// Self-hosted AI drafts: ai_jobs queued with provider "local-runner" are leased to the build runner, which calls the
// local model (no per-token fee) and returns a DRAFT for human approval. Same signed runner channel as AI Builds.
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { HttpError } from "../app/http.ts";
import { randomToken } from "../lib/auth-crypto.ts";
import { sha256Hex, timingSafeEqualHex } from "../lib/crypto.ts";
import { audit } from "./security.ts";
import { AI_SYSTEM_PROMPT, LOCAL_RUNNER } from "./ai.ts";
import { DIAGNOSTIC_WORKFLOW, DIAGNOSTIC_SYSTEM, onDiagnosticClaim, onDiagnosticComplete, onDiagnosticLeaseExpired } from "./runner-diagnostics.ts";

const LEASE_S = 300;
const MAX_TRIES = 3;

export async function claimAiJob(db: Db, runnerId: string, now = new Date()) {
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(runnerId)) throw new HttpError(422, "runnerId must be 1-64 characters of [A-Za-z0-9._:-]");
  const at = now.toISOString();
  for (const c of (await db.prepare(`SELECT id FROM ai_jobs WHERE status = 'queued' AND provider = ? ORDER BY created_at LIMIT 5`).bind(LOCAL_RUNNER).all<{ id: string }>()).results) {
    const r = await db.prepare(`UPDATE ai_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'`).bind(at, c.id).run();
    if (!r.meta?.changes) continue;
    const token = randomToken(32);
    const expires = new Date(now.getTime() + LEASE_S * 1000).toISOString();
    await db.prepare(`INSERT INTO ai_job_leases (job_id, runner_id, token_hash, expires_at, attempts) VALUES (?,?,?,?,1)
                      ON CONFLICT(job_id) DO UPDATE SET runner_id = excluded.runner_id, token_hash = excluded.token_hash, expires_at = excluded.expires_at, attempts = ai_job_leases.attempts + 1`)
      .bind(c.id, runnerId, await sha256Hex(token), expires).run();
    const job = (await db.prepare(`SELECT j.id, j.workflow, i.prompt FROM ai_jobs j LEFT JOIN ai_job_inputs i ON i.job_id = j.id WHERE j.id = ?`).bind(c.id).first<{ id: string; workflow: string; prompt: string | null }>())!;
    if (!job.prompt) {
      await db.prepare(`UPDATE ai_jobs SET status = 'failed', error = 'input not retained', updated_at = ? WHERE id = ?`).bind(at, c.id).run();
      continue;
    }
    if (job.workflow === DIAGNOSTIC_WORKFLOW) {
      // Node 1 diagnostic (migration 0047): D03–D06 are written here, at the moment of the claim.
      const attempt = (await db.prepare(`SELECT attempts FROM ai_job_leases WHERE job_id = ?`).bind(c.id).first<{ attempts: number }>())?.attempts ?? 1;
      const diag = await onDiagnosticClaim(db, c.id, runnerId, expires, attempt, now);
      if (diag) return { job: { id: job.id, workflow: job.workflow, system: DIAGNOSTIC_SYSTEM, prompt: job.prompt, leaseToken: token, leaseExpiresAt: expires, maxOutputTokens: 800, diagnostic: { correlationId: diag.correlationId } } };
    }
    return { job: { id: job.id, workflow: job.workflow, system: AI_SYSTEM_PROMPT, prompt: job.prompt, leaseToken: token, leaseExpiresAt: expires, maxOutputTokens: 1500 } };
  }
  return { job: null };
}

export async function completeAiJob(db: Db, b: Record<string, unknown>) {
  const id = typeof b.jobId === "string" ? b.jobId : "";
  const token = typeof b.leaseToken === "string" && /^[0-9a-f]{64}$/.test(b.leaseToken) ? b.leaseToken : null;
  const lease = token ? await db.prepare(`SELECT l.token_hash, l.attempts, l.runner_id, j.status FROM ai_job_leases l JOIN ai_jobs j ON j.id = l.job_id WHERE l.job_id = ?`).bind(id).first<{ token_hash: string; attempts: number; runner_id: string; status: string }>() : null;
  if (!lease || lease.status !== "running" || !lease.token_hash || !timingSafeEqualHex(lease.token_hash, await sha256Hex(token!))) throw new HttpError(409, "lease_lost");
  const at = nowIso();
  // Node 1 diagnostic: D12/D13, no retry, never in the draft-approval queue.
  await db.prepare(`DELETE FROM ai_job_leases WHERE job_id = ? AND EXISTS (SELECT 1 FROM runner_diagnostics WHERE ai_job_id = ?)`).bind(id, id).run();
  const diag = await onDiagnosticComplete(db, id, b, lease.runner_id);
  if (diag) return diag;
  const model = typeof b.model === "string" && /^[\w.:/-]{1,100}$/.test(b.model) ? `self-hosted:${b.model}` : "self-hosted";
  const text = typeof b.text === "string" ? b.text.trim().slice(0, 20_000) : "";
  await db.prepare(`DELETE FROM ai_job_leases WHERE job_id = ?`).bind(id).run();
  if (text && !b.error) {
    // Local inference has no per-token fee: the per-token cost is a known $0 (hardware and power are tracked as hosting costs).
    await db.prepare(`UPDATE ai_jobs SET status = 'awaiting_approval', output_ref = ?, model = ?, cost_microusd = 0, error = NULL, updated_at = ? WHERE id = ?`).bind(text, model, at, id).run();
    await audit(db, { actorKind: "ai", action: "ai.draft_created", subjectType: "ai_job", subjectId: id, details: { backend: LOCAL_RUNNER, model, inputTokens: Number(b.inputTokens) || 0, outputTokens: Number(b.outputTokens) || 0 } });
    return { status: "awaiting_approval" as const };
  }
  const err = String(b.error ?? "empty response from the local model").slice(0, 500);
  const retry = lease.attempts < MAX_TRIES;
  await db.prepare(`UPDATE ai_jobs SET status = ?, error = ?, retries = retries + 1, model = ?, updated_at = ? WHERE id = ?`).bind(retry ? "queued" : "failed", err, model, at, id).run();
  if (retry) await db.prepare(`INSERT INTO ai_job_leases (job_id, runner_id, token_hash, expires_at, attempts) VALUES (?, 'released', '', ?, ?) ON CONFLICT(job_id) DO NOTHING`).bind(id, at, lease.attempts).run();
  return { status: retry ? "queued" as const : "failed" as const };
}

/** Requeues drafts whose runner stopped responding; fails them after MAX_TRIES. */
export async function sweepAiLeases(db: Db, now = new Date()): Promise<number> {
  const at = now.toISOString();
  const rows = (await db.prepare(`SELECT l.job_id, l.attempts FROM ai_job_leases l JOIN ai_jobs j ON j.id = l.job_id WHERE j.status = 'running' AND l.expires_at < ?`).bind(at).all<{ job_id: string; attempts: number }>()).results;
  for (const r of rows) {
    const runner = await db.prepare(`SELECT runner_id FROM ai_job_leases WHERE job_id = ?`).bind(r.job_id).first<{ runner_id: string }>();
    if (await onDiagnosticLeaseExpired(db, r.job_id, runner?.runner_id ?? null)) { await db.prepare(`DELETE FROM ai_job_leases WHERE job_id = ?`).bind(r.job_id).run(); continue; }
    const retry = r.attempts < MAX_TRIES;
    await db.prepare(`UPDATE ai_jobs SET status = ?, error = 'runner lease expired', updated_at = ? WHERE id = ? AND status = 'running'`).bind(retry ? "queued" : "failed", at, r.job_id).run();
    await db.prepare(`UPDATE ai_job_leases SET token_hash = '', expires_at = ? WHERE job_id = ?`).bind(at, r.job_id).run();
  }
  return rows.length;
}
