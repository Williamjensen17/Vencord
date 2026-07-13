import { sendBotMessage } from "@api/Commands";
import { findLazy } from "@webpack";
import { ChannelStore } from "@webpack/common";

import { encryptFile, parsePublicKey } from "./crypto";
import { getKey, getOwnKeypair } from "./keystore";
import { isPgpEnabled } from "./outgoing";
import { getUnlockedPrivateKey, isUnlocked } from "./session";

/**
 * Discord uploads an attachment the moment you ATTACH it, not when you send.
 * Measured: CloudUpload.upload() runs on attach with status NOT_STARTED and no
 * reserved slot; by the time the send-time hook (uploadFiles) runs, the file is
 * already COMPLETED on storage.googleapis.com.
 *
 * So upload() is the last point at which the bytes are still ours. It is also
 * the best one: item.file here is the ORIGINAL file, before Discord's lossy WebP
 * transcode, and the size fields are recomputed downstream from whatever we put
 * there.
 */

const CloudUpload = findLazy((m: any) => m.prototype?.trackUploadFinished);

// upload() can be called again on retry/resume. Encrypting twice would produce
// ciphertext of ciphertext.
const HANDLED = Symbol("vc-pgp-handled");

let originalUpload: ((...args: any[]) => any) | null = null;

function opaqueName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("") + ".pgp";
}

function getDmRecipientId(channelId: string): string | null {
  const channel = ChannelStore.getChannel(channelId) as any;
  return channel?.recipients?.length === 1 ? channel.recipients[0] : null;
}

function block(upload: any, reason: string) {
  try {
    upload.removeFromMsgDraft?.();
  } catch {
    // Worst case the chip lingers in the composer. Nothing was uploaded, which
    // is the part that matters.
  }

  sendBotMessage(upload.channelId, {
    content:
      `⛔ **Upload blocked** — ${reason}\n` +
      "Nothing was sent. Run `/pgp-import` to add their key, or `/pgp-toggle` to send unencrypted on purpose.",
  });
}

/** @returns true to let the upload proceed, false to block it. */
async function encryptUpload(upload: any): Promise<boolean> {
  if (upload[HANDLED]) return true;

  // PGP off: files behave exactly as they do without the plugin.
  if (!isPgpEnabled()) return true;

  const recipientId = getDmRecipientId(upload.channelId);
  // Not a 1:1 DM. The plugin does not claim to encrypt anywhere else, so leave
  // it alone rather than pretending.
  if (!recipientId) return true;

  const entry = await getKey(recipientId);
  if (!entry?.publicKeyArmored) {
    block(upload, `no PGP key for <@${recipientId}>`);
    return false;
  }

  const recipientKey = await parsePublicKey(entry.publicKeyArmored);
  if (!recipientKey) {
    block(upload, `their stored PGP key could not be parsed`);
    return false;
  }

  const encryptionKeys = [recipientKey];

  // Encrypt to ourselves too, or we cannot read back what we sent.
  const own = await getOwnKeypair();
  if (own?.publicKeyArmored) {
    const ownKey = await parsePublicKey(own.publicKeyArmored);
    if (ownKey) encryptionKeys.push(ownKey);
  }

  const file: File = upload.item.file;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const ciphertext = await encryptFile({
    bytes,
    filename: file.name,
    recipientPublicKeys: encryptionKeys,
    signingKey: isUnlocked() ? getUnlockedPrivateKey() : undefined,
  });

  const name = opaqueName();
  const encrypted = new File([ciphertext as BlobPart], name, {
    type: "application/octet-stream",
  });

  upload.item.file = encrypted;
  upload.mimeType = "application/octet-stream";

  if (typeof upload.setFilename === "function") upload.setFilename(name);
  else upload.filename = name;

  // Must be cleared, or Discord runs its image transcode over our ciphertext.
  upload.isImage = false;
  upload.isVideo = false;

  upload.currentSize = encrypted.size;
  upload.preCompressionSize = encrypted.size;
  upload.postCompressionSize = undefined;

  upload[HANDLED] = true;
  return true;
}

export function registerUploadEncryption() {
  if (originalUpload) return;

  const proto = CloudUpload.prototype;
  originalUpload = proto.upload;

  proto.upload = async function (this: any, ...args: any[]) {
    try {
      const ok = await encryptUpload(this);
      // Fail closed: never call through. Nothing is registered, nothing is sent.
      if (!ok) return;
    } catch (err) {
      block(this, `encryption failed — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    return originalUpload!.apply(this, args);
  };
}

export function unregisterUploadEncryption() {
  if (!originalUpload) return;

  CloudUpload.prototype.upload = originalUpload;
  originalUpload = null;
}
