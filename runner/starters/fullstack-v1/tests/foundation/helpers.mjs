// Shared helpers for the foundation tests. They run against THIS website's business.config.json: a feature the
// configuration enables is tested for real (never skipped); a feature it does not enable is skipped, and the
// acceptance gates check that no required feature's tests were skipped.
import { CONFIG, enabled } from "../../src/lib/config.js";
import { isDate, localDate, weekdayOf } from "../../src/lib/time.js";
import { app as baseApp, fakeStripe } from "../../scripts/lib/harness.mjs";
export { fakeStripe, CONFIG, enabled };

/** Stripe TEST-mode credentials for the offline tests (fake values; the fake Stripe API never leaves the process). */
export const TEST_KEYS = { STRIPE_SECRET_KEY: "sk_test_" + "k".repeat(24), STRIPE_WEBHOOK_SECRET: "whsec_" + "w".repeat(24) };

/** The site under test. When payments are enabled it gets test keys and the fake Stripe API unless noKeys is set. */
export function app(o = {}) {
  const pay = enabled(CONFIG, "payments") && !o.noKeys;
  return baseApp({ ...o, env: { ...(pay ? TEST_KEYS : {}), ...(o.env ?? {}) }, fetch: o.fetch ?? (pay ? fakeStripe() : undefined) });
}

/**
 * Book a slot as a customer would and, when the service is paid online, complete the payment the way Stripe does
 * (Checkout Session + signed checkout.session.completed webhook). Returns the confirmed booking and its token.
 */
export async function book(t, serviceId, start, i = 1) {
  const r = await t.post("/api/bookings", { serviceId, start, ...person(i) }, { "cf-connecting-ip": `198.18.0.${i}` });
  if (r.status !== 201) throw new Error(`booking failed: ${r.status} ${JSON.stringify(r.json)}`);
  if (r.json.booking.status === "pending_payment") {
    const c = await t.post(`/api/bookings/${r.json.booking.reference}/checkout`, {}, { "x-manage-token": r.json.manageToken, "cf-connecting-ip": `198.18.0.${i}` });
    if (c.status !== 200) throw new Error(`checkout failed: ${c.status} ${JSON.stringify(c.json)}`);
    const p = await t.db.prepare(`SELECT checkout_session_id, amount_cents, currency FROM payments WHERE booking_id = (SELECT id FROM bookings WHERE reference = ?)`).bind(r.json.booking.reference).first();
    const w = await t.stripeEvent({ id: `evt_${p.checkout_session_id}`, type: "checkout.session.completed", data: { object: { id: p.checkout_session_id, payment_status: "paid", amount_total: p.amount_cents, currency: p.currency, payment_intent: `pi_${p.checkout_session_id}` } } });
    if (w.json?.outcome !== "paid") throw new Error(`payment webhook not applied: ${JSON.stringify(w.json)}`);
    r.json.booking.status = "confirmed";
  }
  return r.json;
}

export const off = (f) => (enabled(CONFIG, f) ? false : `feature ${f} is not enabled in business.config.json`);

/** First bookable service. */
export const bookable = () => (CONFIG.services ?? []).find((s) => s.bookable && !s.payable) ?? (CONFIG.services ?? []).find((s) => s.bookable && (!s.payable || enabled(CONFIG, "payments")));
export const payable = () => (CONFIG.services ?? []).find((s) => s.bookable && s.payable);

/** Next open local date at least `minDays` after `nowMs` (business hours, blackout dates, booking window). */
export function openDate(nowMs, minDays = 2) {
  const tz = CONFIG.business.timeZone;
  for (let i = minDays; i < (CONFIG.booking?.maxDaysAhead ?? 30); i++) {
    const d = localDate(nowMs + i * 864e5, tz);
    if (isDate(d) && (CONFIG.hours?.[weekdayOf(d)] ?? []).length && !(CONFIG.booking?.blackoutDates ?? []).includes(d)) return d;
  }
  throw new Error("no open date in the booking window (check hours and blackout dates)");
}

export const person = (i = 1) => ({ name: `Test Customer ${i}`, email: `customer${i}@example.test`, phone: "555-0100", postalCode: CONFIG.serviceArea?.postalCodes?.[0] ?? undefined, address: CONFIG.booking?.requireAddress ? "1 Test Street" : undefined });
