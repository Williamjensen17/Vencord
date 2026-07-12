import { DataStore } from "@api/index";

const USERS_STORE_KEY = "PGP_KNOWN_USERS";
const OWN_KEYPAIR_STORE_KEY = "PGP_OWN_KEYPAIR";
const SETTINGS_STORE_KEY = "PGP_SETTINGS";

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

export async function getKey(userId: string): Promise<PgpUserEntry | null> {
  const map = await loadUsersMap();
  return map[userId] ?? null;
}

export async function removeKey(userId: string): Promise<void> {
  const map = await loadUsersMap();
  delete map[userId];
  await saveUsersMap(map);
}

export async function listKnownUsers(): Promise<PgpUserEntry[]> {
  const map = await loadUsersMap();
  return Object.values(map);
}

export async function touchLastSeenEncrypted(userId: string): Promise<void> {
  const map = await loadUsersMap();
  if (map[userId]) {
    map[userId].lastSeenEncrypted = Date.now();
  } else {
    map[userId] = {
      userId,
      publicKeyArmored: "",
      fingerprint: "",
      addedAt: Date.now(),
      lastSeenEncrypted: Date.now(),
      autoEncryptEnabled: false,
      trusted: false,
    };
  }
  await saveUsersMap(map);
}

export async function setAutoEncryptEnabled(
  userId: string,
  enabled: boolean,
): Promise<void> {
  const map = await loadUsersMap();
  if (map[userId]) {
    map[userId].autoEncryptEnabled = enabled;
    await saveUsersMap(map);
  }
}

export async function saveOwnKeypair(
  record: OwnKeypairRecord,
): Promise<void> {
  await DataStore.set(OWN_KEYPAIR_STORE_KEY, record);
}

export async function getOwnKeypair(): Promise<OwnKeypairRecord | null> {
  return (
    (await DataStore.get<OwnKeypairRecord>(OWN_KEYPAIR_STORE_KEY)) ?? null
  );
}

export async function clearOwnKeypair(): Promise<void> {
  await DataStore.del(OWN_KEYPAIR_STORE_KEY);
}

export interface PgpSettingsRecord {
  autoEncryptDms: boolean;
  autoDecrypt: boolean;
  signMessages: boolean;
  promptBeforeTrust: boolean;
}

const DEFAULT_SETTINGS: PgpSettingsRecord = {
  autoEncryptDms: true,
  autoDecrypt: true,
  signMessages: true,
  promptBeforeTrust: true,
};

export async function getSettings(): Promise<PgpSettingsRecord> {
  return (
    (await DataStore.get<PgpSettingsRecord>(SETTINGS_STORE_KEY)) ??
    DEFAULT_SETTINGS
  );
}

export async function saveSettings(
  settings: PgpSettingsRecord,
): Promise<void> {
  await DataStore.set(SETTINGS_STORE_KEY, settings);
}
