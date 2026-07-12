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
  setPgpEnabled,
  isPgpEnabled,
} from "./outgoing";

import { PgpDecryptedAccessory } from "./PgpDecryptedAccessory";

const settings = definePluginSettings({
  autoEncryptDms: {
    type: OptionType.BOOLEAN,
    default: true,
    description: "Automatically encrypt outgoing DMs to known PGP users",
  },
  autoDecrypt: {
    type: OptionType.BOOLEAN,
    default: true,
    description: "Automatically decrypt incoming PGP messages",
  },
  signMessages: {
    type: OptionType.BOOLEAN,
    default: true,
    description: "Sign outgoing encrypted messages",
  },
  promptBeforeTrust: {
    type: OptionType.BOOLEAN,
    default: true,
    description: "Prompt before trusting new public keys",
  },
  passphrase: {
    type: OptionType.STRING,
    default: "",
    description: "Session passphrase for unlocking private key",
  },
  autoUnlockOnStart: {
    type: OptionType.BOOLEAN,
    default: false,
    description: "Auto-unlock on startup",
  },
});

export default definePlugin({
  name: "PGP",
  description:
    "Encrypts outgoing messages/files with PGP and decrypts incoming ones.",
  authors: [{ name: "William", id: 0n }],
  settings,

  commands: [
    // ✅ SEND YOUR PUBLIC KEY
    {
      name: "pgp-pubkey",
      description: "Send your PGP public key in this channel",
      execute: async () => {
        try {
          const armored = await getOwnPublicKeyArmored();
          return { content: armored };
        } catch (err) {
          return {
            content: `Error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          };
        }
      },
    },

    // ✅ IMPORT FRIEND PUBLIC KEY
    {
      name: "pgp-import",
      description: "Import a friend's PGP public key (1:1 DM only)",
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
                "This command must be run inside a 1:1 DM.",
            };
          }

          const entry = await importFriendPublicKey(userId, key);

          return {
            content:
              `✅ Imported key for <@${userId}>\n` +
              `Fingerprint: ${entry.fingerprint}`,
          };
        } catch (err) {
          return {
            content: `Error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          };
        }
      },
    },

    // ✅ TOGGLE ENCRYPTION
    {
      name: "pgp-toggle",
      description: "Quickly enable/disable PGP encryption",
      execute: async () => {
        const next = !isPgpEnabled();
        setPgpEnabled(next);

        if (!next) {
          lockSession();
        }

        return {
          content: next
            ? "🔐 PGP encryption ENABLED."
            : "🔓 PGP encryption DISABLED.",
        };
      },
    },

    // ✅ STATUS
    {
      name: "pgp-status",
      description: "Show current PGP session status",
      execute: async () => {
        return {
          content:
            `PGP Enabled: ${isPgpEnabled() ? "✅ Yes" : "❌ No"}\n` +
            `Session Unlocked: ${isUnlocked() ? "✅ Yes" : "❌ No"}`,
        };
      },
    },

    // ✅ UNLOCK
    {
      name: "pgp-unlock",
      description: "Unlock your PGP private key for this session",
      execute: async () => {
        const passphrase = settings.store.passphrase;

        if (!passphrase) {
          return { content: "No passphrase set in plugin settings." };
        }

        const ok = await unlockSession(passphrase);

        return ok
          ? { content: "PGP unlocked ✅" }
          : { content: "Incorrect passphrase ❌" };
      },
    },
  ],

  async start() {
    registerOutgoingEncryption();

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

    console.log("[PGP] Encryption is ENABLED by default.");
  },

  stop() {
    lockSession();
    unregisterOutgoingEncryption();
    removeMessageAccessory("pgp-decrypted-content");
  },
});
