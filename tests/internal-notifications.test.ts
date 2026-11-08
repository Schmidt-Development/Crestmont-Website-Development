// Internal operational email (Founder directive 2026-11-08, Phase 14): new paid orders and refund requests reach the
// internal mailbox once, from the verified event, and never replace the customer's own email. TEST DATA throughout:
// Stripe events are SIGNED FIXTURES and mail goes to the development outbox; nothing reaches Stripe or Resend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, lastEmail, type TestClient } from "./support/app.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Env } from "../src/app/context.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";
import { createPackageOrder, markInvoicePaid } from "../src/services/commerce.ts";
import { completePaidInvoice } from "../src/services/payments.ts";
import { OutboxEmail } from "../src/adapters/email.ts";

const mailCtx = (db: Env["DB"]) => ({ db, email: new OutboxEmail(db), baseUrl: "http://crestmont.test" });

const INBOX = "crestmontwebsitedevelopment@gmail.com";
const WHSEC = "whsec_test_internal_notifications";
class FakePayments implements PaymentsAdapter {
  readonly configured = true; readonly mode = "test" as const;
  async createCheckout(_req: CheckoutRequest) { return { id: "cs_test_x", url: "https://checkout.stripe.com/c/pay/cs_test_x" }; }
  async createBillingPortal() { return { url: "https://billing.stripe.com/p/session/test" }; }
  async createRefund(pi: string, amount: number) { return { id: `re_test_${pi}_${amount}`, status: "succeeded" }; }
}
const count = async (db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const nowS = () => Math.floor(Date.now() / 1000);
async function webhook(t: { client: () => TestClient }, id: string, type: string, object: Record<string, unknown>) {
  const body = JSON.stringify({ id, type, created: nowS(), data: { object } });
  const ts = nowS();
  return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}`, "content-type": "application/json" } });
}

test("[EMAIL-001] a verified website payment emails the internal mailbox once, with the order's facts; duplicates and retries send nothing more", async () => {
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC, overrides: { payments: new FakePayments() } });
  const cu = await createCustomer(t.db, "owner@fixture-bakery.example", "Fixture Bakery (TEST)");
  const order = await createPackageOrder(t.db, cu.organizationId, "starter", cu.id);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE to_email = ?`, INBOX), 0, "nothing before Stripe confirms payment");

  const session = { id: "cs_internal_1", mode: "payment", payment_status: "paid", amount_total: order.amountCents, payment_intent: "pi_internal_1",
    metadata: { organization_id: cu.organizationId, invoice_id: order.invoiceId, order_id: order.orderId, kind: "package" } };
  assert.equal((await webhook(t, "evt_internal_1", "checkout.session.completed", session)).status, 200);
  await webhook(t, "evt_internal_1", "checkout.session.completed", session); // Stripe retry of the same event
  await webhook(t, "evt_internal_2", "checkout.session.completed", session); // a duplicate event for the same payment
  await completePaidInvoice(mailCtx(t.db), order.invoiceId, null, "repair sweep"); // the repair sweep re-runs follow-ups

  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE to_email = ? AND idempotency_key = ?`, INBOX, `internal:paid_order:${order.invoiceId}`), 1);
  const mail = (await lastEmail(t.db, INBOX))!;
  assert.equal(mail.template, "internal_alert");
  assert.match(mail.subject, /^New Website Order — Payment Confirmed \(Fixture Bakery \(TEST\)\)$/);
  for (const re of [/Customer: Pat Customer/, /Business: Fixture Bakery \(TEST\)/, /Package: Starter website package/, /Amount paid: \$\d[\d,]*\.\d\d/, /Payment date: \d{4}-\d{2}-\d{2}/,
    new RegExp(`Order reference: ${order.orderId}`), /\/staff\/projects\/prj_/, /Assign a project manager/]) assert.match(mail.text_body, re);
  // The customer's own receipt is untouched: it still goes to the customer.
  assert.equal((await lastEmail(t.db, cu.email))?.template, "receipt");
});

test("[EMAIL-001] a simulated test payment sends no internal order email", async () => {
  const t = await createTestApp({});
  const cu = await createCustomer(t.db, "sim@fixture.example", "Simulated Co (TEST)");
  const order = await createPackageOrder(t.db, cu.organizationId, "starter", cu.id);
  await markInvoicePaid(t.db, order.invoiceId, { amountCents: order.amountCents, paymentIntentId: null, provider: "simulated", simulatedTransactionId: newId("sim") });
  await completePaidInvoice(mailCtx(t.db), order.invoiceId, null, "simulation");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE to_email = ?`, INBOX), 0);
});

test("[EMAIL-001] a refund request emails the internal mailbox once; the customer still gets their own confirmation", async () => {
  const t = await createTestApp({});
  const cu = await createCustomer(t.db, "refund@fixture.example", "Refund Bakery (TEST)");
  const pay = newId("pay");
  await t.db.prepare(`INSERT INTO payments (id, organization_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES (?,?, 99900, 'pi_refund_internal', 'succeeded', ?)`).bind(pay, cu.organizationId, nowIso()).run();
  const c = t.client(); await c.login(cu.email);
  assert.equal((await c.post("/portal/billing/refund-request", { payment_id: pay, reason: "The project was cancelled before kickoff (TEST)." })).status, 303);
  assert.equal((await c.post("/portal/billing/refund-request", { payment_id: pay, reason: "The project was cancelled before kickoff (TEST)." })).status, 422, "a second request for the same payment is refused");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE to_email = ? AND template = 'internal_alert'`, INBOX), 1);
  const mail = (await lastEmail(t.db, INBOX))!;
  assert.match(mail.subject, /^Refund request — Refund Bakery \(TEST\)$/);
  for (const re of [/Customer: Pat Customer/, /Amount requested: \$999\.00/, /Reason: The project was cancelled before kickoff/, /\/staff\/refunds\/rf_/, /only the Owner may approve an exception/]) assert.match(mail.text_body, re);
  assert.equal((await lastEmail(t.db, cu.email))?.template, "refund_request");
});
