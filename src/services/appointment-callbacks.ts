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
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { enqueueSalesCall, type SalesCallRow } from "./sales-outbound.ts";
import { addLeadTask } from "./voice-common.ts";
import { slotLabel } from "./voice-settings.ts";

interface AppointmentRow { id: string; lead_id: string | null; calendar: string; status: string; starts_at: string; timezone: string; topic: string | null; phone: string | null; is_test: number; rescheduled_from: string | null; call_id: string | null }

/** Brings the queued callback for one appointment in line with it. Returns the queue row, or null when none applies. */
export async function syncAppointmentCallback(db: Db, appointmentId: string, opts: { now?: Date; reason?: string | null; requirements?: string | null } = {}): Promise<SalesCallRow | null> {
  const now = opts.now ?? new Date();
  const a = await db.prepare(`SELECT id, lead_id, calendar, status, starts_at, timezone, topic, phone, is_test, rescheduled_from, call_id FROM consultations WHERE id = ?`).bind(appointmentId).first<AppointmentRow>();
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
  return row;
}

/** Cancels the queued (not yet dialled) callback that serves an appointment. A call already in progress is left alone. */
export async function cancelAppointmentCallback(db: Db, appointmentId: string, why: string): Promise<number> {
  const r = await db.prepare(`UPDATE sales_calls SET status = 'cancelled', status_detail = ?, updated_at = ? WHERE appointment_id = ? AND mode = 'callback' AND status = 'queued'`).bind(why.slice(0, 300), nowIso(), appointmentId).run();
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
