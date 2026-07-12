import * as openpgp from "openpgp";
import { getOwnKeypair, saveOwnKeypair } from "./keystore";
import { generateKeypair, unlockPrivateKey } from "./crypto";

let unlockedPrivateKey: openpgp.PrivateKey | null = null;

export function isUnlocked(): boolean {
  return unlockedPrivateKey !== null;
}

export function getUnlockedPrivateKey(): openpgp.PrivateKey {
  if (!unlockedPrivateKey) {
    throw new Error("Private key not unlocked.");
  }
  return unlockedPrivateKey;
}

export function lockSession() {
  unlockedPrivateKey = null;
}

export async function unlockSession(passphrase: string) {
  const record = await getOwnKeypair();
  if (!record) throw new Error("No keypair exists.");

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

export async function createAndUnlockNewKeypair(
  name: string,
  email: string,
  passphrase: string,
) {
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
