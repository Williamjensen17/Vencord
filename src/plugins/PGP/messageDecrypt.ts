/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Key } from "openpgp";

import { decryptText, parsePublicKey } from "./crypto";
import { getKey, getOwnKeypair } from "./keystore";
import { getUnlockedPrivateKey, isUnlocked } from "./session";

export async function tryDecryptMessage(
  content: string,
  senderId: string,
) {
  if (!content.includes("-----BEGIN PGP MESSAGE-----"))
    return null;

  if (!isUnlocked()) {
    return {
      success: false,
      verified: null,
      error: "Private key locked.",
    };
  }

  try {
    const privateKey = getUnlockedPrivateKey();

    const senderEntry = await getKey(senderId);
    const verifyKeys: Key[] = [];

    if (senderEntry?.publicKeyArmored) {
      const pub = await parsePublicKey(
        senderEntry.publicKeyArmored,
      );
      if (pub) verifyKeys.push(pub);
    }

    // Our own sent messages are signed with our own key, and we are not in our
    // own contact keystore — so without this there is never a key to verify them
    // against and they can never show as verified.
    const ownKeypair = await getOwnKeypair();
    if (ownKeypair?.publicKeyArmored) {
      const ownPub = await parsePublicKey(ownKeypair.publicKeyArmored);
      if (ownPub) verifyKeys.push(ownPub);
    }

    const result = await decryptText(
      content,
      privateKey,
      verifyKeys,
    );

    return {
      success: true,
      plaintext: result.data,
      verified: result.verified,
    };
  } catch (err) {
    return {
      success: false,
      verified: null,
      error: String(err),
    };
  }
}
