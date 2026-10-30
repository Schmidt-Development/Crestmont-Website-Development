// Self-hosted model work for sales optimization (SALESOPT-003, SALESOPT-005, SALESOPT-007): call analyses,
// evaluation simulations and improvement proposals. Jobs go through the existing signed runner channel
// (ai_jobs provider "local-runner", src/services/ai-runner.ts) — no paid API. Results are consumed here, grounded and
// checked deterministically. Inputs (which can contain consented transcripts) are deleted once a job is consumed.
import type { Db } from "../../lib/db.ts";
import { newId, nowIso } from "../../lib/db.ts";
import { audit } from "../security.ts";
import { LOCAL_RUNNER } from "../ai.ts";
import { SALES_OPT_WORKFLOW_PREFIX } from "../ai-runner.ts";
import { redactSensitive } from "../voice-common.ts";
import { ANALYZER_VERSION, analysisPrompt, deterministicFindings, extractJson, groundAnalysis, parseProposal, proposalPrompt, type EvidenceItem, type GroundedFinding, type ProposalContext } from "../../domain/sales-opt/analysis.ts";
import { SCENARIOS, assertScenario, simulationPrompt } from "../../domain/sales-opt/evaluation.ts";
import { composeSalesPrompt, hasProtectedPolicy, salesPolicyViolations } from "../../domain/sales-opt/policy.ts";
import { createVersion, getVersion, transition, deployedVersion, loadControl, SalesOptError, type VersionRow } from "./registry.ts";
import { computeMetrics, topFindings } from "./metrics.ts";

export const WF = { analysis: `${SALES_OPT_WORKFLOW_PREFIX}analysis`, eval: `${SALES_OPT_WORKFLOW_PREFIX}eval`, proposal: `${SALES_OPT_WORKFLOW_PREFIX}proposal` } as const;
export const MAX_PROMPT = 20_000;
/** A job the runner has not finished after this long is abandoned (runner offline); analysis falls back to deterministic checks. */
export const STALE_JOB_MS = 6 * 3_600_000;

async function queueLocalJob(db: Db, workflow: string, prompt: string, inputRef: string): Promise<string> {
  if (prompt.length > MAX_PROMPT) throw new SalesOptError(`Prompt for ${workflow} is too long for the runner channel (${prompt.length} > ${MAX_PROMPT} characters).`);
  const id = newId("ai"), at = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, created_at, updated_at) VALUES (?,?,?, 'self-hosted', 'queued', ?, ?, ?)`).bind(id, workflow, LOCAL_RUNNER, inputRef.slice(0, 200), at, at),
    db.prepare(`INSERT INTO ai_job_inputs (job_id, prompt, created_at) VALUES (?,?,?)`).bind(id, prompt, at),
  ]);
  return id;
}

interface JobState { status: string; output_ref: string | null; model: string; error: string | null; created_at: string }
const jobState = (db: Db, id: string) => db.prepare(`SELECT status, output_ref, model, error, created_at FROM ai_jobs WHERE id = ?`).bind(id).first<JobState>();

/** Removes the job's retained input and output once consumed (they may contain transcript text). */
async function scrub(db: Db, id: string) {
  await db.batch([
    db.prepare(`DELETE FROM ai_job_inputs WHERE job_id = ?`).bind(id),
    db.prepare(`UPDATE ai_jobs SET output_ref = NULL, updated_at = ? WHERE id = ?`).bind(nowIso(), id),
  ]);
}

async function abandonIfStale(db: Db, id: string, j: JobState, now: Date): Promise<boolean> {
  if (!["queued", "running"].includes(j.status) || now.getTime() - Date.parse(j.created_at) < STALE_JOB_MS) return false;
  await db.prepare(`UPDATE ai_jobs SET status = 'failed', error = 'abandoned: self-hosted runner did not complete in time', updated_at = ? WHERE id = ? AND status IN ('queued','running')`).bind(nowIso(), id).run();
  await db.prepare(`DELETE FROM ai_job_leases WHERE job_id = ?`).bind(id).run();
  return true;
}

// ───────────── Call analysis ─────────────

export async function queueAnalyses(db: Db, limit = 20): Promise<{ queued: number; skipped: number }> {
  const rows = (await db.prepare(`SELECT f.call_id, c.transcript, c.recording_consent FROM so_call_facts f JOIN calls c ON c.id = f.call_id
      LEFT JOIN so_analyses a ON a.call_id = f.call_id AND a.analyzer = ?
      WHERE a.id IS NULL AND f.connected = 1 AND f.last_event_rank >= 2 ORDER BY f.ended_at LIMIT ?`).bind(ANALYZER_VERSION, limit)
    .all<{ call_id: string; transcript: string | null; recording_consent: number }>()).results;
  let queued = 0, skipped = 0;
  for (const r of rows) {
    const id = newId("soan"), at = nowIso();
    const usable = r.recording_consent === 1 && r.transcript && r.transcript.trim().length >= 40;
    const ins = await db.prepare(`INSERT INTO so_analyses (id, call_id, analyzer, status, detail, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(call_id, analyzer) DO NOTHING`)
      .bind(id, r.call_id, ANALYZER_VERSION, usable ? "queued" : "skipped", usable ? null : "no consented transcript", at).run();
    if (ins.meta.changes !== 1) continue;
    if (!usable) { skipped++; continue; }
    const jobId = await queueLocalJob(db, WF.analysis, analysisPrompt(redactSensitive(r.transcript!).slice(0, 16_000)), `so_analysis:${id}`);
    await db.prepare(`UPDATE so_analyses SET ai_job_id = ? WHERE id = ?`).bind(jobId, id).run();
    queued++;
  }
  return { queued, skipped };
}

async function storeFindings(db: Db, analysisId: string, callId: string, findings: GroundedFinding[]) {
  const at = nowIso();
  const seen = new Set<string>();
  for (const f of findings) {
    const key = `${f.category}|${f.line ?? ""}|${f.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await db.prepare(`INSERT INTO so_findings (id, analysis_id, call_id, category, label, basis, evidence_line, evidence_quote, confidence, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(newId("sof"), analysisId, callId, f.category, f.label, f.basis, f.line, f.quote ? redactSensitive(f.quote) : null, f.confidence, at).run();
  }
}

export async function consumeAnalyses(db: Db, now = new Date()): Promise<{ done: number; failed: number }> {
  const rows = (await db.prepare(`SELECT a.id, a.call_id, a.ai_job_id, c.transcript FROM so_analyses a JOIN calls c ON c.id = a.call_id WHERE a.status = 'queued' AND a.ai_job_id IS NOT NULL LIMIT 50`)
    .all<{ id: string; call_id: string; ai_job_id: string; transcript: string | null }>()).results;
  let done = 0, failed = 0;
  for (const r of rows) {
    const j = await jobState(db, r.ai_job_id);
    if (!j) continue;
    if (await abandonIfStale(db, r.ai_job_id, j, now)) j.status = "failed";
    if (j.status !== "succeeded" && j.status !== "failed") continue;
    // Transcript purged by retention in the meantime → nothing may be stored from it.
    if (!r.transcript) {
      await db.prepare(`UPDATE so_analyses SET status = 'skipped', detail = 'transcript no longer retained', completed_at = ? WHERE id = ?`).bind(nowIso(), r.id).run();
      await scrub(db, r.ai_job_id);
      continue;
    }
    const transcript = redactSensitive(r.transcript);
    const det = deterministicFindings(transcript);
    if (j.status === "succeeded") {
      const g = groundAnalysis(extractJson(j.output_ref ?? ""), transcript);
      await storeFindings(db, r.id, r.call_id, [...det, ...g.findings]);
      await db.prepare(`UPDATE so_call_facts SET qualified = COALESCE(?, qualified), product_discussed = COALESCE(?, product_discussed),
          pricing_discussed = MAX(pricing_discussed, COALESCE(?, 0)), follow_up_requested = MAX(follow_up_requested, COALESCE(?, 0)) WHERE call_id = ?`)
        .bind(g.qualified === null ? null : g.qualified ? 1 : 0, g.product, g.pricingDiscussed ? 1 : 0, g.followUpRequested ? 1 : 0, r.call_id).run();
      await db.prepare(`UPDATE so_analyses SET status = 'done', model = ?, detail = ?, completed_at = ? WHERE id = ?`)
        .bind(j.model, `${g.findings.filter((f) => f.basis === "observed").length} observed, ${g.findings.filter((f) => f.basis === "interpreted").length} interpreted, ${det.length} deterministic`, nowIso(), r.id).run();
      done++;
    } else {
      // Model unavailable: the deterministic compliance checks still run, so safety monitoring never depends on the model.
      await storeFindings(db, r.id, r.call_id, det);
      await db.prepare(`UPDATE so_analyses SET status = 'done', model = NULL, detail = ?, completed_at = ? WHERE id = ?`)
        .bind(`model unavailable (${(j.error ?? "failed").slice(0, 120)}); ${det.length} deterministic finding(s) only`, nowIso(), r.id).run();
      failed++;
    }
    await scrub(db, r.ai_job_id);
  }
  return { done, failed };
}

/** Retention: evidence quotes go when the call's transcript goes (retention.voice_transcripts_days / caller erasure). */
export async function purgeOrphanedEvidence(db: Db): Promise<number> {
  // The model-written label can paraphrase the caller, so it goes too (replaced by the category).
  return (await db.prepare(`UPDATE so_findings SET evidence_quote = NULL, label = category WHERE (evidence_quote IS NOT NULL OR label <> category) AND call_id IN (SELECT id FROM calls WHERE transcript IS NULL)`).run()).meta.changes;
}

// ───────────── Evaluation ─────────────

export async function startEvaluation(db: Db, versionId: string, userId: string | null): Promise<{ runId: string; staticOk: boolean; problems: string[] }> {
  const v = await getVersion(db, versionId);
  if (!v) throw new SalesOptError("Version not found", 404);
  const running = await db.prepare(`SELECT id FROM so_eval_runs WHERE version_id = ? AND status = 'running'`).bind(versionId).first<{ id: string }>();
  if (running) throw new SalesOptError("An evaluation of this version is already running.", 409);
  await transition(db, versionId, "evaluating", { userId });
  const prompt = composeSalesPrompt(v.instructions);
  const problems = [...salesPolicyViolations(v.instructions)];
  if (!hasProtectedPolicy(prompt)) problems.push("composed prompt does not start with the protected policy");
  const sims = SCENARIOS.map((s) => ({ s, p: simulationPrompt(s, prompt) }));
  if (sims.some((x) => x.p.length > MAX_PROMPT)) problems.push("prompt too long to simulate on the runner channel");
  const runId = newId("soer"), at = nowIso();
  await db.prepare(`INSERT INTO so_eval_runs (id, version_id, status, static_ok, summary, created_by, created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(runId, versionId, problems.length ? "failed" : "running", problems.length ? 0 : 1, problems.length ? problems.join(" ").slice(0, 2000) : `queued ${SCENARIOS.length} scenarios`, userId, at).run();
  if (problems.length) {
    await db.prepare(`UPDATE so_eval_runs SET completed_at = ? WHERE id = ?`).bind(at, runId).run();
    await transition(db, versionId, "eval_failed", { userId, note: "static policy checks failed" });
    return { runId, staticOk: false, problems };
  }
  for (const { s, p } of sims) {
    const jobId = await queueLocalJob(db, WF.eval, p, `so_eval:${runId}:${s.id}`);
    await db.prepare(`INSERT INTO so_eval_results (id, run_id, scenario, ai_job_id, status) VALUES (?,?,?,?, 'queued')`).bind(newId("soes"), runId, s.id, jobId).run();
  }
  await audit(db, { actorUserId: userId, actorKind: userId ? "user" : "system", action: "salesopt.eval_started", subjectType: "so_version", subjectId: versionId, details: { run: runId } });
  return { runId, staticOk: true, problems: [] };
}

export async function consumeEvaluations(db: Db, now = new Date()): Promise<{ completedRuns: number }> {
  const results = (await db.prepare(`SELECT r.id, r.run_id, r.scenario, r.ai_job_id FROM so_eval_results r JOIN so_eval_runs e ON e.id = r.run_id WHERE r.status = 'queued' AND e.status = 'running' LIMIT 100`)
    .all<{ id: string; run_id: string; scenario: string; ai_job_id: string }>()).results;
  for (const r of results) {
    const j = await jobState(db, r.ai_job_id);
    if (!j) continue;
    if (await abandonIfStale(db, r.ai_job_id, j, now)) j.status = "failed";
    if (j.status === "succeeded") {
      const s = SCENARIOS.find((x) => x.id === r.scenario)!;
      const out = (j.output_ref ?? "").slice(0, 12_000);
      const a = assertScenario(s, out);
      await db.prepare(`UPDATE so_eval_results SET status = ?, assertions_json = ?, transcript = ?, completed_at = ? WHERE id = ?`)
        .bind(a.ok ? "passed" : "failed", JSON.stringify(a.results), out, nowIso(), r.id).run();
      await scrub(db, r.ai_job_id);
    } else if (j.status === "failed") {
      await db.prepare(`UPDATE so_eval_results SET status = 'error', assertions_json = ?, completed_at = ? WHERE id = ?`).bind(JSON.stringify([{ id: "simulation", ok: false, detail: (j.error ?? "failed").slice(0, 200) }]), nowIso(), r.id).run();
      await scrub(db, r.ai_job_id);
    }
  }
  let completedRuns = 0;
  const runs = (await db.prepare(`SELECT e.id, e.version_id, SUM(r.status = 'queued') AS open, SUM(r.status = 'passed') AS passed, SUM(r.status = 'failed') AS failed, SUM(r.status = 'error') AS errors, COUNT(*) AS total
      FROM so_eval_runs e JOIN so_eval_results r ON r.run_id = e.id WHERE e.status = 'running' GROUP BY e.id`).all<{ id: string; version_id: string; open: number; passed: number; failed: number; errors: number; total: number }>()).results;
  for (const run of runs) {
    if (run.open > 0) continue;
    const ok = run.passed === run.total;
    const status = ok ? "passed" : run.errors > 0 && run.failed === 0 ? "error" : "failed";
    const fin = await db.prepare(`UPDATE so_eval_runs SET status = ?, summary = ?, completed_at = ? WHERE id = ? AND status = 'running'`)
      .bind(status, `${run.passed}/${run.total} scenarios passed${run.failed ? `, ${run.failed} failed` : ""}${run.errors ? `, ${run.errors} could not be simulated` : ""}`, nowIso(), run.id).run();
    if (fin.meta.changes !== 1) continue;
    const v = await getVersion(db, run.version_id);
    if (v?.status === "evaluating") await transition(db, run.version_id, ok ? "eval_passed" : "eval_failed", { note: `evaluation ${status}` });
    completedRuns++;
  }
  return { completedRuns };
}

// ───────────── Improvement proposals ─────────────

export const MIN_ANALYSED_FOR_PROPOSAL = 30;
export const PROPOSAL_INTERVAL_MS = 24 * 3_600_000;

/** Base version for proposals: production's verified version, else staging's, else the newest approved, else v1. */
export async function proposalBase(db: Db): Promise<VersionRow | null> {
  return (await deployedVersion(db, "production")) ?? (await deployedVersion(db, "staging"))
    ?? await db.prepare(`SELECT * FROM so_versions WHERE status = 'approved' ORDER BY seq DESC LIMIT 1`).first<VersionRow>()
    ?? await db.prepare(`SELECT * FROM so_versions ORDER BY seq LIMIT 1`).first<VersionRow>();
}

export async function maybeQueueProposal(db: Db, now = new Date(), opts: { force?: boolean } = {}): Promise<string> {
  const ctl = await loadControl(db);
  if (ctl.paused) return "paused";
  if (!opts.force && ctl.lastProposalAt && now.getTime() - Date.parse(ctl.lastProposalAt) < PROPOSAL_INTERVAL_MS) return "waiting for the daily interval";
  if (await db.prepare(`SELECT 1 AS x FROM so_versions WHERE author_kind = 'ai' AND status IN ('draft','evaluating','eval_passed')`).first()) return "an AI proposal is awaiting a decision";
  if (await db.prepare(`SELECT 1 AS x FROM so_proposal_jobs WHERE status = 'queued'`).first()) return "a proposal is already being generated";
  const base = await proposalBase(db);
  if (!base) return "no base version";
  const from = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const m = await computeMetrics(db, { from, to: now.toISOString(), versionId: base.id });
  if (m.analysed < MIN_ANALYSED_FOR_PROPOSAL) return `needs ${MIN_ANALYSED_FOR_PROPOSAL} analysed calls on v${base.seq} (has ${m.analysed})`;
  const ev = (await db.prepare(`SELECT fi.id, fi.category, fi.label, fi.evidence_quote AS quote FROM so_findings fi JOIN so_call_facts f ON f.call_id = fi.call_id
      WHERE f.version_id = ? AND f.is_test = 0 AND fi.created_at >= ? AND fi.category <> 'effective_opening' ORDER BY fi.basis = 'observed' DESC, fi.confidence DESC, fi.created_at DESC LIMIT 40`)
    .bind(base.id, from).all<EvidenceItem>()).results;
  const ctx: ProposalContext = {
    currentInstructions: base.instructions,
    metrics: { connected: m.connected, conversionRate: m.conversionRate, optOutRate: m.optOutRate, avgDurationS: m.avgDurationS },
    topCategories: (await topFindings(db, from)).map((t) => ({ category: t.category, count: t.count })),
    evidence: ev,
  };
  const jobId = await queueLocalJob(db, WF.proposal, proposalPrompt(ctx), `so_proposal:${base.id}`);
  await db.batch([
    db.prepare(`INSERT INTO so_proposal_jobs (ai_job_id, parent_version_id, evidence_json, status, created_at) VALUES (?,?,?, 'queued', ?)`).bind(jobId, base.id, JSON.stringify(ctx), nowIso()),
    db.prepare(`UPDATE so_control SET last_proposal_at = ? WHERE id = 1`).bind(now.toISOString()),
  ]);
  return `proposal queued from v${base.seq}`;
}

export async function consumeProposals(db: Db, now = new Date()): Promise<{ accepted: number; rejected: number }> {
  const rows = (await db.prepare(`SELECT ai_job_id, parent_version_id, evidence_json FROM so_proposal_jobs WHERE status = 'queued'`).all<{ ai_job_id: string; parent_version_id: string; evidence_json: string }>()).results;
  let accepted = 0, rejected = 0;
  for (const r of rows) {
    const j = await jobState(db, r.ai_job_id);
    if (!j) continue;
    if (await abandonIfStale(db, r.ai_job_id, j, now)) j.status = "failed";
    if (j.status === "failed") {
      await db.prepare(`UPDATE so_proposal_jobs SET status = 'failed', detail = ?, evidence_json = '[]', completed_at = ? WHERE ai_job_id = ?`).bind((j.error ?? "failed").slice(0, 300), nowIso(), r.ai_job_id).run();
      await scrub(db, r.ai_job_id); continue;
    }
    if (j.status !== "succeeded") continue;
    const ctx = JSON.parse(r.evidence_json) as ProposalContext;
    const parsed = parseProposal(j.output_ref ?? "", ctx);
    if (!parsed.ok) {
      await db.prepare(`UPDATE so_proposal_jobs SET status = 'rejected', detail = ?, completed_at = ? WHERE ai_job_id = ?`).bind(parsed.problems.join(" ").slice(0, 1000), nowIso(), r.ai_job_id).run();
      await audit(db, { actorKind: "ai", action: "salesopt.proposal_rejected_automatically", subjectType: "ai_job", subjectId: r.ai_job_id, details: { problems: parsed.problems.slice(0, 5) } });
      rejected++;
    } else {
      const cited = new Set(parsed.proposal.changes.flatMap((c) => c.evidence));
      // Versions are immutable, so they reference findings by id only: quotes stay in so_findings, where retention can purge them.
      // Model-written labels can paraphrase the call, so only ids and categories go into the immutable version.
      const evidence = [{ changes: parsed.proposal.changes }, ...ctx.evidence.filter((e) => cited.has(e.id)).map((e) => ({ id: e.id, category: e.category }))];
      try {
        const v = await createVersion(db, { parentId: r.parent_version_id, instructions: parsed.proposal.instructions, rationale: parsed.proposal.rationale, evidence, authorKind: "ai", author: j.model.slice(0, 120) });
        await db.prepare(`UPDATE so_proposal_jobs SET status = 'accepted', version_id = ?, completed_at = ? WHERE ai_job_id = ?`).bind(v.id, nowIso(), r.ai_job_id).run();
        await startEvaluation(db, v.id, null);
        accepted++;
      } catch (e) {
        await db.prepare(`UPDATE so_proposal_jobs SET status = 'rejected', detail = ?, completed_at = ? WHERE ai_job_id = ?`).bind((e as Error).message.slice(0, 1000), nowIso(), r.ai_job_id).run();
        rejected++;
      }
    }
    // The context held transcript quotes: keep only the finding ids that were offered.
    await db.prepare(`UPDATE so_proposal_jobs SET evidence_json = ? WHERE ai_job_id = ?`).bind(JSON.stringify(ctx.evidence.map((e) => e.id)), r.ai_job_id).run();
    await scrub(db, r.ai_job_id);
  }
  return { accepted, rejected };
}
