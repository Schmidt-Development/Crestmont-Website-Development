// TOTP secrets at rest (docs/AUTH-PRODUCTION.md gap 3). users.totp_secret and users.totp_pending_secret hold
//   "v1:<base64 iv>:<base64 AES-GCM ciphertext+tag>"
// under the per-environment Worker secret MFA_ENCRYPTION_KEY (base64 of exactly 32 random bytes). The user id is
// bound as additional authenticated data, so a ciphertext copied onto another user's row does not decrypt.
//
// Legacy plaintext (base32) values still verify and are re-encrypted by the caller after the next successful
// verification (or by scripts/encrypt-totp-secrets.ts). Without the key:
//   development        → new secrets are stored in plaintext (local work and tests only);
//   staging/production → enrolment fails closed with MfaKeyError; existing plaintext rows keep working, so
//                        nobody is locked out while the secret is being rolled out.
// Nothing here logs or returns a key, a secret or a ciphertext in an error message.

export interface MfaKeyEnv { ENVIRONMENT: string; MFA_ENCRYPTION_KEY?: string }

export class MfaKeyError extends Error {}

export const TOTP_CIPHER_PREFIX = "v1:";
const enc = new TextEncoder();
const dec = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

const b64e = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function b64d(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const aad = (userId: string) => enc.encode(`crestmont-totp:v1:${userId}`);

export const isEncryptedTotpSecret = (stored: string | null | undefined): boolean => !!stored && stored.startsWith(TOTP_CIPHER_PREFIX);

/** Validates and imports MFA_ENCRYPTION_KEY. Throws MfaKeyError (without echoing the value) when malformed. */
export function importMfaKey(raw: string): Promise<CryptoKey> {
  let p = keyCache.get(raw);
  if (!p) {
    p = (async () => {
      let bytes: Uint8Array<ArrayBuffer>;
      try { bytes = b64d(raw.trim()); } catch { throw new MfaKeyError("MFA_ENCRYPTION_KEY is not valid base64."); }
      if (bytes.length !== 32) throw new MfaKeyError(`MFA_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${bytes.length}).`);
      return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    })();
    p.catch(() => keyCache.delete(raw));
    keyCache.set(raw, p);
  }
  return p;
}

/** "ok" | "missing" | "invalid" — for health displays; never exposes the value. */
export async function mfaKeyStatus(env: MfaKeyEnv): Promise<"ok" | "missing" | "invalid"> {
  if (!env.MFA_ENCRYPTION_KEY) return "missing";
  try { await importMfaKey(env.MFA_ENCRYPTION_KEY); return "ok"; } catch { return "invalid"; }
}

/** True when new secrets would be stored encrypted (key present), false when plaintext is allowed (development without a key). Throws outside development without a key. */
export function assertCanStoreTotpSecret(env: MfaKeyEnv): boolean {
  if (env.MFA_ENCRYPTION_KEY) return true;
  if (env.ENVIRONMENT === "development") return false;
  throw new MfaKeyError("Two-factor enrolment is unavailable: the MFA_ENCRYPTION_KEY secret is not configured for this environment. Ask the platform operator to set it (docs/DEPLOYMENT.md §4).");
}

/** Encrypts a base32 TOTP secret for storage on `userId`'s row. */
export async function sealTotpSecret(env: MfaKeyEnv, userId: string, plain: string): Promise<string> {
  if (!assertCanStoreTotpSecret(env)) return plain;
  return sealWithKey(env.MFA_ENCRYPTION_KEY!, userId, plain);
}

export async function sealWithKey(rawKey: string, userId: string, plain: string): Promise<string> {
  const key = await importMfaKey(rawKey);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(userId) }, key, enc.encode(plain)));
  return `${TOTP_CIPHER_PREFIX}${b64e(iv)}:${b64e(ct)}`;
}

/** Returns the base32 secret for a stored value (ciphertext or legacy plaintext). */
export async function openTotpSecret(env: MfaKeyEnv, userId: string, stored: string): Promise<string> {
  if (!isEncryptedTotpSecret(stored)) return stored; // legacy plaintext
  if (!env.MFA_ENCRYPTION_KEY) throw new MfaKeyError("Two-factor verification is unavailable: MFA_ENCRYPTION_KEY is not configured for this environment.");
  return openWithKey(env.MFA_ENCRYPTION_KEY, userId, stored);
}

export async function openWithKey(rawKey: string, userId: string, stored: string): Promise<string> {
  const key = await importMfaKey(rawKey);
  const [, ivB64, ctB64] = stored.split(":");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(ivB64 ?? ""), additionalData: aad(userId) }, key, b64d(ctB64 ?? ""));
    return dec.decode(pt);
  } catch {
    throw new MfaKeyError("A stored two-factor secret could not be decrypted with the configured MFA_ENCRYPTION_KEY.");
  }
}
