// Password hashing (PBKDF2-SHA256, 100k iterations — the Workers WebCrypto maximum),
// opaque session/reset tokens, and RFC 6238 TOTP for MFA.
import { sha256Hex, timingSafeEqualHex, toHex } from "./crypto.ts";

const enc = new TextEncoder();
const ITERATIONS = 100_000;

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

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${await pbkdf2(password, salt, ITERATIONS)}`;
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

/** Basic password policy: length plus a small denylist. */
export function passwordProblems(pw: string, email?: string): string[] {
  const p: string[] = [];
  if (pw.length < 12) p.push("Password must be at least 12 characters");
  if (pw.length > 200) p.push("Password is too long");
  if (/^(.)\1+$/.test(pw)) p.push("Password cannot be a single repeated character");
  if (["password1234", "123456789012", "qwertyuiopas"].includes(pw.toLowerCase())) p.push("Password is too common");
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
  if (!/^\d{6}$/.test(code)) return false;
  for (const drift of [-1, 0, 1]) {
    if (timingSafeEqualHex(await totpCode(secret, timeSeconds + drift * 30), code)) return true;
  }
  return false;
}

export function otpauthUri(secret: string, account: string): string {
  return `otpauth://totp/${encodeURIComponent("Crestmont:" + account)}?secret=${secret}&issuer=Crestmont&algorithm=SHA1&digits=6&period=30`;
}
