// Outbound AI sales representative — Retell custom functions (OUTSALES-002..008, proposed).
//
// Endpoint: POST /api/webhooks/retell/outbound/functions (src/routes/sales-outbound.ts). Same X-Retell-Signature
// verification and environment stamp check as the receptionist's endpoint, but a separate URL and a separate allowlist:
// an inbound caller can never reach checkout, CRM updates or lead context, and the receptionist's handler is untouched.
//
// Binding (the core security rule): every function acts ONLY on the lead this platform dialled. The lead comes from the
// signed call metadata (crestmont_sales_call_id → sales_calls → lead) that Crestmont itself set in create-phone-call.
// A lead_id supplied by the model (or the {{lead_id}} query parameter) must match it, otherwise the request is refused:
// prompt injection ("look up lead X") cannot read or change another record.
//
// Guarantees enforced in code, whatever the model sends:
//  - lead context returns only verified, speakable research facts (src/domain/sales-eligibility.ts#spokenContext);
//  - prices come only from the catalog / Founder-approved effective prices; no discount or guarantee field exists;
//  - checkout never takes card details: it emails a link into Crestmont's existing checkout (sign-in, verified email,
//    agreement acceptance, Stripe Checkout). Payment is confirmed only by the Stripe webhook's records;
//  - email: fixed templates only, verified recipient only, ≤ 3 per lead per day, sales opt-outs honoured;
//  - scheduling never claims a confirmation the scheduling service did not return;
//  - do-not-call applies everywhere immediately (sales-outbound.ts#suppressEverywhere).
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { randomToken, hashToken } from "../lib/auth-crypto.ts";
import { parse, v, ValidationError } from "../lib/validate.ts";
import { PACKAGES, type PackageId } from "../domain/catalog.ts";
import { transitionLead, type LeadStage } from "../domain/crm.ts";
import { AGENT_DISPOSITIONS } from "../domain/sales-eligibility.ts";
import { publishedPricing } from "./voice.ts";
import { effectivePrices, effectivePrice } from "./pricing-approvals.ts";
import { intake } from "./contact-identity.ts";
import { audit } from "./security.ts";
import { addLeadNote, addLeadTask, redactSensitive } from "./voice-common.ts";
import { routeCalendar, wantsFounderArg, CALENDAR_LABELS } from "../domain/calendars.ts";
import { recordCallback, confirmedConsultation } from "./calendars.ts";
import { loadVoiceConfig, toE164 } from "./voice-settings.ts";
import * as sched from "./voice-scheduling.ts";
import { sendMail, type MailerCtx } from "./mailer.ts";
import { endOfBusinessDay, businessDate } from "../lib/business-time.ts";
import { leadFacts, researchContext, gateFor, getSalesCall, enqueueSalesCall, suppressEverywhere, type SalesCallRow, type LeadFacts } from "./sales-outbound.ts";

export const SALES_FUNCTIONS = ["get_outbound_lead_context", "update_outbound_lead", "get_packages_pricing", "create_checkout_session",
  "check_payment_status", "send_sales_email", "schedule_sales_followup", "record_do_not_call"] as const;
export type SalesFunction = (typeof SALES_FUNCTIONS)[number];
const READ_ONLY = new Set<SalesFunction>(["get_outbound_lead_context", "get_packages_pricing", "check_payment_status"]);

export interface SalesFnDeps {
  mail?: MailerCtx;
  baseUrl: string;
  environment: string;
  paymentsConfigured: boolean;
  now?: () => Date;
  calendar?: sched.CalendarAdapter;
}

export interface SalesFnResult { status: number; body: Record<string, unknown> }

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const str = (o: Obj, k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
const say = (status: number, message: string, extra: Obj = {}): SalesFnResult => ({ status, body: { ok: false, message, ...extra } });

// ───────────── Argument schemas (server-side authority; mirrored in docs/voice/OUTBOUND-SALES-CONFIG.md) ─────────────

const LEAD_ID = /^ld_[A-Za-z0-9_-]{1,60}$/;
const SERVICE_INTERESTS = ["starter", "business", "premium", "custom", "maintenance", "redesign", "ecommerce", "seo", "booking", "ai_receptionist"] as const;
const schemas = {
  get_outbound_lead_context: v.object({ lead_id: v.string({ optional: true, pattern: LEAD_ID }) }),
  update_outbound_lead: v.object({
    lead_id: v.string({ optional: true, pattern: LEAD_ID }),
    contact_name: v.string({ optional: true, min: 2, max: 120 }),
    contact_role: v.string({ optional: true, max: 80 }),
    contact_email: v.email({ optional: true }),
    discovery_notes: v.string({ optional: true, min: 3, max: 2000 }),
    budget_range: v.enumOf(["under_1000", "1000_2500", "2500_5000", "over_5000", "not_shared"] as const, { optional: true }),
    purchase_timeline: v.enumOf(["now", "within_30_days", "1_3_months", "later", "not_shared"] as const, { optional: true }),
    qualification: v.enumOf(["qualified", "not_qualified", "needs_review"] as const, { optional: true }),
    pipeline_stage: v.enumOf(["qualified", "quote_required", "lost"] as const, { optional: true }),
    sales_outcome: v.enumOf(AGENT_DISPOSITIONS, { optional: true }),
    next_steps: v.string({ optional: true, min: 3, max: 500 }),
  }),
  get_packages_pricing: v.object({}),
  create_checkout_session: v.object({
    lead_id: v.string({ optional: true, pattern: LEAD_ID }),
    package: v.enumOf(["starter", "business", "premium"] as const),
    email: v.email(),
    buyer_confirmed: v.enumOf(["true"] as const),
  }),
  check_payment_status: v.object({ lead_id: v.string({ optional: true, pattern: LEAD_ID }), checkout_reference: v.string({ optional: true, pattern: /^slk_[A-Za-z0-9_-]{1,60}$/ }) }),
  send_sales_email: v.object({
    lead_id: v.string({ optional: true, pattern: LEAD_ID }),
    email_type: v.enumOf(["package_information", "checkout_link", "approved_quote", "consultation_confirmation", "follow_up", "onboarding_instructions"] as const),
    email: v.email(),
    package: v.enumOf(["starter", "business", "premium"] as const, { optional: true }),
  }),
  schedule_sales_followup: v.object({
    lead_id: v.string({ optional: true, pattern: LEAD_ID }),
    followup_type: v.enumOf(["consultation", "staff_callback", "ai_follow_up_call"] as const),
    start_time: v.string({ optional: true, min: 16, max: 40 }),
    preferred_date: v.string({ optional: true, pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    preferred_time: v.enumOf(["morning", "afternoon", "evening", "any"] as const, { optional: true }),
    name: v.string({ optional: true, min: 2, max: 120 }),
    email: v.email({ optional: true }),
    topic: v.string({ optional: true, min: 3, max: 500 }),
    prospect_agreed: v.enumOf(["true"] as const),
    // Dual calendars (migration 0065): true ONLY when the prospect explicitly asked to speak with the Founder/owner.
    // Missing or anything other than true → AI Follow-Up calendar (backwards compatible).
    wants_founder: wantsFounderArg,
  }),
  record_do_not_call: v.object({
    lead_id: v.string({ optional: true, pattern: LEAD_ID }),
    phone: v.string({ optional: true, pattern: /^[+0-9 ().-]{7,40}$/ }),
    also_stop_email: v.enumOf(["true", "false"] as const, { optional: true }),
  }),
};

/**
 * What the Retell function definitions must look like (parameter names and required ones), from the validators above
 * plus the two arrays update_outbound_lead reads directly. Used by the live configuration audit (retell-outbound-audit.ts).
 */
export function outboundFunctionContracts(): Record<SalesFunction, { fields: string[]; required: string[] }> {
  const fieldsOf = (k: SalesFunction) => {
    const probe: string[] = [];
    // The validators are closures; derive the field list from a parse that reports every missing required field.
    const issues: string[] = [];
    (schemas[k] as unknown as (v: unknown, path: string, issues: string[]) => unknown)({}, "", issues);
    for (const i of issues) { const m = /^([a-z_]+) (is required|must be one of)/.exec(i); if (m) probe.push(m[1]); }
    return probe;
  };
  const all: Record<SalesFunction, string[]> = {
    get_outbound_lead_context: ["lead_id"],
    update_outbound_lead: ["lead_id", "contact_name", "contact_role", "contact_email", "discovery_notes", "service_interests", "budget_range", "purchase_timeline", "objections", "qualification", "pipeline_stage", "sales_outcome", "next_steps"],
    get_packages_pricing: [],
    create_checkout_session: ["lead_id", "package", "email", "buyer_confirmed"],
    check_payment_status: ["lead_id", "checkout_reference"],
    send_sales_email: ["lead_id", "email_type", "email", "package"],
    schedule_sales_followup: ["lead_id", "followup_type", "start_time", "preferred_date", "preferred_time", "name", "email", "topic", "prospect_agreed", "wants_founder"],
    record_do_not_call: ["lead_id", "phone", "also_stop_email"],
  };
  return Object.fromEntries(SALES_FUNCTIONS.map((k) => [k, { fields: all[k], required: fieldsOf(k) }])) as Record<SalesFunction, { fields: string[]; required: string[] }>;
}

/**
 * Enum values the backend accepts per function argument (from the validators above). A Retell schema may offer a subset;
 * any value outside these is refused with 422, so the live audit fails a Retell enum that lists one.
 * Boolean-typed Retell parameters are accepted for the ["true"] / ["true","false"] fields (normaliseArgs converts them).
 */
export const OUTBOUND_FUNCTION_ENUMS: Record<string, Record<string, readonly string[]>> = {
  update_outbound_lead: {
    budget_range: ["under_1000", "1000_2500", "2500_5000", "over_5000", "not_shared"],
    purchase_timeline: ["now", "within_30_days", "1_3_months", "later", "not_shared"],
    qualification: ["qualified", "not_qualified", "needs_review"],
    pipeline_stage: ["qualified", "quote_required", "lost"],
    sales_outcome: AGENT_DISPOSITIONS,
    service_interests: SERVICE_INTERESTS,
  },
  create_checkout_session: { package: ["starter", "business", "premium"], buyer_confirmed: ["true"] },
  send_sales_email: { email_type: ["package_information", "checkout_link", "approved_quote", "consultation_confirmation", "follow_up", "onboarding_instructions"], package: ["starter", "business", "premium"] },
  schedule_sales_followup: { followup_type: ["consultation", "staff_callback", "ai_follow_up_call"], preferred_time: ["morning", "afternoon", "evening", "any"], prospect_agreed: ["true"], wants_founder: ["true", "false"] },
  record_do_not_call: { also_stop_email: ["true", "false"] },
};

/** Booleans → "true"/"false", string arguments redacted (card numbers, SSNs) before validation and storage. */
function normaliseArgs(raw: unknown): Obj {
  const o = { ...obj(raw) };
  // The lead comes from the signed call metadata. A lead_id argument that is not a lead id at all (an unrendered
  // "{{lead_id}}", an empty string, a business name) is dropped instead of failing the call; a well-formed but
  // different lead id is still refused by bind() as a cross-lead attempt.
  if (o.lead_id !== undefined && !(typeof o.lead_id === "string" && LEAD_ID.test(o.lead_id))) delete o.lead_id;
  return Object.fromEntries(Object.entries(o).map(([k, val]) => [k, typeof val === "string" ? redactSensitive(val) : typeof val === "boolean" ? String(val) : Array.isArray(val) ? val.map((x) => (typeof x === "string" ? redactSensitive(x) : x)) : val]));
}

// ───────────── Binding ─────────────

interface Bound { row: SalesCallRow; facts: LeadFacts; providerCallId: string; isTest: boolean }

async function bind(db: Db, call: Obj, args: Obj, queryLeadId: string | null): Promise<Bound | SalesFnResult> {
  const providerCallId = str(call, "call_id")!;
  const salesId = str(obj(call.metadata), "crestmont_sales_call_id");
  if (!salesId || !/^scall_[A-Za-z0-9_-]{1,60}$/.test(salesId)) return say(403, "This call was not placed by Crestmont's outbound sales system. Do not continue the sales conversation; apologise and end the call politely.", { refused: "unbound_call" });
  const row = await getSalesCall(db, salesId);
  if (!row) return say(403, "This call is not recognised. Apologise and end the call politely.", { refused: "unknown_sales_call" });
  if (row.provider_call_id && row.provider_call_id !== providerCallId) return say(403, "This call is not recognised. Apologise and end the call politely.", { refused: "call_mismatch" });
  if (!row.provider_call_id) {
    if (row.status !== "dialing") return say(403, "This call is not recognised. Apologise and end the call politely.", { refused: "call_not_active" });
    await db.prepare(`UPDATE sales_calls SET provider_call_id = ? WHERE id = ? AND provider_call_id IS NULL`).bind(providerCallId, row.id).run();
  }
  if (row.finalized_at && row.status !== "queued") return say(409, "This call has already ended.", { refused: "call_finalized" });
  for (const claimed of [str(args, "lead_id"), queryLeadId]) {
    if (claimed && claimed !== row.lead_id) {
      await audit(db, { actorKind: "ai", action: "sales_outbound.lead_mismatch", subjectType: "sales_call", subjectId: row.id, details: { claimed: claimed.slice(0, 64) } });
      return say(403, "I can only discuss the business this call was placed to.", { refused: "lead_mismatch" });
    }
  }
  const facts = await leadFacts(db, row.lead_id);
  if (!facts) return say(404, "I can't find the details for this call. Apologise and offer to have a team member follow up.");
  return { row, facts, providerCallId, isTest: row.is_test === 1 };
}

// ───────────── Helpers ─────────────

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** The address the prospect verified on a call (profile) or the CRM contact's own address. Nothing else is mailable. */
async function verifiedEmails(db: Db, b: Bound): Promise<Set<string>> {
  const p = await db.prepare(`SELECT verified_email FROM sales_lead_profiles WHERE lead_id = ?`).bind(b.row.lead_id).first<{ verified_email: string | null }>();
  const contact = await db.prepare(`SELECT email FROM contacts WHERE id = ?`).bind(b.facts.contactId).first<{ email: string | null }>();
  return new Set([lc(p?.verified_email), lc(contact?.email)].filter(Boolean));
}

async function upsertProfile(db: Db, leadId: string, fields: Record<string, string | null>, via: string): Promise<void> {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  await db.prepare(`INSERT INTO sales_lead_profiles (lead_id, ${cols.join(", ")}, updated_via, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, ?, ?)
      ON CONFLICT(lead_id) DO UPDATE SET ${cols.map((c) => `${c} = COALESCE(excluded.${c}, sales_lead_profiles.${c})`).join(", ")}, updated_via = excluded.updated_via, updated_at = excluded.updated_at`)
    .bind(leadId, ...cols.map((c) => fields[c]), via, nowIso()).run();
}

async function moveStage(db: Db, leadId: string, to: LeadStage, reason: string | null, note: string): Promise<{ moved: boolean; from: string; detail?: string }> {
  const lead = await db.prepare(`SELECT stage, merged_into_lead_id FROM leads WHERE id = ?`).bind(leadId).first<{ stage: LeadStage; merged_into_lead_id: string | null }>();
  if (!lead || lead.merged_into_lead_id) return { moved: false, from: lead?.stage ?? "unknown", detail: "lead merged or missing" };
  if (lead.stage === to) return { moved: false, from: lead.stage };
  try { transitionLead(lead.stage, to, { lostReason: reason ?? undefined }); } catch (e) { return { moved: false, from: lead.stage, detail: (e as Error).message }; }
  const at = nowIso();
  const r = await db.prepare(`UPDATE leads SET stage = ?, lost_reason = COALESCE(?, lost_reason), updated_at = ? WHERE id = ? AND stage = ?`).bind(to, reason, at, leadId, lead.stage).run();
  if (r.meta.changes !== 1) return { moved: false, from: lead.stage, detail: "changed concurrently" };
  await db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'stage_change',?,?)`).bind(newId("act"), leadId, `Stage: ${lead.stage} → ${to} (${note})`, at).run();
  await audit(db, { actorKind: "ai", action: "lead.stage_changed", subjectType: "lead", subjectId: leadId, details: { from: lead.stage, to, via: "outbound_sales_agent" } });
  return { moved: true, from: lead.stage };
}

async function salesEmailsToday(db: Db, leadId: string, now: Date): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM sales_emails WHERE lead_id = ? AND created_at >= ?`).bind(leadId, new Date(now.getTime() - 86_400_000).toISOString()).first<{ n: number }>())!.n;
}
export const MAX_SALES_EMAILS_PER_DAY = 3;

/** Sends one fixed-template sales email (marketing category, unsubscribe link). Idempotent per lead + kind + day. */
async function sendSalesMail(db: Db, deps: SalesFnDeps, b: Bound, kind: string, to: string, data: Parameters<typeof sendMail>[1], now: Date): Promise<{ sent: boolean; status: string; duplicate?: boolean; message?: string }> {
  const email = lc(to);
  if (await db.prepare(`SELECT 1 AS x FROM sales_email_optouts WHERE email = ?`).bind(email).first()) return { sent: false, status: "opted_out", message: "This address asked not to receive sales email." };
  const key = `sales:${b.row.lead_id}:${kind}:${businessDate(now)}`;
  const existing = await db.prepare(`SELECT delivery_status FROM sales_emails WHERE idempotency_key = ?`).bind(key).first<{ delivery_status: string | null }>();
  if (existing && kind !== "checkout_link") return { sent: existing.delivery_status === "sent" || existing.delivery_status === "queued", status: existing.delivery_status ?? "unknown", duplicate: true };
  if (await salesEmailsToday(db, b.row.lead_id, now) >= MAX_SALES_EMAILS_PER_DAY) return { sent: false, status: "rate_limited", message: "We've already sent the maximum number of emails today. A team member can follow up." };
  if (!deps.mail) return { sent: false, status: "not_configured", message: "Email is not available right now. A team member will follow up." };
  const token = randomToken(24);
  const id = newId("sem");
  const finalKey = existing ? `${key}:${id}` : key;
  let status = "failed", deliveryId: string | null = null;
  try {
    const r = await sendMail(deps.mail, { ...(data as object), to: email, idempotencyKey: finalKey, unsubscribeUrl: `${deps.baseUrl}/sales/unsubscribe/${token}` } as Parameters<typeof sendMail>[1]);
    status = r.status; deliveryId = r.deliveryId;
  } catch (e) { status = "failed"; await audit(db, { actorKind: "ai", action: "sales_outbound.email_failed", subjectType: "lead", subjectId: b.row.lead_id, details: { kind, error: (e as Error).message.slice(0, 200) } }); }
  await db.prepare(`INSERT INTO sales_emails (id, lead_id, kind, recipient, idempotency_key, delivery_id, delivery_status, provider_call_id, unsubscribe_token_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, b.row.lead_id, kind, email, finalKey, deliveryId, status, b.providerCallId, await hashToken(token), nowIso(() => now)).run();
  await db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'email',?,?)`).bind(newId("act"), b.row.lead_id,
    `${b.isTest ? "[TEST] " : ""}Sales email "${kind.replace(/_/g, " ")}" to ${email}: ${status === "sent" ? "sent" : status === "queued" ? "queued (not yet delivered)" : `not delivered (${status})`} — requested on AI sales call`, nowIso()).run();
  return { sent: status === "sent" || status === "queued", status };
}

// ───────────── Functions ─────────────

async function getLeadContext(db: Db, b: Bound, now: Date): Promise<Obj> {
  const f = b.facts;
  const ctx = researchContext(f, now);
  const activity = (await db.prepare(`SELECT kind, body, created_at FROM crm_activities WHERE lead_id = ? AND kind IN ('call','email','stage_change') ORDER BY created_at DESC LIMIT 5`).bind(f.leadId)
    .all<{ kind: string; body: string; created_at: string }>()).results;
  const prior = (await db.prepare(`SELECT outcome, finalized_at FROM sales_calls WHERE lead_id = ? AND finalized_at IS NOT NULL ORDER BY finalized_at DESC LIMIT 3`).bind(f.leadId).all<{ outcome: string; finalized_at: string }>()).results;
  const quote = await db.prepare(`SELECT status FROM quotes WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1`).bind(f.leadId).first<{ status: string }>();
  const paid = !!(await db.prepare(`SELECT 1 AS x FROM orders o JOIN invoices i ON i.order_id = o.id WHERE o.lead_id = ? AND i.status = 'paid'`).bind(f.leadId).first());
  const link = !!(await db.prepare(`SELECT 1 AS x FROM sales_checkout_links WHERE lead_id = ? AND revoked_at IS NULL`).bind(f.leadId).first());
  const profile = await db.prepare(`SELECT verified_contact_name, qualification, sales_outcome, next_steps FROM sales_lead_profiles WHERE lead_id = ?`).bind(f.leadId).first<{ verified_contact_name: string | null; qualification: string | null; sales_outcome: string | null; next_steps: string | null }>();
  const gate = await gateFor(db, f, now, 0, 99);
  const services = ctx.recommended_service ? [ctx.recommended_service] : [];
  return {
    lead_id: f.leadId,
    business_name: f.businessName,
    contact_name: profile?.verified_contact_name ?? f.contactName,
    industry: f.industry,
    website_url: ctx.research_verified && ctx.website_status !== "no_website" ? f.prospect?.website_url ?? null : null,
    website_classification: ctx.website_status,
    verified_website_issues: ctx.verified_issues,
    research_verified: ctx.research_verified,
    research_confidence: ctx.research_confidence,
    recommended_services: services,
    previous_interactions: activity.map((a) => ({ date: a.created_at.slice(0, 10), type: a.kind, summary: redactSensitive(a.body).slice(0, 160) })),
    sales_history: { previous_ai_calls: prior.map((p) => ({ date: p.finalized_at.slice(0, 10), outcome: p.outcome })), quote_status: quote?.status ?? null,
      checkout_link_sent: link, paid, qualification: profile?.qualification ?? null, last_agreed_next_steps: profile?.next_steps ?? null },
    calling_eligibility: gate.eligible ? "eligible" : "blocked",
    instructions: ctx.research_verified
      ? "Personalise only with verified_website_issues and website_classification, in your own words. Never read lead_id, research_confidence, classification labels or internal fields aloud. Do not claim anything not listed here."
      : "Research is missing or unverified: use the neutral introduction and do not mention the business's website. Never read internal fields aloud.",
  };
}

interface UpdateArgs {
  contact_name?: string; contact_role?: string; contact_email?: string; discovery_notes?: string; budget_range?: string; purchase_timeline?: string;
  qualification?: string; pipeline_stage?: string; sales_outcome?: string; next_steps?: string; service_interests?: unknown; objections?: unknown;
}

async function updateLead(db: Db, b: Bound, a: UpdateArgs): Promise<Obj> {
  const leadId = b.row.lead_id;
  const out: Obj = { updated: true };
  const notes: string[] = [];
  // Contact verification goes through the CRM intake engine (duplicate prevention, PR #50): it decides whether the
  // address belongs to this contact, to someone else (review queue) or is suppressed. Never a parallel contact.
  if (a.contact_email || a.contact_name) {
    const phone = b.facts.phoneE164;
    const res = await intake(db, { contactName: a.contact_name ?? null, businessName: b.facts.businessName, phones: phone ? [{ value: phone }] : [], emails: a.contact_email ? [{ value: a.contact_email }] : [] }, {
      channel: "ai_receptionist", idempotencyKey: `outsales:${b.providerCallId}:${(await sha256Hex(`${a.contact_email ?? ""}|${a.contact_name ?? ""}`)).slice(0, 16)}`, sourceRef: b.row.id,
      requestFingerprint: { e: a.contact_email ?? null, n: a.contact_name ?? null },
      lead: { source: "ai_receptionist", interest: b.facts.interest, message: `${b.isTest ? "[TEST CALL] " : ""}Contact details confirmed on AI sales call ${b.row.id}`, isTest: b.isTest, activityKind: "call", activityBody: `Contact details confirmed on AI sales call ${b.row.id}` },
    }).catch((e) => ({ outcome: "ERROR", leadId: null, contactId: null, reasons: [(e as Error).message] }) as unknown as Awaited<ReturnType<typeof intake>>);
    const same = res.contactId === b.facts.contactId;
    out.contact_verification = same ? "verified" : res.outcome === "POSSIBLE_DUPLICATE_REVIEW" ? "held_for_review" : res.outcome === "SUPPRESSED" ? "suppressed" : "not_linked";
    if (same) {
      // A research lead's placeholder name (the business name) is replaced by the person's name once they give it.
      if (a.contact_name) await db.prepare(`UPDATE contacts SET name = ? WHERE id = ? AND (name IS NULL OR lower(name) = lower(COALESCE((SELECT co.name FROM companies co WHERE co.id = contacts.company_id), '')))`).bind(a.contact_name, b.facts.contactId).run();
      if (a.contact_email) await db.prepare(`UPDATE contacts SET email = ? WHERE id = ? AND email IS NULL AND NOT EXISTS (SELECT 1 FROM contacts c2 WHERE lower(c2.email) = lower(?) AND c2.id <> ?)`).bind(a.contact_email.toLowerCase(), b.facts.contactId, a.contact_email, b.facts.contactId).run();
    } else if (res.outcome === "POSSIBLE_DUPLICATE_REVIEW") notes.push("Contact details matched another CRM record and were sent to the duplicate review queue");
  }
  const profile: Record<string, string | null> = {};
  if (a.contact_name) profile.verified_contact_name = a.contact_name;
  if (a.contact_role) profile.verified_role = a.contact_role;
  if (a.contact_email && out.contact_verification === "verified") profile.verified_email = a.contact_email.toLowerCase();
  if (a.budget_range) profile.budget_range = a.budget_range;
  if (a.purchase_timeline) profile.purchase_timeline = a.purchase_timeline;
  if (a.qualification) profile.qualification = a.qualification;
  if (a.sales_outcome) profile.sales_outcome = a.sales_outcome;
  if (a.next_steps) profile.next_steps = a.next_steps;
  const interests = Array.isArray(a.service_interests) ? (a.service_interests as unknown[]).filter((x): x is string => typeof x === "string" && (SERVICE_INTERESTS as readonly string[]).includes(x)).slice(0, 6) : null;
  if (interests?.length) profile.service_interests_json = JSON.stringify(interests);
  const objections = Array.isArray(a.objections) ? (a.objections as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length >= 3).map((x) => x.trim().slice(0, 200)).slice(0, 5) : null;
  if (objections?.length) profile.objections_json = JSON.stringify(objections);
  await upsertProfile(db, leadId, profile, `ai_sales_call:${b.row.id}`);
  if (interests?.length && ["starter", "business", "premium", "custom", "maintenance"].includes(interests[0])) await db.prepare(`UPDATE leads SET interest = ?, updated_at = ? WHERE id = ?`).bind(interests[0], nowIso(), leadId).run();
  if (a.sales_outcome) await db.prepare(`UPDATE sales_calls SET disposition = ? WHERE id = ?`).bind(a.sales_outcome, b.row.id).run();
  const summary = [a.discovery_notes && `Discovery: ${a.discovery_notes}`, interests?.length && `Interests: ${interests.join(", ")}`, a.budget_range && `Budget: ${a.budget_range.replace(/_/g, " ")}`,
    a.purchase_timeline && `Timeline: ${a.purchase_timeline.replace(/_/g, " ")}`, objections?.length && `Objections: ${objections.join("; ")}`, a.qualification && `Qualification: ${a.qualification}`,
    a.sales_outcome && `Disposition: ${a.sales_outcome.replace(/_/g, " ")}`, a.next_steps && `Next steps: ${a.next_steps}`].filter(Boolean).join(" · ");
  if (summary) await addLeadNote(db, leadId, `${b.isTest ? "[TEST] " : ""}AI sales call ${b.row.id} — ${summary}`.slice(0, 4000));
  const stageTo = a.pipeline_stage ?? (a.qualification === "qualified" ? "qualified" : a.sales_outcome === "not_interested" ? "lost" : null);
  if (stageTo) {
    const m = await moveStage(db, leadId, stageTo as LeadStage, stageTo === "lost" ? "Not interested (AI sales call)" : null, `AI sales call ${b.row.id}`);
    out.pipeline_stage = m.moved ? stageTo : m.from;
    if (!m.moved && m.detail) notes.push(`Stage unchanged: ${m.detail}`);
  }
  if (notes.length) out.notes = notes;
  out.message = "Saved to the CRM.";
  return out;
}

async function packagesPricing(db: Db, now: Date): Promise<Obj> {
  const p = publishedPricing(await effectivePrices(db, now));
  return {
    packages: p.packages.map((x) => ({ id: Object.values(PACKAGES).find((k) => k.name === x.name)?.id, name: x.name, price: x.price, starting_price: x.startingPrice, page_limit: x.pageLimit, revision_rounds: x.revisionRounds, purchasable_online: true })),
    custom_development: p.customDevelopment,
    maintenance: p.maintenance.map((m) => ({ name: m.name, monthly: m.monthly, purchasable_now: false })),
    maintenance_note: "Maintenance plans are not yet available to buy: their exact inclusions are awaiting Founder approval. Quote the monthly price only and say a team member will confirm what each includes.",
    payment_rules: p.paymentRules,
    rules: "Quote only these figures. No discounts, no bundles, no guarantees of rankings, traffic, revenue or launch dates. Premium is a starting price; work above it is quoted by a person.",
  };
}

async function createCheckout(db: Db, deps: SalesFnDeps, b: Bound, a: { package: PackageId; email: string }, now: Date): Promise<SalesFnResult> {
  if (!deps.paymentsConfigured) return { status: 200, body: { checkout_link_sent: false, reason: "payments_not_configured", message: "Online payment isn't available yet. Offer to have a team member follow up by email." } };
  const emails = await verifiedEmails(db, b);
  if (!emails.has(lc(a.email))) return { status: 200, body: { checkout_link_sent: false, reason: "email_not_verified", message: "First confirm the prospect's email address with update_outbound_lead (contact_email), then try again. Links are only sent to a confirmed address." } };
  const profile = await db.prepare(`SELECT qualification FROM sales_lead_profiles WHERE lead_id = ?`).bind(b.row.lead_id).first<{ qualification: string | null }>();
  const lead = await db.prepare(`SELECT stage FROM leads WHERE id = ?`).bind(b.row.lead_id).first<{ stage: string }>();
  if (profile?.qualification !== "qualified" && !["qualified", "quote_required", "quote_sent", "negotiation", "accepted", "awaiting_payment"].includes(lead?.stage ?? "")) {
    return { status: 200, body: { checkout_link_sent: false, reason: "not_qualified", message: "Confirm the prospect's needs and record qualification (update_outbound_lead qualification=qualified) before sending a purchase link." } };
  }
  if (await db.prepare(`SELECT 1 AS x FROM sales_email_optouts WHERE email = ?`).bind(lc(a.email)).first()) return { status: 200, body: { checkout_link_sent: false, reason: "email_opted_out", message: "This address asked not to receive sales email. A team member can follow up another way." } };
  const pkg = PACKAGES[a.package];
  const price = await effectivePrice(db, "package", pkg.id, now);
  const day = businessDate(now);
  const idem = `checkout:${b.row.lead_id}:${pkg.id}:${day}`;
  const existing = await db.prepare(`SELECT id, expires_at FROM sales_checkout_links WHERE idempotency_key = ? AND revoked_at IS NULL`).bind(idem).first<{ id: string; expires_at: string }>();
  if (existing) return { status: 200, body: { checkout_link_sent: true, already_sent_today: true, checkout_reference: existing.id, package: pkg.name, price: `${dollars(price.cents)}${pkg.priceIsFloor ? "+" : ""}`, expires_at: existing.expires_at,
    message: "A secure link for this package was already emailed today. Ask the prospect to check their inbox (and spam folder)." } };
  const token = randomToken(32);
  const id = newId("slk");
  const expires = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  await db.prepare(`INSERT INTO sales_checkout_links (id, lead_id, package_id, email, token_hash, idempotency_key, sales_call_id, provider_call_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, b.row.lead_id, pkg.id, lc(a.email), await hashToken(token), idem, b.row.id, b.providerCallId, nowIso(() => now), expires).run();
  const url = `${deps.baseUrl}/buy/${token}`;
  const expiresLabel = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" }).format(new Date(expires));
  const priceLabel = `${dollars(price.cents)}${pkg.priceIsFloor ? " (starting price)" : ""}`;
  const mail = await sendSalesMail(db, deps, b, "checkout_link", a.email, { template: "sales_info", data: { event: "checkout_link", name: b.facts.contactName, packageName: pkg.name, price: priceLabel, url, expires: expiresLabel } } as never, now);
  await audit(db, { actorKind: "ai", action: "sales_outbound.checkout_link_created", subjectType: "sales_checkout_link", subjectId: id, details: { lead: b.row.lead_id, package: pkg.id, priceCents: price.cents, delivery: mail.status } });
  return { status: 200, body: {
    checkout_link_sent: mail.sent, delivery: mail.status, checkout_reference: id, checkout_url: url, package: pkg.name, price: priceLabel, expires_at: expires,
    message: mail.sent ? "The secure checkout link has been emailed. Do not read the link aloud. Tell the prospect they'll sign in, accept the agreement and pay on Stripe's secure page; payment is confirmed only when Stripe tells us."
      : `The link was created but the email was not sent (${mail.status}). Offer to have a team member follow up.`,
  } };
}

async function paymentStatus(db: Db, b: Bound, ref: string | undefined): Promise<Obj> {
  const link = ref ? await db.prepare(`SELECT id, created_at, clicked_at, package_id FROM sales_checkout_links WHERE id = ? AND lead_id = ?`).bind(ref, b.row.lead_id).first<{ id: string; created_at: string; clicked_at: string | null; package_id: string }>()
    : await db.prepare(`SELECT id, created_at, clicked_at, package_id FROM sales_checkout_links WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1`).bind(b.row.lead_id).first<{ id: string; created_at: string; clicked_at: string | null; package_id: string }>();
  // Authoritative: invoices.status = 'paid' and a succeeded payment are written only by the verified Stripe webhook.
  const order = await db.prepare(`SELECT o.id, o.status AS order_status, i.id AS invoice_id, i.status AS invoice_status, i.stripe_checkout_session_id, p.status AS payment_status, pr.id AS project_id, pr.status AS project_status
      FROM orders o JOIN invoices i ON i.order_id = o.id LEFT JOIN payments p ON p.invoice_id = i.id LEFT JOIN projects pr ON pr.order_id = o.id
      WHERE o.lead_id = ? OR o.id IN (SELECT order_id FROM sales_checkout_links WHERE lead_id = ? AND order_id IS NOT NULL) ORDER BY o.created_at DESC, p.created_at DESC LIMIT 1`).bind(b.row.lead_id, b.row.lead_id)
    .first<{ id: string; order_status: string; invoice_id: string; invoice_status: string; stripe_checkout_session_id: string | null; payment_status: string | null; project_id: string | null; project_status: string | null }>();
  let status: string;
  if (order?.invoice_status === "paid" && order.payment_status === "succeeded") status = "paid";
  else if (order?.payment_status === "refunded" || order?.payment_status === "partially_refunded") status = "refunded";
  else if (order?.payment_status === "disputed") status = "disputed";
  else if (order?.stripe_checkout_session_id) status = "checkout_started_not_paid";
  else if (link?.clicked_at) status = "link_opened";
  else if (link) status = "link_sent";
  else status = "no_checkout";
  const onboarding = status === "paid" ? (order?.project_id ? `project_created${order.project_status ? `:${order.project_status}` : ""}` : "awaiting_project_setup") : "not_started";
  return {
    payment_status: status, checkout_reference: link?.id ?? null, stripe_checkout_session_id: order?.stripe_checkout_session_id ?? null, lead_id: b.row.lead_id, onboarding_status: onboarding,
    message: status === "paid" ? "Stripe has confirmed the payment. You may thank the prospect and say onboarding instructions are on their way."
      : "Payment is not confirmed. Never say it is paid unless payment_status is \"paid\".",
  };
}

async function sendEmail(db: Db, deps: SalesFnDeps, b: Bound, a: { email_type: string; email: string; package?: PackageId }, now: Date): Promise<SalesFnResult> {
  const emails = await verifiedEmails(db, b);
  if (!emails.has(lc(a.email))) return { status: 200, body: { sent: false, reason: "email_not_verified", message: "Confirm the prospect's email with update_outbound_lead first. Email goes only to a confirmed address." } };
  const name = b.facts.contactName;
  const done = (r: { sent: boolean; status: string; duplicate?: boolean; message?: string }, ok: string) => ({ status: 200, body: { sent: r.sent, delivery: r.status, ...(r.duplicate ? { already_sent_today: true } : {}), message: r.sent ? ok : r.message ?? `The email was not sent (${r.status}).` } });
  switch (a.email_type) {
    case "package_information": {
      const p = publishedPricing(await effectivePrices(db, now));
      return done(await sendSalesMail(db, deps, b, "package_information", a.email, { template: "sales_info", data: { event: "package_information", name, packages: p.packages.map((x) => ({ name: x.name, price: x.price })),
        maintenanceNote: `Maintenance plans (${p.maintenance.map((m) => m.monthly).join(", ")}) are being finalised; a team member will confirm what each includes.`, pricingUrl: `${deps.baseUrl}/pricing` } } as never, now), "Package information has been emailed.");
    }
    case "checkout_link": {
      if (!a.package) return say(422, "Say which package the link is for.");
      return createCheckout(db, deps, b, { package: a.package, email: a.email }, now);
    }
    case "approved_quote": {
      // Only a proposal a person already approved and sent (status 'sent', unexpired) is re-issued; the AI never prices.
      const q = await db.prepare(`SELECT q.id, q.status, v.id AS version_id, v.total_cents, v.valid_until, c.id AS contact_id, c.name AS contact_name FROM quotes q
          JOIN quote_versions v ON v.quote_id = q.id AND v.version = q.current_version JOIN leads l ON l.id = q.lead_id JOIN contacts c ON c.id = l.contact_id
          WHERE q.lead_id = ? AND q.status = 'sent' ORDER BY q.created_at DESC LIMIT 1`).bind(b.row.lead_id).first<{ id: string; version_id: string; total_cents: number; valid_until: string | null; contact_id: string; contact_name: string }>();
      if (!q) return { status: 200, body: { sent: false, reason: "no_approved_quote", message: "There is no approved proposal to send. Offer to have a team member prepare a quote (schedule_sales_followup staff_callback)." } };
      if (q.valid_until && q.valid_until < businessDate(now)) return { status: 200, body: { sent: false, reason: "quote_expired", message: "The proposal has expired. A team member needs to issue a new one." } };
      const token = randomToken();
      const expires = q.valid_until ? endOfBusinessDay(q.valid_until) : new Date(now.getTime() + 30 * 86_400_000).toISOString();
      await db.prepare(`INSERT INTO quote_access_tokens (token_hash, quote_id, contact_id, quote_version_id, expires_at, created_at) VALUES (?,?,?,?,?,?)`).bind(await hashToken(token), q.id, q.contact_id, q.version_id, expires, nowIso(() => now)).run();
      return done(await sendSalesMail(db, deps, b, "approved_quote", a.email, { template: "quote_sent", data: { contactName: q.contact_name, totalCents: q.total_cents, validUntil: q.valid_until, proposalUrl: `${deps.baseUrl}/q/${token}` } } as never, now), "The approved proposal has been emailed.");
    }
    case "consultation_confirmation": {
      const c = await db.prepare(`SELECT * FROM consultations WHERE lead_id = ? AND status IN ('requested','confirmed') AND starts_at > ? ORDER BY starts_at LIMIT 1`).bind(b.row.lead_id, now.toISOString()).first<sched.ConsultationRow>();
      if (!c) return { status: 200, body: { sent: false, reason: "no_consultation", message: "There is no upcoming consultation for this business." } };
      return done(await sendSalesMail(db, deps, b, "consultation_confirmation", a.email, { template: "consultation", data: { event: c.status === "confirmed" ? "confirmed" : "requested", name: c.name, when: sched.labelOf(c), code: c.confirmation_code } } as never, now),
        c.status === "confirmed" ? "The consultation confirmation has been emailed." : "The consultation request details have been emailed; a team member will confirm the time.");
    }
    case "follow_up": {
      const fu = await db.prepare(`SELECT kind, due_at, notes FROM sales_followups WHERE lead_id = ? AND status IN ('scheduled','requested','pending_eligibility') ORDER BY created_at DESC LIMIT 1`).bind(b.row.lead_id).first<{ kind: string; due_at: string | null; notes: string | null }>();
      if (!fu) return { status: 200, body: { sent: false, reason: "no_follow_up_agreed", message: "Agree a follow-up first with schedule_sales_followup; a follow-up email is only sent for an agreed follow-up." } };
      const when = fu.due_at ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" }).format(new Date(fu.due_at)).replace(/^/, "on ") : null;
      return done(await sendSalesMail(db, deps, b, "follow_up", a.email, { template: "sales_info", data: { event: "follow_up", name, when, url: deps.baseUrl } } as never, now), "A follow-up note has been emailed.");
    }
    case "onboarding_instructions": {
      const ps = await paymentStatus(db, b, undefined);
      if (ps.payment_status !== "paid") return { status: 200, body: { sent: false, reason: "payment_not_confirmed", message: "Onboarding instructions are sent only after Stripe confirms payment." } };
      return done(await sendSalesMail(db, deps, b, "onboarding_instructions", a.email, { template: "sales_info", data: { event: "onboarding_instructions", name, url: `${deps.baseUrl}/portal` } } as never, now), "Onboarding instructions have been emailed.");
    }
  }
  return say(422, "Unsupported email type.");
}

async function scheduleFollowup(db: Db, deps: SalesFnDeps, b: Bound, input: { followup_type: string; start_time?: string; preferred_date?: string; preferred_time?: string; name?: string; email?: string; topic?: string; wants_founder?: boolean }, now: Date): Promise<SalesFnResult> {
  const leadId = b.row.lead_id;
  // Dual calendars: the Founder calendar only on an explicit request (src/domain/calendars.ts). An automated AI call
  // cannot be "the Founder", so a Founder request made as ai_follow_up_call becomes a Founder staff callback.
  const route = routeCalendar({ wantsFounder: input.wants_founder, context: { channel: "outbound_sales", fn: "schedule_sales_followup", kind: input.followup_type } });
  const a = route.calendar === "founder_callback" && input.followup_type === "ai_follow_up_call" ? { ...input, followup_type: "staff_callback" } : input;
  const open = await db.prepare(`SELECT id, status, due_at FROM sales_followups WHERE lead_id = ? AND kind = ? AND status IN ('scheduled','requested','pending_eligibility')`).bind(leadId, a.followup_type).first<{ id: string; status: string; due_at: string | null }>();
  if (open) return { status: 200, body: { scheduled: false, already_scheduled: true, status: open.status, message: "A follow-up of this kind is already arranged; no second one was created." } };
  const at = nowIso(() => now);
  if (a.followup_type === "consultation") {
    const cfg = await loadVoiceConfig(db);
    const cal = deps.calendar ?? sched.NO_CALENDAR;
    if (!a.start_time) {
      const av = await sched.availability(db, cfg, now, cal, { fromDate: a.preferred_date });
      if (!av.available) return { status: 200, body: { scheduled: false, reason: av.reason, message: "Consultations can't be booked by phone right now. Offer a staff callback instead (followup_type staff_callback)." } };
      return { status: 200, body: { scheduled: false, needs_time: true, timezone: av.timezone, slots: av.slots.map((x) => ({ start_time: x.startsAt, label: x.label })), message: "Offer only these times. When the prospect chooses one, call again with its start_time." } };
    }
    const phone = b.facts.phoneE164;
    if (!phone || !cfg.scheduling.enabled || !cfg.timezone) return { status: 200, body: { scheduled: false, reason: "scheduling_disabled", message: "Consultations can't be booked by phone right now. Offer a staff callback instead." } };
    try {
      const { booking, existing } = await sched.book(db, cfg, now, cal, { name: a.name ?? b.facts.contactName ?? b.facts.businessName ?? "Prospect", phone, email: a.email ?? null, startsAt: a.start_time, topic: a.topic ?? "Website project (outbound sales call)", leadId, callId: null, isTest: b.isTest, source: "ai_receptionist", checkExisting: true, calendar: route });
      if (existing) return { status: 200, body: { scheduled: false, already_booked: true, message: "This business already has an upcoming consultation." } };
      // Only a booking the database holds on the routed calendar is ever reported as scheduled.
      const held = await confirmedConsultation(db, booking.id);
      if (!held || held.calendar !== route.calendar) return { status: 200, body: { scheduled: false, reason: "not_recorded", message: "That booking could not be saved. Apologise and offer a staff callback instead." } };
      await db.prepare(`INSERT INTO sales_followups (id, lead_id, kind, status, due_at, consultation_id, provider_call_id, created_at, updated_at) VALUES (?,?, 'consultation', ?, ?, ?, ?, ?, ?)`)
        .bind(newId("sfu"), leadId, booking.status === "confirmed" ? "scheduled" : "requested", booking.starts_at, booking.id, b.providerCallId, at, at).run();
      await addLeadNote(db, leadId, `Consultation ${booking.status} for ${sched.labelOf(booking)} (ref ${booking.confirmation_code}) on AI sales call ${b.row.id} · calendar: ${CALENDAR_LABELS[held.calendar].name}`);
      if (booking.status === "requested") await addLeadTask(db, leadId, `${held.calendar === "founder_callback" ? "[FOUNDER CALLBACK] " : ""}Confirm or decline the consultation requested for ${sched.labelOf(booking)} (ref ${booking.confirmation_code}) on an AI sales call.`, 4);
      return { status: 200, body: { scheduled: true, confirmed: booking.status === "confirmed", status: booking.status, when: sched.labelOf(booking), confirmation_code: booking.confirmation_code, calendar: held.calendar,
        message: booking.status === "confirmed" ? `Booked for ${sched.labelOf(booking)}. Read the booking reference letter by letter.` : "The time is held, NOT confirmed. Say a team member will confirm it. Read the booking reference letter by letter." } };
    } catch (e) {
      if (!(e instanceof sched.SlotUnavailableError)) throw e;
      return { status: 200, body: { scheduled: false, reason: e.message, message: "That time isn't available. Ask for another and check availability again." } };
    }
  }
  const window = a.preferred_time && a.preferred_time !== "any" ? a.preferred_time : null;
  const due = a.preferred_date ? new Date(`${a.preferred_date}T${window === "afternoon" ? "17" : window === "evening" ? "21" : "14"}:00:00.000Z`) : null;
  if (due && (Number.isNaN(due.getTime()) || due.getTime() < now.getTime() - 86_400_000 || due.getTime() > now.getTime() + 90 * 86_400_000)) return say(422, "The follow-up date must be within the next 90 days.");
  if (a.followup_type === "staff_callback") {
    const id = newId("sfu");
    const hours = due ? Math.max(1, Math.round((due.getTime() - now.getTime()) / 3_600_000)) : 24;
    // The follow-up, its CRM task and its calendar entry are one transaction, read back before anything is promised.
    const entry = await recordCallback(db, { route, kind: "sales_staff_callback", source: "ai_sales", leadId, providerCallId: b.providerCallId, salesFollowupId: id, isTest: b.isTest,
      dueAt: new Date(Date.now() + hours * 3_600_000),
      extra: [db.prepare(`INSERT INTO sales_followups (id, lead_id, kind, status, due_at, notes, provider_call_id, created_at, updated_at) VALUES (?,?, 'staff_callback', 'scheduled', ?, ?, ?, ?, ?)`)
        .bind(id, leadId, due?.toISOString() ?? null, a.topic ?? null, b.providerCallId, at, at)],
      taskBody: `${b.isTest ? "[TEST] " : ""}Call ${b.facts.contactName ?? b.facts.businessName ?? "the prospect"} back${a.preferred_date ? ` on ${a.preferred_date}` : ""}${window ? ` (${window})` : ""} as agreed on AI sales call ${b.row.id}${a.topic ? `: ${a.topic}` : ""}.` });
    return { status: 200, body: { scheduled: true, followup_type: "staff_callback", calendar: entry.calendar, when: a.preferred_date ?? null,
      message: entry.calendar === "founder_callback"
        ? "The request to speak with the Founder is recorded. Say the Founder or a team member will call back as agreed. Don't promise an exact time."
        : "A team member will call back as agreed. Don't promise an exact time beyond what the prospect asked for." } };
  }
  // ai_follow_up_call: queued, but the full compliance gate runs again at dial time; nothing is promised as confirmed.
  const row = await enqueueSalesCall(db, leadId, { requestedBy: null, notBefore: due?.toISOString() ?? new Date(now.getTime() + 48 * 3_600_000).toISOString(), now, isTest: b.isTest }).catch(() => null);
  const status = row && row.status === "queued" && row.id !== b.row.id ? "pending_eligibility" : "requested";
  const sfuId = newId("sfu");
  const entry = await recordCallback(db, { route, kind: "sales_ai_follow_up", source: "ai_sales", leadId, providerCallId: b.providerCallId, salesFollowupId: sfuId, isTest: b.isTest,
    dueAt: status === "requested" ? new Date(Date.now() + 48 * 3_600_000) : due ?? new Date(now.getTime() + 48 * 3_600_000),
    extra: [db.prepare(`INSERT INTO sales_followups (id, lead_id, kind, status, due_at, sales_call_id, notes, provider_call_id, created_at, updated_at) VALUES (?,?, 'ai_follow_up_call', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(sfuId, leadId, status, due?.toISOString() ?? null, row?.id ?? null, a.topic ?? null, b.providerCallId, at, at)],
    taskBody: status === "requested" ? `${b.isTest ? "[TEST] " : ""}Prospect agreed to a follow-up call${a.preferred_date ? ` on ${a.preferred_date}` : ""}. An automated call could not be queued; call them personally.` : null });
  return { status: 200, body: { scheduled: true, calendar: entry.calendar, followup_type: status === "pending_eligibility" ? "ai_follow_up_call" : "staff_callback", confirmed: false,
    message: "Say someone from Crestmont will follow up around the time they asked. Do not promise an exact time." } };
}

// ───────────── Dispatcher ─────────────

/** Handles one verified Retell custom-function request for the outbound sales agent. */
export async function handleSalesFunction(db: Db, raw: string, queryLeadId: string | null, deps: SalesFnDeps): Promise<SalesFnResult> {
  const json = obj(JSON.parse(raw));
  const name = str(json, "name");
  const call = obj(json.call);
  const callId = str(call, "call_id");
  if (!name) return say(422, "Configure the function with the default payload (not \"args only\").");
  if (!callId || !/^[A-Za-z0-9._:-]{1,120}$/.test(callId)) return say(422, "call.call_id missing or invalid");
  if (!(SALES_FUNCTIONS as readonly string[]).includes(name)) return say(422, "Unknown function.", { refused: "unknown_function" });
  const meta = obj(call.metadata);
  if (typeof meta.crestmont_env === "string" && meta.crestmont_env !== deps.environment) {
    await audit(db, { actorKind: "webhook", action: "voice.environment_mismatch", subjectType: "call", subjectId: callId, details: { stamped: String(meta.crestmont_env).slice(0, 20), here: deps.environment, function: name } });
    return say(409, "This line is not set up correctly. Apologise and end the call politely.");
  }
  const fn = name as SalesFunction;
  const args = normaliseArgs(json.args);
  const bound = await bind(db, call, args, queryLeadId && LEAD_ID.test(queryLeadId) ? queryLeadId : null);
  if ("status" in bound) return bound;
  const now = deps.now?.() ?? new Date();
  // Idempotency: Retell sends no invocation id. Write functions replay their stored result for an identical retry;
  // read-only ones always answer fresh. A stored failure is re-run.
  const key = READ_ONLY.has(fn) ? `${fn}:${newId("ro")}` : `${fn}:${(await sha256Hex(JSON.stringify(args))).slice(0, 40)}`;
  const claimed = await db.prepare(`INSERT INTO sales_function_events (provider_call_id, event_key, name, status, created_at) VALUES (?,?,?, 'ok', ?) ON CONFLICT(provider_call_id, event_key) DO NOTHING`).bind(callId, key, fn, nowIso()).run();
  if (claimed.meta.changes !== 1) {
    const prev = await db.prepare(`SELECT status, result_json FROM sales_function_events WHERE provider_call_id = ? AND event_key = ?`).bind(callId, key).first<{ status: string; result_json: string | null }>();
    if (prev?.status === "ok" && prev.result_json) return { status: 200, body: { ...JSON.parse(prev.result_json), duplicate: true } };
    await db.prepare(`UPDATE sales_function_events SET status = 'ok', result_json = NULL WHERE provider_call_id = ? AND event_key = ?`).bind(callId, key).run();
  }
  const finish = async (r: SalesFnResult) => {
    // The stored replay never holds the bearer link itself.
    const stored = { ...r.body }; delete stored.checkout_url;
    // Only an action that happened is replayed. A refusal ("verify the email first", "no follow-up agreed yet") is kept
    // as 'error' so the same request is evaluated afresh once the prospect's situation has changed during the call.
    const refused = r.body.sent === false || r.body.checkout_link_sent === false || r.body.scheduled === false;
    await db.prepare(`UPDATE sales_function_events SET status = ?, result_json = ? WHERE provider_call_id = ? AND event_key = ?`).bind(r.status < 300 && !refused ? "ok" : "error", JSON.stringify(stored), callId, key).run();
    return r;
  };
  try {
    switch (fn) {
      case "get_outbound_lead_context": parse(schemas.get_outbound_lead_context, args); return finish({ status: 200, body: await getLeadContext(db, bound, now) });
      case "update_outbound_lead": {
        const a = parse(schemas.update_outbound_lead, args);
        return finish({ status: 200, body: await updateLead(db, bound, { ...a, service_interests: args.service_interests, objections: args.objections }) });
      }
      case "get_packages_pricing": return finish({ status: 200, body: await packagesPricing(db, now) });
      case "create_checkout_session": { const a = parse(schemas.create_checkout_session, args); return finish(await createCheckout(db, deps, bound, a, now)); }
      case "check_payment_status": { const a = parse(schemas.check_payment_status, args); return finish({ status: 200, body: await paymentStatus(db, bound, a.checkout_reference) }); }
      case "send_sales_email": { const a = parse(schemas.send_sales_email, args); return finish(await sendEmail(db, deps, bound, a, now)); }
      case "schedule_sales_followup": { const a = parse(schemas.schedule_sales_followup, args); return finish(await scheduleFollowup(db, deps, bound, a, now)); }
      case "record_do_not_call": {
        const a = parse(schemas.record_do_not_call, args);
        const phone = toE164(a.phone) ?? bound.facts.phoneE164 ?? bound.row.phone_e164;
        const contactEmail = a.also_stop_email === "true" ? [...await verifiedEmails(db, bound)][0] ?? null : null;
        const r = await suppressEverywhere(db, phone, { leadId: bound.row.lead_id, email: contactEmail, detail: `Requested on AI sales call ${bound.row.id}`, actor: "ai" });
        await db.prepare(`UPDATE sales_calls SET disposition = 'do_not_call' WHERE id = ?`).bind(bound.row.id).run();
        await audit(db, { actorKind: "ai", action: "sales_outbound.do_not_call", subjectType: "sales_call", subjectId: bound.row.id, details: { phoneLast4: phone.slice(-4), email: !!contactEmail, ...r } });
        return finish({ status: 200, body: { recorded: true, suppressed_for: ["all outbound calls", ...(contactEmail ? ["sales email"] : [])], confirmation: "Understood. We've removed this number from our call list and won't call again.",
          message: "Confirm to the person that they won't be called again, thank them, and end the call. Do not continue selling." } });
      }
    }
  } catch (e) {
    if (e instanceof ValidationError) return finish({ status: 422, body: { ok: false, message: "I couldn't complete that.", detail: e.issues.join("; ") } });
    await audit(db, { actorKind: "ai", action: "sales_outbound.function_error", subjectType: "sales_call", subjectId: bound.row.id, details: { fn, error: (e as Error).message.slice(0, 300) } });
    return finish({ status: 500, body: { ok: false, message: "I couldn't complete that. A team member will follow up." } });
  }
}

// ───────────── Public link handlers (used by src/routes/sales-outbound.ts) ─────────────

/** Resolves a purchase link token. Returns the package to send the buyer to, or why the link is not usable. */
export async function openCheckoutLink(db: Db, token: string, now: Date): Promise<{ ok: true; packageId: string; linkId: string; expiresAt: string } | { ok: false; reason: "invalid" | "expired" | "revoked" }> {
  if (!/^[0-9a-f]{64}$/.test(token)) return { ok: false, reason: "invalid" };
  const l = await db.prepare(`SELECT id, package_id, expires_at, revoked_at, clicked_at FROM sales_checkout_links WHERE token_hash = ?`).bind(await hashToken(token)).first<{ id: string; package_id: string; expires_at: string; revoked_at: string | null; clicked_at: string | null }>();
  if (!l) return { ok: false, reason: "invalid" };
  if (l.revoked_at) return { ok: false, reason: "revoked" };
  if (l.expires_at < now.toISOString()) return { ok: false, reason: "expired" };
  if (!l.clicked_at) await db.prepare(`UPDATE sales_checkout_links SET clicked_at = ? WHERE id = ? AND clicked_at IS NULL`).bind(now.toISOString(), l.id).run();
  return { ok: true, packageId: l.package_id, linkId: l.id, expiresAt: l.expires_at };
}

/**
 * Cookie set by GET /buy/:token: the purchase-link token itself (a 256-bit bearer secret already emailed to the verified
 * buyer), HttpOnly + SameSite=Lax, until the link expires. It survives sign-in/sign-up so checkout can bind the order to
 * the CRM lead the link was issued for (billing.ts#startPackageCheckout), instead of guessing the lead by email.
 */
export const SALES_LINK_COOKIE = "crestmont_sales_link";

export interface SalesLinkBinding { linkId: string; leadId: string; email: string; packageId: string }

/** The purchase link behind a checkout, if the token is valid, unexpired, unrevoked and for this package. */
export async function salesLinkForCheckout(db: Db, token: string | undefined, packageId: string, now: Date): Promise<SalesLinkBinding | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const l = await db.prepare(`SELECT id, lead_id, email, package_id, expires_at, revoked_at FROM sales_checkout_links WHERE token_hash = ?`).bind(await hashToken(token))
    .first<{ id: string; lead_id: string; email: string; package_id: string; expires_at: string; revoked_at: string | null }>();
  if (!l || l.revoked_at || l.expires_at < now.toISOString() || l.package_id !== packageId) return null;
  return { linkId: l.id, leadId: l.lead_id, email: l.email, packageId: l.package_id };
}

/** One-click unsubscribe from sales email (CAN-SPAM). Idempotent; reveals nothing about the address. */
export async function unsubscribeSalesEmail(db: Db, token: string): Promise<boolean> {
  if (!/^[0-9a-f]{48}$/.test(token)) return false;
  const row = await db.prepare(`SELECT recipient, lead_id FROM sales_emails WHERE unsubscribe_token_hash = ?`).bind(await hashToken(token)).first<{ recipient: string; lead_id: string }>();
  if (!row) return false;
  const r = await db.prepare(`INSERT INTO sales_email_optouts (email, source, created_at) VALUES (?, 'unsubscribe_link', ?) ON CONFLICT(email) DO NOTHING`).bind(row.recipient, nowIso()).run();
  if (r.meta.changes === 1) {
    await addLeadNote(db, row.lead_id, "Prospect unsubscribed from sales email (link in a sales email).");
    await audit(db, { actorKind: "user", action: "sales_outbound.email_unsubscribed", subjectType: "lead", subjectId: row.lead_id });
  }
  return true;
}

