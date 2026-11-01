// Booking engine: availability from business hours (in the business's time zone, DST-safe), lead time, buffers,
// blackout dates, resources with capacity; atomic creation that cannot double-book; cancel / reschedule with policy.
import { CONFIG } from "./config.js";
import { HttpError } from "./http.js";
import { all, one, nowMs, nowIso, settings } from "./db.js";
import { hhmm, iso, isDate, localDate, minutes, weekdayOf, zonedToUtc } from "./time.js";

const ACTIVE = "status IN ('confirmed', 'pending_payment') AND (status = 'confirmed' OR hold_expires_at IS NULL OR hold_expires_at > ?)";

export const bookingCfg = () => CONFIG.booking ?? {};
export const tz = () => CONFIG.business?.timeZone ?? "UTC";

/** Candidate start instants for a service on a local date (before capacity is applied). */
export function candidateSlots(hours, blackoutDates, date, durationMin, now) {
  const k = bookingCfg();
  if (!isDate(date) || blackoutDates.includes(date)) return [];
  const ranges = hours[weekdayOf(date)] ?? [];
  const step = k.slotIntervalMinutes;
  const earliest = now + k.leadTimeMinutes * 60_000;
  const lastDay = localDate(now + k.maxDaysAhead * 864e5, tz());
  if (date > lastDay || date < localDate(now, tz())) return [];
  const out = new Set();
  for (const r of ranges) {
    for (let m = minutes(r.open); m + durationMin <= minutes(r.close); m += step) {
      const start = zonedToUtc(date, hhmm(m), tz());
      if (start === null) continue;                     // spring-forward gap: this wall time does not exist
      const end = start + durationMin * 60_000;
      const closeAt = zonedToUtc(date, r.close, tz());
      if (closeAt !== null && end > closeAt) continue;  // a DST change inside the range shortens it
      if (start >= earliest) out.add(start);
    }
  }
  return [...out].sort((a, b) => a - b);
}

async function service(env, id) {
  const s = await one(env.DB, `SELECT * FROM services WHERE id = ? AND active = 1`, id);
  if (!s || !s.bookable) throw new HttpError(404, "service_not_found", "That service cannot be booked online.");
  return s;
}

/** Available slots: [{ start, end, resourceIds }] for one service and local date. */
export async function availability(env, serviceId, date) {
  const s = await service(env, serviceId);
  const st = await settings(env);
  const now = nowMs(env);
  const buffer = bookingCfg().bufferMinutes * 60_000;
  const resources = await all(env.DB, `SELECT r.* FROM resources r JOIN resource_services rs ON rs.resource_id = r.id WHERE rs.service_id = ? AND r.active = 1 ORDER BY r.id`, s.id);
  const slots = [];
  for (const start of candidateSlots(st.hours, st.blackoutDates, date, s.duration_minutes, now)) {
    const end = start + s.duration_minutes * 60_000;
    const free = [];
    for (const r of resources) {
      const row = await one(env.DB, `SELECT COUNT(*) AS n FROM bookings WHERE resource_id = ? AND ${ACTIVE} AND block_start_at < ? AND block_end_at > ?`, r.id, nowIso(env), iso(end + buffer), iso(start - buffer));
      if (row.n < r.capacity) free.push(r.id);
    }
    if (free.length) slots.push({ start: iso(start), end: iso(end), resourceIds: free });
  }
  return { service: { id: s.id, name: s.name, durationMinutes: s.duration_minutes }, date, timeZone: tz(), slots };
}

/**
 * Insert a booking only if the resource still has capacity for the blocked interval: ONE atomic INSERT … SELECT
 * statement (SQLite/D1 run each statement atomically and serially), so two concurrent requests for the last seat
 * cannot both succeed. Returns the resource used, or throws 409 when the slot was taken meanwhile.
 */
export async function insertBooking(env, b, extraStmts = []) {
  const s = await service(env, b.serviceId);
  const start = Date.parse(b.start);
  if (!Number.isFinite(start)) throw new HttpError(422, "validation_failed", "Choose a time.", { fields: { start: "Choose a time." } });
  const st = await settings(env);
  const date = localDate(start, tz());
  if (!candidateSlots(st.hours, st.blackoutDates, date, s.duration_minutes, nowMs(env)).includes(start)) throw new HttpError(409, "slot_unavailable", "That time is not available. Please choose another.");
  const end = start + s.duration_minutes * 60_000;
  const buffer = bookingCfg().bufferMinutes * 60_000;
  const resources = await all(env.DB, `SELECT r.* FROM resources r JOIN resource_services rs ON rs.resource_id = r.id WHERE rs.service_id = ? AND r.active = 1 ORDER BY r.id`, s.id);
  const hold = b.paymentRequired ? iso(nowMs(env) + 30 * 60_000) : null;
  for (const r of resources) {
    const res = await env.DB.prepare(`INSERT INTO bookings (id, reference, service_id, resource_id, customer_id, customer_name, customer_email, customer_phone, address, postal_code, notes, start_at, end_at, block_start_at, block_end_at, time_zone, status, manage_token_hash, payment_required, hold_expires_at, created_at, updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
        WHERE (SELECT COUNT(*) FROM bookings WHERE resource_id = ? AND ${ACTIVE} AND block_start_at < ? AND block_end_at > ?) < ?`)
      .bind(b.id, b.reference, s.id, r.id, b.customerId ?? null, b.name, b.email, b.phone ?? null, b.address ?? null, b.postalCode ?? null, b.notes ?? null,
        iso(start), iso(end), iso(start - buffer), iso(end + buffer), tz(), b.paymentRequired ? "pending_payment" : "confirmed", b.tokenHash, b.paymentRequired ? 1 : 0, hold, nowIso(env), nowIso(env),
        r.id, nowIso(env), iso(end + buffer), iso(start - buffer), r.capacity).run();
    if (res.meta.changes === 1) {
      if (extraStmts.length) await env.DB.batch(extraStmts);
      return { resourceId: r.id, service: s, start, end };
    }
  }
  throw new HttpError(409, "slot_unavailable", "Sorry, that time was just taken. Please choose another.");
}

/**
 * Move a confirmed booking to a new start IN PLACE (same row, reference and manage link): one atomic UPDATE per
 * candidate resource that only succeeds while that resource has capacity for the new interval, not counting this
 * booking itself. A taken slot leaves the booking unchanged (409).
 */
export async function moveBooking(env, booking, newStartIso, extraStmts = []) {
  const s = await service(env, booking.service_id);
  const start = Date.parse(newStartIso);
  const st = await settings(env);
  if (!Number.isFinite(start) || !candidateSlots(st.hours, st.blackoutDates, localDate(start, tz()), s.duration_minutes, nowMs(env)).includes(start)) {
    throw new HttpError(409, "slot_unavailable", "That time is not available. Please choose another.");
  }
  const end = start + s.duration_minutes * 60_000;
  const buffer = bookingCfg().bufferMinutes * 60_000;
  const resources = await all(env.DB, `SELECT r.* FROM resources r JOIN resource_services rs ON rs.resource_id = r.id WHERE rs.service_id = ? AND r.active = 1 ORDER BY r.id = ? DESC, r.id`, s.id, booking.resource_id);
  for (const r of resources) {
    const res = await env.DB.prepare(`UPDATE bookings SET resource_id = ?, start_at = ?, end_at = ?, block_start_at = ?, block_end_at = ?, updated_at = ?
        WHERE id = ? AND status = 'confirmed'
          AND (SELECT COUNT(*) FROM bookings WHERE resource_id = ? AND ${ACTIVE} AND block_start_at < ? AND block_end_at > ? AND id <> ?) < ?`)
      .bind(r.id, iso(start), iso(end), iso(start - buffer), iso(end + buffer), nowIso(env), booking.id, r.id, nowIso(env), iso(end + buffer), iso(start - buffer), booking.id, r.capacity).run();
    if (res.meta.changes === 1) {
      if (extraStmts.length) await env.DB.batch(extraStmts);
      return { resourceId: r.id, start, end };
    }
  }
  throw new HttpError(409, "slot_unavailable", "Sorry, that time was just taken. Please choose another.");
}

/** Cancellation is allowed until cancellationNoticeHours before the start (administrators may override). */
export function cancellable(booking, now, override = false) {
  if (!["confirmed", "pending_payment"].includes(booking.status)) return { ok: false, reason: `This booking is ${booking.status.replace("_", " ")}.` };
  if (override) return { ok: true };
  const notice = bookingCfg().cancellationNoticeHours * 36e5;
  if (Date.parse(booking.start_at) - now < notice) return { ok: false, reason: `Bookings can be changed online until ${bookingCfg().cancellationNoticeHours} hours before the start. Please call us.` };
  return { ok: true };
}

export function formatWhen(startIso) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz(), weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(startIso));
}
