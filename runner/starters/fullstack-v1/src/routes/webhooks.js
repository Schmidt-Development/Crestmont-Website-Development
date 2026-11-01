// Stripe webhooks (the customer's own account): signature verified, each event processed once, payment state
// changes are conditional (a duplicate or out-of-order delivery cannot regress a paid payment).
import { CONFIG } from "../lib/config.js";
import { json } from "../lib/http.js";
import { audit, nowIso, nowMs, one } from "../lib/db.js";
import { verifyWebhook } from "../lib/stripe.js";
import { queueStmt } from "../lib/notify.js";
import { formatWhen } from "../lib/booking.js";

const money = (cents, cur) => new Intl.NumberFormat("en-US", { style: "currency", currency: cur.toUpperCase() }).format(cents / 100);

export async function stripeWebhook(env, request) {
  const payload = await request.text();
  const event = await verifyWebhook(env, payload, request.headers.get("stripe-signature"), nowMs(env));
  const seen = await env.DB.prepare(`INSERT OR IGNORE INTO webhook_events (provider, event_id, type, received_at, outcome) VALUES ('stripe', ?, ?, ?, 'processing')`).bind(String(event.id), String(event.type), nowIso(env)).run();
  if (seen.meta.changes !== 1) return json({ received: true, duplicate: true });
  let outcome;
  try { outcome = await apply(env, event); }
  catch (e) {
    // Not processed: forget the event so Stripe's retry is applied instead of being answered as a duplicate.
    await env.DB.prepare(`DELETE FROM webhook_events WHERE provider = 'stripe' AND event_id = ? AND outcome = 'processing'`).bind(String(event.id)).run();
    throw e;
  }
  await env.DB.prepare(`UPDATE webhook_events SET outcome = ? WHERE provider = 'stripe' AND event_id = ?`).bind(outcome, String(event.id)).run();
  return json({ received: true, outcome });
}

export async function apply(env, event) {
  const obj = event.data?.object ?? {};
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    if (obj.payment_status !== "paid") return "not_paid_yet";
    return markPaid(env, obj, `stripe:${event.id}`);
  }
  if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
    const p = await one(env.DB, `SELECT * FROM payments WHERE checkout_session_id = ?`, String(obj.id));
    if (!p) return "unknown_session";
    await env.DB.prepare(`UPDATE payments SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'`).bind(event.type.endsWith("expired") ? "expired" : "failed", nowIso(env), p.id).run();
    return "payment_not_completed";
  }
  if (event.type === "charge.refunded") {
    const p = await one(env.DB, `SELECT * FROM payments WHERE payment_intent_id = ?`, String(obj.payment_intent ?? ""));
    if (!p) return "unknown_payment";
    const refunded = Number(obj.amount_refunded) || 0;
    await env.DB.prepare(`UPDATE payments SET refunded_cents = MAX(refunded_cents, ?), status = CASE WHEN ? >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END, updated_at = ? WHERE id = ? AND status IN ('paid', 'partially_refunded')`)
      .bind(refunded, refunded, nowIso(env), p.id).run();
    await audit(env, "stripe", "payment.refunded", "payment", p.id, { refundedCents: refunded });
    return "refund_recorded";
  }
  return "ignored";
}

/** Mark a payment paid from a Stripe Checkout Session (webhook or reconciliation). Amount and currency must match. */
export async function markPaid(env, session, actor) {
  const p = await one(env.DB, `SELECT * FROM payments WHERE checkout_session_id = ?`, String(session.id));
  if (!p) return "unknown_session";
  if (p.status === "paid" || p.status === "refunded" || p.status === "partially_refunded") return "already_paid";
  if (Number(session.amount_total) !== p.amount_cents || String(session.currency).toLowerCase() !== p.currency) {
    await audit(env, actor, "payment.amount_mismatch", "payment", p.id, { expected: p.amount_cents, got: session.amount_total, currency: session.currency });
    return "amount_mismatch";
  }
  const b = p.booking_id ? await one(env.DB, `SELECT b.*, s.name AS service_name FROM bookings b JOIN services s ON s.id = b.service_id WHERE b.id = ?`, p.booking_id) : null;
  // The booking is confirmed only while its hold still reserves the slot. A payment that arrives after the hold
  // lapsed (the slot may have been sold again) is recorded as paid and flagged for a refund or a manual rebooking;
  // it never creates a second confirmed booking for the same capacity.
  let confirmed = false;
  if (b && b.status === "pending_payment") {
    const c = await env.DB.prepare(`UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'pending_payment' AND (hold_expires_at IS NULL OR hold_expires_at > ?)`).bind(nowIso(env), b.id, nowIso(env)).run();
    confirmed = c.meta.changes === 1;
  }
  const stmts = [env.DB.prepare(`UPDATE payments SET status = 'paid', payment_intent_id = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'expired', 'failed')`).bind(session.payment_intent ? String(session.payment_intent) : null, nowIso(env), p.id)];
  if (confirmed) {
    stmts.push(env.DB.prepare(`INSERT INTO booking_history (booking_id, from_status, to_status, actor, note, at) VALUES (?, 'pending_payment', 'confirmed', ?, 'payment received', ?)`).bind(b.id, actor.split(":")[0], nowIso(env)));
    const payload = { name: b.customer_name, reference: b.reference, serviceName: b.service_name, when: formatWhen(b.start_at), amount: money(p.amount_cents, p.currency), manageUrl: "" };
    stmts.push(queueStmt(env, `payment:${p.id}:paid`, b.customer_email, "payment_received", payload));
  }
  await env.DB.batch(stmts);
  await audit(env, actor, "payment.paid", "payment", p.id, { amountCents: p.amount_cents, currency: p.currency, mode: p.mode, business: CONFIG.business?.name });
  if (b && !confirmed) {
    await audit(env, actor, "payment.needs_review", "booking", b.id, { paymentId: p.id, bookingStatus: b.status, reason: b.status === "pending_payment" ? "hold expired before payment" : `booking is ${b.status}` });
    return "paid_needs_review";
  }
  return "paid";
}
