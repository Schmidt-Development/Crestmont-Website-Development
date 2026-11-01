// AI receptionist back end (VOICE-003..006, §52–§53). Provider-agnostic: whichever provider the
// Founder approves (docs/voice/PROVIDER-EVALUATION.md) is configured to POST signed JSON events to
// /api/webhooks/voice. Until then no provider is connected (BLK-009) and the endpoint fails closed
// unless VOICE_WEBHOOK_SECRET is set.
//
// Signature: header `x-crestmont-voice-signature: t=<unix seconds>,v1=<hex HMAC-SHA256>` over
// `${t}.${rawBody}` with VOICE_WEBHOOK_SECRET (same scheme as src/readiness/ingest.ts). A thin
// provider-specific adapter (or the provider's own custom-function feature) produces this envelope.
//
// Guardrails are enforced in code, not only in the prompt:
//  - get_published_pricing returns ONLY catalog package prices, maintenance monthly prices and the
//    payment rules. Maintenance entitlements (pending Founder approval, CAT-006) are never returned.
//  - route_support opens a ticket only for a caller matched by verified account email AND phone,
//    and the spoken response is identical whether or not a match was found (no account enumeration,
//    no customer information returned).
//  - No function exists for refunds, agreements, pricing changes, project status or delivery dates.
//  - Transcripts, summaries and recordings are stored only when recording_consent is true.
import { intake } from "./contact-identity.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { hmacSha256Hex, timingSafeEqualHex, sha256Hex } from "../lib/crypto.ts";
import { parse, v, ValidationError } from "../lib/validate.ts";
import { PACKAGES, MAINTENANCE_PLANS, APPROVED_SERVICES } from "../domain/catalog.ts";
import { audit, rateLimit } from "./security.ts";
import { effectivePrices } from "./pricing-approvals.ts";
import { addLeadNote, addLeadTask, notifyOwners, redactSensitive } from "./voice-common.ts";
import { hoursStatus, loadVoiceConfig, transferAvailability, toE164, type VoiceConfig } from "./voice-settings.ts";
import * as sched from "./voice-scheduling.ts";
import { addDnc, applyOutboundResult, recordCallConsent, requestOutbound } from "./voice-outbound.ts";
import { sendMail, type MailerCtx } from "./mailer.ts";
import { voiceBudget, budgetOpen } from "./voice-budget.ts";
import { safeHttpsUrl } from "../lib/html.ts";

export class VoiceAuthError extends Error {}

/** The eight custom functions configured on Crestmont's inbound Retell agent, in register order. */
export const INBOUND_FUNCTIONS = ["crm_customer_lookup", "crm_upsert_lead", "get_packages_pricing", "create_checkout_session",
  "check_payment_status", "schedule_consultation", "create_support_ticket", "send_customer_email"] as const;

export const CALL_OUTCOMES = ["lead_captured", "callback_requested", "support_routed", "escalated", "info_only", "abandoned", "error"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export const VOICE_FUNCTIONS = ["get_published_pricing", "create_lead", "request_callback", "route_support", "escalate",
  // Retell backend completion (migration 0042): hours, transfer, consultations, opt-out.
  "get_business_hours", "check_transfer_availability", "check_consultation_availability", "book_consultation",
  "lookup_consultation", "reschedule_consultation", "cancel_consultation", "record_opt_out",
  // Inbound receptionist register (migration 0055, docs/voice/RETELL-INBOUND-FUNCTION-REGISTER.md): the eight named
  // functions configured in Retell. They reuse the services above; none of them adds a CRM, payment, scheduling or mail path.
  ...INBOUND_FUNCTIONS] as const;
export type VoiceFunction = (typeof VOICE_FUNCTIONS)[number];

const READ_ONLY = new Set<VoiceFunction>(["get_published_pricing", "get_business_hours", "check_transfer_availability", "check_consultation_availability",
  "crm_customer_lookup", "get_packages_pricing", "check_payment_status"]);
/** Read-only answers are never replayed from storage. schedule_consultation is read-only when it only lists times. */
export function isReadOnlyCall(fn: string, args: unknown): boolean {
  if (READ_ONLY.has(fn as VoiceFunction)) return true;
  if (fn !== "schedule_consultation") return false;
  const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  return typeof a.start_time !== "string" || a.start_time.trim() === "";
}

/**
 * voice_events key marking a call that the inbound webhook answered in voicemail-only mode because the Owner's
 * monthly voice budget is unset or reached (src/services/voice-budget.ts). On such a call only these functions run.
 */
export const VOICEMAIL_MODE_EVENT = "inbound_mode:voicemail";
const VOICEMAIL_FUNCTIONS = new Set<VoiceFunction>(["request_callback", "escalate", "record_opt_out", "get_business_hours"]);

/** Optional collaborators for handleVoiceEvent. Every one has a safe default (no mail, real clock, no calendar). */
export interface VoiceDeps {
  mail?: MailerCtx;
  /** Absolute site origin for links in staff emails (escalations). Without it no escalation email is sent. */
  baseUrl?: string;
  now?: () => Date;
  calendar?: sched.CalendarAdapter;
  /** Whether Stripe (test mode on staging) is configured. create_checkout_session refuses honestly when it is not. */
  paymentsConfigured?: boolean;
}

export async function signVoiceEvent(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
}

export async function verifyVoiceSignature(secret: string | undefined, body: string, header: string | null, nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
  if (!secret) throw new VoiceAuthError("Voice webhook secret not configured");
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) throw new VoiceAuthError("Missing or malformed signature");
  if (Math.abs(nowSeconds - Number(m[1])) > 300) throw new VoiceAuthError("Signature timestamp outside tolerance");
  if (!timingSafeEqualHex(m[2], await hmacSha256Hex(secret, `${m[1]}.${body}`))) throw new VoiceAuthError("Signature mismatch");
}

const idPattern = /^[A-Za-z0-9._:-]{1,120}$/;
const phonePattern = /^[+0-9 ().-]{7,40}$/;

const envelope = v.object({
  event: v.enumOf(["call_started", "call_ended", "function_call"] as const),
  provider: v.string({ min: 2, max: 40, pattern: /^[a-z0-9_-]+$/ }),
  call_id: v.string({ pattern: idPattern }),
  event_id: v.string({ optional: true, pattern: idPattern }),
  test: v.enumOf(["true", "false"] as const, { optional: true }),
});

export interface VoiceResult { status: number; body: Record<string, unknown> }

/**
 * Published pricing facts for the receptionist. Maintenance entitlements are deliberately absent.
 * `effective` (CREST-GAP-080): Founder-approved effective prices keyed "package:<id>" / "maintenance:<id>"
 * (src/services/pricing-approvals.ts effectivePrices); without it the catalog prices are used.
 */
export function publishedPricing(effective: Record<string, number> = {}) {
  const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const pk = (id: string, catalog: number) => effective[`package:${id}`] ?? catalog;
  const mt = (id: string, catalog: number) => effective[`maintenance:${id}`] ?? catalog;
  return {
    packages: Object.values(PACKAGES).map((p) => ({
      name: p.name, price: `${dollars(pk(p.id, p.basePriceCents))}${p.priceIsFloor ? "+" : ""}`, priceCents: pk(p.id, p.basePriceCents), startingPrice: p.priceIsFloor,
      pageLimit: p.pageLimit, revisionRounds: p.revisionRounds,
    })),
    customDevelopment: "Quoted separately after a scoping conversation; no price is given by phone.",
    maintenance: Object.values(MAINTENANCE_PLANS).map((m) => ({ name: m.name, monthly: `${dollars(mt(m.id, m.monthlyCents))}/month`, monthlyCents: mt(m.id, m.monthlyCents) })),
    maintenanceNote: "Plan details are being finalised. A team member will confirm what each plan includes.",
    paymentRules: "Standard packages are paid 100% upfront. Custom development is billed 50% deposit, 25% at design approval and 25% before launch.",
    services: [...APPROVED_SERVICES],
    rules: "Quote only these figures. Do not estimate, discount, or promise delivery dates.",
  };
}

const AMOUNTS_ALLOWED = (() => {
  const s = new Set<number>();
  for (const p of Object.values(PACKAGES)) s.add(p.basePriceCents);
  for (const m of Object.values(MAINTENANCE_PLANS)) s.add(m.monthlyCents);
  return s;
})();

/** Dollar amounts in text that are not catalog prices (used to reject invented pricing in agent configs). */
export function inventedPrices(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g)) {
    const cents = Number(m[1].replace(/,/g, "")) * 100 + (m[2] ? Number(m[2]) : 0);
    if (!AMOUNTS_ALLOWED.has(cents)) out.push(m[0]);
  }
  return out;
}

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

interface CallRow { id: string; provider: string; provider_call_id: string; lead_id: string | null; recording_consent: number; is_test: number; ended_at: string | null; direction: string; from_number: string | null; to_number: string | null; outbound_request_id: string | null }
const CALL_COLS = `id, provider, provider_call_id, lead_id, recording_consent, is_test, ended_at, direction, from_number, to_number, outbound_request_id`;

export interface CallData { from?: string | null; to?: string | null; direction?: "inbound" | "outbound"; environment?: string | null; outboundRequestId?: string | null; consent?: boolean; isTest: boolean; agentVersion: number | null }

/** Creates the call row once per provider call id (any later event only fills fields that are still empty). */
export async function ensureCall(db: Db, provider: string, providerCallId: string, data: CallData): Promise<{ call: CallRow; created: boolean }> {
  const at = nowIso();
  const env = data.environment && ["development", "staging", "production"].includes(data.environment) ? data.environment : null;
  // An outbound request id is accepted only if that request really exists (it arrives in signed metadata the platform set).
  const ob = data.outboundRequestId && /^vob_[A-Za-z0-9_-]{1,60}$/.test(data.outboundRequestId)
    ? (await db.prepare(`SELECT id FROM voice_outbound_requests WHERE id = ?`).bind(data.outboundRequestId).first<{ id: string }>())?.id ?? null : null;
  const res = await db.prepare(`INSERT INTO calls (id, provider, provider_call_id, from_number, to_number, direction, recording_consent, started_at, is_test, agent_config_version, environment, outbound_request_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider, provider_call_id) DO NOTHING`)
    .bind(newId("call"), provider, providerCallId, data.from ?? null, data.to ?? null, data.direction ?? "inbound", data.consent ? 1 : 0, at, data.isTest ? 1 : 0, data.agentVersion, env, ob, at).run();
  if (res.meta.changes !== 1 && (data.from || data.to || env || ob)) {
    await db.prepare(`UPDATE calls SET from_number = COALESCE(from_number, ?), to_number = COALESCE(to_number, ?), environment = COALESCE(environment, ?), outbound_request_id = COALESCE(outbound_request_id, ?) WHERE provider = ? AND provider_call_id = ?`)
      .bind(data.from ?? null, data.to ?? null, env, ob, provider, providerCallId).run();
  }
  const call = await db.prepare(`SELECT ${CALL_COLS} FROM calls WHERE provider = ? AND provider_call_id = ?`).bind(provider, providerCallId).first<CallRow>();
  return { call: call!, created: res.meta.changes === 1 };
}

async function activeAgentVersion(db: Db): Promise<number | null> {
  return (await db.prepare(`SELECT version FROM voice_agent_configs WHERE active = 1`).first<{ version: number }>())?.version ?? null;
}

/** Claims an event key for a call. Returns the stored result when the event was already processed. */
async function claimEvent(db: Db, callId: string, key: string, kind: string): Promise<{ duplicate: true; result: Record<string, unknown> } | { duplicate: false; eventId: string }> {
  const id = newId("vev");
  const res = await db.prepare(`INSERT INTO voice_events (id, call_id, event_key, kind, status, created_at) VALUES (?,?,?,?, 'ok', ?) ON CONFLICT(call_id, event_key) DO NOTHING`)
    .bind(id, callId, key, kind, nowIso()).run();
  if (res.meta.changes === 1) return { duplicate: false, eventId: id };
  const prev = await db.prepare(`SELECT id, status, result_json FROM voice_events WHERE call_id = ? AND event_key = ?`).bind(callId, key).first<{ id: string; status: string; result_json: string | null }>();
  // A failed attempt is not an answer: the provider's retry gets a fresh attempt instead of the stored error.
  if (prev && prev.status === "error") {
    const retry = await db.prepare(`UPDATE voice_events SET status = 'ok', result_json = NULL, detail = NULL WHERE id = ? AND status = 'error'`).bind(prev.id).run();
    if (retry.meta.changes === 1) return { duplicate: false, eventId: prev.id };
  }
  return { duplicate: true, result: prev?.result_json ? JSON.parse(prev.result_json) : {} };
}

async function finishEvent(db: Db, eventId: string, status: "ok" | "error", result: Record<string, unknown>, detail?: string) {
  await db.prepare(`UPDATE voice_events SET status = ?, result_json = ?, detail = ? WHERE id = ?`).bind(status, JSON.stringify(result), detail?.slice(0, 1000) ?? null, eventId).run();
}

/** Records a provider event once per (call, key). Returns false when it was already recorded (a retry). */
export async function recordCallEvent(db: Db, callId: string, key: string, kind: string, result: Record<string, unknown>, detail?: string): Promise<boolean> {
  const claim = await claimEvent(db, callId, key.slice(0, 200), kind);
  if (claim.duplicate) return false;
  await finishEvent(db, claim.eventId, "ok", result, detail);
  return true;
}

/**
 * Creates (or reuses) the lead attached to this call so tasks and callbacks have a CRM home. Goes through the CRM
 * intake engine: a caller already in the CRM (same phone or email) continues their open lead instead of getting a
 * duplicate one (src/services/contact-identity.ts).
 */
async function createCallLead(db: Db, call: CallRow, c: { name: string; email?: string | null; phone?: string | null; company?: string | null; interest: string; message: string }): Promise<string> {
  const label = call.is_test ? "[TEST CALL] " : "";
  const res = await intake(db, { contactName: c.name, businessName: c.company ?? null, emails: c.email ? [{ value: c.email }] : [], phones: c.phone ? [{ value: c.phone }] : [] }, {
    channel: "ai_receptionist", idempotencyKey: `receptionist:${call.id}:${(await sha256Hex(c.phone ?? c.email ?? c.name)).slice(0, 16)}`, sourceRef: call.id,
    lead: { source: "ai_receptionist", interest: c.interest, message: label + c.message, isTest: !!call.is_test, activityKind: "call", activityBody: `${label}Lead captured by AI receptionist (call ${call.provider_call_id})` },
    extraStatements: (leadId) => [db.prepare(`UPDATE calls SET lead_id = COALESCE(lead_id, ?) WHERE id = ?`).bind(leadId, call.id)],
  });
  if (!res.leadId) {
    // Rejected (no usable phone/email) or held for review: keep the old behaviour of always giving the call a CRM home.
    const at = nowIso(), contactId = newId("ct"), leadId = newId("ld");
    await db.batch([
      db.prepare(`INSERT INTO contacts (id, name, email, phone, created_at) VALUES (?,?,?,?,?)`).bind(contactId, c.name, c.email ? c.email.trim().toLowerCase() : null, c.phone ?? null, at),
      db.prepare(`INSERT INTO leads (id, contact_id, source, stage, interest, message, intake_decision_id, created_at, updated_at) VALUES (?,?,'ai_receptionist','new',?,?,?,?,?)`).bind(leadId, contactId, c.interest, label + c.message, res.decisionId, at, at),
      db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'call',?,?)`).bind(newId("act"), leadId, `${label}Lead captured by AI receptionist (call ${call.provider_call_id}); ${res.outcome === "POSSIBLE_DUPLICATE_REVIEW" ? "possible duplicate, see the CRM review queue" : "no usable phone or email"}`, at),
      db.prepare(`UPDATE calls SET lead_id = COALESCE(lead_id, ?) WHERE id = ?`).bind(leadId, call.id),
    ]);
    await audit(db, { actorKind: "ai", action: "lead.created", subjectType: "lead", subjectId: leadId, details: { source: "ai_receptionist", call: call.id, test: !!call.is_test, intake: res.outcome } });
    return leadId;
  }
  if (res.leadCreated) await audit(db, { actorKind: "ai", action: "lead.created", subjectType: "lead", subjectId: res.leadId, details: { source: "ai_receptionist", call: call.id, test: !!call.is_test, intake: res.outcome } });
  return res.leadId;
}

const addTask = addLeadTask;

/** True when `phoneE164` is the number this call comes from (inbound) or was placed to (outbound). */
function isCallersOwn(call: CallRow, phoneE164: string): boolean {
  const own = toE164(call.direction === "outbound" ? call.to_number : call.from_number);
  return !!own && own === phoneE164;
}

const SUPPORT_RESPONSE = "Thank you. I've passed this to our support team. If we can match it to an existing account, they'll follow up through that account; otherwise someone will call you back during staffed hours.";

const CHECKOUT_PACKAGES = ["starter", "business", "premium"] as const;
/** The only emails the receptionist can send on request. Fixed wording (mailer.ts voice_followup / consultation). */
const EMAIL_KINDS = ["package_information", "consultation_details"] as const;

const fnSchemas = {
  get_published_pricing: v.object({}),
  create_lead: v.object({
    name: v.string({ min: 2, max: 120 }),
    email: v.email({ optional: true }),
    phone: v.string({ optional: true, pattern: phonePattern }),
    company: v.string({ optional: true, max: 160 }),
    interest: v.enumOf(["starter", "business", "premium", "custom", "maintenance", "other"] as const),
    requirements: v.string({ min: 5, max: 5000 }),
  }),
  request_callback: v.object({
    name: v.string({ min: 2, max: 120 }),
    phone: v.string({ pattern: phonePattern }),
    reason: v.string({ min: 3, max: 2000 }),
    preferred_time: v.string({ optional: true, max: 120 }),
  }),
  route_support: v.object({
    name: v.string({ min: 2, max: 120 }),
    email: v.email(),
    phone: v.string({ pattern: phonePattern }),
    summary: v.string({ min: 5, max: 4000 }),
  }),
  escalate: v.object({
    reason: v.string({ min: 3, max: 2000 }),
    name: v.string({ optional: true, max: 120 }),
    phone: v.string({ optional: true, pattern: phonePattern }),
  }),
  get_business_hours: v.object({}),
  check_transfer_availability: v.object({ department: v.enumOf(["sales", "support", "urgent"] as const, { optional: true }) }),
  check_consultation_availability: v.object({ preferred_date: v.string({ optional: true, pattern: /^\d{4}-\d{2}-\d{2}$/ }) }),
  book_consultation: v.object({
    name: v.string({ min: 2, max: 120 }),
    phone: v.string({ pattern: phonePattern }),
    email: v.email({ optional: true }),
    start_time: v.string({ min: 16, max: 40 }),
    topic: v.string({ min: 3, max: 1000 }),
    reminder_call_ok: v.enumOf(["true", "false"] as const, { optional: true }),
  }),
  lookup_consultation: v.object({ confirmation_code: v.string({ min: 4, max: 20 }), phone: v.string({ pattern: phonePattern }) }),
  reschedule_consultation: v.object({ confirmation_code: v.string({ min: 4, max: 20 }), phone: v.string({ pattern: phonePattern }), new_start_time: v.string({ min: 16, max: 40 }) }),
  cancel_consultation: v.object({ confirmation_code: v.string({ min: 4, max: 20 }), phone: v.string({ pattern: phonePattern }), reason: v.string({ optional: true, max: 500 }) }),
  record_opt_out: v.object({ phone: v.string({ optional: true, pattern: phonePattern }) }),
  // ── Inbound register (INBOUND_FUNCTIONS) ──
  crm_customer_lookup: v.object({
    name: v.string({ optional: true, max: 120 }),
    email: v.email({ optional: true }),
    phone: v.string({ optional: true, pattern: phonePattern }),
  }),
  crm_upsert_lead: v.object({
    name: v.string({ min: 2, max: 120 }),
    email: v.email({ optional: true }),
    phone: v.string({ optional: true, pattern: phonePattern }),
    company: v.string({ optional: true, max: 160 }),
    interest: v.enumOf(["starter", "business", "premium", "custom", "maintenance", "other"] as const),
    requirements: v.string({ min: 5, max: 5000 }),
  }),
  get_packages_pricing: v.object({}),
  create_checkout_session: v.object({
    package: v.enumOf(CHECKOUT_PACKAGES),
    name: v.string({ min: 2, max: 120 }),
    email: v.email(),
  }),
  check_payment_status: v.object({
    checkout_reference: v.string({ min: 4, max: 20 }),
    email: v.email(),
  }),
  schedule_consultation: v.object({
    name: v.string({ optional: true, min: 2, max: 120 }),
    phone: v.string({ optional: true, pattern: phonePattern }),
    email: v.email({ optional: true }),
    topic: v.string({ optional: true, min: 3, max: 1000 }),
    start_time: v.string({ optional: true, max: 40 }),
    preferred_date: v.string({ optional: true, pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    reminder_call_ok: v.enumOf(["true", "false"] as const, { optional: true }),
  }),
  create_support_ticket: v.object({
    name: v.string({ min: 2, max: 120 }),
    email: v.email(),
    phone: v.string({ pattern: phonePattern }),
    summary: v.string({ min: 5, max: 4000 }),
  }),
  send_customer_email: v.object({
    template: v.enumOf(EMAIL_KINDS),
    name: v.string({ min: 2, max: 120 }),
    email: v.email(),
    confirmation_code: v.string({ optional: true, min: 4, max: 20 }),
  }),
};

/** Emails per call (checkout links + send_customer_email together) and per recipient address per day. */
export const MAX_EMAILS_PER_CALL = 3;
export const MAX_EMAILS_PER_RECIPIENT_PER_DAY = 3;
const NOT_VERIFIED_PAYMENT = { verified: false, message: "I couldn't match that checkout reference and email. Please check the reference in the email we sent, or I can ask a team member to follow up." };

const refCode = () => sched.newConfirmationCode();

/** Mail is counted only when it was actually handed to the mail pipeline on this call. */
async function emailsSentOnCall(db: Db, call: CallRow): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM voice_events WHERE call_id = ? AND kind IN ('fn:create_checkout_session','fn:send_customer_email') AND status = 'ok' AND result_json LIKE '%"email_sent":true%'`)
    .bind(call.id).first<{ n: number }>())!.n;
}

/**
 * Shared gate for every email the receptionist sends on a caller's request: needs the mail pipeline, the per-call cap
 * and the per-recipient daily cap (rate_limits). The staging recipient allowlist and suppressions are applied by the
 * email adapter itself, so an address outside the allowlist is recorded in the outbox and never sent.
 */
async function emailGate(db: Db, call: CallRow, deps: VoiceDeps, to: string): Promise<null | Record<string, unknown>> {
  if (!deps.mail || !deps.baseUrl) return { email_sent: false, reason: "email_unavailable", message: "I can't send emails right now. I can ask a team member to follow up instead." };
  if (await emailsSentOnCall(db, call) >= MAX_EMAILS_PER_CALL) return { email_sent: false, reason: "call_limit", message: "I've already sent the emails I can on this call. A team member can send anything else." };
  const rl = await rateLimit(db, `voice-email:${to.trim().toLowerCase()}`, MAX_EMAILS_PER_RECIPIENT_PER_DAY, 86_400);
  if (!rl.allowed) return { email_sent: false, reason: "recipient_limit", message: "That address has already received several emails from us today. A team member can follow up instead." };
  return null;
}

const mailOutcome = (status: string) => status === "sent" || status === "queued" || status === "duplicate"
  ? { email_sent: true, email_status: status }
  : { email_sent: false, email_status: status };

/** Same answer for every unverified booking request: never reveals whether a booking exists. */
const NOT_VERIFIED = { verified: false, message: "I couldn't find an upcoming consultation with that reference and phone number. I can ask a team member to call you back." };
const MAX_VERIFY_FAILURES = 3;

async function verifyFailures(db: Db, call: CallRow): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM voice_events WHERE call_id = ? AND kind IN ('fn:lookup_consultation','fn:reschedule_consultation','fn:cancel_consultation') AND result_json LIKE '%"verified":false%'`)
    .bind(call.id).first<{ n: number }>())!.n;
}

async function mailConsultation(deps: VoiceDeps, row: sched.ConsultationRow, event: "requested" | "confirmed" | "rescheduled" | "cancelled"): Promise<void> {
  if (!deps.mail || !row.email) return;
  try {
    await sendMail(deps.mail, { template: "consultation", to: row.email, idempotencyKey: `consultation:${row.id}:${event}`,
      data: { event, name: row.name, when: sched.labelOf(row), code: row.confirmation_code } });
  } catch { /* delivery problems are recorded by the mail adapter; never fail the caller's booking */ }
}

async function isVoicemailCall(db: Db, call: CallRow): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 FROM voice_events WHERE call_id = ? AND event_key = ?`).bind(call.id, VOICEMAIL_MODE_EVENT).first());
}

/** Emails every active Owner about an escalation (voice_escalation template). Returns how many were sent. */
async function emailOwnersEscalation(db: Db, deps: VoiceDeps, call: CallRow, e: { reason: string; caller: string; transfer: string }): Promise<number> {
  if (!deps.mail || !deps.baseUrl) return 0;
  const owners = (await db.prepare(`SELECT DISTINCT u.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id = 'owner' AND u.disabled_at IS NULL AND u.email IS NOT NULL`).all<{ id: string; email: string }>()).results;
  const ref = newId("vesc");
  let sent = 0;
  for (const o of owners) {
    try {
      await sendMail(deps.mail, { template: "voice_escalation", to: o.email, idempotencyKey: `voice_escalation:${call.id}:${o.id}:${ref}`,
        data: { reason: e.reason.slice(0, 500), caller: e.caller.slice(0, 200), test: !!call.is_test,
          why: e.transfer === "closed" ? "outside_hours" : e.transfer === "not_configured" ? "no_transfer" : "unavailable",
          url: `${deps.baseUrl}/staff/voice/calls/${call.id}` } });
      sent++;
    } catch { /* delivery problems are recorded by the mail adapter; the task and in-app alert already exist */ }
  }
  return sent;
}

/** Every string argument is redacted (card numbers, SSNs) before validation and storage. */
function redactArgs(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, val]) => [k, typeof val === "string" ? redactSensitive(val) : typeof val === "boolean" ? String(val) : val]));
}

/**
 * Support intake shared by route_support and create_support_ticket. A ticket is opened only for a verified account
 * email AND a phone on that user's CRM contact; otherwise a CRM callback task is created. The response, including the
 * shape of the spoken reference (SR-XXXXXX), is identical in both branches, so it never reveals whether an account exists.
 */
async function supportRequest(db: Db, call: CallRow, a: { name: string; email: string; phone: string; summary: string }, withRef: boolean): Promise<Record<string, unknown>> {
  // route_support keeps its original byte-identical answer (no reference); create_support_ticket adds one.
  const ref = withRef ? `SR-${refCode()}` : null;
  // Match only on a verified account email AND a phone recorded on that user's CRM contact.
  const user = await db.prepare(`SELECT u.id FROM users u WHERE u.email = ? AND u.email_verified_at IS NOT NULL AND u.disabled_at IS NULL`).bind(a.email.trim().toLowerCase()).first<{ id: string }>();
  let orgId: string | null = null;
  if (user) {
    const phones = (await db.prepare(`SELECT phone FROM contacts WHERE user_id = ? AND phone IS NOT NULL`).bind(user.id).all<{ phone: string }>()).results;
    const phoneOk = phones.some((p) => digits(p.phone).length >= 7 && digits(p.phone) === digits(a.phone));
    if (phoneOk) {
      orgId = (await db.prepare(`SELECT m.organization_id FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? AND o.kind = 'customer' ORDER BY m.created_at LIMIT 1`).bind(user.id).first<{ organization_id: string }>())?.organization_id ?? null;
    }
  }
  if (user && orgId) {
    const at = nowIso(), ticketId = newId("tkt");
    await db.batch([
      db.prepare(`INSERT INTO tickets (id, organization_id, subject, category, priority, status, opened_by, created_at, updated_at, voice_request_ref) VALUES (?,?,?, 'other', 'normal', 'open', ?, ?, ?, ?)`)
        .bind(ticketId, orgId, `${call.is_test ? "[TEST CALL] " : ""}Phone support request${ref ? ` ${ref}` : ""}`, user.id, at, at, ref),
      db.prepare(`INSERT INTO ticket_messages (id, ticket_id, author_user_id, body, internal, created_at) VALUES (?,?,NULL,?,0,?)`)
        .bind(newId("tm"), ticketId, `Received by the AI receptionist (call ${call.provider_call_id}). Caller's description: ${a.summary}`, at),
      db.prepare(`UPDATE calls SET outcome = COALESCE(outcome, 'support_routed') WHERE id = ?`).bind(call.id),
    ]);
    await audit(db, { actorKind: "ai", action: "ticket.created_by_receptionist", subjectType: "ticket", subjectId: ticketId, organizationId: orgId, details: { call: call.id, ...(ref ? { ref } : {}) } });
  } else {
    const leadId = call.lead_id ?? await createCallLead(db, call, { name: a.name, email: a.email, phone: a.phone, interest: "other", message: `Support callback (caller not matched to an account): ${a.summary}` });
    await addTask(db, leadId, `Support callback${ref ? ` ${ref}` : ""} for ${a.name} at ${a.phone}. Caller could not be matched to an account by verified email and phone — verify identity before discussing any account details.`);
  }
  // Identical response in both branches: never confirms whether an account exists.
  if (!ref) return { received: true, message: SUPPORT_RESPONSE };
  return { received: true, request_reference: ref, message: `${SUPPORT_RESPONSE} Your request reference is ${ref.split("").join(" ")}.` };
}

async function paymentVerifyFailures(db: Db, call: CallRow): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM voice_events WHERE call_id = ? AND kind = 'fn:check_payment_status' AND result_json LIKE '%"verified":false%'`)
    .bind(call.id).first<{ n: number }>())!.n;
}

async function runFunction(db: Db, call: CallRow, name: VoiceFunction, rawArgsIn: unknown, deps: VoiceDeps): Promise<Record<string, unknown>> {
  const rawArgs = redactArgs(rawArgsIn);
  const now = deps.now?.() ?? new Date();
  let cfgCache: VoiceConfig | null = null;
  const cfg = async () => (cfgCache ??= await loadVoiceConfig(db));
  const cal = deps.calendar ?? sched.NO_CALENDAR;
  switch (name) {
    case "get_published_pricing":
      return { pricing: publishedPricing(await effectivePrices(db)) }; // CREST-GAP-080
    case "create_lead":
    case "crm_upsert_lead": {
      // crm_upsert_lead is create_lead under its register name: the CRM intake engine (contact-identity.ts) matches an
      // existing contact by phone or email and continues their open lead instead of creating a duplicate. The answer is
      // the same whether a record was matched or created, so it never reveals that the caller is already known.
      const a = parse(fnSchemas[name] as typeof fnSchemas.create_lead, rawArgs ?? {});
      if (!a.email && !a.phone) throw new ValidationError(["email or phone is required"]);
      if (call.lead_id) {
        await db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'call',?,?)`).bind(newId("act"), call.lead_id, `Additional requirements from caller: ${a.requirements}`.slice(0, 4000), nowIso()).run();
        return name === "crm_upsert_lead" ? { lead_saved: true, message: "Thanks, I've added that to your request." } : { leadCreated: false, message: "Thanks, I've added that to your request." };
      }
      await createCallLead(db, call, { name: a.name, email: a.email, phone: a.phone, company: a.company, interest: a.interest, message: a.requirements });
      const msg = "Thank you. A Crestmont team member will follow up. I can't confirm prices beyond our published packages or commit to dates.";
      return name === "crm_upsert_lead" ? { lead_saved: true, message: msg } : { leadCreated: true, message: msg };
    }
    case "request_callback": {
      const a = parse(fnSchemas.request_callback, rawArgs ?? {});
      const leadId = call.lead_id ?? await createCallLead(db, call, { name: a.name, phone: a.phone, interest: "other", message: `Callback requested: ${a.reason}` });
      await addTask(db, leadId, `Call back ${a.name} at ${a.phone}${a.preferred_time ? ` (preferred: ${a.preferred_time})` : ""}: ${a.reason}`);
      // The caller asked to be called back: that request is the consent, scoped to the callback purpose only.
      // The outbound request still waits for staff approval, and outbound calling is off by default.
      // Consent counts only for the number the caller is actually calling from: a caller cannot consent for someone else.
      const phone = toE164(a.phone);
      if (phone && isCallersOwn(call, phone) && await recordCallConsent(db, phone, "callback", "caller_request", `call:${call.id}`)) {
        await requestOutbound(db, { purpose: "callback", phone, name: a.name, reason: `Caller asked for a callback${a.preferred_time ? ` (preferred: ${a.preferred_time})` : ""}: ${a.reason}`, leadId, isTest: !!call.is_test });
      }
      return { callbackRequested: true, message: "Thanks. Someone will call you back during staffed hours." };
    }
    case "route_support":
    case "create_support_ticket": {
      const a = parse(fnSchemas[name] as typeof fnSchemas.route_support, rawArgs ?? {});
      return supportRequest(db, call, a, name === "create_support_ticket");
    }
    case "escalate": {
      const a = parse(fnSchemas.escalate, rawArgs ?? {});
      await db.prepare(`UPDATE calls SET escalated_at = COALESCE(escalated_at, ?) WHERE id = ?`).bind(nowIso(), call.id).run();
      const tag = call.is_test ? "[TEST] " : "";
      // Staffed hours + Founder-approved transfer number + normal (in-budget) mode → live transfer. The number itself
      // is never returned to the model: Retell's transfer tool dials {{transfer_number}} from the inbound webhook.
      // A transfer that does not connect (transfer_cancelled) becomes a callback task and an Owner alert (adapter).
      const t = transferAvailability(await cfg(), now);
      if (call.direction === "inbound" && t.available && !(await isVoicemailCall(db, call))) {
        if (call.lead_id) await addLeadNote(db, call.lead_id, `Escalated and transferred live: ${a.reason}`);
        await notifyOwners(db, "voice_escalation", `${tag}AI receptionist is transferring a caller to the team now: ${a.reason}`, "call", call.id);
        await audit(db, { actorKind: "ai", action: "call.escalated", subjectType: "call", subjectId: call.id, details: { route: "transfer" } });
        return { escalated: true, transfer: true, transfer_available: true,
          message: "A team member is available. Tell the caller you are transferring them now, then use the transfer tool." };
      }
      // Otherwise: a CRM task (always, so nothing is lost) and an email to every Owner.
      const leadId = call.lead_id ?? await createCallLead(db, call, { name: a.name ?? "Unknown caller", phone: a.phone ?? call.from_number, interest: "other", message: `Escalated call: ${a.reason}` });
      await addTask(db, leadId, `ESCALATION from AI receptionist: ${a.reason}${a.phone ?? call.from_number ? ` — call back ${a.phone ?? call.from_number}` : ""}`, 4);
      await notifyOwners(db, "voice_escalation", `${tag}AI receptionist escalated a call: ${a.reason}`, "call", call.id);
      const emailed = await emailOwnersEscalation(db, deps, call, { reason: a.reason, caller: [a.name, a.phone ?? call.from_number].filter(Boolean).join(", ") || "Unknown caller", transfer: t.reason });
      await audit(db, { actorKind: "ai", action: "call.escalated", subjectType: "call", subjectId: call.id, details: { route: "task_email", emailed, transfer: t.reason } });
      return { escalated: true, transfer: false, transfer_available: false, message: "I'm passing this to a member of the Crestmont team who will follow up during staffed hours." };
    }
    case "get_business_hours": {
      parse(fnSchemas.get_business_hours, rawArgs ?? {});
      const c = await cfg();
      const h = hoursStatus(c, now);
      if (!h.configured) return { configured: false, open_now: false, hours: h.summary, message: "Our business hours aren't published yet. I can take your details and have someone call you back." };
      return { configured: true, open_now: h.open, hours: h.summary, next_open: h.nextOpenAt && h.timezone ? new Intl.DateTimeFormat("en-US", { timeZone: h.timezone, weekday: "long", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(h.nextOpenAt)) : null };
    }
    case "check_transfer_availability": {
      parse(fnSchemas.check_transfer_availability, rawArgs ?? {});
      const t = transferAvailability(await cfg(), now);
      // The destination number is never given to the model: Retell's transfer tool reads {{transfer_number}},
      // which the inbound webhook supplies only when a Founder-approved number is configured.
      return t.available
        ? { transfer_available: true, message: "A team member may be available. Let the caller know you are transferring them now." }
        : { transfer_available: false, reason: t.reason, message: "Nobody is available to take the call live right now. Offer to take a message with request_callback." };
    }
    case "check_consultation_availability": {
      const a = parse(fnSchemas.check_consultation_availability, rawArgs ?? {});
      const av = await sched.availability(db, await cfg(), now, cal, { fromDate: a.preferred_date });
      if (!av.available) {
        return { available: false, reason: av.reason, message: av.reason === "no_slots" ? "There are no open consultation times in the booking window. Offer to take a callback request." : "I can't book consultations by phone right now. Offer to take a callback request." };
      }
      return { available: true, timezone: av.timezone, slots: av.slots.map((x) => ({ start_time: x.startsAt, label: x.label })),
        message: "Offer these times exactly as labelled. When the caller chooses one, call book_consultation with its start_time." };
    }
    case "book_consultation": {
      const a = parse(fnSchemas.book_consultation, rawArgs ?? {});
      const c = await cfg();
      const phone = toE164(a.phone) ?? a.phone;
      if (!c.scheduling.enabled || !c.timezone) return { booked: false, reason: "scheduling_disabled", message: "I can't book consultations by phone right now. Offer to take a callback request." };
      try {
        // Only the caller's own number is checked for an existing booking: saying "you already have one" for any
        // other number would reveal whether that number has a booking.
        const { booking, existing } = await sched.book(db, c, now, cal, { name: a.name, phone, email: a.email ?? null, startsAt: a.start_time, topic: a.topic, leadId: call.lead_id, callId: call.id, isTest: !!call.is_test, source: "ai_receptionist", checkExisting: isCallersOwn(call, phone) });
        if (existing) return { booked: false, already_booked: true, message: "You already have an upcoming consultation with us. I can reschedule or cancel it if you give me your booking reference." };
        const leadId = call.lead_id ?? await createCallLead(db, call, { name: a.name, email: a.email, phone, interest: "other", message: `Consultation requested by phone: ${a.topic}` });
        await db.prepare(`UPDATE consultations SET lead_id = COALESCE(lead_id, ?) WHERE id = ?`).bind(leadId, booking.id).run();
        await addLeadNote(db, leadId, `Consultation ${booking.status} for ${sched.labelOf(booking)} (ref ${booking.confirmation_code}) via AI receptionist`);
        if (booking.status === "requested") await addLeadTask(db, leadId, `Confirm or decline the consultation requested for ${sched.labelOf(booking)} (ref ${booking.confirmation_code}). Check your calendar first: no calendar is connected.`, 4);
        await notifyOwners(db, "voice_consultation", `${call.is_test ? "[TEST] " : ""}Consultation ${booking.status} by phone: ${a.name}, ${sched.labelOf(booking)}`, "consultation", booking.id);
        if (a.reminder_call_ok === "true" && isCallersOwn(call, phone)) await recordCallConsent(db, phone, "consultation_reminder", "caller_request", `call:${call.id}`);
        await mailConsultation(deps, booking, booking.status === "confirmed" ? "confirmed" : "requested");
        return { booked: true, status: booking.status, when: sched.labelOf(booking), confirmation_code: booking.confirmation_code,
          message: booking.status === "confirmed"
            ? `The consultation is booked for ${sched.labelOf(booking)}. Read the booking reference to the caller letter by letter.`
            : `The time is held for the caller. A team member will confirm it${booking.email ? " by email" : ""}. Read the booking reference to the caller letter by letter.` };
      } catch (e) {
        if (!(e instanceof sched.SlotUnavailableError)) throw e;
        const alt = await sched.availability(db, c, now, cal);
        return { booked: false, reason: e.message, slots: alt.available ? alt.slots.map((x) => ({ start_time: x.startsAt, label: x.label })) : [],
          message: alt.available ? "That time isn't available. Offer one of these instead." : "That time isn't available and nothing else is open. Offer a callback." };
      }
    }
    case "lookup_consultation":
    case "reschedule_consultation":
    case "cancel_consultation": {
      if (await verifyFailures(db, call) >= MAX_VERIFY_FAILURES) return { verified: false, locked: true, message: "I can't look that up on this call. I can ask a team member to call you back." };
      const a = parse(fnSchemas[name] as typeof fnSchemas.reschedule_consultation, rawArgs ?? {}) as { confirmation_code: string; phone: string; new_start_time?: string; reason?: string };
      const row = await sched.findVerified(db, a.confirmation_code, a.phone);
      if (!row) return NOT_VERIFIED;
      if (name === "lookup_consultation") return { verified: true, when: sched.labelOf(row), status: row.status === "confirmed" ? "confirmed" : "awaiting confirmation" };
      if (name === "cancel_consultation") {
        await sched.cancel(db, row, a.reason ?? "Cancelled by caller", { kind: "ai" });
        if (row.lead_id) await addLeadNote(db, row.lead_id, `Consultation ${sched.labelOf(row)} cancelled by caller via AI receptionist`);
        await notifyOwners(db, "voice_consultation", `${call.is_test ? "[TEST] " : ""}Consultation cancelled by phone: ${row.name}, ${sched.labelOf(row)}`, "consultation", row.id);
        await mailConsultation(deps, row, "cancelled");
        return { verified: true, cancelled: true, message: "The consultation is cancelled." };
      }
      const c = await cfg();
      try {
        const next = await sched.reschedule(db, c, now, cal, row, a.new_start_time!, { kind: "ai" });
        if (row.lead_id) {
          await addLeadNote(db, row.lead_id, `Consultation moved from ${sched.labelOf(row)} to ${sched.labelOf(next)} (new ref ${next.confirmation_code}) via AI receptionist`);
          if (next.status === "requested") await addLeadTask(db, row.lead_id, `Confirm the rescheduled consultation ${sched.labelOf(next)} (ref ${next.confirmation_code}).`, 4);
        }
        await notifyOwners(db, "voice_consultation", `${call.is_test ? "[TEST] " : ""}Consultation rescheduled by phone: ${row.name}, now ${sched.labelOf(next)}`, "consultation", next.id);
        await mailConsultation(deps, next, "rescheduled");
        return { verified: true, rescheduled: true, when: sched.labelOf(next), confirmation_code: next.confirmation_code, status: next.status,
          message: "The consultation has moved. Read the NEW booking reference to the caller letter by letter." };
      } catch (e) {
        if (!(e instanceof sched.SlotUnavailableError)) throw e;
        const alt = await sched.availability(db, c, now, cal, { exceptId: row.id });
        return { verified: true, rescheduled: false, reason: e.message, slots: alt.available ? alt.slots.map((x) => ({ start_time: x.startsAt, label: x.label })) : [],
          message: "That time isn't available. The original booking is unchanged." };
      }
    }
    // ───── Inbound register functions (INBOUND_FUNCTIONS) ─────
    case "crm_customer_lookup": {
      // Guardrail 6 (VOICE_GUARDRAILS): a name, email or phone given on a call is not identity verification, so this
      // function never queries customer records and never says whether a person or account exists. Same answer for
      // every input; it tells the agent which function to use next. A verified lookup needs a Founder-approved method
      // (RETELL-BACKEND-REPORT.md §4 item 7, e.g. a one-time code sent to the account email).
      parse(fnSchemas.crm_customer_lookup, rawArgs ?? {});
      return { identity_verified: false, account_details_available: false, details_captured_this_call: !!call.lead_id,
        next_step: "For an existing customer's issue use create_support_ticket. For a new project or enquiry use crm_upsert_lead.",
        message: "For privacy I can't look up or confirm account details by phone. I can pass your request to the team, who will follow up through your account." };
    }
    case "get_packages_pricing": {
      parse(fnSchemas.get_packages_pricing, rawArgs ?? {});
      const pricing = publishedPricing(await effectivePrices(db));
      const purchasable = Object.values(MAINTENANCE_PLANS).filter((m) => m.entitlementsStatus === "approved").map((m) => m.name);
      return { pricing: { ...pricing,
        maintenancePurchasableOnline: purchasable,
        addOns: [], addOnsNote: "No add-ons are approved for sale. Anything beyond a package's scope is quoted separately by a person.",
        checkoutPackages: CHECKOUT_PACKAGES.map((id) => PACKAGES[id].name) } };
    }
    case "create_checkout_session": {
      const a = parse(fnSchemas.create_checkout_session, rawArgs ?? {});
      if (!deps.paymentsConfigured) return { link_sent: false, email_sent: false, reason: "payments_not_configured", message: "Online payment isn't available right now. I can ask a team member to follow up about payment options." };
      const email = a.email.trim().toLowerCase();
      const pkg = PACKAGES[a.package];
      // A repeat request for the same package and address on this call reuses the first link (and its reference).
      const prior = await db.prepare(`SELECT reference FROM voice_checkout_links WHERE call_id = ? AND package_id = ? AND email = ?`).bind(call.id, pkg.id, email).first<{ reference: string }>();
      if (prior) return { link_sent: true, email_sent: true, already_sent: true, package: pkg.name, message: "I've already sent that secure link to this email on this call." };
      const gate = await emailGate(db, call, deps, email);
      if (gate) return { link_sent: false, ...gate };
      const price = publishedPricing(await effectivePrices(db)).packages.find((p) => p.name === pkg.name)!.price;
      const leadId = call.lead_id ?? await createCallLead(db, call, { name: a.name, email, phone: call.from_number, interest: pkg.id, message: `Asked the AI receptionist for a secure checkout link for the ${pkg.name} package.` });
      const reference = refCode();
      await db.prepare(`INSERT INTO voice_checkout_links (id, call_id, reference, package_id, email, lead_id, is_test, created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(newId("vck"), call.id, reference, pkg.id, email, leadId, call.is_test, nowIso()).run();
      const url = `${deps.baseUrl}/checkout/${pkg.id}`;
      let status = "failed";
      try {
        status = (await sendMail(deps.mail!, { template: "voice_followup", to: email, idempotencyKey: `voice_checkout:${call.id}:${pkg.id}:${email}`,
          data: { kind: "checkout_link", name: a.name, packageName: pkg.name, price, reference, url } })).status;
      } catch { /* recorded by the mail adapter */ }
      await addLeadNote(db, leadId, `AI receptionist emailed a secure ${pkg.name} checkout link (reference ${reference}, mail ${status}). Nothing is charged until the customer completes Stripe Checkout online.`);
      await audit(db, { actorKind: "ai", action: "voice.checkout_link_sent", subjectType: "lead", subjectId: leadId, details: { call: call.id, package: pkg.id, mail: status } });
      const out = mailOutcome(status);
      // The reference is deliberately NOT returned: it is only in the email, so check_payment_status proves the caller can read that inbox.
      return { link_sent: out.email_sent, ...out, package: pkg.name, price,
        message: out.email_sent
          ? `I've emailed a secure link to buy the ${pkg.name} package. It opens our website, where you sign in, review the agreements and pay through Stripe. I never take card details by phone.`
          : "I couldn't send an email to that address. I can ask a team member to follow up instead." };
    }
    case "check_payment_status": {
      if (await paymentVerifyFailures(db, call) >= MAX_VERIFY_FAILURES) return { verified: false, locked: true, message: "I can't check that on this call. I can ask a team member to follow up." };
      const a = parse(fnSchemas.check_payment_status, rawArgs ?? {});
      const link = await db.prepare(`SELECT package_id, email, created_at FROM voice_checkout_links WHERE reference = ? AND email = ?`)
        .bind(sched.normaliseCode(a.checkout_reference), a.email.trim().toLowerCase()).first<{ package_id: string; email: string; created_at: string }>();
      if (!link) return NOT_VERIFIED_PAYMENT;
      // Authoritative state: invoices.status becomes 'paid' only from a signature-verified Stripe webhook
      // (src/services/payments.ts); checkout itself never marks anything paid. Only the package and address behind
      // this reference are consulted, and only from the moment the link was sent.
      const inv = await db.prepare(`SELECT i.status, i.stripe_checkout_session_id FROM invoices i JOIN orders o ON o.id = i.order_id
          JOIN memberships m ON m.organization_id = i.organization_id JOIN users u ON u.id = m.user_id
          WHERE lower(u.email) = ? AND o.kind = 'package' AND o.product_id = ? AND i.created_at >= ? AND i.status IN ('open','paid')
          ORDER BY CASE i.status WHEN 'paid' THEN 0 ELSE 1 END, i.created_at DESC LIMIT 1`)
        .bind(link.email, link.package_id, link.created_at).first<{ status: string; stripe_checkout_session_id: string | null }>();
      const pkgName = PACKAGES[link.package_id as keyof typeof PACKAGES].name;
      if (inv?.status === "paid") return { verified: true, payment_status: "paid", package: pkgName, message: `Payment for the ${pkgName} package is confirmed. A receipt has been emailed and the team will be in touch about next steps.` };
      if (inv?.stripe_checkout_session_id) return { verified: true, payment_status: "checkout_started_not_paid", package: pkgName, message: "Checkout was started but we haven't received a confirmed payment yet. Stripe confirmations can take a few minutes." };
      return { verified: true, payment_status: "not_started", package: pkgName, message: "We haven't received a payment for that link yet. The link in the email is still the way to pay." };
    }
    case "schedule_consultation": {
      // One function for Retell, two existing steps: without start_time it lists real open slots
      // (check_consultation_availability); with start_time it books through voice-scheduling.ts, where the database
      // allows only one active booking per start time, so a slot can never be double-booked.
      const a = parse(fnSchemas.schedule_consultation, rawArgs ?? {});
      if (!a.start_time) {
        const r = await runFunction(db, call, "check_consultation_availability", { ...(a.preferred_date ? { preferred_date: a.preferred_date } : {}) }, deps);
        return { step: "availability", ...r };
      }
      const missing = (["name", "phone", "topic"] as const).filter((k) => !a[k]);
      if (missing.length) throw new ValidationError(missing.map((k) => `${k} is required to book`));
      const r = await runFunction(db, call, "book_consultation", { name: a.name, phone: a.phone, email: a.email, start_time: a.start_time, topic: a.topic, reminder_call_ok: a.reminder_call_ok }, deps);
      return { step: "booking", ...r };
    }
    case "send_customer_email": {
      const a = parse(fnSchemas.send_customer_email, rawArgs ?? {});
      const email = a.email.trim().toLowerCase();
      if (a.template === "consultation_details") {
        // Only a booking made on THIS call can be re-sent, and only by its reference: never another caller's booking.
        if (!a.confirmation_code) throw new ValidationError(["confirmation_code is required for consultation_details"]);
        const row = await db.prepare(`SELECT * FROM consultations WHERE call_id = ? AND confirmation_code = ? AND status IN ('requested','confirmed')`)
          .bind(call.id, sched.normaliseCode(a.confirmation_code)).first<sched.ConsultationRow>();
        if (!row) return { email_sent: false, reason: "not_found", message: "I can only re-send details of a consultation booked on this call. I can ask a team member to help." };
        const gate = await emailGate(db, call, deps, email);
        if (gate) return gate;
        let status = "failed";
        try {
          status = (await sendMail(deps.mail!, { template: "consultation", to: email, idempotencyKey: `voice_resend:${row.id}:${email}`,
            data: { event: row.status === "confirmed" ? "confirmed" : "requested", name: row.name, when: sched.labelOf(row), code: row.confirmation_code } })).status;
        } catch { /* recorded by the mail adapter */ }
        const out = mailOutcome(status);
        return { ...out, template: a.template, message: out.email_sent ? "I've emailed the consultation details." : "I couldn't send an email to that address. I can ask a team member to follow up instead." };
      }
      const gate = await emailGate(db, call, deps, email);
      if (gate) return gate;
      const pricing = publishedPricing(await effectivePrices(db));
      let status = "failed";
      try {
        status = (await sendMail(deps.mail!, { template: "voice_followup", to: email, idempotencyKey: `voice_pricing:${call.id}:${email}`,
          data: { kind: "package_information", name: a.name, packages: pricing.packages.map((p) => ({ name: p.name, price: p.price })), maintenance: pricing.maintenance.map((m) => ({ name: m.name, monthly: m.monthly })), url: `${deps.baseUrl}/pricing` } })).status;
      } catch { /* recorded by the mail adapter */ }
      if (call.lead_id) await addLeadNote(db, call.lead_id, `AI receptionist emailed published package prices at the caller's request (mail ${status}).`);
      const out = mailOutcome(status);
      return { ...out, template: a.template, message: out.email_sent ? "I've emailed our published package prices." : "I couldn't send an email to that address. I can ask a team member to follow up instead." };
    }
    case "record_opt_out": {
      const a = parse(fnSchemas.record_opt_out, rawArgs ?? {});
      const phone = toE164(a.phone ?? call.from_number);
      if (phone) await addDnc(db, phone, "caller_request", `Requested on call ${call.id}`);
      return { recorded: true, message: "Understood. We won't call this number again." };
    }
  }
}

/** Handles one verified webhook event. The caller has already checked the signature. */
export async function handleVoiceEvent(db: Db, rawBody: string, deps: VoiceDeps = {}): Promise<VoiceResult> {
  const json = JSON.parse(rawBody) as Record<string, unknown>;
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new ValidationError(["Event body must be a JSON object"]);
  const base = parse(envelope, { ...json, test: json.test === undefined ? undefined : String(json.test) });
  const isTest = base.test === "true";
  const consent = json.recording_consent === true;
  const phoneOf = (k: string) => (typeof json[k] === "string" && phonePattern.test(json[k] as string) ? json[k] as string : null);
  const from = phoneOf("from_number");
  const direction = json.direction === "outbound" ? "outbound" : "inbound";
  const { call } = await ensureCall(db, base.provider, base.call_id, {
    from, to: phoneOf("to_number"), direction, environment: typeof json.environment === "string" ? json.environment : null,
    outboundRequestId: typeof json.outbound_request_id === "string" ? json.outbound_request_id : null,
    consent, isTest, agentVersion: await activeAgentVersion(db),
  });

  if (base.event === "call_started") {
    const claim = await claimEvent(db, call.id, "call_started", "call_started");
    if (claim.duplicate) return { status: 200, body: { ok: true, duplicate: true, callId: call.id } };
    // A later call_started can only grant consent, never silently revoke an earlier recorded one.
    if (consent) await db.prepare(`UPDATE calls SET recording_consent = 1 WHERE id = ?`).bind(call.id).run();
    await finishEvent(db, claim.eventId, "ok", { callId: call.id });
    return { status: 200, body: { ok: true, callId: call.id } };
  }

  if (base.event === "call_ended") {
    const claim = await claimEvent(db, call.id, "call_ended", "call_ended");
    if (claim.duplicate) return { status: 200, body: { ok: true, duplicate: true, callId: call.id } };
    const outcome = parse(v.enumOf(CALL_OUTCOMES), json.outcome);
    const consentNow = consent || call.recording_consent === 1;
    const cost = typeof json.cost_microusd === "number" && Number.isInteger(json.cost_microusd) && json.cost_microusd >= 0 ? json.cost_microusd : null;
    const str = (k: string, max: number) => (typeof json[k] === "string" ? (json[k] as string).slice(0, max) : null);
    const recording = str("recording_url", 500);
    const keep = consentNow;
    const discarded = !keep && (json.transcript || json.recording_url || json.summary) ? "transcript/recording/summary discarded: no recording consent" : undefined;
    const duration = typeof json.duration_ms === "number" && Number.isInteger(json.duration_ms) && json.duration_ms >= 0 ? json.duration_ms : null;
    const reason = typeof json.disconnection_reason === "string" && /^[a-z_]{1,60}$/.test(json.disconnection_reason) ? json.disconnection_reason : null;
    const text = (k: string, max: number) => { const t = str(k, max); return t === null ? null : redactSensitive(t); };
    await db.prepare(`UPDATE calls SET outcome = ?, ended_at = ?, cost_microusd = ?, recording_consent = ?, transcript = ?, recording_url = ?, summary = ?, error = ?, duration_ms = COALESCE(?, duration_ms), disconnection_reason = COALESCE(?, disconnection_reason) WHERE id = ?`)
      .bind(outcome, nowIso(), cost, consentNow ? 1 : 0,
        keep ? text("transcript", 100_000) : null,
        // Provider-supplied link: stored only when it is a well-formed https URL (CREST-GAP-100; rendering re-checks).
        keep && recording && safeHttpsUrl(recording) !== "#" ? recording : null,
        keep ? text("summary", 4000) : null,
        outcome === "error" ? (str("error", 1000) ?? "Provider reported an error") : null, duration, reason, call.id).run();
    await finishEvent(db, claim.eventId, "ok", { callId: call.id, outcome }, discarded);
    if (call.lead_id) await addLeadNote(db, call.lead_id, `Call ended · outcome: ${outcome}`);
    // Missed inbound call: nobody spoke and no function ran. Owners are alerted; nothing is dialled automatically.
    if (call.direction === "inbound" && outcome === "abandoned" && !call.is_test && (from ?? call.from_number)) {
      await notifyOwners(db, "voice_missed_call", `Missed call from ${from ?? call.from_number} — the caller hung up before speaking with the receptionist.`, "call", call.id);
    }
    if (call.direction === "outbound" && call.outbound_request_id) {
      await applyOutboundResult(db, call.outbound_request_id, reason, cost, deps.now?.() ?? new Date());
    }
    return { status: 200, body: { ok: true, callId: call.id, outcome } };
  }

  // function_call
  const fn = parse(v.enumOf(VOICE_FUNCTIONS), (json.function as { name?: unknown } | undefined)?.name);
  if (!base.event_id) throw new ValidationError(["event_id is required for function calls (idempotency key)"]);
  // Read-only answers can change during a call (availability, hours): log them, never replay a stored one.
  const key = isReadOnlyCall(fn, (json.function as { arguments?: unknown }).arguments) ? `fn:${base.event_id}:${newId("ro")}` : `fn:${base.event_id}`;
  const claim = await claimEvent(db, call.id, key, `fn:${fn}`);
  if (claim.duplicate) return { status: 200, body: { ok: true, duplicate: true, result: claim.result } };
  // Cost control (CREST-GAP-053) holds even when the phone number's inbound webhook is not configured (no voicemail-mode
  // event recorded at call start): for Retell calls the Owner's monthly budget is also checked live, here.
  if (!VOICEMAIL_FUNCTIONS.has(fn) && (await isVoicemailCall(db, call) || (base.provider === "retell" && !budgetOpen(await voiceBudget(db, deps.now?.() ?? new Date()))))) {
    // Enforced here, not only in the prompt: a voicemail-mode call (budget unset or reached) can only leave a message.
    const result = { refused: "voicemail_mode", message: "I can only take a message right now. Ask for the caller's name, number and message, then call request_callback." };
    await finishEvent(db, claim.eventId, "ok", result, "refused: receptionist in voicemail mode (voice budget)");
    return { status: 200, body: { ok: true, result } };
  }
  try {
    const result = await runFunction(db, call, fn, (json.function as { arguments?: unknown }).arguments, deps);
    await finishEvent(db, claim.eventId, "ok", result);
    return { status: 200, body: { ok: true, result } };
  } catch (e) {
    const msg = e instanceof ValidationError ? e.issues.join("; ") : (e as Error).message;
    const result = { error: "I couldn't complete that. A team member will follow up.", detail: e instanceof ValidationError ? msg : undefined };
    await finishEvent(db, claim.eventId, "error", result, msg);
    if (!(e instanceof ValidationError)) await db.prepare(`UPDATE calls SET error = ? WHERE id = ?`).bind(`${fn}: ${msg}`.slice(0, 1000), call.id).run();
    return { status: e instanceof ValidationError ? 422 : 500, body: { ok: false, result } };
  }
}

// ───────────── Agent configuration (VOICE-004) ─────────────

/** Non-negotiable guardrails, always prepended to every configuration version. */
export const VOICE_GUARDRAILS = `GUARDRAILS (platform-enforced; cannot be edited):
1. Identify yourself at the start of every call as an AI assistant for Crestmont Website Development, not a person.
2. Explain Crestmont's services and ONLY the published pricing returned by get_packages_pricing (or get_published_pricing). Never invent, estimate, discount or negotiate prices. Custom development is quoted separately by a person.
3. Never guarantee or estimate delivery dates, launch dates or timelines.
4. Never agree to, sign, or execute any agreement, contract, quote or change order.
5. Never approve, promise or process refunds, credits or cancellations; record the request and escalate.
6. Never reveal any customer's information (names, projects, invoices, account status, whether an account exists). Support requests go through create_support_ticket (or route_support) only.
7. Never describe or speculate about the status of any project.
8. Ask for consent before recording or transcribing; if the caller declines, continue without recording.
9. When unsure, or when the caller asks for a person, use escalate or request_callback.`;

/**
 * The inbound receptionist's master instructions (appended after VOICE_GUARDRAILS by composePrompt). /staff/voice pre-fills
 * a new version with this text; activating it pushes guardrails + instructions to the Retell LLM (voice-prompt-sync.ts).
 * Every function named here must exist in VOICE_FUNCTIONS, and the text must pass configProblems (tested). Prices are never
 * written here: the agent quotes get_packages_pricing, so a Founder-approved price change can never leave the prompt stale.
 */
export const INBOUND_MASTER_INSTRUCTIONS = `ROLE
You are the AI receptionist for Crestmont Website Development, a website design and development company, answering Crestmont's own phone line. You are an AI assistant, not a person; say so in the greeting and whenever asked.

OPENING
1. After the greeting, ask: "Before we continue, may this call be recorded and transcribed so our team can follow up accurately?" Call record_consent once: true only if the caller clearly agrees, otherwise false. If they decline, say only the message record_consent returns, never that the call has stopped being recorded, and keep helping.
2. If {{receptionist_mode}} is "voicemail", only take a message: get the caller's name, phone number and a short message, call request_callback, thank them and end the call. Use no other function.
3. Ask how you can help, and work out whether this is a new enquiry, an existing customer, a booking, or something else.

SERVICES AND PRICING
- Crestmont designs, builds and redesigns websites and e-commerce sites, and builds custom web applications, customer portals, booking systems, payment integrations, AI chatbots and AI phone receptionists, API and CRM integrations, technical SEO, analytics setup and landing pages, plus hosting and maintenance.
- For any price, package, maintenance plan or add-on question, call get_packages_pricing once and quote only what it returns. Never estimate, round, combine, negotiate or lower a price, and never invent an offer or promotion.
- Packages are Starter, Business and Premium. Premium is a starting price; larger Premium scopes and all custom development are quoted by a person after a scoping conversation. Payment rules are exactly as the function states.
- Maintenance plans: give the monthly prices returned and say plan details are being finalised and a team member will confirm what each includes. They cannot be bought by phone.
- Add-ons: none are approved for sale. Anything beyond a package's scope is quoted separately by a person.
- Never promise timelines, launch dates, search rankings, traffic, leads or results.

NEW ENQUIRIES
Collect, one question at a time: full name; phone and/or email; business name; the package of interest or custom work; what they need (pages, features, current website, goals); and when they hope to start. Read the phone number and email back to confirm them. Then call crm_upsert_lead with interest set to starter, business, premium, custom, maintenance or other. Call it once per enquiry; if the caller adds details later, call it again with the same name and contact details plus the new requirements. Never say whether the caller was already in our records.
Then offer a next step: a consultation, a secure checkout link for a standard package, or the published prices by email.

OBJECTIONS
If price is a concern, explain what each package includes using get_packages_pricing and suggest a consultation to match scope to budget. If they want to think it over, offer to email the published prices and save their details with crm_upsert_lead. Never pressure the caller.

BUYING A PACKAGE
Only Starter, Business or Premium. Confirm the package, name and email (spell the email back), then call create_checkout_session once. Explain that the email has a secure link to our website, where they sign in or create an account, review the agreements and pay through Stripe. Never take, repeat or write down card numbers, bank details or passwords; if a caller starts reading card details, stop them politely and explain payment happens only through the secure link. If link_sent is false, apologise and offer request_callback.
To check a payment, ask for the checkout reference from that email and the email address it went to, then call check_payment_status and read back only its message. If not verified, say you couldn't match those details without hinting which was wrong, and offer a callback. After a locked answer, don't try again on this call.

CONSULTATIONS
If {{scheduling_available}} is "false", or schedule_consultation returns available false, don't book: offer request_callback.
1. Call schedule_consultation without start_time (add preferred_date as YYYY-MM-DD if they named a day). Offer two or three returned labels exactly as given.
2. When they choose, confirm the time, name, phone and topic, then call schedule_consultation again with that slot's exact start_time, name, phone, topic, email if given, and reminder_call_ok true only if they agreed to a reminder call.
3. If booked is true, read the confirmation_code back letter by letter and say whether it is confirmed or held for a team member to confirm. If the time was taken, offer the returned alternatives. If already_booked is true, offer to help with the existing booking.
For an existing booking, ask for the booking reference and the phone used to book, then use lookup_consultation, reschedule_consultation or cancel_consultation.

EXISTING CUSTOMERS, SUPPORT, PROJECT STATUS AND BILLING
- You cannot see or confirm any account, project, invoice or payment details by phone, and you never say whether someone is a customer. If asked, call crm_customer_lookup once and follow its next_step.
- For a support problem, project status, billing or invoice question: collect name, the account email, phone and a short description, call create_support_ticket once, and read the request reference back letter by letter. Say the team will follow up through their account.
- Refund requests, cancellations, contract changes, complaints and anything urgent: call escalate with the reason in the caller's words. Never approve or promise any of these.

PEOPLE, TRANSFERS AND CALLBACKS
If the caller asks for a person, or the request is outside these instructions: when {{transfer_available}} is "true", call check_transfer_availability, and only if it returns transfer_available true say you are transferring them and use the transfer tool. Otherwise call request_callback with name, phone, reason and any preferred time. For anything sensitive or urgent call escalate; if it returns transfer true, transfer the call, otherwise say the team will follow up during staffed hours. For opening hours call get_business_hours. If the caller asks not to be called again, call record_opt_out and confirm.

EMAILS
Use send_customer_email only when the caller asks for something by email: template package_information for the published prices, or consultation_details with the confirmation_code of a consultation booked on this call. Spell the address back first. You cannot write or change an email's content and never send marketing.

PRIVACY
Never confirm or repeat information the caller did not give you on this call. Never ask for passwords, card numbers, bank details or Social Security numbers. Collect only what the task needs.

WAITING AND FAILURES
Say one short phrase before a function runs, such as "One moment while I check that." If a function returns an error or says something couldn't be done, apologise briefly, retry at most once, then offer request_callback. Never say something was booked, sent, saved or created unless the function confirmed it. If an error says the line is not set up correctly, apologise and end the call.

ENDING THE CALL
Before ending, summarise what was done (details saved, link emailed, booking or support reference, callback requested) and what happens next, and ask if there is anything else. Thank them for calling Crestmont Website Development and use the end-call tool. End politely if the caller is abusive or the call is clearly not for Crestmont.

STYLE
Warm, professional and brief: one or two sentences at a time, plain language, one question at a time. Read references letter by letter. Business hours: {{business_hours}}. Human staff are not available around the clock.`;

export function defaultAgentPrompt(): string {
  return INBOUND_MASTER_INSTRUCTIONS;
}

export function composePrompt(instructions: string): string {
  return `${VOICE_GUARDRAILS}\n\nINSTRUCTIONS:\n${instructions.trim()}`;
}

export function instructionsOf(promptText: string): string {
  const i = promptText.indexOf("\n\nINSTRUCTIONS:\n");
  return i >= 0 ? promptText.slice(i + "\n\nINSTRUCTIONS:\n".length) : promptText;
}

const CONTRADICTIONS = [
  /\b(i am|i'm) (a )?(human|real person)\b/i, /\bguarantee/i, /\brefund(s)? (are|is) approved\b/i, /\bapprove (the |a )?refund/i,
  /\bsign (the |an? )?(contract|agreement)\b/i, /\b24\/7 (human|live|staff)/i, /\bdiscount/i,
];

export function configProblems(instructions: string): string[] {
  const p: string[] = [];
  const t = instructions.trim();
  if (t.length < 40) p.push("Instructions are too short.");
  if (t.length > 8000) p.push("Instructions must be at most 8,000 characters.");
  const bad = inventedPrices(t);
  if (bad.length) p.push(`Instructions mention prices that are not published catalog prices: ${bad.join(", ")}.`);
  for (const re of CONTRADICTIONS) if (re.test(t)) p.push(`Instructions contradict a guardrail (matched “${re.source}”).`);
  return p;
}

export async function createAgentConfig(db: Db, userId: string, instructions: string, note: string): Promise<{ id: string; version: number }> {
  const problems = configProblems(instructions);
  if (note.trim().length < 3) problems.push("Describe what changed in this version.");
  if (problems.length) throw new ValidationError(problems);
  const last = await db.prepare(`SELECT MAX(version) AS v FROM voice_agent_configs`).first<{ v: number | null }>();
  const version = (last?.v ?? 0) + 1;
  const id = newId("vac");
  await db.prepare(`INSERT INTO voice_agent_configs (id, version, prompt_text, change_note, created_by, created_at, active) VALUES (?,?,?,?,?,?,0)`)
    .bind(id, version, composePrompt(instructions), note.trim().slice(0, 300), userId, nowIso()).run();
  await audit(db, { actorUserId: userId, action: "voice.config_version_created", subjectType: "voice_agent_config", subjectId: id, details: { version } });
  return { id, version };
}

export async function activateAgentConfig(db: Db, userId: string, version: number): Promise<void> {
  const row = await db.prepare(`SELECT id, prompt_text FROM voice_agent_configs WHERE version = ?`).bind(version).first<{ id: string; prompt_text: string }>();
  if (!row) throw Object.assign(new Error("Version not found"), { status: 404 });
  if (!row.prompt_text.startsWith(VOICE_GUARDRAILS)) throw Object.assign(new Error("This version does not contain the platform guardrails and cannot be activated."), { status: 409 });
  await db.batch([
    db.prepare(`UPDATE voice_agent_configs SET active = 0 WHERE active = 1`),
    db.prepare(`UPDATE voice_agent_configs SET active = 1, activated_by = ?, activated_at = ? WHERE id = ?`).bind(userId, nowIso(), row.id),
  ]);
  await audit(db, { actorUserId: userId, action: "voice.config_activated", subjectType: "voice_agent_config", subjectId: row.id, details: { version } });
}

export interface DiffLine { op: " " | "+" | "-"; text: string }

/** Line diff (LCS). Inputs are bounded by configProblems (≤ 8,000 chars). */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: " ", text: x[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", text: x[i++] });
    else out.push({ op: "+", text: y[j++] });
  }
  while (i < n) out.push({ op: "-", text: x[i++] });
  while (j < m) out.push({ op: "+", text: y[j++] });
  return out;
}


/**
 * The live backend contract of every receptionist function (field names and required fields), read from the same
 * validators that run on each call: a Proxy records which fields a schema reads, and an empty object shows which it
 * requires. Used by the Retell inbound configuration audit to compare each Retell tool's JSON schema with the backend.
 */
export function functionContracts(): Record<string, { fields: string[]; required: string[] }> {
  const out: Record<string, { fields: string[]; required: string[] }> = {};
  for (const [name, check] of Object.entries(fnSchemas)) {
    const fields: string[] = [];
    const probe = new Proxy({}, { get: (_t, k) => { if (typeof k === "string") fields.push(k); return undefined; } });
    (check as (v: unknown, p: string, i: string[]) => unknown)(probe, "", []);
    const issues: string[] = [];
    (check as (v: unknown, p: string, i: string[]) => unknown)({}, "", issues);
    out[name] = { fields, required: [...new Set(issues.map((i) => /^(\w+) /.exec(i)?.[1]).filter((x): x is string => !!x && fields.includes(x)))] };
  }
  out.record_consent = { fields: ["consent"], required: ["consent"] }; // validated in src/adapters/retell.ts
  return out;
}
