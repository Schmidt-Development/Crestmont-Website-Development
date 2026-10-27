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
import * as docs from "../services/finance-documents.ts";
import { createStripeMilestoneInvoice, stripeInvoicer, stripeInvoiceBlocker, STRIPE_INVOICE_KINDS } from "../services/stripe-invoices.ts";
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
<div class="kpis">${kpi("Open invoices", open.length, open.length ? formatCents(open.reduce((s, i) => s + i.amount_cents, 0)) + " due" : "Nothing due")}${kpi("Paid to date", formatCents(b.payments.filter((p) => p.status !== "failed").reduce((s, p) => s + p.amount_cents, 0)), b.refunds.some((r) => r.status === "issued") ? `${formatCents(b.refunds.filter((r) => r.status === "issued").reduce((s, r) => s + r.amount_cents, 0))} refunded` : undefined)}${kpi("Active plans", b.subscriptions.filter((s) => ["active", "trialing", "past_due"].includes(s.status)).length)}</div>
<section class="card stack"><h2 style="font-size:1.2rem">Invoices</h2>${table(b.invoices, [
    { header: "Invoice", cell: (i) => html`<a href="/portal/billing/invoices/${i.id}">${i.description ?? MILESTONE_LABEL[i.milestone_kind ?? ""] ?? i.id}</a>` },
    { header: "Issued", cell: (i) => formatDate(i.created_at) }, { header: "Status", cell: (i) => badge(i.status) }, { header: "Amount", cell: (i) => formatCents(i.amount_cents), numeric: true },
    { header: "", cell: (i) => html`${i.status === "open" && canPay && stripeInvoiceLink(i) ? html`<a class="btn btn--primary btn--sm" href="${stripeInvoiceLink(i)!}" rel="noopener">Pay Stripe invoice</a>`
      : i.status === "open" && canPay && ctx.payments.configured ? actionForm(ctx, `/portal/billing/invoices/${i.id}/pay`, "Pay now", { variant: "primary" }) : i.paid_at ? html`<span class="faint">Paid ${formatDate(i.paid_at)}</span>` : ""}
      <a href="/portal/billing/invoices/${i.id}/pdf" data-pdf>PDF</a>` }],
    { empty: emptyState("No invoices", "Invoices appear here when you buy a package, accept a proposal or reach a payment milestone.", linkButton("See packages", "/pricing", "secondary")) })}</section>
<section class="card stack"><h2 style="font-size:1.2rem">Receipts</h2>${table(b.payments, [
    { header: "Date", cell: (p) => formatDate(p.created_at) }, { header: "For", cell: (p) => p.description ?? "Payment" }, { header: "Status", cell: (p) => badge(p.status) }, { header: "Amount", cell: (p) => formatCents(p.amount_cents), numeric: true },
    { header: "", cell: (p) => (p.status !== "failed" ? html`<a href="/portal/billing/receipts/${p.id}">Receipt</a> · <a href="/portal/billing/receipts/${p.id}/pdf">PDF</a>` : "") }], { empty: html`<p class="muted">No payments yet. Payments are recorded when Stripe confirms them.</p>` })}</section>
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
  const hosted = stripeInvoiceLink(inv);
  const payBlock = inv.status !== "open" ? html``
    : !canPay ? alert("info", "Ask your account administrator to pay this invoice.")
    : hosted ? html`<a class="btn btn--primary" href="${hosted}" rel="noopener">Pay ${formatCents(inv.amount_cents)} — Stripe invoice</a><p class="faint">This invoice is billed through a Stripe invoice. Payment is confirmed when Stripe notifies us.</p>`
    : ctx.payments.configured ? html`<form method="post" action="/portal/billing/invoices/${inv.id}/pay">${csrf(ctx)}${button(`Pay ${formatCents(inv.amount_cents)} securely`)}</form><p class="faint">You will be taken to Stripe's secure checkout. Payment is confirmed when Stripe notifies us.</p>`
    : alert("warn", `${NOT_CONFIGURED} Contact us for payment options.`);
  return portalPage(ctx, "Invoice", html`${pageHead(inv.description ?? MILESTONE_LABEL[inv.milestone_kind ?? ""] ?? "Invoice", html`${badge(inv.status)}${linkButton("Download PDF", `/portal/billing/invoices/${inv.id}/pdf`, "secondary", "sm")}${linkButton("All billing", "/portal/billing", "ghost", "sm")}`, `Invoice ${inv.id}`)}
${ctx.url.searchParams.get("checkout") === "cancelled" ? alert("info", "Checkout was cancelled. Nothing was charged.") : ""}
<section class="card stack">${dl([["Organization", org.organizationName], ["Issued", formatDate(inv.created_at)], ["Type", MILESTONE_LABEL[inv.milestone_kind ?? ""] ?? "—"], ["Project", project ? html`<a href="/portal/projects/${project.id}">${project.name}</a>` : "Created after payment"], ["Due", formatDate(inv.due_at)], ["Paid", formatDate(inv.paid_at)]])}
<p class="price">${formatCents(inv.amount_cents)}</p>
${payBlock}</section>
<section class="card"><h2 style="font-size:1.2rem">Payments (receipts)</h2>${table(pays, [{ header: "Date", cell: (p) => formatDateTime(p.created_at) }, { header: "Status", cell: (p) => badge(p.status) }, { header: "Amount", cell: (p) => formatCents(p.amount_cents), numeric: true }, { header: "Reference", cell: (p) => p.stripe_payment_intent_id ?? p.id }, { header: "", cell: (p) => (p.status !== "failed" ? html`<a href="/portal/billing/receipts/${p.id}">Receipt</a> · <a href="/portal/billing/receipts/${p.id}/pdf">PDF</a>` : "") }], { empty: html`<p class="muted">No payment recorded yet.</p>` })}</section>`);
}

/** The Stripe-hosted invoice URL for an open Stripe invoice, only if it is an https stripe.com address. */
function stripeInvoiceLink(i: { stripe_invoice_status?: string | null; stripe_hosted_invoice_url?: string | null }): string | null {
  if (i.stripe_invoice_status !== "open" || !i.stripe_hosted_invoice_url) return null;
  try {
    const u = new URL(i.stripe_hosted_invoice_url);
    return u.protocol === "https:" && /(^|\.)stripe\.com$/.test(u.hostname) ? u.toString() : null;
  } catch { return null; }
}

// ── PDF downloads (PAY-005): staff with finance.read, or members of the owning organization only ──
async function pdfDownload(ctx: AppContext, kind: "invoice" | "receipt", id: string, staff: boolean): Promise<Response> {
  let orgScope: string | null = null;
  if (staff) requireStaff(ctx, "finance.read");
  else orgScope = requireCustomerOrg(ctx).organizationId;
  const at = ctx.now();
  let bytes: Uint8Array<ArrayBuffer>, filename: string, organizationId: string, number: string;
  if (kind === "invoice") {
    const d = await docs.loadInvoiceDoc(ctx.db, id, orgScope); // 404 for another organization's invoice
    bytes = docs.invoicePdf(d, ctx.settings, at);
    filename = `crestmont-invoice-${d.invoice.id}.pdf`; organizationId = d.organization.id; number = d.invoice.id;
  } else {
    const r = await docs.loadReceiptDoc(ctx.db, id, orgScope);
    bytes = docs.receiptPdf(r, ctx.settings, at);
    filename = `crestmont-receipt-${r.receiptNumber}.pdf`; organizationId = r.organization.id; number = r.receiptNumber;
  }
  await audit(ctx.db, { actorUserId: ctx.user!.id, action: `${kind}.pdf_downloaded`, subjectType: kind === "invoice" ? "invoice" : "payment", subjectId: id, organizationId, ip: ctx.ip, details: { number, bytes: bytes.length, via: staff ? "staff" : "portal" } });
  return download(ctx, bytes, filename, "application/pdf");
}

// ── shared list toolbar: search + filters + CSV export of the filtered list (Owner finance modules) ──
const wantsCsv = (ctx: AppContext) => ctx.url.searchParams.get("format") === "csv";
function csvHref(ctx: AppContext): string {
  const u = new URL(ctx.url);
  u.searchParams.delete("page");
  u.searchParams.set("format", "csv");
  return u.pathname + u.search;
}
function listToolbar(ctx: AppContext, action: string, filters: SafeHtml, searchLabel: string): SafeHtml {
  return html`<form method="get" class="filters" action="${action}">${input({ name: "q", label: "Search", value: fin.searchParam(ctx.url.searchParams), placeholder: searchLabel, maxlength: 100 })}${filters}
<div class="field">${button("Filter", { variant: "secondary", size: "sm" })}</div><div class="field"><a class="btn btn--ghost btn--sm" href="${csvHref(ctx)}" data-csv>Export CSV</a></div></form>`;
}
async function csvResponse(ctx: AppContext, csv: string, name: string, rows: number): Promise<Response> {
  await audit(ctx.db, { actorUserId: ctx.user!.id, action: "finance.exported", subjectType: "report", subjectId: name, details: { rows, query: ctx.url.search.slice(0, 300) } });
  return download(ctx, csv, `crestmont-${name}-${ctx.now().toISOString().slice(0, 10)}.csv`, "text/csv; charset=utf-8");
}

// ── refunds (staff) ──
async function refundsQueue(ctx: AppContext) {
  requireStaff(ctx, "refund.review");
  const status = ctx.url.searchParams.get("status") ?? "";
  const q = fin.searchParam(ctx.url.searchParams);
  if (wantsCsv(ctx)) {
    const all = await refunds.listRefunds(ctx.db, status || undefined, { limit: fin.LIST_EXPORT_LIMIT, offset: 0 }, q);
    return csvResponse(ctx, fin.toCsv(["refund_id", "requested", "customer", "requested_by", "payment_id", "stripe_payment_intent", "amount_cents", "amount_usd", "status", "mandatory_obligation", "reviewer", "decided_by", "decided", "issued", "stripe_refund", "reason"],
      all.slice(0, fin.LIST_EXPORT_LIMIT).map((r) => [r.id, r.created_at.slice(0, 10), r.org_name, r.requester_email, r.payment_id, r.stripe_payment_intent_id, r.amount_cents, fin.dollars(r.amount_cents), r.status, r.mandatory_obligation ? "yes" : "no", r.reviewer_name, r.decider_name, r.decided_at?.slice(0, 10) ?? "", r.issued_at?.slice(0, 10) ?? "", r.stripe_refund_id, r.reason])), "refund-requests", all.length);
  }
  const { page, limit, offset } = pageParam(ctx);
  const rows = await refunds.listRefunds(ctx.db, status || undefined, { limit, offset }, q);
  return staffPage(ctx, "Refunds", html`${pageHead("Refund requests", undefined, "Support review → Founder decision → Stripe refund")}
${listToolbar(ctx, "/staff/refunds", select({ name: "status", label: "Status", options: [...REFUND_STATUSES], value: status, includeBlank: "Open first (all)" }), "Customer, email, reason, payment")}
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
  const state = ["open", "closed"].includes(ctx.url.searchParams.get("state") ?? "") ? ctx.url.searchParams.get("state")! : "";
  const q = fin.searchParam(ctx.url.searchParams);
  if (wantsCsv(ctx)) {
    const all = await refunds.listDisputes(ctx.db, { limit: fin.LIST_EXPORT_LIMIT, offset: 0 }, { state, q });
    return csvResponse(ctx, fin.toCsv(["dispute_id", "stripe_dispute", "opened", "updated", "customer", "amount_cents", "amount_usd", "reason", "status", "evidence_due_by", "payment_id", "stripe_payment_intent", "invoice_id"],
      all.slice(0, fin.LIST_EXPORT_LIMIT).map((d) => [d.id, d.stripe_dispute_id, d.created_at.slice(0, 10), d.updated_at.slice(0, 10), d.org_name ?? "unknown", d.amount_cents, fin.dollars(d.amount_cents), d.reason, d.status, d.evidence_due_by ?? "", d.payment_id, d.stripe_payment_intent_id, d.invoice_id])), "disputes", all.length);
  }
  const { page, limit, offset } = pageParam(ctx);
  const rows = await refunds.listDisputes(ctx.db, { limit, offset }, { state, q });
  const soon = new Date(ctx.now().getTime() + 7 * 86400e3).toISOString();
  const totals = await ctx.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS c, SUM(CASE WHEN evidence_due_by IS NOT NULL AND evidence_due_by < ? THEN 1 ELSE 0 END) AS due_soon
      FROM disputes WHERE status NOT IN (${refunds.DISPUTE_CLOSED.map((s) => `'${s}'`).join(",")})`).bind(soon).first<{ n: number; c: number; due_soon: number | null }>();
  return staffPage(ctx, "Disputes", html`${pageHead("Disputes", undefined, "Recorded from Stripe dispute webhooks")}
<p class="muted">Respond to disputes with evidence in the Stripe Dashboard before the due date. Rows here are created and updated only by verified Stripe events.</p>
<div class="kpis">${kpi("Open disputes", totals?.n ?? 0, `${formatCents(totals?.c ?? 0)} disputed`)}${kpi("Evidence due within 7 days", totals?.due_soon ?? 0)}</div>
${listToolbar(ctx, "/staff/disputes", select({ name: "state", label: "State", options: [{ value: "open", label: "Needs action" }, { value: "closed", label: "Closed (won, lost)" }], value: state, includeBlank: "All" }), "Customer, dispute or payment id")}
${table(rows.slice(0, limit), [
    { header: "Opened", cell: (d) => formatDate(d.created_at) }, { header: "Customer", cell: (d) => (d.organization_id ? html`<a href="/staff/customers/${d.organization_id}">${d.org_name ?? d.organization_id}</a>` : "Unknown customer") },
    { header: "Amount", cell: (d) => formatCents(d.amount_cents), numeric: true }, { header: "Reason", cell: (d) => (d.reason ? label(d.reason) : "—") }, { header: "Status", cell: (d) => badge(d.status) },
    { header: "Evidence due", cell: (d) => (d.evidence_due_by ? html`<span class="${d.evidence_due_by < soon && !["won", "lost", "closed"].includes(d.status) ? "error-text" : ""}">${formatDateTime(d.evidence_due_by)}</span>` : "—") },
    { header: "Payment", cell: (d) => (d.payment_id ? html`<a href="/staff/finance/receipts/${d.payment_id}">${d.stripe_payment_intent_id ?? d.payment_id}</a>` : "Not matched") }, { header: "Stripe dispute", cell: (d) => d.stripe_dispute_id }],
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
${kpi("Subscription revenue", formatCents(d.subscriptionRevenue))}${kpi("MRR", formatCents(d.mrr), `${d.activeSubscriptions} active subscriptions${d.mrrUnpriced ? `; ${d.mrrUnpriced} without a known monthly price excluded` : ""}`)}${kpi("Churn", pct(d.churn.rate), `${d.churn.canceled} canceled / ${d.churn.activeAtStart} active at start`)}
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
  const q = fin.searchParam(ctx.url.searchParams);
  if (wantsCsv(ctx)) {
    const all = await fin.listSubscriptions(ctx.db, { status: valid, q, limit: fin.LIST_EXPORT_LIMIT, offset: 0 });
    return csvResponse(ctx, fin.subscriptionsListCsv(all.slice(0, fin.LIST_EXPORT_LIMIT)), "subscriptions-list", all.length);
  }
  const { page, limit, offset } = pageParam(ctx);
  const rows = await fin.listSubscriptions(ctx.db, { status: valid, q, limit, offset });
  const counts = (await ctx.db.prepare(`SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status`).all<{ status: string; n: number }>()).results;
  const countOf = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  return staffPage(ctx, "Subscriptions", html`${pageHead("Subscriptions", undefined, "Finance")}
<div class="kpis">${kpi("Active", countOf("active"))}${kpi("Past due", countOf("past_due"), countOf("past_due") ? "payment failed; Stripe retries automatically" : undefined)}${kpi("Trialing", countOf("trialing"))}${kpi("Canceled", countOf("canceled"))}</div>
${listToolbar(ctx, "/staff/finance/subscriptions", select({ name: "status", label: "Status", options: ["trialing", "active", "past_due", "canceled", "incomplete", "unpaid"], value: valid, includeBlank: "Any status" }), "Customer, plan, Stripe id")}
${table(rows.slice(0, limit), [{ header: "Customer", cell: (s) => html`<a href="/staff/customers/${s.organization_id}">${s.org_name}</a>` }, { header: "Plan", cell: (s) => planName(s.product_id) },
    { header: "Monthly", cell: (s) => formatCents(fin.planMonthlyCents(s.product_id)), numeric: true }, { header: "Status", cell: (s) => badge(s.status) }, { header: "Period ends", cell: (s) => formatDate(s.current_period_end) },
    { header: "Started", cell: (s) => formatDate(s.created_at) }, { header: "Stripe", cell: (s) => s.stripe_subscription_id ?? "—" }],
    { empty: emptyState("No subscriptions", "Maintenance subscriptions are created by Stripe webhooks after checkout. Plan sales open once the Founder approves entitlements.") })}${pagination(ctx, page, rows.length > limit)}`);
}

async function invoicesPage(ctx: AppContext) {
  requireStaff(ctx, "finance.read");
  const status = ctx.url.searchParams.get("status") ?? "";
  const valid = (fin.INVOICE_STATUSES as readonly string[]).includes(status) ? status : undefined;
  const kindRaw = ctx.url.searchParams.get("kind") ?? "";
  const kind = (fin.INVOICE_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : undefined;
  const q = fin.searchParam(ctx.url.searchParams);
  const hasRange = !!(ctx.url.searchParams.get("from") || ctx.url.searchParams.get("to"));
  const range = hasRange ? fin.parseRange(ctx.url.searchParams, 30, ctx.now()) : undefined;
  if (wantsCsv(ctx)) {
    const all = await fin.listInvoices(ctx.db, { status: valid, kind, q, range, limit: fin.LIST_EXPORT_LIMIT, offset: 0 });
    return csvResponse(ctx, fin.invoicesListCsv(all.slice(0, fin.LIST_EXPORT_LIMIT)), "invoices-list", all.length);
  }
  const { page, limit, offset } = pageParam(ctx);
  const rows = await fin.listInvoices(ctx.db, { status: valid, kind, q, range, limit, offset });
  const filters = html`${input({ name: "q", label: "Search", value: q, placeholder: "Customer, description, invoice id", maxlength: 100 })}
${select({ name: "status", label: "Status", options: [...fin.INVOICE_STATUSES], value: valid, includeBlank: "Any status" })}
${select({ name: "kind", label: "Type", options: fin.INVOICE_KINDS.map((k) => ({ value: k, label: MILESTONE_LABEL[k] ?? label(k) })), value: kind, includeBlank: "Any type" })}`;
  return staffPage(ctx, "Invoices", html`${pageHead("Invoices", html`<a class="btn btn--ghost btn--sm" href="${csvHref(ctx)}" data-csv>Export CSV</a>`, "Finance")}
${rangeForm(ctx, range?.from ?? "", range?.to ?? "", filters)}
${table(rows.slice(0, limit), [{ header: "Issued", cell: (i) => html`<a href="/staff/finance/invoices/${i.id}">${formatDate(i.created_at)}</a>` }, { header: "Customer", cell: (i) => html`<a href="/staff/customers/${i.organization_id}">${i.org_name}</a>` },
    { header: "Description", cell: (i) => html`${i.description ?? MILESTONE_LABEL[i.milestone_kind ?? ""] ?? "—"}${i.stripe_invoice_id ? html`<br><span class="faint">Stripe invoice ${i.stripe_invoice_status ?? ""}</span>` : ""}` },
    { header: "Status", cell: (i) => badge(i.status) }, { header: "Amount", cell: (i) => formatCents(i.amount_cents), numeric: true },
    { header: "Paid", cell: (i) => formatDate(i.paid_at) }, { header: "Project", cell: (i) => (i.project_id ? html`<a href="/staff/projects/${i.project_id}">View</a>` : "—") },
    { header: "Documents", cell: (i) => html`<a href="/staff/finance/invoices/${i.id}/pdf">Invoice PDF</a>${(i.payment_ids ?? "").split(",").filter(Boolean).map((pid, n) => html`<br><a href="/staff/finance/receipts/${pid}" data-receipt>Receipt${n ? ` ${n + 1}` : ""}</a> · <a href="/staff/finance/receipts/${pid}/pdf">PDF</a>`)}` }],
    { empty: emptyState("No invoices", "Invoices are created by purchases, accepted quotes, milestones and change orders.") })}${pagination(ctx, page, rows.length > limit)}`);
}

async function staffInvoicePage(ctx: AppContext, id: string, errors: string[] = [], status = 200) {
  requireStaff(ctx, "finance.read");
  const d = await docs.loadInvoiceDoc(ctx.db, id, null);
  const full = await ctx.db.prepare(`SELECT stripe_invoice_status, stripe_invoice_number, stripe_hosted_invoice_url, stripe_invoice_error, stripe_invoice_synced_at, stripe_checkout_session_id FROM invoices WHERE id = ?`).bind(id)
    .first<{ stripe_invoice_status: string | null; stripe_invoice_number: string | null; stripe_hosted_invoice_url: string | null; stripe_invoice_error: string | null; stripe_invoice_synced_at: string | null; stripe_checkout_session_id: string | null }>();
  const inv = { ...d.invoice, ...full! };
  const invoicer = stripeInvoicer(ctx.env);
  const blocker = stripeInvoiceBlocker(inv);
  const done = inv.stripe_invoice_status === "open" || inv.stripe_invoice_status === "paid";
  const history = (await ctx.db.prepare(`SELECT a.action, a.created_at, a.actor_kind, u.display_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.subject_type = 'invoice' AND a.subject_id = ? ORDER BY a.id DESC LIMIT 50`).bind(id)
    .all<{ action: string; created_at: string; actor_kind: string; display_name: string | null }>()).results;
  const stripeSection = !(STRIPE_INVOICE_KINDS as readonly string[]).includes(inv.milestone_kind ?? "") ? html`<p class="muted">Paid through Stripe Checkout from the customer portal. Stripe invoices are used for 50/25/25 milestone invoices only.</p>`
    : done ? html`${dl([["Stripe invoice", inv.stripe_invoice_id], ["Stripe status", label(inv.stripe_invoice_status ?? "unknown")], ["Number", inv.stripe_invoice_number], ["Last synced", formatDateTime(inv.stripe_invoice_synced_at)]])}<p class="faint">Finalized without sending: the customer pays from the portal link. The invoice is marked paid only when Stripe's invoice.paid webhook arrives.</p>`
    : !invoicer.ok ? alert("warn", invoicer.reason)
    : blocker ? alert("info", blocker)
    : html`${inv.stripe_invoice_error ? alert("error", `Last attempt failed: ${inv.stripe_invoice_error}`) : ""}${inv.stripe_invoice_id ? html`<p class="faint">Draft ${inv.stripe_invoice_id} exists in Stripe; creating again resumes it without billing twice.</p>` : ""}
${actionForm(ctx, `/staff/finance/invoices/${inv.id}/stripe-invoice`, `Create Stripe invoice for ${formatCents(inv.amount_cents)}`, { variant: "primary", confirm: "Create and finalize this invoice in Stripe (not sent by email)?" })}`;
  return staffPage(ctx, "Invoice", html`${pageHead(d.lines[0]?.description ?? "Invoice", html`${badge(inv.status)}${linkButton("Invoice PDF", `/staff/finance/invoices/${inv.id}/pdf`, "secondary", "sm")}${linkButton("All invoices", "/staff/finance/invoices", "ghost", "sm")}`, `Invoice ${inv.id}`)}${formErrors(errors)}
<div class="grid grid-2"><section class="card stack">${dl([["Customer", html`<a href="/staff/customers/${d.organization.id}">${d.organization.name}</a>`], ["Type", MILESTONE_LABEL[inv.milestone_kind ?? ""] ?? "—"], ["Amount", formatCents(inv.amount_cents)],
    ["Paid", formatCents(d.paidCents)], ["Refunded", formatCents(d.refundedCents)], ["Balance due", formatCents(d.balanceCents)], ["Issued", formatDate(inv.created_at)], ["Paid at", formatDate(inv.paid_at)],
    ["Project", d.project ? html`<a href="/staff/projects/${d.project.id}">${d.project.name}</a>` : "—"], ["Order", d.order ? `${d.order.id} (${label(d.order.kind)}, ${formatCents(d.order.total_cents)})` : "—"], ["Checkout session", inv.stripe_checkout_session_id]])}
<h2 style="font-size:1.1rem">Receipts</h2>${table(d.payments, [{ header: "Date", cell: (p) => formatDate(p.created_at) }, { header: "Receipt", cell: (p) => html`<a href="/staff/finance/receipts/${p.id}">${p.receipt_number}</a> · <a href="/staff/finance/receipts/${p.id}/pdf">PDF</a>` },
    { header: "Amount", cell: (p) => formatCents(p.amount_cents), numeric: true }, { header: "Status", cell: (p) => badge(p.status) }], { empty: html`<p class="muted">No payment recorded yet.</p>` })}</section>
<section class="stack"><div class="card stack"><h2 style="font-size:1.1rem">Stripe invoice (PAY-006)</h2>${stripeSection}</div>
<div class="card"><h2 style="font-size:1.1rem">Audit trail</h2>${history.length ? html`<ul class="timeline">${history.map((h) => html`<li><strong>${h.action}</strong> <span class="faint">${formatDateTime(h.created_at)} · ${h.display_name ?? h.actor_kind}</span></li>`)}</ul>` : html`<p class="muted">No entries.</p>`}</div></section></div>`, status);
}

async function profitabilityPage(ctx: AppContext, errors: string[] = [], v: Record<string, string> = {}, status = 200) {
  requireStaff(ctx, "finance.read");
  const all = await fin.projectProfitability(ctx.db);
  const projects = all.map((p) => ({ value: p.projectId, label: `${p.name}` }));
  const q = fin.searchParam(ctx.url.searchParams).toLowerCase();
  const pStatus = ctx.url.searchParams.get("status") ?? "";
  const completeness = ctx.url.searchParams.get("profit") ?? "";
  const filtered = all.filter((p) => (!q || `${p.name} ${p.organization}`.toLowerCase().includes(q)) && (!pStatus || p.status === pStatus)
    && (completeness !== "complete" || p.profitCents !== null) && (completeness !== "incomplete" || p.profitCents === null));
  if (wantsCsv(ctx)) {
    return csvResponse(ctx, fin.toCsv(["project_id", "project", "customer", "status", "revenue_cents", "revenue_usd", "known_cost_cents", "known_cost_usd", ...fin.COST_CATEGORIES.map((c) => `${c}_cents`), "unknown_cost_items", "profit_cents", "profit_usd", "profit_status"],
      filtered.map((x) => [x.projectId, x.name, x.organization, x.status, x.revenueCents, fin.dollars(x.revenueCents), x.knownCostCents, fin.dollars(x.knownCostCents), ...fin.COST_CATEGORIES.map((c) => x.knownByCategory[c] ?? 0), x.unknown.length, x.profitCents ?? "", fin.dollars(x.profitCents), x.profitCents === null ? "incomplete_unknown_costs" : "complete"])), "profitability-list", filtered.length);
  }
  const { page, limit, offset } = pageParam(ctx);
  const rows = filtered.slice(offset, offset + limit);
  const unknownAll = filtered.flatMap((p) => p.unknown.map((u) => ({ ...u, project: p.name })));
  const sum = (f: (p: fin.ProjectProfit) => number) => filtered.reduce((s, p) => s + f(p), 0);
  const incomplete = filtered.filter((p) => p.profitCents === null).length;
  const statuses = [...new Set(all.map((p) => p.status))].sort();
  return staffPage(ctx, "Profitability", html`${pageHead("Project profitability", undefined, "Finance")}
<div class="kpis">${kpi("Revenue (paid)", formatCents(sum((p) => p.revenueCents)), `${filtered.length} projects`)}${kpi("Known costs", formatCents(sum((p) => p.knownCostCents)))}${kpi("AI cost (attributed)", formatCents(sum((p) => p.knownByCategory.ai_usage ?? 0)), "imported from AI jobs")}
${kpi("Profit", incomplete ? "Incomplete" : formatCents(sum((p) => p.profitCents ?? 0)), incomplete ? `${incomplete} project${incomplete === 1 ? " has" : "s have"} unknown costs` : "all costs known")}</div>
${listToolbar(ctx, "/staff/finance/profitability", html`${select({ name: "status", label: "Project status", options: statuses, value: pStatus, includeBlank: "Any status" })}${select({ name: "profit", label: "Profit", options: [{ value: "complete", label: "Complete" }, { value: "incomplete", label: "Incomplete (unknown costs)" }], value: completeness, includeBlank: "Any" })}`, "Project or customer")}
${table(rows, [{ header: "Project", cell: (p) => html`<a href="/staff/projects/${p.projectId}">${p.name}</a><br><span class="faint">${p.organization}</span>` }, { header: "Status", cell: (p) => badge(p.status) },
    { header: "Revenue (paid)", cell: (p) => formatCents(p.revenueCents), numeric: true }, { header: "Known costs", cell: (p) => formatCents(p.knownCostCents), numeric: true },
    { header: "of which AI", cell: (p) => formatCents(p.knownByCategory.ai_usage ?? 0), numeric: true }, { header: "of which labor", cell: (p) => formatCents(p.knownByCategory.labor ?? 0), numeric: true },
    { header: "Profit", cell: (p) => (p.profitCents === null ? html`<span class="badge badge--warn">Incomplete — unknown costs</span>` : formatCents(p.profitCents)), numeric: true }],
    { empty: emptyState(all.length ? "No matching projects" : "No projects yet", all.length ? "Change the search or filters." : "Projects are provisioned when Stripe confirms the first payment.") })}${pagination(ctx, page, filtered.length > offset + limit)}
${unknownAll.length ? html`<section class="card"><h2 style="font-size:1.2rem">Unknown costs (${unknownAll.length})</h2><p class="muted">These items have no amount recorded, so profit for their projects cannot be calculated. Record the real amount when it is known.</p>
${table(unknownAll, [{ header: "Project", cell: (u) => u.project }, { header: "Item", cell: (u) => u.description }, { header: "Date", cell: (u) => u.date.slice(0, 10) }, { header: "Source", cell: (u) => label(u.source) }])}</section>` : ""}
<section class="card stack" style="max-width:720px"><h2 style="font-size:1.2rem">Record a cost</h2>${formErrors(errors)}
<form method="post" action="/staff/finance/costs" class="stack">${csrf(ctx)}
${select({ name: "project_id", label: "Project", options: projects, value: v.project_id, includeBlank: "Business overhead (no project)" })}
${select({ name: "category", label: "Category", options: [...fin.COST_CATEGORIES], value: v.category })}
${input({ name: "amount", label: "Amount ($)", value: v.amount, inputmode: "decimal", hint: "Leave blank if the amount is not known yet — it will be shown as Unknown, never as $0." })}
${input({ name: "description", label: "Description", value: v.description, required: true })}${input({ name: "incurred_on", label: "Date incurred", type: "date", value: v.incurred_on, required: true })}
<div class="form-actions">${button("Record cost", { size: "sm" })}</div></form></section>
${definitions([["Revenue", "Sum of paid invoices linked to the project."], ["Known costs", "project_costs with an amount + time entries × hourly cost (minutes ÷ 60 × hourly_cost_cents)."],
    ["AI cost", "ai_usage costs imported once per AI job by the daily cost import: jobs on project:<id>, on a ticket linked to the project, or on the lead/quote that converted into the project. Costs recorded before a lead converted are moved onto the project when it does."],
    ["Profit", "Revenue − known costs. If any cost or hourly rate is unknown, profit is marked Incomplete rather than computed."]])}`, status);
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
    const url = await billingPortalUrl(ctx, org.organizationId);
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "billing.portal_opened", subjectType: "organization", subjectId: org.organizationId, organizationId: org.organizationId, ip: ctx.ip });
    return stripeRedirect(ctx, url);
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
  r.get("/staff/finance/invoices/:id", (ctx, p) => staffInvoicePage(ctx, p.id));
  r.post("/staff/finance/invoices/:id/stripe-invoice", async (ctx, p) => {
    requireStaff(ctx, "finance.read");
    try {
      const res = await createStripeMilestoneInvoice(ctx.db, ctx.env, ctx.user!.id, p.id);
      return redirect(ctx, `/staff/finance/invoices/${p.id}`, { kind: "success", text: res.outcome === "already_finalized" ? "This invoice already has a finalized Stripe invoice; nothing new was created." : `Stripe invoice ${res.number ?? res.stripeInvoiceId} finalized (not emailed). The customer can pay it from the portal.` });
    } catch (e) {
      const st = (e as { status?: number }).status;
      if (st === 409 || st === 502) return staffInvoicePage(ctx, p.id, [(e as Error).message], st);
      throw e;
    }
  });
  // PAY-005 PDFs: staff (finance.read) and the owning organization only; every download audited.
  r.get("/staff/finance/invoices/:id/pdf", (ctx, p) => pdfDownload(ctx, "invoice", p.id, true));
  r.get("/staff/finance/receipts/:paymentId/pdf", (ctx, p) => pdfDownload(ctx, "receipt", p.paymentId, true));
  r.get("/portal/billing/invoices/:id/pdf", (ctx, p) => pdfDownload(ctx, "invoice", p.id, false));
  r.get("/portal/billing/receipts/:paymentId/pdf", (ctx, p) => pdfDownload(ctx, "receipt", p.paymentId, false));
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

