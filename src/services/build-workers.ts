// AI Website Builder V3 (Founder, 2026-10-28; Claude-only): builder workers, one customer website per worker.
//
// A worker is a registered, Owner-authorized builder identity served by the local Crestmont Orchestrator (the build
// runner on Node 1): "Claude 1/2/3" = a Claude Code installation signed in with one Claude plan account in its own
// config directory; optionally a self-hosted model. There are no pay-per-use worker kinds. The platform stores no
// account password, token or session: a worker proves itself with a Crestmont enrollment key (hash stored, shown
// once) on top of the HMAC-signed runner channel.
//
// Rules (Founder V2 §4, redirect §5):
//  - one active customer website per worker, one worker per website (unique partial indexes on build_assignments);
//  - selection: enabled, not paused, connected (seen within the stale window), not rate-limited, not at its usage limit;
//    then the lowest VERIFIED weekly usage first; workers without verified telemetry
//    follow, least recently assigned first (documented fallback; usage is never estimated or invented);
//  - further websites wait (WAITING_FOR_WORKER_CAPACITY) and are assigned when a worker frees up;
//  - a project keeps its worker through the whole development and review lifecycle (also while the account waits for
//    plan capacity); it is released at engineering completion (owner review), approval or cancellation, or by an
//    explicit Owner reassignment; automatically only when the worker is removed or disconnected for long, with the
//    work checkpointed. A project is never moved to another account to get around a plan's usage limit.
//
// When no worker is registered the builder keeps its earlier single-runner behaviour (backward compatible).

import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { AppContext } from "../app/context.ts";
import { HttpError } from "../app/http.ts";
import { sha256Hex, timingSafeEqualHex } from "../lib/crypto.ts";
import { randomToken } from "../lib/auth-crypto.ts";
import { audit } from "./security.ts";
import { setStage } from "./build-pipeline.ts";

type OwnerCtx = Pick<AppContext, "db"> & { userId: string };

export type ProviderKind = "claude-code" | "local-model";
export type Billing = "subscription" | "zero-cost";
export const PROVIDER_KINDS: readonly ProviderKind[] = ["claude-code", "local-model"];
/** claude-code runs on an existing Claude plan sign-in; local-model on owned hardware. No metered kinds exist. */
export const DEFAULT_BILLING: Record<ProviderKind, Billing> = { "claude-code": "subscription", "local-model": "zero-cost" };
/** Usage at or above this verified percentage of the weekly allowance counts as "at its permitted usage limit". */
export const USAGE_LIMIT_PERCENT = 95;
/** Verified usage older than this is not used for ranking (it may be stale). */
export const USAGE_FRESH_HOURS = 24;

export interface BuildWorker {
  id: string; label: string; provider_kind: ProviderKind; billing: Billing; enabled: number; dispatch_paused: number; pause_reason: string | null;
  max_sessions: number; account_label: string | null; enrollment_key_hash: string; runner_id: string | null; usage_percent: number | null; usage_source: string | null;
  usage_reported_at: string | null; rate_limited_until: string | null; last_seen_at: string | null; last_error: string | null; last_error_at: string | null;
  last_assigned_at: string | null; created_by: string | null; created_at: string; updated_at: string;
}
export interface Assignment { id: string; project_id: string; organization_id: string; worker_id: string; assigned_at: string; released_at: string | null; release_reason: string | null; selection_json: string | null }

export async function listWorkers(db: Db): Promise<BuildWorker[]> {
  return (await db.prepare(`SELECT * FROM build_workers ORDER BY created_at`).all<BuildWorker>()).results;
}
export async function getWorker(db: Db, id: string): Promise<BuildWorker | null> {
  return db.prepare(`SELECT * FROM build_workers WHERE id = ?`).bind(id).first<BuildWorker>();
}
/** Worker mode is on once any worker is registered (enabled or not). */
export async function workerModeOn(db: Db): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 FROM build_workers LIMIT 1`).first());
}
export async function activeAssignment(db: Db, projectId: string): Promise<Assignment | null> {
  return db.prepare(`SELECT * FROM build_assignments WHERE project_id = ? AND released_at IS NULL`).bind(projectId).first<Assignment>();
}
export async function workerAssignment(db: Db, workerId: string): Promise<Assignment | null> {
  return db.prepare(`SELECT * FROM build_assignments WHERE worker_id = ? AND released_at IS NULL`).bind(workerId).first<Assignment>();
}

async function staleMinutes(db: Db): Promise<number> {
  return (await db.prepare(`SELECT worker_stale_minutes AS m FROM build_settings WHERE id = 1`).first<{ m: number }>())?.m ?? 15;
}

// ── Owner actions ──

export async function registerWorker(c: OwnerCtx, v: { label: string; providerKind: string; maxSessions?: number; accountLabel?: string }): Promise<{ id: string; enrollmentKey: string }> {
  const label = v.label.trim().slice(0, 80);
  if (label.length < 2) throw new HttpError(422, "Give the worker a name (for example \"Claude account 1\").");
  if (!(PROVIDER_KINDS as readonly string[]).includes(v.providerKind)) throw new HttpError(422, "Choose the worker type.");
  const kind = v.providerKind as ProviderKind;
  const maxSessions = v.maxSessions ?? 1;
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 16) throw new HttpError(422, "Sessions per website must be 1–16.");
  const account = (v.accountLabel ?? "").trim().slice(0, 120) || null;
  if (account && !/^[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+$/.test(account)) throw new HttpError(422, "Account: the Claude account's email address (an identifier only; never a password).");
  const key = randomToken(32);
  const id = newId("wkr");
  await c.db.prepare(`INSERT INTO build_workers (id, label, provider_kind, billing, max_sessions, account_label, enrollment_key_hash, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, label, kind, DEFAULT_BILLING[kind], maxSessions, account, await sha256Hex(key), c.userId, nowIso(), nowIso()).run();
  await audit(c.db, { actorUserId: c.userId, action: "builds.worker_registered", subjectType: "build_worker", subjectId: id, details: { label, providerKind: kind, billing: DEFAULT_BILLING[kind], account } });
  return { id, enrollmentKey: key };
}

export async function updateWorker(c: OwnerCtx, id: string, action: string, v: { reason?: string; maxSessions?: number } = {}) {
  const w = await getWorker(c.db, id);
  if (!w) throw new HttpError(404, "Worker not found");
  const at = nowIso();
  if (action === "pause") {
    const why = (v.reason ?? "").trim().slice(0, 300);
    if (why.length < 3) throw new HttpError(422, "Give a reason for pausing dispatch.");
    await c.db.prepare(`UPDATE build_workers SET dispatch_paused = 1, pause_reason = ?, updated_at = ? WHERE id = ?`).bind(why, at, id).run();
  } else if (action === "resume") {
    await c.db.prepare(`UPDATE build_workers SET dispatch_paused = 0, pause_reason = NULL, updated_at = ? WHERE id = ?`).bind(at, id).run();
  } else if (action === "sessions") {
    const n = v.maxSessions;
    if (!Number.isInteger(n) || n! < 1 || n! > 16) throw new HttpError(422, "Sessions per website must be 1–16.");
    await c.db.prepare(`UPDATE build_workers SET max_sessions = ?, updated_at = ? WHERE id = ?`).bind(n, at, id).run();
  } else if (action === "remove") {
    if (await workerAssignment(c.db, id)) throw new HttpError(409, "This worker owns a website. Reassign it first (Reassign project), then remove the worker.");
    await c.db.prepare(`UPDATE build_workers SET enabled = 0, dispatch_paused = 1, pause_reason = 'removed', enrollment_key_hash = ?, updated_at = ? WHERE id = ?`).bind(await sha256Hex(randomToken(32)), at, id).run();
  } else throw new HttpError(422, "Unknown action");
  await audit(c.db, { actorUserId: c.userId, action: "builds.worker_updated", subjectType: "build_worker", subjectId: id, details: { action, ...v } });
}

export async function rotateWorkerKey(c: OwnerCtx, id: string): Promise<string> {
  const w = await getWorker(c.db, id);
  if (!w || !w.enabled) throw new HttpError(404, "Worker not found");
  const key = randomToken(32);
  await c.db.prepare(`UPDATE build_workers SET enrollment_key_hash = ?, updated_at = ? WHERE id = ?`).bind(await sha256Hex(key), nowIso(), id).run();
  await audit(c.db, { actorUserId: c.userId, action: "builds.worker_updated", subjectType: "build_worker", subjectId: id, details: { action: "rotate-key" } });
  return key;
}

/** Owner: move a project to another worker (or back to the queue). Work is in the project repository/checkpoints. */
export async function reassignProject(c: OwnerCtx, projectId: string, reason: string) {
  const a = await activeAssignment(c.db, projectId);
  if (!a) throw new HttpError(409, "This project has no assigned worker.");
  const live = await c.db.prepare(`SELECT id FROM build_jobs WHERE project_id = ? AND state IN ('preparing','building','verifying')`).bind(projectId).first();
  if (live) throw new HttpError(409, "A session is running for this project. Pause or cancel it first, so its work is checkpointed.");
  const why = reason.trim().slice(0, 300);
  if (why.length < 3) throw new HttpError(422, "Give a reason.");
  await releaseAssignment(c.db, projectId, `owner: ${why}`);
  await audit(c.db, { actorUserId: c.userId, action: "builds.project_reassigned", subjectType: "project", subjectId: projectId, organizationId: a.organization_id, details: { from: a.worker_id, reason: why } });
  await dispatch(c.db);
}

// ── Runner side ──

/** A claim in worker mode must name a registered, enabled worker and present its enrollment key. */
export async function authenticateWorker(db: Db, workerId: unknown, workerKey: unknown): Promise<BuildWorker> {
  if (typeof workerId !== "string" || typeof workerKey !== "string" || !/^[0-9a-f]{64}$/.test(workerKey)) throw new HttpError(403, "worker_not_authorized");
  const w = await getWorker(db, workerId);
  if (!w || !w.enabled || !timingSafeEqualHex(w.enrollment_key_hash, await sha256Hex(workerKey))) throw new HttpError(403, "worker_not_authorized");
  return w;
}

/**
 * Heartbeat from a worker: liveness, and usage ONLY when the orchestrator read it through an authorized interface
 * (source names it). Anything else is recorded as "not available".
 */
export async function recordWorkerStatus(db: Db, w: BuildWorker, runnerId: string, b: Record<string, unknown>, now = new Date()) {
  const at = now.toISOString();
  const usage = b.usage && typeof b.usage === "object" ? b.usage as Record<string, unknown> : null;
  const pct = usage && typeof usage.percent === "number" && usage.percent >= 0 && usage.percent <= 100 ? Math.round(usage.percent * 10) / 10 : null;
  const source = pct !== null && typeof usage!.source === "string" && /^[a-z0-9:._-]{2,60}$/.test(usage!.source) ? usage!.source : null;
  const rateLimitedUntil = typeof b.rateLimitedUntil === "string" && !Number.isNaN(Date.parse(b.rateLimitedUntil)) ? new Date(b.rateLimitedUntil).toISOString() : null;
  const err = typeof b.error === "string" && b.error ? b.error.slice(0, 500) : null;
  await db.prepare(`UPDATE build_workers SET runner_id = ?, last_seen_at = ?, usage_percent = ?, usage_source = ?, usage_reported_at = ?, rate_limited_until = ?,
      last_error = COALESCE(?, last_error), last_error_at = CASE WHEN ? IS NULL THEN last_error_at ELSE ? END, updated_at = ? WHERE id = ?`)
    .bind(runnerId, at, source ? pct : null, source, source ? at : null, rateLimitedUntil, err, err, at, at, w.id).run();
}

// ── Scheduling ──

export type WorkerAvailability = { workerId: string; label: string; eligible: boolean; reason: string | null; usagePercent: number | null; usageVerified: boolean; lastAssignedAt: string | null };

export async function workerAvailability(db: Db, now = new Date()): Promise<WorkerAvailability[]> {
  const stale = await staleMinutes(db);
  const out: WorkerAvailability[] = [];
  for (const w of await listWorkers(db)) {
    const fresh = !!w.usage_reported_at && now.getTime() - Date.parse(w.usage_reported_at) <= USAGE_FRESH_HOURS * 3600_000;
    const verified = !!w.usage_source && w.usage_percent !== null && fresh;
    let reason: string | null = null;
    if (!w.enabled) reason = "removed";
    else if (w.dispatch_paused) reason = `dispatch paused${w.pause_reason ? `: ${w.pause_reason}` : ""}`;
    else if (!w.last_seen_at || now.getTime() - Date.parse(w.last_seen_at) > stale * 60_000) reason = "disconnected (no heartbeat)";
    else if (w.rate_limited_until && Date.parse(w.rate_limited_until) > now.getTime()) reason = `rate-limited until ${w.rate_limited_until}`;
    else if (verified && w.usage_percent! >= USAGE_LIMIT_PERCENT) reason = `at its usage limit (${w.usage_percent}% verified)`;
    else if (await workerAssignment(db, w.id)) reason = "owns another website";
    out.push({ workerId: w.id, label: w.label, eligible: !reason, reason, usagePercent: verified ? w.usage_percent : null, usageVerified: verified, lastAssignedAt: w.last_assigned_at });
  }
  return out;
}

/** Rank eligible workers: lowest verified usage first; then those without verified telemetry, least recently assigned. */
export function rankWorkers(av: WorkerAvailability[]): WorkerAvailability[] {
  const ok = av.filter((a) => a.eligible);
  const verified = ok.filter((a) => a.usageVerified).sort((a, b) => a.usagePercent! - b.usagePercent! || cmp(a.lastAssignedAt, b.lastAssignedAt) || a.workerId.localeCompare(b.workerId));
  const unknown = ok.filter((a) => !a.usageVerified).sort((a, b) => cmp(a.lastAssignedAt, b.lastAssignedAt) || a.workerId.localeCompare(b.workerId));
  return [...verified, ...unknown];
}
const cmp = (a: string | null, b: string | null) => (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;

async function assign(db: Db, projectId: string, organizationId: string, w: WorkerAvailability, ranked: WorkerAvailability[], at: string): Promise<boolean> {
  const selection = { policy: w.usageVerified ? "lowest verified weekly usage" : "no verified telemetry: least recently assigned", chosen: w.workerId, usagePercent: w.usagePercent, candidates: ranked.map((r) => ({ id: r.workerId, usage: r.usagePercent, verified: r.usageVerified })) };
  try {
    await db.prepare(`INSERT INTO build_assignments (id, project_id, organization_id, worker_id, assigned_at, selection_json) VALUES (?,?,?,?,?,?)`)
      .bind(newId("asg"), projectId, organizationId, w.workerId, at, JSON.stringify(selection)).run();
  } catch { return false; } // the worker or the project was assigned concurrently
  await db.prepare(`UPDATE build_workers SET last_assigned_at = ?, updated_at = ? WHERE id = ?`).bind(at, at, w.workerId).run();
  await audit(db, { actorKind: "system", action: "builds.worker_assigned", subjectType: "project", subjectId: projectId, organizationId, details: selection });
  await setStage(db, projectId, "WORKER_ASSIGNED", `Assigned to ${w.label} (${selection.policy})`, "system");
  return true;
}

/**
 * Dispatcher (runs on every claim and in the 15-minute sweep): give each queued website without a worker the best
 * eligible worker; the rest wait for capacity. Idempotent: duplicate calls cannot double-assign (unique indexes).
 */
export async function dispatch(db: Db, now = new Date()): Promise<{ assigned: number; waiting: number }> {
  if (!(await workerModeOn(db))) return { assigned: 0, waiting: 0 };
  const at = now.toISOString();
  const waitingProjects = (await db.prepare(`SELECT j.project_id, j.organization_id, MIN(j.created_at) AS first FROM build_jobs j
      WHERE j.state = 'queued' AND NOT EXISTS (SELECT 1 FROM build_assignments a WHERE a.project_id = j.project_id AND a.released_at IS NULL)
      GROUP BY j.project_id, j.organization_id ORDER BY first LIMIT 50`).all<{ project_id: string; organization_id: string }>()).results;
  let assigned = 0, waiting = 0;
  for (const p of waitingProjects) {
    let ranked = rankWorkers(await workerAvailability(db, now));
    // Continuity: a website goes back to the worker that built it before, when that worker is eligible.
    const prev = await db.prepare(`SELECT worker_id FROM build_assignments WHERE project_id = ? ORDER BY assigned_at DESC LIMIT 1`).bind(p.project_id).first<{ worker_id: string }>();
    if (prev) { const i = ranked.findIndex((r) => r.workerId === prev.worker_id); if (i > 0) ranked = [ranked[i], ...ranked.slice(0, i), ...ranked.slice(i + 1)]; }
    let ok = false;
    for (const w of ranked) { if (await assign(db, p.project_id, p.organization_id, w, ranked, at)) { ok = true; break; } }
    if (ok) assigned++;
    else { waiting++; await setStage(db, p.project_id, "WAITING_FOR_WORKER_CAPACITY", "Every eligible builder worker owns another website; queued in order of arrival", "system"); }
  }
  return { assigned, waiting };
}

/** Release a project's worker (website finished its turn, canceled, or the Owner reassigned it). */
export async function releaseAssignment(db: Db, projectId: string, reason: string) {
  await db.prepare(`UPDATE build_assignments SET released_at = ?, release_reason = ? WHERE project_id = ? AND released_at IS NULL`).bind(nowIso(), reason.slice(0, 300), projectId).run();
}

/** Sweep: a worker disconnected for longer than twice the stale window gives up a project that is waiting in the queue. */
export async function sweepWorkers(db: Db, now = new Date()): Promise<number> {
  if (!(await workerModeOn(db))) return 0;
  const stale = await staleMinutes(db);
  const cutoff = new Date(now.getTime() - 2 * stale * 60_000).toISOString();
  const rows = (await db.prepare(`SELECT a.project_id FROM build_assignments a JOIN build_workers w ON w.id = a.worker_id
      WHERE a.released_at IS NULL AND (w.enabled = 0 OR w.last_seen_at IS NULL OR w.last_seen_at < ?)
        AND NOT EXISTS (SELECT 1 FROM build_jobs j WHERE j.project_id = a.project_id AND j.state IN ('preparing','building','verifying'))`).bind(cutoff).all<{ project_id: string }>()).results;
  for (const r of rows) {
    await releaseAssignment(db, r.project_id, "worker disconnected; work is checkpointed and the project returns to the queue");
    await audit(db, { actorKind: "system", action: "builds.project_reassigned", subjectType: "project", subjectId: r.project_id, details: { reason: "worker disconnected" } });
  }
  await dispatch(db, now);
  return rows.length;
}
