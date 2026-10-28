// Isolated per-attempt workspaces, the platform-checkout refusal, the agent's .claude/settings.json and the
// allowlisted agent environment.

import { mkdirSync, existsSync, writeFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { run, baseEnv } from "./exec.ts";
import { resolveWithin } from "./paths.ts";
import type { RunnerConfig } from "./config.ts";
import type { Job } from "./protocol.ts";

export class IsolationError extends Error {
  constructor(message: string) { super(message); this.name = "IsolationError"; }
}

export interface Workspace {
  /** <RUNNER_WORKSPACES>/<ref> */
  dir: string;
  /** Stable name reported as workspaceRef. */
  ref: string;
  /** The job's private HOME (Claude Code config + session transcripts live under home/.claude). */
  home: string;
  /** Agent cwd and the project's git repository. */
  repo: string;
  tmp: string;
  checkpoints: string;
}

function nearestExisting(p: string): string {
  let cur = path.resolve(p);
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

async function gitTopLevel(dir: string, pathEnv: string): Promise<string | null> {
  const r = await run("git", ["-C", nearestExisting(dir), "rev-parse", "--show-toplevel"], { env: baseEnv(pathEnv, "/nonexistent"), timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Refuses to run when the runner's cwd or the workspace root sits inside a Crestmont platform checkout, and refuses a
 * workspace root inside ANY git work tree (a job repository nested in another repository would inherit its config,
 * hooks and skill discovery). Called at startup and again before each job.
 */
export async function assertIsolation(opts: { cwd: string; workspacesRoot: string; platformRepoPatterns: RegExp[]; pathEnv: string }): Promise<void> {
  for (const [label, dir] of [["runner working directory", opts.cwd], ["workspace root", opts.workspacesRoot]] as const) {
    const top = await gitTopLevel(dir, opts.pathEnv);
    if (!top) continue;
    const remotes = await run("git", ["-C", top, "remote", "-v"], { env: baseEnv(opts.pathEnv, "/nonexistent"), timeoutMs: 10_000 });
    const isPlatform = opts.platformRepoPatterns.some((re) => re.test(remotes.stdout)) || existsSync(path.join(top, "docs", "ai-builds", "RUNNER-PROTOCOL.md"));
    if (isPlatform) throw new IsolationError(`Refusing to start: the ${label} (${dir}) is inside a Crestmont platform checkout (${top}). Run the runner from its own directory with RUNNER_WORKSPACES outside any repository.`);
    if (label === "workspace root") throw new IsolationError(`Refusing to start: the workspace root (${dir}) is inside a git repository (${top}). Choose a RUNNER_WORKSPACES directory outside any repository.`);
  }
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);

export function createWorkspace(root: string, job: Pick<Job, "id" | "attempt">): Workspace {
  if (!path.isAbsolute(root)) throw new IsolationError(`workspace root must be an absolute path: ${String(root).slice(0, 200)}`);
  // job.id and job.attempt arrive from the control plane: both are reduced to plain segment text before use.
  const attempt = Number(job.attempt);
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt > 100_000) throw new IsolationError(`invalid job attempt ${String(job.attempt).slice(0, 40)}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const ref = `${safe(String(job.id))}-a${attempt}-${randomBytes(3).toString("hex")}`;
  const dir = resolveWithin(root, ref);
  const ws: Workspace = {
    dir, ref,
    home: path.join(dir, "home"),
    repo: path.join(dir, "repo"),
    tmp: path.join(dir, "tmp"),
    checkpoints: path.join(dir, "checkpoints"),
  };
  for (const d of [dir, ws.home, ws.repo, ws.tmp, ws.checkpoints]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return ws;
}

/** Resolve a workspaceRef from a claim to an existing workspace on this host, refusing path tricks. */
export function findLocalWorkspace(root: string, ref: string | null | undefined): Workspace | null {
  if (!ref || !/^[A-Za-z0-9_-]{1,120}$/.test(ref)) return null;
  let dir: string;
  // A symlink planted under the root must not redirect a resumed job to another directory.
  try { dir = resolveWithin(root, ref); if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !statSync(dir).isDirectory()) return null; } catch { return null; }
  return { dir, ref, home: path.join(dir, "home"), repo: path.join(dir, "repo"), tmp: path.join(dir, "tmp"), checkpoints: path.join(dir, "checkpoints") };
}

export function latestCheckpointFile(ws: Workspace): string | null {
  if (!existsSync(ws.checkpoints)) return null;
  const files = readdirSync(ws.checkpoints).filter((f) => /^ckpt-\d+\.tgz$/.test(f))
    .sort((a, b) => Number(a.slice(5, -4)) - Number(b.slice(5, -4)));
  return files.length ? path.join(ws.checkpoints, files[files.length - 1]) : null;
}

// ── Agent permissions ──

/** Network and repository-control commands the agent may never run (the runner pushes and deploys itself). */
export const DENIED_BASH = [
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "socat",
  "sudo", "su", "printenv", "env", "gh",
  "git push", "git remote", "git config", "git credential", "git filter-branch", "git update-ref", "git submodule",
  "wrangler deploy", "wrangler publish", "wrangler secret", "wrangler login", "wrangler d1", "wrangler kv", "wrangler r2",
  "npx wrangler deploy", "npx wrangler publish", "npx wrangler secret", "npx wrangler login",
  "npm publish", "npm login", "npm adduser", "npm token", "npm config",
];

export interface AgentPermissionInput {
  repo: string;
  secretsDir: string;
  allowedDomains: string[];
  referenceDomains: string[];
  fetchReferences: boolean;
  sandbox: "on" | "off";
  /** Directories the agent must never read or write, e.g. the worker's own Claude Code config dir (OAuth login). */
  privateDirs?: string[];
}

export function agentPermissions(p: AgentPermissionInput): { allow: string[]; deny: string[] } {
  const allow = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "Skill", "TodoWrite"];
  if (p.fetchReferences) for (const d of p.referenceDomains) allow.push(`WebFetch(domain:${d})`);
  const deny = [
    "WebSearch",
    ...(p.fetchReferences ? [] : ["WebFetch"]),
    ...DENIED_BASH.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]),
    // .git internals and the runner-provisioned configuration are off limits.
    "Edit(.git/**)", "Read(.git/config)", "Edit(.claude/**)", "Edit(.gitmodules)",
    // Anything outside the workspace: host secrets, other processes' environments, the runner's home.
    `Read(/${p.secretsDir}/**)`, `Edit(/${p.secretsDir}/**)`, "Read(//proc/**)", "Read(//etc/**)", "Read(//root/**)",
    "Read(//var/run/**)", "Read(//run/**)",
    ...(p.privateDirs ?? []).flatMap((d) => [`Read(/${d}/**)`, `Edit(/${d}/**)`]),
  ];
  return { allow, deny };
}

/** .claude/settings.json written into the workspace; loaded through settingSources: ["project"]. */
export function claudeSettings(p: AgentPermissionInput): Record<string, unknown> {
  const { allow, deny } = agentPermissions(p);
  const settings: Record<string, unknown> = {
    permissions: {
      defaultMode: "dontAsk",
      allow,
      deny,
      blockReadsOutsideWorkingDirectories: true,
      disableBypassPermissionsMode: "disable",
    },
  };
  if (p.sandbox === "on") {
    settings.sandbox = {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: [...p.allowedDomains] },
      filesystem: { allowWrite: ["~/.npm", "~/.cache"], denyRead: [p.secretsDir, ...(p.privateDirs ?? [])] },
    };
  }
  return settings;
}

export function writeAgentConfig(ws: Workspace, p: Omit<AgentPermissionInput, "repo">): Record<string, unknown> {
  const settings = claudeSettings({ ...p, repo: ws.repo });
  mkdirSync(path.join(ws.repo, ".claude"), { recursive: true });
  writeFileSync(path.join(ws.repo, ".claude", "settings.json"), JSON.stringify(settings, null, 2) + "\n");
  return settings;
}

// ── Agent environment ──

/** Name patterns that must never reach the agent (checked after the allowlist as a second guard). */
export const FORBIDDEN_ENV = /(RUNNER_SECRET|BUILD_RUNNER|STRIPE|CLOUDFLARE|CF_API|WRANGLER|GITHUB|GH_TOKEN|PROJECT_REPO|PREVIEW_|PRODUCTION_|SITE_DEPLOY|DATABASE|D1_|SESSION_SECRET|PAYMENT|PASSWORD|AWS_|PRIVATE_KEY|CONTROL_PLANE)/i;

export function buildAgentEnv(cfg: Pick<RunnerConfig, "agentPath" | "anthropicApiKey" | "anthropicBaseUrl" | "agentPassthrough">, ws: Workspace, source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {
    PATH: cfg.agentPath,
    HOME: ws.home,
    CLAUDE_CONFIG_DIR: path.join(ws.home, ".claude"),
    TMPDIR: ws.tmp,
    LANG: "C.UTF-8",
    CI: "1",
    NPM_CONFIG_CACHE: path.join(ws.home, ".npm"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_FUND: "false",
    GIT_TERMINAL_PROMPT: "0",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Auto memory loads regardless of settingSources (https://code.claude.com/docs/en/agent-sdk/hosting#multi-tenant-isolation).
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "crestmont-ai-builds-runner",
    ANTHROPIC_API_KEY: cfg.anthropicApiKey,
  };
  if (cfg.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = cfg.anthropicBaseUrl;
  for (const name of cfg.agentPassthrough) {
    const v = source[name];
    if (v !== undefined && !(name in env) && !FORBIDDEN_ENV.test(name)) env[name] = v;
  }
  for (const k of Object.keys(env)) {
    if (FORBIDDEN_ENV.test(k)) throw new Error(`Refusing to start the agent: forbidden variable ${k} in its environment`);
  }
  return env;
}

/** Environment for runner-run checks (npm run check etc.): the agent env without the Anthropic credential. */
export function buildCheckEnv(agentEnv: Record<string, string>): Record<string, string> {
  const env = { ...agentEnv };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  return env;
}
