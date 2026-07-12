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
  getSettings,
  saveSettings,
  getOwnKeypair,
  listKnownUsers,
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
      "Session passphrase used to unlock your private key (not stored)",
    default: "",
  },
});

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
  ],

  async start() {
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
    return getSettings();
  },

  async saveSettings(next: Awaited<ReturnType<typeof getSettings>>) {
    return saveSettings(next);
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
