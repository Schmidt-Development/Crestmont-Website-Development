// AI Outbound Calendar appointment → scheduled AI callback (Founder directive 2026-11-06, part 2 mode A, part 5).
//
// Every active appointment on the AI Outbound Calendar is a call the AI sales agent places at that time. This keeps the
// queue in step with the calendar: a booking queues its callback (with the conversation so far, so the prospect does
// not repeat themselves), a reschedule moves the queued callback (never a second call), a cancellation cancels it.
// Founder Calendar appointments are the Founder's own and are never dialled by the AI.
//
// Queuing is not dialling: the callback still has to pass the Scheduled AI Callbacks switch, the callback gate
// (the prospect's own request on record, no do-not-call, recipient calling hours), capacity and the voice budget at
// its time (src/services/sales-outbound.ts). When it cannot be queued at all, a person gets a task at once.
//
// Outbound awareness (Founder directive 2026-11-08, Phase 13.3). The dialler never trusts the queue row alone:
//  - immediately before a callback is dialled, activeAppointmentFor() re-reads the appointment it serves (following a
//    reschedule to the new booking): a cancelled or finished appointment cancels the call, and a call whose appointment
//    is still in the future is moved to the appointment time instead of being dialled early;
//  - every dispatch run queues any active AI appointment that has no callback at all (queueMissingCallbacks), so an
//    appointment whose callback could not be queued when it was booked is never silently missed;
//  - a queued AI callback supersedes the receptionist's generic "please call me back" request for the same number, so
//    one request never becomes two calls;
//  - the agent learns about the lead's appointments through the authenticated scheduling/CRM function
//    (leadSchedule → get_outbound_lead_context) and the callback's dynamic variables, never by email.
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { enqueueSalesCall, type SalesCallRow } from "./sales-outbound.ts";
import { addLeadTask, addLeadNote, redactSensitive } from "./voice-common.ts";
import { slotLabel } from "./voice-settings.ts";
import { audit } from "./security.ts";
import { CALLBACK_GRACE_MS } from "../domain/outbound-capacity.ts";

interface AppointmentRow { id: string; lead_id: string | null; calendar: string; status: string; starts_at: string; timezone: string; topic: string | null; phone: string | null; is_test: number; rescheduled_from: string | null; call_id: string | null; cancel_reason?: string | null }
const APPT_COLS = "id, lead_id, calendar, status, starts_at, timezone, topic, phone, is_test, rescheduled_from, call_id, cancel_reason";

/** Brings the queued callback for one appointment in line with it. Returns the queue row, or null when none applies. */
export async function syncAppointmentCallback(db: Db, appointmentId: string, opts: { now?: Date; reason?: string | null; requirements?: string | null } = {}): Promise<SalesCallRow | null> {
  const now = opts.now ?? new Date();
  const a = await db.prepare(`SELECT ${APPT_COLS} FROM consultations WHERE id = ?`).bind(appointmentId).first<AppointmentRow>();
  if (!a || a.calendar !== "ai_follow_up") return null;
  if (!["requested", "confirmed"].includes(a.status)) {
    await cancelAppointmentCallback(db, a.id, a.status === "cancelled" ? "Appointment cancelled" : `Appointment ${a.status}`);
    return null;
  }
  if (!a.lead_id) return null;
  const summary = a.call_id ? (await db.prepare(`SELECT summary FROM calls WHERE id = ?`).bind(a.call_id).first<{ summary: string | null }>())?.summary ?? null : null;
  const context = { reason: opts.reason ?? a.topic ?? "Scheduled follow-up", appointment_label: slotLabel(a.starts_at, a.timezone), summary, requirements: opts.requirements ?? null, appointment_id: a.id };
  // A moved appointment takes its predecessor's queued callback with it (enqueue updates the open series in place).
  const row = await enqueueSalesCall(db, a.lead_id, { requestedBy: null, notBefore: a.starts_at, now, isTest: !!a.is_test, mode: "callback", appointmentId: a.id, context }).catch(() => null);
  if (!row) {
    await addLeadTask(db, a.lead_id, `${a.is_test ? "[TEST] " : ""}A scheduled AI callback could not be queued for the appointment on ${context.appointment_label}. Call the prospect at that time personally.`, 2);
    return null;
  }
  if (row.status === "blocked") {
    await addLeadTask(db, a.lead_id, `${a.is_test ? "[TEST] " : ""}The AI callback booked for ${context.appointment_label} cannot be placed automatically (${(row.status_detail ?? "").slice(0, 300)}). Call the prospect personally at that time.`, 2);
  }
  if (row.status === "queued") {
    // The booked time replaces the receptionist's generic callback request for this number (one request, one call).
    const sup = await db.prepare(`UPDATE voice_outbound_requests SET status = 'cancelled', status_detail = ?, updated_at = ? WHERE phone_e164 = ? AND purpose = 'callback' AND status IN ('pending_approval','approved')`)
      .bind(`Superseded by the scheduled AI callback on ${context.appointment_label}`.slice(0, 500), nowIso(), row.phone_e164).run();
    if (sup.meta.changes) await addLeadNote(db, a.lead_id, `${a.is_test ? "[TEST] " : ""}The open callback request for this number was replaced by the scheduled AI callback on ${context.appointment_label}.`);
  }
  return row;
}

/**
 * The active AI Follow-Up appointment a queued callback serves: the appointment itself, or the booking it was
 * rescheduled to. Null when it was cancelled (for any other reason), completed, marked no-show, or is not an AI
 * appointment — a callback for it must not be dialled.
 */
export async function activeAppointmentFor(db: Db, appointmentId: string): Promise<AppointmentRow | null> {
  let id: string | null = appointmentId;
  for (let hops = 0; id && hops < 10; hops++) {
    const a: AppointmentRow | null = await db.prepare(`SELECT ${APPT_COLS} FROM consultations WHERE id = ?`).bind(id).first<AppointmentRow>();
    if (!a) return null;
    if (a.status === "requested" || a.status === "confirmed") return a.calendar === "ai_follow_up" ? a : null;
    if (a.status !== "cancelled" || a.cancel_reason !== "rescheduled") return null;
    id = (await db.prepare(`SELECT id FROM consultations WHERE rescheduled_from = ? ORDER BY created_at DESC LIMIT 1`).bind(a.id).first<{ id: string }>())?.id ?? null;
  }
  return null;
}

/** How far ahead the dispatcher looks for AI appointments that have no callback queued. */
export const RECONCILE_AHEAD_MS = 7 * 86_400_000;

/**
 * Queues the callback for every active AI Follow-Up appointment (from just inside its grace period up to a week ahead)
 * that has no callback series at all. Each appointment is tried once (audited), so a lead that cannot be queued gets
 * one task, not one every run; an appointment with ANY series (queued, dialled, blocked, cancelled by staff) is left
 * alone. Returns how many appointments were looked at.
 */
export async function queueMissingCallbacks(db: Db, now: Date, limit = 25): Promise<number> {
  const rows = (await db.prepare(`SELECT c.id FROM consultations c
      WHERE c.calendar = 'ai_follow_up' AND c.status IN ('requested','confirmed') AND c.lead_id IS NOT NULL AND c.starts_at >= ? AND c.starts_at <= ?
        AND NOT EXISTS (SELECT 1 FROM sales_calls s WHERE s.appointment_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM audit_logs al WHERE al.action = 'sales_outbound.callback_reconciled' AND al.subject_type = 'consultation' AND al.subject_id = c.id)
      ORDER BY c.starts_at LIMIT ?`)
    .bind(new Date(now.getTime() - CALLBACK_GRACE_MS).toISOString(), new Date(now.getTime() + RECONCILE_AHEAD_MS).toISOString(), limit).all<{ id: string }>()).results;
  for (const r of rows) {
    const q = await syncAppointmentCallback(db, r.id, { now });
    await audit(db, { actorKind: "system", action: "sales_outbound.callback_reconciled", subjectType: "consultation", subjectId: r.id, details: { queued: q?.status ?? "none", salesCall: q?.id ?? null } });
  }
  return rows.length;
}

export interface LeadAppointment { when: string; starts_at: string; time_zone: string; calendar: string; type: string; status: string; reason: string }

/**
 * The lead's upcoming appointments on both calendars, as the outbound agent may hear them (no references, no other
 * customers' data). Used by get_outbound_lead_context and the callback's dynamic variables.
 */
export async function leadSchedule(db: Db, leadId: string, now: Date): Promise<LeadAppointment[]> {
  const rows = (await db.prepare(`SELECT starts_at, timezone, calendar, status, topic FROM consultations WHERE lead_id = ? AND status IN ('requested','confirmed') AND starts_at >= ? ORDER BY starts_at LIMIT 5`)
    .bind(leadId, new Date(now.getTime() - CALLBACK_GRACE_MS).toISOString()).all<{ starts_at: string; timezone: string; calendar: string; status: string; topic: string | null }>()).results;
  return rows.map((a) => ({
    when: slotLabel(a.starts_at, a.timezone), starts_at: a.starts_at, time_zone: a.timezone,
    calendar: a.calendar === "founder_callback" ? "Founder Callback" : "AI Follow-Up",
    type: a.calendar === "founder_callback" ? "appointment with the Founder" : "scheduled AI follow-up call",
    status: a.status === "requested" ? "awaiting the Founder's confirmation" : "confirmed",
    reason: redactSensitive((a.topic ?? "").replace(/\s+/g, " ").trim()).slice(0, 200),
  }));
}

/** Cancels the queued (not yet dialled) callback that serves an appointment. A call already in progress is left alone. */
export async function cancelAppointmentCallback(db: Db, appointmentId: string, why: string): Promise<number> {
  const r = await db.prepare(`UPDATE sales_calls SET status = 'cancelled', status_detail = ?, updated_at = ? WHERE appointment_id = ? AND mode = 'callback' AND status = 'queued'`).bind(why.slice(0, 300), nowIso(), appointmentId).run();
  // A receptionist follow-up call about this appointment (e.g. a reminder) is cancelled with it.
  await db.prepare(`UPDATE voice_outbound_requests SET status = 'cancelled', status_detail = ?, updated_at = ? WHERE consultation_id = ? AND status IN ('pending_approval','approved')`).bind(why.slice(0, 500), nowIso(), appointmentId).run();
  return r.meta.changes;
}

/** Scheduled callbacks as the Owner dashboard shows them: upcoming, overdue-while-paused, and missed. */
export async function callbackBoard(db: Db, now: Date, limit = 50) {
  const upcoming = (await db.prepare(`SELECT s.id, s.lead_id, s.status, s.status_detail, s.not_before, s.attempts, s.appointment_id, s.is_test, c.name AS contact_name
      FROM sales_calls s JOIN leads l ON l.id = s.lead_id JOIN contacts c ON c.id = l.contact_id
      WHERE s.mode = 'callback' AND s.status IN ('queued','dialing','in_progress') ORDER BY s.not_before LIMIT ?`).bind(limit)
    .all<{ id: string; lead_id: string; status: string; status_detail: string | null; not_before: string | null; attempts: number; appointment_id: string | null; is_test: number; contact_name: string | null }>()).results;
  const missed = (await db.prepare(`SELECT s.id, s.lead_id, s.not_before, s.missed_at, s.status_detail, s.is_test, c.name AS contact_name
      FROM sales_calls s JOIN leads l ON l.id = s.lead_id JOIN contacts c ON c.id = l.contact_id
      WHERE s.mode = 'callback' AND s.missed_at IS NOT NULL AND s.missed_at >= ? ORDER BY s.missed_at DESC LIMIT ?`).bind(new Date(now.getTime() - 14 * 86_400_000).toISOString(), limit)
    .all<{ id: string; lead_id: string; not_before: string | null; missed_at: string; status_detail: string | null; is_test: number; contact_name: string | null }>()).results;
  const overdue = upcoming.filter((r) => r.status === "queued" && r.not_before && Date.parse(r.not_before) < now.getTime());
  return { upcoming, missed, overdue };
}
