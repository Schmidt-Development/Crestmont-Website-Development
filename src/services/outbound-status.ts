// CRM → Retell outbound calling, made visible (Founder directive 2026-11-08, Phase 11). READ-ONLY.
//
// The outbound engine itself is unchanged (src/services/sales-outbound.ts): which leads may enter the queue, the
// compliance gate re-checked immediately before every dial, do-not-call suppression, calling hours, attempt limits,
// the per-lead and per-number "one open call" indexes, and the idempotent result sync from Retell's webhooks
// (applySalesCallEvent: an outcome is written once; retries and out-of-order events change nothing; CRM stages only
// move forward and never touch converted, lost or merged leads). This module only COUNTS and EXPLAINS what that engine
// already records, for the Sales page and the CRM lead page.
//
// Lead selection, for the record: a CRM lead is a candidate only with documented prior express written consent for
// AI-voice calls to its number (sales_call_consents). Leads that merely exist in the CRM (e.g. the 36,000+ imported
// research leads) are never queued -- they are counted below as "not eligible: no documented consent".
import type { Db } from "../lib/db.ts";
import type { Env } from "../app/context.ts";
import { retellKey, keysAmbiguous } from "../adapters/retell-workspaces.ts";
import { loadSalesSettings, salesOutboundSwitch, callbackSwitch, leadFacts, gateFor, CONSENTED_OPEN_WHERE, OPEN_SALES_STAGES } from "./sales-outbound.ts";
import { voiceBudget, type VoiceBudget } from "./voice-budget.ts";

/** Open CRM stages a sales call may be placed for (same list as the engine's candidate query). */
const OPEN_IN = OPEN_SALES_STAGES.map((s) => `'${s}'`).join(",");

/** Each recorded call result, in the words the Sales team uses. */
export const OUTCOME_LABELS: Record<string, string> = {
  interested: "Interested",
  not_interested: "Not interested",
  follow_up_requested: "Callback requested",
  consultation_booked: "Appointment booked",
  wrong_number: "Wrong number",
  no_answer: "No answer",
  voicemail: "Voicemail",
  do_not_call: "Opted out",
  payment_confirmed: "Sale completed",
  checkout_sent: "Checkout link sent",
  technical_failure: "Call failed (technical)",
  unclassified: "Needs manual review",
};
/** Results that need a person to follow up. */
export const FOLLOW_UP_OUTCOMES = ["interested", "follow_up_requested", "consultation_booked", "checkout_sent", "unclassified", "wrong_number"];

export interface OutboundStatus {
  counts: {
    eligible: number; waiting: number; scheduled: number; inProgress: number; completed: number; followUp: number;
    stopped: number; noConsent: number; doNotCall: number; failed: number;
  };
  outcomes: { outcome: string; label: string; n: number }[];
  failures: { id: string; lead_id: string; who: string | null; status: string; detail: string | null; at: string }[];
  candidates: { leadId: string; who: string | null; eligible: boolean; reasons: string[] }[];
  workspace: { keyConfigured: boolean; ambiguous: boolean; agentId: string | null; fromNumber: string | null; lastAudit: { at: string; status: string } | null; environment: string };
  modes: { cold: { on: boolean; running: boolean; reasons: string[] }; callback: { on: boolean; running: boolean; reasons: string[] } };
  budget: VoiceBudget;
  periodDays: number;
}

const n = async (db: Db, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())?.n ?? 0;

/** Leads with documented AI-calling consent that are open in the CRM, not merged, and not yet in a cold call series.
 *  Driven from the consents (evaluated once, leads fetched by primary key), never from all leads: see sales-outbound.ts. */
const CONSENTED_OPEN = `FROM leads l WHERE ${CONSENTED_OPEN_WHERE}`;
const CANDIDATES = `${CONSENTED_OPEN} AND NOT EXISTS (SELECT 1 FROM sales_calls c WHERE c.lead_id = l.id AND c.mode = 'cold')`;

export async function outboundStatus(db: Db, env: Env, now: Date, periodDays = 30): Promise<OutboundStatus> {
  const at = now.toISOString(), since = new Date(now.getTime() - periodDays * 86_400_000).toISOString();
  const s = await loadSalesSettings(db);
  const [cold, cb] = await Promise.all([salesOutboundSwitch(db, env), callbackSwitch(db, env)]);
  const consented = await n(db, `SELECT COUNT(*) AS n ${CONSENTED_OPEN}`);
  const open = await n(db, `SELECT COUNT(*) AS n FROM leads WHERE merged_into_lead_id IS NULL AND stage IN (${OPEN_IN})`);
  const counts = {
    eligible: await n(db, `SELECT COUNT(*) AS n ${CANDIDATES}`),
    waiting: await n(db, `SELECT COUNT(*) AS n FROM sales_calls WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?)`, at),
    scheduled: await n(db, `SELECT COUNT(*) AS n FROM sales_calls WHERE status = 'queued' AND not_before > ?`, at),
    inProgress: await n(db, `SELECT COUNT(*) AS n FROM sales_calls WHERE status IN ('dialing','in_progress')`),
    completed: await n(db, `SELECT COUNT(*) AS n FROM sales_calls WHERE status = 'completed' AND finalized_at >= ?`, since),
    followUp: await n(db, `SELECT COUNT(*) AS n FROM sales_calls c JOIN leads l ON l.id = c.lead_id WHERE c.status = 'completed' AND c.finalized_at >= ?
        AND c.outcome IN (${FOLLOW_UP_OUTCOMES.map(() => "?").join(",")}) AND l.stage NOT IN ('converted','lost','rejected','archived')`, since, ...FOLLOW_UP_OUTCOMES),
    stopped: await n(db, `SELECT COUNT(*) AS n FROM sales_calls WHERE status IN ('blocked','cancelled') AND updated_at >= ?`, since),
    noConsent: Math.max(0, open - consented),
    doNotCall: await n(db, `SELECT COUNT(*) AS n FROM voice_dnc`),
    failed: await n(db, `SELECT COUNT(*) AS n FROM sales_calls WHERE (status = 'failed' AND updated_at >= ?) OR (missed_at IS NOT NULL AND missed_at >= ?)`, since, since),
  };
  const outcomes = (await db.prepare(`SELECT outcome, COUNT(*) AS n FROM sales_calls WHERE outcome IS NOT NULL AND finalized_at >= ? GROUP BY outcome ORDER BY n DESC`).bind(since)
    .all<{ outcome: string; n: number }>()).results.map((r) => ({ ...r, label: OUTCOME_LABELS[r.outcome] ?? r.outcome }));
  const failures = (await db.prepare(`SELECT c.id, c.lead_id, ct.name AS who, c.status, c.status_detail AS detail, c.updated_at AS at FROM sales_calls c
      JOIN leads l ON l.id = c.lead_id JOIN contacts ct ON ct.id = l.contact_id
      WHERE (c.status IN ('failed','blocked') AND c.updated_at >= ?) OR (c.missed_at IS NOT NULL AND c.missed_at >= ?) ORDER BY c.updated_at DESC LIMIT 10`).bind(since, since)
    .all<{ id: string; lead_id: string; who: string | null; status: string; detail: string | null; at: string }>()).results;
  // Why each next candidate would or would not be dialled right now, from the same gate the dialler uses.
  const next = (await db.prepare(`SELECT l.id, (SELECT name FROM contacts WHERE id = l.contact_id) AS who ${CANDIDATES} ORDER BY l.created_at LIMIT 10`).all<{ id: string; who: string | null }>()).results;
  const candidates: OutboundStatus["candidates"] = [];
  for (const c of next) {
    const f = await leadFacts(db, c.id);
    if (!f) continue;
    const g = await gateFor(db, f, now);
    candidates.push({ leadId: c.id, who: c.who, eligible: g.eligible, reasons: g.reasons });
  }
  const audit = await db.prepare(`SELECT created_at, details_json FROM audit_logs WHERE action = 'sales_outbound.retell_audit' ORDER BY created_at DESC LIMIT 1`).first<{ created_at: string; details_json: string | null }>();
  let auditStatus = "unknown";
  try { auditStatus = String((JSON.parse(audit?.details_json ?? "{}") as { status?: string }).status ?? "unknown"); } catch { /* keep unknown */ }
  return {
    counts, outcomes, failures, candidates, periodDays,
    workspace: { keyConfigured: !!retellKey(env, "outbound"), ambiguous: keysAmbiguous(env), agentId: s.agent_id, fromNumber: s.from_number,
      lastAudit: audit ? { at: audit.created_at, status: auditStatus } : null, environment: env.ENVIRONMENT === "production" ? "production" : "staging" },
    modes: { cold: { on: s.enabled === 1, running: cold.enabled, reasons: cold.reasons }, callback: { on: s.callbacks_enabled === 1, running: cb.enabled, reasons: cb.reasons } },
    budget: await voiceBudget(db, now),
  };
}

/** One lead's AI-calling eligibility and call history, for the CRM lead page. */
export async function leadOutboundEligibility(db: Db, leadId: string, now: Date): Promise<{ eligible: boolean; reasons: string[]; calls: { id: string; status: string; outcome: string | null; at: string; mode: string }[] } | null> {
  const f = await leadFacts(db, leadId);
  if (!f) return null;
  const s = await loadSalesSettings(db);
  const attempts = await n(db, `SELECT COALESCE(SUM(attempts), 0) AS n FROM sales_calls WHERE lead_id = ? AND mode = 'cold'`, leadId);
  const g = await gateFor(db, f, now, attempts, s.max_attempts_per_lead);
  const calls = (await db.prepare(`SELECT id, status, outcome, updated_at AS at, mode FROM sales_calls WHERE lead_id = ? ORDER BY created_at DESC LIMIT 10`).bind(leadId)
    .all<{ id: string; status: string; outcome: string | null; at: string; mode: string }>()).results;
  return { eligible: g.eligible, reasons: g.reasons, calls };
}
