// Consultation scheduling for the AI receptionist (VOICE-003). The platform had no booking store, so this is
// the one place consultations live (table `consultations`, migration 0040). Rules:
//  - Slots come only from configured business hours (src/services/voice-settings.ts); scheduling is off
//    until the Owner enables it. Minimum notice, horizon, holidays and time zone are applied server-side.
//  - Double booking is impossible at the database level (partial unique index on active start times) and
//    overlapping bookings are rejected in code.
//  - Changing or reading a booking needs the confirmation code AND the phone number on the booking. Every
//    failure returns the same answer, so a caller cannot probe which bookings exist.
//  - No external calendar is connected. CalendarAdapter is the seam: `NO_CALENDAR` reports connected=false,
//    so phone bookings stay "requested" (holding the slot) until a person confirms them — unless the
//    Owner explicitly turns on auto-confirm.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { candidateSlots, isOfferableSlot, slotLabel, type Slot, type VoiceConfig } from "./voice-settings.ts";

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

async function bookedIntervals(db: Db, fromMs: number, toMs: number, exceptId?: string): Promise<BusyInterval[]> {
  const rows = (await db.prepare(`SELECT id, starts_at, duration_minutes FROM consultations WHERE status IN ('requested','confirmed') AND starts_at >= ? AND starts_at < ?`)
    .bind(new Date(fromMs - 6 * 3_600_000).toISOString(), new Date(toMs).toISOString()).all<{ id: string; starts_at: string; duration_minutes: number }>()).results;
  return rows.filter((r) => r.id !== exceptId).map((r) => { const s = Date.parse(r.starts_at); return { start: s, end: s + r.duration_minutes * 60_000 }; });
}

export type Availability =
  | { available: false; reason: "scheduling_disabled" | "hours_not_configured" | "no_slots" }
  | { available: true; slots: Slot[]; timezone: string; calendarConnected: boolean };

export async function availability(db: Db, cfg: VoiceConfig, at: Date, cal: CalendarAdapter, opts: { fromDate?: string; exceptId?: string; limit?: number } = {}): Promise<Availability> {
  if (!cfg.scheduling.enabled) return { available: false, reason: "scheduling_disabled" };
  if (!cfg.timezone) return { available: false, reason: "hours_not_configured" };
  const to = at.getTime() + (cfg.scheduling.horizon_days + 1) * 86_400_000;
  const busy = [...await bookedIntervals(db, at.getTime(), to, opts.exceptId), ...(cal.connected ? await cal.busy(at.getTime(), to) : [])];
  const slots = candidateSlots(cfg, at, busy, { fromDate: opts.fromDate, limit: opts.limit ?? 6 });
  return slots.length ? { available: true, slots, timezone: cfg.timezone, calendarConnected: cal.connected } : { available: false, reason: "no_slots" };
}

export class SlotUnavailableError extends Error {}

async function assertBookable(db: Db, cfg: VoiceConfig, at: Date, cal: CalendarAdapter, startsAt: string, exceptId?: string): Promise<void> {
  if (!cfg.scheduling.enabled || !cfg.timezone) throw new SlotUnavailableError("Scheduling is not available");
  if (!isOfferableSlot(cfg, at, startsAt)) throw new SlotUnavailableError("That time is not an available consultation slot");
  const s = Date.parse(startsAt), e = s + cfg.scheduling.duration_minutes * 60_000;
  const busy = [...await bookedIntervals(db, s - 86_400_000, e + 86_400_000, exceptId), ...(cal.connected ? await cal.busy(s, e) : [])];
  if (busy.some((b) => s < b.end && e > b.start)) throw new SlotUnavailableError("That time was just taken");
}

async function insertBooking(db: Db, row: Omit<ConsultationRow, "confirmation_code" | "created_at">): Promise<ConsultationRow> {
  const at = nowIso();
  for (let i = 0; i < 5; i++) {
    const code = newConfirmationCode();
    try {
      await db.prepare(`INSERT INTO consultations (id, lead_id, call_id, name, phone, email, starts_at, duration_minutes, timezone, status, confirmation_code, topic, source, is_test, rescheduled_from, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(row.id, row.lead_id, row.call_id, row.name, row.phone, row.email, row.starts_at, row.duration_minutes, row.timezone, row.status, code, row.topic, row.source, row.is_test, row.rescheduled_from, at, at).run();
      return { ...row, confirmation_code: code, created_at: at };
    } catch (e) {
      const msg = String((e as Error).message);
      if (/consultations\.starts_at|uq_consultations_active_slot/i.test(msg)) throw new SlotUnavailableError("That time was just taken");
      if (/confirmation_code/i.test(msg)) continue; // vanishingly rare code collision: draw again
      throw e;
    }
  }
  throw new Error("Could not allocate a confirmation code");
}

export interface BookInput { name: string; phone: string; email?: string | null; startsAt: string; topic?: string | null; leadId: string | null; callId: string | null; isTest: boolean; source: "ai_receptionist" | "staff"; checkExisting?: boolean }

/** Books a slot. A caller who already holds an upcoming booking gets it back instead of a second one. */
export async function book(db: Db, cfg: VoiceConfig, at: Date, cal: CalendarAdapter, b: BookInput): Promise<{ booking: ConsultationRow; existing: boolean }> {
  const mine = b.checkExisting === false ? undefined : (await db.prepare(`SELECT * FROM consultations WHERE status IN ('requested','confirmed') AND starts_at > ? AND phone IS NOT NULL`).bind(at.toISOString()).all<ConsultationRow>()).results
    .find((r) => digits(r.phone).length >= 7 && digits(r.phone) === digits(b.phone));
  if (mine) return { booking: mine, existing: true };
  await assertBookable(db, cfg, at, cal, b.startsAt);
  const status: ConsultationStatus = cfg.scheduling.auto_confirm ? "confirmed" : "requested";
  const booking = await insertBooking(db, {
    id: newId("cns"), lead_id: b.leadId, call_id: b.callId, name: b.name, phone: b.phone, email: b.email ?? null,
    starts_at: new Date(Date.parse(b.startsAt)).toISOString(), duration_minutes: cfg.scheduling.duration_minutes, timezone: cfg.timezone!, status,
    topic: b.topic ?? null, source: b.source, is_test: b.isTest ? 1 : 0, rescheduled_from: null,
  });
  await audit(db, { actorKind: b.source === "ai_receptionist" ? "ai" : "user", action: "consultation.booked", subjectType: "consultation", subjectId: booking.id, details: { status, call: b.callId, test: b.isTest } });
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
  await assertBookable(db, cfg, at, cal, newStartsAt, current.id);
  // One transaction: free the old slot and claim the new one. If the new slot is taken the whole batch rolls
  // back, so the original booking can never be lost to a concurrent booking of the freed slot.
  const stamp = nowIso();
  const status: ConsultationStatus = cfg.scheduling.auto_confirm ? "confirmed" : "requested";
  const startsAt = new Date(Date.parse(newStartsAt)).toISOString();
  for (let i = 0; i < 5; i++) {
    const id = newId("cns"), code = newConfirmationCode();
    try {
      await db.batch([
        db.prepare(`UPDATE consultations SET status = 'cancelled', cancel_reason = 'rescheduled', updated_at = ? WHERE id = ? AND status IN ('requested','confirmed')`).bind(stamp, current.id),
        db.prepare(`INSERT INTO consultations (id, lead_id, call_id, name, phone, email, starts_at, duration_minutes, timezone, status, confirmation_code, topic, source, is_test, rescheduled_from, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, current.lead_id, current.call_id, current.name, current.phone, current.email, startsAt, cfg.scheduling.duration_minutes, cfg.timezone!, status, code, current.topic, current.source, current.is_test, current.id, stamp, stamp),
      ]);
      await audit(db, { actorKind: actor.kind, actorUserId: actor.userId ?? null, action: "consultation.rescheduled", subjectType: "consultation", subjectId: id, details: { from: current.id } });
      return { ...current, id, starts_at: startsAt, duration_minutes: cfg.scheduling.duration_minutes, timezone: cfg.timezone!, status, confirmation_code: code, rescheduled_from: current.id, created_at: stamp };
    } catch (e) {
      const msg = String((e as Error).message);
      if (/consultations\.starts_at|uq_consultations_active_slot/i.test(msg)) throw new SlotUnavailableError("That time was just taken");
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
