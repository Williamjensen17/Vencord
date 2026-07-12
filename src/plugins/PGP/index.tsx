import definePlugin, { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import {
  addMessageAccessory,
  removeMessageAccessory,
} from "@api/MessageAccessories";
import {
  ApplicationCommandOptionType,
  findOption,
} from "@api/Commands";
import { ChannelStore } from "@webpack/common";

import {
  getOwnKeypair,
  listKnownUsers,
  saveOwnKeypair,
  // NOTE: we will NOT read passphrase from keystore anymore
  getSettings as keystoreGetSettings,
  saveSettings as keystoreSaveSettings,
} from "./keystore";

import {
  isUnlocked,
  lockSession,
  unlockSession,
  createAndUnlockNewKeypair,
} from "./session";

import { getOwnPublicKeyArmored, importFriendPublicKey } from "./keyExchange";

import {
  registerOutgoingEncryption,
  unregisterOutgoingEncryption,
} from "./outgoing";

import { PgpDecryptedAccessory } from "./PgpDecryptedAccessory";

const settings = definePluginSettings({
  autoEncryptDms: {
    type: OptionType.BOOLEAN,
    description: "Automatically encrypt outgoing DMs to known PGP users",
    default: true,
  },
  autoDecrypt: {
    type: OptionType.BOOLEAN,
    description: "Automatically decrypt incoming PGP messages",
    default: true,
  },
  signMessages: {
    type: OptionType.BOOLEAN,
    description: "Sign outgoing encrypted messages with your private key",
    default: true,
  },
  promptBeforeTrust: {
    type: OptionType.BOOLEAN,
    description:
      "Prompt for confirmation before trusting a newly detected public key",
    default: true,
  },

  passphrase: {
    type: OptionType.STRING,
    description:
      "Session passphrase used to unlock your private key (may be saved depending on host behavior)",
    default: "",
  },

  autoUnlockOnStart: {
    type: OptionType.BOOLEAN,
    description: "Automatically unlock your private key on startup (if passphrase is set)",
    default: false,
  },
});

let cachedPassphrase = "";
let cachedAutoUnlockOnStart = false;

export default definePlugin({
  name: "PGP",
  description:
    "Automatically encrypts outgoing messages/files with PGP and decrypts incoming ones.",
  authors: [
    {
      name: "William",
      id: 0n,
    },
  ],
  settings,

  commands: [
    {
      name: "pgp-pubkey",
      description: "Send your PGP public key in this channel",
      execute: async () => {
        try {
          const armored = await getOwnPublicKeyArmored();
          return { content: armored };
        } catch (err) {
          return {
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    },
    {
      name: "pgp-import",
      description: "Import a friend's PGP public key for this DM",
      options: [
        {
          name: "key",
          description: "Armored public key block",
          type: ApplicationCommandOptionType.STRING,
          required: true,
        },
      ],
      execute: async (args, ctx) => {
        try {
          const key = findOption(args, "key", "");
          const channel = ChannelStore.getChannel(ctx.channel.id);
          const userId = channel?.recipients?.[0];

          if (!userId) {
            return {
              content:
                "Could not determine the DM recipient. This command must be run inside a 1:1 DM.",
            };
          }

          const entry = await importFriendPublicKey(userId, key);
          return {
            content: `Imported public key for <@${userId}> (fingerprint: ${entry.fingerprint}) ✅`,
          };
        } catch (err) {
          return {
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    },

{
  name: "pgp-unlock",
  description: "Unlock your PGP private key for this session",
  execute: async () => {
    try {
      const passphrase = settings.store.passphrase;

      if (!passphrase) {
        return {
          content: "No passphrase set in plugin settings.",
        };
      }

      const ok = await unlockSession(passphrase);

      return ok
        ? { content: "PGP unlocked for this session ✅" }
        : { content: "Incorrect passphrase ❌" };
    } catch (err) {
      return {
        content: `Error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  },
},
  ],

  async start() {
    // Initialize cache from keystore settings if possible
    // (This is only for first load; if keystore storage differs, user can re-save once.)
    try {
      const s = await keystoreGetSettings();
      cachedPassphrase = s.passphrase ?? "";
      cachedAutoUnlockOnStart = !!s.autoUnlockOnStart;
    } catch {
      // ignore, user can re-save in UI to populate cache
    }

    const existing = await getOwnKeypair();
    if (!existing) {
      console.log(
        "[PGP] No keypair found. Generate one via the plugin settings panel.",
      );
    } else {
      console.log(
        `[PGP] Loaded existing keypair (fingerprint: ${existing.fingerprint}). Unlock required before use.`,
      );
    }

    if (cachedAutoUnlockOnStart && cachedPassphrase) {
      try {
        const ok = await unlockSession(cachedPassphrase);
        if (ok) console.log("[PGP] Auto-unlocked after startup ✅");
      } catch (e) {
        console.warn("[PGP] Auto-unlock failed:", e);
      }
    }

    addMessageAccessory("pgp-decrypted-content", props => {
      const message = props.message;
      const content: string = message?.content ?? "";

      if (!content.includes("-----BEGIN PGP MESSAGE-----")) return null;

      return (
        <PgpDecryptedAccessory
          content={content}
          senderId={message.author.id}
        />
      );
    });

    registerOutgoingEncryption();
  },

  stop() {
    lockSession();
    removeMessageAccessory("pgp-decrypted-content");
    unregisterOutgoingEncryption();
  },

  async generateNewKeypair(name: string, email: string, passphrase: string) {
    await createAndUnlockNewKeypair(name, email, passphrase);
    console.log("[PGP] New keypair generated and unlocked for this session.");
  },

  async unlock(passphrase: string) {
    const ok = await unlockSession(passphrase);
    if (!ok) {
      console.error("[PGP] Failed to unlock: incorrect passphrase.");
    } else {
      console.log("[PGP] Session unlocked.");
    }
    return ok;
  },

  isSessionUnlocked() {
    return isUnlocked();
  },

  async listUsers() {
    return listKnownUsers();
  },

  async getSettings() {
    // plugin framework calls this; also update cache
    const s = await keystoreGetSettings();
    cachedPassphrase = s.passphrase ?? "";
    cachedAutoUnlockOnStart = !!s.autoUnlockOnStart;
    return s;
  },

  async saveSettings(next) {
    // plugin framework calls this; update cache and persist if it works
    cachedPassphrase = next.passphrase ?? "";
    cachedAutoUnlockOnStart = !!next.autoUnlockOnStart;
    return keystoreSaveSettings(next);
  },

  async getOwnPublicKeyArmored() {
    return getOwnPublicKeyArmored();
  },

  async importFriendPublicKey(
    userId: string,
    armoredKey: string,
    trusted = false,
  ) {
    return importFriendPublicKey(userId, armoredKey, trusted);
  },

  _debugEncrypt: async (text: string) => {
    const { encryptText, parsePublicKey } = await import("./crypto");
    const record = await getOwnKeypair();
    const pub = await parsePublicKey(record!.publicKeyArmored);
    return encryptText({ text, recipientPublicKeys: [pub!] });
  },
});
