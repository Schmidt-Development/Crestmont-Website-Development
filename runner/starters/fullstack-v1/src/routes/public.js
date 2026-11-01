// Public API: business configuration, services, availability, bookings (create / view / cancel / reschedule with
// the private manage link), quote requests, contact messages, checkout for payable bookings.
import { CONFIG, enabled, inServiceArea } from "../lib/config.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { Validator, POSTAL_US } from "../lib/validate.js";
import { all, audit, nowIso, nowMs, one, run, settings } from "../lib/db.js";
import { idempotent, rateLimit, requireSession } from "../lib/guards.js";
import { newId, newReference, randomToken, sha256Hex } from "../lib/crypto.js";
import { availability, cancellable, formatWhen, insertBooking, moveBooking } from "../lib/booking.js";
import { queueStmt } from "../lib/notify.js";
import { createCheckoutSession, stripeMode } from "../lib/stripe.js";

const need = (f) => { if (!enabled(CONFIG, f)) throw new HttpError(404, "not_found", "Not found."); };

export async function publicConfig(env) {
  const st = await settings(env);
  const b = CONFIG.business ?? {};
  return json({
    business: { name: b.name, description: b.description, industry: b.industry, email: b.email, phone: b.phone, address: b.address ?? null, timeZone: b.timeZone },
    hours: st.hours, serviceArea: CONFIG.serviceArea ?? null, features: CONFIG.features ?? {},
    booking: enabled(CONFIG, "booking") ? { maxDaysAhead: CONFIG.booking.maxDaysAhead, cancellationNoticeHours: CONFIG.booking.cancellationNoticeHours } : null,
    payments: enabled(CONFIG, "payments") ? { available: stripeMode(env).ok, currency: CONFIG.payments.currency } : null,
  });
}

export async function listServices(env) {
  const rows = await all(env.DB, `SELECT id, name, description, price_cents, price_note, duration_minutes, bookable, payable FROM services WHERE active = 1 ORDER BY position, name`);
  return json({ services: rows.map((s) => ({ id: s.id, name: s.name, description: s.description, priceCents: s.price_cents, priceNote: s.price_note, durationMinutes: s.duration_minutes, bookable: !!s.bookable, payable: !!s.payable })) });
}

export async function getAvailability(env, url) {
  need("booking");
  const serviceId = url.searchParams.get("service") ?? "";
  const date = url.searchParams.get("date") ?? "";
  if (!/^[a-z0-9-]{2,41}$/.test(serviceId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(422, "validation_failed", "Choose a service and a date.");
  return json(await availability(env, serviceId, date));
}

const origin = (request) => new URL(request.url).origin;
const manageUrl = (request, ref, token) => `${origin(request)}/booking/manage.html?ref=${encodeURIComponent(ref)}#token=${token}`;

export async function createBooking(env, request) {
  need("booking");
  await rateLimit(env, request, "booking", 10, 600);
  const body = await readJson(request);
  const r = await idempotent(env, request, "booking", body, async () => {
    const v = new Validator(body).str("serviceId", { required: true, max: 41, label: "Service" }).str("start", { required: true, max: 40, label: "Time" })
      .str("name", { required: true, min: 2, max: 120, label: "Name" }).email("email", { required: true }).phone("phone", { required: CONFIG.booking?.requirePhone === true })
      .str("address", { required: CONFIG.booking?.requireAddress === true, max: 300, label: "Address" }).str("postalCode", { required: !!CONFIG.serviceArea?.postalCodes?.length, max: 10, label: "ZIP code" })
      .str("notes", { max: 2000, label: "Notes" });
    const d = v.done();
    if (d.postalCode && CONFIG.business?.address?.country !== "other" && !POSTAL_US.test(d.postalCode)) throw new HttpError(422, "validation_failed", "Please correct the highlighted fields.", { fields: { postalCode: "ZIP code is not valid." } });
    if (!inServiceArea(CONFIG, d.postalCode, null)) throw new HttpError(422, "outside_service_area", "Sorry, that address is outside our service area.", { fields: { postalCode: "Outside our service area." } });
    const svc = await one(env.DB, `SELECT * FROM services WHERE id = ? AND active = 1`, d.serviceId);
    const paymentRequired = !!(svc?.payable && enabled(CONFIG, "payments"));
    if (paymentRequired && !stripeMode(env).ok) throw new HttpError(503, "payments_unavailable", "Online payment is not available yet, so this service cannot be booked online. Please call us.");
    const id = newId("bkg"), reference = newReference("BK"), token = randomToken(24);
    const when = formatWhen(new Date(Date.parse(d.start)).toISOString());
    const payload = { name: d.name, email: d.email, reference, serviceName: svc?.name ?? d.serviceId, when, manageUrl: manageUrl(request, reference, token), paymentRequired };
    const staff = (await settings(env)).notifyEmail;
    const extra = [
      env.DB.prepare(`INSERT INTO booking_history (booking_id, from_status, to_status, actor, note, at) VALUES (?, NULL, ?, 'customer', 'created online', ?)`).bind(id, paymentRequired ? "pending_payment" : "confirmed", nowIso(env)),
      queueStmt(env, `booking:${id}:created`, d.email, paymentRequired ? "booking_received" : "booking_confirmed", payload),
      ...(staff ? [queueStmt(env, `booking:${id}:staff`, staff, "staff_new_booking", payload)] : []),
    ];
    // Signed-in customers (feature customer_accounts) own their new bookings; guests link one later with its manage link.
    let customerId = null;
    if (enabled(CONFIG, "customer_accounts") && /(?:^|;\s*)__Host-sid=/.test(request.headers.get("cookie") ?? "")) {
      try { customerId = (await requireSession(env, request, "customer")).subject_id; } catch { customerId = null; }
    }
    const made = await insertBooking(env, { customerId, id, reference, serviceId: d.serviceId, start: d.start, name: d.name, email: d.email, phone: d.phone, address: d.address, postalCode: d.postalCode, notes: d.notes, tokenHash: await sha256Hex(token), paymentRequired }, extra);
    return { status: 201, body: { booking: { id, reference, status: paymentRequired ? "pending_payment" : "confirmed", start: new Date(made.start).toISOString(), end: new Date(made.end).toISOString(), when, paymentRequired }, manageToken: token } };
  });
  return json(r.body, r.status);
}

/** A booking addressed by reference + manage token (the token is never stored in clear). */
export async function bookingByToken(env, ref, token) {
  if (!/^BK-[A-Z0-9]{8}$/.test(ref ?? "") || !/^[0-9a-f]{48}$/.test(token ?? "")) throw new HttpError(404, "not_found", "Booking not found.");
  const b = await one(env.DB, `SELECT b.*, s.name AS service_name FROM bookings b JOIN services s ON s.id = b.service_id WHERE b.reference = ? AND b.manage_token_hash = ?`, ref, await sha256Hex(token));
  if (!b) throw new HttpError(404, "not_found", "Booking not found.");
  return b;
}
const view = (b) => ({ reference: b.reference, service: b.service_name, status: b.status, start: b.start_at, end: b.end_at, when: formatWhen(b.start_at), paymentRequired: !!b.payment_required });

export async function getBooking(env, request, ref) {
  need("booking");
  await rateLimit(env, request, "booking-view", 60, 600);
  return json({ booking: view(await bookingByToken(env, ref, request.headers.get("x-manage-token"))) });
}

export async function cancelBooking(env, request, ref) {
  need("booking");
  await rateLimit(env, request, "booking-change", 10, 600);
  const b = await bookingByToken(env, ref, request.headers.get("x-manage-token"));
  const c = cancellable(b, nowMs(env));
  if (!c.ok) throw new HttpError(409, "not_cancellable", c.reason);
  const res = await env.DB.batch([
    env.DB.prepare(`UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('confirmed', 'pending_payment')`).bind(nowIso(env), b.id),
    env.DB.prepare(`INSERT INTO booking_history (booking_id, from_status, to_status, actor, note, at) VALUES (?,?, 'cancelled', 'customer', 'cancelled online', ?)`).bind(b.id, b.status, nowIso(env)),
    queueStmt(env, `booking:${b.id}:cancelled`, b.customer_email, "booking_cancelled", { name: b.customer_name, reference: b.reference, when: formatWhen(b.start_at) }),
  ]);
  if (res[0].meta.changes !== 1) throw new HttpError(409, "not_cancellable", "This booking was already changed.");
  return json({ booking: { ...view(b), status: "cancelled" } });
}

export async function rescheduleBooking(env, request, ref) {
  need("booking");
  await rateLimit(env, request, "booking-change", 10, 600);
  const b = await bookingByToken(env, ref, request.headers.get("x-manage-token"));
  const c = cancellable(b, nowMs(env));
  if (!c.ok) throw new HttpError(409, "not_reschedulable", c.reason);
  if (b.status !== "confirmed") throw new HttpError(409, "not_reschedulable", "Only confirmed bookings can be moved online.");
  const d = new Validator(await readJson(request)).str("start", { required: true, max: 40, label: "Time" }).done();
  const when = formatWhen(new Date(Date.parse(d.start) || 0).toISOString());
  const moved = await moveBooking(env, b, d.start, [
    env.DB.prepare(`INSERT INTO booking_history (booking_id, from_status, to_status, actor, note, at) VALUES (?, 'confirmed', 'confirmed', 'customer', ?, ?)`).bind(b.id, `rescheduled from ${b.start_at}`, nowIso(env)),
    queueStmt(env, `booking:${b.id}:moved:${d.start}`, b.customer_email, "booking_rescheduled", { name: b.customer_name, reference: b.reference, when, manageUrl: `${origin(request)}/booking/manage.html?ref=${encodeURIComponent(b.reference)}` }),
  ]);
  return json({ booking: { ...view(b), start: new Date(moved.start).toISOString(), end: new Date(moved.end).toISOString(), when } });
}

export async function createQuote(env, request) {
  need("quotes");
  await rateLimit(env, request, "quote", 10, 600);
  const body = await readJson(request);
  const r = await idempotent(env, request, "quote", body, async () => {
    const d = new Validator(body).str("name", { required: true, min: 2, max: 120, label: "Name" }).email("email", { required: true }).phone("phone", { required: CONFIG.quotes?.requirePhone === true })
      .str("serviceId", { max: 41, label: "Service" }).str("address", { max: 300, label: "Address" }).str("postalCode", { required: !!CONFIG.serviceArea?.postalCodes?.length, max: 10, label: "ZIP code" })
      .str("city", { max: 100, label: "City" }).str("details", { required: true, min: 10, max: 5000, label: "Details" }).str("preferredDate", { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/, label: "Preferred date" }).done();
    if (d.postalCode && !POSTAL_US.test(d.postalCode)) throw new HttpError(422, "validation_failed", "Please correct the highlighted fields.", { fields: { postalCode: "ZIP code is not valid." } });
    if (!inServiceArea(CONFIG, d.postalCode, d.city)) throw new HttpError(422, "outside_service_area", "Sorry, that address is outside our service area.", { fields: { postalCode: "Outside our service area." } });
    const svc = d.serviceId ? await one(env.DB, `SELECT id, name FROM services WHERE id = ? AND active = 1`, d.serviceId) : null;
    if (d.serviceId && !svc) throw new HttpError(422, "validation_failed", "Please correct the highlighted fields.", { fields: { serviceId: "Unknown service." } });
    const id = newId("qte"), reference = newReference("QT");
    const staff = (await settings(env)).notifyEmail;
    const payload = { name: d.name, email: d.email, phone: d.phone, reference, serviceName: svc?.name ?? null, details: d.details };
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO quotes (id, reference, service_id, name, email, phone, address, postal_code, city, details, preferred_date, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'new', ?, ?)`)
        .bind(id, reference, svc?.id ?? null, d.name, d.email, d.phone, d.address, d.postalCode, d.city, d.details, d.preferredDate, nowIso(env), nowIso(env)),
      queueStmt(env, `quote:${id}:customer`, d.email, "quote_received", payload),
      ...(staff ? [queueStmt(env, `quote:${id}:staff`, staff, "staff_new_quote", payload)] : []),
    ]);
    return { status: 201, body: { quote: { reference, status: "new" } } };
  });
  return json(r.body, r.status);
}

export async function createContact(env, request) {
  need("contact");
  await rateLimit(env, request, "contact", 5, 600);
  const d = new Validator(await readJson(request)).str("name", { required: true, min: 2, max: 120, label: "Name" }).email("email", { required: true }).phone("phone").str("message", { required: true, min: 10, max: 5000, label: "Message" })
    .str("website", { max: 200 }).done();
  if (d.website) return json({ ok: true }, 201); // honeypot: bots fill the hidden field; nothing is stored
  const id = newId("msg");
  const staff = (await settings(env)).notifyEmail;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO contact_messages (id, name, email, phone, message, status, created_at) VALUES (?,?,?,?,?, 'new', ?)`).bind(id, d.name, d.email, d.phone, d.message, nowIso(env)),
    ...(staff ? [queueStmt(env, `contact:${id}`, staff, "staff_new_contact", { name: d.name, email: d.email, message: d.message })] : []),
  ]);
  return json({ ok: true }, 201);
}

/** Checkout for a booking that requires payment: the amount is the SERVICE's server-side price, never the browser's. */
export async function checkout(env, request, ref, fetchImpl = fetch) {
  need("payments");
  await rateLimit(env, request, "checkout", 10, 600);
  const b = await bookingByToken(env, ref, request.headers.get("x-manage-token"));
  if (b.status !== "pending_payment") throw new HttpError(409, "nothing_to_pay", "This booking has nothing left to pay.");
  if (b.hold_expires_at && b.hold_expires_at <= nowIso(env)) throw new HttpError(409, "hold_expired", "The time held for payment has passed. Please book again.");
  const svc = await one(env.DB, `SELECT * FROM services WHERE id = ?`, b.service_id);
  if (!svc?.payable || !(svc.price_cents > 0)) throw new HttpError(409, "not_payable", "This service is not paid online.");
  // The seat stays reserved for the whole Checkout window: the hold is extended (while it is still valid) to just after
  // the session expires, so the slot cannot be sold twice while this customer is paying.
  const sessionExpiresMs = nowMs(env) + 31 * 60_000;
  const held = await env.DB.prepare(`UPDATE bookings SET hold_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'pending_payment' AND hold_expires_at > ?`)
    .bind(new Date(sessionExpiresMs + 2 * 60_000).toISOString(), nowIso(env), b.id, nowIso(env)).run();
  if (held.meta.changes !== 1) throw new HttpError(409, "hold_expired", "The time held for payment has passed. Please book again.");
  const existing = await one(env.DB, `SELECT * FROM payments WHERE booking_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, b.id);
  const paymentId = existing?.id ?? newId("pay");
  const mode = stripeMode(env);
  const session = await createCheckoutSession(env, fetchImpl, { paymentId, bookingId: b.id, reference: b.reference, email: b.customer_email, amountCents: svc.price_cents, currency: CONFIG.payments.currency, description: `${svc.name} (${b.reference})`, origin: origin(request), nowMs: nowMs(env), expiresAtMs: sessionExpiresMs });
  if (session.livemode !== (mode.mode === "live")) throw new HttpError(502, "payment_mode_mismatch", "The payment provider answered in an unexpected mode.");
  if (existing) await run(env.DB, `UPDATE payments SET checkout_session_id = ?, updated_at = ? WHERE id = ?`, session.id, nowIso(env), paymentId);
  else await run(env.DB, `INSERT INTO payments (id, booking_id, provider, mode, checkout_session_id, amount_cents, currency, status, created_at, updated_at) VALUES (?,?, 'stripe', ?,?,?,?, 'pending', ?, ?)`, paymentId, b.id, mode.mode, session.id, svc.price_cents, CONFIG.payments.currency, nowIso(env), nowIso(env));
  await audit(env, "customer", "payment.checkout_started", "booking", b.id, { paymentId, amountCents: svc.price_cents, mode: mode.mode });
  return json({ url: session.url });
}
