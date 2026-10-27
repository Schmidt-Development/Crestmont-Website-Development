// Stripe API version handling (PAY-003, PAY-006, PAY-004). Requests are pinned to STRIPE_API_VERSION; webhook payloads
// arrive in the webhook endpoint's version, so both pre-basil and basil+ shapes must be applied correctly. Payload
// shapes follow Stripe's changelog (SIMULATED fixtures — not events from a real Stripe account).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer } from "./support/app.ts";
import { createPackageOrder } from "../src/services/commerce.ts";
import { processStripeEvent } from "../src/services/payments.ts";
import { recordStripeEvent, type StripeEvent } from "../src/domain/stripe-webhook.ts";
import { OutboxEmail } from "../src/adapters/email.ts";
import { STRIPE_API_VERSION, StripeTestPayments, StripeReadOnly, StripeInvoicing } from "../src/adapters/payments.ts";
import { invoiceSubscription, invoicePaymentIntent, invoiceCharge, subscriptionPeriodEnd } from "../src/domain/stripe-shapes.ts";

const nowS = () => Math.floor(Date.now() / 1000);

test("[PAY-003] every Stripe API request pins the API version the integration is written against", async () => {
  assert.equal(STRIPE_API_VERSION, "2025-02-24.acacia");
  const seen: string[] = [];
  const f = (async (_u: string | URL, init?: RequestInit) => { seen.push(new Headers(init?.headers).get("stripe-version") ?? "none"); return new Response(JSON.stringify({ id: "x", url: "https://x", data: [], has_more: false, status: "pending" }), { status: 200 }); }) as typeof fetch;
  const p = new StripeTestPayments("sk_test_v", f);
  await p.createCheckout({ mode: "payment", lines: [{ name: "x", amountCents: 100 }], customerEmail: "a@b.example", successUrl: "https://x/s", cancelUrl: "https://x/c", metadata: {}, idempotencyKey: "k" });
  await p.createRefund("pi_1", 100, "r");
  await new StripeReadOnly("sk_test_v", f).get("balance");
  const inv = new StripeInvoicing("sk_test_v", f) as unknown as { post: (p: string, f: [string, string][], k: string) => Promise<unknown> };
  await inv.post("customers", [["email", "a@b.example"]], "c");
  assert.deepEqual(seen, Array(4).fill(STRIPE_API_VERSION));
});

test("[PAY-003] version-tolerant readers: pre-basil and basil+ invoice and subscription shapes", () => {
  assert.equal(invoiceSubscription({ subscription: "sub_old" }), "sub_old");
  assert.equal(invoiceSubscription({ parent: { type: "subscription_details", subscription_details: { subscription: "sub_new" } } }), "sub_new");
  assert.equal(invoiceSubscription({ parent: null }), null);
  assert.equal(invoicePaymentIntent({ payment_intent: "pi_old" }), "pi_old");
  assert.equal(invoicePaymentIntent({ payment_intent: { id: "pi_expanded" } }), "pi_expanded");
  assert.equal(invoicePaymentIntent({ payments: { data: [{ status: "canceled", payment: { type: "payment_intent", payment_intent: "pi_a" } }, { status: "paid", payment: { type: "payment_intent", payment_intent: "pi_b" } }] } }), "pi_b");
  assert.equal(invoicePaymentIntent({ payments: { data: [{ status: "paid", payment: { type: "charge", charge: "ch_1" } }] } }), null);
  assert.equal(invoiceCharge({ payments: { data: [{ payment: { type: "charge", charge: "ch_1" } }] } }), "ch_1");
  assert.equal(subscriptionPeriodEnd({ current_period_end: 100 }), 100);
  assert.equal(subscriptionPeriodEnd({ items: { data: [{ current_period_end: 200 }, { current_period_end: 300 }] } }), 300);
  assert.equal(subscriptionPeriodEnd({}), null);
});

test("[PAY-006] [PAY-004] basil-shaped webhooks: invoice payments are linked through a pinned-version lookup (never applied without one), subscription fields read from their new homes", async () => {
  const t = await createTestApp();
  const cu = await createCustomer(t.db, `v${Date.now()}@ver.example`, "Version Bakery");
  const order = await createPackageOrder(t.db, cu.organizationId, "starter", cu.id);
  const ctx = { db: t.db, email: new OutboxEmail(t.db), baseUrl: "https://crestmont.test" };
  const basilInvoice = (id: string) => ({ id: "in_basil_1", object: "invoice", status: "paid", amount_paid: order.amountCents, customer: "cus_v", customer_email: cu.email,
    parent: { type: "quote_details", quote_details: null, subscription_details: null }, metadata: { crestmont_invoice_id: order.invoiceId }, _evt: id });
  const send = async (evt: StripeEvent, extra: object = {}) => { if (await recordStripeEvent(t.db, evt, JSON.stringify(evt)) === "new") await processStripeEvent({ ...ctx, ...extra }, evt); };

  // No lookup available: the event must FAIL (retried later) rather than record a payment refunds can't find.
  await send({ id: "evt_basil_nolookup", type: "invoice.paid", created: nowS(), data: { object: basilInvoice("a") } } as StripeEvent);
  assert.equal((await t.db.prepare(`SELECT status FROM stripe_events WHERE id = 'evt_basil_nolookup'`).first<{ status: string }>())!.status, "failed");
  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM payments WHERE invoice_id = ?`).bind(order.invoiceId).first<{ n: number }>())!.n, 0);

  // With the lookup (GET /v1/invoices/:id at the pinned version) the PaymentIntent is recorded.
  const looked: string[] = [];
  await send({ id: "evt_basil_lookup", type: "invoice.paid", created: nowS(), data: { object: basilInvoice("b") } } as StripeEvent,
    { stripeLookup: async (id: string) => { looked.push(id); return { paymentIntentId: "pi_basil_1", chargeId: "ch_basil_1" }; } });
  assert.deepEqual(looked, ["in_basil_1"]);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM payments WHERE invoice_id = ? AND stripe_payment_intent_id = 'pi_basil_1'`).bind(order.invoiceId).first<{ n: number }>())!.n, 1);

  // Subscriptions: invoice.payment_failed carries the subscription under parent.subscription_details; period end on items.
  await t.db.prepare(`UPDATE organizations SET stripe_customer_id = 'cus_v' WHERE id = ?`).bind(cu.organizationId).run();
  const end = nowS() + 30 * 86400;
  await send({ id: "evt_sub_upd", type: "customer.subscription.updated", created: nowS(), data: { object: { id: "sub_basil", object: "subscription", customer: "cus_v", status: "active", items: { data: [{ current_period_end: end }] }, metadata: { organization_id: cu.organizationId, product_id: "essential" } } } } as StripeEvent);
  const sub = await t.db.prepare(`SELECT status, current_period_end FROM subscriptions WHERE stripe_subscription_id = 'sub_basil'`).first<{ status: string; current_period_end: string }>();
  assert.deepEqual({ ...sub }, { status: "active", current_period_end: new Date(end * 1000).toISOString() });
  await send({ id: "evt_inv_fail", type: "invoice.payment_failed", created: nowS(), data: { object: { id: "in_basil_2", object: "invoice", customer: "cus_v", parent: { type: "subscription_details", subscription_details: { subscription: "sub_basil" } } } } } as StripeEvent);
  assert.equal((await t.db.prepare(`SELECT status FROM subscriptions WHERE stripe_subscription_id = 'sub_basil'`).first<{ status: string }>())!.status, "past_due");
});

test("[PAY-003] the documented webhook event list matches exactly the events the handler applies", async () => {
  const { readFileSync } = await import("node:fs");
  const handled = [...readFileSync("src/services/payments.ts", "utf8").matchAll(/case "([a-z_.]+)":/g)].map((m) => m[1]).sort();
  const doc = readFileSync("docs/DEPLOYMENT.md", "utf8");
  const line = doc.slice(doc.indexOf("Events to enable:"), doc.indexOf("\n", doc.indexOf("Events to enable:")));
  const listed = [...line.matchAll(/`([a-z_.|]+)`/g)].flatMap((m) => { const [base, ...alts] = m[1].split("|"); const stem = base.slice(0, base.lastIndexOf(".") + 1); return [base, ...alts.map((a) => stem + a)]; }).sort();
  assert.deepEqual(listed, handled);
});
