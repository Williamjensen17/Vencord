/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  addMessagePreSendListener,
  removeMessagePreSendListener,
} from "@api/MessageEvents";

import { encryptText,parsePublicKey } from "./crypto";
import { getKey, getOwnKeypair } from "./keystore";
import { getUnlockedPrivateKey, isUnlocked } from "./session";

let pgpEnabled = true;

export function setPgpEnabled(enabled: boolean) {
  pgpEnabled = enabled;
}

export function isPgpEnabled() {
  return pgpEnabled;
}

function getDmRecipientId(channel: { recipients?: string[] }) {
  if (channel.recipients?.length === 1) {
    return channel.recipients[0];
  }
  return null;
}

const listener = async (_channelId, messageObj, _options, props) => {
  if (!pgpEnabled) return;

  const { content } = messageObj;
  if (!content) return;

  const recipientId = getDmRecipientId(props.channel as any);
  if (!recipientId) return;

  const entry = await getKey(recipientId);
  if (!entry?.publicKeyArmored) return;

  const pubKey = await parsePublicKey(entry.publicKeyArmored);
  if (!pubKey) return;

  const encryptionKeys = [pubKey];

  const ownKeypair = await getOwnKeypair();
  if (ownKeypair?.publicKeyArmored) {
    const ownPub = await parsePublicKey(ownKeypair.publicKeyArmored);
    if (ownPub) encryptionKeys.push(ownPub);
  }

  let signingKey;
  if (isUnlocked()) {
    signingKey = getUnlockedPrivateKey();
  }

  messageObj.content = await encryptText({
    text: content,
    recipientPublicKeys: encryptionKeys,
    signingKey,
  });
};

export function registerOutgoingEncryption() {
  addMessagePreSendListener(listener);
}

export function unregisterOutgoingEncryption() {
  removeMessagePreSendListener(listener);
}
