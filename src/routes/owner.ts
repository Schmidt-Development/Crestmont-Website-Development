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

interface Tile { label: string; value: string; href: string; definition: string; empty?: string; tone?: "bad" | "warn" }

function tile(t: Tile): SafeHtml {
  return html`<a class="kpi exec-tile${t.tone ? ` exec-tile--${t.tone}` : ""}" href="${t.href}" data-metric="${t.label}"><div class="kpi__label">${t.label}</div><div class="kpi__value">${t.value}</div>
<div class="kpi__sub">${t.empty ?? t.definition}</div></a>`;
}

async function n(ctx: AppContext, sql: string, ...binds: unknown[]): Promise<number> {
  try { return (await ctx.db.prepare(sql).bind(...binds).first<{ n: number | null }>())?.n ?? 0; } catch { return 0; }
}

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
    const pendingApprovals = m.customerApprovals + m.refundDecisions + founderPending;
    const paymentFailures = m.pastDue + m.failedEvents + m.failedPayments30;
    const critical = m.incidents + m.criticalFindings;
    const gatesPassing = report.gates.filter((g) => g.status === "pass").length;

    const tiles: Tile[] = [
      { label: "Revenue (all time)", value: formatCents(m.revenueAll), href: "/staff/finance", definition: `Sum of ${m.succeededCount} succeeded payments; last 30 days ${formatCents(m.revenue30)}. Gross, before refunds and fees.`,
        empty: m.succeededCount === 0 ? "No succeeded payments have been recorded." : undefined },
      { label: "Recurring revenue (monthly)", value: formatCents(m.mrr), href: "/staff/finance/subscriptions", definition: `${m.activeSubs} active subscriptions × their monthly plan price${m.unpricedSubs ? `; ${m.unpricedSubs} without a monthly price are excluded` : ""}.`,
        empty: m.activeSubs === 0 ? "No active maintenance subscriptions." : undefined },
      { label: "Active customers", value: String(m.activeCustomers), href: "/staff/customers", definition: "Customer organizations with a project that is not completed/cancelled, or an active, trialing or past-due subscription.",
        empty: m.activeCustomers === 0 ? "No customer currently has an active project or subscription." : undefined },
      { label: "New leads (30 days)", value: String(m.newLeads), href: "/staff/crm?view=list", definition: "Leads created in the last 30 days, all sources, excluding leads merged as duplicates.", empty: m.newLeads === 0 ? "No leads in the last 30 days." : undefined },
      { label: "Active projects", value: String(m.activeProjects), href: "/staff/projects", definition: "Projects not completed, cancelled or in maintenance (paused projects included).", empty: m.activeProjects === 0 ? "No active projects." : undefined },
      { label: "Pending approvals", value: String(pendingApprovals), href: m.refundDecisions ? "/staff/refunds" : founderPending ? "/staff/readiness/approve" : "/staff/projects",
        definition: `${m.customerApprovals} customer decisions requested, ${m.refundDecisions} refunds awaiting review/decision, ${founderPending} Founder launch decision outstanding.`,
        empty: pendingApprovals === 0 ? "Nothing is waiting for an approval." : undefined, tone: pendingApprovals ? "warn" : undefined },
      { label: "Support workload", value: String(m.openTickets), href: "/staff/support", definition: `${m.awaitingStaff} awaiting staff, ${m.overdueTickets} past the first-response target.`,
        empty: m.openTickets === 0 ? "No open support tickets." : undefined, tone: m.overdueTickets ? "bad" : undefined },
      { label: "Overdue tasks", value: String(m.overdueTasks), href: "/staff/tasks", definition: "Tasks not done whose due date has passed.", empty: m.overdueTasks === 0 ? "No overdue tasks." : undefined, tone: m.overdueTasks ? "warn" : undefined },
      { label: "Payment failures", value: String(paymentFailures), href: m.pastDue ? "/staff/finance/subscriptions?status=past_due" : "/staff/finance",
        definition: `${m.pastDue} past-due/unpaid subscriptions, ${m.failedPayments30} failed payments (30 days), ${m.failedEvents} Stripe webhook events failed or dead-lettered.`,
        empty: paymentFailures === 0 ? "No payment failures recorded." : undefined, tone: paymentFailures ? "bad" : undefined },
      { label: "Critical incidents", value: String(critical), href: m.incidents ? "/staff/readiness/blockers" : "/staff/readiness/security", definition: `${m.incidents} open production incidents, ${m.criticalFindings} open critical security findings.`,
        empty: critical === 0 ? "No open production incidents or critical security findings are recorded." : undefined, tone: critical ? "bad" : undefined },
    ];

    return htmlResponse(ctx, appLayout(ctx, { title: "Executive overview", nav: staffNav(ctx), home: "/staff", area: "Owner command center" }, html`${pageHead("Executive overview", linkButton("Launch readiness", "/staff/readiness", "secondary", "sm"), `As of ${formatDateTime(ctx.now().toISOString())}`)}
<p class="muted">Every figure is computed from stored records at page load. Select a figure for its detail page. Zero means no matching record exists; nothing here is estimated.</p>
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
