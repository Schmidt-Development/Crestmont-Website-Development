// Stripe adapter (PAY-001, PAY-004, PAY-006, PAY-009). Every class is constructed for one expected mode ("test" by
// default). A key of the other mode is refused at construction and any Stripe object whose livemode differs from the
// expected mode is refused (CREST-GAP-007/008). Live mode is only ever requested by src/domain/payments-mode.ts, which
// allows it on production behind the Founder's PAYMENTS_LIVE_AUTHORIZED flag (PAY-010).
// When no key is configured the platform reports payments as "not configured" and checkout
// buttons explain that online payment is unavailable — nothing is simulated.

import { keyMode, type StripeMode } from "../domain/payments-mode.ts";

export class LivePaymentsNotAuthorized extends Error {}

function assertKeyMode(secretKey: string, mode: StripeMode) {
  if (keyMode(secretKey) !== mode) {
    throw new LivePaymentsNotAuthorized(mode === "test"
      ? "Only Stripe test-mode keys are accepted until live payments are authorised by the Founder"
      : "Live mode requires a live Stripe key; test keys are refused on production");
  }
}
/** A Stripe object whose livemode does not match the expected mode is refused. */
function assertObjectMode(body: { livemode?: boolean }, mode: StripeMode) {
  if (typeof body.livemode === "boolean" && body.livemode !== (mode === "live")) {
    throw new LivePaymentsNotAuthorized(body.livemode ? "Stripe returned a live-mode object; live payments are not authorised" : "Stripe returned a test-mode object where live mode is expected");
  }
}

/** One Checkout line. Sales tax (LEGAL-005) is sent as its own line per jurisdiction, tagged with taxJurisdictionId. */
export interface CheckoutLine { name: string; amountCents: number; quantity?: number; taxJurisdictionId?: string }
export interface CheckoutRequest {
  mode: "payment" | "subscription";
  lines: CheckoutLine[];
  customerEmail: string;
  /** CREST-GAP-038: the organization's stored Stripe Customer; without one, payment-mode Checkout creates one. */
  customerId?: string | null;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  recurringInterval?: "month";
  idempotencyKey: string;
}

export interface PaymentsAdapter {
  readonly configured: boolean;
  readonly mode: "test" | "live" | "none";
  createCheckout(req: CheckoutRequest): Promise<{ id: string; url: string }>;
  createBillingPortal(customerId: string, returnUrl: string): Promise<{ url: string }>;
  createRefund(paymentIntentId: string, amountCents: number, idempotencyKey: string): Promise<{ id: string; status: string }>;
}

export class NoPayments implements PaymentsAdapter {
  readonly configured = false;
  readonly mode = "none" as const;
  /** Why payments are unavailable here. */
  readonly reason: string;
  constructor(reason = "STRIPE_SECRET_KEY is not set.") { this.reason = reason; }
  async createCheckout(): Promise<never> { throw new Error("Payments are not configured"); }
  async createBillingPortal(): Promise<never> { throw new Error("Payments are not configured"); }
  async createRefund(): Promise<never> { throw new Error("Payments are not configured"); }
}

/**
 * Every request pins the Stripe API version this integration is written against (https://docs.stripe.com/api-versions).
 * 2025-02-24.acacia is the last version before 2025-03-31.basil, which removed Invoice.payment_intent/charge/subscription
 * and Subscription.current_period_end. Webhook payloads follow the webhook endpoint's own version, so
 * src/domain/stripe-shapes.ts reads both shapes. Upgrading means changing this constant after testing the new shapes.
 */
export const STRIPE_API_VERSION = "2025-02-24.acacia";

export class StripePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode: StripeMode;
  private key: string; private fetchImpl: typeof fetch;
  constructor(secretKey: string, fetchImpl: typeof fetch = fetch, mode: StripeMode = "test") {
    assertKeyMode(secretKey, mode);
    this.key = secretKey; this.fetchImpl = fetchImpl; this.mode = mode;
  }

  private async call<T>(path: string, form: Record<string, string>, idem?: string): Promise<T> {
    const r = await this.fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "stripe-version": STRIPE_API_VERSION, "content-type": "application/x-www-form-urlencoded", ...(idem ? { "idempotency-key": idem } : {}) },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await r.json()) as T & { error?: { message: string }; livemode?: boolean };
    if (!r.ok) throw new Error(`Stripe: ${body.error?.message ?? r.status}`);
    assertObjectMode(body, this.mode);
    return body;
  }

  async createCheckout(req: CheckoutRequest) {
    const form: Record<string, string> = { mode: req.mode, success_url: req.successUrl, cancel_url: req.cancelUrl };
    // CREST-GAP-038: reuse the stored Customer; otherwise make Checkout create one (subscription mode always does),
    // so the billing portal works after the first payment. `customer` and `customer_email` are mutually exclusive.
    if (req.customerId) form.customer = req.customerId;
    else {
      form.customer_email = req.customerEmail;
      if (req.mode === "payment") form.customer_creation = "always";
    }
    req.lines.forEach((l, i) => {
      form[`line_items[${i}][quantity]`] = String(l.quantity ?? 1);
      form[`line_items[${i}][price_data][currency]`] = "usd";
      form[`line_items[${i}][price_data][unit_amount]`] = String(l.amountCents);
      form[`line_items[${i}][price_data][product_data][name]`] = l.name;
      if (l.taxJurisdictionId) form[`line_items[${i}][price_data][product_data][metadata][crestmont_tax_jurisdiction]`] = l.taxJurisdictionId;
      if (req.mode === "subscription") form[`line_items[${i}][price_data][recurring][interval]`] = req.recurringInterval ?? "month";
    });
    for (const [k, v] of Object.entries(req.metadata)) form[`metadata[${k}]`] = v;
    if (req.mode === "payment") for (const [k, v] of Object.entries(req.metadata)) form[`payment_intent_data[metadata][${k}]`] = v;
    // CREST-GAP-083: the Subscription carries the same metadata, so customer.subscription.* events resolve the organization.
    if (req.mode === "subscription") for (const [k, v] of Object.entries(req.metadata)) form[`subscription_data[metadata][${k}]`] = v;
    const s = await this.call<{ id: string; url: string }>("checkout/sessions", form, req.idempotencyKey);
    return { id: s.id, url: s.url };
  }

  async createBillingPortal(customerId: string, returnUrl: string) {
    return this.call<{ url: string }>("billing_portal/sessions", { customer: customerId, return_url: returnUrl });
  }

  async createRefund(paymentIntentId: string, amountCents: number, idempotencyKey: string) {
    return this.call<{ id: string; status: string }>("refunds", { payment_intent: paymentIntentId, amount: String(amountCents) }, idempotencyKey);
  }
}

/** Test-mode adapter (the only mode outside an authorised production). */
export class StripeTestPayments extends StripePayments {
  constructor(secretKey: string, fetchImpl: typeof fetch = fetch) { super(secretKey, fetchImpl, "test"); }
}

/**
 * Read-only Stripe API access for fee import (FIN-002) and Stripe-side reconciliation (PAY-009).
 * GET requests only: this class has no method that can create, change or refund anything.
 * Same test-mode-only rule as StripeTestPayments.
 */
export class StripeReadOnly {
  private key: string; private fetchImpl: typeof fetch;
  readonly mode: StripeMode;
  constructor(secretKey: string, fetchImpl: typeof fetch = fetch, mode: StripeMode = "test") {
    assertKeyMode(secretKey, mode);
    this.key = secretKey; this.fetchImpl = fetchImpl; this.mode = mode;
  }

  async get<T>(path: string, query: [string, string][] = []): Promise<T> {
    if (!/^[a-z_]+(\/[A-Za-z0-9_]+)*$/.test(path)) throw new Error("Invalid Stripe path");
    const qs = query.length ? `?${new URLSearchParams(query).toString()}` : "";
    const r = await this.fetchImpl(`https://api.stripe.com/v1/${path}${qs}`, { method: "GET", headers: { authorization: `Bearer ${this.key}`, "stripe-version": STRIPE_API_VERSION } });
    const body = (await r.json().catch(() => ({}))) as T & { error?: { message: string }; livemode?: boolean };
    if (!r.ok) throw new Error(`Stripe ${r.status}: ${body.error?.message ?? "error"}`);
    assertObjectMode(body, this.mode);
    return body;
  }

  /** Refuses a listed object whose livemode differs from this reader's mode. */
  assertMode(o: { livemode?: boolean }) { assertObjectMode(o, this.mode); }

  /** PaymentIntent with its latest charge and that charge's balance transaction (fee). */
  retrievePaymentIntentWithFee(id: string) {
    return this.get<{ id: string; status: string; amount_received?: number; latest_charge?: { id: string; balance_transaction?: { id: string; fee: number; currency: string } | string | null } | string | null }>(
      `payment_intents/${id}`, [["expand[]", "latest_charge.balance_transaction"]]);
  }

  listCheckoutSessions(createdGte: number, startingAfter?: string) {
    const q: [string, string][] = [["limit", "100"], ["created[gte]", String(createdGte)]];
    if (startingAfter) q.push(["starting_after", startingAfter]);
    return this.get<{ data: StripeCheckoutSessionSummary[]; has_more: boolean }>("checkout/sessions", q);
  }

  /** GET /v1/invoices (https://docs.stripe.com/api/invoices/list). */
  listInvoices(f: { createdGte?: number; customer?: string; startingAfter?: string }) {
    const q: [string, string][] = [["limit", "100"]];
    if (f.createdGte !== undefined) q.push(["created[gte]", String(f.createdGte)]);
    if (f.customer) q.push(["customer", f.customer]);
    if (f.startingAfter) q.push(["starting_after", f.startingAfter]);
    return this.get<{ data: StripeInvoice[]; has_more: boolean }>("invoices", q);
  }

  /**
   * GET /v1/balance_transactions (https://docs.stripe.com/api/balance_transactions/list) with each
   * transaction's source expanded, so a charge's payment_intent and a refund's id can be matched locally.
   */
  listBalanceTransactions(f: { createdGte?: number; payout?: string; startingAfter?: string }) {
    const q: [string, string][] = [["limit", "100"], ["expand[]", "data.source"]];
    if (f.createdGte !== undefined) q.push(["created[gte]", String(f.createdGte)]);
    if (f.payout) q.push(["payout", f.payout]);
    if (f.startingAfter) q.push(["starting_after", f.startingAfter]);
    return this.get<{ data: StripeBalanceTransaction[]; has_more: boolean }>("balance_transactions", q);
  }

  /** GET /v1/payouts (https://docs.stripe.com/api/payouts/list). */
  listPayouts(createdGte: number, startingAfter?: string) {
    const q: [string, string][] = [["limit", "100"], ["created[gte]", String(createdGte)]];
    if (startingAfter) q.push(["starting_after", startingAfter]);
    return this.get<{ data: StripePayout[]; has_more: boolean }>("payouts", q);
  }
}

export interface StripeCheckoutSessionSummary {
  id: string; created: number; mode: string; status: string | null; payment_status: string; amount_total: number | null;
  payment_intent: string | null; subscription: string | null; metadata: Record<string, string> | null; livemode?: boolean;
}

/** Fields of the Stripe Invoice object (https://docs.stripe.com/api/invoices/object) that the platform reads. */
export interface StripeInvoice {
  id: string; object?: "invoice"; customer: string | null; status: "draft" | "open" | "paid" | "void" | "uncollectible" | null;
  number: string | null; currency: string; total: number; amount_due: number; amount_paid: number; created: number;
  hosted_invoice_url?: string | null; collection_method?: string; metadata: Record<string, string> | null; livemode?: boolean;
  subscription?: string | null; payment_intent?: string | null; status_transitions?: { paid_at?: number | null; finalized_at?: number | null } | null;
}
/** https://docs.stripe.com/api/balance_transactions/object (source expanded). */
export interface StripeBalanceTransaction {
  id: string; amount: number; fee: number; net: number; currency: string; type: string; created: number; status?: string;
  source: string | { id: string; object: string; payment_intent?: string | null; charge?: string | null; amount?: number } | null;
}
/** https://docs.stripe.com/api/payouts/object */
export interface StripePayout { id: string; amount: number; currency: string; status: string; arrival_date: number | null; created: number; failure_message?: string | null; livemode?: boolean }

/**
 * Stripe Invoicing write path for milestone invoices (PAY-006): customer → invoice → invoice item →
 * finalize, never "send" (the customer pays from the portal link). Every POST carries an idempotency
 * key derived from the local invoice id, so a retried request returns Stripe's first response instead
 * of creating a second invoice or item. Test-mode keys only, same rule as StripeTestPayments.
 * https://docs.stripe.com/api/customers/create, /api/invoices/create, /api/invoiceitems/create,
 * /api/invoices/finalize, /api/invoices/retrieve.
 */
export class StripeInvoicing {
  private key: string; private fetchImpl: typeof fetch;
  readonly reader: StripeReadOnly;
  readonly mode: StripeMode;
  constructor(secretKey: string, fetchImpl: typeof fetch = fetch, mode: StripeMode = "test") {
    assertKeyMode(secretKey, mode);
    this.key = secretKey; this.fetchImpl = fetchImpl; this.mode = mode;
    this.reader = new StripeReadOnly(secretKey, fetchImpl, mode);
  }

  private async post<T>(path: string, form: [string, string][], idempotencyKey: string): Promise<T> {
    if (!/^[a-z_]+(\/[A-Za-z0-9_]+)*$/.test(path)) throw new Error("Invalid Stripe path");
    const r = await this.fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "stripe-version": STRIPE_API_VERSION, "content-type": "application/x-www-form-urlencoded", "idempotency-key": idempotencyKey },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await r.json().catch(() => ({}))) as T & { error?: { message: string }; livemode?: boolean };
    if (!r.ok) throw new Error(`Stripe ${r.status}: ${body.error?.message ?? "error"}`);
    assertObjectMode(body, this.mode);
    return body;
  }

  createCustomer(c: { name: string; email: string | null; organizationId: string }) {
    const form: [string, string][] = [["name", c.name], ["metadata[organization_id]", c.organizationId]];
    if (c.email) form.push(["email", c.email]);
    return this.post<{ id: string }>("customers", form, `crestmont:customer:${c.organizationId}`);
  }

  createInvoice(i: { customer: string; description: string; daysUntilDue: number; metadata: Record<string, string>; localInvoiceId: string }) {
    const form: [string, string][] = [["customer", i.customer], ["collection_method", "send_invoice"], ["days_until_due", String(i.daysUntilDue)],
      ["auto_advance", "false"], ["pending_invoice_items_behavior", "exclude"], ["currency", "usd"], ["description", i.description]];
    for (const [k, v] of Object.entries(i.metadata)) form.push([`metadata[${k}]`, v]);
    return this.post<StripeInvoice>("invoices", form, `crestmont:invoice:${i.localInvoiceId}:create`);
  }

  addInvoiceItem(i: { customer: string; invoice: string; amountCents: number; description: string; localInvoiceId: string; taxJurisdictionId?: string }) {
    // The main item keeps its original idempotency key; each sales-tax item (LEGAL-005) has its own.
    const extra: [string, string][] = i.taxJurisdictionId ? [["metadata[crestmont_tax_jurisdiction]", i.taxJurisdictionId]] : [];
    return this.post<{ id: string; amount: number; invoice: string }>("invoiceitems", [["customer", i.customer], ["invoice", i.invoice], ["amount", String(i.amountCents)],
      ["currency", "usd"], ["description", i.description], ["metadata[crestmont_invoice_id]", i.localInvoiceId], ...extra],
      `crestmont:invoice:${i.localInvoiceId}:item${i.taxJurisdictionId ? `:tax:${i.taxJurisdictionId}` : ""}`);
  }

  finalizeInvoice(stripeInvoiceId: string, localInvoiceId: string) {
    return this.post<StripeInvoice>(`invoices/${stripeInvoiceId}/finalize`, [["auto_advance", "false"]], `crestmont:invoice:${localInvoiceId}:finalize`);
  }

  retrieveInvoice(stripeInvoiceId: string) { return this.reader.get<StripeInvoice>(`invoices/${stripeInvoiceId}`); }
  listCustomerInvoices(customer: string) { return this.reader.listInvoices({ customer }); }
}
