// Account lifecycle and sessions (AUTH-001..006). Implemented in-platform with a local adapter
// design: if the Founder approves a managed identity provider, `loadSession` and the login
// routes are the only places that change. Authorization is always enforced by the platform.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { hashPassword, verifyPassword, randomToken, hashToken, passwordProblems, matchTotpStep, newTotpSecret } from "../lib/auth-crypto.ts";
import { STAFF_ROLES, type Actor, type Role } from "../domain/authz.ts";
import type { SessionUser } from "../app/context.ts";
import { rateLimit, securityEvent, audit } from "./security.ts";

export const SESSION_TTL_STAFF_S = 12 * 3600;
export const SESSION_TTL_CUSTOMER_S = 7 * 24 * 3600;
/** Idle timeouts (ASVS 3.3.2): a session unused for this long is rejected. */
export const SESSION_IDLE_STAFF_S = 2 * 3600;
export const SESSION_IDLE_CUSTOMER_S = 24 * 3600;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60e3;
const LOCK_AFTER = 8;
const LOCK_MINUTES = 15;

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
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

export async function login(db: Db, emailRaw: string, password: string, meta: { ip: string | null; userAgent: string | null }): Promise<LoginResult> {
  const email = emailRaw.trim().toLowerCase();
  const ipRl = await rateLimit(db, `login-ip:${meta.ip ?? "unknown"}`, 30, 900);
  const emRl = await rateLimit(db, `login-email:${email}`, 10, 900);
  if (!ipRl.allowed || !emRl.allowed) {
    await securityEvent(db, "rate_limited", { email, ip: meta.ip, detail: "login" });
    throw new AuthError("Too many sign-in attempts. Wait a few minutes and try again.", 429);
  }
  const u = await db.prepare(`SELECT id, password_hash, disabled_at, locked_until, failed_logins, totp_secret FROM users WHERE email = ?`).bind(email)
    .first<{ id: string; password_hash: string | null; disabled_at: string | null; locked_until: string | null; failed_logins: number; totp_secret: string | null }>();
  const ok = await verifyPassword(password, u?.password_hash ?? null);
  if (!u || !ok || u.disabled_at) {
    if (u) {
      const fails = u.failed_logins + 1;
      const lock = fails >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60e3).toISOString() : null;
      await db.prepare(`UPDATE users SET failed_logins = ?, locked_until = COALESCE(?, locked_until) WHERE id = ?`).bind(fails, lock, u.id).run();
      if (lock) await securityEvent(db, "login_locked", { userId: u.id, email, ip: meta.ip });
    }
    await securityEvent(db, "login_failed", { userId: u?.id, email, ip: meta.ip });
    throw new AuthError("Email or password is incorrect.", 401);
  }
  if (u.locked_until && u.locked_until > nowIso()) throw new AuthError("This account is temporarily locked after repeated failed sign-ins. Try again later.", 423);
  await db.prepare(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?`).bind(u.id).run();
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

export async function loadSession(db: Db, token: string | undefined): Promise<{ user: SessionUser; actor: Actor; sessionId: string; mfaVerified: boolean } | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const s = await db.prepare(
    `SELECT s.id, s.user_id, s.mfa_verified, s.expires_at, s.revoked_at, s.created_at, s.last_seen_at, u.email, u.display_name, u.email_verified_at, u.totp_secret, u.disabled_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).bind(await hashToken(token)).first<{ id: string; user_id: string; mfa_verified: number; expires_at: string; revoked_at: string | null; created_at: string; last_seen_at: string | null; email: string; display_name: string; email_verified_at: string | null; totp_secret: string | null; disabled_at: string | null }>();
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
  if (Date.now() - lastSeen > LAST_SEEN_WRITE_INTERVAL_MS) {
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
  return { user, actor, sessionId: s.id, mfaVerified: effectiveMfa };
}

export async function completeMfa(db: Db, sessionId: string, userId: string, code: string, ip: string | null): Promise<void> {
  const rl = await rateLimit(db, `mfa:${userId}`, 8, 900);
  if (!rl.allowed) throw new AuthError("Too many codes entered. Wait a few minutes.", 429);
  const u = await db.prepare(`SELECT totp_secret, totp_last_step FROM users WHERE id = ?`).bind(userId).first<{ totp_secret: string | null; totp_last_step: number | null }>();
  const step = u?.totp_secret ? await matchTotpStep(u.totp_secret, code) : null;
  if (step === null) {
    await securityEvent(db, "mfa_failed", { userId, ip });
    throw new AuthError("That code is not valid.", 401);
  }
  // Replay protection: each time-step can be used once, and never an earlier one.
  const claim = await db.prepare(`UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`).bind(step, userId, step).run();
  if (claim.meta.changes !== 1) {
    await securityEvent(db, "mfa_replay_rejected", { userId, ip });
    throw new AuthError("That code was already used. Wait for the next code.", 401);
  }
  await db.prepare(`UPDATE sessions SET mfa_verified = 1 WHERE id = ? AND user_id = ?`).bind(sessionId, userId).run();
  await audit(db, { actorUserId: userId, action: "session.mfa_verified", subjectType: "user", subjectId: userId, ip });
}

export async function beginTotpEnrollment(db: Db, userId: string): Promise<string> {
  const secret = newTotpSecret();
  await db.prepare(`UPDATE users SET totp_pending_secret = ? WHERE id = ?`).bind(secret, userId).run();
  return secret;
}

export async function confirmTotpEnrollment(db: Db, userId: string, sessionId: string, code: string): Promise<void> {
  const u = await db.prepare(`SELECT totp_pending_secret FROM users WHERE id = ?`).bind(userId).first<{ totp_pending_secret: string | null }>();
  const step = u?.totp_pending_secret ? await matchTotpStep(u.totp_pending_secret, code) : null;
  if (step === null) throw new AuthError("That code is not valid. Check your authenticator's time setting and try again.");
  await db.batch([
    db.prepare(`UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, mfa_enabled = 1, totp_last_step = ? WHERE id = ?`).bind(step, userId),
    db.prepare(`UPDATE sessions SET mfa_verified = 1 WHERE id = ?`).bind(sessionId),
  ]);
  await audit(db, { actorUserId: userId, action: "user.mfa_enabled", subjectType: "user", subjectId: userId });
}

export async function revokeSession(db: Db, sessionId: string, byUserId: string) {
  await db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(nowIso(), sessionId).run();
  await audit(db, { actorUserId: byUserId, action: "session.revoked", subjectType: "session", subjectId: sessionId });
}

export async function revokeAllSessions(db: Db, userId: string, exceptSessionId: string | null, byUserId: string) {
  await db.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?`).bind(nowIso(), userId, exceptSessionId).run();
  await audit(db, { actorUserId: byUserId, action: "session.revoked_all", subjectType: "user", subjectId: userId });
}

export async function requestPasswordReset(db: Db, emailRaw: string, ip: string | null): Promise<{ userId: string; token: string } | null> {
  const email = emailRaw.trim().toLowerCase();
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

export async function resetPassword(db: Db, token: string, newPassword: string, ip: string | null) {
  const userId = await consumeToken(db, token, "password_reset");
  const u = await db.prepare(`SELECT email FROM users WHERE id = ?`).bind(userId).first<{ email: string }>();
  const problems = passwordProblems(newPassword, u?.email);
  if (problems.length) throw new AuthError(problems.join(". "));
  await db.prepare(`UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?`).bind(await hashPassword(newPassword), userId).run();
  await revokeAllSessions(db, userId, null, userId);
  await audit(db, { actorUserId: userId, action: "user.password_reset", subjectType: "user", subjectId: userId, ip });
  return userId;
}

export async function changePassword(db: Db, userId: string, current: string, next: string, keepSessionId: string) {
  const u = await db.prepare(`SELECT email, password_hash FROM users WHERE id = ?`).bind(userId).first<{ email: string; password_hash: string }>();
  if (!u || !(await verifyPassword(current, u.password_hash))) throw new AuthError("Current password is incorrect.", 401);
  const problems = passwordProblems(next, u.email);
  if (problems.length) throw new AuthError(problems.join(". "));
  await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(await hashPassword(next), userId).run();
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
