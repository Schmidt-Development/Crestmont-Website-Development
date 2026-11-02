// Staff delivery area: "My work" dashboard, projects (list/kanban/detail), tasks, inactivity sweep
// (PM-001..PM-007, EMP-003, PORTAL-003/005/006/007/010 staff side).
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatCents, formatDate, formatDateTime, label, safeUrl, type SafeHtml } from "../lib/html.ts";
import { HttpError, download, htmlResponse, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { appLayout } from "../ui/layout.ts";
import { staffNav } from "./nav.ts";
import {
  csrf, button, linkButton, actionForm, input, textarea, select, checkbox, formErrors, alert, badge, table, emptyState, kpi, dl, tabs, pageHead, nl2br, pagination, pageParam, threadEarlierNav, showingOf,
} from "../ui/components.ts";
import { toCsv } from "../services/finance.ts";
import * as P from "../services/projects.ts";
import * as F from "../services/files.ts";
import * as M from "../services/messages.ts";
import * as O from "../services/onboarding.ts";
import { listNotifications, markNotificationsRead, liveNotificationHrefs } from "../services/notifications.ts";
import { audit } from "../services/security.ts";
import { disabledOwnerFlag } from "../services/offboarding.ts";
import { can, isOwner } from "../domain/authz.ts";
import { PROJECT_STATUSES, PROJECT_TRANSITIONS, type ProjectStatus } from "../domain/project.ts";
import { PACKAGES, type PackageId } from "../domain/catalog.ts";

const PAUSABLE: ProjectStatus[] = ["awaiting_onboarding", "scope_review", "design", "development", "internal_qa", "customer_review", "revisions", "final_approval"];
const TABS = ["overview", "plan", "revisions", "approvals", "messages", "files", "handoff", "costs", "activity"] as const;
type Tab = (typeof TABS)[number];

/** Date-only values (YYYY-MM-DD) are calendar days: render them without a timezone shift. */
const fmtDay = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? formatDate(`${s}T12:00:00Z`) : formatDate(s));

function page(ctx: AppContext, title: string, body: SafeHtml, status = 200): Response {
  return htmlResponse(ctx, appLayout(ctx, { title, nav: staffNav(ctx), home: "/staff", area: "Crestmont staff" }, body), status);
}
const packageName = (id: string | null) => (id && id in PACKAGES ? PACKAGES[id as PackageId].name : id === "custom" ? "Custom" : "—");
const dateOrNull = (s: string) => (s ? s : null);
const centsOrNull = (s: string): number | null => {
  if (!s.trim()) return null;
  const n = Number(s.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(422, "Enter a valid dollar amount, or leave it blank when unknown.");
  return Math.round(n * 100);
};
const intOrNull = (s: string): number | null => {
  if (!s.trim()) return null;
  const n = Number(s);
  if (!Number.isInteger(n)) throw new HttpError(422, "Enter a whole number.");
  return n;
};

async function staffUsers(ctx: AppContext, roles?: string[]): Promise<{ id: string; display_name: string; role_id: string }[]> {
  const r = roles ?? ["owner", "administrator", "developer", "project_manager", "support", "sales"];
  return (await ctx.db.prepare(`SELECT u.id, u.display_name, MIN(m.role_id) AS role_id FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.disabled_at IS NULL AND m.role_id IN (${r.map(() => "?").join(",")}) GROUP BY u.id ORDER BY u.display_name`).bind(...r).all<{ id: string; display_name: string; role_id: string }>()).results;
}

async function generalConversationsNotice(ctx: AppContext): Promise<SafeHtml> {
  const n = await M.generalUnreadForStaff(ctx.db, ctx.user!.id);
  return n ? html`<div class="alert alert--info" role="status">${n} unread general customer message${n === 1 ? "" : "s"} (outside projects). <a href="/staff/conversations">Open conversations</a></div>` : html``;
}

const REVISION_CATEGORY_LABEL: Record<string, string> = { customer_revision: "Customer revision (uses a round)", builder_defect: "Crestmont defect (no round used)", scope_change: "Scope change (change order)" };

/** FD-16: the Founder's documented launch/payment exception for one project (Owner only). */
async function paymentExceptionPanel(ctx: AppContext, projectId: string): Promise<SafeHtml> {
  const ex = await ctx.db.prepare(`SELECT e.reason, e.unpaid_at_grant, e.granted_at, u.display_name FROM release_payment_exceptions e JOIN users u ON u.id = e.granted_by WHERE e.project_id = ? AND e.revoked_at IS NULL`)
    .bind(projectId).first<{ reason: string; unpaid_at_grant: string; granted_at: string; display_name: string }>();
  return html`<details class="disclosure" data-testid="payment-exception"${ex ? html` open` : ""}><summary>Founder payment exception (FD-16)</summary><div class="disclosure__body stack">
<p class="muted">Waives only the unpaid scheduled payments for this project's release. Approvals, change-order invoices and simulated payments are never waived. Requires a fresh second factor.</p>
${ex ? html`${dl([["In force since", formatDateTime(ex.granted_at)], ["By", ex.display_name], ["Waived", ex.unpaid_at_grant.split(",").join(", ")], ["Reason", ex.reason]])}
<form method="post" action="/staff/projects/${projectId}/payment-exception" class="stack">${csrf(ctx)}<input type="hidden" name="intent" value="revoke">${input({ name: "reason", label: "Why revoke it", required: true, maxlength: 1000 })}${button("Revoke exception", { variant: "secondary", size: "sm" })}</form>`
  : html`<form method="post" action="/staff/projects/${projectId}/payment-exception" class="stack" data-confirm="Authorize release without the unpaid scheduled payments?">${csrf(ctx)}<input type="hidden" name="intent" value="grant">${textarea({ name: "reason", label: "Documented reason (what was agreed and how payment will be settled)", rows: 3, required: true, maxlength: 2000 })}${button("Authorize payment exception", { variant: "danger", size: "sm" })}</form>`}
</div></details>`;
}

export function register(r: Router): void {
  // ───────────── My work ─────────────
  r.get("/staff", async (ctx) => {
    requireStaff(ctx);
    const db = ctx.db, me = ctx.user!.id, actor = ctx.actor!;
    const today = ctx.now().toISOString().slice(0, 10);
    const tasks = (await db.prepare(`SELECT t.id, t.title, t.status, t.due_at, p.id AS project_id, p.name AS project_name FROM assignments a JOIN tasks t ON t.id = a.subject_id JOIN projects p ON p.id = t.project_id
        WHERE a.subject_type = 'task' AND a.user_id = ? AND a.ended_at IS NULL AND t.status <> 'done' ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at LIMIT 50`).bind(me)
      .all<{ id: string; title: string; status: string; due_at: string | null; project_id: string; project_name: string }>()).results;
    // CREST-GAP-071: KPIs and "showing N of M" use true totals, not the length of the capped lists.
    const in7 = new Date(ctx.now().getTime() + 7 * 86400e3).toISOString().slice(0, 10);
    const taskTotals = (await db.prepare(`SELECT COUNT(*) AS n, SUM(t.due_at IS NOT NULL AND t.due_at < ?) AS overdue, SUM(t.due_at IS NOT NULL AND t.due_at >= ? AND t.due_at <= ?) AS soon
        FROM assignments a JOIN tasks t ON t.id = a.subject_id WHERE a.subject_type = 'task' AND a.user_id = ? AND a.ended_at IS NULL AND t.status <> 'done'`).bind(today, today, in7, me).first<{ n: number; overdue: number | null; soon: number | null }>())!;
    const overdue = taskTotals.overdue ?? 0, dueSoon = taskTotals.soon ?? 0;
    const vis = P.visibleProjectsSql(actor, me);
    const myProjects = can(actor, "delivery.access") ? (await db.prepare(`SELECT p.id, p.name, p.status, o.name AS org FROM projects p JOIN organizations o ON o.id = p.organization_id
        WHERE (p.project_manager_id = ? OR EXISTS (SELECT 1 FROM assignments a WHERE a.subject_type = 'project' AND a.subject_id = p.id AND a.user_id = ? AND a.ended_at IS NULL)
          OR EXISTS (SELECT 1 FROM assignments a JOIN tasks t ON t.id = a.subject_id WHERE a.subject_type = 'task' AND t.project_id = p.id AND a.user_id = ? AND a.ended_at IS NULL))
          AND p.status NOT IN ('completed','maintenance','cancelled') ORDER BY p.updated_at DESC LIMIT 25`).bind(me, me, me).all<{ id: string; name: string; status: string; org: string }>()).results : [];
    const myProjectsTotal = can(actor, "delivery.access") ? (await db.prepare(`SELECT COUNT(*) AS n FROM projects p WHERE (p.project_manager_id = ? OR EXISTS (SELECT 1 FROM assignments a WHERE a.subject_type = 'project' AND a.subject_id = p.id AND a.user_id = ? AND a.ended_at IS NULL)
          OR EXISTS (SELECT 1 FROM assignments a JOIN tasks t ON t.id = a.subject_id WHERE a.subject_type = 'task' AND t.project_id = p.id AND a.user_id = ? AND a.ended_at IS NULL))
          AND p.status NOT IN ('completed','maintenance','cancelled')`).bind(me, me, me).first<{ n: number }>())!.n : 0;
    const leadsTotal = (await db.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE l.owner_user_id = ? AND l.stage NOT IN ('converted','lost','rejected','archived')`).bind(me).first<{ n: number }>())!.n;
    const ticketsTotal = (await db.prepare(`SELECT COUNT(*) AS n FROM assignments a JOIN tickets t ON t.id = a.subject_id WHERE a.subject_type = 'ticket' AND a.user_id = ? AND a.ended_at IS NULL AND t.status NOT IN ('resolved','closed')`).bind(me).first<{ n: number }>())!.n;
    /** "Showing N of M" with a link to the full, paginated list (only when the list is capped). */
    const more = (shown: number, total: number, noun: string, href: string | null) => (total > shown ? html`<p class="faint" data-showing>Showing ${shown} of ${total} ${noun}.${href ? html` <a href="${href}">View all</a>` : ""}</p>` : "");
    const leads = (await db.prepare(`SELECT l.id, l.stage, l.interest, l.updated_at, c.name FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.owner_user_id = ? AND l.stage NOT IN ('converted','lost','rejected','archived') ORDER BY l.updated_at DESC LIMIT 25`).bind(me)
      .all<{ id: string; stage: string; interest: string | null; updated_at: string; name: string }>()).results;
    const tickets = (await db.prepare(`SELECT t.id, t.subject, t.priority, t.status, t.updated_at, o.name AS org FROM assignments a JOIN tickets t ON t.id = a.subject_id JOIN organizations o ON o.id = t.organization_id
        WHERE a.subject_type = 'ticket' AND a.user_id = ? AND a.ended_at IS NULL AND t.status NOT IN ('resolved','closed') ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at LIMIT 25`).bind(me)
      .all<{ id: string; subject: string; priority: string; status: string; updated_at: string; org: string }>()).results;
    const notes = await listNotifications(db, me, 15);
    const noteHrefs = await liveNotificationHrefs(db, { actor, userId: me }, notes, "staff");
    const activity = (await db.prepare(`SELECT action, subject_type, details_json, created_at FROM audit_logs WHERE actor_user_id = ? ORDER BY id DESC LIMIT 15`).bind(me).all<{ action: string; subject_type: string; details_json: string | null; created_at: string }>()).results;
    const unreadMsgs = can(actor, "delivery.access") ? await M.unreadCountForStaff(db, me, can(actor, "project.read_all") ? "all" : myProjects.map((p) => p.id)) : 0;
    const since30 = new Date(ctx.now().getTime() - 30 * 86400e3).toISOString();
    const roleKpis: SafeHtml[] = [];
    if (can(actor, "task.update_assigned")) {
      const done30 = (await db.prepare(`SELECT COUNT(*) AS n FROM tasks t JOIN assignments a ON a.subject_id = t.id AND a.subject_type = 'task' AND a.user_id = ? WHERE t.status = 'done' AND t.completed_at >= ?`).bind(me, since30).first<{ n: number }>())!.n;
      const mins = (await db.prepare(`SELECT COALESCE(SUM(minutes),0) AS m FROM time_entries WHERE user_id = ? AND worked_on >= ?`).bind(me, since30.slice(0, 10)).first<{ m: number }>())!.m;
      roleKpis.push(kpi("Tasks completed (30 days)", done30), kpi("Time logged (30 days)", `${(mins / 60).toFixed(1)} h`));
    }
    if (can(actor, "project.coordinate")) {
      const c = (await db.prepare(`SELECT COUNT(*) AS active, SUM(status = 'paused') AS paused, SUM(project_manager_id IS NULL) AS unassigned FROM projects p WHERE status NOT IN ('completed','maintenance','cancelled') AND ${vis.sql}`).bind(...vis.binds).first<{ active: number; paused: number | null; unassigned: number | null }>())!;
      const pendingCo = (await db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE included = 0 AND billable_change_order_id IS NULL AND status = 'submitted'`).first<{ n: number }>())!.n;
      roleKpis.push(kpi("Active projects", c.active), kpi("Paused", c.paused ?? 0), kpi("Without a PM", c.unassigned ?? 0), kpi("Revisions needing a change order", pendingCo));
    }
    if (can(actor, "crm.access")) roleKpis.push(kpi("My open leads", leadsTotal));
    if (can(actor, "support.access")) roleKpis.push(kpi("My open tickets", ticketsTotal));
    const body = html`${pageHead("My work", undefined, label(ctx.user!.memberships.find((m) => m.organizationId)?.role ?? "staff"))}
<div class="kpis">${kpi("Open tasks", taskTotals.n, overdue ? `${overdue} overdue` : "None overdue")}${kpi("Due in 7 days", dueSoon)}${kpi("Unread customer messages", unreadMsgs)}${roleKpis}</div>
${can(actor, "customers.read") ? await generalConversationsNotice(ctx) : ""}
<div class="grid grid-2">
<section class="card"><h2 class="card__title">Assigned tasks</h2>${table(tasks, [
  { header: "Task", cell: (t) => html`<a href="/staff/tasks/${t.id}">${t.title}</a><br><span class="faint">${t.project_name}</span>` },
  { header: "Status", cell: (t) => badge(t.status) },
  { header: "Due", cell: (t) => (t.due_at ? html`${fmtDay(t.due_at)}${t.due_at < today ? html` ${badge("past_due", "Overdue")}` : ""}` : "—") },
], { empty: html`<p class="muted">No open tasks assigned to you.</p>` })}${more(tasks.length, taskTotals.n, "open tasks", can(actor, "delivery.access") ? "/staff/tasks?assignee=me" : null)}</section>
<section class="card"><div class="row row--between"><h2 class="card__title">Notifications</h2><div class="row">${notes.some((n) => !n.read_at) ? actionForm(ctx, "/staff/notifications/read", "Mark all read", { variant: "ghost" }) : ""}${linkButton("View all", "/staff/notifications", "ghost", "sm")}</div></div>
${notes.length ? html`<ul class="timeline">${notes.map((n) => { const href = noteHrefs.get(n.id); return html`<li>${n.read_at ? "" : badge("new", "New")} ${href ? html`<a href="${href}">${n.body}</a>` : n.body}<br><span class="faint">${formatDateTime(n.created_at)}</span></li>`; })}</ul>` : html`<p class="muted">No notifications.</p>`}</section>
${can(actor, "delivery.access") ? html`<section class="card"><h2 class="card__title">My projects</h2>${table(myProjects, [
  { header: "Project", cell: (p) => html`<a href="/staff/projects/${p.id}">${p.name}</a><br><span class="faint">${p.org}</span>` }, { header: "Status", cell: (p) => badge(p.status) },
], { empty: html`<p class="muted">You are not assigned to any active project.</p>` })}${more(myProjects.length, myProjectsTotal, "active projects", "/staff/projects")}</section>` : ""}
${can(actor, "crm.access") || leads.length ? html`<section class="card"><h2 class="card__title">Assigned leads</h2>${table(leads, [
  { header: "Lead", cell: (l) => html`<a href="/staff/crm/leads/${l.id}">${l.name}</a>${l.interest ? html`<br><span class="faint">${l.interest}</span>` : ""}` }, { header: "Stage", cell: (l) => badge(l.stage) }, { header: "Updated", cell: (l) => fmtDay(l.updated_at) },
], { empty: html`<p class="muted">No open leads assigned to you.</p>` })}${more(leads.length, leadsTotal, "open leads", can(actor, "crm.access") ? `/staff/crm?view=list&owner=${encodeURIComponent(me)}` : null)}</section>` : ""}
${can(actor, "support.access") || tickets.length ? html`<section class="card"><h2 class="card__title">Assigned tickets</h2>${table(tickets, [
  { header: "Ticket", cell: (t) => html`<a href="/staff/support/${t.id}">${t.subject}</a><br><span class="faint">${t.org}</span>` }, { header: "Priority", cell: (t) => badge(t.priority) }, { header: "Status", cell: (t) => badge(t.status) },
], { empty: html`<p class="muted">No open tickets assigned to you.</p>` })}${more(tickets.length, ticketsTotal, "open tickets", can(actor, "support.access") ? "/staff/support?assignee=me" : null)}</section>` : ""}
<section class="card"><h2 class="card__title">My recent activity</h2>${activity.length ? html`<ul class="timeline">${activity.map((a) => html`<li>${a.action.replace(/[._]/g, " ")} <span class="faint">(${a.subject_type})</span><br><span class="faint">${formatDateTime(a.created_at)}</span></li>`)}</ul>` : html`<p class="muted">No activity recorded yet.</p>`}</section>
</div>`;
    return page(ctx, "My work", body);
  });

  // ───────────── General (non-project) customer conversations (PORTAL-005) ─────────────
  r.get("/staff/conversations", async (ctx) => {
    requireStaff(ctx, "customers.read");
    const q = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 120);
    // CREST-GAP-071: paginated with the true total instead of a silent 100-row cap.
    const { page: pg, limit, offset } = pageParam(ctx);
    const rows = await M.listGeneralConversations(ctx.db, ctx.user!.id, { q: q || undefined, limit, offset });
    const total = await M.countGeneralConversations(ctx.db, { q: q || undefined });
    return page(ctx, "Conversations", html`${pageHead("General conversations", undefined, "Customer messages outside projects")}
<form method="get" class="filters" action="/staff/conversations">${input({ name: "q", label: "Find a customer", value: q, placeholder: "Organization name" })}${button("Search", { variant: "secondary", size: "sm" })}</form>
${table(rows, [
  { header: "Customer", cell: (x) => html`<a href="/staff/conversations/${x.id}">${x.name}</a>` },
  { header: "Messages", cell: (x) => x.total, numeric: true },
  { header: "Unread", cell: (x) => (x.unread ? badge("new", `${x.unread} unread`) : "—") },
  { header: "Last message", cell: (x) => formatDateTime(x.last_at) },
], { empty: emptyState(q ? "No customers match" : "No general conversations yet", q ? "Try another name." : "Customers start one from Messages in their portal. Search for a customer to message them first.") })}
${total > limit ? html`<p class="faint" data-showing>Showing ${offset + (rows.length ? 1 : 0)}–${offset + rows.length} of ${total} conversations.</p>${pagination(ctx, pg, offset + rows.length < total)}` : ""}`);
  });
  const conversationPage = async (ctx: AppContext, orgId: string, errors: string[] = [], status = 200, draft = "") => {
    requireStaff(ctx, "customers.read");
    const org = await ctx.db.prepare(`SELECT id, name FROM organizations WHERE id = ? AND kind = 'customer'`).bind(orgId).first<{ id: string; name: string }>();
    if (!org) throw new HttpError(404, "Customer not found");
    const thread = await M.listThread(ctx.db, { userId: ctx.user!.id, organizationId: org.id, staff: true }, null, { before: ctx.url.searchParams.get("before") });
    const msgs = thread.messages;
    await M.markThreadRead(ctx.db, ctx.user!.id, org.id, null, true, msgs.map((m) => m.id));
    // CREST-GAP-070: broad staff visibility is kept by Founder decision; each view of a customer conversation is audited.
    if (status === 200) await audit(ctx.db, { actorUserId: ctx.user!.id, action: "conversation.viewed", subjectType: "organization", subjectId: org.id, organizationId: org.id, ip: ctx.ip, details: { before: ctx.url.searchParams.get("before") } });
    const body = html`${pageHead(org.name, html`${linkButton("All conversations", "/staff/conversations", "ghost", "sm")}${linkButton("Customer record", `/staff/customers/${org.id}`, "ghost", "sm")}`, "General conversation")}
${formErrors(errors)}
${threadEarlierNav(ctx, thread)}<div class="thread">${msgs.length ? msgs.map((m) => html`<article class="msg${m.internal ? " msg--internal" : m.author_is_staff ? " msg--staff" : ""}"><div class="msg__meta">${m.internal ? "Internal note · " : ""}${m.author_name}${m.author_is_staff ? " · Crestmont" : " · Customer"} · ${formatDateTime(m.created_at)}${!m.internal && m.author_is_staff ? (m.read_by_other_side ? " · Seen by customer" : " · Not yet read by customer") : ""}</div>${nl2br(m.body)}${m.attachment_file_id ? html`<p><a href="/files/${m.attachment_file_id}">Attachment: ${m.attachment_name ?? "file"}</a></p>` : ""}</article>`) : emptyState("No messages yet", "Send the first message, or leave an internal note for the team.")}</div>
<form method="post" action="/staff/conversations/${org.id}" enctype="multipart/form-data" class="card" style="margin-top:1.5rem">${csrf(ctx)}${textarea({ name: "body", label: "Message", required: true, rows: 4, maxlength: 10000, value: draft })}
<div class="field"><label for="f-attachment">Attachment (optional)</label><input class="input" id="f-attachment" type="file" name="attachment"${ctx.storage ? "" : html` disabled`}></div>
${checkbox("internal", "Internal note — not visible to the customer")}<div class="form-actions">${button("Send")}</div></form>`;
    return page(ctx, `${org.name} — conversation`, body, status);
  };
  r.get("/staff/conversations/:orgId", async (ctx, p) => conversationPage(ctx, p.orgId));
  r.post("/staff/conversations/:orgId", async (ctx, p) => {
    requireStaff(ctx, "customers.read");
    const org = await ctx.db.prepare(`SELECT id FROM organizations WHERE id = ? AND kind = 'customer'`).bind(p.orgId).first<{ id: string }>();
    if (!org) throw new HttpError(404, "Customer not found");
    const f = await ctx.form();
    const att = f.get("attachment");
    try {
      await M.postMessage(ctx, { organizationId: org.id, projectId: null, authorUserId: ctx.user!.id, body: str(f, "body"), attachment: att && typeof att !== "string" ? att : null, internal: !!f.get("internal"), fromStaff: true });
    } catch (e) {
      if (e instanceof M.MessageError) return conversationPage(ctx, org.id, [e.message], 422, str(f, "body"));
      throw e;
    }
    return redirect(ctx, `/staff/conversations/${org.id}`, { kind: "success", text: f.get("internal") ? "Internal note added." : "Message sent." });
  });

  r.post("/staff/notifications/read", async (ctx) => {
    requireStaff(ctx);
    await markNotificationsRead(ctx.db, ctx.user!.id);
    const back = str(await ctx.form(), "back") === "/staff/notifications" ? "/staff/notifications" : "/staff";
    return redirect(ctx, back, { kind: "success", text: "Notifications marked as read." });
  });

  // ───────────── Project list / kanban ─────────────
  type ProjectListRow = { id: string; name: string; status: string; product_id: string | null; created_at: string; updated_at: string; last_customer_activity_at: string | null; target_launch_at: string | null; completed_at: string | null; org: string; pm_name: string | null; done: number; total: number; overdue: number };
  const projectQuery = (ctx: AppContext) => {
    const q = ctx.url.searchParams;
    const status = q.get("status") ?? "", pm = q.get("pm") ?? "", org = q.get("customer") ?? "", search = (q.get("q") ?? "").trim().slice(0, 100);
    const vis = P.visibleProjectsSql(ctx.actor!, ctx.user!.id);
    const where = [vis.sql];
    const today = ctx.now().toISOString().slice(0, 10);
    const binds: unknown[] = [today, ...vis.binds]; // first placeholder: the overdue-task cut-off in the SELECT list
    if ((PROJECT_STATUSES as readonly string[]).includes(status)) { where.push("p.status = ?"); binds.push(status); }
    else if (status !== "all") where.push("p.status NOT IN ('cancelled')");
    if (pm === "none") where.push("p.project_manager_id IS NULL"); else if (pm) { where.push("p.project_manager_id = ?"); binds.push(pm); }
    if (org) { where.push("p.organization_id = ?"); binds.push(org); }
    if (search) { const like = `%${search.replace(/[\\%_]/g, (m) => "\\" + m)}%`; where.push("(p.name LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\' OR p.id = ?)"); binds.push(like, like, search); }
    const sql = `SELECT p.id, p.name, p.status, p.product_id, p.created_at, p.updated_at, p.last_customer_activity_at, p.target_launch_at, p.completed_at, o.name AS org, u.display_name AS pm_name,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS total,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done' AND t.due_at IS NOT NULL AND t.due_at < ?) AS overdue
        FROM projects p JOIN organizations o ON o.id = p.organization_id LEFT JOIN users u ON u.id = p.project_manager_id WHERE ${where.join(" AND ")} ORDER BY p.updated_at DESC, p.id`;
    return { sql, binds, v: { status, pm, org, search } };
  };
  r.get("/staff/projects/export.csv", async (ctx) => {
    requireStaff(ctx, "delivery.access");
    const pq = projectQuery(ctx);
    const rows = (await ctx.db.prepare(`${pq.sql} LIMIT 10000`).bind(...pq.binds).all<ProjectListRow>()).results;
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "project.exported", subjectType: "project", details: { count: rows.length, filter: pq.v } });
    const csv = toCsv(["project_id", "name", "customer", "package", "status", "project_manager", "tasks_done", "tasks_total", "tasks_overdue", "target_launch", "created_date", "completed_date", "last_customer_activity"],
      rows.map((p) => [p.id, p.name, p.org, p.product_id ?? "", p.status, p.pm_name ?? "", p.done, p.total, p.overdue, p.target_launch_at?.slice(0, 10) ?? "", p.created_at.slice(0, 10), p.completed_at?.slice(0, 10) ?? "", p.last_customer_activity_at?.slice(0, 10) ?? ""]));
    return download(ctx, csv, `crestmont-projects-${ctx.now().toISOString().slice(0, 10)}.csv`, "text/csv; charset=utf-8");
  });
  r.get("/staff/projects", async (ctx) => {
    requireStaff(ctx, "delivery.access");
    const q = ctx.url.searchParams;
    const view = q.get("view") === "kanban" ? "kanban" : "list";
    const pq = projectQuery(ctx);
    const { status, pm, org, search } = pq.v;
    const { page: pageNo, limit, offset } = pageParam(ctx);
    // The board shows every matching project (capped); the list is paginated.
    const rows = (await ctx.db.prepare(view === "kanban" ? `${pq.sql} LIMIT 500` : `${pq.sql} LIMIT ? OFFSET ?`).bind(...pq.binds, ...(view === "kanban" ? [] : [limit + 1, offset])).all<ProjectListRow>()).results;
    const hasNext = view === "list" && rows.length > limit;
    if (hasNext) rows.length = limit;
    const pms = await staffUsers(ctx, ["project_manager", "owner"]);
    // Customer filter options come only from projects this person may see (assigned-only staff do not learn other customers).
    const vis = P.visibleProjectsSql(ctx.actor!, ctx.user!.id);
    const orgs = (await ctx.db.prepare(`SELECT DISTINCT o.id, o.name FROM organizations o JOIN projects p ON p.organization_id = o.id WHERE ${vis.sql} ORDER BY o.name`).bind(...vis.binds).all<{ id: string; name: string }>()).results;
    const qs = (v: string) => { const u = new URLSearchParams(q); u.set("view", v); return `/staff/projects?${u}`; };
    const filters = html`<form method="get" action="/staff/projects" class="filters"><input type="hidden" name="view" value="${view}">
${select({ name: "status", label: "Status", options: [{ value: "all", label: "All incl. cancelled" }, ...PROJECT_STATUSES.map((s) => ({ value: s, label: label(s) }))], value: status, includeBlank: "Open (not cancelled)" })}
${select({ name: "pm", label: "Project manager", options: [{ value: "none", label: "Unassigned" }, ...pms.map((u) => ({ value: u.id, label: u.display_name }))], value: pm, includeBlank: "Anyone" })}
${select({ name: "customer", label: "Customer", options: orgs.map((o) => ({ value: o.id, label: o.name })), value: org, includeBlank: "All customers" })}
${input({ name: "q", label: "Search", value: search, placeholder: "Project, customer or ID" })}${button("Filter", { variant: "secondary" })}</form>`;
    const listView = table(rows, [
      { header: "Project", cell: (p) => html`<a href="/staff/projects/${p.id}">${p.name}</a><br><span class="faint">${p.org}</span>` },
      { header: "Package", cell: (p) => packageName(p.product_id) },
      { header: "Status", cell: (p) => badge(p.status) },
      { header: "PM", cell: (p) => p.pm_name ?? badge("pending", "Unassigned") },
      { header: "Tasks", cell: (p) => (p.total ? html`${p.done} / ${p.total}${p.overdue ? html` ${badge("past_due", `${p.overdue} overdue`)}` : ""}` : "—") },
      { header: "Target launch", cell: (p) => fmtDay(p.target_launch_at) },
      { header: "Customer activity", cell: (p) => fmtDay(p.last_customer_activity_at) },
      { header: "Updated", cell: (p) => fmtDay(p.updated_at) },
    ], { empty: emptyState("No projects match", "Projects are created automatically when a package order or accepted quote is paid.") });
    const cols = PROJECT_STATUSES.filter((s) => s !== "cancelled" || status === "all" || status === "cancelled");
    const kanbanView = html`<div class="kanban">${cols.map((s) => {
      const items = rows.filter((p) => p.status === s);
      return html`<div class="kanban__col"><h3>${label(s)} · ${items.length}</h3>${items.map((p) => html`<a class="kanban__card" href="/staff/projects/${p.id}"><strong>${p.name}</strong><br><span class="faint">${p.pm_name ?? "No PM"} · ${p.total ? `${p.done}/${p.total} tasks` : "No tasks"}</span></a>`)}</div>`;
    })}</div>`;
    const exportHref = (() => { const u = new URLSearchParams(q); u.delete("page"); u.delete("view"); const s2 = u.toString(); return `/staff/projects/export.csv${s2 ? `?${s2}` : ""}`; })();
    const body = html`${pageHead("Projects", html`${linkButton("List", qs("list"), view === "list" ? "primary" : "ghost", "sm")}${linkButton("Board", qs("kanban"), view === "kanban" ? "primary" : "ghost", "sm")}${linkButton("Export CSV", exportHref, "ghost", "sm")}
${can(ctx.actor!, "project.coordinate") ? actionForm(ctx, "/staff/projects/sweep-inactivity", "Run inactivity sweep", { variant: "secondary", confirm: "Send due inactivity reminders, escalations and pauses now?" }) : ""}`)}
${filters}${view === "kanban" ? kanbanView : html`${listView}${pagination(ctx, pageNo, hasNext)}`}`;
    return page(ctx, "Projects", body);
  });

  r.post("/staff/projects/sweep-inactivity", async (ctx) => {
    requireStaff(ctx, "project.coordinate");
    const res = await P.runInactivitySweep(ctx);
    const n = (k: string) => res.filter((x) => x.action === k).length;
    return redirect(ctx, "/staff/projects", { kind: "success", text: `Inactivity sweep: ${n("remind")} reminder(s), ${n("escalate")} escalation(s), ${n("pause")} pause(s).` });
  });

  // ───────────── Project detail ─────────────
  const projectPage = async (ctx: AppContext, id: string, tab: Tab, errors: string[] = [], status = 200): Promise<Response> => {
    const proj = await P.getStaffProject(ctx, id);
    const db = ctx.db, actor = ctx.actor!;
    const coord = can(actor, "project.coordinate");
    const org = (await db.prepare(`SELECT name FROM organizations WHERE id = ?`).bind(proj.organization_id).first<{ name: string }>())!;
    const pm = proj.project_manager_id ? await db.prepare(`SELECT display_name FROM users WHERE id = ?`).bind(proj.project_manager_id).first<{ display_name: string }>() : null;
    const tabNav = tabs(TABS.map((t) => ({ href: `/staff/projects/${proj.id}${t === "overview" ? "" : `?tab=${t}`}`, label: t === "plan" ? "Milestones & tasks" : label(t), current: t === tab })));
    let content: SafeHtml;

    if (tab === "overview") {
      const scopes = (await db.prepare(`SELECT s.version, s.scope_text, s.approved_at, u.display_name FROM project_scopes s LEFT JOIN users u ON u.id = s.approved_by WHERE s.project_id = ? ORDER BY s.version DESC`).bind(proj.id).all<{ version: number; scope_text: string; approved_at: string | null; display_name: string | null }>()).results;
      const onb = await O.getOnboarding(db, proj.id);
      const assignees = (await db.prepare(`SELECT a.id, u.display_name, a.created_at FROM assignments a JOIN users u ON u.id = a.user_id WHERE a.subject_type = 'project' AND a.subject_id = ? AND a.ended_at IS NULL`).bind(proj.id).all<{ id: string; display_name: string; created_at: string }>()).results;
      const staff = coord ? await staffUsers(ctx) : [];
      const pms = coord ? await staffUsers(ctx, ["project_manager", "owner"]) : [];
      const next = [...PROJECT_TRANSITIONS[proj.status]];
      const fieldsVal = (a: O.Answers, f: O.OnboardingField) => { const v = a[f.name]; const vals = Array.isArray(v) ? v : v ? [v] : []; return f.options ? vals.map((x) => f.options!.find((o) => o.value === x)?.label ?? x).join(", ") : vals.join(", "); };
      content = html`<div class="grid grid-2"><section class="card"><h2 class="card__title">Lifecycle</h2>
${dl([["Status", badge(proj.status)], ["Paused from", proj.paused_from_status ? label(proj.paused_from_status) : null], ["Customer", org.name], ["Package", packageName(proj.product_id)], ["Payment schedule", proj.payment_schedule === "upfront" ? "100% upfront" : "50 / 25 / 25"], ["Revision allowance", proj.revision_allowance], ["Last customer activity", formatDateTime(proj.last_customer_activity_at)], ["Target launch", fmtDay(proj.target_launch_at)], ["Live URL", proj.live_url ? html`<a href="${safeUrl(proj.live_url)}" rel="noopener">${proj.live_url}</a>` : null], ["Cancellation reason", proj.cancel_reason]])}
${coord ? html`<div class="row" style="margin-top:1rem">${next.map((s) => actionForm(ctx, `/staff/projects/${proj.id}/status`, `Move to ${label(s)}`, { hidden: { to: s } }))}
${PAUSABLE.includes(proj.status) ? html`<form method="post" action="/staff/projects/${proj.id}/status" class="row">${csrf(ctx)}<input type="hidden" name="to" value="paused">${input({ name: "note", label: "Pause reason", maxlength: 300, id: "pause-note" })}${button("Pause", { variant: "ghost", size: "sm" })}</form>` : ""}
${proj.status === "paused" ? actionForm(ctx, `/staff/projects/${proj.id}/resume`, `Resume (${label(proj.paused_from_status ?? "")})`, { variant: "primary" }) : ""}</div>` : ""}
${isOwner(actor) && !["completed", "maintenance", "cancelled"].includes(proj.status) ? html`<details style="margin-top:1rem"><summary>Cancel project (Owner only)</summary><form method="post" action="/staff/projects/${proj.id}/cancel" data-confirm="Cancel this customer project? This cannot be undone here.">${csrf(ctx)}${textarea({ name: "reason", label: "Reason", required: true, rows: 3, maxlength: 1000 })}${button("Cancel project", { variant: "danger" })}</form></details>` : ""}</section>
<section class="card"><h2 class="card__title">Team</h2>${dl([["Project manager", pm?.display_name ?? "Unassigned"]])}
${coord ? html`<form method="post" action="/staff/projects/${proj.id}/pm" class="row">${csrf(ctx)}${select({ name: "user_id", label: "Set project manager", options: pms.map((u) => ({ value: u.id, label: u.display_name })), value: proj.project_manager_id })}${button("Save", { variant: "secondary", size: "sm" })}</form>
<form method="post" action="/staff/projects/${proj.id}/target" class="row">${csrf(ctx)}${input({ name: "target_launch_at", label: "Target launch date", type: "date", value: proj.target_launch_at?.slice(0, 10) ?? "" })}${button("Save", { variant: "secondary", size: "sm" })}</form>` : ""}
<h3>Assigned staff</h3>${assignees.length ? html`<ul class="checklist">${assignees.map((a) => html`<li>${a.display_name} ${coord ? actionForm(ctx, `/staff/assignments/${a.id}/end`, "Remove", { variant: "ghost" }) : ""}</li>`)}</ul>` : html`<p class="muted">No additional staff assigned.</p>`}
${coord ? html`<form method="post" action="/staff/projects/${proj.id}/assign" class="row">${csrf(ctx)}${select({ name: "user_id", id: "assign-user", label: "Assign staff", options: staff.map((u) => ({ value: u.id, label: `${u.display_name} (${label(u.role_id)})` })) })}${button("Assign", { variant: "secondary", size: "sm" })}</form>` : ""}</section></div>
<section class="card" style="margin-top:1.5rem"><h2 class="card__title">Scope versions</h2>${scopes.map((s) => html`<details${s === scopes[0] ? html` open` : ""}><summary>Version ${s.version} ${s.approved_at ? badge("approved", `Approved ${fmtDay(s.approved_at)}${s.display_name ? ` by ${s.display_name}` : ""}`) : badge("pending", "Not approved")}</summary><div class="prose">${nl2br(s.scope_text)}</div></details>`)}
${coord ? html`<form method="post" action="/staff/projects/${proj.id}/scope" style="margin-top:1rem">${csrf(ctx)}${textarea({ name: "scope", label: "New scope version", rows: 5, maxlength: 20000, value: scopes[0]?.scope_text ?? "" })}<div class="row">${button("Save new version", { variant: "secondary" })}</div></form>
${scopes[0] && !scopes[0].approved_at ? html`<p class="hint">Scope is approved by the customer: request it from the Approvals tab.</p>` : ""}` : ""}</section>
<section class="card" style="margin-top:1.5rem"><h2 class="card__title">Onboarding</h2>${!onb ? html`<p class="muted">The customer has not started onboarding.</p>` : html`<p>${onb.completed_at ? badge("completed", `Submitted ${formatDateTime(onb.completed_at)}`) : badge("draft", `Draft saved ${formatDateTime(onb.updated_at)}`)}</p>
${dl(O.allFields(proj.product_id).filter((f) => onb.answers[f.name] !== undefined && f.type !== "file").map((f) => [f.label, fieldsVal(onb.answers, f)] as [string, string]))}
${(["logo", "images"] as const).filter((k) => Array.isArray(onb.answers[k])).map((k) => html`<p>${label(k)}: ${(onb.answers[k] as string[]).map((fid) => html`<a href="/files/${fid}">${fid}</a> `)}</p>`)}`}</section>`;
    } else if (tab === "plan") {
      const ms = (await db.prepare(`SELECT * FROM milestones WHERE project_id = ? ORDER BY position`).bind(proj.id).all<{ id: string; name: string; status: string; due_at: string | null; completed_at: string | null }>()).results;
      const tasks = (await db.prepare(`SELECT t.*, (SELECT group_concat(u.display_name, ', ') FROM assignments a JOIN users u ON u.id = a.user_id WHERE a.subject_type = 'task' AND a.subject_id = t.id AND a.ended_at IS NULL) AS assignees,
          (SELECT COALESCE(SUM(minutes),0) FROM time_entries te WHERE te.task_id = t.id) AS logged,
          (SELECT COUNT(*) FROM task_dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id WHERE d.task_id = t.id AND dt.status <> 'done') AS open_deps
          FROM tasks t WHERE t.project_id = ? ORDER BY t.created_at`).bind(proj.id).all<P.TaskRow & { assignees: string | null; logged: number; open_deps: number }>()).results;
      const est = tasks.reduce((s, t) => s + (t.estimate_minutes ?? 0), 0), logged = tasks.reduce((s, t) => s + t.logged, 0);
      content = html`<div class="kpis">${kpi("Tasks", `${tasks.filter((t) => t.status === "done").length} / ${tasks.length} done`)}${kpi("Estimated", `${(est / 60).toFixed(1)} h`, tasks.some((t) => t.estimate_minutes === null) ? "Some tasks have no estimate" : undefined)}${kpi("Logged", `${(logged / 60).toFixed(1)} h`)}</div>
<section class="card"><h2 class="card__title">Milestones</h2>${table(ms, [
  { header: "Milestone", cell: (m) => m.name },
  { header: "Status", cell: (m) => can(actor, "milestone.update") ? html`<form method="post" action="/staff/milestones/${m.id}" class="row">${csrf(ctx)}<select class="select" name="status" aria-label="Status for ${m.name}">${P.MILESTONE_STATUSES.map((s) => html`<option value="${s}"${s === m.status ? html` selected` : ""}>${label(s)}</option>`)}</select>${coord ? html`<input class="input" type="date" name="due_at" value="${m.due_at?.slice(0, 10) ?? ""}" aria-label="Due date for ${m.name}">` : ""}${button("Save", { variant: "ghost", size: "sm" })}</form>` : badge(m.status) },
  { header: "Due", cell: (m) => fmtDay(m.due_at) },
  { header: "", cell: (m) => coord ? actionForm(ctx, `/staff/milestones/${m.id}/delete`, "Delete", { variant: "ghost", confirm: "Delete this milestone? Its tasks are kept." }) : "" },
], { empty: html`<p class="muted">No milestones.</p>` })}
${coord ? html`<form method="post" action="/staff/projects/${proj.id}/milestones" class="filters">${csrf(ctx)}${input({ name: "name", label: "New milestone", required: true, maxlength: 120 })}${input({ name: "due_at", label: "Due", type: "date" })}${button("Add milestone", { variant: "secondary" })}</form>` : ""}</section>
<section class="card" style="margin-top:1.5rem"><h2 class="card__title">Tasks</h2>${table(tasks, [
  { header: "Task", cell: (t) => html`<a href="/staff/tasks/${t.id}">${t.title}</a>${t.open_deps ? html`<br>${badge("blocked", `${t.open_deps} open dependenc${t.open_deps === 1 ? "y" : "ies"}`)}` : ""}` },
  { header: "Milestone", cell: (t) => ms.find((m) => m.id === t.milestone_id)?.name ?? "—" },
  { header: "Assignees", cell: (t) => t.assignees ?? "—" },
  { header: "Status", cell: (t) => badge(t.status) },
  { header: "Estimate / logged", cell: (t) => `${t.estimate_minutes === null ? "—" : `${t.estimate_minutes} min`} / ${t.logged} min` },
  { header: "Due", cell: (t) => fmtDay(t.due_at) },
], { empty: html`<p class="muted">No tasks yet.</p>` })}
${coord ? html`<form method="post" action="/staff/projects/${proj.id}/tasks" style="margin-top:1rem">${csrf(ctx)}<div class="grid grid-3">${input({ name: "title", label: "New task", required: true, maxlength: 200 })}
${select({ name: "milestone_id", label: "Milestone", options: ms.map((m) => ({ value: m.id, label: m.name })), includeBlank: "None" })}
${select({ name: "assignee_id", label: "Assign to", options: (await staffUsers(ctx)).map((u) => ({ value: u.id, label: u.display_name })), includeBlank: "Unassigned" })}
${input({ name: "estimate_minutes", label: "Estimate (minutes)", type: "number", min: 0 })}${input({ name: "due_at", id: "task-due", label: "Due", type: "date" })}</div>
${textarea({ name: "description", label: "Description", rows: 2, maxlength: 5000 })}${button("Add task", { variant: "secondary" })}</form>` : ""}</section>`;
    } else if (tab === "revisions") {
      const revs = await P.listRevisions(db, proj.id);
      const cos = await P.listChangeOrders(db, proj.id);
      const usage = await P.revisionUsage(db, proj.id);
      content = html`<div class="kpis">${kpi("Allowance", proj.revision_allowance)}${kpi("Included used", usage.used)}${kpi("Billable rounds", usage.total - usage.used)}</div>
<section class="card"><h2 class="card__title">Revision queue</h2>${table(revs, [
  { header: "Round", cell: (x) => html`${x.round} ${x.included ? badge("active", "Included") : badge("requested", "Billable")}` },
  { header: "Request", cell: (x) => nl2br(x.request_text) },
  { header: "Category", cell: (x) => html`${x.customer_kind === "problem" && !x.category_at ? badge("pending", "Problem report: triage") : badge(x.category === "builder_defect" ? "active" : x.category === "scope_change" ? "requested" : "draft", REVISION_CATEGORY_LABEL[x.category ?? "customer_revision"])}${x.category_reason ? html`<br><span class="faint">${x.category_reason}</span>` : ""}
${coord && !["delivered", "approved"].includes(x.status) && x.ai_decision !== "rejected" ? html`<form method="post" action="/staff/revisions/${x.id}/classify" class="stack" style="margin-top:.5rem">${csrf(ctx)}${select({ name: "category", label: "Classify", id: `rc-${x.id}`, options: P.REVISION_CATEGORIES.map((c) => ({ value: c, label: REVISION_CATEGORY_LABEL[c] })), value: x.category ?? "customer_revision" })}${input({ name: "reason", label: "Reason (shown to the customer)", required: true, maxlength: 1000, id: `rcr-${x.id}` })}${button("Save classification", { variant: "secondary", size: "sm" })}</form>` : ""}` },
  { header: "Status", cell: (x) => badge(x.status) },
  { header: "Change order", cell: (x) => x.co_status ? html`${badge(x.co_status)} ${formatCents(x.co_price)}` : x.included ? "—" : badge("pending", "Needs proposal") },
  { header: "AI build", cell: (x) => x.ai_job_id ? html`<a href="/staff/builds/${x.ai_job_id}">${(x.ai_job_state ?? "").replace(/_/g, " ")}</a>${x.ai_preview_url ? html` · <a href="/staff/builds/${x.ai_job_id}/preview" rel="noopener noreferrer" target="_blank">preview</a>` : ""}` : "—" },
  { header: "Actions", cell: (x) => {
    if (x.status === "approved" || x.status === "delivered") return x.delivered_at ? html`<span class="faint">Delivered ${fmtDay(x.delivered_at)}</span>` : "";
    if (!x.included && !["approved", "paid", "completed"].includes(x.co_status ?? "")) {
      return coord && !x.billable_change_order_id ? html`<form method="post" action="/staff/projects/${proj.id}/change-orders">${csrf(ctx)}<input type="hidden" name="revision_id" value="${x.id}">${textarea({ name: "scope", label: "Change-order scope", rows: 2, maxlength: 5000, id: `cos-${x.id}`, value: x.request_text })}${input({ name: "price", label: "Price (USD)", required: true, id: `cop-${x.id}` })}${button("Propose change order", { size: "sm" })}</form>` : "";
    }
    return html`<form method="post" action="/staff/revisions/${x.id}/status">${csrf(ctx)}${x.status === "submitted" ? button("Start", { variant: "secondary", size: "sm", name: "status", value: "in_progress" }) : ""}${input({ name: "notes", label: "Delivery notes", maxlength: 2000, id: `rn-${x.id}` })}${button("Mark delivered", { size: "sm", name: "status", value: "delivered" })}</form>`;
  } },
], { empty: html`<p class="muted">No revision requests.</p>` })}</section>
<section class="card" style="margin-top:1.5rem"><h2 class="card__title">Change orders</h2>${table(cos, [
  { header: "Scope", cell: (c) => nl2br(c.scope_text) }, { header: "Price", cell: (c) => formatCents(c.price_cents), numeric: true }, { header: "Status", cell: (c) => badge(c.status) },
  { header: "Invoice", cell: (c) => (c.invoice_id ? badge(c.invoice_status ?? "open") : "—") }, { header: "Task", cell: (c) => (c.task_id ? html`<a href="/staff/tasks/${c.task_id}">Open task</a>` : "—") },
  { header: "Created", cell: (c) => fmtDay(c.created_at) },
], { empty: html`<p class="muted">No change orders.</p>` })}
${coord ? html`<form method="post" action="/staff/projects/${proj.id}/change-orders" style="margin-top:1rem">${csrf(ctx)}${textarea({ name: "scope", label: "New change order — additional scope", rows: 3, maxlength: 5000, required: true })}${input({ name: "price", label: "Price (USD)", required: true })}${button("Propose to customer", { variant: "secondary" })}</form>` : ""}</section>`;
    } else if (tab === "approvals") {
      const rr = await P.releaseReadiness(db, proj.id);
      const closure = await P.closureChecklist(db, proj.id);
      const approvals = (await db.prepare(`SELECT a.kind, a.decision, a.notes, a.created_at, u.display_name FROM approvals a JOIN users u ON u.id = a.decided_by WHERE a.project_id = ? ORDER BY a.created_at DESC, a.rowid DESC`).bind(proj.id).all<{ kind: string; decision: string; notes: string | null; created_at: string; display_name: string }>()).results;
      const requests = (await db.prepare(`SELECT kind, note, created_at, resolved_at FROM approval_requests WHERE project_id = ? ORDER BY created_at DESC`).bind(proj.id).all<{ kind: string; note: string | null; created_at: string; resolved_at: string | null }>()).results;
      const invoices = (await db.prepare(`SELECT id, milestone_kind, amount_cents, status, created_at FROM invoices WHERE project_id = ? ORDER BY created_at`).bind(proj.id).all<{ id: string; milestone_kind: string | null; amount_cents: number; status: string; created_at: string }>()).results;
      const deps = (await db.prepare(`SELECT d.url, d.commit_sha, d.deployed_at, u.display_name FROM customer_deployments d JOIN users u ON u.id = d.deployed_by WHERE d.project_id = ? ORDER BY d.deployed_at DESC`).bind(proj.id).all<{ url: string; commit_sha: string | null; deployed_at: string; display_name: string }>()).results;
      content = html`<section class="card card--gold"><h2 class="card__title">Customer release readiness</h2><p class="muted">Customer website launch chain (§28). Separate from Crestmont's own platform launch.</p>
${table(rr.checks, [{ header: "Check", cell: (c) => c.label }, { header: "Result", cell: (c) => badge(c.ok ? "pass" : "fail", c.ok ? "Pass" : "Missing") }, { header: "Detail", cell: (c) => c.detail }])}
<p>${rr.ready ? badge("pass", "Ready to deploy") : badge("blocked", `Blocked: ${rr.checks.filter((c) => !c.ok).length} check(s) outstanding`)}</p>
${can(ctx.actor!, "release.payment_exception") ? await paymentExceptionPanel(ctx, proj.id) : ""}</section>
<div class="grid grid-2" style="margin-top:1.5rem">
${coord ? html`<section class="card"><h2 class="card__title">Record internal approval</h2><form method="post" action="/staff/projects/${proj.id}/approvals">${csrf(ctx)}
${select({ name: "kind", label: "Check", options: P.STAFF_APPROVAL_KINDS.map((k) => ({ value: k, label: P.APPROVAL_LABELS[k] })) })}
${select({ name: "decision", label: "Decision", options: [{ value: "approved", label: "Approved" }, { value: "rejected", label: "Rejected" }] })}
${textarea({ name: "notes", label: "Evidence / notes", rows: 3, maxlength: 2000 })}${button("Record")}</form></section>
<section class="card"><h2 class="card__title">Ask the customer</h2><form method="post" action="/staff/projects/${proj.id}/request-approval">${csrf(ctx)}
${select({ name: "kind", id: "request-kind", label: "Approval", options: P.CUSTOMER_APPROVAL_KINDS.filter((k) => k !== "revision").map((k) => ({ value: k, label: P.APPROVAL_LABELS[k] })) })}
${textarea({ name: "note", label: "Message to customer", rows: 3, maxlength: 2000 })}${button("Send request", { variant: "secondary" })}</form></section>` : ""}
<section class="card"><h2 class="card__title">Payments</h2>${table(invoices, [{ header: "Invoice", cell: (i) => label(i.milestone_kind ?? "other") }, { header: "Amount", cell: (i) => formatCents(i.amount_cents), numeric: true }, { header: "Status", cell: (i) => badge(i.status) }, { header: "Issued", cell: (i) => fmtDay(i.created_at) }], { empty: html`<p class="muted">No invoices linked to this project.</p>` })}
${coord && proj.payment_schedule === "milestone_50_25_25" ? html`<div class="row" style="margin-top:1rem">${(["design_25", "prelaunch_25"] as const).filter((k) => !invoices.some((i) => i.milestone_kind === k)).map((k) => actionForm(ctx, `/staff/projects/${proj.id}/invoices`, `Issue ${k === "design_25" ? "25% design" : "25% pre-launch"} invoice`, { hidden: { kind: k } }))}</div>` : ""}</section>
<section class="card"><h2 class="card__title">Deployment</h2>${table(deps, [{ header: "URL", cell: (d) => html`<a href="${safeUrl(d.url)}" rel="noopener">${d.url}</a>` }, { header: "Commit", cell: (d) => d.commit_sha ?? "—" }, { header: "By", cell: (d) => d.display_name }, { header: "When", cell: (d) => formatDateTime(d.deployed_at) }], { empty: html`<p class="muted">No deployment recorded.</p>` })}
${coord ? rr.ready ? html`<form method="post" action="/staff/projects/${proj.id}/deployments">${csrf(ctx)}${input({ name: "url", label: "Live URL", type: "url", required: true, placeholder: "https://" })}${input({ name: "commit_sha", label: "Commit SHA (optional)", maxlength: 40 })}${button("Record deployment")}</form>`
  : html`<p class="muted">Deployment can be recorded once every readiness check passes.</p>` : ""}
</section></div>
<section class="card" style="margin-top:1.5rem" data-closure><h2 class="card__title">Project closure &amp; handoff</h2>
<p class="muted">A project is completed only when every required check passes. Customer final acceptance is tracked but not required, so an unresponsive customer cannot block closure.</p>
${table(closure.checks, [{ header: "Check", cell: (c) => html`${c.label}${c.required ? "" : html` <span class="faint">(informational)</span>`}` }, { header: "Result", cell: (c) => badge(c.ok ? "pass" : c.required ? "fail" : "pending", c.ok ? "Done" : c.required ? "Outstanding" : "Not yet") }, { header: "Detail", cell: (c) => c.detail }])}
${proj.status === "completed" || proj.status === "maintenance" ? html`<p>${badge("completed", `Completed ${formatDateTime(proj.completed_at)}`)}${proj.closure_notes ? html` <span class="faint">${proj.closure_notes}</span>` : ""}</p>`
  : coord && proj.status === "deployment" ? (closure.ready ? html`<form method="post" action="/staff/projects/${proj.id}/status">${csrf(ctx)}<input type="hidden" name="to" value="completed">${textarea({ name: "note", label: "Closure notes (optional)", rows: 2, maxlength: 300, id: "closure-note" })}<div class="form-actions">${button("Mark project completed")}</div></form>`
    : html`<p class="muted">Resolve the outstanding checks above, then complete the project here.</p>`)
  : html`<p class="faint">Closure becomes available once the project reaches Deployment.</p>`}
${coord && proj.status === "completed" ? html`<p class="faint">Move to Maintenance once the customer's maintenance plan is active.</p>` : ""}</section>
<section class="card" style="margin-top:1.5rem"><h2 class="card__title">Approval log</h2>${table(approvals, [{ header: "Approval", cell: (a) => P.APPROVAL_LABELS[a.kind] ?? a.kind }, { header: "Decision", cell: (a) => badge(a.decision) }, { header: "By", cell: (a) => a.display_name }, { header: "Notes", cell: (a) => a.notes ?? "—" }, { header: "When", cell: (a) => formatDateTime(a.created_at) }], { empty: html`<p class="muted">No approvals recorded.</p>` })}
<h3>Customer approval requests</h3>${table(requests, [{ header: "Approval", cell: (a) => P.APPROVAL_LABELS[a.kind] }, { header: "Note", cell: (a) => a.note ?? "—" }, { header: "Requested", cell: (a) => fmtDay(a.created_at) }, { header: "Status", cell: (a) => (a.resolved_at ? badge("resolved") : badge("pending_customer", "Waiting on customer")) }], { empty: html`<p class="muted">No requests sent.</p>` })}</section>`;
    } else if (tab === "messages") {
      const thread = await M.listThread(db, { userId: ctx.user!.id, organizationId: proj.organization_id, staff: true }, proj.id, { before: ctx.url.searchParams.get("before") });
      const msgs = thread.messages;
      await M.markThreadRead(db, ctx.user!.id, proj.organization_id, proj.id, true, msgs.map((m) => m.id));
      content = html`${threadEarlierNav(ctx, thread)}<div class="thread">${msgs.length ? msgs.map((m) => html`<article class="msg${m.internal ? " msg--internal" : m.author_is_staff ? " msg--staff" : ""}"><div class="msg__meta">${m.internal ? "Internal note · " : ""}${m.author_name}${m.author_is_staff ? " · Crestmont" : " · Customer"} · ${formatDateTime(m.created_at)}${!m.internal && m.author_is_staff ? (m.read_by_other_side ? " · Seen by customer" : " · Not yet read by customer") : ""}</div>${nl2br(m.body)}${m.attachment_file_id ? html`<p><a href="/files/${m.attachment_file_id}">Attachment: ${m.attachment_name ?? "file"}</a></p>` : ""}</article>`) : emptyState("No messages yet", "Start the conversation with the customer, or leave an internal note.")}</div>
<form method="post" action="/staff/projects/${proj.id}/messages" enctype="multipart/form-data" class="card" style="margin-top:1.5rem">${csrf(ctx)}${textarea({ name: "body", label: "Message", required: true, rows: 4, maxlength: 10000 })}
<div class="field"><label for="f-attachment">Attachment (optional)</label><input class="input" id="f-attachment" type="file" name="attachment"${ctx.storage ? "" : html` disabled`}></div>
${checkbox("internal", "Internal note — not visible to the customer")}<div class="form-actions">${button("Send")}</div></form>`;
    } else if (tab === "files") {
      const files = await F.listFiles(db, proj.organization_id, { projectId: proj.id, includeReplaced: true });
      content = html`${!ctx.storage ? alert("warn", "File storage is not configured, so uploads and downloads are unavailable.") : ""}
${table(files, [
  { header: "File", cell: (f) => html`<a href="/files/${f.id}">${f.filename}</a>${f.replaced_by ? html` ${badge("archived", "Superseded")}` : ""}` }, { header: "Folder", cell: (f) => f.folder ?? "—" },
  { header: "Size", cell: (f) => F.humanSize(f.size_bytes), numeric: true }, { header: "By", cell: (f) => f.uploader }, { header: "Uploaded", cell: (f) => fmtDay(f.created_at) },
  { header: "Scan", cell: (f) => F.scanLabel(f.scan_status) },
  { header: "", cell: (f) => (f.replaced_by ? "" : html`<a class="btn btn--ghost btn--sm" href="/files/${f.id}/share">Create share link</a>`) },
], { empty: html`<p class="muted">No files for this project.</p>` })}
<form method="post" action="/staff/projects/${proj.id}/files" enctype="multipart/form-data" class="card" style="margin-top:1.5rem">${csrf(ctx)}<h2 class="card__title">Share a file with the customer</h2>
<div class="field"><label for="f-file">File</label><input class="input" id="f-file" type="file" name="file" required></div>${input({ name: "folder", label: "Folder", value: "Deliverables", maxlength: 80 })}${button("Upload", { variant: "secondary", disabled: !ctx.storage })}</form>`;
    } else if (tab === "handoff") {
      const h = await db.prepare(`SELECT * FROM handoffs WHERE project_id = ?`).bind(proj.id).first<{ website_url: string | null; documentation: string | null; access_instructions: string | null; ownership_notes: string | null; training_notes: string | null; documentation_file_id: string | null; published_at: string | null; accepted_at: string | null }>();
      const files = await F.listFiles(db, proj.organization_id, { projectId: proj.id });
      content = html`<p>${h?.published_at ? badge("published", `Published ${formatDateTime(h.published_at)}`) : badge("draft", "Not published")} ${h?.accepted_at ? badge("accepted", `Accepted ${formatDateTime(h.accepted_at)}`) : ""}</p>
${coord ? html`<form method="post" action="/staff/projects/${proj.id}/handoff" class="card">${csrf(ctx)}
${input({ name: "website_url", label: "Website URL", type: "url", value: h?.website_url ?? proj.live_url ?? "" })}
${textarea({ name: "documentation", label: "Documentation", value: h?.documentation, rows: 4, maxlength: 20000 })}
${select({ name: "documentation_file_id", label: "Documentation file (optional)", options: files.map((f) => ({ value: f.id, label: f.filename })), value: h?.documentation_file_id, includeBlank: "None" })}
${textarea({ name: "access_instructions", label: "Access instructions", value: h?.access_instructions, rows: 4, maxlength: 10000, hint: "How credentials will be handed over securely. Never paste passwords here." })}
${textarea({ name: "ownership_notes", label: "Ownership records", value: h?.ownership_notes, rows: 3, maxlength: 10000 })}
${textarea({ name: "training_notes", label: "Training materials", value: h?.training_notes, rows: 3, maxlength: 10000 })}
<div class="form-actions">${button("Save draft", { variant: "secondary", name: "intent", value: "draft" })}${button(h?.published_at ? "Update published handoff" : "Publish to customer", { name: "intent", value: "publish" })}</div></form>` : h ? dl([["Website", h.website_url], ["Documentation", nl2br(h.documentation)], ["Access", nl2br(h.access_instructions)], ["Ownership", nl2br(h.ownership_notes)], ["Training", nl2br(h.training_notes)]]) : html`<p class="muted">No handoff drafted.</p>`}`;
    } else if (tab === "costs") {
      const costs = (await db.prepare(`SELECT category, amount_cents, description, incurred_on FROM project_costs WHERE project_id = ? ORDER BY incurred_on DESC`).bind(proj.id).all<{ category: string; amount_cents: number | null; description: string; incurred_on: string }>()).results;
      const labor = (await db.prepare(`SELECT COALESCE(SUM(te.minutes),0) AS mins, SUM(CASE WHEN te.hourly_cost_cents IS NULL THEN 0 ELSE te.minutes * te.hourly_cost_cents END) AS cost_x60, SUM(te.hourly_cost_cents IS NULL) AS unknown FROM time_entries te JOIN tasks t ON t.id = te.task_id WHERE t.project_id = ?`).bind(proj.id).first<{ mins: number; cost_x60: number | null; unknown: number | null }>())!;
      const known = costs.filter((c) => c.amount_cents !== null).reduce((s, c) => s + c.amount_cents!, 0);
      const unknown = costs.filter((c) => c.amount_cents === null).length;
      content = html`<div class="kpis">${kpi("Recorded costs", formatCents(known), unknown ? `${unknown} cost(s) unknown` : undefined)}${kpi("Labor time", `${(labor.mins / 60).toFixed(1)} h`)}
${kpi("Labor cost (known rates)", labor.mins ? formatCents(Math.round((labor.cost_x60 ?? 0) / 60)) : "—", labor.unknown ? `${labor.unknown} entr${labor.unknown === 1 ? "y" : "ies"} with unknown rate` : undefined)}</div>
${table(costs, [{ header: "Date", cell: (c) => c.incurred_on }, { header: "Category", cell: (c) => label(c.category) }, { header: "Description", cell: (c) => c.description }, { header: "Amount", cell: (c) => formatCents(c.amount_cents), numeric: true }], { empty: html`<p class="muted">No costs recorded.</p>` })}
${coord ? html`<form method="post" action="/staff/projects/${proj.id}/costs" class="card" style="margin-top:1.5rem">${csrf(ctx)}<div class="grid grid-3">${select({ name: "category", label: "Category", options: [...P.COST_CATEGORIES] })}
${input({ name: "amount", label: "Amount (USD)", hint: "Leave blank if unknown — it will show as Unknown, never $0." })}${input({ name: "incurred_on", label: "Date", type: "date", required: true, value: ctx.now().toISOString().slice(0, 10) })}</div>
${input({ name: "description", label: "Description", required: true, maxlength: 300 })}${button("Record cost", { variant: "secondary" })}</form>` : ""}`;
    } else {
      const hist = await P.projectHistory(db, proj.id, false, 100);
      content = hist.length ? html`<ul class="timeline">${hist.map((h) => html`<li>${P.describeHistory(h)} <span class="faint">(${h.action})</span><br><span class="faint">${formatDateTime(h.created_at)} · ${h.actor_name ?? label(h.actor_kind)}</span></li>`)}</ul>` : html`<p class="muted">No activity.</p>`;
    }
    return page(ctx, proj.name, html`${pageHead(proj.name, badge(proj.status), `${org.name} · ${proj.id}`)}${tabNav}${formErrors(errors)}${content}`, status);
  };

  r.get("/staff/projects/:id", async (ctx, p) => {
    requireStaff(ctx, "delivery.access");
    const t = ctx.url.searchParams.get("tab") as Tab | null;
    return projectPage(ctx, p.id, t && (TABS as readonly string[]).includes(t) ? t : "overview");
  });

  /** Runs a staff action; business-rule failures (409/422) re-render the tab with the error. */
  const act = async (ctx: AppContext, projectId: string, tab: Tab, fn: () => Promise<string>, perm: "project.coordinate" | "delivery.access" = "project.coordinate") => {
    requireStaff(ctx, perm);
    await P.getStaffProject(ctx, projectId);
    try {
      const text = await fn();
      return redirect(ctx, `/staff/projects/${projectId}${tab === "overview" ? "" : `?tab=${tab}`}`, { kind: "success", text });
    } catch (e) {
      if (e instanceof HttpError && (e.status === 409 || e.status === 422)) return projectPage(ctx, projectId, tab, [e.message], e.status);
      if (e instanceof M.MessageError || e instanceof F.UploadError) return projectPage(ctx, projectId, tab, [e.message], 422);
      throw e;
    }
  };

  r.post("/staff/projects/:id/status", async (ctx, p) => {
    const f = await ctx.form();
    const to = str(f, "to") as ProjectStatus;
    return act(ctx, p.id, to === "completed" ? "approvals" : "overview", async () => {
      if (!(PROJECT_STATUSES as readonly string[]).includes(to)) throw new HttpError(422, "Unknown status");
      await P.changeProjectStatus(ctx, p.id, to, { actorUserId: ctx.user!.id, actorKind: "user", note: str(f, "note") || undefined });
      return to === "paused" ? "Project paused. The customer was notified." : `Project moved to ${label(to)}.`;
    });
  });
  r.post("/staff/projects/:id/resume", async (ctx, p) => act(ctx, p.id, "overview", async () => `Project resumed (${label(await P.resumeProject(ctx, p.id, { actorUserId: ctx.user!.id, actorKind: "user" }))}).`));
  r.post("/staff/projects/:id/cancel", async (ctx, p) => {
    const reason = str(await ctx.form(), "reason");
    return act(ctx, p.id, "overview", async () => { await P.cancelProject(ctx, ctx.actor!, p.id, reason); return "Project cancelled."; }, "delivery.access");
  });
  r.post("/staff/projects/:id/pm", async (ctx, p) => {
    const uid = str(await ctx.form(), "user_id");
    return act(ctx, p.id, "overview", async () => { await P.setProjectManager(ctx, ctx.actor!, p.id, uid); return "Project manager updated."; });
  });
  r.post("/staff/projects/:id/target", async (ctx, p) => {
    const d = str(await ctx.form(), "target_launch_at");
    return act(ctx, p.id, "overview", async () => {
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(422, "Date must be YYYY-MM-DD.");
      const proj = (await P.getProject(ctx.db, p.id))!;
      await ctx.db.prepare(`UPDATE projects SET target_launch_at = ?, updated_at = ? WHERE id = ?`).bind(d || null, new Date().toISOString(), p.id).run();
      await audit(ctx.db, { actorUserId: ctx.user!.id, action: "project.target_launch_set", subjectType: "project", subjectId: p.id, organizationId: proj.organization_id, details: { date: d || null } });
      return "Target launch date saved.";
    });
  });
  r.post("/staff/projects/:id/assign", async (ctx, p) => {
    const uid = str(await ctx.form(), "user_id");
    return act(ctx, p.id, "overview", async () => { await P.assign(ctx, ctx.actor!, "project", p.id, uid); return "Staff assigned."; });
  });
  r.post("/staff/assignments/:id/end", async (ctx, p) => {
    requireStaff(ctx, "project.coordinate");
    const a = await ctx.db.prepare(`SELECT subject_type, subject_id FROM assignments WHERE id = ?`).bind(p.id).first<{ subject_type: string; subject_id: string }>();
    if (!a) throw new HttpError(404, "Assignment not found");
    await P.unassign(ctx.db, ctx.actor!, p.id);
    return redirect(ctx, a.subject_type === "task" ? `/staff/tasks/${a.subject_id}` : `/staff/projects/${a.subject_id}`, { kind: "success", text: "Assignment removed." });
  });
  r.post("/staff/projects/:id/scope", async (ctx, p) => {
    const s = str(await ctx.form(), "scope");
    return act(ctx, p.id, "overview", async () => `Scope version ${await P.addScopeVersion(ctx, ctx.actor!, p.id, s)} saved. Request customer approval from the Approvals tab.`);
  });
  r.post("/staff/projects/:id/request-approval", async (ctx, p) => {
    const f = await ctx.form();
    return act(ctx, p.id, "approvals", async () => {
      const kind = str(f, "kind") as P.CustomerApprovalKind;
      if (!(P.CUSTOMER_APPROVAL_KINDS as readonly string[]).includes(kind)) throw new HttpError(422, "Unknown approval type");
      await P.requestCustomerApproval(ctx, ctx.actor!, p.id, kind, str(f, "note"));
      return "Approval requested. The customer was notified.";
    });
  });
  r.post("/staff/projects/:id/approvals", async (ctx, p) => {
    const f = await ctx.form();
    return act(ctx, p.id, "approvals", async () => {
      await P.recordStaffApproval(ctx, ctx.actor!, p.id, str(f, "kind") as P.StaffApprovalKind, str(f, "decision") === "approved" ? "approved" : "rejected", str(f, "notes"));
      return "Approval recorded.";
    });
  });
  // FD-16: Founder-only launch/payment exception (step-up MFA via src/app/step-up.ts).
  r.post("/staff/projects/:id/payment-exception", async (ctx, p) => {
    requireStaff(ctx, "release.payment_exception");
    const f = await ctx.form();
    const revoke = str(f, "intent") === "revoke";
    return act(ctx, p.id, "approvals", async () => {
      if (revoke) { await P.revokePaymentException(ctx.db, ctx.actor!, p.id, str(f, "reason")); return "Payment exception revoked; the payment check applies again."; }
      await P.grantPaymentException(ctx.db, ctx.actor!, p.id, str(f, "reason"));
      return "Payment exception recorded. Every other release check still applies.";
    });
  });
  r.post("/staff/projects/:id/invoices", async (ctx, p) => {
    const kind = str(await ctx.form(), "kind");
    return act(ctx, p.id, "approvals", async () => {
      if (kind !== "design_25" && kind !== "prelaunch_25") throw new HttpError(422, "Unknown milestone invoice");
      await P.issueProjectMilestoneInvoice(ctx, ctx.actor!, p.id, kind);
      return "Milestone invoice issued to the customer.";
    });
  });
  r.post("/staff/projects/:id/deployments", async (ctx, p) => {
    const f = await ctx.form();
    return act(ctx, p.id, "approvals", async () => { await P.recordDeployment(ctx, ctx.actor!, p.id, str(f, "url"), str(f, "commit_sha") || null); return "Deployment recorded."; });
  });
  r.post("/staff/projects/:id/handoff", async (ctx, p) => {
    const f = await ctx.form();
    return act(ctx, p.id, "handoff", async () => {
      const publish = str(f, "intent") === "publish";
      await P.saveHandoff(ctx, ctx.actor!, p.id, { website_url: str(f, "website_url"), documentation: str(f, "documentation"), access_instructions: str(f, "access_instructions"), ownership_notes: str(f, "ownership_notes"), training_notes: str(f, "training_notes"), documentation_file_id: str(f, "documentation_file_id") || null }, publish);
      return publish ? "Handoff published to the customer." : "Handoff draft saved.";
    });
  });
  r.post("/staff/projects/:id/costs", async (ctx, p) => {
    const f = await ctx.form();
    return act(ctx, p.id, "costs", async () => { await P.addProjectCost(ctx.db, ctx.actor!, p.id, { category: str(f, "category"), amountCents: centsOrNull(str(f, "amount")), description: str(f, "description"), incurredOn: str(f, "incurred_on") }); return "Cost recorded."; });
  });
  r.post("/staff/projects/:id/change-orders", async (ctx, p) => {
    const f = await ctx.form();
    return act(ctx, p.id, "revisions", async () => {
      const price = centsOrNull(str(f, "price"));
      if (price === null) throw new HttpError(422, "Enter a price for the change order.");
      await P.proposeChangeOrder(ctx, ctx.actor!, p.id, { scope: str(f, "scope"), priceCents: price, revisionId: str(f, "revision_id") || null });
      return "Change order proposed. The customer was asked to approve it.";
    });
  });
  r.post("/staff/revisions/:id/classify", async (ctx, p) => {
    requireStaff(ctx, "delivery.access");
    if (!can(ctx.actor!, "project.coordinate")) throw new HttpError(403, "Only a project coordinator can classify revision requests.");
    const f = await ctx.form();
    const rev = await ctx.db.prepare(`SELECT project_id FROM revisions WHERE id = ?`).bind(p.id).first<{ project_id: string }>();
    if (!rev) throw new HttpError(404, "Revision not found");
    return act(ctx, rev.project_id, "revisions", async () => {
      const res = await P.classifyRevision(ctx.db, ctx.actor!, p.id, str(f, "category") as P.RevisionCategory, str(f, "reason"));
      return res.included ? "Classification saved." : "Classification saved. This request needs an approved change order before work starts.";
    });
  });
  r.post("/staff/revisions/:id/status", async (ctx, p) => {
    requireStaff(ctx, "delivery.access");
    // Authorize before validating input (record-level visibility is checked again in updateRevisionStatus).
    if (!can(ctx.actor!, "project.coordinate") && !can(ctx.actor!, "task.update_assigned")) throw new HttpError(403, "You cannot update revisions.");
    const f = await ctx.form();
    const rev = await ctx.db.prepare(`SELECT project_id FROM revisions WHERE id = ?`).bind(p.id).first<{ project_id: string }>();
    if (!rev) throw new HttpError(404, "Revision not found");
    return act(ctx, rev.project_id, "revisions", async () => {
      const s = str(f, "status");
      if (s !== "in_progress" && s !== "delivered") throw new HttpError(422, "Unknown revision status");
      await P.updateRevisionStatus(ctx, ctx.actor!, ctx.user!.id, p.id, s, str(f, "notes"));
      return s === "delivered" ? "Revision delivered. The customer was asked to review it." : "Revision started.";
    }, "delivery.access");
  });
  r.post("/staff/projects/:id/messages", async (ctx, p) => {
    const f = await ctx.form();
    return act(ctx, p.id, "messages", async () => {
      const proj = (await P.getProject(ctx.db, p.id))!;
      const att = f.get("attachment");
      const internal = !!f.get("internal");
      await M.postMessage(ctx, { organizationId: proj.organization_id, projectId: proj.id, authorUserId: ctx.user!.id, body: str(f, "body"), attachment: att && typeof att !== "string" ? att : null, internal, fromStaff: true });
      return internal ? "Internal note saved." : "Message sent to the customer.";
    }, "delivery.access");
  });
  r.post("/staff/projects/:id/files", async (ctx, p) => {
    const f = await ctx.form();
    return act(ctx, p.id, "files", async () => {
      const proj = (await P.getProject(ctx.db, p.id))!;
      const file = f.get("file");
      if (!file || typeof file === "string" || file.size === 0) throw new HttpError(422, "Choose a file.");
      const row = await F.storeUpload(ctx, { organizationId: proj.organization_id, projectId: proj.id, file, uploadedBy: ctx.user!.id, folder: str(f, "folder") });
      return `${row.filename} shared with the customer.`;
    }, "delivery.access");
  });

  // ── Milestones ──
  r.post("/staff/projects/:id/milestones", async (ctx, p) => {
    const f = await ctx.form();
    return act(ctx, p.id, "plan", async () => { await P.createMilestone(ctx.db, ctx.actor!, p.id, str(f, "name"), dateOrNull(str(f, "due_at"))); return "Milestone added."; });
  });
  r.post("/staff/milestones/:id", async (ctx, p) => {
    requireStaff(ctx, "milestone.update");
    const f = await ctx.form();
    const m = await ctx.db.prepare(`SELECT project_id FROM milestones WHERE id = ?`).bind(p.id).first<{ project_id: string }>();
    if (!m) throw new HttpError(404, "Milestone not found");
    return act(ctx, m.project_id, "plan", async () => {
      const patch: { status?: string; dueAt?: string | null; name?: string } = { status: str(f, "status") || undefined };
      if (f.has("due_at") && can(ctx.actor!, "project.coordinate")) patch.dueAt = dateOrNull(str(f, "due_at"));
      if (str(f, "name")) patch.name = str(f, "name");
      await P.updateMilestone(ctx.db, ctx.actor!, ctx.user!.id, p.id, patch);
      return "Milestone updated.";
    }, "delivery.access");
  });
  r.post("/staff/milestones/:id/delete", async (ctx, p) => {
    requireStaff(ctx, "project.coordinate");
    const pid = await P.deleteMilestone(ctx.db, ctx.actor!, p.id);
    return redirect(ctx, `/staff/projects/${pid}?tab=plan`, { kind: "success", text: "Milestone deleted." });
  });

  // ── Tasks ──
  r.post("/staff/projects/:id/tasks", async (ctx, p) => {
    const f = await ctx.form();
    return act(ctx, p.id, "plan", async () => {
      const id = await P.createTask(ctx.db, ctx.actor!, p.id, { title: str(f, "title"), description: str(f, "description"), milestoneId: str(f, "milestone_id") || null, estimateMinutes: intOrNull(str(f, "estimate_minutes")), dueAt: dateOrNull(str(f, "due_at")) });
      if (str(f, "assignee_id")) await P.assign(ctx, ctx.actor!, "task", id, str(f, "assignee_id"));
      return "Task added.";
    });
  });

  type TaskListRow = { id: string; title: string; status: string; due_at: string | null; estimate_minutes: number | null; completed_at: string | null; created_at: string; project_id: string; project_name: string; milestone: string | null; assignees: string | null; logged: number; open_deps: number };
  const taskQuery = (ctx: AppContext) => {
    const q = ctx.url.searchParams;
    const me = ctx.user!.id, actor = ctx.actor!;
    const status = q.get("status") ?? "open", projectId = q.get("project") ?? "", assignee = q.get("assignee") ?? (can(actor, "project.read_all") ? "" : "me"), due = q.get("due") ?? "";
    const search = (q.get("q") ?? "").trim().slice(0, 100);
    const where: string[] = [], binds: unknown[] = [];
    const vis = P.visibleProjectsSql(actor, me);
    where.push(vis.sql); binds.push(...vis.binds);
    if (!can(actor, "project.coordinate") && !can(actor, "project.read_all")) {
      where.push(`EXISTS (SELECT 1 FROM assignments a WHERE a.subject_type = 'task' AND a.subject_id = t.id AND a.user_id = ? AND a.ended_at IS NULL)`); binds.push(me);
    }
    if (status === "open") where.push("t.status <> 'done'"); else if ((P.TASK_STATUSES as readonly string[]).includes(status)) { where.push("t.status = ?"); binds.push(status); }
    if (projectId) { where.push("t.project_id = ?"); binds.push(projectId); }
    if (assignee === "unassigned") where.push(`NOT EXISTS (SELECT 1 FROM assignments a WHERE a.subject_type = 'task' AND a.subject_id = t.id AND a.ended_at IS NULL)`);
    else if (assignee) { where.push(`EXISTS (SELECT 1 FROM assignments a WHERE a.subject_type = 'task' AND a.subject_id = t.id AND a.user_id = ? AND a.ended_at IS NULL)`); binds.push(assignee === "me" ? me : assignee); }
    const today = ctx.now().toISOString().slice(0, 10);
    if (due === "overdue") { where.push("t.due_at < ? AND t.status <> 'done'"); binds.push(today); }
    if (due === "week") { where.push("t.due_at BETWEEN ? AND ?"); binds.push(today, new Date(ctx.now().getTime() + 7 * 86400e3).toISOString().slice(0, 10)); }
    if (due === "none") where.push("t.due_at IS NULL");
    if (q.get("blocked") === "1") where.push(`EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id WHERE d.task_id = t.id AND dt.status <> 'done')`);
    if (search) { const like = `%${search.replace(/[\\%_]/g, (m) => "\\" + m)}%`; where.push(`(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR t.id = ?)`); binds.push(like, like, like, search); }
    const sql = `SELECT t.id, t.title, t.status, t.due_at, t.estimate_minutes, t.completed_at, t.created_at, p.id AS project_id, p.name AS project_name, m.name AS milestone,
        (SELECT group_concat(u.display_name, ', ') FROM assignments a JOIN users u ON u.id = a.user_id WHERE a.subject_type = 'task' AND a.subject_id = t.id AND a.ended_at IS NULL) AS assignees,
        (SELECT COALESCE(SUM(minutes),0) FROM time_entries te WHERE te.task_id = t.id) AS logged,
        (SELECT COUNT(*) FROM task_dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id WHERE d.task_id = t.id AND dt.status <> 'done') AS open_deps
        FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN milestones m ON m.id = t.milestone_id WHERE ${where.join(" AND ")} ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at, t.created_at, t.id`;
    return { sql, binds, today, v: { status, projectId, assignee, due, search, blocked: q.get("blocked") === "1" } };
  };
  r.get("/staff/tasks/export.csv", async (ctx) => {
    requireStaff(ctx, "delivery.access");
    const tq = taskQuery(ctx);
    const rows = (await ctx.db.prepare(`${tq.sql} LIMIT 20000`).bind(...tq.binds).all<TaskListRow>()).results;
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "task.exported", subjectType: "task", details: { count: rows.length, filter: tq.v } });
    const csv = toCsv(["task_id", "title", "project_id", "project", "milestone", "status", "assignees", "due_date", "overdue", "estimate_minutes", "logged_minutes", "open_dependencies", "created_date", "completed_date"],
      rows.map((t) => [t.id, t.title, t.project_id, t.project_name, t.milestone ?? "", t.status, t.assignees ?? "", t.due_at?.slice(0, 10) ?? "", t.due_at && t.due_at.slice(0, 10) < tq.today && t.status !== "done" ? "yes" : "no",
        t.estimate_minutes ?? "", t.logged, t.open_deps, t.created_at.slice(0, 10), t.completed_at?.slice(0, 10) ?? ""]));
    return download(ctx, csv, `crestmont-tasks-${tq.today}.csv`, "text/csv; charset=utf-8");
  });
  r.get("/staff/tasks", async (ctx) => {
    requireStaff(ctx, "delivery.access");
    const actor = ctx.actor!;
    const tq = taskQuery(ctx);
    const { status, projectId, assignee, due, search, blocked } = tq.v;
    const today = tq.today;
    const { page: pageNo, limit, offset } = pageParam(ctx);
    const rows = (await ctx.db.prepare(`${tq.sql} LIMIT ? OFFSET ?`).bind(...tq.binds, limit + 1, offset).all<TaskListRow>()).results;
    const hasNext = rows.length > limit;
    if (hasNext) rows.length = limit;
    const vis = P.visibleProjectsSql(actor, ctx.user!.id);
    const projects = (await ctx.db.prepare(`SELECT p.id, p.name FROM projects p WHERE ${vis.sql} AND p.status NOT IN ('cancelled') ORDER BY p.name`).bind(...vis.binds).all<{ id: string; name: string }>()).results;
    const people = can(actor, "project.read_all") ? await staffUsers(ctx) : [];
    const exportHref = (() => { const u = new URL(ctx.url); u.pathname = "/staff/tasks/export.csv"; u.searchParams.delete("page"); return u.pathname + u.search; })();
    const body = html`${pageHead("Tasks", linkButton("Export CSV", exportHref, "ghost", "sm"))}<form method="get" action="/staff/tasks" class="filters">
${input({ name: "q", label: "Search", value: search, placeholder: "Task, description or project" })}
${select({ name: "status", label: "Status", options: [{ value: "open", label: "Open" }, { value: "all", label: "All" }, ...P.TASK_STATUSES.map((s) => ({ value: s, label: label(s) }))], value: status })}
${select({ name: "project", label: "Project", options: projects.map((x) => ({ value: x.id, label: x.name })), value: projectId, includeBlank: "All projects" })}
${select({ name: "assignee", label: "Assignee", options: [{ value: "me", label: "Me" }, ...(can(actor, "project.read_all") ? [{ value: "unassigned", label: "Unassigned" }] : []), ...people.map((u) => ({ value: u.id, label: u.display_name }))], value: assignee, includeBlank: "Anyone" })}
${select({ name: "due", label: "Due", options: [{ value: "overdue", label: "Overdue" }, { value: "week", label: "Next 7 days" }, { value: "none", label: "No due date" }], value: due, includeBlank: "Any time" })}
${checkbox("blocked", "Waiting on a dependency", { checked: blocked, value: "1" })}${button("Filter", { variant: "secondary" })}</form>
${table(rows, [
  { header: "Task", cell: (t) => html`<a href="/staff/tasks/${t.id}">${t.title}</a>${t.open_deps ? html`<br>${badge("blocked", `Waiting on ${t.open_deps} task${t.open_deps === 1 ? "" : "s"}`)}` : ""}` },
  { header: "Project", cell: (t) => html`<a href="/staff/projects/${t.project_id}?tab=plan">${t.project_name}</a>${t.milestone ? html`<br><span class="faint">${t.milestone}</span>` : ""}` },
  { header: "Assignees", cell: (t) => t.assignees ?? html`<span class="faint">Unassigned</span>` },
  { header: "Status", cell: (t) => badge(t.status) },
  { header: "Estimate / logged", cell: (t) => `${t.estimate_minutes === null ? "—" : `${(t.estimate_minutes / 60).toFixed(1)} h`} / ${(t.logged / 60).toFixed(1)} h` },
  { header: "Due", cell: (t) => (t.due_at ? html`${fmtDay(t.due_at)}${t.due_at.slice(0, 10) < today && t.status !== "done" ? html` ${badge("past_due", "Overdue")}` : ""}` : "—") },
], { empty: emptyState("No tasks match", search || projectId || due || blocked ? "Try a different search or filter." : "Tasks appear here when a project manager assigns them.") })}
${pagination(ctx, pageNo, hasNext)}`;
    return page(ctx, "Tasks", body);
  });

  const taskPage = async (ctx: AppContext, id: string, errors: string[] = [], status = 200) => {
    requireStaff(ctx, "delivery.access");
    const t = await P.getTask(ctx.db, id);
    if (!t) throw new HttpError(404, "Task not found");
    // CREST-GAP-044: the task exists but is no longer visible to this person (unassigned or removed from the
    // project). Explain instead of a bare 404; nothing about the task or project is revealed. Unknown ids still 404,
    // and so do tasks the person never had any link to (no past assignment or notification), so ids cannot be probed.
    if (!(await P.staffCanSeeProject(ctx.db, ctx.actor!, ctx.user!.id, t.project_id))) {
      const hadLink = await ctx.db.prepare(`SELECT 1 FROM assignments WHERE subject_type = 'task' AND subject_id = ?1 AND user_id = ?2
          UNION ALL SELECT 1 FROM notifications WHERE subject_type = 'task' AND subject_id = ?1 AND user_id = ?2 LIMIT 1`).bind(t.id, ctx.user!.id).first();
      if (!hadLink) throw new HttpError(404, "Project not found");
      return page(ctx, "No access to this task", html`${pageHead("You no longer have access to this task")}
${alert("info", html`This task exists, but it is not assigned to you and you are not on its project team any more — for example, you were unassigned or the project was reassigned. If you still need it, ask the project manager to add you again.`)}
<p>${linkButton("Back to my work", "/staff", "secondary", "sm")} ${linkButton("Notifications", "/staff/notifications", "ghost", "sm")}</p>`, 403);
    }
    const proj = await P.getStaffProject(ctx, t.project_id);
    const actor = ctx.actor!, coord = can(actor, "project.coordinate");
    const assigned = await P.isAssignedToTask(ctx.db, ctx.user!.id, t.id);
    const canEdit = coord || (can(actor, "task.update_assigned") && assigned);
    const deps = (await ctx.db.prepare(`SELECT tt.id, tt.title, tt.status FROM task_dependencies d JOIN tasks tt ON tt.id = d.depends_on_task_id WHERE d.task_id = ?`).bind(t.id).all<{ id: string; title: string; status: string }>()).results;
    const dependents = (await ctx.db.prepare(`SELECT tt.id, tt.title, tt.status FROM task_dependencies d JOIN tasks tt ON tt.id = d.task_id WHERE d.depends_on_task_id = ?`).bind(t.id).all<{ id: string; title: string; status: string }>()).results;
    const siblings = coord ? (await ctx.db.prepare(`SELECT id, title FROM tasks WHERE project_id = ? AND id <> ? ORDER BY created_at`).bind(t.project_id, t.id).all<{ id: string; title: string }>()).results : [];
    const assignees = (await ctx.db.prepare(`SELECT a.id, u.display_name FROM assignments a JOIN users u ON u.id = a.user_id WHERE a.subject_type = 'task' AND a.subject_id = ? AND a.ended_at IS NULL`).bind(t.id).all<{ id: string; display_name: string }>()).results;
    const time = (await ctx.db.prepare(`SELECT te.minutes, te.hourly_cost_cents, te.worked_on, u.display_name FROM time_entries te JOIN users u ON u.id = te.user_id WHERE te.task_id = ? ORDER BY te.worked_on DESC`).bind(t.id).all<{ minutes: number; hourly_cost_cents: number | null; worked_on: string; display_name: string }>()).results;
    const ms = coord ? (await ctx.db.prepare(`SELECT id, name FROM milestones WHERE project_id = ? ORDER BY position`).bind(t.project_id).all<{ id: string; name: string }>()).results : [];
    const flag = await disabledOwnerFlag(ctx.db, ["task"], t.id);
    const body = html`${pageHead(t.title, badge(t.status), proj.name)}${formErrors(errors)}${(flag ? alert("warn", html`<strong>Owner disabled.</strong> ${flag.name}'s account was disabled; ${flag.status === "ended" ? "their assignment was ended, so this needs a new owner." : "this is waiting in the offboarding queue for a new owner."}`) : "")}
<div class="grid grid-2"><section class="card">${dl([["Project", html`<a href="/staff/projects/${proj.id}?tab=plan">${proj.name}</a>`], ["Status", badge(t.status)], ["Estimate", t.estimate_minutes === null ? "Not estimated" : `${t.estimate_minutes} min`], ["Due", fmtDay(t.due_at)], ["Completed", formatDateTime(t.completed_at)], ["Assignees", assignees.map((a) => a.display_name).join(", ") || "Unassigned"]])}
${t.description ? html`<div class="prose">${nl2br(t.description)}</div>` : ""}
${canEdit ? html`<form method="post" action="/staff/tasks/${t.id}/status" class="row" style="margin-top:1rem">${csrf(ctx)}${select({ name: "status", label: "Status", options: [...P.TASK_STATUSES], value: t.status })}${button("Update status", { size: "sm" })}</form>` : html`<p class="faint">Only assignees and project managers can update this task.</p>`}</section>
<section class="card"><h2 class="card__title">Dependencies</h2>${deps.length ? html`<ul class="checklist">${deps.map((d) => html`<li><a href="/staff/tasks/${d.id}">${d.title}</a> ${badge(d.status)} ${coord ? actionForm(ctx, `/staff/tasks/${t.id}/dependencies/${d.id}/delete`, "Remove", { variant: "ghost" }) : ""}</li>`)}</ul>` : html`<p class="muted">No dependencies.</p>`}
${dependents.length ? html`<p class="faint">Blocks: ${dependents.map((d) => html`<a href="/staff/tasks/${d.id}">${d.title}</a> `)}</p>` : ""}
${coord && siblings.length ? html`<form method="post" action="/staff/tasks/${t.id}/dependencies" class="row">${csrf(ctx)}${select({ name: "depends_on", label: "Depends on", options: siblings.map((s) => ({ value: s.id, label: s.title })) })}${button("Add", { variant: "secondary", size: "sm" })}</form>` : ""}</section>
<section class="card"><h2 class="card__title">Time</h2>${table(time, [{ header: "Date", cell: (x) => x.worked_on }, { header: "Who", cell: (x) => x.display_name }, { header: "Minutes", cell: (x) => x.minutes, numeric: true }, { header: "Hourly cost", cell: (x) => formatCents(x.hourly_cost_cents) }], { empty: html`<p class="muted">No time logged.</p>` })}
${canEdit ? html`<form method="post" action="/staff/tasks/${t.id}/time" class="filters">${csrf(ctx)}${input({ name: "minutes", label: "Minutes", type: "number", min: 1, max: 1440, required: true })}${input({ name: "worked_on", label: "Date", type: "date", required: true, value: ctx.now().toISOString().slice(0, 10) })}
${coord ? input({ name: "hourly_cost", label: "Hourly cost (USD)", hint: "Blank = unknown" }) : ""}${button("Log time", { variant: "secondary" })}</form>` : ""}</section>
${coord ? html`<section class="card"><h2 class="card__title">Edit task</h2><form method="post" action="/staff/tasks/${t.id}">${csrf(ctx)}${input({ name: "title", label: "Title", value: t.title, required: true, maxlength: 200 })}${textarea({ name: "description", label: "Description", value: t.description, rows: 3, maxlength: 5000 })}
<div class="grid grid-3">${input({ name: "estimate_minutes", label: "Estimate (minutes)", type: "number", min: 0, value: t.estimate_minutes })}${input({ name: "due_at", label: "Due", type: "date", value: t.due_at?.slice(0, 10) ?? "" })}${select({ name: "milestone_id", label: "Milestone", options: ms.map((m) => ({ value: m.id, label: m.name })), value: t.milestone_id, includeBlank: "None" })}</div>${button("Save", { variant: "secondary" })}</form>
<h3>Assignees</h3>${assignees.map((a) => html`<p>${a.display_name} ${actionForm(ctx, `/staff/assignments/${a.id}/end`, "Remove", { variant: "ghost" })}</p>`)}
<form method="post" action="/staff/tasks/${t.id}/assign" class="row">${csrf(ctx)}${select({ name: "user_id", label: "Assign", options: (await staffUsers(ctx)).map((u) => ({ value: u.id, label: u.display_name })) })}${button("Assign", { variant: "secondary", size: "sm" })}</form>
<div style="margin-top:1rem">${actionForm(ctx, `/staff/tasks/${t.id}/delete`, "Delete task", { variant: "danger", confirm: "Delete this task?" })}</div></section>` : ""}</div>`;
    return page(ctx, t.title, body, status);
  };
  const taskAct = async (ctx: AppContext, id: string, fn: () => Promise<string>) => {
    requireStaff(ctx, "delivery.access");
    const t = await P.getTask(ctx.db, id);
    if (!t) throw new HttpError(404, "Task not found");
    await P.getStaffProject(ctx, t.project_id);
    try {
      return redirect(ctx, `/staff/tasks/${id}`, { kind: "success", text: await fn() });
    } catch (e) {
      if (e instanceof HttpError && (e.status === 409 || e.status === 422)) return taskPage(ctx, id, [e.message], e.status);
      throw e;
    }
  };
  r.get("/staff/tasks/:id", async (ctx, p) => taskPage(ctx, p.id));
  r.post("/staff/tasks/:id/status", async (ctx, p) => {
    const s = str(await ctx.form(), "status");
    return taskAct(ctx, p.id, async () => { await P.setTaskStatus(ctx.db, ctx.actor!, ctx.user!.id, p.id, s); return `Task marked ${label(s)}.`; });
  });
  r.post("/staff/tasks/:id", async (ctx, p) => {
    const f = await ctx.form();
    return taskAct(ctx, p.id, async () => {
      await P.updateTask(ctx.db, ctx.actor!, ctx.user!.id, p.id, { title: str(f, "title"), description: str(f, "description"), estimateMinutes: intOrNull(str(f, "estimate_minutes")), dueAt: dateOrNull(str(f, "due_at")), milestoneId: str(f, "milestone_id") || null });
      return "Task saved.";
    });
  });
  r.post("/staff/tasks/:id/delete", async (ctx, p) => {
    requireStaff(ctx, "project.coordinate");
    const t = await P.getTask(ctx.db, p.id);
    if (!t) throw new HttpError(404, "Task not found");
    try {
      const pid = await P.deleteTask(ctx.db, ctx.actor!, p.id);
      return redirect(ctx, `/staff/projects/${pid}?tab=plan`, { kind: "success", text: "Task deleted." });
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) return taskPage(ctx, p.id, [e.message], 409);
      throw e;
    }
  });
  r.post("/staff/tasks/:id/dependencies", async (ctx, p) => {
    const dep = str(await ctx.form(), "depends_on");
    return taskAct(ctx, p.id, async () => { await P.addDependency(ctx.db, ctx.actor!, p.id, dep); return "Dependency added."; });
  });
  r.post("/staff/tasks/:id/dependencies/:dep/delete", async (ctx, p) => taskAct(ctx, p.id, async () => { await P.removeDependency(ctx.db, ctx.actor!, p.id, p.dep); return "Dependency removed."; }));
  r.post("/staff/tasks/:id/time", async (ctx, p) => {
    const f = await ctx.form();
    return taskAct(ctx, p.id, async () => {
      await P.logTime(ctx.db, ctx.actor!, ctx.user!.id, p.id, { minutes: intOrNull(str(f, "minutes")) ?? 0, workedOn: str(f, "worked_on"), hourlyCostCents: centsOrNull(str(f, "hourly_cost")) });
      return "Time logged.";
    });
  });
  r.post("/staff/tasks/:id/assign", async (ctx, p) => {
    const uid = str(await ctx.form(), "user_id");
    return taskAct(ctx, p.id, async () => { await P.assign(ctx, ctx.actor!, "task", p.id, uid); return "Assigned."; });
  });
}
