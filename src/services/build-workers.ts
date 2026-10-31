// AI Website Builder V4 (Founder, 2026-10-28): GPU workers and GPU-capacity-aware scheduling.
//
// A GPU worker is an inference server on owned hardware (Node 1's RTX 5090 first; more GPUs or machines later) with
// the local orchestrator (the build runner) in front of it. Many websites share one worker: the runner runs several
// website agents at once (its slots), and its inference scheduler shares the GPU between them and switches between
// Model A (architect/reviewer) and Model B (builder). The platform stores no model or account credential; a worker
// proves itself with a Crestmont enrollment key (hash stored, shown once) on top of the HMAC-signed runner channel.
//
// Rules:
//  - a website (project) is served by one worker at a time (affinity: its workspace and checkpoints live there);
//  - a worker runs at most `max_active_projects` builds at once; a project waiting for a person, an external setup or
//    its preview review holds no capacity, so another eligible website runs meanwhile;
//  - dispatch: highest effective priority first (Founder priority, raised by waiting time so nothing starves), then
//    first queued; to the eligible worker with the most free capacity, then the least recently assigned; a website goes
//    back to the worker that built it before when that worker is eligible;
//  - eligible = enabled, not paused, connected (seen within the stale window), owned hardware (no rented or paid
//    capacity without a separate Founder approval and budget), not reporting a failed model server;
//  - telemetry (VRAM, utilization, loaded model, throughput) is shown only as reported, with its source; never estimated.
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

export type CostClass = "owned-hardware" | "rented-gpu" | "dedicated-server";
export const COST_CLASSES: readonly CostClass[] = ["owned-hardware", "rented-gpu", "dedicated-server"];
/** Only owned hardware may run builds without a separate Founder approval and budget (V4 §9–10). */
export const ZERO_FEE_COST_CLASSES: readonly CostClass[] = ["owned-hardware"];
export const MODEL_ROLES = ["architect_reviewer", "builder", "single"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
/** Waiting time that raises a queued website's effective priority by one step (anti-starvation). */
export const AGING_HOURS = 4;
export const MAX_ACTIVE_PROJECTS = 32;

export interface BuildWorker {
  id: string; label: string; provider_kind: "local-gpu"; cost_class: CostClass; enabled: number; dispatch_paused: number; pause_reason: string | null;
  max_active_projects: number; enrollment_key_hash: string; runner_id: string | null;
  hardware_json: string | null; vram_total_mb: number | null; vram_used_mb: number | null; gpu_util_percent: number | null; telemetry_source: string | null;
  loaded_models_json: string | null; model_state: string | null; active_requests: number | null; queued_requests: number | null; max_concurrent_requests: number | null;
  slots_total: number | null; slots_busy: number | null; throughput_json: string | null; switch_json: string | null; telemetry_at: string | null;
  last_seen_at: string | null; last_error: string | null; last_error_at: string | null; last_assigned_at: string | null;
  created_by: string | null; created_at: string; updated_at: string;
}
export interface Assignment { id: string; project_id: string; organization_id: string; worker_id: string; assigned_at: string; released_at: string | null; release_reason: string | null; selection_json: string | null }
export interface BuildModel {
  worker_id: string; model_tag: string; role: ModelRole; family: string | null; parameter_size: string | null; quantization: string | null; context_tokens: number | null;
  vram_mb: number | null; vram_source: string | null; license: string | null; tokens_per_second: number | null; requests: number; loaded: number;
  last_ok_at: string | null; last_error: string | null; updated_at: string;
}

export async function listWorkers(db: Db): Promise<BuildWorker[]> {
  return (await db.prepare(`SELECT * FROM build_workers ORDER BY created_at`).all<BuildWorker>()).results;
}
export async function getWorker(db: Db, id: string): Promise<BuildWorker | null> {
  return db.prepare(`SELECT * FROM build_workers WHERE id = ?`).bind(id).first<BuildWorker>();
}
export async function listModels(db: Db): Promise<BuildModel[]> {
  return (await db.prepare(`SELECT * FROM build_models ORDER BY worker_id, CASE role WHEN 'architect_reviewer' THEN 0 WHEN 'builder' THEN 1 ELSE 2 END, model_tag`).all<BuildModel>()).results;
}
/** Worker mode is on once any worker is registered (enabled or not). */
export async function workerModeOn(db: Db): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 FROM build_workers LIMIT 1`).first());
}
export async function activeAssignment(db: Db, projectId: string): Promise<Assignment | null> {
  return db.prepare(`SELECT * FROM build_assignments WHERE project_id = ? AND released_at IS NULL`).bind(projectId).first<Assignment>();
}
/** Builds a worker is running right now (claimed and not finished). */
export async function activeBuilds(db: Db, workerId: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM build_jobs WHERE worker_id = ? AND state IN ('preparing','building','verifying')`).bind(workerId).first<{ n: number }>())!.n;
}

async function staleMinutes(db: Db): Promise<number> {
  return (await db.prepare(`SELECT worker_stale_minutes AS m FROM build_settings WHERE id = 1`).first<{ m: number }>())?.m ?? 15;
}

const okLabel = (v: string, what: string) => { const s = v.trim().slice(0, 80); if (s.length < 2) throw new HttpError(422, `Give the ${what} a name (for example "Node 1 RTX 5090").`); return s; };
const okCapacity = (n: unknown) => { if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_ACTIVE_PROJECTS) throw new HttpError(422, `Concurrent website builds must be 1–${MAX_ACTIVE_PROJECTS} (set it from the Node 1 concurrency benchmark).`); return n as number; };

// ── Owner actions ──

export async function registerWorker(c: OwnerCtx, v: { label: string; costClass?: string; maxActiveProjects?: number }): Promise<{ id: string; enrollmentKey: string }> {
  const label = okLabel(v.label, "GPU worker");
  const costClass = (v.costClass ?? "owned-hardware") as CostClass;
  if (!COST_CLASSES.includes(costClass)) throw new HttpError(422, "Choose the hardware type.");
  if (!ZERO_FEE_COST_CLASSES.includes(costClass)) throw new HttpError(422, "Rented GPUs and paid inference servers need a separate Founder approval and budget (V4 §10). Only owned hardware can be registered.");
  const maxActive = okCapacity(v.maxActiveProjects ?? 1);
  const key = randomToken(32);
  const id = newId("wkr");
  await c.db.prepare(`INSERT INTO build_workers (id, label, provider_kind, cost_class, max_active_projects, enrollment_key_hash, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(id, label, "local-gpu", costClass, maxActive, await sha256Hex(key), c.userId, nowIso(), nowIso()).run();
  await audit(c.db, { actorUserId: c.userId, action: "builds.worker_registered", subjectType: "build_worker", subjectId: id, details: { label, costClass, maxActiveProjects: maxActive } });
  return { id, enrollmentKey: key };
}

export async function updateWorker(c: OwnerCtx, id: string, action: string, v: { reason?: string; maxActiveProjects?: number } = {}) {
  const w = await getWorker(c.db, id);
  if (!w) throw new HttpError(404, "Worker not found");
  const at = nowIso();
  if (action === "pause") {
    const why = (v.reason ?? "").trim().slice(0, 300);
    if (why.length < 3) throw new HttpError(422, "Give a reason for pausing dispatch.");
    await c.db.prepare(`UPDATE build_workers SET dispatch_paused = 1, pause_reason = ?, updated_at = ? WHERE id = ?`).bind(why, at, id).run();
  } else if (action === "resume") {
    await c.db.prepare(`UPDATE build_workers SET dispatch_paused = 0, pause_reason = NULL, updated_at = ? WHERE id = ?`).bind(at, id).run();
  } else if (action === "capacity") {
    await c.db.prepare(`UPDATE build_workers SET max_active_projects = ?, updated_at = ? WHERE id = ?`).bind(okCapacity(v.maxActiveProjects), at, id).run();
  } else if (action === "remove") {
    if (await activeBuilds(c.db, id)) throw new HttpError(409, "This worker is running builds. Pause it and let them finish (or cancel them), then remove it.");
    await c.db.prepare(`UPDATE build_workers SET enabled = 0, dispatch_paused = 1, pause_reason = 'removed', enrollment_key_hash = ?, updated_at = ? WHERE id = ?`).bind(await sha256Hex(randomToken(32)), at, id).run();
    // Its websites go back to the queue (work is in the project repositories / checkpoint archives).
    const owned = (await c.db.prepare(`SELECT project_id FROM build_assignments WHERE worker_id = ? AND released_at IS NULL`).bind(id).all<{ project_id: string }>()).results;
    for (const o of owned) await releaseAssignment(c.db, o.project_id, "worker removed");
  } else throw new HttpError(422, "Unknown action");
  await audit(c.db, { actorUserId: c.userId, action: "builds.worker_updated", subjectType: "build_worker", subjectId: id, details: { action, ...v } });
  if (action === "resume" || action === "capacity" || action === "remove") await dispatch(c.db);
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
  if (live) throw new HttpError(409, "A build is running for this project. Pause or cancel it first, so its work is checkpointed.");
  const why = reason.trim().slice(0, 300);
  if (why.length < 3) throw new HttpError(422, "Give a reason.");
  await releaseAssignment(c.db, projectId, `owner: ${why}`);
  await audit(c.db, { actorUserId: c.userId, action: "builds.project_reassigned", subjectType: "project", subjectId: projectId, organizationId: a.organization_id, details: { from: a.worker_id, reason: why } });
  await dispatch(c.db);
}

/** Owner: Founder priority of a website (-5..5). Higher runs first; waiting time still raises lower ones. */
export async function setProjectPriority(c: OwnerCtx, projectId: string, priority: number) {
  if (!Number.isInteger(priority) || priority < -5 || priority > 5) throw new HttpError(422, "Priority must be a whole number from -5 to 5.");
  const p = await c.db.prepare(`SELECT organization_id FROM projects WHERE id = ?`).bind(projectId).first<{ organization_id: string }>();
  if (!p) throw new HttpError(404, "Project not found");
  const cur = await c.db.prepare(`SELECT 1 FROM build_pipeline WHERE project_id = ?`).bind(projectId).first();
  if (!cur) await setStage(c.db, projectId, "INTAKE_RECEIVED", "Pipeline record created for a priority change", "user");
  await c.db.prepare(`UPDATE build_pipeline SET priority = ?, updated_at = ? WHERE project_id = ?`).bind(priority, nowIso(), projectId).run();
  await audit(c.db, { actorUserId: c.userId, action: "builds.project_priority", subjectType: "project", subjectId: projectId, organizationId: p.organization_id, details: { priority } });
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

const int = (v: unknown, max: number) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null;
const num = (v: unknown, max: number) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v * 10) / 10 : null;
const txt = (v: unknown, max: number) => typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : null;
const tag = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/.test(v) ? v : null;
const source = (v: unknown) => typeof v === "string" && /^[a-z0-9:._ ()-]{2,60}$/i.test(v) ? v : null;
const smallJson = (v: unknown, max = 4000) => { if (v === undefined || v === null) return null; try { const s = JSON.stringify(v); return s.length <= max ? s : null; } catch { return null; } };

/**
 * Status from a GPU worker (with each claim and every minute): liveness, hardware, VRAM, utilization, loaded and
 * supported models, requests, model switching and throughput. Values are stored as reported (bounded, validated);
 * VRAM/utilization only with a named telemetry source. The platform never fills in or estimates a value.
 */
export async function recordWorkerStatus(db: Db, w: BuildWorker, runnerId: string, b: Record<string, unknown>, now = new Date()) {
  const at = now.toISOString();
  const gpu = b.gpu && typeof b.gpu === "object" ? b.gpu as Record<string, unknown> : null;
  const src = gpu ? source(gpu.source) : null;
  const hardware = gpu ? smallJson({ name: txt(gpu.name, 80), driver: txt(gpu.driver, 40), host: txt(gpu.host, 60) }, 400) : null;
  const sched = b.inference && typeof b.inference === "object" ? b.inference as Record<string, unknown> : {};
  const loaded = (Array.isArray(sched.loaded) ? sched.loaded : []).slice(0, 8).map((x) => x as Record<string, unknown>).map((x) => ({ model: tag(x.model), vramMb: int(x.vramMb, 1_000_000) })).filter((x) => x.model);
  const err = txt(b.error, 500);
  // Liveness always; each telemetry section only when the report carries it (a bare claim does not erase the last report).
  await db.prepare(`UPDATE build_workers SET runner_id = ?, last_seen_at = ?, last_error = COALESCE(?, last_error), last_error_at = CASE WHEN ? IS NULL THEN last_error_at ELSE ? END, updated_at = ? WHERE id = ?`)
    .bind(runnerId.slice(0, 64), at, err, err, err, at, w.id).run();
  if ("gpu" in b) { // null = the worker has no current GPU sample: clear the figures (never keep stale ones)
    await db.prepare(`UPDATE build_workers SET hardware_json = COALESCE(?, hardware_json), vram_total_mb = ?, vram_used_mb = ?, gpu_util_percent = ?, telemetry_source = ?, telemetry_at = ? WHERE id = ?`)
      .bind(hardware, src ? int(gpu!.vramTotalMb, 1_000_000) : null, src ? int(gpu!.vramUsedMb, 1_000_000) : null, src ? num(gpu!.utilPercent, 100) : null, src, at, w.id).run();
  }
  if (b.inference && typeof b.inference === "object") {
    await db.prepare(`UPDATE build_workers SET loaded_models_json = ?, model_state = ?, active_requests = ?, queued_requests = ?, max_concurrent_requests = ?, throughput_json = ?, switch_json = ?, telemetry_at = ? WHERE id = ?`)
      .bind(JSON.stringify(loaded), txt(sched.state, 120), int(sched.active, 1000), int(sched.queued, 10_000), int(sched.maxConcurrent, 64), smallJson(sched.throughput), smallJson(sched.switches, 1000), at, w.id).run();
  }
  if (b.slotsTotal !== undefined) await db.prepare(`UPDATE build_workers SET slots_total = ?, slots_busy = ? WHERE id = ?`).bind(int(b.slotsTotal, 64), int(b.slotsBusy, 64), w.id).run();
  // Models this worker serves (Model A / Model B), upserted as reported.
  for (const raw of (Array.isArray(b.models) ? b.models : []).slice(0, 8)) {
    const m = raw as Record<string, unknown>;
    const t = tag(m.tag);
    const role = (MODEL_ROLES as readonly string[]).includes(m.role as string) ? m.role as ModelRole : null;
    if (!t || !role) continue;
    const vramSrc = m.vramSource === "measured" || m.vramSource === "configured-estimate" ? m.vramSource : null;
    await db.prepare(`INSERT INTO build_models (worker_id, model_tag, role, family, parameter_size, quantization, context_tokens, vram_mb, vram_source, license, tokens_per_second, requests, loaded, last_ok_at, last_error, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(worker_id, model_tag) DO UPDATE SET role = excluded.role, family = COALESCE(excluded.family, build_models.family), parameter_size = COALESCE(excluded.parameter_size, build_models.parameter_size),
          quantization = COALESCE(excluded.quantization, build_models.quantization), context_tokens = excluded.context_tokens, vram_mb = COALESCE(excluded.vram_mb, build_models.vram_mb),
          vram_source = COALESCE(excluded.vram_source, build_models.vram_source), license = COALESCE(excluded.license, build_models.license), tokens_per_second = COALESCE(excluded.tokens_per_second, build_models.tokens_per_second),
          requests = excluded.requests, loaded = excluded.loaded, last_ok_at = COALESCE(excluded.last_ok_at, build_models.last_ok_at), last_error = excluded.last_error, updated_at = excluded.updated_at`)
      .bind(w.id, t, role, txt(m.family, 40), txt(m.parameterSize, 20), txt(m.quantization, 20), int(m.contextTokens, 10_000_000),
        vramSrc ? int(m.vramMb, 1_000_000) : null, vramSrc, txt(m.license, 40), num(m.tokensPerSecond, 100_000), int(m.requests, 1e9) ?? 0, loaded.some((l) => l.model === t) ? 1 : 0,
        typeof m.lastOkAt === "string" && !Number.isNaN(Date.parse(m.lastOkAt)) ? new Date(m.lastOkAt).toISOString() : null, txt(m.lastError, 300), at).run();
  }
}

// ── Scheduling ──

export type WorkerAvailability = { workerId: string; label: string; eligible: boolean; reason: string | null; capacity: number; running: number; free: number; lastAssignedAt: string | null };

export async function workerAvailability(db: Db, now = new Date()): Promise<WorkerAvailability[]> {
  const stale = await staleMinutes(db);
  const out: WorkerAvailability[] = [];
  for (const w of await listWorkers(db)) {
    const running = await activeBuilds(db, w.id);
    let reason: string | null = null;
    if (!w.enabled) reason = "removed";
    else if (!ZERO_FEE_COST_CLASSES.includes(w.cost_class)) reason = "not owned hardware: needs a Founder approval and budget";
    else if (w.dispatch_paused) reason = `dispatch paused${w.pause_reason ? `: ${w.pause_reason}` : ""}`;
    else if (!w.last_seen_at || now.getTime() - Date.parse(w.last_seen_at) > stale * 60_000) reason = "disconnected (no status report)";
    else if (w.model_state && /^failed/i.test(w.model_state)) reason = `model server not ready: ${w.model_state}`;
    const free = Math.max(0, w.max_active_projects - running);
    out.push({ workerId: w.id, label: w.label, eligible: !reason, reason, capacity: w.max_active_projects, running, free, lastAssignedAt: w.last_assigned_at });
  }
  return out;
}

/** Eligible workers: most free capacity first, then least recently assigned. */
export function rankWorkers(av: WorkerAvailability[]): WorkerAvailability[] {
  return av.filter((a) => a.eligible).sort((a, b) => b.free - a.free || cmp(a.lastAssignedAt, b.lastAssignedAt) || a.workerId.localeCompare(b.workerId));
}
const cmp = (a: string | null, b: string | null) => (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;

/** Founder priority raised by one step per AGING_HOURS of waiting (bounded), so low-priority websites never starve. */
export function effectivePriority(priority: number, queuedSince: string, now = new Date()): number {
  const waitedH = Math.max(0, (now.getTime() - Date.parse(queuedSince)) / 3600_000);
  return priority + Math.min(10, Math.floor(waitedH / AGING_HOURS));
}

async function assign(db: Db, projectId: string, organizationId: string, w: WorkerAvailability, ranked: WorkerAvailability[], at: string, policy: string): Promise<boolean> {
  const selection = { policy, chosen: w.workerId, candidates: ranked.map((r) => ({ id: r.workerId, free: r.free, capacity: r.capacity })) };
  try {
    await db.prepare(`INSERT INTO build_assignments (id, project_id, organization_id, worker_id, assigned_at, selection_json) VALUES (?,?,?,?,?,?)`)
      .bind(newId("asg"), projectId, organizationId, w.workerId, at, JSON.stringify(selection)).run();
  } catch { return false; } // the project was assigned concurrently
  await db.prepare(`UPDATE build_workers SET last_assigned_at = ?, updated_at = ? WHERE id = ?`).bind(at, at, w.workerId).run();
  await audit(db, { actorKind: "system", action: "builds.worker_assigned", subjectType: "project", subjectId: projectId, organizationId, details: selection });
  await setStage(db, projectId, "WORKER_ASSIGNED", `Assigned to GPU worker ${w.label} (${policy})`, "system");
  return true;
}

/** Queued websites without a worker, in dispatch order (effective priority, then arrival). */
export async function dispatchOrder(db: Db, now = new Date()): Promise<{ project_id: string; organization_id: string; first: string; priority: number; effective: number }[]> {
  const rows = (await db.prepare(`SELECT j.project_id, j.organization_id, MIN(j.created_at) AS first, COALESCE(MAX(pl.priority), 0) AS priority FROM build_jobs j
      LEFT JOIN build_pipeline pl ON pl.project_id = j.project_id
      WHERE j.state = 'queued' AND NOT EXISTS (SELECT 1 FROM build_assignments a WHERE a.project_id = j.project_id AND a.released_at IS NULL)
      GROUP BY j.project_id, j.organization_id LIMIT 200`).all<{ project_id: string; organization_id: string; first: string; priority: number }>()).results;
  return rows.map((r) => ({ ...r, effective: effectivePriority(r.priority, r.first, now) }))
    .sort((a, b) => b.effective - a.effective || cmp(a.first, b.first) || a.project_id.localeCompare(b.project_id));
}

/**
 * Dispatcher (on every claim and in the 15-minute sweep): give each queued website without a worker an eligible GPU
 * worker. Affinity only: capacity is enforced when a build is claimed, so a website waiting for a person never holds
 * GPU capacity. Idempotent: the unique project index prevents double assignment.
 */
export async function dispatch(db: Db, now = new Date()): Promise<{ assigned: number; waiting: number }> {
  if (!(await workerModeOn(db))) return { assigned: 0, waiting: 0 };
  const at = now.toISOString();
  let assigned = 0, waiting = 0;
  for (const p of await dispatchOrder(db, now)) {
    let ranked = rankWorkers(await workerAvailability(db, now));
    let policy = "most free GPU capacity";
    const prev = await db.prepare(`SELECT worker_id FROM build_assignments WHERE project_id = ? ORDER BY assigned_at DESC LIMIT 1`).bind(p.project_id).first<{ worker_id: string }>();
    if (prev) { const i = ranked.findIndex((r) => r.workerId === prev.worker_id); if (i > 0) { ranked = [ranked[i], ...ranked.slice(0, i), ...ranked.slice(i + 1)]; } if (i >= 0) policy = "continuity: the worker that built it before"; }
    let ok = false;
    for (const w of ranked) { if (await assign(db, p.project_id, p.organization_id, w, ranked, at, policy)) { ok = true; break; } }
    if (ok) assigned++;
    else { waiting++; await setStage(db, p.project_id, "WAITING_FOR_GPU_CAPACITY", "No eligible GPU worker is connected; queued by priority and arrival", "system"); }
  }
  return { assigned, waiting };
}

/** Release a project's worker affinity (website finished, canceled, or the Owner reassigned it). */
export async function releaseAssignment(db: Db, projectId: string, reason: string) {
  await db.prepare(`UPDATE build_assignments SET released_at = ?, release_reason = ? WHERE project_id = ? AND released_at IS NULL`).bind(nowIso(), reason.slice(0, 300), projectId).run();
}

/** Sweep: a worker disconnected for longer than twice the stale window gives up its queued websites (not running ones). */
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

// ── Scheduler view (V4 §6: the nine categories, from recorded state only) ──

export interface SchedulerView {
  activeProjects: number; readyToRun: number; executingGpuRequests: number | null; waitingForGpu: number; waitingForTests: number;
  waitingForExternalSetup: number; waitingForHumanApproval: number; waitingForReview: number; completed: number;
}

export async function schedulerView(db: Db, now = new Date()): Promise<SchedulerView> {
  const one = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number | null }>())?.n ?? 0;
  const fresh = new Date(now.getTime() - 10 * 60_000).toISOString();
  const workers = await listWorkers(db);
  const reported = workers.filter((w) => w.telemetry_at && w.telemetry_at >= fresh && w.active_requests !== null);
  return {
    activeProjects: await one(`SELECT COUNT(*) AS n FROM build_pipeline WHERE stage NOT IN ('DELIVERED')`),
    readyToRun: await one(`SELECT COUNT(*) AS n FROM build_jobs j LEFT JOIN build_project_controls c ON c.project_id = j.project_id WHERE j.state = 'queued' AND (j.not_before IS NULL OR j.not_before <= ?) AND COALESCE(c.paused,0) = 0`, now.toISOString()),
    // Only what the GPU workers reported in the last 10 minutes; null when nothing was reported (not zero).
    executingGpuRequests: reported.length ? reported.reduce((n, w) => n + (w.active_requests ?? 0), 0) : null,
    waitingForGpu: await one(`SELECT COUNT(*) AS n FROM build_jobs WHERE state IN ('preparing','building','verifying') AND activity_state IN ('gpu_waiting','model_switching')`)
      + await one(`SELECT COUNT(*) AS n FROM build_pipeline WHERE stage = 'WAITING_FOR_GPU_CAPACITY'`),
    waitingForTests: await one(`SELECT COUNT(*) AS n FROM build_jobs WHERE state IN ('preparing','building','verifying') AND activity_state = 'testing'`),
    waitingForExternalSetup: await one(`SELECT COUNT(*) AS n FROM build_pipeline WHERE stage = 'WAITING_FOR_EXTERNAL_SETUP'`),
    waitingForHumanApproval: await one(`SELECT COUNT(*) AS n FROM build_pipeline WHERE stage IN ('WAITING_FOR_HUMAN_AUTHORIZATION','AWAITING_INTERNAL_APPROVAL','READY_FOR_CUSTOMER_PREVIEW','CUSTOMER_FEEDBACK')`),
    waitingForReview: await one(`SELECT COUNT(*) AS n FROM build_jobs WHERE state IN ('preparing','building','verifying') AND activity_state = 'reviewing'`),
    completed: await one(`SELECT COUNT(*) AS n FROM build_pipeline WHERE stage = 'DELIVERED'`),
  };
}
