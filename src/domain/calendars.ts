// Dual internal calendars (Founder requirement, binding). The ONE place that decides which calendar an AI-recorded
// callback, follow-up or consultation lands on. Storage: migrations/0065_dual_calendars.sql.
//
//   Calendar A  ai_follow_up      "AI Follow-Up": AI follow-up calls, customer questions, qualification, reminders,
//                                 routine callbacks. The default for everything.
//   Calendar B  founder_callback  "Founder Callback": ONLY when
//                                   1. the customer explicitly asked to speak with the Founder, signalled by the voice
//                                      agent's boolean argument `wants_founder: true` (never inferred from free text), or
//                                   2. an escalation rule in APPROVED_ESCALATION_RULES applies. That list is EMPTY until
//                                      the Founder approves a rule; adding one is a code change with review.
//
// Anything missing, false, malformed or ambiguous routes to ai_follow_up, never to the Founder.
import type { Check } from "../lib/validate.ts";

export const CALENDARS = ["ai_follow_up", "founder_callback"] as const;
export type CalendarId = (typeof CALENDARS)[number];

export const CALENDAR_LABELS: Record<CalendarId, { name: string; slug: string; purpose: string }> = {
  ai_follow_up: { name: "AI Follow-Up", slug: "ai-follow-up", purpose: "AI-managed follow-up calls, customer questions, qualification, reminders and routine callbacks." },
  founder_callback: { name: "Founder Callback", slug: "founder-callback", purpose: "Only callers who specifically asked to speak with the Founder, or an escalation rule the Founder approved." },
};

export const CUSTOMER_REQUESTED_FOUNDER = "customer_requested_founder";
/** founder_reason is 'customer_requested_founder' or 'rule:<id>' (the database CHECK enforces the same shape). */
export type FounderReason = typeof CUSTOMER_REQUESTED_FOUNDER | `rule:${string}`;

/** What a rule may look at. Only facts the backend itself established; never free text spoken on the call. */
export interface RoutingContext {
  channel: "inbound_receptionist" | "outbound_sales";
  /** Which function is recording the entry (request_callback, escalate, book_consultation, schedule_sales_followup, ...). */
  fn: string;
  /** Kind of entry being recorded (callback, escalation, consultation, sales_staff_callback, ...). */
  kind: string;
}

/** A Founder-approved escalation rule. `id` is lowercase letters/digits only; it is stored as founder_reason 'rule:<id>'. */
export interface EscalationRule {
  readonly id: string;
  readonly description: string;
  /** Who approved it and when (Founder decision record). A rule without both is ignored. */
  readonly approvedBy: string;
  readonly approvedAt: string;
  applies(ctx: RoutingContext): boolean;
}

/**
 * Escalation rules the Founder has explicitly approved for Calendar B. Deliberately EMPTY: no rule has been approved.
 * Do not add a rule without a recorded Founder decision.
 */
export const APPROVED_ESCALATION_RULES: readonly EscalationRule[] = [];

const RULE_ID = /^[a-z0-9]{1,40}$/;

/** True only for an explicit boolean true (or the string "true" the voice adapters normalise booleans to). */
export function explicitFounderRequest(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Lenient argument check for `wants_founder`: it never fails a call (a callback must always be recordable) and yields
 * true only for an explicit true. Absent → undefined; anything else → false. Used inside v.object schemas so the
 * Retell contract audits see the field.
 */
export const wantsFounderArg: Check<boolean | undefined> = ((value: unknown) =>
  value === undefined || value === null || value === "" ? undefined : explicitFounderRequest(value)) as Check<boolean | undefined>;

export interface CalendarRoute { calendar: CalendarId; founderReason: FounderReason | null }

export const AI_FOLLOW_UP: CalendarRoute = Object.freeze({ calendar: "ai_follow_up", founderReason: null });

/** Decides the calendar. Pure; `rules` is injectable for tests only. */
export function routeCalendar(input: { wantsFounder?: unknown; context: RoutingContext }, rules: readonly EscalationRule[] = APPROVED_ESCALATION_RULES): CalendarRoute {
  if (explicitFounderRequest(input.wantsFounder)) return { calendar: "founder_callback", founderReason: CUSTOMER_REQUESTED_FOUNDER };
  for (const r of rules) {
    if (!RULE_ID.test(r.id) || !r.approvedBy || !r.approvedAt) continue; // unapproved or malformed: ignored
    let hit = false;
    try { hit = r.applies(input.context) === true; } catch { hit = false; }
    if (hit) return { calendar: "founder_callback", founderReason: `rule:${r.id}` };
  }
  return AI_FOLLOW_UP;
}

export const calendarBySlug = (slug: string): CalendarId | null =>
  (CALENDARS.find((c) => CALENDAR_LABELS[c].slug === slug) ?? null);
