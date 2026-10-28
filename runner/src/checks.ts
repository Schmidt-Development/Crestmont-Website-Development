// Acceptance checks the RUNNER executes itself after the agent's verify phase (the agent's own claims are not
// enough). Starter checks come from starter.json; custom projects run whichever of test/build/check scripts exist.
// Checks run with the agent environment minus the Anthropic credential: they execute agent-written code.

import { existsSync, readFileSync, cpSync, readdirSync, lstatSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
  /**
   * Starter files the acceptance checks depend on (the checker and its package profiles). The agent can edit any file
   * in its workspace, so the runner restores these from its own starter copy before every acceptance run: a weakened
   * checker can never decide whether a build passes.
   */
  protected?: string[];
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

/** Repository-relative POSIX path without traversal, absolute paths or git internals. */
const SAFE_REL = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!\.git(?:\/|$))[A-Za-z0-9._\/-]{1,200}$/;

/**
 * Restore the starter's protected files (checker, package profiles) into the workspace from the runner's copy.
 * Returns the files that were missing or differed (i.e. the agent changed them) — reported to the owner.
 */
export function restoreProtectedFiles(dir: string, repo: string, spec: StarterSpec): string[] {
  const changed: string[] = [];
  for (const rel of spec.protected ?? []) {
    if (!SAFE_REL.test(rel)) throw new Error(`Starter ${spec.name}-v${spec.version}: invalid protected path ${rel}`);
    const src = path.join(dir, rel);
    if (!existsSync(src)) throw new Error(`Starter ${spec.name}-v${spec.version}: protected file ${rel} is missing from the starter`);
    const dst = path.join(repo, rel);
    const want = readFileSync(src);
    let same = false;
    try { same = !lstatSync(dst).isSymbolicLink() && lstatSync(dst).isFile() && readFileSync(dst).equals(want); } catch { same = false; }
    if (same && !hasLinkedAncestor(repo, rel)) continue;
    changed.push(rel);
    // Never write through a link the agent planted: replace any linked or non-directory ancestor with a real directory.
    let cur = repo;
    for (const part of rel.split("/").slice(0, -1)) {
      cur = path.join(cur, part);
      let st = null;
      try { st = lstatSync(cur); } catch { /* missing */ }
      if (st && (st.isSymbolicLink() || !st.isDirectory())) rmSync(cur, { recursive: true, force: true });
      if (!st || st.isSymbolicLink() || !st.isDirectory()) mkdirSync(cur);
    }
    rmSync(dst, { recursive: true, force: true });
    writeFileSync(dst, want);
  }
  return changed;
}

function hasLinkedAncestor(repo: string, rel: string): boolean {
  let cur = repo;
  for (const part of rel.split("/").slice(0, -1)) {
    cur = path.join(cur, part);
    try { if (lstatSync(cur).isSymbolicLink()) return true; } catch { return false; }
  }
  return false;
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

/**
 * Wrangler config the runner refuses to deploy with the preview credential: a custom build command (runs project
 * code), routes or custom domains (outside the preview account's workers.dev), and any path that leaves the
 * project (absolute, home-relative or with ..), which could upload runner files such as /run/secrets as assets.
 */
export function previewConfigProblems(repo: string): string[] {
  const problems: string[] = [];
  for (const f of ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]) {
    const file = path.join(repo, f);
    if (!existsSync(file)) continue;
    let st;
    try { st = lstatSync(file); } catch { continue; }
    if (st.isSymbolicLink()) { problems.push(`${f} is a symbolic link`); continue; }
    const text = readFileSync(file, "utf8");
    if (/"build"\s*:/.test(text) || /^\s*\[build\]/m.test(text)) problems.push(`${f} defines a custom build command`);
    if (/"routes?"\s*:|^\s*routes?\s*=|"custom_domain"|custom_domain\s*=/m.test(text)) problems.push(`${f} defines routes or custom domains`);
    for (const m of text.matchAll(/["']([^"'\n]{1,500})["']/g)) {
      const v = m[1];
      if (/^(?:\/|~|[A-Za-z]:[\\/]|\\\\)/.test(v) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(v)) {
        if (/^https?:\/\//i.test(v) || /^\/\*/.test(v) || /^\/api\//.test(v) || v === "/api/*") continue; // URLs and route patterns are not paths
        problems.push(`${f} refers to a path outside the project (${v.slice(0, 80)})`);
        break;
      }
    }
  }
  return problems;
}

/** Files a deploy tool would load from the project directory (package managers, env files, local tool installs). */
export const PREVIEW_EXPORT_STRIP = ["node_modules", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", ".wrangler", ".dev.vars", ".env", ".git"];

/** Worker names the runner deploys and deletes: cm-prv-<project>-<build>. */
export const PREVIEW_NAME = /^cm-prv-[a-z0-9][a-z0-9-]{1,55}$/;

/** One preview per build: a revision never replaces the preview of the build an owner reviewed. */
export function previewName(projectId: string, kind: "first_build" | "revision", revision: number): string {
  const project = projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `cm-prv-${project}-${kind === "revision" ? `r${revision}` : "b0"}`;
}

// ── Brief conformance (runner-side, reads files only; never executes agent code) ──

const decodeEntities = (s: string) => s
  .replace(/&(?:amp|#0*38|#x0*26);/gi, "&").replace(/&(?:apos|#0*39|#x0*27|rsquo|lsquo|#0*8217|#x0*2019);/gi, "'")
  .replace(/&(?:quot|#0*34|#x0*22|ldquo|rdquo);/gi, '"').replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, " ");
const norm = (s: string) => decodeEntities(s).replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
/**
 * Visible text of an HTML document for matching (never output as HTML). A scanner, not a regex: comments and
 * script/style elements are removed even when unterminated or closed as `</script >`, then every remaining tag, and
 * finally any stray angle bracket, so no markup can survive into the text.
 */
export function visibleText(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    let end: number;
    if (lower.startsWith("<!--", lt)) {
      const c = lower.indexOf("-->", lt + 4);
      end = c < 0 ? html.length : c + 3;
    } else {
      const m = /^<(script|style)\b/.exec(lower.slice(lt, lt + 8));
      if (m) {
        const close = lower.indexOf(`</${m[1]}`, lt + 1);
        const gt = close < 0 ? -1 : lower.indexOf(">", close);
        end = gt < 0 ? html.length : gt + 1;
      } else {
        const gt = html.indexOf(">", lt + 1);
        end = gt < 0 ? html.length : gt + 1;
      }
    }
    out += " ";
    i = end;
  }
  return out.replace(/[<>]/g, " ");
}

function htmlPages(dir: string, depth = 0): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries.sort()) {
    const p = path.join(dir, e);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory() && depth < 3 && !e.startsWith(".") && e !== "node_modules") out.push(...htmlPages(p, depth + 1));
    else if (st.isFile() && e.endsWith(".html") && st.size <= 2 * 1024 * 1024) out.push(p);
  }
  return out.slice(0, 200);
}

/** Digit strings of phone-like runs in a page (text and tel: links). */
function phoneDigits(html: string): string[] {
  return [...decodeEntities(html).matchAll(/(?:tel:)?\+?\d[\d\s().\- ]{5,22}\d/gi)].map((m) => m[0].replace(/\D/g, ""));
}

export interface BriefFacts { businessName?: string; publicEmail?: string; publicPhone?: string }

/**
 * Objective checks that the generated site carries the customer's own business details (from the brief snapshot,
 * not from files in the workspace): the business name on the home page, and the public email and phone on at least
 * one page when the customer gave them. Returns null when there is no static site or nothing to check.
 * Subjective quality (design, copy, brand fit) is NOT judged here; that is the owner's review.
 */
export function briefConformance(repo: string, facts: BriefFacts): CheckOutcome | null {
  const pub = path.join(repo, "public");
  const pages = htmlPages(pub);
  if (!pages.length) return null;
  const findings: string[] = [];
  let checked = 0;
  const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
  const name = norm(String(facts.businessName ?? "")).slice(0, 120);
  if (name.length >= 2) {
    checked++;
    const home = pages.find((p) => path.relative(pub, p) === "index.html");
    const homeText = home ? norm(visibleText(read(home))) : "";
    const homeTitle = home ? norm((/<title>([\s\S]*?)<\/title>/i.exec(read(home))?.[1]) ?? "") : "";
    if (!home) findings.push("ERROR public/index.html: home page missing");
    else if (!homeText.includes(name) && !homeTitle.includes(name)) findings.push(`ERROR public/index.html: the customer's business name ("${facts.businessName!.trim().slice(0, 80)}") does not appear on the home page`);
  }
  const email = String(facts.publicEmail ?? "").trim().toLowerCase();
  if (/^[^\s@<>"']{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i.test(email)) {
    checked++;
    if (!pages.some((p) => decodeEntities(read(p)).toLowerCase().includes(email))) findings.push(`ERROR public/: the customer's public email (${email}) does not appear on any page`);
  }
  const want = String(facts.publicPhone ?? "").replace(/\D/g, "");
  if (want.length >= 7) {
    checked++;
    const tail = want.slice(-10);
    if (!pages.some((p) => phoneDigits(read(p)).some((d) => d.endsWith(tail)))) {
      findings.push(`ERROR public/: the customer's public phone number (${String(facts.publicPhone).trim().slice(0, 40)}) does not appear on any page`);
    }
  }
  if (!checked) return null;
  const ok = findings.length === 0;
  return {
    id: "brief-conformance", label: "Customer business details from the brief appear on the site (name on the home page; public email and phone on a page)",
    command: "runner: brief conformance (business name, public email, public phone)", ok, code: ok ? 0 : 1, timedOut: false,
    outputTail: ok ? `${checked} customer detail(s) found on the site` : findings.join("\n"),
  };
}

/** Owner-report check from the sandbox isolation records (every container this job started). */
export function isolationCheck(records: { container: string; ok: boolean; findings: string[] }[]): CheckOutcome | null {
  if (!records.length) return null;
  const bad = records.filter((r) => !r.ok);
  const ok = bad.length === 0;
  return {
    id: "sandbox-isolation",
    label: "Build containers verified with docker inspect: no network, read-only root, no capabilities, no-new-privileges, non-root, CPU/RAM/PID limits, only the job's two mounts, no Docker socket",
    command: "runner: docker inspect of each build container (evidence/sandbox-isolation-*.json in the job directory)",
    ok, code: ok ? 0 : 1, timedOut: false,
    outputTail: ok ? `${records.length} container(s) checked, all isolated` : bad.map((r) => `${r.container}: ${r.findings.join("; ")}`).join("\n").slice(0, 3000),
  };
}
