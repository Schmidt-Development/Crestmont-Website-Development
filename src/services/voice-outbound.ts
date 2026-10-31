// Outbound calling foundation (VOICE-003/005). DISABLED BY DEFAULT and never mass-dials:
//  - Two switches must both be on: RETELL_OUTBOUND=on in the environment AND outbound.enabled in the
//    Owner's receptionist settings (which itself requires an approved caller number and outbound agent id).
//  - Only three purposes exist, all of them follow-ups the person asked for or is already part of:
//    callback, consultation_reminder, support_followup. There is no purpose for cold or marketing calls.
//  - Every request needs a staff approval, an unrevoked consent for that exact purpose, no do-not-call
//    entry, a recipient-local calling window, and per-number daily/weekly caps. All are re-checked
//    immediately before dialling, not only when the request was created.
//  - Opt-outs (the caller says "don't call me", Retell's user_requested_dnc, or staff) go on voice_dnc and
//    block every future request, and the request is cancelled.
import { retellKey } from "../adapters/retell-workspaces.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { Env } from "../app/context.ts";
import { audit } from "./security.ts";
import { loadVoiceConfig, nextCallingWindow, withinCallingWindow, toE164, validTimeZone, OUTBOUND_PURPOSES, type OutboundPurpose, type VoiceConfig } from "./voice-settings.ts";
import { createRetellPhoneCall } from "../adapters/retell.ts";
import { addLeadTask, notifyOwners } from "./voice-common.ts";
import { voiceBudget, budgetOpen, noteBudgetClosed } from "./voice-budget.ts";
import { reservePhone, releasePhone, markDialing, recoverExpiredLeases, recordPhoneOutcome } from "./outreach-ledger.ts";

export const OUTBOUND_ENV_FLAG = "RETELL_OUTBOUND";

export interface OutboundGate { enabled: boolean; reasons: string[] }
export function outboundGate(env: Pick<Env, "RETELL_INBOUND_API_KEY" | "RETELL_OUTBOUND" | "ENVIRONMENT">, cfg: VoiceConfig): OutboundGate {
  const reasons: string[] = [];
  if (env.RETELL_OUTBOUND !== "on") reasons.push(`${OUTBOUND_ENV_FLAG} is not "on" in this environment`);
  if (!cfg.outbound.enabled) reasons.push("Outbound calling is off in receptionist settings");
  if (!cfg.outbound.from_number) reasons.push("No approved outbound caller number");
  if (!cfg.outbound.agent_id) reasons.push("No outbound agent id");
  // Receptionist follow-up calls are placed by the receptionist agent, which lives in the inbound workspace.
  if (!retellKey(env, "inbound")) reasons.push("RETELL_INBOUND_API_KEY is not set");
  return { enabled: reasons.length === 0, reasons };
}

export interface OutboundRow {
  id: string; purpose: OutboundPurpose; phone_e164: string; contact_name: string | null; reason: string; lead_id: string | null;
  consultation_id: string | null; consent_id: string | null; status: string; status_detail: string | null; requested_by: string | null;
  approved_by: string | null; attempts: number; transient_failures: number; max_attempts: number; next_attempt_at: string | null; provider_call_id: string | null;
  idempotency_key: string; is_test: number; created_at: string;
}

// ───────────── Do-not-call and consent ─────────────

export async function isDnc(db: Db, phone: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM voice_dnc WHERE phone_e164 = ?`).bind(phone).first());
}

export async function addDnc(db: Db, phoneRaw: string, source: "caller_request" | "staff" | "provider_dnc", detail: string, userId?: string | null): Promise<boolean> {
  const phone = toE164(phoneRaw);
  if (!phone) return false;
  await db.prepare(`INSERT INTO voice_dnc (phone_e164, source, detail, created_by, created_at) VALUES (?,?,?,?,?) ON CONFLICT(phone_e164) DO NOTHING`)
    .bind(phone, source, detail.slice(0, 300), userId ?? null, nowIso()).run();
  const at = nowIso();
  // An opt-out revokes every consent and cancels anything waiting to dial that number.
  await db.batch([
    db.prepare(`UPDATE voice_call_consents SET revoked_at = COALESCE(revoked_at, ?) WHERE phone_e164 = ?`).bind(at, phone),
    db.prepare(`UPDATE voice_outbound_requests SET status = 'cancelled', status_detail = 'Number opted out of calls', updated_at = ? WHERE phone_e164 = ? AND status IN ('pending_approval','approved')`).bind(at, phone),
  ]);
  await audit(db, { actorUserId: userId ?? null, actorKind: userId ? "user" : source === "caller_request" ? "ai" : "webhook", action: "voice.dnc_added", subjectType: "voice_dnc", subjectId: phone.slice(-4), details: { source } });
  return true;
}

export async function recordCallConsent(db: Db, phoneRaw: string, purpose: OutboundPurpose, source: "caller_request" | "staff_recorded", evidence: string, userId?: string | null): Promise<string | null> {
  const phone = toE164(phoneRaw);
  if (!phone || !(OUTBOUND_PURPOSES as readonly string[]).includes(purpose)) return null;
  if (await isDnc(db, phone)) return null;
  const existing = await db.prepare(`SELECT id FROM voice_call_consents WHERE phone_e164 = ? AND purpose = ? AND revoked_at IS NULL`).bind(phone, purpose).first<{ id: string }>();
  if (existing) return existing.id;
  const id = newId("vcc");
  await db.prepare(`INSERT INTO voice_call_consents (id, phone_e164, purpose, source, evidence, granted_at, recorded_by) VALUES (?,?,?,?,?,?,?)`)
    .bind(id, phone, purpose, source, evidence.slice(0, 300), nowIso(), userId ?? null).run();
  return id;
}

// ───────────── Requests ─────────────

export class OutboundError extends Error {
  status: number;
  constructor(msg: string, status = 422) { super(msg); this.status = status; }
}

export interface OutboundInput {
  purpose: OutboundPurpose; phone: string; name?: string | null; reason: string;
  leadId?: string | null; consultationId?: string | null; requestedBy?: string | null; isTest?: boolean;
  /** Evidence when staff record consent at the same time (e.g. "Customer asked by email on 2026-10-28"). */
  consentEvidence?: string | null;
}

/** Creates a request awaiting staff approval. Nothing dials until approval AND every gate passes. */
export async function requestOutbound(db: Db, i: OutboundInput): Promise<OutboundRow & { duplicateOf?: string }> {
  if (!(OUTBOUND_PURPOSES as readonly string[]).includes(i.purpose)) throw new OutboundError("Unsupported call purpose");
  const phone = toE164(i.phone);
  if (!phone) throw new OutboundError("Enter the number in a dialable format (E.164, e.g. +15551234567)");
  // Calling-window rules assume US time zones, and Retell-purchased numbers dial US destinations only.
  if (!phone.startsWith("+1")) throw new OutboundError("Outbound calls are limited to US/Canada (+1) numbers");
  const reason = i.reason.trim();
  if (reason.length < 3 || reason.length > 1000) throw new OutboundError("Describe why the call is being made (3–1000 characters)");
  if (i.consentEvidence && i.consentEvidence.trim().length >= 5) await recordCallConsent(db, phone, i.purpose, "staff_recorded", i.consentEvidence.trim(), i.requestedBy);
  const dnc = await isDnc(db, phone);
  const id = newId("vob"), at = nowIso();
  const consent = await db.prepare(`SELECT id FROM voice_call_consents WHERE phone_e164 = ? AND purpose = ? AND revoked_at IS NULL`).bind(phone, i.purpose).first<{ id: string }>();
  // Outbound dial deduplication (CRM duplicate protection): at most one open request (awaiting approval, approved or
  // dialing) per number, whatever its purpose. One guarded INSERT, so two simultaneous requests cannot both be created.
  // A blocked (DNC) request is still recorded for the audit trail.
  const ins = await db.prepare(`INSERT INTO voice_outbound_requests (id, purpose, phone_e164, contact_name, reason, lead_id, consultation_id, consent_id, status, status_detail, requested_by, idempotency_key, is_test, created_at, updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ? = 1 OR NOT EXISTS (SELECT 1 FROM voice_outbound_requests WHERE phone_e164 = ? AND is_test = ? AND status IN ('pending_approval','approved','dialing'))`)
    .bind(id, i.purpose, phone, i.name?.slice(0, 120) ?? null, reason, i.leadId ?? null, i.consultationId ?? null, consent?.id ?? null,
      dnc ? "blocked" : "pending_approval", dnc ? "Number is on the do-not-call list" : null, i.requestedBy ?? null, `crestmont_${id}`, i.isTest ? 1 : 0, at, at, dnc ? 1 : 0, phone, i.isTest ? 1 : 0).run();
  if (ins.meta.changes !== 1) {
    const open = (await db.prepare(`SELECT * FROM voice_outbound_requests WHERE phone_e164 = ? AND is_test = ? AND status IN ('pending_approval','approved','dialing') ORDER BY created_at LIMIT 1`).bind(phone, i.isTest ? 1 : 0).first<OutboundRow>())!;
    await audit(db, { actorUserId: i.requestedBy ?? null, actorKind: i.requestedBy ? "user" : "ai", action: "voice.outbound_duplicate_suppressed", subjectType: "voice_outbound_request", subjectId: open.id, details: { purpose: i.purpose, existingPurpose: open.purpose } });
    if (i.leadId && open.lead_id !== i.leadId) await addLeadTask(db, i.leadId, `${i.isTest ? "[TEST] " : ""}Another ${i.purpose.replace(/_/g, " ")} call was requested for ${i.name ?? "this contact"}, but request ${open.id} (${open.purpose.replace(/_/g, " ")}) is already open for the same number. Handle both in that one call.`, 1);
    return Object.assign(open, { duplicateOf: open.id });
  }
  await audit(db, { actorUserId: i.requestedBy ?? null, actorKind: i.requestedBy ? "user" : "ai", action: "voice.outbound_requested", subjectType: "voice_outbound_request", subjectId: id, details: { purpose: i.purpose, blocked: dnc } });
  return (await getOutbound(db, id))!;
}

export async function getOutbound(db: Db, id: string): Promise<OutboundRow | null> {
  return db.prepare(`SELECT * FROM voice_outbound_requests WHERE id = ?`).bind(id).first<OutboundRow>();
}

export async function listOutbound(db: Db, limit = 50): Promise<OutboundRow[]> {
  return (await db.prepare(`SELECT * FROM voice_outbound_requests ORDER BY CASE status WHEN 'pending_approval' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC LIMIT ?`).bind(limit).all<OutboundRow>()).results;
}

export async function decideOutbound(db: Db, userId: string, id: string, decision: "approve" | "cancel", note = ""): Promise<OutboundRow> {
  const row = await getOutbound(db, id);
  if (!row) throw new OutboundError("Request not found", 404);
  if (decision === "approve") {
    if (row.status !== "pending_approval") throw new OutboundError("Only a request awaiting approval can be approved", 409);
    if (await isDnc(db, row.phone_e164)) throw new OutboundError("This number is on the do-not-call list", 409);
    const consent = await db.prepare(`SELECT id FROM voice_call_consents WHERE phone_e164 = ? AND purpose = ? AND revoked_at IS NULL`).bind(row.phone_e164, row.purpose).first<{ id: string }>();
    if (!consent) throw new OutboundError("No recorded consent for this purpose. Record how the person asked to be called before approving.", 409);
    await db.prepare(`UPDATE voice_outbound_requests SET status = 'approved', consent_id = ?, approved_by = ?, approved_at = ?, status_detail = ?, updated_at = ? WHERE id = ?`)
      .bind(consent.id, userId, nowIso(), note.trim().slice(0, 300) || null, nowIso(), id).run();
  } else {
    if (!["pending_approval", "approved", "no_answer"].includes(row.status)) throw new OutboundError("This request can no longer be cancelled", 409);
    await db.prepare(`UPDATE voice_outbound_requests SET status = 'cancelled', status_detail = ?, updated_at = ? WHERE id = ?`).bind(note.trim().slice(0, 300) || "Cancelled by staff", nowIso(), id).run();
    await releasePhone(db, row.phone_e164, { type: "voice_outbound_request", id }, "cancelled");
  }
  await audit(db, { actorUserId: userId, action: "voice.outbound_decided", subjectType: "voice_outbound_request", subjectId: id, details: { decision } });
  return (await getOutbound(db, id))!;
}

// ───────────── Eligibility (re-checked right before dialling) ─────────────

export type Ineligible = { eligible: false; terminal: boolean; reason: string; retryAt?: string };
export type Eligibility = { eligible: true } | Ineligible;

export async function eligibility(db: Db, cfg: VoiceConfig, row: OutboundRow, at: Date, recipientTz: string | null = null): Promise<Eligibility> {
  if (row.status !== "approved") return { eligible: false, terminal: true, reason: `status is ${row.status}` };
  if (!row.approved_by) return { eligible: false, terminal: true, reason: "not approved by staff" };
  if (await isDnc(db, row.phone_e164)) return { eligible: false, terminal: true, reason: "number is on the do-not-call list" };
  const consent = await db.prepare(`SELECT 1 AS x FROM voice_call_consents WHERE phone_e164 = ? AND purpose = ? AND revoked_at IS NULL`).bind(row.phone_e164, row.purpose).first();
  if (!consent) return { eligible: false, terminal: true, reason: "consent for this purpose was revoked or never recorded" };
  const since = (h: number) => new Date(at.getTime() - h * 3_600_000).toISOString();
  const placed = async (h: number) => (await db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE direction = 'outbound' AND to_number = ? AND started_at >= ?`).bind(row.phone_e164, since(h)).first<{ n: number }>())!.n;
  if (await placed(24) >= cfg.outbound.max_per_number_per_day) return { eligible: false, terminal: false, reason: "daily call limit for this number reached", retryAt: new Date(at.getTime() + 24 * 3_600_000).toISOString() };
  if (await placed(24 * 7) >= cfg.outbound.max_per_number_per_week) return { eligible: false, terminal: true, reason: "weekly call limit for this number reached" };
  const tz = recipientTz && validTimeZone(recipientTz) ? recipientTz : null;
  if (!withinCallingWindow(cfg, at, tz)) {
    const next = nextCallingWindow(cfg, at, tz);
    return { eligible: false, terminal: !next, reason: "outside the recipient's calling hours", retryAt: next?.toISOString() };
  }
  return { eligible: true };
}

// ───────────── Queue processing (scheduled job "voice_outbound") ─────────────

/** A dial with no call result after this long is treated as lost (Retell calls are capped at hours, results arrive in minutes). */
export const STALE_DIALING_MS = 3 * 3_600_000;
const MAX_TRANSIENT_FAILURES = 3;
/** A number's lease outlives the dial it protects; stale-dial recovery (above) releases it, expiry is the backstop. */
export const DIAL_LEASE_MS = STALE_DIALING_MS + 30 * 60_000;

export interface OutboundDeps { db: Db; env: Pick<Env, "RETELL_INBOUND_API_KEY" | "RETELL_OUTBOUND" | "ENVIRONMENT">; fetch: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void> }

async function failToHuman(db: Db, row: OutboundRow, status: "failed" | "no_answer" | "blocked", detail: string) {
  await db.prepare(`UPDATE voice_outbound_requests SET status = ?, status_detail = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?`).bind(status, detail.slice(0, 500), nowIso(), row.id).run();
  await releasePhone(db, row.phone_e164, { type: "voice_outbound_request", id: row.id }, `${status}: ${detail}`);
  const text = `${row.is_test ? "[TEST] " : ""}Outbound ${row.purpose.replace(/_/g, " ")} to ${row.contact_name ?? "contact"} (${row.phone_e164}) needs a person: ${detail}`;
  if (row.lead_id) await addLeadTask(db, row.lead_id, text, 4);
  await notifyOwners(db, "voice_outbound", text, "voice_outbound_request", row.id);
}

export async function processOutboundQueue(d: OutboundDeps): Promise<{ detail: string; dialled: number }> {
  const now = d.now ?? (() => new Date());
  const cfg = await loadVoiceConfig(d.db);
  const gate = outboundGate(d.env, cfg);
  if (!gate.enabled) return { detail: `skipped: outbound disabled (${gate.reasons.join("; ")})`, dialled: 0 };
  // Cost control (CREST-GAP-053): nothing is dialled without an Owner voice budget, or once it is reached.
  const budget = await voiceBudget(d.db, now());
  if (!budgetOpen(budget)) {
    await noteBudgetClosed(d.db, budget);
    return { detail: `skipped: voice budget ${budget.state === "not_set" ? "not set" : "reached"}`, dialled: 0 };
  }
  // Recovery: a request whose call result never arrived (lost webhook, Worker stopped after the claim) is handed
  // to a person rather than staying in 'dialing' for ever. It is never re-dialled automatically.
  const stale = (await d.db.prepare(`SELECT * FROM voice_outbound_requests WHERE status = 'dialing' AND updated_at < ?`)
    .bind(new Date(now().getTime() - STALE_DIALING_MS).toISOString()).all<OutboundRow>()).results;
  for (const row of stale) await failToHuman(d.db, row, "failed", "no call result was received from Retell; check the Retell call log before calling again");
  // Crash recovery for number leases whose holder never released them.
  const recovered = await recoverExpiredLeases(d.db, now());
  const due = (await d.db.prepare(`SELECT * FROM voice_outbound_requests WHERE status = 'approved' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT 5`)
    .bind(now().toISOString()).all<OutboundRow>()).results;
  let dialled = 0;
  const notes: string[] = [];
  for (const row of due) {
    const el = await eligibility(d.db, cfg, row, now());
    if (!el.eligible) {
      if (el.terminal) await failToHuman(d.db, row, "blocked", el.reason);
      else await d.db.prepare(`UPDATE voice_outbound_requests SET next_attempt_at = ?, status_detail = ?, updated_at = ? WHERE id = ?`).bind(el.retryAt ?? null, el.reason, nowIso(), row.id).run();
      notes.push(`${row.id}: ${el.reason}`);
      continue;
    }
    const attempt = row.attempts + 1;
    const ref = { type: "voice_outbound_request" as const, id: row.id };
    // Number-level lease (outreach ledger): no other request, worker or run can dial this number while it is held.
    const lease = await reservePhone(d.db, row.phone_e164, ref, row.purpose, DIAL_LEASE_MS, now());
    if (!lease.ok) {
      if (lease.reason === "do_not_call") await failToHuman(d.db, row, "blocked", lease.detail);
      else await d.db.prepare(`UPDATE voice_outbound_requests SET next_attempt_at = ?, status_detail = ?, updated_at = ? WHERE id = ?`).bind(lease.retryAt ?? new Date(now().getTime() + 30 * 60_000).toISOString(), lease.detail, nowIso(), row.id).run();
      notes.push(`${row.id}: ${lease.detail}`);
      continue;
    }
    // Claim before calling Retell so an overlapping run cannot dial the same request twice.
    const claim = await d.db.prepare(`UPDATE voice_outbound_requests SET status = 'dialing', attempts = ?, updated_at = ? WHERE id = ? AND status = 'approved' AND attempts = ?`)
      .bind(attempt, nowIso(), row.id, row.attempts).run();
    if (claim.meta.changes !== 1) { await releasePhone(d.db, row.phone_e164, ref, "claim_lost"); continue; }
    const res = await createRetellPhoneCall({
      apiKey: retellKey(d.env, "inbound"), fetch: d.fetch, sleep: d.sleep,
      body: {
        from_number: cfg.outbound.from_number!, to_number: row.phone_e164, override_agent_id: cfg.outbound.agent_id!,
        idempotency_key: `${row.idempotency_key}_a${attempt}`, honor_internal_dnc: true,
        metadata: { crestmont_env: d.env.ENVIRONMENT, crestmont_outbound_request_id: row.id, crestmont_test: row.is_test ? "true" : "false" },
        // Only what the agent needs to open the call. Internal staff notes (row.reason) are never sent.
        retell_llm_dynamic_variables: { contact_name: row.contact_name ?? "", call_purpose: row.purpose, crestmont_env: d.env.ENVIRONMENT },
      },
    });
    if (res.ok) {
      // Same clock as eligibility(), so per-number caps count this call consistently.
      const at = now().toISOString();
      await d.db.batch([
        d.db.prepare(`UPDATE voice_outbound_requests SET provider_call_id = ?, status_detail = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?`).bind(res.callId, at, row.id),
        // call_started may already have created the row (webhooks can beat this response): link it either way.
        d.db.prepare(`INSERT INTO calls (id, provider, provider_call_id, from_number, to_number, direction, recording_consent, started_at, is_test, environment, outbound_request_id, lead_id, created_at)
            VALUES (?, 'retell', ?, ?, ?, 'outbound', 0, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, provider_call_id) DO UPDATE SET
              outbound_request_id = COALESCE(calls.outbound_request_id, excluded.outbound_request_id), direction = 'outbound',
              to_number = COALESCE(calls.to_number, excluded.to_number), lead_id = COALESCE(calls.lead_id, excluded.lead_id),
              environment = COALESCE(calls.environment, excluded.environment), is_test = MAX(calls.is_test, excluded.is_test)`)
          .bind(newId("call"), res.callId, cfg.outbound.from_number, row.phone_e164, at, row.is_test, d.env.ENVIRONMENT, row.id, row.lead_id, at),
      ]);
      await markDialing(d.db, row.phone_e164, lease.reservationId, res.callId, now());
      await audit(d.db, { actorKind: "system", action: "voice.outbound_dialled", subjectType: "voice_outbound_request", subjectId: row.id, details: { attempt } });
      dialled++;
    } else if (res.retryable && row.transient_failures + 1 < MAX_TRANSIENT_FAILURES) {
      // Transient (timeout/429/5xx): Retell may or may not have created the call, so the attempt number and
      // therefore the idempotency key stay the same. A retry with that key can never place a second call.
      await d.db.prepare(`UPDATE voice_outbound_requests SET status = 'approved', attempts = ?, transient_failures = transient_failures + 1, status_detail = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
        .bind(row.attempts, res.error, new Date(now().getTime() + 30 * 60_000).toISOString(), nowIso(), row.id).run();
      await releasePhone(d.db, row.phone_e164, ref, `transient: ${res.error}`);
      notes.push(`${row.id}: ${res.error} (will retry with the same idempotency key)`);
    } else {
      await failToHuman(d.db, row, "failed", res.error);
      notes.push(`${row.id}: ${res.error}`);
    }
  }
  if (recovered.length) notes.push(`${recovered.length} expired number lease(s) recovered`);
  return { detail: `${dialled} dialled of ${due.length} due${notes.length ? `; ${notes.join("; ")}` : ""}`.slice(0, 900), dialled };
}

// ───────────── Results (from Retell call_ended) ─────────────

const NO_ANSWER = new Set(["dial_no_answer", "dial_busy", "voicemail_reached", "user_declined"]);
const UNREACHABLE = new Set(["dial_failed", "invalid_destination", "telephony_provider_permission_denied", "telephony_provider_unavailable", "sip_routing_error", "marked_as_spam", "network_blocked"]);

/** Applies the outcome of an outbound call. Idempotent: only a request still in 'dialing' is changed. */
export async function applyOutboundResult(db: Db, requestId: string, disconnectionReason: string | null, costMicroUsd: number | null, at: Date = new Date()): Promise<string | null> {
  const row = await getOutbound(db, requestId);
  if (!row || row.status !== "dialing") return null;
  const reason = disconnectionReason ?? "";
  const ref = { type: "voice_outbound_request" as const, id: row.id };
  await recordPhoneOutcome(db, row.phone_e164, reason || "ended", ref, at);
  if (costMicroUsd !== null) await db.prepare(`UPDATE voice_outbound_requests SET cost_microusd = COALESCE(cost_microusd, 0) + ? WHERE id = ?`).bind(costMicroUsd, row.id).run();
  if (reason === "user_requested_dnc") {
    await db.prepare(`UPDATE voice_outbound_requests SET status = 'completed', status_detail = 'Recipient asked not to be called again', updated_at = ? WHERE id = ?`).bind(nowIso(), row.id).run();
    await releasePhone(db, row.phone_e164, ref, "user_requested_dnc", { now: at });
    await addDnc(db, row.phone_e164, "provider_dnc", `Retell user_requested_dnc on request ${row.id}`);
    return "completed";
  }
  if (NO_ANSWER.has(reason)) {
    if (row.attempts < row.max_attempts) {
      // Spaced well apart; eligibility re-checks the window and caps when it comes due.
      await db.prepare(`UPDATE voice_outbound_requests SET status = 'approved', status_detail = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
        .bind(`No answer (${reason}); one more attempt later`, new Date(at.getTime() + 4 * 3_600_000).toISOString(), nowIso(), row.id).run();
      // Retry policy is enforced at the number level too: nobody may reserve it again before the retry time.
      await releasePhone(db, row.phone_e164, ref, `no_answer: ${reason}`, { retryAfter: new Date(at.getTime() + 4 * 3_600_000).toISOString(), now: at });
      return "approved";
    }
    await failToHuman(db, row, "no_answer", `no answer after ${row.attempts} attempt(s) (${reason})`);
    return "no_answer";
  }
  if (UNREACHABLE.has(reason) || reason.startsWith("error")) {
    await failToHuman(db, row, "failed", `call could not be completed (${reason || "unknown"})`);
    return "failed";
  }
  await db.prepare(`UPDATE voice_outbound_requests SET status = 'completed', status_detail = ?, updated_at = ? WHERE id = ?`).bind(reason ? `Ended: ${reason}` : null, nowIso(), row.id).run();
  await releasePhone(db, row.phone_e164, ref, reason ? `completed: ${reason}` : "completed", { now: at });
  return "completed";
}
