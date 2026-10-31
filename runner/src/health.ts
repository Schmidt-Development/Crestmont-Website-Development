// Local-only health endpoint (GET /health). Inside the runner container it listens on RUNNER_HEALTH_HOST:PORT
// (127.0.0.1 in compose; no published port). Get-RunnerHealth.ps1 reads it with `docker exec`.
// No secrets, no customer data: status fields only. Error texts are truncated and passed through the log redactor.

import { createServer } from "node:http";
import type { Server } from "node:http";
import { redact } from "./log.ts";

export interface HealthState {
  startedAt: string;
  runnerId: string;
  version: string;
  provider: string;
  model: string;
  /** Job id currently running (the latest started), or null. */
  currentJob: string | null;
  /** V4: every build this runner works on now (one per website slot). */
  runningJobs: string[];
  /** V4: GPU scheduler summary (model loaded, requests running/queued, switches). */
  inference: { state: string; active: number; queued: number; switches: number } | null;
  currentDraft: string | null;
  lastClaimAt: string | null;
  lastClaimOk: boolean | null;
  lastClaimError: string | null;
  /** Model server reachability (local provider): null until the first probe. */
  modelReachable: boolean | null;
  modelCheckedAt: string | null;
  /**
   * Founder decision D4 (native Windows Ollama): share of the loaded model held in GPU memory, from Ollama's
   * GET /api/ps (size_vram / size). 1 = fully on the GPU; < 1 = partly on the CPU (slow); null = not loaded yet or
   * the model server is not Ollama (another OpenAI-compatible provider).
   */
  modelGpuShare: number | null;
  /** Last model-server problem seen by a probe, a build phase or a draft (with its time). Cleared by nothing: history. */
  lastModelError: string | null;
  lastModelErrorAt: string | null;
  lastJobOutcome: string | null;
  lastJobError: string | null;
  lastJobAt: string | null;
  lastDraftError: string | null;
  jobsRun: number;
  draftsServed: number;
  stopping: boolean;
}

export function newHealthState(fields: Pick<HealthState, "runnerId" | "version" | "provider" | "model">): HealthState {
  return {
    ...fields, startedAt: new Date().toISOString(), currentJob: null, runningJobs: [], inference: null, currentDraft: null, lastClaimAt: null, lastClaimOk: null,
    lastClaimError: null, modelReachable: null, modelCheckedAt: null, modelGpuShare: null, lastModelError: null, lastModelErrorAt: null,
    lastJobOutcome: null, lastJobError: null, lastJobAt: null, lastDraftError: null, jobsRun: 0, draftsServed: 0, stopping: false,
  };
}

/** Error text safe for the health endpoint: secrets redacted, URL credentials and query strings dropped, short. */
export function healthText(text: string | null | undefined, max = 300): string | null {
  if (text === null || text === undefined || text === "") return null;
  const cleaned = redact(String(text))
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?]+)\?\S*/gi, "$1?[redacted]")
    .replace(/[\r\n\t]+/g, " ");
  return cleaned.length > max ? cleaned.slice(0, max) + "..." : cleaned;
}

export function recordModelProbe(s: HealthState, ok: boolean, error?: string | null, now = new Date()): void {
  s.modelReachable = ok;
  s.modelCheckedAt = now.toISOString();
  if (!ok) { s.lastModelError = healthText(error ?? "model server not reachable"); s.lastModelErrorAt = now.toISOString(); }
}

export function recordModelError(s: HealthState, error: string, now = new Date()): void {
  s.lastModelError = healthText(error);
  s.lastModelErrorAt = now.toISOString();
}

/**
 * Healthy = the control plane answered a claim within `staleMs` (or the runner is busy with a job) and, when the model
 * server has been probed, its last probe succeeded. A failed probe makes the runner unhealthy even while claims work,
 * because it could not build anything it claimed.
 */
export function healthStatus(s: HealthState, now = Date.now(), staleMs = 15 * 60_000): { ok: boolean; reason: string } {
  if (s.stopping) return { ok: false, reason: "stopping" };
  if (s.currentJob || s.runningJobs.length) return { ok: true, reason: s.runningJobs.length > 1 ? `running ${s.runningJobs.length} builds` : "running a build" };
  if (s.modelReachable === false) return { ok: false, reason: `model server not reachable: ${s.lastModelError ?? "unknown"}` };
  if (!s.lastClaimAt) return { ok: Date.parse(s.startedAt) > now - staleMs, reason: "starting" };
  if (!s.lastClaimOk) return { ok: false, reason: `last claim failed: ${s.lastClaimError ?? "unknown"}` };
  return Date.parse(s.lastClaimAt) > now - staleMs ? { ok: true, reason: "polling" } : { ok: false, reason: "no successful claim recently" };
}

export function startHealthServer(state: HealthState, host: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url !== "/health" && req.url !== "/")) { res.writeHead(404).end(); return; }
    const h = healthStatus(state);
    res.writeHead(h.ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(redact(JSON.stringify({ status: h.ok ? "ok" : "unhealthy", reason: h.reason, ...state })));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

/**
 * Ollama-only: how much of `model` is resident in GPU memory (GET <origin>/api/ps). Returns null when the model is not
 * loaded or the server has no /api/ps (another provider): the check is advisory and never blocks a build.
 */
export async function ollamaGpuShare(baseUrl: string, model: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const res = await fetchImpl(new URL("/api/ps", baseUrl).href, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = await res.json() as { models?: { name?: string; model?: string; size?: number; size_vram?: number }[] };
    const m = (body.models ?? []).find((x) => [x.name, x.model].some((n) => n === model || n === `${model}:latest`));
    if (!m || typeof m.size !== "number" || m.size <= 0 || typeof m.size_vram !== "number") return null;
    return Math.max(0, Math.min(1, Math.round((m.size_vram / m.size) * 1000) / 1000));
  } catch { return null; }
}
