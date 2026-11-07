/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
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
    // Editing this field does not re-encrypt the key — it only changes what we
    // try to unlock it with, so a stray edit just makes unlocking fail. Use
    // /pgp-passphrase, which re-encrypts the key and updates this together.
    description:
      "Passphrase used to unlock your private key (stored in plain text on disk). " +
      "To CHANGE your passphrase use /pgp-passphrase — editing this box does not re-encrypt your key, it will just stop unlocking it.",
  },
  autoUnlockOnStart: {
    type: OptionType.BOOLEAN,
    default: false,
    description: "Auto-unlock on startup (requires the passphrase above)",
  },
  lockIconColor: {
    type: OptionType.STRING,
    default: "",
    description: "Color of the decrypted lock icon — any CSS color, e.g. #5865f2. Leave blank for the default monochrome",
  },
  warningIconColor: {
    type: OptionType.STRING,
    default: "",
    description: "Color of the invalid-signature warning icon. Leave blank for Discord's danger red",
  },
  linkEmbeds: {
    type: OptionType.SELECT,
    description: "Discord cannot embed links in encrypted messages, so the plugin fetches them itself",
    options: [
      {
        label: "Automatic — behaves like a normal Discord embed",
        value: "auto",
        default: true,
      },
      {
        label: "Click to load — nothing is fetched until you ask (more private)",
        value: "click",
      },
      {
        label: "Off — no embeds",
        value: "off",
      },
    ],
  },
});
