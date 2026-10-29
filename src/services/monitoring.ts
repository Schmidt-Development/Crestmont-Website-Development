// Operational monitoring (INFRA-006, §64). Everything shown is read from real rows; when no
// external alerting exists the page says so rather than implying someone is paged.
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import type { StorageAdapter } from "../adapters/storage.ts";
import { requestAiDraft, type AiDraftRequest, type AiProvider, type AiBackend } from "./ai.ts";
import { audit as auditLog } from "./security.ts";
import type { EmailAdapter } from "../adapters/email.ts";
import { sendMail } from "./mailer.ts";

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

// ───────────── Owner alerting (CREST-GAP-015, -089, -024 alert part) ─────────────
// Scheduled job "ops_alerts" (every 15 minutes, src/app/scheduled.ts). Each run collects alert items from real rows,
// claims each item's dedupe key in ops_alerts (migration 0045) and emails the Owners ONE critical_incident message per
// category listing the new items. An item (or a window, for aggregate conditions) is therefore emailed once, however
// often the job runs. Nothing here changes the rows it reads.

/** Thresholds over the last hour; windows are UTC hour buckets, so a sustained burst alerts at most once an hour. */
export const ALERT_THRESHOLDS = {
  /** Wrong TOTP / recovery codes for one account (CREST-GAP-024: ~768 guesses a day were possible unnoticed). */
  mfa_failed: 8,
  /** Sign-in challenges (progressive login throttling) for one account or address. */
  login_challenge_started: 3,
  /** Account lockouts for one account. */
  login_locked: 1,
  /** Email queue: Resend deliveries still queued after this many minutes. */
  email_queue_stuck_minutes: 60,
} as const;

export type AlertCategory = "stripe_dead_letter" | "reconciliation_finding" | "email_queue_stuck" | "feed_failing" | "security_burst";
export interface AlertItem { key: string; category: AlertCategory; subject: string | null; summary: string }
export interface AlertCtx { db: Db; email: EmailAdapter; baseUrl: string; now: () => Date; settings?: Record<string, string> }

const CATEGORY_TITLE: Record<AlertCategory, string> = {
  stripe_dead_letter: "Stripe events moved to the dead-letter queue",
  reconciliation_finding: "New Stripe reconciliation findings",
  email_queue_stuck: "Outgoing email is stuck in the queue",
  feed_failing: "Readiness evidence feeds are failing",
  security_burst: "Repeated security events",
};
const CATEGORY_PAGE: Record<AlertCategory, string> = {
  stripe_dead_letter: "/staff/monitoring", reconciliation_finding: "/staff/finance/reconciliation", email_queue_stuck: "/staff/monitoring",
  feed_failing: "/staff/readiness", security_burst: "/staff/security",
};

async function rowsOf<T>(db: Db, sql: string, ...b: unknown[]): Promise<T[]> {
  try { return (await db.prepare(sql).bind(...b).all<T>()).results; } catch { return []; } // table absent in a legacy database
}

async function sha256Short(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every alert condition that currently holds, with its dedupe key. Pure read. */
export async function collectAlertItems(db: Db, now = new Date()): Promise<AlertItem[]> {
  const items: AlertItem[] = [];
  const hourAgo = new Date(now.getTime() - 3600e3).toISOString();
  const window = now.toISOString().slice(0, 13); // UTC hour bucket
  for (const e of await rowsOf<{ id: string; type: string; attempts: number }>(db, `SELECT id, type, attempts FROM stripe_events WHERE status = 'dead_letter' ORDER BY received_at LIMIT 200`))
    items.push({ key: `stripe_dead_letter:${e.id}`, category: "stripe_dead_letter", subject: e.id, summary: `Stripe event ${e.id} (${e.type}) is dead-lettered after ${e.attempts} attempts.` });
  for (const f of await rowsOf<{ id: string; kind: string; stripe_object_id: string | null }>(db, `SELECT id, kind, stripe_object_id FROM reconciliation_findings WHERE status = 'open' ORDER BY first_seen_at LIMIT 200`))
    items.push({ key: `reconciliation_finding:${f.id}`, category: "reconciliation_finding", subject: f.id, summary: `Reconciliation finding ${f.id}: ${f.kind.replace(/_/g, " ")}${f.stripe_object_id ? ` (${f.stripe_object_id})` : ""}.` });
  const stuckSince = new Date(now.getTime() - ALERT_THRESHOLDS.email_queue_stuck_minutes * 60e3).toISOString();
  const stuck = (await rowsOf<{ n: number; oldest: string | null }>(db, `SELECT COUNT(*) n, MIN(d.updated_at) oldest FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.status = 'queued' AND m.provider = 'resend' AND d.updated_at < ?`, stuckSince))[0];
  // One alert per stuck episode: the key carries the oldest stuck message's timestamp, so a queue that drains and jams again alerts again.
  if (stuck && stuck.n > 0) items.push({ key: `email_queue_stuck:${stuck.oldest}`, category: "email_queue_stuck", subject: null, summary: `${stuck.n} outgoing email(s) have been queued at Resend for over ${ALERT_THRESHOLDS.email_queue_stuck_minutes} minutes (oldest since ${stuck.oldest}).` });
  // Failing feeds: the latest attempt errored after the last success. One alert per failure episode (key = last success).
  // Optional services that are simply not enabled (file-storage:*) are excluded, as in the readiness health view.
  for (const f of await rowsOf<{ source: string; last_success_at: string | null; last_attempt_at: string | null; last_error: string | null }>(db,
    `SELECT source, last_success_at, last_attempt_at, last_error FROM ingestion_status WHERE last_error IS NOT NULL AND source NOT LIKE 'file-storage:%' ORDER BY source`)) {
    if (f.last_success_at && (f.last_attempt_at ?? "") <= f.last_success_at) continue;
    items.push({ key: `feed_failing:${f.source}:${f.last_success_at ?? "never"}`, category: "feed_failing", subject: f.source, summary: `Feed ${f.source} is failing: ${redact(f.last_error ?? "").slice(0, 160)}` });
  }
  // Security bursts (CREST-GAP-089). Grouped per account, else per address; the stored summary and key carry user ids
  // or a short hash, never an email address or IP.
  const burst = async (kind: "mfa_failed" | "login_challenge_started" | "login_locked", label: string) => {
    for (const r of await rowsOf<{ who: string; is_user: number; n: number }>(db,
      `SELECT COALESCE(user_id, lower(email), ip, 'unknown') who, user_id IS NOT NULL is_user, COUNT(*) n FROM security_events WHERE kind = ? AND created_at >= ? GROUP BY who HAVING COUNT(*) >= ?`, kind, hourAgo, ALERT_THRESHOLDS[kind])) {
      const subject = r.is_user ? r.who : `ref-${await sha256Short(r.who)}`;
      items.push({ key: `${kind}:${subject}:${window}`, category: "security_burst", subject, summary: `${r.n} ${label} in the last hour for ${r.is_user ? `account ${r.who}` : `one address (${subject})`}.` });
    }
  };
  await burst("mfa_failed", "wrong two-factor codes");
  await burst("login_challenge_started", "sign-in challenges");
  await burst("login_locked", "account lockouts");
  // Every recovery-code use is alerted (a used code means the authenticator was unavailable, or was bypassed).
  for (const e of await rowsOf<{ id: number; user_id: string | null; created_at: string }>(db, `SELECT id, user_id, created_at FROM security_events WHERE kind = 'mfa_recovery_code_used' AND created_at >= ? ORDER BY id`, hourAgo))
    items.push({ key: `mfa_recovery_code_used:${e.id}`, category: "security_burst", subject: e.user_id, summary: `A two-factor recovery code was used for account ${e.user_id ?? "unknown"} at ${e.created_at}.` });
  return items;
}

export interface OpsAlertResult { checked: number; raised: number; emailed: number; recipients: number; categories: string[] }

/** Claims new alert items and emails the Owners one critical_incident message per category. Idempotent per dedupe key. */
export async function runOpsAlerts(ctx: AlertCtx): Promise<OpsAlertResult> {
  const now = ctx.now();
  const items = await collectAlertItems(ctx.db, now);
  const fresh: AlertItem[] = [];
  for (const it of items) {
    const r = await ctx.db.prepare(`INSERT INTO ops_alerts (dedupe_key, category, subject, summary, created_at) VALUES (?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`)
      .bind(it.key, it.category, it.subject, it.summary.slice(0, 500), now.toISOString()).run();
    if (r.meta.changes > 0) fresh.push(it);
  }
  const owners = (await ctx.db.prepare(`SELECT DISTINCT u.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id = 'owner' AND u.disabled_at IS NULL ORDER BY u.id`).all<{ id: string; email: string }>()).results;
  const byCat = new Map<AlertCategory, AlertItem[]>();
  for (const it of fresh) byCat.set(it.category, [...(byCat.get(it.category) ?? []), it]);
  let emailed = 0;
  for (const [cat, list] of byCat) {
    const summary = `${CATEGORY_TITLE[cat]}: ${list.slice(0, 10).map((x) => x.summary).join(" ")}${list.length > 10 ? ` (+${list.length - 10} more)` : ""}`.slice(0, 1500);
    for (const o of owners) {
      await sendMail(ctx, { template: "critical_incident", to: o.email, idempotencyKey: `ops-alert:${list[0].key}:${o.id}`.slice(0, 300),
        data: { summary, occurredAt: `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`, url: `${ctx.baseUrl}${CATEGORY_PAGE[cat]}` } });
      emailed++;
    }
    await ctx.db.batch(list.map((x) => ctx.db.prepare(`UPDATE ops_alerts SET recipients = ? WHERE dedupe_key = ?`).bind(owners.length, x.key)));
  }
  return { checked: items.length, raised: fresh.length, emailed, recipients: owners.length, categories: [...byCat.keys()] };
}
