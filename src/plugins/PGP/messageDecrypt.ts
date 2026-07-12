import { looksLikeArmoredMessage, decryptText, parsePublicKey } from "./crypto";
import { getUnlockedPrivateKey, isUnlocked } from "./session";
import { getKey, touchLastSeenEncrypted } from "./keystore";

export interface DecryptedResult {
  success: boolean;
  plaintext?: string;
  verified: boolean | null;
  error?: string;
}

/**
 * Attempts to decrypt a message body if it contains an armored PGP message.
 * Returns null if the content doesn't look like PGP at all (fast path).
 */
export async function tryDecryptMessage(
  content: string,
  senderId: string,
): Promise<DecryptedResult | null> {
  if (!looksLikeArmoredMessage(content)) return null;

  // Record that this sender uses PGP, regardless of whether decryption succeeds
  await touchLastSeenEncrypted(senderId);

  if (!isUnlocked()) {
    return {
      success: false,
      verified: null,
      error: "Private key is locked. Unlock PGP to decrypt this message.",
    };
  }

  try {
    const privateKey = getUnlockedPrivateKey();

    // Optionally verify signature if we have the sender's public key on file
    const senderEntry = await getKey(senderId);
    let verifyKeys: Awaited<ReturnType<typeof parsePublicKey>>[] = [];
    if (senderEntry?.publicKeyArmored) {
      const pub = await parsePublicKey(senderEntry.publicKeyArmored);
      if (pub) verifyKeys = [pub];
    }

    const result = await decryptText(
      content,
      privateKey,
      verifyKeys.filter(Boolean) as any,
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
      error: err instanceof Error ? err.message : String(err),
    };
  }
}