// Owner executive overview (OWN-002, §35). Every figure is a query over persisted records with
// its definition shown beside it; zero is shown as zero with an explanation, unknown as "Unknown".
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatCents, formatDateTime, label, type SafeHtml } from "../lib/html.ts";
import { htmlResponse } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { appLayout } from "../ui/layout.ts";
import { alert, badge, pageHead, table, linkButton } from "../ui/components.ts";
import { staffNav } from "./nav.ts";
import * as ra from "../services/readiness-admin.ts";
import { DIMENSIONS } from "./readiness.ts";
import { recordAppError } from "../services/monitoring.ts";

interface Tile { label: string; value: string; href: string; definition: string; empty?: string; tone?: "bad" | "warn" }

function tile(t: Tile): SafeHtml {
  return html`<a class="kpi exec-tile${t.tone ? ` exec-tile--${t.tone}` : ""}" href="${t.href}" data-metric="${t.label}"><div class="kpi__label">${t.label}</div><div class="kpi__value">${t.value}</div>
<div class="kpi__sub">${t.empty ?? t.definition}</div></a>`;
}

/** Text shown on a tile whose query failed (CREST-GAP-042): never a misleading 0. */
export const UNKNOWN_FAILED = "Unknown — query failed";

/** One metric query. A failure returns null (shown as Unknown) and is recorded in app_errors for Monitoring. */
async function n(ctx: AppContext, sql: string, ...binds: unknown[]): Promise<number | null> {
  try { return (await ctx.db.prepare(sql).bind(...binds).first<{ n: number | null }>())?.n ?? 0; }
  catch (e) {
    await recordAppError(ctx.db, { path: "/staff/owner", method: "GET", status: 500, environment: ctx.env.ENVIRONMENT,
      message: `Executive overview metric query failed: ${(e as Error).message}`, stack: (e as Error).stack ?? null });
    return null;
  }
}

/** Sum of parts, or null when any part is unknown. */
const sum = (...xs: (number | null)[]): number | null => (xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b as number), 0));
const show = (v: number | null, f: (x: number) => string = String): string => (v === null ? UNKNOWN_FAILED : f(v));
/** Detail text for a tile; a part that failed is written as "unknown". */
const part = (v: number | null, f: (x: number) => string = String): string => (v === null ? "unknown" : f(v));

export async function executiveMetrics(ctx: AppContext) {
  const now = ctx.now();
  const iso30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const nowIsoStr = now.toISOString();
  const revenueAll = await n(ctx, `SELECT COALESCE(SUM(amount_cents),0) AS n FROM payments WHERE status = 'succeeded'`);
  const revenue30 = await n(ctx, `SELECT COALESCE(SUM(amount_cents),0) AS n FROM payments WHERE status = 'succeeded' AND created_at >= ?`, iso30);
  const succeededCount = await n(ctx, `SELECT COUNT(*) AS n FROM payments WHERE status = 'succeeded'`);
  const mrr = await n(ctx, `SELECT COALESCE(SUM(p.price_cents),0) AS n FROM subscriptions s JOIN products p ON p.id = s.product_id WHERE s.status = 'active' AND p.billing = 'monthly'`);
  const activeSubs = await n(ctx, `SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'`);
  const unpricedSubs = await n(ctx, `SELECT COUNT(*) AS n FROM subscriptions s JOIN products p ON p.id = s.product_id WHERE s.status = 'active' AND (p.price_cents IS NULL OR p.billing <> 'monthly')`);
  const activeCustomers = await n(ctx, `SELECT COUNT(*) AS n FROM organizations o WHERE o.kind = 'customer' AND (
      EXISTS(SELECT 1 FROM projects p WHERE p.organization_id = o.id AND p.status NOT IN ('completed','cancelled'))
      OR EXISTS(SELECT 1 FROM subscriptions s WHERE s.organization_id = o.id AND s.status IN ('active','trialing','past_due')))`);
  const newLeads = await n(ctx, `SELECT COUNT(*) AS n FROM leads WHERE merged_into_lead_id IS NULL AND created_at >= ?`, iso30);
  const activeProjects = await n(ctx, `SELECT COUNT(*) AS n FROM projects WHERE status NOT IN ('completed','cancelled','maintenance')`);
  const customerApprovals = await n(ctx, `SELECT COUNT(*) AS n FROM approval_requests WHERE resolved_at IS NULL`);
  const refundDecisions = await n(ctx, `SELECT COUNT(*) AS n FROM refunds WHERE status IN ('requested','under_review','recommended')`);
  const openTickets = await n(ctx, `SELECT COUNT(*) AS n FROM tickets WHERE status IN ('open','pending_staff','pending_customer','escalated')`);
  const awaitingStaff = await n(ctx, `SELECT COUNT(*) AS n FROM tickets WHERE status IN ('open','pending_staff','escalated')`);
  const overdueTickets = await n(ctx, `SELECT COUNT(*) AS n FROM tickets WHERE sla_breached_at IS NOT NULL AND first_response_at IS NULL AND status IN ('open','pending_staff','escalated')`);
  const overdueTasks = await n(ctx, `SELECT COUNT(*) AS n FROM tasks WHERE status <> 'done' AND due_at IS NOT NULL AND due_at < ?`, nowIsoStr);
  const pastDue = await n(ctx, `SELECT COUNT(*) AS n FROM subscriptions WHERE status IN ('past_due','unpaid')`);
  const failedEvents = await n(ctx, `SELECT COUNT(*) AS n FROM stripe_events WHERE status IN ('failed','dead_letter')`);
  const failedPayments30 = await n(ctx, `SELECT COUNT(*) AS n FROM payments WHERE status = 'failed' AND created_at >= ?`, iso30);
  const incidents = await n(ctx, `SELECT COUNT(*) AS n FROM blockers WHERE status = 'open' AND category = 'production_incident'`);
  const criticalFindings = await n(ctx, `SELECT COUNT(*) AS n FROM security_findings WHERE status = 'open' AND severity = 'critical'`);
  return { revenueAll, revenue30, succeededCount, mrr, activeSubs, unpricedSubs, activeCustomers, newLeads, activeProjects, customerApprovals, refundDecisions,
    openTickets, awaitingStaff, overdueTickets, overdueTasks, pastDue, failedEvents, failedPayments30, incidents, criticalFindings };
}

export function register(r: Router): void {
  r.get("/staff/owner", async (ctx) => {
    requireStaff(ctx, "finance.read");
    const m = await executiveMetrics(ctx);
    const { input, report } = await ra.loadReport(ctx);
    const feeds = await ra.feedStatuses(ctx, input);
    const feedHealth = ra.overallFeedHealth(feeds);
    const integrations = await ra.integrationRows(ctx.db);
    const rc = await ra.currentReleaseCandidate(ctx.db);
    const launchApproval = (await ra.listApprovals(ctx.db, "production_launch"))[0];
    const launchValid = launchApproval ? ra.validityOf(launchApproval, rc, report.evidenceSetSha256).valid : false;
    const founderPending = rc && !launchValid ? 1 : 0;
    const pendingApprovals = sum(m.customerApprovals, m.refundDecisions, founderPending);
    const paymentFailures = sum(m.pastDue, m.failedEvents, m.failedPayments30);
    const critical = sum(m.incidents, m.criticalFindings);
    const gatesPassing = report.gates.filter((g) => g.status === "pass").length;
    // A tile whose figure is unknown never shows the "nothing recorded" explanation and is flagged.
    const zero = (v: number | null, text: string) => (v === 0 ? text : undefined);
    const tone = (v: number | null, t: "bad" | "warn"): "bad" | "warn" | undefined => (v === null ? "warn" : v ? t : undefined);

    const tiles: Tile[] = [
      { label: "Revenue (all time)", value: show(m.revenueAll, formatCents), href: "/staff/finance", definition: `Sum of ${part(m.succeededCount)} succeeded payments; last 30 days ${part(m.revenue30, formatCents)}. Gross, before refunds and fees.`,
        empty: m.revenueAll !== null ? zero(m.succeededCount, "No succeeded payments have been recorded.") : undefined, tone: m.revenueAll === null ? "warn" : undefined },
      { label: "Recurring revenue (monthly)", value: show(m.mrr, formatCents), href: "/staff/finance/subscriptions", definition: `${part(m.activeSubs)} active subscriptions × their monthly plan price${m.unpricedSubs ? `; ${m.unpricedSubs} without a monthly price are excluded` : ""}.`,
        empty: m.mrr !== null ? zero(m.activeSubs, "No active maintenance subscriptions.") : undefined, tone: m.mrr === null ? "warn" : undefined },
      { label: "Active customers", value: show(m.activeCustomers), href: "/staff/customers", definition: "Customer organizations with a project that is not completed/cancelled, or an active, trialing or past-due subscription.",
        empty: zero(m.activeCustomers, "No customer currently has an active project or subscription."), tone: m.activeCustomers === null ? "warn" : undefined },
      { label: "New leads (30 days)", value: show(m.newLeads), href: "/staff/crm?view=list", definition: "Leads created in the last 30 days, all sources, excluding leads merged as duplicates.", empty: zero(m.newLeads, "No leads in the last 30 days."), tone: m.newLeads === null ? "warn" : undefined },
      { label: "Active projects", value: show(m.activeProjects), href: "/staff/projects", definition: "Projects not completed, cancelled or in maintenance (paused projects included).", empty: zero(m.activeProjects, "No active projects."), tone: m.activeProjects === null ? "warn" : undefined },
      { label: "Pending approvals", value: show(pendingApprovals), href: m.refundDecisions ? "/staff/refunds" : founderPending ? "/staff/readiness/approve" : "/staff/projects",
        definition: `${part(m.customerApprovals)} customer decisions requested, ${part(m.refundDecisions)} refunds awaiting review/decision, ${founderPending} Founder launch decision outstanding.`,
        empty: zero(pendingApprovals, "Nothing is waiting for an approval."), tone: tone(pendingApprovals, "warn") },
      { label: "Support workload", value: show(m.openTickets), href: "/staff/support", definition: `${part(m.awaitingStaff)} awaiting staff, ${part(m.overdueTickets)} past the first-response target.`,
        empty: zero(m.openTickets, "No open support tickets."), tone: m.openTickets === null ? "warn" : m.overdueTickets ? "bad" : m.overdueTickets === null ? "warn" : undefined },
      { label: "Overdue tasks", value: show(m.overdueTasks), href: "/staff/tasks", definition: "Tasks not done whose due date has passed.", empty: zero(m.overdueTasks, "No overdue tasks."), tone: tone(m.overdueTasks, "warn") },
      { label: "Payment failures", value: show(paymentFailures), href: m.pastDue ? "/staff/finance/subscriptions?status=past_due" : "/staff/finance",
        definition: `${part(m.pastDue)} past-due/unpaid subscriptions, ${part(m.failedPayments30)} failed payments (30 days), ${part(m.failedEvents)} Stripe webhook events failed or dead-lettered.`,
        empty: zero(paymentFailures, "No payment failures recorded."), tone: tone(paymentFailures, "bad") },
      { label: "Critical incidents", value: show(critical), href: m.incidents ? "/staff/readiness/blockers" : "/staff/readiness/security", definition: `${part(m.incidents)} open production incidents, ${part(m.criticalFindings)} open critical security findings.`,
        empty: zero(critical, "No open production incidents or critical security findings are recorded."), tone: tone(critical, "bad") },
    ];
    const anyUnknown = tiles.some((t) => t.value === UNKNOWN_FAILED);

    return htmlResponse(ctx, appLayout(ctx, { title: "Executive overview", nav: staffNav(ctx), home: "/staff", area: "Owner command center" }, html`${pageHead("Executive overview", linkButton("Launch readiness", "/staff/readiness", "secondary", "sm"), `As of ${formatDateTime(ctx.now().toISOString())}`)}
<p class="muted">Every figure is computed from stored records at page load. Select a figure for its detail page. Zero means no matching record exists; nothing here is estimated.</p>
${anyUnknown ? alert("warn", html`<strong>Some figures could not be computed.</strong> A tile showing “${UNKNOWN_FAILED}” had a database error; it was recorded under <a href="/staff/monitoring">Monitoring</a> (server error log). The figure is unknown, not zero.`) : ""}
<div class="grid grid-4 kpis exec-grid">${tiles.map(tile)}</div>
<section class="card stack" aria-labelledby="lr-h"><div class="row row--between"><h2 id="lr-h" style="font-size:1.4rem;margin:0">Launch readiness</h2>${linkButton("Open command center", "/staff/readiness", "ghost", "sm")}</div>
${feedHealth.ok ? "" : alert("error", html`<strong>Evidence feeds are not healthy</strong> — readiness figures may be out of date. ${feedHealth.reason}`)}
<p><strong>${report.decision.summary}</strong> <a href="/staff/readiness#gates-h">${gatesPassing} of ${report.gates.length} gates passing</a>.</p>
<div class="table-wrap"><table class="table"><caption class="visually-hidden">Readiness dimensions</caption><thead><tr><th scope="col">Dimension</th><th scope="col" class="num">Count</th><th scope="col" class="num">Percent</th></tr></thead>
<tbody>${DIMENSIONS.map((d) => { const x = report.scores.dimensions[d.key]; return html`<tr><td><a href="/staff/readiness">${d.label}</a></td><td class="num">${x.count} / ${x.total}</td><td class="num">${x.percent}%</td></tr>`; })}</tbody></table></div>
<p class="faint">Separate measurements; no combined score is computed. <a href="/staff/readiness/blockers">${report.blockers.filter((b) => b.status === "open").length} open blockers</a>.</p></section>
<section class="card stack" aria-labelledby="ih-h"><div class="row row--between"><h2 id="ih-h" style="font-size:1.4rem;margin:0">Integration health</h2>${linkButton("Integrations", "/staff/integrations", "ghost", "sm")}</div>
${table(integrations, [{ header: "Integration", cell: (i) => html`<a href="/staff/readiness/env/${i.environment}">${i.integration}</a>` }, { header: "Environment", cell: (i) => label(i.environment) }, { header: "Status", cell: (i) => badge(i.status) }, { header: "Detail", cell: (i) => i.detail ?? "—" }, { header: "Checked", cell: (i) => formatDateTime(i.checked_at) }],
      { empty: alert("warn", "No integration health has been recorded for any environment, so every integration (Stripe, Resend, AI, voice, storage, DNS, monitoring) is unverified.") })}</section>`));
  });
}
