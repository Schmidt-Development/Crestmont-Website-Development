// Owner monthly voice budget (CREST-GAP-053; VOICE-005). Same pattern as the paid-AI budget in
// src/services/ai.ts#paidAiBudget: an Owner-set USD cap in business_settings, fail closed when unset.
//
// Spend = the provider-reported cost of every call that started this calendar month (UTC), test calls
// included because the provider bills them too (Retell call_cost.combined_cost, recorded on call_ended /
// call_analyzed). Calls whose cost has not arrived yet count as unknown, never as zero; the page says so.
//
// When the budget is unset or reached, the Retell inbound webhook answers with a "closed" configuration:
// the agent only takes a message (voicemail / callback request), no transfer, no scheduling, a short
// maximum call length, and the outbound queue does not dial. Owners are notified once per month when the
// budget is reached. This complements, and does not replace, the spending limit set in the Retell dashboard.
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { notifyOwners } from "./voice-common.ts";

export const VOICE_BUDGET_KEY = "voice.monthly_budget_usd";
/** Share of the budget at which the monitoring signal turns to a warning. */
export const VOICE_BUDGET_WARN_SHARE = 0.8;

export type VoiceBudgetState = "not_set" | "ok" | "warning" | "exhausted";
export interface VoiceBudget { budgetMicro: number | null; spentMicro: number; unknownCostCalls: number; month: string; state: VoiceBudgetState }

export async function voiceBudget(db: Db, now = new Date()): Promise<VoiceBudget> {
  const row = await db.prepare(`SELECT value FROM business_settings WHERE key = ?`).bind(VOICE_BUDGET_KEY).first<{ value: string }>().catch(() => null);
  const n = row ? Number(row.value) : NaN;
  const budgetMicro = Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : null;
  const month = now.toISOString().slice(0, 7);
  const s = await db.prepare(`SELECT COALESCE(SUM(cost_microusd), 0) AS spent, SUM(CASE WHEN cost_microusd IS NULL AND ended_at IS NOT NULL THEN 1 ELSE 0 END) AS unknown
      FROM calls WHERE substr(started_at, 1, 7) = ?`).bind(month).first<{ spent: number; unknown: number | null }>();
  const spentMicro = s?.spent ?? 0;
  const state: VoiceBudgetState = budgetMicro === null ? "not_set" : spentMicro >= budgetMicro ? "exhausted" : spentMicro >= budgetMicro * VOICE_BUDGET_WARN_SHARE ? "warning" : "ok";
  return { budgetMicro, spentMicro, unknownCostCalls: s?.unknown ?? 0, month, state };
}

/** True when the receptionist may run in full mode (budget set and not reached). */
export const budgetOpen = (b: VoiceBudget) => b.state === "ok" || b.state === "warning";

/** Notifies Owners once per month that the voice budget was reached (and records why calls are closed). */
export async function noteBudgetClosed(db: Db, b: VoiceBudget): Promise<void> {
  if (b.state !== "exhausted") return;
  const seen = await db.prepare(`SELECT 1 FROM notifications WHERE kind = 'voice_budget_exhausted' AND subject_id = ? LIMIT 1`).bind(b.month).first();
  if (seen) return;
  const usd = (m: number) => `$${(m / 1e6).toFixed(2)}`;
  await notifyOwners(db, "voice_budget_exhausted", `The AI receptionist reached its monthly budget (${usd(b.spentMicro)} of ${usd(b.budgetMicro ?? 0)} for ${b.month}). Calls now go to voicemail / callback until the budget is raised or the month ends.`, "setting", b.month);
  await audit(db, { actorKind: "system", action: "voice.budget_exhausted", subjectType: "setting", subjectId: VOICE_BUDGET_KEY, details: { month: b.month, spentMicro: b.spentMicro, budgetMicro: b.budgetMicro } });
}

export class VoiceBudgetError extends Error {}

/** Owner-only writer (route requires voice.manage, which is Owner-only). Empty or 0 clears it (fail closed). */
export async function setVoiceBudget(db: Db, userId: string, raw: string): Promise<string | null> {
  const t = raw.trim();
  const n = t === "" ? 0 : Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 100_000) throw new VoiceBudgetError("Enter a monthly voice budget between 0 and 100000 USD.");
  const before = (await db.prepare(`SELECT value FROM business_settings WHERE key = ?`).bind(VOICE_BUDGET_KEY).first<{ value: string }>())?.value ?? null;
  const value = n > 0 ? String(Math.round(n * 100) / 100) : null;
  if (value) await db.prepare(`INSERT INTO business_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(VOICE_BUDGET_KEY, value, userId, nowIso()).run();
  else await db.prepare(`DELETE FROM business_settings WHERE key = ?`).bind(VOICE_BUDGET_KEY).run();
  await audit(db, { actorUserId: userId, action: "voice.budget_updated", subjectType: "setting", subjectId: VOICE_BUDGET_KEY, details: { before, after: value } });
  return value;
}
