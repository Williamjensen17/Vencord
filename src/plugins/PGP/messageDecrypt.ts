import type { Key } from "openpgp";

import { decryptText, parsePublicKey } from "./crypto";
import { getUnlockedPrivateKey, isUnlocked } from "./session";
import { getKey } from "./keystore";

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
