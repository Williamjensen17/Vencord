import definePlugin, { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import {
  addMessageAccessory,
  removeMessageAccessory,
} from "@api/MessageAccessories";
import {
  ApplicationCommandInputType,
  ApplicationCommandOptionType,
  findOption,
  sendBotMessage,
} from "@api/Commands";
import { ChannelStore } from "@webpack/common";
import { createAndAppendStyle } from "@utils/css";
import { managedStyleRootNode } from "@api/Styles";

import {
  getOwnKeypair,
  listKnownUsers,
  saveOwnKeypair,
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

let pgpStyle: HTMLStyleElement;

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

  // Without these Vencord won't auto-enable the APIs, and the missing
  // MessageEventsAPI silently skips outgoing encryption (messages send in
  // plaintext with no warning).
  dependencies: [
    "MessageEventsAPI",
    "MessageAccessoriesAPI",
    "CommandsAPI",
  ],

  patches: [
    {
      find: "Message must not be a thread starter message",
      replacement: {
        match: /\)\("li",\{(.+?),className:/,
        replace: ")(\"li\",{$1,className:(arguments[0].message?.content?.includes(\"-----BEGIN PGP MESSAGE-----\")?\"vc-pgp-encrypted \":\"\")+"
      },
    },
  ],

  commands: [
    // Create your keypair. Nothing else works until this has been run once.
    {
      name: "pgp-generate",
      description:
        "Generate your PGP keypair (uses the passphrase from plugin settings)",
      inputType: ApplicationCommandInputType.BUILT_IN,
      options: [
        {
          name: "name",
          description: "Identity name for the key (default: your Discord name)",
          type: ApplicationCommandOptionType.STRING,
          required: false,
        },
        {
          name: "email",
          description: "Identity email for the key (optional)",
          type: ApplicationCommandOptionType.STRING,
          required: false,
        },
      ],
      execute: async (args, ctx) => {
        try {
          const passphrase = settings.store.passphrase;
          if (!passphrase) {
            return sendBotMessage(ctx.channel.id, {
              content:
                "❌ Set a **passphrase** in the PGP plugin settings first, then run this again.",
            });
          }

          const existing = await getOwnKeypair();
          if (existing) {
            return sendBotMessage(ctx.channel.id, {
              content:
                `⚠️ You already have a keypair (fingerprint \`${existing.fingerprint}\`).\n` +
                "Generating a new one would make messages encrypted to the old key unreadable, so this is a no-op.",
            });
          }

          const name = findOption(args, "name", "Vencord PGP User");
          const email = findOption(args, "email", "pgp@vencord.local");

          await createAndUnlockNewKeypair(name, email, passphrase);
          const record = await getOwnKeypair();

          return sendBotMessage(ctx.channel.id, {
            content:
              "🔑 Keypair generated and unlocked for this session.\n" +
              `Fingerprint: \`${record?.fingerprint}\`\n` +
              "Next: run `/pgp-pubkey` in a DM to share your public key.",
          });
        } catch (err) {
          return sendBotMessage(ctx.channel.id, {
            content: `Error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      },
    },

    // ✅ SEND YOUR PUBLIC KEY
    {
      name: "pgp-pubkey",
      description: "Send your PGP public key in this channel",
      // The only command that intentionally transmits — sharing the public key is
      // the whole point, and BUILT_IN_TEXT is what makes the returned content get
      // sent as a real message. Its failure path must still stay local.
      inputType: ApplicationCommandInputType.BUILT_IN_TEXT,
      execute: async (_args, ctx) => {
        try {
          const armored = await getOwnPublicKeyArmored();
          return { content: armored };
        } catch (err) {
          return sendBotMessage(ctx.channel.id, {
            content: `Error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      },
    },

    // ✅ IMPORT FRIEND PUBLIC KEY
    {
      name: "pgp-import",
      description: "Import a friend's PGP public key (1:1 DM only)",
      inputType: ApplicationCommandInputType.BUILT_IN,
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
            return sendBotMessage(ctx.channel.id, {
              content: "This command must be run inside a 1:1 DM.",
            });
          }

          const entry = await importFriendPublicKey(userId, key);

          return sendBotMessage(ctx.channel.id, {
            content:
              `✅ Imported key for <@${userId}>\n` +
              `Fingerprint: ${entry.fingerprint}`,
          });
        } catch (err) {
          return sendBotMessage(ctx.channel.id, {
            content: `Error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      },
    },

    // ✅ TOGGLE ENCRYPTION
    {
      name: "pgp-toggle",
      description: "Quickly enable/disable PGP encryption",
      inputType: ApplicationCommandInputType.BUILT_IN,
      execute: async (_args, ctx) => {
        const next = !isPgpEnabled();
        setPgpEnabled(next);

        // Deliberately does NOT lock the key. Encrypting outgoing messages and
        // being able to read the existing history are separate concerns, and
        // locking here made every already-decrypted message on screen revert to
        // "Private key locked."
        return sendBotMessage(ctx.channel.id, {
          content: next
            ? "🔐 PGP encryption ENABLED for outgoing messages."
            : "🔓 PGP encryption DISABLED for outgoing messages. (Your key stays unlocked — use `/pgp-lock` to lock it.)",
        });
      },
    },

    // ✅ LOCK
    {
      name: "pgp-lock",
      description: "Lock your PGP private key for this session",
      inputType: ApplicationCommandInputType.BUILT_IN,
      execute: async (_args, ctx) => {
        lockSession();
        return sendBotMessage(ctx.channel.id, {
          content: "🔒 Private key locked. Run `/pgp-unlock` to read encrypted messages again.",
        });
      },
    },

    // ✅ STATUS
    {
      name: "pgp-status",
      description: "Show current PGP session status",
      inputType: ApplicationCommandInputType.BUILT_IN,
      execute: async (_args, ctx) => {
        return sendBotMessage(ctx.channel.id, {
          content:
            `PGP Enabled: ${isPgpEnabled() ? "✅ Yes" : "❌ No"}\n` +
            `Session Unlocked: ${isUnlocked() ? "✅ Yes" : "❌ No"}`,
        });
      },
    },

    // ✅ UNLOCK
    {
      name: "pgp-unlock",
      description: "Unlock your PGP private key for this session",
      inputType: ApplicationCommandInputType.BUILT_IN,
      execute: async (_args, ctx) => {
        const passphrase = settings.store.passphrase;

        if (!passphrase) {
          return sendBotMessage(ctx.channel.id, {
            content: "No passphrase set in plugin settings.",
          });
        }

        const ok = await unlockSession(passphrase);

        return sendBotMessage(ctx.channel.id, {
          content: ok ? "PGP unlocked ✅" : "Incorrect passphrase ❌",
        });
      },
    },
  ],

  async start() {
    pgpStyle = createAndAppendStyle("VcPGPEncrypted", managedStyleRootNode);
    pgpStyle.textContent = `
      .vc-pgp-encrypted [class*="messageContent"] {
        display: none !important;
      }
      .vc-pgp-decrypted {
        /* Follow Discord's own text color instead of a hardcoded dark-theme
           hex, so custom themes and light mode render correctly.
           --text-default is current Discord; --text-normal is the legacy name. */
        color: var(--text-default, var(--text-normal, inherit)) !important;
      }
    `;

    registerOutgoingEncryption();

    // The unlocked key only ever lives in memory, so a client restart always
    // comes back locked. Without this the setting was declared but never read.
    if (settings.store.autoUnlockOnStart && settings.store.passphrase) {
      unlockSession(settings.store.passphrase).catch(() => {});
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

    console.log("[PGP] Encryption is ENABLED by default.");
  },

  stop() {
    pgpStyle?.remove();
    lockSession();
    unregisterOutgoingEncryption();
    removeMessageAccessory("pgp-decrypted-content");
  },
});
