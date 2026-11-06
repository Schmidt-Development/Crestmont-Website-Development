// Appointment scheduling for the AI agents (VOICE-003). The platform had no booking store, so this is the one place
// appointments live (table `consultations`, migrations 0042/0083/0090). Two internal calendars (Founder rules 2026-11-06):
//  - AI Outbound Calendar (`ai_follow_up`): scheduled AI callbacks and sales follow-ups. Every appointment is 30
//    minutes; a slot holds up to FIVE active bookings — the fifth succeeds, the sixth is refused by a database trigger
//    inside the inserting statement, so concurrent bookings cannot overbook. A booking is confirmed when made (the AI
//    agent itself keeps it) and is queued as a callback (src/services/appointment-callbacks.ts).
//  - Founder Calendar (`founder_callback`): only on an explicit request for the Founder. One appointment per slot
//    (partial unique index), the Founder's own windows, "requested" until the Founder confirms unless auto-confirm is on.
//  - Slots come only from each calendar's configured windows (src/services/voice-settings.ts calendarView); scheduling
//    is off until the Owner enables it. Minimum notice, horizon, holidays and time zone are applied server-side.
//  - Capacity is the platform's: an external calendar's busy events never cut an AI slot to one booking.
//  - Changing or reading a booking needs the confirmation code AND the phone number on the booking. Every
//    failure returns the same answer, so a caller cannot probe which bookings exist.
//  - No external calendar is connected. CalendarAdapter is the seam: `NO_CALENDAR` reports connected=false,
//    so phone bookings stay "requested" (holding the slot) until a person confirms them — unless the
//    Owner explicitly turns on auto-confirm.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { AI_FOLLOW_UP, type CalendarId, type CalendarRoute } from "../domain/calendars.ts";
import { candidateSlots, isOfferableSlot, slotLabel, calendarView, APPOINTMENT_MINUTES, AI_SLOT_CAPACITY, type Slot, type VoiceConfig } from "./voice-settings.ts";

export interface BusyInterval { start: number; end: number }
export interface CalendarAdapter {
  readonly kind: string;
  readonly connected: boolean;
  busy(fromMs: number, toMs: number): Promise<BusyInterval[]>;
}
/** No calendar provider is configured for Crestmont (none was found in the platform or its settings). */
export const NO_CALENDAR: CalendarAdapter = { kind: "none", connected: false, busy: async () => [] };

export const ACTIVE = ["requested", "confirmed"] as const;
export type ConsultationStatus = "requested" | "confirmed" | "cancelled" | "completed" | "no_show";

export interface ConsultationRow {
  id: string; lead_id: string | null; call_id: string | null; name: string; phone: string | null; email: string | null;
  starts_at: string; duration_minutes: number; timezone: string; status: ConsultationStatus; confirmation_code: string;
  topic: string | null; source: string; is_test: number; rescheduled_from: string | null; created_at: string;
  /** Internal calendar (migration 0083): ai_follow_up unless routed to the Founder by src/domain/calendars.ts. */
  calendar: CalendarId; founder_reason: string | null;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I: easier to read aloud
// Exactly 32 symbols, so each one is picked by the top 5 bits of a random byte: uniform, no modulo bias.
if (CODE_ALPHABET.length !== 32) throw new Error("CODE_ALPHABET must have exactly 32 symbols");
export function newConfirmationCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => CODE_ALPHABET[x >> 3]).join("");
}
export const normaliseCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/**
 * Time a calendar cannot offer. Founder Calendar: every active Founder appointment (exclusive). AI Outbound Calendar:
 * only slots already holding AI_SLOT_CAPACITY bookings — Founder appointments and partly-booked slots do not block it.
 */
async function bookedIntervals(db: Db, calendar: CalendarId, fromMs: number, toMs: number, exceptId?: string): Promise<BusyInterval[]> {
  const rows = (await db.prepare(`SELECT id, starts_at, duration_minutes FROM consultations WHERE calendar = ? AND status IN ('requested','confirmed') AND starts_at >= ? AND starts_at < ?`)
    .bind(calendar, new Date(fromMs - 6 * 3_600_000).toISOString(), new Date(toMs).toISOString()).all<{ id: string; starts_at: string; duration_minutes: number }>()).results
    .filter((r) => r.id !== exceptId);
  if (calendar === "founder_callback") return rows.map((r) => { const s = Date.parse(r.starts_at); return { start: s, end: s + r.duration_minutes * 60_000 }; });
  const perSlot = new Map<string, number>();
  for (const r of rows) perSlot.set(r.starts_at, (perSlot.get(r.starts_at) ?? 0) + 1);
  return [...perSlot].filter(([, n]) => n >= AI_SLOT_CAPACITY).map(([at]) => { const s = Date.parse(at); return { start: s, end: s + APPOINTMENT_MINUTES * 60_000 }; });
}

/** Active bookings in one AI Outbound Calendar slot (for the agent: "3 of 5 taken" is never spoken, only free/full). */
export async function aiSlotCount(db: Db, startsAt: string, exceptId?: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM consultations WHERE calendar = 'ai_follow_up' AND starts_at = ? AND status IN ('requested','confirmed') AND id <> ?`)
    .bind(new Date(Date.parse(startsAt)).toISOString(), exceptId ?? "").first<{ n: number }>())!.n;
}

export type Availability =
  | { available: false; reason: "scheduling_disabled" | "hours_not_configured" | "no_slots" | "calendar_unavailable" }
  | { available: true; slots: Slot[]; timezone: string; calendarConnected: boolean };

export async function availability(db: Db, cfg: VoiceConfig, at: Date, cal: CalendarAdapter, opts: { fromDate?: string; exceptId?: string; limit?: number; calendar?: CalendarId } = {}): Promise<Availability> {
  if (!cfg.scheduling.enabled) return { available: false, reason: "scheduling_disabled" };
  if (!cfg.timezone) return { available: false, reason: "hours_not_configured" };
  const calendar = opts.calendar ?? "ai_follow_up";
  const view = calendarView(cfg, calendar);
  const to = at.getTime() + (view.scheduling.horizon_days + 1) * 86_400_000;
  // An external calendar (Google, src/services/founder-calendar.ts) only ever informs the Founder's availability, never
  // AI capacity. When it is connected but cannot be read, no Founder time is offered: availability is never claimed
  // without the check.
  let external: BusyInterval[] = [];
  if (calendar === "founder_callback" && cal.connected) {
    try { external = await cal.busy(at.getTime(), to); } catch { return { available: false, reason: "calendar_unavailable" }; }
  }
  const busy = [...await bookedIntervals(db, calendar, at.getTime(), to, opts.exceptId), ...external];
  const slots = candidateSlots(view, at, busy, { fromDate: opts.fromDate, limit: opts.limit ?? 6 });
  return slots.length ? { available: true, slots, timezone: cfg.timezone, calendarConnected: cal.connected } : { available: false, reason: "no_slots" };
}

export class SlotUnavailableError extends Error {}

async function assertBookable(db: Db, cfg: VoiceConfig, at: Date, cal: CalendarAdapter, startsAt: string, calendar: CalendarId, exceptId?: string): Promise<void> {
  if (!cfg.scheduling.enabled || !cfg.timezone) throw new SlotUnavailableError("Scheduling is not available");
  if (!isOfferableSlot(calendarView(cfg, calendar), at, startsAt)) throw new SlotUnavailableError("That time is not an available appointment slot");
  const s = Date.parse(startsAt), e = s + APPOINTMENT_MINUTES * 60_000;
  if (calendar === "ai_follow_up") {
    // A friendly early answer; the trigger in migration 0090 is what actually guarantees the limit under concurrency.
    if (await aiSlotCount(db, startsAt, exceptId) >= AI_SLOT_CAPACITY) throw new SlotUnavailableError("That time is fully booked");
    return;
  }
  let external: BusyInterval[] = [];
  if (cal.connected) {
    try { external = await cal.busy(s, e); } catch { throw new SlotUnavailableError("The Founder's calendar cannot be checked right now"); }
  }
  const busy = [...await bookedIntervals(db, calendar, s - 86_400_000, e + 86_400_000, exceptId), ...external];
  if (busy.some((b) => s < b.end && e > b.start)) throw new SlotUnavailableError("That time was just taken");
}

/** Database refusals that mean "this slot cannot take this booking" (capacity, Founder exclusivity, duplicate). */
const SLOT_REFUSAL = /ai_follow_up_slot_full|uq_consultations_founder_slot|uq_consultations_calendar_phone_slot|consultations\.starts_at|consultations\.calendar, consultations\.starts_at/i;

async function insertBooking(db: Db, row: Omit<ConsultationRow, "confirmation_code" | "created_at">): Promise<ConsultationRow> {
  const at = nowIso();
  for (let i = 0; i < 5; i++) {
    const code = newConfirmationCode();
    try {
      await db.prepare(`INSERT INTO consultations (id, lead_id, call_id, name, phone, email, starts_at, duration_minutes, timezone, status, confirmation_code, topic, source, is_test, rescheduled_from, calendar, founder_reason, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(row.id, row.lead_id, row.call_id, row.name, row.phone, row.email, row.starts_at, row.duration_minutes, row.timezone, row.status, code, row.topic, row.source, row.is_test, row.rescheduled_from, row.calendar, row.founder_reason, at, at).run();
      return { ...row, confirmation_code: code, created_at: at };
    } catch (e) {
      const msg = String((e as Error).message);
      if (SLOT_REFUSAL.test(msg)) throw new SlotUnavailableError(/slot_full/.test(msg) ? "That time is fully booked" : "That time was just taken");
      if (/confirmation_code/i.test(msg)) continue; // vanishingly rare code collision: draw again
      throw e;
    }
  }
  throw new Error("Could not allocate a confirmation code");
}

export interface BookInput { name: string; phone: string; email?: string | null; startsAt: string; topic?: string | null; leadId: string | null; callId: string | null; isTest: boolean; source: "ai_receptionist" | "staff"; checkExisting?: boolean;
  /** Which internal calendar the booking goes on (src/domain/calendars.ts routeCalendar). Default: AI Follow-Up. */
  calendar?: CalendarRoute }

/** Books a slot. A caller who already holds an upcoming booking gets it back instead of a second one. */
/** AI Outbound Calendar bookings are AI callbacks, confirmed when made; Founder appointments follow auto-confirm. */
export const bookingStatus = (cfg: VoiceConfig, calendar: CalendarId): ConsultationStatus => calendar === "ai_follow_up" || cfg.scheduling.auto_confirm ? "confirmed" : "requested";

export async function book(db: Db, cfg: VoiceConfig, at: Date, cal: CalendarAdapter, b: BookInput): Promise<{ booking: ConsultationRow; existing: boolean }> {
  const route = b.calendar ?? AI_FOLLOW_UP;
  const mine = b.checkExisting === false ? undefined : (await db.prepare(`SELECT * FROM consultations WHERE calendar = ? AND status IN ('requested','confirmed') AND starts_at > ? AND phone IS NOT NULL`).bind(route.calendar, at.toISOString()).all<ConsultationRow>()).results
    .find((r) => digits(r.phone).length >= 7 && digits(r.phone) === digits(b.phone));
  if (mine) return { booking: mine, existing: true };
  await assertBookable(db, cfg, at, cal, b.startsAt, route.calendar);
  const status = bookingStatus(cfg, route.calendar);
  const booking = await insertBooking(db, {
    id: newId("cns"), lead_id: b.leadId, call_id: b.callId, name: b.name, phone: b.phone, email: b.email ?? null,
    starts_at: new Date(Date.parse(b.startsAt)).toISOString(), duration_minutes: APPOINTMENT_MINUTES, timezone: cfg.timezone!, status,
    topic: b.topic ?? null, source: b.source, is_test: b.isTest ? 1 : 0, rescheduled_from: null,
    calendar: route.calendar, founder_reason: route.founderReason,
  });
  await audit(db, { actorKind: b.source === "ai_receptionist" ? "ai" : "user", action: "consultation.booked", subjectType: "consultation", subjectId: booking.id, details: { status, call: b.callId, test: b.isTest, calendar: booking.calendar, reason: booking.founder_reason } });
  return { booking, existing: false };
}

/** Finds an ACTIVE booking only when both the code and the phone on the booking match. */
export async function findVerified(db: Db, code: string, phone: string): Promise<ConsultationRow | null> {
  const c = normaliseCode(code);
  if (c.length !== 6 || digits(phone).length < 7) return null;
  const row = await db.prepare(`SELECT * FROM consultations WHERE confirmation_code = ? AND status IN ('requested','confirmed')`).bind(c).first<ConsultationRow>();
  return row && digits(row.phone) === digits(phone) ? row : null;
}

export async function reschedule(db: Db, cfg: VoiceConfig, at: Date, cal: CalendarAdapter, current: ConsultationRow, newStartsAt: string, actor: { kind: "ai" | "user"; userId?: string }): Promise<ConsultationRow> {
  if (Date.parse(current.starts_at) <= at.getTime()) throw new SlotUnavailableError("This consultation has already started");
  const calendar: CalendarId = current.calendar ?? "ai_follow_up";
  await assertBookable(db, cfg, at, cal, newStartsAt, calendar, current.id);
  // One transaction: free the old slot and claim the new one. If the new slot is taken (Founder exclusivity, or the
  // AI slot's five-booking trigger) the whole batch rolls back, so the original booking can never be lost.
  const stamp = nowIso();
  const status = bookingStatus(cfg, calendar);
  const startsAt = new Date(Date.parse(newStartsAt)).toISOString();
  for (let i = 0; i < 5; i++) {
    const id = newId("cns"), code = newConfirmationCode();
    try {
      await db.batch([
        db.prepare(`UPDATE consultations SET status = 'cancelled', cancel_reason = 'rescheduled', updated_at = ? WHERE id = ? AND status IN ('requested','confirmed')`).bind(stamp, current.id),
        // A rescheduled booking stays on the calendar (and keeps the Founder reason) of the booking it replaces.
        db.prepare(`INSERT INTO consultations (id, lead_id, call_id, name, phone, email, starts_at, duration_minutes, timezone, status, confirmation_code, topic, source, is_test, rescheduled_from, calendar, founder_reason, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, current.lead_id, current.call_id, current.name, current.phone, current.email, startsAt, APPOINTMENT_MINUTES, cfg.timezone!, status, code, current.topic, current.source, current.is_test, current.id, calendar, current.founder_reason ?? null, stamp, stamp),
      ]);
      await audit(db, { actorKind: actor.kind, actorUserId: actor.userId ?? null, action: "consultation.rescheduled", subjectType: "consultation", subjectId: id, details: { from: current.id } });
      return { ...current, id, starts_at: startsAt, duration_minutes: APPOINTMENT_MINUTES, timezone: cfg.timezone!, status, confirmation_code: code, rescheduled_from: current.id, created_at: stamp };
    } catch (e) {
      const msg = String((e as Error).message);
      if (SLOT_REFUSAL.test(msg)) throw new SlotUnavailableError(/slot_full/.test(msg) ? "That time is fully booked" : "That time was just taken");
      if (/confirmation_code/i.test(msg)) continue;
      throw e;
    }
  }
  throw new Error("Could not allocate a confirmation code");
}

export async function cancel(db: Db, current: ConsultationRow, reason: string, actor: { kind: "ai" | "user"; userId?: string }): Promise<void> {
  await db.prepare(`UPDATE consultations SET status = 'cancelled', cancel_reason = ?, decided_by = ?, updated_at = ? WHERE id = ? AND status IN ('requested','confirmed')`)
    .bind(reason.slice(0, 500), actor.userId ?? null, nowIso(), current.id).run();
  await audit(db, { actorKind: actor.kind, actorUserId: actor.userId ?? null, action: "consultation.cancelled", subjectType: "consultation", subjectId: current.id });
}

export class ConsultationStateError extends Error {}

/** Staff confirm a requested booking (after checking their own calendar) or cancel it. */
export async function decide(db: Db, userId: string, id: string, decision: "confirm" | "cancel", note: string): Promise<ConsultationRow> {
  const row = await db.prepare(`SELECT * FROM consultations WHERE id = ?`).bind(id).first<ConsultationRow>();
  if (!row) throw Object.assign(new Error("Consultation not found"), { status: 404 });
  if (decision === "confirm") {
    if (row.status !== "requested") throw new ConsultationStateError("Only a requested consultation can be confirmed.");
    await db.prepare(`UPDATE consultations SET status = 'confirmed', decided_by = ?, updated_at = ? WHERE id = ?`).bind(userId, nowIso(), id).run();
    await audit(db, { actorUserId: userId, action: "consultation.confirmed", subjectType: "consultation", subjectId: id });
    return { ...row, status: "confirmed" };
  }
  if (!(ACTIVE as readonly string[]).includes(row.status)) throw new ConsultationStateError("This consultation is not active.");
  await cancel(db, row, note.trim() || "Cancelled by staff", { kind: "user", userId });
  return { ...row, status: "cancelled" };
}

export async function upcomingConsultations(db: Db, at: Date, limit = 50): Promise<ConsultationRow[]> {
  return (await db.prepare(`SELECT * FROM consultations WHERE status IN ('requested','confirmed') AND starts_at >= ? ORDER BY starts_at LIMIT ?`)
    .bind(new Date(at.getTime() - 3_600_000).toISOString(), limit).all<ConsultationRow>()).results;
}

export const labelOf = (row: Pick<ConsultationRow, "starts_at" | "timezone">) => slotLabel(row.starts_at, row.timezone);
