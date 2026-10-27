// Stripe adapter (PAY-001, PAY-004, PAY-006, PAY-009). TEST MODE ONLY until the Founder authorises live payments
// after the legal entity exists (PAY-010). A live secret key is refused at construction.
// When no key is configured the platform reports payments as "not configured" and checkout
// buttons explain that online payment is unavailable — nothing is simulated.

export class LivePaymentsNotAuthorized extends Error {}

export interface CheckoutLine { name: string; amountCents: number; quantity?: number }
export interface CheckoutRequest {
  mode: "payment" | "subscription";
  lines: CheckoutLine[];
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  recurringInterval?: "month";
  idempotencyKey: string;
}

export interface PaymentsAdapter {
  readonly configured: boolean;
  readonly mode: "test" | "none";
  createCheckout(req: CheckoutRequest): Promise<{ id: string; url: string }>;
  createBillingPortal(customerId: string, returnUrl: string): Promise<{ url: string }>;
  createRefund(paymentIntentId: string, amountCents: number, idempotencyKey: string): Promise<{ id: string; status: string }>;
}

export class NoPayments implements PaymentsAdapter {
  readonly configured = false;
  readonly mode = "none" as const;
  async createCheckout(): Promise<never> { throw new Error("Payments are not configured"); }
  async createBillingPortal(): Promise<never> { throw new Error("Payments are not configured"); }
  async createRefund(): Promise<never> { throw new Error("Payments are not configured"); }
}

export class StripeTestPayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  private key: string; private fetchImpl: typeof fetch;
  constructor(secretKey: string, fetchImpl: typeof fetch = fetch) {
    if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("rk_test_")) {
      throw new LivePaymentsNotAuthorized("Only Stripe test-mode keys are accepted until live payments are authorised by the Founder");
    }
    this.key = secretKey; this.fetchImpl = fetchImpl;
  }

  private async call<T>(path: string, form: Record<string, string>, idem?: string): Promise<T> {
    const r = await this.fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/x-www-form-urlencoded", ...(idem ? { "idempotency-key": idem } : {}) },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await r.json()) as T & { error?: { message: string } };
    if (!r.ok) throw new Error(`Stripe: ${body.error?.message ?? r.status}`);
    return body;
  }

  async createCheckout(req: CheckoutRequest) {
    const form: Record<string, string> = {
      mode: req.mode, success_url: req.successUrl, cancel_url: req.cancelUrl, customer_email: req.customerEmail,
    };
    req.lines.forEach((l, i) => {
      form[`line_items[${i}][quantity]`] = String(l.quantity ?? 1);
      form[`line_items[${i}][price_data][currency]`] = "usd";
      form[`line_items[${i}][price_data][unit_amount]`] = String(l.amountCents);
      form[`line_items[${i}][price_data][product_data][name]`] = l.name;
      if (req.mode === "subscription") form[`line_items[${i}][price_data][recurring][interval]`] = req.recurringInterval ?? "month";
    });
    for (const [k, v] of Object.entries(req.metadata)) form[`metadata[${k}]`] = v;
    if (req.mode === "payment") for (const [k, v] of Object.entries(req.metadata)) form[`payment_intent_data[metadata][${k}]`] = v;
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

/**
 * Read-only Stripe API access for fee import (FIN-002) and Stripe-side reconciliation (PAY-009).
 * GET requests only: this class has no method that can create, change or refund anything.
 * Same test-mode-only rule as StripeTestPayments.
 */
export class StripeReadOnly {
  private key: string; private fetchImpl: typeof fetch;
  constructor(secretKey: string, fetchImpl: typeof fetch = fetch) {
    if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("rk_test_")) {
      throw new LivePaymentsNotAuthorized("Only Stripe test-mode keys are accepted until live payments are authorised by the Founder");
    }
    this.key = secretKey; this.fetchImpl = fetchImpl;
  }

  async get<T>(path: string, query: [string, string][] = []): Promise<T> {
    if (!/^[a-z_]+(\/[A-Za-z0-9_]+)*$/.test(path)) throw new Error("Invalid Stripe path");
    const qs = query.length ? `?${new URLSearchParams(query).toString()}` : "";
    const r = await this.fetchImpl(`https://api.stripe.com/v1/${path}${qs}`, { method: "GET", headers: { authorization: `Bearer ${this.key}` } });
    const body = (await r.json().catch(() => ({}))) as T & { error?: { message: string }; livemode?: boolean };
    if (!r.ok) throw new Error(`Stripe ${r.status}: ${body.error?.message ?? "error"}`);
    if (body.livemode === true) throw new LivePaymentsNotAuthorized("Stripe returned a live-mode object; live payments are not authorised");
    return body;
  }

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
  constructor(secretKey: string, fetchImpl: typeof fetch = fetch) {
    if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("rk_test_")) {
      throw new LivePaymentsNotAuthorized("Only Stripe test-mode keys are accepted until live payments are authorised by the Founder");
    }
    this.key = secretKey; this.fetchImpl = fetchImpl;
    this.reader = new StripeReadOnly(secretKey, fetchImpl);
  }

  private async post<T>(path: string, form: [string, string][], idempotencyKey: string): Promise<T> {
    if (!/^[a-z_]+(\/[A-Za-z0-9_]+)*$/.test(path)) throw new Error("Invalid Stripe path");
    const r = await this.fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": idempotencyKey },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await r.json().catch(() => ({}))) as T & { error?: { message: string }; livemode?: boolean };
    if (!r.ok) throw new Error(`Stripe ${r.status}: ${body.error?.message ?? "error"}`);
    if (body.livemode === true) throw new LivePaymentsNotAuthorized("Stripe returned a live-mode object; live payments are not authorised");
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

  addInvoiceItem(i: { customer: string; invoice: string; amountCents: number; description: string; localInvoiceId: string }) {
    return this.post<{ id: string; amount: number; invoice: string }>("invoiceitems", [["customer", i.customer], ["invoice", i.invoice], ["amount", String(i.amountCents)],
      ["currency", "usd"], ["description", i.description], ["metadata[crestmont_invoice_id]", i.localInvoiceId]], `crestmont:invoice:${i.localInvoiceId}:item`);
  }

  finalizeInvoice(stripeInvoiceId: string, localInvoiceId: string) {
    return this.post<StripeInvoice>(`invoices/${stripeInvoiceId}/finalize`, [["auto_advance", "false"]], `crestmont:invoice:${localInvoiceId}:finalize`);
  }

  retrieveInvoice(stripeInvoiceId: string) { return this.reader.get<StripeInvoice>(`invoices/${stripeInvoiceId}`); }
  listCustomerInvoices(customer: string) { return this.reader.listInvoices({ customer }); }
}
