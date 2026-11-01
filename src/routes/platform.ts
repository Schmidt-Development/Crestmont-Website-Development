// Platform administration, AI operations and AI receptionist (area E):
// employees, email operations, integrations, monitoring, security, audit logs, backups, business
// settings, AI operations, AI receptionist, privacy self-service and the signed voice webhook.
// Every staff route calls requireStaff(ctx, perm) with the permission its nav link declares.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, formatDate, label, safeHttpsUrl, type SafeHtml } from "../lib/html.ts";
import { HttpError, htmlResponse, jsonResponse, redirect, download, str } from "../app/http.ts";
import { requireStaff, requireUser } from "../app/app.ts";
import { appLayout } from "../ui/layout.ts";
import {
  csrf, input, textarea, select, checkbox, button, formErrors, alert, badge, table, emptyState, kpi, pagination, pageParam,
  pageHead, actionForm, tabs, dl, barChart, linkButton,
} from "../ui/components.ts";
import { staffNav, portalNav } from "./nav.ts";
import { isOwner, can } from "../domain/authz.ts";
import { audit } from "../services/security.ts";
import { sendMail, renderTemplate, identityFrom, EMAIL_TEMPLATES, REQUIRED_WORKFLOWS, TEMPLATES, type EmailTemplate, type TemplateDef } from "../services/mailer.ts";
import { ResendEmail } from "../adapters/email.ts";
import { decideAiJob, aiProviderFromEnv, AI_WORKFLOWS, AI_FORBIDDEN, LOCAL_RUNNER, paidAiBudget, priceKnown } from "../services/ai.ts";
import * as emp from "../services/employees.ts";
import * as off from "../services/offboarding.ts";
import * as wl from "../services/workload.ts";
import { toCsv } from "../services/finance.ts";
import * as integ from "../services/integrations.ts";
import * as mon from "../services/monitoring.ts";
import * as priv from "../services/privacy.ts";
import * as voice from "../services/voice.ts";
import { voiceBudget, setVoiceBudget, VoiceBudgetError } from "../services/voice-budget.ts";
import { syncPrompt, latestPromptSync, type PromptSyncResult } from "../services/voice-prompt-sync.ts";
import { readBody } from "./api.ts";
import { ValidationError } from "../lib/validate.ts";
import { newId, nowIso } from "../lib/db.ts";

// ───────────── shared helpers ─────────────
function staffPage(ctx: AppContext, title: string, body: SafeHtml, status = 200): Response {
  return htmlResponse(ctx, appLayout(ctx, { title, nav: staffNav(ctx), home: "/staff", area: "Crestmont staff" }, body), status);
}

const q = (ctx: AppContext, k: string, max = 120) => (ctx.url.searchParams.get(k) ?? "").trim().slice(0, max);
/** Stored mail keeps single-use secrets (password reset, email verification, invitation, proposal and share links)
 *  so a failed delivery can be retried. Staff views never show them: whoever reads one can act as the recipient. */
const redactSecrets = (s: string) => s.replace(/(token=|\/q\/|\/share\/)[A-Za-z0-9_-]{16,}/g, "$1[redacted]");
/** The staging journeys' synthetic customers (tests/e2e/staging-journeys.e2e.ts). `.example` is reserved (RFC 2606), so
 *  these addresses can never belong to or reach a real person. */
export const JOURNEY_EMAIL_DOMAIN = "@staging-journeys.example";
export const isJourneyAddress = (email: string) => email.trim().toLowerCase().endsWith(JOURNEY_EMAIL_DOMAIN);
/** Links in stored emails carry live tokens (proposal, verification, reset, share), so staff never see them (EMP-002) —
 *  with one exception: on STAGING, mail to the journeys' own synthetic domain, whose "recipient" is the test itself and
 *  must follow the links it was sent (deploy #61, journey 4). Development, tests and production always redact. */
const bodyForStaff = (ctx: AppContext, to: string, s: string) => (ctx.env.ENVIRONMENT === "staging" && isJourneyAddress(to) ? s : redactSecrets(s));
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const microUsd = (v: number | null | undefined) => (v === null || v === undefined ? "Unknown" : `$${(v / 1e6).toFixed(4)}`);
const yesNo = (b: boolean) => (b ? badge("active", "Present") : badge("not_configured", "Not set"));

function filterForm(ctx: AppContext, fields: SafeHtml[], action?: string): SafeHtml {
  return html`<form class="filters" method="get" action="${action ?? ctx.url.pathname}">${fields}<div class="field">${button("Filter", { variant: "secondary", size: "sm" })}</div></form>`;
}

/** CSV cell with spreadsheet formula-injection guard (SEC-001). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function errStatus(e: unknown): number | undefined {
  return (e as { status?: number }).status;
}

// ───────────── 1. Employees (EMP-001, EMP-002, EMP-003, AUTH-006) ─────────────
async function employeesPage(ctx: AppContext, errors: string[] = [], v: Record<string, string> = {}) {
  requireStaff(ctx, "employee.manage");
  const fq = q(ctx, "q"), frole = q(ctx, "role"), fstatus = q(ctx, "status");
  const all = await wl.teamWorkload(ctx.db, ctx.now());
  const staff = filterStaff(all, fq, frole, fstatus);
  const invites = await emp.pendingInvitations(ctx.db);
  const roleOpts = emp.ASSIGNABLE_STAFF_ROLES.map((r) => ({ value: r, label: label(r) }));
  const active = all.filter((s) => !s.disabled_at);
  const mfa = active.filter((s) => s.mfa).length;
  const teamOverdue = active.reduce((n, s) => n + s.w.overdueTasks, 0);
  const unassignedTasks = (await ctx.db.prepare(`SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.status <> 'done' AND p.status NOT IN ('completed','maintenance','cancelled')
      AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.subject_type = 'task' AND a.subject_id = t.id AND a.ended_at IS NULL)`).first<{ n: number }>())?.n ?? 0;
  const exportQs = new URLSearchParams(ctx.url.search); exportQs.delete("page");
  const exportHref = `/staff/employees/export.csv${exportQs.toString() ? `?${exportQs}` : ""}`;
  const body = html`${pageHead("Employees", linkButton("Export CSV", exportHref, "ghost", "sm"), "Delivery")}
<div class="kpis grid grid-4">${kpi("Active staff", active.length)}${kpi("MFA enrolled", `${mfa}/${active.length}`, "Required for every staff sign-in", active.length ? (mfa / active.length) * 100 : 0)}${kpi("Disabled", all.length - active.length)}${kpi("Pending invitations", invites.length)}</div>
<div class="kpis grid grid-4">${kpi("Overdue tasks (team)", teamOverdue, "Assigned tasks past their due date")}${kpi("Open tasks without an assignee", unassignedTasks, "On active projects")}${kpi("Open tasks (team)", active.reduce((n, s) => n + s.w.openTasks, 0))}${kpi("Logged (7 days, team)", wl.hours(active.reduce((n, s) => n + s.w.loggedLast7Minutes, 0)))}</div>
${alert("info", html`The <strong>Owner</strong> role is never granted, changed or removed here, and the Owner account cannot be disabled. Role changes and disabling sign the person out everywhere. Every change is written to the audit log. Workload counts come from live assignments, tasks, leads, tickets and time entries; utilisation is logged time in the last 7 days ÷ the weekly capacity set on each person's page.`)}
<section class="section--tight"><h2>Staff</h2>
${filterForm(ctx, [
  input({ name: "q", label: "Name or email", value: fq }),
  select({ name: "role", label: "Role", options: [{ value: "owner", label: "Owner" }, ...roleOpts], value: frole, includeBlank: "Any role" }),
  select({ name: "status", label: "Status", options: [{ value: "active", label: "Active" }, { value: "disabled", label: "Disabled" }], value: fstatus, includeBlank: "Any" }),
])}
${table(staff, [
  { header: "Name", cell: (s) => html`<a href="/staff/employees/${s.id}">${s.display_name}</a><br><span class="faint">${s.email}${s.w.jobTitle ? ` · ${s.w.jobTitle}` : ""}</span>` },
  { header: "Role", cell: (s) => badge(s.role === "owner" ? "requires_founder_approval" : "", label(s.role)) },
  { header: "Status", cell: (s) => s.disabled_at ? badge("blocked", "Disabled") : s.locked_until && s.locked_until > nowIso() ? badge("paused", "Locked") : badge("active", "Active") },
  { header: "MFA", cell: (s) => s.mfa ? badge("verified", "Enrolled") : badge("failing", "Not enrolled") },
  { header: "Last sign-in", cell: (s) => formatDateTime(s.last_sign_in) },
  { header: "Workload", cell: (s) => html`${s.w.openTasks} task${s.w.openTasks === 1 ? "" : "s"}${s.w.overdueTasks ? html` ${badge("past_due", `${s.w.overdueTasks} overdue`)}` : ""}<br><span class="faint">${s.w.activeProjects} projects · ${s.w.openLeads} leads · ${s.w.openTickets} tickets</span>` },
  { header: "Open estimate", cell: (s) => html`${wl.hours(s.w.openEstimateMinutes)}${s.w.unestimatedTasks ? html`<br><span class="faint">+${s.w.unestimatedTasks} unestimated</span>` : ""}`, numeric: true },
  { header: "Logged 7 d / capacity", cell: (s) => html`${wl.hours(s.w.loggedLast7Minutes)} / ${s.w.weeklyCapacityMinutes === null ? "not set" : wl.hours(s.w.weeklyCapacityMinutes)}<br><span class="faint">${wl.utilisationText(s.w)}</span>` },
  { header: "Manage", cell: (s) => {
    if (s.role === "owner") return html`<span class="faint">Owner — protected</span>`;
    if (s.id === ctx.user!.id) return html`<span class="faint">Your account</span>`;
    return html`<form method="post" action="/staff/employees/${s.id}/role" class="row">${csrf(ctx)}<label class="visually-hidden" for="role-${s.id}">Role for ${s.display_name}</label><select class="select" id="role-${s.id}" name="role">${roleOpts.map((o) => html`<option value="${o.value}"${o.value === s.role ? html` selected` : ""}>${o.label}</option>`)}</select>${button("Change role", { variant: "secondary", size: "sm" })}</form>
${s.disabled_at
  ? actionForm(ctx, `/staff/employees/${s.id}/enable`, "Enable account", { variant: "secondary" })
  : html`<form method="post" action="/staff/employees/${s.id}/disable" class="row" data-confirm="Disable this account and sign them out everywhere?">${csrf(ctx)}<label class="visually-hidden" for="reason-${s.id}">Reason</label><input class="input" id="reason-${s.id}" name="reason" placeholder="Reason" maxlength="300" required>
<label class="visually-hidden" for="offb-${s.id}">Their open work</label><select class="select" id="offb-${s.id}" name="offboarding"><option value="queue">Queue their work for reassignment</option><option value="end">End their assignments now</option></select>${button("Disable", { variant: "danger", size: "sm" })}</form>`}
${s.mfa ? actionForm(ctx, `/staff/employees/${s.id}/mfa-reset`, "Reset 2FA", { variant: "ghost", confirm: "Reset this person's two-factor authentication? Their authenticator and recovery codes stop working, they are signed out everywhere, and they must set up a new authenticator at next sign-in." }) : ""}`;
  } },
], { empty: emptyState(fq || frole || fstatus ? "No staff match" : "No staff yet", fq || frole || fstatus ? "Adjust the filters." : "Invite your first team member below.") })}</section>
<div class="grid grid-2">
<section class="card"><h2 class="card__title">Invite a staff member</h2>${formErrors(errors)}
<form method="post" action="/staff/employees/invite">${csrf(ctx)}
${input({ name: "email", label: "Work email", type: "email", value: v.email, required: true, autocomplete: "off" })}
${select({ name: "role", label: "Role", options: roleOpts, value: v.role ?? "support" })}
<p class="hint">The invitation link expires in 7 days. The person chooses a password and must enrol two-factor authentication on first sign-in.</p>
<div class="form-actions">${button("Send invitation")}</div></form></section>
<section class="card"><h2 class="card__title">Pending invitations</h2>
${table(invites, [
  { header: "Email", cell: (i) => i.email },
  { header: "Role", cell: (i) => label(i.role_id) },
  { header: "Expires", cell: (i) => formatDateTime(i.expires_at) },
  { header: "", cell: (i) => actionForm(ctx, `/staff/employees/invitations/${i.id}/revoke`, "Revoke", { variant: "ghost", confirm: "Revoke this invitation?" }) },
], { empty: emptyState("No pending invitations", "Invitations you send appear here until accepted or expired.") })}</section></div>`;
  return staffPage(ctx, "Employees", body, errors.length ? 422 : 200);
}

function filterStaff<T extends { display_name: string; email: string; role: string; disabled_at: string | null }>(all: T[], fq: string, frole: string, fstatus: string): T[] {
  return all.filter((s) => (!fq || `${s.display_name} ${s.email}`.toLowerCase().includes(fq.toLowerCase()))
    && (!frole || s.role === frole) && (!fstatus || (fstatus === "disabled" ? !!s.disabled_at : !s.disabled_at)));
}

function actorOf(ctx: AppContext) { return { userId: ctx.user!.id, isOwner: isOwner(ctx.actor!) }; }

// ───────────── 2. Email operations (EMAIL-002, EMAIL-003) ─────────────
const EMAIL_STATUSES = ["queued", "sent", "delivered", "bounced", "failed", "suppressed"] as const;

/** Renders a template's Nth preview sample with the current Business settings identity (pending text where unset). */
function previewMail(ctx: AppContext, t: EmailTemplate, sample: number) {
  const def = TEMPLATES[t] as TemplateDef<EmailTemplate>;
  const data = def.samples[sample];
  if (data === undefined) return null;
  return renderTemplate(t, data as never, identityFrom(ctx.settings), def.category === "marketing" ? `${ctx.baseUrl}/unsubscribe/preview` : undefined);
}

// ───────────── 7. Backups ─────────────
const BACKUP_METHODS = ["d1_export", "d1_time_travel_bookmark", "r2_versioning", "r2_copy", "manual_other"] as const;
const ENVS = ["development", "staging", "production"] as const;

// ───────────── 8. Settings ─────────────
const SETTING_KEYS = ["business.legal_name", "business.address", "contact.email", "contact.phone", "support.staffed_hours",
  "backup.rpo_target_hours", "backup.rto_target_hours", "voice.phone_number", "crm.default_lead_owner"] as const;

/** Active staff who may own leads (CREST-GAP-005 default lead owner). */
async function leadOwnerOptions(ctx: AppContext) {
  return (await ctx.db.prepare(`SELECT DISTINCT u.id, u.display_name, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id IN ('owner','administrator','sales') AND u.disabled_at IS NULL ORDER BY u.display_name`)
    .all<{ id: string; display_name: string; email: string }>()).results;
}

/** Recovery targets from business settings; null when not set (never a built-in default). */
export function recoveryTargets(settings: Record<string, string>): { rpoHours: number | null; rtoHours: number | null } {
  const n = (k: string) => { const v = parseInt(settings[k] ?? "", 10); return Number.isInteger(v) && v > 0 ? v : null; };
  return { rpoHours: n("backup.rpo_target_hours"), rtoHours: n("backup.rto_target_hours") };
}

async function settingsPage(ctx: AppContext, errors: string[] = [], v?: Record<string, string>) {
  requireStaff(ctx, "settings.operational");
  const support = await ctx.db.prepare(`SELECT staffed_hours, first_response_target_hours, updated_at FROM support_settings WHERE id = 1`).first<{ staffed_hours: string; first_response_target_hours: number; updated_at: string }>();
  const meta = (await ctx.db.prepare(`SELECT b.key, b.updated_at, u.display_name FROM business_settings b LEFT JOIN users u ON u.id = b.updated_by`).all<{ key: string; updated_at: string; display_name: string | null }>()).results;
  const val = (k: string) => v?.[k] ?? ctx.settings[k] ?? "";
  const body = html`${pageHead("Business settings", undefined, "Platform")}
${alert("info", html`Package and maintenance <strong>pricing is not editable here</strong>. Prices live in the server-side catalog and change only with Founder approval (CAT-007). Changes below are audited and appear on public pages immediately.`)}
${formErrors(errors)}
<form method="post" action="/staff/settings" class="card stack">${csrf(ctx)}
<h2 class="card__title">Company identity</h2>
${input({ name: "business.legal_name", id: "f-legal", label: "Legal business name", value: val("business.legal_name"), maxlength: 160, hint: "Leave blank until the legal entity is formed (BLK-006). Never enter a name that is not registered." })}
<div class="alert alert--warn" role="note" data-testid="residential-warning"><strong>Registered business address only.</strong> Never enter a home or residential address — it is displayed publicly on the business-disclosures page and in email footers. Use a registered office, commercial mailbox or registered-agent address.</div>
${textarea({ name: "business.address", id: "f-address", label: "Registered business mailing address", value: val("business.address"), rows: 3, maxlength: 300 })}
${checkbox("address_confirm", "I confirm this is a registered business address and not a residence.", { checked: !!v?.address_confirm })}
<h2 class="card__title">Contact</h2>
<div class="grid grid-2">${input({ name: "contact.email", id: "f-cemail", label: "Public contact email", type: "email", value: val("contact.email"), maxlength: 254 })}
${input({ name: "contact.phone", id: "f-cphone", label: "Public phone", value: val("contact.phone"), maxlength: 40, hint: "Business line only. No phone number has been purchased for the AI receptionist yet." })}</div>
<h2 class="card__title">Recovery targets</h2>
<p class="hint">Used by the Backups page to judge restore drills. Leave blank until the Founder approves targets; nothing is assumed when blank.</p>
<div class="grid grid-2">${input({ name: "backup.rpo_target_hours", id: "f-rpo", label: "Recovery point objective (hours of data loss)", type: "number", min: 1, max: 720, value: val("backup.rpo_target_hours") })}
${input({ name: "backup.rto_target_hours", id: "f-rto", label: "Recovery time objective (hours to restore)", type: "number", min: 1, max: 720, value: val("backup.rto_target_hours") })}</div>
<h2 class="card__title">Sales</h2>
${select({ name: "crm.default_lead_owner", label: "Default owner for new web leads", options: (await leadOwnerOptions(ctx)).map((u) => ({ value: u.id, label: `${u.display_name} (${u.email})` })), value: val("crm.default_lead_owner"), includeBlank: "Unassigned (Owners and sales are notified)" })}
<h2 class="card__title">AI receptionist</h2>
${input({ name: "voice.phone_number", id: "f-voice", label: "Receptionist phone number (only once purchased)", value: val("voice.phone_number"), maxlength: 40, hint: "Record the number only after the Founder-approved provider has provisioned it. The AI receptionist page shows this value; blank means no number." })}
<h2 class="card__title">Support</h2>
<div class="grid grid-2">${input({ name: "staffed_hours", label: "Staffed support hours", value: v?.staffed_hours ?? support?.staffed_hours ?? ctx.settings["support.staffed_hours"] ?? "", maxlength: 160, required: true, hint: "Shown publicly. Do not claim 24/7 human coverage unless it is actually staffed (SUP-005)." })}
${input({ name: "first_response_target_hours", label: "First-response target (staffed hours)", type: "number", min: 1, max: 168, value: v?.first_response_target_hours ?? support?.first_response_target_hours ?? "", required: true })}</div>
<div class="form-actions">${button("Save settings")}</div></form>
<section class="card stack" data-testid="tax-settings-link"><h2 class="card__title">Tax</h2>${isOwner(ctx.actor!)
  ? html`<p class="muted">Sales tax registration, jurisdictions, rates and taxable products (LEGAL-005). Owner only.</p><p>${linkButton("Tax configuration", "/staff/settings/tax", "secondary", "sm")}</p>`
  : html`<p class="muted">Tax configuration is recorded by the Owner.</p>`}</section>
<section class="section--tight"><h2>Change history</h2>${table(meta, [
  { header: "Setting", cell: (m) => m.key },
  { header: "Last changed", cell: (m) => formatDateTime(m.updated_at) },
  { header: "By", cell: (m) => m.display_name ?? "—" },
], { empty: emptyState("No settings saved yet", "Values you save appear here; full history is in the audit log.") })}
<p><a href="/staff/audit?action=settings.">Full change history in the audit log</a></p></section>`;
  return staffPage(ctx, "Business settings", body, errors.length ? 422 : 200);
}

// ───────────── 10. Voice ─────────────
async function voiceConfigs(ctx: AppContext) {
  return (await ctx.db.prepare(`SELECT c.id, c.version, c.prompt_text, c.change_note, c.created_at, c.active, c.activated_at, u.display_name AS author FROM voice_agent_configs c JOIN users u ON u.id = c.created_by ORDER BY c.version DESC`)
    .all<{ id: string; version: number; prompt_text: string; change_note: string; created_at: string; active: number; activated_at: string | null; author: string }>()).results;
}

async function voicePage(ctx: AppContext, errors: string[] = [], draft?: { instructions: string; note: string }) {
  requireStaff(ctx, "voice.manage");
  const db = ctx.db;
  const env = ctx.env.ENVIRONMENT;
  const health = await integ.refreshIntegrationHealth({ db, env: ctx.env, storage: ctx.storage });
  const h = (id: string) => health.find((r) => r.integration === id && r.environment === env);
  const configs = await voiceConfigs(ctx);
  const activeCfg = configs.find((c) => c.active);
  const showTest = q(ctx, "test") === "1";
  const since30 = new Date(Date.now() - 30 * 86400e3).toISOString();
  const vol = await db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN is_test = 0 THEN 1 ELSE 0 END) AS real, SUM(CASE WHEN is_test = 1 THEN 1 ELSE 0 END) AS test,
      SUM(CASE WHEN lead_id IS NOT NULL AND is_test = 0 THEN 1 ELSE 0 END) AS with_lead, SUM(CASE WHEN escalated_at IS NOT NULL AND is_test = 0 THEN 1 ELSE 0 END) AS escalated,
      SUM(CASE WHEN (outcome = 'error' OR error IS NOT NULL) AND is_test = 0 THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN is_test = 0 AND cost_microusd IS NOT NULL THEN cost_microusd ELSE 0 END) AS cost_known, SUM(CASE WHEN is_test = 0 AND cost_microusd IS NULL THEN 1 ELSE 0 END) AS cost_unknown
    FROM calls WHERE started_at >= ?`).bind(since30).first<Record<string, number | null>>();
  const outcomes = (await db.prepare(`SELECT COALESCE(outcome,'in_progress') AS outcome, COUNT(*) AS n FROM calls WHERE is_test = 0 GROUP BY 1 ORDER BY n DESC`).all<{ outcome: string; n: number }>()).results;
  const conversion = (await db.prepare(`SELECT l.stage, COUNT(*) AS n FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.is_test = 0 GROUP BY l.stage ORDER BY n DESC`).all<{ stage: string; n: number }>()).results;
  const { page, limit, offset } = pageParam(ctx);
  const calls = (await db.prepare(`SELECT c.id, c.provider, c.provider_call_id, c.from_number, c.outcome, c.lead_id, c.recording_consent, c.cost_microusd, c.started_at, c.ended_at, c.is_test, c.error, c.escalated_at, c.agent_config_version, l.stage AS lead_stage
      FROM calls c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.is_test = ? ORDER BY c.started_at DESC LIMIT ? OFFSET ?`).bind(showTest ? 1 : 0, limit + 1, offset)
    .all<{ id: string; provider: string; provider_call_id: string; from_number: string | null; outcome: string | null; lead_id: string | null; recording_consent: number; cost_microusd: number | null; started_at: string; ended_at: string | null; is_test: number; error: string | null; escalated_at: string | null; agent_config_version: number | null; lead_stage: string | null }>()).results;
  const errorsList = (await db.prepare(`SELECT e.created_at, e.kind, e.detail, c.id AS call_id, c.is_test FROM voice_events e JOIN calls c ON c.id = e.call_id WHERE e.status = 'error' ORDER BY e.created_at DESC LIMIT 20`)
    .all<{ created_at: string; kind: string; detail: string | null; call_id: string; is_test: number }>()).results;
  const escalations = (await db.prepare(`SELECT id, provider_call_id, escalated_at, is_test FROM calls WHERE escalated_at IS NOT NULL ORDER BY escalated_at DESC LIMIT 20`).all<{ id: string; provider_call_id: string; escalated_at: string; is_test: number }>()).results;
  const n = (k: string) => Number(vol?.[k] ?? 0);
  const dev = env === "development";
  const budget = await voiceBudget(db);
  const sync = await latestPromptSync(db);
  const usd2 = (m: number) => `$${(m / 1e6).toFixed(2)}`;
  const syncBadge = !sync ? badge("not_configured", "Never synchronised")
    : sync.status === "in_sync" && sync.config_version !== (activeCfg?.version ?? null) ? badge("degraded", `Stale: last in sync for v${sync.config_version}`)
    : badge(sync.status === "in_sync" ? "verified" : sync.status === "not_configured" ? "not_configured" : "failing", label(sync.status));
  const costCards = html`<div class="grid grid-2" style="margin-top:1.5rem">
<section class="card" id="budget" data-testid="voice-budget"><h2 class="card__title">Monthly voice budget</h2>
<p>${budget.state === "not_set" ? badge("not_configured", "Not set") : badge(budget.state === "exhausted" ? "failing" : budget.state === "warning" ? "degraded" : "active", `${usd2(budget.spentMicro)} of ${usd2(budget.budgetMicro!)} used (${budget.month})`)}</p>
<p class="muted">${budget.state === "not_set" ? "Without a budget, Retell calls are answered in voicemail-only mode (take a message, no transfer, no booking) and no outbound call is dialled." : budget.state === "exhausted" ? "Budget reached: calls are answered in voicemail-only mode until the budget is raised or the month ends." : "Spend is the provider-reported cost of every call this month, test calls included."}${budget.unknownCostCalls ? ` ${budget.unknownCostCalls} ended calls have no cost reported yet (not counted as zero).` : ""} Also set a spending limit in the Retell dashboard.</p>
<form method="post" action="/staff/voice/budget" class="row">${csrf(ctx)}${input({ name: "monthly_budget_usd", label: "Monthly budget (USD, blank = off)", type: "number", min: 0, max: 100000, value: budget.budgetMicro ? String(budget.budgetMicro / 1e6) : "" })}<div class="field">${button("Save budget", { variant: "secondary", size: "sm" })}</div></form></section>
<section class="card" id="prompt-sync" data-testid="voice-prompt-sync"><h2 class="card__title">Retell prompt synchronisation</h2>
<p>${syncBadge}</p><p class="muted">${sync ? html`${label(sync.mode)} at ${formatDateTime(sync.created_at)}: ${sync.detail}` : "The active configuration has not been pushed to Retell from this environment."}</p>
<p class="faint">${ctx.env.RETELL_INBOUND_API_KEY ? "Activating a version pushes its full prompt (guardrails + instructions) to the Retell LLM behind this environment's agent and reads it back. Publishing an agent version stays a Retell dashboard action." : "Provider not configured: RETELL_INBOUND_API_KEY is not set in this environment (the receptionist workspace key), so nothing can be pushed to Retell."}</p>
<form method="post" action="/staff/voice/prompt-sync" class="row">${csrf(ctx)}${select({ name: "mode", label: "Action", options: [{ value: "check", label: "Check for drift (read only)" }, { value: "adopt", label: "Adopt the live Retell prompt as the active version (writes nothing to Retell)" }, { value: "push", label: "Push active version to Retell (refused if the prompt was edited in Retell)" }, { value: "push_overwrite", label: "Overwrite Retell with the active version (replaces a dashboard-edited prompt)" }] })}<div class="field">${button("Run", { variant: "secondary", size: "sm" })}</div></form></section></div>`;
  const body = html`${pageHead("AI receptionist", linkButton("Operations: hours, scheduling, outbound", "/staff/voice/operations", "ghost", "sm"), "AI")}
<div class="grid grid-3">
<section class="card"><h2 class="card__title">Provider</h2><p>${badge(h("voice")?.status ?? "not_configured")}</p><p class="muted">${h("voice")?.detail ?? ""}</p>
<p class="faint">Provider evaluation and recommendation awaiting Founder decision: <code>docs/voice/PROVIDER-EVALUATION.md</code> (BLK-009). Crestmont must use its own separate provider workspace; the other business's existing receptionist is never touched.</p></section>
<section class="card"><h2 class="card__title">Phone number</h2>${ctx.settings["voice.phone_number"]
  ? html`<p>${badge("configured_unverified", ctx.settings["voice.phone_number"])}</p><p class="muted">Recorded in Business settings. It is not verified as live until signed provider events arrive for real (non-test) calls.</p>`
  : html`<p>${badge("not_configured", "None recorded")}</p><p class="muted">No receptionist number is recorded in Business settings. Purchasing a number requires Founder approval of the provider recommendation and its cost; this platform never buys numbers.</p>`}</section>
<section class="card"><h2 class="card__title">Agent</h2>${activeCfg ? html`<p>${badge("active", `Configuration v${activeCfg.version} active`)}</p><p class="muted">Activated ${formatDateTime(activeCfg.activated_at)}. It is not live on any phone line until a provider and number exist.</p>` : html`<p>${badge("not_configured", "No active configuration")}</p><p class="muted">Create and activate a configuration version below.</p>`}</section>
</div>
${costCards}
<div class="kpis grid grid-4" style="margin-top:1.5rem">${kpi("Calls (30 days)", n("real"), `${n("test")} test calls excluded`)}${kpi("Calls with a CRM lead", n("with_lead"))}${kpi("Escalations", n("escalated"))}${kpi("Call errors", n("errors"))}</div>
<div class="kpis grid grid-4">${kpi("Usage cost (known, 30 days)", microUsd(n("cost_known")), n("cost_unknown") ? `${n("cost_unknown")} calls with unknown cost` : "All call costs known")}</div>
<div class="grid grid-2"><section class="card"><h2 class="card__title">Outcomes (all real calls)</h2>${outcomes.length ? barChart(outcomes.map((o) => ({ label: label(o.outcome), value: o.n, display: String(o.n) }))) : emptyState("No calls yet", "Calls appear once a provider sends signed events.")}</section>
<section class="card"><h2 class="card__title">Lead conversion from calls</h2>${conversion.length ? barChart(conversion.map((o) => ({ label: label(o.stage), value: o.n, display: String(o.n) }))) : emptyState("No call leads yet", "Leads created by the receptionist are tracked through the CRM pipeline.")}</section></div>
<section class="section--tight"><div class="row row--between"><h2>Call history</h2>${tabs([{ href: "/staff/voice", label: "Real calls", current: !showTest }, { href: "/staff/voice?test=1", label: "Test calls", current: showTest }])}</div>
${table(calls.slice(0, limit), [
  { header: "Started", cell: (c) => html`<a href="/staff/voice/calls/${c.id}">${formatDateTime(c.started_at)}</a>${c.is_test ? html` ${badge("in_progress", "Test")}` : ""}` },
  { header: "Caller", cell: (c) => c.from_number ?? "Unknown" },
  { header: "Outcome", cell: (c) => c.outcome ? badge(c.outcome === "error" ? "failed" : c.outcome === "escalated" ? "escalated" : "completed", label(c.outcome)) : badge("in_progress", "In progress") },
  { header: "Lead", cell: (c) => c.lead_id ? badge(c.lead_stage, label(c.lead_stage ?? "")) : "—" },
  { header: "Consent", cell: (c) => c.recording_consent ? "Recorded" : "No" },
  { header: "Config", cell: (c) => c.agent_config_version ? `v${c.agent_config_version}` : "—" },
  { header: "Cost", cell: (c) => microUsd(c.cost_microusd), numeric: true },
], { empty: emptyState(showTest ? "No test calls" : "No calls yet", showTest ? "Test events sent through the signed webhook appear here." : "No provider is connected yet (BLK-009); real calls will appear here.") })}
${pagination(ctx, page, calls.length > limit)}</section>
<div class="grid grid-2"><section class="card"><h2 class="card__title">Escalation events</h2>${table(escalations, [
  { header: "When", cell: (e) => html`<a href="/staff/voice/calls/${e.id}">${formatDateTime(e.escalated_at)}</a>${e.is_test ? html` ${badge("in_progress", "Test")}` : ""}` },
  { header: "Call", cell: (e) => e.provider_call_id },
], { empty: emptyState("No escalations", "Escalated calls notify the Owner and create a CRM task.") })}</section>
<section class="card"><h2 class="card__title">Call errors</h2>${table(errorsList, [
  { header: "When", cell: (e) => html`<a href="/staff/voice/calls/${e.call_id}">${formatDateTime(e.created_at)}</a>${e.is_test ? html` ${badge("in_progress", "Test")}` : ""}` },
  { header: "Event", cell: (e) => e.kind },
  { header: "Detail", cell: (e) => (e.detail ?? "").slice(0, 160) },
], { empty: emptyState("No errors", "Failed webhook events and function calls appear here.") })}</section></div>
<section class="section--tight" id="config"><h2>Agent configuration versions</h2>
<p class="muted">Every version starts with platform guardrails that cannot be edited: AI disclosure, published pricing only, no guarantees, no agreements, no refunds, no customer information, no project status. Prices other than published catalog prices are rejected.</p>
${table(configs, [
  { header: "Version", cell: (c) => html`v${c.version} ${c.active ? badge("active", "Active") : ""}` },
  { header: "Change", cell: (c) => c.change_note },
  { header: "Author", cell: (c) => c.author },
  { header: "Created", cell: (c) => formatDateTime(c.created_at) },
  { header: "", cell: (c) => html`${c.version > 1 ? html`<a class="btn btn--ghost btn--sm" href="/staff/voice/configs/diff?a=${c.version - 1}&b=${c.version}">Diff v${c.version - 1}→v${c.version}</a> ` : ""}${c.active ? "" : actionForm(ctx, `/staff/voice/configs/${c.version}/activate`, "Activate", { confirm: `Activate configuration v${c.version}?` })}` },
], { empty: emptyState("No configuration versions", "Create the first version below.") })}
<details class="card" style="margin-top:1rem"${errors.length ? html` open` : ""}><summary>Create a new version</summary>${formErrors(errors)}
<pre class="code-block">${voice.VOICE_GUARDRAILS}</pre>
<form method="post" action="/staff/voice/configs">${csrf(ctx)}
${textarea({ name: "instructions", label: "Instructions (appended after the guardrails)", rows: 10, maxlength: 8000, required: true, value: draft?.instructions ?? (configs[0] ? voice.instructionsOf(configs[0].prompt_text) : voice.defaultAgentPrompt()) })}
${input({ name: "note", label: "What changed", required: true, maxlength: 300, value: draft?.note })}
<div class="form-actions">${button("Save new version")}</div></form></details></section>
${dev ? html`<section class="card" style="margin-top:1.5rem"><h2 class="card__title">Send a signed test event (development only)</h2>
<p class="muted">Signs an event with VOICE_WEBHOOK_SECRET and processes it through the same webhook handler. The resulting call, lead and tasks are labelled <strong>test</strong>.${ctx.env.VOICE_WEBHOOK_SECRET ? "" : " VOICE_WEBHOOK_SECRET is not set, so the webhook fails closed and this tool cannot sign events."}</p>
<form method="post" action="/staff/voice/test-event" class="row">${csrf(ctx)}${select({ name: "scenario", label: "Scenario", options: [
  { value: "lead", label: "New-project caller → lead captured" }, { value: "pricing", label: "Pricing question → info only" },
  { value: "callback", label: "Callback request" }, { value: "escalate", label: "Escalation" },
] })}${button("Send test event", { variant: "secondary" })}</form></section>` : ""}`;
  return staffPage(ctx, "AI receptionist", body, errors.length ? 422 : 200);
}

function syncSentence(s: PromptSyncResult): string {
  switch (s.status) {
    case "in_sync": return `Retell prompt in sync: ${s.detail}`;
    case "drift": return `Retell prompt DRIFT detected: ${s.detail}`;
    case "failed": return `Retell prompt sync failed: ${s.detail}`;
    case "not_configured": return `Not pushed to Retell. ${s.detail}`;
  }
}

// ───────────── registration ─────────────
export function register(r: Router): void {
  // ── Employees ──
  r.get("/staff/employees", (ctx) => employeesPage(ctx));
  r.get("/staff/employees/export.csv", async (ctx) => {
    requireStaff(ctx, "employee.manage");
    const rows = filterStaff(await wl.teamWorkload(ctx.db, ctx.now()), q(ctx, "q"), q(ctx, "role"), q(ctx, "status"));
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "employee.exported", subjectType: "user", details: { count: rows.length } });
    const csv = toCsv(["user_id", "name", "email", "role", "job_title", "status", "mfa", "last_sign_in", "open_tasks", "overdue_tasks", "due_next_7_days", "blocked_tasks", "open_estimate_hours", "unestimated_tasks",
      "active_projects", "open_leads", "open_tickets", "logged_7d_hours", "logged_30d_hours", "weekly_capacity_hours", "utilisation_7d"],
      rows.map((s) => [s.id, s.display_name, s.email, s.role, s.w.jobTitle ?? "", s.disabled_at ? "disabled" : "active", s.mfa ? "yes" : "no", s.last_sign_in ?? "", s.w.openTasks, s.w.overdueTasks, s.w.dueNext7, s.w.blockedTasks,
        (s.w.openEstimateMinutes / 60).toFixed(2), s.w.unestimatedTasks, s.w.activeProjects, s.w.openLeads, s.w.openTickets, (s.w.loggedLast7Minutes / 60).toFixed(2), (s.w.loggedLast30Minutes / 60).toFixed(2),
        s.w.weeklyCapacityMinutes === null ? "" : (s.w.weeklyCapacityMinutes / 60).toFixed(2), s.w.utilisation === null ? "unknown" : s.w.utilisation.toFixed(3)]));
    return download(ctx, csv, `crestmont-employees-${nowIso().slice(0, 10)}.csv`, "text/csv; charset=utf-8");
  });
  const employeeDetail = async (ctx: AppContext, id: string, errors: string[] = [], status = 200) => {
    requireStaff(ctx, "employee.manage");
    const s = (await emp.listStaff(ctx.db)).find((x) => x.id === id);
    if (!s) throw new HttpError(404, "Staff member not found");
    const w = await wl.workloadFor(ctx.db, id, ctx.now());
    const today = ctx.now().toISOString().slice(0, 10);
    const tasks = (await ctx.db.prepare(`SELECT t.id, t.title, t.status, t.due_at, t.estimate_minutes, p.id AS project_id, p.name AS project_name FROM assignments a JOIN tasks t ON t.id = a.subject_id JOIN projects p ON p.id = t.project_id
        WHERE a.subject_type = 'task' AND a.user_id = ? AND a.ended_at IS NULL AND t.status <> 'done' ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at LIMIT 200`).bind(id)
      .all<{ id: string; title: string; status: string; due_at: string | null; estimate_minutes: number | null; project_id: string; project_name: string }>()).results;
    const projects = (await ctx.db.prepare(`SELECT p.id, p.name, p.status, CASE WHEN p.project_manager_id = ?1 THEN 'Project manager' ELSE 'Assigned' END AS role FROM projects p WHERE p.status NOT IN ('completed','maintenance','cancelled') AND (p.project_manager_id = ?1
        OR EXISTS (SELECT 1 FROM assignments a WHERE a.subject_type = 'project' AND a.subject_id = p.id AND a.user_id = ?1 AND a.ended_at IS NULL)
        OR EXISTS (SELECT 1 FROM assignments a JOIN tasks tt ON tt.id = a.subject_id WHERE a.subject_type = 'task' AND tt.project_id = p.id AND a.user_id = ?1 AND a.ended_at IS NULL AND tt.status <> 'done')) ORDER BY p.updated_at DESC`).bind(id)
      .all<{ id: string; name: string; status: string; role: string }>()).results;
    const leads = (await ctx.db.prepare(`SELECT l.id, l.stage, c.name FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.owner_user_id = ? AND l.merged_into_lead_id IS NULL AND l.stage NOT IN ('converted','lost','rejected','archived') ORDER BY l.updated_at DESC LIMIT 100`).bind(id).all<{ id: string; stage: string; name: string }>()).results;
    const tickets = (await ctx.db.prepare(`SELECT t.id, t.subject, t.priority, t.status FROM assignments a JOIN tickets t ON t.id = a.subject_id WHERE a.subject_type = 'ticket' AND a.user_id = ? AND a.ended_at IS NULL AND t.status NOT IN ('resolved','closed') ORDER BY t.updated_at DESC LIMIT 100`).bind(id).all<{ id: string; subject: string; priority: string; status: string }>()).results;
    const time = (await ctx.db.prepare(`SELECT te.worked_on, te.minutes, t.id AS task_id, t.title FROM time_entries te JOIN tasks t ON t.id = te.task_id WHERE te.user_id = ? ORDER BY te.worked_on DESC LIMIT 20`).bind(id).all<{ worked_on: string; minutes: number; task_id: string; title: string }>()).results;
    const activity = (await ctx.db.prepare(`SELECT action, subject_type, subject_id, created_at FROM audit_logs WHERE actor_user_id = ? ORDER BY id DESC LIMIT 20`).bind(id).all<{ action: string; subject_type: string; subject_id: string | null; created_at: string }>()).results;
    const offPending = await off.pendingCount(ctx.db, id);
    const body = html`${pageHead(s.display_name, linkButton("All employees", "/staff/employees", "ghost", "sm"), `${label(s.role)}${w.jobTitle ? ` · ${w.jobTitle}` : ""}`)}
${formErrors(errors)}
<div class="kpis grid grid-4">${kpi("Open tasks", w.openTasks, w.overdueTasks ? `${w.overdueTasks} overdue` : "None overdue")}${kpi("Due in 7 days", w.dueNext7)}${kpi("Waiting on dependencies", w.blockedTasks)}${kpi("Open estimate", wl.hours(w.openEstimateMinutes), w.unestimatedTasks ? `${w.unestimatedTasks} task(s) not estimated` : "All open tasks estimated")}</div>
<div class="kpis grid grid-4">${kpi("Active projects", w.activeProjects)}${kpi("Open leads", w.openLeads)}${kpi("Open tickets", w.openTickets)}${kpi("Logged last 7 days", wl.hours(w.loggedLast7Minutes), `Utilisation: ${wl.utilisationText(w)}`, w.utilisation === null ? undefined : Math.min(100, w.utilisation * 100))}</div>
<div class="grid grid-2"><section class="card"><h2 class="card__title">Profile &amp; capacity</h2>${dl([["Email", s.email], ["Status", s.disabled_at ? "Disabled" : "Active"], ["Two-factor", s.mfa ? "Enrolled" : "Not enrolled"], ["Last sign-in", formatDateTime(s.last_sign_in)], ["Logged last 30 days", wl.hours(w.loggedLast30Minutes)]])}
<form method="post" action="/staff/employees/${s.id}/profile">${csrf(ctx)}${input({ name: "job_title", label: "Job title", value: w.jobTitle, maxlength: 120 })}
${input({ name: "weekly_capacity_hours", label: "Weekly capacity (hours)", type: "number", min: 0, max: 100, step: "0.25", value: w.weeklyCapacityMinutes === null ? "" : w.weeklyCapacityMinutes / 60, hint: "Blank = not set; utilisation then shows as Unknown." })}
<div class="form-actions">${button("Save profile", { variant: "secondary", size: "sm" })}</div></form></section>
<section class="card"><h2 class="card__title">Projects</h2>${table(projects, [{ header: "Project", cell: (p) => html`<a href="/staff/projects/${p.id}">${p.name}</a>` }, { header: "Role", cell: (p) => p.role }, { header: "Status", cell: (p) => badge(p.status) }], { empty: html`<p class="muted">No active projects.</p>` })}</section></div>
<section class="section--tight"><h2>Open tasks</h2>${table(tasks, [
  { header: "Task", cell: (t) => html`<a href="/staff/tasks/${t.id}">${t.title}</a><br><span class="faint">${t.project_name}</span>` }, { header: "Status", cell: (t) => badge(t.status) },
  { header: "Estimate", cell: (t) => (t.estimate_minutes === null ? "—" : wl.hours(t.estimate_minutes)), numeric: true },
  { header: "Due", cell: (t) => (t.due_at ? html`${t.due_at.slice(0, 10)}${t.due_at.slice(0, 10) < today ? html` ${badge("past_due", "Overdue")}` : ""}` : "—") },
], { empty: emptyState("No open tasks", "Tasks assigned to this person appear here.") })}</section>
<div class="grid grid-2"><section class="card"><h2 class="card__title">Leads</h2>${table(leads, [{ header: "Lead", cell: (l) => html`<a href="/staff/crm/leads/${l.id}">${l.name}</a>` }, { header: "Stage", cell: (l) => badge(l.stage) }], { empty: html`<p class="muted">No open leads.</p>` })}</section>
<section class="card"><h2 class="card__title">Tickets</h2>${table(tickets, [{ header: "Ticket", cell: (t) => html`<a href="/staff/support/${t.id}">${t.subject}</a>` }, { header: "Priority", cell: (t) => badge(t.priority) }, { header: "Status", cell: (t) => badge(t.status) }], { empty: html`<p class="muted">No open tickets.</p>` })}</section>
<section class="card"><h2 class="card__title">Recent time</h2>${table(time, [{ header: "Date", cell: (x) => x.worked_on }, { header: "Task", cell: (x) => html`<a href="/staff/tasks/${x.task_id}">${x.title}</a>` }, { header: "Time", cell: (x) => wl.hours(x.minutes), numeric: true }], { empty: html`<p class="muted">No time logged.</p>` })}</section>
<section class="card"><h2 class="card__title">Recent activity</h2>${table(activity, [{ header: "When", cell: (a) => formatDateTime(a.created_at) }, { header: "Action", cell: (a) => html`<code>${a.action}</code>` }, { header: "Subject", cell: (a) => `${a.subject_type}${a.subject_id ? ` ${a.subject_id}` : ""}` }], { empty: html`<p class="muted">No recorded activity.</p>` })}
<p><a href="/staff/audit?actor=${encodeURIComponent(s.email)}">Full history in the audit log</a></p></section></div>
<section class="card" style="margin-top:1.5rem"><h2 class="card__title">Offboarding</h2>${s.disabled_at ? html`<p>${offPending ? html`${badge("blocked", `${offPending} item${offPending === 1 ? "" : "s"} owner disabled`)} ` : ""}${offPending ? "Open work still needs a new owner." : "No work is waiting for reassignment."}</p>` : html`<p class="muted">When this account is disabled, its open work is queued for reassignment.</p>`}${linkButton(s.disabled_at ? "Open the reassignment queue" : "Preview open work", `/staff/employees/${s.id}/offboarding`, "secondary", "sm")}</section>`;
    return staffPage(ctx, s.display_name, body, status);
  };
  r.get("/staff/employees/:id", (ctx, p) => employeeDetail(ctx, p.id));
  r.post("/staff/employees/:id/profile", async (ctx, p) => {
    requireStaff(ctx, "employee.manage");
    const f = await ctx.form();
    try {
      await wl.saveProfile(ctx.db, ctx.user!.id, p.id, { jobTitle: str(f, "job_title"), weeklyCapacityHours: str(f, "weekly_capacity_hours") });
    } catch (e) {
      if (e instanceof wl.ProfileError) return employeeDetail(ctx, p.id, [e.message], 422);
      throw e;
    }
    return redirect(ctx, `/staff/employees/${p.id}`, { kind: "success", text: "Profile saved." });
  });
  r.post("/staff/employees/invite", async (ctx) => {
    requireStaff(ctx, "employee.manage");
    const f = await ctx.form();
    const v = { email: str(f, "email"), role: str(f, "role") };
    try {
      const inv = await emp.inviteStaff(ctx.db, ctx.user!.id, v.email, v.role);
      await sendMail(ctx, {
        template: "staff_invitation", to: inv.email, idempotencyKey: `staff-invite:${inv.token.slice(0, 16)}`,
        data: { inviterName: ctx.user!.displayName, roleLabel: label(inv.role), acceptUrl: `${ctx.baseUrl}/invite?token=${inv.token}` },
      });
      return redirect(ctx, "/staff/employees", { kind: "success", text: `Invitation sent to ${inv.email}.` });
    } catch (e) {
      if (e instanceof emp.EmployeeError || (e as Error).name === "AuthError") return employeesPage(ctx, [(e as Error).message], v);
      throw e;
    }
  });
  r.post("/staff/employees/invitations/:id/revoke", async (ctx, p) => {
    requireStaff(ctx, "employee.manage");
    try { await emp.revokeInvitation(ctx.db, ctx.user!.id, p.id); } catch (e) { if (e instanceof emp.EmployeeError) return redirect(ctx, "/staff/employees", { kind: "error", text: e.message }); throw e; }
    return redirect(ctx, "/staff/employees", { kind: "success", text: "Invitation revoked." });
  });
  // AUTH-002: administrator-initiated two-factor reset for a person who lost their authenticator (step-up required).
  r.post("/staff/employees/:id/mfa-reset", async (ctx, p) => {
    requireStaff(ctx, "employee.manage");
    try {
      const res = await emp.resetStaffMfa(ctx.db, actorOf(ctx), p.id, ctx.ip);
      await sendMail(ctx, { template: "security_notification", to: res.email, idempotencyKey: `mfa-reset:${p.id}:${Date.now()}`, data: { event: "mfa_reset" } });
      return redirect(ctx, "/staff/employees", { kind: "success", text: "Two-factor authentication was reset. They were signed out and will set up a new authenticator at next sign-in." });
    } catch (e) {
      if (e instanceof emp.EmployeeError) {
        if (e.status === 403) throw new HttpError(403, e.message);
        if (e.status === 404) throw new HttpError(404, e.message);
        return redirect(ctx, "/staff/employees", { kind: "error", text: e.message });
      }
      throw e;
    }
  });
  r.post("/staff/employees/:id/role", async (ctx, p) => {
    requireStaff(ctx, "employee.manage");
    try {
      const res = await emp.changeStaffRole(ctx.db, actorOf(ctx), p.id, str(await ctx.form(), "role"));
      return redirect(ctx, "/staff/employees", { kind: "success", text: res.from === res.to ? "Role unchanged." : `Role changed from ${label(res.from)} to ${label(res.to)}. They have been signed out.` });
    } catch (e) {
      if (e instanceof emp.EmployeeError) {
        if (e.status === 403) throw new HttpError(403, e.message);
        return redirect(ctx, "/staff/employees", { kind: "error", text: e.message });
      }
      throw e;
    }
  });
  for (const action of ["disable", "enable"] as const) {
    r.post(`/staff/employees/:id/${action}`, async (ctx, p) => {
      requireStaff(ctx, "employee.manage");
      try {
        const f = await ctx.form();
        const res = await emp.setStaffDisabled(ctx.db, actorOf(ctx), p.id, action === "disable", str(f, "reason"), str(f, "offboarding") === "end" ? "end" : "queue");
        if (action === "disable" && res.queued) return redirect(ctx, `/staff/employees/${p.id}/offboarding`, { kind: "success", text: `Account disabled and all sessions revoked. ${res.queued} open item${res.queued === 1 ? "" : "s"} of work need a new owner.` });
        return redirect(ctx, "/staff/employees", { kind: "success", text: action === "disable" ? `Account disabled and all sessions revoked.${res.ended ? ` ${res.ended} assignment${res.ended === 1 ? " was" : "s were"} ended and flagged "owner disabled".` : ""}` : `Account enabled.${res.restored ? ` ${res.restored} queued item${res.restored === 1 ? "" : "s"} returned to them.` : ""}` });
      } catch (e) {
        if (e instanceof emp.EmployeeError) {
          if (e.status === 403) throw new HttpError(403, e.message);
          return redirect(ctx, "/staff/employees", { kind: "error", text: e.message });
        }
        throw e;
      }
    });
  }

  // ── Offboarding queue (CREST-GAP-041) ──
  const offboardingPage = async (ctx: AppContext, id: string, errors: string[] = [], status = 200) => {
    requireStaff(ctx, "employee.manage");
    const s = (await emp.listStaff(ctx.db)).find((x) => x.id === id);
    if (!s) throw new HttpError(404, "Staff member not found");
    const items = await off.listItems(ctx.db, id);
    const pending = items.filter((i) => i.status === "pending");
    const live = s.disabled_at ? [] : await off.openWork(ctx.db, id);
    const people = await off.eligibleAssignees(ctx.db, id);
    const href = (i: { subject_type: off.OffboardingSubject; subject_id: string }) => i.subject_type === "task" ? `/staff/tasks/${i.subject_id}` : i.subject_type === "lead" ? `/staff/crm/leads/${i.subject_id}` : i.subject_type === "ticket" ? `/staff/support/${i.subject_id}` : `/staff/projects/${i.subject_id}`;
    const who = (i: off.OffboardingItem) => html`<label class="visually-hidden" for="to-${i.id}">New owner for ${i.label}</label><select class="select" id="to-${i.id}" name="to_user_id">${people.filter((u) => off.canTake(i.subject_type, u.role_id)).map((u) => html`<option value="${u.id}">${u.display_name} (${label(u.role_id)})</option>`)}</select>`;
    const body = html`${pageHead(`Offboarding: ${s.display_name}`, linkButton("Employee record", `/staff/employees/${s.id}`, "ghost", "sm"), s.disabled_at ? "Account disabled" : "Account active")}
${formErrors(errors)}
${s.disabled_at ? alert(pending.length ? "warn" : "success", pending.length ? html`<strong>${pending.length} item${pending.length === 1 ? "" : "s"} of work still belong to this disabled account</strong> and are flagged “owner disabled”. Reassign each one, or end the assignment so a coordinator picks it up.` : "Nothing is waiting: every piece of this person's work has a new owner or was ended.")
      : alert("info", html`This account is active. Its open work is listed below; when the account is disabled from the employee list, this work is queued here (or ended at once, if you choose that).`)}
${s.disabled_at && pending.length ? html`<section class="card"><h2 class="card__title">Everything at once</h2><form method="post" action="/staff/employees/${s.id}/offboarding" class="row">${csrf(ctx)}<input type="hidden" name="item" value="all">
<label class="visually-hidden" for="to-all">New owner</label><select class="select" id="to-all" name="to_user_id">${people.map((u) => html`<option value="${u.id}">${u.display_name} (${label(u.role_id)})</option>`)}</select>
${button("Reassign all", { name: "action", value: "reassign", variant: "secondary", size: "sm" })}${button("End all assignments", { name: "action", value: "end", variant: "danger", size: "sm" })}</form>
<p class="faint">Items the chosen person's role cannot take (for example a ticket for a developer) are skipped and stay in the queue.</p></section>` : ""}
${s.disabled_at ? table(items, [
      { header: "Work", cell: (i) => html`<a href="${href(i)}">${i.label}</a><br><span class="faint">${off.SUBJECT_LABELS[i.subject_type]}</span>` },
      { header: "Status", cell: (i) => i.status === "pending" ? badge("blocked", "Owner disabled") : i.status === "reassigned" ? badge("done", `Reassigned to ${i.resolved_to_name ?? "—"}`) : i.status === "ended" ? badge("paused", "Ended — owner disabled") : badge("active", "Returned on re-enable") },
      { header: "Since", cell: (i) => formatDateTime(i.created_at) },
      { header: "", cell: (i) => i.status !== "pending" ? (i.resolved_at ? html`<span class="faint">${formatDateTime(i.resolved_at)}</span>` : "") : html`<form method="post" action="/staff/employees/${s.id}/offboarding" class="row">${csrf(ctx)}<input type="hidden" name="item" value="${i.id}">${who(i)}${button("Reassign", { name: "action", value: "reassign", variant: "secondary", size: "sm" })}${button("End", { name: "action", value: "end", variant: "ghost", size: "sm" })}</form>` },
    ], { empty: emptyState("No offboarding items", "This person had no open assignments, projects, leads or tickets when the account was disabled."), caption: "Offboarding queue" })
    : table(live, [{ header: "Work", cell: (i) => html`<a href="${href(i)}">${i.label}</a>` }, { header: "Kind", cell: (i) => off.SUBJECT_LABELS[i.subject_type] }], { empty: emptyState("No open work", "No open task or project assignments, managed projects, leads or tickets."), caption: "Open work" })}`;
    return staffPage(ctx, `Offboarding: ${s.display_name}`, body, status);
  };
  r.get("/staff/employees/:id/offboarding", (ctx, p) => offboardingPage(ctx, p.id));
  r.post("/staff/employees/:id/offboarding", async (ctx, p) => {
    requireStaff(ctx, "employee.manage");
    const s = (await emp.listStaff(ctx.db)).find((x) => x.id === p.id);
    if (!s) throw new HttpError(404, "Staff member not found");
    if (!s.disabled_at) return offboardingPage(ctx, p.id, ["Work is reassigned here only after the account is disabled. Use the project, lead and ticket pages for an active person."], 409);
    const f = await ctx.form();
    const item = str(f, "item");
    const action = str(f, "action") === "end" ? "end" : "reassign";
    try {
      const res = await off.resolveItems(ctx.db, ctx.user!.id, p.id, item === "all" ? "all" : [item], action, str(f, "to_user_id") || null, ctx.ip);
      return redirect(ctx, `/staff/employees/${p.id}/offboarding`, { kind: res.skipped.length ? "info" : "success", text: `${res.done} item${res.done === 1 ? "" : "s"} ${action === "end" ? "ended" : "reassigned"}.${res.skipped.length ? ` ${res.skipped.length} skipped because that person's role cannot take them.` : ""}` });
    } catch (e) {
      if (e instanceof off.OffboardingError) return offboardingPage(ctx, p.id, [e.message], e.status);
      throw e;
    }
  });

  // ── Email operations ──
  const emailQuery = (ctx: AppContext) => {
    const status = q(ctx, "status"), template = q(ctx, "template"), to = q(ctx, "to", 254), from = q(ctx, "from", 10), until = q(ctx, "until", 10);
    const where: string[] = [], binds: unknown[] = [];
    if ((EMAIL_STATUSES as readonly string[]).includes(status)) { where.push("d.status = ?"); binds.push(status); }
    if ((EMAIL_TEMPLATES as readonly string[]).includes(template)) { where.push("d.template = ?"); binds.push(template); }
    if (to) { where.push("d.to_email LIKE ?"); binds.push(`%${to.replace(/[%_]/g, "")}%`); }
    if (isDate(from)) { where.push("d.created_at >= ?"); binds.push(from); }
    if (isDate(until)) { where.push("d.created_at < ?"); binds.push(new Date(Date.parse(until) + 86400e3).toISOString().slice(0, 10)); }
    return { where, binds, v: { status, template, to, from, until } };
  };
  r.get("/staff/email/export.csv", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const { where, binds, v } = emailQuery(ctx);
    const rows = (await ctx.db.prepare(`SELECT d.id, d.template, d.to_email, d.status, d.attempts, d.last_error, d.created_at, d.updated_at, m.provider, m.subject FROM email_deliveries d LEFT JOIN email_messages m ON m.delivery_id = d.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.created_at DESC LIMIT 50000`).bind(...binds)
      .all<{ id: string; template: string; to_email: string; status: string; attempts: number; last_error: string | null; created_at: string; updated_at: string; provider: string | null; subject: string | null }>()).results;
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "email.log_exported", subjectType: "email_delivery", details: { count: rows.length, filters: v } });
    const csv = toCsv(["delivery_id", "created_at", "updated_at", "template", "to", "subject", "provider", "status", "attempts", "last_error"],
      rows.map((d) => [d.id, d.created_at, d.updated_at, d.template, d.to_email, d.subject ?? "", d.provider ?? "", d.provider === "dev-outbox" ? "dev_outbox_not_sent" : d.status, d.attempts, d.last_error ?? ""]));
    return download(ctx, csv, `crestmont-email-log-${nowIso().slice(0, 10)}.csv`, "text/csv; charset=utf-8");
  });
  r.get("/staff/email", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const { where, binds, v: ev } = emailQuery(ctx);
    const { status, template, to } = ev;
    const { page, limit, offset } = pageParam(ctx);
    const rows = (await ctx.db.prepare(`SELECT d.id, d.template, d.to_email, d.status, d.attempts, d.last_error, d.created_at, d.updated_at, m.provider, m.subject FROM email_deliveries d LEFT JOIN email_messages m ON m.delivery_id = d.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`).bind(...binds, limit + 1, offset)
      .all<{ id: string; template: string; to_email: string; status: string; attempts: number; last_error: string | null; created_at: string; updated_at: string; provider: string | null; subject: string | null }>()).results;
    const counts = (await ctx.db.prepare(`SELECT status, COUNT(*) AS n FROM email_deliveries GROUP BY status`).all<{ status: string; n: number }>()).results;
    const health = (await integ.refreshIntegrationHealth({ db: ctx.db, env: ctx.env, storage: ctx.storage })).find((h) => h.integration === "resend" && h.environment === ctx.env.ENVIRONMENT);
    const c = (s: string) => counts.find((x) => x.status === s)?.n ?? 0;
    const exportQs = new URLSearchParams(ctx.url.search); exportQs.delete("page");
    const body = html`${pageHead("Email operations", html`${linkButton("Export CSV", `/staff/email/export.csv${exportQs.toString() ? `?${exportQs}` : ""}`, "ghost", "sm")}${linkButton("Template catalogue", "/staff/email/templates", "secondary", "sm")}`, "Platform")}
<div class="grid grid-2"><section class="card"><h2 class="card__title">Delivery provider &amp; domain authentication</h2>
<p>${badge(health?.status ?? "not_configured")} <span class="muted">Adapter in use: <strong>${ctx.email.kind}</strong></span></p><p class="muted">${health?.detail ?? ""}</p>
${ctx.email.kind === "dev-outbox" ? html`<p class="faint">Development outbox: messages are rendered and stored here, never sent and never reported as delivered.</p>` : ""}
<p><a href="/staff/integrations">Verify on the integrations page</a></p></section>
<section class="card"><h2 class="card__title">Unsubscribe behaviour</h2><p class="muted">Every template is transactional (account, project, billing and security notices) except <strong>Sales info</strong>: the package, purchase-link, follow-up and onboarding emails a prospect asks for on an outbound AI sales call. That one is commercial, always carries a one-click unsubscribe link and the postal address, and the opt-out is honoured for every later sales email. No newsletter or bulk marketing is sent by this platform. Hard bounces and spam complaints reported by Resend delivery webhooks add the address to the <a href="/staff/email-suppressions">suppression list</a>; suppressed addresses are never mailed. The webhook is verified but not yet receiving events until Resend is configured (BLK-005).</p></section></div>
<div class="kpis grid grid-4">${kpi("Queued / outbox", c("queued"))}${kpi("Sent", c("sent"))}${kpi("Delivered", c("delivered"), "Requires Resend delivery webhooks")}${kpi("Failed or bounced", c("failed") + c("bounced"))}</div>
${filterForm(ctx, [
  select({ name: "status", label: "Status", options: [...EMAIL_STATUSES], value: status, includeBlank: "Any status" }),
  select({ name: "template", label: "Template", options: [...EMAIL_TEMPLATES], value: template, includeBlank: "Any template" }),
  input({ name: "to", label: "Recipient contains", value: to, maxlength: 254 }),
  input({ name: "from", label: "From", type: "date", value: ev.from }),
  input({ name: "until", label: "To", type: "date", value: ev.until }),
])}
${table(rows.slice(0, limit), [
  { header: "Created", cell: (d) => html`<a href="/staff/email/${d.id}">${formatDateTime(d.created_at)}</a>` },
  { header: "Template", cell: (d) => label(d.template) },
  { header: "To", cell: (d) => d.to_email },
  { header: "Subject", cell: (d) => d.subject ?? "—" },
  { header: "Provider", cell: (d) => d.provider ?? "—" },
  { header: "Status", cell: (d) => d.provider === "dev-outbox" ? badge("queued", "Dev outbox (not sent)") : badge(d.status) },
  { header: "Attempts", cell: (d) => d.attempts, numeric: true },
  { header: "Last error", cell: (d) => d.last_error ? d.last_error.slice(0, 100) : "—" },
], { empty: emptyState("No email deliveries", "Messages appear here as workflows send them.") })}
${pagination(ctx, page, rows.length > limit)}`;
    return staffPage(ctx, "Email operations", body);
  });
  r.get("/staff/email/templates", (ctx) => {
    requireStaff(ctx, "settings.operational");
    const required = new Set<string>(REQUIRED_WORKFLOWS);
    const covered = REQUIRED_WORKFLOWS.filter((w) => w in TEMPLATES).length;
    const body = html`${pageHead("Email template catalogue", linkButton("Delivery log", "/staff/email", "secondary", "sm"), "Email operations")}
${alert("warn", html`<strong>Preview only — copy awaiting Founder review.</strong> Each template is rendered with labelled sample data through the same registry and layout the platform uses for real mail. Nothing here is sent. The footer shows the business identity recorded in <a href="/staff/settings">Business settings</a>; anything not yet recorded shows as pending.`)}
<p class="muted" data-testid="template-coverage">${covered} of ${REQUIRED_WORKFLOWS.length} required workflows have a template; ${EMAIL_TEMPLATES.length} templates in total. HTML previews download as files (the page security policy does not allow embedding mail HTML).</p>
${EMAIL_TEMPLATES.map((t) => {
      const def = TEMPLATES[t] as TemplateDef<EmailTemplate>;
      return html`<section class="card stack" id="tpl-${t}" data-template="${t}"><h2 class="card__title">${label(t)} ${required.has(t) ? badge("active", "Required workflow") : badge("draft", "Additional")} ${badge(def.category === "transactional" ? "info" : "warn", def.category === "transactional" ? "Transactional — no unsubscribe link" : "Marketing — unsubscribe link")}</h2>
<p class="muted">${def.description} Audience: ${label(def.audience)}.</p>
${def.samples.map((_, i) => {
        const m = previewMail(ctx, t, i)!;
        return html`<details${i === 0 ? html` open` : ""}><summary><strong>Subject:</strong> ${m.subject}</summary><pre class="code-block">${m.text}</pre>
<a class="btn btn--ghost btn--sm" href="/staff/email/templates/${t}/html?sample=${i}">Download HTML preview</a></details>`;
      })}</section>`;
    })}`;
    return staffPage(ctx, "Email templates", body);
  });
  r.get("/staff/email/templates/:name/html", (ctx, p) => {
    requireStaff(ctx, "settings.operational");
    if (!(EMAIL_TEMPLATES as readonly string[]).includes(p.name)) throw new HttpError(404, "Unknown template");
    const n = Number(ctx.url.searchParams.get("sample") ?? "0");
    const m = Number.isInteger(n) && n >= 0 ? previewMail(ctx, p.name as EmailTemplate, n) : null;
    if (!m) throw new HttpError(404, "Unknown sample");
    return download(ctx, m.html, `preview-${p.name}-${n}.html`, "text/html; charset=utf-8");
  });
  r.get("/staff/email/:id", async (ctx, p) => {
    requireStaff(ctx, "settings.operational");
    const d = await ctx.db.prepare(`SELECT d.*, m.provider, m.subject, m.text_body FROM email_deliveries d LEFT JOIN email_messages m ON m.delivery_id = d.id WHERE d.id = ?`).bind(p.id)
      .first<{ id: string; template: string; to_email: string; status: string; attempts: number; last_error: string | null; provider_message_id: string | null; created_at: string; updated_at: string; provider: string | null; subject: string | null; text_body: string | null }>();
    if (!d) throw new HttpError(404, "Delivery not found");
    const canRetry = d.provider === "resend" && ["failed", "queued"].includes(d.status) && ctx.email instanceof ResendEmail;
    const body = html`${pageHead(d.subject ?? label(d.template), linkButton("Back to log", "/staff/email", "ghost", "sm"), "Email delivery")}
${dl([["Template", label(d.template)], ["To", d.to_email], ["Provider", d.provider ?? "—"], ["Status", d.provider === "dev-outbox" ? badge("queued", "Dev outbox (not sent)") : badge(d.status)], ["Attempts", d.attempts], ["Provider message id", d.provider_message_id], ["Last error", d.last_error], ["Created", formatDateTime(d.created_at)], ["Updated", formatDateTime(d.updated_at)]])}
${d.provider === "resend" && ["failed", "queued"].includes(d.status) ? (canRetry ? html`<p>${actionForm(ctx, `/staff/email/${d.id}/retry`, "Retry delivery", { variant: "primary" })}</p>` : alert("warn", "Retry is unavailable: Resend is not configured in this environment.")) : ""}
<section class="section--tight"><h2>Text body</h2>${d.text_body ? html`<pre class="code-block">${bodyForStaff(ctx, d.to_email, d.text_body)}</pre><p><a class="btn btn--ghost btn--sm" href="/staff/email/${d.id}/html">Download HTML version</a></p>` : emptyState("No stored content", "The rendered body was not stored for this delivery.")}</section>`;
    return staffPage(ctx, "Email delivery", body);
  });
  r.get("/staff/email/:id/html", async (ctx, p) => {
    requireStaff(ctx, "settings.operational");
    const m = await ctx.db.prepare(`SELECT m.html_body, d.to_email FROM email_messages m JOIN email_deliveries d ON d.id = m.delivery_id WHERE m.delivery_id = ?`).bind(p.id).first<{ html_body: string; to_email: string }>();
    if (!m) throw new HttpError(404, "No stored HTML for this delivery");
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "email.body_downloaded", subjectType: "email_delivery", subjectId: p.id });
    return download(ctx, bodyForStaff(ctx, m.to_email, m.html_body), `email-${p.id}.html`, "text/html; charset=utf-8");
  });
  r.post("/staff/email/:id/retry", async (ctx, p) => {
    requireStaff(ctx, "settings.operational");
    const row = await ctx.db.prepare(`SELECT d.id, d.status, d.template, d.to_email, d.idempotency_key, m.provider, m.subject, m.html_body, m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.id = ?`).bind(p.id)
      .first<{ id: string; status: string; template: string; to_email: string; idempotency_key: string; provider: string; subject: string; html_body: string; text_body: string }>();
    if (!row) throw new HttpError(404, "Delivery not found");
    if (row.provider !== "resend" || !(ctx.email instanceof ResendEmail)) return redirect(ctx, `/staff/email/${p.id}`, { kind: "error", text: "Resend is not configured in this environment; nothing was retried." });
    if (!["failed", "queued"].includes(row.status)) return redirect(ctx, `/staff/email/${p.id}`, { kind: "error", text: "Only failed or queued deliveries can be retried." });
    const res = await ctx.email.attempt(row.id, { to: row.to_email, subject: row.subject, html: row.html_body, text: row.text_body, template: row.template, idempotencyKey: row.idempotency_key });
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "email.retried", subjectType: "email_delivery", subjectId: row.id, details: { result: res.status } });
    return redirect(ctx, `/staff/email/${p.id}`, res.status === "sent" ? { kind: "success", text: "Delivery succeeded." } : { kind: "error", text: "Retry failed; see the last error." });
  });

  // ── Integrations ──
  r.get("/staff/integrations", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const rows = await integ.refreshIntegrationHealth({ db: ctx.db, env: ctx.env, storage: ctx.storage });
    const cell = (id: string, env: string) => rows.find((x) => x.integration === id && x.environment === env);
    const here = ctx.env.ENVIRONMENT;
    const body = html`${pageHead("Integrations", undefined, "Platform")}
<p class="muted">Status is computed from this environment's real configuration. <strong>Verified</strong> is recorded only after a successful read-only call to the provider. Other environments show their last recorded state (staging and production are not provisioned yet: BLK-003).</p>
<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Integration</th>${integ.ENVIRONMENTS.map((e) => html`<th scope="col">${label(e)}${e === here ? " (this)" : ""}</th>`)}<th scope="col">Detail (${here})</th><th scope="col"></th></tr></thead><tbody>
${integ.INTEGRATIONS.map((i) => {
      const cur = cell(i.id, here);
      return html`<tr><td><strong>${i.label}</strong>${i.blocker ? html`<br><span class="faint">${i.blocker}</span>` : ""}</td>
${integ.ENVIRONMENTS.map((e) => { const c = cell(i.id, e); return html`<td>${c ? html`${badge(c.status)}<br><span class="faint">${formatDateTime(c.checked_at)}</span>` : html`<span class="faint">No record</span>`}</td>`; })}
<td class="muted" style="max-width:28rem">${cur?.detail ?? "—"}</td>
<td>${actionForm(ctx, `/staff/integrations/${i.id}/verify`, "Run check", { variant: "secondary" })}</td></tr>`;
    })}</tbody></table></div>`;
    return staffPage(ctx, "Integrations", body);
  });
  r.post("/staff/integrations/:name/verify", async (ctx, p) => {
    requireStaff(ctx, "settings.operational");
    if (!integ.isIntegrationId(p.name)) throw new HttpError(404, "Unknown integration");
    try {
      const res = await integ.verifyIntegration({ db: ctx.db, env: ctx.env, storage: ctx.storage }, p.name, ctx.user!.id);
      return redirect(ctx, "/staff/integrations", { kind: res.status === "verified" ? "success" : "error", text: `${p.name}: ${label(res.status)} — ${res.detail}`.slice(0, 280) });
    } catch (e) {
      if (e instanceof integ.ProbeUnavailable) return redirect(ctx, "/staff/integrations", { kind: "info", text: e.message.slice(0, 280) });
      throw e;
    }
  });

  // ── Monitoring ──
  r.get("/staff/monitoring", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const checks = await mon.serviceChecks(ctx.db, ctx.storage);
    const s = await mon.monitoringSummary(ctx.db);
    const days = await mon.errorsByDay(ctx.db, 7);
    const errs = (await ctx.db.prepare(`SELECT id, path, method, status, message, created_at FROM app_errors ORDER BY created_at DESC LIMIT 25`).all<{ id: number; path: string; method: string | null; status: number; message: string; created_at: string }>()).results;
    const stripe = (await ctx.db.prepare(`SELECT id, type, status, attempts, last_error, received_at FROM stripe_events WHERE status IN ('failed','dead_letter') ORDER BY received_at DESC LIMIT 20`).all<{ id: string; type: string; status: string; attempts: number; last_error: string | null; received_at: string }>()).results;
    const failedMail = (await ctx.db.prepare(`SELECT id, template, to_email, last_error, updated_at FROM email_deliveries WHERE status IN ('failed','bounced') ORDER BY updated_at DESC LIMIT 10`).all<{ id: string; template: string; to_email: string; last_error: string | null; updated_at: string }>()).results;
    const failedAi = (await ctx.db.prepare(`SELECT id, workflow, error, updated_at FROM ai_jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 10`).all<{ id: string; workflow: string; error: string | null; updated_at: string }>()).results;
    const body = html`${pageHead("Monitoring", undefined, "Platform")}
${alert("info", html`<strong>Alerting: email to the Owners, no paging.</strong> Every 15 minutes the scheduled <code>ops_alerts</code> job emails the Owners once per item for dead-lettered Stripe events, new reconciliation findings, a stuck email queue, failing evidence feeds and repeated security events. Outages are caught from outside Cloudflare by the GitHub health monitors (<code>staging-health-monitor.yml</code>, <code>production-health-monitor.yml</code>). Nobody is texted or paged; check this page and the runbook (<code>docs/RUNBOOK.md</code>) during staffed hours.`)}
<section><h2>Service health</h2>${table(checks, [
  { header: "Service", cell: (c) => c.name },
  { header: "Status", cell: (c) => badge(c.status === "healthy" ? "healthy" : c.status === "failing" ? "failing" : c.status === "stale" ? "stale" : "not_configured", label(c.status)) },
  { header: "Detail", cell: (c) => c.detail },
])}</section>
<div class="kpis grid grid-4">${kpi("5xx errors (24 h)", s.errors24h)}${kpi("5xx errors (7 days)", s.errors7d)}${kpi("Failed / bounced email", s.emailFailed, s.emailQueuedStuck ? `${s.emailQueuedStuck} Resend messages queued > 1 h` : undefined)}${kpi("Stripe events failed / dead-letter", `${s.stripeFailed} / ${s.stripeDeadLetter}`)}</div>
<div class="kpis grid grid-4">${kpi("Failed AI jobs", s.aiFailed)}${kpi("Voice call errors (7 days)", s.voiceErrors7d)}</div>
<section class="card"><h2 class="card__title">5xx errors per day</h2>${barChart(days.map((d) => ({ label: formatDate(d.day + "T12:00:00Z"), value: d.count, display: String(d.count) })))}</section>
<section class="section--tight"><h2>Recent errors</h2>${table(errs, [
  { header: "When", cell: (e) => formatDateTime(e.created_at) },
  { header: "Request", cell: (e) => `${e.method ?? ""} ${e.path}` },
  { header: "Status", cell: (e) => e.status, numeric: true },
  { header: "Message", cell: (e) => e.message.slice(0, 200) },
], { empty: emptyState("No errors recorded", "Unhandled server errors are recorded here by the request pipeline.") })}</section>
<div class="grid grid-2"><section class="card"><h2 class="card__title">Stripe events needing attention</h2>${table(stripe, [
  { header: "Event", cell: (e) => html`${e.type}<br><span class="faint">${e.id}</span>` },
  { header: "Status", cell: (e) => badge(e.status) },
  { header: "Attempts", cell: (e) => e.attempts, numeric: true },
  { header: "Error", cell: (e) => (e.last_error ?? "—").slice(0, 120) },
], { empty: emptyState("None", "No failed or dead-lettered Stripe events.") })}<p class="faint">Dead-letter handling: see docs/RUNBOOK.md.</p></section>
<section class="card"><h2 class="card__title">Failed email</h2>${table(failedMail, [
  { header: "When", cell: (m) => html`<a href="/staff/email/${m.id}">${formatDateTime(m.updated_at)}</a>` },
  { header: "Template", cell: (m) => label(m.template) },
  { header: "Error", cell: (m) => (m.last_error ?? "—").slice(0, 120) },
], { empty: emptyState("None", "No failed or bounced deliveries.") })}</section>
<section class="card"><h2 class="card__title">Failed AI jobs</h2>${table(failedAi, [
  { header: "When", cell: (j) => html`<a href="/staff/ai/${j.id}">${formatDateTime(j.updated_at)}</a>` },
  { header: "Workflow", cell: (j) => label(j.workflow) },
  { header: "Error", cell: (j) => (j.error ?? "—").slice(0, 120) },
], { empty: emptyState("None", "No failed AI jobs.") })}</section></div>`;
    return staffPage(ctx, "Monitoring", body);
  });

  // ── Security ──
  r.get("/staff/security", async (ctx) => {
    requireStaff(ctx, "audit.read");
    const now = nowIso();
    const kind = q(ctx, "kind", 60), email = q(ctx, "email", 254), from = q(ctx, "from", 10), to = q(ctx, "to", 10);
    const where: string[] = [], binds: unknown[] = [];
    if (kind) { where.push("kind = ?"); binds.push(kind); }
    if (email) { where.push("email LIKE ?"); binds.push(`%${email.replace(/[%_]/g, "")}%`); }
    if (isDate(from)) { where.push("created_at >= ?"); binds.push(from); }
    if (isDate(to)) { where.push("created_at < ?"); binds.push(new Date(Date.parse(to) + 86400e3).toISOString().slice(0, 10)); }
    const { page, limit, offset } = pageParam(ctx);
    const events = (await ctx.db.prepare(`SELECT id, kind, user_id, email, ip, detail, created_at FROM security_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...binds, limit + 1, offset)
      .all<{ id: number; kind: string; user_id: string | null; email: string | null; ip: string | null; detail: string | null; created_at: string }>()).results;
    const kinds = (await ctx.db.prepare(`SELECT DISTINCT kind FROM security_events ORDER BY kind`).all<{ kind: string }>()).results.map((k) => k.kind);
    const staff = await emp.listStaff(ctx.db);
    const activeStaff = staff.filter((s) => !s.disabled_at);
    const mfa = activeStaff.filter((s) => s.mfa).length;
    const sessions = (await ctx.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?`).bind(now).first<{ n: number }>())?.n ?? 0;
    const locked = (await ctx.db.prepare(`SELECT id, email, locked_until, failed_logins FROM users WHERE locked_until IS NOT NULL AND locked_until > ? ORDER BY locked_until DESC`).bind(now).all<{ id: string; email: string; locked_until: string; failed_logins: number }>()).results;
    const findings = (await ctx.db.prepare(`SELECT id, title, severity, release_blocking, source, status, opened_at FROM security_findings WHERE status = 'open' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, opened_at`)
      .all<{ id: string; title: string; severity: string; release_blocking: number; source: string; status: string; opened_at: string }>()).results;
    const privacy = await priv.listDeletionQueue(ctx.db);
    const canProcess = !!ctx.actor && can(ctx.actor, "employee.manage");
    const body = html`${pageHead("Security", linkButton("Audit logs", "/staff/audit", "secondary", "sm"), "Platform")}
<div class="kpis grid grid-4">${kpi("Staff MFA coverage", `${mfa}/${activeStaff.length}`, "Staff cannot use staff pages without MFA", activeStaff.length ? (mfa / activeStaff.length) * 100 : 0)}${kpi("Active sessions", sessions)}${kpi("Locked accounts", locked.length)}${kpi("Open security findings", findings.length, `${findings.filter((f) => f.release_blocking).length} release-blocking`)}</div>
<div class="grid grid-2">
<section class="card"><h2 class="card__title">Dependencies</h2><p>${badge("active", "0 runtime dependencies")}</p><p class="muted">The platform has zero runtime npm dependencies (package.json declares none); it uses Web APIs and Node/Workers built-ins only. Development tooling (TypeScript, @types/node) is installed in CI only. Automated dependency and code scanning (npm audit, CodeQL) runs in CI, which is currently blocked (BLK-013).</p></section>
<section class="card"><h2 class="card__title">Secrets (${label(ctx.env.ENVIRONMENT)})</h2><p class="faint">Names only. Values are never displayed or logged.</p>
${table(integ.secretPresence(ctx.env), [{ header: "Secret", cell: (s) => html`<code>${s.name}</code>` }, { header: "Status", cell: (s) => yesNo(s.present) }])}</section></div>
<section class="section--tight"><h2>Open security findings</h2>${table(findings, [
  { header: "Finding", cell: (f) => f.title },
  { header: "Severity", cell: (f) => badge(f.severity === "critical" || f.severity === "high" ? "failing" : f.severity === "medium" ? "warn" : "", label(f.severity)) },
  { header: "Release-blocking", cell: (f) => (f.release_blocking ? "Yes" : "No") },
  { header: "Source", cell: (f) => f.source },
  { header: "Opened", cell: (f) => formatDate(f.opened_at) },
], { empty: emptyState("No open findings recorded", "Findings from reviews (docs/security/ASVS-REVIEW.md) and scans are tracked in the readiness area.") })}</section>
${locked.length ? html`<section class="section--tight"><h2>Locked accounts</h2>${table(locked, [{ header: "Email", cell: (l) => l.email }, { header: "Locked until", cell: (l) => formatDateTime(l.locked_until) }, { header: "Failed sign-ins", cell: (l) => l.failed_logins, numeric: true }])}</section>` : ""}
<section class="section--tight" id="privacy"><h2>Privacy deletion requests</h2>
<p class="muted">Completing a request anonymises the account (name, email, password, MFA), removes memberships and notifications, anonymises linked CRM contacts and revokes every session. Orders, invoices, payments, refunds, agreement acceptances and audit logs are retained as legally required.</p>
${table(privacy, [
  { header: "Received", cell: (p) => formatDateTime(p.created_at) },
  { header: "Account", cell: (p) => html`${p.display_name}<br><span class="faint">${p.email}</span>` },
  { header: "Reason", cell: (p) => p.notes ?? "—" },
  { header: "Status", cell: (p) => badge(p.status) },
  { header: "", cell: (p) => ["received", "in_progress"].includes(p.status) && canProcess
    ? html`<form method="post" action="/staff/privacy/${p.id}/process" class="row">${csrf(ctx)}<label class="visually-hidden" for="pn-${p.id}">Notes</label><input class="input" id="pn-${p.id}" name="notes" placeholder="Notes" maxlength="1000">${button("Complete deletion", { variant: "danger", size: "sm", name: "decision", value: "complete" })}${button("Deny", { variant: "ghost", size: "sm", name: "decision", value: "deny" })}</form>`
    : p.processed_by_name ? `Processed by ${p.processed_by_name}` : "—" },
], { empty: emptyState("No deletion requests", "Requests made from /account/privacy appear here.") })}</section>
<section class="section--tight"><div class="row row--between"><h2>Security events</h2>${linkButton("Export CSV", `/staff/security/events.csv${(() => { const u = new URLSearchParams(ctx.url.search); u.delete("page"); return u.toString() ? `?${u}` : ""; })()}`, "ghost", "sm")}</div>
${filterForm(ctx, [
  select({ name: "kind", label: "Kind", options: kinds, value: kind, includeBlank: "Any" }),
  input({ name: "email", label: "Email contains", value: email }),
  input({ name: "from", label: "From", type: "date", value: from }),
  input({ name: "to", label: "To", type: "date", value: to }),
])}
${table(events.slice(0, limit), [
  { header: "When", cell: (e) => formatDateTime(e.created_at) },
  { header: "Kind", cell: (e) => label(e.kind) },
  { header: "Email", cell: (e) => e.email ?? "—" },
  { header: "IP", cell: (e) => e.ip ?? "—" },
  { header: "Detail", cell: (e) => e.detail ?? "—" },
], { empty: emptyState("No security events", "Failed sign-ins, lockouts, rate limits and MFA failures appear here.") })}
${pagination(ctx, page, events.length > limit)}</section>`;
    return staffPage(ctx, "Security", body);
  });
  r.get("/staff/security/events.csv", async (ctx) => {
    requireStaff(ctx, "audit.read");
    const kind = q(ctx, "kind", 60), email = q(ctx, "email", 254), from = q(ctx, "from", 10), to = q(ctx, "to", 10);
    const where: string[] = [], binds: unknown[] = [];
    if (kind) { where.push("kind = ?"); binds.push(kind); }
    if (email) { where.push("email LIKE ?"); binds.push(`%${email.replace(/[%_]/g, "")}%`); }
    if (isDate(from)) { where.push("created_at >= ?"); binds.push(from); }
    if (isDate(to)) { where.push("created_at < ?"); binds.push(new Date(Date.parse(to) + 86400e3).toISOString().slice(0, 10)); }
    const rows = (await ctx.db.prepare(`SELECT id, kind, user_id, email, ip, detail, created_at FROM security_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 50000`).bind(...binds)
      .all<{ id: number; kind: string; user_id: string | null; email: string | null; ip: string | null; detail: string | null; created_at: string }>()).results;
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "security.events_exported", subjectType: "security_events", details: { count: rows.length, filters: { kind, email, from, to } } });
    const csv = toCsv(["id", "created_at", "kind", "user_id", "email", "ip", "detail"], rows.map((e) => [e.id, e.created_at, e.kind, e.user_id ?? "", e.email ?? "", e.ip ?? "", e.detail ?? ""]));
    return download(ctx, csv, `crestmont-security-events-${nowIso().slice(0, 10)}.csv`, "text/csv; charset=utf-8");
  });
  r.post("/staff/privacy/:id/process", async (ctx, p) => {
    requireStaff(ctx, "employee.manage");
    const f = await ctx.form();
    const decision = str(f, "decision") === "deny" ? "deny" : str(f, "decision") === "complete" ? "complete" : null;
    if (!decision) throw new HttpError(400, "Choose complete or deny.");
    try {
      await priv.processDeletion(ctx.db, ctx.user!.id, p.id, decision, str(f, "notes"));
    } catch (e) {
      if (e instanceof priv.PrivacyError) return redirect(ctx, "/staff/security#privacy", { kind: "error", text: e.message });
      throw e;
    }
    return redirect(ctx, "/staff/security#privacy", { kind: "success", text: decision === "complete" ? "Deletion completed: account anonymised and sessions revoked." : "Request denied." });
  });

  // ── Audit logs ──
  const auditQuery = (ctx: AppContext) => {
    const actor = q(ctx, "actor", 254), action = q(ctx, "action", 120), subject = q(ctx, "subject", 120), from = q(ctx, "from", 10), to = q(ctx, "to", 10);
    const where: string[] = [], binds: unknown[] = [];
    if (actor) { where.push("(a.actor_user_id = ? OR u.email LIKE ? OR a.actor_kind = ?)"); binds.push(actor, `%${actor.replace(/[%_]/g, "")}%`, actor); }
    if (action) { where.push("a.action LIKE ?"); binds.push(`${action.replace(/[%_]/g, "")}%`); }
    if (subject) { where.push("(a.subject_type = ? OR a.subject_id = ?)"); binds.push(subject, subject); }
    if (isDate(from)) { where.push("a.created_at >= ?"); binds.push(from); }
    if (isDate(to)) { where.push("a.created_at < ?"); binds.push(new Date(Date.parse(to) + 86400e3).toISOString().slice(0, 10)); }
    return { sql: `FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`, binds, v: { actor, action, subject, from, to } };
  };
  type AuditRow = { id: number; created_at: string; actor_kind: string; actor_user_id: string | null; actor_email: string | null; actor_name: string | null; action: string; subject_type: string; subject_id: string | null; organization_id: string | null; ip: string | null; details_json: string | null };
  r.get("/staff/audit", async (ctx) => {
    requireStaff(ctx, "audit.read");
    const aq = auditQuery(ctx);
    const { page, limit, offset } = pageParam(ctx);
    const rows = (await ctx.db.prepare(`SELECT a.*, u.email AS actor_email, u.display_name AS actor_name ${aq.sql} ORDER BY a.id DESC LIMIT ? OFFSET ?`).bind(...aq.binds, limit + 1, offset).all<AuditRow>()).results;
    const exportUrl = "/staff/audit/export.csv" + (ctx.url.search ? ctx.url.search.replace(/([?&])page=\d+&?/, "$1") : "");
    const body = html`${pageHead("Audit logs", linkButton("Export CSV", exportUrl, "secondary", "sm"), "Platform")}
<p class="muted">Append-only: the database rejects updates and deletes on this table. Exports are themselves audited.</p>
${filterForm(ctx, [
  input({ name: "actor", label: "Actor (email, user id or kind)", value: aq.v.actor }),
  input({ name: "action", label: "Action starts with", value: aq.v.action }),
  input({ name: "subject", label: "Subject type or id", value: aq.v.subject }),
  input({ name: "from", label: "From", type: "date", value: aq.v.from }),
  input({ name: "to", label: "To", type: "date", value: aq.v.to }),
])}
${table(rows.slice(0, limit), [
  { header: "When", cell: (a) => formatDateTime(a.created_at) },
  { header: "Actor", cell: (a) => a.actor_email ? html`${a.actor_name}<br><span class="faint">${a.actor_email}</span>` : label(a.actor_kind) },
  { header: "Action", cell: (a) => html`<code>${a.action}</code>` },
  { header: "Subject", cell: (a) => html`${a.subject_type}<br><span class="faint">${a.subject_id ?? ""}</span>` },
  { header: "Details", cell: (a) => (a.details_json ?? "").slice(0, 160) },
  { header: "IP", cell: (a) => a.ip ?? "—" },
], { empty: emptyState("No audit entries match", "Adjust the filters.") })}
${pagination(ctx, page, rows.length > limit)}`;
    return staffPage(ctx, "Audit logs", body);
  });
  r.get("/staff/audit/export.csv", async (ctx) => {
    requireStaff(ctx, "audit.read");
    const aq = auditQuery(ctx);
    const rows = (await ctx.db.prepare(`SELECT a.*, u.email AS actor_email, u.display_name AS actor_name ${aq.sql} ORDER BY a.id DESC LIMIT 50000`).bind(...aq.binds).all<AuditRow>()).results;
    const header = ["id", "created_at", "actor_kind", "actor_user_id", "actor_email", "actor_name", "action", "subject_type", "subject_id", "organization_id", "ip", "details_json"];
    const csv = [header, ...rows.map((a) => header.map((h) => (a as unknown as Record<string, unknown>)[h]))].map((r2) => r2.map(csvCell).join(",")).join("\n") + "\n";
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "audit.exported", subjectType: "audit_logs", details: { filters: aq.v, rows: rows.length } });
    return download(ctx, csv, `crestmont-audit-${nowIso().slice(0, 10)}.csv`, "text/csv; charset=utf-8");
  });

  // ── Backups ──
  const backupsPage = async (ctx: AppContext, errors: string[] = []) => {
    requireStaff(ctx, "settings.operational");
    const backups = (await ctx.db.prepare(`SELECT b.*, r.display_name AS recorded_by_name, v.display_name AS verified_by_name FROM backup_records b JOIN users r ON r.id = b.recorded_by LEFT JOIN users v ON v.id = b.verified_by ORDER BY b.taken_at DESC LIMIT 100`)
      .all<{ id: string; what: string; location: string; environment: string; method: string; taken_at: string; size_bytes: number | null; sha256: string | null; result: string; evidence: string; recorded_by_name: string; verified_by_name: string | null }>()).results;
    const drills = (await ctx.db.prepare(`SELECT t.*, p.display_name AS performed_by_name, v.display_name AS verified_by_name FROM restore_tests t JOIN users p ON p.id = t.performed_by LEFT JOIN users v ON v.id = t.verified_by ORDER BY t.performed_at DESC LIMIT 100`)
      .all<{ id: string; what: string; target: string; environment: string; performed_at: string; result: string; duration_minutes: number | null; data_loss_minutes: number | null; evidence: string; performed_by_name: string; verified_by_name: string | null }>()).results;
    const staff = (await emp.listStaff(ctx.db)).filter((s) => !s.disabled_at).map((s) => ({ value: s.id, label: s.display_name }));
    const lastPass = drills.find((d) => d.result === "passed");
    const targets = recoveryTargets(ctx.settings);
    const judge = (observedMin: number | null, targetH: number | null, name: string) =>
      targetH === null ? `${name} target not set` : observedMin === null ? `${name} not measured in the last passed drill` : observedMin <= targetH * 60 ? `${name} ${observedMin} min within the ${targetH} h target` : `${name} ${observedMin} min EXCEEDS the ${targetH} h target`;
    const drillVerdict = !lastPass ? "No passed restore drill is recorded, so recovery against any target is unproven." :
      `Last passed drill (${formatDate(lastPass.performed_at)}): ${judge(lastPass.duration_minutes, targets.rtoHours, "restore time")}; ${judge(lastPass.data_loss_minutes, targets.rpoHours, "data-loss window")}.`;
    const body = html`${pageHead("Backups & recovery", undefined, "Platform")}
${alert("warn", html`<strong>No automated backups exist yet.</strong> Cloudflare D1 Time Travel and R2 object versioning are not provisioned because no Cloudflare account is connected (BLK-003). Until then, record every manual export and every restore drill here with evidence. Procedures: <code>docs/BACKUP-RECOVERY.md</code>.`)}
<div class="kpis grid grid-4">${kpi("Backups recorded", backups.length)}${kpi("Restore drills", drills.length)}${kpi("Last passed drill", lastPass ? formatDate(lastPass.performed_at) : "Never")}${kpi("Recovery targets", targets.rpoHours === null && targets.rtoHours === null ? "Not set" : `RPO ${targets.rpoHours ?? "—"} h · RTO ${targets.rtoHours ?? "—"} h`, "From Business settings")}</div>
<p class="muted">${drillVerdict}</p>
${formErrors(errors)}
<section class="section--tight"><h2>Backup register</h2>${table(backups, [
  { header: "Taken", cell: (b) => formatDateTime(b.taken_at) },
  { header: "What", cell: (b) => html`${b.what}<br><span class="faint">${label(b.method)} · ${label(b.environment)}</span>` },
  { header: "Where", cell: (b) => b.location },
  { header: "Size", cell: (b) => b.size_bytes === null ? "Unknown" : `${(b.size_bytes / 1024 / 1024).toFixed(2)} MB`, numeric: true },
  { header: "Result", cell: (b) => badge(b.result === "succeeded" ? "succeeded" : "failed", label(b.result)) },
  { header: "Verified by", cell: (b) => b.verified_by_name ?? "Not verified" },
  { header: "Evidence", cell: (b) => html`${b.evidence}${b.sha256 ? html`<br><span class="faint">sha256 ${b.sha256.slice(0, 16)}…</span>` : ""}` },
], { empty: emptyState("No backups recorded", "Record a manual export below (see docs/BACKUP-RECOVERY.md for the wrangler d1 export procedure).") })}
<details class="card"><summary>Record a backup</summary><form method="post" action="/staff/backups/records">${csrf(ctx)}
<div class="grid grid-2">${input({ name: "what", label: "What was backed up", required: true, maxlength: 200 })}${input({ name: "location", label: "Where it is stored", required: true, maxlength: 300 })}
${select({ name: "environment", label: "Environment", options: [...ENVS] })}${select({ name: "method", label: "Method", options: [...BACKUP_METHODS] })}
${input({ name: "taken_at", label: "Taken at", type: "datetime-local", required: true })}${select({ name: "result", label: "Result", options: ["succeeded", "partial", "failed"] })}
${input({ name: "size_bytes", label: "Size in bytes (blank = unknown)", type: "number", min: 0 })}${input({ name: "sha256", label: "SHA-256 of artefact (optional)", maxlength: 64 })}
${select({ name: "verified_by", label: "Verified by", options: staff, includeBlank: "Not verified" })}</div>
${textarea({ name: "evidence", label: "Evidence (command output, file listing, link)", required: true, rows: 3, maxlength: 4000 })}
<div class="form-actions">${button("Record backup")}</div></form></details></section>
<section class="section--tight"><h2>Restore drills</h2>${table(drills, [
  { header: "Performed", cell: (d) => formatDateTime(d.performed_at) },
  { header: "What", cell: (d) => html`${d.what}<br><span class="faint">→ ${d.target} (${label(d.environment)})</span>` },
  { header: "Result", cell: (d) => badge(d.result === "passed" ? "pass" : "fail", label(d.result)) },
  { header: "Observed RTO", cell: (d) => d.duration_minutes === null ? "Not measured" : `${d.duration_minutes} min`, numeric: true },
  { header: "Observed RPO", cell: (d) => d.data_loss_minutes === null ? "Not measured" : `${d.data_loss_minutes} min`, numeric: true },
  { header: "By / verified", cell: (d) => `${d.performed_by_name} / ${d.verified_by_name ?? "not verified"}` },
  { header: "Evidence", cell: (d) => d.evidence },
], { empty: emptyState("No restore drills recorded", "Backups are not proven until a restore has been tested.") })}
<details class="card"><summary>Record a restore drill</summary><form method="post" action="/staff/backups/restore-tests">${csrf(ctx)}
<div class="grid grid-2">${input({ name: "what", label: "What was restored", required: true, maxlength: 200 })}${input({ name: "target", label: "Restored to (never production for drills)", required: true, maxlength: 200 })}
${select({ name: "environment", label: "Environment of the target", options: [...ENVS] })}${select({ name: "backup_record_id", label: "From backup", options: backups.map((b) => ({ value: b.id, label: `${formatDate(b.taken_at)} — ${b.what}`.slice(0, 80) })), includeBlank: "Not linked" })}
${input({ name: "performed_at", label: "Performed at", type: "datetime-local", required: true })}${select({ name: "result", label: "Result", options: ["passed", "partial", "failed"] })}
${input({ name: "duration_minutes", label: "Time to restore, minutes (blank = not measured)", type: "number", min: 0 })}${input({ name: "data_loss_minutes", label: "Data-loss window, minutes (blank = not measured)", type: "number", min: 0 })}
${select({ name: "verified_by", label: "Verified by", options: staff, includeBlank: "Not verified" })}</div>
${textarea({ name: "evidence", label: "Evidence (row counts compared, checks run, output)", required: true, rows: 3, maxlength: 4000 })}
<div class="form-actions">${button("Record drill")}</div></form></details></section>`;
    return staffPage(ctx, "Backups", body, errors.length ? 422 : 200);
  };
  r.get("/staff/backups", (ctx) => backupsPage(ctx));
  const optInt = (s: string, errors: string[], name: string) => {
    if (!s) return null;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0) { errors.push(`${name} must be a whole number ≥ 0`); return null; }
    return n;
  };
  const dt = (s: string, errors: string[], name: string) => {
    const t = Date.parse(s);
    if (!s || Number.isNaN(t)) { errors.push(`${name} is required`); return ""; }
    if (t > Date.now() + 5 * 60e3) errors.push(`${name} cannot be in the future`);
    return new Date(t).toISOString();
  };
  const staffIdOrNull = async (ctx: AppContext, id: string, errors: string[]) => {
    if (!id) return null;
    const ok = (await emp.listStaff(ctx.db)).some((s) => s.id === id && !s.disabled_at);
    if (!ok) errors.push("Verifier must be an active staff member");
    return ok ? id : null;
  };
  r.post("/staff/backups/records", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const f = await ctx.form();
    const e: string[] = [];
    const what = str(f, "what"), location = str(f, "location"), evidence = str(f, "evidence");
    if (what.length < 3) e.push("Describe what was backed up");
    if (location.length < 3) e.push("Say where the backup is stored");
    if (evidence.length < 5) e.push("Evidence is required");
    const env = str(f, "environment"), method = str(f, "method"), result = str(f, "result");
    if (!(ENVS as readonly string[]).includes(env)) e.push("Choose an environment");
    if (!(BACKUP_METHODS as readonly string[]).includes(method)) e.push("Choose a method");
    if (!["succeeded", "partial", "failed"].includes(result)) e.push("Choose a result");
    const takenAt = dt(str(f, "taken_at"), e, "Taken at");
    const size = optInt(str(f, "size_bytes"), e, "Size");
    const sha = str(f, "sha256").toLowerCase();
    if (sha && !/^[0-9a-f]{64}$/.test(sha)) e.push("SHA-256 must be 64 hex characters");
    const verifiedBy = await staffIdOrNull(ctx, str(f, "verified_by"), e);
    if (e.length) return backupsPage(ctx, e);
    const id = newId("bkp");
    await ctx.db.prepare(`INSERT INTO backup_records (id, what, location, environment, method, taken_at, size_bytes, sha256, result, verified_by, evidence, recorded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, what, location, env, method, takenAt, size, sha || null, result, verifiedBy, evidence, ctx.user!.id, nowIso()).run();
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "backup.recorded", subjectType: "backup_record", subjectId: id, details: { environment: env, method, result } });
    return redirect(ctx, "/staff/backups", { kind: "success", text: "Backup recorded." });
  });
  r.post("/staff/backups/restore-tests", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const f = await ctx.form();
    const e: string[] = [];
    const what = str(f, "what"), target = str(f, "target"), evidence = str(f, "evidence");
    if (what.length < 3) e.push("Describe what was restored");
    if (target.length < 3) e.push("Say where it was restored to");
    if (evidence.length < 5) e.push("Evidence is required");
    const env = str(f, "environment"), result = str(f, "result");
    if (!(ENVS as readonly string[]).includes(env)) e.push("Choose an environment");
    if (env === "production") e.push("Restore drills must not target production; restore into a separate database or staging");
    if (!["passed", "partial", "failed"].includes(result)) e.push("Choose a result");
    const performedAt = dt(str(f, "performed_at"), e, "Performed at");
    const dur = optInt(str(f, "duration_minutes"), e, "Time to restore"), loss = optInt(str(f, "data_loss_minutes"), e, "Data-loss window");
    const backupId = str(f, "backup_record_id") || null;
    if (backupId && !(await ctx.db.prepare(`SELECT 1 FROM backup_records WHERE id = ?`).bind(backupId).first())) e.push("Unknown backup record");
    const verifiedBy = await staffIdOrNull(ctx, str(f, "verified_by"), e);
    if (e.length) return backupsPage(ctx, e);
    const id = newId("rst");
    await ctx.db.prepare(`INSERT INTO restore_tests (id, backup_record_id, what, target, environment, performed_at, performed_by, verified_by, result, duration_minutes, data_loss_minutes, evidence, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, backupId, what, target, env, performedAt, ctx.user!.id, verifiedBy, result, dur, loss, evidence, nowIso()).run();
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "backup.restore_test_recorded", subjectType: "restore_test", subjectId: id, details: { result } });
    return redirect(ctx, "/staff/backups", { kind: "success", text: "Restore drill recorded." });
  });

  // ── Business settings ──
  r.get("/staff/settings", (ctx) => settingsPage(ctx));
  r.post("/staff/settings", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const f = await ctx.form();
    const v: Record<string, string> = {};
    for (const k of SETTING_KEYS) v[k] = str(f, k);
    v.staffed_hours = str(f, "staffed_hours");
    v.first_response_target_hours = str(f, "first_response_target_hours");
    if (f.get("address_confirm")) v.address_confirm = "1";
    const e: string[] = [];
    if (v["business.legal_name"].length > 160) e.push("Legal name is too long");
    if (v["business.address"].length > 300) e.push("Address is too long");
    if (v["business.address"] && v["business.address"] !== (ctx.settings["business.address"] ?? "") && !v.address_confirm) e.push("Confirm the address is a registered business address and not a residence");
    if (v["contact.email"] && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v["contact.email"])) e.push("Enter a valid contact email");
    if (v["contact.phone"] && !/^[+0-9 ().-]{7,40}$/.test(v["contact.phone"])) e.push("Enter a valid phone number");
    if (v["voice.phone_number"] && !/^[+0-9 ().-]{7,40}$/.test(v["voice.phone_number"])) e.push("Enter a valid receptionist phone number");
    for (const [k, name] of [["backup.rpo_target_hours", "Recovery point objective"], ["backup.rto_target_hours", "Recovery time objective"]] as const) {
      if (v[k] && (!/^\d+$/.test(v[k]) || Number(v[k]) < 1 || Number(v[k]) > 720)) e.push(`${name} must be a whole number of hours between 1 and 720`);
    }
    if (v["contact.email"].length > 254) e.push("Contact email is too long");
    if (v["crm.default_lead_owner"] && !(await leadOwnerOptions(ctx)).some((u) => u.id === v["crm.default_lead_owner"])) e.push("The default lead owner must be an active Owner, administrator or sales user");
    if (/<[^>]*>/.test(v["business.legal_name"] + v["business.address"])) e.push("Business name and address must be plain text");
    if (v.staffed_hours.length < 3 || v.staffed_hours.length > 160) e.push("Enter staffed support hours");
    if (/24\s*\/\s*7|24 hours|around the clock/i.test(v.staffed_hours)) e.push("Staffed hours must not claim 24/7 human coverage unless it is actually staffed — describe the real staffed hours");
    const target = Number(v.first_response_target_hours);
    if (!Number.isInteger(target) || target < 1 || target > 168) e.push("First-response target must be a whole number of hours between 1 and 168");
    if (e.length) return settingsPage(ctx, e, v);
    const at = nowIso();
    const changed: string[] = [];
    const stmts = [];
    const values: Record<string, string> = { ...Object.fromEntries(SETTING_KEYS.map((k) => [k, v[k]])), "support.staffed_hours": v.staffed_hours };
    for (const [k, val] of Object.entries(values)) {
      const prev = ctx.settings[k] ?? "";
      if (prev === val) continue;
      changed.push(k);
      stmts.push(val
        ? ctx.db.prepare(`INSERT INTO business_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(k, val, ctx.user!.id, at)
        : ctx.db.prepare(`DELETE FROM business_settings WHERE key = ?`).bind(k));
    }
    stmts.push(ctx.db.prepare(`INSERT INTO support_settings (id, staffed_hours, first_response_target_hours, updated_by, updated_at) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET staffed_hours = excluded.staffed_hours, first_response_target_hours = excluded.first_response_target_hours, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(v.staffed_hours, target, ctx.user!.id, at));
    await ctx.db.batch(stmts);
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "settings.updated", subjectType: "business_settings", details: { changed, firstResponseTargetHours: target } });
    return redirect(ctx, "/staff/settings", { kind: "success", text: changed.length ? `Saved: ${changed.join(", ")}.` : "Support settings saved." });
  });

  // ── AI operations ──
  const AI_STATUSES = ["queued", "running", "succeeded", "failed", "awaiting_approval", "approved", "rejected"];
  const aiQuery = (ctx: AppContext) => {
    const status = q(ctx, "status"), workflow = q(ctx, "workflow");
    const where: string[] = [], binds: unknown[] = [];
    if (AI_STATUSES.includes(status)) { where.push("j.status = ?"); binds.push(status); }
    if ((AI_WORKFLOWS as readonly string[]).includes(workflow)) { where.push("j.workflow = ?"); binds.push(workflow); }
    return { where, binds, status, workflow };
  };
  r.get("/staff/ai/export.csv", async (ctx) => {
    requireStaff(ctx, "ai.manage");
    const { where, binds, status, workflow } = aiQuery(ctx);
    const rows = (await ctx.db.prepare(`SELECT j.id, j.workflow, j.provider, j.model, j.status, j.input_ref, j.cost_microusd, j.error, j.retries, j.retry_of, j.created_at, j.updated_at, u.display_name AS approver
        FROM ai_jobs j LEFT JOIN users u ON u.id = j.approved_by ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY j.created_at DESC LIMIT 50000`).bind(...binds)
      .all<{ id: string; workflow: string; provider: string; model: string; status: string; input_ref: string; cost_microusd: number | null; error: string | null; retries: number; retry_of: string | null; created_at: string; updated_at: string; approver: string | null }>()).results;
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "ai.jobs_exported", subjectType: "ai_job", details: { count: rows.length, status, workflow } });
    const csv = toCsv(["job_id", "created_at", "updated_at", "workflow", "provider", "model", "status", "input_ref", "cost_usd", "cost_known", "retries", "retry_of", "decided_by", "error"],
      rows.map((j) => [j.id, j.created_at, j.updated_at, j.workflow, j.provider, j.model, j.status, j.input_ref, j.cost_microusd === null ? "" : (j.cost_microusd / 1e6).toFixed(6), j.cost_microusd === null ? "unknown" : "known", j.retries, j.retry_of ?? "", j.approver ?? "", j.error ?? ""]));
    return download(ctx, csv, `crestmont-ai-jobs-${nowIso().slice(0, 10)}.csv`, "text/csv; charset=utf-8");
  });
  r.post("/staff/ai/budget", async (ctx) => {
    requireStaff(ctx, "ai.budget"); // Owner-only (OWNER_ONLY in src/domain/authz.ts)
    const raw = String((await ctx.form()).get("monthly_budget_usd") ?? "").trim();
    const n = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100_000) return redirect(ctx, "/staff/ai", { kind: "error", text: "Enter a monthly budget between 0 and 100000 USD." });
    const before = (await ctx.db.prepare(`SELECT value FROM business_settings WHERE key = 'ai.monthly_budget_usd'`).first<{ value: string }>())?.value ?? null;
    const value = n > 0 ? String(Math.round(n * 100) / 100) : null;
    if (value) await ctx.db.prepare(`INSERT INTO business_settings (key, value, updated_by, updated_at) VALUES ('ai.monthly_budget_usd', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(value, ctx.user!.id, nowIso()).run();
    else await ctx.db.prepare(`DELETE FROM business_settings WHERE key = 'ai.monthly_budget_usd'`).run();
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "ai.budget_updated", subjectType: "setting", subjectId: "ai.monthly_budget_usd", details: { before, after: value } });
    return redirect(ctx, "/staff/ai", { kind: "success", text: value ? `Paid AI budget set to $${value} per month.` : "Paid AI budget cleared: paid AI calls are off." });
  });

  r.get("/staff/ai", async (ctx) => {
    requireStaff(ctx, "ai.manage");
    const { where, binds, status, workflow } = aiQuery(ctx);
    const STATUSES = AI_STATUSES;
    const { page, limit, offset } = pageParam(ctx);
    const jobs = (await ctx.db.prepare(`SELECT j.id, j.workflow, j.provider, j.model, j.status, j.input_ref, j.cost_microusd, j.error, j.retries, j.retry_of, j.created_at, u.display_name AS approver, (SELECT 1 FROM ai_job_inputs i WHERE i.job_id = j.id) AS retryable
        FROM ai_jobs j LEFT JOIN users u ON u.id = j.approved_by ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY j.created_at DESC LIMIT ? OFFSET ?`).bind(...binds, limit + 1, offset)
      .all<{ id: string; workflow: string; provider: string; model: string; status: string; input_ref: string; cost_microusd: number | null; error: string | null; retries: number; retry_of: string | null; created_at: string; approver: string | null; retryable: number | null }>()).results;
    const totals = await ctx.db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN status='awaiting_approval' THEN 1 ELSE 0 END) AS waiting, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(COALESCE(cost_microusd,0)) AS known_cost, SUM(CASE WHEN cost_microusd IS NULL AND status NOT IN ('failed','queued','running') THEN 1 ELSE 0 END) AS unknown_cost FROM ai_jobs`).first<{ n: number; waiting: number | null; failed: number | null; known_cost: number | null; unknown_cost: number | null }>();
    const backend = aiProviderFromEnv(ctx.env);
    const budget = await paidAiBudget(ctx.db);
    const owner = can(ctx.actor!, "ai.budget");
    const providerCard = backend === LOCAL_RUNNER
      ? html`<p>${badge("configured_unverified", "Self-hosted model")}</p><p class="muted">Drafts are queued for the self-hosted model on the build runner (AI_PROVIDER=local-runner). No per-token fee; no paid fallback.</p>`
      : backend
        ? html`<p>${badge("configured_unverified", "Anthropic (paid)")}</p><p class="muted">Anthropic Messages API · model <code>${backend.model}</code>${priceKnown(backend.model) ? "" : " (price unknown — calls are refused)"}. The key is never displayed. Verify it on the <a href="/staff/integrations">integrations page</a>.</p>`
        : html`<p>${badge("not_configured", "Off")}</p><p class="muted">No AI backend is selected. Set AI_PROVIDER to <code>local-runner</code> (self-hosted, with BUILD_RUNNER_SECRET) or <code>anthropic</code> (paid, with ANTHROPIC_API_KEY). A key alone never switches paid AI on. Every AI job fails with not_configured; nothing is generated or simulated.</p>`;
    const budgetCard = html`<section class="card"><h2 class="card__title">Paid AI monthly budget</h2>
<p>${budget.budgetMicro === null ? badge("not_configured", "Not set — paid calls refused") : html`${microUsd(budget.spentMicro)} of ${microUsd(budget.budgetMicro)} used this month`}</p>
<p class="muted">Applies to paid providers only (the self-hosted model has no per-token fee). When the budget is used up, new paid drafts are refused until next month or until the Owner raises it.</p>
${owner ? html`<form method="post" action="/staff/ai/budget" class="row">${csrf(ctx)}${input({ name: "monthly_budget_usd", label: "Monthly budget (USD)", type: "number", value: budget.budgetMicro === null ? "" : String(budget.budgetMicro / 1_000_000), hint: "0 or empty turns paid AI calls off." })}${button("Save budget", { variant: "secondary" })}</form>` : html`<p class="faint">Set by the Owner.</p>`}</section>`;
    const aiExportQs = new URLSearchParams(ctx.url.search); aiExportQs.delete("page");
    const body = html`${pageHead("AI operations", linkButton("Export CSV", `/staff/ai/export.csv${aiExportQs.toString() ? `?${aiExportQs}` : ""}`, "ghost", "sm"), "AI")}
<div class="grid grid-2"><section class="card"><h2 class="card__title">Provider</h2>
${providerCard}</section>
${budgetCard}
<section class="card"><h2 class="card__title">Permission boundaries</h2><p class="muted">AI output is always a draft that a person approves before it is used. AI jobs run with no Founder-protected permissions (enforced in <code>src/domain/authz.ts</code>): AI <strong>cannot</strong> issue or approve refunds, execute contracts or agreements, change prices, or approve or deploy production releases.</p>
<p class="faint">Never requested by any workflow: ${AI_FORBIDDEN.join(", ")}.</p></section></div>
<div class="kpis grid grid-4">${kpi("Jobs", totals?.n ?? 0)}${kpi("Awaiting approval", totals?.waiting ?? 0)}${kpi("Failed", totals?.failed ?? 0)}${kpi("Known cost", microUsd(totals?.known_cost ?? 0), totals?.unknown_cost ? `${totals.unknown_cost} completed jobs with unknown cost` : undefined)}</div>
${filterForm(ctx, [
  select({ name: "status", label: "Status", options: STATUSES, value: status, includeBlank: "Any" }),
  select({ name: "workflow", label: "Workflow", options: [...AI_WORKFLOWS], value: workflow, includeBlank: "Any" }),
])}
${table(jobs.slice(0, limit), [
  { header: "Created", cell: (j) => html`<a href="/staff/ai/${j.id}">${formatDateTime(j.created_at)}</a>${j.retry_of ? html`<br><span class="faint">retry of ${j.retry_of}</span>` : ""}` },
  { header: "Workflow", cell: (j) => label(j.workflow) },
  { header: "Provider / model", cell: (j) => `${j.provider} / ${j.model}` },
  { header: "Status", cell: (j) => badge(j.status) },
  { header: "Cost", cell: (j) => microUsd(j.cost_microusd), numeric: true },
  { header: "Retries", cell: (j) => j.retries, numeric: true },
  { header: "Error", cell: (j) => (j.error ?? "—").slice(0, 100) },
  { header: "Approval", cell: (j) => j.status === "awaiting_approval"
    ? html`${actionForm(ctx, `/staff/ai/${j.id}/decide`, "Approve", { variant: "primary", hidden: { decision: "approved" } })} ${actionForm(ctx, `/staff/ai/${j.id}/decide`, "Reject", { variant: "ghost", hidden: { decision: "rejected" } })}`
    : j.status === "failed" ? (j.retryable ? actionForm(ctx, `/staff/ai/${j.id}/retry`, "Retry") : html`<span class="faint">Input not retained</span>`)
    : j.approver ? `By ${j.approver}` : "—" },
], { empty: emptyState("No AI jobs", "Jobs appear when staff request AI drafts (lead qualification, quote drafts, support replies and more).") })}
${pagination(ctx, page, jobs.length > limit)}`;
    return staffPage(ctx, "AI operations", body);
  });
  r.get("/staff/ai/:id", async (ctx, p) => {
    requireStaff(ctx, "ai.manage");
    const j = await ctx.db.prepare(`SELECT j.*, u.display_name AS approver FROM ai_jobs j LEFT JOIN users u ON u.id = j.approved_by WHERE j.id = ?`).bind(p.id)
      .first<{ id: string; workflow: string; provider: string; model: string; status: string; input_ref: string; output_ref: string | null; cost_microusd: number | null; error: string | null; retries: number; retry_of: string | null; created_at: string; updated_at: string; approver: string | null }>();
    if (!j) throw new HttpError(404, "AI job not found");
    // Sales-optimization jobs can hold consented transcript text: their output is shown only on the Owner-only dashboard.
    if (j.workflow.startsWith("salesopt_")) j.output_ref = null;
    const body = html`${pageHead(`AI job · ${label(j.workflow)}`, linkButton("All jobs", "/staff/ai", "ghost", "sm"), "AI operations")}
${dl([["Job id", j.id], ["Status", badge(j.status)], ["Provider / model", `${j.provider} / ${j.model}`], ["Input reference", j.input_ref], ["Cost", microUsd(j.cost_microusd)], ["Retries", j.retries], ["Retry of", j.retry_of], ["Error", j.error], ["Approved / decided by", j.approver], ["Created", formatDateTime(j.created_at)], ["Updated", formatDateTime(j.updated_at)]])}
<section class="section--tight"><h2>Output (draft)</h2>${j.output_ref ? (j.status === "awaiting_approval"
      ? html`<form method="post" action="/staff/ai/${j.id}/decide">${csrf(ctx)}${textarea({ name: "final_text", label: "Edit before approving (optional)", value: j.output_ref, rows: 12, maxlength: 20000 })}<div class="form-actions">${button("Approve", { name: "decision", value: "approved" })}${button("Reject", { variant: "ghost", name: "decision", value: "rejected" })}</div></form>`
      : html`<pre class="code-block">${j.output_ref}</pre>`) : emptyState("No output", j.status === "failed" ? "This job failed; nothing was generated." : "No output recorded.")}</section>`;
    return staffPage(ctx, "AI job", body);
  });
  r.post("/staff/ai/:id/decide", async (ctx, p) => {
    requireStaff(ctx, "ai.manage");
    const f = await ctx.form();
    const decision = str(f, "decision");
    if (decision !== "approved" && decision !== "rejected") throw new HttpError(400, "Choose approve or reject.");
    const finalText = typeof f.get("final_text") === "string" && decision === "approved" ? String(f.get("final_text")).slice(0, 20_000) : undefined;
    try {
      await decideAiJob(ctx.db, p.id, ctx.user!.id, decision, finalText || undefined);
    } catch (e) {
      return redirect(ctx, "/staff/ai", { kind: "error", text: (e as Error).message });
    }
    return redirect(ctx, "/staff/ai", { kind: "success", text: decision === "approved" ? "Draft approved." : "Draft rejected." });
  });
  r.post("/staff/ai/:id/retry", async (ctx, p) => {
    requireStaff(ctx, "ai.manage");
    try {
      const res = await mon.retryAiJob(ctx.db, aiProviderFromEnv(ctx.env), p.id, ctx.user!.id);
      return redirect(ctx, "/staff/ai", res.status === "failed" ? { kind: "error", text: `Retry failed: ${res.error ?? "unknown error"}` } : res.status === "queued" ? { kind: "info", text: "Retry queued for the self-hosted model; the new draft appears here when ready." } : { kind: "success", text: "Retry succeeded; the new draft awaits approval." });
    } catch (e) {
      if (e instanceof mon.AiOpsError) return redirect(ctx, "/staff/ai", { kind: "error", text: e.message });
      throw e;
    }
  });

  // ── AI receptionist ──
  r.get("/staff/voice", (ctx) => voicePage(ctx));
  r.post("/staff/voice/configs", async (ctx) => {
    requireStaff(ctx, "voice.manage");
    const f = await ctx.form();
    const draft = { instructions: String(f.get("instructions") ?? ""), note: str(f, "note") };
    try {
      const res = await voice.createAgentConfig(ctx.db, ctx.user!.id, draft.instructions, draft.note);
      return redirect(ctx, "/staff/voice#config", { kind: "success", text: `Configuration v${res.version} saved (not active until activated).` });
    } catch (e) {
      if (e instanceof ValidationError) return voicePage(ctx, e.issues, draft);
      throw e;
    }
  });
  r.post("/staff/voice/configs/:version/activate", async (ctx, p) => {
    requireStaff(ctx, "voice.manage");
    const v = Number(p.version);
    if (!Number.isInteger(v) || v < 1) throw new HttpError(404, "Version not found");
    try { await voice.activateAgentConfig(ctx.db, ctx.user!.id, v); } catch (e) {
      if (errStatus(e) === 404 || errStatus(e) === 409) return redirect(ctx, "/staff/voice#config", { kind: "error", text: (e as Error).message });
      throw e;
    }
    // CREST-GAP-053: push the composed prompt to Retell and read it back. Never reported as synced unless Retell's read-back matches.
    const s = await syncPrompt({ db: ctx.db, env: ctx.env, fetch: ctx.env.overrides?.fetch ?? fetch, userId: ctx.user!.id, mode: "push" });
    return redirect(ctx, "/staff/voice#prompt-sync", { kind: s.status === "in_sync" ? "success" : s.status === "not_configured" ? "info" : "error", text: `Configuration v${v} is now active on the platform. ${syncSentence(s)}` });
  });
  r.post("/staff/voice/prompt-sync", async (ctx) => {
    requireStaff(ctx, "voice.manage");
    const m = str(await ctx.form(), "mode");
    const mode = m === "check" || m === "adopt" || m === "push_overwrite" ? m : "push";
    const s = await syncPrompt({ db: ctx.db, env: ctx.env, fetch: ctx.env.overrides?.fetch ?? fetch, userId: ctx.user!.id, mode });
    return redirect(ctx, "/staff/voice#prompt-sync", { kind: s.status === "in_sync" ? "success" : "error", text: syncSentence(s) });
  });
  r.post("/staff/voice/budget", async (ctx) => {
    requireStaff(ctx, "voice.manage"); // Owner-only (src/domain/authz.ts)
    try {
      const value = await setVoiceBudget(ctx.db, ctx.user!.id, str(await ctx.form(), "monthly_budget_usd"));
      return redirect(ctx, "/staff/voice#budget", { kind: "success", text: value ? `Voice budget set to $${value} per month.` : "Voice budget cleared: Retell calls are answered in voicemail-only mode and nothing is dialled." });
    } catch (e) {
      if (e instanceof VoiceBudgetError) return redirect(ctx, "/staff/voice#budget", { kind: "error", text: e.message });
      throw e;
    }
  });
  r.get("/staff/voice/configs/diff", async (ctx) => {
    requireStaff(ctx, "voice.manage");
    const a = Number(q(ctx, "a")), b = Number(q(ctx, "b"));
    const get = (n: number) => ctx.db.prepare(`SELECT version, prompt_text, change_note, created_at FROM voice_agent_configs WHERE version = ?`).bind(n).first<{ version: number; prompt_text: string; change_note: string; created_at: string }>();
    const [x, y] = [Number.isInteger(a) ? await get(a) : null, Number.isInteger(b) ? await get(b) : null];
    if (!x || !y) throw new HttpError(404, "Version not found");
    const diff = voice.lineDiff(x.prompt_text, y.prompt_text);
    const body = html`${pageHead(`Configuration v${x.version} → v${y.version}`, linkButton("Back", "/staff/voice#config", "ghost", "sm"), "AI receptionist")}
<p class="muted">v${y.version}: ${y.change_note} (${formatDateTime(y.created_at)})</p>
<pre class="code-block diff">${diff.map((d) => html`<span class="diff__${d.op === "+" ? "add" : d.op === "-" ? "del" : "ctx"}">${d.op} ${d.text}\n</span>`)}</pre>`;
    return staffPage(ctx, "Configuration diff", body);
  });
  r.get("/staff/voice/calls/:id", async (ctx, p) => {
    requireStaff(ctx, "voice.manage");
    const c = await ctx.db.prepare(`SELECT c.*, l.stage AS lead_stage FROM calls c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.id = ?`).bind(p.id)
      .first<{ id: string; provider: string; provider_call_id: string; from_number: string | null; outcome: string | null; lead_id: string | null; lead_stage: string | null; recording_consent: number; summary: string | null; transcript: string | null; recording_url: string | null; cost_microusd: number | null; started_at: string; ended_at: string | null; is_test: number; error: string | null; escalated_at: string | null; agent_config_version: number | null }>();
    if (!c) throw new HttpError(404, "Call not found");
    const events = (await ctx.db.prepare(`SELECT kind, status, detail, created_at FROM voice_events WHERE call_id = ? ORDER BY created_at`).bind(c.id).all<{ kind: string; status: string; detail: string | null; created_at: string }>()).results;
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "call.viewed", subjectType: "call", subjectId: c.id });
    const body = html`${pageHead(`Call ${c.provider_call_id}`, linkButton("All calls", c.is_test ? "/staff/voice?test=1" : "/staff/voice", "ghost", "sm"), c.is_test ? "Test call" : "AI receptionist")}
${c.is_test ? alert("info", "This is a test call created through the signed webhook. It is excluded from call volume, costs and conversion.") : ""}
${dl([["Provider", c.provider], ["Caller", c.from_number ?? "Unknown"], ["Started", formatDateTime(c.started_at)], ["Ended", formatDateTime(c.ended_at)], ["Outcome", c.outcome ? label(c.outcome) : "In progress"],
      ["Lead", c.lead_id ? `${c.lead_id} (${label(c.lead_stage ?? "")})` : "—"], ["Escalated", formatDateTime(c.escalated_at)], ["Recording consent", c.recording_consent ? "Given" : "Not given"],
      ["Agent configuration", c.agent_config_version ? `v${c.agent_config_version}` : "None active"], ["Cost", microUsd(c.cost_microusd)], ["Error", c.error]])}
<section class="section--tight"><h2>Summary &amp; transcript</h2>${c.recording_consent
      ? html`${c.summary ? html`<p>${c.summary}</p>` : ""}${c.transcript ? html`<pre class="code-block">${c.transcript}</pre>` : emptyState("No transcript", "The provider did not send a transcript.")}${c.recording_url ? (safeHttpsUrl(c.recording_url) === "#"
        // CREST-GAP-100: a provider-supplied link that is not https is never made clickable.
        ? html`<p data-testid="recording-link"><a href="#" rel="noopener noreferrer">Recording link withheld (not an https URL)</a></p>`
        : html`<p data-testid="recording-link"><a href="${safeHttpsUrl(c.recording_url)}" rel="noopener noreferrer">Recording (provider-hosted)</a></p>`) : ""}`
      : emptyState("Not stored", "The caller did not consent to recording or transcription, so no transcript, summary or recording was stored.")}</section>
<section class="section--tight"><h2>Events</h2>${table(events, [
      { header: "When", cell: (e) => formatDateTime(e.created_at) }, { header: "Event", cell: (e) => e.kind }, { header: "Status", cell: (e) => badge(e.status === "ok" ? "active" : "failed", e.status) }, { header: "Detail", cell: (e) => e.detail ?? "—" },
    ])}</section>`;
    return staffPage(ctx, "Call", body);
  });
  r.post("/staff/voice/test-event", async (ctx) => {
    requireStaff(ctx, "voice.manage");
    if (ctx.env.ENVIRONMENT !== "development") throw new HttpError(403, "Test events are available in development only.");
    const secret = ctx.env.VOICE_WEBHOOK_SECRET;
    if (!secret) return redirect(ctx, "/staff/voice", { kind: "error", text: "VOICE_WEBHOOK_SECRET is not set; the webhook fails closed, so no test event was sent." });
    const scenario = str(await ctx.form(), "scenario");
    const callId = `test-${Date.now()}`;
    const fn = (name: string, args: Record<string, unknown>) => ({ event: "function_call", event_id: `${callId}-fn`, function: { name, arguments: args } });
    const steps: Record<string, unknown>[] = [{ event: "call_started", recording_consent: false, from_number: "+1 555 0100" }];
    let outcome = "info_only";
    if (scenario === "lead") { steps.push(fn("create_lead", { name: "Test Caller", phone: "+1 555 0100", interest: "business", requirements: "TEST: wants a 10-page site for a bakery." })); outcome = "lead_captured"; }
    else if (scenario === "callback") { steps.push(fn("request_callback", { name: "Test Caller", phone: "+1 555 0100", reason: "TEST: prefers to talk to a person." })); outcome = "callback_requested"; }
    else if (scenario === "escalate") { steps.push(fn("escalate", { reason: "TEST: asked about a contract change.", name: "Test Caller", phone: "+1 555 0100" })); outcome = "escalated"; }
    else steps.push(fn("get_published_pricing", {}));
    steps.push({ event: "call_ended", outcome, recording_consent: false });
    for (const s of steps) {
      const raw = JSON.stringify({ provider: "crestmont-test", call_id: callId, test: true, ...s });
      await voice.verifyVoiceSignature(secret, raw, await voice.signVoiceEvent(secret, raw));
      await voice.handleVoiceEvent(ctx.db, raw);
    }
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "voice.test_event_sent", subjectType: "call", subjectId: callId, details: { scenario } });
    return redirect(ctx, "/staff/voice?test=1", { kind: "success", text: `Signed test call ${callId} processed (labelled test).` });
  });
  r.post("/api/webhooks/voice", async (ctx) => {
    const raw = await readBody(ctx.req);
    try {
      await voice.verifyVoiceSignature(ctx.env.VOICE_WEBHOOK_SECRET, raw, ctx.req.headers.get("x-crestmont-voice-signature"));
    } catch (e) {
      if (e instanceof voice.VoiceAuthError) throw new HttpError(401, e.message);
      throw e;
    }
    const res = await voice.handleVoiceEvent(ctx.db, raw);
    return jsonResponse(ctx, res.status, res.body);
  });

  // ── Privacy self-service (any signed-in user) ──
  const privacyPage = async (ctx: AppContext) => {
    requireUser(ctx);
    if (!ctx.sessionMfaVerified) throw new HttpError(401, "MFA_REQUIRED");
    const reqs = await priv.listOwnRequests(ctx.db, ctx.user!.id);
    const openDeletion = reqs.find((x) => x.kind === "deletion" && ["received", "in_progress"].includes(x.status));
    const body = html`${pageHead("Privacy & your data", undefined, "Account")}
<div class="grid grid-2"><section class="card"><h2 class="card__title">Download your data</h2>
<p class="muted">A JSON file with your profile, memberships, sign-in history and, for customer organizations you belong to, their projects, messages, support tickets, orders and invoice records. It does not include password hashes, two-factor secrets, internal staff notes, or any other organization's data.</p>
<form method="post" action="/account/privacy/export">${csrf(ctx)}${button("Download my data", { variant: "secondary" })}</form></section>
<section class="card"><h2 class="card__title">Request deletion</h2>
<p class="muted">Crestmont staff review deletion requests. When completed, your name, email, password and two-factor settings are removed, you are signed out everywhere, and you lose access to the portal.</p>
<p class="muted"><strong>What is kept:</strong> orders, invoices, payments, refunds, signed agreements and audit records are retained for as long as tax, accounting and contract law require. They will no longer be linked to your name or email.</p>
${openDeletion ? alert("info", `Your deletion request from ${formatDate(openDeletion.created_at)} is ${label(openDeletion.status).toLowerCase()}.`) : html`<form method="post" action="/account/privacy/delete" data-confirm="Request deletion of your account? Staff will process it.">${csrf(ctx)}
${textarea({ name: "reason", label: "Anything we should know (optional)", rows: 3, maxlength: 1000 })}
${checkbox("confirm", "I understand my account will be anonymised and I will lose access.", { required: true })}
<div class="form-actions">${button("Request deletion", { variant: "danger" })}</div></form>`}</section></div>
<section class="section--tight"><h2>Your requests</h2>${table(reqs, [
  { header: "Requested", cell: (x) => formatDateTime(x.created_at) }, { header: "Type", cell: (x) => label(x.kind) }, { header: "Status", cell: (x) => badge(x.status) }, { header: "Completed", cell: (x) => formatDateTime(x.completed_at) },
], { empty: emptyState("No requests yet", "Exports and deletion requests you make are listed here.") })}</section>`;
    const staff = ctx.user!.isStaff;
    return htmlResponse(ctx, appLayout(ctx, { title: "Privacy", nav: staff ? staffNav(ctx) : portalNav(ctx), home: staff ? "/staff" : "/portal", area: staff ? "Crestmont staff" : "Customer portal" }, body));
  };
  r.get("/account/privacy", (ctx) => privacyPage(ctx));
  r.post("/account/privacy/export", async (ctx) => {
    requireUser(ctx);
    if (!ctx.sessionMfaVerified) throw new HttpError(401, "MFA_REQUIRED");
    const data = await priv.buildExport(ctx.db, ctx.user!.id);
    return download(ctx, JSON.stringify(data, null, 2), `crestmont-data-export-${nowIso().slice(0, 10)}.json`, "application/json; charset=utf-8");
  });
  r.post("/account/privacy/delete", async (ctx) => {
    requireUser(ctx);
    if (!ctx.sessionMfaVerified) throw new HttpError(401, "MFA_REQUIRED");
    const f = await ctx.form();
    if (!f.get("confirm")) return redirect(ctx, "/account/privacy", { kind: "error", text: "Tick the confirmation box to request deletion." });
    try {
      await priv.requestDeletion(ctx.db, ctx.user!.id, str(f, "reason"));
    } catch (e) {
      if (e instanceof priv.PrivacyError) return redirect(ctx, "/account/privacy", { kind: "error", text: e.message });
      throw e;
    }
    await sendMail(ctx, { template: "security_notification", to: ctx.user!.email, idempotencyKey: `privacy-del:${ctx.user!.id}:${Date.now()}`, data: { event: "deletion_requested" } });
    return redirect(ctx, "/account/privacy", { kind: "success", text: "Deletion request received. Staff will review it." });
  });
}

