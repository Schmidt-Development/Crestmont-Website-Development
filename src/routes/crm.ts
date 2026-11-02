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
import { quoteDefaultValidUntil } from "../services/quotes.ts";
import * as dedupe from "../services/crm-dedupe.ts";
import * as identity from "../services/contact-identity.ts";
import { eraseIdentityData, ErasureError } from "../services/identity-erasure.ts";
import { isOwner } from "../domain/authz.ts";
import { startPackageCheckout, startMaintenanceCheckout, packageById, maintenanceById, NOT_CONFIGURED, stripeRedirect } from "../services/billing.ts";
import { requestAiDraft, aiProviderFromEnv, decideAiJob } from "../services/ai.ts";
import { audit } from "../services/security.ts";
import { toCsv, parseDollars, parseRange } from "../services/finance.ts";
import { TransitionError } from "../domain/state-machine.ts";
import { recordAcceptance } from "../services/agreements.ts";
import { effectivePrice } from "../services/pricing-approvals.ts";
import { loadTaxConfig, taxLabel } from "../services/tax.ts";
import { computeTax, type TaxResult } from "../domain/tax.ts";
import { usd } from "../services/finance-documents.ts";
import { businessDate } from "../lib/business-time.ts";
import { requireVerifiedForPayment } from "./verify-gate.ts";
import { effectivePrices } from "../services/pricing-approvals.ts";
import { staffCanSeeProject } from "../services/projects.ts";
import { disabledOwnerFlag } from "../services/offboarding.ts";

/** LEGAL-005: estimated tax per quote line under the current configuration (null when tax is not configured). */
async function quoteTax(ctx: AppContext, packageId: string | null, lines: QuoteLine[]): Promise<TaxResult | null> {
  const key = packageId && packageId in PACKAGES ? packageId : "custom";
  const r = computeTax(lines.map((l) => ({ description: l.description, amountCents: l.amountCents, productKey: key })), await loadTaxConfig(ctx.db));
  return r.configured ? r : null;
}

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

/** Only same-site staff paths are accepted as a post-action return location. */
const safeBack = (s: string, fallback: string) => (/^\/staff\/[A-Za-z0-9/_.?=&-]*$/.test(s) && !s.startsWith("//") ? s : fallback);

const pct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);
const today = (ctx: AppContext) => businessDate(ctx.now()); // CREST-GAP-094: Eastern calendar date

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
  return staffPage(ctx, "CRM", html`${pageHead("CRM pipeline", html`${linkButton("Export CSV", exportHref, "ghost", "sm")}${linkButton("Contacts", "/staff/crm/contacts", "ghost", "sm")}${linkButton("Duplicates", "/staff/crm/duplicates", "ghost", "sm")}${linkButton("Add lead", "/staff/crm/new", "primary", "sm")}`, all ? "All leads" : "Leads assigned to you")}
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
type DupPreview = Awaited<ReturnType<typeof identity.previewMatches>>;
/** Matching records shown before anything is saved (CRM duplicate protection). */
function duplicateWarning(ctx: AppContext, d: DupPreview, v: Record<string, string>): SafeHtml {
  const canLink = (m: DupPreview["matches"][number]) => !!m.contactId && (m.strength !== "weak" || !!m.leadId);
  return html`<section class="card stack" data-duplicate-warning role="alert"><h2 style="font-size:1.2rem">This contact may already be in the CRM</h2>
<p class="muted">Nothing has been saved yet. ${d.suppressed.phone ? html`<strong>The phone number is on the do-not-call list.</strong> ` : ""}${d.suppressed.email ? html`<strong>The email address is suppressed.</strong> ` : ""}${d.suppressed.erased ? html`<strong>An erasure request is on file for this person.</strong> ` : ""}A shared phone line or inbox can belong to several businesses, so check the company before linking.</p>
${table(d.matches, [
    { header: "Record", cell: (m) => m.leadId ? html`<a href="/staff/crm/leads/${m.leadId}" target="_blank" rel="noopener">${m.contactName}</a>` : m.contactName },
    { header: "Company", cell: (m) => m.companyName ?? "—" },
    { header: "Matched on", cell: (m) => m.reasons.map((r) => label(r)).join(", ") },
    { header: "Match", cell: (m) => badge(m.strength === "strong" ? "warning" : "draft", m.strength === "strong" ? "Same contact" : m.strength === "ambiguous" ? "Same identifier, different business details" : m.strength === "shared" ? "Shared identifier" : "Similar business") },
    { header: "Status", cell: (m) => html`${m.customer ? badge("active", "Customer") : ""} ${m.stage ? badge(m.stage) : ""}` },
  ], { caption: "Matching CRM records" })}
<form method="post" action="/staff/crm/new" class="stack">${csrf(ctx)}
${(["name", "email", "phone", "company", "website", "source", "interest", "message"] as const).map((k) => html`<input type="hidden" name="${k}" value="${v[k] ?? ""}">`)}
<fieldset class="stack"><legend>What should happen?</legend>
${d.matches.filter(canLink).map((m, i) => html`<label class="checkbox"><input type="radio" name="resolution" value="link:${m.contactId}"${i === 0 ? " checked" : ""}> Add this lead to <strong>${m.contactName}</strong>${m.companyName ? ` (${m.companyName})` : ""}</label>`)}
<label class="checkbox"><input type="radio" name="resolution" value="create_new"${d.matches.some(canLink) ? "" : " checked"}> Create a separate record — it is a different person or business</label>
</fieldset>
<div class="form-actions">${button("Continue")}${linkButton("Cancel", "/staff/crm", "ghost")}</div></form></section>`;
}

function newLeadForm(ctx: AppContext, errors: string[] = [], v: Record<string, string> = {}, status = 200, dups?: DupPreview) {
  return staffPage(ctx, "Add lead", html`${pageHead("Add a lead", linkButton("Back to CRM", "/staff/crm", "ghost", "sm"), "CRM")}${formErrors(errors)}
${dups ? duplicateWarning(ctx, dups, v) : ""}
<form method="post" action="/staff/crm/new" class="card stack" style="max-width:720px" data-dup-check="/staff/crm/new/matches">${csrf(ctx)}
${input({ name: "name", label: "Contact name", value: v.name, required: true })}
${input({ name: "email", label: "Email", type: "email", value: v.email, hint: "Email or phone is required. Proposals are sent to this address." })}
${input({ name: "phone", label: "Phone", type: "tel", value: v.phone })}
${input({ name: "company", label: "Company", value: v.company })}${input({ name: "website", label: "Company website", type: "url", value: v.website, placeholder: "https://" })}
<div data-dup-preview aria-live="polite"></div>
${select({ name: "source", label: "Source", options: [{ value: "manual", label: "Manual entry" }, { value: "referral", label: "Referral" }], value: v.source ?? "manual" })}
${select({ name: "interest", label: "Interested in", options: ["starter", "business", "premium", "custom", "maintenance", "other"], value: v.interest ?? "custom" })}
${textarea({ name: "message", label: "Notes", value: v.message, rows: 4 })}
<p class="faint">Before anything is saved, the email, phone and website are checked against existing contacts and customers.</p>
<div class="form-actions">${button("Create lead")}</div></form>`, status);
}

/** Live duplicate hint for the Add-lead form (HTML fragment; the form works the same without JavaScript). */
async function newLeadMatches(ctx: AppContext) {
  requireStaff(ctx, "crm.access");
  if (!can(ctx.actor!, "lead.write_all") && !can(ctx.actor!, "lead.write_assigned")) throw new HttpError(403, "You cannot create leads.");
  const q = (k: string) => (ctx.url.searchParams.get(k) ?? "").trim().slice(0, 300);
  const d = await crm.redactPreview(ctx.db, ctx.actor!, await identity.previewMatches(ctx.db, { contactName: q("name") || null, businessName: q("company") || null, website: q("website") || null, emails: q("email") ? [{ value: q("email") }] : [], phones: q("phone") ? [{ value: q("phone") }] : [] }));
  const body = d.matches.length || d.suppressed.phone || d.suppressed.email
    ? html`<div class="alert alert--warn" data-dup-hint><strong>${d.matches.length ? `${d.matches.length} possible match${d.matches.length === 1 ? "" : "es"} in the CRM` : "Suppressed contact"}.</strong>
${d.matches.slice(0, 5).map((m) => html` <span>${m.contactName}${m.companyName ? ` (${m.companyName})` : ""} · ${m.reasons.map((r) => label(r)).join(", ")}${m.customer ? " · customer" : ""}</span>`)}
${d.suppressed.phone ? html` <span>Phone is on the do-not-call list.</span>` : ""}${d.suppressed.email ? html` <span>Email is suppressed.</span>` : ""} You will be asked what to do when you save.</div>`
    : html`<p class="faint" data-dup-hint>No matching contacts found.</p>`;
  return htmlResponse(ctx, body);
}

// ── lead detail ──
async function leadDetail(ctx: AppContext, id: string, errors: string[] = [], status = 200) {
  requireStaff(ctx, "crm.access");
  const actor = ctx.actor!;
  const lead = await crm.getLead(ctx.db, actor, id);
  const [acts, links, staff, ai, dups] = await Promise.all([
    crm.activities(ctx.db, id), crm.leadLinks(ctx.db, lead), can(actor, "lead.assign") ? crm.salesStaff(ctx.db) : Promise.resolve([]),
    ctx.db.prepare(`SELECT id, status, output_ref, error, created_at FROM ai_jobs WHERE workflow = 'lead_qualification' AND input_ref = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(`lead:${id}`).first<{ id: string; status: string; output_ref: string | null; error: string | null; created_at: string }>(),
    lead.merged_into_lead_id ? Promise.resolve([]) : dedupe.duplicatesOf(ctx.db, actor, lead),
  ]);
  const idp = await identity.contactIdentityPanel(ctx.db, lead.contact_id);
  const writable = !lead.merged_into_lead_id && (can(actor, "lead.write_all") || (can(actor, "lead.write_assigned") && lead.owner_user_id === actor.userId));
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
  const dupCard = dups.length ? html`<section class="card stack" data-duplicates><h2 style="font-size:1.2rem">Possible duplicates (${dups.length})</h2>
<p class="muted">These leads share an email address, phone number, or name and company with this lead. Merging moves activities, quotes, orders and calls to the surviving lead, fills blank contact details, and archives the other lead (it stays in history).</p>
${table(dups, [
    { header: "Lead", cell: (d) => html`<a href="/staff/crm/leads/${d.id}">${d.contact_name}</a><br><span class="faint">${d.contact_email ?? d.contact_phone ?? ""}</span>` },
    { header: "Company", cell: (d) => d.company_name ?? "—" }, { header: "Stage", cell: (d) => badge(d.stage) }, { header: "Created", cell: (d) => formatDate(d.created_at) },
    { header: "Matched on", cell: (d) => d.reasons.map((r) => label(r)).join(", ") },
    { header: "", cell: (d) => writable ? html`${actionForm(ctx, `/staff/crm/leads/${d.id}/merge`, "Merge it into this lead", { hidden: { into: id }, confirm: `Merge ${d.contact_name} into this lead? The other lead is archived.` })}
${actionForm(ctx, `/staff/crm/leads/${id}/merge`, "Merge this lead into it", { variant: "ghost", hidden: { into: d.id }, confirm: "Merge this lead into the other one? This lead is archived." })}
${actionForm(ctx, "/staff/crm/duplicates/dismiss", "Not a duplicate", { variant: "ghost", hidden: { a: id, b: d.id, back: `/staff/crm/leads/${id}` } })}` : "" },
  ], { caption: "Possible duplicate leads" })}</section>` : html``;
  const body = html`${pageHead(lead.contact_name, html`${badge(lead.stage)}${can(actor, "quote.write") && writable && !lead.merged_into_lead_id ? linkButton("New quote", `/staff/quotes/new?lead=${id}`, "primary", "sm") : ""}`, lead.company_name ?? "Lead")}
${lead.merged_into_lead_id ? alert("info", html`This lead was merged into <a href="/staff/crm/leads/${lead.merged_into_lead_id}">lead ${lead.merged_into_lead_id}</a>. Its history moved there; this record is archived and kept for reference.`) : ""}
${formErrors(errors)}${dupCard}${await (async () => { const flag = await disabledOwnerFlag(ctx.db, ["lead"], id); return (flag ? alert("warn", html`<strong>Owner disabled.</strong> ${flag.name}'s account was disabled; ${flag.status === "ended" ? "their assignment was ended, so this needs a new owner." : "this is waiting in the offboarding queue for a new owner."}`) : ""); })()}
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
${identityCard(ctx, idp)}
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

/** Contact identity, provenance, suppression and outreach ledger (CRM duplicate protection). */
function identityCard(ctx: AppContext, p: Awaited<ReturnType<typeof identity.contactIdentityPanel>>): SafeHtml {
  const active = p.identifiers.filter((i) => !i.removed_at), past = p.identifiers.filter((i) => i.removed_at);
  return html`<section class="card stack" data-identity><h2 style="font-size:1.2rem">Contact identity &amp; provenance</h2>
${p.openReviews ? alert("warn", html`${p.openReviews} item${p.openReviews === 1 ? "" : "s"} about this contact ${p.openReviews === 1 ? "is" : "are"} waiting in the <a href="/staff/crm/duplicates?view=review">duplicate review queue</a>.`) : ""}
${active.length ? table(active, [
    { header: "Identifier", cell: (i) => html`${i.original_value}<br><span class="faint">${i.kind === "phone" ? i.value_norm : label(i.kind)}${i.label ? ` · ${label(i.label)}` : ""}${i.role === "additional" ? " · additional" : ""}</span>` },
    { header: "Status", cell: (i) => html`${i.suppressed ? badge("escalated", i.kind === "phone" ? "Do not call" : "Suppressed") : ""} ${i.verification_status === "verified" ? badge("verified") : badge("pending", "Unverified")} ${i.shared || i.contacts > 1 ? badge("warning", `Shared · ${i.contacts} contacts`) : ""}` },
    { header: "Source", cell: (i) => html`${label(i.source)}<br><span class="faint">confidence ${i.confidence} · since ${formatDate(i.created_at)}</span>` },
    { header: "Outreach ledger", cell: (i) => i.kind !== "phone" ? "—" : i.attempts === null ? html`<span class="faint">Never dialled</span>` : html`${i.attempts} attempt${i.attempts === 1 ? "" : "s"}${i.last_attempt_at ? `, last ${formatDate(i.last_attempt_at)}` : ""}${i.last_outcome ? html`<br><span class="faint">${i.last_outcome}</span>` : ""}${i.call_state && i.call_state !== "idle" ? html`<br>${badge("in_progress", `${label(i.call_state)} until ${formatDateTime(i.lease_expires_at)}`)}` : ""}` },
  ], { caption: "Phone numbers and email addresses" }) : html`<p class="muted">No phone number or email address on file.</p>`}
<p class="faint">Duplicate protection never makes a number callable: outbound calls still need staff approval, recorded consent for the purpose, no do-not-call entry, the recipient's calling hours and the per-number limits.</p>
${past.length ? html`<details><summary>Previous identifiers (${past.length})</summary><ul>${past.map((i) => html`<li>${i.original_value} <span class="faint">(${label(i.source)}, removed ${formatDate(i.removed_at)})</span></li>`)}</ul></details>` : ""}
${p.decisions.length ? html`<details><summary>Intake decisions (${p.decisions.length})</summary>${table(p.decisions, [
    { header: "When", cell: (d) => formatDateTime(d.created_at) }, { header: "Channel", cell: (d) => label(d.channel) }, { header: "Outcome", cell: (d) => label(d.outcome.toLowerCase()) }, { header: "Rule", cell: (d) => d.rule ? label(d.rule) : "—" }], { caption: "Intake decisions" })}</details>` : ""}
${p.changes.length ? html`<details><summary>Merge and edit history (${p.changes.length})</summary>${table(p.changes, [
    { header: "When", cell: (c) => formatDateTime(c.created_at) }, { header: "Field", cell: (c) => label(c.field) }, { header: "Change", cell: (c) => html`${c.old_value ?? "—"} → ${c.new_value ?? "—"}` },
    { header: "By", cell: (c) => c.actor ?? label(c.source) }, { header: "Rule", cell: (c) => label(c.rule) }], { caption: "Field changes" })}</details>` : ""}
</section>`;
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

// ── duplicates (CRM-002) ──
/** Tabs shared by the duplicate-protection views (existing Duplicates screen; no new navigation section). */
function duplicateTabs(ctx: AppContext, current: "groups" | "review" | "analytics", openReviews: number): SafeHtml {
  return tabs([{ href: "/staff/crm/duplicates", label: "Duplicate leads", current: current === "groups" },
    { href: "/staff/crm/duplicates?view=review", label: `Review queue (${openReviews})`, current: current === "review" },
    { href: "/staff/crm/duplicates?view=analytics", label: "Duplicate prevention", current: current === "analytics" }]);
}

async function duplicatesPage(ctx: AppContext) {
  requireStaff(ctx, "crm.access");
  const view = ctx.url.searchParams.get("view");
  if (view === "review") return reviewQueuePage(ctx);
  if (view === "analytics") return duplicateAnalyticsPage(ctx);
  const actor = ctx.actor!;
  const openReviews = !can(actor, "lead.read_all") ? 0 : (await ctx.db.prepare(`SELECT COUNT(*) AS n FROM crm_identity_reviews WHERE status = 'open'`).first<{ n: number }>())?.n ?? 0;
  const pageNo = parseInt(ctx.url.searchParams.get("page") ?? "1", 10) || 1;
  const result = await dedupe.findDuplicateClusters(ctx.db, actor, { page: pageNo });
  const clusters = result.clusters;
  const offset = (result.page - 1) * dedupe.CLUSTERS_PER_PAGE;
  const canWrite = (l: dedupe.DupLead) => can(actor, "lead.write_all") || (can(actor, "lead.write_assigned") && l.owner_user_id === actor.userId);
  return staffPage(ctx, "Duplicate leads", html`${pageHead("Duplicate leads", linkButton("Pipeline", "/staff/crm", "ghost", "sm"), can(actor, "lead.read_all") ? "All leads" : "Leads assigned to you")}
${duplicateTabs(ctx, "groups", openReviews)}
<p class="muted">Leads are grouped when their contacts share a normalized email address, a phone number (digits only, US country code ignored) or the same name at the same company. The suggested survivor is the most advanced lead (then the oldest). Merging is audited and cannot silently drop data: activities, quotes, orders and calls move to the survivor, blank contact fields are filled, and the merged lead is archived with a link to the survivor.</p>
${result.truncated ? alert("warn", html`More than ${dedupe.MAX_DUPLICATE_ROWS} matching lead keys were found; groups are built from the first ${dedupe.MAX_DUPLICATE_ROWS}. Merge or dismiss these, then reload to see the rest.`) : ""}
${result.totalClusters > clusters.length ? html`<p class="faint" data-showing>Showing groups ${offset + (clusters.length ? 1 : 0)}–${offset + clusters.length} of ${result.totalClusters}.</p>` : ""}
${clusters.length ? clusters.map((c, j) => { const i = offset + j;
    const survivor = c.leads.find((l) => l.id === c.survivorId)!;
    return html`<section class="card stack" data-cluster="${i + 1}"><h2 style="font-size:1.2rem">${survivor.contact_name} · ${c.leads.length} leads <span class="faint">matched on ${c.reasons.map((r) => label(r)).join(", ")}</span></h2>
${table(c.leads, [
      { header: "Lead", cell: (l) => html`<a href="/staff/crm/leads/${l.id}">${l.contact_name}</a>${l.id === c.survivorId ? html` ${badge("active", "Suggested survivor")}` : ""}` },
      { header: "Email", cell: (l) => l.contact_email ?? "—" }, { header: "Phone", cell: (l) => l.contact_phone ?? "—" }, { header: "Company", cell: (l) => l.company_name ?? "—" },
      { header: "Stage", cell: (l) => badge(l.stage) }, { header: "Source", cell: (l) => label(l.source) }, { header: "Owner", cell: (l) => l.owner_name ?? "Unassigned" }, { header: "Created", cell: (l) => formatDate(l.created_at) },
      { header: "", cell: (l) => l.id === c.survivorId || !canWrite(l) || !canWrite(survivor) ? "" : html`${actionForm(ctx, `/staff/crm/leads/${l.id}/merge`, "Merge into survivor", { hidden: { into: c.survivorId, back: "/staff/crm/duplicates" }, confirm: `Merge ${l.contact_name} (${l.id}) into ${c.survivorId}?` })}
${actionForm(ctx, "/staff/crm/duplicates/dismiss", "Not a duplicate", { variant: "ghost", hidden: { a: l.id, b: c.survivorId, back: "/staff/crm/duplicates" } })}` },
    ], { caption: `Duplicate group ${i + 1}` })}<p class="faint">To keep a different lead, open it and merge the others into it from its page.</p></section>`;
  }) : emptyState(result.page > 1 ? "No more duplicate groups" : "No duplicates found", "No two visible leads share an email, phone number, or name and company.")}
${result.totalClusters > dedupe.CLUSTERS_PER_PAGE || result.page > 1 ? pagination(ctx, result.page, result.hasNext) : ""}`);
}

const REVIEW_KIND: Record<string, string> = { possible_duplicate: "Possible duplicate", field_conflict: "Conflicting value", customer_match: "Existing customer", historical_duplicate: "Historical duplicate" };

async function reviewQueuePage(ctx: AppContext) {
  requireStaff(ctx, "crm.access");
  const actor = ctx.actor!;
  // Review items carry names and proposed phone numbers/emails for any record: only staff who can see every lead.
  if (!can(actor, "lead.read_all")) {
    return staffPage(ctx, "Duplicate review queue", html`${pageHead("Duplicate review queue", linkButton("Pipeline", "/staff/crm", "ghost", "sm"), "CRM duplicate protection")}
${duplicateTabs(ctx, "review", 0)}${emptyState("Handled by the Owner", "Possible duplicates and conflicting contact details are reviewed by the Owner. Duplicates of your own leads are shown on each lead's page.")}`);
  }
  const status = ctx.url.searchParams.get("status") ?? "open";
  const pageNo = parseInt(ctx.url.searchParams.get("page") ?? "1", 10) || 1;
  const { rows, total, hasNext } = await identity.listReviews(ctx.db, { status, page: pageNo });
  const openReviews = status === "open" ? total : (await ctx.db.prepare(`SELECT COUNT(*) AS n FROM crm_identity_reviews WHERE status = 'open'`).first<{ n: number }>())?.n ?? 0;
  const canResolve = can(actor, "lead.write_all");
  const owner = actor.roles.some((r) => r.role === "owner");
  const act = (r: identity.ReviewRow, decision: string, text: string, variant: "primary" | "secondary" | "ghost" = "secondary", confirm?: string) =>
    actionForm(ctx, "/staff/crm/identity-reviews/resolve", text, { hidden: { id: r.id, decision, back: `/staff/crm/duplicates?view=review` }, variant, ...(confirm ? { confirm } : {}) });
  return staffPage(ctx, "Duplicate review queue", html`${pageHead("Duplicate review queue", linkButton("Pipeline", "/staff/crm", "ghost", "sm"), "CRM duplicate protection")}
${duplicateTabs(ctx, "review", openReviews)}
<p class="muted">Items the CRM would not decide on its own: records that may be the same business, values that conflict with what is already on file, and matches with existing customers. Nothing here has been applied. Changes to an existing customer's records need the Owner.</p>
<form method="get" class="filters" action="/staff/crm/duplicates"><input type="hidden" name="view" value="review">
${select({ name: "status", label: "Status", options: [{ value: "open", label: "Open" }, { value: "applied", label: "Applied" }, { value: "linked", label: "Linked" }, { value: "created_new", label: "Created separately" }, { value: "rejected", label: "Rejected" }], value: status })}
<div class="field">${button("Show", { variant: "secondary", size: "sm" })}</div></form>
${rows.length ? table(rows, [
    { header: "Type", cell: (r) => html`${badge(r.kind === "customer_match" ? "escalated" : r.kind === "field_conflict" ? "negotiation" : "review", REVIEW_KIND[r.kind] ?? label(r.kind))}${r.customer ? html` ${badge("active", "Customer")}` : ""}` },
    { header: "Record", cell: (r) => r.lead_id ? html`<a href="/staff/crm/leads/${r.lead_id}">${r.contact_name ?? r.lead_id}</a>${r.company_name ? html`<br><span class="faint">${r.company_name}</span>` : ""}` : html`<span class="faint">No CRM record yet</span>` },
    { header: "Details", cell: (r) => html`${r.field ? html`<strong>${label(r.field)}</strong>: <span class="faint">on file</span> ${r.current_value ?? "—"} → <span class="faint">proposed</span> ${r.proposed_value ?? "—"}<br>` : ""}${r.reason}` },
    { header: "Source", cell: (r) => html`${label(r.proposed_source ?? "—")}${r.proposed_confidence !== null ? html`<br><span class="faint">confidence ${r.proposed_confidence}</span>` : ""}` },
    { header: "Received", cell: (r) => formatDateTime(r.created_at) },
    { header: "", cell: (r) => r.status !== "open" ? badge(r.status) : !canResolve ? html`<span class="faint">Needs an administrator</span>` : r.customer && !owner && r.kind !== "possible_duplicate" ? html`${act(r, "reject", "Reject", "ghost")}<br><span class="faint">Owner applies customer changes</span>` : html`
${r.kind === "field_conflict" ? act(r, "apply", r.field === "email" || r.field === "phone" ? "Add as additional" : "Apply change", "primary", "Apply this value to the existing record? The change is recorded in its history.") : ""}
${r.has_candidate && r.contact_id ? act(r, "link", "Link to this record", "primary") : ""}
${r.has_candidate ? act(r, "create_new", "Create separately", "secondary", "Create a separate CRM record for this business?") : ""}
${act(r, "reject", r.has_candidate ? "Discard" : "Keep existing", "ghost")}` },
  ], { caption: "Duplicate review queue" }) : emptyState(status === "open" ? "Nothing to review" : "No items", status === "open" ? "Imports, forms and edits that need a person's decision appear here." : "No review items with this status.")}
${total > 25 || pageNo > 1 ? pagination(ctx, pageNo, hasNext) : ""}
${owner ? html`<details class="card stack" data-identity-erasure><summary><strong>Erase a person's CRM data (privacy request)</strong></summary>
<p class="muted">For someone who is not an account holder or receptionist caller (those have their own erasure flows, which also run this). Removes their phone numbers and email addresses from contacts identified only by them, from CRM identity records, held research records, review items and field history. Customers, payments, contracts and businesses that share a number or inbox are kept. Do-not-call and email suppressions are kept so opt-outs are honoured. You will be asked to confirm your authenticator.</p>
<form method="post" action="/staff/crm/identity-erasure" class="stack" data-confirm="Erase this person's CRM data? This cannot be undone.">${csrf(ctx)}
${textarea({ name: "phones", label: "Phone numbers (one per line)", rows: 2 })}${textarea({ name: "emails", label: "Email addresses (one per line)", rows: 2 })}
${textarea({ name: "note", label: "Who asked, and how", rows: 2, required: true })}
<label class="checkbox"><input type="checkbox" name="allow_reimport" value="1"> Allow research imports to add these identifiers again (by default a one-way hash is kept so they are not re-imported)</label>
<div class="form-actions">${button("Erase CRM data", { variant: "danger" })}</div></form></details>` : ""}`);
}

async function duplicateAnalyticsPage(ctx: AppContext) {
  requireStaff(ctx, "crm.access");
  const since = new Date(ctx.now().getTime() - 30 * 86400e3).toISOString();
  const a = await identity.duplicateAnalytics(ctx.db, since);
  const openReviews = a.reviews.filter((r) => r.status === "open").reduce((s, r) => s + r.n, 0);
  const total = Object.values(a.totals).reduce((s, n) => s + n, 0);
  return staffPage(ctx, "Duplicate prevention", html`${pageHead("Duplicate prevention", linkButton("Pipeline", "/staff/crm", "ghost", "sm"), "Last 30 days")}
${duplicateTabs(ctx, "analytics", openReviews)}
<div class="grid grid-3">${kpi("Intake decisions", String(total))}${kpi("Duplicates prevented", String(a.prevented), "linked, merged, held for review or suppressed instead of creating a new lead")}${kpi("Open review items", String(openReviews))}</div>
<div class="grid grid-3" style="margin-top:1rem">${kpi("Canonical phone numbers", String(a.identities.phones), `${a.identities.shared} identifiers shared by several businesses`)}${kpi("Canonical email addresses", String(a.identities.emails))}${kpi("Outbound numbers in ledger", String(a.ledger.numbers), `${a.ledger.reserved} reserved now · ${a.ledger.denied} duplicate dial attempts refused`)}</div>
<section class="card" style="margin-top:1rem"><h2 class="card__title">Outcomes by channel</h2>${table(a.byOutcome, [
    { header: "Outcome", cell: (r) => badge(r.outcome === "CREATED" ? "new" : r.outcome === "REJECTED_INVALID" || r.outcome === "SUPPRESSED" ? "escalated" : "review", label(r.outcome.toLowerCase())) },
    { header: "Channel", cell: (r) => label(r.channel) }, { header: "Count", cell: (r) => r.n, numeric: true }],
    { empty: html`<p class="muted">No intake decisions in the last 30 days.</p>`, caption: "Intake outcomes by channel" })}</section>
${definitions([["Intake decision", "Every manual entry, web form, lead API submission, receptionist lead and research-agent record is decided once and recorded with its outcome, evidence and idempotency key (crm_intake_decisions)."],
    ["Duplicates prevented", "Decisions that linked to, updated or merged into an existing contact, were held for review, made no change, or were refused because the contact is suppressed."],
    ["Shared identifier", "A phone number or email linked to more than one business (receptionist line, franchise headquarters, agency inbox). It never merges the businesses; it does mean one outreach ledger row for all of them."],
    ["Duplicate dial attempts refused", "Times a number was already reserved by another outbound request (or inside its retry window) when a call was about to be released."]])}`);
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
  const st = ctx.url.searchParams.get("status");
  const status = st === "active" || st === "inactive" ? st : undefined;
  const rows = await crm.listCustomers(ctx.db, q, { limit, offset }, { status });
  const exportHref = (() => { const u = new URL(ctx.url); u.pathname = "/staff/customers/export.csv"; u.searchParams.delete("page"); return u.pathname + u.search; })();
  return staffPage(ctx, "Customers", html`${pageHead("Customers", linkButton("Export CSV", exportHref, "ghost", "sm"), "Customer organizations")}
<form method="get" class="filters" action="/staff/customers">${input({ name: "q", label: "Search", value: q, placeholder: "Organization name or member email" })}
${select({ name: "status", label: "Status", options: [{ value: "active", label: "Active (open project or plan)" }, { value: "inactive", label: "Inactive" }], value: status, includeBlank: "All customers" })}<div class="field">${button("Search", { variant: "secondary", size: "sm" })}</div></form>
${table(rows.slice(0, limit), [
    { header: "Organization", cell: (r) => html`<a href="/staff/customers/${r.id}">${r.name}</a>` }, { header: "Since", cell: (r) => formatDate(r.created_at) },
    { header: "Orders", cell: (r) => r.orders, numeric: true }, { header: "Projects", cell: (r) => r.projects, numeric: true }, { header: "Active plans", cell: (r) => r.subscriptions, numeric: true },
    { header: "Open tickets", cell: (r) => r.open_tickets, numeric: true }, { header: "Paid to date", cell: (r) => formatCents(r.paid_cents), numeric: true }],
    { empty: emptyState("No customers yet", "Customer organizations are created when someone registers or buys.") })}${pagination(ctx, page, rows.length > limit)}`);
}

/** Prev/next links and "showing N of M" for one customer sub-table; other sections keep their page (CREST-GAP-071). */
function sectionPager(ctx: AppContext, key: crm.CustomerSection, s: crm.SectionPage<unknown>, noun: string): SafeHtml {
  if (s.total <= s.rows.length && s.page === 1) return html``;
  const href = (p: number) => { const u = new URL(ctx.url); u.searchParams.set(`${key}_page`, String(p)); return `${u.pathname}${u.search}#${key}`; };
  const from = (s.page - 1) * crm.CUSTOMER_SECTION_SIZE + (s.rows.length ? 1 : 0), to = (s.page - 1) * crm.CUSTOMER_SECTION_SIZE + s.rows.length;
  return html`<nav class="pagination" aria-label="${noun} pages" data-showing><span class="faint">Showing ${from}–${to} of ${s.total} ${noun}</span>${s.page > 1 ? html`<a class="btn btn--ghost btn--sm" href="${href(s.page - 1)}">Previous</a>` : ""}${s.hasNext ? html`<a class="btn btn--ghost btn--sm" href="${href(s.page + 1)}">Next</a>` : ""}</nav>`;
}

async function customerPage(ctx: AppContext, id: string) {
  requireStaff(ctx, "customers.read");
  const actor = ctx.actor!, me = ctx.user!.id;
  const pages = Object.fromEntries(crm.CUSTOMER_SECTIONS.map((k) => [k, parseInt(ctx.url.searchParams.get(`${k}_page`) ?? "1", 10) || 1]));
  const d = await crm.customerDetail(ctx.db, id, pages);
  // CREST-GAP-070: staff visibility of customer records stays broad by Founder decision, but every view is audited.
  await audit(ctx.db, { actorUserId: me, action: "customer.viewed", subjectType: "organization", subjectId: d.org.id, organizationId: d.org.id, ip: ctx.ip });
  // CREST-GAP-079: link only what this viewer can open. Leads: crm.access plus lead visibility (all, or owned).
  const canLead = (owner: string | null | undefined) => can(actor, "crm.access") && (can(actor, "lead.read_all") || (can(actor, "lead.read_assigned") && owner === me));
  const leadIds = [...new Set([...d.leads.rows.map((l) => l.id), ...d.orders.rows.map((o) => o.lead_id).filter((x): x is string => !!x)])];
  const leadOwners = new Map<string, string | null>();
  if (leadIds.length) for (const l of (await ctx.db.prepare(`SELECT id, owner_user_id FROM leads WHERE id IN (${leadIds.map(() => "?").join(",")})`).bind(...leadIds).all<{ id: string; owner_user_id: string | null }>()).results) leadOwners.set(l.id, l.owner_user_id);
  const leadLink = (lid: string) => (canLead(leadOwners.get(lid)) ? html`<a href="/staff/crm/leads/${lid}">${lid}</a>` : html`${lid}`);
  // Projects: delivery.access plus project visibility (read_all, or PM / assigned).
  const visibleProjects = new Set<string>();
  if (can(actor, "delivery.access")) for (const p of d.projects.rows) if (await staffCanSeeProject(ctx.db, actor, me, p.id)) visibleProjects.add(p.id);
  const projectCell = (p: { id: string; name: string }) => (visibleProjects.has(p.id) ? html`<a href="/staff/projects/${p.id}">${p.name}</a>` : html`${p.name}`);
  return staffPage(ctx, d.org.name, html`${pageHead(d.org.name, linkButton("General conversation", `/staff/conversations/${d.org.id}`, "secondary", "sm"), "Customer")}
${dl([["Customer since", formatDate(d.org.created_at)], ["Stripe customer", d.org.stripe_customer_id ? "Linked" : "Not linked yet"], ["Members", d.members.map((m) => `${m.display_name} <${m.email}> (${label(m.role_id)})`).join(", ") || "—"]])}
<div class="grid grid-2">
<section class="card" id="orders"><h2 style="font-size:1.2rem">Orders</h2>${table(d.orders.rows, [{ header: "Order", cell: (o) => o.id }, { header: "Kind", cell: (o) => label(o.kind) }, { header: "Status", cell: (o) => badge(o.status) }, { header: "Total", cell: (o) => formatCents(o.total_cents), numeric: true }, { header: "Lead", cell: (o) => (o.lead_id ? leadLink(o.lead_id) : "—") }], { empty: html`<p class="muted">No orders.</p>` })}${sectionPager(ctx, "orders", d.orders, "orders")}</section>
<section class="card" id="invoices"><h2 style="font-size:1.2rem">Invoices</h2>${table(d.invoices.rows, [{ header: "Invoice", cell: (i) => i.description ?? i.id }, { header: "Status", cell: (i) => badge(i.status) }, { header: "Amount", cell: (i) => formatCents(i.amount_cents), numeric: true }, { header: "Issued", cell: (i) => formatDate(i.created_at) }], { empty: html`<p class="muted">No invoices.</p>` })}${sectionPager(ctx, "invoices", d.invoices, "invoices")}</section>
<section class="card" id="projects"><h2 style="font-size:1.2rem">Projects</h2>${table(d.projects.rows, [{ header: "Project", cell: projectCell }, { header: "Status", cell: (p) => badge(p.status) }], { empty: html`<p class="muted">No projects.</p>` })}${sectionPager(ctx, "projects", d.projects, "projects")}</section>
<section class="card" id="subscriptions"><h2 style="font-size:1.2rem">Subscriptions</h2>${table(d.subscriptions.rows, [{ header: "Plan", cell: (s) => label(s.product_id) }, { header: "Status", cell: (s) => badge(s.status) }, { header: "Renews", cell: (s) => formatDate(s.current_period_end) }], { empty: html`<p class="muted">No maintenance plans.</p>` })}${sectionPager(ctx, "subscriptions", d.subscriptions, "plans")}</section>
<section class="card" id="tickets"><h2 style="font-size:1.2rem">Support tickets</h2>${table(d.tickets.rows, [{ header: "Subject", cell: (t) => t.subject }, { header: "Status", cell: (t) => badge(t.status) }, { header: "Opened", cell: (t) => formatDate(t.created_at) }], { empty: html`<p class="muted">No tickets.</p>` })}${sectionPager(ctx, "tickets", d.tickets, "tickets")}</section>
<section class="card" id="leads"><h2 style="font-size:1.2rem">Leads</h2>${table(d.leads.rows, [{ header: "Lead", cell: (l) => leadLink(l.id) }, { header: "Stage", cell: (l) => badge(l.stage) }, { header: "Source", cell: (l) => label(l.source) }, { header: "Created", cell: (l) => formatDate(l.created_at) }], { empty: html`<p class="muted">No linked leads.</p>` })}${sectionPager(ctx, "leads", d.leads, "leads")}</section>
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

const QUOTE_STATUS_OPTIONS = [{ value: "draft", label: "Draft" }, { value: "sent", label: "Sent" }, { value: "lapsed", label: "Lapsed (valid-until passed)" }, { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Withdrawn / declined" }, { value: "expired", label: "Expired" }, { value: "superseded", label: "Superseded" }];

function quoteFilter(ctx: AppContext): quotes.QuoteListFilter {
  const status = ctx.url.searchParams.get("status") ?? "";
  return { status: QUOTE_STATUS_OPTIONS.some((o) => o.value === status) ? status : undefined, q: (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 120) || undefined, today: today(ctx) };
}

async function quotesList(ctx: AppContext) {
  requireStaff(ctx, "quote.write");
  const f = quoteFilter(ctx);
  const { page, limit, offset } = pageParam(ctx);
  const rows = await quotes.listQuotes(ctx.db, ctx.actor!, f, { limit, offset });
  const exportHref = (() => { const u = new URL(ctx.url); u.pathname = "/staff/quotes/export.csv"; u.searchParams.delete("page"); return u.pathname + u.search; })();
  const lapsed = (q: { status: string; valid_until: string | null }) => ["draft", "sent"].includes(q.status) && !!q.valid_until && q.valid_until < today(ctx);
  return staffPage(ctx, "Quotes", html`${pageHead("Quotes & proposals", linkButton("Export CSV", exportHref, "ghost", "sm"), "Sales")}
<form method="get" class="filters" action="/staff/quotes">${input({ name: "q", label: "Search", value: f.q, placeholder: "Quote ID, contact, email or company" })}${select({ name: "status", label: "Status", options: QUOTE_STATUS_OPTIONS, value: f.status, includeBlank: "Any status" })}<div class="field">${button("Filter", { variant: "secondary", size: "sm" })}</div></form>
${table(rows.slice(0, limit), [
    { header: "Quote", cell: (q) => html`<a href="/staff/quotes/${q.id}">${q.id}</a>` }, { header: "Contact", cell: (q) => html`<a href="/staff/crm/leads/${q.lead_id}">${q.contact_name}</a>${q.company_name ? html`<br><span class="faint">${q.company_name}</span>` : ""}` },
    { header: "Package", cell: (q) => quotes.packageName(q.package_id) }, { header: "Version", cell: (q) => `v${q.current_version}` },
    { header: "Status", cell: (q) => html`${q.status === "rejected" ? badge("rejected", q.closed_reason?.startsWith("declined") ? "Declined" : "Withdrawn") : badge(q.status)}${lapsed(q) ? html` ${badge("past_due", "Lapsed")}` : ""}` },
    { header: "Total", cell: (q) => formatCents(q.total_cents), numeric: true }, { header: "Valid until", cell: (q) => q.valid_until ?? "—" }, { header: "Sent", cell: (q) => formatDate(q.sent_at) }],
    { empty: f.q || f.status ? emptyState("No quotes match", "Try a different search or status.") : emptyState("No quotes", "Create a quote from a lead in the CRM.", linkButton("Open CRM", "/staff/crm", "secondary")) })}${pagination(ctx, page, rows.length > limit)}`);
}

async function quotesExport(ctx: AppContext) {
  requireStaff(ctx, "quote.write");
  const f = quoteFilter(ctx);
  const rows = await quotes.exportQuotes(ctx.db, ctx.actor!, f);
  await audit(ctx.db, { actorUserId: ctx.user!.id, action: "quote.exported", subjectType: "quote", details: { count: rows.length, filter: { status: f.status ?? null, q: f.q ?? null } } });
  const csv = toCsv(["quote_id", "created_date", "status", "closed_reason", "version", "package", "total_cents", "total_usd", "payment_schedule", "valid_until", "sent_date", "lead_id", "contact", "email", "company"],
    rows.map((q) => [q.id, q.created_at.slice(0, 10), q.status, q.closed_reason, q.current_version, q.package_id ?? "custom", q.total_cents, (q.total_cents / 100).toFixed(2), q.payment_schedule, q.valid_until, q.sent_at?.slice(0, 10) ?? "", q.lead_id, q.contact_name, q.contact_email, q.company_name]));
  return download(ctx, csv, `crestmont-quotes-${today(ctx)}.csv`, "text/csv; charset=utf-8");
}

async function newQuotePage(ctx: AppContext, errors: string[] = [], values?: QuoteFormValues, status = 200) {
  requireStaff(ctx, "quote.write");
  const leadId = ctx.url.searchParams.get("lead") ?? "";
  if (!leadId) throw new HttpError(400, "Start a quote from a lead in the CRM.");
  const lead = await crm.getLead(ctx.db, ctx.actor!, leadId);
  const interest = lead.interest && ["starter", "business", "premium"].includes(lead.interest) ? lead.interest : "custom";
  const v = values ?? { packageId: interest, scope: interest !== "custom" ? `${PACKAGES[interest as PackageId].name} package: ${PACKAGES[interest as PackageId].includes.join("; ")}.` : "", validUntil: quoteDefaultValidUntil(today(ctx)), lines: [] };
  return staffPage(ctx, "New quote", html`${pageHead(`New quote for ${lead.contact_name}`, linkButton("Back to lead", `/staff/crm/leads/${lead.id}`, "ghost", "sm"), "Quote builder")}
${quoteForm(ctx, `/staff/quotes/new?lead=${encodeURIComponent(lead.id)}`, v, errors, "Save draft (v1)")}`, status);
}

function lineTable(lines: QuoteLine[], total: number, installments: { kind: string; amountCents: number }[], tax: TaxResult | null = null) {
  const taxed = tax ? html`${table(tax.lines, [{ header: "Item", cell: (l) => l.description }, { header: "Amount", cell: (l) => usd(l.amountCents), numeric: true },
    { header: "Estimated sales tax", cell: (l) => (l.taxable ? usd(l.taxCents) : "Not taxable"), numeric: true }, { header: "Line total", cell: (l) => usd(l.amountCents + l.taxCents), numeric: true }])}
<div class="right" data-testid="quote-tax"><p>Subtotal ${usd(tax.subtotalCents)}</p>${tax.byJurisdiction.map((j) => html`<p>${taxLabel(j)} ${usd(j.taxCents)}</p>`)}<p><strong>Total with estimated tax ${usd(tax.totalCents)}</strong></p></div>
<p class="faint">Sales tax is calculated on each invoice when it is issued, from the rates recorded in Crestmont's tax settings (rounded per line and jurisdiction, half away from zero). Installments below are before tax; per-invoice rounding can differ from this estimate by a cent.</p>` : "";
  return html`${tax ? taxed : html`${table(lines, [{ header: "Item", cell: (l) => l.description }, { header: "Amount", cell: (l) => formatCents(l.amountCents), numeric: true }])}
<p class="right"><strong>Total ${formatCents(total)}</strong></p>`}
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
${lineTable(parsed.lines, current.total_cents, parsed.installments, await quoteTax(ctx, current.package_id, parsed.lines))}<h3 style="font-size:1rem">Scope</h3><p>${nl2br(current.scope_text)}</p>
${quote.status === "rejected" ? alert("warn", html`<strong>${quote.closed_reason?.startsWith("declined") ? "Declined by the customer" : "Withdrawn"}</strong> ${quote.closed_at ? `on ${formatDate(quote.closed_at)}` : ""} — ${quote.closed_reason?.replace(/^(withdrawn|declined): /, "") ?? ""}. The proposal link no longer accepts. Saving a new version reopens the quote as a draft.`) : ""}
${["draft", "sent"].includes(quote.status) && can(ctx.actor!, "quote.send") ? actionForm(ctx, `/staff/quotes/${quote.id}/send`, quote.status === "sent" ? "Resend proposal" : "Send proposal", { variant: "primary", size: undefined, confirm: `Email this proposal to ${lead.contact_email ?? "the contact"}?` }) : ""}
${["draft", "sent"].includes(quote.status) ? html`<details><summary>Withdraw or record a decline</summary><form method="post" action="/staff/quotes/${quote.id}/close" class="stack">${csrf(ctx)}
${select({ name: "kind", label: "Outcome", options: [{ value: "withdrawn", label: "Withdrawn by Crestmont" }, { value: "declined", label: "Declined by the customer" }] })}
${input({ name: "reason", label: "Reason", required: true, maxlength: 1000 })}<div class="form-actions">${button("Close quote", { variant: "danger", size: "sm" })}</div></form></details>` : ""}</section>
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
  else if (quotes.isPackageQuote(p.version)) acceptBlock = html`<form method="post" action="${self}/accept" class="card card--gold stack">${csrf(ctx)}<h2 style="font-size:1.3rem">Accept this proposal</h2>
${checkbox("agree", "I accept this proposal, its scope and payment schedule, the Development Agreement, the Refund Policy, the Data Processing Addendum and the Terms of Service.", { required: true })}
<p class="faint"><a href="/legal/development-agreement">Development agreement</a> · <a href="/legal/refunds">Refund policy</a> · <a href="/legal/data-processing">Data processing addendum</a> · <a href="/legal/terms">Terms</a></p>
<div class="form-actions">${button("Accept and continue to payment")}</div></form>`;
  else acceptBlock = html`<form method="post" action="${self}/accept" class="card card--gold stack">${csrf(ctx)}<h2 style="font-size:1.3rem">Accept this proposal</h2>
${checkbox("agree", "I accept this proposal, its scope and payment schedule, the Custom Development Agreement, the Data Processing Addendum and the Terms of Service.", { required: true })}
<p class="faint"><a href="/legal/custom-development-agreement">Custom development agreement</a> · <a href="/legal/data-processing">Data processing addendum</a> · <a href="/legal/terms">Terms</a> · <a href="/legal/refunds">Refund policy</a></p>
<div class="form-actions">${button("Accept and continue to payment")}</div></form>`;
  return htmlResponse(ctx, publicLayout(ctx, { title: "Your proposal", noindex: true }, html`<section class="section"><div class="container stack" style="max-width:860px">
<div class="eyebrow">Proposal · version ${p.version.version}</div><h1>Proposal for ${p.companyName ?? p.contact.name}</h1>
${formErrors(errors)}
${dl([["Prepared for", `${p.contact.name}${p.companyName ? `, ${p.companyName}` : ""}`], ["Package", quotes.packageName(p.version.package_id)], ["Valid until", p.version.valid_until ?? "—"], ["Status", label(p.state)]])}
<section class="card stack"><h2 style="font-size:1.3rem">Scope of work</h2><p>${nl2br(p.version.scope_text)}</p></section>
<section class="card stack"><h2 style="font-size:1.3rem">Investment</h2>${lineTable(p.lines, p.version.total_cents, p.installments, await quoteTax(ctx, p.version.package_id, p.lines))}</section>
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
  // CREST-GAP-032: acceptance, order, invoice and agreement records commit together inside acceptProposal.
  const order = await quotes.acceptProposal(ctx, p, { id: ctx.user.id, email: ctx.user.email }, org.organizationId);
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
  // LEGAL-005: configured sales tax is shown per jurisdiction and included in the amount charged.
  const tax = computeTax([{ description: `${pkg.name} website package`, amountCents: priceCents, productKey: pkg.id }], await loadTaxConfig(ctx.db));
  const dueCents = tax.configured ? tax.totalCents : priceCents;
  return htmlResponse(ctx, publicLayout(ctx, { title: `Checkout — ${pkg.name}`, noindex: true }, html`<section class="section"><div class="container stack" style="max-width:760px">
<div class="eyebrow">Checkout</div><h1>${pkg.name} website package</h1>
${cancelled ? alert("info", "Checkout was cancelled. Nothing was charged.") : ""}${formErrors(errors)}
<div class="card card--gold stack"><p class="price" data-testid="checkout-price">${formatCents(priceCents)}${pkg.priceIsFloor ? html` <small>starting price</small>` : ""}</p>
${tax.configured ? html`<div data-testid="checkout-tax">${tax.byJurisdiction.map((j) => html`<p>${taxLabel(j)}: ${usd(j.taxCents)}</p>`)}<p><strong>Total due ${usd(tax.totalCents)}</strong></p></div>` : ""}
<p class="muted">Fixed price, paid 100% upfront. ${pkg.revisionRounds} revision rounds, up to ${pkg.pageLimit} pages.</p>
<ul class="checklist">${pkg.includes.map((i) => html`<li>${i}</li>`)}</ul>
${pkg.priceIsFloor ? html`<p class="faint">Need more than the standard Premium scope? <a href="/quote">Request a custom quote</a> — work above the starting price is quoted separately.</p>` : ""}</div>
${configured ? html`<form method="post" action="/checkout/${pkg.id}" class="card stack">${csrf(ctx)}
${checkbox("terms", "I agree to the Development Agreement, Terms of Service, Refund Policy and Data Processing Addendum.", { required: true })}
<p class="faint"><a href="/legal/development-agreement">Development agreement</a> · <a href="/legal/terms">Terms</a> · <a href="/legal/refunds">Refund policy</a> · <a href="/legal/data-processing">Data processing addendum</a></p>
<p class="faint">You will be taken to Stripe's secure checkout. Your payment is confirmed only when Stripe notifies us.</p>
<div class="form-actions">${button(`Pay ${formatCents(dueCents)}`)}</div></form>`
    : html`<div class="card stack">${alert("warn", `${NOT_CONFIGURED} You cannot pay online right now.`)}<p>We can still start your project: request a quote or contact us and we will follow up with payment options.</p>
<div class="row">${linkButton("Request a quote", "/quote", "primary")}${linkButton("Contact us", "/contact", "secondary")}</div></div>`}
</div></section>`), status);
}

async function checkoutPost(ctx: AppContext, packageId: string) {
  const pkg = packageById(packageId);
  if (!pkg) throw new HttpError(404, "That package does not exist.");
  const org = requireCustomerOrg(ctx);
  if (!can(ctx.actor!, "customer.billing", { organizationId: org.organizationId })) throw new HttpError(403, "Only an account administrator can make purchases for this organization.");
  const unverified = requireVerifiedForPayment(ctx); // CREST-GAP-031
  if (unverified) return unverified;
  if (!ctx.payments.configured) return checkoutPage(ctx, packageId, [`${NOT_CONFIGURED} No order was created.`], 409);
  const f = await ctx.form();
  if (!f.get("terms")) return checkoutPage(ctx, packageId, ["You must accept the agreements to continue."], 422);
  // Any client-supplied price/amount fields are ignored: the order total comes from PACKAGES.
  const res = await startPackageCheckout(ctx, { id: ctx.user!.id, email: ctx.user!.email, name: ctx.user!.displayName }, org.organizationId, pkg.id);
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
${ctx.payments.configured ? html`<form method="post" action="/checkout/maintenance/${plan.id}" class="card stack">${csrf(ctx)}${checkbox("terms", "I agree to the Maintenance Agreement, Terms of Service, Support Policy, Cancellation Policy and Data Processing Addendum, and authorize monthly billing until I cancel.", { required: true })}<p class="faint"><a href="/legal/maintenance-agreement">Maintenance agreement</a> · <a href="/legal/terms">Terms</a> · <a href="/legal/support">Support policy</a> · <a href="/legal/cancellation">Cancellation policy</a> · <a href="/legal/data-processing">Data processing addendum</a></p><div class="form-actions">${button("Subscribe")}</div></form>`
      : html`<div class="card stack">${alert("warn", NOT_CONFIGURED)}<div class="row">${linkButton("Contact us", "/contact", "primary")}</div></div>`}</div></section>`));
  }
  if (!can(ctx.actor!, "customer.billing", { organizationId: org.organizationId })) throw new HttpError(403, "Only an account administrator can subscribe for this organization.");
  const unverified = requireVerifiedForPayment(ctx); // CREST-GAP-031
  if (unverified) return unverified;
  if (!ctx.payments.configured) throw new HttpError(409, NOT_CONFIGURED);
  const f = await ctx.form();
  if (!f.get("terms")) throw new HttpError(422, "You must accept the terms to subscribe.");
  const res = await startMaintenanceCheckout(ctx, { id: ctx.user!.id, email: ctx.user!.email }, org.organizationId, plan.id);
  await recordAcceptance(ctx, { userId: ctx.user!.id, organizationId: org.organizationId, context: "maintenance_checkout", contextId: plan.id });
  return stripeRedirect(ctx, res.url);
}

/** CREST-GAP-080: the AI qualification prompt quotes the Founder-approved effective prices, never hard-coded ones. */
async function approvedPackagesLine(ctx: AppContext): Promise<string> {
  const prices = await effectivePrices(ctx.db, ctx.now());
  return (Object.keys(PACKAGES) as PackageId[]).map((id) => {
    const p = PACKAGES[id];
    return `${p.name} ${p.priceIsFloor ? "from " : ""}${formatCents(prices[`package:${id}`] ?? p.basePriceCents).replace(/\.00$/, "")} (${p.pageLimit} pages)`;
  }).join(", ");
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
    const res = await crm.createManualLead(ctx.db, ctx.actor!, { ...v, resolution: str(f, "resolution") }, { ip: ctx.ip });
    if (!res.ok) return newLeadForm(ctx, res.issues, v, res.duplicates ? 409 : 422, res.duplicates);
    return redirect(ctx, `/staff/crm/leads/${res.leadId}`, { kind: "success", text: res.linked ? "Lead added to the existing contact." : "Lead created." });
  });
  r.get("/staff/crm/new/matches", newLeadMatches);
  r.post("/staff/crm/identity-erasure", async (ctx) => {
    requireStaff(ctx, "crm.access");
    if (!isOwner(ctx.actor!)) throw new HttpError(403, "Only the Owner can erase CRM identity data.");
    const f = await ctx.form();
    const list = (k: string) => str(f, k).split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 30);
    const note = str(f, "note").trim();
    const back = "/staff/crm/duplicates?view=review";
    if (note.length < 5) return redirect(ctx, back, { kind: "error", text: "Describe who asked for the erasure, and how." });
    try {
      const r = await eraseIdentityData(ctx.db, ctx.user!.id, { phones: list("phones"), emails: list("emails"), blockReimport: str(f, "allow_reimport") !== "1" }, { ip: ctx.ip, note });
      return redirect(ctx, back, { kind: "success", text: `Erased: ${r.contacts} contact(s), ${r.identitiesDeleted} identifier(s), ${r.reviewsDeleted + r.reviewsScrubbed} review item(s), ${r.fieldChangesScrubbed} history value(s).${r.sharedKept ? ` ${r.sharedKept} identifier(s) shared with another business were kept for that business.` : ""}${r.tombstoneSkipped ? " Re-import block NOT recorded: CRM_ERASURE_HMAC_KEY is not configured in this environment." : ""}` });
    } catch (e) {
      if (e instanceof ErasureError) return redirect(ctx, back, { kind: "error", text: e.message });
      throw e;
    }
  });
  r.post("/staff/crm/identity-reviews/resolve", async (ctx) => {
    requireStaff(ctx, "crm.access");
    if (!can(ctx.actor!, "lead.write_all")) throw new HttpError(403, "Only staff who can edit all leads can resolve the review queue.");
    const f = await ctx.form();
    const back = safeBack(str(f, "back"), "/staff/crm/duplicates?view=review");
    const decision = str(f, "decision");
    if (!["apply", "reject", "create_new", "link"].includes(decision)) return redirect(ctx, back, { kind: "error", text: "Choose what to do with this item." });
    try {
      const res = await identity.resolveReview(ctx.db, ctx.actor!, str(f, "id"), decision as identity.ReviewDecision, str(f, "note"), { ip: ctx.ip });
      const text = { apply: "Change applied and recorded in the contact's history.", reject: "Kept the existing record.", create_new: "Created as a separate record.", link: "Linked to the existing record." }[decision as identity.ReviewDecision];
      return redirect(ctx, res.leadId && decision !== "reject" ? `/staff/crm/leads/${res.leadId}` : back, { kind: "success", text });
    } catch (e) {
      if (e instanceof identity.IntakeError) return redirect(ctx, back, { kind: "error", text: e.message });
      throw e;
    }
  });
  r.get("/staff/crm/contacts", contactsPage);
  r.get("/staff/crm/duplicates", duplicatesPage);
  r.post("/staff/crm/duplicates/dismiss", async (ctx) => {
    requireStaff(ctx, "crm.access");
    // Authorize before validating input (record-level write checks follow in dismissPair).
    if (!can(ctx.actor!, "lead.write_all") && !can(ctx.actor!, "lead.write_assigned")) throw new HttpError(403, "You cannot edit leads.");
    const f = await ctx.form();
    const back = safeBack(str(f, "back"), "/staff/crm/duplicates");
    try { await dedupe.dismissPair(ctx.db, ctx.actor!, str(f, "a"), str(f, "b"), { ip: ctx.ip }); } catch (e) {
      if (e instanceof dedupe.MergeError) return redirect(ctx, back, { kind: "error", text: e.message });
      throw e;
    }
    return redirect(ctx, back, { kind: "success", text: "Marked as not duplicates." });
  });
  r.post("/staff/crm/leads/:id/merge", async (ctx, p) => {
    requireStaff(ctx, "crm.access");
    // Authorize before validating input (record-level write checks follow in mergeLeads).
    if (!can(ctx.actor!, "lead.write_all") && !can(ctx.actor!, "lead.write_assigned")) throw new HttpError(403, "You cannot edit leads.");
    const f = await ctx.form();
    const into = str(f, "into");
    try {
      const moved = await dedupe.mergeLeads(ctx.db, ctx.actor!, p.id, into, { ip: ctx.ip });
      return redirect(ctx, `/staff/crm/leads/${into}`, { kind: "success", text: `Lead merged: ${moved.activities} activities, ${moved.quotes} quotes, ${moved.orders} orders and ${moved.calls} calls moved here.` });
    } catch (e) {
      if (e instanceof dedupe.MergeError) return redirect(ctx, safeBack(str(f, "back"), `/staff/crm/leads/${p.id}`), { kind: "error", text: e.message });
      throw e;
    }
  });
  r.get("/staff/crm/leads/:id", (ctx, p) => leadDetail(ctx, p.id));
  r.get("/staff/crm/leads/:id/quick", (ctx, p) => leadQuickView(ctx, p.id));
  r.post("/staff/crm/leads/:id/stage", async (ctx, p) => {
    requireStaff(ctx, "crm.access");
    const current = await crm.getLead(ctx.db, ctx.actor!, p.id);
    // Authorize before validating input: callers who cannot write this lead get 403 whatever they send.
    if (!can(ctx.actor!, "lead.write_all") && !(can(ctx.actor!, "lead.write_assigned") && current.owner_user_id === ctx.actor!.userId)) throw new HttpError(403, "This lead is not assigned to you.");
    if (current.merged_into_lead_id) throw new HttpError(409, "This lead was merged into another lead; change the surviving lead instead.");
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
      `Approved packages: ${await approvedPackagesLine(ctx)}; larger work is a custom quote. Summarize fit, likely package, open questions, and suggested next step. Do not quote new prices or promise dates.`].join("\n");
    const res = await requestAiDraft(ctx.db, aiProviderFromEnv(ctx.env), { workflow: "lead_qualification", inputRef: `lead:${lead.id}`, prompt, requestedBy: ctx.user!.id });
    return redirect(ctx, `/staff/crm/leads/${p.id}`, res.status === "failed" ? { kind: "error", text: res.error ?? "AI draft failed." } : res.status === "queued" ? { kind: "info", text: "Draft requested from the self-hosted model; reload this page in a minute to review it. Nothing has been sent." } : { kind: "success", text: "AI draft ready for review." });
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
  r.get("/staff/customers/export.csv", async (ctx) => {
    requireStaff(ctx, "customers.read");
    const q = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 120);
    const st = ctx.url.searchParams.get("status");
    const rows = (await crm.listCustomers(ctx.db, q, { limit: 10000, offset: 0 }, { status: st === "active" || st === "inactive" ? st : undefined })).slice(0, 10000);
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "customer.exported", subjectType: "organization", details: { count: rows.length, q, status: st } });
    const csv = toCsv(["organization_id", "name", "customer_since", "orders", "projects", "active_plans", "open_tickets", "paid_to_date_cents", "paid_to_date_usd"],
      rows.map((r) => [r.id, r.name, r.created_at.slice(0, 10), r.orders, r.projects, r.subscriptions, r.open_tickets, r.paid_cents, (r.paid_cents / 100).toFixed(2)]));
    return download(ctx, csv, `crestmont-customers-${today(ctx)}.csv`, "text/csv; charset=utf-8");
  });
  r.get("/staff/customers/:id", (ctx, p) => customerPage(ctx, p.id));
  r.get("/staff/sales", salesPage);

  r.get("/staff/quotes", quotesList);
  r.get("/staff/quotes/export.csv", quotesExport);
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
  r.post("/staff/quotes/:id/close", async (ctx, p) => {
    requireStaff(ctx, "quote.write");
    const f = await ctx.form();
    const kind = str(f, "kind") === "declined" ? "declined" : "withdrawn";
    try {
      await quotes.closeQuote(ctx.db, ctx.actor!, p.id, kind, str(f, "reason"));
    } catch (e) {
      if (e instanceof HttpError && (e.status === 409 || e.status === 422)) return quoteDetail(ctx, p.id, [e.message], undefined, e.status);
      throw e;
    }
    return redirect(ctx, `/staff/quotes/${p.id}`, { kind: "success", text: kind === "declined" ? "Quote recorded as declined." : "Quote withdrawn. The proposal link no longer accepts." });
  });
  r.post("/staff/quotes/:id/send", async (ctx, p) => {
    requireStaff(ctx, "quote.send");
    const res = await quotes.sendQuote(ctx, ctx.actor!, p.id);
    // CREST-GAP-034: the flash says what really happened to the email, with the link to share by hand when it did not go.
    const note = res.stageNote ? " " + res.stageNote : "";
    if (res.delivery === "sent") return redirect(ctx, `/staff/quotes/${p.id}`, { kind: res.stageNote ? "info" : "success", text: `Proposal emailed.${note}` });
    const why = res.delivery === "queued" ? "The email is queued and has not been delivered yet (Email operations shows its status)." : `The email was NOT delivered (${res.delivery}${res.deliveryError ? `: ${res.deliveryError.slice(0, 80)}` : ""}).`;
    return redirect(ctx, `/staff/quotes/${p.id}`, { kind: "error", text: `Proposal link created. ${why} Share this link with the contact: ${res.url}${note}`.slice(0, 300) });
  });

  r.get("/q/:token", (ctx, p) => proposalPage(ctx, p.token));
  r.post("/q/:token/accept", (ctx, p) => acceptProposalRoute(ctx, p.token));

  r.get("/checkout/maintenance/:planId", (ctx, p) => maintenanceCheckoutPage(ctx, p.planId, false));
  r.post("/checkout/maintenance/:planId", (ctx, p) => maintenanceCheckoutPage(ctx, p.planId, true));
  r.get("/checkout/:packageId", (ctx, p) => checkoutPage(ctx, p.packageId));
  r.post("/checkout/:packageId", (ctx, p) => checkoutPost(ctx, p.packageId));
}

