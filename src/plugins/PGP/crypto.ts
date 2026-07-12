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
    curve: "curve25519",
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
  return openpgp.decryptKey({ privateKey, passphrase });
}



export async function parsePublicKey(armoredKey: string) {
  try {
    const key = await openpgp.readKey({ armoredKey });
    if (!key.isPrivate()) return key;
    return null;
  } catch (err) {
    console.error("[PGP] parsePublicKey failed:", err);
    throw err;
  }
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
export function normalizeArmoredKey(text: string): string {
  let normalized = text.trim().replace(/\r\n?/g, "\n");

  // Already has real newlines - nothing to repair.
  if (normalized.includes("\n")) return normalized;

  const beginMatch = normalized.match(
    /-----BEGIN PGP (PUBLIC KEY BLOCK|PRIVATE KEY BLOCK|MESSAGE)-----/,
  );
  const endMatch = normalized.match(
    /-----END PGP (PUBLIC KEY BLOCK|PRIVATE KEY BLOCK|MESSAGE)-----/,
  );
  if (!beginMatch || !endMatch) return normalized;

  const header = beginMatch[0];
  const footer = endMatch[0];

  const bodyStart = beginMatch.index! + header.length;
  const bodyEnd = endMatch.index!;
  let body = normalized.slice(bodyStart, bodyEnd).trim();

  // Body tokens were separated by spaces where newlines used to be.
  // Rejoin all whitespace-separated chunks, then re-wrap at 64 chars,
  // except keep the checksum line (starts with "=") on its own line.
  const tokens = body.split(/\s+/).filter(Boolean);

  let checksumToken: string | null = null;
  if (tokens.length && tokens[tokens.length - 1].startsWith("=")) {
    checksumToken = tokens.pop()!;
  }

  const joined = tokens.join("");
  const lines: string[] = [];
  for (let i = 0; i < joined.length; i += 64) {
    lines.push(joined.slice(i, i + 64));
  }

  let rebuilt = `${header}\n\n${lines.join("\n")}`;
  if (checksumToken) rebuilt += `\n${checksumToken}`;
  rebuilt += `\n${footer}`;

  return rebuilt;
}
export async function decryptText(
  armoredMessage: string,
  privateKey: openpgp.PrivateKey,
  verifyKeys: openpgp.Key[] = [],
): Promise<DecryptTextResult> {
  const message = await openpgp.readMessage({ armoredMessage });
  const { data, signatures } = await openpgp.decrypt({
    message,
    decryptionKeys: privateKey,
    verificationKeys: verifyKeys.length ? verifyKeys : undefined,
  });

  let verified: boolean | null = null;
  let signedBy: string | undefined;

  if (signatures?.length) {
    verified = false;
    for (const sig of signatures) {
      try {
        await sig.verified;
        verified = true;
        signedBy = sig.keyID.toHex();
        break;
      } catch {
        // keep checking others
      }
    }
  }

  return { data: data as string, verified, signedBy };
}

export async function encryptBinary(
  bytes: Uint8Array,
  recipientPublicKeys: openpgp.Key[],
  signingKey?: openpgp.PrivateKey,
): Promise<Uint8Array> {
  const message = await openpgp.createMessage({ binary: bytes });
  const encrypted = await openpgp.encrypt({
    message,
    encryptionKeys: recipientPublicKeys,
    signingKeys: signingKey ? [signingKey] : undefined,
    format: "binary",
  });
  return encrypted as Uint8Array;
}

export async function decryptBinary(
  bytes: Uint8Array,
  privateKey: openpgp.PrivateKey,
): Promise<Uint8Array> {
  const message = await openpgp.readMessage({ binaryMessage: bytes });
  const { data } = await openpgp.decrypt({
    message,
    decryptionKeys: privateKey,
    format: "binary",
  });
  return data as Uint8Array;
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
