/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByProps } from "@webpack";
import { MessageStore, showToast, Toasts } from "@webpack/common";

import { tryDecryptMessage } from "./messageDecrypt";
import { encryptPgpContentForChannel } from "./outgoing";

const PGP_MESSAGE_HEADER = "-----BEGIN PGP MESSAGE-----";

interface EditableMessage {
  id: string;
  content: string;
  author?: { id?: string; };
}

interface EditBody {
  content: string;
  [key: string]: unknown;
}

type EditMessage = (
  channelId: string,
  messageId: string,
  body: EditBody,
) => Promise<void>;

type StartEditMessage = (
  channelId: string,
  messageId: string,
  content: string,
  source?: unknown,
) => void;

type StartEditMessageRecord = (
  channelId: string,
  message: EditableMessage,
  source?: unknown,
) => void;

interface MessageActions {
  deleteMessage: (...args: unknown[]) => unknown;
  editMessage: EditMessage;
  startEditMessage: StartEditMessage;
  startEditMessageRecord?: StartEditMessageRecord;
}

let messageActions: MessageActions | null = null;
let originalEditMessage: EditMessage | null = null;
let originalStartEditMessage: StartEditMessage | null = null;
let originalStartEditMessageRecord: StartEditMessageRecord | null = null;
let wrappedEditMessage: EditMessage | null = null;
let wrappedStartEditMessage: StartEditMessage | null = null;
let wrappedStartEditMessageRecord: StartEditMessageRecord | null = null;

async function beginPgpEdit(
  channelId: string,
  messageId: string,
  armoredContent: string,
  source?: unknown,
) {
  const storedMessage = MessageStore.getMessage(channelId, messageId) as EditableMessage | undefined;
  const result = await tryDecryptMessage(
    armoredContent,
    storedMessage?.author?.id ?? "",
  );

  if (!result?.success || result.plaintext == null) {
    showToast(
      result?.error ?? "Could not decrypt this message for editing.",
      Toasts.Type.FAILURE,
    );
    return;
  }

  // Use Discord's real inline editor and all of its native keyboard/accessibility
  // behavior. The final editMessage wrapper below is the network boundary and
  // replaces this local plaintext with ciphertext before Discord can send it.
  originalStartEditMessage?.call(
    messageActions,
    channelId,
    messageId,
    result.plaintext,
    source,
  );
}

export function installPgpEditInterceptor() {
  if (messageActions) return;

  const actions = findByProps(
    "deleteMessage",
    "editMessage",
    "startEditMessage",
  ) as MessageActions;

  messageActions = actions;
  originalEditMessage = actions.editMessage;
  originalStartEditMessage = actions.startEditMessage;
  originalStartEditMessageRecord = actions.startEditMessageRecord ?? null;

  wrappedEditMessage = async (channelId, messageId, body) => {
    const storedMessage = MessageStore.getMessage(channelId, messageId) as EditableMessage | undefined;
    const isPgpEdit = storedMessage?.content.includes(PGP_MESSAGE_HEADER);

    if (!isPgpEdit || body.content.includes(PGP_MESSAGE_HEADER)) {
      return originalEditMessage!.call(actions, channelId, messageId, body);
    }

    try {
      const encrypted = await encryptPgpContentForChannel(channelId, body.content);
      return originalEditMessage!.call(actions, channelId, messageId, {
        ...body,
        content: encrypted,
      });
    } catch (caught) {
      showToast(
        caught instanceof Error ? caught.message : String(caught),
        Toasts.Type.FAILURE,
      );
    }
  };
  actions.editMessage = wrappedEditMessage;

  wrappedStartEditMessage = (channelId, messageId, content, source) => {
    if (!content.includes(PGP_MESSAGE_HEADER)) {
      originalStartEditMessage!.call(
        actions,
        channelId,
        messageId,
        content,
        source,
      );
      return;
    }

    void beginPgpEdit(channelId, messageId, content, source);
  };
  actions.startEditMessage = wrappedStartEditMessage;

  if (originalStartEditMessageRecord) {
    wrappedStartEditMessageRecord = (channelId, message, source) => {
      if (!message.content.includes(PGP_MESSAGE_HEADER)) {
        originalStartEditMessageRecord!.call(actions, channelId, message, source);
        return;
      }

      void beginPgpEdit(channelId, message.id, message.content, source);
    };
    actions.startEditMessageRecord = wrappedStartEditMessageRecord;
  }
}

export function uninstallPgpEditInterceptor() {
  if (
    messageActions
    && originalEditMessage
    && wrappedEditMessage
    && messageActions.editMessage === wrappedEditMessage
  ) {
    messageActions.editMessage = originalEditMessage;
  }

  if (
    messageActions
    && originalStartEditMessage
    && wrappedStartEditMessage
    && messageActions.startEditMessage === wrappedStartEditMessage
  ) {
    messageActions.startEditMessage = originalStartEditMessage;
  }

  if (
    messageActions
    && originalStartEditMessageRecord
    && wrappedStartEditMessageRecord
    && messageActions.startEditMessageRecord === wrappedStartEditMessageRecord
  ) {
    messageActions.startEditMessageRecord = originalStartEditMessageRecord;
  }

  messageActions = null;
  originalEditMessage = null;
  originalStartEditMessage = null;
  originalStartEditMessageRecord = null;
  wrappedEditMessage = null;
  wrappedStartEditMessage = null;
  wrappedStartEditMessageRecord = null;
}
