// Child-process helper for every process the runner starts on its own host.
//
// Security contract (CodeQL js/command-line-injection, js/shell-command-injection-from-environment):
//   * Never a shell. `shell: false` is explicit, and shell interpreters (sh, bash, cmd, powershell, env, xargs, …)
//     are refused as programs, so no argument a caller passes — job IDs, workspace paths, repository content — is
//     ever interpreted by a shell on the runner host.
//   * Only allow-listed programs. A caller names one of PROGRAMS (resolved through the explicit PATH it passes), or a
//     TrustedBinary: the Docker CLI or the Claude Code CLI, whose path comes from operator configuration and is
//     validated by trustedBinary() (absolute or bare name, expected basename, no traversal, regular executable file).
//     Nothing received from the control plane, a customer, the agent or a repository can select the executable.
//   * Arguments, working directory and environment are checked (no NUL bytes, bounded sizes, absolute cwd, sane
//     variable names). A refusal is returned as an ExecResult with `refused` set (code 126); it never runs anything.
//   * Always an explicit environment (no implicit inheritance of the runner's secrets), capped output and runtime.
//
// Commands the agent itself runs (Claude Code's Bash tool, the local provider's run_command) never come through
// here as programs: they run inside the job's container sandbox (`docker exec … bash -c <cmd>`, the shell is the
// container's) or under Claude Code's own permission settings, both of which stay in force.

import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync, accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean; notFound: boolean; refused?: boolean }

/** Programs the runner may start by name (resolved through the PATH in the explicit environment). */
const PROGRAMS = {
  git: "git",
  tar: "tar",
  node: "node",
  npm: "npm",
  npx: "npx",
  wrangler: "wrangler",
  bwrap: "bwrap",
  socat: "socat",
} as const;
export type Program = keyof typeof PROGRAMS;

/** Interpreters and launchers that would re-introduce shell interpretation or arbitrary-program selection. */
const SHELL_LIKE = /^(?:sh|bash|dash|zsh|ksh|mksh|csh|tcsh|fish|ash|busybox|rbash|cmd|command|powershell|pwsh|env|xargs|nohup|exec|eval|timeout|nice|sudo|su|doas|script|expect|perl|python\d*(?:\.\d+)?|ruby|php|lua|osascript|wscript|cscript|mshta|rundll32)(?:\.(?:exe|cmd|bat|com|ps1))?$/i;

/** Returns the allow-listed program for `name`, or null. Never returns a shell. */
export function programOf(name: unknown): Program | null {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(PROGRAMS, name)) return null;
  return name as Program;
}

export function isShellLike(name: string): boolean {
  return SHELL_LIKE.test(path.basename(name));
}

const BINARY_NAMES: Record<TrustedBinaryKind, readonly string[]> = {
  docker: ["docker", "docker.exe"],
  claude: ["claude", "claude.exe"],
};
export type TrustedBinaryKind = "docker" | "claude";
const TRUSTED = Symbol("crestmont.trustedBinary");
/** An operator-configured executable that passed trustedBinary(). Only this module can create one. */
export interface TrustedBinary { readonly kind: TrustedBinaryKind; readonly path: string; readonly [TRUSTED]: true }

export class ExecPolicyError extends Error {
  constructor(message: string) { super(message); this.name = "ExecPolicyError"; }
}

/**
 * Validate an operator-configured binary setting (RUNNER_DOCKER_BIN, CLAUDE_CODE_BIN, DOCKER_BIN in CI): either the
 * bare expected name (resolved through PATH) or an absolute, normalized path to a regular executable file whose name
 * (after resolving symlinks, too) is the expected one. Throws ExecPolicyError otherwise.
 */
export function trustedBinary(kind: TrustedBinaryKind, value: string, opts: { requireExists?: boolean } = {}): TrustedBinary {
  const names = BINARY_NAMES[kind];
  if (typeof value !== "string" || !value || value.length > 4096 || /[\0\r\n]/.test(value)) throw new ExecPolicyError(`${kind} binary setting is empty or contains control characters`);
  if (names.includes(value)) return Object.freeze({ kind, path: value, [TRUSTED]: true as const });
  if (!path.isAbsolute(value)) throw new ExecPolicyError(`${kind} binary must be "${names[0]}" or an absolute path (got ${value.slice(0, 200)})`);
  if (path.normalize(value) !== value || value.split(/[\\/]/).includes("..")) throw new ExecPolicyError(`${kind} binary path must be normalized, without "..": ${value.slice(0, 200)}`);
  if (!names.includes(path.basename(value).toLowerCase())) throw new ExecPolicyError(`${kind} binary must be named ${names.join(" or ")} (got ${path.basename(value).slice(0, 80)})`);
  if (opts.requireExists !== false && existsSync(value)) {
    const real = realpathSync(value);
    const st = statSync(real);
    if (!st.isFile()) throw new ExecPolicyError(`${kind} binary ${value} is not a regular file`);
    try { accessSync(real, fsConstants.X_OK); } catch { throw new ExecPolicyError(`${kind} binary ${value} is not executable`); }
    if (isShellLike(real)) throw new ExecPolicyError(`${kind} binary ${value} resolves to a shell or interpreter (${real})`);
  }
  return Object.freeze({ kind, path: value, [TRUSTED]: true as const });
}

function isTrustedBinary(p: unknown): p is TrustedBinary {
  return typeof p === "object" && p !== null && (p as TrustedBinary)[TRUSTED] === true;
}

const MAX_ARGS = 1024;
const MAX_ARG_BYTES = 256 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Why this invocation is refused, or null when it may run. Exported for tests. */
export function invocationProblem(args: unknown, opts: { cwd?: unknown; env?: unknown }): string | null {
  if (!Array.isArray(args) || args.length > MAX_ARGS) return "arguments must be an array of at most 1024 strings";
  for (const a of args) {
    if (typeof a !== "string") return "every argument must be a string";
    if (a.includes("\0")) return "an argument contains a NUL byte";
    if (a.length > MAX_ARG_BYTES) return "an argument is too long";
  }
  if (opts.cwd !== undefined) {
    if (typeof opts.cwd !== "string" || !path.isAbsolute(opts.cwd) || opts.cwd.includes("\0")) return "the working directory must be an absolute path";
  }
  if (typeof opts.env !== "object" || opts.env === null) return "an explicit environment is required";
  for (const [k, v] of Object.entries(opts.env as Record<string, unknown>)) {
    if (!ENV_NAME.test(k)) return `invalid environment variable name ${k.slice(0, 60)}`;
    if (typeof v !== "string" || v.includes("\0")) return `environment variable ${k} is not a NUL-free string`;
  }
  return null;
}

const refused = (why: string): ExecResult => ({ code: 126, stdout: "", stderr: `refused by the runner's execution policy: ${why}`, timedOut: false, notFound: false, refused: true });

export function run(program: Program | TrustedBinary, args: string[], opts: { cwd?: string; env: Record<string, string>; timeoutMs?: number; input?: string; maxOutput?: number }): Promise<ExecResult> {
  // The executable is a constant from PROGRAMS or a validated TrustedBinary path — never a caller-built string.
  let executable: string;
  if (isTrustedBinary(program)) executable = program.path;
  else {
    const p = programOf(program);
    if (!p) return Promise.resolve(refused(`"${String(program).slice(0, 80)}" is not an allow-listed program`));
    executable = PROGRAMS[p];
  }
  const problem = invocationProblem(args, opts);
  if (problem) return Promise.resolve(refused(problem));
  const max = opts.maxOutput ?? 2 * 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (r: ExecResult) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(executable, [...args], { cwd: opts.cwd, env: { ...opts.env }, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    } catch (err) {
      done({ code: 127, stdout: "", stderr: String(err), timedOut: false, notFound: true });
      return;
    }
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs) : null;
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < max) stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < max) stderr += d.toString("utf8"); });
    child.stdin.on("error", () => { /* child exited before reading its input */ });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      done({ code: 127, stdout, stderr: stderr + String(err), timedOut, notFound: err.code === "ENOENT" });
    });
    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      done({ code: code ?? (timedOut ? 124 : 1), stdout, stderr, timedOut, notFound: false });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input); else child.stdin.end();
  });
}

/** Minimal environment for runner-side git/tar calls (no secrets). */
export function baseEnv(pathValue: string, home: string): Record<string, string> {
  return {
    PATH: pathValue,
    HOME: home,
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/**
 * The runner's own outbound proxy settings (compose sets HTTPS_PROXY=http://egress-proxy:3128 on the runner; its
 * network has no other way out). Runner-side network commands (git push/clone, the preview deploy) need them; the
 * agent and the sandbox never get them. A proxy URL carrying credentials is not passed on.
 */
export function proxyEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]) {
    const v = env[name];
    if (!v || v.length > 500) continue;
    if (!/^no_proxy$/i.test(name)) {
      try { const u = new URL(v); if (u.username || u.password || !/^https?:$/.test(u.protocol)) continue; } catch { continue; }
    }
    out[name] = v;
  }
  return out;
}

/** A Docker image reference given on a command line (CI scripts): registry/name[:tag][@digest], never an option. */
const IMAGE_REF = /^(?:[a-z0-9][a-z0-9.-]{0,252}(?::\d{1,5})?\/)?[a-z0-9][a-z0-9._/-]{0,200}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;
export function dockerImageRef(value: unknown): string {
  if (typeof value !== "string" || !IMAGE_REF.test(value) || value.includes("..") || value.includes("//")) throw new ExecPolicyError(`not a Docker image reference: ${String(value).slice(0, 120)}`);
  return value;
}
