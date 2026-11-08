// Outbound AI sales representative — orchestration (OUTSALES-001..009, proposed). DISABLED BY DEFAULT.
//
//   select lead → compliance gate → research context → create-phone-call (dynamic variables, signed metadata)
//   → call row linked to the CRM lead → Retell webhook (call_ended / call_analyzed) → final outcome + CRM + follow-up
//
// Separation of concerns:
//  - The compliance gate is the pure function salesCallEligibility() (src/domain/sales-eligibility.ts). It is evaluated
//    when a lead is queued AND again immediately before every dial. Sales logic never decides eligibility.
//  - This file never shares a switch with the receptionist's consented follow-up calls (voice-outbound.ts):
//    RETELL_SALES_OUTBOUND (env) + sales_outbound_settings.enabled (Owner) + an active compliance approval (Founder,
//    counsel reference) must all be on. The number-level lease (outreach ledger) and voice_dnc ARE shared, so a sales
//    call and a follow-up call can never overlap on one number and one opt-out stops both.
//  - Concurrency, per-run and per-day limits are enforced here; Retell's own workspace concurrency (20 on
//    pay-as-you-go, shared with the receptionist) is the outer bound, not a target.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { Env } from "../app/context.ts";
import { audit } from "./security.ts";
import { toE164, validTimeZone, loadVoiceConfig, slotLabel } from "./voice-settings.ts";
import { createRetellPhoneCall, RETELL_PROVIDER } from "../adapters/retell.ts";
import { retellKey, keysAmbiguous } from "../adapters/retell-workspaces.ts";
import { addLeadNote, addLeadTask, notifyOwners } from "./voice-common.ts";
import { addDnc, isDnc } from "./voice-outbound.ts";
import { voiceBudget, budgetOpen, noteBudgetClosed } from "./voice-budget.ts";
import { reservePhone, releasePhone, markDialing, recordPhoneOutcome } from "./outreach-ledger.ts";
import { suppressionFor } from "./contact-identity.ts";
import { activeAppointmentFor, queueMissingCallbacks } from "./appointment-callbacks.ts";
import { applySuppressions } from "./research.ts";
import { timeZoneForState } from "../domain/research.ts";
import { listTargets, deployedVersion } from "./sales-opt/registry.ts";
import { experimentRouting } from "./sales-opt/monitor.ts";
import {
  capacityPlan, allocationShortfall, parseStageLimits, stageLimitProblems, isStageIncrease, callbackEligibility, callbackMissed,
  COLD_MAX_CONCURRENT, COLD_STAGES, COLD_STAGE_LABELS, CALLBACK_MAX_ATTEMPTS, CALLBACK_RETRY_MS, MODE_LABELS,
  type OutboundMode, type ColdStage, type CapacityPlan,
} from "../domain/outbound-capacity.ts";
import {
  salesCallEligibility, spokenContext, dynamicVariables, withinSalesWindow, nextSalesWindow, resolveOutcome,
  type SalesGate, type ResearchFinding, type SpokenContext, type SalesOutcome,
} from "../domain/sales-eligibility.ts";

export const SALES_OUTBOUND_ENV_FLAG = "RETELL_SALES_OUTBOUND";
export const SALES_PURPOSE = "ai_voice_sales";
/** The outreach ledger's ref-type CHECK allows one value; sales leases are told apart by the scall_ id and purpose. */
const leaseRef = (id: string) => ({ type: "voice_outbound_request" as const, id });
export const SALES_STALE_DIALING_MS = 3 * 3_600_000;
export const SALES_LEASE_MS = SALES_STALE_DIALING_MS + 30 * 60_000;
const MAX_TRANSIENT_FAILURES = 3;

export class SalesOutboundError extends Error {
  status: number;
  constructor(msg: string, status = 422) { super(msg); this.status = status; }
}

// ───────────── Settings and records (Owner) ─────────────

/**
 * `enabled` is the AI Cold Outreach switch and `callbacks_enabled` the Scheduled AI Callbacks switch (migration 0090):
 * two independent Owner switches on /staff/sales-outbound. `max_concurrent` is the cold-outreach concurrency (≤ 15),
 * `callback_reserved` the slots only callbacks may use. `max_dials_per_day` is kept for history; cold outreach's daily
 * volume is the ramp stage (cold_stage, cold_stage_limits_json) and callbacks have callback_max_per_day.
 */
export interface SalesSettings { enabled: number; callbacks_enabled: number; agent_id: string | null; from_number: string | null; max_concurrent: number; callback_reserved: number;
  provider_concurrency_limit: number; inbound_shares_capacity: number; inbound_headroom: number; cold_stage: ColdStage; cold_stage_limits_json: string; callback_max_per_day: number;
  max_dials_per_run: number; max_dials_per_day: number; max_attempts_per_lead: number; retry_after_hours: number; updated_by: string | null; updated_at: string }

export async function loadSalesSettings(db: Db): Promise<SalesSettings> {
  return (await db.prepare(`SELECT * FROM sales_outbound_settings WHERE id = 1`).first<SalesSettings>())!;
}

const AGENT_ID = /^[A-Za-z0-9_-]{4,80}$/;

export async function saveSalesSettings(db: Db, userId: string, i: { enabled: boolean; agentId: string; fromNumber: string; maxConcurrent: number; maxPerRun: number; maxPerDay: number; maxAttempts: number; retryAfterHours: number }): Promise<string[]> {
  const problems: string[] = [];
  const agentId = i.agentId.trim(), from = i.fromNumber.trim() ? toE164(i.fromNumber) : null;
  if (agentId && !AGENT_ID.test(agentId)) problems.push("Sales agent id has an invalid format");
  if (i.fromNumber.trim() && !from) problems.push("Caller number must be a dialable E.164 number");
  if (from && !from.startsWith("+1")) problems.push("Caller number must be a US (+1) number");
  const inRange = (n: number, lo: number, hi: number, what: string) => { if (!Number.isInteger(n) || n < lo || n > hi) problems.push(`${what} must be ${lo}–${hi}`); };
  inRange(i.maxConcurrent, 1, COLD_MAX_CONCURRENT, "Concurrent cold-outreach calls"); inRange(i.maxPerRun, 1, 20, "Dials per run"); inRange(i.maxPerDay, 1, 500, "Dials per day");
  inRange(i.maxAttempts, 1, 3, "Attempts per lead"); inRange(i.retryAfterHours, 4, 720, "Hours between attempts");
  if (i.enabled && (!agentId || !from)) problems.push("Outbound sales can only be switched on with a sales agent id and an approved caller number");
  if (agentId) {
    // The receptionist's agent must never be recorded as the sales agent, switched on or not: it carries receptionist
    // guardrails, and the receptionist's prompt sync refuses agents recorded here (PR #72), so the overlap would block it.
    const cfg = await loadVoiceConfig(db);
    if (cfg.inbound.agent_id === agentId || cfg.outbound.agent_id === agentId) problems.push("The sales agent must be a separate Retell agent from the receptionist and its follow-up agent");
  }
  if (problems.length) return problems;
  await db.prepare(`UPDATE sales_outbound_settings SET enabled = ?, agent_id = ?, from_number = ?, max_concurrent = ?, max_dials_per_run = ?, max_dials_per_day = ?, max_attempts_per_lead = ?, retry_after_hours = ?, updated_by = ?, updated_at = ? WHERE id = 1`)
    .bind(i.enabled ? 1 : 0, agentId || null, from, i.maxConcurrent, i.maxPerRun, i.maxPerDay, i.maxAttempts, i.retryAfterHours, userId, nowIso()).run();
  await audit(db, { actorUserId: userId, action: "sales_outbound.settings_updated", subjectType: "sales_outbound_settings", subjectId: "1", details: { enabled: i.enabled, maxConcurrent: i.maxConcurrent, maxPerDay: i.maxPerDay } });
  return [];
}

export async function activeComplianceApproval(db: Db): Promise<{ id: string; approvedBy: string; approvedAt: string; reference: string } | null> {
  const r = await db.prepare(`SELECT id, approved_by, approved_at, counsel_reference FROM sales_compliance_approvals WHERE scope = 'ai_voice_sales_outbound' AND revoked_at IS NULL`)
    .first<{ id: string; approved_by: string; approved_at: string; counsel_reference: string }>();
  return r ? { id: r.id, approvedBy: r.approved_by, approvedAt: r.approved_at, reference: r.counsel_reference } : null;
}

export async function recordComplianceApproval(db: Db, userId: string, counselReference: string, notes: string): Promise<string> {
  const ref = counselReference.trim();
  if (ref.length < 4 || ref.length > 200) throw new SalesOutboundError("Enter counsel's reference for the approved consent design (4–200 characters)");
  if (await activeComplianceApproval(db)) throw new SalesOutboundError("An approval is already active; revoke it first", 409);
  const id = newId("sca");
  await db.prepare(`INSERT INTO sales_compliance_approvals (id, scope, approved_by, counsel_reference, notes, approved_at) VALUES (?, 'ai_voice_sales_outbound', ?, ?, ?, ?)`)
    .bind(id, userId, ref, notes.trim().slice(0, 1000) || null, nowIso()).run();
  await audit(db, { actorUserId: userId, action: "sales_outbound.compliance_approved", subjectType: "sales_compliance_approval", subjectId: id, details: { reference: ref } });
  return id;
}

export async function revokeComplianceApproval(db: Db, userId: string): Promise<boolean> {
  const at = nowIso();
  const r = await db.prepare(`UPDATE sales_compliance_approvals SET revoked_at = ?, revoked_by = ? WHERE scope = 'ai_voice_sales_outbound' AND revoked_at IS NULL`).bind(at, userId).run();
  // Revoking the approval stops everything queued at once; nothing already dialling is interrupted (Retell owns it).
  await db.prepare(`UPDATE sales_calls SET status = 'cancelled', status_detail = 'Compliance approval revoked', updated_at = ? WHERE status = 'queued'`).bind(at).run();
  await audit(db, { actorUserId: userId, action: "sales_outbound.compliance_revoked", subjectType: "sales_compliance_approval", subjectId: "active", details: { changed: r.meta.changes } });
  return r.meta.changes === 1;
}

// ───────────── The two calling modes, capacity and the cold-outreach ramp (Owner) ─────────────

/** One Owner switch per mode, saved together from the same page. Takes effect on the next dispatch run. */
export async function saveOutboundModes(db: Db, userId: string, i: { callbacks: boolean; cold: boolean }): Promise<string[]> {
  const s = await loadSalesSettings(db);
  const problems: string[] = [];
  // Switching a mode ON needs the agent and number it would dial with; switching OFF is always allowed.
  if ((i.callbacks && !s.callbacks_enabled) || (i.cold && !s.enabled)) {
    if (!s.agent_id || !s.from_number) problems.push("A mode can only be switched on once the sales agent id and the approved caller number are saved");
  }
  if (problems.length) return problems;
  await db.prepare(`UPDATE sales_outbound_settings SET callbacks_enabled = ?, enabled = ?, updated_by = ?, updated_at = ? WHERE id = 1`).bind(i.callbacks ? 1 : 0, i.cold ? 1 : 0, userId, nowIso()).run();
  await audit(db, { actorUserId: userId, action: "sales_outbound.modes_updated", subjectType: "sales_outbound_settings", subjectId: "1",
    details: { callbacks: { from: !!s.callbacks_enabled, to: i.callbacks }, cold: { from: !!s.enabled, to: i.cold } } });
  return [];
}

/** Concurrency allocation and the provider's real limit. */
export async function saveCapacitySettings(db: Db, userId: string, i: { coldMax: number; callbackReserved: number; providerLimit: number; inboundShares: boolean; inboundHeadroom: number; callbackMaxPerDay: number }): Promise<string[]> {
  const p: string[] = [];
  const inRange = (n: number, lo: number, hi: number, what: string) => { if (!Number.isInteger(n) || n < lo || n > hi) p.push(`${what} must be ${lo}–${hi}`); };
  inRange(i.coldMax, 1, COLD_MAX_CONCURRENT, "Concurrent cold-outreach calls"); inRange(i.callbackReserved, 1, 5, "Reserved callback calls");
  inRange(i.providerLimit, 1, 200, "Provider concurrency limit"); inRange(i.inboundHeadroom, 0, 20, "Lines kept free for inbound"); inRange(i.callbackMaxPerDay, 1, 1000, "Callbacks per day");
  if (p.length) return p;
  await db.prepare(`UPDATE sales_outbound_settings SET max_concurrent = ?, callback_reserved = ?, provider_concurrency_limit = ?, inbound_shares_capacity = ?, inbound_headroom = ?, callback_max_per_day = ?, updated_by = ?, updated_at = ? WHERE id = 1`)
    .bind(i.coldMax, i.callbackReserved, i.providerLimit, i.inboundShares ? 1 : 0, i.inboundHeadroom, i.callbackMaxPerDay, userId, nowIso()).run();
  await audit(db, { actorUserId: userId, action: "sales_outbound.capacity_updated", subjectType: "sales_outbound_settings", subjectId: "1", details: i });
  return [];
}

/**
 * The cold-outreach ramp. Every move is the Founder's decision (Owner-only route) and audited; nothing moves it by
 * itself. An increase additionally needs the typed confirmation so a stray click cannot raise volume.
 */
export async function saveColdStage(db: Db, userId: string, i: { stage: string; limits: Record<string, number>; confirmIncrease: boolean }): Promise<string[]> {
  if (!(COLD_STAGES as readonly string[]).includes(i.stage)) return ["Unknown ramp stage"];
  const p = stageLimitProblems(i.limits);
  const s = await loadSalesSettings(db);
  const before = parseStageLimits(s.cold_stage_limits_json);
  const to = i.stage as ColdStage;
  const raises = isStageIncrease(s.cold_stage, to) || COLD_STAGES.some((x) => i.limits[x] > before[x]);
  if (raises && !i.confirmIncrease) p.push("Raising cold-outreach volume needs the Founder's confirmation (tick the authorisation box)");
  if (p.length) return p;
  const limits = Object.fromEntries(COLD_STAGES.map((x) => [x, i.limits[x]]));
  await db.prepare(`UPDATE sales_outbound_settings SET cold_stage = ?, cold_stage_limits_json = ?, updated_by = ?, updated_at = ? WHERE id = 1`).bind(to, JSON.stringify(limits), userId, nowIso()).run();
  await audit(db, { actorUserId: userId, action: raises ? "sales_outbound.ramp_increased" : "sales_outbound.ramp_updated", subjectType: "sales_outbound_settings", subjectId: "1",
    details: { from: s.cold_stage, to, limit: limits[to], limits } });
  return [];
}

export const coldDailyLimit = (s: Pick<SalesSettings, "cold_stage" | "cold_stage_limits_json">) => parseStageLimits(s.cold_stage_limits_json)[s.cold_stage];
export { COLD_STAGES, COLD_STAGE_LABELS, MODE_LABELS };

export interface ConsentInput { phone: string; leadId?: string | null; lineType: string; signerName: string; evidenceRef: string; disclosureText: string; capturedAt: string }

/** Records documented prior express written consent for AI-voice sales calls to one number (staff, with evidence). */
export async function recordSalesConsent(db: Db, userId: string, i: ConsentInput, now: Date = new Date()): Promise<string> {
  const phone = toE164(i.phone);
  const problems: string[] = [];
  if (!phone || !phone.startsWith("+1")) problems.push("Enter the US number the consent covers (E.164)");
  if (!["mobile", "landline", "voip"].includes(i.lineType)) problems.push("Line type must be mobile, landline or voip");
  if (i.signerName.trim().length < 2) problems.push("Enter the name of the person who signed");
  if (i.evidenceRef.trim().length < 6) problems.push("Enter the reference to the signed consent record (form submission id, e-signature reference)");
  if (i.disclosureText.trim().length < 40 || !/artificial|AI|automated|prerecorded/i.test(i.disclosureText)) problems.push("Paste the exact consent language; it must disclose AI / artificial-voice calls");
  if (!/^\d{4}-\d{2}-\d{2}/.test(i.capturedAt) || Number.isNaN(Date.parse(i.capturedAt)) || Date.parse(i.capturedAt) > now.getTime() + 60_000) problems.push("Enter when consent was given (not in the future)");
  if (problems.length) throw new SalesOutboundError(problems.join(" "));
  if (await isDnc(db, phone!)) throw new SalesOutboundError("This number is on the do-not-call list; a new opt-in must be handled by a person", 409);
  const leadId = i.leadId?.trim() || null;
  if (leadId && !(await db.prepare(`SELECT 1 AS x FROM leads WHERE id = ?`).bind(leadId.slice(0, 64)).first())) throw new SalesOutboundError("That CRM lead id does not exist");
  const id = newId("scc");
  await db.prepare(`INSERT INTO sales_call_consents (id, phone_e164, lead_id, consent_type, covers_ai_voice, line_type, signer_name, evidence_ref, disclosure_text, captured_at, recorded_by, recorded_at)
      VALUES (?,?,?, 'prior_express_written', 1, ?,?,?,?,?,?,?)`).bind(id, phone, leadId, i.lineType, i.signerName.trim().slice(0, 120), i.evidenceRef.trim().slice(0, 300), i.disclosureText.trim().slice(0, 4000), new Date(i.capturedAt).toISOString(), userId, nowIso()).run();
  await audit(db, { actorUserId: userId, action: "sales_outbound.consent_recorded", subjectType: "sales_call_consent", subjectId: id, details: { phoneLast4: phone!.slice(-4), lineType: i.lineType } });
  return id;
}

export async function recordDncScrub(db: Db, userId: string | null, i: { phone: string; registry: "national" | "state"; result: "clear" | "listed"; sourceRef: string; checkedAt: string }, now: Date = new Date()): Promise<string> {
  const phone = toE164(i.phone);
  if (!phone) throw new SalesOutboundError("Enter a dialable number");
  if (!["national", "state"].includes(i.registry) || !["clear", "listed"].includes(i.result)) throw new SalesOutboundError("Registry must be national/state and result clear/listed");
  if (i.sourceRef.trim().length < 3) throw new SalesOutboundError("Enter the registry download or vendor reference");
  const checked = Date.parse(i.checkedAt);
  if (Number.isNaN(checked) || checked > now.getTime() + 60_000) throw new SalesOutboundError("Enter when the registry was checked (not in the future)");
  const id = newId("sds");
  await db.prepare(`INSERT INTO sales_dnc_scrubs (id, phone_e164, registry, result, source_ref, checked_at, recorded_by, recorded_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(id, phone, i.registry, i.result, i.sourceRef.trim().slice(0, 200), new Date(checked).toISOString(), userId, nowIso()).run();
  // A registry hit cancels anything queued for that number immediately.
  if (i.result === "listed") await db.prepare(`UPDATE sales_calls SET status = 'cancelled', status_detail = 'Number listed on a do-not-call registry', updated_at = ? WHERE phone_e164 = ? AND status = 'queued'`).bind(nowIso(), phone).run();
  await audit(db, { actorUserId: userId, actorKind: userId ? "user" : "system", action: "sales_outbound.dnc_scrub_recorded", subjectType: "sales_dnc_scrub", subjectId: id, details: { registry: i.registry, result: i.result, phoneLast4: phone.slice(-4) } });
  return id;
}

// ───────────── Lead facts ─────────────

export interface LeadFacts {
  leadId: string; stage: string; merged: boolean; interest: string | null; origin: string | null; isTest: boolean;
  contactId: string; contactName: string | null; contactEmail: string | null; contactPhone: string | null;
  businessName: string | null; industry: string | null; companyLocationNorm: string | null;
  prospect: { id: string; state: string | null; time_zone: string | null; phone_e164: string | null; shared_phone: number; website_class: string; website_url: string | null;
    findings_json: string; identity_confidence: number; last_verified_at: string; recommended_package: string | null; category: string | null; phone_status: string | null } | null;
  phoneE164: string | null; state: string | null; timeZone: string | null;
}

export async function leadFacts(db: Db, leadId: string): Promise<LeadFacts | null> {
  const l = await db.prepare(`SELECT l.id, l.stage, l.merged_into_lead_id, l.interest, l.origin, l.message, c.id AS contact_id, c.name AS contact_name, c.email, c.phone,
        co.name AS company_name, co.industry, co.location_norm
      FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id WHERE l.id = ?`).bind(leadId)
    .first<{ id: string; stage: string; merged_into_lead_id: string | null; interest: string | null; origin: string | null; message: string | null; contact_id: string; contact_name: string | null; email: string | null; phone: string | null; company_name: string | null; industry: string | null; location_norm: string | null }>();
  if (!l) return null;
  const prospect = await db.prepare(`SELECT id, state, time_zone, phone_e164, shared_phone, website_class, website_url, findings_json, identity_confidence, last_verified_at, recommended_package, category, phone_status
      FROM research_prospects WHERE crm_lead_id = ? ORDER BY updated_at DESC LIMIT 1`).bind(leadId).first<NonNullable<LeadFacts["prospect"]>>();
  const phoneE164 = toE164(l.phone) ?? prospect?.phone_e164 ?? null;
  const locState = l.location_norm ? (l.location_norm.split("|")[1] ?? "").toUpperCase() || null : null;
  const state = prospect?.state ?? (locState && /^[A-Z]{2}$/.test(locState) ? locState : null);
  const tz = prospect?.time_zone ?? timeZoneForState(state);
  // A research prospect's contact name is the business (no person known): never present it as a first name.
  const contactName = l.contact_name && l.company_name && l.contact_name.trim().toLowerCase() === l.company_name.trim().toLowerCase() ? null : l.contact_name;
  return {
    leadId: l.id, stage: l.stage, merged: !!l.merged_into_lead_id, interest: l.interest, origin: l.origin, isTest: /^\[TEST/.test(l.message ?? ""),
    contactId: l.contact_id, contactName, contactEmail: l.email, contactPhone: l.phone,
    businessName: l.company_name, industry: l.industry ?? prospect?.category ?? null, companyLocationNorm: l.location_norm,
    prospect: prospect ?? null, phoneE164, state, timeZone: tz && validTimeZone(tz) ? tz : null,
  };
}

export function researchContext(f: LeadFacts, now: Date): SpokenContext {
  const p = f.prospect;
  let findings: ResearchFinding[] = [];
  try { findings = p ? (JSON.parse(p.findings_json) as ResearchFinding[]) : []; } catch { findings = []; }
  return spokenContext({ websiteClass: p?.website_class ?? null, websiteUrl: p?.website_url ?? null, findings, identityConfidence: p?.identity_confidence ?? null,
    lastVerifiedAt: p?.last_verified_at ?? null, recommendedPackage: p?.recommended_package ?? (f.interest && ["starter", "business", "premium", "custom"].includes(f.interest) ? f.interest : null) }, now);
}

/** Evaluates the compliance gate for a lead from authoritative records. */
export async function gateFor(db: Db, f: LeadFacts, now: Date, attemptsSoFar = 0, maxAttempts?: number): Promise<SalesGate> {
  const phone = f.phoneE164;
  const settings = await loadSalesSettings(db);
  const consent = phone ? await db.prepare(`SELECT id, line_type, evidence_ref, captured_at FROM sales_call_consents WHERE phone_e164 = ? AND revoked_at IS NULL ORDER BY captured_at DESC LIMIT 1`).bind(phone)
    .first<{ id: string; line_type: "mobile" | "landline" | "voip"; evidence_ref: string; captured_at: string }>() : null;
  const scrub = phone ? await db.prepare(`SELECT result, checked_at FROM sales_dnc_scrubs WHERE phone_e164 = ? AND registry = 'national' ORDER BY checked_at DESC LIMIT 1`).bind(phone)
    .first<{ result: "clear" | "listed"; checked_at: string }>() : null;
  // A state registry hit at any time blocks as well.
  const stateListed = phone ? !!(await db.prepare(`SELECT 1 AS x FROM sales_dnc_scrubs WHERE phone_e164 = ? AND registry = 'state' AND result = 'listed'`).bind(phone).first()) : false;
  const supp = await suppressionFor(db, phone ? [phone] : [], f.contactEmail ? [f.contactEmail.toLowerCase()] : []);
  const gate = salesCallEligibility({
    phoneE164: phone, timeZone: f.timeZone, state: f.state, onDnc: phone ? await isDnc(db, phone) : false,
    complianceApproval: await activeComplianceApproval(db),
    consent: consent ? { id: consent.id, lineType: consent.line_type, evidenceRef: consent.evidence_ref, capturedAt: consent.captured_at } : null,
    dncScrub: scrub ? { result: stateListed ? "listed" : scrub.result, checkedAt: scrub.checked_at } : null,
    emailOrPhoneSuppressedInCrm: supp.phone || supp.erased,
    leadStage: f.stage, leadMerged: f.merged, sharedPhoneConflict: !!f.prospect?.shared_phone,
    attemptsSoFar, maxAttempts: maxAttempts ?? settings.max_attempts_per_lead,
  }, now);
  // A number Retell reported as invalid_destination stays blocked until staff verify a new one (B-2).
  const invalid = phone ? await db.prepare(`SELECT 1 AS x FROM research_prospects WHERE phone_e164 = ? AND phone_status = 'invalid'`).bind(phone).first() : null;
  if (invalid) return { ...gate, eligible: false, reasons: [...gate.reasons, "The number was reported invalid by the carrier on an earlier call; verify the business's number first"] };
  return gate;
}

// ───────────── Self-Improvement Engine attribution (dialler contract, docs/voice/SALES-OPTIMIZATION.md §5) ─────────────

export interface SieStamp { metadata: Record<string, string>; note: string }

/**
 * Metadata the SIE needs to attribute a sales call: crestmont_so_version (the version VERIFIED on the agent this call
 * uses), crestmont_so_experiment (only when the lead's experiment arm is that same version) and crestmont_segment.
 * Never stamps a version the call does not actually run: the SIE deploys to one agent per stage, so a candidate arm
 * that is not the deployed version cannot be served by this agent and the call is left out of the experiment
 * (it still attributes to the deployed version). Nothing is stamped when the sales agent is not the SIE target.
 */
export async function sieStamp(db: Db, environment: string, agentId: string, leadId: string, segment: string | null): Promise<SieStamp> {
  const stage = environment === "production" ? "production" : "staging";
  const md: Record<string, string> = {};
  if (segment && /^[a-z0-9_-]{1,40}$/.test(segment)) md.crestmont_segment = segment;
  const target = (await listTargets(db))[stage];
  if (!target || target.agent_id !== agentId) return { metadata: md, note: `sales agent is not the SIE ${stage} target: no version attribution` };
  const dep = await deployedVersion(db, stage);
  if (!dep) return { metadata: md, note: `no verified SIE deployment on ${stage}` };
  md.crestmont_so_version = dep.id;
  const route = await experimentRouting(db, leadId);
  if (route && route.versionId === dep.id) { md.crestmont_so_experiment = route.experimentId; return { metadata: md, note: `experiment ${route.experimentId} arm ${route.arm}` }; }
  return { metadata: md, note: route ? `experiment ${route.experimentId} routed this lead to ${route.arm} (${route.versionId}), which this agent does not run: left out of the experiment` : `version ${dep.id}` };
}

export interface SalesGateStatus { enabled: boolean; reasons: string[] }
export const outboundKeyConfigured = (env: Pick<Env, "RETELL_OUTBOUND_API_KEY">) => !!retellKey(env, "outbound");
export const SALES_CALLBACKS_ENV_FLAG = "RETELL_SALES_CALLBACKS";
type SwitchEnv = Pick<Env, "RETELL_OUTBOUND_API_KEY" | "RETELL_INBOUND_API_KEY" | "RETELL_SALES_OUTBOUND"> & { RETELL_SALES_CALLBACKS?: string };

/** What both modes need: the sales agent, its number and the sales workspace key (never the receptionist's). */
function commonReasons(s: SalesSettings, env: SwitchEnv): string[] {
  const reasons: string[] = [];
  if (!s.agent_id) reasons.push("No sales agent id");
  if (!s.from_number) reasons.push("No approved caller number");
  if (!retellKey(env, "outbound")) reasons.push("RETELL_OUTBOUND_API_KEY (the sales workspace key) is not set");
  if (keysAmbiguous(env)) reasons.push("RETELL_INBOUND_API_KEY and RETELL_OUTBOUND_API_KEY are identical: the two workspaces cannot be told apart");
  return reasons;
}

/** AI Cold Outreach: the environment flag, the Owner switch and an active counsel-referenced compliance approval. */
export async function salesOutboundSwitch(db: Db, env: SwitchEnv): Promise<SalesGateStatus> {
  const s = await loadSalesSettings(db);
  const reasons: string[] = [];
  if (env.RETELL_SALES_OUTBOUND !== "on") reasons.push(`${SALES_OUTBOUND_ENV_FLAG} is not "on" in this environment`);
  if (!s.enabled) reasons.push("AI Cold Outreach is off in the Owner's settings");
  reasons.push(...commonReasons(s, env));
  if (!(await activeComplianceApproval(db))) reasons.push("No active compliance approval for AI-voice sales calls (Founder decision D-14; counsel review required)");
  if (coldDailyLimit(s) === 0) reasons.push(`The cold-outreach ramp is at ${COLD_STAGE_LABELS[s.cold_stage]} (0 calls a day)`);
  return { enabled: reasons.length === 0, reasons };
}

/**
 * Scheduled AI Callbacks: independent of cold outreach (works while cold outreach is OFF). A callback is a call the
 * prospect asked for, so it needs that request on record (callbackEligibility), not the cold-outreach approval.
 * RETELL_SALES_CALLBACKS="off" is an environment-level kill switch.
 */
export async function callbackSwitch(db: Db, env: SwitchEnv): Promise<SalesGateStatus> {
  const s = await loadSalesSettings(db);
  const reasons: string[] = [];
  if (env.RETELL_SALES_CALLBACKS === "off") reasons.push(`${SALES_CALLBACKS_ENV_FLAG} is "off" in this environment`);
  if (!s.callbacks_enabled) reasons.push("Scheduled AI Callbacks are off in the Owner's settings");
  reasons.push(...commonReasons(s, env));
  return { enabled: reasons.length === 0, reasons };
}

export async function modeSwitch(db: Db, env: SwitchEnv, mode: OutboundMode): Promise<SalesGateStatus> {
  return mode === "callback" ? callbackSwitch(db, env) : salesOutboundSwitch(db, env);
}

/** The callback gate from authoritative records. The time-of-day check uses the appointment time when given. */
export async function gateForCallback(db: Db, f: LeadFacts, at: Date, attemptsSoFar: number, maxAttempts: number) {
  const phone = f.phoneE164;
  const asked = phone ? await db.prepare(`SELECT evidence FROM voice_call_consents WHERE phone_e164 = ? AND purpose = 'callback' AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1`).bind(phone).first<{ evidence: string }>() : null;
  const written = phone && !asked ? await db.prepare(`SELECT evidence_ref FROM sales_call_consents WHERE phone_e164 = ? AND revoked_at IS NULL ORDER BY captured_at DESC LIMIT 1`).bind(phone).first<{ evidence_ref: string }>() : null;
  const supp = await suppressionFor(db, phone ? [phone] : [], f.contactEmail ? [f.contactEmail.toLowerCase()] : []);
  const tz = f.timeZone ?? (await loadVoiceConfig(db)).timezone;
  return callbackEligibility({ phoneE164: phone, onDnc: phone ? await isDnc(db, phone) : false, suppressedInCrm: supp.phone || supp.erased, leadMerged: f.merged,
    consentEvidence: asked?.evidence ?? written?.evidence_ref ?? null, timeZone: tz && validTimeZone(tz) ? tz : null, attemptsSoFar, maxAttempts }, at);
}

// ───────────── Concurrency reservations and daily limits (atomic in the database, migration 0090) ─────────────

/** Claims one of the mode's concurrent-call slots, but only while fewer than `limit` are held. One statement, so two
 *  overlapping scheduler runs can never both take the last slot; an expired reservation counts as free. */
export async function claimSlot(db: Db, mode: OutboundMode, salesCallId: string, limit: number, now: Date, ttlMs = SALES_LEASE_MS): Promise<boolean> {
  if (limit <= 0) return false;
  const at = now.toISOString(), exp = new Date(now.getTime() + ttlMs).toISOString();
  const r = await db.prepare(`UPDATE outbound_call_slots SET sales_call_id = ?1, reserved_at = ?2, expires_at = ?3
      WHERE slot_key = (SELECT slot_key FROM outbound_call_slots WHERE mode = ?4 AND (sales_call_id IS NULL OR expires_at < ?2) ORDER BY slot_no LIMIT 1)
        AND (sales_call_id IS NULL OR expires_at < ?2)
        AND (SELECT COUNT(*) FROM outbound_call_slots WHERE mode = ?4 AND sales_call_id IS NOT NULL AND expires_at >= ?2) < ?5
        AND NOT EXISTS (SELECT 1 FROM outbound_call_slots WHERE sales_call_id = ?1)`).bind(salesCallId, at, exp, mode, limit).run();
  return r.meta.changes === 1;
}
export async function releaseSlot(db: Db, salesCallId: string): Promise<void> {
  await db.prepare(`UPDATE outbound_call_slots SET sales_call_id = NULL, reserved_at = NULL, expires_at = NULL WHERE sales_call_id = ?`).bind(salesCallId).run();
}
export async function heldSlots(db: Db, now: Date): Promise<Record<OutboundMode, number>> {
  const rows = (await db.prepare(`SELECT mode, COUNT(*) AS n FROM outbound_call_slots WHERE sales_call_id IS NOT NULL AND expires_at >= ? GROUP BY mode`).bind(now.toISOString()).all<{ mode: OutboundMode; n: number }>()).results;
  return { cold: rows.find((r) => r.mode === "cold")?.n ?? 0, callback: rows.find((r) => r.mode === "callback")?.n ?? 0 };
}

/** Business-day key for daily limits (the business time zone, so "today" matches what the Owner sees). */
async function businessDay(db: Db, now: Date): Promise<string> {
  const tz = (await loadVoiceConfig(db)).timezone ?? "America/New_York";
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); } catch { return now.toISOString().slice(0, 10); }
}
/** Counts one dial against the mode's daily limit, only while under it (conditional upsert: race-safe). */
async function claimDailyDial(db: Db, mode: OutboundMode, limit: number, now: Date): Promise<boolean> {
  if (limit <= 0) return false;
  const day = await businessDay(db, now);
  const r = await db.prepare(`INSERT INTO outbound_daily_dials (day, mode, n) VALUES (?1, ?2, 1) ON CONFLICT(day, mode) DO UPDATE SET n = n + 1 WHERE n < ?3`).bind(day, mode, limit).run();
  return r.meta.changes === 1;
}
async function unclaimDailyDial(db: Db, mode: OutboundMode, now: Date): Promise<void> {
  await db.prepare(`UPDATE outbound_daily_dials SET n = MAX(0, n - 1) WHERE day = ? AND mode = ?`).bind(await businessDay(db, now), mode).run();
}
export async function dialsToday(db: Db, now: Date): Promise<Record<OutboundMode, number>> {
  const rows = (await db.prepare(`SELECT mode, n FROM outbound_daily_dials WHERE day = ?`).bind(await businessDay(db, now)).all<{ mode: OutboundMode; n: number }>()).results;
  return { cold: rows.find((r) => r.mode === "cold")?.n ?? 0, callback: rows.find((r) => r.mode === "callback")?.n ?? 0 };
}

/** Calls the provider is carrying that are not sales calls: inbound receptionist calls and its follow-up calls. */
async function activeInboundCalls(db: Db, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 2 * 3_600_000).toISOString();
  const inbound = (await db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE direction = 'inbound' AND ended_at IS NULL AND started_at >= ?`).bind(since).first<{ n: number }>())!.n;
  const followUps = (await db.prepare(`SELECT COUNT(*) AS n FROM voice_outbound_requests WHERE status = 'dialing'`).first<{ n: number }>())!.n;
  return inbound + followUps;
}

/** The live capacity picture (dispatcher and Owner dashboard read the same numbers). */
export async function outboundCapacity(db: Db, now: Date): Promise<CapacityPlan & { active: Record<OutboundMode, number>; activeInbound: number; shortfall: string | null }> {
  const s = await loadSalesSettings(db);
  const active = await heldSlots(db, now);
  const activeInbound = await activeInboundCalls(db, now);
  const plan = capacityPlan({ providerLimit: s.provider_concurrency_limit, inboundSharesCapacity: !!s.inbound_shares_capacity, activeInbound, inboundHeadroom: s.inbound_headroom,
    coldMax: s.max_concurrent, callbackReserved: s.callback_reserved, activeCold: active.cold, activeCallback: active.callback });
  return { ...plan, active, activeInbound, shortfall: allocationShortfall(s.provider_concurrency_limit, !!s.inbound_shares_capacity, s.inbound_headroom, s.max_concurrent, s.callback_reserved) };
}

// ───────────── Queue ─────────────

export interface SalesCallRow {
  id: string; lead_id: string; phone_e164: string; status: string; status_detail: string | null; not_before: string | null; attempts: number; transient_failures: number;
  max_attempts: number; idempotency_key: string; provider_call_id: string | null; eligibility_json: string; dynamic_variables_json: string; outcome: string | null;
  outcome_source: string | null; disposition: string | null; disconnection_reason: string | null; duration_ms: number | null; cost_microusd: number | null;
  requested_by: string | null; is_test: number; created_at: string; updated_at: string; finalized_at: string | null;
  mode: OutboundMode; appointment_id: string | null; context_json: string; missed_at: string | null;
}

export async function getSalesCall(db: Db, id: string): Promise<SalesCallRow | null> {
  return db.prepare(`SELECT * FROM sales_calls WHERE id = ?`).bind(id).first<SalesCallRow>();
}
export async function salesCallByProvider(db: Db, providerCallId: string): Promise<SalesCallRow | null> {
  return db.prepare(`SELECT * FROM sales_calls WHERE provider_call_id = ?`).bind(providerCallId).first<SalesCallRow>();
}

const cleanVar = (v: unknown, max: number) => String(v ?? "").replace(/[\r\n\t{}]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
/** Conversation context handed to the agent on a callback, so the prospect never repeats what they already said. */
export function callbackVariables(ctx: Record<string, unknown>): Record<string, string> {
  return {
    call_mode: "scheduled_callback",
    callback_reason: cleanVar(ctx.reason, 300),
    callback_appointment: cleanVar(ctx.appointment_label, 120),
    previous_conversation_summary: cleanVar(ctx.summary, 1200),
    previous_requirements: cleanVar(ctx.requirements, 600),
  };
}

/**
 * Queues a lead for an AI call (staff action, an agreed AI follow-up, an AI Outbound Calendar appointment, or the cold
 * outreach candidate pool). The mode's gate runs now; a blocked lead is recorded as `blocked` with its reasons (audit
 * trail) and is never dialled. One open series per lead and per number in each mode.
 */
export async function enqueueSalesCall(db: Db, leadId: string, opts: { requestedBy: string | null; notBefore?: string | null; now?: Date; isTest?: boolean;
  mode?: OutboundMode; appointmentId?: string | null; context?: Record<string, unknown> }): Promise<SalesCallRow> {
  const now = opts.now ?? new Date();
  const mode = opts.mode ?? "cold";
  const f = await leadFacts(db, leadId);
  if (!f) throw new SalesOutboundError("Lead not found", 404);
  const settings = await loadSalesSettings(db);
  const maxAttempts = mode === "callback" ? CALLBACK_MAX_ATTEMPTS : settings.max_attempts_per_lead;
  const prior = mode === "callback" ? 0 : (await db.prepare(`SELECT COALESCE(SUM(attempts), 0) AS n FROM sales_calls WHERE lead_id = ? AND mode = 'cold'`).bind(leadId).first<{ n: number }>())!.n;
  const gate = mode === "callback"
    ? await gateForCallback(db, f, opts.notBefore ? new Date(opts.notBefore) : now, 0, maxAttempts)
    : await gateFor(db, f, now, prior, maxAttempts);
  const id = newId("scall"), at = nowIso(() => now);
  const ctx = researchContext(f, now);
  const vars = { ...dynamicVariables({ leadId, businessName: f.businessName, contactName: f.contactName, industry: f.industry, websiteUrl: f.prospect?.website_url ?? null, environment: "pending", ctx }),
    ...(mode === "callback" ? callbackVariables(opts.context ?? {}) : {}) };
  const status = gate.eligible && f.phoneE164 ? "queued" : "blocked";
  if (mode === "callback" && status === "queued") {
    // A prospect who booked a callback is engaged: a queued cold call to them would be a second, unasked-for call.
    await db.prepare(`UPDATE sales_calls SET status = 'cancelled', status_detail = 'Superseded by a scheduled callback', updated_at = ? WHERE lead_id = ? AND mode = 'cold' AND status = 'queued'`).bind(at, leadId).run();
  }
  try {
    await db.prepare(`INSERT INTO sales_calls (id, lead_id, phone_e164, status, status_detail, not_before, max_attempts, idempotency_key, eligibility_json, dynamic_variables_json, requested_by, is_test, mode, appointment_id, context_json, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, leadId, f.phoneE164 ?? "unknown", status, status === "blocked" ? gate.reasons.join("; ").slice(0, 900) : null,
      opts.notBefore ?? null, maxAttempts, `crestmont_${id}`, JSON.stringify(gate.reasons), JSON.stringify(vars), opts.requestedBy, opts.isTest || f.isTest ? 1 : 0,
      mode, opts.appointmentId ?? null, JSON.stringify(opts.context ?? {}).slice(0, 4000), at, at).run();
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) {
      const open = await db.prepare(`SELECT * FROM sales_calls WHERE (lead_id = ? OR phone_e164 = ?) AND mode = ? AND status IN ('queued','dialing','in_progress') LIMIT 1`).bind(leadId, f.phoneE164 ?? "", mode).first<SalesCallRow>();
      if (open && mode === "callback" && open.status === "queued" && opts.appointmentId) {
        // The prospect moved their callback: the queued series follows the new appointment (never a second call).
        await db.prepare(`UPDATE sales_calls SET not_before = ?, appointment_id = ?, context_json = ?, dynamic_variables_json = ?, updated_at = ? WHERE id = ? AND status = 'queued'`)
          .bind(opts.notBefore ?? null, opts.appointmentId, JSON.stringify(opts.context ?? {}).slice(0, 4000), JSON.stringify(vars), at, open.id).run();
        return (await getSalesCall(db, open.id))!;
      }
      if (open) return open;
    }
    throw e;
  }
  await audit(db, { actorUserId: opts.requestedBy, actorKind: opts.requestedBy ? "user" : "ai", action: status === "queued" ? "sales_outbound.queued" : "sales_outbound.blocked", subjectType: "sales_call", subjectId: id,
    details: { lead: leadId, mode, reasons: gate.reasons.slice(0, 12) } });
  if (status === "queued") await addLeadNote(db, leadId, mode === "callback"
    ? `Scheduled AI callback queued (${id})${opts.notBefore ? ` for ${opts.notBefore}` : ""}; eligibility is re-checked immediately before dialling.`
    : `Queued for an AI sales call (${id}); eligibility is re-checked immediately before dialling.`);
  return (await getSalesCall(db, id))!;
}

export async function cancelSalesCall(db: Db, userId: string, id: string, note: string): Promise<void> {
  const r = await db.prepare(`UPDATE sales_calls SET status = 'cancelled', status_detail = ?, updated_at = ? WHERE id = ? AND status = 'queued'`).bind(note.trim().slice(0, 300) || "Cancelled by staff", nowIso(), id).run();
  if (r.meta.changes !== 1) throw new SalesOutboundError("Only a queued call can be cancelled", 409);
  await audit(db, { actorUserId: userId, action: "sales_outbound.cancelled", subjectType: "sales_call", subjectId: id });
}

export interface SalesQueueDeps { db: Db; env: Pick<Env, "RETELL_OUTBOUND_API_KEY" | "RETELL_INBOUND_API_KEY" | "RETELL_SALES_OUTBOUND" | "ENVIRONMENT"> & { RETELL_SALES_CALLBACKS?: string }; fetch: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void> }

async function block(db: Db, row: SalesCallRow, status: "blocked" | "failed", detail: string, notify = true) {
  await db.prepare(`UPDATE sales_calls SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?`).bind(status, detail.slice(0, 900), nowIso(), row.id).run();
  await releaseSlot(db, row.id);
  await releasePhone(db, row.phone_e164, leaseRef(row.id), `${status}: ${detail}`);
  if (notify) await addLeadTask(db, row.lead_id, `${row.is_test ? "[TEST] " : ""}${row.mode === "callback" ? "Scheduled AI callback" : "AI sales call"} ${row.id} was not placed: ${detail}`, row.mode === "callback" ? 2 : 24);
}

/** A callback whose time passed without a call is never dialled late: it goes to a person, visibly, instead. */
async function markMissed(db: Db, row: SalesCallRow, why: string, now: Date) {
  const r = await db.prepare(`UPDATE sales_calls SET status = 'blocked', missed_at = ?, status_detail = ?, updated_at = ? WHERE id = ? AND status = 'queued'`).bind(now.toISOString(), `Missed: ${why}`.slice(0, 900), nowIso(), row.id).run();
  if (r.meta.changes !== 1) return;
  await addLeadTask(db, row.lead_id, `${row.is_test ? "[TEST] " : ""}MISSED scheduled AI callback (${row.id}, due ${row.not_before}): ${why}. Call the prospect personally or book a new time.`, 1);
  await notifyOwners(db, "sales_outbound", `${row.is_test ? "[TEST] " : ""}A scheduled AI callback was missed (${why}).`, "sales_call", row.id);
  await audit(db, { actorKind: "system", action: "sales_outbound.callback_missed", subjectType: "sales_call", subjectId: row.id, details: { due: row.not_before, why } });
}

/**
 * Scheduled job "sales_outbound" (every 15 minutes; also safe to run concurrently). Each mode is dispatched only when
 * its own switch is on — Scheduled AI Callbacks first, then AI Cold Outreach — within the capacity plan, the mode's
 * daily limit, the per-lead gate and the recipient's calling hours. Reservations are claimed atomically.
 */
export async function processSalesQueue(d: SalesQueueDeps): Promise<{ detail: string; dialled: number; byMode?: Record<OutboundMode, number> }> {
  const now = d.now ?? (() => new Date());
  const sw = { callback: await callbackSwitch(d.db, d.env), cold: await salesOutboundSwitch(d.db, d.env) };
  // Lost results: a dial with no call_ended for 3 hours goes to a person and is never re-dialled automatically.
  const stale = (await d.db.prepare(`SELECT * FROM sales_calls WHERE status IN ('dialing','in_progress') AND updated_at < ?`).bind(new Date(now().getTime() - SALES_STALE_DIALING_MS).toISOString()).all<SalesCallRow>()).results;
  for (const row of stale) await block(d.db, row, "failed", "no call result was received from Retell; check the Retell call log before calling again");
  // A reservation whose call is no longer dialling (a release that never ran) is freed, so capacity cannot leak.
  await d.db.prepare(`UPDATE outbound_call_slots SET sales_call_id = NULL, reserved_at = NULL, expires_at = NULL
      WHERE sales_call_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales_calls c WHERE c.id = outbound_call_slots.sales_call_id AND c.status IN ('dialing','in_progress'))`).run();
  if (!sw.callback.enabled && !sw.cold.enabled) return { detail: `skipped: both calling modes are off (callbacks: ${sw.callback.reasons.join("; ")} | cold outreach: ${sw.cold.reasons.join("; ")})`, dialled: 0, byMode: { callback: 0, cold: 0 } };
  const budget = await voiceBudget(d.db, now());
  if (!budgetOpen(budget)) { await noteBudgetClosed(d.db, budget); return { detail: `skipped: voice budget ${budget.state === "not_set" ? "not set" : "reached"}`, dialled: 0, byMode: { callback: 0, cold: 0 } }; }
  const s = await loadSalesSettings(d.db);
  // Never miss an eligible scheduled callback: an active AI appointment whose callback was never queued is queued now
  // (it still passes the callback gate, here and again immediately before the dial).
  if (sw.callback.enabled) await queueMissingCallbacks(d.db, now());
  if (sw.cold.enabled) await topUpColdCandidates(d.db, s, now());
  const notes: string[] = [];
  const byMode: Record<OutboundMode, number> = { callback: 0, cold: 0 };
  for (const mode of ["callback", "cold"] as const) {
    if (!sw[mode].enabled) { notes.push(`${MODE_LABELS[mode]} not dialling: ${sw[mode].reasons.join("; ")}`); continue; }
    const r = await dispatchMode(d, s, mode, now, notes);
    byMode[mode] = r;
  }
  const dialled = byMode.callback + byMode.cold;
  return { detail: `${dialled} dialled (callbacks ${byMode.callback}, cold ${byMode.cold})${notes.length ? `; ${notes.join("; ")}` : ""}`.slice(0, 900), dialled, byMode };
}

async function dispatchMode(d: SalesQueueDeps, s: SalesSettings, mode: OutboundMode, now: () => Date, notes: string[]): Promise<number> {
  const plan = await outboundCapacity(d.db, now());
  const perRun = Math.min(plan.free[mode], s.max_dials_per_run);
  if (perRun === 0) { notes.push(`${MODE_LABELS[mode]}: no capacity (active ${plan.active[mode]}/${plan.limit[mode]}${plan.notes.length ? `; ${plan.notes.join("; ")}` : ""})`); return 0; }
  const dailyLimit = mode === "cold" ? coldDailyLimit(s) : s.callback_max_per_day;
  const order = mode === "callback" ? "not_before" : "created_at";
  const due = (await d.db.prepare(`SELECT * FROM sales_calls WHERE status = 'queued' AND mode = ? AND (not_before IS NULL OR not_before <= ?) ORDER BY ${order} LIMIT ?`).bind(mode, now().toISOString(), perRun * 3).all<SalesCallRow>()).results;
  let dialled = 0;
  for (const row of due) {
    if (dialled >= perRun) break;
    if (mode === "callback" && row.appointment_id) {
      // The appointment is the authority, not the queue row: re-read it (following a reschedule) right before dialling.
      const appt = await activeAppointmentFor(d.db, row.appointment_id);
      if (!appt) {
        const c = await d.db.prepare(`UPDATE sales_calls SET status = 'cancelled', status_detail = 'Appointment cancelled or no longer active', updated_at = ? WHERE id = ? AND status = 'queued'`).bind(nowIso(), row.id).run();
        if (c.meta.changes) await audit(d.db, { actorKind: "system", action: "sales_outbound.callback_cancelled", subjectType: "sales_call", subjectId: row.id, details: { appointment: row.appointment_id, why: "appointment_not_active" } });
        notes.push(`${row.id}: appointment no longer active`);
        continue;
      }
      if (appt.id !== row.appointment_id || Date.parse(appt.starts_at) > now().getTime()) {
        let context: Record<string, unknown> = {};
        try { context = JSON.parse(row.context_json || "{}"); } catch { context = {}; }
        context = { ...context, appointment_id: appt.id, appointment_label: slotLabel(appt.starts_at, appt.timezone) };
        const early = Date.parse(appt.starts_at) > now().getTime();
        // Never early: a callback is placed at its appointment time (a moved appointment takes its call with it).
        await d.db.prepare(`UPDATE sales_calls SET appointment_id = ?, context_json = ?, not_before = CASE WHEN ? THEN ? ELSE not_before END, updated_at = ? WHERE id = ? AND status = 'queued'`)
          .bind(appt.id, JSON.stringify(context).slice(0, 4000), early ? 1 : 0, appt.starts_at, nowIso(), row.id).run();
        if (early) { notes.push(`${row.id}: not due until its appointment`); continue; }
        row.appointment_id = appt.id; row.context_json = JSON.stringify(context);
      }
    }
    if (mode === "callback" && callbackMissed(row.not_before, now())) { await markMissed(d.db, row, "its appointment time passed before it could be placed (callbacks paused, outside calling hours or no capacity)", now()); notes.push(`${row.id}: missed`); continue; }
    const f = await leadFacts(d.db, row.lead_id);
    if (!f) { await block(d.db, row, "blocked", "lead no longer exists", false); continue; }
    const gate = mode === "callback"
      ? await gateForCallback(d.db, f, now(), row.attempts, row.max_attempts)
      : await gateFor(d.db, f, now(), (await d.db.prepare(`SELECT COALESCE(SUM(attempts), 0) AS n FROM sales_calls WHERE lead_id = ? AND id <> ? AND mode = 'cold'`).bind(row.lead_id, row.id).first<{ n: number }>())!.n + row.attempts, row.max_attempts);
    if (!gate.eligible || f.phoneE164 !== row.phone_e164) {
      const why = !gate.eligible ? gate.reasons.join("; ") : "the lead's phone number changed since it was queued";
      await block(d.db, row, "blocked", why);
      await d.db.prepare(`UPDATE sales_calls SET eligibility_json = ? WHERE id = ?`).bind(JSON.stringify(gate.reasons), row.id).run();
      notes.push(`${row.id}: blocked`);
      continue;
    }
    if (mode === "cold") {
      // A prospect who already has an appointment (either calendar) or a scheduled callback is never cold-called on top.
      const engaged = await d.db.prepare(`SELECT (SELECT COUNT(*) FROM consultations WHERE lead_id = ? AND status IN ('requested','confirmed') AND starts_at >= ?)
          + (SELECT COUNT(*) FROM sales_calls WHERE lead_id = ? AND mode = 'callback' AND status IN ('queued','dialing','in_progress')) AS n`)
        .bind(row.lead_id, new Date(now().getTime() - 3_600_000).toISOString(), row.lead_id).first<{ n: number }>();
      if (engaged && engaged.n > 0) {
        await d.db.prepare(`UPDATE sales_calls SET status = 'cancelled', status_detail = 'Superseded by a scheduled appointment or callback', updated_at = ? WHERE id = ? AND status = 'queued'`).bind(nowIso(), row.id).run();
        notes.push(`${row.id}: superseded by a scheduled appointment`);
        continue;
      }
    }
    if (mode === "cold" && !withinSalesWindow(now(), f.timeZone, f.state)) {
      const next = nextSalesWindow(now(), f.timeZone, f.state);
      if (!next) { await block(d.db, row, "blocked", "no permitted calling window found in the next 8 days"); continue; }
      await d.db.prepare(`UPDATE sales_calls SET not_before = ?, status_detail = 'outside the recipient''s calling window', updated_at = ? WHERE id = ?`).bind(next.toISOString(), nowIso(), row.id).run();
      notes.push(`${row.id}: outside window`);
      continue;
    }
    // Capacity first (the scarcest, shared resource), then the daily limit, then the number's lease, then the row.
    const limitNow = (await outboundCapacity(d.db, now())).limit[mode];
    if (!(await claimSlot(d.db, mode, row.id, limitNow, now()))) { notes.push(`${MODE_LABELS[mode]}: concurrency limit reached`); break; }
    if (!(await claimDailyDial(d.db, mode, dailyLimit, now()))) { await releaseSlot(d.db, row.id); notes.push(`${MODE_LABELS[mode]}: daily limit (${dailyLimit}) reached`); break; }
    const undo = async () => { await releaseSlot(d.db, row.id); await unclaimDailyDial(d.db, mode, now()); };
    const lease = await reservePhone(d.db, row.phone_e164, leaseRef(row.id), SALES_PURPOSE, SALES_LEASE_MS, now());
    if (!lease.ok) {
      await undo();
      if (lease.reason === "do_not_call") await block(d.db, row, "blocked", lease.detail);
      else await d.db.prepare(`UPDATE sales_calls SET not_before = ?, status_detail = ?, updated_at = ? WHERE id = ?`).bind(lease.retryAt ?? new Date(now().getTime() + (mode === "callback" ? 5 : 30) * 60_000).toISOString(), lease.detail, nowIso(), row.id).run();
      notes.push(`${row.id}: ${lease.detail}`);
      continue;
    }
    const attempt = row.attempts + 1;
    const claim = await d.db.prepare(`UPDATE sales_calls SET status = 'dialing', attempts = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND attempts = ?`).bind(attempt, nowIso(), row.id, row.attempts).run();
    if (claim.meta.changes !== 1) { await undo(); await releasePhone(d.db, row.phone_e164, leaseRef(row.id), "claim_lost"); continue; }
    const ctx = researchContext(f, now());
    let context: Record<string, unknown> = {};
    try { context = JSON.parse(row.context_json || "{}"); } catch { context = {}; }
    const vars = { ...dynamicVariables({ leadId: f.leadId, businessName: f.businessName, contactName: f.contactName, industry: f.industry, websiteUrl: f.prospect?.website_url ?? null, environment: d.env.ENVIRONMENT, ctx }),
      ...(mode === "callback" ? callbackVariables(context) : { call_mode: "cold_outreach" }) };
    const sie = await sieStamp(d.db, d.env.ENVIRONMENT, s.agent_id!, row.lead_id, ctx.website_status);
    const res = await createRetellPhoneCall({
      apiKey: retellKey(d.env, "outbound"), fetch: d.fetch, sleep: d.sleep, // the sales workspace only; never the receptionist's key
      body: {
        from_number: s.from_number!, to_number: row.phone_e164, override_agent_id: s.agent_id!,
        idempotency_key: `${row.idempotency_key}_a${attempt}`, honor_internal_dnc: true,
        metadata: { crestmont_env: d.env.ENVIRONMENT, crestmont_sales_call_id: row.id, crestmont_lead_id: row.lead_id, crestmont_test: row.is_test ? "true" : "false", crestmont_call_mode: mode, ...sie.metadata },
        retell_llm_dynamic_variables: vars,
      },
    });
    if (res.ok) {
      const at = now().toISOString();
      await d.db.batch([
        d.db.prepare(`UPDATE sales_calls SET provider_call_id = ?, dynamic_variables_json = ?, status_detail = NULL, not_before = NULL, updated_at = ? WHERE id = ?`).bind(res.callId, JSON.stringify(vars), at, row.id),
        d.db.prepare(`INSERT INTO calls (id, provider, provider_call_id, from_number, to_number, direction, recording_consent, started_at, is_test, environment, lead_id, created_at)
            VALUES (?, ?, ?, ?, ?, 'outbound', 0, ?, ?, ?, ?, ?) ON CONFLICT(provider, provider_call_id) DO UPDATE SET direction = 'outbound',
              to_number = COALESCE(calls.to_number, excluded.to_number), lead_id = COALESCE(calls.lead_id, excluded.lead_id),
              environment = COALESCE(calls.environment, excluded.environment), is_test = MAX(calls.is_test, excluded.is_test)`)
          .bind(newId("call"), RETELL_PROVIDER, res.callId, s.from_number, row.phone_e164, at, row.is_test, d.env.ENVIRONMENT, row.lead_id, at),
      ]);
      await markDialing(d.db, row.phone_e164, lease.reservationId, res.callId, now());
      await audit(d.db, { actorKind: "system", action: "sales_outbound.dialled", subjectType: "sales_call", subjectId: row.id, details: { attempt, lead: row.lead_id, mode, sie: sie.note } });
      dialled++;
    } else if ((res.retryable || res.error.includes("concurrency_limit")) && row.transient_failures + 1 < MAX_TRANSIENT_FAILURES) {
      // Same attempt number → same idempotency key on the retry: Retell can never place a second call for it. The
      // provider's own concurrency limit is a capacity signal, not a failure of the prospect's number.
      await d.db.prepare(`UPDATE sales_calls SET status = 'queued', attempts = ?, transient_failures = transient_failures + 1, status_detail = ?, not_before = ?, updated_at = ? WHERE id = ?`)
        .bind(row.attempts, res.error, new Date(now().getTime() + (mode === "callback" ? 2 : 30) * 60_000).toISOString(), nowIso(), row.id).run();
      await undo();
      await releasePhone(d.db, row.phone_e164, leaseRef(row.id), `transient: ${res.error}`);
      notes.push(`${row.id}: ${res.error} (retry with the same idempotency key)`);
    } else {
      await unclaimDailyDial(d.db, mode, now());
      await block(d.db, row, "failed", res.error);
      notes.push(`${row.id}: ${res.error}`);
    }
  }
  return dialled;
}

/**
 * The cold-outreach candidate pool: Approved-CRM leads in an open stage with documented written consent for AI-voice
 * sales calls to their number, never called by cold outreach before. A lead does NOT need to have asked for a callback.
 * Each candidate is queued once (its series carries its own retries); the compliance gate decides at queue time and
 * again right before the dial, so a lead that is not eligible is recorded as blocked with its reasons.
 */
export async function topUpColdCandidates(db: Db, s: SalesSettings, now: Date): Promise<number> {
  const remaining = coldDailyLimit(s) - (await dialsToday(db, now)).cold;
  const queued = (await db.prepare(`SELECT COUNT(*) AS n FROM sales_calls WHERE mode = 'cold' AND status = 'queued'`).first<{ n: number }>())!.n;
  const want = Math.min(Math.max(0, remaining - queued), s.max_dials_per_run * 3);
  if (want <= 0) return 0;
  const rows = (await db.prepare(`SELECT DISTINCT l.id FROM leads l
      JOIN sales_call_consents sc ON sc.revoked_at IS NULL AND (sc.lead_id = l.id OR sc.phone_e164 IN (SELECT phone_e164 FROM research_prospects WHERE crm_lead_id = l.id))
      WHERE l.merged_into_lead_id IS NULL AND l.stage IN ('new','qualified','quote_required','quote_sent','negotiation')
        AND NOT EXISTS (SELECT 1 FROM sales_calls c WHERE c.lead_id = l.id AND c.mode = 'cold')
      ORDER BY l.created_at LIMIT ?`).bind(want).all<{ id: string }>()).results;
  let n = 0;
  for (const r of rows) { const row = await enqueueSalesCall(db, r.id, { requestedBy: null, now, mode: "cold" }).catch(() => null); if (row?.status === "queued") n++; }
  if (n) await audit(db, { actorKind: "system", action: "sales_outbound.candidates_queued", subjectType: "sales_outbound_settings", subjectId: "1", details: { queued: n, considered: rows.length } });
  return n;
}

// ───────────── Webhook: call status and final outcome ─────────────

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const str = (o: Obj, k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);

/**
 * Applies a verified Retell call webhook to the sales queue (after the voice handler stored the call). Only calls whose
 * signed metadata names a sales call that this platform created are touched. Idempotent: the outcome is written once
 * (finalized_at), retries and out-of-order events change nothing. call_analyzed may only fill a missing post-call guess.
 */
export async function applySalesCallEvent(db: Db, raw: string, opts: { environment: string; now?: () => Date }): Promise<{ applied: string } | null> {
  const json = obj(JSON.parse(raw));
  const event = str(json, "event");
  const call = obj(json.call);
  const meta = obj(call.metadata);
  const salesId = str(meta, "crestmont_sales_call_id");
  const providerCallId = str(call, "call_id");
  if (!salesId || !/^scall_[A-Za-z0-9_-]{1,60}$/.test(salesId) || !providerCallId) return null;
  if (typeof meta.crestmont_env === "string" && meta.crestmont_env !== opts.environment) return null;
  const row = await getSalesCall(db, salesId);
  if (!row) return null;
  // Bind the Retell call id only while this series is dialling (the webhook can beat the create-phone-call response).
  // After a retry is scheduled the id is cleared and the status is 'queued', so late events of the previous attempt
  // (e.g. its call_analyzed) can never attach themselves to the series again.
  if (!row.provider_call_id) {
    if (row.status !== "dialing") return null;
    const b = await db.prepare(`UPDATE sales_calls SET provider_call_id = ? WHERE id = ? AND provider_call_id IS NULL AND status = 'dialing'`).bind(providerCallId, row.id).run();
    if (b.meta.changes !== 1) return null;
    row.provider_call_id = providerCallId;
  } else if (row.provider_call_id !== providerCallId) return null;
  const now = opts.now?.() ?? new Date();
  if (event === "call_started") {
    await db.prepare(`UPDATE sales_calls SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'dialing'`).bind(nowIso(), row.id).run();
    return { applied: "in_progress" };
  }
  if (event === "call_analyzed") {
    const analysis = str(obj(obj(call.call_analysis).custom_analysis_data), "sales_outcome") ?? null;
    if (analysis && row.finalized_at && row.outcome === "unclassified" && ["wrong_number", "not_interested", "interested", "follow_up_requested"].includes(analysis)) {
      await db.prepare(`UPDATE sales_calls SET outcome = ?, outcome_source = 'retell_post_call_analysis' WHERE id = ? AND outcome = 'unclassified'`).bind(analysis, row.id).run();
      return { applied: `analysis:${analysis}` };
    }
    const cost = typeof obj(call.call_cost).combined_cost === "number" ? Math.round((obj(call.call_cost).combined_cost as number) * 10_000) : null;
    if (cost !== null) await db.prepare(`UPDATE sales_calls SET cost_microusd = COALESCE(cost_microusd, ?) WHERE id = ?`).bind(cost, row.id).run();
    return { applied: "analysis" };
  }
  if (event !== "call_ended") return null;
  if (row.finalized_at) return { applied: "duplicate" };
  const reason = str(call, "disconnection_reason") ?? null;
  const has = async (sql: string, ...b: unknown[]) => !!(await db.prepare(sql).bind(...b).first());
  const facts = {
    disconnectionReason: reason, callStatus: str(call, "call_status") ?? null,
    talked: (str(call, "transcript") ?? "").trim().length > 0 || await has(`SELECT 1 AS x FROM sales_function_events WHERE provider_call_id = ? AND status = 'ok'`, providerCallId),
    dncRecorded: await has(`SELECT 1 AS x FROM sales_function_events WHERE provider_call_id = ? AND name = 'record_do_not_call' AND status = 'ok'`, providerCallId),
    paymentConfirmed: await has(`SELECT 1 AS x FROM orders o JOIN invoices i ON i.order_id = o.id JOIN payments p ON p.invoice_id = i.id WHERE o.lead_id = ? AND i.status = 'paid' AND p.status = 'succeeded' AND p.created_at >= ?`, row.lead_id, row.created_at),
    checkoutSent: await has(`SELECT 1 AS x FROM sales_checkout_links WHERE provider_call_id = ?`, providerCallId),
    consultationBooked: await has(`SELECT 1 AS x FROM sales_followups WHERE provider_call_id = ? AND kind = 'consultation' AND status IN ('scheduled','requested')`, providerCallId),
    followUpScheduled: await has(`SELECT 1 AS x FROM sales_followups WHERE provider_call_id = ?`, providerCallId),
    agentDisposition: row.disposition, analysisOutcome: str(obj(obj(call.call_analysis).custom_analysis_data), "sales_outcome") ?? null,
  };
  const { outcome, source } = resolveOutcome(facts);
  const duration = typeof call.duration_ms === "number" && Number.isInteger(call.duration_ms) ? call.duration_ms : null;
  const retry = (outcome === "no_answer" || outcome === "voicemail") && row.attempts < row.max_attempts;
  const s = await loadSalesSettings(db);
  // A callback that rang out is tried once more a few minutes later, inside its appointment; a cold call days later.
  const retryAt = new Date(now.getTime() + (row.mode === "callback" ? CALLBACK_RETRY_MS : s.retry_after_hours * 3_600_000));
  const fin = await db.prepare(`UPDATE sales_calls SET status = ?, outcome = ?, outcome_source = ?, disconnection_reason = ?, duration_ms = ?, finalized_at = ?, provider_call_id = CASE WHEN ? THEN NULL ELSE provider_call_id END,
        not_before = ?, status_detail = ?, updated_at = ? WHERE id = ? AND finalized_at IS NULL`)
    .bind(retry ? "queued" : outcome === "technical_failure" ? "failed" : "completed", retry ? null : outcome, retry ? null : source, reason, duration, retry ? null : nowIso(() => now), retry ? 1 : 0,
      retry ? retryAt.toISOString() : null, retry ? `${outcome} on attempt ${row.attempts}; one more attempt later` : null, nowIso(), row.id).run();
  if (fin.meta.changes !== 1) return { applied: "duplicate" };
  // The call is over: its concurrent-call reservation is free for the next dial.
  await releaseSlot(db, row.id);
  if (!retry && row.mode === "callback" && row.appointment_id) {
    const connected = !["no_answer", "voicemail", "technical_failure"].includes(outcome);
    await db.prepare(`UPDATE consultations SET status = ?, updated_at = ? WHERE id = ? AND status IN ('requested','confirmed')`).bind(connected ? "completed" : "no_show", nowIso(), row.appointment_id).run();
    if (!connected) await addLeadTask(db, row.lead_id, `${row.is_test ? "[TEST] " : ""}The scheduled AI callback (${row.id}) did not reach the prospect after ${row.attempts} attempt(s). Follow up personally or book a new time.`, 4);
  }
  // Retell's own DNC detection (the person asked not to be called and the agent ended the call) is honoured like the function.
  if (reason === "user_requested_dnc") await suppressEverywhere(db, row.phone_e164, { leadId: row.lead_id, detail: `Retell user_requested_dnc on sales call ${row.id}`, actor: "provider" });
  await recordPhoneOutcome(db, row.phone_e164, reason ?? "ended", leaseRef(row.id), now);
  await releasePhone(db, row.phone_e164, leaseRef(row.id), `sales:${outcome}`, retry ? { retryAfter: retryAt.toISOString(), now } : { now });
  if (retry) {
    // The retry series keeps its row; the attempt's own call stays in `calls` with its outcome history in audit.
    await audit(db, { actorKind: "webhook", action: "sales_outbound.retry_scheduled", subjectType: "sales_call", subjectId: row.id, details: { outcome, attempt: row.attempts, providerCallId, mode: row.mode } });
    await addLeadNote(db, row.lead_id, row.mode === "callback"
      ? `Scheduled AI callback attempt ${row.attempts}: ${outcome.replace(/_/g, " ")}. One more attempt in ${Math.round(CALLBACK_RETRY_MS / 60_000)} minutes.`
      : `AI sales call attempt ${row.attempts}: ${outcome.replace(/_/g, " ")}. One more attempt is allowed after ${s.retry_after_hours} hours.`);
    return { applied: `retry:${outcome}` };
  }
  await applyOutcomeToCrm(db, row, outcome, source, reason);
  await audit(db, { actorKind: "webhook", action: "sales_outbound.outcome", subjectType: "sales_call", subjectId: row.id, details: { outcome, source, providerCallId } });
  return { applied: outcome };
}

/** Pipeline effects of a final outcome. Stage changes only move forward and never touch converted/lost/merged leads. */
async function applyOutcomeToCrm(db: Db, row: SalesCallRow, outcome: SalesOutcome, source: string, reason: string | null): Promise<void> {
  const tag = row.is_test ? "[TEST] " : "";
  await addLeadNote(db, row.lead_id, `${tag}AI sales call ${row.id} finished: ${outcome.replace(/_/g, " ")} (source: ${source.replace(/_/g, " ")}${reason ? `; ${reason}` : ""}).`);
  const move = async (to: string, from: string[]) => {
    const r = await db.prepare(`UPDATE leads SET stage = ?, updated_at = ? WHERE id = ? AND merged_into_lead_id IS NULL AND stage IN (${from.map(() => "?").join(",")})`).bind(to, nowIso(), row.lead_id, ...from).run();
    if (r.meta.changes === 1) await db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'stage_change',?,?)`).bind(newId("act"), row.lead_id, `Stage → ${to} (AI sales call outcome: ${outcome})`, nowIso()).run();
  };
  switch (outcome) {
    // Only transitions LEAD_TRANSITIONS allows from these stages. "Awaiting payment" is set by the existing checkout flow
    // when the buyer actually starts checkout (billing.ts#ensureCheckoutLead), and "converted" only by the Stripe webhook.
    case "interested": case "follow_up_requested": case "consultation_booked": case "checkout_sent": await move("qualified", ["new"]); break;
    case "not_interested":
      await db.prepare(`UPDATE leads SET stage = 'lost', lost_reason = COALESCE(lost_reason, 'Not interested (AI sales call)'), updated_at = ? WHERE id = ? AND stage IN ('new','qualified') AND merged_into_lead_id IS NULL`).bind(nowIso(), row.lead_id).run();
      break;
    case "wrong_number":
      await addLeadTask(db, row.lead_id, `${tag}The AI sales call reached a wrong number (${row.phone_e164}). Verify the business's number before any further contact.`, 48);
      await db.prepare(`UPDATE sales_call_consents SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, 'Wrong number reported on call') WHERE phone_e164 = ?`).bind(nowIso(), row.phone_e164).run();
      break;
    case "unclassified": await addLeadTask(db, row.lead_id, `${tag}Classify the result of AI sales call ${row.id}: the call connected but no outcome was recorded.`, 24); break;
    case "technical_failure":
      if (reason === "invalid_destination") {
        // The number itself is bad (not a carrier or network fault): mark it so it is never dialled again, ask for a new one.
        await db.prepare(`UPDATE research_prospects SET phone_status = 'invalid' WHERE phone_e164 = ?`).bind(row.phone_e164).run();
        await addLeadTask(db, row.lead_id, `${tag}The AI sales call to ${row.phone_e164} failed: the number is invalid or disconnected. Find and verify the business's current number before any further contact.`, 48);
      }
      await notifyOwners(db, "sales_outbound", `${tag}AI sales call ${row.id} failed (${reason ?? "unknown"}).`, "sales_call", row.id); break;
    default: break;
  }
}

/**
 * Do-not-call, applied everywhere at once: voice_dnc (shared with the receptionist and follow-up calls, revokes
 * consents, cancels follow-up requests), research prospects (suppressed, so a re-import is never callable), every
 * queued sales call and AI follow-up for the number, sales consents, and optionally sales email.
 */
export async function suppressEverywhere(db: Db, phone: string, opts: { leadId?: string | null; email?: string | null; detail: string; actor: "ai" | "staff" | "provider"; userId?: string | null }): Promise<{ salesCallsCancelled: number; prospectsSuppressed: number }> {
  const e164 = toE164(phone);
  if (!e164) throw new SalesOutboundError("No dialable number to suppress");
  await addDnc(db, e164, opts.actor === "staff" ? "staff" : opts.actor === "provider" ? "provider_dnc" : "caller_request", opts.detail, opts.userId ?? null);
  const at = nowIso();
  const cancelled = await db.prepare(`UPDATE sales_calls SET status = 'cancelled', status_detail = 'Number opted out of calls', updated_at = ? WHERE phone_e164 = ? AND status = 'queued'`).bind(at, e164).run();
  await db.batch([
    db.prepare(`UPDATE sales_call_consents SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, 'Do-not-call request') WHERE phone_e164 = ?`).bind(at, e164),
    db.prepare(`UPDATE sales_followups SET status = 'cancelled', updated_at = ? WHERE kind = 'ai_follow_up_call' AND status IN ('scheduled','pending_eligibility') AND lead_id IN (SELECT id FROM sales_calls WHERE phone_e164 = ? UNION SELECT ?)`).bind(at, e164, opts.leadId ?? ""),
  ]);
  const prospects = await applySuppressions(db);
  if (opts.email) await db.prepare(`INSERT INTO sales_email_optouts (email, source, created_at) VALUES (?, 'do_not_contact', ?) ON CONFLICT(email) DO NOTHING`).bind(opts.email.trim().toLowerCase(), at).run();
  if (opts.leadId) await addLeadNote(db, opts.leadId, `Do-not-call recorded for ${e164.slice(0, -4)}••••: suppressed for all outbound calling${opts.email ? " and sales email" : ""}.`);
  return { salesCallsCancelled: cancelled.meta.changes, prospectsSuppressed: prospects };
}
