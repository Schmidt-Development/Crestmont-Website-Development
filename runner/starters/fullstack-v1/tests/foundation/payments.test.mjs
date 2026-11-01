import { test } from "node:test";
import assert from "node:assert/strict";
import { app, CONFIG, fakeStripe, off, openDate, payable, person } from "./helpers.mjs";
import { stripeMode } from "../../src/lib/stripe.js";

const skip = off("payments") || (!payable() ? "no bookable payable service" : false);
const KEYS = { STRIPE_SECRET_KEY: "sk_test_" + "k".repeat(24), STRIPE_WEBHOOK_SECRET: "whsec_" + "w".repeat(24) };

async function pendingBooking(t, i = 1) {
  const svc = payable();
  const slot = (await t.get(`/api/availability?service=${svc.id}&date=${openDate(t.now())}`)).json.slots[0];
  const r = await t.post("/api/bookings", { serviceId: svc.id, start: slot.start, ...person(i) });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.booking.status, "pending_payment");
  return { svc, ...r.json };
}

test("[payments] [security] test and live keys are kept apart by environment; live payments need explicit authorization", () => {
  assert.equal(stripeMode({ ENVIRONMENT: "staging", STRIPE_SECRET_KEY: "sk_test_abc" }).mode, "test");
  assert.equal(stripeMode({ ENVIRONMENT: "staging", STRIPE_SECRET_KEY: "sk_live_abc" }).reason, "live_key_outside_production");
  assert.equal(stripeMode({ ENVIRONMENT: "production", STRIPE_SECRET_KEY: "sk_test_abc" }).reason, "test_key_in_production");
  assert.equal(stripeMode({ ENVIRONMENT: "production", STRIPE_SECRET_KEY: "sk_live_abc" }).reason, "live_payments_not_authorized");
  assert.equal(stripeMode({ ENVIRONMENT: "production", STRIPE_SECRET_KEY: "sk_live_abc", PAYMENTS_LIVE_AUTHORIZED: "true" }).mode, "live");
  assert.equal(stripeMode({ ENVIRONMENT: "staging" }).reason, "payments_not_configured");
});

test("[payments] without the customer's Stripe keys a paid service cannot be booked online (honest refusal, nothing faked)", { skip }, async () => {
  const t = await app({ noKeys: true });
  const svc = payable();
  const slot = (await t.get(`/api/availability?service=${svc.id}&date=${openDate(t.now())}`)).json.slots[0];
  const r = await t.post("/api/bookings", { serviceId: svc.id, start: slot.start, ...person(1) });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "payments_unavailable");
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM bookings`).first()).n, 0);
});

test("[payments] checkout uses the SERVER's price; the browser cannot change the amount; the redirect alone confirms nothing", { skip }, async () => {
  const stripe = fakeStripe();
  const t = await app({ env: KEYS, fetch: stripe });
  const { svc, booking, manageToken } = await pendingBooking(t);
  const r = await t.post(`/api/bookings/${booking.reference}/checkout`, { amountCents: 1, priceCents: 1 }, { "x-manage-token": manageToken });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.url, /^https:\/\/checkout\.stripe\.com\//);
  const sent = stripe.calls.find((c) => c.path === "/v1/checkout/sessions");
  assert.equal(Number(sent.body["line_items[0][price_data][unit_amount]"]), svc.priceCents, "amount from the server catalogue");
  assert.equal(sent.body["line_items[0][price_data][currency]"], CONFIG.payments.currency);
  assert.ok(sent.headers["idempotency-key"], "Stripe request is idempotent");
  const row = await t.db.prepare(`SELECT status, amount_cents, mode FROM payments`).first();
  assert.deepEqual({ ...row }, { status: "pending", amount_cents: svc.priceCents, mode: "test" });
  assert.equal((await t.get(`/api/bookings/${booking.reference}`, { "x-manage-token": manageToken })).json.booking.status, "pending_payment", "returning from Checkout is not proof of payment");
});

test("[payments] [webhooks] only a correctly signed webhook marks the payment paid and confirms the booking; duplicates are ignored; amount mismatches are refused", { skip }, async () => {
  const stripe = fakeStripe();
  const t = await app({ env: KEYS, fetch: stripe });
  const { svc, booking, manageToken } = await pendingBooking(t);
  await t.post(`/api/bookings/${booking.reference}/checkout`, {}, { "x-manage-token": manageToken });
  const session = { id: "cs_test_1", payment_status: "paid", amount_total: svc.priceCents, currency: CONFIG.payments.currency, payment_intent: "pi_test_1" };
  const event = { id: "evt_1", type: "checkout.session.completed", data: { object: session } };
  const forged = await t.stripeEvent(event, "whsec_wrong_secret_0000000000");
  assert.equal(forged.status, 400);
  assert.equal((await t.db.prepare(`SELECT status FROM payments`).first()).status, "pending");
  const stale = await t.call("POST", "/api/webhooks/stripe", JSON.stringify(event), { "content-type": "application/json", "stripe-signature": "t=1,v1=abc" });
  assert.equal(stale.status, 400, "old timestamp / bad signature refused");
  const ok = await t.stripeEvent(event);
  assert.equal(ok.json.outcome, "paid");
  assert.equal((await t.db.prepare(`SELECT status FROM payments`).first()).status, "paid");
  assert.equal((await t.get(`/api/bookings/${booking.reference}`, { "x-manage-token": manageToken })).json.booking.status, "confirmed");
  assert.equal((await t.stripeEvent(event)).json.duplicate, true, "the same event twice is processed once");
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'payment_received'`).first()).n, 1);
  // A second booking whose session reports a different amount is not marked paid.
  const two = await pendingBooking(t, 2);
  await t.post(`/api/bookings/${two.booking.reference}/checkout`, {}, { "x-manage-token": two.manageToken });
  const bad = await t.stripeEvent({ id: "evt_2", type: "checkout.session.completed", data: { object: { ...session, id: "cs_test_2", amount_total: 1 } } });
  assert.equal(bad.json.outcome, "amount_mismatch");
  assert.equal((await t.db.prepare(`SELECT status FROM payments WHERE checkout_session_id = 'cs_test_2'`).first()).status, "pending");
});

test("[payments] [reconciliation] a missed webhook is recovered by reading the session from Stripe; refunds are recorded", { skip }, async () => {
  const stripe = fakeStripe();
  const t = await app({ env: KEYS, fetch: stripe });
  const { svc, booking, manageToken } = await pendingBooking(t);
  await t.post(`/api/bookings/${booking.reference}/checkout`, {}, { "x-manage-token": manageToken });
  stripe.sessions["cs_test_1"] = { id: "cs_test_1", status: "complete", payment_status: "paid", amount_total: svc.priceCents, currency: CONFIG.payments.currency, payment_intent: "pi_test_9" };
  await t.signInOwner();
  const pay = await t.db.prepare(`SELECT id FROM payments`).first();
  const r = await t.adminPost(`/api/admin/payments/${pay.id}/reconcile`, {});
  assert.equal(r.json.outcome, "paid");
  await t.stripeEvent({ id: "evt_r", type: "charge.refunded", data: { object: { payment_intent: "pi_test_9", amount_refunded: svc.priceCents } } });
  assert.equal((await t.db.prepare(`SELECT status FROM payments`).first()).status, "refunded");
  const list = await t.get("/api/admin/payments");
  assert.equal(list.json.items[0].status, "refunded", "visible to the administrator");
});

test("[payments] [concurrency] the slot stays reserved for the whole Checkout window; a payment after the hold lapsed never confirms a second booking", { skip }, async () => {
  const stripe = fakeStripe();
  const t = await app({ env: KEYS, fetch: stripe });
  const { svc, booking, manageToken } = await pendingBooking(t);
  const held = async () => (await t.db.prepare(`SELECT hold_expires_at FROM bookings WHERE reference = ?`).bind(booking.reference).first()).hold_expires_at;
  const firstHold = Date.parse(await held());
  t.setNow(t.now() + 25 * 60_000);
  assert.equal((await t.post(`/api/bookings/${booking.reference}/checkout`, {}, { "x-manage-token": manageToken })).status, 200);
  const sent = stripe.calls.find((c) => c.path === "/v1/checkout/sessions");
  const sessionEnd = Number(sent.body.expires_at) * 1000;
  assert.ok(Date.parse(await held()) > sessionEnd && sessionEnd > firstHold, "the hold covers the whole Checkout session");
  // The customer pays after the hold lapsed (the slot may have been sold again): paid, flagged, never confirmed.
  t.setNow(Date.parse(await held()) + 60_000);
  const late = await t.stripeEvent({ id: "evt_late", type: "checkout.session.completed", data: { object: { id: "cs_test_1", payment_status: "paid", amount_total: svc.priceCents, currency: CONFIG.payments.currency, payment_intent: "pi_late" } } });
  assert.equal(late.json.outcome, "paid_needs_review");
  assert.equal((await t.db.prepare(`SELECT status FROM bookings WHERE reference = ?`).bind(booking.reference).first()).status, "pending_payment");
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_log WHERE action = 'payment.needs_review'`).first());
  // An expired hold cannot be re-extended by starting a new checkout.
  assert.equal((await t.post(`/api/bookings/${booking.reference}/checkout`, {}, { "x-manage-token": manageToken })).status, 409);
});

test("[payments] [webhooks] an event that fails while being applied is not lost: Stripe's retry is processed", { skip }, async () => {
  const stripe = fakeStripe();
  const t = await app({ env: KEYS, fetch: stripe });
  const { svc, booking, manageToken } = await pendingBooking(t);
  await t.post(`/api/bookings/${booking.reference}/checkout`, {}, { "x-manage-token": manageToken });
  const event = { id: "evt_retry", type: "checkout.session.completed", data: { object: { id: "cs_test_1", payment_status: "paid", amount_total: svc.priceCents, currency: CONFIG.payments.currency, payment_intent: "pi_retry" } } };
  const prepare = t.env.DB.prepare.bind(t.env.DB);
  t.env.DB.prepare = (sql) => { if (/^UPDATE bookings SET status = 'confirmed'/.test(sql)) throw new Error("database unavailable"); return prepare(sql); };
  const first = await t.stripeEvent(event);
  assert.ok(first.status >= 500, "a failure is reported so Stripe retries");
  t.env.DB.prepare = prepare;
  const retry = await t.stripeEvent(event);
  assert.equal(retry.json.outcome, "paid");
  assert.equal((await t.db.prepare(`SELECT status FROM bookings WHERE reference = ?`).bind(booking.reference).first()).status, "confirmed");
});
