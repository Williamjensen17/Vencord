import * as openpgp from "openpgp";
import { getOwnKeypair, saveOwnKeypair } from "./keystore";
import { generateKeypair, unlockPrivateKey } from "./crypto";

let unlockedPrivateKey: openpgp.PrivateKey | null = null;

export function isUnlocked(): boolean {
  return unlockedPrivateKey !== null;
}

export function getUnlockedPrivateKey(): openpgp.PrivateKey {
  if (!unlockedPrivateKey) {
    throw new Error("PGP private key is not unlocked for this session.");
  }
  return unlockedPrivateKey;
}

export function lockSession(): void {
  unlockedPrivateKey = null;
}

/**
 * Attempts to unlock the stored keypair with the given passphrase.
 * Returns true on success, false on wrong passphrase.
 */
export async function unlockSession(passphrase: string): Promise<boolean> {
  const record = await getOwnKeypair();
  if (!record) throw new Error("No PGP keypair has been generated yet.");

  try {
    unlockedPrivateKey = await unlockPrivateKey(
      record.privateKeyArmored,
      passphrase,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Generates a brand-new keypair, persists the (still-encrypted) private key,
 * and unlocks it for the current session immediately.
 */
export async function createAndUnlockNewKeypair(
  name: string,
  email: string,
  passphrase: string,
): Promise<void> {
  const generated = await generateKeypair(name, email, passphrase);

  await saveOwnKeypair({
    privateKeyArmored: generated.privateKeyArmored,
    publicKeyArmored: generated.publicKeyArmored,
    fingerprint: generated.fingerprint,
    createdAt: Date.now(),
  });

  unlockedPrivateKey = await unlockPrivateKey(
    generated.privateKeyArmored,
    passphrase,
  );
}
