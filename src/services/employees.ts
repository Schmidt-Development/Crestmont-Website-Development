// Staff administration (EMP-001, EMP-002, AUTH-006). Rules:
//  - The Owner role is never granted or removed through the platform UI (bootstrap only).
//  - Nobody can change the Owner account's role or disable it; Administrators cannot modify the
//    Owner account at all.
//  - Users cannot disable themselves or change their own role.
//  - Disabling revokes every session immediately. Every change is audited.
//  - Two-factor reset (lost authenticator, AUTH-002): Owner / Administrator only (employee.manage); never your own
//    account; the Owner account only by the Owner (a locked-out Owner uses scripts/reset-owner-mfa.ts). Clears the
//    authenticator and recovery codes and revokes every session, so the person must enrol again at next sign-in.
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { STAFF_ROLES, type Role } from "../domain/authz.ts";
import { audit, securityEvent } from "./security.ts";
import { clearMfa, createInvitation, revokeAllSessions } from "./auth.ts";

/** Roles that can be assigned or invited through the UI (never 'owner'). */
export const ASSIGNABLE_STAFF_ROLES = STAFF_ROLES.filter((r) => r !== "owner") as Exclude<(typeof STAFF_ROLES)[number], "owner">[];

export class EmployeeError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export interface StaffRow {
  id: string; email: string; display_name: string; role: Role; mfa: number; disabled_at: string | null; locked_until: string | null;
  last_sign_in: string | null; active_sessions: number; open_assignments: number; created_at: string;
}

export async function internalOrgId(db: Db): Promise<string | null> {
  return (await db.prepare(`SELECT id FROM organizations WHERE kind = 'internal' ORDER BY created_at LIMIT 1`).first<{ id: string }>())?.id ?? null;
}

export async function listStaff(db: Db, now = nowIso()): Promise<StaffRow[]> {
  return (await db.prepare(
    `SELECT u.id, u.email, u.display_name, m.role_id AS role, CASE WHEN u.totp_secret IS NOT NULL THEN 1 ELSE 0 END AS mfa, u.disabled_at, u.locked_until, u.created_at,
       (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_sign_in,
       (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions,
       (SELECT COUNT(*) FROM assignments a WHERE a.user_id = u.id AND a.ended_at IS NULL) AS open_assignments
     FROM memberships m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id
     WHERE o.kind = 'internal' AND m.role_id IN ('owner','administrator','sales','developer','project_manager','support')
     ORDER BY CASE m.role_id WHEN 'owner' THEN 0 WHEN 'administrator' THEN 1 ELSE 2 END, u.display_name`,
  ).bind(now).all<StaffRow>()).results;
}

export async function staffWorkload(db: Db, userId: string) {
  return (await db.prepare(`SELECT subject_type, COUNT(*) AS n FROM assignments WHERE user_id = ? AND ended_at IS NULL GROUP BY subject_type ORDER BY subject_type`)
    .bind(userId).all<{ subject_type: string; n: number }>()).results;
}

export async function pendingInvitations(db: Db, now = nowIso()) {
  return (await db.prepare(`SELECT i.id, i.email, i.role_id, i.expires_at, u.display_name AS invited_by_name FROM invitations i JOIN organizations o ON o.id = i.organization_id
     LEFT JOIN users u ON u.id = i.invited_by WHERE o.kind = 'internal' AND i.accepted_at IS NULL AND i.expires_at > ? ORDER BY i.expires_at DESC`)
    .bind(now).all<{ id: string; email: string; role_id: string; expires_at: string; invited_by_name: string | null }>()).results;
}

async function staffMembership(db: Db, userId: string) {
  return db.prepare(`SELECT m.id, m.role_id, m.organization_id, u.disabled_at, u.email FROM memberships m JOIN organizations o ON o.id = m.organization_id JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ? AND o.kind = 'internal' AND m.role_id IN ('owner','administrator','sales','developer','project_manager','support')`)
    .bind(userId).first<{ id: string; role_id: Role; organization_id: string; disabled_at: string | null; email: string }>();
}

export async function inviteStaff(db: Db, byUserId: string, emailRaw: string, role: string): Promise<{ token: string; email: string; role: Role }> {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) throw new EmployeeError("Enter a valid email address.");
  if (role === "owner") throw new EmployeeError("The Owner role cannot be granted through the platform.", 403);
  if (!(ASSIGNABLE_STAFF_ROLES as string[]).includes(role)) throw new EmployeeError("Choose a staff role.");
  const orgId = await internalOrgId(db);
  if (!orgId) throw new EmployeeError("The internal Crestmont organization does not exist yet.", 409);
  const existing = await db.prepare(`SELECT m.role_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ? AND m.organization_id = ?`).bind(email, orgId).first<{ role_id: string }>();
  if (existing) throw new EmployeeError("That person is already a staff member. Change their role instead.", 409);
  const token = await createInvitation(db, byUserId, email, role as Role, orgId);
  return { token, email, role: role as Role };
}

export async function changeStaffRole(db: Db, actor: { userId: string; isOwner: boolean }, targetUserId: string, newRole: string): Promise<{ from: Role; to: Role }> {
  if (newRole === "owner") throw new EmployeeError("The Owner role cannot be granted through the platform.", 403);
  if (!(ASSIGNABLE_STAFF_ROLES as string[]).includes(newRole)) throw new EmployeeError("Choose a staff role.");
  if (targetUserId === actor.userId) throw new EmployeeError("You cannot change your own role.", 403);
  const m = await staffMembership(db, targetUserId);
  if (!m) throw new EmployeeError("Staff member not found.", 404);
  if (m.role_id === "owner") throw new EmployeeError("The Owner account's role cannot be changed through the platform.", 403);
  if (m.role_id === newRole) return { from: m.role_id, to: m.role_id };
  const res = await db.prepare(`UPDATE memberships SET role_id = ? WHERE id = ? AND role_id = ?`).bind(newRole, m.id, m.role_id).run();
  if (res.meta.changes !== 1) throw new EmployeeError("The role changed concurrently. Reload and try again.", 409);
  // Existing sessions carry the old role in memory only per request; revoke so the new role applies cleanly.
  await revokeAllSessions(db, targetUserId, null, actor.userId);
  await audit(db, { actorUserId: actor.userId, action: "employee.role_changed", subjectType: "user", subjectId: targetUserId, organizationId: m.organization_id, details: { from: m.role_id, to: newRole } });
  return { from: m.role_id, to: newRole as Role };
}

export async function setStaffDisabled(db: Db, actor: { userId: string; isOwner: boolean }, targetUserId: string, disable: boolean, reason: string): Promise<void> {
  if (targetUserId === actor.userId) throw new EmployeeError("You cannot disable or enable your own account.", 403);
  const m = await staffMembership(db, targetUserId);
  if (!m) throw new EmployeeError("Staff member not found.", 404);
  if (m.role_id === "owner") throw new EmployeeError("The Owner account cannot be disabled through the platform.", 403);
  if (disable && reason.trim().length < 3) throw new EmployeeError("Give a short reason for disabling this account.");
  if (disable) {
    if (m.disabled_at) return;
    await db.prepare(`UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`).bind(nowIso(), targetUserId).run();
    await revokeAllSessions(db, targetUserId, null, actor.userId);
  } else {
    if (!m.disabled_at) return;
    await db.prepare(`UPDATE users SET disabled_at = NULL, failed_logins = 0, locked_until = NULL WHERE id = ?`).bind(targetUserId).run();
  }
  await audit(db, { actorUserId: actor.userId, action: disable ? "employee.disabled" : "employee.enabled", subjectType: "user", subjectId: targetUserId, organizationId: m.organization_id, details: disable ? { reason: reason.slice(0, 300) } : undefined });
}

export async function revokeInvitation(db: Db, byUserId: string, invitationId: string): Promise<void> {
  const res = await db.prepare(`UPDATE invitations SET expires_at = ? WHERE id = ? AND accepted_at IS NULL AND role_id <> 'owner' AND expires_at > ?`).bind(nowIso(), invitationId, nowIso()).run();
  if (res.meta.changes !== 1) throw new EmployeeError("Invitation not found or no longer pending.", 404);
  await audit(db, { actorUserId: byUserId, action: "invitation.revoked", subjectType: "invitation", subjectId: invitationId });
}

export async function resetStaffMfa(db: Db, actor: { userId: string; isOwner: boolean }, targetUserId: string, ip: string | null): Promise<{ email: string }> {
  if (targetUserId === actor.userId) throw new EmployeeError("You cannot reset your own two-factor authentication here. Use \"Replace authenticator\" on your account page, or a recovery code.", 403);
  const m = await staffMembership(db, targetUserId);
  if (!m) throw new EmployeeError("Staff member not found.", 404);
  if (m.role_id === "owner" && !actor.isOwner) throw new EmployeeError("Only the Owner can reset the Owner account's two-factor authentication. A locked-out Owner follows the break-glass procedure in docs/RUNBOOK.md.", 403);
  await clearMfa(db, targetUserId);
  await revokeAllSessions(db, targetUserId, null, actor.userId);
  await securityEvent(db, "mfa_reset_by_admin", { userId: targetUserId, ip, detail: `by ${actor.userId}` });
  await audit(db, { actorUserId: actor.userId, action: "employee.mfa_reset", subjectType: "user", subjectId: targetUserId, organizationId: m.organization_id, ip, details: { role: m.role_id } });
  return { email: m.email };
}
