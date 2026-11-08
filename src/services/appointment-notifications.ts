// Internal appointment notifications for both internal calendars (Founder directives 2026-11-06 and 2026-11-08).
//
// Every booked, rescheduled and cancelled appointment on either calendar sends ONE email to the internal operations
// mailbox (internal-notify.ts: crestmontwebsitedevelopment@gmail.com, INTERNAL_NOTIFY_EMAIL may point a test
// environment elsewhere). Nothing here emails the Founder's personal address any more.
//
//   AI Follow-Up calendar (consultations, calendar = 'ai_follow_up')  → internal_alert, kind "appointment"
//   Founder Callback calendar, time-slot appointments                 → founder_appointment (the richer template:
//                                                                        business, sales context, confirm-or-decline),
//                                                                        kind "founder_callback"
//   Founder Callback calendar, callback requests without a time       → internal_alert, kind "founder_callback"
//
// Idempotency: the key is the appointment (or calendar entry) id plus the event, under the internal-notify key scheme,
// so a retried booking, a replayed Retell function call or a repeated webhook never sends a second email, and a
// detailed email and an internal_alert can never both go out for one event. A rescheduled appointment is a new row
// (new id), so "rescheduled" is keyed by the new appointment.
//
// Content is what the person handling it needs (name, business, phone, type, time with its time zone, reason, CRM
// link, how to prepare) and nothing more: no payment data, no transcripts; free text is passed through the card/SSN
// redaction the receptionist uses for stored text. A failed send never undoes or fails the booking.
import type { Db } from "../lib/db.ts";
import type { Env } from "../app/context.ts";
import type { MailerCtx, TemplateData } from "./mailer.ts";
import { slotLabel, loadVoiceConfig } from "./voice-settings.ts";
import { redactSensitive } from "./voice-common.ts";
import { sendInternalNotification, sendInternalTemplate } from "./internal-notify.ts";
import { CALENDAR_LABELS, CUSTOMER_REQUESTED_FOUNDER, type CalendarId } from "../domain/calendars.ts";

export type AppointmentEvent = "booked" | "rescheduled" | "cancelled";
/** Kept for the call sites written before the AI Follow-Up calendar was notified too. */
export type FounderEvent = AppointmentEvent;

export interface AppointmentNotifyDeps {
  db: Db;
  env?: Partial<Pick<Env, "INTERNAL_NOTIFY_EMAIL">> | null;
  mail?: MailerCtx;
  /** Absolute site origin for the CRM link; without it the email has no link. */
  baseUrl?: string;
}
export type FounderDeps = AppointmentNotifyDeps;

/** The hook the voice and sales function handlers call (src/routes/hooks.ts wires it to the real mailer). */
export interface AppointmentHooks {
  changed(consultationId: string, event: AppointmentEvent): Promise<void>;
  callbackRecorded(entryId: string): Promise<void>;
}

export const appointmentHooks = (d: AppointmentNotifyDeps): AppointmentHooks => ({
  changed: (id, event) => appointmentChanged(d, id, event),
  callbackRecorded: (id) => calendarCallbackRecorded(d, id),
});

interface Appt {
  id: string; lead_id: string | null; name: string; phone: string | null; email: string | null; starts_at: string; duration_minutes: number; timezone: string;
  status: string; topic: string | null; calendar: CalendarId; founder_reason: string | null; is_test: number; confirmation_code: string; source: string;
  rescheduled_from: string | null; cancel_reason: string | null;
}

const clean = (s: string | null | undefined, max: number) => redactSensitive((s ?? "").replace(/\s+/g, " ").trim()).slice(0, max);
const crmUrl = (d: AppointmentNotifyDeps, leadId: string | null) => (leadId && d.baseUrl ? `${d.baseUrl.replace(/\/$/, "")}/staff/crm/leads/${leadId}` : null);

/** Business name and the latest CRM context for the email (never the content of other customers' records). */
async function crmContext(db: Db, leadId: string | null) {
  if (!leadId) return { business: null, salesContext: null, phone: null as string | null, name: null as string | null };
  const lead = await db.prepare(`SELECT l.interest, l.message, c.name, c.phone, co.name AS company FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id WHERE l.id = ?`).bind(leadId)
    .first<{ interest: string | null; message: string | null; name: string | null; phone: string | null; company: string | null }>();
  const note = await db.prepare(`SELECT body FROM crm_activities WHERE lead_id = ? AND kind IN ('note','call') ORDER BY created_at DESC LIMIT 1`).bind(leadId).first<{ body: string }>();
  const ctx = [lead?.interest ? `Interest: ${lead.interest}` : null, clean(note?.body ?? lead?.message, 400) || null].filter(Boolean).join(" · ");
  return { business: lead?.company ?? null, salesContext: ctx || null, phone: lead?.phone ?? null, name: lead?.name ?? null };
}

const sourceLabel = (s: string) => (s === "ai_receptionist" ? "the AI agent on a call" : s === "staff" ? "staff" : s.replace(/_/g, " "));

/**
 * Emails the internal mailbox about one appointment event on either calendar. Never throws to the caller: the booking
 * always stands, and the delivery log records what the provider did with the message.
 */
export async function appointmentChanged(d: AppointmentNotifyDeps, consultationId: string, event: AppointmentEvent): Promise<void> {
  if (!d.mail) return;
  try {
    const a = await d.db.prepare(`SELECT * FROM consultations WHERE id = ?`).bind(consultationId).first<Appt>();
    if (!a) return;
    const mail = { ...d.mail, env: d.env ?? null };
    const ctx = await crmContext(d.db, a.lead_id);
    const when = slotLabel(a.starts_at, a.timezone);
    const prev = event === "rescheduled" && a.rescheduled_from
      ? await d.db.prepare(`SELECT starts_at, timezone FROM consultations WHERE id = ?`).bind(a.rescheduled_from).first<{ starts_at: string; timezone: string }>()
      : null;
    const phone = a.phone ?? ctx.phone;
    if (a.calendar === "founder_callback") {
      const data: TemplateData["founder_appointment"] = {
        event, prospect: a.name, business: ctx.business, when, timeZone: a.timezone, durationMinutes: a.duration_minutes,
        contact: [phone, a.email].filter(Boolean).join(" · ") || "—", reason: clean(a.topic, 300) || "—", salesContext: ctx.salesContext, status: a.status,
        reference: a.confirmation_code, crmUrl: crmUrl(d, a.lead_id), test: !!a.is_test,
        preparation: `${a.status === "requested" ? "Confirm or decline the request on the receptionist operations page first. " : ""}Review the CRM record (latest notes, calls and any quote) before the call${phone ? `, then call ${phone} at ${when}` : ""}.${prev ? ` It was previously ${slotLabel(prev.starts_at, prev.timezone)}.` : ""}`,
      };
      await sendInternalTemplate(mail, "founder_callback", `${a.id}:${event}`, { template: "founder_appointment", data });
      return;
    }
    const verb = event === "booked" ? "booked" : event === "rescheduled" ? "rescheduled" : "cancelled";
    const tag = a.is_test ? "[TEST] " : "";
    const facts: [string, string][] = [
      ["Customer", a.name],
      ...(ctx.business ? [["Business", ctx.business] as [string, string]] : []),
      ["Phone", phone ?? "—"],
      ["Appointment type", "AI follow-up call (30 minutes): the AI sales agent calls the customer"],
      ["When", when],
      ["Time zone", a.timezone],
      ...(prev ? [["Previously", slotLabel(prev.starts_at, prev.timezone)] as [string, string]] : []),
      ["Reason", clean(a.topic, 300) || "—"],
      ["Status", a.status],
      ["Calendar", CALENDAR_LABELS.ai_follow_up.name],
      ["Booked by", sourceLabel(a.source)],
      ["Booking reference", a.confirmation_code],
    ];
    await sendInternalNotification(mail, "appointment", `${a.id}:${event}`, {
      subject: `${tag}AI follow-up appointment ${verb}: ${a.name}, ${when}`,
      heading: `An AI follow-up appointment was ${verb}`,
      summary: event === "cancelled"
        ? `The AI follow-up call with ${a.name} on ${when} was cancelled. The queued AI callback is cancelled with it, so nobody will be dialled for this appointment.`
        : `The AI sales agent will call ${a.name} at ${when}. The call is re-checked against do-not-call, consent and calling hours immediately before it is placed.`,
      facts,
      nextAction: event === "cancelled" ? null : "No action is needed for the AI call. To prepare or take it over, review the CRM record (latest notes and the earlier call summary) before the appointment.",
      url: crmUrl(d, a.lead_id), urlLabel: "Open the CRM record",
    });
  } catch { /* never fail the booking; provider failures are in the delivery log */ }
}

/** The Founder Calendar half of the old Founder notification: kept so existing callers keep working. */
export async function founderAppointmentChanged(d: AppointmentNotifyDeps, consultationId: string, event: AppointmentEvent): Promise<void> {
  const cal = await d.db.prepare(`SELECT calendar FROM consultations WHERE id = ?`).bind(consultationId).first<{ calendar: string }>();
  if (cal?.calendar === "founder_callback") await appointmentChanged(d, consultationId, event);
}

const CALLBACK_KIND: Record<string, string> = { callback: "Callback request", sales_staff_callback: "Sales callback request", support_callback: "Support callback", sales_ai_follow_up: "AI follow-up call", escalation: "Escalation callback" };

/**
 * A callback request recorded on the Founder Callback calendar (no fixed time: the Founder or a team member calls back).
 * AI Follow-Up callback requests are routine CRM tasks and are not emailed; escalations already alert by their own
 * email (voice_escalation), so they are not emailed twice.
 */
export async function calendarCallbackRecorded(d: AppointmentNotifyDeps, entryId: string): Promise<void> {
  if (!d.mail) return;
  try {
    const e = await d.db.prepare(`SELECT e.id, e.calendar, e.founder_reason, e.kind, e.source, e.lead_id, e.due_at, e.is_test, a.body AS task FROM calendar_callbacks e LEFT JOIN crm_activities a ON a.id = e.task_activity_id WHERE e.id = ?`)
      .bind(entryId).first<{ id: string; calendar: CalendarId; founder_reason: string | null; kind: string; source: string; lead_id: string; due_at: string | null; is_test: number; task: string | null }>();
    if (!e || e.calendar !== "founder_callback" || e.kind === "escalation") return;
    const ctx = await crmContext(d.db, e.lead_id);
    const tz = (await loadVoiceConfig(d.db)).timezone ?? "America/New_York";
    const due = e.due_at ? slotLabel(e.due_at, tz) : "No time agreed";
    const name = ctx.name ?? "Unknown caller";
    await sendInternalNotification({ ...d.mail, env: d.env ?? null }, "founder_callback", `${e.id}:booked`, {
      subject: `${e.is_test ? "[TEST] " : ""}Founder callback requested: ${name}`,
      heading: "A customer asked for a callback from the Founder",
      summary: `${name} asked to speak with the Founder. The request is on the Founder Callback calendar and as a CRM task on the lead.`,
      facts: [
        ["Customer", name],
        ...(ctx.business ? [["Business", ctx.business] as [string, string]] : []),
        ["Phone", ctx.phone ?? "—"],
        ["Request type", CALLBACK_KIND[e.kind] ?? e.kind.replace(/_/g, " ")],
        ["Call back by", due],
        ["Time zone", tz],
        ["Reason", clean((e.task ?? "").replace(/^\[FOUNDER CALLBACK\]\s*/, ""), 400) || "—"],
        ["Why on this calendar", e.founder_reason === CUSTOMER_REQUESTED_FOUNDER ? "The customer asked for the Founder" : `Approved escalation rule ${(e.founder_reason ?? "").slice(5)}`],
        ["Recorded by", e.source === "ai_sales" ? "the AI sales agent on a call" : sourceLabel(e.source)],
      ],
      nextAction: "Review the CRM record, then call the customer back (or book a time with them on the Founder Callback calendar). Complete the CRM task when done.",
      url: crmUrl(d, e.lead_id), urlLabel: "Open the CRM record",
    });
  } catch { /* never fail the callback; provider failures are in the delivery log */ }
}
