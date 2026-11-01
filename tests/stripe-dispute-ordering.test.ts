// A dispute that arrives before its payment (Stripe does not order webhook events). Staging deploy 41258366594:
// charge.dispute.created was processed 40 ms after checkout.session.completed, before the payment row existed, so the
// dispute showed "Unknown customer / Not matched" forever. All records are TEST DATA; events are SIGNED FIXTURES posted
// to the real webhook route; Stripe is never called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";

class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); return { id: `cs_test_order_${this.checkouts.length}`, url: "https://checkout.stripe.com/c/pay/x" }; }
  async createBillingPortal() { return { url: "https://billing.stripe.com/p/session/test_x" }; }
  async createRefund() { return { id: "re_x", status: "succeeded" }; }
}
const WHSEC = "whsec_dispute_ordering_fixture";
let seq = 0;
async function send(t: { client: () => TestClient }, type: string, object: Record<string, unknown>) {
  const body = JSON.stringify({ id: `evt_order_${++seq}`, object: "event", type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const r = await t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}` } });
  assert.equal(r.status, 200);
}
async function paidCheckout(pi: string) {
  const fake = new FakePayments();
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC, overrides: { payments: fake } });
  const cu = await createCustomer(t.db, `dispute-order-${pi}@fixture.example`, "Dispute Ordering Fixture LLC");
  const c = t.client(); await c.login(cu.email);
  await c.post("/checkout/starter", { terms: "1" });
  const co = fake.checkouts.at(-1)!;
  const session = { id: `cs_${pi}`, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: co.lines.reduce((s, l) => s + l.amountCents * (l.quantity ?? 1), 0), payment_intent: pi, customer: `cus_${pi}`, customer_email: co.customerEmail, metadata: co.metadata };
  const dispute = (status = "needs_response") => ({ id: `du_${pi}`, object: "dispute", payment_intent: pi, charge: `ch_${pi}`, amount: session.amount_total, reason: "fraudulent", status, evidence_details: { due_by: Math.floor(Date.now() / 1000) + 9 * 86400 } });
  return { t, cu, session, dispute };
}
const one = async <T>(t: { db: import("../src/app/context.ts").Env["DB"] }, sql: string, ...b: unknown[]) => (await t.db.prepare(sql).bind(...b).first<T>())!;

test("[PAY-008] a dispute processed before its payment is linked to the customer and payment once the payment is recorded", async () => {
  const w = await paidCheckout("pi_dispute_first");
  await send(w.t, "charge.dispute.created", w.dispute());           // arrives first, as on staging
  const orphan = await one<{ organization_id: string | null; payment_id: string | null }>(w.t, `SELECT organization_id, payment_id FROM disputes WHERE stripe_dispute_id = 'du_pi_dispute_first'`);
  assert.deepEqual({ ...orphan }, { organization_id: null, payment_id: null }, "no payment exists yet");
  await send(w.t, "checkout.session.completed", w.session);          // 40 ms later
  const pay = await one<{ id: string; status: string; organization_id: string }>(w.t, `SELECT id, status, organization_id FROM payments WHERE stripe_payment_intent_id = 'pi_dispute_first'`);
  const linked = await one<{ organization_id: string; payment_id: string }>(w.t, `SELECT organization_id, payment_id FROM disputes WHERE stripe_dispute_id = 'du_pi_dispute_first'`);
  assert.deepEqual({ ...linked }, { organization_id: w.cu.organizationId, payment_id: pay.id });
  assert.equal(pay.status, "disputed", "an open dispute marks the payment disputed, as in-order delivery would");
  assert.equal((await one<{ n: number }>(w.t, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'dispute.linked_late' AND subject_id = ?`, pay.id)).n, 1);
  // Staff see the customer and the payment instead of "Unknown customer / Not matched".
  const owner = await createStaff(w.t.db, "owner");
  const oc = w.t.client(); await oc.login(owner.email, TEST_PASSWORD, owner.secret);
  const page = await (await oc.get(`/staff/disputes?q=${encodeURIComponent("Dispute Ordering Fixture")}`)).text();
  assert.match(page, /du_pi_dispute_first/);
  assert.match(page, /Dispute Ordering Fixture LLC/);
  // Redelivery of the payment event changes nothing further.
  await send(w.t, "checkout.session.completed", w.session);
  assert.equal((await one<{ n: number }>(w.t, `SELECT COUNT(*) n FROM payments WHERE stripe_payment_intent_id = 'pi_dispute_first'`)).n, 1);
  assert.equal((await one<{ n: number }>(w.t, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'dispute.linked_late'`)).n, 1);
});

test("[PAY-008] in-order events behave as before, and a dispute already won does not mark the late payment disputed", async () => {
  const inOrder = await paidCheckout("pi_in_order");
  await send(inOrder.t, "checkout.session.completed", inOrder.session);
  await send(inOrder.t, "charge.dispute.created", inOrder.dispute());
  const p = await one<{ id: string; status: string }>(inOrder.t, `SELECT id, status FROM payments WHERE stripe_payment_intent_id = 'pi_in_order'`);
  assert.equal(p.status, "disputed");
  assert.equal((await one<{ payment_id: string }>(inOrder.t, `SELECT payment_id FROM disputes WHERE stripe_dispute_id = 'du_pi_in_order'`)).payment_id, p.id);
  const won = await paidCheckout("pi_won_first");
  await send(won.t, "charge.dispute.closed", won.dispute("won"));
  await send(won.t, "checkout.session.completed", won.session);
  const wp = await one<{ id: string; status: string }>(won.t, `SELECT id, status FROM payments WHERE stripe_payment_intent_id = 'pi_won_first'`);
  assert.equal(wp.status, "succeeded", "a closed (won) dispute is linked but does not mark the payment disputed");
  assert.equal((await one<{ payment_id: string }>(won.t, `SELECT payment_id FROM disputes WHERE stripe_dispute_id = 'du_pi_won_first'`)).payment_id, wp.id);
});
