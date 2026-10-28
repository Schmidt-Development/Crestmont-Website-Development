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

import { lstatSync, readdirSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run, trustedBinary } from "./exec.ts";
import type { ExecResult } from "./exec.ts";
import type { JobSandboxConfig } from "./config.ts";
import type { Workspace } from "./workspace.ts";
import type { Logger } from "./log.ts";
import { silentLogger } from "./log.ts";

/** Runs the docker CLI. Injected so tests can record the exact flags without a Docker daemon. */
export type DockerExecutor = (args: string[], opts: { timeoutMs: number }) => Promise<ExecResult>;

export function cliDockerExecutor(dockerBin: string, env: Record<string, string>): DockerExecutor {
  const docker = trustedBinary("docker", dockerBin);
  return (args, opts) => run(docker, args, { env, timeoutMs: opts.timeoutMs, maxOutput: 4 * 1024 * 1024 });
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

/** What `docker inspect` says about one build container, checked against the hardening the runner asked for. */
export interface IsolationRecord {
  container: string;
  at: string;
  ok: boolean;
  findings: string[];
  /** The facts the verdict is based on (subset of `docker inspect`), kept as evidence after the container is gone. */
  facts: Record<string, unknown>;
}

interface InspectShape {
  Config?: { User?: string; Image?: string; Labels?: Record<string, string> };
  HostConfig?: {
    NetworkMode?: string; ReadonlyRootfs?: boolean; CapDrop?: string[] | null; CapAdd?: string[] | null; SecurityOpt?: string[] | null;
    Privileged?: boolean; Memory?: number; NanoCpus?: number; PidsLimit?: number | null; PortBindings?: Record<string, unknown> | null;
    Binds?: string[] | null; Devices?: unknown[] | null; IpcMode?: string; PidMode?: string; UsernsMode?: string;
  };
  Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean }[];
}

/**
 * Pure verdict on a container's real configuration (as Docker applied it, not as the runner requested it): a Docker
 * Desktop version that silently ignored a flag would show up here.
 */
export function evaluateIsolation(inspect: unknown, expect: { uid: number; network: string }): { ok: boolean; findings: string[]; facts: Record<string, unknown> } {
  const i = (Array.isArray(inspect) ? inspect[0] : inspect) as InspectShape | undefined;
  const h = i?.HostConfig ?? {};
  const findings: string[] = [];
  const lower = (a: string[] | null | undefined) => (a ?? []).map((x) => String(x).toLowerCase());
  if (!i || !i.HostConfig) return { ok: false, findings: ["docker inspect returned no HostConfig"], facts: {} };
  if (h.NetworkMode !== expect.network) findings.push(`network is ${String(h.NetworkMode)}, expected ${expect.network}`);
  if (h.ReadonlyRootfs !== true) findings.push("root filesystem is writable");
  if (!lower(h.CapDrop).includes("all")) findings.push("capabilities not dropped (CapDrop lacks ALL)");
  if (lower(h.CapAdd).length) findings.push(`capabilities added: ${lower(h.CapAdd).join(", ")}`);
  if (!lower(h.SecurityOpt).some((o) => o === "no-new-privileges" || o === "no-new-privileges:true")) findings.push("no-new-privileges not set");
  if (h.Privileged) findings.push("container is privileged");
  if (h.PidMode === "host" || h.IpcMode === "host" || h.UsernsMode === "host") findings.push("shares a host namespace (pid/ipc/userns)");
  if ((h.Devices ?? []).length) findings.push("host devices are attached");
  if (i.Config?.User !== `${expect.uid}:${expect.uid}`) findings.push(`runs as user ${String(i.Config?.User || "root")}, expected ${expect.uid}:${expect.uid}`);
  if (!(Number(h.Memory) > 0)) findings.push("no memory limit");
  if (!(Number(h.NanoCpus) > 0)) findings.push("no CPU limit");
  if (!(Number(h.PidsLimit) > 0)) findings.push("no process limit");
  if (h.PortBindings && Object.keys(h.PortBindings).length) findings.push("ports are published");
  const mounts = i.Mounts ?? [];
  const dests = mounts.map((m) => m.Destination).sort();
  if (JSON.stringify(dests) !== JSON.stringify([CONTAINER_HOME, CONTAINER_REPO].sort())) findings.push(`mounts are ${dests.join(", ") || "none"}, expected only ${CONTAINER_REPO} and ${CONTAINER_HOME}`);
  if (mounts.some((m) => /docker\.sock/.test(String(m.Source ?? ""))) || (h.Binds ?? []).some((b) => /docker\.sock/.test(b))) findings.push("the Docker socket is mounted");
  const facts = {
    image: i.Config?.Image ?? null, user: i.Config?.User ?? null, labels: i.Config?.Labels ?? {},
    networkMode: h.NetworkMode ?? null, readonlyRootfs: h.ReadonlyRootfs ?? null, capDrop: h.CapDrop ?? null, capAdd: h.CapAdd ?? null,
    securityOpt: h.SecurityOpt ?? null, privileged: h.Privileged ?? null, memoryBytes: h.Memory ?? null, nanoCpus: h.NanoCpus ?? null,
    pidsLimit: h.PidsLimit ?? null, portBindings: h.PortBindings ?? null,
    mounts: mounts.map((m) => ({ type: m.Type ?? null, destination: m.Destination ?? null, rw: m.RW ?? null })),
  };
  return { ok: findings.length === 0, findings, facts };
}

export class JobSandbox {
  readonly name: string;
  readonly cfg: JobSandboxConfig;
  readonly ws: Workspace;
  readonly jobId: string;
  private readonly exec: DockerExecutor;
  private readonly log: Logger;
  private started = false;
  /** One record per container this job started (restarts included). Also written to <job dir>/evidence/. */
  readonly isolation: IsolationRecord[] = [];

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
    await this.recordIsolation();
  }

  /**
   * Isolation evidence: `docker inspect` of the container just started, judged by evaluateIsolation, written to the
   * job's own directory (outside the repository the agent sees) so it survives the container's removal at job end
   * (Collect-Evidence.ps1 copies it) and summarized in the owner report as check:sandbox-isolation.
   */
  async recordIsolation(): Promise<IsolationRecord> {
    const at = new Date().toISOString();
    const r = await this.exec(["inspect", "--type", "container", "--format", "{{json .}}", this.name], { timeoutMs: 30_000 });
    let parsed: unknown = null;
    try { parsed = r.code === 0 ? JSON.parse(r.stdout) : null; } catch { parsed = null; }
    const verdict = parsed ? evaluateIsolation(parsed, { uid: this.cfg.uid, network: "none" }) : { ok: false, findings: [`docker inspect failed (exit ${r.code})`], facts: {} };
    const rec: IsolationRecord = { container: this.name, at, ok: verdict.ok, findings: verdict.findings, facts: verdict.facts };
    this.isolation.push(rec);
    try {
      const dir = path.join(this.ws.dir, "evidence");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `sandbox-isolation-${String(this.isolation.length).padStart(2, "0")}.json`), JSON.stringify({ schema: "crestmont.sandbox-isolation/1", job: this.jobId, ...rec }, null, 2) + "\n");
    } catch (err) { this.log.warn("could not write isolation evidence", { error: String(err) }); }
    if (!rec.ok) this.log.warn("sandbox isolation check failed", { container: this.name, findings: rec.findings });
    return rec;
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
