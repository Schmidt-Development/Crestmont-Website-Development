// Customer team permissions (PORTAL-001, AUTH-008): a customer administrator manages their own
// organization's members and invitations. Every query is scoped by the organization resolved from the
// session (never from the URL), an organization always keeps at least one administrator, nobody
// changes their own role, and every change is audited. Removing a member revokes their sessions.
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { revokeAllSessions } from "./auth.ts";

export const CUSTOMER_TEAM_ROLES = ["customer_admin", "customer_member"] as const;
export type CustomerTeamRole = (typeof CUSTOMER_TEAM_ROLES)[number];

export class TeamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function member(db: Db, organizationId: string, userId: string) {
  return db.prepare(`SELECT m.id, m.role_id, u.email, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.user_id = ? AND m.role_id IN ('customer_admin','customer_member')`)
    .bind(organizationId, userId).first<{ id: string; role_id: CustomerTeamRole; email: string; display_name: string }>();
}

async function adminCount(db: Db, organizationId: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.role_id = 'customer_admin' AND u.disabled_at IS NULL`).bind(organizationId).first<{ n: number }>())?.n ?? 0;
}

export async function changeMemberRole(db: Db, actorUserId: string, organizationId: string, targetUserId: string, role: string) {
  if (!(CUSTOMER_TEAM_ROLES as readonly string[]).includes(role)) throw new TeamError(422, "Choose administrator or member.");
  if (targetUserId === actorUserId) throw new TeamError(409, "You cannot change your own role. Ask another administrator.");
  const m = await member(db, organizationId, targetUserId);
  if (!m) throw new TeamError(404, "That person is not a member of your organization.");
  if (m.role_id === role) return { from: m.role_id, to: m.role_id };
  if (m.role_id === "customer_admin" && (await adminCount(db, organizationId)) <= 1) throw new TeamError(409, "Your organization must keep at least one administrator.");
  await db.prepare(`UPDATE memberships SET role_id = ? WHERE id = ? AND organization_id = ?`).bind(role, m.id, organizationId).run();
  await audit(db, { actorUserId, action: "customer.member_role_changed", subjectType: "user", subjectId: targetUserId, organizationId, details: { from: m.role_id, to: role } });
  return { from: m.role_id, to: role as CustomerTeamRole };
}

export async function removeMember(db: Db, actorUserId: string, organizationId: string, targetUserId: string) {
  if (targetUserId === actorUserId) throw new TeamError(409, "You cannot remove yourself. Ask another administrator.");
  const m = await member(db, organizationId, targetUserId);
  if (!m) throw new TeamError(404, "That person is not a member of your organization.");
  if (m.role_id === "customer_admin" && (await adminCount(db, organizationId)) <= 1) throw new TeamError(409, "Your organization must keep at least one administrator.");
  await db.prepare(`DELETE FROM memberships WHERE id = ? AND organization_id = ?`).bind(m.id, organizationId).run();
  // Memberships are read on every request, so access ends at once; sessions are revoked as well so the person is signed out everywhere.
  await revokeAllSessions(db, targetUserId, null, actorUserId);
  await audit(db, { actorUserId, action: "customer.member_removed", subjectType: "user", subjectId: targetUserId, organizationId, details: { email: m.email, role: m.role_id } });
  return m;
}

export async function revokeCustomerInvitation(db: Db, actorUserId: string, organizationId: string, invitationId: string) {
  const at = nowIso();
  const res = await db.prepare(`UPDATE invitations SET expires_at = ? WHERE id = ? AND organization_id = ? AND accepted_at IS NULL AND expires_at > ? AND role_id IN ('customer_admin','customer_member')`)
    .bind(at, invitationId, organizationId, at).run();
  if (res.meta.changes !== 1) throw new TeamError(404, "That invitation is not pending for your organization.");
  await audit(db, { actorUserId, action: "customer.invitation_revoked", subjectType: "invitation", subjectId: invitationId, organizationId });
}
