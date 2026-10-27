// Operational reports (Reports module, non-finance side): one page with an operational summary for a
// date range and every operational CSV export, each gated by the permission of the module it comes
// from. Financial/accounting exports stay on /staff/reports (finance area).
// Registered before the finance routes so /staff/reports/operations is not taken by /staff/reports/:file.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html } from "../lib/html.ts";
import { download, htmlResponse } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { appLayout } from "../ui/layout.ts";
import { alert, badge, dateRange, linkButton, pageHead, table } from "../ui/components.ts";
import { staffNav } from "./nav.ts";
import { can, type Permission } from "../domain/authz.ts";
import { parseRange, toCsv, type DateRange } from "../services/finance.ts";
import { audit } from "../services/security.ts";

interface Metric { key: string; label: string; value: number | null; unit?: "hours" | "count"; definition: string; perm: Permission }

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export async function operationalSummary(ctx: AppContext, r: DateRange): Promise<Metric[]> {
  const n = async (sql: string, ...b: unknown[]) => (await ctx.db.prepare(sql).bind(...b).first<{ n: number | null }>())?.n ?? 0;
  const range = [r.fromIso, r.toIso];
  const dayRange = [r.from, r.to];
  const responses = (await ctx.db.prepare(`SELECT created_at, first_response_at FROM tickets WHERE created_at >= ? AND created_at < ? AND first_response_at IS NOT NULL`).bind(...range).all<{ created_at: string; first_response_at: string }>()).results
    .map((t) => (Date.parse(t.first_response_at) - Date.parse(t.created_at)) / 3_600_000);
  const med = median(responses);
  return [
    { key: "leads_created", label: "Leads created", value: await n(`SELECT COUNT(*) AS n FROM leads WHERE merged_into_lead_id IS NULL AND created_at >= ? AND created_at < ?`, ...range), definition: "Leads created in the range, excluding leads merged into another lead as duplicates.", perm: "crm.access" },
    { key: "leads_converted", label: "Of those, converted", value: await n(`SELECT COUNT(*) AS n FROM leads WHERE merged_into_lead_id IS NULL AND stage = 'converted' AND created_at >= ? AND created_at < ?`, ...range), definition: "Leads created in the range that are now converted (set only by a verified payment webhook).", perm: "crm.access" },
    { key: "quotes_sent", label: "Quotes sent", value: await n(`SELECT COUNT(*) AS n FROM quotes WHERE sent_at >= ? AND sent_at < ?`, ...range), definition: "Quotes whose first send falls in the range.", perm: "quote.write" },
    { key: "quotes_accepted", label: "Quote versions accepted", value: await n(`SELECT COUNT(*) AS n FROM quote_versions WHERE accepted_at >= ? AND accepted_at < ?`, ...range), definition: "Quote versions accepted by the customer in the range.", perm: "quote.write" },
    { key: "projects_started", label: "Projects started", value: await n(`SELECT COUNT(*) AS n FROM projects WHERE created_at >= ? AND created_at < ?`, ...range), definition: "Projects provisioned in the range.", perm: "delivery.access" },
    { key: "projects_completed", label: "Projects completed", value: await n(`SELECT COUNT(*) AS n FROM projects WHERE completed_at >= ? AND completed_at < ?`, ...range), definition: "Projects whose completion (closure checklist passed) falls in the range.", perm: "delivery.access" },
    { key: "tasks_completed", label: "Tasks completed", value: await n(`SELECT COUNT(*) AS n FROM tasks WHERE completed_at >= ? AND completed_at < ?`, ...range), definition: "Tasks marked done in the range.", perm: "delivery.access" },
    { key: "time_logged_hours", label: "Time logged", unit: "hours", value: (await n(`SELECT COALESCE(SUM(minutes),0) AS n FROM time_entries WHERE worked_on >= ? AND worked_on <= ?`, ...dayRange)) / 60, definition: "Sum of time entries whose work date falls in the range, in hours.", perm: "delivery.access" },
    { key: "tickets_opened", label: "Support tickets opened", value: await n(`SELECT COUNT(*) AS n FROM tickets WHERE created_at >= ? AND created_at < ?`, ...range), definition: "Tickets created in the range.", perm: "support.access" },
    { key: "tickets_resolved", label: "Support tickets resolved", value: await n(`SELECT COUNT(*) AS n FROM tickets WHERE resolved_at >= ? AND resolved_at < ?`, ...range), definition: "Tickets resolved in the range.", perm: "support.access" },
    { key: "median_first_response_hours", label: "Median first response", unit: "hours", value: med === null ? null : Math.round(med * 10) / 10, definition: `Median hours from creation to first staff response for tickets created in the range that have been answered (${responses.length} ticket${responses.length === 1 ? "" : "s"}). Unknown when none were answered.`, perm: "support.access" },
    { key: "emails_failed", label: "Email deliveries failed or bounced", value: await n(`SELECT COUNT(*) AS n FROM email_deliveries WHERE status IN ('failed','bounced') AND created_at >= ? AND created_at < ?`, ...range), definition: "Deliveries created in the range that failed or bounced.", perm: "settings.operational" },
    { key: "ai_jobs", label: "AI jobs run", value: await n(`SELECT COUNT(*) AS n FROM ai_jobs WHERE created_at >= ? AND created_at < ?`, ...range), definition: "AI jobs requested in the range (all statuses).", perm: "ai.manage" },
  ];
}

const fmt = (m: Metric) => (m.value === null ? "Unknown" : m.unit === "hours" ? `${m.value.toFixed(1)} h` : String(m.value));

interface ExportDef { label: string; href: (r: DateRange) => string; perm: Permission; contents: string }
const EXPORTS: ExportDef[] = [
  { label: "Leads", href: (r) => `/staff/crm/export.csv?from=${r.from}&to=${r.to}`, perm: "crm.access", contents: "Leads created in the range with source, stage, owner and interest (sales reps: their own leads only)." },
  { label: "Quotes", href: () => `/staff/quotes/export.csv`, perm: "quote.write", contents: "Every quote with its current version total, status (incl. withdrawn/declined reason) and contact." },
  { label: "Customers", href: () => `/staff/customers/export.csv`, perm: "customers.read", contents: "Customer organizations with orders, projects, active plans, open tickets and amount paid." },
  { label: "Projects", href: () => `/staff/projects/export.csv?status=all`, perm: "delivery.access", contents: "Projects with status, PM, task progress, overdue tasks, target launch and completion dates." },
  { label: "Tasks", href: () => `/staff/tasks/export.csv?status=all`, perm: "delivery.access", contents: "Tasks with project, milestone, assignees, due/overdue, estimate, time logged and open dependencies." },
  { label: "Time entries", href: (r) => `/staff/reports/operations/time.csv?from=${r.from}&to=${r.to}`, perm: "project.coordinate", contents: "Time logged in the range per entry: date, person, task and project (labor cost is on the finance profitability export)." },
  { label: "Support tickets", href: () => `/staff/support/export.csv?status=all`, perm: "support.access", contents: "Tickets with customer, category, priority, status, assignee and first-response timing against the target." },
  { label: "Employee workload", href: () => `/staff/employees/export.csv`, perm: "employee.manage", contents: "Per-person open/overdue tasks, estimates, projects, leads, tickets, time logged and capacity utilisation." },
  { label: "Email delivery log", href: (r) => `/staff/email/export.csv?from=${r.from}&until=${r.to}`, perm: "settings.operational", contents: "Transactional email deliveries in the range with template, recipient, provider, status and errors." },
  { label: "AI jobs", href: () => `/staff/ai/export.csv`, perm: "ai.manage", contents: "AI jobs with workflow, provider/model, status, known/unknown cost, retries and approver." },
  { label: "Security events", href: (r) => `/staff/security/events.csv?from=${r.from}&to=${r.to}`, perm: "audit.read", contents: "Sign-in failures, lockouts, rate limits and MFA events in the range." },
  { label: "Audit log", href: (r) => `/staff/audit/export.csv?from=${r.from}&to=${r.to}`, perm: "audit.read", contents: "Append-only audit entries in the range (the export itself is audited)." },
  { label: "Operational summary", href: (r) => `/staff/reports/operations/summary.csv?from=${r.from}&to=${r.to}`, perm: "readiness.read", contents: "The summary figures on this page for the selected range (only the figures you may see)." },
];

export function register(r: Router): void {
  r.get("/staff/reports/operations", async (ctx) => {
    requireStaff(ctx);
    const range = parseRange(ctx.url.searchParams, 30, ctx.now());
    const metrics = (await operationalSummary(ctx, range)).filter((m) => can(ctx.actor!, m.perm));
    const body = html`${pageHead("Operational reports", can(ctx.actor!, "finance.read") ? linkButton("Financial reports", "/staff/reports", "ghost", "sm") : undefined, `${range.from} to ${range.to}`)}
${dateRange(ctx, { from: range.from, to: range.to })}
<p class="muted">Every figure is counted from stored records for the selected range at page load; nothing is estimated. You see only the figures and exports your role permits. Each export applies the same visibility rules as its module page and is recorded in the audit log.</p>
${metrics.length ? table(metrics, [{ header: "Measure", cell: (m) => m.label }, { header: "Value", cell: (m) => fmt(m), numeric: true }, { header: "Definition", cell: (m) => html`<span class="faint">${m.definition}</span>` }], { caption: "Operational summary" })
      : alert("info", "Your role has no operational figures to show.")}
<section class="section--tight"><h2>Exports</h2>${table(EXPORTS, [
      { header: "Export", cell: (e) => e.label }, { header: "Contents", cell: (e) => e.contents },
      { header: "", cell: (e) => (can(ctx.actor!, e.perm) ? linkButton("Download CSV", e.href(range), "secondary", "sm") : badge("not_configured", "Not permitted for your role")) },
    ], { caption: "Operational CSV exports" })}</section>`;
    return htmlResponse(ctx, appLayout(ctx, { title: "Operational reports", nav: staffNav(ctx), home: "/staff", area: "Owner command center" }, body));
  });

  r.get("/staff/reports/operations/summary.csv", async (ctx) => {
    requireStaff(ctx);
    const range = parseRange(ctx.url.searchParams, 30, ctx.now());
    const metrics = (await operationalSummary(ctx, range)).filter((m) => can(ctx.actor!, m.perm));
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "report.operations_exported", subjectType: "report", details: { from: range.from, to: range.to, measures: metrics.length } });
    const csv = toCsv(["from", "to", "measure", "value", "unit", "definition"], metrics.map((m) => [range.from, range.to, m.key, m.value === null ? "unknown" : m.value, m.unit ?? "count", m.definition]));
    return download(ctx, csv, `crestmont-operations-${range.from}-to-${range.to}.csv`, "text/csv; charset=utf-8");
  });

  r.get("/staff/reports/operations/time.csv", async (ctx) => {
    requireStaff(ctx, "project.coordinate");
    const range = parseRange(ctx.url.searchParams, 30, ctx.now());
    const rows = (await ctx.db.prepare(`SELECT te.id, te.worked_on, te.minutes, u.display_name AS person, u.email, t.id AS task_id, t.title, p.id AS project_id, p.name AS project
        FROM time_entries te JOIN users u ON u.id = te.user_id JOIN tasks t ON t.id = te.task_id JOIN projects p ON p.id = t.project_id
        WHERE te.worked_on >= ? AND te.worked_on <= ? ORDER BY te.worked_on, p.name, t.title LIMIT 50000`).bind(range.from, range.to)
      .all<{ id: string; worked_on: string; minutes: number; person: string; email: string; task_id: string; title: string; project_id: string; project: string }>()).results;
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "report.time_exported", subjectType: "report", details: { from: range.from, to: range.to, rows: rows.length } });
    const csv = toCsv(["entry_id", "worked_on", "person", "email", "minutes", "hours", "task_id", "task", "project_id", "project"],
      rows.map((x) => [x.id, x.worked_on, x.person, x.email, x.minutes, (x.minutes / 60).toFixed(2), x.task_id, x.title, x.project_id, x.project]));
    return download(ctx, csv, `crestmont-time-${range.from}-to-${range.to}.csv`, "text/csv; charset=utf-8");
  });
}
