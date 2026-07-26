import * as openpgp from "openpgp";

export interface GeneratedKeypair {
  privateKeyArmored: string;
  publicKeyArmored: string;
  fingerprint: string;
}

export async function generateKeypair(
  name: string,
  email: string,
  passphrase: string,
): Promise<GeneratedKeypair> {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: "ecc",
    // openpgp v6 renamed this curve; "curve25519" is only a deprecated alias.
    // The Legacy variant stays interoperable with standard GnuPG keys.
    curve: "curve25519Legacy",
    userIDs: [{ name, email }],
    passphrase,
    format: "armored",
  });

  const parsedPub = await openpgp.readKey({ armoredKey: publicKey });

  return {
    privateKeyArmored: privateKey,
    publicKeyArmored: publicKey,
    fingerprint: parsedPub.getFingerprint(),
  };
}

export async function unlockPrivateKey(
  privateKeyArmored: string,
  passphrase: string,
) {
  const privateKey = await openpgp.readPrivateKey({
    armoredKey: privateKeyArmored,
  });

  return openpgp.decryptKey({
    privateKey,
    passphrase,
  });
}

/**
 * Re-encrypts the private key under a new passphrase.
 *
 * Safe by construction: the passphrase only protects the private key at rest.
 * Messages are encrypted to the *public* key, which is untouched here — so no
 * existing message or file becomes unreadable, and the other side never needs to
 * know. (Regenerating the keypair is the operation that would destroy history.)
 *
 * Throws if the old passphrase is wrong, before anything is written.
 */
export async function changePassphrase(
  privateKeyArmored: string,
  oldPassphrase: string,
  newPassphrase: string,
): Promise<string> {
  const locked = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });

  const unlocked = await openpgp.decryptKey({
    privateKey: locked,
    passphrase: oldPassphrase,
  });

  const relocked = await openpgp.encryptKey({
    privateKey: unlocked,
    passphrase: newPassphrase,
  });

  return relocked.armor();
}

const BEGIN_ARMOR = /-----BEGIN PGP (?:PUBLIC KEY|PRIVATE KEY|MESSAGE|SIGNATURE) BLOCK-----/;
const END_ARMOR = /-----END PGP (?:PUBLIC KEY|PRIVATE KEY|MESSAGE|SIGNATURE) BLOCK-----/;

export function normalizeArmoredText(text: string): string {
  text = text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const beginMatch = BEGIN_ARMOR.exec(text);
  const endMatch = END_ARMOR.exec(text);

  if (!beginMatch || !endMatch || endMatch.index <= beginMatch.index) {
    return text;
  }

  const header = text.slice(beginMatch.index, beginMatch.index + beginMatch[0].length);
  const footer = text.slice(endMatch.index, endMatch.index + endMatch[0].length);
  const bodyArea = text.slice(beginMatch.index + beginMatch[0].length, endMatch.index);

  if (bodyArea.includes("\n")) {
    return text;
  }

  const base64Start = bodyArea.match(/[A-Za-z0-9+/]{20,}/);
  let body = (base64Start ? bodyArea.slice(base64Start.index) : bodyArea)
    .replace(/[^A-Za-z0-9+/=]/g, "");

  if (body.length === 0) {
    return text;
  }

  let checksum = "";
  const eqIdx = body.lastIndexOf("=");
  if (eqIdx !== -1 && body.length - eqIdx === 5) {
    checksum = body.slice(eqIdx);
    body = body.slice(0, eqIdx);
  }

  const lines: string[] = [];
  for (let i = 0; i < body.length; i += 76) {
    lines.push(body.slice(i, i + 76));
  }

  let result = header + "\n\n" + lines.join("\n");
  if (checksum) {
    result += "\n" + checksum;
  }
  result += "\n" + footer + "\n";
  return result;
}

export async function parsePublicKey(armoredKey: string) {
  const key = await openpgp.readKey({ armoredKey: normalizeArmoredText(armoredKey) });
  if (!key.isPrivate()) return key;
  return null;
}

export interface EncryptTextOptions {
  text: string;
  recipientPublicKeys: openpgp.Key[];
  signingKey?: openpgp.PrivateKey;
}

export async function encryptText({
  text,
  recipientPublicKeys,
  signingKey,
}: EncryptTextOptions): Promise<string> {
  const message = await openpgp.createMessage({ text });

  const encrypted = await openpgp.encrypt({
    message,
    encryptionKeys: recipientPublicKeys,
    signingKeys: signingKey ? [signingKey] : undefined,
    format: "armored",
  });

  return encrypted as string;
}

export interface DecryptTextResult {
  data: string;
  verified: boolean | null;
  signedBy?: string;
}

/**
 * Shared by text and files so the two can never drift apart on something this
 * sensitive.
 */
async function resolveVerified(
  signatures: Awaited<ReturnType<typeof openpgp.decrypt>>["signatures"],
  verifyKeys: openpgp.Key[],
): Promise<{ verified: boolean | null; signedBy?: string; }> {
  if (!signatures?.length) return { verified: null };

  for (const sig of signatures) {
    // Only judge a signature we actually hold the signer's key for. Asking
    // merely whether verifyKeys is non-empty is not enough: our own key is
    // always in there, so a sender's key we happen to be missing would take
    // the "assume invalid" path below and be reported as forged. Unknown is
    // not the same as tampered, and must never be shown as such.
    if (!verifyKeys.some(key => key.getKeys(sig.keyID).length > 0)) continue;

    try {
      await sig.verified;
      return { verified: true, signedBy: sig.keyID.toHex() };
    } catch {
      // We held the right key and it still failed: genuinely bad.
      return { verified: false };
    }
  }

  return { verified: null };
}

export async function decryptText(
  armoredMessage: string,
  privateKey: openpgp.PrivateKey,
  verifyKeys: openpgp.Key[] = [],
): Promise<DecryptTextResult> {
  const message = await openpgp.readMessage({ armoredMessage: normalizeArmoredText(armoredMessage) });

  const { data, signatures } = await openpgp.decrypt({
    message,
    decryptionKeys: privateKey,
    verificationKeys: verifyKeys.length ? verifyKeys : undefined,
  });

  const { verified, signedBy } = await resolveVerified(signatures, verifyKeys);

  return {
    data: data as string,
    verified,
    signedBy,
  };
}

export interface EncryptFileOptions {
  bytes: Uint8Array;
  filename: string;
  recipientPublicKeys: openpgp.Key[];
  signingKey?: openpgp.PrivateKey;
}

/**
 * Binary, never armored. Armor is base64: it inflates a file by ~33%, which
 * would push a 9MB video past Discord's 10MB limit as a pure encoding artifact.
 *
 * The real filename rides inside OpenPGP's literal-data packet, so it is
 * encrypted and signed along with the contents — Discord only ever sees the
 * opaque name we upload under.
 */
export async function encryptFile({
  bytes,
  filename,
  recipientPublicKeys,
  signingKey,
}: EncryptFileOptions): Promise<Uint8Array> {
  const message = await openpgp.createMessage({ binary: bytes, filename });

  const encrypted = await openpgp.encrypt({
    message,
    encryptionKeys: recipientPublicKeys,
    signingKeys: signingKey ? [signingKey] : undefined,
    format: "binary",
  });

  return encrypted as Uint8Array;
}

export interface DecryptFileResult {
  bytes: Uint8Array;
  filename: string;
  verified: boolean | null;
  signedBy?: string;
}

export async function decryptFile(
  ciphertext: Uint8Array,
  privateKey: openpgp.PrivateKey,
  verifyKeys: openpgp.Key[] = [],
): Promise<DecryptFileResult> {
  const message = await openpgp.readMessage({ binaryMessage: ciphertext });

  const { data, signatures, filename } = await openpgp.decrypt({
    message,
    decryptionKeys: privateKey,
    verificationKeys: verifyKeys.length ? verifyKeys : undefined,
    format: "binary",
  });

  const { verified, signedBy } = await resolveVerified(signatures, verifyKeys);

  return {
    bytes: data as Uint8Array,
    filename,
    verified,
    signedBy,
  };
}

export function looksLikeArmoredPublicKey(text: string): boolean {
  return (
    text.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----") &&
    text.includes("-----END PGP PUBLIC KEY BLOCK-----")
  );
}

export function looksLikeArmoredMessage(text: string): boolean {
  return (
    text.includes("-----BEGIN PGP MESSAGE-----") &&
    text.includes("-----END PGP MESSAGE-----")
  );
}

export function looksLikeArmoredPrivateKey(text: string): boolean {
  return (
    text.includes("-----BEGIN PGP PRIVATE KEY BLOCK-----") &&
    text.includes("-----END PGP PRIVATE KEY BLOCK-----")
  );
}
