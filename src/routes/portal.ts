// Customer portal — collaboration side (PORTAL-001..007, PORTAL-010, FILE-001, AUTH-008).
// Every query is scoped by the organization returned from requireCustomerOrg(ctx), never by URL/form input.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatCents, formatDate, formatDateTime, label, safeUrl, type SafeHtml } from "../lib/html.ts";
import { HttpError, htmlResponse, redirect, str } from "../app/http.ts";
import { requireCustomerOrg, requireStaff } from "../app/app.ts";
import { appLayout, publicLayout } from "../ui/layout.ts";
import { portalNav, staffNav } from "./nav.ts";
import {
  csrf, button, linkButton, actionForm, input, textarea, select, checkbox, formErrors, alert, badge, table, emptyState, kpi, dl, tabs, pageHead, nl2br,
} from "../ui/components.ts";
import * as P from "../services/projects.ts";
import * as F from "../services/files.ts";
import * as M from "../services/messages.ts";
import * as O from "../services/onboarding.ts";
import * as S from "../services/share-links.ts";
import { sharePanel } from "../ui/share.ts";
import { listNotifications, markNotificationsRead, notificationHref } from "../services/notifications.ts";
import { createInvitation, AuthError } from "../services/auth.ts";
import { sendMail } from "../services/mailer.ts";
import { audit } from "../services/security.ts";
import { PACKAGES, type PackageId } from "../domain/catalog.ts";
import * as T from "../services/customer-team.ts";

type Org = ReturnType<typeof requireCustomerOrg>;

/** Date-only values (YYYY-MM-DD) are calendar days: render them without a timezone shift. */
const fmtDay = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? formatDate(`${s}T12:00:00Z`) : formatDate(s));

function page(ctx: AppContext, title: string, body: SafeHtml, status = 200): Response {
  return htmlResponse(ctx, appLayout(ctx, { title, nav: portalNav(ctx), home: "/portal", area: "Customer portal" }, body), status);
}

/** Re-render on business-rule errors (409/422) instead of the generic error page. */
async function orRerender(render: (errors: string[], status: number) => Promise<Response>, fn: () => Promise<Response>): Promise<Response> {
  try { return await fn(); } catch (e) {
    if (e instanceof HttpError && (e.status === 409 || e.status === 422)) return render([e.message], e.status);
    if (e instanceof O.OnboardingError) return render(e.errors, 422);
    if (e instanceof M.MessageError || e instanceof F.UploadError) return render([e.message], 422);
    throw e;
  }
}

const packageName = (id: string | null) => (id && id in PACKAGES ? PACKAGES[id as PackageId].name : id === "custom" ? "Custom development" : "—");
const isAdmin = (org: Org) => org.role === "customer_admin";

function projectTabs(ctx: AppContext, id: string): SafeHtml {
  const base = `/portal/projects/${id}`;
  const here = ctx.url.pathname;
  return tabs([
    { href: base, label: "Overview", current: here === base },
    { href: `${base}/onboarding`, label: "Onboarding", current: here === `${base}/onboarding` },
    { href: `${base}/messages`, label: "Messages", current: here === `${base}/messages` },
    { href: `${base}/files`, label: "Files", current: here === `${base}/files` },
    { href: `${base}/revisions`, label: "Revisions", current: here === `${base}/revisions` },
    { href: `${base}/approvals`, label: "Approvals", current: here === `${base}/approvals` },
    { href: `${base}/handoff`, label: "Handoff", current: here === `${base}/handoff` },
  ]);
}

// ───────────── Data helpers (all org-scoped) ─────────────

interface CustomerAction { text: string; href: string }

async function requiredActions(ctx: AppContext, org: Org, projectId?: string): Promise<CustomerAction[]> {
  const scope = projectId ? "AND p.id = ?" : "";
  const b = (extra: unknown[] = []) => [org.organizationId, ...(projectId ? [projectId] : []), ...extra];
  const out: CustomerAction[] = [];
  const onboarding = (await ctx.db.prepare(`SELECT p.id, p.name FROM projects p LEFT JOIN onboarding_responses o ON o.project_id = p.id WHERE p.organization_id = ? ${scope} AND p.status IN ('purchased','awaiting_onboarding') AND o.completed_at IS NULL`).bind(...b()).all<{ id: string; name: string }>()).results;
  for (const p of onboarding) out.push({ text: `Complete onboarding for ${p.name}`, href: `/portal/projects/${p.id}/onboarding` });
  const approvals = (await ctx.db.prepare(`SELECT r.kind, p.id, p.name FROM approval_requests r JOIN projects p ON p.id = r.project_id WHERE p.organization_id = ? ${scope} AND r.resolved_at IS NULL ORDER BY r.created_at`).bind(...b()).all<{ kind: string; id: string; name: string }>()).results;
  for (const a of approvals) out.push({ text: `${P.APPROVAL_LABELS[a.kind]} awaiting your decision — ${a.name}`, href: `/portal/projects/${a.id}/approvals` });
  const delivered = (await ctx.db.prepare(`SELECT r.round, p.id, p.name FROM revisions r JOIN projects p ON p.id = r.project_id WHERE p.organization_id = ? ${scope} AND r.status = 'delivered'`).bind(...b()).all<{ round: number; id: string; name: string }>()).results;
  for (const r of delivered) out.push({ text: `Review delivered revision round ${r.round} — ${r.name}`, href: `/portal/projects/${r.id}/revisions` });
  const cos = (await ctx.db.prepare(`SELECT c.id, p.id AS pid, p.name, c.price_cents FROM change_orders c JOIN projects p ON p.id = c.project_id WHERE p.organization_id = ? ${scope} AND c.status = 'proposed'`).bind(...b()).all<{ id: string; pid: string; name: string; price_cents: number }>()).results;
  for (const c of cos) out.push({ text: `Change order (${formatCents(c.price_cents)}) awaiting approval — ${c.name}`, href: `/portal/projects/${c.pid}/revisions` });
  const handoffs = (await ctx.db.prepare(`SELECT p.id, p.name FROM handoffs h JOIN projects p ON p.id = h.project_id WHERE p.organization_id = ? ${scope} AND h.published_at IS NOT NULL AND h.accepted_at IS NULL`).bind(...b()).all<{ id: string; name: string }>()).results;
  for (const h of handoffs) if (!approvals.some((a) => a.id === h.id && a.kind === "final_acceptance")) out.push({ text: `Review your handoff and record final acceptance — ${h.name}`, href: `/portal/projects/${h.id}/handoff` });
  const paused = (await ctx.db.prepare(`SELECT p.id, p.name FROM projects p WHERE p.organization_id = ? ${scope} AND p.status = 'paused'`).bind(...b()).all<{ id: string; name: string }>()).results;
  for (const p of paused) out.push({ text: `${p.name} is paused — send a message to restart it`, href: `/portal/projects/${p.id}/messages` });
  return out;
}

async function taskCounts(ctx: AppContext, projectId: string) {
  const rows = (await ctx.db.prepare(`SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status`).bind(projectId).all<{ status: string; n: number }>()).results;
  const total = rows.reduce((s, r) => s + r.n, 0);
  const done = rows.find((r) => r.status === "done")?.n ?? 0;
  const blocked = rows.find((r) => r.status === "blocked")?.n ?? 0;
  return { total, done, blocked, inProgress: total - done - blocked - (rows.find((r) => r.status === "todo")?.n ?? 0) };
}

function actionList(actions: CustomerAction[]): SafeHtml {
  if (!actions.length) return html`<p class="muted">Nothing needs your attention right now.</p>`;
  return html`<ul class="checklist">${actions.map((a) => html`<li><a href="${safeUrl(a.href)}">${a.text}</a></li>`)}</ul>`;
}

// ───────────── Routes ─────────────

export function register(r: Router): void {
  // ── Dashboard ──
  r.get("/portal", async (ctx) => {
    const org = requireCustomerOrg(ctx);
    const db = ctx.db;
    const projects = (await db.prepare(`SELECT id, name, status, product_id, updated_at FROM projects WHERE organization_id = ? ORDER BY CASE WHEN status IN ('completed','maintenance','cancelled') THEN 1 ELSE 0 END, updated_at DESC`).bind(org.organizationId).all<{ id: string; name: string; status: string; product_id: string | null; updated_at: string }>()).results;
    const unread = await M.unreadCountForCustomer(db, ctx.user!.id, org.organizationId);
    const openInvoices = (await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total FROM invoices WHERE organization_id = ? AND status = 'open'`).bind(org.organizationId).first<{ n: number; total: number }>())!;
    const subs = (await db.prepare(`SELECT s.status, p.name FROM subscriptions s JOIN products p ON p.id = s.product_id WHERE s.organization_id = ? ORDER BY s.updated_at DESC`).bind(org.organizationId).all<{ status: string; name: string }>()).results;
    const tickets = (await db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE organization_id = ? AND status NOT IN ('resolved','closed')`).bind(org.organizationId).first<{ n: number }>())!.n;
    const notes = await listNotifications(db, ctx.user!.id, 8);
    const actions = await requiredActions(ctx, org);
    const active = projects.filter((p) => !["completed", "maintenance", "cancelled"].includes(p.status));
    const body = html`${pageHead(`Welcome, ${ctx.user!.displayName}`, undefined, org.organizationName)}
${projects.length === 0 ? html`<section class="card card--gold">${emptyState("You have no projects yet",
  "Projects appear here as soon as a package purchase or an accepted quote is paid. Choose a package, or ask for a custom quote and we will prepare a fixed proposal.",
  html`<div class="row" style="justify-content:center">${linkButton("View packages", "/pricing")}${linkButton("Request a custom quote", "/quote", "secondary")}</div>`)}</section>` : html`
<div class="kpis">${kpi("Active projects", active.length)}${kpi("Actions for you", actions.length)}${kpi("Unread messages", unread)}
${kpi("Open invoices", openInvoices.n, openInvoices.n ? formatCents(openInvoices.total) + " due" : "Nothing due")}${kpi("Open support tickets", tickets)}
${kpi("Maintenance plan", subs.length ? label(subs[0].status) : "None", subs.length ? subs[0].name : "No subscription")}</div>
<div class="grid grid-2">
<section class="card"><h2 class="card__title">Required actions</h2>${actionList(actions)}</section>
<section class="card"><h2 class="card__title">Projects</h2>${table(projects, [
  { header: "Project", cell: (p) => html`<a href="/portal/projects/${p.id}">${p.name}</a>` },
  { header: "Package", cell: (p) => packageName(p.product_id) },
  { header: "Status", cell: (p) => badge(p.status) },
])}</section></div>`}
<div class="grid grid-2" style="margin-top:1.5rem">
<section class="card"><div class="row row--between"><h2 class="card__title">Notifications</h2>${notes.some((n) => !n.read_at) ? actionForm(ctx, "/portal/notifications/read", "Mark all read", { variant: "ghost" }) : ""}</div>
${notes.length ? html`<ul class="timeline">${notes.map((n) => { const href = notificationHref(n, "portal"); return html`<li>${n.read_at ? "" : badge("new", "New")} ${href ? html`<a href="${href}">${n.body}</a>` : n.body}<br><span class="faint">${formatDateTime(n.created_at)}</span></li>`; })}</ul>` : html`<p class="muted">No notifications yet.</p>`}
<p><a href="/portal/notifications">All notifications</a></p></section>
<section class="card"><h2 class="card__title">Billing &amp; support</h2>
<p>${openInvoices.n ? html`${openInvoices.n} open invoice${openInvoices.n === 1 ? "" : "s"} totalling ${formatCents(openInvoices.total)}.` : "No open invoices."} <a href="/portal/billing">Billing</a></p>
<p>${subs.length ? html`Maintenance: ${subs.map((s) => html`${s.name} ${badge(s.status)} `)}` : "No maintenance subscription."}</p>
<p>${tickets} open support ticket${tickets === 1 ? "" : "s"}. <a href="/portal/support">Support</a></p></section></div>`;
    return page(ctx, "Dashboard", body);
  });

  r.post("/portal/notifications/read", async (ctx) => {
    requireCustomerOrg(ctx);
    await markNotificationsRead(ctx.db, ctx.user!.id);
    const back = str(await ctx.form(), "back") === "/portal/notifications" ? "/portal/notifications" : "/portal";
    return redirect(ctx, back, { kind: "success", text: "Notifications marked as read." });
  });

  // ── Projects ──
  r.get("/portal/projects", async (ctx) => {
    const org = requireCustomerOrg(ctx);
    const rows = (await ctx.db.prepare(`SELECT p.id, p.name, p.status, p.product_id, p.target_launch_at, p.updated_at,
        (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id AND m.status = 'done') AS ms_done, (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id) AS ms_total
        FROM projects p WHERE p.organization_id = ? ORDER BY p.created_at DESC`).bind(org.organizationId)
      .all<{ id: string; name: string; status: string; product_id: string | null; target_launch_at: string | null; updated_at: string; ms_done: number; ms_total: number }>()).results;
    return page(ctx, "Projects", html`${pageHead("Projects")}${table(rows, [
      { header: "Project", cell: (p) => html`<a href="/portal/projects/${p.id}">${p.name}</a>` },
      { header: "Package", cell: (p) => packageName(p.product_id) },
      { header: "Status", cell: (p) => badge(p.status) },
      { header: "Milestones", cell: (p) => `${p.ms_done} / ${p.ms_total}` },
      { header: "Target launch", cell: (p) => fmtDay(p.target_launch_at) },
      { header: "Updated", cell: (p) => fmtDay(p.updated_at) },
    ], { empty: emptyState("No projects yet", "Purchase a package or request a custom quote to start a project.", html`<div class="row" style="justify-content:center">${linkButton("View packages", "/pricing")}${linkButton("Request a quote", "/quote", "secondary")}</div>`) })}`);
  });

  r.get("/portal/projects/:id", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    const proj = await P.getOrgProject(ctx.db, org.organizationId, p.id);
    const milestones = (await ctx.db.prepare(`SELECT name, status, due_at, completed_at FROM milestones WHERE project_id = ? ORDER BY position`).bind(proj.id).all<{ name: string; status: string; due_at: string | null; completed_at: string | null }>()).results;
    const tc = await taskCounts(ctx, proj.id);
    const usage = await P.revisionUsage(ctx.db, proj.id);
    const actions = await requiredActions(ctx, org, proj.id);
    const history = await P.projectHistory(ctx.db, proj.id, true, 25);
    const pm = proj.project_manager_id ? await ctx.db.prepare(`SELECT display_name FROM users WHERE id = ?`).bind(proj.project_manager_id).first<{ display_name: string }>() : null;
    const blockers: string[] = [];
    if (proj.status === "paused") blockers.push(`Project is paused (was ${P.labelStatus(proj.paused_from_status ?? "")}). Send a message to restart it.`);
    for (const m of milestones.filter((m) => m.status === "blocked")) blockers.push(`Milestone blocked: ${m.name}`);
    if (tc.blocked) blockers.push(`${tc.blocked} task${tc.blocked === 1 ? " is" : "s are"} blocked`);
    const unpaid = (await ctx.db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE project_id = ? AND organization_id = ? AND status = 'open'`).bind(proj.id, org.organizationId).first<{ n: number }>())!.n;
    if (unpaid) blockers.push(`${unpaid} open invoice${unpaid === 1 ? "" : "s"} for this project`);
    const lastDue = milestones.map((m) => m.due_at).filter(Boolean).sort().at(-1) ?? null;
    const pct = tc.total ? Math.round((tc.done / tc.total) * 100) : 0;
    const body = html`${pageHead(proj.name, undefined, `${packageName(proj.product_id)} · ${proj.id}`)}${projectTabs(ctx, proj.id)}
<div class="kpis">${kpi("Status", P.labelStatus(proj.status))}${kpi("Task progress", tc.total ? `${tc.done} / ${tc.total}` : "Not planned yet", tc.total ? `${pct}% complete` : "Your team adds tasks after scope review", tc.total ? pct : undefined)}
${kpi("Revisions used", `${usage.used} / ${proj.revision_allowance}`, usage.total > usage.used ? `${usage.total - usage.used} billable round(s)` : "Included rounds")}
${kpi("Estimated completion", lastDue ? fmtDay(lastDue) : proj.target_launch_at ? fmtDay(proj.target_launch_at) : "Not scheduled yet", lastDue ? "Based on milestone due dates" : undefined)}</div>
<div class="grid grid-2">
<section class="card"><h2 class="card__title">Milestones</h2>${table(milestones, [
  { header: "Milestone", cell: (m) => m.name },
  { header: "Status", cell: (m) => badge(m.status) },
  { header: "Due", cell: (m) => fmtDay(m.due_at) },
  { header: "Completed", cell: (m) => fmtDay(m.completed_at) },
], { empty: emptyState("No milestones yet", "Milestones are planned during scope review.") })}</section>
<section class="stack"><div class="card"><h2 class="card__title">Required from you</h2>${actionList(actions)}</div>
<div class="card"><h2 class="card__title">Blockers</h2>${blockers.length ? html`<ul class="checklist">${blockers.map((b) => html`<li>${b}</li>`)}</ul>` : html`<p class="muted">No blockers recorded.</p>`}</div>
<div class="card">${dl([["Project manager", pm?.display_name ?? "Being assigned"], ["Payment schedule", proj.payment_schedule === "upfront" ? "100% upfront" : "50% / 25% / 25% milestones"], ["Live website", proj.live_url ? html`<a href="${safeUrl(proj.live_url)}" rel="noopener">${proj.live_url}</a>` : "Not launched yet"], ["Started", fmtDay(proj.created_at)]])}</div></section></div>
<section class="card" style="margin-top:1.5rem"><h2 class="card__title">Project history</h2>${history.length ? html`<ul class="timeline">${history.map((h) => html`<li>${P.describeHistory(h)}<br><span class="faint">${formatDateTime(h.created_at)}${h.actor_name ? ` · ${h.actor_name}` : h.actor_kind === "system" ? " · Automatic" : ""}</span></li>`)}</ul>` : html`<p class="muted">No activity yet.</p>`}</section>`;
    return page(ctx, proj.name, body);
  });

  // ── Onboarding ──
  const onboardingPage = async (ctx: AppContext, org: Org, id: string, errors: string[] = [], status = 200, posted?: O.Answers) => {
    const proj = await P.getOrgProject(ctx.db, org.organizationId, id);
    const rec = await O.getOnboarding(ctx.db, proj.id);
    const a: O.Answers = posted ?? rec?.answers ?? { business_name: org.organizationName, contact_name: ctx.user!.displayName, contact_email: ctx.user!.email };
    const done = !!rec?.completed_at;
    const open = !done && ["purchased", "awaiting_onboarding"].includes(proj.status);
    const val = (n: string) => { const v = a[n]; return Array.isArray(v) ? v.join(", ") : v ?? ""; };
    const uploaded = async (n: string) => {
      const ids = Array.isArray(a[n]) ? (a[n] as string[]) : [];
      if (!ids.length) return html``;
      const rows = (await ctx.db.prepare(`SELECT id, filename FROM files WHERE organization_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`).bind(org.organizationId, ...ids).all<{ id: string; filename: string }>()).results;
      return html`<p class="hint">Uploaded: ${rows.map((f) => html`<a href="/files/${f.id}">${f.filename}</a> `)}</p>`;
    };
    const field = async (f: O.OnboardingField): Promise<SafeHtml> => {
      const req = !!f.required;
      let inner: SafeHtml;
      if (f.type === "textarea") inner = textarea({ name: f.name, label: f.label, value: val(f.name), hint: f.hint, required: false, maxlength: f.max, rows: 4 });
      else if (f.type === "radio") inner = html`<fieldset class="field"><legend>${f.label}${req ? html` <span aria-hidden="true" class="faint">*</span>` : ""}</legend>${f.options!.map((o) => html`<label class="checkbox"><input type="radio" name="${f.name}" value="${o.value}"${a[f.name] === o.value ? html` checked` : ""}> <span>${o.label}</span></label>`)}${f.hint ? html`<span class="hint">${f.hint}</span>` : ""}</fieldset>`;
      else if (f.type === "checkboxes") { const cur = Array.isArray(a[f.name]) ? (a[f.name] as string[]) : []; inner = html`<fieldset class="field"><legend>${f.label}</legend>${f.options!.map((o) => checkbox(f.name, o.label, { value: o.value, checked: cur.includes(o.value) }))}</fieldset>`; }
      else if (f.type === "file") inner = html`<div class="field dropzone"><label for="f-${f.name}">${f.label}</label><input class="input" id="f-${f.name}" type="file" name="${f.name}"${f.name === "images" ? html` multiple` : ""} accept=".png,.jpg,.jpeg,.webp,.gif,.pdf"><span class="hint">${f.hint ?? ""} Up to 25 MB each.</span>${await uploaded(f.name)}</div>`;
      else inner = input({ name: f.name, label: f.label, type: f.type === "tel" ? "tel" : f.type === "email" ? "email" : "text", value: val(f.name), hint: f.hint, maxlength: f.max });
      if (req && f.type !== "radio") inner = html`${inner}<span class="faint" style="font-size:.75rem">Required${f.showWhen ? " when shown" : ""}</span>`;
      return f.showWhen ? html`<div data-show-when="${f.showWhen.field}=${f.showWhen.values.join(",")}">${inner}</div>` : inner;
    };
    const sections: SafeHtml[] = [];
    for (const s of O.ONBOARDING_SECTIONS) {
      const fields = s.fields.filter((f) => !f.packages || f.packages.includes(proj.product_id ?? "custom"));
      const rendered: SafeHtml[] = [];
      for (const f of fields) rendered.push(await field(f));
      sections.push(html`<fieldset class="card ob-section"><legend class="card__title">${s.title}</legend>${rendered}</fieldset>`);
    }
    const summary = done ? html`<section class="card">${alert("success", html`Onboarding submitted ${formatDateTime(rec!.completed_at)}. Need to change something? <a href="/portal/projects/${proj.id}/messages">Message your team</a>.`)}
${dl(O.allFields(proj.product_id).filter((f) => f.type !== "file" && a[f.name] !== undefined && val(f.name) !== "").map((f) => [f.label, (f.options ? (Array.isArray(a[f.name]) ? (a[f.name] as string[]) : [a[f.name] as string]).map((v) => f.options!.find((o) => o.value === v)?.label ?? v).join(", ") : val(f.name))] as [string, string]))}</section>` : html``;
    const body = html`${pageHead("Project onboarding", undefined, proj.name)}${projectTabs(ctx, proj.id)}
${done ? summary : !open ? alert("info", "Onboarding is not open for this project at its current stage.") : html`
<p class="lede">Tell us about your business and website. Save a draft any time; questions appear based on your answers. Never send passwords here — we arrange access securely.</p>
${rec && !done ? html`<p class="faint">Draft last saved ${formatDateTime(rec.updated_at)}.</p>` : ""}${formErrors(errors)}
<form method="post" action="/portal/projects/${proj.id}/onboarding" enctype="multipart/form-data" class="stack">${csrf(ctx)}${sections}
<div class="form-actions">${button("Save draft", { variant: "secondary", name: "intent", value: "draft" })}${button("Submit onboarding", { name: "intent", value: "submit" })}</div></form>`}`;
    return page(ctx, "Onboarding", body, status);
  };
  r.get("/portal/projects/:id/onboarding", async (ctx, p) => onboardingPage(ctx, requireCustomerOrg(ctx), p.id));
  r.post("/portal/projects/:id/onboarding", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    const f = await ctx.form();
    const submit = str(f, "intent") === "submit";
    return orRerender((errs, st) => onboardingPage(ctx, org, p.id, errs, st), async () => {
      const res = await O.saveOnboarding(ctx, { organizationId: org.organizationId, projectId: p.id, userId: ctx.user!.id, form: f, submit });
      return redirect(ctx, res.completed ? `/portal/projects/${p.id}` : `/portal/projects/${p.id}/onboarding`, { kind: "success", text: res.completed ? "Onboarding submitted. Your project manager will review your scope next." : "Draft saved." });
    });
  });

  // ── Files ──
  const filesPage = async (ctx: AppContext, org: Org, projectId: string | null, errors: string[] = [], status = 200) => {
    const proj = projectId ? await P.getOrgProject(ctx.db, org.organizationId, projectId) : null;
    const folder = F.normalizeFolder(ctx.url.searchParams.get("folder"));
    const files = await F.listFiles(ctx.db, org.organizationId, { projectId: proj?.id ?? null, folder });
    const folders = (await ctx.db.prepare(`SELECT DISTINCT folder FROM files WHERE organization_id = ? AND deleted_at IS NULL AND folder IS NOT NULL ${proj ? "AND project_id = ?" : ""} ORDER BY folder`).bind(org.organizationId, ...(proj ? [proj.id] : [])).all<{ folder: string }>()).results.map((x) => x.folder);
    const projects = proj ? [] : (await ctx.db.prepare(`SELECT id, name FROM projects WHERE organization_id = ? ORDER BY created_at DESC`).bind(org.organizationId).all<{ id: string; name: string }>()).results;
    const base = proj ? `/portal/projects/${proj.id}/files` : "/portal/files";
    const body = html`${pageHead(proj ? "Project files" : "Files", undefined, proj?.name ?? org.organizationName)}${proj ? projectTabs(ctx, proj.id) : ""}
${!ctx.storage ? alert("warn", "File storage is not configured yet, so uploading and downloading files is unavailable. Your team has been told; existing records are listed below.") : ""}
${alert("info", "Files are private to your organization and your Crestmont team. Malware scanning is not configured yet, so uploads show as “Not yet scanned”. Only PDF, images (PNG, JPG, WEBP, GIF), Word, Excel, ZIP, text and CSV up to 25 MB are accepted.")}
${formErrors(errors)}
<div class="grid grid-2"><section class="card"><h2 class="card__title">Upload</h2>
<form method="post" action="${base}" enctype="multipart/form-data">${csrf(ctx)}
${proj ? "" : select({ name: "project_id", label: "Project (optional)", options: projects.map((x) => ({ value: x.id, label: x.name })), includeBlank: "General — not tied to a project" })}
<div class="field"><label for="f-file">File</label><input class="input" id="f-file" type="file" name="file" required accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.docx,.xlsx,.zip,.txt,.csv"></div>
${input({ name: "folder", label: "Folder (optional)", value: folder ?? "", hint: "e.g. Branding, Content/Home page", maxlength: 80 })}
${button("Upload", { disabled: !ctx.storage })}</form></section>
<section class="card"><h2 class="card__title">Folders</h2>${folders.length ? html`<p><a href="${base}"${!folder ? html` aria-current="page"` : ""}>All files</a></p><ul class="checklist">${folders.map((x) => html`<li><a href="${base}?folder=${encodeURIComponent(x)}">${x}</a></li>`)}</ul>` : html`<p class="muted">No folders yet. Add a folder name when uploading to organize files.</p>`}</section></div>
<section style="margin-top:1.5rem">${table(files, [
  { header: "File", cell: (x) => html`<a href="/portal/files/${x.id}">${x.filename}</a>` },
  { header: "Folder", cell: (x) => x.folder ?? "—" },
  ...(proj ? [] : [{ header: "Project", cell: (x: F.FileRow) => x.project_id ? (projects.find((pp) => pp.id === x.project_id)?.name ?? "—") : "General" }]),
  { header: "Size", cell: (x) => F.humanSize(x.size_bytes), numeric: true },
  { header: "Uploaded", cell: (x) => html`${fmtDay(x.created_at)}<br><span class="faint">${x.uploader}</span>` },
  { header: "Scan", cell: (x) => badge(x.scan_status === "pending" ? "test_pending" : x.scan_status, F.scanLabel(x.scan_status)) },
  { header: "", cell: (x) => html`<a class="btn btn--ghost btn--sm" href="/files/${x.id}">Download</a>${F.PREVIEWABLE.has(x.content_type) ? html` <a class="btn btn--ghost btn--sm" href="/files/${x.id}/preview" target="_blank" rel="noopener">Preview</a>` : ""}${isAdmin(org) ? html` <a class="btn btn--ghost btn--sm" href="/files/${x.id}/share">Share</a>` : ""}` },
], { empty: emptyState("No files yet", "Upload logos, content, images and documents for your project here.") })}</section>`;
    return page(ctx, "Files", body, status);
  };
  const handleUpload = async (ctx: AppContext, org: Org, projectFromUrl: string | null) => {
    const f = await ctx.form();
    const projectId = projectFromUrl ?? (str(f, "project_id") || null);
    return orRerender((errs, st) => filesPage(ctx, org, projectFromUrl, errs, st), async () => {
      if (projectId) await P.getOrgProject(ctx.db, org.organizationId, projectId); // tenant check on the posted project id
      const file = f.get("file");
      if (!file || typeof file === "string" || file.size === 0) throw new HttpError(422, "Choose a file to upload.");
      const row = await F.storeUpload(ctx, { organizationId: org.organizationId, projectId, file, uploadedBy: ctx.user!.id, folder: str(f, "folder") });
      if (projectId) await P.touchCustomerActivity(ctx.db, org.organizationId, projectId);
      return redirect(ctx, projectFromUrl ? `/portal/projects/${projectFromUrl}/files` : "/portal/files", { kind: "success", text: `${row.filename} uploaded.` });
    });
  };
  r.get("/portal/files", async (ctx) => filesPage(ctx, requireCustomerOrg(ctx), null));
  r.post("/portal/files", async (ctx) => handleUpload(ctx, requireCustomerOrg(ctx), null));
  r.get("/portal/projects/:id/files", async (ctx, p) => filesPage(ctx, requireCustomerOrg(ctx), p.id));
  r.post("/portal/projects/:id/files", async (ctx, p) => { const org = requireCustomerOrg(ctx); await P.getOrgProject(ctx.db, org.organizationId, p.id); return handleUpload(ctx, org, p.id); });

  const fileDetail = async (ctx: AppContext, org: Org, id: string, errors: string[] = [], status = 200) => {
    const f = await F.getOrgFile(ctx.db, org.organizationId, id);
    const versions = await F.fileVersions(ctx.db, org.organizationId, f.id);
    const newer = f.replaced_by ? await ctx.db.prepare(`SELECT id, filename FROM files WHERE id = ? AND organization_id = ?`).bind(f.replaced_by, org.organizationId).first<{ id: string; filename: string }>() : null;
    const body = html`${pageHead(f.filename, html`<a class="btn btn--secondary" href="/files/${f.id}">Download</a>${F.PREVIEWABLE.has(f.content_type) ? html`<a class="btn btn--ghost" href="/files/${f.id}/preview" target="_blank" rel="noopener">Preview</a>` : ""}`, "File")}
${newer ? alert("info", html`A newer version exists: <a href="/portal/files/${newer.id}">${newer.filename}</a>.`) : ""}${formErrors(errors)}
<div class="grid grid-2"><section class="card">${dl([["Type", f.content_type], ["Size", F.humanSize(f.size_bytes)], ["Folder", f.folder ?? "—"], ["Uploaded", formatDateTime(f.created_at)], ["SHA-256", html`<code style="word-break:break-all">${f.sha256}</code>`], ["Malware scan", F.scanLabel(f.scan_status)]])}
${F.PREVIEWABLE.has(f.content_type) && f.content_type.startsWith("image/") ? html`<img src="/files/${f.id}/preview" alt="${f.filename}" style="max-width:100%;margin-top:1rem;border-radius:4px">` : ""}</section>
<section class="stack">${!f.replaced_by ? html`<div class="card"><h2 class="card__title">Replace with a new version</h2><form method="post" action="/portal/files/${f.id}/replace" enctype="multipart/form-data">${csrf(ctx)}<div class="field"><label for="f-file">New version</label><input class="input" id="f-file" type="file" name="file" required></div>${button("Upload new version", { variant: "secondary", disabled: !ctx.storage })}</form></div>` : ""}
${!f.replaced_by ? sharePanel(ctx, f, await S.listShareLinks(ctx.db, f.id), { canManage: await S.canManageShares(ctx, f) }) : ""}
<div class="card"><h2 class="card__title">Organize</h2><form method="post" action="/portal/files/${f.id}/move">${csrf(ctx)}${input({ name: "folder", label: "Folder", value: f.folder ?? "", maxlength: 80 })}${button("Move", { variant: "secondary" })}</form></div>
<div class="card"><h2 class="card__title">Remove</h2><p class="muted">Removed files disappear from your file list. A record is kept for the audit trail.</p>${actionForm(ctx, `/portal/files/${f.id}/delete`, "Remove file", { variant: "danger", confirm: "Remove this file?" })}</div></section></div>
${versions.length ? html`<section style="margin-top:1.5rem"><h2>Earlier versions</h2>${table(versions, [{ header: "File", cell: (v) => html`<a href="/files/${v.id}">${v.filename}</a>` }, { header: "Uploaded", cell: (v) => formatDateTime(v.created_at) }, { header: "Size", cell: (v) => F.humanSize(v.size_bytes), numeric: true }])}</section>` : ""}`;
    return page(ctx, f.filename, body, status);
  };
  r.get("/portal/files/:id", async (ctx, p) => fileDetail(ctx, requireCustomerOrg(ctx), p.id));
  r.post("/portal/files/:id/replace", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    const old = await F.getOrgFile(ctx.db, org.organizationId, p.id);
    const form = await ctx.form();
    return orRerender((errs, st) => fileDetail(ctx, org, p.id, errs, st), async () => {
      if (old.replaced_by) throw new HttpError(409, "Only the latest version can be replaced.");
      const file = form.get("file");
      if (!file || typeof file === "string" || file.size === 0) throw new HttpError(422, "Choose a file.");
      const row = await F.storeUpload(ctx, { organizationId: org.organizationId, projectId: old.project_id, file, uploadedBy: ctx.user!.id, folder: old.folder, replaces: old.id });
      return redirect(ctx, `/portal/files/${row.id}`, { kind: "success", text: "New version uploaded." });
    });
  });
  r.post("/portal/files/:id/move", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    await F.moveFile(ctx.db, org.organizationId, p.id, str(await ctx.form(), "folder"), ctx.user!.id);
    return redirect(ctx, `/portal/files/${p.id}`, { kind: "success", text: "File moved." });
  });
  r.post("/portal/files/:id/delete", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    await F.softDeleteFile(ctx.db, org.organizationId, p.id, ctx.user!.id);
    return redirect(ctx, "/portal/files", { kind: "success", text: "File removed." });
  });

  // Authorised download / preview (customers and staff). Access is checked per file; every download is audited.
  r.get("/files/:id", async (ctx, p) => F.serveFile(ctx, p.id, false));
  r.get("/files/:id/preview", async (ctx, p) => F.serveFile(ctx, p.id, true));

  // ── Time-limited share links (SEC-003) ──
  // Management page for one file: customers of the owning organization (admins create/revoke) and staff who can read the file.
  const shareFile = async (ctx: AppContext, id: string) => {
    if (!ctx.user) throw new HttpError(401, "Please sign in.");
    if (ctx.user.isStaff) requireStaff(ctx); else requireCustomerOrg(ctx);
    const f = await F.getFile(ctx.db, id);
    if (!f || !(await F.canReadFile(ctx, f))) throw new HttpError(404, "File not found");
    return f;
  };
  const sharePage = async (ctx: AppContext, id: string, errors: string[] = [], status = 200, created: { url: string; expiresAt: string } | null = null) => {
    const f = await shareFile(ctx, id);
    const links = await S.listShareLinks(ctx.db, f.id);
    const back = ctx.user!.isStaff ? (f.project_id ? `/staff/projects/${f.project_id}?tab=files` : `/staff/customers/${f.organization_id}`) : `/portal/files/${f.id}`;
    const body = html`${pageHead(`Share ${f.filename}`, linkButton("Back", back, "ghost", "sm"), "Secure sharing")}${formErrors(errors)}
${dl([["File", f.filename], ["Size", F.humanSize(f.size_bytes)], ["Malware scan", F.scanLabel(f.scan_status)]])}
<div style="margin-top:1.5rem">${sharePanel(ctx, f, links, { canManage: await S.canManageShares(ctx, f), created })}</div>`;
    const shell = ctx.user!.isStaff ? { title: "Share file", nav: staffNav(ctx), home: "/staff", area: "Crestmont staff" } : { title: "Share file", nav: portalNav(ctx), home: "/portal", area: "Customer portal" };
    // A freshly created link is shown exactly once in this response; never cache it.
    return htmlResponse(ctx, appLayout(ctx, shell, body), status);
  };
  r.get("/files/:id/share", async (ctx, p) => sharePage(ctx, p.id));
  r.post("/files/:id/share", async (ctx, p) => {
    const f = await shareFile(ctx, p.id);
    if (!(await S.canManageShares(ctx, f))) throw new HttpError(403, "Only an account administrator or Crestmont staff can create share links for this file.");
    const form = await ctx.form();
    try {
      const res = await S.createShareLink(ctx, { fileId: f.id, hours: Number(str(form, "hours")), acknowledgeUnscanned: !!form.get("acknowledge_unscanned"), note: str(form, "note") });
      return sharePage(ctx, f.id, [], 201, { url: res.url, expiresAt: res.expiresAt });
    } catch (e) {
      if (e instanceof S.ShareError) return sharePage(ctx, f.id, [e.message], e.status);
      throw e;
    }
  });
  r.post("/files/share-links/:id/revoke", async (ctx, p) => {
    if (!ctx.user) throw new HttpError(401, "Please sign in.");
    if (ctx.user.isStaff) requireStaff(ctx); else requireCustomerOrg(ctx);
    try {
      const { fileId } = await S.revokeShareLink(ctx, p.id);
      return redirect(ctx, `/files/${fileId}/share`, { kind: "success", text: "Share link revoked. It no longer works." });
    } catch (e) {
      if (e instanceof S.ShareError) throw new HttpError(e.status, e.message);
      throw e;
    }
  });

  // Public share link: no login. Shows only this file's name, size and the unscanned warning, then downloads it.
  const shareDenied = (ctx: AppContext, reason: string) => {
    const msg: Record<string, [number, string]> = {
      not_found: [404, "This share link is not valid. Ask the person who sent it for a new link."],
      expired: [410, "This share link has expired. Ask the person who sent it for a new link."],
      revoked: [410, "This share link was revoked by its owner."],
      file_unavailable: [410, "The shared file is no longer available."],
      rate_limited: [429, "Too many requests from your network. Please wait a while and try again."],
    };
    const [st, text] = msg[reason] ?? msg.not_found;
    const res = htmlResponse(ctx, publicLayout(ctx, { title: "Shared file", noindex: true }, html`<section class="section"><div class="container share-page stack"><div class="eyebrow">Shared file</div><h1>Link unavailable</h1>${alert("warn", text)}</div></section>`), st);
    res.headers.set("referrer-policy", "no-referrer");
    return res;
  };
  r.get("/share/:token", async (ctx, p) => {
    const s = await S.resolveShare(ctx, p.token, "view");
    if (!s.ok) return shareDenied(ctx, s.reason);
    const res = htmlResponse(ctx, publicLayout(ctx, { title: "Shared file", noindex: true }, html`<section class="section"><div class="container share-page stack">
<div class="eyebrow">Shared file</div><h1>${s.file.filename}</h1>
<p class="muted">Shared privately by Crestmont Website Development or one of its customers. This link expires ${formatDateTime(s.link.expires_at)}.</p>
${dl([["Size", F.humanSize(s.file.size_bytes)], ["Type", s.file.content_type], ["Malware scan", F.scanLabel(s.file.scan_status)]])}
${s.file.scan_status !== "clean" ? alert("warn", html`<strong>This file has not been scanned for malware.</strong> Only open it if you trust the sender.`) : ""}
<form method="post" action="/share/${p.token}/download">${csrf(ctx)}${button("Download file")}</form>
<p class="faint">Downloads through this link are logged.</p></div></section>`));
    res.headers.set("referrer-policy", "no-referrer");
    res.headers.set("cache-control", "no-store");
    return res;
  });
  r.post("/share/:token/download", async (ctx, p) => {
    const s = await S.resolveShare(ctx, p.token, "download");
    if (!s.ok) return shareDenied(ctx, s.reason);
    if (!ctx.storage) throw new HttpError(503, "File storage is not configured yet.");
    const obj = await ctx.storage.get(s.file.r2_key);
    if (!obj) throw new HttpError(404, "File content is missing from storage.");
    const headers = new Headers({
      "content-type": s.file.content_type,
      "content-disposition": `attachment; filename="${s.file.filename.replace(/[^\w.\- ()]/g, "_")}"`,
      "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; sandbox", "x-frame-options": "DENY",
    });
    for (const c of ctx.setCookies) headers.append("set-cookie", c);
    return new Response(obj.body as BodyInit, { headers });
  });

  // ── Messages ──
  r.get("/portal/messages", async (ctx) => {
    const org = requireCustomerOrg(ctx);
    const rows = (await ctx.db.prepare(`SELECT p.id, p.name, p.status,
        (SELECT COUNT(*) FROM messages m WHERE m.project_id = p.id AND m.internal = 0) AS total,
        (SELECT COUNT(*) FROM messages m WHERE m.project_id = p.id AND m.internal = 0 AND m.author_user_id <> ? AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?)) AS unread,
        (SELECT MAX(created_at) FROM messages m WHERE m.project_id = p.id AND m.internal = 0) AS last_at
        FROM projects p WHERE p.organization_id = ? ORDER BY COALESCE(last_at, p.created_at) DESC`).bind(ctx.user!.id, ctx.user!.id, org.organizationId)
      .all<{ id: string; name: string; status: string; total: number; unread: number; last_at: string | null }>()).results;
    const general = (await ctx.db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN m.author_user_id <> ? AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?) THEN 1 ELSE 0 END) AS unread,
        MAX(m.created_at) AS last_at FROM messages m WHERE m.organization_id = ? AND m.project_id IS NULL AND m.internal = 0`).bind(ctx.user!.id, ctx.user!.id, org.organizationId)
      .first<{ total: number; unread: number | null; last_at: string | null }>())!;
    return page(ctx, "Messages", html`${pageHead("Messages", linkButton("New general message", "/portal/messages/general", "primary", "sm"))}
<section class="card" style="margin-bottom:1.5rem"><div class="row row--between"><div><h2 class="card__title">General conversation with Crestmont</h2>
<p class="muted" style="margin:0">For questions that are not about one project — new work, your account, or anything else. For account or billing problems you can also open a <a href="/portal/support">support ticket</a>.</p></div>
<div class="row">${general.unread ? badge("new", `${general.unread} unread`) : ""}<span class="faint">${general.total ? `${general.total} message${general.total === 1 ? "" : "s"} · last ${formatDateTime(general.last_at)}` : "No messages yet"}</span>${linkButton("Open", "/portal/messages/general", "secondary", "sm")}</div></div></section>
<h2 class="h4">Project conversations</h2>
${table(rows, [
  { header: "Project", cell: (x) => html`<a href="/portal/projects/${x.id}/messages">${x.name}</a>` },
  { header: "Messages", cell: (x) => x.total, numeric: true },
  { header: "Unread", cell: (x) => (x.unread ? badge("new", `${x.unread} unread`) : "—") },
  { header: "Last message", cell: (x) => formatDateTime(x.last_at) },
], { empty: emptyState("No project conversations yet", "A conversation opens for each project once it is created. Use the general conversation above for anything else.", linkButton("View packages", "/pricing", "secondary")) })}`);
  });

  // General (non-project) conversation with Crestmont (PORTAL-005). project_id IS NULL, scoped to the caller's organization.
  const generalThreadPage = async (ctx: AppContext, org: Org, errors: string[] = [], status = 200, draft = "") => {
    const msgs = await M.listThread(ctx.db, { userId: ctx.user!.id, organizationId: org.organizationId, staff: false }, null);
    await M.markThreadRead(ctx.db, ctx.user!.id, org.organizationId, null, false);
    const body = html`${pageHead("General conversation", linkButton("All messages", "/portal/messages", "ghost", "sm"), org.organizationName)}
<p class="muted">Messages here go to the Crestmont team, not to a specific project. Project questions are answered faster in that project's own conversation.</p>
<div class="thread" aria-live="polite">${msgs.length ? msgs.map((m) => html`<article class="msg${m.author_is_staff ? " msg--staff" : ""}"><div class="msg__meta">${m.author_name}${m.author_is_staff ? " · Crestmont" : ""} · ${formatDateTime(m.created_at)}${m.author_user_id === ctx.user!.id ? (m.read_by_other_side ? " · Seen by Crestmont" : " · Not yet read") : m.read_by_me ? "" : " · New"}</div>
${nl2br(m.body)}${m.attachment_file_id ? html`<p><a href="/files/${m.attachment_file_id}">Attachment: ${m.attachment_name ?? "file"}</a></p>` : ""}</article>`) : emptyState("No messages yet", "Ask a question or tell us what you need below.")}</div>
${formErrors(errors)}
<form method="post" action="/portal/messages/general" enctype="multipart/form-data" class="card" style="margin-top:1.5rem">${csrf(ctx)}
${textarea({ name: "body", label: "Message", value: draft, required: true, maxlength: 10000, rows: 4 })}
<div class="field"><label for="f-attachment">Attachment (optional)</label><input class="input" id="f-attachment" type="file" name="attachment" aria-describedby="f-attachment-hint"${ctx.storage ? "" : html` disabled`}><span class="hint" id="f-attachment-hint">${ctx.storage ? "Same file rules as uploads: up to 25 MB." : "File storage is not configured yet."}</span></div>
${button("Send message")}</form>`;
    return page(ctx, "General conversation", body, status);
  };
  r.get("/portal/messages/general", async (ctx) => generalThreadPage(ctx, requireCustomerOrg(ctx)));
  r.post("/portal/messages/general", async (ctx) => {
    const org = requireCustomerOrg(ctx);
    const f = await ctx.form();
    const att = f.get("attachment");
    return orRerender((errs, st) => generalThreadPage(ctx, org, errs, st, str(f, "body")), async () => {
      await M.postMessage(ctx, { organizationId: org.organizationId, projectId: null, authorUserId: ctx.user!.id, body: str(f, "body"), attachment: att && typeof att !== "string" ? att : null, fromStaff: false });
      return redirect(ctx, "/portal/messages/general", { kind: "success", text: "Message sent." });
    });
  });

  const threadPage = async (ctx: AppContext, org: Org, id: string, errors: string[] = [], status = 200, draft = "") => {
    const proj = await P.getOrgProject(ctx.db, org.organizationId, id);
    const msgs = await M.listThread(ctx.db, { userId: ctx.user!.id, organizationId: org.organizationId, staff: false }, proj.id);
    await M.markThreadRead(ctx.db, ctx.user!.id, org.organizationId, proj.id, false);
    const body = html`${pageHead("Messages", undefined, proj.name)}${projectTabs(ctx, proj.id)}
<div class="thread" aria-live="polite">${msgs.length ? msgs.map((m) => html`<article class="msg${m.author_is_staff ? " msg--staff" : ""}"><div class="msg__meta">${m.author_name}${m.author_is_staff ? " · Crestmont" : ""} · ${formatDateTime(m.created_at)}${m.author_user_id === ctx.user!.id ? (m.read_by_other_side ? " · Seen by team" : " · Not yet read") : m.read_by_me ? "" : " · New"}</div>
${nl2br(m.body)}${m.attachment_file_id ? html`<p><a href="/files/${m.attachment_file_id}">Attachment: ${m.attachment_name ?? "file"}</a></p>` : ""}</article>`) : emptyState("No messages yet", "Ask a question or share an update with your team below.")}</div>
${formErrors(errors)}
<form method="post" action="/portal/projects/${proj.id}/messages" enctype="multipart/form-data" class="card" style="margin-top:1.5rem">${csrf(ctx)}
${textarea({ name: "body", label: "Message", value: draft, required: true, maxlength: 10000, rows: 4 })}
<div class="field"><label for="f-attachment">Attachment (optional)</label><input class="input" id="f-attachment" type="file" name="attachment"${ctx.storage ? "" : html` disabled`}><span class="hint">${ctx.storage ? "Same file rules as uploads: up to 25 MB." : "File storage is not configured yet."}</span></div>
${button("Send message")}</form>`;
    return page(ctx, "Messages", body, status);
  };
  r.get("/portal/projects/:id/messages", async (ctx, p) => threadPage(ctx, requireCustomerOrg(ctx), p.id));
  r.post("/portal/projects/:id/messages", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    await P.getOrgProject(ctx.db, org.organizationId, p.id);
    const f = await ctx.form();
    const att = f.get("attachment");
    return orRerender((errs, st) => threadPage(ctx, org, p.id, errs, st, str(f, "body")), async () => {
      await M.postMessage(ctx, { organizationId: org.organizationId, projectId: p.id, authorUserId: ctx.user!.id, body: str(f, "body"), attachment: att && typeof att !== "string" ? att : null, fromStaff: false });
      return redirect(ctx, `/portal/projects/${p.id}/messages`, { kind: "success", text: "Message sent." });
    });
  });

  // ── Revisions & change orders ──
  const revisionsPage = async (ctx: AppContext, org: Org, id: string, errors: string[] = [], status = 200) => {
    const proj = await P.getOrgProject(ctx.db, org.organizationId, id);
    const revs = await P.listRevisions(ctx.db, proj.id);
    const cos = await P.listChangeOrders(ctx.db, proj.id);
    const usage = await P.revisionUsage(ctx.db, proj.id);
    const remaining = Math.max(0, proj.revision_allowance - usage.used);
    const body = html`${pageHead("Revisions", undefined, proj.name)}${projectTabs(ctx, proj.id)}
<div class="kpis">${kpi("Included rounds", proj.revision_allowance, packageName(proj.product_id))}${kpi("Used", usage.used)}${kpi("Remaining", remaining, remaining ? undefined : "Further changes need a change order")}</div>
${formErrors(errors)}
<div class="grid grid-2"><section class="card"><h2 class="card__title">Request a revision</h2>
${remaining ? html`<p class="muted">This will use round ${usage.used + 1} of ${proj.revision_allowance}. Group all changes for this round into one request.</p>` : html`<p class="muted">You have used every included round. You can still submit a request: we will reply with a change order (scope and price) for your approval before any work starts.</p>`}
<form method="post" action="/portal/projects/${proj.id}/revisions">${csrf(ctx)}${textarea({ name: "request", label: "What should change?", required: true, maxlength: 10000, rows: 6 })}${button(remaining ? "Submit revision request" : "Request a change-order quote")}</form></section>
<section class="card"><h2 class="card__title">Change orders</h2>${cos.length ? cos.map((c) => html`<div class="msg" style="margin-bottom:.75rem"><div class="row row--between"><strong>${formatCents(c.price_cents)}</strong>${badge(c.status)}</div><p>${nl2br(c.scope_text)}</p>
${c.status === "proposed" ? isAdmin(org) ? html`<form method="post" action="/portal/change-orders/${c.id}/decide">${csrf(ctx)}${input({ name: "notes", label: "Notes (optional)", maxlength: 1000, id: `co-notes-${c.id}` })}<div class="row">${button("Approve change order", { name: "decision", value: "approved", size: "sm" })}${button("Decline", { variant: "ghost", name: "decision", value: "rejected", size: "sm" })}</div></form>` : html`<p class="faint">An account administrator must approve change orders.</p>` : ""}
${c.invoice_id ? html`<p>Invoice: ${badge(c.invoice_status ?? "open")} ${c.invoice_status === "open" ? html`<a class="btn btn--primary btn--sm" href="/portal/billing/invoices/${c.invoice_id}">Pay invoice</a>` : ""}</p>` : ""}</div>`) : html`<p class="muted">No change orders.</p>`}</section></div>
<section style="margin-top:1.5rem"><h2>Revision rounds</h2>${table(revs, [
  { header: "Round", cell: (x) => html`${x.round}${x.included ? "" : html` ${badge("requested", "Billable")}`}` },
  { header: "Request", cell: (x) => nl2br(x.request_text.length > 300 ? x.request_text.slice(0, 297) + "…" : x.request_text) },
  { header: "Status", cell: (x) => (!x.included && !x.billable_change_order_id ? badge("pending", "Awaiting change-order quote") : badge(x.status)) },
  { header: "Change order", cell: (x) => (x.co_status ? html`${badge(x.co_status)} ${formatCents(x.co_price)}` : "—") },
  { header: "Submitted", cell: (x) => fmtDay(x.created_at) },
  { header: "", cell: (x) => (x.status === "delivered" ? html`<a class="btn btn--secondary btn--sm" href="/portal/projects/${proj.id}/approvals">Review &amp; approve</a>` : "") },
], { empty: emptyState("No revision requests yet", "When you review your design or website, request changes here. Each request counts as one round.") })}</section>`;
    return page(ctx, "Revisions", body, status);
  };
  r.get("/portal/projects/:id/revisions", async (ctx, p) => revisionsPage(ctx, requireCustomerOrg(ctx), p.id));
  r.post("/portal/projects/:id/revisions", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    const f = await ctx.form();
    return orRerender((errs, st) => revisionsPage(ctx, org, p.id, errs, st), async () => {
      const res = await P.requestRevision(ctx, { organizationId: org.organizationId, projectId: p.id, userId: ctx.user!.id, text: str(f, "request") });
      return redirect(ctx, `/portal/projects/${p.id}/revisions`, { kind: "success", text: res.decision.kind === "included" ? `Revision round ${res.decision.round} submitted.` : "Request received. Your included rounds are used, so we will send a change order for approval." });
    });
  });
  r.post("/portal/change-orders/:id/decide", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    const f = await ctx.form();
    const decision = str(f, "decision") === "approved" ? "approved" : "rejected";
    const co = await ctx.db.prepare(`SELECT c.project_id FROM change_orders c JOIN projects pr ON pr.id = c.project_id WHERE c.id = ? AND pr.organization_id = ?`).bind(p.id, org.organizationId).first<{ project_id: string }>();
    if (!co) throw new HttpError(404, "Change order not found");
    return orRerender((errs, st) => revisionsPage(ctx, org, co.project_id, errs, st), async () => {
      const res = await P.decideChangeOrder(ctx, ctx.actor!, { organizationId: org.organizationId, changeOrderId: p.id, userId: ctx.user!.id, decision, notes: str(f, "notes") });
      if (res.invoiceId) return redirect(ctx, `/portal/projects/${co.project_id}/revisions`, { kind: "success", text: "Change order approved. An invoice is ready under Billing." });
      return redirect(ctx, `/portal/projects/${co.project_id}/revisions`, { kind: "success", text: decision === "approved" ? "Change order approved." : "Change order declined." });
    });
  });

  // ── Approvals ──
  r.get("/portal/approvals", async (ctx) => {
    const org = requireCustomerOrg(ctx);
    const open = (await ctx.db.prepare(`SELECT r.id, r.kind, r.note, r.created_at, p.id AS project_id, p.name FROM approval_requests r JOIN projects p ON p.id = r.project_id WHERE p.organization_id = ? AND r.resolved_at IS NULL ORDER BY r.created_at`).bind(org.organizationId).all<{ id: string; kind: string; note: string | null; created_at: string; project_id: string; name: string }>()).results;
    const past = (await ctx.db.prepare(`SELECT a.kind, a.decision, a.notes, a.created_at, p.id AS project_id, p.name, u.display_name FROM approvals a JOIN projects p ON p.id = a.project_id JOIN users u ON u.id = a.decided_by WHERE p.organization_id = ? AND a.kind IN ('scope','design','revision','customer_launch','final_acceptance') ORDER BY a.created_at DESC LIMIT 100`).bind(org.organizationId).all<{ kind: string; decision: string; notes: string | null; created_at: string; project_id: string; name: string; display_name: string }>()).results;
    return page(ctx, "Approvals", html`${pageHead("Approvals")}
<section class="card"><h2 class="card__title">Waiting for your decision</h2>${table(open, [
  { header: "Approval", cell: (a) => P.APPROVAL_LABELS[a.kind] },
  { header: "Project", cell: (a) => html`<a href="/portal/projects/${a.project_id}/approvals">${a.name}</a>` },
  { header: "Requested", cell: (a) => fmtDay(a.created_at) },
  { header: "Note", cell: (a) => a.note ?? "—" },
], { empty: html`<p class="muted">Nothing is waiting for your approval.</p>` })}</section>
<section style="margin-top:1.5rem"><h2>Decision history</h2>${table(past, [
  { header: "Approval", cell: (a) => P.APPROVAL_LABELS[a.kind] },
  { header: "Project", cell: (a) => a.name },
  { header: "Decision", cell: (a) => badge(a.decision) },
  { header: "By", cell: (a) => a.display_name },
  { header: "Notes", cell: (a) => a.notes ?? "—" },
  { header: "When", cell: (a) => formatDateTime(a.created_at) },
], { empty: emptyState("No decisions yet", "Your scope, design, revision, launch and acceptance decisions are recorded here.") })}</section>`);
  });

  const approvalsPage = async (ctx: AppContext, org: Org, id: string, errors: string[] = [], status = 200) => {
    const proj = await P.getOrgProject(ctx.db, org.organizationId, id);
    const open = (await ctx.db.prepare(`SELECT id, kind, subject_id, note, created_at FROM approval_requests WHERE project_id = ? AND resolved_at IS NULL ORDER BY created_at`).bind(proj.id).all<{ id: string; kind: P.CustomerApprovalKind; subject_id: string | null; note: string | null; created_at: string }>()).results;
    const past = (await ctx.db.prepare(`SELECT a.kind, a.decision, a.notes, a.created_at, u.display_name FROM approvals a JOIN users u ON u.id = a.decided_by WHERE a.project_id = ? AND a.kind IN ('scope','design','revision','customer_launch','final_acceptance') ORDER BY a.created_at DESC`).bind(proj.id).all<{ kind: string; decision: string; notes: string | null; created_at: string; display_name: string }>()).results;
    const scope = await ctx.db.prepare(`SELECT version, scope_text, approved_at FROM project_scopes WHERE project_id = ? ORDER BY version DESC LIMIT 1`).bind(proj.id).first<{ version: number; scope_text: string; approved_at: string | null }>();
    const form = (req: (typeof open)[number]) => isAdmin(org) ? html`<form method="post" action="/portal/projects/${proj.id}/approvals">${csrf(ctx)}<input type="hidden" name="kind" value="${req.kind}"><input type="hidden" name="subject_id" value="${req.subject_id ?? ""}">
${textarea({ name: "notes", label: "Notes", hint: "Required if you reject: tell us what needs to change.", rows: 3, maxlength: 2000, id: `notes-${req.id}` })}
<div class="row">${button("Approve", { name: "decision", value: "approved" })}${button("Reject", { variant: "danger", name: "decision", value: "rejected" })}</div></form>` : html`<p class="faint">Only an account administrator for ${org.organizationName} can record approvals.</p>`;
    const body = html`${pageHead("Approvals", undefined, proj.name)}${projectTabs(ctx, proj.id)}${formErrors(errors)}
${open.length ? open.map((req) => html`<section class="card card--gold" style="margin-bottom:1rem"><h2 class="card__title">${P.APPROVAL_LABELS[req.kind]}</h2>
${req.note ? html`<p>${nl2br(req.note)}</p>` : ""}${req.kind === "scope" && scope ? html`<details open><summary>Scope version ${scope.version}</summary><div class="prose">${nl2br(scope.scope_text)}</div></details>` : ""}
${req.kind === "final_acceptance" ? html`<p><a href="/portal/projects/${proj.id}/handoff">Review the handoff package first</a>.</p>` : ""}${form(req)}</section>`) : html`<section class="card"><p class="muted">Nothing is waiting for your approval on this project.</p></section>`}
<section style="margin-top:1.5rem"><h2>History</h2>${table(past, [
  { header: "Approval", cell: (a) => P.APPROVAL_LABELS[a.kind] }, { header: "Decision", cell: (a) => badge(a.decision) },
  { header: "By", cell: (a) => a.display_name }, { header: "Notes", cell: (a) => a.notes ?? "—" }, { header: "When", cell: (a) => formatDateTime(a.created_at) },
], { empty: html`<p class="muted">No decisions recorded yet.</p>` })}</section>`;
    return page(ctx, "Approvals", body, status);
  };
  r.get("/portal/projects/:id/approvals", async (ctx, p) => approvalsPage(ctx, requireCustomerOrg(ctx), p.id));
  r.post("/portal/projects/:id/approvals", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    const f = await ctx.form();
    const kind = str(f, "kind") as P.CustomerApprovalKind;
    const decision = str(f, "decision") === "approved" ? "approved" : "rejected";
    return orRerender((errs, st) => approvalsPage(ctx, org, p.id, errs, st), async () => {
      // recordCustomerApproval authorizes (customer.approve) BEFORE validating the approval kind.
      await P.recordCustomerApproval(ctx, ctx.actor!, { organizationId: org.organizationId, projectId: p.id, kind, decision, notes: str(f, "notes"), userId: ctx.user!.id, subjectId: str(f, "subject_id") || null });
      return redirect(ctx, kind === "final_acceptance" ? `/portal/projects/${p.id}/handoff` : `/portal/projects/${p.id}/approvals`, { kind: "success", text: `${P.APPROVAL_LABELS[kind]} ${decision}.` });
    });
  });

  // ── Handoff ──
  r.get("/portal/projects/:id/handoff", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    const proj = await P.getOrgProject(ctx.db, org.organizationId, p.id);
    const h = await ctx.db.prepare(`SELECT h.*, u.display_name AS accepted_name, f.filename AS doc_name FROM handoffs h LEFT JOIN users u ON u.id = h.accepted_by LEFT JOIN files f ON f.id = h.documentation_file_id AND f.deleted_at IS NULL AND f.organization_id = ? WHERE h.project_id = ?`)
      .bind(org.organizationId, proj.id).first<{ website_url: string | null; documentation: string | null; access_instructions: string | null; ownership_notes: string | null; training_notes: string | null; documentation_file_id: string | null; doc_name: string | null; published_at: string | null; accepted_at: string | null; accepted_name: string | null }>();
    const published = !!h?.published_at;
    const body = html`${pageHead("Handoff", undefined, proj.name)}${projectTabs(ctx, proj.id)}
${!published ? emptyState("Handoff not published yet", "When your website is launched, your project manager publishes the handoff package here: website URL, documentation, access instructions, ownership records and training notes.") : html`
${h!.accepted_at ? alert("success", `Final acceptance recorded ${formatDateTime(h!.accepted_at)} by ${h!.accepted_name ?? "your team"}.`) : alert("info", html`Review everything below, then record your final acceptance. ${isAdmin(org) ? "" : "An account administrator must record it."}`)}
<div class="grid grid-2"><section class="card"><h2 class="card__title">Website</h2><p><a href="${safeUrl(h!.website_url)}" rel="noopener">${h!.website_url}</a></p>
<h3>Documentation</h3><div class="prose">${nl2br(h!.documentation)}</div>${h!.documentation_file_id && h!.doc_name ? html`<p><a href="/files/${h!.documentation_file_id}">Download: ${h!.doc_name}</a></p>` : ""}</section>
<section class="card"><h2 class="card__title">Access instructions</h2><div class="prose">${nl2br(h!.access_instructions)}</div><p class="faint">Credentials are never sent in the portal or by email; follow these instructions to receive them securely.</p></section>
<section class="card"><h2 class="card__title">Ownership records</h2><div class="prose">${nl2br(h!.ownership_notes)}</div><p class="faint">Your domain remains yours. Intellectual property rights transfer after full payment, subject to third-party licenses.</p></section>
<section class="card"><h2 class="card__title">Training</h2><div class="prose">${nl2br(h!.training_notes)}</div></section></div>
${!h!.accepted_at && isAdmin(org) ? html`<section class="card card--gold" style="margin-top:1.5rem"><h2 class="card__title">Final acceptance</h2><form method="post" action="/portal/projects/${proj.id}/approvals">${csrf(ctx)}<input type="hidden" name="kind" value="final_acceptance">
${textarea({ name: "notes", label: "Notes", rows: 3, maxlength: 2000, hint: "Required if anything is missing." })}<div class="row">${button("Accept the website", { name: "decision", value: "approved" })}${button("Something is missing", { variant: "ghost", name: "decision", value: "rejected" })}</div></form></section>` : ""}`}`;
    return page(ctx, "Handoff", body);
  });

  // ── Team ──
  const teamPage = async (ctx: AppContext, org: Org, errors: string[] = [], status = 200, email = "") => {
    const members = (await ctx.db.prepare(`SELECT u.id, u.display_name, u.email, m.role_id, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY m.created_at`).bind(org.organizationId).all<{ id: string; display_name: string; email: string; role_id: string; created_at: string }>()).results;
    const invites = (await ctx.db.prepare(`SELECT id, email, role_id, expires_at FROM invitations WHERE organization_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY expires_at DESC`).bind(org.organizationId, new Date().toISOString()).all<{ id: string; email: string; role_id: string; expires_at: string }>()).results;
    const admin = isAdmin(org);
    const roleLabel = (r: string) => (r === "customer_admin" ? "Administrator" : r === "customer_member" ? "Member" : label(r));
    const roleOpts = [{ value: "customer_member", label: "Member" }, { value: "customer_admin", label: "Administrator" }];
    const body = html`${pageHead("Team", undefined, org.organizationName)}
${formErrors(errors)}
<p class="muted"><strong>Members</strong> can view projects, send messages, upload files, request revisions and open support tickets. <strong>Administrators</strong> can also approve scope, designs, change orders and launch, pay invoices, and manage this team. Your organization always keeps at least one administrator.</p>
${table(members, [
      { header: "Name", cell: (m) => html`${m.display_name}${m.id === ctx.user!.id ? html` <span class="faint">(you)</span>` : ""}` }, { header: "Email", cell: (m) => m.email },
      { header: "Role", cell: (m) => admin && m.id !== ctx.user!.id
        ? html`<form method="post" action="/portal/team/members/${m.id}/role" class="row">${csrf(ctx)}<label class="visually-hidden" for="role-${m.id}">Role for ${m.display_name}</label><select class="select" id="role-${m.id}" name="role">${roleOpts.map((o) => html`<option value="${o.value}"${o.value === m.role_id ? html` selected` : ""}>${o.label}</option>`)}</select>${button("Save", { variant: "secondary", size: "sm" })}</form>`
        : roleLabel(m.role_id) },
      { header: "Since", cell: (m) => fmtDay(m.created_at) },
      { header: "", cell: (m) => (admin && m.id !== ctx.user!.id ? actionForm(ctx, `/portal/team/members/${m.id}/remove`, "Remove", { variant: "danger", confirm: `Remove ${m.display_name} from ${org.organizationName}? They lose portal access immediately.` }) : "") },
    ], { caption: "Team members" })}
<h2 style="margin-top:1.5rem">Pending invitations</h2>${table(invites, [
      { header: "Email", cell: (i) => i.email }, { header: "Role", cell: (i) => roleLabel(i.role_id) }, { header: "Expires", cell: (i) => fmtDay(i.expires_at) },
      { header: "", cell: (i) => (admin ? actionForm(ctx, `/portal/team/invitations/${i.id}/revoke`, "Revoke", { variant: "ghost", confirm: `Revoke the invitation for ${i.email}?` }) : "") },
    ], { empty: html`<p class="muted">No pending invitations.</p>`, caption: "Pending invitations" })}
<section class="card" style="margin-top:1.5rem"><h2 class="card__title">Invite a colleague</h2>
${admin ? html`<form method="post" action="/portal/team">${csrf(ctx)}${input({ name: "email", label: "Email", type: "email", value: email, required: true, autocomplete: "off" })}
${select({ name: "role", label: "Role", options: roleOpts, value: "customer_member" })}${button("Send invitation")}</form>` : html`<p class="muted">Only an account administrator can invite colleagues or change roles.</p>`}</section>`;
    return page(ctx, "Team", body, status);
  };
  const teamAction = async (ctx: AppContext, fn: (org: Org) => Promise<string>) => {
    const org = requireCustomerOrg(ctx);
    if (!isAdmin(org)) throw new HttpError(403, "Only an account administrator can manage the team.");
    try {
      return redirect(ctx, "/portal/team", { kind: "success", text: await fn(org) });
    } catch (e) {
      if (e instanceof T.TeamError) {
        if (e.status === 404) throw new HttpError(404, e.message);
        return teamPage(ctx, org, [e.message], e.status);
      }
      throw e;
    }
  };
  r.post("/portal/team/members/:userId/role", async (ctx, p) => {
    const role = str(await ctx.form(), "role");
    return teamAction(ctx, async (org) => {
      const res = await T.changeMemberRole(ctx.db, ctx.user!.id, org.organizationId, p.userId, role);
      return res.from === res.to ? "Role unchanged." : `Role changed to ${res.to === "customer_admin" ? "Administrator" : "Member"}.`;
    });
  });
  r.post("/portal/team/members/:userId/remove", async (ctx, p) => teamAction(ctx, async (org) => {
    const m = await T.removeMember(ctx.db, ctx.user!.id, org.organizationId, p.userId);
    return `${m.display_name} was removed and signed out.`;
  }));
  r.post("/portal/team/invitations/:id/revoke", async (ctx, p) => teamAction(ctx, async (org) => {
    await T.revokeCustomerInvitation(ctx.db, ctx.user!.id, org.organizationId, p.id);
    return "Invitation revoked.";
  }));
  r.get("/portal/team", async (ctx) => teamPage(ctx, requireCustomerOrg(ctx)));
  r.post("/portal/team", async (ctx) => {
    const org = requireCustomerOrg(ctx);
    if (!isAdmin(org)) throw new HttpError(403, "Only an account administrator can invite colleagues.");
    const form = await ctx.form();
    const email = str(form, "email").toLowerCase();
    const role = str(form, "role") === "customer_admin" ? "customer_admin" : "customer_member";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) return teamPage(ctx, org, ["Enter a valid email address."], 422, email);
    const member = await ctx.db.prepare(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ? AND m.organization_id = ?`).bind(email, org.organizationId).first();
    if (member) return teamPage(ctx, org, ["That person is already a member of your organization."], 422, email);
    const staff = await ctx.db.prepare(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ? AND m.role_id IN ('owner','administrator','sales','developer','project_manager','support')`).bind(email).first();
    if (staff) return teamPage(ctx, org, ["That address belongs to a Crestmont staff account and cannot be invited to a customer organization."], 422, email);
    try {
      const pending = await ctx.db.prepare(`SELECT 1 FROM invitations WHERE organization_id = ? AND email = ? AND accepted_at IS NULL AND expires_at > ?`).bind(org.organizationId, email, new Date().toISOString()).first();
      if (pending) return teamPage(ctx, org, ["An invitation to that address is already pending. Revoke it first to send a new one."], 422, email);
      const token = await createInvitation(ctx.db, ctx.user!.id, email, role, org.organizationId);
      await sendMail(ctx, { template: "registration", to: email, idempotencyKey: `cinv:${token.slice(0, 16)}`,
        data: { inviterName: ctx.user!.displayName, organizationName: org.organizationName, acceptUrl: `${ctx.baseUrl}/invite?token=${token}` } });
    } catch (e) {
      if (e instanceof AuthError) return teamPage(ctx, org, [e.message], 422, email);
      throw e;
    }
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "customer.member_invited", subjectType: "organization", subjectId: org.organizationId, organizationId: org.organizationId, details: { email, role } });
    return redirect(ctx, "/portal/team", { kind: "success", text: `Invitation sent to ${email}.` });
  });
}
