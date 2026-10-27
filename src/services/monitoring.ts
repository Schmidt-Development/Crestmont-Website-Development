// Operational monitoring (INFRA-006, §64). Everything shown is read from real rows; when no
// external alerting exists the page says so rather than implying someone is paged.
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import type { StorageAdapter } from "../adapters/storage.ts";
import { requestAiDraft, type AiDraftRequest, type AiProvider, type AiBackend } from "./ai.ts";
import { audit as auditLog } from "./security.ts";

/**
 * Record an unhandled server error. Called by the 500 handler in src/app/app.ts. Never throws:
 * a failing error log must not turn a 500 into a crash. Messages and stacks are truncated, and
 * obvious secret-looking tokens are redacted before storage.
 */
export async function recordAppError(db: Db, e: { path: string; message: string; stack?: string | null; method?: string | null; status?: number; environment?: string | null }): Promise<void> {
  try {
    await db.prepare(`INSERT INTO app_errors (path, method, status, message, stack, environment, created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(e.path.slice(0, 300), e.method ?? null, e.status ?? 500, redact(e.message).slice(0, 1000), e.stack ? redact(e.stack).slice(0, 4000) : null, e.environment ?? null, nowIso()).run();
  } catch { /* the error log itself is unavailable; console logging in app.ts still applies */ }
}

export function redact(s: string): string {
  return s
    .replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, "$1_$2_[redacted]")
    .replace(/\bre_[A-Za-z0-9_]{10,}/g, "re_[redacted]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh_[redacted]")
    .replace(/\b[0-9a-f]{64}\b/g, "[redacted-token]")
    // Personal data that can end up in free-form error text (ASVS F-13).
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/(?<![\w.:])\+?\(?\d[\d ().-]{8,}\d(?![\w.:])/g, (m) => /^\d{4}-\d{2}-\d{2}/.test(m) || m.replace(/\D/g, "").length < 10 ? m : "[redacted-phone]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[redacted-number]");
}

export interface ServiceCheck { name: string; status: "healthy" | "failing" | "not_configured" | "stale" | "unavailable"; detail: string }

export async function serviceChecks(db: Db, storage: StorageAdapter | null, now = new Date()): Promise<ServiceCheck[]> {
  const out: ServiceCheck[] = [];
  try {
    const t0 = Date.now();
    await db.prepare(`SELECT 1`).first();
    out.push({ name: "Database", status: "healthy", detail: `SELECT 1 in ${Date.now() - t0} ms` });
  } catch (e) {
    out.push({ name: "Database", status: "failing", detail: (e as Error).message.slice(0, 200) });
  }
  if (!storage) out.push({ name: "Object storage", status: "not_configured", detail: "No storage binding; uploads unavailable." });
  else {
    try {
      const key = `_health/monitor-${now.getTime()}.txt`;
      await storage.put(key, new TextEncoder().encode("ok"), "text/plain");
      const got = await storage.get(key);
      await storage.delete(key);
      out.push({ name: "Object storage", status: got ? "healthy" : "failing", detail: `${storage.kind} write/read/delete ${got ? "succeeded" : "could not read back"}` });
    } catch (e) {
      out.push({ name: "Object storage", status: "failing", detail: (e as Error).message.slice(0, 200) });
    }
  }
  const feeds = (await db.prepare(`SELECT source, last_success_at, last_attempt_at, last_error FROM ingestion_status ORDER BY source`).all<{ source: string; last_success_at: string | null; last_attempt_at: string | null; last_error: string | null }>()).results;
  if (!feeds.length) out.push({ name: "Evidence feed", status: "unavailable", detail: "No CI evidence has ever been ingested (CI cannot run: BLK-013)." });
  for (const f of feeds) {
    const ageH = f.last_success_at ? (now.getTime() - Date.parse(f.last_success_at)) / 3600e3 : Infinity;
    const status = f.last_error && (!f.last_success_at || (f.last_attempt_at ?? "") > f.last_success_at) ? "failing" : ageH > 48 ? "stale" : "healthy";
    out.push({ name: `Evidence feed: ${f.source}`, status, detail: f.last_success_at ? `Last success ${f.last_success_at}${f.last_error ? ` · last error: ${f.last_error.slice(0, 120)}` : ""}` : `Never succeeded${f.last_error ? `: ${f.last_error.slice(0, 120)}` : ""}` });
  }
  return out;
}

export interface MonitoringSummary {
  errors24h: number; errors7d: number;
  emailFailed: number; emailQueuedStuck: number;
  stripeFailed: number; stripeDeadLetter: number;
  aiFailed: number; voiceErrors7d: number;
}

export async function monitoringSummary(db: Db, now = new Date()): Promise<MonitoringSummary> {
  const ago = (h: number) => new Date(now.getTime() - h * 3600e3).toISOString();
  const n = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())?.n ?? 0;
  return {
    errors24h: await n(`SELECT COUNT(*) n FROM app_errors WHERE status >= 500 AND created_at >= ?`, ago(24)),
    errors7d: await n(`SELECT COUNT(*) n FROM app_errors WHERE status >= 500 AND created_at >= ?`, ago(168)),
    emailFailed: await n(`SELECT COUNT(*) n FROM email_deliveries WHERE status IN ('failed','bounced')`),
    emailQueuedStuck: await n(`SELECT COUNT(*) n FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.status = 'queued' AND m.provider = 'resend' AND d.updated_at < ?`, ago(1)),
    stripeFailed: await n(`SELECT COUNT(*) n FROM stripe_events WHERE status = 'failed'`),
    stripeDeadLetter: await n(`SELECT COUNT(*) n FROM stripe_events WHERE status = 'dead_letter'`),
    aiFailed: await n(`SELECT COUNT(*) n FROM ai_jobs WHERE status = 'failed'`),
    voiceErrors7d: await n(`SELECT COUNT(*) n FROM calls WHERE (outcome = 'error' OR error IS NOT NULL) AND started_at >= ?`, ago(168)),
  };
}

/** Daily 5xx counts for the last `days` days (oldest first), zero-filled from real rows. */
export async function errorsByDay(db: Db, days = 7, now = new Date()): Promise<{ day: string; count: number }[]> {
  const since = new Date(now.getTime() - (days - 1) * 86400e3).toISOString().slice(0, 10);
  const rows = (await db.prepare(`SELECT substr(created_at,1,10) AS day, COUNT(*) AS n FROM app_errors WHERE status >= 500 AND substr(created_at,1,10) >= ? GROUP BY day`).bind(since).all<{ day: string; n: number }>()).results;
  const map = new Map(rows.map((r) => [r.day, r.n]));
  const out: { day: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 86400e3).toISOString().slice(0, 10);
    out.push({ day, count: map.get(day) ?? 0 });
  }
  return out;
}

// ───────────── AI job operations (AIOPS-001) ─────────────
// src/services/ai.ts owns the job runner; these helpers add prompt retention (so a failed job can
// be retried with the same input) and the retry linkage. Any area may call startAiJob instead of
// requestAiDraft to make its jobs retryable from /staff/ai.

export async function startAiJob(db: Db, provider: AiBackend, req: AiDraftRequest) {
  const res = await requestAiDraft(db, provider, req);
  await db.prepare(`INSERT INTO ai_job_inputs (job_id, prompt, created_at) VALUES (?,?,?) ON CONFLICT(job_id) DO NOTHING`).bind(res.jobId, req.prompt.slice(0, 20_000), nowIso()).run();
  return res;
}

export class AiOpsError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** Re-runs a failed job as a new job (retry_of → original). Fails honestly when no provider is configured. */
export async function retryAiJob(db: Db, provider: AiBackend, jobId: string, userId: string) {
  const job = await db.prepare(`SELECT id, workflow, input_ref, status FROM ai_jobs WHERE id = ?`).bind(jobId).first<{ id: string; workflow: string; input_ref: string; status: string }>();
  if (!job) throw new AiOpsError("AI job not found.", 404);
  if (job.status !== "failed") throw new AiOpsError("Only failed jobs can be retried.", 409);
  const input = await db.prepare(`SELECT prompt FROM ai_job_inputs WHERE job_id = ?`).bind(jobId).first<{ prompt: string }>();
  if (!input) throw new AiOpsError("The original input was not retained for this job. Start it again from the screen that created it.", 409);
  const res = await startAiJob(db, provider, { workflow: job.workflow as AiDraftRequest["workflow"], inputRef: job.input_ref, prompt: input.prompt, requestedBy: userId });
  await db.batch([
    db.prepare(`UPDATE ai_jobs SET retry_of = ? WHERE id = ?`).bind(jobId, res.jobId),
    db.prepare(`UPDATE ai_jobs SET retries = retries + 1, updated_at = ? WHERE id = ?`).bind(nowIso(), jobId),
  ]);
  await auditLog(db, { actorUserId: userId, action: "ai.job_retried", subjectType: "ai_job", subjectId: jobId, details: { newJob: res.jobId, status: res.status } });
  return res;
}
