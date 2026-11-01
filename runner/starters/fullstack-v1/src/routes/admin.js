// Administration API (session cookie + same-origin writes). Roles: owner (everything) and staff (operations only).
// First owner: POST /api/admin/setup with the one-time ADMIN_SETUP_TOKEN secret (no default passwords exist).
import { CONFIG } from "../lib/config.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { Validator } from "../lib/validate.js";
import { all, audit, nowIso, nowMs, one, run, settings } from "../lib/db.js";
import { clearSessionCookie, createSession, endSession, rateLimit, requireSameOrigin, requireSession } from "../lib/guards.js";
import { hashPassword, newId, safeEqual, sha256Hex, verifyPassword } from "../lib/crypto.js";
import { cancellable, formatWhen, moveBooking } from "../lib/booking.js";
import { queueStmt, mailConfigured } from "../lib/notify.js";
import { retrieveSession, stripeMode } from "../lib/stripe.js";
import { markPaid } from "./webhooks.js";
import { isDate, isTime, WEEKDAYS } from "../lib/time.js";

async function admin(env, request, role = "staff") {
  const s = await requireSession(env, request, "admin");
  const u = await one(env.DB, `SELECT id, email, name, role, active FROM admin_users WHERE id = ?`, s.subject_id);
  if (!u || !u.active) throw new HttpError(401, "unauthenticated", "Please sign in.");
  if (role === "owner" && u.role !== "owner") throw new HttpError(403, "forbidden", "Only the owner can do this.");
  return u;
}

export async function setup(env, request) {
  requireSameOrigin(request);
  await rateLimit(env, request, "admin-setup", 5, 3600);
  const d = new Validator(await readJson(request)).str("token", { required: true, max: 200 }).str("name", { required: true, min: 2, max: 120, label: "Name" }).email("email", { required: true }).str("password", { required: true, min: 12, max: 200, label: "Password" }).done();
  if (!env.ADMIN_SETUP_TOKEN || env.ADMIN_SETUP_TOKEN.length < 24 || !safeEqual(await sha256Hex(d.token), await sha256Hex(env.ADMIN_SETUP_TOKEN))) throw new HttpError(403, "forbidden", "Setup is not available.");
  const existing = await one(env.DB, `SELECT COUNT(*) AS n FROM admin_users`);
  if (existing.n > 0) throw new HttpError(409, "already_set_up", "An owner account already exists.");
  const id = newId("adm");
  await run(env.DB, `INSERT INTO admin_users (id, email, name, role, password_hash, active, created_at) VALUES (?,?,?, 'owner', ?, 1, ?)`, id, d.email, d.name, await hashPassword(d.password), nowIso(env));
  await audit(env, `admin:${id}`, "admin.setup", "admin_user", id);
  return json({ ok: true }, 201);
}

export async function login(env, request) {
  requireSameOrigin(request);
  await rateLimit(env, request, "admin-login", 5, 900);
  const d = new Validator(await readJson(request)).email("email", { required: true }).str("password", { required: true, max: 200, label: "Password" }).done();
  const u = await one(env.DB, `SELECT * FROM admin_users WHERE email = ? AND active = 1`, d.email);
  // Same work whether or not the account exists (no account enumeration by timing).
  const ok = await verifyPassword(d.password, u?.password_hash ?? "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  if (!u || !ok) { await audit(env, "anonymous", "admin.login_failed", "admin_user", null, { email: d.email }); throw new HttpError(401, "invalid_credentials", "Email or password is incorrect."); }
  const cookieHeader = await createSession(env, "admin", u.id);
  await audit(env, `admin:${u.id}`, "admin.login", "admin_user", u.id);
  return json({ user: { name: u.name, email: u.email, role: u.role } }, 200, { "set-cookie": cookieHeader });
}

export async function logout(env, request) {
  requireSameOrigin(request);
  await endSession(env, request);
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie });
}

export async function me(env, request) {
  const u = await admin(env, request);
  return json({ user: { name: u.name, email: u.email, role: u.role }, mail: { configured: mailConfigured(env) }, payments: CONFIG.features?.payments ? stripeMode(env) : null });
}

export async function dashboard(env, request) {
  await admin(env, request);
  const today = new Date(nowMs(env)).toISOString();
  const [upcoming, quotes, messages, queued, failed, paid] = await Promise.all([
    one(env.DB, `SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed' AND start_at >= ?`, today),
    one(env.DB, `SELECT COUNT(*) AS n FROM quotes WHERE status = 'new'`),
    one(env.DB, `SELECT COUNT(*) AS n FROM contact_messages WHERE status = 'new'`),
    one(env.DB, `SELECT COUNT(*) AS n FROM notifications WHERE status = 'queued'`),
    one(env.DB, `SELECT COUNT(*) AS n FROM notifications WHERE status = 'failed'`),
    one(env.DB, `SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS cents FROM payments WHERE status IN ('paid', 'partially_refunded')`),
  ]);
  return json({ upcomingBookings: upcoming.n, newQuotes: quotes.n, newMessages: messages.n, emailsQueued: queued.n, emailsFailed: failed.n, paidCents: paid.cents, mailConfigured: mailConfigured(env) });
}

const LIST = { bookings: `SELECT b.id, b.reference, b.status, b.start_at, b.end_at, b.customer_name, b.customer_email, b.customer_phone, b.postal_code, b.resource_id, s.name AS service FROM bookings b JOIN services s ON s.id = b.service_id`,
  quotes: `SELECT id, reference, status, name, email, phone, postal_code, city, details, preferred_date, created_at FROM quotes`,
  messages: `SELECT id, status, name, email, phone, message, created_at FROM contact_messages`,
  payments: `SELECT p.id, p.status, p.mode, p.amount_cents, p.refunded_cents, p.currency, p.created_at, b.reference FROM payments p LEFT JOIN bookings b ON b.id = p.booking_id`,
  notifications: `SELECT id, status, template, to_address, attempts, last_error, created_at, sent_at FROM notifications`,
  audit: `SELECT id, actor, action, subject_type, subject_id, at FROM audit_log` };
const ORDER = { bookings: "b.start_at DESC", quotes: "created_at DESC", messages: "created_at DESC", payments: "p.created_at DESC", notifications: "created_at DESC", audit: "id DESC" };

export async function list(env, request, kind, url) {
  await admin(env, request, kind === "audit" ? "owner" : "staff");
  const status = url.searchParams.get("status");
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const where = status && /^[a-z_]{2,30}$/.test(status) && kind !== "audit" ? ` WHERE ${kind === "bookings" ? "b." : kind === "payments" ? "p." : ""}status = ?` : "";
  const rows = await all(env.DB, `${LIST[kind]}${where} ORDER BY ${ORDER[kind]} LIMIT ?`, ...(where ? [status, limit] : [limit]));
  return json({ items: rows });
}

const STATUS = { quotes: ["new", "contacted", "quoted", "won", "lost"], messages: ["new", "answered", "archived"] };
export async function setStatus(env, request, kind, id) {
  const u = await admin(env, request);
  const d = new Validator(await readJson(request)).oneOf("status", STATUS[kind], { required: true, label: "Status" }).done();
  const table = kind === "quotes" ? "quotes" : "contact_messages";
  const res = await run(env.DB, `UPDATE ${table} SET status = ?${kind === "quotes" ? ", updated_at = ?" : ""} WHERE id = ?`, ...(kind === "quotes" ? [d.status, nowIso(env), id] : [d.status, id]));
  if (res.meta.changes !== 1) throw new HttpError(404, "not_found", "Not found.");
  await audit(env, `admin:${u.id}`, `${kind}.status`, kind, id, { status: d.status });
  return json({ ok: true });
}

export async function bookingAction(env, request, id, action) {
  const u = await admin(env, request);
  const b = await one(env.DB, `SELECT * FROM bookings WHERE id = ?`, id);
  if (!b) throw new HttpError(404, "not_found", "Booking not found.");
  const body = await readJson(request);
  if (action === "cancel") {
    const c = cancellable(b, nowMs(env), true);
    if (!c.ok) throw new HttpError(409, "not_cancellable", c.reason);
    await env.DB.batch([
      env.DB.prepare(`UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(nowIso(env), id),
      env.DB.prepare(`INSERT INTO booking_history (booking_id, from_status, to_status, actor, note, at) VALUES (?,?, 'cancelled', ?, ?, ?)`).bind(id, b.status, `admin:${u.id}`, String(body.note ?? "").slice(0, 300) || null, nowIso(env)),
      queueStmt(env, `booking:${id}:cancelled`, b.customer_email, "booking_cancelled", { name: b.customer_name, reference: b.reference, when: formatWhen(b.start_at) }),
    ]);
  } else if (action === "complete" || action === "no_show") {
    if (b.status !== "confirmed") throw new HttpError(409, "invalid_transition", `A ${b.status} booking cannot be marked ${action}.`);
    const to = action === "complete" ? "completed" : "no_show";
    await env.DB.batch([
      env.DB.prepare(`UPDATE bookings SET status = ?, updated_at = ? WHERE id = ? AND status = 'confirmed'`).bind(to, nowIso(env), id),
      env.DB.prepare(`INSERT INTO booking_history (booking_id, from_status, to_status, actor, note, at) VALUES (?, 'confirmed', ?, ?, NULL, ?)`).bind(id, to, `admin:${u.id}`, nowIso(env)),
    ]);
  } else if (action === "reschedule") {
    const d = new Validator(body).str("start", { required: true, max: 40, label: "Time" }).done();
    await moveBooking(env, b, d.start, [env.DB.prepare(`INSERT INTO booking_history (booking_id, from_status, to_status, actor, note, at) VALUES (?, 'confirmed', 'confirmed', ?, ?, ?)`).bind(id, `admin:${u.id}`, `rescheduled from ${b.start_at}`, nowIso(env))]);
  } else throw new HttpError(404, "not_found", "Unknown action.");
  await audit(env, `admin:${u.id}`, `booking.${action}`, "booking", id);
  return json({ ok: true });
}

export async function bookingHistory(env, request, id) {
  await admin(env, request);
  return json({ items: await all(env.DB, `SELECT from_status, to_status, actor, note, at FROM booking_history WHERE booking_id = ? ORDER BY id`, id) });
}

/** Business hours, blackout dates and the staff notification address (owner only). */
export async function updateSettings(env, request) {
  const u = await admin(env, request, "owner");
  const body = await readJson(request);
  const out = {};
  if (body.hours !== undefined) {
    const h = body.hours;
    if (!h || typeof h !== "object" || Object.keys(h).some((k) => !WEEKDAYS.includes(k)) || Object.values(h).some((rs) => !Array.isArray(rs) || rs.some((r) => !isTime(r?.open) || !isTime(r?.close) || r.open >= r.close))) {
      throw new HttpError(422, "validation_failed", "Hours must be { mon: [{ open: \"08:00\", close: \"17:00\" }], … }.");
    }
    out.hours = h;
  }
  if (body.blackoutDates !== undefined) {
    if (!Array.isArray(body.blackoutDates) || body.blackoutDates.length > 366 || body.blackoutDates.some((d) => !isDate(d))) throw new HttpError(422, "validation_failed", "Blackout dates must be a list of YYYY-MM-DD dates.");
    out.blackoutDates = [...new Set(body.blackoutDates)].sort();
  }
  if (body.notifyEmail !== undefined) out.notifyEmail = new Validator(body).email("notifyEmail", { required: true }).done().notifyEmail;
  for (const [k, v] of Object.entries(out)) await run(env.DB, `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, k, JSON.stringify(v), nowIso(env), u.id);
  await audit(env, `admin:${u.id}`, "settings.updated", "settings", null, { keys: Object.keys(out) });
  return json({ settings: await settings(env) });
}

export async function updateService(env, request, id) {
  const u = await admin(env, request, "owner");
  const body = await readJson(request);
  const s = await one(env.DB, `SELECT * FROM services WHERE id = ?`, id);
  if (!s) throw new HttpError(404, "not_found", "Service not found.");
  const price = body.priceCents === undefined ? s.price_cents : body.priceCents;
  if (price !== null && !(Number.isInteger(price) && price >= 0 && price <= 10_000_000)) throw new HttpError(422, "validation_failed", "Price must be a whole number of cents.");
  if (s.payable && !(price > 0)) throw new HttpError(422, "validation_failed", "A service paid online needs a price.");
  const active = body.active === undefined ? s.active : body.active ? 1 : 0;
  await run(env.DB, `UPDATE services SET price_cents = ?, active = ?, updated_at = ? WHERE id = ?`, price, active, nowIso(env), id);
  await audit(env, `admin:${u.id}`, "service.updated", "service", id, { priceCents: price, active: !!active });
  return json({ ok: true });
}

/** Read the payment's Checkout Session from Stripe and apply it (recovers a missed webhook). */
export async function reconcilePayment(env, request, id, fetchImpl = fetch) {
  const u = await admin(env, request);
  const p = await one(env.DB, `SELECT * FROM payments WHERE id = ?`, id);
  if (!p?.checkout_session_id) throw new HttpError(404, "not_found", "Payment not found.");
  const s = await retrieveSession(env, fetchImpl, p.checkout_session_id);
  let outcome = "unchanged";
  if (s.payment_status === "paid") outcome = await markPaid(env, s, `admin:${u.id}`);
  else if (s.status === "expired") { await run(env.DB, `UPDATE payments SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'`, nowIso(env), id); outcome = "expired"; }
  await audit(env, `admin:${u.id}`, "payment.reconciled", "payment", id, { outcome });
  return json({ outcome });
}

export async function addStaff(env, request) {
  const u = await admin(env, request, "owner");
  const d = new Validator(await readJson(request)).str("name", { required: true, min: 2, max: 120, label: "Name" }).email("email", { required: true }).str("password", { required: true, min: 12, max: 200, label: "Password" }).oneOf("role", ["owner", "staff"], { required: true, label: "Role" }).done();
  const id = newId("adm");
  try { await run(env.DB, `INSERT INTO admin_users (id, email, name, role, password_hash, active, created_at) VALUES (?,?,?,?,?,1,?)`, id, d.email, d.name, d.role, await hashPassword(d.password), nowIso(env)); }
  catch (e) { if (/UNIQUE/.test(String(e?.message))) throw new HttpError(409, "exists", "A user with that email already exists."); throw e; }
  await audit(env, `admin:${u.id}`, "admin.user_added", "admin_user", id, { role: d.role });
  return json({ id }, 201);
}
