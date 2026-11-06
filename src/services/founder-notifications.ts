// Founder appointment notifications (Founder directive 2026-11-06). The internal Founder Calendar (consultations,
// calendar = 'founder_callback') is the authoritative scheduling system: request-only, one appointment per slot within
// the Founder's configured windows, "requested" until the Founder confirms. No external calendar is used.
//
// For every new, rescheduled and cancelled Founder appointment the Founder is emailed through the platform mailer
// (Resend outside development). Each appointment + event is sent at most once (idempotency key), so a retried booking
// or a repeated webhook never produces a second email. Delivery is whatever the mail provider reports in email_deliveries.
import type { Db } from "../lib/db.ts";
import type { Env } from "../app/context.ts";
import { sendMail, type MailerCtx } from "./mailer.ts";
import { slotLabel } from "./voice-settings.ts";

export type FounderEvent = "booked" | "rescheduled" | "cancelled";
/** The Founder's address for appointment notifications (already the Founder's public commit address); overridable. */
export const DEFAULT_FOUNDER_NOTIFY_EMAIL = "noahschmidt10@gmail.com";
export const founderNotifyEmail = (env: Pick<Env, "FOUNDER_NOTIFY_EMAIL">) => (env.FOUNDER_NOTIFY_EMAIL?.trim() || DEFAULT_FOUNDER_NOTIFY_EMAIL).toLowerCase();

export interface FounderDeps { db: Db; env: Pick<Env, "FOUNDER_NOTIFY_EMAIL">; mail?: MailerCtx; baseUrl?: string }

interface Appt { id: string; lead_id: string | null; name: string; phone: string | null; email: string | null; starts_at: string; duration_minutes: number; timezone: string; status: string; topic: string | null; calendar: string; is_test: number; confirmation_code: string }

/** Business name and the latest CRM context for the email (never the content of other customers' records). */
async function crmContext(db: Db, leadId: string | null) {
  if (!leadId) return { business: null, salesContext: null };
  const lead = await db.prepare(`SELECT l.interest, l.message, co.name AS company FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id WHERE l.id = ?`).bind(leadId)
    .first<{ interest: string | null; message: string | null; company: string | null }>();
  const note = await db.prepare(`SELECT body FROM crm_activities WHERE lead_id = ? AND kind IN ('note','call') ORDER BY created_at DESC LIMIT 1`).bind(leadId).first<{ body: string }>();
  const ctx = [lead?.interest ? `Interest: ${lead.interest}` : null, (note?.body ?? lead?.message ?? "").replace(/\s+/g, " ").slice(0, 400) || null].filter(Boolean).join(" · ");
  return { business: lead?.company ?? null, salesContext: ctx || null };
}

/** Emails the Founder about one Founder appointment event. Never throws to the caller: the booking always stands. */
export async function founderAppointmentChanged(d: FounderDeps, consultationId: string, event: FounderEvent): Promise<void> {
  if (!d.mail) return;
  const a = await d.db.prepare(`SELECT * FROM consultations WHERE id = ?`).bind(consultationId).first<Appt>();
  if (!a || a.calendar !== "founder_callback") return;
  const ctx = await crmContext(d.db, a.lead_id);
  try {
    await sendMail(d.mail, { template: "founder_appointment", to: founderNotifyEmail(d.env), idempotencyKey: `founder-appt:${a.id}:${event}`, data: {
      event, prospect: a.name, business: ctx.business, when: slotLabel(a.starts_at, a.timezone), timeZone: a.timezone, durationMinutes: a.duration_minutes,
      contact: [a.phone, a.email].filter(Boolean).join(" · ") || "—", reason: a.topic ?? "—", salesContext: ctx.salesContext, status: a.status, reference: a.confirmation_code,
      crmUrl: a.lead_id && d.baseUrl ? `${d.baseUrl.replace(/\/$/, "")}/staff/crm/leads/${a.lead_id}` : null, test: !!a.is_test,
    } });
  } catch { /* the delivery log records provider failures */ }
}
