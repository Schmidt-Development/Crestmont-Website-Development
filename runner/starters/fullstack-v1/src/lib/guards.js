// Request guards: rate limiting, idempotency keys, sessions (admin and customer), CSRF.
import { HttpError, clientIp, cookie } from "./http.js";
import { one, run, nowMs, nowIso } from "./db.js";
import { randomToken, sha256Hex } from "./crypto.js";

/** Fixed-window rate limit in D1 (per bucket). Throws 429 with Retry-After when exceeded. */
export async function rateLimit(env, request, name, limit, windowSeconds) {
  const bucket = `${name}:${await sha256Hex(clientIp(request))}`;
  const win = Math.floor(nowMs(env) / 1000 / windowSeconds) * windowSeconds;
  await run(env.DB, `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?,?,1) ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1`, bucket, win);
  const row = await one(env.DB, `SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?`, bucket, win);
  if (row.count > limit) {
    const retry = win + windowSeconds - Math.floor(nowMs(env) / 1000);
    throw new HttpError(429, "rate_limited", "Too many requests. Please wait a moment and try again.", { retryAfterSeconds: retry });
  }
}

/**
 * Idempotency for state-changing POSTs: the same Idempotency-Key with the same body returns the first response;
 * the same key with a different body is refused (409). Keys are scoped per endpoint.
 */
export async function idempotent(env, request, scope, body, handler) {
  const key = request.headers.get("idempotency-key");
  if (!key) return handler();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 8-100 letters, digits, - or _.");
  const hash = await sha256Hex(JSON.stringify(body));
  const prior = await one(env.DB, `SELECT request_hash, status, response_json FROM idempotency_keys WHERE scope = ? AND key = ?`, scope, key);
  if (prior) {
    if (prior.request_hash !== hash) throw new HttpError(409, "idempotency_conflict", "This Idempotency-Key was already used for a different request.");
    return { status: prior.status, body: JSON.parse(prior.response_json), replayed: true };
  }
  const res = await handler();
  if (res.status < 500) {
    await run(env.DB, `INSERT OR IGNORE INTO idempotency_keys (scope, key, request_hash, status, response_json, created_at) VALUES (?,?,?,?,?,?)`, scope, key, hash, res.status, JSON.stringify(res.body), nowIso(env));
  }
  return res;
}

const SESSION_HOURS = { admin: 12, customer: 24 * 7 };
export const SESSION_COOKIE = "__Host-sid";

export async function createSession(env, kind, subjectId) {
  const token = randomToken(32);
  const at = nowMs(env);
  await run(env.DB, `INSERT INTO sessions (token_hash, subject_kind, subject_id, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?)`,
    await sha256Hex(token), kind, subjectId, new Date(at).toISOString(), new Date(at).toISOString(), new Date(at + SESSION_HOURS[kind] * 36e5).toISOString());
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS[kind] * 3600}`;
}
export const clearSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** The session's subject, or a 401. State-changing requests also need same-origin proof (CSRF). */
export async function requireSession(env, request, kind) {
  const token = cookie(request, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "unauthenticated", "Please sign in.");
  const s = await one(env.DB, `SELECT * FROM sessions WHERE token_hash = ? AND subject_kind = ?`, await sha256Hex(token), kind);
  if (!s || s.expires_at <= nowIso(env)) throw new HttpError(401, "unauthenticated", "Your session has ended. Please sign in again.");
  if (request.method !== "GET" && request.method !== "HEAD") requireSameOrigin(request);
  await run(env.DB, `UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`, nowIso(env), s.token_hash);
  return s;
}

/** CSRF defence for cookie-authenticated writes: an Origin matching the request host and the fetch marker header. */
export function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  const host = new URL(request.url).host;
  if (!origin || new URL(origin).host !== host || request.headers.get("x-requested-with") !== "fetch") {
    throw new HttpError(403, "csrf_rejected", "This request must come from the site itself.");
  }
}

export async function endSession(env, request) {
  const token = cookie(request, SESSION_COOKIE);
  if (token) await run(env.DB, `DELETE FROM sessions WHERE token_hash = ?`, await sha256Hex(token));
}
