// Storage and staff listing for the two internal calendars (routing rules: src/domain/calendars.ts; schema: migration 0065).
//  - Consultations carry their calendar on the booking row (voice-scheduling.ts writes it in the booking INSERT).
//  - Callbacks and follow-ups are a calendar_callbacks row written in ONE transaction with the CRM task it points at,
//    then read back. The voice functions only tell the agent a callback is recorded after that read-back succeeds.
import type { Db, DbStatement } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import type { CalendarId, CalendarRoute } from "../domain/calendars.ts";

export type CallbackKind = "callback" | "escalation" | "support_callback" | "sales_staff_callback" | "sales_ai_follow_up";

export interface CallbackInput {
  route: CalendarRoute;
  kind: CallbackKind;
  source: "ai_receptionist" | "ai_sales" | "staff";
  leadId: string;
  /** CRM task text (null = no task, e.g. a queued AI follow-up call). Founder-calendar tasks are prefixed. */
  taskBody: string | null;
  /** Statements that must succeed in the same transaction, run first (e.g. the sales_followups row the entry points at). */
  extra?: DbStatement[];
  /** Due time of the task / entry. */
  dueAt: Date;
  callId?: string | null;
  providerCallId?: string | null;
  salesFollowupId?: string | null;
  isTest: boolean;
}

export interface RecordedCallback { id: string; calendar: CalendarId; founderReason: string | null; taskId: string | null; dueAt: string }

export class CalendarWriteError extends Error {}

/**
 * Writes the CRM task and its calendar entry atomically, then confirms the entry from the database. Throws when either
 * write fails or the read-back does not match: callers must not tell anyone a callback exists unless this returns.
 */
export async function recordCallback(db: Db, i: CallbackInput): Promise<RecordedCallback> {
  const id = newId("cal"), taskId = i.taskBody === null ? null : newId("act"), at = nowIso(), due = i.dueAt.toISOString();
  const body = i.taskBody === null ? null : (i.route.calendar === "founder_callback" ? `[FOUNDER CALLBACK] ${i.taskBody}` : i.taskBody).slice(0, 2000);
  await db.batch([
    ...(i.extra ?? []),
    ...(taskId ? [db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, due_at, created_at) VALUES (?,?,'task',?,?,?)`).bind(taskId, i.leadId, body, due, at)] : []),
    db.prepare(`INSERT INTO calendar_callbacks (id, calendar, founder_reason, kind, source, lead_id, call_id, provider_call_id, sales_followup_id, task_activity_id, due_at, is_test, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, i.route.calendar, i.route.founderReason, i.kind, i.source, i.leadId, i.callId ?? null, i.providerCallId ?? null, i.salesFollowupId ?? null, taskId, due, i.isTest ? 1 : 0, at),
  ]);
  const row = await db.prepare(`SELECT c.calendar, c.founder_reason, c.task_activity_id, (SELECT COUNT(*) FROM crm_activities a WHERE a.id = c.task_activity_id) AS tasks
      FROM calendar_callbacks c WHERE c.id = ?`).bind(id).first<{ calendar: CalendarId; founder_reason: string | null; task_activity_id: string | null; tasks: number }>();
  if (!row || row.calendar !== i.route.calendar || (taskId && row.tasks !== 1)) throw new CalendarWriteError("Calendar entry was not recorded");
  await audit(db, { actorKind: i.source === "staff" ? "user" : "ai", action: "calendar.entry_recorded", subjectType: "calendar_callback", subjectId: id,
    details: { calendar: row.calendar, reason: row.founder_reason, kind: i.kind, lead: i.leadId, test: i.isTest } });
  return { id, calendar: row.calendar, founderReason: row.founder_reason, taskId, dueAt: due };
}

/** Confirms an active consultation exists with the given calendar. Used before telling the agent a booking was made. */
export async function confirmedConsultation(db: Db, id: string): Promise<{ id: string; calendar: CalendarId; founder_reason: string | null; status: string } | null> {
  return db.prepare(`SELECT id, calendar, founder_reason, status FROM consultations WHERE id = ? AND status IN ('requested','confirmed')`).bind(id)
    .first<{ id: string; calendar: CalendarId; founder_reason: string | null; status: string }>();
}

export interface CalendarEntry {
  entry_type: "consultation" | "callback";
  id: string;
  when_at: string | null;
  kind: string;
  status: string;
  founder_reason: string | null;
  source: string;
  lead_id: string | null;
  contact_name: string | null;
  detail: string | null;
  reference: string | null;
  is_test: number;
}

/**
 * Upcoming / open entries on one calendar: active consultations from an hour ago onward, and callbacks whose CRM task
 * is still open (and whose sales follow-up, if any, is still open). Sorted by time; undated callbacks last.
 */
export async function upcomingEntries(db: Db, calendar: CalendarId, now: Date, limit = 200): Promise<CalendarEntry[]> {
  const from = new Date(now.getTime() - 3_600_000).toISOString();
  const consultations = (await db.prepare(`SELECT 'consultation' AS entry_type, c.id, c.starts_at AS when_at, 'consultation' AS kind, c.status, c.founder_reason, c.source,
        c.lead_id, c.name AS contact_name, c.topic AS detail, c.confirmation_code AS reference, c.is_test
      FROM consultations c WHERE c.calendar = ? AND c.status IN ('requested','confirmed') AND c.starts_at >= ? ORDER BY c.starts_at LIMIT ?`)
    .bind(calendar, from, limit).all<CalendarEntry>()).results;
  const callbacks = (await db.prepare(`SELECT 'callback' AS entry_type, e.id, e.due_at AS when_at, e.kind, CASE WHEN f.status IS NOT NULL THEN f.status ELSE 'open' END AS status,
        e.founder_reason, e.source, e.lead_id, ct.name AS contact_name, COALESCE(a.body, f.notes) AS detail, NULL AS reference, e.is_test
      FROM calendar_callbacks e
      LEFT JOIN crm_activities a ON a.id = e.task_activity_id
      LEFT JOIN sales_followups f ON f.id = e.sales_followup_id
      LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN contacts ct ON ct.id = l.contact_id
      WHERE e.calendar = ? AND (e.task_activity_id IS NULL OR (a.id IS NOT NULL AND a.completed_at IS NULL)) AND (f.id IS NULL OR f.status IN ('scheduled','requested','pending_eligibility'))
      ORDER BY e.due_at LIMIT ?`).bind(calendar, limit).all<CalendarEntry>()).results;
  return [...consultations, ...callbacks]
    .sort((a, b) => (a.when_at ?? "9999").localeCompare(b.when_at ?? "9999"))
    .slice(0, limit);
}

export async function calendarCounts(db: Db, now: Date): Promise<Record<CalendarId, number>> {
  return { ai_follow_up: (await upcomingEntries(db, "ai_follow_up", now)).length, founder_callback: (await upcomingEntries(db, "founder_callback", now)).length };
}
