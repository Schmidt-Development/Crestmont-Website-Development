// AI Sales Optimization at a glance (Founder directive 2026-11-08, Phase 10.4). READ-ONLY.
//
// Answers, in plain English and only from records the engine actually wrote, "is the sales script improving itself
// from real calls?": the active version, when calls were last analysed and how many, the main opportunities, the
// latest proposal and its state, outcome trends, the last verified deployment to Retell, and anything blocking the
// loop. Each step of the loop shows when it LAST happened, from its own table; a step that never happened says
// "Not yet" -- nothing here claims an optimization that has no evaluation and version record behind it.
import type { Db } from "../../lib/db.ts";
import { loadControl, listTargets, deployedVersion, type Stage } from "./registry.ts";
import { computeMetrics, topFindings } from "./metrics.ts";
import { STALE_JOB_MS } from "./jobs.ts";

/** What each finding category means for the script, in the words the Founder used. */
export const OPPORTUNITY_TEXT: Record<string, string> = {
  objection: "Objections the agent did not answer well",
  pricing_resistance: "Price objections",
  trust_concern: "Prospects not yet trusting the offer",
  product_misunderstanding: "Prospects misunderstanding what is offered",
  customer_confusion: "Prospects confused by the agent",
  customer_question: "Questions the agent could answer better",
  interruption: "Agent talking over the prospect",
  verbosity: "Unnecessary repetition or long answers",
  failed_qualification: "Weak discovery questions",
  missed_buying_signal: "Missed buying signals (no next step asked for)",
  checkout_friction: "Friction getting to checkout or a booked next step",
  hallucination: "Inaccurate statements",
  unsupported_claim: "Claims or prices that are not published",
  compliance_failure: "Not respecting a refusal, opt-out or required disclosure",
  complaint: "Complaints",
  objection_handled: "Objections handled well",
  effective_opening: "Openings that worked",
};
/** Categories that are strengths, not problems to fix. */
const STRENGTHS = new Set(["objection_handled", "effective_opening"]);

export type ProposalState = "pending" | "approved" | "active" | "rejected" | "retired";
export interface LoopStep { step: string; last: string | null; detail: string }
export interface SalesOptSummary {
  stage: Stage;
  active: { seq: number; since: string | null } | null;
  lastAnalysisAt: string | null;
  analysed30: number; eligible30: number;
  opportunities: { category: string; text: string; count: number }[];
  latestProposal: { id: string; seq: number; rationale: string; state: ProposalState; stateText: string; createdAt: string } | null;
  trend: { connectedNow: number; connectedBefore: number; conversionNow: number | null; conversionBefore: number | null; optOutNow: number | null; optOutBefore: number | null };
  lastDeployment: { stage: string; seq: number; at: string; kind: string } | null;
  blockers: string[];
  loop: LoopStep[];
}

const STATE_TEXT: Record<ProposalState, string> = {
  pending: "Pending: being tested or awaiting the Founder's decision",
  approved: "Approved, not yet live",
  active: "Active on the sales agent",
  rejected: "Rejected (failed testing or declined)",
  retired: "Retired (replaced by a later version)",
};

export async function salesOptSummary(db: Db, stage: Stage, now: Date): Promise<SalesOptSummary> {
  const iso = (d: Date) => d.toISOString();
  const d30 = new Date(now.getTime() - 30 * 86_400_000), d60 = new Date(now.getTime() - 60 * 86_400_000);
  const ctl = await loadControl(db);
  const targets = await listTargets(db);
  const active = await deployedVersion(db, stage);
  const activeSince = active ? (await db.prepare(`SELECT completed_at FROM so_deployments WHERE stage = ? AND version_id = ? AND status = 'verified' ORDER BY created_at DESC LIMIT 1`).bind(stage, active.id).first<{ completed_at: string | null }>())?.completed_at ?? null : null;
  const one = async <T>(sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).first<T>();
  const lastAnalysis = await one<{ at: string | null }>(`SELECT MAX(completed_at) AS at FROM so_analyses WHERE status = 'done'`);
  const analysed30 = (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM so_analyses WHERE status = 'done' AND completed_at >= ?`, iso(d30)))?.n ?? 0;
  const eligible30 = (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM so_call_facts WHERE is_test = 0 AND connected = 1 AND last_event_rank >= 2 AND COALESCE(ended_at, started_at) >= ?`, iso(d30)))?.n ?? 0;
  const opportunities = (await topFindings(db, iso(d30), 12)).filter((f) => !STRENGTHS.has(f.category)).slice(0, 4)
    .map((f) => ({ category: f.category, text: OPPORTUNITY_TEXT[f.category] ?? f.category.replace(/_/g, " "), count: f.count }));

  const p = await one<{ id: string; seq: number; rationale: string; status: string; created_at: string }>(`SELECT id, seq, rationale, status, created_at FROM so_versions WHERE author_kind = 'ai' ORDER BY seq DESC LIMIT 1`);
  let latestProposal: SalesOptSummary["latestProposal"] = null;
  if (p) {
    const live = (["staging", "production"] as const).some((s) => (s === stage ? active : null)?.id === p.id) || (await deployedVersion(db, stage === "production" ? "staging" : "production"))?.id === p.id;
    const state: ProposalState = live ? "active" : p.status === "approved" ? "approved" : p.status === "retired" ? "retired" : ["rejected", "eval_failed"].includes(p.status) ? "rejected" : "pending";
    latestProposal = { id: p.id, seq: p.seq, rationale: p.rationale.slice(0, 400), state, stateText: STATE_TEXT[state], createdAt: p.created_at };
  }

  const now30 = await computeMetrics(db, { stage, from: iso(d30), to: iso(now) });
  const prev30 = await computeMetrics(db, { stage, from: iso(d60), to: iso(d30) });
  const dep = await one<{ stage: string; seq: number; at: string; kind: string }>(`SELECT d.stage, v.seq, COALESCE(d.completed_at, d.created_at) AS at, d.kind FROM so_deployments d JOIN so_versions v ON v.id = d.version_id
      WHERE d.status = 'verified' ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`);

  // What is stopping the loop right now, most fundamental first.
  const blockers: string[] = [];
  if (!targets[stage]) blockers.push(`No ${stage} sales agent is registered, so calls cannot be attributed to a script version and nothing can be deployed.`);
  else if (!targets[stage]!.verified_at) blockers.push(`The ${stage} sales agent has not been verified with Retell yet.`);
  if (ctl.paused) blockers.push("Optimization is paused by the Founder: calls are not analysed and no improvements are proposed (safety monitoring still runs).");
  if (stage === "production" && !ctl.productionActivated) blockers.push("Production optimization is not activated: improvements can be tested on staging only.");
  const stale = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ai_jobs WHERE workflow LIKE 'salesopt_%' AND status = 'queued' AND created_at < ?`, iso(new Date(now.getTime() - STALE_JOB_MS / 6)));
  if ((stale?.n ?? 0) > 0) blockers.push(`${stale!.n} analysis job(s) have waited over an hour: the self-hosted model runner may be offline.`);
  const failed = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ai_jobs WHERE workflow LIKE 'salesopt_%' AND status = 'failed' AND updated_at >= ?`, iso(new Date(now.getTime() - 7 * 86_400_000)));
  if ((failed?.n ?? 0) > 0) blockers.push(`${failed!.n} analysis or proposal job(s) failed in the last 7 days.`);
  const depFail = await one<{ created_at: string }>(`SELECT created_at FROM audit_logs WHERE action IN ('salesopt.deploy_failed','salesopt.rollback_failed','salesopt.wrong_workspace') AND created_at >= ? ORDER BY id DESC LIMIT 1`, iso(new Date(now.getTime() - 7 * 86_400_000)));
  if (depFail) blockers.push("A deployment to Retell failed in the last 7 days (see Failure diagnostics below).");
  if (!eligible30) blockers.push("No connected sales calls in the last 30 days, so there is nothing to learn from yet.");

  const last = async (sql: string, ...b: unknown[]) => (await one<{ at: string | null }>(sql, ...b))?.at ?? null;
  const loop: LoopStep[] = [
    { step: "A sales call finished and its result was received from Retell", last: await last(`SELECT MAX(COALESCE(ended_at, started_at)) AS at FROM so_call_facts WHERE is_test = 0`), detail: "Signed Retell webhook, recorded once per call." },
    { step: "Calls were analysed for missed opportunities and script weaknesses", last: lastAnalysis?.at ?? null, detail: "Self-hosted model plus deterministic checks for unpublished prices, opt-outs and disclosures; every finding is checked against the transcript." },
    { step: "Sales were confirmed against real payments", last: await last(`SELECT MAX(updated_at) AS at FROM so_attributions`), detail: "A sale counts only when Stripe confirms payment, so a call mislabelled as a sale is not rewarded." },
    { step: "An improved script was proposed from recurring patterns", last: await last(`SELECT MAX(created_at) AS at FROM so_versions WHERE author_kind = 'ai'`), detail: "Only the editable part changes; the protected compliance, consent, suppression and pricing policy cannot be edited." },
    { step: "The proposal was tested", last: await last(`SELECT MAX(completed_at) AS at FROM so_eval_runs WHERE status IN ('passed','failed')`), detail: "Static policy checks and simulated conversations must pass before it can be approved." },
    { step: "A version was deployed to Retell and read back", last: dep?.at ?? null, detail: "Only under the deployment policy: the Founder approves, and production must be activated." },
    { step: "Results after deployment were monitored", last: ctl.lastRunAt, detail: ctl.autoRollback ? "Automatic rollback is on: a safety breach restores the previous version." : "Automatic rollback is OFF: a safety breach alerts the Founder instead." },
    { step: "A harmful change was rolled back", last: await last(`SELECT MAX(created_at) AS at FROM so_deployments WHERE kind = 'rollback' AND status = 'verified'`), detail: "Version history is kept, so any earlier version can be restored." },
  ];

  return {
    stage, active: active ? { seq: active.seq, since: activeSince } : null, lastAnalysisAt: lastAnalysis?.at ?? null, analysed30, eligible30, opportunities, latestProposal,
    trend: { connectedNow: now30.connected, connectedBefore: prev30.connected, conversionNow: now30.conversionRate, conversionBefore: prev30.conversionRate, optOutNow: now30.optOutRate, optOutBefore: prev30.optOutRate },
    lastDeployment: dep ?? null, blockers, loop,
  };
}
