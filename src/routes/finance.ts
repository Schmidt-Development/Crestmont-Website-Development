// Customer billing (portal), refunds & disputes, finance dashboards and accounting exports (area C).
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatCents, formatDate, formatDateTime, label, type SafeHtml } from "../lib/html.ts";
import { HttpError, download, htmlResponse, redirect, str } from "../app/http.ts";
import { requireStaff, requireCustomerOrg } from "../app/app.ts";
import { appLayout } from "../ui/layout.ts";
import { portalNav } from "./nav.ts";
import { csrf, button, linkButton, actionForm, input, textarea, select, checkbox, formErrors, alert, badge, table, emptyState, kpi, pagination, pageParam, dl, pageHead, barChart, nl2br } from "../ui/components.ts";
import { can } from "../domain/authz.ts";
import { MAINTENANCE_PLANS } from "../domain/catalog.ts";
import { REFUND_STATUSES, type RefundStatus } from "../domain/refunds.ts";
import { customerBilling, customerInvoice, startInvoiceCheckout, billingPortalUrl, requestRefund, stripeRedirect, NOT_CONFIGURED } from "../services/billing.ts";
import * as refunds from "../services/refunds.ts";
import * as fin from "../services/finance.ts";
import { audit } from "../services/security.ts";
import { staffPage, definitions, rangeForm } from "./crm.ts";

function portalPage(ctx: AppContext, title: string, body: SafeHtml, status = 200) {
  return htmlResponse(ctx, appLayout(ctx, { title, nav: portalNav(ctx), home: "/portal", area: "Customer portal" }, body), status);
}

const MILESTONE_LABEL: Record<string, string> = { full: "Payment in full", deposit_50: "50% deposit", design_25: "25% design milestone", prelaunch_25: "25% pre-launch", change_order: "Change order", subscription: "Subscription" };
const planName = (id: string) => (id in MAINTENANCE_PLANS ? `${MAINTENANCE_PLANS[id as keyof typeof MAINTENANCE_PLANS].name} maintenance` : label(id));

// ── portal billing ──
async function billingPage(ctx: AppContext, errors: string[] = [], refundValues: Record<string, string> = {}, status = 200) {
  const org = requireCustomerOrg(ctx);
  const b = await customerBilling(ctx.db, org.organizationId);
  const canPay = can(ctx.actor!, "customer.billing", { organizationId: org.organizationId });
  const open = b.invoices.filter((i) => i.status === "open");
  const refundable = b.payments.filter((p) => p.refundable);
  const checkout = ctx.url.searchParams.get("checkout");
  const body = html`${pageHead("Billing", ctx.payments.configured && b.hasStripeCustomer && canPay ? actionForm(ctx, "/portal/billing/manage", "Manage payment methods", { variant: "secondary" }) : undefined, org.organizationName)}
${checkout === "success" ? alert("info", "Thank you. Stripe is confirming your payment — this page updates when the confirmation arrives, usually within a minute. You will also receive a receipt by email.") : ""}
${!ctx.payments.configured ? alert("warn", `${NOT_CONFIGURED} Open invoices cannot be paid online yet; contact us for payment options.`) : ""}
${formErrors(errors)}
<div class="kpis">${kpi("Open invoices", open.length, open.length ? formatCents(open.reduce((s, i) => s + i.amount_cents, 0)) + " due" : "Nothing due")}${kpi("Paid to date", formatCents(b.payments.filter((p) => p.status !== "failed").reduce((s, p) => s + p.amount_cents, 0)))}${kpi("Active plans", b.subscriptions.filter((s) => ["active", "trialing", "past_due"].includes(s.status)).length)}</div>
<section class="card stack"><h2 style="font-size:1.2rem">Invoices</h2>${table(b.invoices, [
    { header: "Invoice", cell: (i) => html`<a href="/portal/billing/invoices/${i.id}">${i.description ?? MILESTONE_LABEL[i.milestone_kind ?? ""] ?? i.id}</a>` },
    { header: "Issued", cell: (i) => formatDate(i.created_at) }, { header: "Status", cell: (i) => badge(i.status) }, { header: "Amount", cell: (i) => formatCents(i.amount_cents), numeric: true },
    { header: "", cell: (i) => (i.status === "open" && canPay && ctx.payments.configured ? actionForm(ctx, `/portal/billing/invoices/${i.id}/pay`, "Pay now", { variant: "primary" }) : i.paid_at ? html`<span class="faint">Paid ${formatDate(i.paid_at)}</span>` : "") }],
    { empty: emptyState("No invoices", "Invoices appear here when you buy a package, accept a proposal or reach a payment milestone.", linkButton("See packages", "/pricing", "secondary")) })}</section>
<section class="card stack"><h2 style="font-size:1.2rem">Receipts</h2>${table(b.payments, [
    { header: "Date", cell: (p) => formatDate(p.created_at) }, { header: "For", cell: (p) => p.description ?? "Payment" }, { header: "Status", cell: (p) => badge(p.status) }, { header: "Amount", cell: (p) => formatCents(p.amount_cents), numeric: true },
    { header: "", cell: (p) => (p.status !== "failed" ? html`<a href="/portal/billing/receipts/${p.id}">Receipt</a>` : "") }], { empty: html`<p class="muted">No payments yet. Payments are recorded when Stripe confirms them.</p>` })}</section>
<section class="card stack"><h2 style="font-size:1.2rem">Orders</h2>${table(b.orders, [{ header: "Order", cell: (o) => o.id }, { header: "Type", cell: (o) => label(o.kind) }, { header: "Placed", cell: (o) => formatDate(o.created_at) }, { header: "Status", cell: (o) => badge(o.status) }, { header: "Total", cell: (o) => formatCents(o.total_cents), numeric: true }], { empty: html`<p class="muted">No orders yet.</p>` })}</section>
<section class="card stack"><h2 style="font-size:1.2rem">Maintenance subscriptions</h2>${table(b.subscriptions, [{ header: "Plan", cell: (s) => planName(s.product_id) }, { header: "Status", cell: (s) => badge(s.status) }, { header: "Current period ends", cell: (s) => formatDate(s.current_period_end) }, { header: "Started", cell: (s) => formatDate(s.created_at) }],
    { empty: html`<p class="muted">No maintenance plan. Plans open for purchase once their entitlements are finalized.</p>` })}
${b.subscriptions.some((s) => s.status === "past_due") ? alert("error", "A maintenance payment failed. Update your payment method to keep your plan active.") : ""}</section>
<section class="card stack"><h2 style="font-size:1.2rem">Refund requests</h2>${table(b.refunds, [{ header: "Requested", cell: (r) => formatDate(r.created_at) }, { header: "Amount", cell: (r) => formatCents(r.amount_cents), numeric: true }, { header: "Reason", cell: (r) => r.reason.slice(0, 120) }, { header: "Status", cell: (r) => badge(r.status) }, { header: "Decided", cell: (r) => formatDate(r.decided_at) }], { empty: html`<p class="muted">No refund requests.</p>` })}
${refundable.length && canPay ? html`<details${errors.length ? html` open` : ""}><summary>Request a refund</summary><form method="post" action="/portal/billing/refund-request" class="stack">${csrf(ctx)}
${select({ name: "payment_id", label: "Payment", options: refundable.map((p) => ({ value: p.id, label: `${formatDate(p.created_at)} — ${p.description ?? "Payment"} — ${formatCents(p.amount_cents)}` })), value: refundValues.payment_id })}
${input({ name: "amount", label: "Amount to refund ($)", value: refundValues.amount, hint: "Leave blank to request the full payment.", inputmode: "decimal" })}
${textarea({ name: "reason", label: "Reason", value: refundValues.reason, rows: 4, required: true })}
${textarea({ name: "evidence", label: "Supporting details (optional)", value: refundValues.evidence, rows: 3 })}
<p class="faint">Support reviews every request. Discretionary refunds are decided by the Founder; legally required refunds are always honored. See the <a href="/legal/refunds">refund policy</a>.</p>
<div class="form-actions">${button("Submit request", { variant: "secondary" })}</div></form></details>` : ""}</section>`;
  return portalPage(ctx, "Billing", body, status);
}

async function invoicePage(ctx: AppContext, id: string) {
  const org = requireCustomerOrg(ctx);
  const inv = await customerInvoice(ctx.db, org.organizationId, id);
  const pays = (await ctx.db.prepare(`SELECT id, amount_cents, status, created_at, stripe_payment_intent_id FROM payments WHERE invoice_id = ? AND organization_id = ? ORDER BY created_at`).bind(inv.id, org.organizationId)
    .all<{ id: string; amount_cents: number; status: string; created_at: string; stripe_payment_intent_id: string | null }>()).results;
  const project = inv.project_id ? await ctx.db.prepare(`SELECT id, name FROM projects WHERE id = ? AND organization_id = ?`).bind(inv.project_id, org.organizationId).first<{ id: string; name: string }>() : null;
  const canPay = can(ctx.actor!, "customer.billing", { organizationId: org.organizationId });
  return portalPage(ctx, "Invoice", html`${pageHead(inv.description ?? MILESTONE_LABEL[inv.milestone_kind ?? ""] ?? "Invoice", html`${badge(inv.status)}${linkButton("All billing", "/portal/billing", "ghost", "sm")}`, `Invoice ${inv.id}`)}
${ctx.url.searchParams.get("checkout") === "cancelled" ? alert("info", "Checkout was cancelled. Nothing was charged.") : ""}
<section class="card stack">${dl([["Organization", org.organizationName], ["Issued", formatDate(inv.created_at)], ["Type", MILESTONE_LABEL[inv.milestone_kind ?? ""] ?? "—"], ["Project", project ? html`<a href="/portal/projects/${project.id}">${project.name}</a>` : "Created after payment"], ["Due", formatDate(inv.due_at)], ["Paid", formatDate(inv.paid_at)]])}
<p class="price">${formatCents(inv.amount_cents)}</p>
${inv.status === "open" ? ctx.payments.configured ? canPay ? html`<form method="post" action="/portal/billing/invoices/${inv.id}/pay">${csrf(ctx)}${button(`Pay ${formatCents(inv.amount_cents)} securely`)}</form><p class="faint">You will be taken to Stripe's secure checkout. Payment is confirmed when Stripe notifies us.</p>` : alert("info", "Ask your account administrator to pay this invoice.")
    : alert("warn", `${NOT_CONFIGURED} Contact us for payment options.`) : ""}</section>
<section class="card"><h2 style="font-size:1.2rem">Payments (receipts)</h2>${table(pays, [{ header: "Date", cell: (p) => formatDateTime(p.created_at) }, { header: "Status", cell: (p) => badge(p.status) }, { header: "Amount", cell: (p) => formatCents(p.amount_cents), numeric: true }, { header: "Reference", cell: (p) => p.stripe_payment_intent_id ?? p.id }, { header: "", cell: (p) => (p.status !== "failed" ? html`<a href="/portal/billing/receipts/${p.id}">Receipt</a>` : "") }], { empty: html`<p class="muted">No payment recorded yet.</p>` })}</section>`);
}

// ── refunds (staff) ──
async function refundsQueue(ctx: AppContext) {
  requireStaff(ctx, "refund.review");
  const status = ctx.url.searchParams.get("status") ?? "";
  const { page, limit, offset } = pageParam(ctx);
  const rows = await refunds.listRefunds(ctx.db, status || undefined, { limit, offset });
  return staffPage(ctx, "Refunds", html`${pageHead("Refund requests", undefined, "Support review → Founder decision → Stripe refund")}
<form method="get" class="filters" action="/staff/refunds">${select({ name: "status", label: "Status", options: [...REFUND_STATUSES], value: status, includeBlank: "Open first (all)" })}<div class="field">${button("Filter", { variant: "secondary", size: "sm" })}</div></form>
${table(rows.slice(0, limit), [
    { header: "Requested", cell: (r) => html`<a href="/staff/refunds/${r.id}">${formatDate(r.created_at)}</a>` }, { header: "Customer", cell: (r) => r.org_name },
    { header: "Amount", cell: (r) => formatCents(r.amount_cents), numeric: true }, { header: "Reason", cell: (r) => r.reason.slice(0, 100) },
    { header: "Status", cell: (r) => html`${badge(r.status)}${r.mandatory_obligation ? html` ${badge("requires_founder_approval", "Mandatory")}` : ""}` }, { header: "Reviewer", cell: (r) => r.reviewer_name ?? "—" }],
    { empty: emptyState("No refund requests", "Customer refund requests from the portal appear here.") })}${pagination(ctx, page, rows.length > limit)}`);
}

async function refundDetail(ctx: AppContext, id: string, errors: string[] = [], status = 200) {
  requireStaff(ctx, "refund.review");
  const r = await refunds.getRefund(ctx.db, id);
  const owner = can(ctx.actor!, "refund.decide");
  const base = `/staff/refunds/${id}`;
  const history = (await ctx.db.prepare(`SELECT a.action, a.created_at, u.display_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.subject_type = 'refund' AND a.subject_id = ? ORDER BY a.id`).bind(id).all<{ action: string; created_at: string; display_name: string | null }>()).results;
  let actions: SafeHtml = html``;
  if (r.status === "requested") actions = html`<form method="post" action="${base}/review" class="stack">${csrf(ctx)}<input type="hidden" name="to" value="under_review">${textarea({ name: "notes", label: "Review notes", rows: 3, required: true })}<div class="form-actions">${button("Start review", { size: "sm" })}</div></form>`;
  else if (r.status === "under_review") actions = html`<form method="post" action="${base}/review" class="stack">${csrf(ctx)}
${textarea({ name: "notes", label: "Review findings", rows: 4, required: true, hint: "Document what was checked and why you recommend this outcome." })}
${checkbox("mandatory", "This refund is required by law or payment-network rules (cannot be denied).", { checked: !!r.mandatory_obligation })}
<div class="form-actions">${button("Recommend refund", { size: "sm", name: "to", value: "recommended" })}${button("Deny", { size: "sm", variant: "danger", name: "to", value: "denied" })}</div></form>`;
  else if (r.status === "recommended") actions = owner ? html`<form method="post" action="${base}/decide" class="stack">${csrf(ctx)}${textarea({ name: "notes", label: "Decision notes", rows: 3, required: true })}
<div class="form-actions">${button("Approve refund", { size: "sm", name: "decision", value: "approved" })}${r.mandatory_obligation ? "" : button("Deny refund", { size: "sm", variant: "danger", name: "decision", value: "denied" })}</div></form>${r.mandatory_obligation ? html`<p class="faint">Marked as a mandatory obligation: it cannot be denied.</p>` : ""}`
    : alert("info", "Awaiting the Founder's decision.");
  else if (r.status === "approved" || r.status === "failed") actions = owner ? html`${!ctx.payments.configured ? alert("warn", `${NOT_CONFIGURED} The refund cannot be issued through Stripe until payments are connected.`) : ""}
${actionForm(ctx, `${base}/issue`, `Issue ${formatCents(r.amount_cents)} refund via Stripe`, { variant: "primary", confirm: "Send this refund through Stripe now?" })}${r.failure_reason ? html`<p class="error-text">Last attempt failed: ${r.failure_reason}</p>` : ""}`
    : alert("info", "Approved — awaiting issue by the Founder.");
  return staffPage(ctx, "Refund request", html`${pageHead(`Refund for ${r.org_name}`, html`${badge(r.status)}${linkButton("Queue", "/staff/refunds", "ghost", "sm")}`, `Refund ${r.id}`)}${formErrors(errors)}
<div class="grid grid-2"><section class="card stack">${dl([["Customer", r.org_name], ["Requested by", `${r.requester_name} <${r.requester_email}>`], ["Requested", formatDateTime(r.created_at)], ["Amount", formatCents(r.amount_cents)], ["Payment", `${formatCents(r.payment_amount_cents)} · ${label(r.payment_status)} · ${r.stripe_payment_intent_id ?? "no Stripe reference"}`],
    ["Mandatory obligation", r.mandatory_obligation ? "Yes" : "No"], ["Reviewer", r.reviewer_name], ["Decided by", r.decider_name], ["Decided", formatDateTime(r.decided_at)], ["Stripe refund", r.stripe_refund_id], ["Issued", formatDateTime(r.issued_at)], ["Customer notified", formatDateTime(r.customer_notified_at)]])}
<h3 style="font-size:1rem">Reason</h3><p>${nl2br(r.reason)}</p>${r.evidence ? html`<h3 style="font-size:1rem">Supporting details</h3><p>${nl2br(r.evidence)}</p>` : ""}
${r.review_notes ? html`<h3 style="font-size:1rem">Review notes</h3><p>${nl2br(r.review_notes)}</p>` : ""}${r.decision_notes ? html`<h3 style="font-size:1rem">Decision notes</h3><p>${nl2br(r.decision_notes)}</p>` : ""}</section>
<section class="stack"><div class="card stack"><h2 style="font-size:1.2rem">Next step</h2>${actions}<p class="faint">AI and automation cannot act on refunds. Every step is recorded in the audit log.</p></div>
<div class="card"><h2 style="font-size:1.2rem">Audit trail</h2>${history.length ? html`<ul class="timeline">${history.map((h) => html`<li><strong>${h.action}</strong> <span class="faint">${formatDateTime(h.created_at)}${h.display_name ? ` · ${h.display_name}` : ""}</span></li>`)}</ul>` : html`<p class="muted">No entries.</p>`}</div></section></div>`, status);
}

async function refundStep(ctx: AppContext, id: string, fn: () => Promise<unknown>, success: string) {
  try { await fn(); }
  catch (e) {
    const st = (e as { status?: number }).status;
    if (st === 422 || st === 409 || st === 502) return refundDetail(ctx, id, [(e as Error).message], st);
    throw e;
  }
  return redirect(ctx, `/staff/refunds/${id}`, { kind: "success", text: success });
}

async function disputesPage(ctx: AppContext) {
  requireStaff(ctx, "finance.read");
  const { page, limit, offset } = pageParam(ctx);
  const rows = await refunds.listDisputes(ctx.db, { limit, offset });
  const soon = new Date(ctx.now().getTime() + 7 * 86400e3).toISOString();
  return staffPage(ctx, "Disputes", html`${pageHead("Disputes", undefined, "Recorded from Stripe dispute webhooks")}
<p class="muted">Respond to disputes with evidence in the Stripe Dashboard before the due date. Rows here are created and updated only by verified Stripe events.</p>
${table(rows.slice(0, limit), [
    { header: "Opened", cell: (d) => formatDate(d.created_at) }, { header: "Customer", cell: (d) => (d.organization_id ? html`<a href="/staff/customers/${d.organization_id}">${d.org_name ?? d.organization_id}</a>` : "Unknown customer") },
    { header: "Amount", cell: (d) => formatCents(d.amount_cents), numeric: true }, { header: "Reason", cell: (d) => (d.reason ? label(d.reason) : "—") }, { header: "Status", cell: (d) => badge(d.status) },
    { header: "Evidence due", cell: (d) => (d.evidence_due_by ? html`<span class="${d.evidence_due_by < soon && !["won", "lost", "closed"].includes(d.status) ? "error-text" : ""}">${formatDateTime(d.evidence_due_by)}</span>` : "—") },
    { header: "Payment", cell: (d) => d.stripe_payment_intent_id ?? d.payment_id ?? "Not matched" }, { header: "Stripe dispute", cell: (d) => d.stripe_dispute_id }],
    { empty: emptyState("No disputes", "Chargebacks reported by Stripe appear here with their evidence deadline.") })}${pagination(ctx, page, rows.length > limit)}`);
}

// ── finance ──
const pct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);

async function financeDashboardPage(ctx: AppContext) {
  requireStaff(ctx, "finance.read");
  const range = fin.parseRange(ctx.url.searchParams, 30, ctx.now());
  const d = await fin.financeDashboard(ctx.db, range);
  const fees = d.fees.unknownCount > 0 ? "Unknown — not yet reconciled" : formatCents(d.fees.known);
  const feeSub = d.fees.unknownCount > 0 ? `${d.fees.unknownCount} of ${d.fees.paymentCount} payments have no fee recorded${d.fees.known ? `; known fees ${formatCents(d.fees.known)}` : ""}` : `${d.fees.paymentCount} payments`;
  return staffPage(ctx, "Revenue", html`${pageHead("Revenue", linkButton("Exports", "/staff/reports", "ghost", "sm"), `${d.range.from} to ${d.range.to}`)}
${rangeForm(ctx, range.from, range.to)}
<div class="kpis">${kpi("Gross revenue", formatCents(d.gross))}${kpi("Refunds", formatCents(d.refunds))}${kpi("Net revenue", formatCents(d.net), "gross − refunds")}${kpi("Stripe fees", fees, feeSub)}
${kpi("Subscription revenue", formatCents(d.subscriptionRevenue))}${kpi("MRR", formatCents(d.mrr), `${d.activeSubscriptions} active subscriptions`)}${kpi("Churn", pct(d.churn.rate), `${d.churn.canceled} canceled / ${d.churn.activeAtStart} active at start`)}
${kpi("Outstanding invoices", formatCents(d.outstanding.cents), `${d.outstanding.count} open`)}${kpi("Average order value", d.aov.cents === null ? "—" : formatCents(d.aov.cents), `${d.aov.orders} paid orders`)}${kpi("Sales conversion", pct(d.conversion.rate), `${d.conversion.converted} of ${d.conversion.created} leads`)}</div>
<div class="grid grid-2"><section class="card"><h2 style="font-size:1.2rem">Gross revenue by month</h2>${d.byMonth.length ? barChart(d.byMonth.map((m) => ({ label: m.month, value: m.cents, display: formatCents(m.cents) }))) : html`<p class="muted">No captured payments in this range.</p>`}</section>
<section class="card"><h2 style="font-size:1.2rem">Revenue by type</h2>${d.byKind.length ? barChart(d.byKind.map((k) => ({ label: MILESTONE_LABEL[k.kind] ?? label(k.kind), value: k.cents, display: formatCents(k.cents) }))) : html`<p class="muted">No captured payments in this range.</p>`}</section></div>
${definitions(fin.FINANCE_DEFINITIONS)}
<p class="faint">This dashboard summarizes internal records. It is not tax or accounting advice; reconcile with Stripe and consult a qualified accountant.</p>`);
}

async function subscriptionsPage(ctx: AppContext) {
  requireStaff(ctx, "finance.read");
  const status = ctx.url.searchParams.get("status") ?? "";
  const valid = ["trialing", "active", "past_due", "canceled", "incomplete", "unpaid"].includes(status) ? status : undefined;
  const { page, limit, offset } = pageParam(ctx);
  const rows = await fin.listSubscriptions(ctx.db, { status: valid, limit, offset });
  return staffPage(ctx, "Subscriptions", html`${pageHead("Subscriptions", undefined, "Finance")}
<form method="get" class="filters" action="/staff/finance/subscriptions">${select({ name: "status", label: "Status", options: ["trialing", "active", "past_due", "canceled", "incomplete", "unpaid"], value: valid, includeBlank: "Any status" })}<div class="field">${button("Filter", { variant: "secondary", size: "sm" })}</div></form>
${table(rows.slice(0, limit), [{ header: "Customer", cell: (s) => html`<a href="/staff/customers/${s.organization_id}">${s.org_name}</a>` }, { header: "Plan", cell: (s) => planName(s.product_id) },
    { header: "Monthly", cell: (s) => formatCents(fin.planMonthlyCents(s.product_id)), numeric: true }, { header: "Status", cell: (s) => badge(s.status) }, { header: "Period ends", cell: (s) => formatDate(s.current_period_end) },
    { header: "Started", cell: (s) => formatDate(s.created_at) }, { header: "Stripe", cell: (s) => s.stripe_subscription_id ?? "—" }],
    { empty: emptyState("No subscriptions", "Maintenance subscriptions are created by Stripe webhooks after checkout. Plan sales open once the Founder approves entitlements.") })}${pagination(ctx, page, rows.length > limit)}`);
}

async function invoicesPage(ctx: AppContext) {
  requireStaff(ctx, "finance.read");
  const status = ctx.url.searchParams.get("status") ?? "";
  const valid = ["draft", "open", "paid", "void", "uncollectible"].includes(status) ? status : undefined;
  const hasRange = ctx.url.searchParams.has("from") || ctx.url.searchParams.has("to");
  const range = hasRange ? fin.parseRange(ctx.url.searchParams, 30, ctx.now()) : undefined;
  const { page, limit, offset } = pageParam(ctx);
  const rows = await fin.listInvoices(ctx.db, { status: valid, range, limit, offset });
  return staffPage(ctx, "Invoices", html`${pageHead("Invoices", undefined, "Finance")}
${rangeForm(ctx, range?.from ?? "", range?.to ?? "", select({ name: "status", label: "Status", options: ["draft", "open", "paid", "void", "uncollectible"], value: valid, includeBlank: "Any status" }))}
${table(rows.slice(0, limit), [{ header: "Issued", cell: (i) => formatDate(i.created_at) }, { header: "Customer", cell: (i) => html`<a href="/staff/customers/${i.organization_id}">${i.org_name}</a>` },
    { header: "Description", cell: (i) => i.description ?? MILESTONE_LABEL[i.milestone_kind ?? ""] ?? "—" }, { header: "Status", cell: (i) => badge(i.status) }, { header: "Amount", cell: (i) => formatCents(i.amount_cents), numeric: true },
    { header: "Paid", cell: (i) => formatDate(i.paid_at) }, { header: "Project", cell: (i) => (i.project_id ? html`<a href="/staff/projects/${i.project_id}">View</a>` : "—") }],
    { empty: emptyState("No invoices", "Invoices are created by purchases, accepted quotes, milestones and change orders.") })}${pagination(ctx, page, rows.length > limit)}`);
}

async function profitabilityPage(ctx: AppContext, errors: string[] = [], v: Record<string, string> = {}, status = 200) {
  requireStaff(ctx, "finance.read");
  const rows = await fin.projectProfitability(ctx.db);
  const projects = rows.map((p) => ({ value: p.projectId, label: `${p.name}` }));
  const unknownAll = rows.flatMap((p) => p.unknown.map((u) => ({ ...u, project: p.name })));
  return staffPage(ctx, "Profitability", html`${pageHead("Project profitability", linkButton("Export CSV", "/staff/reports/profitability.csv", "ghost", "sm"), "Finance")}
${table(rows, [{ header: "Project", cell: (p) => html`<a href="/staff/projects/${p.projectId}">${p.name}</a><br><span class="faint">${p.organization}</span>` }, { header: "Status", cell: (p) => badge(p.status) },
    { header: "Revenue (paid)", cell: (p) => formatCents(p.revenueCents), numeric: true }, { header: "Known costs", cell: (p) => formatCents(p.knownCostCents), numeric: true },
    { header: "Profit", cell: (p) => (p.profitCents === null ? html`<span class="badge badge--warn">Incomplete — unknown costs</span>` : formatCents(p.profitCents)), numeric: true }],
    { empty: emptyState("No projects yet", "Projects are provisioned when Stripe confirms the first payment.") })}
${unknownAll.length ? html`<section class="card"><h2 style="font-size:1.2rem">Unknown costs (${unknownAll.length})</h2><p class="muted">These items have no amount recorded, so profit for their projects cannot be calculated. Record the real amount when it is known.</p>
${table(unknownAll, [{ header: "Project", cell: (u) => u.project }, { header: "Item", cell: (u) => u.description }, { header: "Date", cell: (u) => u.date.slice(0, 10) }, { header: "Source", cell: (u) => label(u.source) }])}</section>` : ""}
<section class="card stack" style="max-width:720px"><h2 style="font-size:1.2rem">Record a cost</h2>${formErrors(errors)}
<form method="post" action="/staff/finance/costs" class="stack">${csrf(ctx)}
${select({ name: "project_id", label: "Project", options: projects, value: v.project_id, includeBlank: "Business overhead (no project)" })}
${select({ name: "category", label: "Category", options: [...fin.COST_CATEGORIES], value: v.category })}
${input({ name: "amount", label: "Amount ($)", value: v.amount, inputmode: "decimal", hint: "Leave blank if the amount is not known yet — it will be shown as Unknown, never as $0." })}
${input({ name: "description", label: "Description", value: v.description, required: true })}${input({ name: "incurred_on", label: "Date incurred", type: "date", value: v.incurred_on, required: true })}
<div class="form-actions">${button("Record cost", { size: "sm" })}</div></form></section>
${definitions([["Revenue", "Sum of paid invoices linked to the project."], ["Known costs", "project_costs with an amount + time entries × hourly cost (minutes ÷ 60 × hourly_cost_cents)."], ["Profit", "Revenue − known costs. If any cost or hourly rate is unknown, profit is marked Incomplete rather than computed."]])}`, status);
}

async function reportsPage(ctx: AppContext) {
  requireStaff(ctx, "finance.read");
  const range = fin.parseRange(ctx.url.searchParams, 30, ctx.now());
  const q = `?from=${range.from}&to=${range.to}`;
  const desc: Record<fin.ExportKind, string> = {
    transactions: "Every payment recorded from Stripe, with fee status (unknown fees are blank and flagged).",
    invoices: "Invoices issued in the range with paid dates and status.",
    refunds: "Refund requests created in the range with decision, issue date and Stripe reference.",
    subscriptions: "Subscriptions active at any point in the range, with monthly price and cancel date.",
    profitability: "All projects: revenue, known costs, count of unknown cost items, profit status (date range not applied).",
  };
  return staffPage(ctx, "Reports", html`${pageHead("Accounting exports", undefined, "Finance")}
${rangeForm(ctx, range.from, range.to)}
${table([...fin.EXPORT_KINDS], [{ header: "Export", cell: (k) => label(k) }, { header: "Contents", cell: (k) => desc[k] }, { header: "", cell: (k) => linkButton("Download CSV", `/staff/reports/${k}.csv${q}`, "secondary", "sm") }])}
<p class="muted">CSV files use ISO dates (YYYY-MM-DD, UTC), integer cents and plain decimal dollar columns. Cells beginning with =, +, - or @ are prefixed with an apostrophe to prevent spreadsheet formula execution.</p>
${alert("info", "These exports summarize Crestmont's internal records. They are not tax or accounting advice. Reconcile against Stripe payouts and consult a qualified accountant.")}`);
}

export function register(r: Router): void {
  // portal billing
  r.get("/portal/billing", (ctx) => billingPage(ctx));
  r.get("/portal/billing/invoices/:id", (ctx, p) => invoicePage(ctx, p.id));
  r.post("/portal/billing/invoices/:id/pay", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    if (!can(ctx.actor!, "customer.billing", { organizationId: org.organizationId })) throw new HttpError(403, "Only an account administrator can pay invoices.");
    const res = await startInvoiceCheckout(ctx, { id: ctx.user!.id, email: ctx.user!.email }, org.organizationId, p.id);
    return stripeRedirect(ctx, res.url);
  });
  r.post("/portal/billing/manage", async (ctx) => {
    const org = requireCustomerOrg(ctx);
    if (!can(ctx.actor!, "customer.billing", { organizationId: org.organizationId })) throw new HttpError(403, "Only an account administrator can manage payment methods.");
    return stripeRedirect(ctx, await billingPortalUrl(ctx, org.organizationId));
  });
  r.post("/portal/billing/refund-request", async (ctx) => {
    const org = requireCustomerOrg(ctx);
    if (!can(ctx.actor!, "customer.billing", { organizationId: org.organizationId })) throw new HttpError(403, "Only an account administrator can request refunds.");
    const f = await ctx.form();
    const v = { payment_id: str(f, "payment_id"), amount: str(f, "amount"), reason: str(f, "reason"), evidence: str(f, "evidence") };
    const amt = fin.parseDollars(v.amount);
    const res = await requestRefund(ctx, { id: ctx.user!.id, email: ctx.user!.email }, org.organizationId, { paymentId: v.payment_id, reason: v.reason, evidence: v.evidence, amountCents: amt });
    if (!res.ok) return billingPage(ctx, res.issues, v, 422);
    return redirect(ctx, "/portal/billing", { kind: "success", text: "Refund request submitted. We will email you when it is reviewed." });
  });

  // refunds & disputes
  r.get("/staff/refunds", refundsQueue);
  r.get("/staff/refunds/:id", (ctx, p) => refundDetail(ctx, p.id));
  r.post("/staff/refunds/:id/review", async (ctx, p) => {
    requireStaff(ctx, "refund.review");
    const f = await ctx.form();
    const to = str(f, "to") as RefundStatus;
    return refundStep(ctx, p.id, () => refunds.reviewRefund(ctx, ctx.actor!, p.id, to, { notes: str(f, "notes"), mandatoryObligation: f.has("mandatory") ? true : undefined }), `Refund moved to ${label(to)}.`);
  });
  r.post("/staff/refunds/:id/decide", async (ctx, p) => {
    requireStaff(ctx, "refund.decide");
    const f = await ctx.form();
    const decision = str(f, "decision") === "approved" ? "approved" : "denied";
    return refundStep(ctx, p.id, () => refunds.decideRefund(ctx, ctx.actor!, p.id, decision, str(f, "notes")), `Refund ${decision}.`);
  });
  r.post("/staff/refunds/:id/issue", async (ctx, p) => {
    requireStaff(ctx, "refund.issue");
    return refundStep(ctx, p.id, () => refunds.issueRefund(ctx, ctx.actor!, p.id), "Refund issued through Stripe.");
  });
  r.get("/staff/disputes", disputesPage);

  // finance
  r.get("/staff/finance", financeDashboardPage);
  r.get("/staff/finance/subscriptions", subscriptionsPage);
  r.get("/staff/finance/invoices", invoicesPage);
  r.get("/staff/finance/profitability", (ctx) => profitabilityPage(ctx));
  r.post("/staff/finance/costs", async (ctx) => {
    requireStaff(ctx, "finance.read");
    const f = await ctx.form();
    const v = { project_id: str(f, "project_id"), category: str(f, "category"), amount: str(f, "amount"), description: str(f, "description"), incurred_on: str(f, "incurred_on") };
    const amt = fin.parseDollars(v.amount);
    if (Number.isNaN(amt)) return profitabilityPage(ctx, ["Amount must be a dollar amount like 120 or 120.50, or blank if unknown"], v, 422);
    const res = await fin.addCost(ctx.db, ctx.user!.id, { projectId: v.project_id || null, category: v.category, amountCents: amt, description: v.description, incurredOn: v.incurred_on });
    if (!res.ok) return profitabilityPage(ctx, res.issues, v, 422);
    return redirect(ctx, "/staff/finance/profitability", { kind: "success", text: amt === null ? "Cost recorded as Unknown." : "Cost recorded." });
  });
  r.get("/staff/reports", reportsPage);
  r.get("/staff/reports/:file", async (ctx, p) => {
    requireStaff(ctx, "finance.read");
    const kind = p.file.replace(/\.csv$/, "") as fin.ExportKind;
    if (!p.file.endsWith(".csv") || !(fin.EXPORT_KINDS as readonly string[]).includes(kind)) throw new HttpError(404, "Unknown export.");
    const range = fin.parseRange(ctx.url.searchParams, 30, ctx.now());
    const csv = await fin.exportCsv(ctx.db, kind, range);
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "finance.exported", subjectType: "report", subjectId: kind, details: { from: range.from, to: range.to } });
    return download(ctx, csv, `crestmont-${kind}-${range.from}-to-${range.to}.csv`, "text/csv; charset=utf-8");
  });
}

