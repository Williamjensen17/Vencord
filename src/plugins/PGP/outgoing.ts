/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  addMessagePreSendListener,
  removeMessagePreSendListener,
} from "@api/MessageEvents";
import { ChannelStore } from "@webpack/common";

import { encryptText, parsePublicKey } from "./crypto";
import { getKey, getOwnKeypair } from "./keystore";
import { getUnlockedPrivateKey, isUnlocked } from "./session";

let pgpEnabled = true;

export function setPgpEnabled(enabled: boolean) {
  pgpEnabled = enabled;
}

export function isPgpEnabled() {
  return pgpEnabled;
}

interface DmChannel {
  recipients?: string[];
}

function getDmRecipientId(channel: DmChannel) {
  if (channel.recipients?.length === 1) {
    return channel.recipients[0];
  }
  return null;
}

async function encryptForDmChannel(channel: DmChannel, content: string): Promise<string | null> {
  const recipientId = getDmRecipientId(channel);
  if (!recipientId) return null;

  const entry = await getKey(recipientId);
  if (!entry?.publicKeyArmored) return null;

  const pubKey = await parsePublicKey(entry.publicKeyArmored);
  if (!pubKey) return null;

  const encryptionKeys = [pubKey];

  const ownKeypair = await getOwnKeypair();
  if (ownKeypair?.publicKeyArmored) {
    const ownPub = await parsePublicKey(ownKeypair.publicKeyArmored);
    if (ownPub) encryptionKeys.push(ownPub);
  }

  const signingKey = isUnlocked()
    ? getUnlockedPrivateKey()
    : undefined;

  return encryptText({
    text: content,
    recipientPublicKeys: encryptionKeys,
    signingKey,
  });
}

/** Encrypts an edit without ever putting its plaintext in Discord's edit store. */
export async function encryptPgpContentForChannel(channelId: string, content: string) {
  const channel = ChannelStore.getChannel(channelId);
  if (!channel) throw new Error("Channel is no longer available.");

  const encrypted = await encryptForDmChannel(channel, content);
  if (!encrypted) {
    throw new Error("This DM recipient does not have an imported PGP public key.");
  }
  return encrypted;
}

const listener = async (_channelId, messageObj, _options, props) => {
  if (!pgpEnabled) return;

  const { content } = messageObj;
  if (!content) return;

  const encrypted = await encryptForDmChannel(props.channel, content);
  if (encrypted) messageObj.content = encrypted;
};

export function registerOutgoingEncryption() {
  addMessagePreSendListener(listener);
}

export function unregisterOutgoingEncryption() {
  removeMessagePreSendListener(listener);
}
