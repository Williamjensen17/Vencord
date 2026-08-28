/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as openpgp from "openpgp";

import { generateKeypair, unlockPrivateKey } from "./crypto";
import { getOwnKeypair, saveOwnKeypair } from "./keystore";

let unlockedPrivateKey: openpgp.PrivateKey | null = null;

// Bumped on every lock/unlock. Rendered messages cache their decryption result,
// so they need a value that changes to know to try again.
let sessionGeneration = 0;
const listeners = new Set<() => void>();

export function getSessionGeneration(): number {
  return sessionGeneration;
}

export function subscribeToSession(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notifySessionChanged() {
  sessionGeneration++;
  for (const cb of listeners) cb();
}

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
  notifySessionChanged();
}

export async function unlockSession(passphrase: string) {
  const record = await getOwnKeypair();
  if (!record) throw new Error("No keypair exists.");

  try {
    unlockedPrivateKey = await unlockPrivateKey(
      record.privateKeyArmored,
      passphrase,
    );
    notifySessionChanged();
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
  notifySessionChanged();
}
