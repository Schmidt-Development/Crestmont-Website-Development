// Customer portal maintenance services view (PORTAL-001, CAT-006): the organization's maintenance
// plan(s) and status, the plan's entitlements exactly as the catalog states them (labelled proposed
// until the Founder approves them), the sites under care, and this organization's maintenance
// requests. Read-only over org-scoped records; requests are made through support tickets.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatCents, formatDate, formatDateTime, label, safeUrl } from "../lib/html.ts";
import { htmlResponse } from "../app/http.ts";
import { requireCustomerOrg } from "../app/app.ts";
import { appLayout } from "../ui/layout.ts";
import { alert, badge, dl, emptyState, kpi, linkButton, pageHead, table } from "../ui/components.ts";
import { portalNav } from "./nav.ts";
import { MAINTENANCE_PLANS, type MaintenanceId } from "../domain/catalog.ts";
import { effectivePrice } from "../services/pricing-approvals.ts";

async function maintenancePage(ctx: AppContext) {
  const org = requireCustomerOrg(ctx);
  const db = ctx.db;
  const subs = (await db.prepare(`SELECT s.id, s.product_id, s.status, s.current_period_end, s.created_at FROM subscriptions s WHERE s.organization_id = ? ORDER BY CASE WHEN s.status IN ('active','trialing','past_due') THEN 0 ELSE 1 END, s.created_at DESC`)
    .bind(org.organizationId).all<{ id: string; product_id: string; status: string; current_period_end: string | null; created_at: string }>()).results;
  const sites = (await db.prepare(`SELECT p.id, p.name, p.status, p.live_url, p.completed_at, (SELECT d.url FROM customer_deployments d WHERE d.project_id = p.id ORDER BY d.deployed_at DESC LIMIT 1) AS deployed_url,
      (SELECT d.deployed_at FROM customer_deployments d WHERE d.project_id = p.id ORDER BY d.deployed_at DESC LIMIT 1) AS deployed_at
    FROM projects p WHERE p.organization_id = ? AND p.status IN ('completed','maintenance') ORDER BY p.completed_at DESC`).bind(org.organizationId)
    .all<{ id: string; name: string; status: string; live_url: string | null; completed_at: string | null; deployed_url: string | null; deployed_at: string | null }>()).results;
  const monthStart = `${ctx.now().toISOString().slice(0, 7)}-01T00:00:00.000Z`;
  const requests = (await db.prepare(`SELECT t.id, t.subject, t.category, t.status, t.created_at, t.resolved_at FROM tickets t WHERE t.organization_id = ? AND t.category IN ('content_change','technical') ORDER BY t.created_at DESC LIMIT 25`)
    .bind(org.organizationId).all<{ id: string; subject: string; category: string; status: string; created_at: string; resolved_at: string | null }>()).results;
  const thisMonth = (await db.prepare(`SELECT category, COUNT(*) AS n FROM tickets WHERE organization_id = ? AND category IN ('content_change','technical') AND created_at >= ? GROUP BY category`)
    .bind(org.organizationId, monthStart).all<{ category: string; n: number }>()).results;
  const count = (c: string) => thisMonth.find((x) => x.category === c)?.n ?? 0;
  const open = requests.filter((r) => !["resolved", "closed"].includes(r.status)).length;
  const active = subs.find((s) => ["active", "trialing", "past_due"].includes(s.status));
  const planOf = (id: string) => (id in MAINTENANCE_PLANS ? MAINTENANCE_PLANS[id as MaintenanceId] : null);
  const activePlan = active ? planOf(active.product_id) : null;
  const price = activePlan ? (await effectivePrice(db, "maintenance", activePlan.id, ctx.now())).cents : null;

  const body = html`${pageHead("Maintenance", linkButton("Request a change", `/portal/support/new?category=content_change`, "primary", "sm"), org.organizationName)}
<div class="kpis">${kpi("Plan", activePlan ? `${activePlan.name}` : "None", active ? label(active.status) : "No active maintenance plan")}${kpi("Next renewal", active?.current_period_end ? formatDate(active.current_period_end) : "—")}
${kpi("Sites under care", sites.length)}${kpi("Open maintenance requests", open)}${kpi("Content changes this month", count("content_change"), `${count("technical")} technical request${count("technical") === 1 ? "" : "s"} this month`)}</div>
${active?.status === "past_due" ? alert("error", html`A maintenance payment failed. <a href="/portal/billing">Update your payment method</a> to keep your plan active.`) : ""}
${activePlan ? html`<section class="card"><h2 class="card__title">${activePlan.name} plan${price !== null ? html` · ${formatCents(price)}/month` : ""}</h2>
${activePlan.entitlementsStatus === "approved" ? "" : alert("warn", "These entitlements are proposed and awaiting Founder approval. They are shown exactly as proposed; nothing here is a commitment until approved.")}
${dl(Object.entries(activePlan.proposedEntitlements).map(([k, v]) => [label(k), v]))}
<p class="faint">Usage against allowances is reviewed by our team from your requests; the counts above are the requests you have opened this calendar month.</p></section>`
    : html`<section class="card">${emptyState("No active maintenance plan", "A maintenance plan covers hosting, updates, monitoring, backups and small content changes after launch. You can still request help through support at any time.", html`<div class="row" style="justify-content:center">${linkButton("See maintenance plans", "/hosting-maintenance", "secondary")}${linkButton("Contact support", "/portal/support/new", "ghost")}</div>`)}</section>`}
<section class="section--tight"><h2>Sites under care</h2>${table(sites, [
    { header: "Site", cell: (p) => html`<a href="/portal/projects/${p.id}">${p.name}</a>` },
    { header: "Address", cell: (p) => { const u = p.live_url ?? p.deployed_url; return u ? html`<a href="${safeUrl(u)}" rel="noopener noreferrer" target="_blank">${u}</a>` : "—"; } },
    { header: "Status", cell: (p) => badge(p.status === "maintenance" ? "active" : "completed", p.status === "maintenance" ? "In maintenance" : "Completed") },
    { header: "Launched", cell: (p) => formatDate(p.deployed_at ?? p.completed_at) },
  ], { empty: html`<p class="muted">No launched sites yet. Sites appear here once a project is completed.</p>`, caption: "Sites under care" })}</section>
<section class="section--tight"><h2>Maintenance requests</h2>${table(requests, [
    { header: "Request", cell: (t) => html`<a href="/portal/support/${t.id}">${t.subject}</a>` }, { header: "Type", cell: (t) => label(t.category) },
    { header: "Status", cell: (t) => badge(t.status) }, { header: "Opened", cell: (t) => formatDateTime(t.created_at) }, { header: "Resolved", cell: (t) => formatDateTime(t.resolved_at) },
  ], { empty: html`<p class="muted">No maintenance requests yet. Use “Request a change” for content updates, or open a technical ticket.</p>`, caption: "Maintenance requests" })}</section>
${subs.length > 1 || (subs.length === 1 && !active) ? html`<section class="section--tight"><h2>Plan history</h2>${table(subs, [
    { header: "Plan", cell: (s) => planOf(s.product_id)?.name ?? label(s.product_id) }, { header: "Status", cell: (s) => badge(s.status) }, { header: "Started", cell: (s) => formatDate(s.created_at) }, { header: "Period end", cell: (s) => formatDate(s.current_period_end) },
  ], { caption: "Plan history" })}</section>` : ""}`;
  return htmlResponse(ctx, appLayout(ctx, { title: "Maintenance", nav: portalNav(ctx), home: "/portal", area: "Customer portal" }, body));
}

export function register(r: Router): void {
  r.get("/portal/maintenance", (ctx) => maintenancePage(ctx));
}
