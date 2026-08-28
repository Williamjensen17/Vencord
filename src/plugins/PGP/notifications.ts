/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserStore } from "@webpack/common";

import { tryDecryptMessage } from "./messageDecrypt";

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
let originalNotification: typeof Notification | null = null;
let wrappedNotification: typeof Notification | null = null;

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

async function decryptedNotificationBody(title: string, encryptedBody: string): Promise<string> {
  // Discord constructs its Notification during the synchronous Flux dispatch.
  // Let every MESSAGE_CREATE subscriber run before consuming the candidate.
  await new Promise<void>(resolve => setTimeout(resolve, 0));

  const message = takePendingMessage(title, encryptedBody);
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

type NotificationEventName = "click" | "close" | "error" | "show";

/**
 * Discord assigns click/close handlers immediately after `new Notification()`.
 * Decryption is asynchronous, so return this local stand-in and transfer those
 * handlers to the real OS notification as soon as its decrypted body is ready.
 */
class DeferredPgpNotification extends EventTarget {
  onclick: ((this: Notification, ev: Event) => any) | null = null;
  onclose: ((this: Notification, ev: Event) => any) | null = null;
  onerror: ((this: Notification, ev: Event) => any) | null = null;
  onshow: ((this: Notification, ev: Event) => any) | null = null;

  private notification: Notification | null = null;
  private closeRequested = false;

  constructor(
    private readonly NativeNotification: typeof Notification,
    private readonly notificationTitle: string,
    private readonly options: NotificationOptions,
  ) {
    super();
    void this.show();
  }

  private async show() {
    try {
      const body = await decryptedNotificationBody(
        this.notificationTitle,
        this.options.body ?? "",
      );

      const notification = new this.NativeNotification(this.notificationTitle, {
        ...this.options,
        body,
      });
      this.notification = notification;

      for (const type of ["click", "close", "error", "show"] as const) {
        notification.addEventListener(type, event => this.forward(type, event));
      }

      if (this.closeRequested) notification.close();
    } catch (error) {
      console.error("[PGP] Failed to show decrypted notification", error);
    }
  }

  private forward(type: NotificationEventName, event: Event) {
    const handler = this[`on${type}`];
    handler?.call(this as unknown as Notification, event);
    this.dispatchEvent(new Event(type));
  }

  close() {
    this.closeRequested = true;
    this.notification?.close();
  }
}

function isEncryptedPgpNotification(options?: NotificationOptions): boolean {
  return options?.body?.includes(PGP_MESSAGE_HEADER) ?? false;
}

export function installPgpNotificationInterceptor() {
  if (originalNotification || typeof Notification === "undefined") return;

  originalNotification = Notification;
  const NativeNotification = originalNotification;

  wrappedNotification = new Proxy(NativeNotification, {
    construct(target, args) {
      const [title, options] = args as [string, NotificationOptions?];

      if (!isEncryptedPgpNotification(options)) {
        return Reflect.construct(target, args);
      }

      return new DeferredPgpNotification(
        NativeNotification,
        title,
        options ?? {},
      ) as unknown as Notification;
    },
  });

  globalThis.Notification = wrappedNotification;
}

export function uninstallPgpNotificationInterceptor() {
  if (
    originalNotification
    && wrappedNotification
    && globalThis.Notification === wrappedNotification
  ) {
    globalThis.Notification = originalNotification;
  }

  originalNotification = null;
  wrappedNotification = null;
  pendingMessages = [];
}
