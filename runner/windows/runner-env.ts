// runner.env / runner.local.env handling for Install-CrestmontRunner.ps1. RunnerEnv.ps1 implements the same functions
// for the installer; runner/test/runner-env.test.ts compares the two wherever pwsh is available (CI windows-scripts
// and the Windows PowerShell 5.1 workflow). Pure functions: no file access.
//
//   runner.env        written by the installer on every run (managed keys only). Never edit it by hand.
//   runner.local.env  the Founder's own settings (project repositories, previews, extra tuning). Created once with
//                     commented examples, never overwritten. Compose loads it FIRST and runner.env second, so a managed
//                     value always wins even if someone adds it to the local file by hand.
//
// A re-run never loses a setting: keys found in an existing runner.env that the installer does not manage are moved
// into runner.local.env (unless that file already sets them), and the installer keeps a timestamped backup of the old
// runner.env. Reserved keys in runner.local.env (managed ones, and ones that would weaken the sandbox or enable a
// paid provider) are reported as conflicts; the installer stops on them.

/** Keys the installer writes to runner.env, in this order. */
export const MANAGED_RUNNER_ENV_KEYS = [
  "CONTROL_PLANE_URL", "BUILD_RUNNER_SECRET_FILE", "RUNNER_ID", "RUNNER_AGENT_PROVIDER", "RUNNER_ALLOW_PAID_PROVIDER",
  "LOCAL_MODEL", "LOCAL_MODEL_BASE_URL", "LOCAL_MODEL_CONTEXT_TOKENS", "RUNNER_SANDBOX_IMAGE", "RUNNER_JOB_CPUS",
  "RUNNER_JOB_MEMORY", "RUNNER_JOB_DISK_MB", "RUNNER_SERVE_AI_DRAFTS", "LOG_LEVEL",
] as const;

/**
 * Not allowed in runner.local.env besides the managed keys: settings that would turn the per-build sandbox off or
 * loosen it, or switch to / authenticate a paid provider. Changing them is an installer or code change, not a local edit.
 */
export const RESERVED_LOCAL_KEYS = [
  "RUNNER_SANDBOX", "RUNNER_JOB_UID", "RUNNER_DOCKER_BIN", "RUNNER_INSTALL_NETWORK", "RUNNER_INSTALL_PROXY", "RUNNER_NPM_REGISTRY",
  "RUNNER_ALLOWED_BUILD_SCRIPTS", "RUNNER_BROWSER_CHECK", "RUNNER_WORKSPACES", "RUNNER_SANDBOX_VOLUME",
  "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_FILE", "ANTHROPIC_BASE_URL", "RUNNER_AI_DRAFTS_PROVIDER",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY",
] as const;

export const RUNNER_ENV_HEADER = [
  "# Managed by Install-CrestmontRunner.ps1 and rewritten on every run. Do not edit.",
  "# Your own settings (PROJECT_REPO_*, PREVIEW_DEPLOY_*, ...) go in runner.local.env, which the installer never overwrites.",
];

export const LOCAL_ENV_TEMPLATE = [
  "# runner.local.env: your own runner settings. The installer creates this file once and never overwrites it.",
  "# Compose loads it before runner.env, so installer-managed keys cannot be changed here (the installer stops if you try).",
  "# Secrets go in files under ..\\secrets\\ (mounted read-only at /run/secrets); refer to them with <NAME>_FILE.",
  "#",
  "# Per-project repositories (RUNNER-SETUP.md section 4):",
  "# PROJECT_REPO_OWNER=crestmont-builds",
  "# PROJECT_REPO_OWNER_TYPE=org",
  "# PROJECT_REPO_TOKEN_FILE=/run/secrets/project_repo_token",
  "#",
  "# Preview deploys to a separate Cloudflare preview account (PREVIEW-DEPLOYMENT.md):",
  "# PREVIEW_DEPLOY_COMMAND=...",
  "# PREVIEW_DEPLOY_ENV=CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID",
  "# CLOUDFLARE_API_TOKEN_FILE=/run/secrets/cloudflare_api_token",
  "# CLOUDFLARE_ACCOUNT_ID_FILE=/run/secrets/cloudflare_account_id",
  "# Private previews (required for any preview; same value as the platform's BUILD_PREVIEW_GATE_SECRET):",
  "# PREVIEW_GATE_SECRET_FILE=/run/secrets/preview_gate_secret",
];

const KEY = /^[A-Z_][A-Z0-9_]{0,99}$/;
const VALUE = /^[\x20-\x7e]{0,2000}$/;

export class RunnerEnvError extends Error {}

export interface EnvLine { key: string; value: string }

/** KEY=VALUE lines (BOM, CRLF, blank lines and # comments tolerated; malformed lines ignored). */
export function parseEnvText(text: string): EnvLine[] {
  const out: EnvLine[] = [];
  for (const raw of text.replace(/^﻿/, "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) continue;
    out.push({ key, value: line.slice(eq + 1) });
  }
  return out;
}

/** Managed runner.env text. Throws on unexpected keys or values with control or non-ASCII characters. */
export function renderRunnerEnv(managed: EnvLine[]): string {
  const keys = managed.map((m) => m.key);
  if (JSON.stringify(keys) !== JSON.stringify([...MANAGED_RUNNER_ENV_KEYS])) throw new RunnerEnvError(`managed keys must be exactly: ${MANAGED_RUNNER_ENV_KEYS.join(", ")}`);
  for (const m of managed) if (!VALUE.test(m.value)) throw new RunnerEnvError(`${m.key}: value must be printable ASCII on one line`);
  return [...RUNNER_ENV_HEADER, ...managed.map((m) => `${m.key}=${m.value}`)].join("\n") + "\n";
}

export interface MergeResult {
  runnerEnv: string;
  localEnv: string;
  /** Keys moved from the old runner.env into runner.local.env. */
  moved: string[];
  /** Managed or reserved keys set in runner.local.env (the installer stops). */
  conflicts: string[];
  /** Managed keys whose value differs from the old runner.env (reported, and the old file is backed up). */
  changed: string[];
}

export function mergeRunnerEnv(i: { managed: EnvLine[]; existingRunnerEnv: string | null; existingLocalEnv: string | null; stamp: string }): MergeResult {
  if (!/^[0-9]{8}-[0-9]{6}$/.test(i.stamp)) throw new RunnerEnvError("stamp must look like 20261028-041500");
  const runnerEnv = renderRunnerEnv(i.managed);
  const managedSet = new Set<string>(MANAGED_RUNNER_ENV_KEYS);
  const reserved = new Set<string>([...MANAGED_RUNNER_ENV_KEYS, ...RESERVED_LOCAL_KEYS]);
  const oldLines = i.existingRunnerEnv === null ? [] : parseEnvText(i.existingRunnerEnv);
  const local = i.existingLocalEnv === null ? [] : parseEnvText(i.existingLocalEnv);
  const localKeys = new Set(local.map((l) => l.key));

  const conflicts = [...new Set(local.filter((l) => reserved.has(l.key)).map((l) => l.key))];
  const changed: string[] = [];
  const oldManaged = new Map(oldLines.filter((l) => managedSet.has(l.key)).map((l) => [l.key, l.value]));
  if (i.existingRunnerEnv !== null) for (const m of i.managed) if (oldManaged.get(m.key) !== m.value) changed.push(m.key);

  const moveLines: EnvLine[] = [];
  const seen = new Set<string>();
  for (const l of oldLines) {
    if (managedSet.has(l.key) || localKeys.has(l.key) || seen.has(l.key)) continue;
    seen.add(l.key);
    // A reserved key that was hand-added to the old runner.env is not carried over silently: it becomes a conflict.
    if (reserved.has(l.key)) { if (!conflicts.includes(l.key)) conflicts.push(l.key); continue; }
    moveLines.push(l);
  }
  const moved = moveLines.map((l) => l.key);

  let base: string;
  if (i.existingLocalEnv === null || !i.existingLocalEnv.replace(/^﻿/, "").trim()) base = LOCAL_ENV_TEMPLATE.join("\n") + "\n";
  else {
    base = i.existingLocalEnv.replace(/^﻿/, "").replace(/\r\n/g, "\n");
    if (!base.endsWith("\n")) base += "\n";
  }
  const localEnv = moveLines.length
    ? base + `# Moved from runner.env by the installer on ${i.stamp}:\n` + moveLines.map((l) => `${l.key}=${l.value}`).join("\n") + "\n"
    : base;
  return { runnerEnv, localEnv, moved, conflicts, changed };
}
