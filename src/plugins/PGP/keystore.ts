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

async function loadUsersMap(): Promise<UsersMap> {
  return (await DataStore.get<UsersMap>(USERS_STORE_KEY)) ?? {};
}

async function saveUsersMap(map: UsersMap): Promise<void> {
  await DataStore.set(USERS_STORE_KEY, map);
}

export async function addOrUpdateKey(
  entry: Omit<PgpUserEntry, "addedAt"> & { addedAt?: number },
): Promise<PgpUserEntry> {
  const map = await loadUsersMap();
  const existing = map[entry.userId];

  const full: PgpUserEntry = {
    addedAt: existing?.addedAt ?? Date.now(),
    autoEncryptEnabled: existing?.autoEncryptEnabled ?? true,
    trusted: entry.trusted ?? existing?.trusted ?? false,
    ...entry,
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
  await DataStore.set(OWN_KEYPAIR_STORE_KEY, record);
}

export async function getOwnKeypair() {
  return (
    (await DataStore.get<OwnKeypairRecord>(OWN_KEYPAIR_STORE_KEY)) ?? null
  );
}
