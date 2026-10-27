// Local-only health endpoint (GET /health). Inside the runner container it listens on RUNNER_HEALTH_HOST:PORT; the
// compose file publishes it on 127.0.0.1 of the Windows host only. No secrets, no customer data: status fields only.

import { createServer } from "node:http";
import type { Server } from "node:http";

export interface HealthState {
  startedAt: string;
  runnerId: string;
  version: string;
  provider: string;
  model: string;
  /** Job id currently running, or null. */
  currentJob: string | null;
  currentDraft: string | null;
  lastClaimAt: string | null;
  lastClaimOk: boolean | null;
  lastClaimError: string | null;
  jobsRun: number;
  draftsServed: number;
  stopping: boolean;
}

export function newHealthState(fields: Pick<HealthState, "runnerId" | "version" | "provider" | "model">): HealthState {
  return {
    ...fields, startedAt: new Date().toISOString(), currentJob: null, currentDraft: null, lastClaimAt: null, lastClaimOk: null,
    lastClaimError: null, jobsRun: 0, draftsServed: 0, stopping: false,
  };
}

/** Healthy = the control plane answered a claim within `staleMs` (or the runner is busy with a job). */
export function healthStatus(s: HealthState, now = Date.now(), staleMs = 15 * 60_000): { ok: boolean; reason: string } {
  if (s.stopping) return { ok: false, reason: "stopping" };
  if (s.currentJob) return { ok: true, reason: "running a build" };
  if (!s.lastClaimAt) return { ok: Date.parse(s.startedAt) > now - staleMs, reason: "starting" };
  if (!s.lastClaimOk) return { ok: false, reason: `last claim failed: ${s.lastClaimError ?? "unknown"}` };
  return Date.parse(s.lastClaimAt) > now - staleMs ? { ok: true, reason: "polling" } : { ok: false, reason: "no successful claim recently" };
}

export function startHealthServer(state: HealthState, host: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url !== "/health" && req.url !== "/")) { res.writeHead(404).end(); return; }
    const h = healthStatus(state);
    res.writeHead(h.ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ status: h.ok ? "ok" : "unhealthy", reason: h.reason, ...state }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
