// Curated skill manifest, preflight (verify skills and tools exist, don't assume) and provisioning into the
// workspace's .claude/skills/. Only the listed skills are copied; their names are passed to query({ skills }).

import { readFileSync, existsSync, cpSync, statSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { run } from "./exec.ts";

export type Workflow = "standard-brochure" | "custom-app";

export interface SkillDef { title: string; source: string; sha256: string | null }
export interface ToolDef { command: string[]; sandboxOnly?: boolean; hint?: string }
export interface SkillManifest {
  schema: string;
  version: string;
  skills: Record<string, SkillDef>;
  tools: Record<string, ToolDef>;
  workflows: Record<Workflow, { description: string; skills: { name: string; required: boolean }[]; tools: string[] }>;
}

export function loadManifest(file: string): SkillManifest {
  const m = JSON.parse(readFileSync(file, "utf8")) as SkillManifest;
  if (m.schema !== "crestmont.runner-skills/1") throw new Error(`Unsupported skills manifest schema ${m.schema}`);
  for (const wf of Object.values(m.workflows)) {
    for (const s of wf.skills) if (!m.skills[s.name]) throw new Error(`Workflow skill ${s.name} is not defined in the manifest`);
    for (const t of wf.tools) if (!m.tools[t]) throw new Error(`Workflow tool ${t} is not defined in the manifest`);
  }
  for (const name of Object.keys(m.skills)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`Invalid skill name ${name}`);
  }
  return m;
}

export interface SkillCheck { name: string; title: string; required: boolean; ok: boolean; problem?: string; sourceDir: string }
export interface ToolCheck { name: string; ok: boolean; problem?: string; hint?: string }
export interface PreflightResult { ok: boolean; skills: SkillCheck[]; tools: ToolCheck[]; errors: string[]; warnings: string[] }

function checkSkill(sourceRoot: string, name: string, def: SkillDef, required: boolean): SkillCheck {
  const sourceDir = path.resolve(sourceRoot, def.source);
  const base: SkillCheck = { name, title: def.title, required, ok: false, sourceDir };
  if (!sourceDir.startsWith(path.resolve(sourceRoot) + path.sep)) return { ...base, problem: "source path escapes SKILLS_SOURCE_DIR" };
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) return { ...base, problem: `not found at ${sourceDir}` };
  const skillMd = path.join(sourceDir, "SKILL.md");
  if (!existsSync(skillMd)) return { ...base, problem: "SKILL.md missing" };
  const text = readFileSync(skillMd);
  const head = text.subarray(0, 4096).toString("utf8");
  if (!head.startsWith("---") || !/\ndescription\s*:/.test(head)) return { ...base, problem: "SKILL.md has no frontmatter description" };
  if (def.sha256) {
    const actual = createHash("sha256").update(text).digest("hex");
    if (actual !== def.sha256.toLowerCase()) return { ...base, problem: `SKILL.md sha256 ${actual} does not match the pinned ${def.sha256}` };
  }
  return { ...base, ok: true };
}

export async function preflight(opts: {
  manifest: SkillManifest; workflow: Workflow; skillsSourceDir: string; sandbox: "on" | "off";
  env: Record<string, string>; toolTimeoutMs?: number;
}): Promise<PreflightResult> {
  const wf = opts.manifest.workflows[opts.workflow];
  const errors: string[] = [];
  const warnings: string[] = [];
  const skills = wf.skills.map((s) => checkSkill(opts.skillsSourceDir, s.name, opts.manifest.skills[s.name], s.required));
  for (const s of skills) {
    if (s.ok) continue;
    const msg = `skill "${s.title}" (${s.name}): ${s.problem}`;
    (s.required ? errors : warnings).push(s.required ? `Required ${msg}` : `Optional ${msg}`);
  }
  const tools: ToolCheck[] = [];
  for (const name of wf.tools) {
    const def = opts.manifest.tools[name];
    if (def.sandboxOnly && opts.sandbox === "off") continue;
    const [cmd, ...args] = def.command;
    const r = await run(cmd, args, { env: opts.env, timeoutMs: opts.toolTimeoutMs ?? 30_000, cwd: opts.env.HOME });
    const ok = r.code === 0;
    const problem = ok ? undefined : r.notFound ? "not installed" : r.timedOut ? "check timed out" : `check exited ${r.code}`;
    tools.push({ name, ok, problem, hint: def.hint });
    if (!ok) errors.push(`Required tool ${name}: ${problem}${def.hint ? ` (${def.hint})` : ""}`);
  }
  return { ok: errors.length === 0, skills, tools, errors, warnings };
}

/** Copy the available listed skills into <repo>/.claude/skills/. Returns the names to pass to query({ skills }). */
export function provisionSkills(repo: string, checks: SkillCheck[]): string[] {
  const dest = path.join(repo, ".claude", "skills");
  mkdirSync(dest, { recursive: true });
  const names: string[] = [];
  for (const s of checks) {
    if (!s.ok) continue;
    cpSync(s.sourceDir, path.join(dest, s.name), { recursive: true, dereference: true, errorOnExist: false, force: true });
    names.push(s.name);
  }
  return names;
}
