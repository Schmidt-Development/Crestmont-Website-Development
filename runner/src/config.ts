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
  /** Which agent runs the builds. "local" (default) = in-house tool-using agent against a self-hosted model. */
  agentProvider: AgentProviderId;
  /** RUNNER_ALLOW_PAID_PROVIDER: the paid Claude Agent SDK adapter refuses to start unless this is true. */
  allowPaidProvider: boolean;
  /** Agent SDK auth: ANTHROPIC_API_KEY (Claude Console key). Read ONLY when agentProvider is claude-agent-sdk. */
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
  /** Local (self-hosted) model settings for the local provider and AI drafts. */
  local: LocalModelConfig;
  /** Per-job container sandbox (local provider; every agent command, install, check and browser check runs here). */
  jobSandbox: JobSandboxConfig;
  /** Short platform AI drafts (ai_jobs) served by the local model between builds. */
  aiDrafts: { enabled: boolean; provider: "local" | "claude" };
  /** Local-only health endpoint port inside the runner container (0 = off). */
  healthPort: number;
  healthHost: string;
}

export type AgentProviderId = "local" | "claude-agent-sdk";

export interface LocalModelConfig {
  /** OpenAI-compatible base URL, e.g. Ollama: http://host.docker.internal:11434/v1 */
  baseUrl: string;
  model: string;
  /** Placeholder: Ollama ignores it but OpenAI-style clients send one. Never a paid key. */
  apiKey: string;
  /** The context window the model server was configured with (OLLAMA_CONTEXT_LENGTH / Modelfile num_ctx). */
  contextTokens: number;
  maxOutputTokensPerCall: number;
  /** Total generated tokens per job attempt (all phases). */
  maxOutputTokensTotal: number;
  temperature: number;
  requestTimeoutMs: number;
}

export interface JobSandboxConfig {
  dockerBin: string;
  image: string;
  /** Named Docker volume that holds RUNNER_WORKSPACES (runner in a container). Empty = bind-mount host paths. */
  volume: string;
  cpus: string;
  memory: string;
  pidsLimit: number;
  tmpfsMb: number;
  commandTimeoutMs: number;
  installTimeoutMs: number;
  /** Docker network whose only egress is the allow-listed registry proxy. */
  installNetwork: string;
  /** Registry proxy URL used by package installs, e.g. http://egress-proxy:3128 */
  installProxy: string;
  registry: string;
  diskQuotaMb: number;
  uid: number;
  /** Packages whose install scripts may run (npm rebuild, offline) after an --ignore-scripts install. */
  allowedBuildScripts: string[];
  browserCheck: boolean;
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
  const agentProvider: AgentProviderId = env.RUNNER_AGENT_PROVIDER === "claude-agent-sdk" ? "claude-agent-sdk" : "local";
  if (env.RUNNER_AGENT_PROVIDER && !["local", "claude-agent-sdk"].includes(env.RUNNER_AGENT_PROVIDER)) {
    throw new Error(`RUNNER_AGENT_PROVIDER must be "local" or "claude-agent-sdk" (got ${env.RUNNER_AGENT_PROVIDER})`);
  }
  const allowPaidProvider = env.RUNNER_ALLOW_PAID_PROVIDER === "true";
  // The Anthropic key is read only for the explicitly enabled paid adapter; the local default never touches it.
  const anthropicApiKey = agentProvider === "claude-agent-sdk" ? need("ANTHROPIC_API_KEY", readSecret(env, "ANTHROPIC_API_KEY")) : "";
  const localModel = env.LOCAL_MODEL ?? "";
  if (agentProvider === "local") need("LOCAL_MODEL", localModel);
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
    agentProvider,
    allowPaidProvider,
    local: {
      baseUrl: (env.LOCAL_MODEL_BASE_URL ?? "http://host.docker.internal:11434/v1").replace(/\/+$/, ""),
      model: localModel,
      apiKey: env.LOCAL_MODEL_API_KEY ?? "ollama",
      contextTokens: num(env.LOCAL_MODEL_CONTEXT_TOKENS, 32_768),
      maxOutputTokensPerCall: num(env.LOCAL_MODEL_MAX_OUTPUT_TOKENS, 8_192),
      maxOutputTokensTotal: num(env.RUNNER_LOCAL_MAX_OUTPUT_TOKENS, 2_000_000),
      temperature: env.LOCAL_MODEL_TEMPERATURE !== undefined && Number.isFinite(Number(env.LOCAL_MODEL_TEMPERATURE)) ? Number(env.LOCAL_MODEL_TEMPERATURE) : 0.2,
      requestTimeoutMs: num(env.LOCAL_MODEL_REQUEST_TIMEOUT_SECONDS, 900) * 1000,
    },
    jobSandbox: {
      dockerBin: env.RUNNER_DOCKER_BIN ?? "docker",
      image: env.RUNNER_SANDBOX_IMAGE ?? "crestmont-build-sandbox:1",
      volume: env.RUNNER_SANDBOX_VOLUME ?? "",
      cpus: env.RUNNER_JOB_CPUS ?? "2",
      memory: env.RUNNER_JOB_MEMORY ?? "4g",
      pidsLimit: num(env.RUNNER_JOB_PIDS, 512),
      tmpfsMb: num(env.RUNNER_JOB_TMPFS_MB, 512),
      commandTimeoutMs: num(env.RUNNER_JOB_COMMAND_TIMEOUT_SECONDS, 600) * 1000,
      installTimeoutMs: num(env.RUNNER_JOB_INSTALL_TIMEOUT_SECONDS, 900) * 1000,
      installNetwork: env.RUNNER_INSTALL_NETWORK ?? "crestmont_install",
      installProxy: env.RUNNER_INSTALL_PROXY ?? "http://egress-proxy:3128",
      registry: env.RUNNER_NPM_REGISTRY ?? "https://registry.npmjs.org/",
      diskQuotaMb: num(env.RUNNER_JOB_DISK_MB, 4096),
      uid: num(env.RUNNER_JOB_UID, 10001),
      allowedBuildScripts: list(env.RUNNER_ALLOWED_BUILD_SCRIPTS),
      browserCheck: env.RUNNER_BROWSER_CHECK !== "off",
    },
    aiDrafts: {
      // Default on with the local provider; the paid path needs BOTH explicit flags (and is not implemented here).
      enabled: env.RUNNER_SERVE_AI_DRAFTS !== undefined ? env.RUNNER_SERVE_AI_DRAFTS === "true" : agentProvider === "local",
      provider: env.RUNNER_AI_DRAFTS_PROVIDER === "claude" ? "claude" : "local",
    },
    healthPort: env.RUNNER_HEALTH_PORT ? num(env.RUNNER_HEALTH_PORT, 0) : 0,
    healthHost: env.RUNNER_HEALTH_HOST ?? "127.0.0.1",
  };
}

/** Variable names (never values) the owner report lists under "configuration". */
export function configuredVariableNames(cfg: RunnerConfig): string[] {
  const names = ["CONTROL_PLANE_URL", "BUILD_RUNNER_SECRET", "RUNNER_WORKSPACES", "SKILLS_SOURCE_DIR", "RUNNER_AGENT_PROVIDER"];
  if (cfg.agentProvider === "claude-agent-sdk") names.push("RUNNER_ALLOW_PAID_PROVIDER", "ANTHROPIC_API_KEY");
  else names.push("LOCAL_MODEL", "LOCAL_MODEL_BASE_URL", "RUNNER_SANDBOX_IMAGE");
  if (cfg.repo) names.push("PROJECT_REPO_OWNER", "PROJECT_REPO_TOKEN");
  if (cfg.preview) names.push("PREVIEW_DEPLOY_COMMAND", ...cfg.preview.envNames);
  return names;
}
