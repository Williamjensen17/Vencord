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

  return openpgp.decryptKey({
    privateKey,
    passphrase,
  });
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
        continue;
      }
    }
  }

  return {
    data: data as string,
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
