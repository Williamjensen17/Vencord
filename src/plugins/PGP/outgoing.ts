import type {
  MessageObject,
  MessageSendListener,
} from "@api/MessageEvents";
import {
  addMessagePreSendListener,
  removeMessagePreSendListener,
} from "@api/MessageEvents";
import { getKey, getSettings } from "./keystore";
import {
  parsePublicKey,
  encryptText,
  looksLikeArmoredMessage,
} from "./crypto";
import { getUnlockedPrivateKey, isUnlocked } from "./session";

/**
 * Given a DM channel, returns the other participant's user ID.
 * Returns null for group DMs / guild channels (not supported here).
 */
function getDmRecipientId(channel: { recipients?: string[] }): string | null {
  if (channel.recipients?.length === 1) {
    return channel.recipients[0];
  }
  return null;
}

const listener: MessageSendListener = async (
  channelId,
  messageObj: MessageObject,
  _options,
  props,
) => {
  const settings = await getSettings();
  if (!settings.autoEncryptDms) return;

  const content = messageObj.content;
  if (!content || looksLikeArmoredMessage(content)) return;

  const recipientId = getDmRecipientId(props.channel as any);
  if (!recipientId) return; // not a 1:1 DM, skip

  const entry = await getKey(recipientId);
  if (!entry?.publicKeyArmored || !entry.autoEncryptEnabled) return;

  const pubKey = await parsePublicKey(entry.publicKeyArmored);
  if (!pubKey) return;

  let signingKey;
  if (settings.signMessages && isUnlocked()) {
    signingKey = getUnlockedPrivateKey();
  }

  messageObj.content = await encryptText({
    text: content,
    recipientPublicKeys: [pubKey],
    signingKey,
  });
};

export function registerOutgoingEncryption(): void {
  addMessagePreSendListener(listener);
}

export function unregisterOutgoingEncryption(): void {
  removeMessagePreSendListener(listener);
}
