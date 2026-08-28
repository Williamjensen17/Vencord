/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { RenderModalProps } from "@vencord/discord-types";
import { findByProps } from "@webpack";
import {
  MessageStore,
  Modal,
  openModal,
  React,
  showToast,
  TextArea,
  Toasts,
} from "@webpack/common";

import { tryDecryptMessage } from "./messageDecrypt";
import { encryptPgpContentForChannel } from "./outgoing";

const PGP_MESSAGE_HEADER = "-----BEGIN PGP MESSAGE-----";

interface EditableMessage {
  id: string;
  content: string;
  author?: { id?: string; };
}

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
  editMessage: (
    channelId: string,
    messageId: string,
    body: { content: string; },
  ) => Promise<void>;
  startEditMessage: StartEditMessage;
  startEditMessageRecord?: StartEditMessageRecord;
}

let messageActions: MessageActions | null = null;
let originalStartEditMessage: StartEditMessage | null = null;
let originalStartEditMessageRecord: StartEditMessageRecord | null = null;
let wrappedStartEditMessage: StartEditMessage | null = null;
let wrappedStartEditMessageRecord: StartEditMessageRecord | null = null;

function PgpEditModal({
  channelId,
  initialText,
  messageId,
  modalProps,
}: {
  channelId: string;
  initialText: string;
  messageId: string;
  modalProps: RenderModalProps;
}) {
  const [text, setText] = React.useState(initialText);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    if (saving || !text.trim() || !messageActions) return;

    setSaving(true);
    setError(null);

    try {
      // Only the armored result crosses into Discord's edit action. Plaintext
      // remains in this plugin-owned component state and never enters Flux.
      const encrypted = await encryptPgpContentForChannel(channelId, text);
      await messageActions.editMessage(channelId, messageId, {
        content: encrypted,
      });
      modalProps.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  };

  return (
    <Modal
      {...modalProps}
      title="Edit encrypted message"
      subtitle="The editor stays local; only newly encrypted PGP text is sent to Discord."
      actions={[
        {
          text: "Cancel",
          variant: "secondary",
          onClick: modalProps.onClose,
          disabled: saving,
        },
        {
          text: saving ? "Encrypting…" : "Save",
          variant: "primary",
          onClick: save,
          disabled: saving || !text.trim(),
        },
      ]}
      notice={error ? { message: error, type: "critical" } : undefined}
    >
      <TextArea
        autoFocus
        autosize
        value={text}
        onChange={setText}
        placeholder="Message"
      />
    </Modal>
  );
}

async function beginPgpEdit(
  channelId: string,
  messageId: string,
  armoredContent: string,
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

  openModal(modalProps => (
    <PgpEditModal
      channelId={channelId}
      initialText={result.plaintext!}
      messageId={messageId}
      modalProps={modalProps}
    />
  ));
}

export function installPgpEditInterceptor() {
  if (messageActions) return;

  const actions = findByProps(
    "deleteMessage",
    "editMessage",
    "startEditMessage",
  ) as MessageActions;

  messageActions = actions;
  originalStartEditMessage = actions.startEditMessage;
  originalStartEditMessageRecord = actions.startEditMessageRecord ?? null;

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

    void beginPgpEdit(channelId, messageId, content);
  };
  actions.startEditMessage = wrappedStartEditMessage;

  if (originalStartEditMessageRecord) {
    wrappedStartEditMessageRecord = (channelId, message, source) => {
      if (!message.content.includes(PGP_MESSAGE_HEADER)) {
        originalStartEditMessageRecord!.call(actions, channelId, message, source);
        return;
      }

      void beginPgpEdit(channelId, message.id, message.content);
    };
    actions.startEditMessageRecord = wrappedStartEditMessageRecord;
  }
}

export function uninstallPgpEditInterceptor() {
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
  originalStartEditMessage = null;
  originalStartEditMessageRecord = null;
  wrappedStartEditMessage = null;
  wrappedStartEditMessageRecord = null;
}
