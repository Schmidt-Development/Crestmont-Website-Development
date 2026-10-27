// Acceptance checks the RUNNER executes itself after the agent's verify phase (the agent's own claims are not
// enough). Starter checks come from starter.json; custom projects run whichever of test/build/check scripts exist.
// Checks run with the agent environment minus the Anthropic credential: they execute agent-written code.

import { existsSync, readFileSync, cpSync, readdirSync } from "node:fs";
import path from "node:path";
import { run } from "./exec.ts";
import type { ExecResult } from "./exec.ts";

export interface StarterPackageSpec {
  maxPages: number;
  contactForm: boolean;
  requirements: { key: string; label: string }[];
}

export interface StarterSpec {
  schema: "crestmont.starter/1";
  name: string;
  version: string;
  description: string;
  packages: Record<string, StarterPackageSpec>;
  acceptance: { id: string; label: string; command: string[] }[];
}

export interface CheckOutcome { id: string; label: string; command: string; ok: boolean; code: number; timedOut: boolean; outputTail: string }

export function starterDir(startersDir: string, starter: { name: string; version: string }): string {
  if (!/^[a-z0-9-]{1,40}$/.test(starter.name) || !/^[0-9]{1,4}$/.test(starter.version)) throw new Error(`Invalid starter reference ${starter.name}@${starter.version}`);
  return path.join(startersDir, `${starter.name}-v${starter.version}`);
}

export function loadStarter(dir: string): StarterSpec {
  const file = path.join(dir, "starter.json");
  if (!existsSync(file)) throw new Error(`Starter not found: ${dir}`);
  const spec = JSON.parse(readFileSync(file, "utf8")) as StarterSpec;
  if (spec.schema !== "crestmont.starter/1") throw new Error(`Unsupported starter schema in ${file}`);
  return spec;
}

/** Copy the starter (excluding starter.json, which stays a runner-side contract) into an empty repository. */
export function copyStarter(dir: string, repo: string): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "starter.json" || entry === "node_modules") continue;
    cpSync(path.join(dir, entry), path.join(repo, entry), { recursive: true });
  }
}

export function acceptanceCommands(spec: StarterSpec | null, repo: string, packageId: string | null): { id: string; label: string; command: string[] }[] {
  if (spec) {
    return spec.acceptance.map((a) => ({ ...a, command: a.command.map((c) => c.replace("{package}", packageId ?? "starter")) }));
  }
  const pkgFile = path.join(repo, "package.json");
  if (!existsSync(pkgFile)) return [];
  let scripts: Record<string, string> = {};
  try { scripts = (JSON.parse(readFileSync(pkgFile, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}; } catch { return []; }
  return ["check", "build", "test"].filter((s) => typeof scripts[s] === "string")
    .map((s) => ({ id: `npm-${s}`, label: `npm run ${s}`, command: ["npm", "run", "-s", s] }));
}

/** Executes one check. Default: a runner-side child process (Agent SDK path). The local provider passes the job's
 * container sandbox so agent-written code never runs in the runner process or on the host. */
export type CheckExecutor = (argv: string[], timeoutMs: number) => Promise<ExecResult>;

export async function runChecks(repo: string, commands: { id: string; label: string; command: string[] }[], env: Record<string, string>, timeoutMs: number, executor?: CheckExecutor): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  for (const c of commands) {
    const [cmd, ...args] = c.command;
    const r = executor ? await executor(c.command, timeoutMs) : await run(cmd, args, { cwd: repo, env, timeoutMs });
    const tail = (r.stdout + "\n" + r.stderr).trim().split("\n").slice(-25).join("\n").slice(-3000);
    out.push({ id: c.id, label: c.label, command: c.command.join(" "), ok: r.code === 0, code: r.code, timedOut: r.timedOut, outputTail: tail });
  }
  return out;
}

/** Wrangler config keys that would make a preview deploy execute project code with the preview credential. */
export function previewConfigProblems(repo: string): string[] {
  const problems: string[] = [];
  for (const f of ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]) {
    const file = path.join(repo, f);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (/"build"\s*:/.test(text) || /^\s*\[build\]/m.test(text)) problems.push(`${f} defines a custom build command`);
    if (/"routes?"\s*:|^\s*routes?\s*=|"custom_domain"|custom_domain\s*=/m.test(text)) problems.push(`${f} defines routes or custom domains`);
  }
  return problems;
}
