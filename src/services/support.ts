// Support operating system (SUP-001..005, §32–§33). Every customer query is scoped by the
// organization id returned from requireCustomerOrg; staff actions are permission-checked in the
// route layer and audited here. AI drafts are never sent automatically: a human edits and sends,
// and sensitive tickets require an explicit approval tick that is recorded on the message and job.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { AppContext } from "../app/context.ts";
import { assertTransition, TransitionError } from "../domain/state-machine.ts";
import { sanitizeFilename, validateUpload } from "../adapters/storage.ts";
import { audit } from "./security.ts";
import { sendMail } from "./mailer.ts";
import { notify } from "./notifications.ts";
import { aiProviderFromEnv, decideAiJob, requestAiDraft } from "./ai.ts";
import { toHex } from "../lib/crypto.ts";

export const TICKET_CATEGORIES = ["technical", "billing", "content_change", "account", "refund", "other"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TICKET_STATUSES = ["open", "pending_staff", "pending_customer", "escalated", "resolved", "closed"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Categories where an AI-drafted reply needs explicit human approval before it can be sent (§33). */
export const SENSITIVE_CATEGORIES: readonly TicketCategory[] = ["billing", "refund", "account"];
const SENSITIVE_TEXT = /\b(refund|chargeback|dispute|cancel(l?ation)?|password|invoice|payment)\b/i;

/** Allowed ticket status transitions. Reopening is resolved/closed → open. */
export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ["pending_staff", "pending_customer", "escalated", "resolved", "closed"],
  pending_staff: ["open", "pending_customer", "escalated", "resolved", "closed"],
  pending_customer: ["pending_staff", "escalated", "resolved", "closed"],
  escalated: ["pending_staff", "pending_customer", "resolved", "closed"],
  resolved: ["open", "closed"],
  closed: ["open"],
};
export const ACTIVE_STATUSES: TicketStatus[] = ["open", "pending_staff", "pending_customer", "escalated"];

export class SupportError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}

export interface TicketRow {
  id: string; organization_id: string; project_id: string | null; subject: string; category: TicketCategory; priority: TicketPriority;
  status: TicketStatus; opened_by: string; first_response_at: string | null; resolved_at: string | null; created_at: string; updated_at: string;
  sla_breached_at: string | null; escalated_at: string | null; reopened_at: string | null;
}
export interface TicketMessageRow {
  id: string; ticket_id: string; author_user_id: string | null; body: string; internal: number; ai_draft_job_id: string | null;
  approved_by: string | null; attachment_file_id: string | null; created_at: string;
  author_name: string | null; author_is_staff: number; attachment_name: string | null; attachment_size: number | null; approver_name: string | null;
}

type MailCtx = Pick<AppContext, "db" | "email" | "baseUrl">;
type SettingsCtx = Pick<AppContext, "db" | "settings">;

// ───────────── Settings (SUP-005) ─────────────

export interface SupportSettings { staffedHours: string | null; firstResponseTargetHours: number | null; source: "support_settings" | "business_settings" | "none"; updatedAt: string | null }

export async function getSupportSettings(ctx: SettingsCtx): Promise<SupportSettings> {
  const row = await ctx.db.prepare(`SELECT staffed_hours, first_response_target_hours, updated_at FROM support_settings WHERE id = 1`)
    .first<{ staffed_hours: string; first_response_target_hours: number; updated_at: string }>();
  if (row) return { staffedHours: row.staffed_hours || null, firstResponseTargetHours: row.first_response_target_hours ?? null, source: "support_settings", updatedAt: row.updated_at };
  const hours = ctx.settings["support.staffed_hours"]?.trim() || null;
  const target = parseInt(ctx.settings["support.first_response_target_hours"] ?? "", 10);
  return { staffedHours: hours, firstResponseTargetHours: Number.isFinite(target) && target > 0 ? target : null, source: hours ? "business_settings" : "none", updatedAt: null };
}

export async function saveSupportSettings(db: Db, userId: string, staffedHours: string, targetHours: number): Promise<void> {
  if (staffedHours.trim().length < 3 || staffedHours.length > 300) throw new SupportError("Describe the staffed hours (3–300 characters), e.g. “Mon–Fri 9:00–17:00 Eastern”.");
  if (/24\s*\/\s*7|24 hours|around the clock|round[- ]the[- ]clock/i.test(staffedHours)) {
    // §33: intake is 24/7, but human coverage must not be advertised as 24/7 unless actually staffed.
    throw new SupportError("Staffed hours may not claim 24/7 human coverage. Intake is already 24/7; describe the hours staff actually respond.");
  }
  if (!Number.isInteger(targetHours) || targetHours < 1 || targetHours > 168) throw new SupportError("First-response target must be a whole number of hours between 1 and 168.");
  const at = nowIso();
  await db.prepare(`INSERT INTO support_settings (id, staffed_hours, first_response_target_hours, updated_by, updated_at) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET staffed_hours = excluded.staffed_hours, first_response_target_hours = excluded.first_response_target_hours, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(staffedHours.trim(), targetHours, userId, at).run();
  await audit(db, { actorUserId: userId, action: "support.settings_updated", subjectType: "support_settings", subjectId: "1", details: { staffedHours: staffedHours.trim(), targetHours } });
}

/** Customer-facing wording. Never implies round-the-clock human coverage. */
export function hoursDisclosure(s: SupportSettings): string {
  return s.staffedHours
    ? `You can submit a ticket at any time — intake is open 24/7. Our team responds during staffed hours: ${s.staffedHours}.`
    : "You can submit a ticket at any time — intake is open 24/7. Crestmont has not yet published its staffed support hours; replies come from staff during staffed hours, not around the clock.";
}

// ───────────── Attachments ─────────────

export const MAX_ATTACHMENTS = 5;

export function uploadedFiles(form: FormData, field = "attachments"): File[] {
  return form.getAll(field).filter((v): v is File => typeof v !== "string" && v.size > 0);
}

/** Validates, stores and records a file for the customer organization. Throws SupportError with a user-facing reason. */
export async function storeAttachment(ctx: Pick<AppContext, "db" | "storage">, organizationId: string, userId: string, file: File): Promise<string> {
  if (!ctx.storage) throw new SupportError("Attachments are unavailable: file storage is not configured in this environment.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = sanitizeFilename(file.name || "file");
  const check = validateUpload(name, bytes);
  if (!check.ok) throw new SupportError(`${name}: ${check.reason}`);
  const id = newId("fil");
  const key = `org/${organizationId}/support/${id}/${name}`;
  const digest = toHex(await crypto.subtle.digest("SHA-256", bytes));
  await ctx.storage.put(key, bytes, check.contentType);
  await ctx.db.prepare(`INSERT INTO files (id, organization_id, project_id, r2_key, filename, content_type, size_bytes, sha256, scan_status, folder, uploaded_by, created_at)
    VALUES (?,?,NULL,?,?,?,?,?, 'pending', 'support', ?, ?)`).bind(id, organizationId, key, name, check.contentType, bytes.length, digest, userId, nowIso()).run();
  return id;
}

// ───────────── Queries ─────────────

export async function getTicket(db: Db, id: string): Promise<TicketRow | null> {
  return db.prepare(`SELECT * FROM tickets WHERE id = ?`).bind(id).first<TicketRow>();
}

/** Tenant-scoped lookup: returns null when the ticket belongs to another organization (AUTH-008). */
export async function getTicketForOrg(db: Db, id: string, organizationId: string): Promise<TicketRow | null> {
  return db.prepare(`SELECT * FROM tickets WHERE id = ? AND organization_id = ?`).bind(id, organizationId).first<TicketRow>();
}

export async function ticketMessages(db: Db, ticketId: string, opts: { includeInternal: boolean }): Promise<TicketMessageRow[]> {
  return (await db.prepare(
    `SELECT tm.*, u.display_name AS author_name,
       EXISTS(SELECT 1 FROM memberships m WHERE m.user_id = tm.author_user_id AND m.role_id IN ('owner','administrator','sales','developer','project_manager','support')) AS author_is_staff,
       f.filename AS attachment_name, f.size_bytes AS attachment_size, ap.display_name AS approver_name
     FROM ticket_messages tm LEFT JOIN users u ON u.id = tm.author_user_id LEFT JOIN files f ON f.id = tm.attachment_file_id
     LEFT JOIN users ap ON ap.id = tm.approved_by
     WHERE tm.ticket_id = ? ${opts.includeInternal ? "" : "AND tm.internal = 0"} ORDER BY tm.created_at, tm.rowid`,
  ).bind(ticketId).all<TicketMessageRow>()).results;
}

export async function listOrgTickets(db: Db, organizationId: string, status: "active" | "closed" | "all", limit: number, offset: number) {
  const where = status === "active" ? `AND t.status IN ('open','pending_staff','pending_customer','escalated')` : status === "closed" ? `AND t.status IN ('resolved','closed')` : "";
  return (await db.prepare(
    `SELECT t.*, p.name AS project_name, (SELECT COUNT(*) FROM ticket_messages tm WHERE tm.ticket_id = t.id AND tm.internal = 0) AS message_count
     FROM tickets t LEFT JOIN projects p ON p.id = t.project_id WHERE t.organization_id = ? ${where} ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`,
  ).bind(organizationId, limit + 1, offset).all<TicketRow & { project_name: string | null; message_count: number }>()).results;
}

export interface QueueFilters { status?: string; priority?: string; category?: string; assignee?: string; q?: string; breached?: boolean }

export async function listQueue(db: Db, f: QueueFilters, currentUserId: string, limit: number, offset: number) {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.status === "active" || !f.status) where.push(`t.status IN ('open','pending_staff','pending_customer','escalated')`);
  else if (f.status !== "all" && (TICKET_STATUSES as readonly string[]).includes(f.status)) { where.push(`t.status = ?`); binds.push(f.status); }
  if (f.priority && (TICKET_PRIORITIES as readonly string[]).includes(f.priority)) { where.push(`t.priority = ?`); binds.push(f.priority); }
  if (f.category && (TICKET_CATEGORIES as readonly string[]).includes(f.category)) { where.push(`t.category = ?`); binds.push(f.category); }
  if (f.assignee === "me") { where.push(`a.user_id = ?`); binds.push(currentUserId); }
  else if (f.assignee === "unassigned") where.push(`a.user_id IS NULL`);
  else if (f.assignee && /^[A-Za-z0-9_]{1,64}$/.test(f.assignee)) { where.push(`a.user_id = ?`); binds.push(f.assignee); }
  if (f.breached) where.push(`t.sla_breached_at IS NOT NULL AND t.first_response_at IS NULL`);
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, (c) => "\\" + c).slice(0, 100)}%`;
    where.push(`(t.subject LIKE ? ESCAPE '\\' OR t.id LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\')`);
    binds.push(like, like, like);
  }
  const sql = `SELECT t.*, o.name AS organization_name, a.user_id AS assignee_id, au.display_name AS assignee_name
    FROM tickets t JOIN organizations o ON o.id = t.organization_id
    LEFT JOIN assignments a ON a.subject_type = 'ticket' AND a.subject_id = t.id AND a.ended_at IS NULL
    LEFT JOIN users au ON au.id = a.user_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at ASC LIMIT ? OFFSET ?`;
  return (await db.prepare(sql).bind(...binds, limit + 1, offset).all<TicketRow & { organization_name: string; assignee_id: string | null; assignee_name: string | null }>()).results;
}

export async function queueCounts(db: Db) {
  return (await db.prepare(`SELECT status, COUNT(*) AS n FROM tickets GROUP BY status`).all<{ status: string; n: number }>()).results;
}

export async function currentAssignee(db: Db, ticketId: string) {
  return db.prepare(`SELECT a.user_id, u.display_name, u.email FROM assignments a JOIN users u ON u.id = a.user_id WHERE a.subject_type = 'ticket' AND a.subject_id = ? AND a.ended_at IS NULL ORDER BY a.created_at DESC LIMIT 1`)
    .bind(ticketId).first<{ user_id: string; display_name: string; email: string }>();
}

/** Staff who can work tickets (assignment targets). */
export async function supportAgents(db: Db) {
  return (await db.prepare(`SELECT DISTINCT u.id, u.display_name, u.email FROM users u JOIN memberships m ON m.user_id = u.id
    WHERE m.role_id IN ('owner','support') AND u.disabled_at IS NULL ORDER BY u.display_name`).all<{ id: string; display_name: string; email: string }>()).results;
}

/** Supervisors who receive escalations and SLA reminders. */
async function supervisors(db: Db) {
  return (await db.prepare(`SELECT DISTINCT u.id, u.display_name, u.email FROM users u JOIN memberships m ON m.user_id = u.id
    WHERE m.role_id IN ('owner','administrator','support') AND u.disabled_at IS NULL`).all<{ id: string; display_name: string; email: string }>()).results;
}

export interface ResponseTiming { targetHours: number | null; firstResponseHours: number | null; elapsedHours: number; state: "met" | "breached" | "within" | "no_target" }

export function responseTiming(t: Pick<TicketRow, "created_at" | "first_response_at">, targetHours: number | null, now: Date): ResponseTiming {
  const created = Date.parse(t.created_at);
  const first = t.first_response_at ? Date.parse(t.first_response_at) : null;
  const firstResponseHours = first !== null ? Math.round(((first - created) / 3_600_000) * 10) / 10 : null;
  const elapsedHours = Math.round(((now.getTime() - created) / 3_600_000) * 10) / 10;
  if (targetHours === null) return { targetHours, firstResponseHours, elapsedHours, state: "no_target" };
  if (firstResponseHours !== null) return { targetHours, firstResponseHours, elapsedHours, state: firstResponseHours <= targetHours ? "met" : "breached" };
  return { targetHours, firstResponseHours, elapsedHours, state: elapsedHours > targetHours ? "breached" : "within" };
}

// ───────────── Customer actions (SUP-001) ─────────────

export interface NewTicket { subject: string; category: string; priority?: string; projectId?: string | null; description: string; files: File[] }

export async function createTicket(ctx: Pick<AppContext, "db" | "storage" | "email" | "baseUrl" | "settings">, org: { organizationId: string }, user: { id: string; email: string; displayName: string }, input: NewTicket): Promise<string> {
  const errors: string[] = [];
  const subject = input.subject.trim();
  const description = input.description.trim();
  if (subject.length < 4 || subject.length > 200) errors.push("Subject must be 4–200 characters");
  if (!(TICKET_CATEGORIES as readonly string[]).includes(input.category)) errors.push("Choose a category");
  if (description.length < 10 || description.length > 10_000) errors.push("Describe the issue (10–10,000 characters)");
  if (input.files.length > MAX_ATTACHMENTS) errors.push(`Attach at most ${MAX_ATTACHMENTS} files`);
  if (input.files.length && !ctx.storage) errors.push("Attachments are unavailable: file storage is not configured in this environment.");
  let projectId: string | null = null;
  if (input.projectId) {
    const p = await ctx.db.prepare(`SELECT id FROM projects WHERE id = ? AND organization_id = ?`).bind(input.projectId, org.organizationId).first<{ id: string }>();
    if (!p) errors.push("Choose one of your projects");
    else projectId = p.id;
  }
  if (errors.length) throw new SupportError(errors.join(". "));
  // Validate every attachment before writing anything, so a bad file never leaves a half-created ticket.
  for (const f of input.files) {
    const check = validateUpload(sanitizeFilename(f.name || "file"), new Uint8Array(await f.arrayBuffer()));
    if (!check.ok) throw new SupportError(`${sanitizeFilename(f.name || "file")}: ${check.reason}`);
  }
  const id = newId("tkt");
  const at = nowIso();
  const priority = input.category === "refund" || input.category === "billing" ? "high" : "normal";
  await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO tickets (id, organization_id, project_id, subject, category, priority, status, opened_by, created_at, updated_at) VALUES (?,?,?,?,?,?, 'open', ?, ?, ?)`)
      .bind(id, org.organizationId, projectId, subject, input.category, priority, user.id, at, at),
    ctx.db.prepare(`INSERT INTO ticket_messages (id, ticket_id, author_user_id, body, internal, created_at) VALUES (?,?,?,?,0,?)`).bind(newId("tm"), id, user.id, description, at),
  ]);
  for (const f of input.files) {
    const fileId = await storeAttachment(ctx, org.organizationId, user.id, f);
    await ctx.db.prepare(`INSERT INTO ticket_messages (id, ticket_id, author_user_id, body, internal, attachment_file_id, created_at) VALUES (?,?,?,?,0,?,?)`)
      .bind(newId("tm"), id, user.id, `Attached ${sanitizeFilename(f.name || "file")}`, fileId, nowIso()).run();
  }
  await audit(ctx.db, { actorUserId: user.id, action: "ticket.created", subjectType: "ticket", subjectId: id, organizationId: org.organizationId, details: { category: input.category, attachments: input.files.length } });
  const settings = await getSupportSettings(ctx);
  await sendMail(ctx, { template: "support_ticket", to: user.email, subject: `We received your request — ${subject}`, heading: "Your support request is recorded",
    paragraphs: [`Hello ${user.displayName}, we have recorded your request “${subject}” (reference ${id}).`, hoursDisclosure(settings)],
    cta: { label: "View your ticket", url: `${ctx.baseUrl}/portal/support/${id}` }, idempotencyKey: `ticket-confirm:${id}` });
  for (const s of await supportAgents(ctx.db)) await notify(ctx.db, s.id, { kind: "ticket_new", subjectType: "ticket", subjectId: id, body: `New ${input.category.replace("_", " ")} ticket: ${subject}` });
  return id;
}

export async function customerReply(ctx: Pick<AppContext, "db" | "storage" | "email" | "baseUrl">, ticket: TicketRow, userId: string, body: string, files: File[]): Promise<void> {
  if (ticket.status === "resolved" || ticket.status === "closed") throw new SupportError("This ticket is resolved. Reopen it to reply.", 409);
  const text = body.trim();
  if (text.length < 1 && !files.length) throw new SupportError("Write a reply or attach a file");
  if (text.length > 10_000) throw new SupportError("Reply is too long (10,000 characters maximum)");
  if (files.length > MAX_ATTACHMENTS) throw new SupportError(`Attach at most ${MAX_ATTACHMENTS} files`);
  if (files.length && !ctx.storage) throw new SupportError("Attachments are unavailable: file storage is not configured in this environment.");
  for (const f of files) {
    const check = validateUpload(sanitizeFilename(f.name || "file"), new Uint8Array(await f.arrayBuffer()));
    if (!check.ok) throw new SupportError(`${sanitizeFilename(f.name || "file")}: ${check.reason}`);
  }
  const at = nowIso();
  if (text) await ctx.db.prepare(`INSERT INTO ticket_messages (id, ticket_id, author_user_id, body, internal, created_at) VALUES (?,?,?,?,0,?)`).bind(newId("tm"), ticket.id, userId, text, at).run();
  for (const f of files) {
    const fileId = await storeAttachment(ctx, ticket.organization_id, userId, f);
    await ctx.db.prepare(`INSERT INTO ticket_messages (id, ticket_id, author_user_id, body, internal, attachment_file_id, created_at) VALUES (?,?,?,?,0,?,?)`)
      .bind(newId("tm"), ticket.id, userId, `Attached ${sanitizeFilename(f.name || "file")}`, fileId, nowIso()).run();
  }
  const next: TicketStatus = ticket.status === "escalated" ? "escalated" : "pending_staff";
  await ctx.db.prepare(`UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?`).bind(next, at, ticket.id).run();
  await audit(ctx.db, { actorUserId: userId, action: "ticket.customer_reply", subjectType: "ticket", subjectId: ticket.id, organizationId: ticket.organization_id });
  await notifyStaffOfActivity(ctx, ticket, `Customer replied on “${ticket.subject}”`, `cust-reply:${ticket.id}:${at}`);
}

async function notifyStaffOfActivity(ctx: MailCtx, ticket: TicketRow, text: string, key: string) {
  const a = await currentAssignee(ctx.db, ticket.id);
  const people = a ? [{ id: a.user_id, email: a.email }] : (await supportAgents(ctx.db)).map((s) => ({ id: s.id, email: s.email }));
  for (const p of people) {
    await notify(ctx.db, p.id, { kind: "ticket_activity", subjectType: "ticket", subjectId: ticket.id, body: text });
    if (a) await sendMail(ctx, { template: "support_reply", to: p.email, subject: text, heading: text, paragraphs: ["Open the ticket in the staff support queue to respond."],
      cta: { label: "Open ticket", url: `${ctx.baseUrl}/staff/support/${ticket.id}` }, idempotencyKey: `${key}:${p.id}` });
  }
}

export async function reopenTicket(ctx: MailCtx, ticket: TicketRow, userId: string, by: "customer" | "staff"): Promise<void> {
  if (by === "customer" && ticket.status !== "resolved") throw new SupportError(ticket.status === "closed" ? "Closed tickets cannot be reopened. Please open a new ticket." : "Only resolved tickets can be reopened.", 409);
  await changeStatus(ctx, ticket, "open", userId);
  await ctx.db.prepare(`UPDATE tickets SET reopened_at = ?, resolved_at = NULL WHERE id = ?`).bind(nowIso(), ticket.id).run();
  if (by === "customer") await notifyStaffOfActivity(ctx, ticket, `Customer reopened “${ticket.subject}”`, `reopen:${ticket.id}:${nowIso()}`);
}

// ───────────── Staff actions (SUP-002..004) ─────────────

export async function changeStatus(ctx: Pick<AppContext, "db">, ticket: TicketRow, to: TicketStatus, userId: string): Promise<void> {
  if (!(TICKET_STATUSES as readonly string[]).includes(to)) throw new SupportError("Unknown status");
  if (ticket.status === to) return;
  try { assertTransition(TICKET_TRANSITIONS, ticket.status, to); } catch (e) {
    if (e instanceof TransitionError) throw new SupportError(`A ticket cannot move from ${ticket.status.replace("_", " ")} to ${to.replace("_", " ")}.`, 409);
    throw e;
  }
  const at = nowIso();
  const res = await ctx.db.prepare(`UPDATE tickets SET status = ?, updated_at = ?,
      resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END,
      escalated_at = CASE WHEN ? = 'escalated' THEN ? ELSE escalated_at END
    WHERE id = ? AND status = ?`).bind(to, at, to, at, to, at, ticket.id, ticket.status).run();
  if (res.meta.changes !== 1) throw new SupportError("The ticket changed while you were editing. Reload and try again.", 409);
  await audit(ctx.db, { actorUserId: userId, action: "ticket.status_changed", subjectType: "ticket", subjectId: ticket.id, organizationId: ticket.organization_id, details: { from: ticket.status, to } });
  ticket.status = to;
}

export async function escalateTicket(ctx: MailCtx, ticket: TicketRow, userId: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new SupportError("Give a reason for the escalation (at least 5 characters)");
  await changeStatus(ctx, ticket, "escalated", userId);
  await ctx.db.prepare(`INSERT INTO ticket_messages (id, ticket_id, author_user_id, body, internal, created_at) VALUES (?,?,?,?,1,?)`)
    .bind(newId("tm"), ticket.id, userId, `Escalated: ${reason.trim().slice(0, 2000)}`, nowIso()).run();
  for (const s of await supervisors(ctx.db)) {
    if (s.id === userId) continue;
    await notify(ctx.db, s.id, { kind: "ticket_escalated", subjectType: "ticket", subjectId: ticket.id, body: `Escalated: ${ticket.subject}` });
    await sendMail(ctx, { template: "support_ticket", to: s.email, subject: `Escalated ticket — ${ticket.subject}`, heading: "A support ticket was escalated",
      paragraphs: [`Ticket ${ticket.id} (“${ticket.subject}”) was escalated. Open it in the staff queue for details.`],
      cta: { label: "Open ticket", url: `${ctx.baseUrl}/staff/support/${ticket.id}` }, idempotencyKey: `escalate:${ticket.id}:${s.id}:${ticket.updated_at}` });
  }
}

export async function assignTicket(ctx: MailCtx, ticket: TicketRow, assigneeId: string, byUserId: string): Promise<void> {
  const agent = (await supportAgents(ctx.db)).find((a) => a.id === assigneeId);
  if (!agent) throw new SupportError("Choose a support team member");
  const current = await currentAssignee(ctx.db, ticket.id);
  if (current?.user_id === assigneeId) return;
  const at = nowIso();
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE assignments SET ended_at = ? WHERE subject_type = 'ticket' AND subject_id = ? AND ended_at IS NULL`).bind(at, ticket.id),
    ctx.db.prepare(`INSERT INTO assignments (id, subject_type, subject_id, user_id, assigned_by, created_at) VALUES (?, 'ticket', ?, ?, ?, ?)`).bind(newId("asg"), ticket.id, assigneeId, byUserId, at),
    ctx.db.prepare(`UPDATE tickets SET updated_at = ? WHERE id = ?`).bind(at, ticket.id),
  ]);
  await audit(ctx.db, { actorUserId: byUserId, action: "ticket.assigned", subjectType: "ticket", subjectId: ticket.id, organizationId: ticket.organization_id, details: { assigneeId, previous: current?.user_id ?? null } });
  if (assigneeId !== byUserId) {
    await notify(ctx.db, assigneeId, { kind: "ticket_assigned", subjectType: "ticket", subjectId: ticket.id, body: `Assigned to you: ${ticket.subject}` });
    await sendMail(ctx, { template: "support_ticket", to: agent.email, subject: `Ticket assigned to you — ${ticket.subject}`, heading: "A support ticket was assigned to you",
      paragraphs: [`Ticket ${ticket.id} (“${ticket.subject}”, ${ticket.priority} priority) is now assigned to you.`],
      cta: { label: "Open ticket", url: `${ctx.baseUrl}/staff/support/${ticket.id}` }, idempotencyKey: `assign:${ticket.id}:${assigneeId}:${at}` });
  }
}

export async function updateTriage(db: Db, ticket: TicketRow, userId: string, priority: string, category: string): Promise<void> {
  if (!(TICKET_PRIORITIES as readonly string[]).includes(priority)) throw new SupportError("Choose a priority");
  if (!(TICKET_CATEGORIES as readonly string[]).includes(category)) throw new SupportError("Choose a category");
  if (priority === ticket.priority && category === ticket.category) return;
  await db.prepare(`UPDATE tickets SET priority = ?, category = ?, updated_at = ? WHERE id = ?`).bind(priority, category, nowIso(), ticket.id).run();
  await audit(db, { actorUserId: userId, action: "ticket.triaged", subjectType: "ticket", subjectId: ticket.id, organizationId: ticket.organization_id,
    details: { from: { priority: ticket.priority, category: ticket.category }, to: { priority, category } } });
}

export async function addInternalNote(db: Db, ticket: TicketRow, userId: string, body: string): Promise<void> {
  const text = body.trim();
  if (text.length < 1 || text.length > 10_000) throw new SupportError("Write the note (up to 10,000 characters)");
  await db.prepare(`INSERT INTO ticket_messages (id, ticket_id, author_user_id, body, internal, created_at) VALUES (?,?,?,?,1,?)`).bind(newId("tm"), ticket.id, userId, text, nowIso()).run();
  await audit(db, { actorUserId: userId, action: "ticket.internal_note", subjectType: "ticket", subjectId: ticket.id, organizationId: ticket.organization_id });
}

export function isSensitive(ticket: Pick<TicketRow, "category">, text = ""): boolean {
  return SENSITIVE_CATEGORIES.includes(ticket.category) || SENSITIVE_TEXT.test(text);
}

export interface StaffReply { body: string; aiJobId?: string | null; approveSensitive?: boolean; thenStatus?: string; file?: File | null }

/** Sends a reply visible to the customer. AI-drafted text is only ever sent here, by a human. */
export async function staffReply(ctx: Pick<AppContext, "db" | "storage" | "email" | "baseUrl">, ticket: TicketRow, user: { id: string }, r: StaffReply): Promise<{ messageId: string }> {
  const text = r.body.trim();
  if (text.length < 1 || text.length > 10_000) throw new SupportError("Write the reply (up to 10,000 characters)");
  if (ticket.status === "closed") throw new SupportError("Reopen the ticket before replying.", 409);
  let approvedBy: string | null = null;
  if (r.aiJobId) {
    const job = await ctx.db.prepare(`SELECT id, status, input_ref, workflow FROM ai_jobs WHERE id = ?`).bind(r.aiJobId).first<{ id: string; status: string; input_ref: string; workflow: string }>();
    if (!job || job.workflow !== "support_reply" || job.input_ref !== `ticket:${ticket.id}`) throw new SupportError("That AI draft does not belong to this ticket.", 400);
    if (job.status !== "awaiting_approval") throw new SupportError("That AI draft was already used or discarded. Request a new draft.", 409);
    if (isSensitive(ticket, text) && !r.approveSensitive) {
      throw new SupportError("This is a sensitive ticket (billing, refund or account). Review the AI-drafted reply and tick “I approve this AI-assisted reply” before sending.", 422);
    }
    approvedBy = user.id;
  }
  let fileId: string | null = null;
  if (r.file) fileId = await storeAttachment(ctx, ticket.organization_id, user.id, r.file);
  if (r.aiJobId) await decideAiJob(ctx.db, r.aiJobId, user.id, "approved", text);
  const id = newId("tm");
  const at = nowIso();
  await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO ticket_messages (id, ticket_id, author_user_id, body, internal, ai_draft_job_id, approved_by, attachment_file_id, created_at) VALUES (?,?,?,?,0,?,?,?,?)`)
      .bind(id, ticket.id, user.id, text, r.aiJobId ?? null, approvedBy, fileId, at),
    ctx.db.prepare(`UPDATE tickets SET first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ?`).bind(at, at, ticket.id),
  ]);
  await audit(ctx.db, { actorUserId: user.id, action: "ticket.staff_reply", subjectType: "ticket", subjectId: ticket.id, organizationId: ticket.organization_id,
    details: { aiJobId: r.aiJobId ?? null, approvedSensitive: !!approvedBy && isSensitive(ticket, text) } });
  const then = r.thenStatus && r.thenStatus !== "keep" ? r.thenStatus : ticket.status === "escalated" ? "escalated" : "pending_customer";
  if (then !== ticket.status) await changeStatus(ctx, ticket, then as TicketStatus, user.id);
  const opener = await ctx.db.prepare(`SELECT u.id, u.email, u.display_name FROM users u WHERE u.id = ? AND u.disabled_at IS NULL`).bind(ticket.opened_by).first<{ id: string; email: string; display_name: string }>();
  if (opener) {
    await notify(ctx.db, opener.id, { kind: "ticket_reply", subjectType: "ticket", subjectId: ticket.id, body: `Crestmont replied to “${ticket.subject}”` });
    await sendMail(ctx, { template: "support_reply", to: opener.email, subject: `Update on your request — ${ticket.subject}`, heading: "There is an update on your support request",
      paragraphs: [`Hello ${opener.display_name}, a member of the Crestmont team replied to “${ticket.subject}”. Sign in to read the reply and respond.`],
      cta: { label: "Read the reply", url: `${ctx.baseUrl}/portal/support/${ticket.id}` }, idempotencyKey: `ticket-reply:${id}` });
  }
  return { messageId: id };
}

/** Requests an AI draft. Nothing is sent; the draft is returned for a human to edit. */
export async function draftReply(ctx: Pick<AppContext, "db" | "env">, ticket: TicketRow, userId: string) {
  const msgs = await ticketMessages(ctx.db, ticket.id, { includeInternal: false });
  const thread = msgs.slice(-12).map((m) => `${m.author_is_staff ? "Crestmont" : "Customer"}: ${m.body}`).join("\n\n");
  const prompt = `Draft a reply from Crestmont Website Development support to the customer below.\nTicket subject: ${ticket.subject}\nCategory: ${ticket.category}\n\nConversation (oldest first):\n${thread}\n\nWrite only the reply body. Be courteous and specific; if information is missing, ask for it.`;
  const res = await requestAiDraft(ctx.db, aiProviderFromEnv(ctx.env), { workflow: "support_reply", inputRef: `ticket:${ticket.id}`, prompt, requestedBy: userId });
  await audit(ctx.db, { actorUserId: userId, action: "ticket.ai_draft_requested", subjectType: "ticket", subjectId: ticket.id, organizationId: ticket.organization_id, details: { jobId: res.jobId, status: res.status } });
  return res;
}

export async function discardDraft(db: Db, ticket: TicketRow, jobId: string, userId: string): Promise<void> {
  const job = await db.prepare(`SELECT input_ref FROM ai_jobs WHERE id = ? AND workflow = 'support_reply'`).bind(jobId).first<{ input_ref: string }>();
  if (!job || job.input_ref !== `ticket:${ticket.id}`) throw new SupportError("That AI draft does not belong to this ticket.", 400);
  try { await decideAiJob(db, jobId, userId, "rejected"); } catch { throw new SupportError("That AI draft was already used or discarded.", 409); }
}

export async function pendingDraft(db: Db, ticketId: string, jobId: string | null) {
  if (!jobId) return null;
  return db.prepare(`SELECT id, output_ref, provider, model, created_at FROM ai_jobs WHERE id = ? AND workflow = 'support_reply' AND input_ref = ? AND status = 'awaiting_approval'`)
    .bind(jobId, `ticket:${ticketId}`).first<{ id: string; output_ref: string; provider: string; model: string; created_at: string }>();
}

// ───────────── Escalation sweep (SUP-003) ─────────────

/**
 * Flags active tickets that have had no staff response within the first-response target and
 * reminds the assignee (or support supervisors). Idempotent: each ticket is flagged and reminded once.
 */
export async function runSupportEscalationSweep(ctx: Pick<AppContext, "db" | "email" | "baseUrl" | "settings" | "now">): Promise<{ flagged: number; checked: number; targetHours: number | null; note?: string }> {
  const s = await getSupportSettings(ctx);
  if (!s.firstResponseTargetHours) return { flagged: 0, checked: 0, targetHours: null, note: "No first-response target is configured; nothing can breach it." };
  const cutoff = new Date(ctx.now().getTime() - s.firstResponseTargetHours * 3_600_000).toISOString();
  const due = (await ctx.db.prepare(`SELECT * FROM tickets WHERE first_response_at IS NULL AND sla_breached_at IS NULL
      AND status IN ('open','pending_staff','escalated') AND created_at <= ? ORDER BY created_at LIMIT 500`).bind(cutoff).all<TicketRow>()).results;
  let flagged = 0;
  for (const t of due) {
    const at = nowIso(ctx.now);
    const res = await ctx.db.prepare(`UPDATE tickets SET sla_breached_at = ? WHERE id = ? AND sla_breached_at IS NULL AND first_response_at IS NULL`).bind(at, t.id).run();
    if (res.meta.changes !== 1) continue;
    flagged++;
    await audit(ctx.db, { actorKind: "system", action: "ticket.sla_breached", subjectType: "ticket", subjectId: t.id, organizationId: t.organization_id, details: { targetHours: s.firstResponseTargetHours } });
    const a = await currentAssignee(ctx.db, t.id);
    const people = a ? [{ id: a.user_id, email: a.email }] : (await supervisors(ctx.db)).map((x) => ({ id: x.id, email: x.email }));
    for (const p of people) {
      await notify(ctx.db, p.id, { kind: "ticket_sla_breached", subjectType: "ticket", subjectId: t.id, body: `No first response within ${s.firstResponseTargetHours}h: ${t.subject}` });
      await sendMail(ctx, { template: "support_ticket", to: p.email, subject: `Response overdue — ${t.subject}`, heading: "A ticket has passed its first-response target",
        paragraphs: [`Ticket ${t.id} (“${t.subject}”) has had no staff response within the ${s.firstResponseTargetHours}-hour target.`],
        cta: { label: "Open ticket", url: `${ctx.baseUrl}/staff/support/${t.id}` }, idempotencyKey: `sla:${t.id}:${p.id}` });
    }
  }
  return { flagged, checked: due.length, targetHours: s.firstResponseTargetHours };
}
