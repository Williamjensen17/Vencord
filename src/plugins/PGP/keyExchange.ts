/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { looksLikeArmoredPublicKey, normalizeArmoredText,parsePublicKey } from "./crypto";
import { addOrUpdateKey,getOwnKeypair } from "./keystore";

export async function getOwnPublicKeyArmored() {
  const record = await getOwnKeypair();
  if (!record) throw new Error("No keypair generated.");
  return record.publicKeyArmored;
}

export async function importFriendPublicKey(
  userId: string,
  armoredKey: string,
  trusted = false,
) {
  const normalized = normalizeArmoredText(armoredKey);

  if (!looksLikeArmoredPublicKey(normalized)) {
    throw new Error("Invalid public key block.");
  }

  const key = await parsePublicKey(normalized);
  if (!key) throw new Error("Failed to parse key.");

  return addOrUpdateKey({
    userId,
    publicKeyArmored: normalized,
    fingerprint: key.getFingerprint(),
    lastSeenEncrypted: Date.now(),
    trusted,
  });
}
