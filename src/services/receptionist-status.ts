// What is actually true about the AI receptionist in THIS environment (Founder directive 2026-11-08, Phase 12).
//
// The receptionist page used to read a generic "voice provider" check (VOICE_WEBHOOK_SECRET, written before Retell was
// chosen) and a Business-settings phone field, so it said "not configured" while real Retell calls were being answered.
// This reads the sources the receptionist really uses:
//   - provider: the receptionist workspace key (RETELL_INBOUND_API_KEY), which also verifies Retell's webhook signatures;
//   - phone number: this environment's voice settings (inbound.numbers), and the numbers real calls arrived on;
//   - agent: the agent override in voice settings and the agent the last live Retell audit read;
//   - evidence: signed, non-test calls recorded in this environment, provider-reported call costs, and the last
//     read-only audit of the live Retell configuration.
// Status words follow one rule: "Verified" only with evidence from this environment (a real signed call or a passing
// live audit); "Configured, not verified" when settings exist but nothing has proven them; "Not configured" when the
// setting is missing; "Failing" when the evidence shows a fault. Staging evidence never counts for production.
import type { Db } from "../lib/db.ts";
import type { Env } from "../app/context.ts";
import { retellKey, keysAmbiguous } from "../adapters/retell-workspaces.ts";
import { loadVoiceConfig } from "./voice-settings.ts";

export type ReceptionistState = "not_configured" | "configured_unverified" | "verified" | "failing";
export interface ReceptionistItem { state: ReceptionistState; label: string; detail: string }
export interface ReceptionistStatus {
  environment: string;
  provider: ReceptionistItem; phone: ReceptionistItem; agent: ReceptionistItem; webhooks: ReceptionistItem; costs: ReceptionistItem;
  lastRealCallAt: string | null; realCalls30: number;
}

const LABEL: Record<ReceptionistState, string> = { not_configured: "Not configured", configured_unverified: "Configured, not verified", verified: "Verified", failing: "Failing" };
const item = (state: ReceptionistState, detail: string): ReceptionistItem => ({ state, label: LABEL[state], detail });
const last4 = (n: string) => `…${n.replace(/\D/g, "").slice(-4)}`;

export async function receptionistStatus(db: Db, env: Env, now = new Date()): Promise<ReceptionistStatus> {
  const environment = env.ENVIRONMENT === "production" ? "production" : env.ENVIRONMENT === "staging" ? "staging" : "development";
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const cfg = await loadVoiceConfig(db);
  // Real calls: signed by Retell (the webhook refuses anything else), not test calls, recorded by THIS environment.
  const real = await db.prepare(`SELECT COUNT(*) AS n, MAX(started_at) AS last, COALESCE(SUM(cost_microusd IS NOT NULL), 0) AS costed, COALESCE(SUM(ended_at IS NOT NULL), 0) AS ended,
        COALESCE(SUM(error IS NOT NULL OR outcome = 'error'), 0) AS errors
      FROM calls WHERE provider = 'retell' AND is_test = 0 AND direction = 'inbound' AND started_at >= ? AND (environment IS NULL OR environment = ?)`).bind(since, environment)
    .first<{ n: number; last: string | null; costed: number; ended: number; errors: number }>();
  const n = real?.n ?? 0;
  const toNumbers = (await db.prepare(`SELECT DISTINCT to_number FROM calls WHERE provider = 'retell' AND is_test = 0 AND direction = 'inbound' AND to_number IS NOT NULL AND started_at >= ? AND (environment IS NULL OR environment = ?) LIMIT 5`)
    .bind(since, environment).all<{ to_number: string }>()).results.map((r) => r.to_number);
  const auditRow = await db.prepare(`SELECT created_at, subject_id, details_json FROM audit_logs WHERE action = 'voice.retell_audit' ORDER BY created_at DESC LIMIT 1`).first<{ created_at: string; subject_id: string | null; details_json: string | null }>();
  let auditStatus: string | null = null;
  try { auditStatus = auditRow ? String((JSON.parse(auditRow.details_json ?? "{}") as { status?: string }).status ?? "") || null : null; } catch { auditStatus = null; }
  const auditOk = auditStatus === "ok", auditBad = auditStatus === "issues" || auditStatus === "failed";
  const auditWhen = auditRow ? auditRow.created_at.slice(0, 10) : null;

  const key = !!retellKey(env, "inbound");
  const provider = keysAmbiguous(env) ? item("failing", "RETELL_INBOUND_API_KEY and RETELL_OUTBOUND_API_KEY are identical, so receptionist and sales requests cannot be told apart and every Retell request is refused. Set each to its own workspace's key.")
    : !key ? item("not_configured", `RETELL_INBOUND_API_KEY (the receptionist's Retell workspace key) is not set in ${environment}, so Retell's signed webhooks and function calls are refused here.`)
    : n ? item("verified", `Retell receptionist workspace key set; ${n} real signed call${n === 1 ? "" : "s"} received in ${environment} in the last 30 days (latest ${real!.last!.slice(0, 16).replace("T", " ")} UTC).`)
    : auditOk ? item("verified", `Retell receptionist workspace key set; the live Retell configuration passed the read-only audit on ${auditWhen}. No real call in the last 30 days yet.`)
    : item("configured_unverified", `Retell receptionist workspace key set in ${environment}, but no real signed call has been received here in the last 30 days and no live audit has passed. ${environment === "staging" ? "Calls answered by the production number do not count for staging." : ""}`.trim());

  // Numbers bound in this environment's voice settings, plus the public receptionist number in Business settings.
  const listed = (await db.prepare(`SELECT value FROM business_settings WHERE key = 'voice.phone_number'`).first<{ value: string }>().catch(() => null))?.value?.trim() || null;
  const numbers = [...new Set([...cfg.inbound.numbers, ...(listed ? [listed] : [])])];
  const same = (a: string, b: string) => a.replace(/\D/g, "").slice(-10) === b.replace(/\D/g, "").slice(-10);
  const phone = numbers.length
    ? (toNumbers.some((t) => numbers.some((x) => same(x, t))) ? item("verified", `${numbers.join(", ")} recorded for ${environment}; real calls arrived on ${toNumbers.filter((t) => numbers.some((x) => same(x, t))).map(last4).join(", ")} in the last 30 days.`)
      : item("configured_unverified", `${numbers.join(", ")} recorded for ${environment}; no real call has arrived on it here in the last 30 days, so it is not verified as live.`))
    : toNumbers.length ? item("verified", `Real calls arrived on ${toNumbers.map(last4).join(", ")} in the last 30 days, so the number works with Retell. It is not listed in this environment's voice settings: add it under Operations to bind it to ${environment} (then calls to any other number are refused).`)
    : item("not_configured", `No receptionist number is listed in ${environment}'s voice settings and no real call has arrived here. Numbers are bought and assigned in the Retell dashboard; this platform never buys numbers.`);

  const agentId = cfg.inbound.agent_id ?? auditRow?.subject_id ?? null;
  const agent = auditBad ? item("failing", `The last read-only audit of the live Retell agent${agentId ? ` (${agentId})` : ""} on ${auditWhen} found problems: see Operations → Retell audit.`)
    : auditOk ? item("verified", `Agent ${agentId ?? "(id not recorded)"} passed the read-only audit of the live Retell configuration on ${auditWhen}.`)
    : n ? item("verified", `Real calls are being answered${agentId ? ` (agent ${agentId})` : " by the agent assigned to the number in Retell"}. Run the Retell audit under Operations to check its prompt, tools and webhook settings.`)
    : agentId ? item("configured_unverified", `Agent ${agentId} is set for ${environment} but has not answered a real call here or passed a live audit.`)
    : item("not_configured", "No receptionist agent is recorded for this environment: the agent assigned to the number in Retell answers, and none has answered a real call here yet.");

  const webhooks = !key ? item("not_configured", "Webhooks cannot be accepted without the receptionist workspace key.")
    : (real?.ended ?? 0) > 0 ? item("verified", `${real!.ended} real call${real!.ended === 1 ? "" : "s"} completed with a signed call_ended event in the last 30 days.`)
    : n ? item("failing", `${n} call${n === 1 ? "" : "s"} started but no signed call_ended event arrived: check the agent's webhook URL and events in Retell.`)
    : item("configured_unverified", "No signed call events received here in the last 30 days.");

  const costs = !n ? item("configured_unverified", "No real calls in the last 30 days, so cost tracking has nothing to show yet.")
    : (real?.costed ?? 0) === n ? item("verified", `Provider-reported cost recorded for all ${n} real call${n === 1 ? "" : "s"} in the last 30 days.`)
    : item("configured_unverified", `Provider-reported cost recorded for ${real!.costed} of ${n} real calls; the rest arrive with Retell's call_analyzed event.`);

  return { environment, provider, phone, agent, webhooks, costs, lastRealCallAt: real?.last ?? null, realCalls30: n };
}
