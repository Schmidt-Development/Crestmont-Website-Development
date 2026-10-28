// Tools of the in-house local coding agent. File tools run in the runner process but are confined to the job's
// repository (realpath under the repo; .git internals and runner-provisioned config denied). Commands, package
// installs and browser checks run ONLY in the per-job sandbox container (sandbox.ts).
// Tool arguments are validated against a strict JSON schema; violations return corrective feedback to the model.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolSpec } from "./openai-client.ts";
import type { JobSandbox } from "../sandbox.ts";
import { normalizeItem } from "../requirements.ts";
import type { RequirementItem } from "../protocol.ts";

// ── schemas ──

type Schema =
  | { type: "string"; description?: string; maxLength?: number; enum?: string[] }
  | { type: "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: { type: "string"; maxLength?: number }; maxItems?: number };

interface ObjectSchema { type: "object"; properties: Record<string, Schema>; required: string[]; additionalProperties: false }

interface ToolDef { name: string; description: string; parameters: ObjectSchema }

const S = (description: string, maxLength = 4096): Schema => ({ type: "string", description, maxLength });

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "list_dir",
    description: "List files and directories under a path in the project repository (relative paths only).",
    parameters: { type: "object", additionalProperties: false, required: [], properties: {
      path: S("Directory relative to the repository root. Default: \".\"", 500),
      depth: { type: "integer", minimum: 1, maximum: 4, description: "How many levels to list (1-4). Default 2." },
    } },
  },
  {
    name: "read_file",
    description: "Read a text file from the repository. Returns numbered lines.",
    parameters: { type: "object", additionalProperties: false, required: ["path"], properties: {
      path: S("File path relative to the repository root.", 500),
      start_line: { type: "integer", minimum: 1, maximum: 1_000_000, description: "First line (1-based). Default 1." },
      max_lines: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum lines to return. Default 400." },
    } },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file in the repository with the complete content.",
    parameters: { type: "object", additionalProperties: false, required: ["path", "content"], properties: {
      path: S("File path relative to the repository root.", 500),
      content: S("The full file content.", 512 * 1024),
    } },
  },
  {
    name: "edit_file",
    description: "Replace an exact string in a file. old_string must match exactly once unless replace_all is true.",
    parameters: { type: "object", additionalProperties: false, required: ["path", "old_string", "new_string"], properties: {
      path: S("File path relative to the repository root.", 500),
      old_string: S("Exact text to find (including whitespace).", 64 * 1024),
      new_string: S("Replacement text.", 256 * 1024),
      replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
    } },
  },
  {
    name: "search",
    description: "Search file contents in the repository (like grep). Returns matching lines as path:line: text.",
    parameters: { type: "object", additionalProperties: false, required: ["pattern"], properties: {
      pattern: S("Text to find. Treated literally unless regex is true.", 500),
      path: S("Directory or file to search, relative. Default \".\"", 500),
      regex: { type: "boolean", description: "Interpret pattern as a JavaScript regular expression." },
    } },
  },
  {
    name: "run_command",
    description: "Run a shell command in the project's isolated build container (no network). Use for builds, tests and checks such as `npm run check`.",
    parameters: { type: "object", additionalProperties: false, required: ["command"], properties: {
      command: S("Shell command (bash). Runs in the repository root.", 4000),
      timeout_seconds: { type: "integer", minimum: 1, maximum: 1800, description: "Timeout. Default from the runner configuration." },
    } },
  },
  {
    name: "install_packages",
    description: "Install npm dependencies through the approved registry proxy with install scripts disabled. With no packages, installs from package.json/package-lock.json.",
    parameters: { type: "object", additionalProperties: false, required: [], properties: {
      packages: { type: "array", maxItems: 20, items: { type: "string", maxLength: 150 }, description: "Registry package specs, e.g. [\"vite@5.4.10\"]." },
      dev: { type: "boolean", description: "Save as devDependencies." },
    } },
  },
  {
    name: "report_requirement",
    description: "Record the status of one requirement. Use \"verified\" only with evidence naming the command or screenshot you actually ran/took.",
    parameters: { type: "object", additionalProperties: false, required: ["key", "status"], properties: {
      key: S("Requirement key, e.g. page:home or pkg:responsive.", 120),
      status: { type: "string", enum: ["remaining", "implemented_unverified", "verified", "blocked"] },
      label: S("Short label.", 200),
      evidence: S("Command + result or screenshot path (required for verified).", 1000),
      blocker: S("What blocks it (required for blocked).", 500),
    } },
  },
  {
    name: "finish",
    description: "End the current phase. Call this when the phase's work is done (or truly blocked).",
    parameters: { type: "object", additionalProperties: false, required: ["summary"], properties: {
      summary: S("What was done in this phase and what remains.", 4000),
    } },
  },
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Tools of a read-only session (Model A architect and reviewer): they can look, never change or run anything. */
export const READ_ONLY_TOOLS = ["list_dir", "read_file", "search"];
export function readOnlyToolSpecs(): ToolSpec[] {
  return toolSpecs().filter((t) => READ_ONLY_TOOLS.includes(t.function.name));
}

/** Execute a tool for a read-only session; anything but the read-only tools is refused (never executed). */
export async function executeReadOnlyTool(name: string, args: Record<string, unknown>, repo: string): Promise<ToolOutcome> {
  if (!READ_ONLY_TOOLS.includes(name)) return { ok: false, activity: `${name} refused`, output: `ERROR: ${name} is not available in a read-only session. Available: ${READ_ONLY_TOOLS.join(", ")}.` };
  const problems = validateArgs(name, args);
  if (problems.length) return { ok: false, activity: `${name} invalid`, output: `ERROR: invalid call to ${name}: ${problems.join("; ")}. Schema: ${schemaHint(name)}` };
  const noSandbox = new Proxy({}, { get() { throw new Error("read-only session: no commands"); } }) as unknown as JobSandbox;
  return executeTool(name, args, { repo, sandbox: noSandbox, defaultTimeoutMs: 0 });
}

export function toolSpecs(): ToolSpec[] {
  return TOOL_DEFS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters as unknown as Record<string, unknown> } }));
}

/** Strict validation: unknown tool, unknown/missing properties and wrong types are all errors. */
export function validateArgs(tool: string, args: unknown): string[] {
  const def = TOOL_DEFS.find((t) => t.name === tool);
  if (!def) return [`unknown tool "${tool}". Available tools: ${TOOL_NAMES.join(", ")}`];
  if (!args || typeof args !== "object" || Array.isArray(args)) return ["arguments must be a JSON object"];
  const errors: string[] = [];
  const a = args as Record<string, unknown>;
  for (const r of def.parameters.required) if (!(r in a)) errors.push(`missing required property "${r}"`);
  for (const [k, v] of Object.entries(a)) {
    const s = def.parameters.properties[k];
    if (!s) { errors.push(`unknown property "${k}" (allowed: ${Object.keys(def.parameters.properties).join(", ")})`); continue; }
    if (s.type === "string") {
      if (typeof v !== "string") errors.push(`"${k}" must be a string`);
      else if (s.maxLength && v.length > s.maxLength) errors.push(`"${k}" is longer than ${s.maxLength} characters`);
      else if (s.enum && !s.enum.includes(v)) errors.push(`"${k}" must be one of ${s.enum.join(", ")}`);
    } else if (s.type === "integer") {
      if (typeof v !== "number" || !Number.isInteger(v)) errors.push(`"${k}" must be an integer`);
      else if ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum)) errors.push(`"${k}" must be between ${s.minimum} and ${s.maximum}`);
    } else if (s.type === "boolean") {
      if (typeof v !== "boolean") errors.push(`"${k}" must be true or false`);
    } else if (s.type === "array") {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) errors.push(`"${k}" must be an array of strings`);
      else if (s.maxItems && v.length > s.maxItems) errors.push(`"${k}" may have at most ${s.maxItems} items`);
    }
  }
  return errors;
}

export function schemaHint(tool: string): string {
  const def = TOOL_DEFS.find((t) => t.name === tool);
  return def ? JSON.stringify(def.parameters) : "";
}

// ── path confinement ──

export class PathDenied extends Error {
  constructor(message: string) { super(message); this.name = "PathDenied"; }
}

/** Paths the agent may not read (r) or write (w). Matched against the repo-relative POSIX path. */
function deniedReason(rel: string, mode: "r" | "w"): string | null {
  const parts = rel.split("/");
  if (parts.includes(".git")) return "git internals are managed by the runner";
  if (mode === "w" && (parts[0] === ".claude" || rel === ".gitmodules")) return "runner-provisioned configuration is read-only";
  if (mode === "w" && rel === ".crestmont/runner-checks.json") return "runner check results are read-only";
  return null;
}

/**
 * Resolve a model-supplied path inside the repository. Refuses absolute paths outside it, `..` escapes, symlinks
 * that resolve outside it (checked on the nearest existing ancestor for new files) and denied locations.
 */
export function confine(repo: string, p: unknown, mode: "r" | "w"): { abs: string; rel: string } {
  if (typeof p !== "string" || !p.trim()) throw new PathDenied("path must be a non-empty string");
  if (p.includes("\0")) throw new PathDenied("path contains a NUL byte");
  const root = realpathSync(repo);
  // Commands see the repository at /workspace/repo; accept that spelling of a repository path too.
  const normalized = p.replace(/\\/g, "/").replace(/^\/workspace\/repo(?=\/|$)/, ".");
  const candidate = path.resolve(root, normalized);
  const relLexical = path.relative(root, candidate);
  if (relLexical.startsWith("..") || path.isAbsolute(relLexical)) throw new PathDenied(`${p} is outside the project repository`);
  // Follow symlinks on whatever part of the path exists.
  let existing = candidate;
  while (!existsSync(existing)) existing = path.dirname(existing);
  const real = path.join(realpathSync(existing), path.relative(existing, candidate));
  const rel = path.relative(root, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new PathDenied(`${p} resolves outside the project repository`);
  const posix = rel.split(path.sep).join("/") || ".";
  const denied = deniedReason(posix, mode);
  if (denied) throw new PathDenied(`${p}: ${denied}`);
  if (mode === "w" && existsSync(real) && lstatSync(real).isDirectory()) throw new PathDenied(`${p} is a directory`);
  return { abs: real, rel: posix };
}

// ── implementations ──

export interface ToolContext {
  repo: string;
  sandbox: JobSandbox;
  defaultTimeoutMs: number;
}

export interface ToolOutcome { output: string; finished?: { summary: string }; activity: string; ok: boolean }

const MAX_OUTPUT = 16_000;

export function clip(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2) - 40;
  return `${text.slice(0, half)}\n... [${text.length - 2 * half} characters omitted] ...\n${text.slice(-half)}`;
}

function listDir(repo: string, rel: string, depth: number): string {
  const { abs } = confine(repo, rel || ".", "r");
  if (!statSync(abs).isDirectory()) throw new PathDenied(`${rel} is not a directory`);
  const out: string[] = [];
  const walk = (dir: string, prefix: string, d: number) => {
    let entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== ".git" && e.name !== "node_modules");
    entries = entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= 500) return;
      const isDir = e.isDirectory();
      out.push(`${prefix}${e.name}${isDir ? "/" : ""}`);
      if (isDir && d < depth) walk(path.join(dir, e.name), `${prefix}${e.name}/`, d + 1);
    }
  };
  walk(abs, "", 1);
  return out.length ? out.join("\n") + (out.length >= 500 ? "\n... (truncated)" : "") : "(empty directory)";
}

function readFileTool(repo: string, p: string, start = 1, max = 400): string {
  const { abs } = confine(repo, p, "r");
  if (!existsSync(abs)) throw new PathDenied(`${p} does not exist`);
  if (statSync(abs).isDirectory()) throw new PathDenied(`${p} is a directory; use list_dir`);
  if (statSync(abs).size > 2 * 1024 * 1024) throw new PathDenied(`${p} is larger than 2 MB`);
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return `${p} is a binary file (${buf.length} bytes)`;
  const lines = buf.toString("utf8").split("\n");
  const slice = lines.slice(start - 1, start - 1 + max);
  const body = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`).join("\n");
  const more = start - 1 + max < lines.length ? `\n... (${lines.length - (start - 1 + max)} more lines; use start_line)` : "";
  return clip(body + more, 48_000);
}

function searchTool(repo: string, pattern: string, rel: string, regex: boolean): string {
  const { abs } = confine(repo, rel || ".", "r");
  let re: RegExp;
  try { re = regex ? new RegExp(pattern) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); } catch (e) {
    throw new PathDenied(`invalid regular expression: ${(e as Error).message}`);
  }
  const root = realpathSync(repo);
  const hits: string[] = [];
  const visit = (p: string) => {
    if (hits.length >= 200) return;
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) if (e !== ".git" && e !== "node_modules") visit(path.join(p, e));
      return;
    }
    if (st.size > 1024 * 1024) return;
    const buf = readFileSync(p);
    if (buf.subarray(0, 8000).includes(0)) return;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length && hits.length < 200; i++) {
      const line = lines[i].slice(0, 2000);
      if (re.test(line)) hits.push(`${path.relative(root, p).split(path.sep).join("/")}:${i + 1}: ${line.trim().slice(0, 300)}`);
    }
  };
  visit(abs);
  return hits.length ? hits.join("\n") + (hits.length >= 200 ? "\n... (first 200 matches)" : "") : "No matches.";
}

export function requirementsFile(repo: string): string { return path.join(repo, ".crestmont", "requirements.json"); }

export function upsertRequirement(repo: string, raw: Record<string, unknown>): RequirementItem {
  const item = normalizeItem(raw);
  if (!item) throw new PathDenied("requirement needs a key");
  const file = requirementsFile(repo);
  mkdirSync(path.dirname(file), { recursive: true });
  let list: unknown[] = [];
  if (existsSync(file)) { try { const v = JSON.parse(readFileSync(file, "utf8")); if (Array.isArray(v)) list = v; } catch { list = []; } }
  const idx = list.findIndex((r) => r && typeof r === "object" && (r as { key?: unknown }).key === item.key);
  const prevLabel = idx >= 0 ? (list[idx] as { label?: string }).label : undefined;
  const merged = { ...item, ...(item.label || prevLabel ? { label: item.label ?? prevLabel } : {}) };
  if (idx >= 0) list[idx] = merged; else list.push(merged);
  writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
  return merged;
}

export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  try {
    switch (name) {
      case "list_dir":
        return { ok: true, activity: `list_dir ${str("path") || "."}`, output: listDir(ctx.repo, str("path") || ".", typeof args.depth === "number" ? args.depth : 2) };
      case "read_file":
        return { ok: true, activity: `read_file ${str("path")}`, output: readFileTool(ctx.repo, str("path"), args.start_line as number | undefined, args.max_lines as number | undefined) };
      case "write_file": {
        const { abs, rel } = confine(ctx.repo, str("path"), "w");
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, str("content"));
        return { ok: true, activity: `write_file ${rel}`, output: `Wrote ${rel} (${Buffer.byteLength(str("content"))} bytes).` };
      }
      case "edit_file": {
        const { abs, rel } = confine(ctx.repo, str("path"), "w");
        if (!existsSync(abs)) return { ok: false, activity: `edit_file ${rel}`, output: `ERROR: ${rel} does not exist. Use write_file to create it.` };
        const text = readFileSync(abs, "utf8");
        const oldS = str("old_string");
        if (!oldS) return { ok: false, activity: `edit_file ${rel}`, output: "ERROR: old_string must not be empty." };
        const count = text.split(oldS).length - 1;
        if (count === 0) return { ok: false, activity: `edit_file ${rel}`, output: `ERROR: old_string was not found in ${rel}. Read the file again and copy the exact text, including whitespace.` };
        if (count > 1 && args.replace_all !== true) return { ok: false, activity: `edit_file ${rel}`, output: `ERROR: old_string occurs ${count} times in ${rel}. Add surrounding context to make it unique, or set replace_all to true.` };
        writeFileSync(abs, args.replace_all === true ? text.split(oldS).join(str("new_string")) : text.replace(oldS, () => str("new_string")));
        return { ok: true, activity: `edit_file ${rel}`, output: `Edited ${rel} (${args.replace_all === true ? count : 1} replacement${count > 1 && args.replace_all === true ? "s" : ""}).` };
      }
      case "search":
        return { ok: true, activity: `search ${str("pattern").slice(0, 60)}`, output: searchTool(ctx.repo, str("pattern"), str("path") || ".", args.regex === true) };
      case "run_command": {
        const timeoutMs = typeof args.timeout_seconds === "number" ? args.timeout_seconds * 1000 : ctx.defaultTimeoutMs;
        const r = await ctx.sandbox.shell(str("command"), timeoutMs);
        const out = `exit code: ${r.code}${r.timedOut ? " (timed out)" : ""}\n--- stdout ---\n${clip(r.stdout, 10_000)}\n--- stderr ---\n${clip(r.stderr, 6_000)}`;
        return { ok: r.code === 0, activity: `run_command ${str("command").split(/\s+/).slice(0, 4).join(" ")}`, output: out };
      }
      case "install_packages": {
        const pkgs = Array.isArray(args.packages) ? (args.packages as string[]) : [];
        const r = await ctx.sandbox.install({ packages: pkgs, dev: args.dev === true });
        return { ok: r.code === 0, activity: `install_packages ${pkgs.join(" ").slice(0, 120) || "(from package.json)"}`, output: `${r.command}\nexit code: ${r.code}${r.timedOut ? " (timed out)" : ""}\n${clip(r.stdout + "\n" + r.stderr, 8_000)}` };
      }
      case "report_requirement": {
        const item = upsertRequirement(ctx.repo, args);
        const downgraded = args.status === "verified" && item.status !== "verified";
        return { ok: true, activity: `report_requirement ${item.key}=${item.status}`, output: `Recorded ${item.key}: ${item.status}${downgraded ? " (downgraded: verified needs evidence naming the command or screenshot)" : ""}.` };
      }
      case "finish":
        return { ok: true, activity: "finish", output: "Phase finished.", finished: { summary: str("summary") } };
      default:
        return { ok: false, activity: name, output: `ERROR: unknown tool ${name}` };
    }
  } catch (err) {
    if (err instanceof PathDenied) return { ok: false, activity: `${name} denied`, output: `ERROR: ${err.message}` };
    return { ok: false, activity: `${name} failed`, output: `ERROR: ${(err as Error).message ?? String(err)}`.slice(0, 2000) };
  }
}
