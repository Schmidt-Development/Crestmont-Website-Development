// Child-process helper: never uses a shell unless the caller passes ["sh","-c",cmd] explicitly, always takes an
// explicit environment (no implicit inheritance of the runner's secrets), and caps output and runtime.

import { spawn } from "node:child_process";

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean; notFound: boolean }

export function run(cmd: string, args: string[], opts: { cwd?: string; env: Record<string, string>; timeoutMs?: number; input?: string; maxOutput?: number }): Promise<ExecResult> {
  const max = opts.maxOutput ?? 2 * 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (r: ExecResult) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      done({ code: 127, stdout: "", stderr: String(err), timedOut: false, notFound: true });
      return;
    }
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs) : null;
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < max) stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < max) stderr += d.toString("utf8"); });
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
