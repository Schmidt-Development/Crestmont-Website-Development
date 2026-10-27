// Customer ↔ team project messaging with attachments, read status and notifications (PORTAL-005).
// Internal notes (internal = 1) are staff-only and are filtered out of every customer query.
import type { AppContext } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { storeUpload } from "./files.ts";
import { notifyCustomer, notifyProjectTeam, notify, customerMembers } from "./notifications.ts";
import { sendMail } from "./mailer.ts";
import { HttpError } from "../app/http.ts";

export interface MessageRow {
  id: string; organization_id: string; project_id: string | null; author_user_id: string; author_name: string; author_is_staff: number;
  body: string; attachment_file_id: string | null; attachment_name: string | null; internal: number; created_at: string; read_by_me: number; read_by_other_side: number;
}

const STAFF_ROLE_SQL = `('owner','administrator','sales','developer','project_manager','support')`;

/** Thread for a project, oldest first. Customers never see internal notes. */
export async function listThread(db: Db, viewer: { userId: string; organizationId: string; staff: boolean }, projectId: string | null): Promise<MessageRow[]> {
  const sql = `SELECT m.id, m.organization_id, m.project_id, m.author_user_id, u.display_name AS author_name,
      EXISTS (SELECT 1 FROM memberships mm WHERE mm.user_id = m.author_user_id AND mm.role_id IN ${STAFF_ROLE_SQL}) AS author_is_staff,
      m.body, m.attachment_file_id, f.filename AS attachment_name, m.internal, m.created_at,
      EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?) AS read_by_me,
      EXISTS (SELECT 1 FROM message_reads r JOIN memberships rm ON rm.user_id = r.user_id WHERE r.message_id = m.id AND r.user_id <> m.author_user_id
              AND ((rm.role_id IN ${STAFF_ROLE_SQL}) <> EXISTS (SELECT 1 FROM memberships am WHERE am.user_id = m.author_user_id AND am.role_id IN ${STAFF_ROLE_SQL})))
        AS read_by_other_side
    FROM messages m JOIN users u ON u.id = m.author_user_id LEFT JOIN files f ON f.id = m.attachment_file_id AND f.deleted_at IS NULL
    WHERE m.organization_id = ? AND ${projectId ? "m.project_id = ?" : "m.project_id IS NULL"} ${viewer.staff ? "" : "AND m.internal = 0"}
    ORDER BY m.created_at ASC, m.rowid ASC LIMIT 500`;
  const binds: unknown[] = [viewer.userId, viewer.organizationId];
  if (projectId) binds.push(projectId);
  return (await db.prepare(sql).bind(...binds).all<MessageRow>()).results;
}

export async function markThreadRead(db: Db, userId: string, organizationId: string, projectId: string | null, staff: boolean): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at)
                    SELECT m.id, ?, ? FROM messages m WHERE m.organization_id = ? AND ${projectId ? "m.project_id = ?" : "m.project_id IS NULL"} AND m.author_user_id <> ? ${staff ? "" : "AND m.internal = 0"}`)
    .bind(...[userId, nowIso(), organizationId, ...(projectId ? [projectId] : []), userId]).run();
}

export async function unreadCountForCustomer(db: Db, userId: string, organizationId: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.organization_id = ? AND m.internal = 0 AND m.author_user_id <> ?
                            AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?)`).bind(organizationId, userId, userId).first<{ n: number }>())?.n ?? 0;
}

/** Unread customer-authored messages on projects visible to this staff member. */
export async function unreadCountForStaff(db: Db, userId: string, projectIds: string[] | "all"): Promise<number> {
  const scope = projectIds === "all" ? "" : projectIds.length ? `AND m.project_id IN (${projectIds.map(() => "?").join(",")})` : "AND 0";
  return (await db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.internal = 0 AND m.author_user_id <> ?
      AND NOT EXISTS (SELECT 1 FROM memberships mm WHERE mm.user_id = m.author_user_id AND mm.role_id IN ${STAFF_ROLE_SQL})
      AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?) ${scope}`)
    .bind(userId, userId, ...(projectIds === "all" ? [] : projectIds)).first<{ n: number }>())?.n ?? 0;
}

export class MessageError extends Error {}

export async function postMessage(ctx: AppContext, input: {
  organizationId: string; projectId: string | null; authorUserId: string; body: string; attachment?: File | null; internal?: boolean; fromStaff: boolean;
}): Promise<string> {
  const body = input.body.trim();
  if (body.length < 1) throw new MessageError("Write a message before sending.");
  if (body.length > 10_000) throw new MessageError("Messages are limited to 10,000 characters.");
  if (input.internal && !input.fromStaff) throw new HttpError(403, "Only staff can write internal notes.");
  let attachmentId: string | null = null;
  if (input.attachment && input.attachment.size > 0) {
    try {
      attachmentId = (await storeUpload(ctx, { organizationId: input.organizationId, projectId: input.projectId, file: input.attachment, uploadedBy: input.authorUserId, folder: "Message attachments" })).id;
    } catch (e) { throw new MessageError((e as Error).message); }
  }
  const id = newId("msg");
  const at = nowIso();
  await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO messages (id, organization_id, project_id, author_user_id, body, attachment_file_id, internal, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(id, input.organizationId, input.projectId, input.authorUserId, body, attachmentId, input.internal ? 1 : 0, at),
    ctx.db.prepare(`INSERT INTO message_reads (message_id, user_id, read_at) VALUES (?,?,?)`).bind(id, input.authorUserId, at),
    ...(!input.fromStaff && input.projectId ? [ctx.db.prepare(`UPDATE projects SET last_customer_activity_at = ? WHERE id = ? AND organization_id = ?`).bind(at, input.projectId, input.organizationId)] : []),
  ]);
  await audit(ctx.db, { actorUserId: input.authorUserId, action: input.internal ? "message.internal_note" : "message.posted", subjectType: "message", subjectId: id, organizationId: input.organizationId, details: { projectId: input.projectId, attachment: !!attachmentId } });
  if (!input.internal && !input.projectId) await notifyGeneral(ctx, input.organizationId, id, body, input.fromStaff, input.authorUserId);
  if (!input.internal && input.projectId) {
    const preview = body.length > 160 ? body.slice(0, 157) + "…" : body;
    if (input.fromStaff) {
      await notifyCustomer(ctx, input.projectId, { kind: "message", template: "project_update", subject: "New message from your Crestmont team", body: preview, path: `/portal/projects/${input.projectId}/messages`, key: `msg:${id}`, exceptUserId: input.authorUserId });
    } else {
      await notifyProjectTeam(ctx, input.projectId, { kind: "message", template: "project_update", subject: "New customer message", body: preview, path: `/staff/projects/${input.projectId}?tab=messages`, key: `msg:${id}`, exceptUserId: input.authorUserId });
    }
  }
  return id;
}

// ───────────── General (non-project) conversations ─────────────
// One thread per customer organization with project_id NULL: questions that are not about a specific
// project. Customers see only their own organization's thread (scoped by requireCustomerOrg); staff with
// customers.read can read and reply to any organization's thread.

/** Staff who answer general conversations: support and owners, plus PMs of the organization's active projects. */
export async function generalConversationStaff(db: Db, organizationId: string): Promise<{ id: string; email: string; display_name: string }[]> {
  return (await db.prepare(`SELECT DISTINCT u.id, u.email, u.display_name FROM users u WHERE u.disabled_at IS NULL AND (
      u.id IN (SELECT user_id FROM memberships WHERE role_id IN ('owner','support'))
      OR u.id IN (SELECT project_manager_id FROM projects WHERE organization_id = ? AND status NOT IN ('completed','cancelled') AND project_manager_id IS NOT NULL))
    ORDER BY u.display_name`).bind(organizationId).all<{ id: string; email: string; display_name: string }>()).results;
}

async function notifyGeneral(ctx: AppContext, organizationId: string, messageId: string, body: string, fromStaff: boolean, authorUserId: string): Promise<void> {
  const preview = body.length > 160 ? body.slice(0, 157) + "…" : body;
  const org = await ctx.db.prepare(`SELECT name FROM organizations WHERE id = ?`).bind(organizationId).first<{ name: string }>();
  const people = fromStaff ? await customerMembers(ctx.db, organizationId) : await generalConversationStaff(ctx.db, organizationId);
  const subject = fromStaff ? "New message from Crestmont" : `New general message from ${org?.name ?? "a customer"}`;
  const path = fromStaff ? "/portal/messages/general" : `/staff/conversations/${organizationId}`;
  for (const u of people) {
    if (u.id === authorUserId) continue;
    await notify(ctx.db, u.id, { kind: "message", subjectType: "conversation", subjectId: organizationId, body: fromStaff ? `New message from Crestmont: ${preview}` : `${org?.name ?? "Customer"}: ${preview}` });
    await sendMail(ctx, { template: "project_update", to: u.email, subject, heading: subject, paragraphs: [preview],
      cta: { label: fromStaff ? "Open your portal" : "Open conversation", url: `${ctx.baseUrl}${path}` }, idempotencyKey: `msg:${messageId}:${u.id}` });
  }
}

/** Organizations with a general conversation (or every customer org when `all`), newest activity first, with unread counts for this staff user. */
export async function listGeneralConversations(db: Db, staffUserId: string, opts: { q?: string; limit?: number } = {}) {
  const like = opts.q ? `%${opts.q.replace(/[\\%_]/g, (m) => "\\" + m)}%` : null;
  return (await db.prepare(`SELECT o.id, o.name,
      (SELECT COUNT(*) FROM messages m WHERE m.organization_id = o.id AND m.project_id IS NULL AND m.internal = 0) AS total,
      (SELECT COUNT(*) FROM messages m WHERE m.organization_id = o.id AND m.project_id IS NULL AND m.internal = 0 AND m.author_user_id <> ?
         AND NOT EXISTS (SELECT 1 FROM memberships mm WHERE mm.user_id = m.author_user_id AND mm.role_id IN ${STAFF_ROLE_SQL})
         AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?)) AS unread,
      (SELECT MAX(created_at) FROM messages m WHERE m.organization_id = o.id AND m.project_id IS NULL) AS last_at
    FROM organizations o WHERE o.kind = 'customer' ${like ? `AND o.name LIKE ? ESCAPE '\\'` : ""}
      AND (${like ? "1=1" : "EXISTS (SELECT 1 FROM messages m WHERE m.organization_id = o.id AND m.project_id IS NULL)"})
    ORDER BY COALESCE(last_at, '') DESC, o.name LIMIT ?`).bind(staffUserId, staffUserId, ...(like ? [like] : []), opts.limit ?? 100)
    .all<{ id: string; name: string; total: number; unread: number; last_at: string | null }>()).results;
}

export async function generalUnreadForStaff(db: Db, staffUserId: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.project_id IS NULL AND m.internal = 0 AND m.author_user_id <> ?
      AND NOT EXISTS (SELECT 1 FROM memberships mm WHERE mm.user_id = m.author_user_id AND mm.role_id IN ${STAFF_ROLE_SQL})
      AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?)`).bind(staffUserId, staffUserId).first<{ n: number }>())?.n ?? 0;
}
