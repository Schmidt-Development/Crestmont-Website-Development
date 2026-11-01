import { test } from "node:test";
import assert from "node:assert/strict";
import { app, book, bookable, CONFIG, off, openDate, person } from "./helpers.mjs";
import { processOutbox } from "../../src/lib/notify.js";

const skip = off("admin");

test("[auth] [admin] no default account: setup needs the one-time secret and works once; passwords are hashed", { skip }, async () => {
  const t = await app();
  assert.equal((await t.adminPost("/api/admin/setup", { token: "wrong-token-wrong-token-1234", name: "Eve Evil", email: "eve@example.test", password: "a-long-password-123" })).status, 403);
  const ok = await t.adminPost("/api/admin/setup", { token: t.env.ADMIN_SETUP_TOKEN, name: "Owner Test", email: "owner@site.example", password: "correct horse battery staple" });
  assert.equal(ok.status, 201);
  assert.equal((await t.adminPost("/api/admin/setup", { token: t.env.ADMIN_SETUP_TOKEN, name: "Second Owner", email: "two@site.example", password: "another long password" })).status, 409);
  const u = await t.db.prepare(`SELECT password_hash FROM admin_users`).first();
  assert.match(u.password_hash, /^pbkdf2\$100000\$/);
  assert.doesNotMatch(u.password_hash, /correct horse/);
});

test("[auth] [security] admin endpoints need a session; sign-in is rate limited; wrong passwords reveal nothing; sign-out ends the session", { skip }, async () => {
  const t = await app();
  assert.equal((await t.get("/api/admin/dashboard")).status, 401);
  await t.adminPost("/api/admin/setup", { token: t.env.ADMIN_SETUP_TOKEN, name: "Owner Test", email: "owner@site.example", password: "correct horse battery staple" });
  const wrong = await t.adminPost("/api/admin/login", { email: "owner@site.example", password: "nope-nope-nope" });
  const unknown = await t.adminPost("/api/admin/login", { email: "nobody@site.example", password: "nope-nope-nope" });
  assert.deepEqual([wrong.status, wrong.json.error.message], [unknown.status, unknown.json.error.message]);
  const login = await t.adminPost("/api/admin/login", { email: "owner@site.example", password: "correct horse battery staple" });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /^__Host-sid=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await t.get("/api/admin/dashboard")).status, 200);
  await t.adminPost("/api/admin/logout", {});
  assert.equal((await t.get("/api/admin/dashboard")).status, 401);
  for (let i = 0; i < 5; i++) await t.adminPost("/api/admin/login", { email: "owner@site.example", password: "nope-nope-nope" }, { "cf-connecting-ip": "192.0.2.50" });
  assert.equal((await t.adminPost("/api/admin/login", { email: "owner@site.example", password: "correct horse battery staple" }, { "cf-connecting-ip": "192.0.2.50" })).status, 429);
});

test("[security] [csrf] cookie-authenticated writes from another origin, or without the fetch marker, are refused", { skip }, async () => {
  const t = await app();
  await t.signInOwner();
  assert.equal((await t.post("/api/admin/settings", { notifyEmail: "x@example.test" }, { origin: "https://evil.example", "x-requested-with": "fetch" })).status, 403);
  assert.equal((await t.post("/api/admin/settings", { notifyEmail: "x@example.test" }, { origin: "https://site.example" })).status, 403);
  assert.equal((await t.adminPost("/api/admin/settings", { notifyEmail: "x@example.test" })).status, 200);
});

test("[admin] [authorization] staff run operations but cannot change settings, prices or users; the audit log is owner-only", { skip }, async () => {
  const t = await app();
  await t.signInOwner();
  assert.equal((await t.adminPost("/api/admin/users", { name: "Sam Staff", email: "staff@site.example", password: "staff-password-123", role: "staff" })).status, 201);
  await t.adminPost("/api/admin/logout", {});
  await t.adminPost("/api/admin/login", { email: "staff@site.example", password: "staff-password-123" });
  assert.equal((await t.get("/api/admin/dashboard")).status, 200);
  assert.equal((await t.adminPost("/api/admin/settings", { notifyEmail: "x@example.test" })).status, 403);
  assert.equal((await t.get("/api/admin/audit")).status, 403);
  if (CONFIG.services?.length) assert.equal((await t.adminPost(`/api/admin/services/${CONFIG.services[0].id}`, { priceCents: 1 })).status, 403);
});

test("[admin] [booking] the administrator sees bookings, reschedules, completes and cancels them; every change is in the history and audit log", { skip: skip || off("booking") }, async () => {
  const t = await app();
  const svc = bookable();
  const slots = (await t.get(`/api/availability?service=${svc.id}&date=${openDate(t.now())}`)).json.slots;
  await book(t, svc.id, slots[0].start, 1);
  await t.signInOwner();
  const list = await t.get("/api/admin/bookings");
  assert.equal(list.json.items.length, 1);
  const id = list.json.items[0].id;
  assert.equal((await t.adminPost(`/api/admin/bookings/${id}/reschedule`, { start: slots.at(-1).start })).status, 200);
  assert.equal((await t.adminPost(`/api/admin/bookings/${id}/complete`, {})).status, 200);
  assert.equal((await t.adminPost(`/api/admin/bookings/${id}/complete`, {})).status, 409);
  const hist = await t.get(`/api/admin/bookings/${id}/history`);
  assert.deepEqual(hist.json.items.map((h) => h.to_status).slice(-2), ["confirmed", "completed"], "rescheduled (still confirmed), then completed");
  assert.ok(hist.json.items.some((h) => /^rescheduled from /.test(h.note ?? "")));
  const audit = await t.get("/api/admin/audit");
  assert.ok(audit.json.items.some((a) => a.action === "booking.reschedule") && audit.json.items.some((a) => a.action === "booking.complete"));
});

test("[admin] [booking] settings: hours and the staff address are validated and take effect at once", { skip: skip || off("booking") }, async () => {
  const t = await app();
  await t.signInOwner();
  assert.equal((await t.adminPost("/api/admin/settings", { hours: { mon: [{ open: "17:00", close: "09:00" }] } })).status, 422);
  assert.equal((await t.adminPost("/api/admin/settings", { hours: {} })).status, 200);
  assert.deepEqual((await t.get(`/api/availability?service=${bookable().id}&date=${openDate(t.now())}`)).json.slots, [], "no hours, no slots");
});

test("[quotes] [database] quote requests are validated, limited to the service area, stored and visible to staff with a status workflow", { skip: off("quotes") }, async () => {
  const t = await app();
  const base = { name: "Pat Quote", email: "pat@example.test", phone: "555-0101", details: "Please quote for clearing a two-car garage.", postalCode: CONFIG.serviceArea?.postalCodes?.[0], city: CONFIG.serviceArea?.cities?.[0] };
  assert.equal((await t.post("/api/quotes", { ...base, details: "short" })).status, 422);
  if (CONFIG.serviceArea?.postalCodes?.length) assert.equal((await t.post("/api/quotes", { ...base, postalCode: "99999", city: "Nowhere" })).json.error.code, "outside_service_area");
  const ok = await t.post("/api/quotes", base);
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.match(ok.json.quote.reference, /^QT-/);
  await t.signInOwner();
  const q = (await t.get("/api/admin/quotes")).json.items[0];
  assert.equal(q.email, "pat@example.test");
  assert.equal((await t.adminPost(`/api/admin/quotes/${q.id}/status`, { status: "won" })).status, 200);
  assert.equal((await t.adminPost(`/api/admin/quotes/${q.id}/status`, { status: "deleted" })).status, 422);
});

test("[notifications] the outbox is never reported as sent without the customer's mail provider; with it, each message is sent once", { skip: off("notifications") }, async () => {
  const t = await app();
  await t.post("/api/contact", { name: "Jane Doe", email: "jane@example.test", message: "A message that needs an answer." });
  await t.post("/api/quotes", { name: "Pat Quote", email: "pat@example.test", details: "Please quote for clearing a garage.", postalCode: CONFIG.serviceArea?.postalCodes?.[0], city: CONFIG.serviceArea?.cities?.[0] }).catch(() => {});
  const r1 = await processOutbox(t.env);
  assert.match(r1.skipped, /not configured/);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE status = 'sent'`).first()).n, 0);
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body), key: init.headers["idempotency-key"] }); return Response.json({ id: `re_msg_${sent.length}` }); };
  const env = { ...t.env, RESEND_API_KEY: "re_test_key_for_tests", MAIL_FROM: "Site <hello@site.example>" };
  const queued = (await t.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE status = 'queued'`).first()).n;
  const r2 = await processOutbox(env, fetchImpl);
  assert.equal(r2.sent, queued);
  assert.ok(sent.every((s) => s.url === "https://api.resend.com/emails" && s.key));
  const r3 = await processOutbox(env, fetchImpl);
  assert.equal(r3.sent, 0, "nothing is sent twice");
});

test("[customer-accounts] [security] customers register and sign in, and see only bookings they made signed in or proved with the booking's manage link", { skip: off("customer_accounts") }, async () => {
  const t = await app();
  const svc = bookable();
  const reg = await t.adminPost("/api/account/register", { name: "Customer One", email: "customer1@example.test", password: "customer-password-1" });
  assert.equal(reg.status, 201);
  // Registering an email that already has an account changes nothing and reveals nothing.
  const again = await t.adminPost("/api/account/register", { name: "Attacker", email: "customer1@example.test", password: "attacker-password-9" });
  assert.deepEqual([again.status, again.json], [reg.status, reg.json]);
  assert.equal((await t.get("/api/account")).status, 401);
  assert.equal((await t.adminPost("/api/account/login", { email: "customer1@example.test", password: "attacker-password-9" })).status, 401, "no takeover of an existing account");
  let guest = null;
  if (svc) {
    const slots = (await t.get(`/api/availability?service=${svc.id}&date=${openDate(t.now())}`)).json.slots;
    guest = await book(t, svc.id, slots.at(-1).start, 1); // a guest booking under the SAME email as the account
  }
  assert.equal((await t.adminPost("/api/account/login", { email: "customer1@example.test", password: "customer-password-1" })).status, 200);
  const me = await t.get("/api/account");
  assert.equal(me.json.customer.email, "customer1@example.test");
  if (svc) {
    assert.equal(me.json.bookings.length, 0, "an unverified email address never exposes a guest's bookings");
    assert.equal((await t.adminPost("/api/account/link-booking", { reference: guest.booking.reference, token: "0".repeat(48) })).status, 404, "a wrong manage token links nothing");
    assert.equal((await t.adminPost("/api/account/link-booking", { reference: guest.booking.reference, token: guest.manageToken })).status, 200);
    assert.equal((await t.get("/api/account")).json.bookings.length, 1, "linked with the booking's own manage link");
  }
  assert.equal((await t.get("/api/admin/dashboard")).status, 401, "a customer session is not an admin session");
});
