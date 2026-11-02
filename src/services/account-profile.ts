// Customer self-service profile (CREST-GAP-073) and the customer-administrator two-factor reminder (CREST-GAP-072).
//
// Display name: edited directly, audited.
// Email change: the person confirms their current password and names a new address. Nothing changes yet: a
// single-use link (48 h, only its SHA-256 stored) goes to the NEW address and the OLD address is told a change was
// requested. The new address takes effect only when that link is confirmed; then the address is marked verified,
// every other session is signed out, and the old address is told the change happened. Requests never reveal
// whether another account already uses the new address. Staff email addresses are managed by an administrator,
// not here.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { hashToken, randomToken, verifyPassword } from "../lib/auth-crypto.ts";
import { audit, rateLimit } from "./security.ts";
import { sendMail } from "./mailer.ts";
import type { MailCtx } from "./notifications.ts";

export class ProfileError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}

export const EMAIL_CHANGE_TTL_HOURS = 48;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function updateDisplayName(db: Db, userId: string, raw: string, ip: string | null = null): Promise<string> {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 2) throw new ProfileError("Enter your name (at least 2 characters).");
  if (name.length > 100) throw new ProfileError("Names are limited to 100 characters.");
  if (/[<>\u0000-\u001f]/.test(name)) throw new ProfileError("Names cannot contain angle brackets or control characters.");
  const before = await db.prepare(`SELECT display_name FROM users WHERE id = ?`).bind(userId).first<{ display_name: string }>();
  if (!before) throw new ProfileError("Account not found.", 404);
  if (before.display_name === name) return name;
  await db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).bind(name, userId).run();
  await audit(db, { actorUserId: userId, action: "user.profile_updated", subjectType: "user", subjectId: userId, ip, details: { field: "display_name" } });
  return name;
}

export interface PendingEmailChange { id: string; new_email: string; created_at: string; expires_at: string }

export async function pendingEmailChange(db: Db, userId: string, now = nowIso()): Promise<PendingEmailChange | null> {
  return db.prepare(`SELECT id, new_email, created_at, expires_at FROM email_change_requests WHERE user_id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`)
    .bind(userId, now).first<PendingEmailChange>();
}

/** Starts an email change: mails a confirmation link to the new address and a notice to the old one. Never displays the token. */
export async function requestEmailChange(ctx: MailCtx & { ip?: string | null }, userId: string, newEmailRaw: string, currentPassword: string): Promise<void> {
  const db = ctx.db;
  const newEmail = newEmailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(newEmail) || newEmail.length > 254) throw new ProfileError("Enter a valid email address.");
  const user = await db.prepare(`SELECT id, email, password_hash FROM users WHERE id = ? AND disabled_at IS NULL`).bind(userId).first<{ id: string; email: string; password_hash: string | null }>();
  if (!user) throw new ProfileError("Account not found.", 404);
  if (!(await rateLimit(db, `email-change:${userId}`, 5, 3600)).allowed) throw new ProfileError("Too many email change requests. Try again in an hour.", 429);
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    await audit(db, { actorUserId: userId, action: "user.email_change_denied", subjectType: "user", subjectId: userId, ip: ctx.ip ?? null, details: { reason: "wrong_password" } });
    throw new ProfileError("Your current password is not correct.");
  }
  if (newEmail === user.email.toLowerCase()) throw new ProfileError("That is already your email address.");
  const at = nowIso();
  // Only one open request at a time: a new request replaces the previous link.
  await db.prepare(`UPDATE email_change_requests SET cancelled_at = ? WHERE user_id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL`).bind(at, userId).run();
  const taken = await db.prepare(`SELECT 1 FROM users WHERE email = ? AND id <> ?`).bind(newEmail, userId).first();
  const id = newId("ecr");
  if (!taken) {
    const token = randomToken();
    await db.prepare(`INSERT INTO email_change_requests (id, user_id, old_email, new_email, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(id, userId, user.email, newEmail, await hashToken(token), new Date(Date.now() + EMAIL_CHANGE_TTL_HOURS * 3600e3).toISOString(), at).run();
    await sendMail(ctx, { template: "email_change_confirm", to: newEmail, idempotencyKey: `email-change:${id}`, data: { confirmUrl: `${ctx.baseUrl}/account/email/confirm?token=${token}` } });
  }
  // The old address is always told, so a hijacked session cannot move the account silently.
  await sendMail(ctx, { template: "security_notification", to: user.email, idempotencyKey: `email-change-old:${id}`, data: { event: "email_change_requested" } });
  // The audit trail records whether a link was actually sent; the person sees the same message either way.
  await audit(db, { actorUserId: userId, action: "user.email_change_requested", subjectType: "user", subjectId: userId, ip: ctx.ip ?? null, details: { linkSent: !taken } });
}

export async function cancelEmailChange(db: Db, userId: string, ip: string | null = null): Promise<boolean> {
  const res = await db.prepare(`UPDATE email_change_requests SET cancelled_at = ? WHERE user_id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL`).bind(nowIso(), userId).run();
  await audit(db, { actorUserId: userId, action: "user.email_change_cancelled", subjectType: "user", subjectId: userId, ip, details: { cancelled: res.meta.changes } });
  return res.meta.changes > 0;
}

/** Looks up an open request by token without consuming it (for the confirmation page). */
export async function emailChangeByToken(db: Db, token: string): Promise<{ id: string; user_id: string; new_email: string } | null> {
  if (!token || token.length > 200) return null;
  return db.prepare(`SELECT id, user_id, new_email FROM email_change_requests WHERE token_hash = ? AND confirmed_at IS NULL AND cancelled_at IS NULL AND expires_at > ?`)
    .bind(await hashToken(token), nowIso()).first<{ id: string; user_id: string; new_email: string }>();
}

/** Confirms the change: the new address becomes the sign-in address. Other sessions are signed out (except `keepSessionId`). */
export async function confirmEmailChange(ctx: MailCtx & { ip?: string | null }, token: string, keepSessionId: string | null): Promise<{ userId: string; newEmail: string }> {
  const db = ctx.db;
  const req = await emailChangeByToken(db, token);
  if (!req) throw new ProfileError("This confirmation link is invalid, already used, cancelled or expired.", 404);
  const at = nowIso();
  const claimed = await db.prepare(`UPDATE email_change_requests SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL`).bind(at, req.id).run();
  if (claimed.meta.changes !== 1) throw new ProfileError("This confirmation link has already been used.", 409);
  const old = await db.prepare(`SELECT email FROM users WHERE id = ? AND disabled_at IS NULL`).bind(req.user_id).first<{ email: string }>();
  if (!old) throw new ProfileError("This account is no longer active.", 409);
  if (await db.prepare(`SELECT 1 FROM users WHERE email = ? AND id <> ?`).bind(req.new_email, req.user_id).first()) {
    throw new ProfileError("That email address is no longer available. Request the change again with another address.", 409);
  }
  await db.batch([
    db.prepare(`UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?`).bind(req.new_email, at, req.user_id),
    db.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?`).bind(at, req.user_id, keepSessionId),
  ]);
  await audit(db, { actorUserId: req.user_id, action: "user.email_changed", subjectType: "user", subjectId: req.user_id, ip: ctx.ip ?? null, details: { request: req.id, otherSessionsRevoked: true } });
  await sendMail(ctx, { template: "security_notification", to: old.email, idempotencyKey: `email-changed-old:${req.id}`, data: { event: "email_changed" } });
  return { userId: req.user_id, newEmail: req.new_email };
}

// ───────────── CREST-GAP-072 / FD-30: two-factor notice for customer administrators ─────────────
// Founder decision FD-30 (supersedes the CREST-GAP-072 "prompt, not require" default): customer administrators must
// use MFA. Until they enrol, the portal shows a notice that can no longer be dismissed, and administrator actions are
// refused (src/app/app.ts, src/domain/authz.ts). Customer members keep MFA optional. Staff and Owner MFA is mandatory.

export const MFA_REMINDER = "customer_admin_mfa";

export async function shouldShowMfaReminder(db: Db, user: { id: string; mfaEnabled: boolean; isStaff: boolean }, role: string): Promise<boolean> {
  void db; // FD-30: a dismissal recorded earlier no longer hides the notice (enrolment is required, not recommended)
  return !(user.isStaff || user.mfaEnabled || role !== "customer_admin");
}

export async function dismissMfaReminder(db: Db, userId: string, ip: string | null = null): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO user_notice_dismissals (user_id, notice, dismissed_at) VALUES (?,?,?)`).bind(userId, MFA_REMINDER, nowIso()).run();
  await audit(db, { actorUserId: userId, action: "user.mfa_reminder_dismissed", subjectType: "user", subjectId: userId, ip });
}
