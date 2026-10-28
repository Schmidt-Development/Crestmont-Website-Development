// Runner entry point: `node --no-warnings src/main.ts` (Node >= 22.18 strips TypeScript types natively).
//   --preflight   check configuration, isolation, skills, the agent provider (model server + sandbox) and exit.
//   --once        claim and run at most one job, then exit.
// SIGTERM/SIGINT: stop claiming; a running job is stopped, checkpointed and completed as "released" so the control
// plane requeues it without spending an attempt (it resumes from the checkpoint).
//
// Default agent: the LOCAL provider (self-hosted model, zero per-token fees). The Claude Agent SDK adapter is loaded
// only when RUNNER_AGENT_PROVIDER=claude-agent-sdk AND RUNNER_ALLOW_PAID_PROVIDER=true. No automatic fallback.

import { loadConfig } from "./config.ts";
import type { RunnerConfig } from "./config.ts";
import { createLogger, errorMessage } from "./log.ts";
import type { Logger } from "./log.ts";
import { ControlPlaneClient } from "./control-plane.ts";
import { assertIsolation, buildAgentEnv, buildCheckEnv, createWorkspace } from "./workspace.ts";
import { loadManifest, preflight } from "./skills.ts";
import type { SkillManifest, Workflow } from "./skills.ts";
import { runJob } from "./job.ts";
import type { JobDeps } from "./job.ts";
import type { QueryFn } from "./providers/claude-agent-sdk.ts";
import { assertProviderAllowed, createProvider } from "./providers/index.ts";
import { draftsServer, serveOneDraft } from "./drafts.ts";
import type { DraftOutcome } from "./drafts.ts";
import { newHealthState, startHealthServer, recordModelProbe, recordModelError, healthText } from "./health.ts";
import { OpenAICompatClient } from "./providers/openai-client.ts";
import type { HealthState } from "./health.ts";
import { RUNNER_VERSION } from "./protocol.ts";
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
  health?: HealthState;
  /**
   * Model-server readiness probe (local provider). While it fails the runner claims neither builds nor drafts, so an
   * unreachable Ollama does not burn build attempts; it is re-checked every loop until it answers, then every
   * `intervalMs`.
   */
  modelProbe?: { check: () => Promise<{ ok: boolean; error?: string }>; intervalMs?: number } | null;
}

/** Probe: the model server answers GET /models and lists the configured model. No generation, no tokens. */
export function localModelProbe(cfg: RunnerConfig, fetchImpl?: typeof fetch): () => Promise<{ ok: boolean; error?: string }> {
  const client = new OpenAICompatClient({ baseUrl: cfg.local.baseUrl, apiKey: cfg.local.apiKey, timeoutMs: 15_000, retries: 0, fetchImpl });
  return async () => {
    try {
      const ids = await client.models(AbortSignal.timeout(15_000));
      const m = cfg.local.model;
      if (!ids.some((id) => id === m || id === `${m}:latest`)) return { ok: false, error: `model ${m} is not available on the model server (pull it)` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `model server not reachable: ${errorMessage(err)}` };
    }
  };
}

export function capabilities(cfg: RunnerConfig): string[] {
  const base = cfg.agentProvider === "local" ? ["local-model", "container-sandbox", "zero-token-cost"] : ["agent-sdk"];
  return [...base, "git", ...(cfg.preview ? ["preview"] : []), ...(cfg.aiDrafts.enabled && cfg.aiDrafts.provider === "local" ? ["ai-drafts"] : [])];
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
  let lastProbeAt = 0;
  let modelOk = true;
  let paidRefusalLogged = false;
  while (!d.shouldStop()) {
    if (d.modelProbe && (!modelOk || Date.now() - lastProbeAt >= (d.modelProbe.intervalMs ?? 300_000))) {
      const p = await d.modelProbe.check();
      lastProbeAt = Date.now();
      if (d.health) recordModelProbe(d.health, p.ok, p.error);
      if (!p.ok && modelOk) d.logger.warn("model server not ready; not claiming builds or drafts until it answers", { error: healthText(p.error) });
      if (p.ok && !modelOk) d.logger.info("model server reachable again; claiming resumes");
      modelOk = p.ok;
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
      if (d.once) return jobs;
      if (served > 0) { idleMs = d.cfg.pollMinMs; continue; }
      const factor = claimed.reason === "none_queued" ? 1.5 : 3;
      await sleep(idleMs, d.shouldStop);
      idleMs = Math.min(d.cfg.pollMaxMs, Math.round(idleMs * factor));
      continue;
    }
    idleMs = d.cfg.pollMinMs;
    jobs++;
    if (d.health) d.health.currentJob = claimed.job.id;
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
      d.health.currentJob = null;
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
    logger.info("preflight provider", { provider: provider.id, model: provider.id === "local" ? cfg.local.model : "(per job)", ok: p.errors.length === 0, errors: p.errors, warnings: p.warnings });
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

  const client = new ControlPlaneClient({ baseUrl: cfg.controlPlaneUrl, secret: cfg.secret, runnerId: cfg.runnerId, logger });
  const health = newHealthState({ runnerId: cfg.runnerId, version: RUNNER_VERSION, provider: cfg.agentProvider, model: cfg.agentProvider === "local" ? cfg.local.model : "per job" });
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
    aiDrafts: !!ds, preview: !!cfg.preview, projectRepos: !!cfg.repo,
  });
  const onDraftError = (msg: string) => {
    health.lastDraftError = healthText(msg);
    if (/local model/i.test(msg)) recordModelError(health, msg);
  };
  await runLoop({
    cfg, client, queryFn, manifest, logger, shouldStop: () => stopping, once: argv.includes("--once"), health,
    drafts: ds ? { serve: () => serveOneDraft({ client, model: ds.model, modelName: ds.modelName, log: logger, onError: onDraftError }) } : null,
    // The local provider (and local drafts) need the model server; the paid adapter's model is not ours to probe.
    modelProbe: cfg.agentProvider === "local" ? { check: localModelProbe(cfg), intervalMs: 300_000 } : null,
  });
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
