// Privacy requests (SEC-006, §66): self-service data export and deletion requests.
//
// Export: generated on demand for the signed-in user only. It contains the user's own profile,
// memberships, sessions metadata and — for CUSTOMER organizations the user belongs to — that
// organization's projects, messages, tickets, orders and invoice metadata. It never contains
// password hashes, MFA secrets, token hashes, internal staff notes or other organizations' data.
// Internal (Crestmont staff) organization data is excluded: it belongs to the business.
//
// Deletion: a request row is created; staff process it. Completion anonymises the user record
// (name, email, credentials), removes memberships and notifications, anonymises CRM contacts linked
// to the user, and revokes every session. Financial and contractual records (orders, invoices,
// payments, refunds, agreement acceptances, audit logs) are retained as legally required; they
// then reference an anonymised user id rather than a name or email.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { revokeAllSessions } from "./auth.ts";
import { holdBlockingUser } from "./legal-holds.ts";

export class PrivacyError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export interface PrivacyRequestRow { id: string; user_id: string; kind: "export" | "deletion"; status: string; created_at: string; completed_at: string | null; processed_by: string | null; notes: string | null }

export async function listOwnRequests(db: Db, userId: string): Promise<PrivacyRequestRow[]> {
  return (await db.prepare(`SELECT id, user_id, kind, status, created_at, completed_at, processed_by, notes FROM privacy_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).bind(userId).all<PrivacyRequestRow>()).results;
}

/** Customer organizations the user belongs to (never the internal organization). */
async function customerOrgIds(db: Db, userId: string): Promise<string[]> {
  return (await db.prepare(`SELECT m.organization_id FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? AND o.kind = 'customer'`).bind(userId).all<{ organization_id: string }>()).results.map((r) => r.organization_id);
}

export async function buildExport(db: Db, userId: string): Promise<Record<string, unknown>> {
  const profile = await db.prepare(`SELECT id, email, display_name, email_verified_at, mfa_enabled, created_at FROM users WHERE id = ?`).bind(userId).first();
  if (!profile) throw new PrivacyError("Account not found.", 404);
  const memberships = (await db.prepare(`SELECT o.id AS organization_id, o.name AS organization_name, o.kind, m.role_id, m.created_at FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ?`).bind(userId).all()).results;
  const sessions = (await db.prepare(`SELECT created_at, expires_at, revoked_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`).bind(userId).all()).results;
  const contacts = (await db.prepare(`SELECT id, name, email, phone, created_at FROM contacts WHERE user_id = ?`).bind(userId).all()).results;
  const acceptances = (await db.prepare(`SELECT a.kind, a.version, x.accepted_at FROM agreement_acceptances x JOIN agreements a ON a.id = x.agreement_id WHERE x.user_id = ?`).bind(userId).all()).results;
  const requests = (await db.prepare(`SELECT kind, status, created_at, completed_at FROM privacy_requests WHERE user_id = ?`).bind(userId).all()).results;
  const orgs: Record<string, unknown>[] = [];
  for (const orgId of await customerOrgIds(db, userId)) {
    const q = async (sql: string) => (await db.prepare(sql).bind(orgId).all()).results;
    orgs.push({
      organization: await db.prepare(`SELECT id, name, created_at FROM organizations WHERE id = ?`).bind(orgId).first(),
      projects: await q(`SELECT id, name, status, payment_schedule, live_url, created_at, updated_at FROM projects WHERE organization_id = ?`),
      // Staff internal notes (messages.internal = 1) are excluded, as everywhere else customers read messages.
      messages: await q(`SELECT m.id, m.project_id, m.body, m.created_at, u.display_name AS author FROM messages m JOIN users u ON u.id = m.author_user_id WHERE m.organization_id = ? AND m.internal = 0 ORDER BY m.created_at`),
      tickets: await q(`SELECT id, subject, category, priority, status, created_at, resolved_at FROM tickets WHERE organization_id = ?`),
      // Internal staff notes (internal = 1) are excluded.
      ticketMessages: await q(`SELECT tm.ticket_id, tm.body, tm.created_at FROM ticket_messages tm JOIN tickets t ON t.id = tm.ticket_id WHERE t.organization_id = ? AND tm.internal = 0 ORDER BY tm.created_at`),
      orders: await q(`SELECT id, total_cents, status, created_at FROM orders WHERE organization_id = ?`),
      invoices: await q(`SELECT id, amount_cents, status, milestone_kind, due_at, paid_at, created_at FROM invoices WHERE organization_id = ?`),
      files: await q(`SELECT id, filename, content_type, size_bytes, created_at FROM files WHERE organization_id = ? AND deleted_at IS NULL`),
    });
  }
  await audit(db, { actorUserId: userId, action: "privacy.export_generated", subjectType: "user", subjectId: userId });
  await db.prepare(`INSERT INTO privacy_requests (id, user_id, kind, status, created_at, completed_at, notes) VALUES (?,?,'export','completed',?,?, 'Self-service download')`)
    .bind(newId("prv"), userId, nowIso(), nowIso()).run();
  return {
    generatedAt: nowIso(),
    notice: "Personal data export from Crestmont Website Development. File contents (uploaded documents) are listed by name; download them from the portal. Password hashes, MFA secrets and internal staff notes are not included.",
    profile, memberships, sessions, crmContacts: contacts, agreementAcceptances: acceptances, privacyRequests: requests, customerOrganizations: orgs,
  };
}

export async function requestDeletion(db: Db, userId: string, reason: string): Promise<string> {
  const owner = await db.prepare(`SELECT 1 FROM memberships WHERE user_id = ? AND role_id = 'owner'`).bind(userId).first();
  if (owner) throw new PrivacyError("The Owner account cannot be deleted through a self-service request.", 403);
  const open = await db.prepare(`SELECT id FROM privacy_requests WHERE user_id = ? AND kind = 'deletion' AND status IN ('received','in_progress')`).bind(userId).first<{ id: string }>();
  if (open) throw new PrivacyError("A deletion request is already open for this account.", 409);
  const id = newId("prv");
  await db.prepare(`INSERT INTO privacy_requests (id, user_id, kind, status, created_at, notes) VALUES (?,?,'deletion','received',?,?)`).bind(id, userId, nowIso(), reason.slice(0, 1000) || null).run();
  await audit(db, { actorUserId: userId, action: "privacy.deletion_requested", subjectType: "privacy_request", subjectId: id });
  return id;
}

export async function listDeletionQueue(db: Db) {
  return (await db.prepare(`SELECT p.id, p.user_id, p.kind, p.status, p.created_at, p.completed_at, p.notes, u.email, u.display_name, pb.display_name AS processed_by_name
     FROM privacy_requests p JOIN users u ON u.id = p.user_id LEFT JOIN users pb ON pb.id = p.processed_by
     WHERE p.kind = 'deletion' ORDER BY CASE WHEN p.status IN ('received','in_progress') THEN 0 ELSE 1 END, p.created_at DESC LIMIT 100`).all<PrivacyRequestRow & { email: string; display_name: string; processed_by_name: string | null }>()).results;
}

/** Staff completes (anonymises) or denies a deletion request. */
export async function processDeletion(db: Db, staffUserId: string, requestId: string, decision: "complete" | "deny", notes: string): Promise<void> {
  const r = await db.prepare(`SELECT id, user_id, status FROM privacy_requests WHERE id = ? AND kind = 'deletion'`).bind(requestId).first<{ id: string; user_id: string; status: string }>();
  if (!r) throw new PrivacyError("Request not found.", 404);
  if (!["received", "in_progress"].includes(r.status)) throw new PrivacyError("This request has already been processed.", 409);
  if (r.user_id === staffUserId) throw new PrivacyError("You cannot process your own deletion request.", 403);
  const at = nowIso();
  if (decision === "deny") {
    if (notes.trim().length < 5) throw new PrivacyError("Explain why the request is denied (this is shared with the requester on request).");
    await db.prepare(`UPDATE privacy_requests SET status='denied', completed_at=?, processed_by=?, notes=? WHERE id=?`).bind(at, staffUserId, notes.slice(0, 1000), requestId).run();
    await audit(db, { actorUserId: staffUserId, action: "privacy.deletion_denied", subjectType: "privacy_request", subjectId: requestId });
    return;
  }
  const owner = await db.prepare(`SELECT 1 FROM memberships WHERE user_id = ? AND role_id = 'owner'`).bind(r.user_id).first();
  if (owner) throw new PrivacyError("The Owner account cannot be anonymised through this workflow.", 403);
  // Legal hold (F-25): anonymisation is irreversible, so it waits while data is preserved for a dispute or investigation.
  const held = await holdBlockingUser(db, r.user_id);
  if (held) {
    await audit(db, { actorUserId: staffUserId, action: "privacy.deletion_blocked_by_hold", subjectType: "privacy_request", subjectId: requestId, details: { reason: held } });
    throw new PrivacyError(`${held}, so this account cannot be anonymised yet. Leave the request open, or deny it with the legal reason.`, 409);
  }
  const u = r.user_id;
  const anonEmail = `deleted+${u}@deleted.invalid`;
  await db.batch([
    db.prepare(`UPDATE users SET email = ?, display_name = 'Deleted user', password_hash = NULL, totp_secret = NULL, totp_pending_secret = NULL, mfa_enabled = 0, disabled_at = COALESCE(disabled_at, ?) WHERE id = ?`).bind(anonEmail, at, u),
    db.prepare(`DELETE FROM mfa_recovery_codes WHERE user_id = ?`).bind(u),
    db.prepare(`UPDATE contacts SET name = 'Deleted contact', email = NULL, phone = NULL WHERE user_id = ?`).bind(u),
    db.prepare(`DELETE FROM memberships WHERE user_id = ?`).bind(u),
    db.prepare(`DELETE FROM notifications WHERE user_id = ?`).bind(u),
    db.prepare(`DELETE FROM auth_tokens WHERE user_id = ?`).bind(u),
    db.prepare(`UPDATE sessions SET ip = NULL, user_agent = NULL WHERE user_id = ?`).bind(u),
    db.prepare(`UPDATE privacy_requests SET status='completed', completed_at=?, processed_by=?, notes=COALESCE(?, notes) WHERE id=?`).bind(at, staffUserId, notes.trim() ? notes.slice(0, 1000) : null, requestId),
  ]);
  await revokeAllSessions(db, u, null, staffUserId);
  await audit(db, { actorUserId: staffUserId, action: "privacy.deletion_completed", subjectType: "user", subjectId: u, details: { request: requestId, retained: "financial and contractual records" } });
}
