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
import { toE164, validTimeZone, loadVoiceConfig } from "./voice-settings.ts";
import { createRetellPhoneCall, RETELL_PROVIDER } from "../adapters/retell.ts";
import { addLeadNote, addLeadTask, notifyOwners } from "./voice-common.ts";
import { addDnc, isDnc } from "./voice-outbound.ts";
import { voiceBudget, budgetOpen, noteBudgetClosed } from "./voice-budget.ts";
import { reservePhone, releasePhone, markDialing, recordPhoneOutcome } from "./outreach-ledger.ts";
import { suppressionFor } from "./contact-identity.ts";
import { applySuppressions } from "./research.ts";
import { timeZoneForState } from "../domain/research.ts";
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

export interface SalesSettings { enabled: number; agent_id: string | null; from_number: string | null; max_concurrent: number; max_dials_per_run: number; max_dials_per_day: number; max_attempts_per_lead: number; retry_after_hours: number; updated_by: string | null; updated_at: string }

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
  inRange(i.maxConcurrent, 1, 20, "Concurrent calls"); inRange(i.maxPerRun, 1, 20, "Dials per run"); inRange(i.maxPerDay, 1, 500, "Dials per day");
  inRange(i.maxAttempts, 1, 3, "Attempts per lead"); inRange(i.retryAfterHours, 4, 720, "Hours between attempts");
  if (i.enabled && (!agentId || !from)) problems.push("Outbound sales can only be switched on with a sales agent id and an approved caller number");
  if (i.enabled) {
    // The receptionist's agent must never be used for sales calls (it carries receptionist guardrails, not sales ones).
    const cfg = await loadVoiceConfig(db);
    if (agentId && (cfg.inbound.agent_id === agentId || cfg.outbound.agent_id === agentId)) problems.push("The sales agent must be a separate Retell agent from the receptionist and its follow-up agent");
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
    findings_json: string; identity_confidence: number; last_verified_at: string; recommended_package: string | null; category: string | null } | null;
  phoneE164: string | null; state: string | null; timeZone: string | null;
}

export async function leadFacts(db: Db, leadId: string): Promise<LeadFacts | null> {
  const l = await db.prepare(`SELECT l.id, l.stage, l.merged_into_lead_id, l.interest, l.origin, l.message, c.id AS contact_id, c.name AS contact_name, c.email, c.phone,
        co.name AS company_name, co.industry, co.location_norm
      FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id WHERE l.id = ?`).bind(leadId)
    .first<{ id: string; stage: string; merged_into_lead_id: string | null; interest: string | null; origin: string | null; message: string | null; contact_id: string; contact_name: string | null; email: string | null; phone: string | null; company_name: string | null; industry: string | null; location_norm: string | null }>();
  if (!l) return null;
  const prospect = await db.prepare(`SELECT id, state, time_zone, phone_e164, shared_phone, website_class, website_url, findings_json, identity_confidence, last_verified_at, recommended_package, category
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
  return gate;
}

// ───────────── Queue ─────────────

export interface SalesCallRow {
  id: string; lead_id: string; phone_e164: string; status: string; status_detail: string | null; not_before: string | null; attempts: number; transient_failures: number;
  max_attempts: number; idempotency_key: string; provider_call_id: string | null; eligibility_json: string; dynamic_variables_json: string; outcome: string | null;
  outcome_source: string | null; disposition: string | null; disconnection_reason: string | null; duration_ms: number | null; cost_microusd: number | null;
  requested_by: string | null; is_test: number; created_at: string; updated_at: string; finalized_at: string | null;
}

export async function getSalesCall(db: Db, id: string): Promise<SalesCallRow | null> {
  return db.prepare(`SELECT * FROM sales_calls WHERE id = ?`).bind(id).first<SalesCallRow>();
}
export async function salesCallByProvider(db: Db, providerCallId: string): Promise<SalesCallRow | null> {
  return db.prepare(`SELECT * FROM sales_calls WHERE provider_call_id = ?`).bind(providerCallId).first<SalesCallRow>();
}

/**
 * Queues a lead for an AI sales call (staff action, or an agreed AI follow-up). The gate runs now; a blocked lead is
 * recorded as `blocked` with its reasons (audit trail) and is never dialled. One open series per lead and per number.
 */
export async function enqueueSalesCall(db: Db, leadId: string, opts: { requestedBy: string | null; notBefore?: string | null; now?: Date; isTest?: boolean }): Promise<SalesCallRow> {
  const now = opts.now ?? new Date();
  const f = await leadFacts(db, leadId);
  if (!f) throw new SalesOutboundError("Lead not found", 404);
  const settings = await loadSalesSettings(db);
  const prior = (await db.prepare(`SELECT COALESCE(SUM(attempts), 0) AS n FROM sales_calls WHERE lead_id = ?`).bind(leadId).first<{ n: number }>())!.n;
  const gate = await gateFor(db, f, now, prior, settings.max_attempts_per_lead);
  const id = newId("scall"), at = nowIso(() => now);
  const ctx = researchContext(f, now);
  const vars = dynamicVariables({ leadId, businessName: f.businessName, contactName: f.contactName, industry: f.industry, websiteUrl: f.prospect?.website_url ?? null, environment: "pending", ctx });
  const status = gate.eligible && f.phoneE164 ? "queued" : "blocked";
  try {
    await db.prepare(`INSERT INTO sales_calls (id, lead_id, phone_e164, status, status_detail, not_before, max_attempts, idempotency_key, eligibility_json, dynamic_variables_json, requested_by, is_test, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, leadId, f.phoneE164 ?? "unknown", status, status === "blocked" ? gate.reasons.join("; ").slice(0, 900) : null,
      opts.notBefore ?? null, settings.max_attempts_per_lead, `crestmont_${id}`, JSON.stringify(gate.reasons), JSON.stringify(vars), opts.requestedBy, opts.isTest || f.isTest ? 1 : 0, at, at).run();
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) {
      const open = await db.prepare(`SELECT * FROM sales_calls WHERE (lead_id = ? OR phone_e164 = ?) AND status IN ('queued','dialing','in_progress') LIMIT 1`).bind(leadId, f.phoneE164 ?? "").first<SalesCallRow>();
      if (open) return open;
    }
    throw e;
  }
  await audit(db, { actorUserId: opts.requestedBy, actorKind: opts.requestedBy ? "user" : "ai", action: status === "queued" ? "sales_outbound.queued" : "sales_outbound.blocked", subjectType: "sales_call", subjectId: id,
    details: { lead: leadId, reasons: gate.reasons.slice(0, 12) } });
  if (status === "queued") await addLeadNote(db, leadId, `Queued for an AI sales call (${id}); eligibility is re-checked immediately before dialling.`);
  return (await getSalesCall(db, id))!;
}

export async function cancelSalesCall(db: Db, userId: string, id: string, note: string): Promise<void> {
  const r = await db.prepare(`UPDATE sales_calls SET status = 'cancelled', status_detail = ?, updated_at = ? WHERE id = ? AND status = 'queued'`).bind(note.trim().slice(0, 300) || "Cancelled by staff", nowIso(), id).run();
  if (r.meta.changes !== 1) throw new SalesOutboundError("Only a queued call can be cancelled", 409);
  await audit(db, { actorUserId: userId, action: "sales_outbound.cancelled", subjectType: "sales_call", subjectId: id });
}

export interface SalesGateStatus { enabled: boolean; reasons: string[] }

/** The environment/Owner switch, separate from per-lead eligibility. */
export async function salesOutboundSwitch(db: Db, env: Pick<Env, "RETELL_API_KEY" | "RETELL_SALES_OUTBOUND">): Promise<SalesGateStatus> {
  const s = await loadSalesSettings(db);
  const reasons: string[] = [];
  if (env.RETELL_SALES_OUTBOUND !== "on") reasons.push(`${SALES_OUTBOUND_ENV_FLAG} is not "on" in this environment`);
  if (!s.enabled) reasons.push("Outbound sales calling is off in the Owner's settings");
  if (!s.agent_id) reasons.push("No sales agent id");
  if (!s.from_number) reasons.push("No approved caller number");
  if (!env.RETELL_API_KEY) reasons.push("RETELL_API_KEY is not set");
  if (!(await activeComplianceApproval(db))) reasons.push("No active compliance approval for AI-voice sales calls (Founder decision D-14; counsel review required)");
  return { enabled: reasons.length === 0, reasons };
}

export interface SalesQueueDeps { db: Db; env: Pick<Env, "RETELL_API_KEY" | "RETELL_SALES_OUTBOUND" | "ENVIRONMENT">; fetch: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void> }

async function block(db: Db, row: SalesCallRow, status: "blocked" | "failed", detail: string, notify = true) {
  await db.prepare(`UPDATE sales_calls SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?`).bind(status, detail.slice(0, 900), nowIso(), row.id).run();
  await releasePhone(db, row.phone_e164, leaseRef(row.id), `${status}: ${detail}`);
  if (notify) await addLeadTask(db, row.lead_id, `${row.is_test ? "[TEST] " : ""}AI sales call ${row.id} was not placed: ${detail}`, 24);
}

/** Scheduled job "sales_outbound" (every 15 minutes). Dials nothing unless every switch and the per-lead gate pass. */
export async function processSalesQueue(d: SalesQueueDeps): Promise<{ detail: string; dialled: number }> {
  const now = d.now ?? (() => new Date());
  const sw = await salesOutboundSwitch(d.db, d.env);
  if (!sw.enabled) return { detail: `skipped: outbound sales disabled (${sw.reasons.join("; ")})`, dialled: 0 };
  const budget = await voiceBudget(d.db, now());
  if (!budgetOpen(budget)) { await noteBudgetClosed(d.db, budget); return { detail: `skipped: voice budget ${budget.state === "not_set" ? "not set" : "reached"}`, dialled: 0 }; }
  const s = await loadSalesSettings(d.db);
  // Lost results: a dial with no call_ended for 3 hours goes to a person and is never re-dialled automatically.
  const stale = (await d.db.prepare(`SELECT * FROM sales_calls WHERE status IN ('dialing','in_progress') AND updated_at < ?`).bind(new Date(now().getTime() - SALES_STALE_DIALING_MS).toISOString()).all<SalesCallRow>()).results;
  for (const row of stale) await block(d.db, row, "failed", "no call result was received from Retell; check the Retell call log before calling again");
  const active = (await d.db.prepare(`SELECT COUNT(*) AS n FROM sales_calls WHERE status IN ('dialing','in_progress')`).first<{ n: number }>())!.n;
  const today = now().toISOString().slice(0, 10);
  const dialledToday = (await d.db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE direction = 'outbound' AND started_at >= ? AND id IN (SELECT c.id FROM calls c JOIN sales_calls s ON s.provider_call_id = c.provider_call_id)`).bind(`${today}T00:00:00.000Z`).first<{ n: number }>())!.n;
  const capacity = Math.max(0, Math.min(s.max_concurrent - active, s.max_dials_per_run, s.max_dials_per_day - dialledToday));
  if (capacity === 0) return { detail: `no capacity (active ${active}/${s.max_concurrent}, today ${dialledToday}/${s.max_dials_per_day})`, dialled: 0 };
  const due = (await d.db.prepare(`SELECT * FROM sales_calls WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY created_at LIMIT ?`).bind(now().toISOString(), capacity * 3).all<SalesCallRow>()).results;
  let dialled = 0;
  const notes: string[] = [];
  for (const row of due) {
    if (dialled >= capacity) break;
    const f = await leadFacts(d.db, row.lead_id);
    if (!f) { await block(d.db, row, "blocked", "lead no longer exists", false); continue; }
    const prior = (await d.db.prepare(`SELECT COALESCE(SUM(attempts), 0) AS n FROM sales_calls WHERE lead_id = ? AND id <> ?`).bind(row.lead_id, row.id).first<{ n: number }>())!.n;
    const gate = await gateFor(d.db, f, now(), prior + row.attempts, row.max_attempts);
    if (!gate.eligible || f.phoneE164 !== row.phone_e164) {
      const why = !gate.eligible ? gate.reasons.join("; ") : "the lead's phone number changed since it was queued";
      await block(d.db, row, "blocked", why);
      await d.db.prepare(`UPDATE sales_calls SET eligibility_json = ? WHERE id = ?`).bind(JSON.stringify(gate.reasons), row.id).run();
      notes.push(`${row.id}: blocked`);
      continue;
    }
    if (!withinSalesWindow(now(), f.timeZone, f.state)) {
      const next = nextSalesWindow(now(), f.timeZone, f.state);
      if (!next) { await block(d.db, row, "blocked", "no permitted calling window found in the next 8 days"); continue; }
      await d.db.prepare(`UPDATE sales_calls SET not_before = ?, status_detail = 'outside the recipient''s calling window', updated_at = ? WHERE id = ?`).bind(next.toISOString(), nowIso(), row.id).run();
      notes.push(`${row.id}: outside window`);
      continue;
    }
    const lease = await reservePhone(d.db, row.phone_e164, leaseRef(row.id), SALES_PURPOSE, SALES_LEASE_MS, now());
    if (!lease.ok) {
      if (lease.reason === "do_not_call") await block(d.db, row, "blocked", lease.detail);
      else await d.db.prepare(`UPDATE sales_calls SET not_before = ?, status_detail = ?, updated_at = ? WHERE id = ?`).bind(lease.retryAt ?? new Date(now().getTime() + 30 * 60_000).toISOString(), lease.detail, nowIso(), row.id).run();
      notes.push(`${row.id}: ${lease.detail}`);
      continue;
    }
    const attempt = row.attempts + 1;
    const claim = await d.db.prepare(`UPDATE sales_calls SET status = 'dialing', attempts = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND attempts = ?`).bind(attempt, nowIso(), row.id, row.attempts).run();
    if (claim.meta.changes !== 1) { await releasePhone(d.db, row.phone_e164, leaseRef(row.id), "claim_lost"); continue; }
    const ctx = researchContext(f, now());
    const vars = dynamicVariables({ leadId: f.leadId, businessName: f.businessName, contactName: f.contactName, industry: f.industry, websiteUrl: f.prospect?.website_url ?? null, environment: d.env.ENVIRONMENT, ctx });
    const res = await createRetellPhoneCall({
      apiKey: d.env.RETELL_API_KEY, fetch: d.fetch, sleep: d.sleep,
      body: {
        from_number: s.from_number!, to_number: row.phone_e164, override_agent_id: s.agent_id!,
        idempotency_key: `${row.idempotency_key}_a${attempt}`, honor_internal_dnc: true,
        metadata: { crestmont_env: d.env.ENVIRONMENT, crestmont_sales_call_id: row.id, crestmont_lead_id: row.lead_id, crestmont_test: row.is_test ? "true" : "false" },
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
      await audit(d.db, { actorKind: "system", action: "sales_outbound.dialled", subjectType: "sales_call", subjectId: row.id, details: { attempt, lead: row.lead_id } });
      dialled++;
    } else if (res.retryable && row.transient_failures + 1 < MAX_TRANSIENT_FAILURES) {
      // Same attempt number → same idempotency key on the retry: Retell can never place a second call for it.
      await d.db.prepare(`UPDATE sales_calls SET status = 'queued', attempts = ?, transient_failures = transient_failures + 1, status_detail = ?, not_before = ?, updated_at = ? WHERE id = ?`)
        .bind(row.attempts, res.error, new Date(now().getTime() + 30 * 60_000).toISOString(), nowIso(), row.id).run();
      await releasePhone(d.db, row.phone_e164, leaseRef(row.id), `transient: ${res.error}`);
      notes.push(`${row.id}: ${res.error} (retry with the same idempotency key)`);
    } else {
      await block(d.db, row, "failed", res.error);
      notes.push(`${row.id}: ${res.error}`);
    }
  }
  return { detail: `${dialled} dialled of ${due.length} due (capacity ${capacity})${notes.length ? `; ${notes.join("; ")}` : ""}`.slice(0, 900), dialled };
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
  const fin = await db.prepare(`UPDATE sales_calls SET status = ?, outcome = ?, outcome_source = ?, disconnection_reason = ?, duration_ms = ?, finalized_at = ?, provider_call_id = CASE WHEN ? THEN NULL ELSE provider_call_id END,
        not_before = ?, status_detail = ?, updated_at = ? WHERE id = ? AND finalized_at IS NULL`)
    .bind(retry ? "queued" : outcome === "technical_failure" ? "failed" : "completed", retry ? null : outcome, retry ? null : source, reason, duration, retry ? null : nowIso(() => now), retry ? 1 : 0,
      retry ? new Date(now.getTime() + s.retry_after_hours * 3_600_000).toISOString() : null, retry ? `${outcome} on attempt ${row.attempts}; one more attempt later` : null, nowIso(), row.id).run();
  if (fin.meta.changes !== 1) return { applied: "duplicate" };
  // Retell's own DNC detection (the person asked not to be called and the agent ended the call) is honoured like the function.
  if (reason === "user_requested_dnc") await suppressEverywhere(db, row.phone_e164, { leadId: row.lead_id, detail: `Retell user_requested_dnc on sales call ${row.id}`, actor: "provider" });
  await recordPhoneOutcome(db, row.phone_e164, reason ?? "ended", leaseRef(row.id), now);
  await releasePhone(db, row.phone_e164, leaseRef(row.id), `sales:${outcome}`, retry ? { retryAfter: new Date(now.getTime() + s.retry_after_hours * 3_600_000).toISOString(), now } : { now });
  if (retry) {
    // The retry series keeps its row; the attempt's own call stays in `calls` with its outcome history in audit.
    await audit(db, { actorKind: "webhook", action: "sales_outbound.retry_scheduled", subjectType: "sales_call", subjectId: row.id, details: { outcome, attempt: row.attempts, providerCallId } });
    await addLeadNote(db, row.lead_id, `AI sales call attempt ${row.attempts}: ${outcome.replace(/_/g, " ")}. One more attempt is allowed after ${s.retry_after_hours} hours.`);
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
    case "technical_failure": await notifyOwners(db, "sales_outbound", `${tag}AI sales call ${row.id} failed (${reason ?? "unknown"}).`, "sales_call", row.id); break;
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
