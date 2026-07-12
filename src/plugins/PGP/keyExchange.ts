// keyExchange.ts
import { getOwnKeypair, addOrUpdateKey, PgpUserEntry } from "./keystore";
import {
  parsePublicKey,
  looksLikeArmoredPublicKey,
  normalizeArmoredKey,
} from "./crypto";

/**
 * Returns your own armored public key so you can share it with a friend.
 */
export async function getOwnPublicKeyArmored(): Promise<string> {
  const record = await getOwnKeypair();
  if (!record) throw new Error("No keypair generated yet.");
  return record.publicKeyArmored;
}

/**
 * Parses and stores a friend's public key, associating it with their
 * Discord user ID so future messages to/from them can be encrypted/verified.
 */
export async function importFriendPublicKey(
  userId: string,
  armoredKey: string,
  trusted = false,
): Promise<PgpUserEntry> {
  const trimmed = normalizeArmoredKey(armoredKey);

  if (!looksLikeArmoredPublicKey(trimmed)) {
    throw new Error("That doesn't look like a PGP public key block.");
  }

  let key;
  try {
    key = await parsePublicKey(trimmed);
  } catch (err) {
    throw new Error(
      `Failed to parse public key: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!key) {
    throw new Error(
      "Failed to parse public key (is it actually a private key?).",
    );
  }

  return addOrUpdateKey({
    userId,
    publicKeyArmored: trimmed,
    fingerprint: key.getFingerprint(),
    lastSeenEncrypted: Date.now(),
    trusted,
  });
}
