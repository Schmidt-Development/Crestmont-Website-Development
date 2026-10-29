// Customer checkout and billing (SALES-004, PAY-001, PAY-004, PAY-005, PORTAL-008).
// Every query is scoped by the organization returned from requireCustomerOrg(). Checkout never
// marks anything paid: the Stripe webhook (src/services/payments.ts) is the only source of truth.
import type { AppContext } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { HttpError, securityHeaders } from "../app/http.ts";
import { PACKAGES, MAINTENANCE_PLANS, type PackageId, type MaintenanceId, type MaintenanceDef } from "../domain/catalog.ts";
import { createPackageOrder } from "./commerce.ts";
import { audit } from "./security.ts";
import { sendMail } from "./mailer.ts";
import { effectivePrice, pricedItem } from "./pricing-approvals.ts";
import { checkoutLinesFor, loadTaxConfig, taxLines } from "./tax.ts";
import { computeTax } from "../domain/tax.ts";
import { parseAttributionCookie, privacySignal, ATTRIBUTION_COOKIE } from "./leads.ts";
import { parseCookies } from "../app/http.ts";

export const NOT_CONFIGURED = "Online payment is not configured yet.";

export function packageById(id: string) {
  return id in PACKAGES ? PACKAGES[id as PackageId] : null;
}
export function maintenanceById(id: string) {
  return id in MAINTENANCE_PLANS ? MAINTENANCE_PLANS[id as MaintenanceId] : null;
}

export interface CheckoutUser { id: string; email: string; name?: string }

async function stripeCustomerOf(db: Db, organizationId: string): Promise<string | null> {
  return (await db.prepare(`SELECT stripe_customer_id FROM organizations WHERE id = ?`).bind(organizationId).first<{ stripe_customer_id: string | null }>())?.stripe_customer_id ?? null;
}

const OPEN_LEAD_STAGES = `('new','qualified','quote_required','quote_sent','negotiation','accepted','awaiting_payment')`;

/**
 * CREST-GAP-091: a direct package purchase appears in the CRM. The buyer's open lead (matched by contact email) is
 * linked and moved to awaiting payment; without one, a lead with source "checkout" is created carrying the first-party
 * campaign attribution cookie (referrer dropped under DNT/GPC). The paid webhook then converts it.
 */
export async function ensureCheckoutLead(ctx: AppContext, user: CheckoutUser, organizationId: string, pkg: { id: string; name: string }): Promise<string> {
  const db = ctx.db;
  const email = user.email.trim().toLowerCase();
  const at = nowIso(ctx.now);
  const existing = await db.prepare(`SELECT l.id, l.stage FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.email = ? AND l.merged_into_lead_id IS NULL AND l.stage IN ${OPEN_LEAD_STAGES} ORDER BY l.updated_at DESC LIMIT 1`)
    .bind(email).first<{ id: string; stage: string }>();
  if (existing) {
    if (existing.stage !== "awaiting_payment") {
      const r = await db.prepare(`UPDATE leads SET stage = 'awaiting_payment', updated_at = ? WHERE id = ? AND stage = ?`).bind(at, existing.id, existing.stage).run();
      if (r.meta.changes === 1) await db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'stage_change',?,?)`).bind(newId("act"), existing.id, `Stage: ${existing.stage} → awaiting_payment (customer started ${pkg.name} package checkout)`, at).run();
    }
    return existing.id;
  }
  const attr = parseAttributionCookie(parseCookies(ctx.req.headers.get("cookie"))[ATTRIBUTION_COOKIE]);
  if (privacySignal(ctx.req.headers)) delete attr.referrer;
  const org = await db.prepare(`SELECT name FROM organizations WHERE id = ?`).bind(organizationId).first<{ name: string }>();
  const companyId = newId("co"), contactId = newId("ct"), leadId = newId("ld");
  await db.batch([
    db.prepare(`INSERT INTO companies (id, name, organization_id, created_at) VALUES (?,?,?,?)`).bind(companyId, org?.name ?? "Customer", organizationId, at),
    db.prepare(`INSERT INTO contacts (id, company_id, name, email, user_id, created_at) VALUES (?,?,?,?,?,?)`).bind(contactId, companyId, user.name?.trim() || email, email, user.id, at),
    db.prepare(`INSERT INTO leads (id, contact_id, source, stage, interest, message, utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer, landing_page, created_at, updated_at) VALUES (?,?,'checkout','awaiting_payment',?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(leadId, contactId, pkg.id, `Started ${pkg.name} package checkout online.`, attr.utm_source ?? null, attr.utm_medium ?? null, attr.utm_campaign ?? null, attr.utm_term ?? null, attr.utm_content ?? null, attr.referrer ?? null, attr.landing_page ?? null, at, at),
    db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'system',?,?)`).bind(newId("act"), leadId, `Lead created by ${pkg.name} package checkout${attr.utm_source ? ` (campaign source: ${attr.utm_source})` : ""}`, at),
  ]);
  await audit(db, { actorUserId: user.id, action: "lead.created", subjectType: "lead", subjectId: leadId, organizationId, details: { source: "checkout", packageId: pkg.id, ...(Object.keys(attr).length ? { attribution: attr } : {}) } });
  return leadId;
}

/** Standard package checkout (fixed price, 100% upfront). Premium above the floor goes through quotes. */
export async function startPackageCheckout(ctx: AppContext, user: CheckoutUser, organizationId: string, packageId: string) {
  const pkg = packageById(packageId);
  if (!pkg) throw new HttpError(404, "Unknown package.");
  if (!ctx.payments.configured) throw new HttpError(409, NOT_CONFIGURED);
  const leadId = await ensureCheckoutLead(ctx, user, organizationId, pkg);
  const order = await createPackageOrder(ctx.db, organizationId, pkg.id, user.id, ctx.now(), { leadId });
  const session = await ctx.payments.createCheckout({
    mode: "payment",
    lines: order.checkoutLines,
    customerEmail: user.email,
    customerId: await stripeCustomerOf(ctx.db, organizationId),
    successUrl: `${ctx.baseUrl}/portal/billing?checkout=success`,
    cancelUrl: `${ctx.baseUrl}/checkout/${pkg.id}?checkout=cancelled`,
    metadata: { organization_id: organizationId, order_id: order.orderId, invoice_id: order.invoiceId, kind: "package" },
    // One Stripe session per invoice per day: a repeat click on the reused invoice returns the same session (CREST-GAP-036).
    idempotencyKey: `checkout:${order.invoiceId}:${nowIso(ctx.now).slice(0, 10)}`,
  });
  await recordCheckoutSession(ctx.db, order.invoiceId, session.id);
  await audit(ctx.db, { actorUserId: user.id, action: "checkout.started", subjectType: "invoice", subjectId: order.invoiceId, organizationId, details: { packageId: pkg.id, amountCents: order.amountCents, reusedInvoice: order.reused } });
  return { url: session.url, orderId: order.orderId, invoiceId: order.invoiceId };
}

async function recordCheckoutSession(db: Db, invoiceId: string, sessionId: string) {
  await db.prepare(`UPDATE invoices SET stripe_checkout_session_id = ? WHERE id = ?`).bind(sessionId, invoiceId).run();
}

export interface CustomerInvoice { id: string; organization_id: string; order_id: string | null; project_id: string | null; milestone_kind: string | null; amount_cents: number; subtotal_cents: number | null; tax_cents: number; tax_detail_json: string | null; status: string; description: string | null; created_at: string; paid_at: string | null; due_at: string | null; stripe_checkout_session_id: string | null; stripe_invoice_status: string | null; stripe_hosted_invoice_url: string | null }

export async function customerInvoice(db: Db, organizationId: string, invoiceId: string): Promise<CustomerInvoice> {
  const inv = await db.prepare(`SELECT id, organization_id, order_id, project_id, milestone_kind, amount_cents, subtotal_cents, tax_cents, tax_detail_json, status, description, created_at, paid_at, due_at, stripe_checkout_session_id, stripe_invoice_status, stripe_hosted_invoice_url FROM invoices WHERE id = ? AND organization_id = ?`)
    .bind(invoiceId, organizationId).first<CustomerInvoice>();
  if (!inv) throw new HttpError(404, "Invoice not found.");
  return inv;
}

/** Pay any open invoice of the customer's organization (package, quote deposit, milestone, change order). */
export async function startInvoiceCheckout(ctx: AppContext, user: CheckoutUser, organizationId: string, invoiceId: string) {
  const inv = await customerInvoice(ctx.db, organizationId, invoiceId);
  if (inv.status !== "open") throw new HttpError(409, inv.status === "paid" ? "This invoice is already paid." : "This invoice is not open for payment.");
  if (inv.amount_cents <= 0) throw new HttpError(409, "This invoice has no amount due.");
  // PAY-006: an invoice billed as a Stripe Invoice is paid through its Stripe link only, never also through Checkout.
  if (inv.stripe_invoice_status === "open" || inv.stripe_invoice_status === "paid") throw new HttpError(409, "This invoice is billed through a Stripe invoice. Use the “Pay Stripe invoice” link on the invoice page.");
  if (!ctx.payments.configured) throw new HttpError(409, NOT_CONFIGURED);
  const order = inv.order_id ? await ctx.db.prepare(`SELECT kind FROM orders WHERE id = ?`).bind(inv.order_id).first<{ kind: string }>() : null;
  const kind = inv.milestone_kind === "change_order" ? "change_order" : inv.milestone_kind === "design_25" || inv.milestone_kind === "prelaunch_25" ? "milestone" : order?.kind ?? "invoice";
  const session = await ctx.payments.createCheckout({
    mode: "payment",
    lines: checkoutLinesFor(inv, "Crestmont invoice"),
    customerEmail: user.email,
    customerId: await stripeCustomerOf(ctx.db, organizationId),
    successUrl: `${ctx.baseUrl}/portal/billing?checkout=success`,
    cancelUrl: `${ctx.baseUrl}/portal/billing/invoices/${inv.id}?checkout=cancelled`,
    metadata: { organization_id: organizationId, invoice_id: inv.id, order_id: inv.order_id ?? "", kind },
    // One Stripe session per invoice per day: retries within a day reuse the same session.
    idempotencyKey: `checkout:${inv.id}:${nowIso(ctx.now).slice(0, 10)}`,
  });
  await recordCheckoutSession(ctx.db, inv.id, session.id);
  await audit(ctx.db, { actorUserId: user.id, action: "checkout.started", subjectType: "invoice", subjectId: inv.id, organizationId, details: { amountCents: inv.amount_cents, kind } });
  return { url: session.url };
}

/** Maintenance subscription checkout. Gated until the Founder approves entitlements (CAT-006, BLK-010). */
export async function startMaintenanceCheckout(ctx: AppContext, user: CheckoutUser, organizationId: string, planId: string,
  catalog: Readonly<Record<string, MaintenanceDef>> = MAINTENANCE_PLANS) {
  // `catalog` defaults to the server-side catalog; tests pass an approved copy to exercise the post-approval path.
  const plan = planId in catalog ? catalog[planId] : null;
  if (!plan) throw new HttpError(404, "Unknown maintenance plan.");
  if (plan.entitlementsStatus !== "approved") {
    throw new HttpError(409, `${plan.name} maintenance cannot be purchased yet: its entitlements are proposed and awaiting Founder approval. Contact us and we will let you know when plans open.`);
  }
  if (!ctx.payments.configured) throw new HttpError(409, NOT_CONFIGURED);
  const existing = await ctx.db.prepare(`SELECT id FROM subscriptions WHERE organization_id = ? AND product_id = ? AND status IN ('active','trialing','past_due')`).bind(organizationId, plan.id).first();
  if (existing) throw new HttpError(409, `You already have an active ${plan.name} plan. Manage it from Billing.`);
  const monthly = pricedItem("maintenance", plan.id) ? (await effectivePrice(ctx.db, "maintenance", plan.id, ctx.now())).cents : plan.monthlyCents; // CAT-007 effective price
  // LEGAL-005: configured tax is a separate recurring line per jurisdiction.
  const tax = computeTax([{ description: `${plan.name} maintenance (monthly)`, amountCents: monthly, productKey: plan.id }], await loadTaxConfig(ctx.db));
  const session = await ctx.payments.createCheckout({
    mode: "subscription",
    recurringInterval: "month",
    lines: [{ name: `${plan.name} maintenance (monthly)`, amountCents: monthly }, ...(tax.configured ? taxLines(tax) : [])],
    customerEmail: user.email,
    customerId: await stripeCustomerOf(ctx.db, organizationId),
    successUrl: `${ctx.baseUrl}/portal/billing?checkout=success`,
    cancelUrl: `${ctx.baseUrl}/checkout/maintenance/${plan.id}?checkout=cancelled`,
    metadata: { organization_id: organizationId, product_id: plan.id, kind: "subscription" },
    idempotencyKey: `subscribe:${organizationId}:${plan.id}:${nowIso(ctx.now).slice(0, 10)}`,
  });
  await audit(ctx.db, { actorUserId: user.id, action: "checkout.subscription_started", subjectType: "organization", subjectId: organizationId, organizationId, details: { planId: plan.id } });
  return { url: session.url };
}

export async function billingPortalUrl(ctx: AppContext, organizationId: string): Promise<string> {
  if (!ctx.payments.configured) throw new HttpError(409, NOT_CONFIGURED);
  const org = await ctx.db.prepare(`SELECT stripe_customer_id FROM organizations WHERE id = ?`).bind(organizationId).first<{ stripe_customer_id: string | null }>();
  if (!org?.stripe_customer_id) throw new HttpError(409, "There is no saved payment profile yet. It is created with your first successful payment.");
  return (await ctx.payments.createBillingPortal(org.stripe_customer_id, `${ctx.baseUrl}/portal/billing`)).url;
}

export async function customerBilling(db: Db, organizationId: string) {
  const q = <T>(sql: string) => db.prepare(sql).bind(organizationId).all<T>().then((r) => r.results);
  return {
    orders: await q<{ id: string; kind: string; status: string; total_cents: number; created_at: string; product_id: string | null }>(`SELECT id, kind, status, total_cents, created_at, product_id FROM orders WHERE organization_id = ? ORDER BY created_at DESC`),
    invoices: await q<CustomerInvoice>(`SELECT id, organization_id, order_id, project_id, milestone_kind, amount_cents, subtotal_cents, tax_cents, tax_detail_json, status, description, created_at, paid_at, due_at, stripe_checkout_session_id, stripe_invoice_status, stripe_hosted_invoice_url FROM invoices WHERE organization_id = ? AND status <> 'draft' ORDER BY created_at DESC`),
    payments: await q<{ id: string; invoice_id: string | null; amount_cents: number; status: string; created_at: string; description: string | null; refundable: number }>(`SELECT p.id, p.invoice_id, p.amount_cents, p.status, p.created_at, i.description,
        CASE WHEN p.status = 'succeeded' AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id AND r.status NOT IN ('denied','failed')) THEN 1 ELSE 0 END AS refundable
      FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id WHERE p.organization_id = ? ORDER BY p.created_at DESC`),
    subscriptions: await q<{ id: string; product_id: string; status: string; current_period_end: string | null; created_at: string }>(`SELECT id, product_id, status, current_period_end, created_at FROM subscriptions WHERE organization_id = ? ORDER BY created_at DESC`),
    refunds: await q<{ id: string; payment_id: string; amount_cents: number; reason: string; status: string; created_at: string; decided_at: string | null }>(`SELECT id, payment_id, amount_cents, reason, status, created_at, decided_at FROM refunds WHERE organization_id = ? ORDER BY created_at DESC`),
    hasStripeCustomer: !!(await db.prepare(`SELECT stripe_customer_id FROM organizations WHERE id = ?`).bind(organizationId).first<{ stripe_customer_id: string | null }>())?.stripe_customer_id,
  };
}

/** Customer refund request (PAY-007 step 1). Only for this organization's succeeded payments. */
export async function requestRefund(ctx: AppContext, user: CheckoutUser, organizationId: string, input: { paymentId: string; reason: string; amountCents: number | null; evidence: string }) {
  const issues: string[] = [];
  if (input.reason.length < 10 || input.reason.length > 5000) issues.push("Explain the reason for your request (at least 10 characters)");
  if (input.evidence.length > 5000) issues.push("Supporting details are too long");
  const pay = await ctx.db.prepare(`SELECT id, amount_cents, status FROM payments WHERE id = ? AND organization_id = ?`).bind(input.paymentId, organizationId).first<{ id: string; amount_cents: number; status: string }>();
  if (!pay) issues.push("Choose one of your payments");
  else {
    if (pay.status !== "succeeded") issues.push("Only completed payments can be refunded");
    const amount = input.amountCents ?? pay.amount_cents;
    if (Number.isNaN(amount) || amount <= 0 || amount > pay.amount_cents) issues.push("The amount must be more than $0 and no more than the payment");
    const open = await ctx.db.prepare(`SELECT 1 AS x FROM refunds WHERE payment_id = ? AND status NOT IN ('denied','failed')`).bind(pay.id).first();
    if (open) issues.push("There is already a refund request for this payment");
  }
  if (issues.length) return { ok: false as const, issues };
  const id = newId("rf");
  const amount = input.amountCents ?? pay!.amount_cents;
  const at = nowIso(ctx.now);
  await ctx.db.prepare(`INSERT INTO refunds (id, organization_id, payment_id, amount_cents, reason, evidence, status, requested_by, created_at) VALUES (?,?,?,?,?,?, 'requested', ?, ?)`)
    .bind(id, organizationId, pay!.id, amount, input.reason, input.evidence || null, user.id, at).run();
  await audit(ctx.db, { actorUserId: user.id, action: "refund.requested", subjectType: "refund", subjectId: id, organizationId, details: { paymentId: pay!.id, amountCents: amount } });
  await sendMail(ctx, { template: "refund_request", to: user.email, idempotencyKey: `refund-req:${id}`, data: { amountCents: amount, url: `${ctx.baseUrl}/portal/billing` } });
  const reviewers = (await ctx.db.prepare(`SELECT DISTINCT user_id FROM memberships WHERE role_id IN ('support','owner')`).all<{ user_id: string }>()).results;
  for (const r of reviewers) {
    await ctx.db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(newId("ntf"), r.user_id, "refund_requested", "refund", id, `New refund request for $${(amount / 100).toFixed(2)} needs review.`, at).run();
  }
  return { ok: true as const, id };
}

/** 303 to a Stripe-hosted page. Only Stripe hosts are allowed (matches the form-action CSP). */
export function stripeRedirect(ctx: AppContext, url: string): Response {
  let u: URL;
  try { u = new URL(url); } catch { throw new HttpError(502, "Stripe returned an invalid checkout link."); }
  if (u.protocol !== "https:" || !/(^|\.)stripe\.com$/.test(u.hostname)) throw new HttpError(502, "Stripe returned an unexpected checkout link.");
  const headers = new Headers({ location: u.toString(), ...securityHeaders("page"), "cache-control": "no-store" });
  for (const c of ctx.setCookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/** Records acceptance of the effective purchase agreements (terms, development agreement, refund policy). */
export async function recordCheckoutTerms(ctx: AppContext, userId: string, organizationId: string) {
  const agreements = (await ctx.db.prepare(`SELECT id FROM agreements WHERE kind IN ('terms_of_service','development_agreement','refund_policy','cancellation_policy','support_policy') AND effective_at IS NOT NULL`).all<{ id: string }>()).results;
  for (const a of agreements) {
    await ctx.db.prepare(`INSERT INTO agreement_acceptances (id, agreement_id, user_id, organization_id, ip, accepted_at) VALUES (?,?,?,?,?,?)`)
      .bind(newId("acc"), a.id, userId, organizationId, ctx.ip, nowIso(ctx.now)).run();
  }
  await audit(ctx.db, { actorUserId: userId, action: "agreements.accepted_at_checkout", subjectType: "organization", subjectId: organizationId, organizationId, details: { agreements: agreements.map((a) => a.id) } });
}
