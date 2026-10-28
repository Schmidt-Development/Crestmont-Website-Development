// Per-build container sandbox. Every command the local agent runs, every package install, every acceptance check
// and the browser check run inside a container created for this job only - never in the runner process and never
// on the (Windows) host:
//
//   job container   docker run -d --init --network none  (agent commands, builds, tests, browser checks)
//   install runs    docker run --rm --network <install network>  (npm ci/install --ignore-scripts through the
//                   allow-listed registry proxy; the install network is `internal`, the proxy is its only way out)
//
// Both: non-root uid, --read-only root filesystem + size-limited tmpfs, --cap-drop ALL, no-new-privileges,
// --cpus/--memory/--pids-limit, and ONLY this job's repo + home directories mounted (no Docker socket, no host home,
// no secrets, no other job's files). The runner talks to Docker; the agent only gets tool results.
// Disk: the repo/home live on the shared workspaces volume, so a per-job quota is enforced by measuring the job's
// directory after every command (`overDiskQuota`) and failing the build when it exceeds RUNNER_JOB_DISK_MB.
// (`--storage-opt size=` would need overlay2 on xfs with pquota, which Docker Desktop's VM does not provide, and the
// root filesystem is read-only anyway.)

import { lstatSync, readdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { run } from "./exec.ts";
import type { ExecResult } from "./exec.ts";
import type { JobSandboxConfig } from "./config.ts";
import type { Workspace } from "./workspace.ts";
import type { Logger } from "./log.ts";
import { silentLogger } from "./log.ts";

/** Runs the docker CLI. Injected so tests can record the exact flags without a Docker daemon. */
export type DockerExecutor = (args: string[], opts: { timeoutMs: number }) => Promise<ExecResult>;

export function cliDockerExecutor(dockerBin: string, env: Record<string, string>): DockerExecutor {
  return (args, opts) => run(dockerBin, args, { env, timeoutMs: opts.timeoutMs, maxOutput: 4 * 1024 * 1024 });
}

export const CONTAINER_REPO = "/workspace/repo";
export const CONTAINER_HOME = "/home/builder";
export const BROWSER_CHECK = "/opt/crestmont/browser-check.mjs";

/** npm package specs the agent may request: registry names with an optional plain version range. */
const PACKAGE_SPEC = /^(@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,100}(@[0-9A-Za-z.^~*+<>= -]{1,40})?$/;

export function validatePackageSpec(spec: string): string | null {
  if (typeof spec !== "string" || !PACKAGE_SPEC.test(spec)) return `"${String(spec).slice(0, 80)}" is not an allowed package spec (registry package names only; no URLs, paths, git or tarballs)`;
  return null;
}

export interface SandboxCommandResult extends ExecResult { command: string }

export class JobSandbox {
  readonly name: string;
  readonly cfg: JobSandboxConfig;
  readonly ws: Workspace;
  readonly jobId: string;
  private readonly exec: DockerExecutor;
  private readonly log: Logger;
  private started = false;

  constructor(cfg: JobSandboxConfig, ws: Workspace, jobId: string, exec: DockerExecutor, log: Logger = silentLogger) {
    this.cfg = cfg;
    this.ws = ws;
    this.jobId = jobId;
    this.exec = exec;
    this.log = log;
    this.name = `cm-job-${ws.ref}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 120);
  }

  /** Mounts: this job's repo and home only. Volume sub-paths when the runner itself runs in a container. */
  mountFlags(): string[] {
    const m = (sub: "repo" | "home", dst: string, hostPath: string) => this.cfg.volume
      ? `type=volume,src=${this.cfg.volume},dst=${dst},volume-subpath=${this.ws.ref}/${sub}`
      : `type=bind,src=${hostPath},dst=${dst}`;
    return ["--mount", m("repo", CONTAINER_REPO, this.ws.repo), "--mount", m("home", CONTAINER_HOME, this.ws.home)];
  }

  /** Flags shared by the job container and install runs. */
  hardeningFlags(network: string): string[] {
    const c = this.cfg;
    return [
      "--network", network,
      "--user", `${c.uid}:${c.uid}`,
      "--cpus", c.cpus,
      "--memory", c.memory,
      "--memory-swap", c.memory,
      "--pids-limit", String(c.pidsLimit),
      "--read-only",
      "--tmpfs", `/tmp:rw,nosuid,nodev,size=${c.tmpfsMb}m`,
      "--shm-size", "256m",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--workdir", CONTAINER_REPO,
      "--label", "crestmont.role=build-sandbox",
      "--label", `crestmont.job=${this.jobId}`,
      "--env", `HOME=${CONTAINER_HOME}`,
      "--env", "CI=1",
      "--env", `NPM_CONFIG_CACHE=${CONTAINER_HOME}/.npm`,
      "--env", "NPM_CONFIG_UPDATE_NOTIFIER=false",
      "--env", "NPM_CONFIG_FUND=false",
      "--env", "NPM_CONFIG_AUDIT=false",
      "--env", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
      ...this.mountFlags(),
    ];
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.exec(["rm", "-f", this.name], { timeoutMs: 60_000 });
    const r = await this.exec(["run", "-d", "--init", "--name", this.name, ...this.hardeningFlags("none"), this.cfg.image, "sleep", "infinity"], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`could not start the build sandbox container: ${(r.stderr || r.stdout).slice(0, 400)}`);
    this.started = true;
    this.log.info("sandbox started", { container: this.name });
  }

  /** Run a shell command inside the job container (network none). The in-container `timeout` kills it reliably. */
  async shell(command: string, timeoutMs = this.cfg.commandTimeoutMs): Promise<SandboxCommandResult> {
    return this.argv(["bash", "-c", command], timeoutMs, command);
  }

  /** Run an argv inside the job container (network none). */
  async argv(argv: string[], timeoutMs = this.cfg.commandTimeoutMs, label = argv.join(" ")): Promise<SandboxCommandResult> {
    await this.start();
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    const r = await this.exec(["exec", "--workdir", CONTAINER_REPO, this.name, "timeout", "-k", "5", String(secs), ...argv], { timeoutMs: timeoutMs + 20_000 });
    if (r.timedOut) {
      // The docker client hung past the in-container timeout: restart the container so nothing keeps running.
      this.log.warn("sandbox command exceeded its timeout; restarting the container", { container: this.name });
      await this.restart();
    }
    return { ...r, timedOut: r.timedOut || r.code === 124 || r.code === 137, command: label };
  }

  /**
   * Install dependencies in a throw-away container on the install network (its only egress is the registry proxy),
   * with lifecycle scripts disabled. Explicitly approved packages then get their build scripts run offline.
   */
  async install(opts: { packages?: string[]; dev?: boolean } = {}): Promise<SandboxCommandResult> {
    const pkgs = opts.packages ?? [];
    for (const p of pkgs) {
      const bad = validatePackageSpec(p);
      if (bad) return { code: 2, stdout: "", stderr: bad, timedOut: false, notFound: false, command: "install" };
    }
    const hasLock = existsSync(path.join(this.ws.repo, "package-lock.json"));
    const base = ["--ignore-scripts", "--no-audit", "--no-fund"];
    const npmArgs = pkgs.length
      ? ["npm", "install", ...base, "--save-exact", ...(opts.dev ? ["--save-dev"] : []), "--", ...pkgs]
      : hasLock ? ["npm", "ci", ...base] : ["npm", "install", ...base];
    const proxy = this.cfg.installProxy;
    const secs = Math.ceil(this.cfg.installTimeoutMs / 1000);
    const r = await this.exec([
      "run", "--rm", "--name", `${this.name}-install`, ...this.hardeningFlags(this.cfg.installNetwork),
      "--env", `npm_config_registry=${this.cfg.registry}`,
      "--env", `npm_config_proxy=${proxy}`,
      "--env", `npm_config_https_proxy=${proxy}`,
      "--env", "npm_config_ignore_scripts=true",
      this.cfg.image, "timeout", "-k", "5", String(secs), ...npmArgs,
    ], { timeoutMs: this.cfg.installTimeoutMs + 30_000 });
    const label = npmArgs.join(" ");
    if (r.code !== 0) return { ...r, command: label };
    // Approved build scripts run offline in the job container (network none).
    const approved = this.cfg.allowedBuildScripts.filter((p) => existsSync(path.join(this.ws.repo, "node_modules", ...p.split("/"))));
    if (approved.length) {
      const rb = await this.argv(["npm", "rebuild", "--foreground-scripts", ...approved], this.cfg.installTimeoutMs);
      return { ...rb, stdout: `${r.stdout}\n${rb.stdout}`, command: `${label} && npm rebuild ${approved.join(" ")}` };
    }
    return { ...r, command: label };
  }

  /** Browser validation of a static site inside the job container (Playwright Chromium, network none). */
  async browserCheck(root: string, timeoutMs = this.cfg.commandTimeoutMs): Promise<SandboxCommandResult> {
    return this.argv(["node", BROWSER_CHECK, "--root", root, "--out", ".crestmont/screenshots"], timeoutMs);
  }

  /** Bytes used by this job's directory (repo, home, checkpoints). Symlinks are not followed. */
  diskUsageBytes(): number {
    return dirBytes(this.ws.dir, 0);
  }

  overDiskQuota(): { over: boolean; usedMb: number; quotaMb: number } {
    const usedMb = Math.round(this.diskUsageBytes() / (1024 * 1024));
    return { over: usedMb > this.cfg.diskQuotaMb, usedMb, quotaMb: this.cfg.diskQuotaMb };
  }

  async restart(): Promise<void> {
    await this.exec(["rm", "-f", this.name], { timeoutMs: 60_000 });
    this.started = false;
    await this.start();
  }

  /** Kill whatever is running (interrupt). The container is recreated on the next command. */
  async kill(): Promise<void> {
    if (!this.started) return;
    await this.exec(["rm", "-f", this.name], { timeoutMs: 60_000 });
    await this.exec(["rm", "-f", `${this.name}-install`], { timeoutMs: 60_000 });
    this.started = false;
  }

  async close(): Promise<void> {
    await this.kill();
  }

  /** Readiness: docker reachable and the sandbox image present. */
  static async preflight(cfg: JobSandboxConfig, exec: DockerExecutor): Promise<string[]> {
    const errors: string[] = [];
    const v = await exec(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 30_000 });
    if (v.code !== 0) { errors.push(`Docker is not reachable from the runner (${(v.stderr || "docker version failed").slice(0, 200)})`); return errors; }
    const img = await exec(["image", "inspect", "--format", "{{.Id}}", cfg.image], { timeoutMs: 30_000 });
    if (img.code !== 0) errors.push(`Build sandbox image ${cfg.image} is not present (build runner/sandbox/Dockerfile)`);
    return errors;
  }
}

function dirBytes(dir: string, depth: number): number {
  if (depth > 40) return 0;
  let total = 0;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isDirectory()) total += dirBytes(p, depth + 1);
    else total += st.size;
  }
  return total;
}

/** Whether the project declares dependencies that need installing before checks can run. */
export function needsInstall(repo: string): boolean {
  const f = path.join(repo, "package.json");
  if (!existsSync(f)) return false;
  try {
    const pkg = JSON.parse(readFileSync(f, "utf8")) as { dependencies?: object; devDependencies?: object };
    const n = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
    return n > 0 && !existsSync(path.join(repo, "node_modules"));
  } catch { return false; }
}
