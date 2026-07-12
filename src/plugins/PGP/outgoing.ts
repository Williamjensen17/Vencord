import {
  addMessagePreSendListener,
  removeMessagePreSendListener,
} from "@api/MessageEvents";
import { getKey } from "./keystore";
import { parsePublicKey, encryptText } from "./crypto";
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

  const content = messageObj.content;
  if (!content) return;

  const recipientId = getDmRecipientId(props.channel as any);
  if (!recipientId) return;

  const entry = await getKey(recipientId);
  if (!entry?.publicKeyArmored) return;

  const pubKey = await parsePublicKey(entry.publicKeyArmored);
  if (!pubKey) return;

  let signingKey;
  if (isUnlocked()) {
    signingKey = getUnlockedPrivateKey();
  }

  messageObj.content = await encryptText({
    text: content,
    recipientPublicKeys: [pubKey],
    signingKey,
  });
};

export function registerOutgoingEncryption() {
  addMessagePreSendListener(listener);
}

export function unregisterOutgoingEncryption() {
  removeMessagePreSendListener(listener);
}
