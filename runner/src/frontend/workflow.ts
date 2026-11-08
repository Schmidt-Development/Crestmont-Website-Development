// The design-locked import, end to end: an archive in, a frozen baseline and a checked plan out.
//
// GATED, AND SEPARATE. Nothing here is reachable from the existing build path. `job.ts` is untouched; a project
// enters this workflow only when something explicitly calls `importFrontend`, which is how an unfinished
// workflow is kept away from the projects the legacy pipeline is still running. The obsolete design-generation
// code is not deleted either — the directive is explicit that removal waits until the replacement is verified
// and no supported project or rollback path still reaches it.
//
// The five steps, in order, each refusing to go on without the one before it:
//
//   ingest (scan gate, verdict, extraction) → build (sandbox) → measure (browser) → freeze → check the plan.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sourceFingerprint } from "../orchestrator/repair-effect.ts";
import { buildFrontend, planBuild } from "./build.ts";
import type { BuildResult, BuildSandbox } from "./build.ts";
import { describeIngest, ingestArtifact } from "./ingest.ts";
import type { ArtifactSource, IngestResult, ScanGate } from "./ingest.ts";
import { baselineFrom, describeImport, readImportReport, verifyAgainstBaseline } from "./import.ts";
import { describePinned, discoverRefs, pinExternalAssets } from "./pin-assets.ts";
import { isVisual, visualImpact } from "./external-assets.ts";
import type { PinOutcome, ResolveAssets } from "./pin-assets.ts";
import type { ImportReport, VerifyResult } from "./import.ts";
import type { DesignBaseline } from "./design-lock.ts";
import { validateManifest } from "./integration-manifest.ts";
import type { IntegrationManifest, ManifestProblem } from "./integration-manifest.ts";

/** Where the measurement script lives inside the sandbox image. */
export const IMPORT_SCRIPT = "/opt/crestmont/frontend-import.mjs";
/** Where its output lands, relative to the repo root. Inside `.crestmont/`, which is evidence, not the website. */
export const IMPORT_OUT = ".crestmont/import";

export interface ImportSandbox extends BuildSandbox {
  argv(argv: string[], timeoutMs?: number, label?: string): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; command: string }>;
}

export interface ImportOutcome {
  ok: boolean;
  /** The step that stopped it, or null when every step ran. */
  failedAt: "ingest" | "build" | "measure" | "freeze" | "plan" | null;
  ingest: IngestResult | null;
  build: BuildResult | null;
  report: ImportReport | null;
  baseline: DesignBaseline | null;
  manifestProblems: ManifestProblem[];
  verify: VerifyResult | null;
  problems: string[];
  /**
   * The artifact's external dependencies, acquired and written in before anything was measured.
   *
   * Null when no resolver was supplied, which is how a caller that cannot reach the platform behaves: the import
   * then measures the artifact as it stands, exactly as it did before, and says nothing it cannot support.
   */
  assets: PinOutcome | null;
}

/**
 * Import an approved frontend.
 *
 * `approvedBy` is required: the baseline records who approved the design, and under this architecture that is a
 * person. `manifest` is optional — an import can freeze a baseline before any plan exists.
 */
export async function importFrontend(o: {
  archive: Buffer;
  source: ArtifactSource;
  scan?: ScanGate;
  /** The job's repo directory. The frontend is extracted here. */
  repo: string;
  /**
   * Acquires the artifact's external dependencies through the platform, which has the network and the rules.
   *
   * Optional, and absent means "do not": an import with no resolver measures what is in the archive, which is
   * the old behaviour and is still correct for an artifact that references nothing external.
   */
  resolveAssets?: ResolveAssets;
  sandbox: ImportSandbox;
  approvedBy: string;
  manifest?: unknown;
  buildTimeoutMs?: number;
  measureTimeoutMs?: number;
}): Promise<ImportOutcome> {
  const out: ImportOutcome = {
    ok: false, failedAt: null, ingest: null, build: null, report: null,
    baseline: null, manifestProblems: [], verify: null, problems: [], assets: null,
  };

  // ── 1. ingest ───────────────────────────────────────────────────────────────────────────────────────────────
  const ingest = ingestArtifact({ bytes: o.archive, destDir: o.repo, source: o.source, scan: o.scan });
  out.ingest = ingest;
  if (!ingest.ok || !ingest.framework) {
    out.failedAt = "ingest";
    out.problems.push(describeIngest(ingest));
    return out;
  }
  // Ingest's own warnings on a SUCCESSFUL import, which used to be dropped: only the failure path described the
  // ingest at all. That the entry point was renamed, or that an install hook was found, is something the owner
  // should read on the project page rather than something only the runner's log knows.
  for (const p of ingest.problems) {
    if (p.severity === "warn") out.problems.push(`${p.code}${p.path ? ` (${p.path})` : ""}: ${p.detail}`);
  }

  // ── 1b. the external assets ─────────────────────────────────────────────────────────────────────────────────
  //
  // Before the build and before the measurement, because both of them must see the same files a visitor would.
  // The measurement container has no network: without this step a site whose typography comes from a font CDN is
  // measured in a fallback face, and that becomes the approved design.
  //
  // A failure to ACQUIRE is not a failure to import. The design is measured either way; what changes is that a
  // missing visual dependency is reported, and the platform refuses to approve a baseline that has any.
  if (o.resolveAssets) {
    try {
      out.assets = await pinExternalAssets({ repo: o.repo, resolve: o.resolveAssets });
      out.problems.push(describePinned(out.assets));
    } catch (err) {
      out.problems.push(`the external assets could not be resolved: ${String((err as Error)?.message ?? err).slice(0, 300)}`);
    }
  } else {
    // NO RESOLVER AT ALL, which must not pass quietly.
    //
    // Acquisition needs the control plane, so a caller can legitimately have none. Discovery does not: it reads
    // the files. The platform refuses approval of a baseline that has a REFUSED asset row, and with no attempt
    // there are no rows -- so "nobody tried" was indistinguishable from "nothing was needed", and a law firm
    // design whose typography and four photographs come from CDNs measured in a fallback face with no images and
    // was approved. Say it here, where the import's own problems are read.
    const unacquired = discoverRefs(o.repo).filter((r) => isVisual(r.kind));
    if (unacquired.length) {
      out.problems.push(
        `${unacquired.length} external visual dependenc${unacquired.length === 1 ? "y was" : "ies were"} NOT acquired, because this import was given no way to fetch them: ` +
        unacquired.slice(0, 6).map((r) => `${r.url} (${visualImpact(r.kind, r.url)})`).join("; ") +
        `. The design was measured without them, so this measurement is not what a visitor would see.`,
      );
    }
  }

  // ── 2. build ────────────────────────────────────────────────────────────────────────────────────────────────
  const plan = planBuild(o.repo, ingest.framework);
  if ("error" in plan) {
    out.failedAt = "build";
    out.problems.push(plan.error);
    return out;
  }
  const build = await buildFrontend({ sandbox: o.sandbox, repo: o.repo, plan, buildTimeoutMs: o.buildTimeoutMs });
  out.build = build;
  if (!build.ok || build.outputRoot === null) {
    out.failedAt = "build";
    out.problems.push(...build.problems);
    return out;
  }

  // ── 3. measure ──────────────────────────────────────────────────────────────────────────────────────────────
  const measured = await o.sandbox.argv(
    ["node", IMPORT_SCRIPT, "--root", build.outputRoot || ".", "--out", IMPORT_OUT],
    o.measureTimeoutMs,
    "frontend-import",
  );
  if (measured.code !== 0) {
    out.failedAt = "measure";
    out.problems.push(measured.timedOut
      ? "measuring the imported frontend timed out"
      : `measuring the imported frontend failed (exit ${measured.code}): ${(measured.stderr || measured.stdout).slice(0, 600)}`);
    return out;
  }

  let report: ImportReport;
  try {
    report = readImportReport(path.join(o.repo, IMPORT_OUT));
  } catch (err) {
    out.failedAt = "measure";
    out.problems.push(String((err as Error)?.message ?? err));
    return out;
  }
  out.report = report;

  // ── 4. freeze ───────────────────────────────────────────────────────────────────────────────────────────────
  try {
    out.baseline = baselineFrom(report, {
      artifactSha: ingest.artifactSha,
      // The fingerprint of the SOURCE, not of the build output: that is what later work must not disturb.
      sourceFingerprint: sourceFingerprint(o.repo).sha,
      approvedBy: o.approvedBy,
    });
  } catch (err) {
    out.failedAt = "freeze";
    out.problems.push(String((err as Error)?.message ?? err));
    return out;
  }
  writeBaseline(o.repo, out.baseline);

  // ── 5. the plan, when there is one ──────────────────────────────────────────────────────────────────────────
  if (o.manifest !== undefined) {
    const approvedPages = [...new Set(report.signatures.map((s) => s.page))];
    const checked = validateManifest(o.manifest, {
      approvedPages,
      designFingerprint: out.baseline.fingerprint,
      artifactSha: ingest.artifactSha,
    });
    out.manifestProblems = checked.problems;
    if (!checked.ok || !checked.manifest) {
      out.failedAt = "plan";
      out.problems.push(...checked.problems.filter((p) => p.severity === "reject").map((p) => `${p.code}: ${p.detail}`));
      return out;
    }
    out.verify = verifyAgainstBaseline(out.baseline, report, { manifest: checked.manifest });
  }

  out.ok = true;
  out.problems.push(...report.problems);
  return out;
}

/** Where a frozen baseline is kept inside the job's repo. Evidence, not part of the website. */
export const BASELINE_FILE = ".crestmont/design-baseline.json";

export function writeBaseline(repo: string, baseline: DesignBaseline): string {
  const file = path.join(repo, BASELINE_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(baseline, null, 2) + "\n");
  return file;
}

export function readBaseline(repo: string): DesignBaseline | null {
  const file = path.join(repo, BASELINE_FILE);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as DesignBaseline; } catch { return null; }
}

/**
 * Re-measure a project after backend work and compare it with the frozen baseline.
 *
 * This is the gate the integration phase has to pass: the design the Founder approved is still what renders.
 */
export async function verifyDesignHeld(o: {
  repo: string;
  sandbox: ImportSandbox;
  outputRoot: string;
  manifest?: IntegrationManifest;
  /** The import taken when the baseline was frozen, for comparing interactive states. */
  before?: ImportReport;
  measureTimeoutMs?: number;
  /** Where to put this measurement, so it does not overwrite the baseline's own. */
  out?: string;
}): Promise<{ ok: boolean; verify: VerifyResult | null; report: ImportReport | null; problems: string[] }> {
  const baseline = readBaseline(o.repo);
  if (!baseline) return { ok: false, verify: null, report: null, problems: [`no frozen design baseline at ${BASELINE_FILE}; there is nothing to compare against`] };

  const outDir = o.out ?? ".crestmont/import-after";
  const measured = await o.sandbox.argv(
    ["node", IMPORT_SCRIPT, "--root", o.outputRoot || ".", "--out", outDir],
    o.measureTimeoutMs,
    "frontend-import (verify)",
  );
  if (measured.code !== 0) {
    return { ok: false, verify: null, report: null, problems: [`re-measuring the frontend failed (exit ${measured.code}): ${(measured.stderr || measured.stdout).slice(0, 600)}`] };
  }

  let report: ImportReport;
  try { report = readImportReport(path.join(o.repo, outDir)); }
  catch (err) { return { ok: false, verify: null, report: null, problems: [String((err as Error)?.message ?? err)] }; }

  const verify = verifyAgainstBaseline(baseline, report, { manifest: o.manifest, before: o.before });
  return {
    ok: verify.drift.ok && verify.stateChanges.length === 0,
    verify,
    report,
    problems: verify.stateChanges.map((s) => `an interactive state changed: ${s.key}`),
  };
}

/** A copy of the imported frontend, kept so the original is always recoverable. */
export function preserveOriginal(repo: string, to: string): void {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(repo, to, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|dist|build|\.crestmont|\.git)([\\/]|$)/.test(src),
  });
}

export function describeOutcome(o: ImportOutcome): string {
  const lines: string[] = [];
  if (o.ingest) lines.push(describeIngest(o.ingest));
  if (o.build) lines.push(o.build.preserved ? `built; the imported source is byte-identical before and after` : `BUILT BUT THE IMPORTED SOURCE WAS MODIFIED`);
  if (o.report) lines.push(describeImport(o.report));
  if (o.baseline) lines.push(`design frozen as ${o.baseline.fingerprint.slice(0, 16)}… across ${o.baseline.signatures.length} page view(s), approved by ${o.baseline.approvedBy}`);
  if (o.manifestProblems.length) lines.push(...o.manifestProblems.map((p) => `${p.severity.toUpperCase()} ${p.code}: ${p.detail}`));
  if (!o.ok) lines.push(`STOPPED AT: ${o.failedAt}`);
  lines.push(...o.problems);
  return lines.join("\n");
}
