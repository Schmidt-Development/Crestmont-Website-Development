// Account lifecycle and sessions (AUTH-001..006). Implemented in-platform with a local adapter
// design: if the Founder approves a managed identity provider, `loadSession` and the login
// routes are the only places that change. Authorization is always enforced by the platform.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { hashPassword, verifyPassword, randomToken, hashToken, passwordProblems, matchTotpStep, newTotpSecret, passwordNeedsRehash, newRecoveryCode, normalizeRecoveryCode, RECOVERY_CODE_COUNT } from "../lib/auth-crypto.ts";
import { MfaKeyError, assertCanStoreTotpSecret, isEncryptedTotpSecret, openTotpSecret, sealTotpSecret, sealWithKey, type MfaKeyEnv } from "../lib/totp-secrets.ts";
import { STAFF_ROLES, type Actor, type Role } from "../domain/authz.ts";
import type { SessionUser, Env } from "../app/context.ts";
import { rateLimit, peekRateLimit, securityEvent, audit } from "./security.ts";

export const SESSION_TTL_STAFF_S = 12 * 3600;
export const SESSION_TTL_CUSTOMER_S = 7 * 24 * 3600;
/** Idle timeouts (ASVS 3.3.2): a session unused for this long is rejected. */
export const SESSION_IDLE_STAFF_S = 2 * 3600;
export const SESSION_IDLE_CUSTOMER_S = 24 * 3600;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60e3;
// Abuse-resistant sign-in throttling (CREST-GAP-003). There is no account lockout: a hard lock let any anonymous
// visitor who knew an address keep that account (including the Owner) locked indefinitely. Instead:
//  - a device that has completed a sign-in for the account before ("known device" cookie) is never challenged or
//    blocked by other people's failures; its own wrong guesses are limited per device;
//  - after CHALLENGE_AFTER failures for an address in a 15-minute window, unknown devices must pass the Turnstile
//    challenge to try that address. The decision is made before the password is looked at, and is identical for
//    existing and unknown addresses, so it reveals neither a correct password nor whether an account exists;
//  - each IP is limited per address and overall; only FAILED attempts count toward the per-address limits.
export const CHALLENGE_AFTER = 5;
const FAIL_WINDOW_S = 15 * 60;
const PER_IP_ADDRESS_FAILS = 10;
const PER_IP_ATTEMPTS = 30;
const PER_DEVICE_FAILS = 10;
export const DEVICE_COOKIE = "cm_device";
export const DEVICE_MAX_AGE_S = 180 * 86400;
export const CHALLENGE_MESSAGE = "For your security, complete the check below and sign in again.";

/** Signals the route to show the bot challenge (status 403); carries no information about the password. */
export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** A wrong password (always the same message). `notifyEmail` is set once per window, when an existing account starts
 *  requiring the challenge, so the route can tell the account holder. */
export class LoginFailed extends AuthError {
  readonly notifyUserId: string | null;
  readonly notifyEmail: string | null;
  constructor(notifyUserId: string | null, notifyEmail: string | null) { super("Email or password is incorrect.", 401); this.notifyUserId = notifyUserId; this.notifyEmail = notifyEmail; }
}

export class SignInChallengeRequired extends AuthError {
  constructor() { super(CHALLENGE_MESSAGE, 403); }
}

/**
 * Breached-password check (ASVS 2.1.7, finding F-06) using the Have I Been Pwned range API with
 * k-anonymity: only the first 5 hex characters of the password's SHA-1 leave the platform, and the
 * comparison happens locally. On by default outside development (PASSWORD_BREACH_CHECK = "off" disables,
 * "on" enables in development). If the service cannot be reached the password is accepted (fail open)
 * and the outage is recorded, because blocking every sign-up on a third-party outage is worse; the
 * local policy in passwordProblems still applies.
 */
export const BREACH_API = "https://api.pwnedpasswords.com/range/";
export async function assertPasswordNotBreached(env: Env, db: Db, password: string): Promise<void> {
  const mode = env.PASSWORD_BREACH_CHECK ?? (env.ENVIRONMENT === "development" ? "off" : "on");
  if (mode !== "on" || !password) return;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password)));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const f = env.overrides?.fetch ?? fetch;
  let body: string;
  try {
    const r = await f(BREACH_API + hex.slice(0, 5), { headers: { "add-padding": "true", "user-agent": "crestmont-platform" }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    body = await r.text();
  } catch (e) {
    await securityEvent(db, "breach_check_unavailable", { detail: String((e as Error).message ?? e).slice(0, 120) });
    return;
  }
  const suffix = hex.slice(5);
  for (const line of body.split("\n")) {
    const [h, count] = line.trim().split(":");
    if (h === suffix && Number(count) > 0) throw new AuthError("This password has appeared in a known data breach. Choose a different password.");
  }
}

export async function registerCustomer(db: Db, input: { email: string; name: string; password: string; organizationName: string }, ip: string | null) {
  const email = input.email.trim().toLowerCase();
  const problems = passwordProblems(input.password, email);
  if (problems.length) throw new AuthError(problems.join(". "));
  const rl = await rateLimit(db, `register:${ip ?? "unknown"}`, 10, 3600);
  if (!rl.allowed) { await securityEvent(db, "rate_limited", { ip, detail: "register" }); throw new AuthError("Too many attempts. Try again later.", 429); }
  const existing = await db.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first<{ id: string }>();
  // Do not reveal whether an account exists; caller shows the same "check your email" result.
  if (existing) return { userId: existing.id, verifyToken: null as string | null, existed: true };
  const at = nowIso();
  const userId = newId("usr"), orgId = newId("org");
  const token = randomToken();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?,?,?,?,?)`).bind(userId, email, input.name.trim(), await hashPassword(input.password), at),
    db.prepare(`INSERT INTO organizations (id, name, kind, created_at) VALUES (?,?,'customer',?)`).bind(orgId, input.organizationName.trim(), at),
    db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,'customer_admin',?)`).bind(newId("mbr"), userId, orgId, at),
    db.prepare(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?,?,'email_verify',?,?)`)
      .bind(await hashToken(token), userId, new Date(Date.now() + 48 * 3600e3).toISOString(), at),
  ]);
  await linkContactsToUser(db, userId, email);
  await audit(db, { actorUserId: userId, action: "user.registered", subjectType: "user", subjectId: userId, organizationId: orgId, ip });
  return { userId, verifyToken: token, existed: false, organizationId: orgId };
}

/** Attach any CRM contacts with this email to the new user so their quotes/orders appear. */
async function linkContactsToUser(db: Db, userId: string, email: string) {
  await db.prepare(`UPDATE contacts SET user_id = ? WHERE email = ? AND user_id IS NULL`).bind(userId, email).run();
}

export async function consumeToken(db: Db, token: string, purpose: "email_verify" | "password_reset"): Promise<string> {
  const h = await hashToken(token);
  const row = await db.prepare(`SELECT user_id, expires_at, used_at FROM auth_tokens WHERE token_hash = ? AND purpose = ?`).bind(h, purpose).first<{ user_id: string; expires_at: string; used_at: string | null }>();
  if (!row || row.used_at || row.expires_at < nowIso()) throw new AuthError("This link is invalid or has expired.");
  const res = await db.prepare(`UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`).bind(nowIso(), h).run();
  if (res.meta.changes !== 1) throw new AuthError("This link has already been used.");
  return row.user_id;
}

export async function verifyEmail(db: Db, token: string) {
  const userId = await consumeToken(db, token, "email_verify");
  await db.prepare(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`).bind(nowIso(), userId).run();
  await audit(db, { actorUserId: userId, action: "user.email_verified", subjectType: "user", subjectId: userId });
  return userId;
}

export async function newEmailVerifyToken(db: Db, userId: string): Promise<string> {
  const token = randomToken();
  await db.prepare(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?,?,'email_verify',?,?)`)
    .bind(await hashToken(token), userId, new Date(Date.now() + 48 * 3600e3).toISOString(), nowIso()).run();
  return token;
}

export type LoginResult = { status: "ok"; sessionToken: string; userId: string; mfaRequired: boolean; maxAge: number };

/** True if this device cookie was issued to this user by an earlier completed sign-in and has not been revoked. */
export async function isKnownDevice(db: Db, userId: string, token: string | null | undefined): Promise<boolean> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const row = await db.prepare(`SELECT 1 AS x FROM known_devices WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL`).bind(await hashToken(token), userId).first();
  return !!row;
}

/** Remembers this browser for the user after a completed sign-in (password, plus MFA when enabled). Returns the
 *  cookie value to set; reuses the existing one when it already belongs to this user. */
export async function rememberDevice(db: Db, userId: string, existing: string | null | undefined): Promise<string> {
  const at = nowIso();
  if (existing && await isKnownDevice(db, userId, existing)) {
    await db.prepare(`UPDATE known_devices SET last_seen_at = ? WHERE token_hash = ?`).bind(at, await hashToken(existing)).run();
    return existing;
  }
  const token = randomToken();
  await db.prepare(`INSERT INTO known_devices (token_hash, user_id, created_at, last_seen_at) VALUES (?,?,?,?)`).bind(await hashToken(token), userId, at, at).run();
  return token;
}

export async function login(db: Db, emailRaw: string, password: string, meta: { ip: string | null; userAgent: string | null; deviceToken?: string | null; challengePassed?: boolean }): Promise<LoginResult> {
  const email = emailRaw.trim().toLowerCase();
  const ip = meta.ip ?? "unknown";
  const u = await db.prepare(`SELECT id, password_hash, disabled_at, totp_secret FROM users WHERE email = ?`).bind(email)
    .first<{ id: string; password_hash: string | null; disabled_at: string | null; totp_secret: string | null }>();
  const known = u ? await isKnownDevice(db, u.id, meta.deviceToken) : false;
  const deviceKey = known ? `login-fail-device:${await hashToken(meta.deviceToken!)}` : null;
  // Everything below is decided before the password result is used, and the same way for unknown addresses.
  if (known) {
    if (await peekRateLimit(db, deviceKey!, FAIL_WINDOW_S) >= PER_DEVICE_FAILS) {
      await securityEvent(db, "rate_limited", { userId: u!.id, email, ip: meta.ip, detail: "login: known device" });
      throw new AuthError("Too many sign-in attempts from this browser. Wait a few minutes and try again.", 429);
    }
  } else {
    const perIp = await rateLimit(db, `login-ip:${ip}`, PER_IP_ATTEMPTS, FAIL_WINDOW_S);
    const perIpAddress = await peekRateLimit(db, `login-fail-ip:${ip}:${email}`, FAIL_WINDOW_S);
    if (!perIp.allowed || perIpAddress >= PER_IP_ADDRESS_FAILS) {
      await securityEvent(db, "rate_limited", { email, ip: meta.ip, detail: "login" });
      throw new AuthError("Too many sign-in attempts. Wait a few minutes and try again.", 429);
    }
    if (await peekRateLimit(db, `login-fail:${email}`, FAIL_WINDOW_S) >= CHALLENGE_AFTER && !meta.challengePassed) {
      await securityEvent(db, "login_challenge_required", { userId: u?.id, email, ip: meta.ip });
      throw new SignInChallengeRequired();
    }
  }
  const ok = await verifyPassword(password, u?.password_hash ?? null);
  if (!u || !ok || u.disabled_at) {
    if (known) await rateLimit(db, deviceKey!, PER_DEVICE_FAILS, FAIL_WINDOW_S);
    else {
      const fails = await rateLimit(db, `login-fail:${email}`, CHALLENGE_AFTER, FAIL_WINDOW_S);
      await rateLimit(db, `login-fail-ip:${ip}:${email}`, PER_IP_ADDRESS_FAILS, FAIL_WINDOW_S);
      // Recorded once per window, when the address starts requiring the challenge; the account holder is told.
      if (fails.remaining === 0 && fails.allowed) {
        await securityEvent(db, "login_challenge_started", { userId: u?.id, email, ip: meta.ip });
        if (u) {
          await db.prepare(`UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ?`).bind(u.id).run();
          await securityEvent(db, "login_failed", { userId: u.id, email, ip: meta.ip });
          throw new LoginFailed(u.id, email);
        }
      }
    }
    if (u) await db.prepare(`UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ?`).bind(u.id).run();
    await securityEvent(db, "login_failed", { userId: u?.id, email, ip: meta.ip });
    throw new LoginFailed(null, null);
  }
  await db.prepare(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?`).bind(u.id).run();
  // Versioned hash format (docs/AUTH-PRODUCTION.md gap 6): a hash made with older parameters is replaced with
  // one made with the current algorithm and cost, now that the plaintext is known to be correct.
  if (passwordNeedsRehash(u.password_hash)) {
    const res = await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?`).bind(await hashPassword(password), u.id, u.password_hash).run();
    if (res.meta.changes === 1) await audit(db, { actorUserId: u.id, actorKind: "system", action: "user.password_rehashed", subjectType: "user", subjectId: u.id, details: { from: u.password_hash!.split("$").slice(0, 2).join("$") } });
  }
  const roles = (await db.prepare(`SELECT role_id FROM memberships WHERE user_id = ?`).bind(u.id).all<{ role_id: Role }>()).results.map((r) => r.role_id);
  const staff = roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r));
  const maxAge = staff ? SESSION_TTL_STAFF_S : SESSION_TTL_CUSTOMER_S;
  const token = randomToken();
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, mfa_verified, ip, user_agent, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(newId("ses"), u.id, await hashToken(token), 0, meta.ip, meta.userAgent?.slice(0, 300) ?? null, nowIso(), new Date(Date.now() + maxAge * 1000).toISOString()).run();
  await audit(db, { actorUserId: u.id, action: "session.created", subjectType: "user", subjectId: u.id, ip: meta.ip });
  // Staff must complete MFA (enrol if needed); customers only if they enabled it.
  return { status: "ok", sessionToken: token, userId: u.id, mfaRequired: staff || !!u.totp_secret, maxAge };
}

/** `passive`: background requests (live polling) must not count as activity, or an idle tab would never time out (F-07). */
export async function loadSession(db: Db, token: string | undefined, opts: { passive?: boolean } = {}): Promise<{ user: SessionUser; actor: Actor; sessionId: string; mfaVerified: boolean; mfaVerifiedAt: string | null } | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const s = await db.prepare(
    `SELECT s.id, s.user_id, s.mfa_verified, s.mfa_verified_at, s.expires_at, s.revoked_at, s.created_at, s.last_seen_at, u.email, u.display_name, u.email_verified_at, u.totp_secret, u.disabled_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).bind(await hashToken(token)).first<{ id: string; user_id: string; mfa_verified: number; mfa_verified_at: string | null; expires_at: string; revoked_at: string | null; created_at: string; last_seen_at: string | null; email: string; display_name: string; email_verified_at: string | null; totp_secret: string | null; disabled_at: string | null }>();
  if (!s || s.revoked_at || s.disabled_at || s.expires_at < nowIso()) return null;
  const memberships = (await db.prepare(
    `SELECT m.organization_id, o.name, m.role_id FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ?`,
  ).bind(s.user_id).all<{ organization_id: string; name: string; role_id: Role }>()).results;
  const isStaff = memberships.some((m) => (STAFF_ROLES as readonly string[]).includes(m.role_id));
  const lastSeen = Date.parse(s.last_seen_at ?? s.created_at);
  const idleLimit = (isStaff ? SESSION_IDLE_STAFF_S : SESSION_IDLE_CUSTOMER_S) * 1000;
  if (Date.now() - lastSeen > idleLimit) {
    await db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(nowIso(), s.id).run();
    return null;
  }
  if (!opts.passive && Date.now() - lastSeen > LAST_SEEN_WRITE_INTERVAL_MS) {
    await db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(nowIso(), s.id).run();
  }
  const mfaVerified = !!s.mfa_verified;
  const user: SessionUser = {
    id: s.user_id, email: s.email, displayName: s.display_name, emailVerified: !!s.email_verified_at, mfaEnabled: !!s.totp_secret,
    memberships: memberships.map((m) => ({ organizationId: m.organization_id, organizationName: m.name, role: m.role_id })), isStaff,
  };
  // Customers without MFA enabled are treated as fully verified for their own customer roles.
  const effectiveMfa = mfaVerified || (!isStaff && !s.totp_secret);
  const actor: Actor = { kind: "user", userId: s.user_id, roles: memberships.map((m) => ({ role: m.role_id, organizationId: m.organization_id })), mfaVerified: effectiveMfa };
  return { user, actor, sessionId: s.id, mfaVerified: effectiveMfa, mfaVerifiedAt: s.mfa_verified ? s.mfa_verified_at : null };
}

// ── Second factor: TOTP (encrypted at rest) and single-use recovery codes (AUTH-002, AUTH-003) ──

const MFA_UNAVAILABLE = "Two-factor verification is temporarily unavailable in this environment. Contact the platform operator.";

/** Decrypts the user's TOTP secret. A missing/wrong key is an operator problem: fail closed, record it, never echo secrets. */
async function readTotpSecret(env: MfaKeyEnv, db: Db, userId: string): Promise<{ plain: string; stored: string } | null> {
  const u = await db.prepare(`SELECT totp_secret FROM users WHERE id = ?`).bind(userId).first<{ totp_secret: string | null }>();
  if (!u?.totp_secret) return null;
  try {
    return { plain: await openTotpSecret(env, userId, u.totp_secret), stored: u.totp_secret };
  } catch (e) {
    if (e instanceof MfaKeyError) {
      await securityEvent(db, "mfa_key_unavailable", { userId, detail: e.message.slice(0, 160) });
      throw new AuthError(MFA_UNAVAILABLE, 503);
    }
    throw e;
  }
}

/**
 * Checks a 6-digit TOTP code with replay protection (each 30-second step once, never an earlier one). After a
 * successful check a legacy plaintext secret is re-encrypted when MFA_ENCRYPTION_KEY is configured.
 */
async function checkTotp(env: MfaKeyEnv, db: Db, userId: string, code: string, ip: string | null): Promise<boolean> {
  const t = await readTotpSecret(env, db, userId);
  const step = t ? await matchTotpStep(t.plain, code) : null;
  if (step === null || !t) return false;
  const claim = await db.prepare(`UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`).bind(step, userId, step).run();
  if (claim.meta.changes !== 1) {
    await securityEvent(db, "mfa_replay_rejected", { userId, ip });
    throw new AuthError("That code was already used. Wait for the next code.", 401);
  }
  if (!isEncryptedTotpSecret(t.stored) && env.MFA_ENCRYPTION_KEY) {
    try {
      const sealed = await sealWithKey(env.MFA_ENCRYPTION_KEY, userId, t.plain);
      await db.prepare(`UPDATE users SET totp_secret = ? WHERE id = ? AND totp_secret = ?`).bind(sealed, userId, t.stored).run();
    } catch (e) {
      // A malformed key must not lock out a user whose (legacy) code was just verified; record it for the operator.
      if (!(e instanceof MfaKeyError)) throw e;
      await securityEvent(db, "mfa_key_unavailable", { userId, detail: e.message.slice(0, 160) });
    }
  }
  return true;
}

/** Consumes a recovery code. Returns the number of unused codes left, or null when the code does not match an unused one. */
async function useRecoveryCode(db: Db, userId: string, input: string): Promise<number | null> {
  const code = normalizeRecoveryCode(input);
  if (!code) return null;
  const rows = (await db.prepare(`SELECT id, code_hash FROM mfa_recovery_codes WHERE user_id = ? AND lookup = ? AND used_at IS NULL`).bind(userId, code.slice(0, 4)).all<{ id: string; code_hash: string }>()).results;
  if (!rows.length) { await verifyPassword(code, null); return null; } // equalise timing
  for (const r of rows) {
    if (!(await verifyPassword(code, r.code_hash))) continue;
    const claim = await db.prepare(`UPDATE mfa_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL`).bind(nowIso(), r.id).run();
    if (claim.meta.changes !== 1) return null;
    return (await db.prepare(`SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL`).bind(userId).first<{ n: number }>())?.n ?? 0;
  }
  return null;
}

/** Wrong second-factor codes allowed per user in any rolling 24 hours before further attempts are refused. */
export const MFA_DAILY_FAILURES = 30;

/** Second-factor attempt limit: 8 codes (any kind) per user per 15 minutes. */
async function assertMfaRate(db: Db, userId: string): Promise<void> {
  const rl = await rateLimit(db, `mfa:${userId}`, 8, 900);
  if (!rl.allowed) throw new AuthError("Too many codes entered. Wait a few minutes.", 429);
}

/** Daily cap on WRONG 6-digit codes: at most MFA_DAILY_FAILURES in any rolling 24 hours since the user's last
 *  (re-)enrolment or provisioning. One password-only session could otherwise keep guessing 8 codes per window all
 *  day (≈0.2 % chance per day of a valid TOTP code). Recovery codes are not subject to it (each is ~60 bits, so
 *  guessing is hopeless within the 15-minute limit), which keeps a way in for a user whose password is known to
 *  someone who exhausts the cap; replays (a double submit) do not count. */
async function assertTotpDailyCap(db: Db, userId: string, ip: string | null, purpose: string): Promise<void> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const failures = (await db.prepare(`SELECT COUNT(*) AS n FROM security_events WHERE user_id = ? AND kind = 'mfa_failed' AND detail LIKE 'totp%'
      AND created_at > max(?, COALESCE((SELECT MAX(created_at) FROM audit_logs WHERE subject_type = 'user' AND subject_id = ? AND action IN ('user.mfa_enabled', 'user.mfa_provisioned')), ''))`)
    .bind(userId, since, userId).first<{ n: number }>())?.n ?? 0;
  if (failures >= MFA_DAILY_FAILURES) {
    await securityEvent(db, "mfa_locked", { userId, ip, detail: purpose });
    throw new AuthError("Too many incorrect authenticator codes in the last 24 hours. Sign in with a recovery code, try again later, or ask an administrator to reset your two-factor authentication.", 429);
  }
}

export type SecondFactorResult = { method: "totp" } | { method: "recovery"; remaining: number };

/**
 * Verifies a second factor for this session: a 6-digit TOTP code, or (when `allowRecovery`) a single-use recovery
 * code. Success marks the session MFA-verified *now* (sessions.mfa_verified_at, used by step-up). A recovery code
 * revokes nothing else, but is recorded as a security event and in the audit log; the caller emails the user.
 */
export async function verifySecondFactor(env: MfaKeyEnv, db: Db, sessionId: string, userId: string, codeRaw: string, ip: string | null,
  purpose: "login" | "step_up", opts: { allowRecovery?: boolean } = { allowRecovery: true }): Promise<SecondFactorResult> {
  await assertMfaRate(db, userId);
  const compact = codeRaw.replace(/\s/g, "");
  let result: SecondFactorResult | null = null;
  const isTotp = /^\d{6}$/.test(compact);
  if (isTotp) {
    await assertTotpDailyCap(db, userId, ip, purpose);
    if (await checkTotp(env, db, userId, compact, ip)) result = { method: "totp" };
  } else if (opts.allowRecovery) {
    const remaining = await useRecoveryCode(db, userId, codeRaw);
    if (remaining !== null) result = { method: "recovery", remaining };
  }
  if (!result) {
    await securityEvent(db, "mfa_failed", { userId, ip, detail: `${isTotp ? "totp" : "recovery"}; ${purpose}` });
    throw new AuthError("That code is not valid.", 401);
  }
  await db.prepare(`UPDATE sessions SET mfa_verified = 1, mfa_verified_at = ? WHERE id = ? AND user_id = ?`).bind(nowIso(), sessionId, userId).run();
  if (result.method === "recovery") {
    await securityEvent(db, "mfa_recovery_code_used", { userId, ip, detail: `${purpose}; ${result.remaining} left` });
    await audit(db, { actorUserId: userId, action: "user.mfa_recovery_code_used", subjectType: "user", subjectId: userId, ip, details: { purpose, remaining: result.remaining } });
  }
  await audit(db, { actorUserId: userId, action: purpose === "login" ? "session.mfa_verified" : "session.step_up_verified", subjectType: "user", subjectId: userId, ip, details: { method: result.method } });
  return result;
}

/** Sign-in second step (TOTP or recovery code). */
export async function completeMfa(env: MfaKeyEnv, db: Db, sessionId: string, userId: string, code: string, ip: string | null): Promise<SecondFactorResult> {
  return verifySecondFactor(env, db, sessionId, userId, code, ip, "login");
}

/** Starts enrolment. Outside development without MFA_ENCRYPTION_KEY this fails closed (503) and stores nothing. */
export async function beginTotpEnrollment(env: MfaKeyEnv, db: Db, userId: string): Promise<string> {
  const secret = newTotpSecret();
  let sealed: string;
  try {
    assertCanStoreTotpSecret(env);
    sealed = await sealTotpSecret(env, userId, secret); // also validates the key (exactly 32 bytes)
  } catch (e) {
    if (e instanceof MfaKeyError) { await securityEvent(db, "mfa_key_unavailable", { userId, detail: "enrolment refused" }); throw new AuthError(e.message, 503); }
    throw e;
  }
  await db.prepare(`UPDATE users SET totp_pending_secret = ? WHERE id = ?`).bind(sealed, userId).run();
  return secret;
}

/** The pending (not yet confirmed) secret, for re-displaying the setup page after a wrong code. */
export async function pendingTotpSecret(env: MfaKeyEnv, db: Db, userId: string): Promise<string | null> {
  const u = await db.prepare(`SELECT totp_pending_secret FROM users WHERE id = ?`).bind(userId).first<{ totp_pending_secret: string | null }>();
  if (!u?.totp_pending_secret) return null;
  try { return await openTotpSecret(env, userId, u.totp_pending_secret); } catch (e) { if (e instanceof MfaKeyError) throw new AuthError(MFA_UNAVAILABLE, 503); throw e; }
}

/** Confirms enrolment and issues a new set of recovery codes, returned once (plaintext) for display. */
export async function confirmTotpEnrollment(env: MfaKeyEnv, db: Db, userId: string, sessionId: string, code: string): Promise<string[]> {
  const plain = await pendingTotpSecret(env, db, userId);
  const step = plain ? await matchTotpStep(plain, code) : null;
  if (step === null || !plain) throw new AuthError("That code is not valid. Check your authenticator's time setting and try again.");
  let sealed: string;
  try { sealed = await sealTotpSecret(env, userId, plain); } catch (e) { if (e instanceof MfaKeyError) throw new AuthError(e.message, 503); throw e; }
  const at = nowIso();
  await db.batch([
    db.prepare(`UPDATE users SET totp_secret = ?, totp_pending_secret = NULL, mfa_enabled = 1, totp_last_step = ? WHERE id = ?`).bind(sealed, step, userId),
    db.prepare(`UPDATE sessions SET mfa_verified = 1, mfa_verified_at = ? WHERE id = ?`).bind(at, sessionId),
    // Enrolling or REPLACING the authenticator signs out every other session: a session verified with the old
    // authenticator (for example on a lost or stolen device) must not stay signed in after the replacement.
    db.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id IS NOT ? AND revoked_at IS NULL`).bind(at, userId, sessionId),
  ]);
  await audit(db, { actorUserId: userId, action: "user.mfa_enabled", subjectType: "user", subjectId: userId, details: { otherSessionsRevoked: true } });
  const codes = await issueRecoveryCodes(db, userId);
  await audit(db, { actorUserId: userId, action: "user.mfa_recovery_codes_generated", subjectType: "user", subjectId: userId, details: { count: codes.length } });
  return codes;
}

/** Replaces the user's recovery codes with RECOVERY_CODE_COUNT new ones; only their password hashes are stored. */
async function issueRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  const codes: string[] = [];
  const lookups = new Set<string>();
  while (codes.length < RECOVERY_CODE_COUNT) {
    const c = newRecoveryCode();
    if (lookups.has(c.slice(0, 4))) continue;
    lookups.add(c.slice(0, 4));
    codes.push(c);
  }
  const at = nowIso();
  const hashes = await Promise.all(codes.map((c) => hashPassword(normalizeRecoveryCode(c)!)));
  await db.batch([
    db.prepare(`DELETE FROM mfa_recovery_codes WHERE user_id = ?`).bind(userId),
    ...codes.map((c, i) => db.prepare(`INSERT INTO mfa_recovery_codes (id, user_id, lookup, code_hash, created_at) VALUES (?,?,?,?,?)`).bind(newId("mrc"), userId, c.slice(0, 4), hashes[i], at)),
  ]);
  return codes;
}

/**
 * Regenerates recovery codes. Requires an MFA-verified session AND a current TOTP code from the authenticator
 * (a recovery code cannot mint new recovery codes). Audited and recorded as a security event.
 */
export async function regenerateRecoveryCodes(env: MfaKeyEnv, db: Db, sessionId: string, userId: string, code: string, ip: string | null): Promise<string[]> {
  await assertMfaRate(db, userId);
  await assertTotpDailyCap(db, userId, ip, "recovery_codes");
  const compact = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(compact) || !(await checkTotp(env, db, userId, compact, ip))) {
    await securityEvent(db, "mfa_failed", { userId, ip, detail: "totp; recovery code regeneration" });
    throw new AuthError("Enter the current 6-digit code from your authenticator app.", 401);
  }
  await db.prepare(`UPDATE sessions SET mfa_verified_at = ? WHERE id = ? AND user_id = ? AND mfa_verified = 1`).bind(nowIso(), sessionId, userId).run();
  const codes = await issueRecoveryCodes(db, userId);
  await securityEvent(db, "mfa_recovery_codes_regenerated", { userId, ip });
  await audit(db, { actorUserId: userId, action: "user.mfa_recovery_codes_regenerated", subjectType: "user", subjectId: userId, ip, details: { count: codes.length } });
  return codes;
}

export async function recoveryCodeStatus(db: Db, userId: string): Promise<{ total: number; remaining: number }> {
  const r = await db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS remaining FROM mfa_recovery_codes WHERE user_id = ?`).bind(userId).first<{ total: number; remaining: number | null }>();
  return { total: r?.total ?? 0, remaining: r?.remaining ?? 0 };
}

/** Clears every MFA factor (authenticator, pending enrolment, recovery codes): the user must enrol again. Callers revoke sessions and audit. */
export async function clearMfa(db: Db, userId: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = NULL, mfa_enabled = 0 WHERE id = ?`).bind(userId),
    db.prepare(`DELETE FROM mfa_recovery_codes WHERE user_id = ?`).bind(userId),
  ]);
}

/**
 * Issues a new token for an existing session (CREST-GAP-086): called when a session is elevated by completing MFA, so
 * a token observed before the second factor (password-only stage) is worthless afterwards. Returns the new token and
 * the seconds left on the session for the cookie's Max-Age.
 */
export async function rotateSessionToken(db: Db, sessionId: string): Promise<{ token: string; maxAge: number } | null> {
  const s = await db.prepare(`SELECT expires_at FROM sessions WHERE id = ? AND revoked_at IS NULL`).bind(sessionId).first<{ expires_at: string }>();
  if (!s) return null;
  const token = randomToken();
  await db.prepare(`UPDATE sessions SET token_hash = ? WHERE id = ? AND revoked_at IS NULL`).bind(await hashToken(token), sessionId).run();
  return { token, maxAge: Math.max(0, Math.floor((Date.parse(s.expires_at) - Date.now()) / 1000)) };
}

export async function revokeSession(db: Db, sessionId: string, byUserId: string) {
  await db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(nowIso(), sessionId).run();
  await audit(db, { actorUserId: byUserId, action: "session.revoked", subjectType: "session", subjectId: sessionId });
}

export async function revokeAllSessions(db: Db, userId: string, exceptSessionId: string | null, byUserId: string) {
  await db.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?`).bind(nowIso(), userId, exceptSessionId).run();
  await audit(db, { actorUserId: byUserId, action: "session.revoked_all", subjectType: "user", subjectId: userId });
}

/** Per-IP limit on reset requests (bot protection, docs/AUTH-PRODUCTION.md gap 4); the per-email limit below stays. */
export const RESET_PER_IP_LIMIT = 10, RESET_PER_IP_WINDOW_S = 3600;
export async function requestPasswordReset(db: Db, emailRaw: string, ip: string | null): Promise<{ userId: string; token: string } | null> {
  const email = emailRaw.trim().toLowerCase();
  const ipRl = await rateLimit(db, `reset-ip:${ip ?? "unknown"}`, RESET_PER_IP_LIMIT, RESET_PER_IP_WINDOW_S);
  if (!ipRl.allowed) {
    await securityEvent(db, "rate_limited", { ip, detail: "password reset (per IP)" });
    throw new AuthError("Too many reset requests from your network. Wait an hour and try again.", 429);
  }
  const rl = await rateLimit(db, `reset:${email}`, 3, 3600);
  if (!rl.allowed) return null;
  const u = await db.prepare(`SELECT id FROM users WHERE email = ? AND disabled_at IS NULL`).bind(email).first<{ id: string }>();
  if (!u) return null;
  const token = randomToken();
  await db.prepare(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?,?,'password_reset',?,?)`)
    .bind(await hashToken(token), u.id, new Date(Date.now() + 3600e3).toISOString(), nowIso()).run();
  await securityEvent(db, "password_reset_requested", { userId: u.id, email, ip });
  return { userId: u.id, token };
}

/**
 * After a password is reset or changed, every other outstanding reset link for the account stops working.
 * Otherwise a reset link sent earlier (for example to a mailbox an attacker can read) would stay valid for its
 * full hour and could undo the change.
 */
export async function invalidateResetTokens(db: Db, userId: string): Promise<void> {
  await db.prepare(`UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = 'password_reset' AND used_at IS NULL`).bind(nowIso(), userId).run();
}

export async function resetPassword(db: Db, token: string, newPassword: string, ip: string | null) {
  const userId = await consumeToken(db, token, "password_reset");
  const u = await db.prepare(`SELECT email FROM users WHERE id = ?`).bind(userId).first<{ email: string }>();
  const problems = passwordProblems(newPassword, u?.email);
  if (problems.length) throw new AuthError(problems.join(". "));
  await db.prepare(`UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?`).bind(await hashPassword(newPassword), userId).run();
  await invalidateResetTokens(db, userId);
  await revokeAllSessions(db, userId, null, userId);
  // Account recovery forgets every remembered browser (CREST-GAP-003): they must complete a sign-in again.
  await db.prepare(`UPDATE known_devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).bind(nowIso(), userId).run();
  await audit(db, { actorUserId: userId, action: "user.password_reset", subjectType: "user", subjectId: userId, ip });
  return userId;
}

export async function changePassword(db: Db, userId: string, current: string, next: string, keepSessionId: string) {
  const u = await db.prepare(`SELECT email, password_hash FROM users WHERE id = ?`).bind(userId).first<{ email: string; password_hash: string }>();
  if (!u || !(await verifyPassword(current, u.password_hash))) throw new AuthError("Current password is incorrect.", 401);
  const problems = passwordProblems(next, u.email);
  if (problems.length) throw new AuthError(problems.join(". "));
  await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(await hashPassword(next), userId).run();
  await invalidateResetTokens(db, userId);
  await audit(db, { actorUserId: userId, action: "user.password_changed", subjectType: "user", subjectId: userId });
  await revokeAllSessions(db, userId, keepSessionId, userId);
}

// ── Staff invitations (AUTH-006) ──
export async function createInvitation(db: Db, byUserId: string, email: string, role: Role, organizationId: string): Promise<string> {
  if (!(STAFF_ROLES as readonly string[]).includes(role) && role !== "customer_member" && role !== "customer_admin") throw new AuthError("Unknown role");
  if (role === "owner") throw new AuthError("The Owner role cannot be granted by invitation.");
  const token = randomToken();
  await db.prepare(`INSERT INTO invitations (id, email, organization_id, role_id, token_hash, invited_by, expires_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(newId("inv"), email.trim().toLowerCase(), organizationId, role, await hashToken(token), byUserId, new Date(Date.now() + 7 * 86400e3).toISOString()).run();
  await audit(db, { actorUserId: byUserId, action: "invitation.created", subjectType: "invitation", organizationId, details: { email, role } });
  return token;
}

export async function invitationByToken(db: Db, token: string) {
  return db.prepare(`SELECT i.id, i.email, i.role_id, i.organization_id, i.expires_at, i.accepted_at, o.name AS org_name FROM invitations i JOIN organizations o ON o.id = i.organization_id WHERE i.token_hash = ?`)
    .bind(await hashToken(token)).first<{ id: string; email: string; role_id: Role; organization_id: string; expires_at: string; accepted_at: string | null; org_name: string }>();
}

export async function acceptInvitation(db: Db, token: string, name: string, password: string) {
  const inv = await invitationByToken(db, token);
  if (!inv || inv.accepted_at || inv.expires_at < nowIso()) throw new AuthError("This invitation is invalid or has expired.");
  const problems = passwordProblems(password, inv.email);
  if (problems.length) throw new AuthError(problems.join(". "));
  const at = nowIso();
  let user = await db.prepare(`SELECT id FROM users WHERE email = ?`).bind(inv.email).first<{ id: string }>();
  const stmts = [];
  if (!user) {
    user = { id: newId("usr") };
    stmts.push(db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, created_at) VALUES (?,?,?,?,?,?)`).bind(user.id, inv.email, name.trim(), await hashPassword(password), at, at));
  }
  stmts.push(
    db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id, organization_id) DO UPDATE SET role_id = excluded.role_id`).bind(newId("mbr"), user.id, inv.organization_id, inv.role_id, at),
    db.prepare(`UPDATE invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL`).bind(at, inv.id),
  );
  await db.batch(stmts);
  await audit(db, { actorUserId: user.id, action: "invitation.accepted", subjectType: "invitation", subjectId: inv.id, organizationId: inv.organization_id, details: { role: inv.role_id } });
  return user.id;
}
