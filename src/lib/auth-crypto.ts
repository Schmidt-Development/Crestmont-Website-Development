// Password hashing (PBKDF2-SHA256, 100k iterations — the Workers WebCrypto maximum),
// opaque session/reset tokens, MFA recovery codes, and RFC 6238 TOTP for MFA.
//
// Stored password hashes are self-describing: "pbkdf2$<iterations>$<salt hex>$<hash hex>", where "pbkdf2" means
// PBKDF2-HMAC-SHA256 with a 16-byte salt and a 32-byte output. verifyPassword reads the algorithm and the
// iteration count from the stored value, and passwordNeedsRehash() tells the login flow to re-hash with the
// current parameters after a successful sign-in, so a stronger KDF (a new algorithm tag) or a different cost
// can be adopted without a reset (docs/AUTH-PRODUCTION.md gap 6).
import { sha256Hex, timingSafeEqualHex, toHex } from "./crypto.ts";

const enc = new TextEncoder();
export const PASSWORD_ALGORITHM = "pbkdf2";
export const ITERATIONS = 100_000;

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return toHex(bits);
}

/** `iterations` is only ever overridden by tests (to create legacy-cost hashes); production always uses ITERATIONS. */
export async function hashPassword(password: string, iterations = ITERATIONS): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return `${PASSWORD_ALGORITHM}$${iterations}$${toHex(salt)}$${await pbkdf2(password, salt, iterations)}`;
}

/** True when a stored hash was made with other parameters than the current ones (algorithm, cost, salt or output size). */
export function passwordNeedsRehash(stored: string | null): boolean {
  if (!stored) return false;
  const [alg, iter, saltHex, hash] = stored.split("$");
  return alg !== PASSWORD_ALGORITHM || Number(iter) !== ITERATIONS || saltHex?.length !== 32 || hash?.length !== 64;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    await pbkdf2(password, new Uint8Array(16), ITERATIONS); // equalise timing for unknown accounts
    return false;
  }
  const [alg, iter, saltHex, hash] = stored.split("$");
  if (alg !== "pbkdf2" || !iter || !saltHex || !hash) return false;
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16))) as Uint8Array<ArrayBuffer>;
  return timingSafeEqualHex(await pbkdf2(password, salt, Number(iter)), hash);
}

export const hashToken = (t: string) => sha256Hex(t);

// ── MFA recovery codes ──
// 12 characters from a 31-character alphabet without look-alikes (~59 bits), shown as xxxx-xxxx-xxxx. The first
// four characters are a non-secret lookup key (to find the row without hashing every code); the whole code is
// stored only as a password hash.
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const RECOVERY_CODE_COUNT = 10;

export function newRecoveryCode(): string {
  let out = "";
  const limit = Math.floor(256 / RECOVERY_ALPHABET.length) * RECOVERY_ALPHABET.length;
  while (out.length < 12) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    for (const x of b) if (x < limit && out.length < 12) out += RECOVERY_ALPHABET[x % RECOVERY_ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

/** Canonical form of a typed recovery code (case, spaces and dashes ignored), or null if it cannot be one. */
export function normalizeRecoveryCode(input: string): string | null {
  const c = input.toLowerCase().replace(/[\s-]/g, "");
  if (c.length !== 12) return null;
  for (const ch of c) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return c;
}

/** Long-form passwords seen at the top of public breach corpora (offline fallback; the breach API is the main check). */
const COMMON_PASSWORDS = new Set(["password1234", "123456789012", "qwertyuiopas", "qwertyuiop123", "passwordpassword", "1q2w3e4r5t6y", "1qaz2wsx3edc",
  "abcdefghijkl", "abc123abc123", "aaaaaaaaaaaa", "iloveyouiloveyou", "trustno1trustno1", "monkeymonkey", "dragondragon", "sunshine1234",
  "football1234", "baseball1234", "princess1234", "welcomewelcome", "changeme1234", "letmeinletmein", "administrator", "correcthorsebatterystaple"]);

/** Basic password policy: length plus a denylist of common long passwords and patterns. */
export function passwordProblems(pw: string, email?: string): string[] {
  const p: string[] = [];
  if (pw.length < 12) p.push("Password must be at least 12 characters");
  if (pw.length > 200) p.push("Password is too long");
  if (/^(.)\1+$/.test(pw)) p.push("Password cannot be a single repeated character");
  const lower = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(password|passw0rd|qwerty|letmein|welcome|admin|iloveyou|crestmont)[\d!@#$%^&*._-]*$/.test(lower) || /^\d+$/.test(pw) && /^(0123456789|1234567890|9876543210)+/.test(pw))
    p.push("Password is too common");
  if (email && pw.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length > 3) p.push("Password cannot contain your email name");
  return p;
}

// ── TOTP (RFC 6238, SHA-1, 30s, 6 digits) ──
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): string {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return base32Encode(b);
}

export async function totpCode(secret: string, timeSeconds = Math.floor(Date.now() / 1000), step = 30): Promise<string> {
  const counter = Math.floor(timeSeconds / step);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

export async function verifyTotp(secret: string, code: string, timeSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  return (await matchTotpStep(secret, code, timeSeconds)) !== null;
}

/** Returns the 30-second time-step the code belongs to (±1 step drift), or null. Used for replay protection. */
export async function matchTotpStep(secret: string, code: string, timeSeconds = Math.floor(Date.now() / 1000)): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  for (const drift of [-1, 0, 1]) {
    const t = timeSeconds + drift * 30;
    if (timingSafeEqualHex(await totpCode(secret, t), code)) return Math.floor(t / 30);
  }
  return null;
}

export function otpauthUri(secret: string, account: string): string {
  return `otpauth://totp/${encodeURIComponent("Crestmont:" + account)}?secret=${secret}&issuer=Crestmont&algorithm=SHA1&digits=6&period=30`;
}
