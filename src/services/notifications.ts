// In-app notifications + email fan-out for project collaboration (PORTAL-005, EMP-003, PM-005).
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { AppContext } from "../app/context.ts";
import { can, type Actor } from "../domain/authz.ts";
import { sendMail, templateContent, type EmailTemplate, type TemplateData, type MailSpec } from "./mailer.ts";

export type MailCtx = Pick<AppContext, "db" | "email" | "baseUrl">;

export interface NotificationRow { id: string; kind: string; subject_type: string | null; subject_id: string | null; body: string; read_at: string | null; created_at: string }

export async function notify(db: Db, userId: string, n: { kind: string; subjectType?: string; subjectId?: string; body: string }): Promise<string> {
  const id = newId("ntf");
  await db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(id, userId, n.kind, n.subjectType ?? null, n.subjectId ?? null, n.body.slice(0, 500), nowIso()).run();
  return id;
}

export async function listNotifications(db: Db, userId: string, limit = 20): Promise<NotificationRow[]> {
  return (await db.prepare(`SELECT id, kind, subject_type, subject_id, body, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(userId, limit).all<NotificationRow>()).results;
}

/** Paged notification history for the full notifications page (newest first). */
export async function pageNotifications(db: Db, userId: string, opts: { unreadOnly?: boolean; limit: number; offset: number }): Promise<NotificationRow[]> {
  return (await db.prepare(`SELECT id, kind, subject_type, subject_id, body, read_at, created_at FROM notifications WHERE user_id = ? ${opts.unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
    .bind(userId, opts.limit, opts.offset).all<NotificationRow>()).results;
}

const STAFF_LINKS: Record<string, (id: string) => string> = {
  project: (id) => `/staff/projects/${id}`, task: (id) => `/staff/tasks/${id}`, lead: (id) => `/staff/crm/leads/${id}`, ticket: (id) => `/staff/support/${id}`,
  quote: (id) => `/staff/quotes/${id}`, refund: (id) => `/staff/refunds/${id}`, cms_revision: (id) => `/staff/cms/revisions/${id}`, call: (id) => `/staff/voice/calls/${id}`,
  conversation: (id) => `/staff/conversations/${id}`, organization: (id) => `/staff/customers/${id}`, ai_job: (id) => `/staff/ai/${id}`, build_job: (id) => `/staff/builds/${id}`, blocker: (id) => `/staff/readiness/blockers/${id}`,
};
const PORTAL_LINKS: Record<string, (id: string) => string> = {
  project: (id) => `/portal/projects/${id}`, ticket: (id) => `/portal/support/${id}`, invoice: (id) => `/portal/billing/invoices/${id}`, conversation: () => `/portal/messages/general`,
};

/** Where a notification points in the given area, or null when it has no linkable subject there. Ids are URL-encoded. */
export function notificationHref(n: Pick<NotificationRow, "subject_type" | "subject_id">, area: "staff" | "portal"): string | null {
  if (!n.subject_type || !n.subject_id) return null;
  const f = (area === "staff" ? STAFF_LINKS : PORTAL_LINKS)[n.subject_type];
  return f ? f(encodeURIComponent(n.subject_id)) : null;
}

/**
 * Links for a list of notifications, with dead links removed (CREST-GAP-044): a staff notification about a task
 * or project the viewer can no longer open (unassigned, removed from the project) renders as plain text instead of
 * a link that would 403/404. Visibility mirrors staffCanSeeProject in src/services/projects.ts.
 */
export async function liveNotificationHrefs(db: Db, viewer: { actor: Actor; userId: string }, rows: Pick<NotificationRow, "id" | "subject_type" | "subject_id">[], area: "staff" | "portal"): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const n of rows) out.set(n.id, notificationHref(n, area));
  if (area !== "staff" || can(viewer.actor, "project.read_all")) return out;
  const ids = (t: string) => [...new Set(rows.filter((n) => n.subject_type === t && n.subject_id && out.get(n.id)).map((n) => n.subject_id!))];
  const visibleProjectSql = `(p.project_manager_id = ?
       OR EXISTS (SELECT 1 FROM assignments a WHERE a.subject_type = 'project' AND a.subject_id = p.id AND a.user_id = ? AND a.ended_at IS NULL)
       OR EXISTS (SELECT 1 FROM assignments a JOIN tasks tt ON tt.id = a.subject_id WHERE a.subject_type = 'task' AND tt.project_id = p.id AND a.user_id = ? AND a.ended_at IS NULL))`;
  const canReadAssigned = can(viewer.actor, "project.read_assigned");
  const live = new Set<string>();
  const taskIds = ids("task"), projectIds = ids("project");
  if (canReadAssigned && taskIds.length) {
    for (const r of (await db.prepare(`SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id IN (${taskIds.map(() => "?").join(",")}) AND ${visibleProjectSql}`)
      .bind(...taskIds, viewer.userId, viewer.userId, viewer.userId).all<{ id: string }>()).results) live.add(`task:${r.id}`);
  }
  if (canReadAssigned && projectIds.length) {
    for (const r of (await db.prepare(`SELECT p.id FROM projects p WHERE p.id IN (${projectIds.map(() => "?").join(",")}) AND ${visibleProjectSql}`)
      .bind(...projectIds, viewer.userId, viewer.userId, viewer.userId).all<{ id: string }>()).results) live.add(`project:${r.id}`);
  }
  for (const n of rows) {
    if ((n.subject_type === "task" || n.subject_type === "project") && out.get(n.id) && !live.has(`${n.subject_type}:${n.subject_id}`)) out.set(n.id, null);
  }
  return out;
}

export async function unreadNotificationCount(db: Db, userId: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL`).bind(userId).first<{ n: number }>())?.n ?? 0;
}

export async function markNotificationsRead(db: Db, userId: string, id?: string): Promise<void> {
  if (id) await db.prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL`).bind(nowIso(), id, userId).run();
  else await db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`).bind(nowIso(), userId).run();
}

/** Staff responsible for a project: its project manager plus active project-level assignees. */
export async function projectStaff(db: Db, projectId: string): Promise<{ id: string; email: string; display_name: string }[]> {
  return (await db.prepare(
    `SELECT DISTINCT u.id, u.email, u.display_name FROM users u
     WHERE u.disabled_at IS NULL AND (u.id = (SELECT project_manager_id FROM projects WHERE id = ?)
       OR u.id IN (SELECT user_id FROM assignments WHERE subject_type = 'project' AND subject_id = ? AND ended_at IS NULL))`,
  ).bind(projectId, projectId).all<{ id: string; email: string; display_name: string }>()).results;
}

export async function projectManager(db: Db, projectId: string): Promise<{ id: string; email: string; display_name: string } | null> {
  return db.prepare(`SELECT u.id, u.email, u.display_name FROM projects p JOIN users u ON u.id = p.project_manager_id WHERE p.id = ? AND u.disabled_at IS NULL`)
    .bind(projectId).first<{ id: string; email: string; display_name: string }>();
}

/** Owners/administrators, used when a project has no PM yet so nothing is silently dropped. */
export async function fallbackCoordinators(db: Db): Promise<{ id: string; email: string; display_name: string }[]> {
  return (await db.prepare(`SELECT DISTINCT u.id, u.email, u.display_name FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.role_id IN ('owner','project_manager') AND u.disabled_at IS NULL`)
    .all<{ id: string; email: string; display_name: string }>()).results;
}

export async function customerMembers(db: Db, organizationId: string): Promise<{ id: string; email: string; display_name: string }[]> {
  return (await db.prepare(`SELECT u.id, u.email, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.role_id IN ('customer_admin','customer_member') AND u.disabled_at IS NULL`)
    .bind(organizationId).all<{ id: string; email: string; display_name: string }>()).results;
}

/** Project-scoped mail: template data without projectName/url, which the notifier fills in. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ProjectMail = { [K in EmailTemplate]: { template: K; data: DistributiveOmit<TemplateData[K], "projectName" | "url"> } }[EmailTemplate];

function projectSpec(mail: ProjectMail, projectName: string, url: string): MailSpec {
  return { template: mail.template, data: { ...mail.data, projectName, url } } as MailSpec;
}

/** In-app notification text: the template's main (last) paragraph, so in-app and email never disagree. */
function inAppBody(spec: MailSpec): string {
  return templateContent(spec).paragraphs.at(-1) ?? templateContent(spec).subject;
}

/** Notify (in-app + email) every customer member of the project's organization. Copy lives in the template registry. */
export async function notifyCustomer(ctx: MailCtx, projectId: string, n: { kind: string; mail: ProjectMail; path: string; key: string; exceptUserId?: string }) {
  const p = await ctx.db.prepare(`SELECT organization_id, name FROM projects WHERE id = ?`).bind(projectId).first<{ organization_id: string; name: string }>();
  if (!p) return;
  const spec = projectSpec(n.mail, p.name, `${ctx.baseUrl}${n.path}`);
  for (const u of await customerMembers(ctx.db, p.organization_id)) {
    if (u.id === n.exceptUserId) continue;
    await notify(ctx.db, u.id, { kind: n.kind, subjectType: "project", subjectId: projectId, body: inAppBody(spec) });
    await sendMail(ctx, { ...spec, to: u.email, idempotencyKey: `${n.key}:${u.id}` });
  }
}

/** Notify (in-app + email) the PM and project assignees; falls back to owners/PMs when nobody is assigned. */
export async function notifyProjectTeam(ctx: MailCtx, projectId: string, n: { kind: string; mail: ProjectMail; path: string; key: string; exceptUserId?: string; pmOnly?: boolean }) {
  let people = n.pmOnly ? [await projectManager(ctx.db, projectId)].filter((x): x is NonNullable<typeof x> => !!x) : await projectStaff(ctx.db, projectId);
  if (!people.length) people = await fallbackCoordinators(ctx.db);
  const p = await ctx.db.prepare(`SELECT name FROM projects WHERE id = ?`).bind(projectId).first<{ name: string }>();
  const spec = projectSpec(n.mail, p?.name ?? projectId, `${ctx.baseUrl}${n.path}`);
  for (const u of people) {
    if (u.id === n.exceptUserId) continue;
    await notify(ctx.db, u.id, { kind: n.kind, subjectType: "project", subjectId: projectId, body: inAppBody(spec) });
    await sendMail(ctx, { ...spec, to: u.email, idempotencyKey: `${n.key}:${u.id}` });
  }
}
