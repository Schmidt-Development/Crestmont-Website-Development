// Customer accounts (feature customer_accounts): sign-up, sign-in, own bookings and payments only.
import { CONFIG, enabled } from "../lib/config.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { Validator } from "../lib/validate.js";
import { all, nowIso, one, run } from "../lib/db.js";
import { clearSessionCookie, createSession, endSession, rateLimit, requireSameOrigin, requireSession } from "../lib/guards.js";
import { hashPassword, newId, verifyPassword } from "../lib/crypto.js";
import { bookingByToken } from "./public.js";

const need = () => { if (!enabled(CONFIG, "customer_accounts")) throw new HttpError(404, "not_found", "Not found."); };

export async function register(env, request) {
  need(); requireSameOrigin(request);
  await rateLimit(env, request, "customer-register", 5, 3600);
  const d = new Validator(await readJson(request)).str("name", { required: true, min: 2, max: 120, label: "Name" }).email("email", { required: true }).phone("phone").str("password", { required: true, min: 10, max: 200, label: "Password" }).done();
  const id = newId("cus");
  const hash = await hashPassword(d.password);
  // An existing account is never changed from here (no takeover); the response is identical either way, so it does
  // not reveal whether the email exists. Signing up proves nothing about the email address, so an account sees only
  // bookings made while signed in, or linked with the booking's own manage link (sent to that booking's email).
  const existing = await one(env.DB, `SELECT id FROM customers WHERE email = ?`, d.email);
  if (!existing) await run(env.DB, `INSERT INTO customers (id, email, name, phone, password_hash, created_at) VALUES (?,?,?,?,?,?)`, id, d.email, d.name, d.phone, hash, nowIso(env));
  return json({ ok: true, message: "If this email can be registered, you can now sign in." }, 201);
}

export async function customerLogin(env, request) {
  need(); requireSameOrigin(request);
  await rateLimit(env, request, "customer-login", 5, 900);
  const d = new Validator(await readJson(request)).email("email", { required: true }).str("password", { required: true, max: 200, label: "Password" }).done();
  const c = await one(env.DB, `SELECT * FROM customers WHERE email = ?`, d.email);
  const ok = await verifyPassword(d.password, c?.password_hash ?? "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  if (!c || !ok) throw new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
  return json({ customer: { name: c.name, email: c.email } }, 200, { "set-cookie": await createSession(env, "customer", c.id) });
}

export async function customerLogout(env, request) {
  need(); requireSameOrigin(request);
  await endSession(env, request);
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie });
}

export async function customerSession(env, request) {
  need();
  const s = await requireSession(env, request, "customer");
  return one(env.DB, `SELECT id, name, email FROM customers WHERE id = ?`, s.subject_id);
}

export async function myAccount(env, request) {
  const c = await customerSession(env, request);
  // Only this customer's own records (linked by id; never matched by an unverified email address).
  const bookings = await all(env.DB, `SELECT b.reference, b.status, b.start_at, s.name AS service FROM bookings b JOIN services s ON s.id = b.service_id WHERE b.customer_id = ? ORDER BY b.start_at DESC LIMIT 100`, c.id);
  const payments = await all(env.DB, `SELECT p.status, p.amount_cents, p.currency, p.created_at, b.reference FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.customer_id = ? ORDER BY p.created_at DESC LIMIT 100`, c.id);
  return json({ customer: { name: c.name, email: c.email }, bookings, payments });
}

/** Link a guest booking to the signed-in account: proof is the booking's manage link (reference + token). */
export async function linkBooking(env, request) {
  need();
  const s = await requireSession(env, request, "customer");
  await rateLimit(env, request, "customer-link", 10, 3600);
  const d = new Validator(await readJson(request)).str("reference", { required: true, max: 20, label: "Reference" }).str("token", { required: true, max: 64, label: "Token" }).done();
  const b = await bookingByToken(env, d.reference, d.token);
  const r = await run(env.DB, `UPDATE bookings SET customer_id = ?, updated_at = ? WHERE id = ? AND (customer_id IS NULL OR customer_id = ?)`, s.subject_id, nowIso(env), b.id, s.subject_id);
  if (!r.meta?.changes) throw new HttpError(409, "already_linked", "This booking belongs to another account.");
  return json({ ok: true, reference: b.reference });
}
