// Stripe through the CUSTOMER's own account (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are Worker secrets on the
// customer's deployment; never in source). Test and live keys are kept apart by environment. Prices always come
// from the server's catalogue; a browser redirect is never proof of payment — only a verified webhook or a
// reconciliation read from Stripe marks a payment paid.
import { HttpError } from "./http.js";
import { hmacSha256Hex, safeEqual } from "./crypto.js";

/** Which mode the configured key is in, and whether it is allowed in this environment. */
export function stripeMode(env) {
  const key = env.STRIPE_SECRET_KEY ?? "";
  if (!key) return { ok: false, reason: "payments_not_configured", message: "Online payment is not set up yet." };
  const mode = /^(sk|rk)_test_/.test(key) ? "test" : /^(sk|rk)_live_/.test(key) ? "live" : null;
  if (!mode) return { ok: false, reason: "payments_misconfigured", message: "The payment key is not a Stripe secret key." };
  const production = env.ENVIRONMENT === "production";
  if (!production && mode === "live") return { ok: false, reason: "live_key_outside_production", message: "A live payment key is refused outside production." };
  if (production && mode === "test") return { ok: false, reason: "test_key_in_production", message: "A test payment key is refused in production." };
  if (production && env.PAYMENTS_LIVE_AUTHORIZED !== "true") return { ok: false, reason: "live_payments_not_authorized", message: "Live payments have not been authorized for this website yet." };
  return { ok: true, mode };
}

function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === "object") form(v, key, out); else out.append(key, String(v));
  }
  return out;
}

async function stripe(env, fetchImpl, method, path, body, idempotencyKey) {
  const res = await fetchImpl(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
    body: body ? form(body).toString() : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, "payment_provider_error", "The payment provider could not be reached. Please try again.", { providerStatus: res.status });
  return data;
}

/** Create a Checkout Session for an amount computed on the server. */
export async function createCheckoutSession(env, fetchImpl, p) {
  const m = stripeMode(env);
  if (!m.ok) throw new HttpError(503, m.reason, m.message);
  const s = await stripe(env, fetchImpl, "POST", "/checkout/sessions", {
    mode: "payment",
    success_url: `${p.origin}/booking/confirmation.html?ref=${encodeURIComponent(p.reference)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${p.origin}/booking/manage.html?ref=${encodeURIComponent(p.reference)}`,
    customer_email: p.email,
    client_reference_id: p.paymentId,
    metadata: { payment_id: p.paymentId, booking_id: p.bookingId ?? "" },
    line_items: { 0: { quantity: 1, price_data: { currency: p.currency, unit_amount: p.amountCents, product_data: { name: p.description } } } },
    payment_intent_data: { metadata: { payment_id: p.paymentId } },
    expires_at: Math.floor((p.nowMs + 30 * 60_000) / 1000),
  }, `checkout_${p.paymentId}`);
  if (!s.id || !s.url) throw new HttpError(502, "payment_provider_error", "The payment provider returned an incomplete answer.");
  return { id: s.id, url: s.url, mode: m.mode, livemode: s.livemode === true };
}

export async function retrieveSession(env, fetchImpl, id) {
  const m = stripeMode(env);
  if (!m.ok) throw new HttpError(503, m.reason, m.message);
  return stripe(env, fetchImpl, "GET", `/checkout/sessions/${encodeURIComponent(id)}`);
}

/**
 * Verify a Stripe-Signature header (t=…, v1=…): HMAC-SHA256 of "t.payload" with the endpoint secret, any v1 may
 * match, timestamp within the tolerance. Returns the parsed event or throws 400.
 */
export async function verifyWebhook(env, payload, header, nowMs, toleranceSeconds = 300) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, "webhooks_not_configured", "Webhook secret is not configured.");
  const parts = String(header ?? "").split(",").map((x) => x.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length) throw new HttpError(400, "invalid_signature", "Missing or malformed Stripe-Signature.");
  if (Math.abs(nowMs / 1000 - t) > toleranceSeconds) throw new HttpError(400, "invalid_signature", "Signature timestamp outside the tolerance.");
  const expected = await hmacSha256Hex(env.STRIPE_WEBHOOK_SECRET, `${t}.${payload}`);
  if (!sigs.some((s) => safeEqual(s, expected))) throw new HttpError(400, "invalid_signature", "Signature does not match.");
  try { return JSON.parse(payload); } catch { throw new HttpError(400, "invalid_json", "Payload is not JSON."); }
}
