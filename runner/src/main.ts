// Runner entry point: `node --no-warnings src/main.ts` (Node >= 22.18 strips TypeScript types natively).
//   --preflight   check configuration, isolation, skills and tools for both workflows, then exit.
//   --once        claim and run at most one job, then exit.
// SIGTERM/SIGINT: stop claiming; a running job is stopped, checkpointed and completed as failed("runner shutdown")
// so the control plane retries it (resuming from the checkpoint).

import { loadConfig } from "./config.ts";
import type { RunnerConfig } from "./config.ts";
import { createLogger, errorMessage } from "./log.ts";
import type { Logger } from "./log.ts";
import { ControlPlaneClient } from "./control-plane.ts";
import { assertIsolation, buildAgentEnv, buildCheckEnv, createWorkspace } from "./workspace.ts";
import { loadManifest, preflight } from "./skills.ts";
import type { SkillManifest, Workflow } from "./skills.ts";
import { runJob } from "./job.ts";
import type { QueryFn } from "./agent.ts";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LoopDeps {
  cfg: RunnerConfig;
  client: ControlPlaneClient;
  queryFn: QueryFn;
  manifest: SkillManifest;
  logger: Logger;
  shouldStop: () => boolean;
  sleep?: (ms: number, shouldStop: () => boolean) => Promise<void>;
  once?: boolean;
}

const CAPABILITIES = (cfg: RunnerConfig) => ["agent-sdk", "git", ...(cfg.preview ? ["preview"] : [])];

async function interruptibleSleep(ms: number, shouldStop: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !shouldStop()) await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
}

/** Poll → claim → run. Idle polling backs off exponentially (longer when paused/at capacity). */
export async function runLoop(d: LoopDeps): Promise<number> {
  const sleep = d.sleep ?? interruptibleSleep;
  let idleMs = d.cfg.pollMinMs;
  let jobs = 0;
  while (!d.shouldStop()) {
    let claimed;
    try {
      claimed = await d.client.claim(CAPABILITIES(d.cfg));
    } catch (err) {
      d.logger.warn("claim failed", { error: errorMessage(err) });
      await sleep(idleMs, d.shouldStop);
      idleMs = Math.min(d.cfg.pollMaxMs, idleMs * 2);
      continue;
    }
    if (!claimed.job) {
      if (d.once) return jobs;
      const factor = claimed.reason === "none_queued" ? 1.5 : 3;
      await sleep(idleMs, d.shouldStop);
      idleMs = Math.min(d.cfg.pollMaxMs, Math.round(idleMs * factor));
      continue;
    }
    idleMs = d.cfg.pollMinMs;
    jobs++;
    try {
      await runJob(claimed.job, { cfg: d.cfg, client: d.client, queryFn: d.queryFn, manifest: d.manifest, logger: d.logger, shutdown: d.shouldStop });
    } catch (err) {
      d.logger.error("job crashed", { jobId: claimed.job.id, error: errorMessage(err) });
    }
    if (d.once) return jobs;
  }
  return jobs;
}

async function runPreflight(cfg: RunnerConfig, manifest: SkillManifest, logger: Logger): Promise<boolean> {
  const tmp = createWorkspace(cfg.workspacesRoot, { id: "preflight", attempt: 0 });
  try {
    const env = buildCheckEnv(buildAgentEnv(cfg, tmp));
    let ok = true;
    for (const wf of ["standard-brochure", "custom-app"] as Workflow[]) {
      const r = await preflight({ manifest, workflow: wf, skillsSourceDir: cfg.skillsSourceDir, sandbox: cfg.sandbox, env });
      logger.info("preflight", { workflow: wf, ok: r.ok, errors: r.errors, warnings: r.warnings });
      ok &&= r.ok;
    }
    return ok;
  } finally {
    rmSync(tmp.dir, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.logLevel, base: { runnerId: cfg.runnerId } });
  await assertIsolation({ cwd: process.cwd(), workspacesRoot: cfg.workspacesRoot, platformRepoPatterns: cfg.platformRepoPatterns, pathEnv: cfg.agentPath });
  const manifest = loadManifest(cfg.skillsManifestPath);
  if (argv.includes("--preflight")) return (await runPreflight(cfg, manifest, logger)) ? 0 : 1;

  // The real SDK is loaded only here; tests inject a fake query function instead.
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const client = new ControlPlaneClient({ baseUrl: cfg.controlPlaneUrl, secret: cfg.secret, runnerId: cfg.runnerId, logger });
  let stopping = false;
  const onSignal = (sig: string) => { logger.warn("shutdown requested", { signal: sig }); stopping = true; };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
  logger.info("runner started", { controlPlane: new URL(cfg.controlPlaneUrl).origin, sandbox: cfg.sandbox, preview: !!cfg.preview, projectRepos: !!cfg.repo });
  await runLoop({ cfg, client, queryFn: sdk.query as QueryFn, manifest, logger, shouldStop: () => stopping, once: argv.includes("--once") });
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
