// Customer accounts (feature customer_accounts): sign-up, sign-in, own bookings and payments only.
import { CONFIG, enabled } from "../lib/config.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { Validator } from "../lib/validate.js";
import { all, nowIso, one, run } from "../lib/db.js";
import { clearSessionCookie, createSession, endSession, rateLimit, requireSameOrigin, requireSession } from "../lib/guards.js";
import { hashPassword, newId, verifyPassword } from "../lib/crypto.js";

const need = () => { if (!enabled(CONFIG, "customer_accounts")) throw new HttpError(404, "not_found", "Not found."); };

export async function register(env, request) {
  need(); requireSameOrigin(request);
  await rateLimit(env, request, "customer-register", 5, 3600);
  const d = new Validator(await readJson(request)).str("name", { required: true, min: 2, max: 120, label: "Name" }).email("email", { required: true }).phone("phone").str("password", { required: true, min: 10, max: 200, label: "Password" }).done();
  const id = newId("cus");
  const hash = await hashPassword(d.password);
  // An existing guest record (from an earlier booking) gets a password only through a fresh sign-up path that does not
  // reveal whether the email exists: the response is identical either way.
  const existing = await one(env.DB, `SELECT id, password_hash FROM customers WHERE email = ?`, d.email);
  if (!existing) await run(env.DB, `INSERT INTO customers (id, email, name, phone, password_hash, created_at) VALUES (?,?,?,?,?,?)`, id, d.email, d.name, d.phone, hash, nowIso(env));
  else if (!existing.password_hash) await run(env.DB, `UPDATE customers SET password_hash = ?, name = ? WHERE id = ?`, hash, d.name, existing.id);
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
  // Only this customer's own records: by customer id, or by the email they signed up with for earlier guest bookings.
  const bookings = await all(env.DB, `SELECT b.reference, b.status, b.start_at, s.name AS service FROM bookings b JOIN services s ON s.id = b.service_id WHERE b.customer_id = ? OR (b.customer_id IS NULL AND b.customer_email = ?) ORDER BY b.start_at DESC LIMIT 100`, c.id, c.email);
  const payments = await all(env.DB, `SELECT p.status, p.amount_cents, p.currency, p.created_at, b.reference FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.customer_id = ? OR (b.customer_id IS NULL AND b.customer_email = ?) ORDER BY p.created_at DESC LIMIT 100`, c.id, c.email);
  return json({ customer: { name: c.name, email: c.email }, bookings, payments });
}
