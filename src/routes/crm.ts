// CRM, sales reporting, quotes/proposals and package checkout (area C).
// Staff routes: requireStaff(ctx, perm) + record-level checks in src/services/crm.ts / quotes.ts.
// Customer routes: requireCustomerOrg(ctx); every query is scoped by that organization.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, safeUrl, formatCents, formatDate, formatDateTime, label, type SafeHtml } from "../lib/html.ts";
import { HttpError, download, htmlResponse, redirect, str } from "../app/http.ts";
import { requireStaff, requireCustomerOrg } from "../app/app.ts";
import { appLayout, publicLayout } from "../ui/layout.ts";
import { staffNav } from "./nav.ts";
import { csrf, button, linkButton, actionForm, input, textarea, select, checkbox, formErrors, alert, badge, table, emptyState, kpi, pagination, pageParam, dl, tabs, pageHead, barChart, nl2br, dateRange, drawerAttrs, drawerBody } from "../ui/components.ts";
import { can } from "../domain/authz.ts";
import { LEAD_STAGES, LEAD_TRANSITIONS, type LeadStage } from "../domain/crm.ts";
import { PACKAGES, type PackageId, type QuoteLine } from "../domain/catalog.ts";
import { changeLeadStage } from "../services/leads.ts";
import * as crm from "../services/crm.ts";
import * as quotes from "../services/quotes.ts";
import { startPackageCheckout, startMaintenanceCheckout, packageById, maintenanceById, NOT_CONFIGURED, stripeRedirect } from "../services/billing.ts";
import { requestAiDraft, aiProviderFromEnv, decideAiJob } from "../services/ai.ts";
import { audit } from "../services/security.ts";
import { toCsv, parseDollars, parseRange } from "../services/finance.ts";
import { TransitionError } from "../domain/state-machine.ts";
import { recordAcceptance } from "../services/agreements.ts";
import { effectivePrice } from "../services/pricing-approvals.ts";

export function staffPage(ctx: AppContext, title: string, body: SafeHtml, status = 200) {
  return htmlResponse(ctx, appLayout(ctx, { title, nav: staffNav(ctx), home: "/staff", area: "Staff" }, body), status);
}

export function definitions(defs: [string, string][]): SafeHtml {
  return html`<details class="card definitions"><summary><strong>How these numbers are calculated</strong></summary>${dl(defs.map(([k, v]) => [k, v]))}</details>`;
}

/** Date-range filter shared by sales/finance/reports pages. Markup comes from the design-system dateRange control (BRAND-004); query params stay `from` / `to`. */
export function rangeForm(ctx: AppContext, from: string, to: string, extra: SafeHtml = html``): SafeHtml {
  return dateRange(ctx, { from, to }, { extra });
}

/** Campaign attribution captured from the public forms (CRM-001). */
function attributionCard(lead: crm.LeadRow): SafeHtml {
  const rows: [string, string | null][] = [["Campaign source", lead.utm_source], ["Medium", lead.utm_medium], ["Campaign", lead.utm_campaign], ["Term", lead.utm_term], ["Content", lead.utm_content], ["Referrer", lead.referrer], ["Landing page", lead.landing_page]];
  const known = rows.filter(([, v]) => v);
  return html`<h3 style="font-size:1rem">Attribution</h3>${known.length ? html`<div data-attribution>${dl(known.map(([k, v]) => [k, v]))}</div>` : html`<p class="muted" data-attribution>No campaign or referrer recorded${["web_form", "quote_form"].includes(lead.source) ? " (direct visit, untagged link, or the visitor's browser asked not to be tracked)" : ` (${label(lead.source)} leads do not carry web attribution)`}.</p>`}`;
}

function attributionSection(a: Awaited<ReturnType<typeof crm.attributionReport>>, total: number): SafeHtml {
  const col = (title: string, rows: crm.AttributionRow[]) => html`<section class="card"><h3 class="card__title">${title}</h3>${rows.length ? table(rows, [
    { header: title, cell: (x) => x.value ?? html`<span class="faint">(none)</span>` },
    { header: "Leads", cell: (x) => x.n, numeric: true },
    { header: "Converted", cell: (x) => x.converted ?? 0, numeric: true },
  ], { caption: `Leads by ${title.toLowerCase()}` }) : html`<p class="muted">No leads in this range.</p>`}</section>`;
  return html`<section class="stack" style="margin-top:1.5rem" data-attribution-report><h2 style="font-size:1.4rem">Campaign attribution</h2>
<p class="muted">From first-party UTM parameters on the visit that submitted a public form. No third-party tracking is used; referrers are not recorded when the visitor's browser sends Do-Not-Track or Global Privacy Control.</p>
${total ? html`<div class="grid grid-3">${col("Source", a.source)}${col("Medium", a.medium)}${col("Campaign", a.campaign)}</div>
<section class="card"><h3 class="card__title">Source / medium / campaign</h3>${table(a.combos, [
    { header: "Source", cell: (x) => x.source ?? "—" }, { header: "Medium", cell: (x) => x.medium ?? "—" }, { header: "Campaign", cell: (x) => x.campaign ?? "—" },
    { header: "Leads", cell: (x) => x.n, numeric: true }, { header: "Converted", cell: (x) => x.converted ?? 0, numeric: true },
  ], { empty: html`<p class="muted">No leads with campaign parameters in this range.</p>`, caption: "Leads by campaign combination" })}</section>` : html`<p class="muted">No leads in this range.</p>`}</section>`;
}

const pct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);
const today = (ctx: AppContext) => ctx.now().toISOString().slice(0, 10);

function leadFilter(ctx: AppContext): crm.LeadFilter {
  const p = ctx.url.searchParams;
  const g = (k: string) => (p.get(k) ?? "").trim().slice(0, 120) || undefined;
  return { q: g("q"), stage: g("stage"), source: g("source"), owner: g("owner"), from: g("from"), to: g("to") };
}

function stageError(e: unknown): string {
  if (e instanceof TransitionError) return `That stage change is not allowed (${e.from} → ${e.to}).`;
  return (e as Error).message;
}

// ── CRM pipeline + list ──
async function crmIndex(ctx: AppContext) {
  requireStaff(ctx, "crm.access");
  const actor = ctx.actor!;
  const f = leadFilter(ctx);
  const view = ctx.url.searchParams.get("view") === "list" ? "list" : "board";
  const { page, limit, offset } = pageParam(ctx);
  const all = can(actor, "lead.read_all");
  const staff = all ? await crm.salesStaff(ctx.db) : [];
  const counts = await crm.stageCounts(ctx.db, actor, f);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const qs = (v: string) => { const u = new URL(ctx.url); u.searchParams.set("view", v); u.searchParams.delete("page"); return u.pathname + u.search; };
  const exportHref = (() => { const u = new URL(ctx.url); u.pathname = "/staff/crm/export.csv"; u.searchParams.delete("page"); u.searchParams.delete("view"); return u.pathname + u.search; })();
  const filters = html`<form method="get" class="filters" action="/staff/crm"><input type="hidden" name="view" value="${view}">
${input({ name: "q", label: "Search", value: f.q, placeholder: "Name, email or company" })}
${select({ name: "stage", label: "Stage", options: [...LEAD_STAGES], value: f.stage, includeBlank: "Any stage" })}
${select({ name: "source", label: "Source", options: [...crm.LEAD_SOURCES], value: f.source, includeBlank: "Any source" })}
${all ? select({ name: "owner", label: "Owner", options: [{ value: "unassigned", label: "Unassigned" }, ...staff.map((s) => ({ value: s.id, label: s.display_name }))], value: f.owner, includeBlank: "Anyone" }) : ""}
${input({ name: "from", label: "Created from", type: "date", value: f.from })}${input({ name: "to", label: "Created to", type: "date", value: f.to })}
<div class="field">${button("Filter", { variant: "secondary", size: "sm" })}</div></form>`;
  let body: SafeHtml;
  if (view === "board") {
    const rows = await crm.listLeads(ctx.db, actor, f, { limit: 500, offset: 0 });
    const shown = LEAD_STAGES.filter((s) => s !== "archived" || f.stage === "archived");
    body = total === 0 ? emptyState("No leads match", all ? "Leads arrive from the website forms, the AI receptionist and manual entry." : "Leads assigned to you will appear here.", linkButton("Add a lead", "/staff/crm/new", "secondary"))
      : html`<div class="kanban" aria-label="Pipeline by stage">${shown.map((s) => html`<section class="kanban__col" aria-label="${label(s)}"><h3>${label(s)} · ${counts[s] ?? 0}</h3>
${rows.filter((r) => r.stage === s).slice(0, 40).map((r) => html`<div class="kanban__item"><a class="kanban__card" href="/staff/crm/leads/${r.id}"><strong>${r.contact_name}</strong>${r.company_name ? html`<br><span class="faint">${r.company_name}</span>` : ""}<br><span class="faint">${label(r.source)} · ${formatDate(r.created_at)}${r.owner_name ? ` · ${r.owner_name}` : ""}</span></a><a class="kanban__quick" href="/staff/crm/leads/${r.id}/quick"${drawerAttrs(`/staff/crm/leads/${r.id}/quick`)} aria-label="Quick view: ${r.contact_name}">Quick view</a></div>`)}
${(counts[s] ?? 0) > 40 ? html`<a class="faint" href="${qs("list")}&amp;stage=${s}">View all ${counts[s]}</a>` : ""}</section>`)}</div>`;
  } else {
    const rows = await crm.listLeads(ctx.db, actor, f, { limit: limit + 1, offset });
    body = html`${table(rows.slice(0, limit), [
      { header: "Contact", cell: (r) => html`<a href="/staff/crm/leads/${r.id}">${r.contact_name}</a><br><span class="faint">${r.contact_email ?? r.contact_phone ?? ""}</span>` },
      { header: "Company", cell: (r) => r.company_name ?? "—" },
      { header: "Stage", cell: (r) => badge(r.stage) },
      { header: "Source", cell: (r) => label(r.source) },
      { header: "Interest", cell: (r) => (r.interest ? label(r.interest) : "—") },
      { header: "Owner", cell: (r) => r.owner_name ?? html`<span class="faint">Unassigned</span>` },
      { header: "Created", cell: (r) => formatDate(r.created_at) },
      { header: "Updated", cell: (r) => formatDate(r.updated_at) },
    ], { empty: emptyState("No leads match", "Try a different search or filter."), caption: "Leads" })}${pagination(ctx, page, rows.length > limit)}`;
  }
  return staffPage(ctx, "CRM", html`${pageHead("CRM pipeline", html`${linkButton("Export CSV", exportHref, "ghost", "sm")}${linkButton("Contacts", "/staff/crm/contacts", "ghost", "sm")}${linkButton("Add lead", "/staff/crm/new", "primary", "sm")}`, all ? "All leads" : "Leads assigned to you")}
${tabs([{ href: qs("board"), label: `Pipeline (${total})`, current: view === "board" }, { href: qs("list"), label: "List", current: view === "list" }])}
${filters}${body}`);
}

async function crmExport(ctx: AppContext) {
  requireStaff(ctx, "crm.access");
  const rows = await crm.exportLeads(ctx.db, ctx.actor!, leadFilter(ctx));
  await audit(ctx.db, { actorUserId: ctx.user!.id, action: "lead.exported", subjectType: "lead", details: { count: rows.length, filter: leadFilter(ctx) } });
  const csv = toCsv(["lead_id", "created_date", "name", "email", "phone", "company", "source", "stage", "owner", "interest", "lost_reason"],
    rows.map((r) => [r.id, r.created_at.slice(0, 10), r.contact_name, r.contact_email, r.contact_phone, r.company_name, r.source, r.stage, r.owner_name, r.interest, r.lost_reason]));
  return download(ctx, csv, `crestmont-leads-${today(ctx)}.csv`, "text/csv; charset=utf-8");
}

// ── manual lead ──
function newLeadForm(ctx: AppContext, errors: string[] = [], v: Record<string, string> = {}, status = 200) {
  return staffPage(ctx, "Add lead", html`${pageHead("Add a lead", linkButton("Back to CRM", "/staff/crm", "ghost", "sm"), "CRM")}${formErrors(errors)}
<form method="post" action="/staff/crm/new" class="card stack" style="max-width:720px">${csrf(ctx)}
${input({ name: "name", label: "Contact name", value: v.name, required: true })}
${input({ name: "email", label: "Email", type: "email", value: v.email, hint: "Email or phone is required. Proposals are sent to this address." })}
${input({ name: "phone", label: "Phone", type: "tel", value: v.phone })}
${input({ name: "company", label: "Company", value: v.company })}${input({ name: "website", label: "Company website", type: "url", value: v.website, placeholder: "https://" })}
${select({ name: "source", label: "Source", options: [{ value: "manual", label: "Manual entry" }, { value: "referral", label: "Referral" }], value: v.source ?? "manual" })}
${select({ name: "interest", label: "Interested in", options: ["starter", "business", "premium", "custom", "maintenance", "other"], value: v.interest ?? "custom" })}
${textarea({ name: "message", label: "Notes", value: v.message, rows: 4 })}
<div class="form-actions">${button("Create lead")}</div></form>`, status);
}

// ── lead detail ──
async function leadDetail(ctx: AppContext, id: string, errors: string[] = [], status = 200) {
  requireStaff(ctx, "crm.access");
  const actor = ctx.actor!;
  const lead = await crm.getLead(ctx.db, actor, id);
  const [acts, links, staff, ai] = await Promise.all([
    crm.activities(ctx.db, id), crm.leadLinks(ctx.db, lead), can(actor, "lead.assign") ? crm.salesStaff(ctx.db) : Promise.resolve([]),
    ctx.db.prepare(`SELECT id, status, output_ref, error, created_at FROM ai_jobs WHERE workflow = 'lead_qualification' AND input_ref = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(`lead:${id}`).first<{ id: string; status: string; output_ref: string | null; error: string | null; created_at: string }>(),
  ]);
  const writable = can(actor, "lead.write_all") || (can(actor, "lead.write_assigned") && lead.owner_user_id === actor.userId);
  const nextStages = (LEAD_TRANSITIONS[lead.stage] as readonly LeadStage[]).filter((s) => s !== "converted");
  const tasks = acts.filter((a) => a.kind === "task");
  const history = acts.filter((a) => a.kind !== "task");
  const base = `/staff/crm/leads/${id}`;
  const aiCard = html`<section class="card stack"><h2 style="font-size:1.2rem">AI qualification draft</h2>
${ai ? html`<p class="faint">Last run ${formatDateTime(ai.created_at)} · ${badge(ai.status)}</p>
${ai.status === "failed" ? alert("warn", ai.error?.startsWith("not_configured") ? "AI drafting is not configured: no AI provider API key is set. Write the qualification notes manually." : `The draft failed: ${ai.error ?? "unknown error"}`) : ""}
${ai.output_ref && ai.status !== "failed" ? html`<div class="prose"><p>${nl2br(ai.output_ref)}</p></div><p class="faint">AI output is a draft. A person must review it before it is used.</p>` : ""}
${ai.status === "awaiting_approval" && writable ? html`<div class="row">${actionForm(ctx, `${base}/ai-draft/${ai.id}`, "Use as qualification notes", { hidden: { decision: "approved" }, variant: "primary" })}${actionForm(ctx, `${base}/ai-draft/${ai.id}`, "Discard draft", { hidden: { decision: "rejected" }, variant: "ghost" })}</div>` : ""}`
    : html`<p class="muted">Generate a draft summary of fit, budget signals and next questions from this lead's details. Nothing is sent to the customer.</p>`}
${writable ? actionForm(ctx, `${base}/ai-draft`, "Draft qualification with AI", { variant: "secondary" }) : ""}</section>`;
  const body = html`${pageHead(lead.contact_name, html`${badge(lead.stage)}${can(actor, "quote.write") && writable ? linkButton("New quote", `/staff/quotes/new?lead=${id}`, "primary", "sm") : ""}`, lead.company_name ?? "Lead")}
${formErrors(errors)}
<div class="grid grid-2">
<section class="card stack"><h2 style="font-size:1.2rem">Contact &amp; company</h2>
${dl([["Name", lead.contact_name], ["Email", lead.contact_email ? html`<a href="mailto:${lead.contact_email}">${lead.contact_email}</a>` : "—"], ["Phone", lead.contact_phone], ["Company", lead.company_name],
  ["Website", lead.company_website ? html`<a href="${safeUrl(lead.company_website)}" rel="noopener noreferrer" target="_blank">${lead.company_website}</a>` : "—"],
  ["Customer account", links.orgId ? html`<a href="/staff/customers/${links.orgId}">View customer</a>` : lead.contact_user_id ? "Registered (no organization link yet)" : "Not registered"],
  ["Source", label(lead.source)], ["Interest", lead.interest ? label(lead.interest) : "—"], ["Created", formatDateTime(lead.created_at)], ["Owner", lead.owner_name ?? "Unassigned"],
  ...(lead.lost_reason ? [["Closed reason", lead.lost_reason] as [string, string]] : [])])}
${attributionCard(lead)}
${lead.message ? html`<h3 style="font-size:1rem">Original message</h3><p>${nl2br(lead.message)}</p>` : ""}
${lead.qualification_notes ? html`<h3 style="font-size:1rem">Qualification notes</h3><p>${nl2br(lead.qualification_notes)}</p>` : ""}
${writable ? html`<details><summary>Edit contact, company and qualification</summary><form method="post" action="${base}/contact" class="stack">${csrf(ctx)}
${input({ name: "name", label: "Name", value: lead.contact_name, required: true })}${input({ name: "email", label: "Email", type: "email", value: lead.contact_email })}
${input({ name: "phone", label: "Phone", value: lead.contact_phone })}${input({ name: "company", label: "Company", value: lead.company_name })}${input({ name: "website", label: "Website", value: lead.company_website })}
${textarea({ name: "qualification_notes", label: "Qualification notes", value: lead.qualification_notes, rows: 4 })}<div class="form-actions">${button("Save", { size: "sm" })}</div></form></details>` : ""}
</section>
<section class="stack">
<div class="card stack"><h2 style="font-size:1.2rem">Stage</h2>
${writable && nextStages.length ? html`<form method="post" action="${base}/stage" class="stack">${csrf(ctx)}
${select({ name: "to", label: "Move to", options: nextStages.map((s) => ({ value: s, label: s === "qualified" && ["lost", "rejected", "archived"].includes(lead.stage) ? "Reopen (qualified)" : label(s) })) })}
${input({ name: "reason", label: "Reason", hint: "Required for Lost or Rejected." })}<div class="form-actions">${button("Change stage", { size: "sm" })}</div></form>
<p class="faint">Converted is set automatically when Stripe confirms payment.</p>` : html`<p class="muted">${writable ? "No further manual stage changes from here." : "Only the lead owner can change the stage."}</p>`}</div>
${can(actor, "lead.assign") ? html`<div class="card stack"><h2 style="font-size:1.2rem">Owner</h2><form method="post" action="${base}/assign" class="stack">${csrf(ctx)}
${select({ name: "owner", label: "Assign to", options: staff.map((s) => ({ value: s.id, label: s.display_name })), value: lead.owner_user_id, includeBlank: "Unassigned" })}<div class="form-actions">${button("Save owner", { size: "sm", variant: "secondary" })}</div></form></div>` : ""}
<div class="card stack"><h2 style="font-size:1.2rem">Follow-up tasks</h2>
${tasks.length ? html`<ul class="checklist">${tasks.map((t) => html`<li>${t.completed_at ? html`<s>${t.body}</s> <span class="faint">done ${formatDate(t.completed_at)}</span>` : html`<strong>${t.body}</strong> <span class="${t.due_at && t.due_at < ctx.now().toISOString() ? "error-text" : "faint"}">due ${formatDate(t.due_at)}</span> ${writable ? actionForm(ctx, `${base}/tasks/${t.id}/complete`, "Mark done") : ""}`}</li>`)}</ul>` : html`<p class="muted">No follow-ups scheduled.</p>`}
${writable ? html`<form method="post" action="${base}/task" class="stack">${csrf(ctx)}${input({ name: "body", label: "Follow-up", required: true, id: "followup-body" })}${input({ name: "due", label: "Due date", type: "date", required: true })}<div class="form-actions">${button("Add task", { size: "sm", variant: "secondary" })}</div></form>` : ""}</div>
</section></div>
${aiCard}
<section class="card stack"><h2 style="font-size:1.2rem">Linked records</h2>
<h3 style="font-size:1rem">Quotes</h3>${table(links.quotes, [
    { header: "Quote", cell: (q) => html`<a href="/staff/quotes/${q.id}">${q.id}</a>` }, { header: "Version", cell: (q) => `v${q.current_version}` }, { header: "Status", cell: (q) => badge(q.status) },
    { header: "Total", cell: (q) => formatCents(q.total_cents), numeric: true }, { header: "Created", cell: (q) => formatDate(q.created_at) }], { empty: html`<p class="muted">No quotes yet.</p>` })}
<h3 style="font-size:1rem">Orders</h3>${table(links.orders, [
    { header: "Order", cell: (o) => o.id }, { header: "Kind", cell: (o) => label(o.kind) }, { header: "Status", cell: (o) => badge(o.status) }, { header: "Total", cell: (o) => formatCents(o.total_cents), numeric: true }, { header: "Created", cell: (o) => formatDate(o.created_at) }], { empty: html`<p class="muted">No orders.</p>` })}
<h3 style="font-size:1rem">Projects</h3>${table(links.projects, [{ header: "Project", cell: (p) => html`<a href="/staff/projects/${p.id}">${p.name}</a>` }, { header: "Status", cell: (p) => badge(p.status) }, { header: "Created", cell: (p) => formatDate(p.created_at) }], { empty: html`<p class="muted">No projects.</p>` })}
<h3 style="font-size:1rem">Support tickets</h3>${table(links.tickets, [{ header: "Subject", cell: (t) => t.subject }, { header: "Status", cell: (t) => badge(t.status) }, { header: "Priority", cell: (t) => badge(t.priority) }, { header: "Opened", cell: (t) => formatDate(t.created_at) }], { empty: html`<p class="muted">No tickets.</p>` })}
</section>
<section class="card stack"><h2 style="font-size:1.2rem">Activity</h2>
${writable ? html`<form method="post" action="${base}/note" class="stack">${csrf(ctx)}${select({ name: "kind", label: "Type", options: [{ value: "note", label: "Note" }, { value: "call", label: "Call log" }, { value: "email", label: "Email log" }] })}${textarea({ name: "body", label: "Details", rows: 3, required: true })}<div class="form-actions">${button("Add to history", { size: "sm", variant: "secondary" })}</div></form>` : ""}
${history.length ? html`<ul class="timeline">${history.map((a) => html`<li><strong>${label(a.kind)}</strong> <span class="faint">${formatDateTime(a.created_at)}${a.actor ? ` · ${a.actor}` : ""}</span><br>${nl2br(a.body)}</li>`)}</ul>` : html`<p class="muted">No activity yet.</p>`}
</section>`;
  return staffPage(ctx, lead.contact_name, body, status);
}

/** Lead quick view (BRAND-003 drawer). A complete page on its own; the CRM board loads its drawer body into the drawer. */
async function leadQuickView(ctx: AppContext, id: string) {
  requireStaff(ctx, "crm.access");
  const lead = await crm.getLead(ctx.db, ctx.actor!, id);
  const acts = await crm.activities(ctx.db, id);
  const openTasks = acts.filter((a) => a.kind === "task" && !a.completed_at);
  const recent = acts.filter((a) => a.kind !== "task").slice(0, 5);
  const body = drawerBody(lead.contact_name, html`<p>${badge(lead.stage)} <span class="faint">${label(lead.source)} · created ${formatDate(lead.created_at)}</span></p>
${dl([["Company", lead.company_name], ["Email", lead.contact_email ? html`<a href="mailto:${lead.contact_email}">${lead.contact_email}</a>` : "—"], ["Phone", lead.contact_phone], ["Interest", lead.interest ? label(lead.interest) : "—"], ["Owner", lead.owner_name ?? "Unassigned"]])}
${attributionCard(lead)}
<h3 style="font-size:1rem">Open follow-ups</h3>${openTasks.length ? html`<ul class="checklist">${openTasks.map((t) => html`<li>${t.body} <span class="${t.due_at && t.due_at < ctx.now().toISOString() ? "error-text" : "faint"}">due ${formatDate(t.due_at)}</span></li>`)}</ul>` : html`<p class="muted">No open follow-ups.</p>`}
<h3 style="font-size:1rem">Recent activity</h3>${recent.length ? html`<ul class="timeline">${recent.map((a) => html`<li><strong>${label(a.kind)}</strong> <span class="faint">${formatDateTime(a.created_at)}</span><br>${a.body.length > 220 ? a.body.slice(0, 217) + "…" : a.body}</li>`)}</ul>` : html`<p class="muted">No activity yet.</p>`}
<p>${linkButton("Open full lead", `/staff/crm/leads/${id}`, "secondary", "sm")}</p>`);
  return staffPage(ctx, `${lead.contact_name} — quick view`, html`${pageHead(lead.contact_name, linkButton("Back to pipeline", "/staff/crm", "ghost", "sm"), "Lead quick view")}<div class="card" style="max-width:640px">${body}</div>`);
}

async function leadAction(ctx: AppContext, id: string, fn: (lead: crm.LeadRow) => Promise<{ ok: boolean; issues?: string[] } | void>, success: string) {
  requireStaff(ctx, "crm.access");
  const lead = await crm.getLead(ctx.db, ctx.actor!, id);
  const res = await fn(lead);
  if (res && !res.ok) return leadDetail(ctx, id, res.issues ?? ["Please check your input."], 422);
  return redirect(ctx, `/staff/crm/leads/${id}`, { kind: "success", text: success });
}

// ── contacts / customers ──
async function contactsPage(ctx: AppContext) {
  requireStaff(ctx, "crm.access");
  const q = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const { page, limit, offset } = pageParam(ctx);
  const rows = await crm.listContacts(ctx.db, ctx.actor!, q, { limit, offset });
  return staffPage(ctx, "Contacts", html`${pageHead("Contacts & companies", linkButton("Pipeline", "/staff/crm", "ghost", "sm"), "CRM")}
<form method="get" class="filters" action="/staff/crm/contacts">${input({ name: "q", label: "Search", value: q, placeholder: "Name, email or company" })}<div class="field">${button("Search", { variant: "secondary", size: "sm" })}</div></form>
${table(rows.slice(0, limit), [
    { header: "Contact", cell: (r) => html`<a href="/staff/crm/leads/${r.last_lead_id}">${r.name}</a>` }, { header: "Email", cell: (r) => r.email ?? "—" }, { header: "Phone", cell: (r) => r.phone ?? "—" },
    { header: "Company", cell: (r) => (r.organization_id && can(ctx.actor!, "customers.read") ? html`<a href="/staff/customers/${r.organization_id}">${r.company ?? "Customer"}</a>` : r.company ?? "—") },
    { header: "Account", cell: (r) => (r.user_id ? badge("active", "Registered") : html`<span class="faint">No account</span>`) },
    { header: "Leads", cell: (r) => r.leads, numeric: true }, { header: "Last activity", cell: (r) => formatDate(r.last_activity) }],
    { empty: emptyState("No contacts", "Contacts are created with leads.") })}${pagination(ctx, page, rows.length > limit)}`);
}

async function customersPage(ctx: AppContext) {
  requireStaff(ctx, "customers.read");
  const q = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const { page, limit, offset } = pageParam(ctx);
  const rows = await crm.listCustomers(ctx.db, q, { limit, offset });
  return staffPage(ctx, "Customers", html`${pageHead("Customers", undefined, "Customer organizations")}
<form method="get" class="filters" action="/staff/customers">${input({ name: "q", label: "Search", value: q, placeholder: "Organization name" })}<div class="field">${button("Search", { variant: "secondary", size: "sm" })}</div></form>
${table(rows.slice(0, limit), [
    { header: "Organization", cell: (r) => html`<a href="/staff/customers/${r.id}">${r.name}</a>` }, { header: "Since", cell: (r) => formatDate(r.created_at) },
    { header: "Orders", cell: (r) => r.orders, numeric: true }, { header: "Projects", cell: (r) => r.projects, numeric: true }, { header: "Active plans", cell: (r) => r.subscriptions, numeric: true },
    { header: "Open tickets", cell: (r) => r.open_tickets, numeric: true }, { header: "Paid to date", cell: (r) => formatCents(r.paid_cents), numeric: true }],
    { empty: emptyState("No customers yet", "Customer organizations are created when someone registers or buys.") })}${pagination(ctx, page, rows.length > limit)}`);
}

async function customerPage(ctx: AppContext, id: string) {
  requireStaff(ctx, "customers.read");
  const d = await crm.customerDetail(ctx.db, id);
  const leadLink = (lid: string) => (can(ctx.actor!, "crm.access") ? html`<a href="/staff/crm/leads/${lid}">${lid}</a>` : html`${lid}`);
  return staffPage(ctx, d.org.name, html`${pageHead(d.org.name, linkButton("General conversation", `/staff/conversations/${d.org.id}`, "secondary", "sm"), "Customer")}
${dl([["Customer since", formatDate(d.org.created_at)], ["Stripe customer", d.org.stripe_customer_id ? "Linked" : "Not linked yet"], ["Members", d.members.map((m) => `${m.display_name} <${m.email}> (${label(m.role_id)})`).join(", ") || "—"]])}
<div class="grid grid-2">
<section class="card"><h2 style="font-size:1.2rem">Orders</h2>${table(d.orders, [{ header: "Order", cell: (o) => o.id }, { header: "Kind", cell: (o) => label(o.kind) }, { header: "Status", cell: (o) => badge(o.status) }, { header: "Total", cell: (o) => formatCents(o.total_cents), numeric: true }, { header: "Lead", cell: (o) => (o.lead_id ? leadLink(o.lead_id) : "—") }], { empty: html`<p class="muted">No orders.</p>` })}</section>
<section class="card"><h2 style="font-size:1.2rem">Invoices</h2>${table(d.invoices, [{ header: "Invoice", cell: (i) => i.description ?? i.id }, { header: "Status", cell: (i) => badge(i.status) }, { header: "Amount", cell: (i) => formatCents(i.amount_cents), numeric: true }, { header: "Issued", cell: (i) => formatDate(i.created_at) }], { empty: html`<p class="muted">No invoices.</p>` })}</section>
<section class="card"><h2 style="font-size:1.2rem">Projects</h2>${table(d.projects, [{ header: "Project", cell: (p) => html`<a href="/staff/projects/${p.id}">${p.name}</a>` }, { header: "Status", cell: (p) => badge(p.status) }], { empty: html`<p class="muted">No projects.</p>` })}</section>
<section class="card"><h2 style="font-size:1.2rem">Subscriptions</h2>${table(d.subscriptions, [{ header: "Plan", cell: (s) => label(s.product_id) }, { header: "Status", cell: (s) => badge(s.status) }, { header: "Renews", cell: (s) => formatDate(s.current_period_end) }], { empty: html`<p class="muted">No maintenance plans.</p>` })}</section>
<section class="card"><h2 style="font-size:1.2rem">Support tickets</h2>${table(d.tickets, [{ header: "Subject", cell: (t) => t.subject }, { header: "Status", cell: (t) => badge(t.status) }, { header: "Opened", cell: (t) => formatDate(t.created_at) }], { empty: html`<p class="muted">No tickets.</p>` })}</section>
<section class="card"><h2 style="font-size:1.2rem">Leads</h2>${table(d.leads, [{ header: "Lead", cell: (l) => leadLink(l.id) }, { header: "Stage", cell: (l) => badge(l.stage) }, { header: "Source", cell: (l) => label(l.source) }, { header: "Created", cell: (l) => formatDate(l.created_at) }], { empty: html`<p class="muted">No linked leads.</p>` })}</section>
</div>`);
}

// ── sales reporting ──
async function salesPage(ctx: AppContext) {
  requireStaff(ctx, "crm.access");
  const range = parseRange(ctx.url.searchParams, 90, ctx.now());
  const r = await crm.salesReport(ctx.db, ctx.actor!, range);
  return staffPage(ctx, "Sales", html`${pageHead("Sales & conversion", undefined, can(ctx.actor!, "lead.read_all") ? "All leads" : "Your leads")}
${rangeForm(ctx, range.from, range.to)}
<div class="kpis">${kpi("Leads created", r.created)}${kpi("Converted", r.converted)}${kpi("Conversion rate", pct(r.rate), "converted ÷ created")}${kpi("Quotes sent", r.quotesSent)}${kpi("Quotes accepted", r.quotesAccepted)}</div>
<div class="grid grid-2">
<section class="card"><h2 style="font-size:1.2rem">Leads by source</h2>${r.bySource.length ? barChart(r.bySource.map((s) => ({ label: label(s.source), value: s.n, display: `${s.n} (${s.converted ?? 0} converted)` }))) : html`<p class="muted">No leads in this range.</p>`}</section>
<section class="card"><h2 style="font-size:1.2rem">Stage funnel</h2>${r.created ? barChart(LEAD_STAGES.filter((s) => r.funnel[s]).map((s) => ({ label: label(s), value: r.funnel[s], display: String(r.funnel[s]) }))) : html`<p class="muted">No leads in this range.</p>`}</section>
<section class="card"><h2 style="font-size:1.2rem">Revenue attributed by lead source</h2>${r.revenue.length ? barChart(r.revenue.map((x) => ({ label: label(x.source), value: x.cents, display: formatCents(x.cents) }))) : html`<p class="muted">No captured payments in this range.</p>`}</section>
</div>
${attributionSection(r.attribution, r.created)}${definitions(crm.SALES_DEFINITIONS)}`);
}

// ── quotes ──
interface QuoteFormValues { packageId: string; scope: string; validUntil: string; lines: { description: string; amount: string }[] }

function readQuoteForm(f: FormData): { values: QuoteFormValues; input: quotes.QuoteInput | null; issues: string[] } {
  const descs = f.getAll("line_desc").map((x) => String(x).trim());
  const amts = f.getAll("line_amount").map((x) => String(x).trim());
  const values: QuoteFormValues = { packageId: str(f, "package"), scope: str(f, "scope"), validUntil: str(f, "valid_until"), lines: descs.map((d, i) => ({ description: d, amount: amts[i] ?? "" })) };
  const issues: string[] = [];
  const lines: QuoteLine[] = [];
  values.lines.forEach((l, i) => {
    if (!l.description && !l.amount) return;
    const cents = parseDollars(l.amount);
    if (!l.description) issues.push(`Line ${i + 1} needs a description`);
    if (cents === null || Number.isNaN(cents)) issues.push(`Line ${i + 1} needs a dollar amount like 1250 or 1250.50`);
    else lines.push({ description: l.description, amountCents: cents });
  });
  if (!["starter", "business", "premium", "custom"].includes(values.packageId)) issues.push("Choose a package or custom");
  if (issues.length) return { values, input: null, issues };
  return { values, input: { packageId: values.packageId as PackageId | "custom", lines, scope: values.scope, validUntil: values.validUntil }, issues };
}

function quoteForm(ctx: AppContext, action: string, v: QuoteFormValues, errors: string[], submit: string): SafeHtml {
  const rows = [...v.lines.filter((l) => l.description || l.amount)];
  while (rows.length < Math.max(4, v.lines.length + 1) && rows.length < 40) rows.push({ description: "", amount: "" });
  return html`${formErrors(errors)}<form method="post" action="${action}" class="card stack">${csrf(ctx)}
${select({ name: "package", label: "Package", value: v.packageId, options: [
    ...(["starter", "business", "premium"] as PackageId[]).map((id) => ({ value: id, label: `${PACKAGES[id].name} — ${formatCents(PACKAGES[id].basePriceCents)}${PACKAGES[id].priceIsFloor ? "+" : ""} (100% upfront)` })),
    { value: "custom", label: "Custom development — line items, 50/25/25 milestones" }], hint: "Starter and Business are fixed-price: leave extra lines empty. Premium may add lines above the $4,999 floor. Custom uses only the lines below." })}
<fieldset class="stack"><legend>Line items</legend><p class="faint">Amounts in US dollars. The total and payment schedule are calculated by the server from the catalog and these lines.</p>
${rows.map((l, i) => html`<div class="row quote-line">${input({ name: "line_desc", id: `line-desc-${i}`, label: `Line ${i + 1} description`, value: l.description })}${input({ name: "line_amount", id: `line-amt-${i}`, label: "Amount ($)", value: l.amount, inputmode: "decimal" })}</div>`)}</fieldset>
${textarea({ name: "scope", label: "Scope of work", value: v.scope, rows: 8, required: true, hint: "What is included, page counts, integrations, revision rounds and exclusions. Shown to the customer." })}
${input({ name: "valid_until", label: "Valid until", type: "date", value: v.validUntil, required: true })}
<div class="form-actions">${button(submit)}</div></form>`;
}

async function quotesList(ctx: AppContext) {
  requireStaff(ctx, "quote.write");
  const status = ctx.url.searchParams.get("status") ?? "";
  const valid = ["draft", "sent", "accepted", "rejected", "expired", "superseded"].includes(status) ? status : undefined;
  const { page, limit, offset } = pageParam(ctx);
  const rows = await quotes.listQuotes(ctx.db, ctx.actor!, { status: valid }, { limit, offset });
  return staffPage(ctx, "Quotes", html`${pageHead("Quotes & proposals", undefined, "Sales")}
<form method="get" class="filters" action="/staff/quotes">${select({ name: "status", label: "Status", options: ["draft", "sent", "accepted", "rejected", "expired", "superseded"], value: valid, includeBlank: "Any status" })}<div class="field">${button("Filter", { variant: "secondary", size: "sm" })}</div></form>
${table(rows.slice(0, limit), [
    { header: "Quote", cell: (q) => html`<a href="/staff/quotes/${q.id}">${q.id}</a>` }, { header: "Contact", cell: (q) => html`<a href="/staff/crm/leads/${q.lead_id}">${q.contact_name}</a>${q.company_name ? html`<br><span class="faint">${q.company_name}</span>` : ""}` },
    { header: "Package", cell: (q) => quotes.packageName(q.package_id) }, { header: "Version", cell: (q) => `v${q.current_version}` }, { header: "Status", cell: (q) => badge(q.status) },
    { header: "Total", cell: (q) => formatCents(q.total_cents), numeric: true }, { header: "Valid until", cell: (q) => q.valid_until ?? "—" }, { header: "Sent", cell: (q) => formatDate(q.sent_at) }],
    { empty: emptyState("No quotes", "Create a quote from a lead in the CRM.", linkButton("Open CRM", "/staff/crm", "secondary")) })}${pagination(ctx, page, rows.length > limit)}`);
}

async function newQuotePage(ctx: AppContext, errors: string[] = [], values?: QuoteFormValues, status = 200) {
  requireStaff(ctx, "quote.write");
  const leadId = ctx.url.searchParams.get("lead") ?? "";
  if (!leadId) throw new HttpError(400, "Start a quote from a lead in the CRM.");
  const lead = await crm.getLead(ctx.db, ctx.actor!, leadId);
  const interest = lead.interest && ["starter", "business", "premium"].includes(lead.interest) ? lead.interest : "custom";
  const v = values ?? { packageId: interest, scope: interest !== "custom" ? `${PACKAGES[interest as PackageId].name} package: ${PACKAGES[interest as PackageId].includes.join("; ")}.` : "", validUntil: new Date(ctx.now().getTime() + 30 * 86400e3).toISOString().slice(0, 10), lines: [] };
  return staffPage(ctx, "New quote", html`${pageHead(`New quote for ${lead.contact_name}`, linkButton("Back to lead", `/staff/crm/leads/${lead.id}`, "ghost", "sm"), "Quote builder")}
${quoteForm(ctx, `/staff/quotes/new?lead=${encodeURIComponent(lead.id)}`, v, errors, "Save draft (v1)")}`, status);
}

function lineTable(lines: QuoteLine[], total: number, installments: { kind: string; amountCents: number }[]) {
  return html`${table(lines, [{ header: "Item", cell: (l) => l.description }, { header: "Amount", cell: (l) => formatCents(l.amountCents), numeric: true }])}
<p class="right"><strong>Total ${formatCents(total)}</strong></p>
<h3 style="font-size:1rem">Payment schedule</h3>${table(installments, [{ header: "Installment", cell: (i) => ({ full: "100% upfront", deposit_50: "50% deposit on acceptance", design_25: "25% after approved design", prelaunch_25: "25% before production launch" } as Record<string, string>)[i.kind] ?? label(i.kind) }, { header: "Amount", cell: (i) => formatCents(i.amountCents), numeric: true }])}`;
}

async function quoteDetail(ctx: AppContext, id: string, errors: string[] = [], values?: QuoteFormValues, status = 200) {
  requireStaff(ctx, "quote.write");
  const { quote, versions, current } = await quotes.getQuote(ctx.db, ctx.actor!, id);
  const lead = await crm.getLead(ctx.db, ctx.actor!, quote.lead_id);
  const parsed = JSON.parse(current.line_items_json) as { lines: QuoteLine[]; installments: { kind: string; amountCents: number }[] };
  const extra = current.package_id && current.package_id !== "custom" ? parsed.lines.slice(1) : parsed.lines;
  const v = values ?? { packageId: current.package_id ?? "custom", scope: current.scope_text, validUntil: current.valid_until ?? "", lines: extra.map((l) => ({ description: l.description, amount: (l.amountCents / 100).toFixed(2) })) };
  const expired = !!current.valid_until && current.valid_until < today(ctx);
  return staffPage(ctx, `Quote ${quote.id}`, html`${pageHead(`Quote for ${lead.contact_name}`, html`${badge(quote.status)}${linkButton("Lead", `/staff/crm/leads/${lead.id}`, "ghost", "sm")}`, `${quote.id} · version ${quote.current_version}`)}
${expired && quote.status !== "accepted" ? alert("warn", "This version's valid-until date has passed. Save a new version with a later date before sending.") : ""}
<div class="grid grid-2"><section class="card stack"><h2 style="font-size:1.2rem">Current version (v${current.version})</h2>
${dl([["Package", quotes.packageName(current.package_id)], ["Valid until", current.valid_until ?? "—"], ["Accepted", current.accepted_at ? formatDateTime(current.accepted_at) : "Not accepted"], ["Sent to", lead.contact_email ?? "No email on file"]])}
${lineTable(parsed.lines, current.total_cents, parsed.installments)}<h3 style="font-size:1rem">Scope</h3><p>${nl2br(current.scope_text)}</p>
${quote.status !== "accepted" && can(ctx.actor!, "quote.send") ? actionForm(ctx, `/staff/quotes/${quote.id}/send`, quote.status === "sent" ? "Resend proposal" : "Send proposal", { variant: "primary", size: undefined, confirm: `Email this proposal to ${lead.contact_email ?? "the contact"}?` }) : ""}</section>
<section class="stack">${quote.status !== "accepted" ? html`<h2 style="font-size:1.2rem">Revise (saves v${quote.current_version + 1})</h2>${quoteForm(ctx, `/staff/quotes/${quote.id}`, v, errors, `Save as v${quote.current_version + 1}`)}` : alert("success", "Accepted quotes cannot be revised. Additional work needs a change order on the project.")}</section></div>
<section class="card"><h2 style="font-size:1.2rem">Version history</h2>${table(versions, [{ header: "Version", cell: (x) => `v${x.version}` }, { header: "Package", cell: (x) => quotes.packageName(x.package_id) }, { header: "Total", cell: (x) => formatCents(x.total_cents), numeric: true }, { header: "Schedule", cell: (x) => label(x.payment_schedule) }, { header: "Valid until", cell: (x) => x.valid_until ?? "—" }, { header: "Created", cell: (x) => formatDateTime(x.created_at) }, { header: "Accepted", cell: (x) => (x.accepted_at ? formatDateTime(x.accepted_at) : "—") }])}</section>`, status);
}

// ── public proposal ──
async function proposalPage(ctx: AppContext, token: string, errors: string[] = [], status = 200) {
  const p = await quotes.loadProposal(ctx.db, token, ctx.now());
  if (!p) throw new HttpError(404, "This proposal link is not valid. Ask your Crestmont contact for a new link.");
  const self = `/q/${token}`;
  const signedInMatch = ctx.user && p.contact.email && ctx.user.email.toLowerCase() === p.contact.email.toLowerCase();
  let acceptBlock: SafeHtml;
  if (p.state === "accepted") acceptBlock = alert("success", html`This proposal was accepted on ${formatDate(p.version.accepted_at)}. ${ctx.user ? html`<a href="/portal/billing">Go to billing</a>` : html`<a href="/login?next=/portal/billing">Sign in</a> to view billing.`}`);
  else if (p.state === "superseded") acceptBlock = alert("warn", "This version has been replaced by a newer proposal. Use the link in the most recent email from Crestmont.");
  else if (p.state === "expired") acceptBlock = alert("warn", "This proposal has expired. Contact us and we will send an updated proposal.");
  else if (p.state === "withdrawn") acceptBlock = alert("warn", "This proposal is no longer available.");
  else if (!ctx.user) acceptBlock = html`<div class="card card--gold stack"><h2 style="font-size:1.3rem">Ready to accept?</h2><p>To accept, sign in or create an account with <strong>${p.contact.email ?? "the email address this proposal was sent to"}</strong>.</p>
<div class="row">${linkButton("Sign in", `/login?next=${encodeURIComponent(self)}`, "primary")}${linkButton("Create account", "/register", "secondary")}</div><p class="faint">After creating an account, confirm your email, sign in, and return to this link.</p></div>`;
  else if (!signedInMatch) acceptBlock = alert("warn", html`You are signed in as ${ctx.user.email}, but this proposal was sent to a different address. <form method="post" action="/logout" style="display:inline">${csrf(ctx)}<button class="btn btn--ghost btn--sm" type="submit">Sign out</button></form> and sign in with the address the proposal was sent to.`);
  else if (!ctx.user.emailVerified) acceptBlock = alert("warn", "Confirm your email address first — check your inbox for the confirmation link — then return to this page.");
  else acceptBlock = html`<form method="post" action="${self}/accept" class="card card--gold stack">${csrf(ctx)}<h2 style="font-size:1.3rem">Accept this proposal</h2>
${checkbox("agree", "I accept this proposal, its scope and payment schedule, and the Development Agreement and Terms of Service.", { required: true })}
<p class="faint"><a href="/legal/development-agreement">Development agreement</a> · <a href="/legal/terms">Terms</a> · <a href="/legal/refunds">Refund policy</a></p>
<div class="form-actions">${button("Accept and continue to payment")}</div></form>`;
  return htmlResponse(ctx, publicLayout(ctx, { title: "Your proposal", noindex: true }, html`<section class="section"><div class="container stack" style="max-width:860px">
<div class="eyebrow">Proposal · version ${p.version.version}</div><h1>Proposal for ${p.companyName ?? p.contact.name}</h1>
${formErrors(errors)}
${dl([["Prepared for", `${p.contact.name}${p.companyName ? `, ${p.companyName}` : ""}`], ["Package", quotes.packageName(p.version.package_id)], ["Valid until", p.version.valid_until ?? "—"], ["Status", label(p.state)]])}
<section class="card stack"><h2 style="font-size:1.3rem">Scope of work</h2><p>${nl2br(p.version.scope_text)}</p></section>
<section class="card stack"><h2 style="font-size:1.3rem">Investment</h2>${lineTable(p.lines, p.version.total_cents, p.installments)}</section>
${acceptBlock}</div></section>`), status);
}

async function acceptProposalRoute(ctx: AppContext, token: string) {
  const p = await quotes.loadProposal(ctx.db, token, ctx.now());
  if (!p) throw new HttpError(404, "This proposal link is not valid.");
  if (!ctx.user) return redirect(ctx, `/login?next=${encodeURIComponent(`/q/${token}`)}`);
  const org = requireCustomerOrg(ctx);
  if (!can(ctx.actor!, "customer.approve", { organizationId: org.organizationId })) throw new HttpError(403, "Only an account administrator can accept proposals for this organization.");
  if (!ctx.user.emailVerified) return proposalPage(ctx, token, ["Confirm your email address before accepting."], 403);
  const f = await ctx.form();
  if (!f.get("agree")) return proposalPage(ctx, token, ["Tick the box to accept the proposal and agreements."], 422);
  const order = await quotes.acceptProposal(ctx, p, { id: ctx.user.id, email: ctx.user.email }, org.organizationId);
  await recordAcceptance(ctx, { userId: ctx.user.id, organizationId: org.organizationId, context: "quote_acceptance", contextId: p.version.id });
  return redirect(ctx, `/portal/billing/invoices/${order.invoiceId}`, { kind: "success", text: "Proposal accepted. Pay the first invoice to start your project." });
}

// ── package checkout ──
async function checkoutPage(ctx: AppContext, packageId: string, errors: string[] = [], status = 200) {
  const pkg = packageById(packageId);
  if (!pkg) throw new HttpError(404, "That package does not exist.");
  requireCustomerOrg(ctx);
  const configured = ctx.payments.configured;
  const cancelled = ctx.url.searchParams.get("checkout") === "cancelled";
  const priceCents = (await effectivePrice(ctx.db, "package", pkg.id, ctx.now())).cents; // CAT-007
  return htmlResponse(ctx, publicLayout(ctx, { title: `Checkout — ${pkg.name}`, noindex: true }, html`<section class="section"><div class="container stack" style="max-width:760px">
<div class="eyebrow">Checkout</div><h1>${pkg.name} website package</h1>
${cancelled ? alert("info", "Checkout was cancelled. Nothing was charged.") : ""}${formErrors(errors)}
<div class="card card--gold stack"><p class="price" data-testid="checkout-price">${formatCents(priceCents)}${pkg.priceIsFloor ? html` <small>starting price</small>` : ""}</p>
<p class="muted">Fixed price, paid 100% upfront. ${pkg.revisionRounds} revision rounds, up to ${pkg.pageLimit} pages.</p>
<ul class="checklist">${pkg.includes.map((i) => html`<li>${i}</li>`)}</ul>
${pkg.priceIsFloor ? html`<p class="faint">Need more than the standard Premium scope? <a href="/quote">Request a custom quote</a> — work above the starting price is quoted separately.</p>` : ""}</div>
${configured ? html`<form method="post" action="/checkout/${pkg.id}" class="card stack">${csrf(ctx)}
${checkbox("terms", "I agree to the Development Agreement, Terms of Service and Refund Policy.", { required: true })}
<p class="faint"><a href="/legal/development-agreement">Development agreement</a> · <a href="/legal/terms">Terms</a> · <a href="/legal/refunds">Refund policy</a></p>
<p class="faint">You will be taken to Stripe's secure checkout. Your payment is confirmed only when Stripe notifies us.</p>
<div class="form-actions">${button(`Pay ${formatCents(priceCents)}`)}</div></form>`
    : html`<div class="card stack">${alert("warn", `${NOT_CONFIGURED} You cannot pay online right now.`)}<p>We can still start your project: request a quote or contact us and we will follow up with payment options.</p>
<div class="row">${linkButton("Request a quote", "/quote", "primary")}${linkButton("Contact us", "/contact", "secondary")}</div></div>`}
</div></section>`), status);
}

async function checkoutPost(ctx: AppContext, packageId: string) {
  const pkg = packageById(packageId);
  if (!pkg) throw new HttpError(404, "That package does not exist.");
  const org = requireCustomerOrg(ctx);
  if (!can(ctx.actor!, "customer.billing", { organizationId: org.organizationId })) throw new HttpError(403, "Only an account administrator can make purchases for this organization.");
  if (!ctx.payments.configured) return checkoutPage(ctx, packageId, [`${NOT_CONFIGURED} No order was created.`], 409);
  const f = await ctx.form();
  if (!f.get("terms")) return checkoutPage(ctx, packageId, ["You must accept the agreements to continue."], 422);
  // Any client-supplied price/amount fields are ignored: the order total comes from PACKAGES.
  const res = await startPackageCheckout(ctx, { id: ctx.user!.id, email: ctx.user!.email }, org.organizationId, pkg.id);
  await recordAcceptance(ctx, { userId: ctx.user!.id, organizationId: org.organizationId, context: "package_checkout", contextId: res.orderId });
  return stripeRedirect(ctx, res.url);
}

async function maintenanceCheckoutPage(ctx: AppContext, planId: string, post: boolean) {
  const plan = maintenanceById(planId);
  if (!plan) throw new HttpError(404, "That maintenance plan does not exist.");
  const org = requireCustomerOrg(ctx);
  const monthlyCents = (await effectivePrice(ctx.db, "maintenance", plan.id, ctx.now())).cents; // CAT-007
  if (plan.entitlementsStatus !== "approved") {
    return htmlResponse(ctx, publicLayout(ctx, { title: `${plan.name} maintenance`, noindex: true }, html`<section class="section"><div class="container stack" style="max-width:720px">
<div class="eyebrow">Maintenance plans</div><h1>${plan.name} — ${formatCents(monthlyCents)}/month</h1>
${alert("warn", "Maintenance plans are not available for purchase yet. Their exact entitlements are awaiting Founder approval, and we will not sell a plan before its terms are final.")}
<div class="row">${linkButton("Contact us", "/contact", "primary")}${linkButton("Back to hosting & maintenance", "/hosting-maintenance", "secondary")}</div></div></section>`), 409);
  }
  if (!post) {
    return htmlResponse(ctx, publicLayout(ctx, { title: `${plan.name} maintenance`, noindex: true }, html`<section class="section"><div class="container stack" style="max-width:720px">
<div class="eyebrow">Maintenance plans</div><h1>${plan.name} — ${formatCents(monthlyCents)}/month</h1>
<div class="card">${dl(Object.entries(plan.proposedEntitlements).map(([k, v]) => [label(k), v]))}</div>
${ctx.payments.configured ? html`<form method="post" action="/checkout/maintenance/${plan.id}" class="card stack">${csrf(ctx)}${checkbox("terms", "I agree to the Terms of Service, Support Policy and Cancellation Policy, and authorize monthly billing until I cancel.", { required: true })}<div class="form-actions">${button("Subscribe")}</div></form>`
      : html`<div class="card stack">${alert("warn", NOT_CONFIGURED)}<div class="row">${linkButton("Contact us", "/contact", "primary")}</div></div>`}</div></section>`));
  }
  if (!can(ctx.actor!, "customer.billing", { organizationId: org.organizationId })) throw new HttpError(403, "Only an account administrator can subscribe for this organization.");
  if (!ctx.payments.configured) throw new HttpError(409, NOT_CONFIGURED);
  const f = await ctx.form();
  if (!f.get("terms")) throw new HttpError(422, "You must accept the terms to subscribe.");
  const res = await startMaintenanceCheckout(ctx, { id: ctx.user!.id, email: ctx.user!.email }, org.organizationId, plan.id);
  await recordAcceptance(ctx, { userId: ctx.user!.id, organizationId: org.organizationId, context: "maintenance_checkout", contextId: plan.id });
  return stripeRedirect(ctx, res.url);
}

export function register(r: Router): void {
  r.get("/staff/crm", crmIndex);
  r.get("/staff/crm/export.csv", crmExport);
  r.get("/staff/crm/new", (ctx) => { requireStaff(ctx, "crm.access"); return newLeadForm(ctx); });
  r.post("/staff/crm/new", async (ctx) => {
    requireStaff(ctx, "crm.access");
    if (!can(ctx.actor!, "lead.write_all") && !can(ctx.actor!, "lead.write_assigned")) throw new HttpError(403, "You cannot create leads.");
    const f = await ctx.form();
    const v = { name: str(f, "name"), email: str(f, "email"), phone: str(f, "phone"), company: str(f, "company"), website: str(f, "website"), interest: str(f, "interest"), message: str(f, "message"), source: str(f, "source") };
    const res = await crm.createManualLead(ctx.db, ctx.actor!, v);
    if (!res.ok) return newLeadForm(ctx, res.issues, v, 422);
    return redirect(ctx, `/staff/crm/leads/${res.leadId}`, { kind: "success", text: "Lead created." });
  });
  r.get("/staff/crm/contacts", contactsPage);
  r.get("/staff/crm/leads/:id", (ctx, p) => leadDetail(ctx, p.id));
  r.get("/staff/crm/leads/:id/quick", (ctx, p) => leadQuickView(ctx, p.id));
  r.post("/staff/crm/leads/:id/stage", async (ctx, p) => {
    requireStaff(ctx, "crm.access");
    await crm.getLead(ctx.db, ctx.actor!, p.id);
    const f = await ctx.form();
    const to = str(f, "to") as LeadStage;
    if (!(LEAD_STAGES as readonly string[]).includes(to)) return leadDetail(ctx, p.id, ["Choose a stage"], 422);
    try {
      await changeLeadStage(ctx.db, ctx.actor!, p.id, to, { reason: str(f, "reason") || undefined });
    } catch (e) {
      const st = (e as { status?: number }).status;
      if (st === 403 || st === 404) throw new HttpError(st, (e as Error).message);
      return leadDetail(ctx, p.id, [stageError(e)], 422);
    }
    return redirect(ctx, `/staff/crm/leads/${p.id}`, { kind: "success", text: `Stage changed to ${label(to)}.` });
  });
  r.post("/staff/crm/leads/:id/note", async (ctx, p) => {
    const f = await ctx.form();
    const kind = (["note", "call", "email"].includes(str(f, "kind")) ? str(f, "kind") : "note") as "note" | "call" | "email";
    return leadAction(ctx, p.id, (lead) => crm.addNote(ctx.db, ctx.actor!, lead, str(f, "body"), kind), "Added to history.");
  });
  r.post("/staff/crm/leads/:id/task", async (ctx, p) => {
    const f = await ctx.form();
    return leadAction(ctx, p.id, (lead) => crm.addTask(ctx.db, ctx.actor!, lead, str(f, "body"), str(f, "due")), "Follow-up scheduled.");
  });
  r.post("/staff/crm/leads/:id/tasks/:taskId/complete", (ctx, p) => leadAction(ctx, p.id, (lead) => crm.completeTask(ctx.db, ctx.actor!, lead, p.taskId), "Task completed."));
  r.post("/staff/crm/leads/:id/contact", async (ctx, p) => {
    const f = await ctx.form();
    return leadAction(ctx, p.id, (lead) => crm.updateContact(ctx.db, ctx.actor!, lead, { name: str(f, "name"), email: str(f, "email"), phone: str(f, "phone"), company: str(f, "company"), website: str(f, "website"), qualificationNotes: str(f, "qualification_notes") }), "Contact updated.");
  });
  r.post("/staff/crm/leads/:id/assign", async (ctx, p) => {
    requireStaff(ctx, "lead.assign");
    await crm.getLead(ctx.db, ctx.actor!, p.id);
    const f = await ctx.form();
    await crm.assignOwner(ctx.db, ctx.actor!, p.id, str(f, "owner") || null);
    return redirect(ctx, `/staff/crm/leads/${p.id}`, { kind: "success", text: "Owner updated." });
  });
  r.post("/staff/crm/leads/:id/ai-draft", async (ctx, p) => {
    requireStaff(ctx, "crm.access");
    const lead = await crm.getLead(ctx.db, ctx.actor!, p.id);
    if (!can(ctx.actor!, "lead.write_all") && lead.owner_user_id !== ctx.actor!.userId) throw new HttpError(403, "This lead is not assigned to you.");
    const prompt = [`Draft lead qualification notes for a website development agency.`, `Interest: ${lead.interest ?? "unknown"}`, `Source: ${lead.source}`, `Company: ${lead.company_name ?? "unknown"}`, `Website: ${lead.company_website ?? "none given"}`,
      `Message from the prospect:\n${lead.message ?? "(none)"}`, `Existing notes:\n${lead.qualification_notes ?? "(none)"}`,
      `Approved packages: Starter $999 (5 pages), Business $2,499 (12 pages), Premium from $4,999 (25 pages); larger work is a custom quote. Summarize fit, likely package, open questions, and suggested next step. Do not quote new prices or promise dates.`].join("\n");
    const res = await requestAiDraft(ctx.db, aiProviderFromEnv(ctx.env), { workflow: "lead_qualification", inputRef: `lead:${lead.id}`, prompt, requestedBy: ctx.user!.id });
    return redirect(ctx, `/staff/crm/leads/${p.id}`, res.status === "failed" ? { kind: "error", text: res.error ?? "AI draft failed." } : { kind: "success", text: "AI draft ready for review." });
  });
  r.post("/staff/crm/leads/:id/ai-draft/:jobId", async (ctx, p) => {
    requireStaff(ctx, "crm.access");
    const lead = await crm.getLead(ctx.db, ctx.actor!, p.id);
    if (!can(ctx.actor!, "lead.write_all") && lead.owner_user_id !== ctx.actor!.userId) throw new HttpError(403, "This lead is not assigned to you.");
    const job = await ctx.db.prepare(`SELECT id, output_ref FROM ai_jobs WHERE id = ? AND input_ref = ? AND workflow = 'lead_qualification'`).bind(p.jobId, `lead:${lead.id}`).first<{ id: string; output_ref: string | null }>();
    if (!job) throw new HttpError(404, "AI draft not found.");
    const decision = str(await ctx.form(), "decision") === "approved" ? "approved" : "rejected";
    try { await decideAiJob(ctx.db, job.id, ctx.user!.id, decision); } catch (e) { throw new HttpError(409, (e as Error).message); }
    if (decision === "approved" && job.output_ref) {
      await ctx.db.prepare(`UPDATE leads SET qualification_notes = ?, updated_at = ? WHERE id = ?`).bind(job.output_ref.slice(0, 5000), new Date().toISOString(), lead.id).run();
    }
    return redirect(ctx, `/staff/crm/leads/${p.id}`, { kind: "success", text: decision === "approved" ? "Draft saved to qualification notes." : "Draft discarded." });
  });

  r.get("/staff/customers", customersPage);
  r.get("/staff/customers/:id", (ctx, p) => customerPage(ctx, p.id));
  r.get("/staff/sales", salesPage);

  r.get("/staff/quotes", quotesList);
  r.get("/staff/quotes/new", (ctx) => newQuotePage(ctx));
  r.post("/staff/quotes/new", async (ctx) => {
    requireStaff(ctx, "quote.write");
    const leadId = ctx.url.searchParams.get("lead") ?? "";
    const { values, input: qi, issues } = readQuoteForm(await ctx.form());
    if (!qi) return newQuotePage(ctx, issues, values, 422);
    const res = await quotes.saveQuote(ctx.db, ctx.actor!, leadId, null, qi, today(ctx));
    if (!res.ok) return newQuotePage(ctx, res.issues, values, 422);
    return redirect(ctx, `/staff/quotes/${res.quoteId}`, { kind: "success", text: `Draft saved: ${formatCents(res.price.totalCents)}.` });
  });
  r.get("/staff/quotes/:id", (ctx, p) => quoteDetail(ctx, p.id));
  r.post("/staff/quotes/:id", async (ctx, p) => {
    requireStaff(ctx, "quote.write");
    const { quote } = await quotes.getQuote(ctx.db, ctx.actor!, p.id);
    const { values, input: qi, issues } = readQuoteForm(await ctx.form());
    if (!qi) return quoteDetail(ctx, p.id, issues, values, 422);
    const res = await quotes.saveQuote(ctx.db, ctx.actor!, quote.lead_id, quote.id, qi, today(ctx));
    if (!res.ok) return quoteDetail(ctx, p.id, res.issues, values, 422);
    return redirect(ctx, `/staff/quotes/${p.id}`, { kind: "success", text: `Saved as v${res.version} (draft). Send it when ready.` });
  });
  r.post("/staff/quotes/:id/send", async (ctx, p) => {
    requireStaff(ctx, "quote.send");
    const res = await quotes.sendQuote(ctx, ctx.actor!, p.id);
    return redirect(ctx, `/staff/quotes/${p.id}`, { kind: res.stageNote ? "info" : "success", text: `Proposal emailed.${res.stageNote ? " " + res.stageNote : ""}` });
  });

  r.get("/q/:token", (ctx, p) => proposalPage(ctx, p.token));
  r.post("/q/:token/accept", (ctx, p) => acceptProposalRoute(ctx, p.token));

  r.get("/checkout/maintenance/:planId", (ctx, p) => maintenanceCheckoutPage(ctx, p.planId, false));
  r.post("/checkout/maintenance/:planId", (ctx, p) => maintenanceCheckoutPage(ctx, p.planId, true));
  r.get("/checkout/:packageId", (ctx, p) => checkoutPage(ctx, p.packageId));
  r.post("/checkout/:packageId", (ctx, p) => checkoutPost(ctx, p.packageId));
}

