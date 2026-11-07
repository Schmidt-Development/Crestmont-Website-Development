// Sandbox lifecycle for the proof-of-concept scripts.
//
// THE DEFECT THIS FIXES. `ci/frontend-integration-poc.ts` left a container running for eighteen hours on a GPU
// host: `cm-job-bld_integration_poc-a1-53a1f4`, still holding its CPU, memory and PID limits. Two reasons, and
// both are addressed here rather than by remembering harder:
//
//   1. The scripts closed the sandbox they used for the model run, but not the separate one `install()` creates,
//      and nothing closed anything if the process died between creating a sandbox and reaching its `finally`.
//   2. The runner's own orphan reaper could never have collected it. `JobSandbox.reapOrphans` removes only
//      containers labelled with ITS runner id — deliberately, so that two runners sharing a Docker host never
//      remove each other's work — and the PoC containers carry a different id.
//
// So each script gets its own stable runner id, reaps whatever its OWN previous run left behind before it
// starts, and closes every sandbox it created on the way out, including on a crash. Containers belonging to the
// real runner, or to another script, are never touched: the label is the boundary.

import { tmpdir } from "node:os";
import path from "node:path";
import { JobSandbox, cliDockerExecutor } from "../src/sandbox.ts";
import type { DockerExecutor } from "../src/sandbox.ts";
import type { JobSandboxConfig } from "../src/config.ts";
import type { Workspace } from "../src/workspace.ts";
import type { Logger } from "../src/log.ts";
import { silentLogger } from "../src/log.ts";

/**
 * The environment handed to docker, with names that are not valid identifiers removed.
 *
 * This Windows host has a variable literally named `3DVPATH`, and the runner's execution policy refuses an
 * environment containing one — correctly, since that is how odd names get smuggled into a child process. The
 * policy is not loosened; the environment is cleaned.
 */
export function dockerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out[k] = v;
  }
  return out;
}

/**
 * Tracks every sandbox a script creates so one `finally` can close all of them.
 *
 * `close()` is safe to call more than once and never throws: a cleanup path that can fail is a cleanup path
 * that leaves containers behind, which is the whole problem.
 */
export class PocSandboxes {
  readonly executor: DockerExecutor;
  private readonly cfg: JobSandboxConfig;
  private readonly log: Logger;
  private readonly open: JobSandbox[] = [];
  private closed = false;

  constructor(cfg: JobSandboxConfig, log: Logger = silentLogger) {
    this.cfg = cfg;
    this.log = log;
    this.executor = cliDockerExecutor(cfg.dockerBin, dockerEnv());
  }

  /**
   * Remove containers this script's PREVIOUS run left behind.
   *
   * Scoped to this script's own runner id, so a crashed run cleans up after itself on the next run and nothing
   * else is affected. Reported rather than silent: a script that quietly removes containers is as hard to
   * reason about as one that quietly leaves them.
   */
  async reapOwn(): Promise<{ removed: string[]; errors: string[] }> {
    const r = await JobSandbox.reapOrphans(this.cfg, this.executor, this.log);
    if (r.removed.length) console.log(`removed ${r.removed.length} container(s) left by a previous run: ${r.removed.join(", ")}`);
    if (r.unlabelled.length) console.log(`left alone (not this script's): ${r.unlabelled.join(", ")}`);
    for (const e of r.errors) console.error(`cleanup problem: ${e}`);
    return { removed: r.removed, errors: r.errors };
  }

  /** A sandbox this tracker will close. */
  create(ws: Workspace, jobId: string): JobSandbox {
    const s = new JobSandbox(this.cfg, ws, jobId, this.executor, this.log);
    this.open.push(s);
    return s;
  }

  async closeAll(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.open.splice(0)) {
      try { await s.close(); } catch (err) { console.error(`could not close ${s.name}: ${String((err as Error)?.message ?? err)}`); }
    }
  }

  /**
   * Close on the ways a script actually ends, not just the happy one.
   *
   * Ctrl-C and an unhandled rejection both killed the PoC scripts during development, and neither ran a
   * `finally`. Returns a function that removes the handlers again.
   */
  installExitHandlers(): () => void {
    const bye = (code: number) => () => { void this.closeAll().finally(() => process.exit(code)); };
    const onInt = bye(130), onTerm = bye(143);
    const onFatal = (err: unknown) => { console.error(String((err as Error)?.stack ?? err)); void this.closeAll().finally(() => process.exit(1)); };
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    process.on("uncaughtException", onFatal);
    process.on("unhandledRejection", onFatal);
    return () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      process.off("uncaughtException", onFatal);
      process.off("unhandledRejection", onFatal);
    };
  }
}

/** A sandbox config for a PoC script, with its own runner id so its containers are identifiable and reapable. */
export function pocConfig(runnerId: string, over: Partial<JobSandboxConfig> = {}): JobSandboxConfig {
  const env = process.env;
  return {
    dockerBin: env.RUNNER_DOCKER_BIN ?? "docker",
    image: env.RUNNER_SANDBOX_IMAGE ?? "crestmont-build-sandbox:1",
    runnerId,
    volume: "",
    // Bind mounts (volume ""), so JobSandbox never consults this; it is stated because a sandbox on the
    // workspaces VOLUME can only mount <workspacesRoot>/<ref> and has to be able to check that.
    workspacesRoot: path.resolve(env.RUNNER_WORKSPACES ?? tmpdir()),
    cpus: env.RUNNER_JOB_CPUS ?? "8",
    memory: env.RUNNER_JOB_MEMORY ?? "8g",
    pidsLimit: 512,
    tmpfsMb: 512,
    commandTimeoutMs: 600_000,
    installTimeoutMs: 900_000,
    installNetwork: env.RUNNER_INSTALL_NETWORK ?? "crestmont_install",
    installProxy: env.RUNNER_INSTALL_PROXY ?? "http://egress-proxy:3128",
    registry: env.RUNNER_NPM_REGISTRY ?? "https://registry.npmjs.org/",
    diskQuotaMb: 4096,
    uid: Number(env.RUNNER_JOB_UID ?? 10001),
    allowedBuildScripts: [],
    browserCheck: true,
    ...over,
  };
}
