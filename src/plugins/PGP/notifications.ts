/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByProps } from "@webpack";
import { UserStore } from "@webpack/common";

import { encryptText, parsePublicKey } from "./crypto";
import { getOwnKeypair } from "./keystore";
import { tryDecryptMessage } from "./messageDecrypt";
import { getUnlockedPrivateKey, isUnlocked } from "./session";

const PGP_MESSAGE_HEADER = "-----BEGIN PGP MESSAGE-----";
const CANDIDATE_TTL_MS = 3_000;

interface NotificationMessage {
  id: string;
  content: string;
  author?: {
    id?: string;
    username?: string;
    globalName?: string;
  };
}

interface MessageCreateEvent {
  message?: NotificationMessage;
  optimistic?: boolean;
}

interface PendingMessage {
  message: NotificationMessage;
  receivedAt: number;
}

let pendingMessages: PendingMessage[] = [];

type ShowNotification = (
  icon: string | null | undefined,
  title: string,
  body: string,
  trackingProps: Record<string, unknown>,
  options: DiscordNotificationOptions,
) => Promise<unknown>;

interface DiscordNotificationOptions extends Record<string, unknown> {
  messageRecord?: NotificationMessage;
}

interface DiscordNotificationUtils {
  hasPermission: (...args: unknown[]) => unknown;
  playNotificationSound: (...args: unknown[]) => unknown;
  showNotification: ShowNotification;
}

let notificationUtils: DiscordNotificationUtils | null = null;
let originalShowNotification: ShowNotification | null = null;
let wrappedShowNotification: ShowNotification | null = null;

function prunePending(now = Date.now()) {
  pendingMessages = pendingMessages.filter(
    candidate => now - candidate.receivedAt <= CANDIDATE_TTL_MS,
  );
}

/**
 * Records only enough ciphertext metadata to pair Discord's eventual native
 * notification with its MESSAGE_CREATE. The plaintext never enters Flux or a
 * Discord-owned message record.
 */
export function handlePgpMessageCreate({ message, optimistic }: MessageCreateEvent) {
  if (optimistic || !message?.content.includes(PGP_MESSAGE_HEADER)) return;
  if (message.author?.id === UserStore.getCurrentUser()?.id) return;

  prunePending();
  pendingMessages.push({ message, receivedAt: Date.now() });
}

function contentMatchesNotification(content: string, body: string): boolean {
  if (content === body) return true;

  // Discord may truncate the body, but the armor following the common header
  // still uniquely identifies ordinary messages. It may also wrap it in code
  // fences, hence checking containment in both directions.
  return content.startsWith(body)
    || body.includes(content)
    || (body.length > PGP_MESSAGE_HEADER.length && content.includes(body));
}

function takePendingMessage(title: string, body: string): NotificationMessage | null {
  prunePending();

  let index = pendingMessages.findIndex(({ message }) =>
    contentMatchesNotification(message.content, body),
  );

  // A heavily truncated notification can contain only the common armor header.
  // Prefer the author whose name Discord retained in the title, then the oldest
  // still-pending encrypted event (notification order follows dispatch order).
  if (index === -1) {
    index = pendingMessages.findIndex(({ message }) => {
      const { username, globalName } = message.author ?? {};
      return !!(
        (username && title.includes(username))
        || (globalName && title.includes(globalName))
      );
    });
  }
  if (index === -1 && pendingMessages.length) index = 0;
  if (index === -1) return null;

  return pendingMessages.splice(index, 1)[0].message;
}

async function decryptedNotificationBody(
  title: string,
  encryptedBody: string,
  messageRecord?: NotificationMessage,
): Promise<string> {
  let message = messageRecord;

  if (message) {
    // Avoid retaining the duplicate recorded by our MESSAGE_CREATE handler.
    pendingMessages = pendingMessages.filter(({ message: pending }) =>
      pending.id !== message!.id,
    );
  } else {
    // The generic NOTIFICATION_CREATE path has no messageRecord. Discord may
    // construct it during the same synchronous Flux dispatch, so allow every
    // MESSAGE_CREATE subscriber to run before consuming the fallback queue.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    message = takePendingMessage(title, encryptedBody) ?? undefined;
  }

  if (!message) return "Encrypted PGP message";

  const result = await tryDecryptMessage(
    message.content,
    message.author?.id ?? "",
  );

  if (!result?.success) {
    return result?.error === "Private key locked."
      ? "Encrypted PGP message — unlock PGP to preview"
      : "Encrypted PGP message — could not decrypt";
  }

  const plaintext = result.plaintext ?? "Encrypted PGP message — could not decrypt";
  return result.verified === false
    ? `⚠️ Signature verification failed\n${plaintext}`
    : plaintext;
}

export function installPgpNotificationInterceptor() {
  if (notificationUtils) return;

  // Discord captures `window.Notification` when its webpack module loads, long
  // before plugins start. Replacing the global constructor therefore cannot
  // affect message notifications. This is Discord's final notification helper,
  // immediately before its native IPC / cached HTML5 constructor boundary.
  const utils = findByProps(
    "showNotification",
    "playNotificationSound",
    "hasPermission",
  ) as DiscordNotificationUtils;

  notificationUtils = utils;
  originalShowNotification = utils.showNotification;
  wrappedShowNotification = (icon, title, body, trackingProps, options) => {
    const { messageRecord } = options;
    const isEncrypted = body.includes(PGP_MESSAGE_HEADER)
      || messageRecord?.content.includes(PGP_MESSAGE_HEADER);

    if (!isEncrypted) {
      return originalShowNotification!.call(
        utils,
        icon,
        title,
        body,
        trackingProps,
        options,
      );
    }

    return decryptedNotificationBody(title, body, messageRecord).then(decryptedBody =>
      originalShowNotification!.call(
        utils,
        icon,
        title,
        decryptedBody,
        trackingProps,
        options,
      ),
    );
  };

  utils.showNotification = wrappedShowNotification;
}

export function uninstallPgpNotificationInterceptor() {
  if (
    notificationUtils
    && originalShowNotification
    && wrappedShowNotification
    && notificationUtils.showNotification === wrappedShowNotification
  ) {
    notificationUtils.showNotification = originalShowNotification;
  }

  notificationUtils = null;
  originalShowNotification = null;
  wrappedShowNotification = null;
  pendingMessages = [];
}

/** Runs the real encrypted notification path without needing another account. */
export async function showPgpTestNotification() {
  if (!notificationUtils || notificationUtils.showNotification !== wrappedShowNotification) {
    throw new Error("PGP notification interceptor is not installed.");
  }
  if (!isUnlocked()) {
    throw new Error("Unlock PGP first with /pgp-unlock.");
  }

  const ownKeypair = await getOwnKeypair();
  if (!ownKeypair) {
    throw new Error("No keypair exists. Run /pgp-generate first.");
  }

  const publicKey = await parsePublicKey(ownKeypair.publicKeyArmored);
  if (!publicKey) throw new Error("Stored public key could not be parsed.");

  const content = await encryptText({
    text: "PGP notification decrypted successfully.",
    recipientPublicKeys: [publicKey],
    signingKey: getUnlockedPrivateKey(),
  });
  const currentUser = UserStore.getCurrentUser();

  pendingMessages.push({
    message: {
      id: `pgp-notification-test-${Date.now()}`,
      content,
      author: {
        id: currentUser?.id,
        username: currentUser?.username,
        globalName: currentUser?.globalName,
      },
    },
    receivedAt: Date.now(),
  });

  await notificationUtils.showNotification(
    null,
    "PGP notification test",
    content,
    { notif_type: "PGP_TEST" },
    {
      isUserAvatar: false,
      messageRecord: pendingMessages.at(-1)?.message,
      omitViewTracking: true,
      sound: "message1",
      tag: `pgp-notification-test-${Date.now()}`,
      volume: 0.4,
    },
  );
}
