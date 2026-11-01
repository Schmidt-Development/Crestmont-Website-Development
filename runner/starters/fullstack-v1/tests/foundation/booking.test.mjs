import { test } from "node:test";
import assert from "node:assert/strict";
import { app, bookable, CONFIG, off, openDate, person } from "./helpers.mjs";
import { candidateSlots } from "../../src/lib/booking.js";
import { localDate, zonedParts, zonedToUtc } from "../../src/lib/time.js";

const skip = off("booking");

test("[booking] time zones: wall-clock times convert with the zone's offset on that date, across both DST changes", () => {
  // US 2030: DST starts Sun 10 Mar 02:00 (02:00–02:59 does not exist), ends Sun 3 Nov 02:00 (01:00–01:59 twice).
  assert.equal(new Date(zonedToUtc("2030-03-09", "09:00", "America/New_York")).toISOString(), "2030-03-09T14:00:00.000Z", "EST −5");
  assert.equal(new Date(zonedToUtc("2030-03-11", "09:00", "America/New_York")).toISOString(), "2030-03-11T13:00:00.000Z", "EDT −4");
  assert.equal(zonedToUtc("2030-03-10", "02:30", "America/New_York"), null, "spring-forward gap");
  assert.equal(new Date(zonedToUtc("2030-11-03", "01:30", "America/New_York")).toISOString(), "2030-11-03T05:30:00.000Z", "ambiguous hour: the earlier instant");
  assert.equal(new Date(zonedToUtc("2030-07-01", "09:00", "America/Phoenix")).toISOString(), "2030-07-01T16:00:00.000Z", "a zone without DST");
  const p = zonedParts(Date.parse("2030-03-10T07:30:00Z"), "America/New_York");
  assert.deepEqual([p.hour, p.minute], [3, 30]);
});

test("[booking] slots on a DST day keep their wall-clock times and skip the missing hour", () => {
  const hours = { sun: [{ open: "01:00", close: "05:00" }] };
  const now = Date.parse("2030-03-01T00:00:00Z");
  const saved = CONFIG.booking;
  CONFIG.booking = { ...(saved ?? {}), slotIntervalMinutes: 30, leadTimeMinutes: 0, maxDaysAhead: 60, bufferMinutes: 0 };
  const savedTz = CONFIG.business.timeZone; CONFIG.business.timeZone = "America/New_York";
  try {
    const s = candidateSlots(hours, [], "2030-03-10", 30, now).map((ms) => new Date(ms).toISOString());
    const local = s.map((iso) => { const q = zonedParts(Date.parse(iso), "America/New_York"); return `${q.hour}:${String(q.minute).padStart(2, "0")}`; });
    assert.ok(!local.some((x) => x.startsWith("2:")), "no slot in the non-existent hour");
    assert.ok(local.includes("1:30") && local.includes("3:00") && local.includes("4:30"));
    assert.equal(new Set(s).size, s.length, "no duplicate instants");
  } finally { CONFIG.booking = saved; CONFIG.business.timeZone = savedTz; }
});

test("[booking] availability honours business hours, lead time, blackout dates and the booking window", { skip }, async () => {
  const t = await app();
  const svc = bookable();
  const date = openDate(t.now());
  const r = await t.get(`/api/availability?service=${svc.id}&date=${date}`);
  assert.equal(r.status, 200);
  assert.ok(r.json.slots.length > 0, "an open day has slots");
  for (const s of r.json.slots) {
    assert.equal(localDate(Date.parse(s.start), CONFIG.business.timeZone), date);
    assert.equal(Date.parse(s.end) - Date.parse(s.start), svc.durationMinutes * 60_000);
    assert.ok(Date.parse(s.start) >= t.now() + CONFIG.booking.leadTimeMinutes * 60_000);
  }
  const past = localDate(t.now() - 864e5 * 2, CONFIG.business.timeZone);
  assert.deepEqual((await t.get(`/api/availability?service=${svc.id}&date=${past}`)).json.slots, []);
  const far = localDate(t.now() + 864e5 * (CONFIG.booking.maxDaysAhead + 2), CONFIG.business.timeZone);
  assert.deepEqual((await t.get(`/api/availability?service=${svc.id}&date=${far}`)).json.slots, []);
  await t.signInOwner();
  await t.adminPost("/api/admin/settings", { blackoutDates: [date] });
  assert.deepEqual((await t.get(`/api/availability?service=${svc.id}&date=${date}`)).json.slots, [], "blackout date closed by the administrator");
});

test("[booking] [database] a booking is validated, persisted with history and a manage link, and notifies customer and staff", { skip }, async () => {
  const t = await app();
  const svc = bookable();
  const slot = (await t.get(`/api/availability?service=${svc.id}&date=${openDate(t.now())}`)).json.slots[0];
  const bad = await t.post("/api/bookings", { serviceId: svc.id, start: slot.start, name: "", email: "x" });
  assert.equal(bad.status, 422);
  const r = await t.post("/api/bookings", { serviceId: svc.id, start: slot.start, ...person(1) });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.match(r.json.booking.reference, /^BK-[A-Z0-9]{8}$/);
  const row = await t.db.prepare(`SELECT * FROM bookings WHERE reference = ?`).bind(r.json.booking.reference).first();
  assert.equal(row.start_at, slot.start);
  assert.notEqual(row.manage_token_hash, r.json.manageToken, "the manage token is stored only as a hash");
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM booking_history WHERE booking_id = ?`).bind(row.id).first()).n, 1);
  const n = await t.db.prepare(`SELECT template, to_address FROM notifications ORDER BY created_at`).all();
  assert.ok(n.results.some((x) => x.to_address === "customer1@example.test"));
  const view = await t.get(`/api/bookings/${r.json.booking.reference}`, { "x-manage-token": r.json.manageToken });
  assert.equal(view.json.booking.service, svc.name);
  assert.equal((await t.get(`/api/bookings/${r.json.booking.reference}`, { "x-manage-token": "0".repeat(48) })).status, 404, "a wrong token reveals nothing");
});

test("[booking] [concurrency] the last seat cannot be booked twice, even by simultaneous requests; buffers block neighbours", { skip }, async () => {
  const t = await app();
  const svc = bookable();
  const date = openDate(t.now());
  const slot = (await t.get(`/api/availability?service=${svc.id}&date=${date}`)).json.slots[0];
  const capacity = (CONFIG.booking.resources ?? []).filter((r) => !r.services || r.services.includes(svc.id)).reduce((n, r) => n + (r.capacity ?? 1), 0);
  const attempts = await Promise.all(Array.from({ length: capacity + 3 }, (_, i) => t.post("/api/bookings", { serviceId: svc.id, start: slot.start, ...person(i + 10) }, { "cf-connecting-ip": `198.51.100.${i}` })));
  assert.equal(attempts.filter((a) => a.status === 201).length, capacity, "exactly the capacity is booked");
  assert.ok(attempts.filter((a) => a.status !== 201).every((a) => a.status === 409 && a.json.error.code === "slot_unavailable"));
  const after = await t.get(`/api/availability?service=${svc.id}&date=${date}`);
  assert.ok(!after.json.slots.some((s) => s.start === slot.start), "the full slot is no longer offered");
});

test("[booking] customers cancel and reschedule with their link inside the notice period; outside it they are refused", { skip }, async () => {
  const t = await app();
  const svc = bookable();
  const date = openDate(t.now(), Math.ceil(CONFIG.booking.cancellationNoticeHours / 24) + 2);
  const slots = (await t.get(`/api/availability?service=${svc.id}&date=${date}`)).json.slots;
  const b = (await t.post("/api/bookings", { serviceId: svc.id, start: slots[0].start, ...person(2) })).json;
  const h = { "x-manage-token": b.manageToken };
  const target = slots.at(-1).start;
  const moved = await t.post(`/api/bookings/${b.booking.reference}/reschedule`, { start: target }, h);
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.booking.start, target);
  const row = await t.db.prepare(`SELECT start_at, reference FROM bookings WHERE reference = ?`).bind(b.booking.reference).first();
  assert.equal(row.start_at, target, "same booking, same reference, new time");
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM bookings`).first()).n, 1);
  t.setNow(Date.parse(target) - (CONFIG.booking.cancellationNoticeHours * 36e5) + 60_000);
  const late = await t.post(`/api/bookings/${b.booking.reference}/cancel`, {}, h);
  assert.equal(late.status, 409);
  t.setNow(Date.parse(target) - (CONFIG.booking.cancellationNoticeHours * 36e5) - 36e5);
  const ok = await t.post(`/api/bookings/${b.booking.reference}/cancel`, {}, h);
  assert.equal(ok.json.booking.status, "cancelled");
  assert.equal((await t.post(`/api/bookings/${b.booking.reference}/cancel`, {}, h)).status, 409, "cancelling twice is refused");
  const hist = await t.db.prepare(`SELECT to_status FROM booking_history ORDER BY id`).all();
  assert.deepEqual(hist.results.map((x) => x.to_status).slice(-1), ["cancelled"]);
});

test("[booking] [idempotency] retrying the same booking request with its Idempotency-Key returns the first booking, never a second", { skip }, async () => {
  const t = await app();
  const svc = bookable();
  const slot = (await t.get(`/api/availability?service=${svc.id}&date=${openDate(t.now())}`)).json.slots[0];
  const body = { serviceId: svc.id, start: slot.start, ...person(3) };
  const a = await t.post("/api/bookings", body, { "idempotency-key": "retry-key-0001" });
  const b = await t.post("/api/bookings", body, { "idempotency-key": "retry-key-0001" });
  assert.equal(a.json.booking.reference, b.json.booking.reference);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM bookings`).first()).n, 1);
  assert.equal((await t.post("/api/bookings", { ...body, name: "Someone Else" }, { "idempotency-key": "retry-key-0001" })).status, 409);
});

test("[booking] [service-area] bookings outside the service area are refused", { skip: skip || !CONFIG.serviceArea?.postalCodes?.length ? "no postal-code service area configured" : false }, async () => {
  const t = await app();
  const svc = bookable();
  const slot = (await t.get(`/api/availability?service=${svc.id}&date=${openDate(t.now())}`)).json.slots[0];
  const r = await t.post("/api/bookings", { serviceId: svc.id, start: slot.start, ...person(4), postalCode: "99999" });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, "outside_service_area");
});
