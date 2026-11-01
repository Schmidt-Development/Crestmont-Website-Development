// WebCrypto helpers (Workers and Node 22 both provide globalThis.crypto.subtle).

const enc = new TextEncoder();

export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function newId(prefix) { return `${prefix}_${randomToken(12)}`; }

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Human-readable reference (no 0/O/1/I), uniform over the alphabet (rejection sampling, no modulo bias). */
export function newReference(prefix, length = 8) {
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 256 - (256 % REF_ALPHABET.length) && out.length < length) out += REF_ALPHABET[b % REF_ALPHABET.length];
    }
  }
  return `${prefix}-${out}`;
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two hex/ASCII strings. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Password hashing: PBKDF2-SHA256, 100,000 iterations (the maximum Cloudflare Workers allows), 16-byte salt.
const ITER = 100_000;
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITER);
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(hash)}`;
}
export async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored ?? "").split("$");
  if (alg !== "pbkdf2" || !iter || !salt || !hash) return false;
  const got = await pbkdf2(password, unb64(salt), Number(iter));
  return safeEqual(b64(got), hash);
}
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
