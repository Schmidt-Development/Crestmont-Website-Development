// Runner entry point: `node --no-warnings src/main.ts` (Node >= 22.18 strips TypeScript types natively).
//   --preflight   check configuration, isolation, skills, the agent provider (model server + sandbox) and exit.
//   --once        claim and run at most one job, then exit.
// SIGTERM/SIGINT: stop claiming; a running job is stopped, checkpointed and completed as "released" so the control
// plane requeues it without spending an attempt (it resumes from the checkpoint).
//
// Default agent: the LOCAL provider (self-hosted models, zero per-token fees). Founder V4: Model A (architect/reviewer)
// and Model B (builder) share the GPU through one inference scheduler; RUNNER_SLOTS website builds run at once.
// The Claude Agent SDK adapter is loaded only when RUNNER_AGENT_PROVIDER=claude-agent-sdk AND
// RUNNER_ALLOW_PAID_PROVIDER=true (and the platform separately allows paid providers). No automatic fallback.

import { loadConfig } from "./config.ts";
import type { RunnerConfig } from "./config.ts";
import { createLogger, errorMessage } from "./log.ts";
import type { Logger } from "./log.ts";
import { ControlPlaneClient } from "./control-plane.ts";
import { assertIsolation, buildAgentEnv, buildCheckEnv, createWorkspace } from "./workspace.ts";
import { loadManifest, preflight } from "./skills.ts";
import type { SkillManifest, Workflow } from "./skills.ts";
import { runJob, deletePreview } from "./job.ts";
import { serveOneDeployment } from "./delivery.ts";
import type { JobDeps } from "./job.ts";
import type { QueryFn } from "./providers/claude-agent-sdk.ts";
import { assertProviderAllowed, createProvider } from "./providers/index.ts";
import { draftsServer, serveOneDraft } from "./drafts.ts";
import type { DraftOutcome } from "./drafts.ts";
import { newHealthState, startHealthServer, recordModelProbe, recordModelError, healthText, ollamaGpuShare } from "./health.ts";
import { OpenAICompatClient } from "./providers/openai-client.ts";
import type { HealthState } from "./health.ts";
import { RUNNER_VERSION } from "./protocol.ts";
import { InferenceScheduler } from "./inference/scheduler.ts";
import { OllamaResidency } from "./inference/ollama.ts";
import { ModelDetailsCache, buildWorkerStatus } from "./inference/status.ts";
import { meteredVariables } from "./orchestrator/cost-guard.ts";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LoopDeps {
  cfg: RunnerConfig;
  client: ControlPlaneClient;
  /** Only for the explicitly enabled paid adapter (real SDK query or a test fake). */
  queryFn?: QueryFn;
  manifest: SkillManifest;
  logger: Logger;
  shouldStop: () => boolean;
  sleep?: (ms: number, shouldStop: () => boolean) => Promise<void>;
  once?: boolean;
  /** Extra job dependencies (tests: fake docker executor, fake model server fetch). */
  jobDeps?: Partial<JobDeps>;
  /** Serve AI drafts when idle (null = off). */
  drafts?: { serve: () => Promise<DraftOutcome>; maxPerIdle?: number } | null;
  /** Delete expired / owner-deleted previews when idle (null = PREVIEW_DELETE_COMMAND not configured). */
  previews?: { sweep: () => Promise<"unsupported" | number> } | null;
  /** Owner-authorized customer releases (null = PRODUCTION_DEPLOY_COMMAND not configured). */
  deployments?: { serve: () => Promise<"unsupported" | "none" | "done"> } | null;
  health?: HealthState;
  /**
   * Model-server readiness probe (local provider). While it fails the runner claims neither builds nor drafts, so an
   * unreachable Ollama does not burn build attempts; it is re-checked every loop until it answers, then every
   * `intervalMs`.
   */
  modelProbe?: { check: () => Promise<{ ok: boolean; error?: string; gpuShare?: number | null }>; intervalMs?: number } | null;
  /** V4 website slots: the model-server state shared by the slots (only slot 0 probes; the others follow it). */
  shared?: { modelOk: boolean };
}

/** Probe: the model server answers GET /models and lists the configured model. No generation, no tokens. */
export function localModelProbe(cfg: RunnerConfig, fetchImpl?: typeof fetch): () => Promise<{ ok: boolean; error?: string; gpuShare?: number | null }> {
  const client = new OpenAICompatClient({ baseUrl: cfg.local.baseUrl, apiKey: cfg.local.apiKey, timeoutMs: 15_000, retries: 0, fetchImpl });
  return async () => {
    try {
      const ids = await client.models(AbortSignal.timeout(15_000));
      for (const m of new Set([cfg.local.model, ...(cfg.models.mode === "dual" ? [cfg.models.a.tag] : [])])) {
        if (!ids.some((id) => id === m || id === `${m}:latest`)) return { ok: false, error: `model ${m} is not available on the model server (pull it)` };
      }
      // Founder decision D4: report GPU residency (Ollama only; advisory, never blocks).
      return { ok: true, gpuShare: await ollamaGpuShare(cfg.local.baseUrl, cfg.local.model, fetchImpl) };
    } catch (err) {
      return { ok: false, error: `model server not reachable: ${errorMessage(err)}` };
    }
  };
}

/** Delete the previews the platform lists (owner request or retention), one at a time, and report each result. */
export async function sweepPreviews(cfg: RunnerConfig, client: ControlPlaneClient, logger: Logger, processEnv: Record<string, string | undefined> = process.env): Promise<"unsupported" | number> {
  const list = await client.expiredPreviews();
  if (list === null) return "unsupported";
  let deleted = 0;
  for (const p of list) {
    const r = await deletePreview(cfg, String(p.previewName), processEnv);
    if (r.ok) deleted++;
    else logger.warn("preview delete failed", { jobId: p.jobId, error: r.error });
    await client.previewDeleted(String(p.jobId), r.ok, r.error);
  }
  return deleted;
}

export function capabilities(cfg: RunnerConfig): string[] {
  const base = cfg.agentProvider === "local" ? ["local-model", "container-sandbox", "zero-token-cost", ...(cfg.models.mode === "dual" ? ["dual-model"] : [])] : ["agent-sdk"];
  return [...base, "git", ...(cfg.preview ? ["preview"] : []), ...((cfg.preview?.gateSecret.length ?? 0) >= 32 ? ["private-preview"] : []), ...(cfg.previewDelete ? ["preview-cleanup"] : []), ...(cfg.delivery && cfg.repo ? ["production-deploy"] : []), ...(cfg.aiDrafts.enabled && cfg.aiDrafts.provider === "local" ? ["ai-drafts"] : [])];
}

async function interruptibleSleep(ms: number, shouldStop: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !shouldStop()) await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
}

/** Poll → claim → run. Idle: serve AI drafts one at a time, then back off exponentially (longer when paused/at capacity). */
export async function runLoop(d: LoopDeps): Promise<number> {
  const sleep = d.sleep ?? interruptibleSleep;
  let idleMs = d.cfg.pollMinMs;
  let jobs = 0;
  let draftsSupported = true;
  let previewsSupported = true;
  let deploymentsSupported = true;
  let lastProbeAt = 0;
  let modelOk = true;
  let paidRefusalLogged = false;
  while (!d.shouldStop()) {
    if (!d.modelProbe && d.shared && !d.shared.modelOk) {
      // Another slot found the model server unreachable: wait for it instead of claiming builds.
      if (d.once) return jobs;
      await sleep(idleMs, d.shouldStop);
      idleMs = Math.min(d.cfg.pollMaxMs, idleMs * 2);
      continue;
    }
    if (d.modelProbe && (!modelOk || Date.now() - lastProbeAt >= (d.modelProbe.intervalMs ?? 300_000))) {
      const p = await d.modelProbe.check();
      lastProbeAt = Date.now();
      if (d.health) {
        recordModelProbe(d.health, p.ok, p.error);
        if (p.gpuShare !== undefined) {
          if (p.gpuShare !== null && p.gpuShare < 1 && d.health.modelGpuShare !== p.gpuShare) d.logger.warn("the model is only partly in GPU memory; builds will be slow (choose a smaller model or context)", { gpuShare: p.gpuShare });
          d.health.modelGpuShare = p.gpuShare;
        }
      }
      if (!p.ok && modelOk) d.logger.warn("model server not ready; not claiming builds or drafts until it answers", { error: healthText(p.error) });
      if (p.ok && !modelOk) d.logger.info("model server reachable again; claiming resumes");
      modelOk = p.ok;
      if (d.shared) d.shared.modelOk = p.ok;
      if (!modelOk) {
        if (d.once) return jobs;
        await sleep(idleMs, d.shouldStop);
        idleMs = Math.min(d.cfg.pollMaxMs, idleMs * 2);
        continue;
      }
    }
    let claimed;
    try {
      claimed = await d.client.claim(capabilities(d.cfg));
      if (d.health) { d.health.lastClaimAt = new Date().toISOString(); d.health.lastClaimOk = true; d.health.lastClaimError = null; }
    } catch (err) {
      d.logger.warn("claim failed", { error: errorMessage(err) });
      if (d.health) { d.health.lastClaimAt = new Date().toISOString(); d.health.lastClaimOk = false; d.health.lastClaimError = errorMessage(err).slice(0, 200); }
      await sleep(idleMs, d.shouldStop);
      idleMs = Math.min(d.cfg.pollMaxMs, idleMs * 2);
      continue;
    }
    if (!claimed.job) {
      if (claimed.reason === "paid_provider_not_authorized" && !paidRefusalLogged) {
        paidRefusalLogged = true;
        d.logger.warn("the platform refuses builds to this runner: it uses a paid provider and BUILD_ALLOW_PAID_PROVIDER is not enabled on the platform");
      }
      // Idle: no build is running, so one draft at a time stays within the machine's concurrency of one.
      let served = 0;
      if (d.drafts && draftsSupported) {
        const max = d.drafts.maxPerIdle ?? 5;
        while (served < max && !d.shouldStop()) {
          const out = await d.drafts.serve();
          if (out === "unsupported") { draftsSupported = false; d.logger.info("the control plane does not offer AI drafts; not polling for them again until restart"); break; }
          if (out === "none") break;
          served++;
          if (d.health) d.health.draftsServed++;
        }
      }
      if (d.previews && previewsSupported && !d.shouldStop()) {
        try {
          const n = await d.previews.sweep();
          if (n === "unsupported") { previewsSupported = false; d.logger.info("the control plane does not offer preview cleanup; not polling for it again until restart"); }
          else if (n > 0) d.logger.info("previews deleted", { count: n });
        } catch (err) { d.logger.warn("preview cleanup failed", { error: errorMessage(err) }); }
      }
      if (d.deployments && deploymentsSupported && !d.shouldStop()) {
        try {
          const r = await d.deployments.serve();
          if (r === "unsupported") { deploymentsSupported = false; d.logger.info("the control plane does not offer customer releases; not polling for them again until restart"); }
          else if (r === "done") served++;
        } catch (err) { d.logger.warn("customer release handling failed", { error: errorMessage(err) }); }
      }
      if (d.once) return jobs;
      if (served > 0) { idleMs = d.cfg.pollMinMs; continue; }
      const factor = claimed.reason === "none_queued" ? 1.5 : 3;
      await sleep(idleMs, d.shouldStop);
      idleMs = Math.min(d.cfg.pollMaxMs, Math.round(idleMs * factor));
      continue;
    }
    idleMs = d.cfg.pollMinMs;
    jobs++;
    if (d.health) { d.health.currentJob = claimed.job.id; d.health.runningJobs = [...d.health.runningJobs, claimed.job.id]; }
    let outcome = "crashed";
    let jobError: string | null = null;
    try {
      const summary = await runJob(claimed.job, { cfg: d.cfg, client: d.client, queryFn: d.queryFn, manifest: d.manifest, logger: d.logger, shutdown: d.shouldStop, ...(d.jobDeps ?? {}) });
      outcome = summary.outcome;
      jobError = summary.complete?.error ?? (summary.outcome === "lease_lost" ? "lease lost (another attempt may own the job)" : null);
    } catch (err) {
      jobError = errorMessage(err);
      d.logger.error("job crashed", { jobId: claimed.job.id, error: jobError });
    }
    if (d.health) {
      d.health.runningJobs = d.health.runningJobs.filter((id) => id !== claimed.job!.id);
      d.health.currentJob = d.health.runningJobs[d.health.runningJobs.length - 1] ?? null;
      d.health.jobsRun++;
      d.health.lastJobOutcome = outcome;
      d.health.lastJobError = healthText(jobError);
      d.health.lastJobAt = new Date().toISOString();
      if (jobError && /local model|model server/i.test(jobError)) recordModelError(d.health, jobError);
    }
    // A model failure inside the build: re-check the model server before claiming again.
    if (jobError && /local model|model server/i.test(jobError)) lastProbeAt = 0;
    if (d.once) return jobs;
  }
  return jobs;
}

/**
 * V4: several website builds at once, each in its own slot (own workspace, sandbox container, transcript, checkpoints).
 * Slot 0 also serves drafts, preview cleanup and customer releases and probes the model server for all slots. Slots
 * start a few seconds apart so they do not claim at the same instant; the platform enforces the worker's capacity.
 */
export async function runSlots(d: LoopDeps, slots: number, stagger = 3000): Promise<number> {
  const shared = d.shared ?? { modelOk: true };
  const loops: Promise<number>[] = [];
  for (let i = 0; i < Math.max(1, slots); i++) {
    const deps: LoopDeps = i === 0 ? { ...d, shared } : { ...d, shared, drafts: null, previews: null, deployments: null, modelProbe: null, logger: d.logger.child({ slot: i }) };
    loops.push((async () => { if (i > 0) await (d.sleep ?? interruptibleSleep)(i * stagger, d.shouldStop); return d.shouldStop() ? 0 : runLoop(deps); })());
  }
  return (await Promise.all(loops)).reduce((a, b) => a + b, 0);
}

/** The shared GPU scheduler for the local provider (null for the paid adapter, whose model is not ours). */
export function createScheduler(cfg: RunnerConfig, logger: Logger, fetchImpl?: typeof fetch): InferenceScheduler | null {
  if (cfg.agentProvider !== "local") return null;
  const models = cfg.models.mode === "dual" ? [cfg.models.a, cfg.models.b] : [cfg.models.b];
  return new InferenceScheduler({
    models, maxConcurrent: cfg.inference.maxConcurrent, vramTotalMb: cfg.inference.vramTotalMb, vramReserveMb: cfg.inference.vramReserveMb,
    switchTimeoutMs: cfg.inference.switchTimeoutMs, maxWaitBeforeSwitchMs: cfg.inference.maxWaitBeforeSwitchMs, keepAlive: cfg.inference.keepAlive,
    residency: new OllamaResidency(cfg.local.baseUrl, fetchImpl), log: logger.child({ component: "gpu-scheduler" }),
  });
}

async function runPreflight(cfg: RunnerConfig, manifest: SkillManifest, logger: Logger, queryFn?: QueryFn): Promise<boolean> {
  const tmp = createWorkspace(cfg.workspacesRoot, { id: "preflight", attempt: 0 });
  try {
    const env = buildCheckEnv(buildAgentEnv(cfg, tmp));
    let ok = true;
    for (const wf of ["standard-brochure", "custom-app"] as Workflow[]) {
      const r = await preflight({ manifest, workflow: wf, skillsSourceDir: cfg.skillsSourceDir, sandbox: cfg.sandbox, env, checkTools: cfg.agentProvider !== "local" });
      logger.info("preflight", { workflow: wf, ok: r.ok, errors: r.errors, warnings: r.warnings });
      ok &&= r.ok;
    }
    const provider = createProvider(cfg, { log: logger, queryFn });
    const p = await provider.preflight(logger);
    logger.info("preflight provider", { provider: provider.id, models: provider.id === "local" ? { mode: cfg.models.mode, a: cfg.models.a.tag, b: cfg.models.b.tag } : "(per job)", ok: p.errors.length === 0, errors: p.errors, warnings: p.warnings });
    // $0 policy (V4 §10): metered-billing credentials have no place on a local runner; they are never used, but say so.
    const metered = cfg.agentProvider === "local" ? meteredVariables(process.env) : [];
    if (metered.length) logger.warn("preflight: metered AI credentials are set in the runner's environment; they are never passed to the agent or used, remove them", { names: metered });
    ok &&= p.errors.length === 0;
    return ok;
  } finally {
    rmSync(tmp.dir, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.logLevel, base: { runnerId: cfg.runnerId } });
  assertProviderAllowed(cfg);
  await assertIsolation({ cwd: process.cwd(), workspacesRoot: cfg.workspacesRoot, platformRepoPatterns: cfg.platformRepoPatterns, pathEnv: cfg.agentPath });
  const manifest = loadManifest(cfg.skillsManifestPath);

  // The real SDK is loaded only for the explicitly enabled paid adapter; the local default never imports it.
  let queryFn: QueryFn | undefined;
  if (cfg.agentProvider === "claude-agent-sdk") {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    queryFn = sdk.query as QueryFn;
  }
  if (argv.includes("--preflight")) return (await runPreflight(cfg, manifest, logger, queryFn)) ? 0 : 1;

  const client = new ControlPlaneClient({ baseUrl: cfg.controlPlaneUrl, secret: cfg.secret, runnerId: cfg.runnerId, logger, worker: cfg.worker });
  const health = newHealthState({ runnerId: cfg.runnerId, version: RUNNER_VERSION, provider: cfg.agentProvider, model: cfg.agentProvider === "local" ? (cfg.models.mode === "dual" ? `A ${cfg.models.a.tag} / B ${cfg.models.b.tag}` : cfg.local.model) : "per job" });
  const scheduler = createScheduler(cfg, logger);
  if (cfg.healthPort) {
    await startHealthServer(health, cfg.healthHost, cfg.healthPort);
    logger.info("health endpoint listening", { host: cfg.healthHost, port: cfg.healthPort });
  }
  let stopping = false;
  const onSignal = (sig: string) => { logger.warn("shutdown requested", { signal: sig }); stopping = true; health.stopping = true; };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
  const ds = draftsServer(cfg, logger);
  logger.info("runner started", {
    version: RUNNER_VERSION, controlPlane: new URL(cfg.controlPlaneUrl).origin, provider: cfg.agentProvider,
    paidProviderAllowed: cfg.allowPaidProvider, model: cfg.agentProvider === "local" ? cfg.local.model : "per job",
    aiDrafts: !!ds, preview: !!cfg.preview, privatePreviewGate: (cfg.preview?.gateSecret.length ?? 0) >= 32, customerDelivery: !!(cfg.delivery && cfg.repo), projectRepos: !!cfg.repo,
    worker: cfg.worker?.id ?? null, architect: cfg.advisor.architect, reviewer: cfg.advisor.reviewer,
    models: cfg.agentProvider === "local" ? { mode: cfg.models.mode, a: cfg.models.a.tag, b: cfg.models.b.tag } : null, slots: cfg.slots,
    gpu: { maxConcurrent: cfg.inference.maxConcurrent, vramTotalMb: cfg.inference.vramTotalMb || "unknown", reserveMb: cfg.inference.vramReserveMb },
  });
  // GPU worker status: with every claim and every minute (V4 §9). Values as measured; nothing estimated.
  const details = scheduler ? new ModelDetailsCache(new OllamaResidency(cfg.local.baseUrl)) : null;
  const reportStatus = async () => {
    try {
      const status = await buildWorkerStatus(cfg, scheduler, { total: cfg.slots, busy: health.runningJobs.length }, details);
      const s = scheduler?.status();
      health.inference = s ? { state: s.state, active: s.active, queued: s.queued, switches: s.switches.count } : null;
      if (cfg.worker) await client.reportWorkerStatus(status); else client.workerStatus = status;
    } catch (err) { logger.warn("worker status report failed", { error: errorMessage(err) }); }
  };
  await reportStatus();
  const statusTimer = setInterval(() => void reportStatus(), 60_000);
  statusTimer.unref();
  if (cfg.preview && cfg.preview.gateSecret.length < 32) logger.warn("PREVIEW_DEPLOY_COMMAND is set but PREVIEW_GATE_SECRET is missing or shorter than 32 characters: no preview will be deployed (previews are private; Founder decision D3)");
  const onDraftError = (msg: string) => {
    health.lastDraftError = healthText(msg);
    if (/local model/i.test(msg)) recordModelError(health, msg);
  };
  await runSlots({
    cfg, client, queryFn, manifest, logger, shouldStop: () => stopping, once: argv.includes("--once"), health, jobDeps: { scheduler },
    drafts: ds ? { serve: () => serveOneDraft({ client, model: ds.model, modelName: ds.modelName, baseUrl: ds.baseUrl, log: logger, onError: onDraftError }) } : null,
    previews: cfg.previewDelete ? { sweep: () => sweepPreviews(cfg, client, logger) } : null,
    deployments: cfg.delivery && cfg.repo ? { serve: () => serveOneDeployment(cfg, client, capabilities(cfg), { logger }) } : null,
    // The local provider (and local drafts) need the model server; the paid adapter's model is not ours to probe.
    modelProbe: cfg.agentProvider === "local" ? { check: localModelProbe(cfg), intervalMs: 300_000 } : null,
  }, argv.includes("--once") ? 1 : cfg.slots);
  clearInterval(statusTimer);
  scheduler?.close();
  logger.info("runner stopped");
  return 0;
}

// import.meta.main is not available on every Node 22.x, so compare paths instead.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stderr.write(`runner: ${errorMessage(err)}\n`);
    process.exit(1);
  });
}
