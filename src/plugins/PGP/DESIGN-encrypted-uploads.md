# Encrypted media uploads — design

**Date:** 2026-07-13
**Plugin:** `src/userplugins/PGP` (upstream: `src/plugins/PGP` on `Williamjensen17/Vencord`, branch `feat/PGP`)
**Status:** approved design, not yet implemented

## Problem

The plugin's own description claims it "encrypts outgoing messages/files with PGP". It does not
touch files at all. An image sent in a DM with PGP enabled and the padlock showing is uploaded to
Discord's CDN **completely unencrypted**. The UI actively implies otherwise, which is worse than
having no feature.

Goal: attachments in a 1:1 DM with a known PGP contact are encrypted before any byte leaves the
machine, and are decrypted and rendered inline on receipt so they look like ordinary Discord
attachments.

## Non-goals

- Group DMs and guild channels. The plugin is 1:1-DM only; this does not change that.
- Hiding the *existence* of an attachment, or its size. Discord always learns both.
- Encrypting Discord-native previews/thumbnails. There will be none, by construction.
- A separate integrity hash. See "Why no hash".

## Findings that drive the design

These were measured in the running client with a read-only probe, not inferred.

**Discord pre-uploads attachments on attach, not on send.** Observed timeline for one image:

| time | method | `status` | `uploadedFilename` | `item.file` |
|---|---|---|---|---|
| +37.9s (attach) | `CloudUpload.upload()` | `NOT_STARTED` | `undefined` | `image/png`, 40352 B |
| +38.2s | `uploadFileToCloud()` | `STARTED` | reserved | `image/webp`, 29296 B |
| +55.2s (**send**) | `uploadFiles()` | `COMPLETED` | reserved | `image/webp`, 29296 B |

Consequences:

1. **`uploadFiles()` is unusable as the encryption hook.** By the time it runs the file is already
   `COMPLETED` — sitting on `discord-attachments-uploads-prd.storage.googleapis.com`. Encrypting
   there would show a padlock over a file that had already leaked. (This is the hook
   `anonymiseFileNames` uses, which is fine for *renaming* — the displayed name comes from the
   message payload — but fatal for encrypting.)

2. **`CloudUpload.prototype.upload()` is the correct hook.** On entry, nothing has been reserved or
   sent, and `item.file` is still the **original** file — before Discord's lossy WebP transcode,
   which happens inside `upload()`.

3. `currentSize` / `preCompressionSize` equal `item.file.size` on entry and are recomputed
   downstream, so replacing `item.file` gets the attachment registered with the ciphertext's real
   size.

## Wire format

Binary OpenPGP, **not ASCII-armored**. Armor is base64: it inflates a file ~33%, which would push a
9 MB video past Discord's 10 MB limit as a pure encoding artifact. Binary ciphertext is ≈ plaintext
size.

The original filename travels **inside** the encrypted payload, via OpenPGP's own literal-data
packet:

```ts
const message = await openpgp.createMessage({ binary: bytes, filename: originalName });
const ciphertext = await openpgp.encrypt({
  message,
  encryptionKeys: [recipientKey, ownKey],
  signingKeys: [ownPrivateKey],
  format: "binary",
});
```

That field is encrypted and signed along with the contents, so the opaque-filename property comes
for free — no custom container, no side-channel metadata to keep in sync. `openpgp.decrypt` returns
it as `result.filename`.

Uploaded as `<random-hex>.pgp`, `application/octet-stream`. Discord sees an opaque blob of a given
size and nothing else.

### Why no hash

The original idea was to send an integrity hash alongside. It is not needed, and sending it would
be harmful:

- **Integrity is already covered.** OpenPGP ciphertext carries an integrity check (AEAD in v6, MDC
  in older SEIPD packets). Flip one byte and `openpgp.decrypt` **throws**; it does not return
  corrupt plaintext.
- **Authenticity is already covered.** We sign, and the signature covers the plaintext *and* the
  filename.
- **A plaintext hash would leak.** It is a fingerprint of the file. Anyone holding the ciphertext —
  Discord, or anyone with the CDN link — could hash a file they *suspect* was sent and compare,
  turning "opaque blob" into "confirmed: this exact known file". A confirmation-of-a-guess attack,
  for zero security gain.
- A hash placed *inside* the encrypted payload avoids the leak but is then pure redundancy with the
  AEAD tag.

## Outgoing

Wrap `CloudUpload.prototype.upload` at plugin start. The class is reachable the way `voiceMessages`
gets it: `findLazy(m => m.prototype?.trackUploadFinished)`.

```
upload() called
  ├─ PGP disabled?            → call through untouched
  ├─ not a 1:1 DM?            → call through untouched
  ├─ no key for recipient?    → BLOCK (see below)
  ├─ encryption throws?       → BLOCK
  └─ else
       read item.file → bytes
       encrypt (binary, signed, to [them, us])
       item.file  = new File([ct], `${randomHex()}.pgp`, { type: "application/octet-stream" })
       filename   = that name (via setFilename())
       mimeType   = "application/octet-stream"
       isImage    = false
       isVideo    = false
       → call through
```

`isImage`/`isVideo` must be cleared so Discord's transcode path skips our ciphertext.

**Fail closed.** On block: do **not** call the original `upload()`, call `removeFromMsgDraft()` so
the attachment disappears from the composer, and send a Clyde message explaining
("No PGP key for @X — upload blocked. Run `/pgp-import` first, or `/pgp-toggle` to send
unencrypted on purpose."). Nothing is registered and nothing is sent. Failure happens before the
network, which is the only place it can be undone.

This is deliberately stricter than outgoing *text*, which currently sends plaintext when no key is
known. A leaked message can at least be deleted from a conversation you control; a leaked file is on
a CDN the moment it lands.

## Incoming

Mirrors the existing text path, for consistency.

1. A message patch tags messages carrying `.pgp` attachments, and CSS hides Discord's native
   attachment card for them (same technique as `.vc-pgp-encrypted` hiding `messageContent`).
2. A message accessory renders our own view: fetch the ciphertext from the CDN, decrypt, recover the
   real filename from the literal packet, sniff the type from its extension, and render an `<img>`,
   `<video>`, `<audio>`, or a download card — from a `blob:` URL, so it looks native.
3. Decryption result is cached per attachment id; `blob:` URLs are revoked on unmount (a 50 MB video
   re-leaked on every remount would be ugly).
4. The whole subtree sits behind `ErrorBoundary`. **A failed attachment must never blank the
   message it sits under** — the same rule the link embeds already follow, learned the hard way.

Signature status reuses the existing badge: padlock for verified/unknown, warning glyph only for a
signature that genuinely failed.

## Risks / open questions

| Risk | Handling |
|---|---|
| WebP transcode ran despite `maybeConvertToWebP` never firing in the probe — the real path is something else inside `upload()`. | Clearing `isImage`/`isVideo` *should* make it skip. **Verify with the probe that swapped bytes reach `uploadFileToCloud()` unmangled before trusting this.** |
| CDN fetch from the renderer may be blocked by CORS. | Fall back to fetching in `native.ts`, as the link-embed scraper already does. |
| Discord's CSP may not permit `blob:` in `img-src`/`media-src`. | Likely fine (Discord uses blobs itself). If not, fall back to `data:` URIs — costs ~33% memory. |
| Large files: encrypting a 50 MB video in the renderer could jank the UI. | Acceptable for v1. If it bites, move encryption to `native.ts`. |
| A resumed upload (`supportsResume`) against a swapped file would splice two ciphertexts. | Not reachable: we mutate before `upload()` proceeds, while `status` is `NOT_STARTED`. |

## Test plan

Manual, in a live DM (there is no test harness in this repo):

1. **Encrypts before the wire.** Attach an image, do **not** send, and confirm via the Network tab
   that the bytes PUT to `storage.googleapis.com` are the `.pgp` ciphertext, not the image. This is
   the test that actually matters.
2. **Round-trip.** William receives it, sees the image inline with the original filename.
3. **Fidelity.** The received file is byte-identical to the original — no WebP transcode.
4. **Fail closed.** Remove his key, attach a file, confirm the upload is blocked and *nothing*
   appears in the Network tab.
5. **Plugin off.** Confirm a raw `.pgp` attachment is visible, proving the ciphertext is what's
   really on the CDN.
6. **Degradation.** A corrupt/undecryptable `.pgp` attachment shows an error, and the message text
   around it still renders.
