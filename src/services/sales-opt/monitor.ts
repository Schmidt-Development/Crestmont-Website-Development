// Post-deployment monitoring, controlled experiments and the scheduled orchestrator (SALESOPT-008, SALESOPT-009).
import type { Db } from "../../lib/db.ts";
import { newId, nowIso } from "../../lib/db.ts";
import { audit } from "../security.ts";
import { notifyOwners } from "../voice-common.ts";
import { assignArm, decideExperiment, safetyBreaches, type ArmCounts, type ExperimentDecision } from "../../domain/sales-opt/stats.ts";
import { deployedVersion, getVersion, loadControl, SalesOptError, STAGES } from "./registry.ts";
import { computeMetrics, safetyCounts } from "./metrics.ts";
import { rollback, rollbackCandidate, type DeployDeps } from "./deploy.ts";
import { reconcileAttributions } from "./attribution.ts";
import { pruneReceipts } from "./ingest.ts";
import { consumeAnalyses, consumeEvaluations, consumeProposals, maybeQueueProposal, purgeOrphanedEvidence, queueAnalyses } from "./jobs.ts";

const alerted = async (db: Db, action: string, subject: string) => !!(await db.prepare(`SELECT 1 AS x FROM audit_logs WHERE action = ? AND subject_id = ? LIMIT 1`).bind(action, subject).first());

/** Checks each stage's live version since it was deployed; rolls back (if enabled) or alerts on a safety breach. */
export async function monitorDeployments(d: DeployDeps): Promise<string[]> {
  const notes: string[] = [];
  const ctl = await loadControl(d.db);
  const now = (d.now ?? (() => new Date()))();
  for (const stage of STAGES) {
    const dep = await d.db.prepare(`SELECT id, version_id, created_at FROM so_deployments WHERE stage = ? AND status = 'verified' ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(stage).first<{ id: string; version_id: string; created_at: string }>();
    if (!dep) continue;
    const m = await computeMetrics(d.db, { stage, from: dep.created_at, to: now.toISOString(), versionId: dep.version_id });
    const breaches = safetyBreaches(safetyCounts(m), ctl.thresholds);
    if (!breaches.length) continue;
    const text = breaches.map((b) => `${b.metric} ${(b.value * 100).toFixed(1)}% (limit ${(b.limit * 100).toFixed(1)}%)`).join(", ");
    if (await alerted(d.db, "salesopt.safety_breach", dep.id)) continue;
    await audit(d.db, { actorKind: "system", action: "salesopt.safety_breach", subjectType: "so_deployment", subjectId: dep.id, details: { stage, breaches: breaches.map((b) => b.metric) } });
    const target = await rollbackCandidate(d.db, stage);
    if (ctl.autoRollback && target) {
      try {
        const r = await rollback(d, stage, null, `Automatic rollback: ${text}`, target);
        notes.push(`${stage}: safety breach (${text}); automatic rollback ${r.status}`);
        continue;
      } catch (e) {
        notes.push(`${stage}: safety breach (${text}); automatic rollback refused: ${(e as Error).message}`);
      }
    } else notes.push(`${stage}: safety breach (${text}); ${target ? "auto-rollback is off" : "no earlier version to roll back to"}`);
    await notifyOwners(d.db, "salesopt_safety_breach", `Sales agent on ${stage} breached safety limits: ${text}. Review and roll back from AI Sales Optimization.`, "so_deployment", dep.id);
  }
  return notes;
}

// ───────────── Experiments ─────────────

export interface ExperimentInput { baselineId: string; candidateId: string; candidateShare: number; minConnectedPerArm: number }

export async function proposeExperiment(db: Db, userId: string, i: ExperimentInput): Promise<string> {
  const base = await deployedVersion(db, "production");
  if (!base || base.id !== i.baselineId) throw new SalesOptError("The baseline must be the version currently verified on the production agent.", 409);
  const cand = await getVersion(db, i.candidateId);
  if (!cand || cand.id === base.id) throw new SalesOptError("Choose a different candidate version.", 422);
  if (!["eval_passed", "approved"].includes(cand.status)) throw new SalesOptError("The candidate must have passed evaluation.", 409);
  if (!(i.candidateShare > 0 && i.candidateShare <= 0.5)) throw new SalesOptError("Candidate share must be more than 0% and at most 50%.");
  if (!Number.isInteger(i.minConnectedPerArm) || i.minConnectedPerArm < 100) throw new SalesOptError("Minimum sample must be at least 100 connected calls per arm.");
  const id = newId("soex");
  await db.prepare(`INSERT INTO so_experiments (id, baseline_version_id, candidate_version_id, candidate_share, min_connected_per_arm, status, created_by, created_at) VALUES (?,?,?,?,?, 'proposed', ?, ?)`)
    .bind(id, base.id, cand.id, i.candidateShare, i.minConnectedPerArm, userId, nowIso()).run();
  await audit(db, { actorUserId: userId, action: "salesopt.experiment_proposed", subjectType: "so_experiment", subjectId: id, details: { share: i.candidateShare, min: i.minConnectedPerArm } });
  return id;
}

export async function decideExperimentStatus(db: Db, userId: string, id: string, action: "start" | "stop"): Promise<void> {
  const e = await db.prepare(`SELECT status FROM so_experiments WHERE id = ?`).bind(id).first<{ status: string }>();
  if (!e) throw new SalesOptError("Experiment not found", 404);
  if (action === "start") {
    if (e.status !== "proposed") throw new SalesOptError("Only a proposed experiment can start.", 409);
    try {
      await db.prepare(`UPDATE so_experiments SET status = 'running', approved_by = ?, started_at = ? WHERE id = ? AND status = 'proposed'`).bind(userId, nowIso(), id).run();
    } catch (err) {
      if (/UNIQUE/.test((err as Error).message)) throw new SalesOptError("Another experiment is already running.", 409);
      throw err;
    }
  } else {
    if (!["proposed", "running"].includes(e.status)) throw new SalesOptError("This experiment has already ended.", 409);
    await db.prepare(`UPDATE so_experiments SET status = 'stopped', decision = COALESCE(decision, 'stopped_by_founder'), ended_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  }
  await audit(db, { actorUserId: userId, action: `salesopt.experiment_${action}`, subjectType: "so_experiment", subjectId: id });
}

/**
 * Arm for a lead in the running experiment, for whatever creates calls. Stamp the returned version id as
 * metadata.crestmont_so_version and the experiment id as metadata.crestmont_so_experiment so outcomes attribute
 * correctly. Nothing in this repository places sales calls; see docs/voice/SALES-OPTIMIZATION.md §Experiments.
 */
export async function experimentRouting(db: Db, leadKey: string): Promise<{ experimentId: string; arm: "baseline" | "candidate"; versionId: string } | null> {
  const e = await db.prepare(`SELECT id, baseline_version_id, candidate_version_id, candidate_share FROM so_experiments WHERE status = 'running'`).first<{ id: string; baseline_version_id: string; candidate_version_id: string; candidate_share: number }>();
  if (!e) return null;
  const arm = await assignArm(e.id, leadKey, e.candidate_share);
  return { experimentId: e.id, arm, versionId: arm === "candidate" ? e.candidate_version_id : e.baseline_version_id };
}

export async function experimentReport(db: Db, id: string, now = new Date()): Promise<{ baseline: ArmCounts; candidate: ArmCounts; decision: ExperimentDecision } | null> {
  const e = await db.prepare(`SELECT * FROM so_experiments WHERE id = ?`).bind(id).first<{ id: string; min_connected_per_arm: number; started_at: string | null; ended_at: string | null; created_at: string }>();
  if (!e) return null;
  const range = { from: e.started_at ?? e.created_at, to: e.ended_at ?? now.toISOString() };
  const arm = async (a: "baseline" | "candidate"): Promise<ArmCounts> => {
    const m = await computeMetrics(db, { stage: "production", ...range, experimentId: id, arm: a });
    return { connected: m.connected, conversions: m.sales, revenueCents: m.revenueCents, safety: safetyCounts(m) };
  };
  const baseline = await arm("baseline"), candidate = await arm("candidate");
  return { baseline, candidate, decision: decideExperiment(baseline, candidate, e.min_connected_per_arm, (await loadControl(db)).thresholds) };
}

/** Stops a running experiment on a candidate safety breach and records the statistical recommendation. Never promotes. */
export async function monitorExperiments(db: Db, now = new Date()): Promise<string | null> {
  const e = await db.prepare(`SELECT id FROM so_experiments WHERE status = 'running'`).first<{ id: string }>();
  if (!e) return null;
  const rep = (await experimentReport(db, e.id, now))!;
  await db.prepare(`UPDATE so_experiments SET decision = ?, decision_detail = ? WHERE id = ?`).bind(rep.decision.decision, rep.decision.detail.slice(0, 1000), e.id).run();
  if (rep.decision.decision === "stop_safety") {
    await db.prepare(`UPDATE so_experiments SET status = 'stopped', ended_at = ? WHERE id = ? AND status = 'running'`).bind(now.toISOString(), e.id).run();
    await audit(db, { actorKind: "system", action: "salesopt.experiment_stopped_safety", subjectType: "so_experiment", subjectId: e.id });
    await notifyOwners(db, "salesopt_experiment_stopped", `Sales experiment stopped automatically: ${rep.decision.detail}`, "so_experiment", e.id);
  }
  return `experiment ${e.id}: ${rep.decision.decision}`;
}

// ───────────── Scheduled orchestrator (job "sales_opt") ─────────────

export async function runSalesOpt(d: DeployDeps): Promise<string> {
  const now = (d.now ?? (() => new Date()))();
  const ctl = await loadControl(d.db);
  const parts: string[] = [];
  parts.push(`${await pruneReceipts(d.db, now)} receipts pruned`);
  const a = await reconcileAttributions(d.db, now);
  parts.push(`attribution: ${a.created} new, ${a.updated} updated of ${a.payments} payments`);
  parts.push(`${await purgeOrphanedEvidence(d.db)} purged quotes`);
  const ca = await consumeAnalyses(d.db, now);
  const ce = await consumeEvaluations(d.db, now);
  const cp = await consumeProposals(d.db, now);
  parts.push(`analyses ${ca.done} done/${ca.failed} deterministic-only; ${ce.completedRuns} evaluations finished; proposals ${cp.accepted} accepted/${cp.rejected} rejected`);
  if (ctl.paused) parts.push("optimization paused: nothing new queued");
  else {
    const q = await queueAnalyses(d.db);
    parts.push(`${q.queued} analyses queued, ${q.skipped} without consented transcript`);
    parts.push(`proposal: ${await maybeQueueProposal(d.db, now)}`);
  }
  // Safety monitoring runs even while paused.
  parts.push(...(await monitorDeployments(d)));
  const ex = await monitorExperiments(d.db, now);
  if (ex) parts.push(ex);
  const detail = parts.join("; ").slice(0, 900);
  await d.db.prepare(`UPDATE so_control SET last_run_at = ?, last_run_detail = ? WHERE id = 1`).bind(now.toISOString(), detail).run();
  return detail;
}
