// Building an imported frontend inside the existing per-job sandbox.
//
// NO NEW EXECUTION ENVIRONMENT. `JobSandbox` already gives exactly what is needed: a container running as a
// non-root uid with `--read-only`, `--cap-drop ALL`, `--network none` for everything except the install step,
// which gets the registry proxy and `--ignore-scripts`. This module decides WHAT to run and checks what came
// out; the isolation is the sandbox's, unchanged.
//
// THE ORIGINAL PROJECT IS PRESERVED. A build writes to `dist/` or `build/`, and `sourceFingerprint()` from
// `repair-effect.ts` already skips those directories along with `node_modules`. So the same fingerprint taken
// before and after a build is a real check that the Founder's source and assets were not modified — not a
// promise, a measurement. `preserved: false` is reported rather than ignored.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { sourceFingerprint } from "../orchestrator/repair-effect.ts";
import type { Framework } from "./artifact.ts";

/** The part of `JobSandbox` this module uses, so a build can be tested without Docker. */
export interface BuildSandbox {
  install(opts?: { packages?: string[]; dev?: boolean }): Promise<SandboxRun>;
  argv(argv: string[], timeoutMs?: number, label?: string): Promise<SandboxRun>;
}

export interface SandboxRun {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  command: string;
}

export interface BuildPlan {
  framework: Framework;
  needsInstall: boolean;
  /** null for a static site: there is nothing to build. */
  buildCommand: string[] | null;
  /** Where the servable site is expected, relative to the repo root. "" means the repo root itself. */
  expectOutput: string;
  /** Why this plan, in words, for the build record. */
  rationale: string;
}

export interface BuildResult {
  ok: boolean;
  /** The directory to serve and render, relative to the repo root. */
  outputRoot: string | null;
  plan: BuildPlan;
  install: SandboxRun | null;
  build: SandboxRun | null;
  /** The Founder's source and assets are byte-identical before and after. */
  preserved: boolean;
  sourceBefore: string | null;
  sourceAfter: string | null;
  problems: string[];
}

/** Where each toolchain puts its output, in the order they are looked for. */
const OUTPUT_CANDIDATES = ["dist", "build", "out", ".output/public", "public/build"] as const;

/** A directory that is never the site root. */
const NOT_A_ROOT = new Set(["node_modules", ".git", ".crestmont", "src", "test", "tests"]);

function readPkg(repo: string): { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null {
  const f = path.join(repo, "package.json");
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

/**
 * The shallowest directory holding an `index.html`, for a static site whose pages may be at the root or under
 * `public/`, `site/`, `www/` and so on. Decided from the files, not from a convention.
 */
export function staticRoot(repo: string, depth = 2): string | null {
  if (existsSync(path.join(repo, "index.html"))) return "";
  const walk = (rel: string, d: number): string | null => {
    if (d > depth) return null;
    let names: string[];
    try { names = readdirSync(path.join(repo, rel)); } catch { return null; }
    for (const n of names.sort()) {
      if (NOT_A_ROOT.has(n) || n.startsWith(".")) continue;
      const sub = rel ? `${rel}/${n}` : n;
      let st;
      try { st = statSync(path.join(repo, sub)); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (existsSync(path.join(repo, sub, "index.html"))) return sub;
    }
    for (const n of names.sort()) {
      if (NOT_A_ROOT.has(n) || n.startsWith(".")) continue;
      const sub = rel ? `${rel}/${n}` : n;
      try { if (!statSync(path.join(repo, sub)).isDirectory()) continue; } catch { continue; }
      const deeper = walk(sub, d + 1);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk("", 1);
}

/** Decide how to build this frontend. */
export function planBuild(repo: string, framework: Framework): BuildPlan | { error: string } {
  const pkg = readPkg(repo);

  if (framework === "static") {
    const root = staticRoot(repo);
    if (root === null) return { error: "this is a static site but no index.html could be found at or near the project root" };
    return { framework, needsInstall: false, buildCommand: null, expectOutput: root, rationale: `a static site: no build step, served from ${root === "" ? "the project root" : root}` };
  }

  if (!pkg) return { error: `a ${framework} project needs a package.json to build and none is present` };
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const hasBuildScript = typeof pkg.scripts?.build === "string" && pkg.scripts.build.trim().length > 0;

  if (hasBuildScript) {
    return {
      framework, needsInstall: true, buildCommand: ["npm", "run", "build"],
      expectOutput: framework === "vite" ? "dist" : "build",
      rationale: `"npm run build" (${pkg.scripts!.build.slice(0, 80)}), output expected in ${framework === "vite" ? "dist/" : "build/"}`,
    };
  }

  // No build script. For Vite the local binary is enough, and running it directly avoids inventing a script in
  // the Founder's package.json — the project is not modified to suit the pipeline.
  if (framework === "vite" || "vite" in deps) {
    return {
      framework, needsInstall: true, buildCommand: ["node", "node_modules/vite/bin/vite.js", "build"],
      expectOutput: "dist",
      rationale: "no build script, so Vite's own binary is run directly rather than adding a script to the project",
    };
  }

  return { error: `a ${framework} project with no "build" script cannot be built; add one to package.json or export a static site` };
}

/**
 * Install and build, inside the sandbox, then find and check the output.
 *
 * Returns `ok: false` with the real stderr rather than throwing: a frontend that does not build is an answer the
 * import workflow has to report to a person, not an exception.
 */
export async function buildFrontend(o: {
  sandbox: BuildSandbox;
  /** The repo path on the host, for fingerprinting and for finding the output. */
  repo: string;
  plan: BuildPlan;
  installTimeoutMs?: number;
  buildTimeoutMs?: number;
}): Promise<BuildResult> {
  const { plan, repo } = o;
  const problems: string[] = [];
  const before = sourceFingerprint(repo);

  const base: Omit<BuildResult, "ok" | "outputRoot"> = {
    plan, install: null, build: null, preserved: true,
    sourceBefore: before.sha, sourceAfter: before.sha, problems,
  };

  // A static site is already the deliverable.
  if (!plan.buildCommand) {
    const root = plan.expectOutput;
    const index = path.join(repo, root, "index.html");
    if (!existsSync(index)) {
      problems.push(`the static site has no index.html at ${root || "the project root"}`);
      return { ...base, ok: false, outputRoot: null };
    }
    return { ...base, ok: true, outputRoot: root };
  }

  let install: SandboxRun | null = null;
  if (plan.needsInstall) {
    install = await o.sandbox.install();
    if (install.code !== 0) {
      problems.push(install.timedOut
        ? `dependency installation timed out; the frontend's dependencies could not be fetched`
        : `dependency installation failed (exit ${install.code}): ${(install.stderr || install.stdout).slice(0, 600)}`);
      return { ...base, ok: false, outputRoot: null, install };
    }
  }

  const build = await o.sandbox.argv(plan.buildCommand, o.buildTimeoutMs, plan.buildCommand.join(" "));
  if (build.code !== 0) {
    problems.push(build.timedOut
      ? `the frontend build timed out`
      : `the frontend build failed (exit ${build.code}): ${(build.stderr || build.stdout).slice(0, 800)}`);
    return { ...base, ok: false, outputRoot: null, install, build };
  }

  // Where the output actually landed, decided by looking rather than by trusting the plan: a project may set its
  // own outDir, and a build that wrote nowhere must not be reported as a success.
  const found = [plan.expectOutput, ...OUTPUT_CANDIDATES].find((d) => d && existsSync(path.join(repo, d, "index.html"))) ?? null;
  if (!found) {
    problems.push(`the build reported success but produced no index.html in ${[plan.expectOutput, ...OUTPUT_CANDIDATES].filter(Boolean).join(", ")}; there is nothing to render`);
    return { ...base, ok: false, outputRoot: null, install, build };
  }
  if (found !== plan.expectOutput) {
    problems.push(`the output is in ${found}/ rather than the expected ${plan.expectOutput}/ — using ${found}/`);
  }

  // The measurement that matters: the Founder's source is untouched.
  const after = sourceFingerprint(repo);
  const preserved = after.sha === before.sha && after.files === before.files;
  if (!preserved) {
    problems.push(`the build modified the project's own source or assets (${before.files} → ${after.files} files, fingerprint ${String(before.sha).slice(0, 12)} → ${String(after.sha).slice(0, 12)}); the imported frontend must be preserved exactly`);
  }

  return { ok: preserved, outputRoot: found, plan, install, build, preserved, sourceBefore: before.sha, sourceAfter: after.sha, problems };
}

export function describeBuild(r: BuildResult): string {
  const head = r.ok
    ? `built as a ${r.plan.framework} project; serving ${r.outputRoot === "" ? "the project root" : `${r.outputRoot}/`}`
    : `the ${r.plan.framework} frontend did not build`;
  const notes = [
    r.plan.rationale,
    r.install ? `install exit ${r.install.code}` : null,
    r.build ? `build exit ${r.build.code}` : null,
    r.preserved ? "the imported source and assets are byte-identical before and after" : "THE IMPORTED SOURCE WAS MODIFIED",
    ...r.problems,
  ].filter(Boolean);
  return `${head}\n  - ${notes.join("\n  - ")}`;
}
