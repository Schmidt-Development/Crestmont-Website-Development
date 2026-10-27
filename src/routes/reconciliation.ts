// Finance → Reconciliation (PAY-009) and imported costs (FIN-002). Registered from hooks.ts.
//  GET  /staff/finance/reconciliation                 ?view=findings|payouts|costs, &scope=checkout|ledger, &kind=, &status=, &q=, &format=csv
//  POST /staff/finance/reconciliation/:id/resolve      typed resolution + note (audited; changes no money state)
//  POST /staff/finance/reconciliation/:id/reopen       re-open a resolved finding with a reason (audited)
// All finance.read. Findings never change invoices or payments: verified webhooks stay the only source of payment truth.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatCents, formatDateTime, label, type SafeHtml } from "../lib/html.ts";
import { download, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { textarea, button, alert, badge, table, emptyState, kpi, pagination, pageParam, pageHead, linkButton, input, csrf, select, tabs } from "../ui/components.ts";
import { staffPage } from "./crm.ts";
import * as rec from "../services/stripe-reconcile.ts";
import * as costs from "../services/cost-import.ts";
import { audit } from "../services/security.ts";

const qp = (ctx: AppContext, k: string, max = 120) => (ctx.url.searchParams.get(k) ?? "").trim().slice(0, max);
const BASE = "/staff/finance/reconciliation";
const cents = (v: number | null) => (v === null ? "—" : formatCents(v));

function head(ctx: AppContext, view: string, errors: string[], reader: ReturnType<typeof rec.stripeReader>): SafeHtml {
  return html`${pageHead("Reconciliation & cost import", linkButton("Revenue", "/staff/finance", "ghost", "sm"), "Finance")}
${reader.ok ? "" : alert("warn", `Stripe-side reconciliation and fee lookup are not running: ${reader.reason}. Online payment is not configured yet, so nothing is compared with Stripe.`)}
${errors.length ? alert("error", errors.join(" ")) : ""}
${tabs([{ href: BASE, label: "Stripe findings", current: view === "findings" }, { href: `${BASE}?view=payouts`, label: "Payouts", current: view === "payouts" }, { href: `${BASE}?view=costs`, label: "Imported costs", current: view === "costs" }])}`;
}

async function costsView(ctx: AppContext, top: SafeHtml, status: number) {
  const { page, limit, offset } = pageParam(ctx);
  const rows = await costs.listCostImports(ctx.db, limit, offset);
  const un = await costs.unattributedAiSummary(ctx.db);
  return staffPage(ctx, "Cost import", html`${top}
<p class="muted">The daily <code>cost_import</code> job imports AI usage (ai_jobs.cost_microusd) and Stripe fees (payments.fee_cents) into project costs exactly once each. AI jobs whose input reference is <code>project:&lt;id&gt;</code>, a ticket linked to a project, or a lead/quote that converted into a project are charged to that project; costs recorded before a lead converted move onto the project when it does. Others stay company-wide AI cost. Unknown amounts stay Unknown, never $0.</p>
<div class="kpis">${kpi("Unattributed AI cost", formatCents(un?.known_cents ?? 0), `${un?.n ?? 0} jobs${un?.unknown ? `, ${un.unknown} with unknown cost` : ""}`)}</div>
${table(rows.slice(0, limit), [
  { header: "Imported", cell: (c) => formatDateTime(c.imported_at) },
  { header: "Source", cell: (c) => c.source === "ai_job" ? `AI job ${c.source_id}` : `Stripe fee, payment ${c.source_id}` },
  { header: "Project", cell: (c) => c.project_id ? html`<a href="/staff/projects/${c.project_id}">${c.project_name ?? c.project_id}</a>` : "—" },
  { header: "Amount", cell: (c) => c.project_cost_id === null ? "—" : c.amount_cents === null ? "Unknown" : formatCents(c.amount_cents), numeric: true },
  { header: "Note", cell: (c) => c.note ?? "—" },
], { empty: emptyState("Nothing imported yet", "Costs appear here after the daily cost import runs and finds AI jobs or Stripe fees.") })}
${pagination(ctx, page, rows.length > limit)}`, status);
}

async function payoutsView(ctx: AppContext, top: SafeHtml, status: number) {
  const { page, limit, offset } = pageParam(ctx);
  const rows = await rec.listPayouts(ctx.db, limit, offset);
  return staffPage(ctx, "Payouts", html`${top}
<p class="muted">The daily <code>stripe_ledger_reconcile</code> job lists Stripe payouts and each payout's balance transactions (read-only), then compares the payout amount with local payments − recorded Stripe fees − refunds. <em>Incomplete</em> means a fee or a matching local record is unknown, so the expected amount cannot be computed — it is never assumed to be $0.</p>
${table(rows.slice(0, limit), [
  { header: "Payout", cell: (p) => html`<code>${p.id}</code><br><span class="faint">created ${formatDateTime(p.stripe_created)}</span>` },
  { header: "Stripe status", cell: (p) => label(p.status) }, { header: "Arrival", cell: (p) => formatDateTime(p.arrival_date) },
  { header: "Amount", cell: (p) => formatCents(p.amount_cents), numeric: true },
  { header: "Transactions net", cell: (p) => cents(p.stripe_net_cents), numeric: true },
  { header: "Expected from local records", cell: (p) => (p.local_expected_cents === null ? "Unknown" : formatCents(p.local_expected_cents)), numeric: true },
  { header: "Matched", cell: (p) => `${p.matched_count} of ${p.txn_count}` },
  { header: "Result", cell: (p) => html`${badge(p.state === "matched" ? "verified" : p.state === "mismatch" || p.state === "failed" ? "failing" : "pending", label(p.state))}${p.detail ? html`<br><span class="faint">${p.detail}</span>` : ""}` },
], { empty: emptyState("No payouts recorded", "Payouts appear after the ledger reconciliation job runs against a connected Stripe account.") })}
${pagination(ctx, page, rows.length > limit)}`, status);
}

async function findingsView(ctx: AppContext, top: SafeHtml, status: number, reader: ReturnType<typeof rec.stripeReader>) {
  const st = ["open", "cleared", "resolved"].includes(qp(ctx, "status")) ? qp(ctx, "status") : "";
  const scope = ["checkout", "ledger"].includes(qp(ctx, "scope")) ? qp(ctx, "scope") : "";
  const kind = qp(ctx, "kind") in rec.FINDING_KINDS ? qp(ctx, "kind") : "";
  const q = qp(ctx, "q", 100);
  if (qp(ctx, "format") === "csv") {
    const csv = await rec.findingsCsv(ctx.db, { status: st || undefined, scope, kind, q });
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "finance.exported", subjectType: "report", subjectId: "reconciliation-findings", details: { status: st, scope, kind, q } });
    return download(ctx, csv, `crestmont-reconciliation-findings-${ctx.now().toISOString().slice(0, 10)}.csv`, "text/csv; charset=utf-8");
  }
  const { page, limit, offset } = pageParam(ctx);
  const rows = await rec.listFindings(ctx.db, { status: st || undefined, scope, kind, q, limit, offset });
  const counts = await rec.findingCounts(ctx.db);
  const open = (s: string) => counts.filter((c) => c.scope === s && c.status === "open").reduce((a, c) => a + c.n, 0);
  const runs = await rec.recentRuns(ctx.db, 6);
  const csvUrl = (() => { const u = new URL(ctx.url); u.searchParams.delete("page"); u.searchParams.set("format", "csv"); return u.pathname + u.search; })();
  return staffPage(ctx, "Reconciliation", html`${top}
<p class="muted">Two daily read-only jobs compare Stripe with local records for the last ${rec.RECONCILE_WINDOW_DAYS} days: <code>stripe_side_reconcile</code> (Checkout Sessions vs invoices, payments, subscriptions) and <code>stripe_ledger_reconcile</code> (Stripe Invoices, balance transactions and payouts vs invoices, payments, fees and refunds). <strong>Findings never change payment state.</strong> Verified Stripe webhooks are the only thing that marks an invoice paid; a finding tells a person where to look. A finding that disappears on a later run is marked <em>cleared</em> automatically.</p>
<div class="kpis">${kpi("Open — checkout", open("checkout"))}${kpi("Open — ledger", open("ledger"), "invoices, balance transactions, payouts")}</div>
<form method="get" class="filters" action="${BASE}">${input({ name: "q", label: "Search", value: q, placeholder: "Stripe id, invoice, payment, customer", maxlength: 100 })}
${select({ name: "status", label: "Status", options: ["open", "cleared", "resolved"], value: st, includeBlank: "Any status" })}
${select({ name: "scope", label: "Compared", options: [{ value: "checkout", label: "Checkout sessions" }, { value: "ledger", label: "Invoices, transactions, payouts" }], value: scope, includeBlank: "Everything" })}
${select({ name: "kind", label: "Discrepancy", options: (Object.keys(rec.FINDING_KINDS) as rec.FindingKind[]).map((k) => ({ value: k, label: rec.FINDING_KINDS[k] })), value: kind, includeBlank: "Any type" })}
<div class="field">${button("Filter", { variant: "secondary", size: "sm" })}</div><div class="field"><a class="btn btn--ghost btn--sm" href="${csvUrl}" data-csv>Export CSV</a></div></form>
${table(rows.slice(0, limit), [
  { header: "Finding", cell: (f) => html`<strong>${rec.FINDING_KINDS[f.kind] ?? f.kind}</strong> <span class="faint">(${f.scope})</span><br><span class="faint">${f.detail}</span>${f.invoice_id ? html`<br><a href="/staff/finance/invoices/${f.invoice_id}">Invoice ${f.invoice_id}</a>` : ""}` },
  { header: "Customer", cell: (f) => f.org_name ?? "—" },
  { header: "Stripe / local", cell: (f) => `${cents(f.stripe_amount_cents)} / ${cents(f.local_amount_cents)}` },
  { header: "Seen", cell: (f) => html`${formatDateTime(f.first_seen_at)}<br><span class="faint">last ${formatDateTime(f.last_seen_at)}${f.reopened_count ? ` · re-opened ${f.reopened_count}×` : ""}</span>` },
  { header: "Status", cell: (f) => f.status === "resolved" ? html`${badge("resolved", "Reviewed")}<br><span class="faint">${f.resolution ? rec.RESOLUTIONS[f.resolution] : ""} — ${f.resolved_by_name ?? ""}: ${f.resolution_note ?? ""}</span>` : badge(f.status === "open" ? "open" : "closed", label(f.status)) },
  { header: "", cell: (f) => f.status !== "resolved"
    ? html`<form method="post" action="${BASE}/${f.id}/resolve" class="stack">${csrf(ctx)}${select({ name: "resolution", id: `res-${f.id}`, label: "Outcome", options: (Object.keys(rec.RESOLUTIONS) as rec.Resolution[]).map((k) => ({ value: k, label: rec.RESOLUTIONS[k] })), value: "no_action_needed" })}${textarea({ name: "note", id: `note-${f.id}`, label: "What you checked / did", rows: 2, maxlength: 1000, required: true })}${button("Mark reviewed", { variant: "secondary", size: "sm" })}</form>`
    : html`<form method="post" action="${BASE}/${f.id}/reopen" class="stack">${csrf(ctx)}${input({ name: "note", id: `reopen-${f.id}`, label: "Reason to re-open", maxlength: 1000, required: true })}${button("Re-open", { variant: "ghost", size: "sm" })}</form>` },
], { empty: emptyState("No reconciliation findings", reader.ok ? "Stripe and local records agree for the period checked." : "Reconciliation has not compared anything because payments are not configured.") })}
${pagination(ctx, page, rows.length > limit)}
<section class="section--tight"><h2>Recent runs</h2>${table(runs, [
  { header: "Started", cell: (x) => formatDateTime(x.started_at) }, { header: "Compared", cell: (x) => (x.scope === "ledger" ? "Invoices, transactions, payouts" : "Checkout sessions") },
  { header: "Status", cell: (x) => badge(x.status === "ok" ? "verified" : x.status === "skipped" ? "not_configured" : x.status === "failed" ? "failing" : "queued", label(x.status)) },
  { header: "Checked", cell: (x) => x.objects_checked, numeric: true }, { header: "New findings", cell: (x) => x.findings_opened, numeric: true }, { header: "Detail", cell: (x) => x.detail ?? "—" },
], { empty: emptyState("No runs yet", "The reconciliation jobs record each run here.") })}</section>`, status);
}

async function reconciliationPage(ctx: AppContext, errors: string[] = [], status = 200) {
  requireStaff(ctx, "finance.read");
  const view = ["costs", "payouts"].includes(qp(ctx, "view")) ? qp(ctx, "view") : "findings";
  const reader = rec.stripeReader(ctx.env);
  const top = head(ctx, view, errors, reader);
  if (view === "costs") return costsView(ctx, top, status);
  if (view === "payouts") return payoutsView(ctx, top, status);
  return findingsView(ctx, top, status, reader);
}

export function registerReconciliation(r: Router): void {
  r.get(BASE, (ctx) => reconciliationPage(ctx));
  r.post(`${BASE}/:id/resolve`, async (ctx, p) => {
    requireStaff(ctx, "finance.read");
    const f = await ctx.form();
    try {
      await rec.resolveFinding(ctx.db, p.id, ctx.user!.id, str(f, "note"), str(f, "resolution") || "no_action_needed");
      return redirect(ctx, BASE, { kind: "success", text: "Finding marked as reviewed. No payment or invoice was changed." });
    } catch (e) {
      if (e instanceof rec.FindingError) return reconciliationPage(ctx, [e.message], 422);
      throw e;
    }
  });
  r.post(`${BASE}/:id/reopen`, async (ctx, p) => {
    requireStaff(ctx, "finance.read");
    try {
      await rec.reopenFinding(ctx.db, p.id, ctx.user!.id, str(await ctx.form(), "note"));
      return redirect(ctx, BASE, { kind: "success", text: "Finding re-opened." });
    } catch (e) {
      if (e instanceof rec.FindingError) return reconciliationPage(ctx, [e.message], 422);
      throw e;
    }
  });
}
