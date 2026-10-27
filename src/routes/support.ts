// Support center (SUP-001..005): customer portal tickets and the staff support queue.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, label, type SafeHtml } from "../lib/html.ts";
import { HttpError, download, htmlResponse, redirect, str } from "../app/http.ts";
import { toCsv } from "../services/finance.ts";
import { audit } from "../services/security.ts";
import { requireCustomerOrg, requireStaff } from "../app/app.ts";
import { appLayout } from "../ui/layout.ts";
import {
  csrf, input, textarea, select, button, linkButton, formErrors, alert, badge, table, emptyState, pageHead, pagination, pageParam, dl, fileInput, checkbox, actionForm, kpi, nl2br,
} from "../ui/components.ts";
import { portalNav, staffNav } from "./nav.ts";
import { can } from "../domain/authz.ts";
import * as sup from "../services/support.ts";

const portalPage = (ctx: AppContext, title: string, body: SafeHtml, status = 200) =>
  htmlResponse(ctx, appLayout(ctx, { title, nav: portalNav(ctx), home: "/portal", area: "Customer portal" }, body), status);
const staffPage = (ctx: AppContext, title: string, body: SafeHtml, status = 200) =>
  htmlResponse(ctx, appLayout(ctx, { title, nav: staffNav(ctx), home: "/staff", area: "Crestmont staff" }, body), status);

const fmtSize = (n: number | null) => (n === null ? "" : n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 102.4) / 10} KB` : `${Math.round(n / 104_857.6) / 10} MB`);

function thread(rows: sup.TicketMessageRow[], viewer: "customer" | "staff"): SafeHtml {
  if (!rows.length) return emptyState("No messages yet", "Messages on this ticket will appear here.");
  return html`<div class="thread">${rows.map((m) => {
    const cls = m.internal ? "msg msg--internal" : m.author_is_staff ? "msg msg--staff" : "msg";
    const who = m.author_is_staff ? (viewer === "customer" ? `${m.author_name ?? "Crestmont"} · Crestmont` : `${m.author_name ?? "Staff"} · staff`) : (m.author_name ?? "Customer");
    return html`<article class="${cls}" data-message-id="${m.id}"><div class="msg__meta">${who} · ${formatDateTime(m.created_at)}${m.internal ? html` · <strong>Internal note — not visible to the customer</strong>` : ""}${viewer === "staff" && m.ai_draft_job_id ? html` · AI-assisted draft, sent by a person${m.approver_name ? html`; approved by ${m.approver_name}` : ""}` : ""}</div>
<div>${nl2br(m.body)}</div>${m.attachment_file_id ? html`<p class="faint" style="margin:.5rem 0 0">Attachment: <a href="/files/${m.attachment_file_id}">${m.attachment_name ?? "file"}</a> ${fmtSize(m.attachment_size)}</p>` : ""}</article>`;
  })}</div>`;
}

const categoryOptions = sup.TICKET_CATEGORIES.map((c) => ({ value: c, label: c === "content_change" ? "Content change" : label(c) }));

async function orgProjects(ctx: AppContext, orgId: string) {
  return (await ctx.db.prepare(`SELECT id, name FROM projects WHERE organization_id = ? ORDER BY created_at DESC`).bind(orgId).all<{ id: string; name: string }>()).results;
}

async function newTicketForm(ctx: AppContext, orgId: string, errors: string[] = [], v: Record<string, string> = {}, status = 200) {
  const settings = await sup.getSupportSettings(ctx);
  const projects = await orgProjects(ctx, orgId);
  return portalPage(ctx, "New support ticket", html`${pageHead("New support ticket", undefined, "Support")}
${alert("info", sup.hoursDisclosure(settings))}${formErrors(errors)}
<form class="card stack" method="post" action="/portal/support/new" enctype="multipart/form-data">${csrf(ctx)}
${input({ name: "subject", label: "Subject", value: v.subject, required: true, maxlength: 200 })}
${select({ name: "category", label: "Category", options: categoryOptions, value: v.category, includeBlank: "Choose a category", required: true })}
${projects.length ? select({ name: "project_id", label: "Related project (optional)", options: projects.map((p) => ({ value: p.id, label: p.name })), value: v.project_id, includeBlank: "Not about a specific project" }) : ""}
${textarea({ name: "description", label: "Describe the issue", value: v.description, required: true, rows: 8, maxlength: 10000, hint: "Include what you expected, what happened, and any page addresses involved." })}
${ctx.storage ? fileInput("attachments", "Attachments (optional)", { multiple: true, hint: `Up to ${sup.MAX_ATTACHMENTS} files · PDF, images, Word, Excel, ZIP, text or CSV · 25 MB each` }) : alert("warn", "Attachments are unavailable: file storage is not configured in this environment. You can still submit your ticket.")}
<div class="form-actions">${button("Submit ticket")}${linkButton("Cancel", "/portal/support", "ghost")}</div></form>`, status);
}

async function customerTicketPage(ctx: AppContext, orgId: string, id: string, errors: string[] = [], status = 200) {
  const t = await sup.getTicketForOrg(ctx.db, id, orgId);
  if (!t) throw new HttpError(404, "Ticket not found.");
  const msgs = await sup.ticketMessages(ctx.db, t.id, { includeInternal: false });
  const project = t.project_id ? await ctx.db.prepare(`SELECT name FROM projects WHERE id = ? AND organization_id = ?`).bind(t.project_id, orgId).first<{ name: string }>() : null;
  const settings = await sup.getSupportSettings(ctx);
  const closed = t.status === "resolved" || t.status === "closed";
  return portalPage(ctx, t.subject, html`${pageHead(t.subject, linkButton("All tickets", "/portal/support", "ghost", "sm"), `Ticket ${t.id}`)}
${formErrors(errors)}
<div class="grid grid-2" style="align-items:start"><section class="stack">${thread(msgs, "customer")}
${closed ? html`<div class="card">${t.status === "resolved" ? html`<p>This ticket is resolved. If the issue is not fixed, reopen it and we will pick it up again.</p>${actionForm(ctx, `/portal/support/${t.id}/reopen`, "Reopen ticket", { variant: "primary" })}` : html`<p>This ticket is closed. Please <a href="/portal/support/new">open a new ticket</a> if you need more help.</p>`}</div>`
    : html`<form class="card stack" method="post" action="/portal/support/${t.id}/reply" enctype="multipart/form-data">${csrf(ctx)}
${textarea({ name: "body", label: "Your reply", rows: 5, maxlength: 10000 })}
${ctx.storage ? fileInput("attachments", "Attach files (optional)", { multiple: true }) : html`<p class="faint">Attachments are unavailable: file storage is not configured in this environment.</p>`}
<div class="form-actions">${button("Send reply")}</div></form>`}</section>
<aside class="card">${dl([["Status", badge(t.status)], ["Category", label(t.category)], ["Priority", label(t.priority)], ["Project", project?.name ?? "—"], ["Opened", formatDateTime(t.created_at)],
    ["First response", t.first_response_at ? formatDateTime(t.first_response_at) : "Awaiting a reply from our team"], ["Resolved", t.resolved_at ? formatDateTime(t.resolved_at) : "—"]])}
<p class="faint" style="margin-top:1rem">${sup.hoursDisclosure(settings)}</p></aside></div>`, status);
}

async function staffTicketPage(ctx: AppContext, id: string, errors: string[] = [], status = 200, draftOverride?: { jobId: string; text: string }) {
  const t = await sup.getTicket(ctx.db, id);
  if (!t) throw new HttpError(404, "Ticket not found.");
  const actor = ctx.actor!;
  const canManage = can(actor, "ticket.manage");
  const canNote = can(actor, "ticket.internal_note");
  const msgs = await sup.ticketMessages(ctx.db, t.id, { includeInternal: true });
  const org = await ctx.db.prepare(`SELECT name FROM organizations WHERE id = ?`).bind(t.organization_id).first<{ name: string }>();
  const opener = await ctx.db.prepare(`SELECT display_name, email FROM users WHERE id = ?`).bind(t.opened_by).first<{ display_name: string; email: string }>();
  const project = t.project_id ? await ctx.db.prepare(`SELECT id, name FROM projects WHERE id = ?`).bind(t.project_id).first<{ id: string; name: string }>() : null;
  const assignee = await sup.currentAssignee(ctx.db, t.id);
  const agents = canManage ? await sup.supportAgents(ctx.db) : [];
  const settings = await sup.getSupportSettings(ctx);
  const timing = sup.responseTiming(t, settings.firstResponseTargetHours, ctx.now());
  const draftId = draftOverride?.jobId ?? ctx.url.searchParams.get("draft");
  const draft = draftOverride ? { id: draftOverride.jobId, output_ref: draftOverride.text, provider: "", model: "", created_at: "" } : await sup.pendingDraft(ctx.db, t.id, draftId && /^ai_[0-9a-f]{24}$/.test(draftId) ? draftId : null);
  const sensitive = sup.isSensitive(t, draft?.output_ref ?? "");
  const nextStates = sup.TICKET_TRANSITIONS[t.status];
  const timingText = timing.state === "no_target" ? "No first-response target configured"
    : timing.state === "met" ? `Met: first response after ${timing.firstResponseHours} h (target ${timing.targetHours} h)`
    : timing.state === "breached" ? (timing.firstResponseHours !== null ? `Missed: first response after ${timing.firstResponseHours} h (target ${timing.targetHours} h)` : `Overdue: ${timing.elapsedHours} h without a first response (target ${timing.targetHours} h)`)
    : `${timing.elapsedHours} h elapsed of ${timing.targetHours} h target`;

  return staffPage(ctx, t.subject, html`${pageHead(t.subject, linkButton("Queue", "/staff/support", "ghost", "sm"), `Ticket ${t.id} · ${org?.name ?? ""}`)}
${formErrors(errors)}
<div class="grid grid-2" style="align-items:start"><section class="stack">${thread(msgs, "staff")}
${canManage ? html`<form class="card stack" method="post" action="/staff/support/${t.id}/reply" enctype="multipart/form-data" id="reply">${csrf(ctx)}
<h2 style="font-size:1.4rem">Reply to customer</h2>
${draft ? html`${alert(sensitive ? "warn" : "info", sensitive
      ? "AI-assisted draft for a sensitive ticket (billing, refund or account). Edit it as needed. It will only be sent if you tick the approval box and press Send — it is never sent automatically."
      : "AI-assisted draft. Review and edit before sending — nothing is sent until you press Send.")}<input type="hidden" name="ai_job_id" value="${draft.id}">` : ""}
${textarea({ name: "body", label: "Message (visible to the customer)", value: draft?.output_ref ?? "", rows: 8, maxlength: 10000, required: true })}
${draft && sensitive ? checkbox("approve_sensitive", "I have reviewed this AI-assisted reply and approve sending it.") : ""}
${ctx.storage ? fileInput("attachment", "Attach a file (optional)") : ""}
${select({ name: "then_status", label: "After sending, set status to", options: [{ value: "keep", label: "Default (awaiting customer)" }, ...["pending_customer", "resolved"].filter((s) => s === "pending_customer" || nextStates.includes(s as sup.TicketStatus)).map((s) => ({ value: s, label: label(s) }))] })}
<div class="form-actions">${button("Send reply")}</div></form>
<div class="row">${draft ? actionForm(ctx, `/staff/support/${t.id}/draft/discard`, "Discard AI draft", { hidden: { ai_job_id: draft.id } }) : actionForm(ctx, `/staff/support/${t.id}/draft`, "AI draft reply")}
<span class="faint">AI drafts are suggestions only and are never sent automatically.</span></div>` : ""}
${canNote ? html`<form class="card stack" method="post" action="/staff/support/${t.id}/note">${csrf(ctx)}
${textarea({ name: "body", label: "Internal note (staff only — never shown to the customer)", rows: 3, maxlength: 10000, required: true })}
<div class="form-actions">${button("Add internal note", { variant: "secondary" })}</div></form>` : ""}
</section>
<aside class="stack"><div class="card">${dl([["Status", badge(t.status)], ["Priority", badge(t.priority)], ["Category", label(t.category)], ["Customer", html`${opener?.display_name ?? "—"}<br><span class="faint">${opener?.email ?? ""}</span>`],
    ["Organization", org?.name ?? "—"], ["Project", project ? html`<a href="/staff/projects/${project.id}">${project.name}</a>` : "—"], ["Assignee", assignee?.display_name ?? "Unassigned"],
    ["Opened", formatDateTime(t.created_at)], ["First response", t.first_response_at ? formatDateTime(t.first_response_at) : "None yet"],
    ["Response time", html`${badge(timing.state === "met" ? "pass" : timing.state === "breached" ? "fail" : timing.state === "within" ? "pending" : "not_evaluable", label(timing.state))} ${timingText}`],
    ["SLA flag", t.sla_breached_at ? html`${badge("fail", "Breached")} ${formatDateTime(t.sla_breached_at)}` : "—"],
    ["Escalated", t.escalated_at ? formatDateTime(t.escalated_at) : "—"], ["Resolved", t.resolved_at ? formatDateTime(t.resolved_at) : "—"], ["Reopened", t.reopened_at ? formatDateTime(t.reopened_at) : "—"]])}</div>
${canManage ? html`<form class="card stack" method="post" action="/staff/support/${t.id}/assign">${csrf(ctx)}
${select({ name: "assignee", label: "Assign to", options: agents.map((a) => ({ value: a.id, label: a.display_name })), value: assignee?.user_id ?? "", includeBlank: "Choose a team member" })}
<div class="form-actions">${button("Assign", { variant: "secondary", size: "sm" })}</div></form>
<form class="card stack" method="post" action="/staff/support/${t.id}/triage">${csrf(ctx)}
${select({ name: "priority", label: "Priority", options: [...sup.TICKET_PRIORITIES], value: t.priority })}
${select({ name: "category", label: "Category", options: categoryOptions, value: t.category })}
<div class="form-actions">${button("Save triage", { variant: "secondary", size: "sm" })}</div></form>
<form class="card stack" method="post" action="/staff/support/${t.id}/status">${csrf(ctx)}
${select({ name: "status", label: "Change status", options: nextStates.filter((s) => s !== "escalated").map((s) => ({ value: s, label: s === "open" && (t.status === "resolved" || t.status === "closed") ? "Reopen" : label(s) })), includeBlank: "Choose" })}
<div class="form-actions">${button("Update status", { variant: "secondary", size: "sm" })}</div></form>
${nextStates.includes("escalated") ? html`<form class="card stack" method="post" action="/staff/support/${t.id}/escalate">${csrf(ctx)}
${input({ name: "reason", label: "Escalation reason", required: true, maxlength: 2000 })}<div class="form-actions">${button("Escalate", { variant: "danger", size: "sm" })}</div></form>` : ""}` : html`<p class="faint">You can read this ticket${canNote ? " and add internal notes" : ""}. Changing it requires the ticket management permission.</p>`}
</aside></div>`, status);
}

function supportError(e: unknown): string[] | null {
  return e instanceof sup.SupportError ? [e.message] : null;
}

export function register(r: Router): void {
  // ───────── Customer portal ─────────
  r.get("/portal/support", async (ctx) => {
    const org = requireCustomerOrg(ctx);
    const view = (["active", "closed", "all"] as const).find((x) => x === ctx.url.searchParams.get("view")) ?? "all";
    const { page, limit, offset } = pageParam(ctx);
    const rows = await sup.listOrgTickets(ctx.db, org.organizationId, view, limit, offset);
    const settings = await sup.getSupportSettings(ctx);
    return portalPage(ctx, "Support", html`${pageHead("Support", linkButton("New ticket", "/portal/support/new"), org.organizationName)}
${alert("info", sup.hoursDisclosure(settings))}
<nav class="tabs" aria-label="Ticket views">${(["all", "active", "closed"] as const).map((v) => html`<a href="/portal/support?view=${v}"${v === view ? html` aria-current="page"` : ""}>${v === "all" ? "All" : v === "active" ? "Open" : "Resolved & closed"}</a>`)}</nav>
${table(rows.slice(0, limit), [
      { header: "Subject", cell: (t) => html`<a href="/portal/support/${t.id}">${t.subject}</a>` },
      { header: "Category", cell: (t) => label(t.category) },
      { header: "Project", cell: (t) => t.project_name ?? "—" },
      { header: "Status", cell: (t) => badge(t.status) },
      { header: "Messages", cell: (t) => t.message_count, numeric: true },
      { header: "Updated", cell: (t) => formatDateTime(t.updated_at) },
    ], { empty: emptyState("No support tickets", view === "all" ? "When you need help, open a ticket and our team will respond during staffed hours." : "No tickets in this view.", linkButton("Open a ticket", "/portal/support/new", "secondary")) })}
${pagination(ctx, page, rows.length > limit)}`);
  });

  r.get("/portal/support/new", async (ctx) => {
    const cat = ctx.url.searchParams.get("category") ?? "";
    return newTicketForm(ctx, requireCustomerOrg(ctx).organizationId, [], (sup.TICKET_CATEGORIES as readonly string[]).includes(cat) ? { category: cat } : {});
  });
  r.post("/portal/support/new", async (ctx) => {
    const org = requireCustomerOrg(ctx);
    const f = await ctx.form();
    const v = { subject: str(f, "subject"), category: str(f, "category"), project_id: str(f, "project_id"), description: str(f, "description") };
    try {
      const id = await sup.createTicket(ctx, org, { id: ctx.user!.id, email: ctx.user!.email, displayName: ctx.user!.displayName },
        { subject: v.subject, category: v.category, projectId: v.project_id || null, description: v.description, files: sup.uploadedFiles(f) });
      return redirect(ctx, `/portal/support/${id}`, { kind: "success", text: "Ticket submitted. A confirmation is on its way to your email." });
    } catch (e) {
      const errs = supportError(e);
      if (errs) return newTicketForm(ctx, org.organizationId, errs.flatMap((x) => x.split(". ")), v, 422);
      throw e;
    }
  });

  r.get("/portal/support/:id", async (ctx, p) => customerTicketPage(ctx, requireCustomerOrg(ctx).organizationId, p.id));
  r.post("/portal/support/:id/reply", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    const t = await sup.getTicketForOrg(ctx.db, p.id, org.organizationId);
    if (!t) throw new HttpError(404, "Ticket not found.");
    const f = await ctx.form();
    try {
      await sup.customerReply(ctx, t, ctx.user!.id, str(f, "body"), sup.uploadedFiles(f));
      return redirect(ctx, `/portal/support/${t.id}`, { kind: "success", text: "Reply sent." });
    } catch (e) {
      const errs = supportError(e);
      if (errs) return customerTicketPage(ctx, org.organizationId, t.id, errs, (e as sup.SupportError).status);
      throw e;
    }
  });
  r.post("/portal/support/:id/reopen", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    const t = await sup.getTicketForOrg(ctx.db, p.id, org.organizationId);
    if (!t) throw new HttpError(404, "Ticket not found.");
    try {
      await sup.reopenTicket(ctx, t, ctx.user!.id, "customer");
      return redirect(ctx, `/portal/support/${t.id}`, { kind: "success", text: "Ticket reopened." });
    } catch (e) {
      const errs = supportError(e);
      if (errs) return customerTicketPage(ctx, org.organizationId, t.id, errs, (e as sup.SupportError).status);
      throw e;
    }
  });

  // ───────── Staff queue ─────────
  const queueFilters = (ctx: AppContext): sup.QueueFilters => {
    const sp = ctx.url.searchParams;
    return { status: sp.get("status") ?? "active", priority: sp.get("priority") ?? "", category: sp.get("category") ?? "", assignee: sp.get("assignee") ?? "", q: (sp.get("q") ?? "").trim(), breached: sp.get("breached") === "1" };
  };
  r.get("/staff/support/export.csv", async (ctx) => {
    requireStaff(ctx, "support.access");
    const filters = queueFilters(ctx);
    const rows = (await sup.listQueue(ctx.db, filters, ctx.user!.id, 20000, 0)).slice(0, 20000);
    const s = await sup.getSupportSettings(ctx);
    const now = ctx.now();
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "ticket.exported", subjectType: "ticket", details: { count: rows.length, filters } });
    const csv = toCsv(["ticket_id", "opened", "customer", "subject", "category", "priority", "status", "assignee", "first_response_at", "first_response_hours", "response_target_hours", "response_state", "resolved_at"],
      rows.map((t) => { const rt = sup.responseTiming(t, s.firstResponseTargetHours, now); return [t.id, t.created_at, t.organization_name, t.subject, t.category, t.priority, t.status, t.assignee_name ?? "", t.first_response_at ?? "", rt.firstResponseHours ?? "", rt.targetHours ?? "", rt.state, t.resolved_at ?? ""]; }));
    return download(ctx, csv, `crestmont-tickets-${now.toISOString().slice(0, 10)}.csv`, "text/csv; charset=utf-8");
  });
  r.get("/staff/support", async (ctx) => {
    requireStaff(ctx, "support.access");
    const filters = queueFilters(ctx);
    const { page, limit, offset } = pageParam(ctx);
    const rows = await sup.listQueue(ctx.db, filters, ctx.user!.id, limit, offset);
    const counts = await sup.queueCounts(ctx.db);
    const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
    const breached = (await ctx.db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE sla_breached_at IS NOT NULL AND first_response_at IS NULL AND status IN ('open','pending_staff','escalated')`).first<{ n: number }>())?.n ?? 0;
    const settings = await sup.getSupportSettings(ctx);
    const agents = await sup.supportAgents(ctx.db);
    const now = ctx.now();
    const exportQs = new URLSearchParams(ctx.url.search); exportQs.delete("page");
    return staffPage(ctx, "Support queue", html`${pageHead("Support queue", html`${linkButton("Export CSV", `/staff/support/export.csv${exportQs.toString() ? `?${exportQs}` : ""}`, "ghost", "sm")}${can(ctx.actor!, "ticket.manage") ? actionForm(ctx, "/staff/support/sweep", "Run escalation sweep") : ""}${can(ctx.actor!, "settings.operational") ? linkButton("Support settings", "/staff/support/settings", "ghost", "sm") : ""}`, "Support")}
<div class="kpis grid grid-4">${kpi("Open", n("open"))}${kpi("Awaiting staff", n("pending_staff"))}${kpi("Escalated", n("escalated"))}${kpi("Overdue first response", breached, settings.firstResponseTargetHours ? `Target ${settings.firstResponseTargetHours} h` : "No target configured")}</div>
${settings.staffedHours ? html`<p class="faint">Published staffed hours: ${settings.staffedHours}. Intake is 24/7.</p>` : alert("warn", html`Staffed support hours are not configured, so customers are told hours are not yet published. ${can(ctx.actor!, "settings.operational") ? html`<a href="/staff/support/settings">Set them</a>.` : ""}`)}
<form class="filters row" method="get" action="/staff/support">
${select({ name: "status", label: "Status", options: [{ value: "active", label: "Active" }, { value: "all", label: "All" }, ...sup.TICKET_STATUSES.map((s) => ({ value: s, label: label(s) }))], value: filters.status })}
${select({ name: "priority", label: "Priority", options: [...sup.TICKET_PRIORITIES], value: filters.priority, includeBlank: "Any" })}
${select({ name: "category", label: "Category", options: categoryOptions, value: filters.category, includeBlank: "Any" })}
${select({ name: "assignee", label: "Assignee", options: [{ value: "me", label: "Me" }, { value: "unassigned", label: "Unassigned" }, ...agents.map((a) => ({ value: a.id, label: a.display_name }))], value: filters.assignee, includeBlank: "Anyone" })}
${input({ name: "q", label: "Search", value: filters.q, placeholder: "Subject, ticket id or customer" })}
${checkbox("breached", "Overdue only", { checked: filters.breached })}
<div class="form-actions">${button("Filter", { variant: "secondary", size: "sm" })}${linkButton("Reset", "/staff/support", "ghost", "sm")}</div></form>
${table(rows.slice(0, limit), [
      { header: "Subject", cell: (t) => html`<a href="/staff/support/${t.id}">${t.subject}</a>${t.sla_breached_at && !t.first_response_at ? html` ${badge("fail", "Overdue")}` : ""}` },
      { header: "Customer", cell: (t) => t.organization_name },
      { header: "Category", cell: (t) => label(t.category) },
      { header: "Priority", cell: (t) => badge(t.priority) },
      { header: "Status", cell: (t) => badge(t.status) },
      { header: "Assignee", cell: (t) => t.assignee_name ?? html`<span class="faint">Unassigned</span>` },
      { header: "Age", cell: (t) => `${Math.max(0, Math.round((now.getTime() - Date.parse(t.created_at)) / 3_600_000))} h`, numeric: true },
      { header: "First response", cell: (t) => (t.first_response_at ? formatDateTime(t.first_response_at) : "—") },
    ], { empty: emptyState("No tickets match", "Tickets submitted by customers appear here. Try clearing the filters.") })}
${pagination(ctx, page, rows.length > limit)}`);
  });

  const settingsPage = async (ctx: AppContext, errors: string[] = [], v?: { hours: string; target: string }, status = 200) => {
    const s = await sup.getSupportSettings(ctx);
    return staffPage(ctx, "Support settings", html`${pageHead("Support settings", linkButton("Queue", "/staff/support", "ghost", "sm"), "Support")}
${formErrors(errors)}
<p class="muted">Ticket intake is always open (24/7). These settings publish the hours staff actually respond and the first-response target used for response-time tracking and escalation reminders. Do not describe coverage as 24/7 unless it is genuinely staffed around the clock.</p>
<form class="card stack" method="post" action="/staff/support/settings">${csrf(ctx)}
${input({ name: "staffed_hours", label: "Staffed response hours", value: v?.hours ?? s.staffedHours ?? "", required: true, maxlength: 300, placeholder: "Mon–Fri 9:00–17:00 Eastern" })}
${input({ name: "target_hours", label: "First-response target (hours)", type: "number", min: 1, max: 168, value: v?.target ?? (s.firstResponseTargetHours ?? ""), required: true })}
<div class="form-actions">${button("Save")}</div></form>
<p class="faint">Last updated: ${s.updatedAt ? formatDateTime(s.updatedAt) : "never"} · source: ${s.source === "none" ? "not configured" : s.source}</p>`, status);
  };
  r.get("/staff/support/settings", async (ctx) => { requireStaff(ctx, "settings.operational"); return settingsPage(ctx); });
  r.post("/staff/support/settings", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const f = await ctx.form();
    const v = { hours: str(f, "staffed_hours"), target: str(f, "target_hours") };
    try {
      await sup.saveSupportSettings(ctx.db, ctx.user!.id, v.hours, Number(v.target));
      return redirect(ctx, "/staff/support/settings", { kind: "success", text: "Support settings saved." });
    } catch (e) {
      const errs = supportError(e);
      if (errs) return settingsPage(ctx, errs, v, 422);
      throw e;
    }
  });

  r.post("/staff/support/sweep", async (ctx) => {
    requireStaff(ctx, "ticket.manage");
    const res = await sup.runSupportEscalationSweep(ctx);
    return redirect(ctx, "/staff/support", { kind: res.targetHours ? "success" : "info", text: res.note ?? `Escalation sweep: ${res.flagged} ticket(s) newly flagged as overdue (target ${res.targetHours} h).` });
  });

  r.get("/staff/support/:id", async (ctx, p) => { requireStaff(ctx, "support.access"); return staffTicketPage(ctx, p.id); });

  /** Shared wrapper for staff ticket mutations: loads the ticket, maps SupportError to a 4xx re-render. */
  const mutate = (perm: "ticket.manage" | "ticket.internal_note", fn: (ctx: AppContext, t: sup.TicketRow, f: FormData) => Promise<string | Response>) =>
    async (ctx: AppContext, p: Record<string, string>) => {
      requireStaff(ctx, perm);
      const t = await sup.getTicket(ctx.db, p.id);
      if (!t) throw new HttpError(404, "Ticket not found.");
      const f = await ctx.form();
      try {
        const out = await fn(ctx, t, f);
        return typeof out === "string" ? redirect(ctx, `/staff/support/${t.id}`, { kind: "success", text: out }) : out;
      } catch (e) {
        const errs = supportError(e);
        if (errs) {
          const job = str(f, "ai_job_id");
          return staffTicketPage(ctx, t.id, errs, (e as sup.SupportError).status, job && str(f, "body") ? { jobId: job, text: str(f, "body") } : undefined);
        }
        throw e;
      }
    };

  r.post("/staff/support/:id/assign", mutate("ticket.manage", async (ctx, t, f) => { await sup.assignTicket(ctx, t, str(f, "assignee"), ctx.user!.id); return "Ticket assigned."; }));
  r.post("/staff/support/:id/triage", mutate("ticket.manage", async (ctx, t, f) => { await sup.updateTriage(ctx.db, t, ctx.user!.id, str(f, "priority"), str(f, "category")); return "Triage saved."; }));
  r.post("/staff/support/:id/status", mutate("ticket.manage", async (ctx, t, f) => {
    const to = str(f, "status") as sup.TicketStatus;
    if (to === "escalated") throw new sup.SupportError("Use Escalate and give a reason.");
    if (to === "open" && (t.status === "resolved" || t.status === "closed")) { await sup.reopenTicket(ctx, t, ctx.user!.id, "staff"); return "Ticket reopened."; }
    await sup.changeStatus(ctx, t, to, ctx.user!.id);
    return `Status changed to ${label(to)}.`;
  }));
  r.post("/staff/support/:id/escalate", mutate("ticket.manage", async (ctx, t, f) => { await sup.escalateTicket(ctx, t, ctx.user!.id, str(f, "reason")); return "Ticket escalated."; }));
  r.post("/staff/support/:id/note", mutate("ticket.internal_note", async (ctx, t, f) => { await sup.addInternalNote(ctx.db, t, ctx.user!.id, str(f, "body")); return "Internal note added."; }));
  r.post("/staff/support/:id/reply", mutate("ticket.manage", async (ctx, t, f) => {
    const file = sup.uploadedFiles(f, "attachment")[0] ?? null;
    if (file && !ctx.storage) throw new sup.SupportError("Attachments are unavailable: file storage is not configured in this environment.");
    await sup.staffReply(ctx, t, { id: ctx.user!.id }, { body: str(f, "body"), aiJobId: str(f, "ai_job_id") || null, approveSensitive: f.get("approve_sensitive") === "1", thenStatus: str(f, "then_status") || "keep", file });
    return "Reply sent to the customer.";
  }));
  r.post("/staff/support/:id/draft", mutate("ticket.manage", async (ctx, t) => {
    const res = await sup.draftReply(ctx, t, ctx.user!.id);
    if (res.status === "failed") return redirect(ctx, `/staff/support/${t.id}`, { kind: "error", text: `AI draft unavailable: ${res.error ?? "the provider returned an error"}. Nothing was sent.` });
    return redirect(ctx, `/staff/support/${t.id}?draft=${res.jobId}#reply`, { kind: "info", text: "AI draft ready for review. Nothing has been sent." });
  }));
  r.post("/staff/support/:id/draft/discard", mutate("ticket.manage", async (ctx, t, f) => { await sup.discardDraft(ctx.db, t, str(f, "ai_job_id"), ctx.user!.id); return "AI draft discarded."; }));
}
