/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  ApplicationCommandInputType,
  ApplicationCommandOptionType,
  findOption,
  sendBotMessage,
} from "@api/Commands";
import {
  addMessageAccessory,
  removeMessageAccessory,
} from "@api/MessageAccessories";
import { managedStyleRootNode } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { createAndAppendStyle } from "@utils/css";
import definePlugin from "@utils/types";
import { ChannelStore } from "@webpack/common";

import { changePassphrase, looksLikeArmoredPrivateKey, normalizeArmoredText } from "./crypto";
import { getOwnPublicKeyArmored, importFriendPublicKey } from "./keyExchange";
import {
  getOwnKeypair,
  listKnownUsers,
  saveOwnKeypair,
  warmKeyring,
} from "./keystore";
import {
  handlePgpMessageCreate,
  installPgpNotificationInterceptor,
  showPgpTestNotification,
  uninstallPgpNotificationInterceptor,
} from "./notifications";
import {
  isPgpEnabled,
  registerOutgoingEncryption,
  setPgpEnabled,
  unregisterOutgoingEncryption,
} from "./outgoing";
import { PgpAttachments } from "./PgpAttachments";
import { PgpDecryptedAccessory } from "./PgpDecryptedAccessory";
import { PGPReplyPreview } from "./replyPreview";
import {
  createAndUnlockNewKeypair,
  isUnlocked,
  lockSession,
  unlockSession,
} from "./session";
import { settings } from "./settings";
import {
  registerUploadEncryption,
  unregisterUploadEncryption,
} from "./upload";

let pgpStyle: HTMLStyleElement;

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

  // The message row used to be tagged by patching "Message must not be a
  // thread starter message", but Discord changed that code — stock
  // MessageLogger fails on the identical string — and the class silently
  // stopped being applied. The accessories now tag their own row via
  // useTagMessageRow(), which depends on nothing minified. The reply-quote
  // panel, however, has no accessory hook, so it still needs the one patch
  // below.
  patches: [
    {
      // Same module anchor as the official ReplyTimestamp/ValidReply plugins:
      // the chat reply-quote renderer. PGPReplyPreview writes the decrypted
      // text into Discord's native preview element, so the reply keeps
      // Discord's exact structure and styling (see replyPreview.tsx).
      find: "#{intl::REPLY_QUOTE_MESSAGE_NOT_LOADED}",
      replacement: {
        match: /\.onClickReply,.+?}\),(?=\i,\i,\i\])/,
        replace: "$&$self.PGPReplyPreview(arguments[0]),",
      },
    },
  ],

  flux: {
    MESSAGE_CREATE: handlePgpMessageCreate,
  },

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
          const { passphrase } = settings.store;
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

    // ✅ VIEW YOUR OWN KEYS
    {
      name: "pgp-mykeys",
      description: "View your saved PGP keypair details",
      inputType: ApplicationCommandInputType.BUILT_IN,
      options: [
        {
          name: "showkey",
          description: "Also print the full armored public key block",
          type: ApplicationCommandOptionType.BOOLEAN,
          required: false,
        },
      ],
      execute: async (args, ctx) => {
        try {
          const record = await getOwnKeypair();
          if (!record) {
            return sendBotMessage(ctx.channel.id, {
              content:
                "❌ No keypair found. Run `/pgp-generate` to create one.",
            });
          }

          const date = new Date(record.createdAt).toLocaleString();
          let content =
            "**Your PGP Keypair**\n" +
            `Fingerprint: \`${record.fingerprint}\`\n` +
            `Created: ${date}\n` +
            "Private key: ✅ Stored\n" +
            "Public key: ✅ Stored";

          if (findOption(args, "showkey", false)) {
            content += `\n\n**Public key:**\n\`\`\`\n${record.publicKeyArmored}\n\`\`\``;
          }

          return sendBotMessage(ctx.channel.id, { content });
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

    // ✅ LIST OTHER USERS' SAVED PUBLIC KEYS
    {
      name: "pgp-listkeys",
      description: "List all saved PGP public keys from contacts",
      inputType: ApplicationCommandInputType.BUILT_IN,
      options: [
        {
          name: "showkey",
          description: "Also print each full armored public key block",
          type: ApplicationCommandOptionType.BOOLEAN,
          required: false,
        },
      ],
      execute: async (args, ctx) => {
        try {
          const users = await listKnownUsers();

          if (!users.length) {
            return sendBotMessage(ctx.channel.id, {
              content:
                "No saved public keys. Use `/pgp-import` in a DM to add one.",
            });
          }

          const showKey = findOption(args, "showkey", false);

          let content = `**Saved Public Keys** (${users.length})\n`;
          for (const user of users) {
            const date = new Date(user.addedAt).toLocaleString();
            content +=
              `\n<@${user.userId}>` +
              `\nFingerprint: \`${user.fingerprint}\`` +
              `\nAdded: ${date}` +
              `\nAuto-encrypt: ${user.autoEncryptEnabled ? "✅" : "❌"}` +
              ` · Trusted: ${user.trusted ? "✅" : "❌"}`;

            if (showKey) {
              content += `\n\`\`\`\n${user.publicKeyArmored}\n\`\`\``;
            }

            content += "\n";
          }

          return sendBotMessage(ctx.channel.id, { content });
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

    // ✅ CHANGE PASSPHRASE
    // Safe: the passphrase only protects the private key at rest. Messages are
    // encrypted to the public key, which does not change — so nothing already
    // sent or received becomes unreadable, and the other side is unaffected.
    {
      name: "pgp-passphrase",
      description: "Change the passphrase protecting your private key",
      inputType: ApplicationCommandInputType.BUILT_IN,
      options: [
        {
          name: "new",
          description: "The new passphrase",
          type: ApplicationCommandOptionType.STRING,
          required: true,
        },
        {
          name: "old",
          description: "Current passphrase (defaults to the one in settings)",
          type: ApplicationCommandOptionType.STRING,
          required: false,
        },
      ],
      execute: async (args, ctx) => {
        try {
          const next = findOption(args, "new", "");
          const current = findOption(args, "old", "") || settings.store.passphrase;

          if (!next) {
            return sendBotMessage(ctx.channel.id, {
              content: "❌ The new passphrase cannot be empty.",
            });
          }

          const record = await getOwnKeypair();
          if (!record) {
            return sendBotMessage(ctx.channel.id, {
              content: "❌ You have no keypair yet. Run `/pgp-generate` first.",
            });
          }

          // Throws on a wrong old passphrase, before anything is written.
          const reArmored = await changePassphrase(
            record.privateKeyArmored,
            current,
            next,
          );

          // Order matters. The key must be saved before the stored passphrase is
          // updated: if this were the other way round and the write failed, the
          // settings would hold a passphrase that does not open the stored key.
          await saveOwnKeypair({ ...record, privateKeyArmored: reArmored });
          settings.store.passphrase = next;

          // The in-memory key is already unlocked and unchanged, so the session
          // keeps working. Re-unlock anyway so state cannot drift.
          await unlockSession(next);

          return sendBotMessage(ctx.channel.id, {
            content:
              "🔑 Passphrase changed.\n" +
              "Your key is unchanged, so every message and file you have already sent or received stays readable, and your friend does not need to do anything.",
          });
        } catch {
          return sendBotMessage(ctx.channel.id, {
            content:
              "❌ Wrong current passphrase — nothing was changed.\n" +
              "Pass the correct one explicitly: `/pgp-passphrase new:<new> old:<current>`",
          });
        }
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

    {
      name: "pgp-test-notification",
      description: "Show a locally encrypted PGP notification test",
      inputType: ApplicationCommandInputType.BUILT_IN,
      execute: async (_args, ctx) => {
        try {
          await showPgpTestNotification();
          return sendBotMessage(ctx.channel.id, {
            content: "PGP notification test sent locally. It should say: `PGP notification decrypted successfully.`",
          });
        } catch (error) {
          return sendBotMessage(ctx.channel.id, {
            content: `PGP notification test failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
    },

    // ✅ UNLOCK
    {
      name: "pgp-unlock",
      description: "Unlock your PGP private key for this session",
      inputType: ApplicationCommandInputType.BUILT_IN,
      execute: async (_args, ctx) => {
        const { passphrase } = settings.store;

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

    // ✅ EXPORT OWN KEYPAIR
    {
      name: "pgp-export",
      description: "Export your own PGP public and/or private key for use in other tools",
      inputType: ApplicationCommandInputType.BUILT_IN,
      options: [
        {
          name: "type",
          description: "Which key to export",
          type: ApplicationCommandOptionType.STRING,
          required: false,
          choices: [
            { name: "Both keys (public + private)", label: "Both keys (public + private)", value: "both", displayName: "Both keys (public + private)" },
            { name: "Public key only", label: "Public key only", value: "public", displayName: "Public key only" },
            { name: "Private key only", label: "Private key only", value: "private", displayName: "Private key only" },
          ],
        },
      ],
      execute: async (args, ctx) => {
        try {
          const record = await getOwnKeypair();
          if (!record) {
            return sendBotMessage(ctx.channel.id, {
              content: "❌ No keypair found. Run `/pgp-generate` first.",
            });
          }

          const type = findOption(args, "type", "both");
          const parts: string[] = [];

          if (type === "both" || type === "public") {
            parts.push(`**Public key:**\n\`\`\`\n${record.publicKeyArmored}\n\`\`\``);
          }
          if (type === "both" || type === "private") {
            parts.push(
              "⚠️ **The private key below unlocks all your encrypted messages. Do not share it.**\n" +
              `\`\`\`\n${record.privateKeyArmored}\n\`\`\``
            );
          }

          return sendBotMessage(ctx.channel.id, { content: parts.join("\n\n") });
        } catch (err) {
          return sendBotMessage(ctx.channel.id, {
            content: `Error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      },
    },

    // ✅ IMPORT OWN KEYPAIR
    {
      name: "pgp-import-keypair",
      description: "Import a PGP keypair (private + optional public) to use as your own",
      inputType: ApplicationCommandInputType.BUILT_IN,
      options: [
        {
          name: "privatekey",
          description: "Armored private key block",
          type: ApplicationCommandOptionType.STRING,
          required: true,
        },
        {
          name: "publickey",
          description: "Armored public key block (derived from private key if omitted)",
          type: ApplicationCommandOptionType.STRING,
          required: false,
        },
        {
          name: "force",
          description: "Overwrite existing keypair (WARNING: breaks unread encrypted messages)",
          type: ApplicationCommandOptionType.BOOLEAN,
          required: false,
        },
      ],
      execute: async (args, ctx) => {
        try {
          const rawPrivate = findOption(args, "privatekey", "");
          const rawPublic = findOption(args, "publickey", "");

          const normalizedPrivate = normalizeArmoredText(rawPrivate);
          if (!looksLikeArmoredPrivateKey(normalizedPrivate)) {
            return sendBotMessage(ctx.channel.id, {
              content: "❌ The provided private key does not look like a valid armored PGP private key block.",
            });
          }

          // Validate by reading the key with openpgp
          const openpgp = await import("openpgp");
          const parsedPrivate = await openpgp.readPrivateKey({ armoredKey: normalizedPrivate });

          let publicKeyArmored: string;
          let fingerprint: string;

          if (rawPublic) {
            const normalizedPublic = normalizeArmoredText(rawPublic);
            const parsedPublic = await openpgp.readKey({ armoredKey: normalizedPublic });
            publicKeyArmored = parsedPublic.armor();
            fingerprint = parsedPublic.getFingerprint();
          } else {
            // Derive the public key from the private key
            const publicKey = parsedPrivate.toPublic();
            publicKeyArmored = publicKey.armor();
            fingerprint = parsedPrivate.getFingerprint();
          }

          const existing = await getOwnKeypair();
          if (existing && !findOption(args, "force", false)) {
            return sendBotMessage(ctx.channel.id, {
              content:
                "⚠️ You already have a keypair (fingerprint `" + existing.fingerprint + "`).\n" +
                "To replace it, re-run with `force:true`. This will make messages encrypted to the old key unreadable.",
            });
          }

          await saveOwnKeypair({
            privateKeyArmored: normalizedPrivate,
            publicKeyArmored,
            fingerprint,
            createdAt: Date.now(),
          });

          return sendBotMessage(ctx.channel.id, {
            content:
              "✅ Keypair imported and saved.\n" +
              `Fingerprint: \`${fingerprint}\`\n` +
              "Run `/pgp-unlock` to unlock it for this session.",
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
  ],

  PGPReplyPreview: ErrorBoundary.wrap(PGPReplyPreview, { noop: true }),

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
        white-space: pre-wrap;
      }
      /* Trailing marker, styled after Discord's own "(edited)": quiet enough to
         ignore while reading, there when you look for it. */
      .vc-pgp-badge {
        display: inline-flex;
        align-items: center;
        margin-left: 0.25rem;
        vertical-align: -1px;
        color: var(--text-muted, var(--text-normal, inherit));
        opacity: 0.45;
        cursor: default;
        transition: opacity 0.1s ease;
      }
      .vc-pgp-badge:hover {
        opacity: 1;
      }
      /* An invalid signature is not something to be subtle about. */
      .vc-pgp-badge--warn {
        color: var(--text-danger, var(--status-danger, currentColor));
        opacity: 1;
      }
      /* A colour was picked deliberately in settings, so stop dimming it. */
      .vc-pgp-badge--custom {
        opacity: 0.9;
      }
      .vc-pgp-notice {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        color: var(--text-muted, var(--text-normal, inherit)) !important;
        font-size: 0.875rem;
      }
      .vc-pgp-embeds {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.25rem;
        margin-top: 0.25rem;
      }
      .vc-pgp-embed-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.25rem 0.5rem;
        border: 1px solid var(--background-modifier-accent, rgba(128, 128, 128, 0.3));
        border-radius: 4px;
        background: none;
        color: var(--text-muted, var(--text-normal, inherit));
        font-size: 0.8125rem;
        cursor: pointer;
        transition: color 0.1s ease, border-color 0.1s ease;
      }
      .vc-pgp-embed-chip:hover {
        color: var(--text-default, var(--text-normal, inherit));
        border-color: var(--text-muted, rgba(128, 128, 128, 0.6));
      }
      .vc-pgp-embed-frame {
        border: 0;
        border-radius: 4px;
        width: 100%;
        max-width: 400px;
        margin-top: 0.5rem;
      }
      /* Mirrors Discord's own embed: left accent bar, muted panel, 432px cap. */
      .vc-pgp-embed {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        max-width: 432px;
        margin-top: 0.5rem;
        padding: 0.5rem 1rem 1rem 0.75rem;
        border-left: 4px solid var(--background-modifier-accent, rgba(128, 128, 128, 0.4));
        border-radius: 4px;
        background: var(--background-secondary, rgba(128, 128, 128, 0.1));
      }
      .vc-pgp-embed-provider {
        margin-top: 0.5rem;
        color: var(--text-muted, inherit);
        font-size: 0.75rem;
      }
      .vc-pgp-embed-title {
        margin-top: 0.5rem;
        color: var(--text-link, #00a8fc);
        font-size: 1rem;
        font-weight: 600;
        line-height: 1.375rem;
      }
      .vc-pgp-embed-title:hover {
        text-decoration: underline;
      }
      .vc-pgp-embed-description {
        margin-top: 0.5rem;
        color: var(--text-muted, inherit);
        font-size: 0.875rem;
        line-height: 1.125rem;
        white-space: pre-wrap;
      }
      /* Discord's native reply preview contains the raw armored message. Hide
         it for encrypted replies and render the decrypted sibling instead. */
      .vc-pgp-reply [class*="repliedTextContent"],
      .vc-pgp-reply [class*="repliedTextPreview"] {
        display: none !important;
      }
      .vc-pgp-reply-text {
        color: var(--text-default, var(--text-normal, inherit));
        font-size: 0.875rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
        cursor: pointer;
      }
      .vc-pgp-reply-text:hover {
        color: var(--interactive-active, var(--text-default, var(--text-normal, inherit)));
        filter: brightness(1.1);
      }
      .vc-pgp-reply:hover [class*="repliedMessageClickableSpine"] {
        color: var(--interactive-active, var(--text-normal, inherit)) !important;
        filter: brightness(1.1);
      }
      .vc-pgp-embed-image {
        margin-top: 0.5rem;
        max-width: 100%;
        border-radius: 4px;
      }
      /* A directly-linked gif/image/video: bare and inline, no card. */
      .vc-pgp-embed-media {
        display: block;
        max-width: 400px;
        max-height: 350px;
        margin-top: 0.25rem;
        border-radius: 4px;
      }
      .vc-pgp-embed-media--image {
        cursor: zoom-in;
      }
      /* Thumbnail doubling as the play button, the way Discord's video embeds do. */
      .vc-pgp-embed-thumb-button {
        position: relative;
        display: block;
        padding: 0;
        border: 0;
        background: none;
        cursor: pointer;
      }
      .vc-pgp-embed-play {
        position: absolute;
        top: 50%;
        left: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 3rem;
        height: 3rem;
        transform: translate(-50%, -50%);
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.65);
        color: #fff;
      }
      .vc-pgp-embed-play svg {
        width: 20px;
        height: 20px;
        margin-left: 2px;
      }
      .vc-pgp-embed-thumb-button:hover .vc-pgp-embed-play {
        background: rgba(0, 0, 0, 0.85);
      }
      /* Hide the opaque .pgp blob Discord renders; our accessory draws the real
         file in its place. The :not() is load-bearing — our own decrypted media
         lives in .vc-pgp-attachment*, which would otherwise match this selector
         and hide the very thing we are trying to show. */
      .vc-pgp-has-encrypted-file [class*="attachment" i]:not([class*="vc-pgp"]),
      .vc-pgp-has-encrypted-file [class*="mediaItem" i]:not([class*="vc-pgp"]) {
        display: none !important;
      }
      .vc-pgp-attachments {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.25rem;
        margin-top: 0.25rem;
      }
      .vc-pgp-attachment-media {
        max-width: 400px;
        max-height: 350px;
        border-radius: 4px;
      }
      .vc-pgp-attachment-image {
        cursor: zoom-in;
      }
      /* Strip the modal chrome so only the image floats on the backdrop. */
      .vc-pgp-lightbox {
        position: relative;
        background: transparent !important;
        box-shadow: none !important;
        border: none !important;
        /* Must stay visible: the toolbar is positioned above the image. */
        overflow: visible !important;
      }
      .vc-pgp-lightbox-image {
        display: block;
        max-width: 90vw;
        max-height: 90vh;
        border-radius: 4px;
        cursor: zoom-out;
      }
      /* Toolbar in the corner, where Discord puts its own. */
      .vc-pgp-lightbox-actions {
        position: absolute;
        top: -2.75rem;
        right: 0;
        display: flex;
        gap: 0.25rem;
      }
      .vc-pgp-lightbox-action {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 2rem;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.5);
        color: #fff;
        cursor: pointer;
        transition: background 0.1s ease;
      }
      .vc-pgp-lightbox-action:hover {
        background: rgba(0, 0, 0, 0.8);
      }
      .vc-pgp-attachment-file {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        max-width: 432px;
        padding: 0.625rem 0.75rem;
        border: 1px solid var(--background-modifier-accent, rgba(128, 128, 128, 0.3));
        border-radius: 4px;
        background: var(--background-secondary, rgba(128, 128, 128, 0.1));
        color: var(--text-link, #00a8fc);
        font-size: 0.875rem;
      }
      .vc-pgp-attachment-file:hover {
        text-decoration: underline;
      }
      .vc-pgp-attachment-size {
        color: var(--text-muted, inherit);
        font-size: 0.75rem;
      }
    `;

    registerOutgoingEncryption();
    registerUploadEncryption();
    installPgpNotificationInterceptor();

    // Warm the in-memory keyring cache up front. Decryption reads keys on every
    // message; reading them here (and caching them) means each decrypt no longer
    // races a lazily-initialising IndexedDB, which intermittently produced a
    // false "signature invalid" verdict that a reload always cleared.
    warmKeyring();

    // The unlocked key only ever lives in memory, so a client restart always
    // comes back locked. Without this the setting was declared but never read.
    if (settings.store.autoUnlockOnStart && settings.store.passphrase) {
      unlockSession(settings.store.passphrase).catch(() => {});
    }

    addMessageAccessory("pgp-decrypted-content", props => {
      const { message } = props;
      const content: string = message?.content ?? "";

      if (!content.includes("-----BEGIN PGP MESSAGE-----")) return null;

      return (
        <PgpDecryptedAccessory
          content={content}
          senderId={message.author.id}
        />
      );
    });

    addMessageAccessory("pgp-decrypted-attachments", props => {
      const { message } = props;

      const encrypted = (message?.attachments ?? []).filter(
        (a: any) => a?.filename?.endsWith(".pgp"),
      );
      if (!encrypted.length) return null;

      // A failed attachment must never blank the message it sits under.
      return (
        <ErrorBoundary noop>
          <PgpAttachments
            attachments={encrypted}
            senderId={message.author.id}
          />
        </ErrorBoundary>
      );
    });
  },

  stop() {
    pgpStyle?.remove();
    lockSession();
    unregisterOutgoingEncryption();
    unregisterUploadEncryption();
    uninstallPgpNotificationInterceptor();
    removeMessageAccessory("pgp-decrypted-content");
    removeMessageAccessory("pgp-decrypted-attachments");
  },
});
