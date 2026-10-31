// Node 1 dispatch-to-GPU diagnostic (Founder P0 directive, 2026-10-30; migration 0050).
//
// A diagnostic is ONE real, small, deterministic job on the existing signed runner channel: an ai_jobs row with
// workflow "gpu_diagnostic" and provider "local-runner". The self-hosted runner claims it like any AI draft
// (/api/builds/runner/ai/claim), runs it on its local Ollama model and returns the result (/ai/complete). Nothing here
// fakes a step: every checkpoint is written when the transition is observed, by the side that observed it.
//
//  D01 job created      platform   Owner action                      D08 Ollama contacted     runner  /api/version
//  D02 job persisted    platform   row read back                     D09 model loaded         runner  /api/ps (size_vram)
//  D03 worker known     platform   build_runners row at claim time   D10 inference begins     runner  request sent
//  D04 worker fresh     platform   last_seen_at at claim time        D11 inference completes  runner  durations, tokens
//  D05 job offered      platform   returned in a claim response      D12 result received      platform /ai/complete
//  D06 job claimed      platform   lease written                     D13 job finalized        platform terminal state
//  D07 runner acks      runner     first signed checkpoint call from the runner process
//
// A runner that predates diagnostics still serves the job as a plain draft: D07–D11 are then absent (shown as "not
// reported by this runner version") while D05/D06/D12/D13 still prove the round trip.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { HttpError } from "../app/http.ts";
import { randomToken } from "../lib/auth-crypto.ts";
import { sha256Hex, timingSafeEqualHex } from "../lib/crypto.ts";
import { audit } from "./security.ts";
import { LOCAL_RUNNER } from "./ai.ts";
import { sanitize } from "./builds.ts";

export const DIAGNOSTIC_WORKFLOW = "gpu_diagnostic";
export const CHECKPOINTS = ["D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09", "D10", "D11", "D12", "D13"] as const;
export type CheckpointCode = (typeof CHECKPOINTS)[number];
export const RUNNER_CHECKPOINTS: readonly CheckpointCode[] = ["D07", "D08", "D09", "D10", "D11"];
export const CHECKPOINT_LABELS: Record<CheckpointCode, string> = {
  D01: "Job created", D02: "Job persisted", D03: "Worker registered", D04: "Worker heartbeat", D05: "Job offered", D06: "Job claimed",
  D07: "Runner acknowledges", D08: "Ollama contacted", D09: "Model loaded", D10: "GPU inference begins", D11: "Inference completes",
  D12: "Result uploaded", D13: "Job finalized",
};
/** A runner is "fresh" when it called the platform within this window (same rule as the AI builds runner status). */
export const FRESH_MS = 5 * 60_000;
/** Diagnostic lease: cold model load (minutes for a large model) + inference + upload. */
export const DIAGNOSTIC_LEASE_S = 15 * 60;

/** Small, deterministic workload (Founder's suggested prompt). Temperature 0 on the runner. */
export const DIAGNOSTIC_SYSTEM = "You are a diagnostic workload for Crestmont's self-hosted model server. Reply with one complete HTML document and nothing else: no explanation, no Markdown fences.";
export const DIAGNOSTIC_PROMPT = "Generate a minimal HTML document containing a title, heading and paragraph for a fictional junk removal company called Junk in the Trunk.";

/**
 * Runner-supplied evidence is untrusted: credential-shaped strings are redacted and the size is capped. Unlike the
 * general sanitize(), hex digests (prompt hashes, model digests) are kept: they are the evidence.
 */
export function redactEvidence(text: string): string {
  return text
    .replace(/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{10,}/g, "[redacted-token]")
    .replace(/\b(?:sk-ant|sk|rk|pk|whsec)[-_][A-Za-z0-9_-]{10,}/g, "[redacted-key]")
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]")
    .replace(/[A-Za-z0-9+/]{48,}={0,2}/g, (m) => /^[0-9a-f]+$/i.test(m) ? m : "[redacted-blob]")
    .slice(0, 4000);
}
const evid = (v: unknown, trusted = false) => trusted ? JSON.stringify(v ?? null).slice(0, 4000) : redactEvidence(JSON.stringify(v ?? null));

async function addCheckpoint(db: Db, diagnosticId: string, c: { code: CheckpointCode; ok: boolean; at?: string; source: "platform" | "runner"; component: string; worker?: string | null; error?: string | null; evidence?: unknown }) {
  const trusted = c.source === "platform";
  const now = nowIso();
  await db.prepare(`INSERT INTO runner_diagnostic_checkpoints (diagnostic_id, code, ok, at, recorded_at, source, component, worker, error, evidence) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(diagnosticId, c.code, c.ok ? 1 : 0, c.at ?? now, now, c.source, c.component.slice(0, 60), c.worker ? sanitize(c.worker, 80) : null, c.error ? sanitize(c.error, 1000) : null, evid(c.evidence, trusted)).run();
}

/** The diagnostic for an ai_job, or null. Tolerates a Worker running before migration 0050 (drafts keep working). */
async function diagnosticForJob(db: Db, aiJobId: string) {
  try {
    return await db.prepare(`SELECT id, correlation_id FROM runner_diagnostics WHERE ai_job_id = ?`).bind(aiJobId).first<{ id: string; correlation_id: string }>();
  } catch (e) {
    if (/no such table/i.test((e as Error).message)) return null;
    throw e;
  }
}
export async function isDiagnosticJob(db: Db, aiJobId: string): Promise<boolean> { return !!(await diagnosticForJob(db, aiJobId)); }

/** D01 + D02: the Owner creates one diagnostic job; it is read back from the database before D02 is written. */
export async function createDiagnostic(db: Db, userId: string): Promise<{ id: string; correlationId: string; aiJobId: string }> {
  const id = newId("diag"), aiJobId = newId("ai"), correlationId = `corr_${randomToken(8)}`;
  const at = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, created_at, updated_at) VALUES (?,?,?, 'self-hosted', 'queued', ?, ?, ?)`)
      .bind(aiJobId, DIAGNOSTIC_WORKFLOW, LOCAL_RUNNER, `diagnostic:${id}`, at, at),
    db.prepare(`INSERT INTO ai_job_inputs (job_id, prompt, created_at) VALUES (?,?,?)`).bind(aiJobId, DIAGNOSTIC_PROMPT, at),
    db.prepare(`INSERT INTO runner_diagnostics (id, correlation_id, ai_job_id, created_by, created_at) VALUES (?,?,?,?,?)`).bind(id, correlationId, aiJobId, userId, at),
  ]);
  await addCheckpoint(db, id, { code: "D01", ok: true, at, source: "platform", component: "platform", evidence: { aiJobId, correlationId, source: "Owner → AI builds → Node diagnostics", createdBy: userId } });
  const row = await db.prepare(`SELECT status, provider, workflow FROM ai_jobs WHERE id = ?`).bind(aiJobId).first<{ status: string; provider: string; workflow: string }>();
  await addCheckpoint(db, id, { code: "D02", ok: row?.status === "queued", source: "platform", component: "database", error: row ? null : "the job row was not found after the insert", evidence: row ?? null });
  await audit(db, { actorUserId: userId, action: "builds.diagnostic_created", subjectType: "ai_job", subjectId: aiJobId, details: { diagnosticId: id, correlationId } });
  return { id, correlationId, aiJobId };
}

/** D03–D06, written by claimAiJob when it leases a diagnostic job. Returns the fields the runner needs. */
export async function onDiagnosticClaim(db: Db, aiJobId: string, runnerId: string, leaseExpiresAt: string, attempt: number, now: Date): Promise<{ correlationId: string } | null> {
  const d = await diagnosticForJob(db, aiJobId);
  if (!d) return null;
  const r = await db.prepare(`SELECT runner_id, version, capabilities, last_seen_at FROM build_runners WHERE runner_id = ?`).bind(runnerId).first<{ runner_id: string; version: string | null; capabilities: string | null; last_seen_at: string }>();
  await addCheckpoint(db, d.id, { code: "D03", ok: !!r, source: "platform", component: "worker registry", worker: runnerId,
    error: r ? null : "this runner id has never claimed a build (no build_runners row): it reached the draft channel without registering",
    evidence: r ? { runnerId: r.runner_id, version: r.version, capabilities: r.capabilities } : { runnerId } });
  const age = r ? now.getTime() - Date.parse(r.last_seen_at) : null;
  await addCheckpoint(db, d.id, { code: "D04", ok: age !== null && age < FRESH_MS, source: "platform", component: "worker heartbeat", worker: runnerId,
    error: age === null ? "no heartbeat recorded" : age >= FRESH_MS ? `last heartbeat ${Math.round(age / 1000)} s ago` : null,
    evidence: r ? { lastSeenAt: r.last_seen_at, ageSeconds: Math.round((age ?? 0) / 1000) } : null });
  const at = now.toISOString();
  await addCheckpoint(db, d.id, { code: "D05", ok: true, at, source: "platform", component: "dispatch", worker: runnerId, evidence: { model: "pull: the runner asked for work and this job was selected for it" } });
  await addCheckpoint(db, d.id, { code: "D06", ok: true, at, source: "platform", component: "lease", worker: runnerId, evidence: { leaseExpiresAt, attempt } });
  return { correlationId: d.correlation_id };
}

/** D07–D11 from the runner process, authenticated by the job's lease token. */
export async function recordRunnerCheckpoint(db: Db, b: Record<string, unknown>): Promise<{ recorded: true }> {
  const jobId = typeof b.jobId === "string" ? b.jobId : "";
  const token = typeof b.leaseToken === "string" && /^[0-9a-f]{64}$/.test(b.leaseToken) ? b.leaseToken : null;
  const lease = token ? await db.prepare(`SELECT l.token_hash, l.runner_id, j.status FROM ai_job_leases l JOIN ai_jobs j ON j.id = l.job_id WHERE l.job_id = ?`).bind(jobId).first<{ token_hash: string; runner_id: string; status: string }>() : null;
  if (!lease || lease.status !== "running" || !lease.token_hash || !timingSafeEqualHex(lease.token_hash, await sha256Hex(token!))) throw new HttpError(409, "lease_lost");
  const d = await diagnosticForJob(db, jobId);
  if (!d) throw new HttpError(422, "Not a diagnostic job");
  const code = String(b.code ?? "") as CheckpointCode;
  if (!RUNNER_CHECKPOINTS.includes(code)) throw new HttpError(422, "Runner checkpoints are D07–D11");
  if (b.correlationId !== d.correlation_id) throw new HttpError(422, "Correlation id does not match this job");
  const atMs = typeof b.at === "string" ? Date.parse(b.at) : NaN;
  await addCheckpoint(db, d.id, { code, ok: b.ok === true, at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : nowIso(), source: "runner",
    component: typeof b.component === "string" ? b.component : "runner", worker: lease.runner_id, error: typeof b.error === "string" ? b.error : null, evidence: b.evidence });
  return { recorded: true };
}

/** D12 + D13, from completeAiJob. Diagnostics are never retried and never enter the human draft-approval queue. */
export async function onDiagnosticComplete(db: Db, aiJobId: string, b: Record<string, unknown>, runnerId: string): Promise<{ status: "succeeded" | "failed" } | null> {
  const d = await diagnosticForJob(db, aiJobId);
  if (!d) return null;
  const text = typeof b.text === "string" ? b.text.trim().slice(0, 20_000) : "";
  const err = b.error ? sanitize(String(b.error), 500) : null;
  const model = typeof b.model === "string" && /^[\w.:/-]{1,100}$/.test(b.model) ? b.model : null;
  const metrics = b.diagnostic && typeof b.diagnostic === "object" ? b.diagnostic : null;
  await db.prepare(`UPDATE runner_diagnostics SET result_json = ? WHERE id = ?`).bind(evid({ model, inputTokens: Number(b.inputTokens) || 0, outputTokens: Number(b.outputTokens) || 0, metrics }), d.id).run();
  await addCheckpoint(db, d.id, { code: "D12", ok: !!text && !err, source: "platform", component: "result upload", worker: runnerId, error: err ?? (text ? null : "the runner returned no output"),
    evidence: { bytes: new TextEncoder().encode(text).length, sha256: text ? await sha256Hex(text) : null, model, correlationId: b.correlationId === d.correlation_id ? d.correlation_id : "missing (runner predates diagnostics)" } });
  const status = text && !err ? "succeeded" : "failed";
  await db.prepare(`UPDATE ai_jobs SET status = ?, output_ref = ?, model = ?, cost_microusd = 0, error = ?, updated_at = ? WHERE id = ?`)
    .bind(status, text || null, model ? `self-hosted:${model}` : "self-hosted", err, nowIso(), aiJobId).run();
  const row = await db.prepare(`SELECT status FROM ai_jobs WHERE id = ?`).bind(aiJobId).first<{ status: string }>();
  await addCheckpoint(db, d.id, { code: "D13", ok: row?.status === "succeeded", source: "platform", component: "database", worker: runnerId, error: row?.status === "succeeded" ? null : `terminal state ${row?.status ?? "missing"}`, evidence: { status: row?.status ?? null } });
  return { status };
}

/** Lease expired on a diagnostic: no retry (a retry would blur the trace); the gap stays visible. */
export async function onDiagnosticLeaseExpired(db: Db, aiJobId: string, runnerId: string | null): Promise<boolean> {
  const d = await diagnosticForJob(db, aiJobId);
  if (!d) return false;
  await db.prepare(`UPDATE ai_jobs SET status = 'failed', error = 'runner lease expired before the result arrived', updated_at = ? WHERE id = ?`).bind(nowIso(), aiJobId).run();
  await addCheckpoint(db, d.id, { code: "D12", ok: false, source: "platform", component: "lease sweep", worker: runnerId, error: `the runner claimed the job but no result arrived before the ${DIAGNOSTIC_LEASE_S / 60}-minute lease expired` });
  return true;
}

// ── views ──

export interface CheckpointRow { code: CheckpointCode; ok: number; at: string; recorded_at: string; source: string; component: string; worker: string | null; error: string | null; evidence: string | null }
export interface TraceStep { code: CheckpointCode; label: string; row: CheckpointRow | null; elapsedMs: number | null; status: "pass" | "fail" | "missing" }
export interface DiagnosticView {
  id: string; correlationId: string; aiJobId: string; createdAt: string; jobStatus: string; jobError: string | null; output: string | null; model: string | null;
  result: unknown; steps: TraceStep[]; firstFailure: TraceStep | null;
}

export async function getDiagnostic(db: Db, id: string): Promise<DiagnosticView | null> {
  const d = await db.prepare(`SELECT d.id, d.correlation_id, d.ai_job_id, d.created_at, d.result_json, j.status, j.error, j.output_ref, j.model FROM runner_diagnostics d JOIN ai_jobs j ON j.id = d.ai_job_id WHERE d.id = ?`).bind(id)
    .first<{ id: string; correlation_id: string; ai_job_id: string; created_at: string; result_json: string | null; status: string; error: string | null; output_ref: string | null; model: string | null }>();
  if (!d) return null;
  const rows = (await db.prepare(`SELECT code, ok, at, recorded_at, source, component, worker, error, evidence FROM runner_diagnostic_checkpoints WHERE diagnostic_id = ? ORDER BY id`).bind(id).all<CheckpointRow>()).results;
  let prev: number | null = null;
  const steps: TraceStep[] = CHECKPOINTS.map((code) => {
    const row = rows.filter((r) => r.code === code).at(-1) ?? null;
    const t = row ? Date.parse(row.at) : null;
    const elapsedMs = t !== null && prev !== null ? t - prev : null;
    if (t !== null) prev = t;
    return { code, label: CHECKPOINT_LABELS[code], row, elapsedMs, status: !row ? "missing" : row.ok ? "pass" : "fail" };
  });
  let result: unknown = null;
  try { result = d.result_json ? JSON.parse(d.result_json) : null; } catch { result = null; }
  return { id: d.id, correlationId: d.correlation_id, aiJobId: d.ai_job_id, createdAt: d.created_at, jobStatus: d.status, jobError: d.error, output: d.output_ref, model: d.model, result, steps,
    firstFailure: steps.find((s) => s.status !== "pass") ?? null };
}

export async function listDiagnostics(db: Db, limit = 20) {
  // Same rule as the detail page: a step counts when its LATEST row passed.
  return (await db.prepare(`SELECT d.id, d.correlation_id, d.created_at, j.status, (SELECT COUNT(*) FROM runner_diagnostic_checkpoints c WHERE c.diagnostic_id = d.id AND c.ok = 1
                               AND c.id = (SELECT MAX(c2.id) FROM runner_diagnostic_checkpoints c2 WHERE c2.diagnostic_id = d.id AND c2.code = c.code)) AS passed
                             FROM runner_diagnostics d JOIN ai_jobs j ON j.id = d.ai_job_id ORDER BY d.created_at DESC LIMIT ?`).bind(limit)
    .all<{ id: string; correlation_id: string; created_at: string; status: string; passed: number }>()).results;
}

/** Everything the platform can see about runners without the machine: registrations, freshness, rejected signatures. */
export async function runnerConnectivity(db: Db, env: { BUILD_RUNNER_SECRET?: string }, now = new Date()) {
  const runners = (await db.prepare(`SELECT runner_id, version, capabilities, last_seen_at FROM build_runners ORDER BY last_seen_at DESC LIMIT 10`).all<{ runner_id: string; version: string | null; capabilities: string | null; last_seen_at: string }>()).results
    .map((r) => ({ ...r, ageSeconds: Math.round((now.getTime() - Date.parse(r.last_seen_at)) / 1000), fresh: now.getTime() - Date.parse(r.last_seen_at) < FRESH_MS }));
  const rejected = (await db.prepare(`SELECT detail, ip, created_at FROM security_events WHERE kind = 'runner_auth_failed' ORDER BY id DESC LIMIT 5`).all<{ detail: string | null; ip: string | null; created_at: string }>()).results;
  return { secretConfigured: !!env.BUILD_RUNNER_SECRET, runners, rejected };
}
