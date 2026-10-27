// Runner configuration from the environment. Secrets may be given directly or as <NAME>_FILE (a path), which keeps
// them out of the process environment block that other processes on the host could read.

import { readFileSync } from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { registerSecret } from "./log.ts";

export interface RunnerConfig {
  controlPlaneUrl: string;
  secret: string;
  runnerId: string;
  workspacesRoot: string;
  skillsSourceDir: string;
  skillsManifestPath: string;
  startersDir: string;
  /** Agent auth: ANTHROPIC_API_KEY (Claude Console key). */
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  /** PATH handed to the agent and to checks. */
  agentPath: string;
  /** Extra non-secret variables passed to the agent (names), e.g. PLAYWRIGHT_BROWSERS_PATH. */
  agentPassthrough: string[];
  allowedDomains: string[];
  fetchReferences: boolean;
  sandbox: "on" | "off";
  secretsDir: string;
  /** Local defense-in-depth caps; the server limits are authoritative and the stricter one wins. */
  localMaxTurns: number;
  localMaxBudgetUsd: number;
  localMaxRuntimeMinutes: number;
  heartbeatSecondsOverride: number | null;
  pollMinMs: number;
  pollMaxMs: number;
  checkTimeoutMs: number;
  maxCustomerFileBytes: number;
  repo: {
    owner: string;
    ownerType: "org" | "user";
    token: string;
    host: string;
    apiBase: string;
    prefix: string;
  } | null;
  preview: { command: string; envNames: string[]; timeoutMs: number } | null;
  platformRepoPatterns: RegExp[];
  gitAuthorName: string;
  gitAuthorEmail: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

type Env = Record<string, string | undefined>;

export function readSecret(env: Env, name: string): string {
  const direct = env[name];
  if (direct) return direct.trim();
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  return "";
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : d;
};
const list = (v: string | undefined, d: string[] = []) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);

export function loadConfig(env: Env = process.env, runnerDir = path.resolve(import.meta.dirname, "..")): RunnerConfig {
  const missing: string[] = [];
  const need = (name: string, value: string) => { if (!value) missing.push(name); return value; };

  const controlPlaneUrl = need("CONTROL_PLANE_URL", env.CONTROL_PLANE_URL ?? "");
  const secret = need("BUILD_RUNNER_SECRET", readSecret(env, "BUILD_RUNNER_SECRET"));
  const anthropicApiKey = need("ANTHROPIC_API_KEY", readSecret(env, "ANTHROPIC_API_KEY"));
  const workspacesRoot = need("RUNNER_WORKSPACES", env.RUNNER_WORKSPACES ?? "");
  const skillsSourceDir = need("SKILLS_SOURCE_DIR", env.SKILLS_SOURCE_DIR ?? "");
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(", ")}`);

  const repoToken = readSecret(env, "PROJECT_REPO_TOKEN");
  const repoOwner = env.PROJECT_REPO_OWNER ?? "";
  const repo = repoToken && repoOwner ? {
    owner: repoOwner,
    ownerType: (env.PROJECT_REPO_OWNER_TYPE === "user" ? "user" : "org") as "org" | "user",
    token: repoToken,
    host: env.PROJECT_REPO_HOST ?? "github.com",
    apiBase: env.PROJECT_REPO_API ?? "https://api.github.com",
    prefix: env.PROJECT_REPO_PREFIX ?? "crestmont-build-",
  } : null;

  const previewCommand = env.PREVIEW_DEPLOY_COMMAND ?? "";
  const preview = previewCommand ? {
    command: previewCommand,
    envNames: list(env.PREVIEW_DEPLOY_ENV),
    timeoutMs: num(env.PREVIEW_DEPLOY_TIMEOUT_SECONDS, 600) * 1000,
  } : null;

  for (const s of [secret, anthropicApiKey, repoToken]) registerSecret(s);
  for (const n of preview?.envNames ?? []) registerSecret(readSecret(env, n));

  return {
    controlPlaneUrl,
    secret,
    runnerId: (env.RUNNER_ID ?? `runner-${hostname()}`).slice(0, 64),
    workspacesRoot: path.resolve(workspacesRoot),
    skillsSourceDir: path.resolve(skillsSourceDir),
    skillsManifestPath: env.SKILLS_MANIFEST ?? path.join(runnerDir, "skills", "manifest.json"),
    startersDir: env.STARTERS_DIR ?? path.join(runnerDir, "starters"),
    anthropicApiKey,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL ?? "",
    agentPath: env.RUNNER_AGENT_PATH ?? env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    agentPassthrough: list(env.RUNNER_AGENT_PASSTHROUGH, ["PLAYWRIGHT_BROWSERS_PATH", "NODE_PATH", "LANG", "TZ"]),
    allowedDomains: list(env.RUNNER_ALLOWED_DOMAINS, ["registry.npmjs.org"]),
    fetchReferences: env.RUNNER_FETCH_REFERENCES === "1",
    sandbox: env.RUNNER_SANDBOX === "off" ? "off" : "on",
    secretsDir: env.RUNNER_SECRETS_DIR ?? "/run/secrets",
    localMaxTurns: num(env.RUNNER_MAX_TURNS, 300),
    localMaxBudgetUsd: num(env.RUNNER_MAX_BUDGET_USD, 50),
    localMaxRuntimeMinutes: num(env.RUNNER_MAX_RUNTIME_MINUTES, 180),
    heartbeatSecondsOverride: env.RUNNER_HEARTBEAT_SECONDS ? num(env.RUNNER_HEARTBEAT_SECONDS, 30) : null,
    pollMinMs: num(env.RUNNER_POLL_MIN_SECONDS, 15) * 1000,
    pollMaxMs: num(env.RUNNER_POLL_MAX_SECONDS, 300) * 1000,
    checkTimeoutMs: num(env.RUNNER_CHECK_TIMEOUT_SECONDS, 300) * 1000,
    maxCustomerFileBytes: num(env.RUNNER_MAX_CUSTOMER_FILE_MB, 25) * 1024 * 1024,
    repo,
    preview,
    platformRepoPatterns: list(env.CRESTMONT_PLATFORM_REPO_PATTERNS, ["Crestmont-Website-Development", "crestmont-platform"])
      .map((p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")),
    gitAuthorName: env.RUNNER_GIT_NAME ?? "Crestmont AI Builds",
    gitAuthorEmail: env.RUNNER_GIT_EMAIL ?? "ai-builds@users.noreply.github.com",
    logLevel: (["debug", "info", "warn", "error"].includes(env.LOG_LEVEL ?? "") ? env.LOG_LEVEL : "info") as RunnerConfig["logLevel"],
  };
}

/** Variable names (never values) the owner report lists under "configuration". */
export function configuredVariableNames(cfg: RunnerConfig): string[] {
  const names = ["CONTROL_PLANE_URL", "BUILD_RUNNER_SECRET", "ANTHROPIC_API_KEY", "RUNNER_WORKSPACES", "SKILLS_SOURCE_DIR"];
  if (cfg.repo) names.push("PROJECT_REPO_OWNER", "PROJECT_REPO_TOKEN");
  if (cfg.preview) names.push("PREVIEW_DEPLOY_COMMAND", ...cfg.preview.envNames);
  return names;
}
