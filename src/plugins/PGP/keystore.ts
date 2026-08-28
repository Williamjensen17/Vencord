/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";

const USERS_STORE_KEY = "PGP_KNOWN_USERS";
const OWN_KEYPAIR_STORE_KEY = "PGP_OWN_KEYPAIR";

export interface PgpUserEntry {
  userId: string;
  publicKeyArmored: string;
  fingerprint: string;
  addedAt: number;
  lastSeenEncrypted: number;
  autoEncryptEnabled: boolean;
  trusted: boolean;
}

export interface OwnKeypairRecord {
  privateKeyArmored: string;
  publicKeyArmored: string;
  fingerprint: string;
  createdAt: number;
}

type UsersMap = Record<string, PgpUserEntry>;

// In-memory cache for every read path. Decryption calls getKey() / getOwnKeypair()
// on every message, and DataStore (IndexedDB) can serve inconsistent or partial
// values mid-session while its writes flush lazily. That intermittently gave a
// false "signature invalid" verdict that a cold reload always cleared. Caching a
// consistent snapshot removes the dependence on IndexedDB timing.
let usersCache: UsersMap | null = null;
let ownKeypairCache: OwnKeypairRecord | null = null;

// Bumped every time the keyring is written. Accessories subscribe so a
// decryption result computed against a not-yet-loaded keyring gets recomputed
// once the keys are actually available.
let keyringGeneration = 0;
const listeners = new Set<() => void>();

export function getKeyringGeneration(): number {
  return keyringGeneration;
}

export function subscribeToKeyring(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notifyKeyringChanged() {
  keyringGeneration++;
  for (const cb of listeners) cb();
}

async function loadUsersMap(): Promise<UsersMap> {
  if (usersCache) return usersCache;
  const map = (await DataStore.get<UsersMap>(USERS_STORE_KEY)) ?? {};
  usersCache = map;
  return map;
}

async function saveUsersMap(map: UsersMap): Promise<void> {
  usersCache = map;
  await DataStore.set(USERS_STORE_KEY, map);
  notifyKeyringChanged();
}

/** Warms both caches from IndexedDB so reads during the session are consistent. */
export async function warmKeyring(): Promise<void> {
  await loadUsersMap();
  ownKeypairCache =
    (await DataStore.get<OwnKeypairRecord>(OWN_KEYPAIR_STORE_KEY)) ?? null;
}

export async function addOrUpdateKey(
  entry: Omit<PgpUserEntry, "addedAt" | "autoEncryptEnabled" | "trusted"> & {
    addedAt?: number;
    autoEncryptEnabled?: boolean;
    trusted?: boolean;
  },
): Promise<PgpUserEntry> {
  const map = await loadUsersMap();
  const existing = map[entry.userId];

  // Spreads first, resolved values last: spreading `entry` afterwards would
  // clobber these fallbacks with its own undefined fields.
  const full: PgpUserEntry = {
    ...existing,
    ...entry,
    addedAt: existing?.addedAt ?? entry.addedAt ?? Date.now(),
    autoEncryptEnabled:
      entry.autoEncryptEnabled ?? existing?.autoEncryptEnabled ?? true,
    trusted: entry.trusted ?? existing?.trusted ?? false,
  };

  map[entry.userId] = full;
  await saveUsersMap(map);
  return full;
}

export async function getKey(userId: string) {
  const map = await loadUsersMap();
  return map[userId] ?? null;
}

export async function listKnownUsers() {
  const map = await loadUsersMap();
  return Object.values(map);
}

export async function saveOwnKeypair(record: OwnKeypairRecord) {
  ownKeypairCache = record;
  await DataStore.set(OWN_KEYPAIR_STORE_KEY, record);
  notifyKeyringChanged();
}

export async function getOwnKeypair() {
  if (ownKeypairCache) return ownKeypairCache;
  ownKeypairCache =
    (await DataStore.get<OwnKeypairRecord>(OWN_KEYPAIR_STORE_KEY)) ?? null;
  return ownKeypairCache;
}
