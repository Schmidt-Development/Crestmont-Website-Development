// Runner configuration from the environment. Secrets may be given directly or as <NAME>_FILE (a path), which keeps
// them out of the process environment block that other processes on the host could read.

import { readFileSync } from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { registerSecret } from "./log.ts";
import { trustedBinary } from "./exec.ts";
import { parseOperatorCommand } from "./operator-command.ts";

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
  /**
   * Preview deploy. `gateSecret` (PREVIEW_GATE_SECRET, ≥32 characters, the same value as the platform's) signs the
   * private-preview gate (Founder decision D3); without it the runner refuses to deploy any preview.
   */
  preview: { command: string; envNames: string[]; timeoutMs: number; gateSecret: string } | null;
  /**
   * Customer production delivery (Founder decision D5): PRODUCTION_DEPLOY_COMMAND deploys an Owner-authorized release
   * with the customer-hosting account's credentials (PRODUCTION_DEPLOY_ENV), which must be different variables and
   * values from the preview credentials. Unset = this runner never deploys a customer site.
   */
  delivery: { command: string; envNames: string[]; timeoutMs: number; verifyAttempts: number; verifyDelayMs: number } | null;
  /**
   * Founder V4 (local dual-model). `worker`: the GPU worker this runner serves (BUILD_WORKER_ID + BUILD_WORKER_KEY[_FILE]);
   * `models`: Model A (architect, reviewer, hard repairs) and Model B (builder) on the shared model server; `inference`:
   * the GPU scheduler; `slots`: website builds this runner works on at once; `advisor`: who writes the specification
   * and who reviews each cycle (Model A in a fresh read-only session, or the rule-based reviewer).
   */
  worker: { id: string; key: string } | null;
  models: { a: ModelProfile; b: ModelProfile; mode: "dual" | "single" };
  inference: InferenceConfig;
  slots: number;
  routing: { escalateAfterRepeats: number };
  advisor: { architect: "local" | "none"; reviewer: "local" | "deterministic"; maxTurns: number; maxCycles: number };
  /**
   * Preview deletion: PREVIEW_DELETE=cloudflare-api (built in: DELETE /accounts/{CLOUDFLARE_ACCOUNT_ID}/workers/scripts/{name}
   * with CLOUDFLARE_API_TOKEN, through the runner's proxy), or PREVIEW_DELETE_COMMAND (a shell command given
   * $CRESTMONT_PREVIEW_NAME and the PREVIEW_DEPLOY_ENV credentials). Unset = previews are never deleted by the runner.
   */
  previewDelete: { mode: "cloudflare-api" | "command"; command: string; timeoutMs: number } | null;
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

/** One model on the shared model server (Ollama tag), with its role and what the Founder configured for it. */
export interface ModelProfile {
  tag: string;
  role: "architect_reviewer" | "builder" | "single";
  contextTokens: number;
  /** Configured memory estimate in MB (0 = unknown); replaced by the measured value while the model is loaded. */
  vramMb: number;
  quantization: string | null;
  /** reasoning_effort sent with requests (Qwen thinking models); null = not configured, the client sends "none". */
  reasoning: "high" | "medium" | "low" | "none" | null;
  /** The model accepts images (the reviewer then receives the screenshots themselves). */
  vision: boolean;
  license: string | null;
}

export interface InferenceConfig {
  /** Concurrent generation requests on the GPU (match OLLAMA_NUM_PARALLEL; set from the concurrency benchmark). */
  maxConcurrent: number;
  /** GPU memory in MB (GPU_VRAM_TOTAL_MB from the installer's hardware check; 0 = unknown → one model resident). */
  vramTotalMb: number;
  /** Memory kept free for KV cache, runtime and context processing; never allocated to model weights. */
  vramReserveMb: number;
  switchTimeoutMs: number;
  /** How long a request for the non-resident model may wait before the scheduler drains and switches. */
  maxWaitBeforeSwitchMs: number;
  keepAlive: string;
  /** JSON file written by the host's GPU sampler (nvidia-smi); absent = GPU telemetry "not reported". */
  telemetryFile: string;
}

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
    throw new Error(`RUNNER_AGENT_PROVIDER must be "local" or "claude-agent-sdk" (got ${env.RUNNER_AGENT_PROVIDER}); the V3 Claude subscription worker was removed (Founder directive V4)`);
  }
  const allowPaidProvider = env.RUNNER_ALLOW_PAID_PROVIDER === "true";
  // The Anthropic key is read only for the explicitly enabled paid adapter; the local default never touches it.
  const anthropicApiKey = agentProvider === "claude-agent-sdk" ? need("ANTHROPIC_API_KEY", readSecret(env, "ANTHROPIC_API_KEY")) : "";
  // V4: LOCAL_MODEL_A (architect/reviewer) and LOCAL_MODEL_B (builder); LOCAL_MODEL alone = one model for both roles.
  const localModel = env.LOCAL_MODEL_B || env.LOCAL_MODEL || "";
  if (agentProvider === "local" && !localModel) missing.push("LOCAL_MODEL_B (or LOCAL_MODEL)");
  const workspacesRoot = need("RUNNER_WORKSPACES", env.RUNNER_WORKSPACES ?? "");
  const skillsSourceDir = need("SKILLS_SOURCE_DIR", env.SKILLS_SOURCE_DIR ?? "");
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  // Every job workspace, export and checkpoint path is built under this root and confined to it.
  if (!path.isAbsolute(workspacesRoot) || workspacesRoot.includes("\0") || workspacesRoot.split(/[\\/]/).includes("..")) {
    throw new Error(`RUNNER_WORKSPACES must be an absolute path without ".." (got ${workspacesRoot.slice(0, 200)})`);
  }

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
    gateSecret: readSecret(env, "PREVIEW_GATE_SECRET"),
  } : null;
  // Operator commands run without a shell: parse them now so an unsupported setting stops the runner at startup.
  if (preview) parseOperatorCommand("preview-deploy", preview.command, preview.envNames);

  if (env.PREVIEW_DELETE && env.PREVIEW_DELETE !== "cloudflare-api") throw new Error(`PREVIEW_DELETE must be "cloudflare-api" (got ${env.PREVIEW_DELETE}); for a custom command use PREVIEW_DELETE_COMMAND`);
  const previewDeleteCommand = env.PREVIEW_DELETE_COMMAND ?? "";
  const previewDeleteTimeout = num(env.PREVIEW_DELETE_TIMEOUT_SECONDS, 180) * 1000;
  const previewDelete = env.PREVIEW_DELETE === "cloudflare-api" ? { mode: "cloudflare-api" as const, command: "", timeoutMs: previewDeleteTimeout }
    : previewDeleteCommand ? { mode: "command" as const, command: previewDeleteCommand, timeoutMs: previewDeleteTimeout } : null;
  if (previewDelete?.mode === "command") parseOperatorCommand("preview-delete", previewDelete.command, preview?.envNames ?? []);
  if (previewDelete?.mode === "cloudflare-api") for (const n of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) registerSecret(readSecret(env, n));

  for (const s of [secret, anthropicApiKey, repoToken]) registerSecret(s);
  for (const n of preview?.envNames ?? []) registerSecret(readSecret(env, n));
  registerSecret(preview?.gateSecret ?? "");

  const deliveryCommand = env.PRODUCTION_DEPLOY_COMMAND ?? "";
  const delivery = deliveryCommand ? {
    command: deliveryCommand,
    envNames: list(env.PRODUCTION_DEPLOY_ENV),
    timeoutMs: num(env.PRODUCTION_DEPLOY_TIMEOUT_SECONDS, 600) * 1000,
    verifyAttempts: Math.max(1, Math.min(20, num(env.PRODUCTION_VERIFY_ATTEMPTS, 6))),
    verifyDelayMs: num(env.PRODUCTION_VERIFY_DELAY_SECONDS, 10) * 1000,
  } : null;
  if (delivery) {
    parseOperatorCommand("production-deploy", delivery.command, delivery.envNames);
    if (!repo) throw new Error("PRODUCTION_DEPLOY_COMMAND needs the project repositories (PROJECT_REPO_*): releases are deployed from the versioned project repository");
    const shared = delivery.envNames.filter((n) => (preview?.envNames ?? []).includes(n));
    if (shared.length) throw new Error(`PRODUCTION_DEPLOY_ENV must not reuse the preview credentials (${shared.join(", ")}); use separate variables for the customer-hosting account`);
    const previewValues = new Set((preview?.envNames ?? []).map((n) => readSecret(env, n)).filter(Boolean));
    for (const n of delivery.envNames) {
      const v = readSecret(env, n);
      if (v && previewValues.has(v)) throw new Error(`PRODUCTION_DEPLOY_ENV ${n} has the same value as a preview credential; production and preview must use different accounts or tokens`);
      registerSecret(v);
    }
  }

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
    previewDelete,
    delivery,
    worker: (() => {
      const id = env.BUILD_WORKER_ID ?? "";
      if (!id) return null;
      const key = readSecret(env, "BUILD_WORKER_KEY");
      if (!/^wkr_[A-Za-z0-9]+$/.test(id) || !/^[0-9a-f]{64}$/.test(key)) throw new Error("BUILD_WORKER_ID / BUILD_WORKER_KEY(_FILE) are set but invalid (copy them from Owner → AI builds → GPU workers)");
      registerSecret(key);
      return { id, key };
    })(),
    models: loadModels(env, localModel),
    inference: {
      maxConcurrent: Math.max(1, Math.min(16, num(env.INFERENCE_MAX_CONCURRENT, 1))),
      vramTotalMb: num(env.GPU_VRAM_TOTAL_MB, 0),
      vramReserveMb: num(env.GPU_VRAM_RESERVE_MB, 4096),
      switchTimeoutMs: num(env.MODEL_SWITCH_TIMEOUT_SECONDS, 300) * 1000,
      maxWaitBeforeSwitchMs: num(env.MODEL_SWITCH_MAX_WAIT_SECONDS, 180) * 1000,
      keepAlive: /^\d+[smh]$|^-1$/.test(env.MODEL_KEEP_ALIVE ?? "") ? env.MODEL_KEEP_ALIVE! : "30m",
      telemetryFile: env.GPU_TELEMETRY_FILE ?? "/run/crestmont/gpu.json",
    },
    slots: Math.max(1, Math.min(16, Math.floor(num(env.RUNNER_SLOTS, 1)))),
    routing: { escalateAfterRepeats: Math.max(1, Math.min(10, Math.floor(num(env.ROUTER_ESCALATE_AFTER_REPEATS, 2)))) },
    advisor: (() => {
      const local = agentProvider === "local";
      const a = env.ORCHESTRATOR_ARCHITECT ?? (local ? "local" : "none"), r = env.ORCHESTRATOR_REVIEWER ?? (local ? "local" : "deterministic");
      if (!["local", "none"].includes(a)) throw new Error("ORCHESTRATOR_ARCHITECT must be local or none");
      if (!["local", "deterministic"].includes(r)) throw new Error("ORCHESTRATOR_REVIEWER must be local or deterministic");
      if ((a === "local" || r === "local") && !local) throw new Error("A local Model A architect/reviewer needs RUNNER_AGENT_PROVIDER=local");
      return { architect: a as "local" | "none", reviewer: r as "local" | "deterministic",
        maxTurns: Math.max(5, Math.min(200, num(env.ORCHESTRATOR_ADVISOR_MAX_TURNS, 40))), maxCycles: Math.max(1, Math.min(50, num(env.ORCHESTRATOR_MAX_CYCLES, 8))) };
    })(),
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
      dockerBin: trustedBinary("docker", env.RUNNER_DOCKER_BIN ?? "docker").path,
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

const REASONING = ["high", "medium", "low", "none"] as const;

/** Model A / Model B from LOCAL_MODEL_A / LOCAL_MODEL_B (dual) or LOCAL_MODEL for both roles (single). */
export function loadModels(env: Env, builderTag: string): RunnerConfig["models"] {
  const baseCtx = num(env.LOCAL_MODEL_CONTEXT_TOKENS, 32_768);
  const profile = (prefix: "A" | "B", tag: string, role: ModelProfile["role"]): ModelProfile => {
    const r = env[`LOCAL_MODEL_${prefix}_REASONING`] ?? "";
    if (r && !(REASONING as readonly string[]).includes(r)) throw new Error(`LOCAL_MODEL_${prefix}_REASONING must be high, medium, low or none`);
    return {
      tag, role, contextTokens: num(env[`LOCAL_MODEL_${prefix}_CONTEXT_TOKENS`], baseCtx), vramMb: num(env[`LOCAL_MODEL_${prefix}_VRAM_MB`], 0),
      quantization: (env[`LOCAL_MODEL_${prefix}_QUANT`] ?? (/(q\d_k_[ms]|q8_0|q4_0|bf16|fp16)/i.exec(tag)?.[1]?.toUpperCase() ?? null)) || null,
      reasoning: (r || null) as ModelProfile["reasoning"], vision: env[`LOCAL_MODEL_${prefix}_VISION`] === "true", license: env[`LOCAL_MODEL_${prefix}_LICENSE`] || null,
    };
  };
  const aTag = env.LOCAL_MODEL_A ?? "";
  if (!aTag || aTag === builderTag) {
    const single = profile("B", builderTag, "single");
    return { a: single, b: single, mode: "single" };
  }
  return { a: profile("A", aTag, "architect_reviewer"), b: profile("B", builderTag, "builder"), mode: "dual" };
}

/** Variable names (never values) the owner report lists under "configuration". */
export function configuredVariableNames(cfg: RunnerConfig): string[] {
  const names = ["CONTROL_PLANE_URL", "BUILD_RUNNER_SECRET", "RUNNER_WORKSPACES", "SKILLS_SOURCE_DIR", "RUNNER_AGENT_PROVIDER"];
  if (cfg.agentProvider === "claude-agent-sdk") names.push("RUNNER_ALLOW_PAID_PROVIDER", "ANTHROPIC_API_KEY");
  else names.push(...(cfg.models.mode === "dual" ? ["LOCAL_MODEL_A", "LOCAL_MODEL_B"] : ["LOCAL_MODEL"]), "LOCAL_MODEL_BASE_URL", "RUNNER_SANDBOX_IMAGE");
  if (cfg.repo) names.push("PROJECT_REPO_OWNER", "PROJECT_REPO_TOKEN");
  if (cfg.preview) names.push("PREVIEW_DEPLOY_COMMAND", ...cfg.preview.envNames);
  if (cfg.previewDelete) names.push(cfg.previewDelete.mode === "cloudflare-api" ? "PREVIEW_DELETE" : "PREVIEW_DELETE_COMMAND");
  return names;
}
