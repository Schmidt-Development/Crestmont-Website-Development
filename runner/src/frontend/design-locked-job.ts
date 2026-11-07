// The build, for a project whose frontend a person has already approved.
//
// This is a SEPARATE path, not a branch threaded through `job.ts`. The legacy pipeline is still running live
// projects, and the safest way to add a second kind of build is to give it its own entry point rather than
// adding conditionals to a 1,900-line function that already carries the old architecture's phases. `job.ts`
// delegates here when the claim says the project is design-locked, and otherwise never reaches this file.
//
// The sequence is fixed and each step refuses to continue without the one before it:
//
//   fetch the approved artifact (signed channel, hash verified)
//     → ingest and build it (sandbox)
//       → measure it (browser)
//         → Model B implements the backend against the manifest
//           → conformance + functional + visual, all three, independently run
//             → bounded repair cycles while they make measurable progress

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Workspace } from "../workspace.ts";
import type { JobSandbox } from "../sandbox.ts";
import type { AgentProvider } from "../providers/types.ts";
import type { RunTracker, StopSwitch } from "../agent.ts";
import type { ApprovedArtifact, Job } from "../protocol.ts";
import type { Logger } from "../log.ts";
import { ingestArtifact } from "./ingest.ts";
import { buildFrontend, planBuild } from "./build.ts";
import { baselineFrom, describeImport, readImportReport, verifyAgainstBaseline } from "./import.ts";
import type { ImportReport } from "./import.ts";
import { IMPORT_OUT, IMPORT_SCRIPT, writeBaseline } from "./workflow.ts";
import type { DesignBaseline, DriftFinding } from "./design-lock.ts";
import { checkConformance, describeConformance, repairBrief } from "./conformance.ts";
import type { ConformanceReport } from "./conformance.ts";
import { integrationMemory, integrationPrompt, readIntegrationOutcome } from "./integrate.ts";
import { acceptancePlan, coverageChecks, readAcceptanceOutput, summarise, writeAcceptanceDriver, writeAcceptanceResults, DRIVER } from "./acceptance.ts";
import { completeness, validateManifest } from "./integration-manifest.ts";
import type { IntegrationManifest, ManifestContract } from "./integration-manifest.ts";

/** How many repair cycles a build may spend. Each one must make measurable progress to earn the next. */
export const MAX_REPAIR_CYCLES = 3;

export interface DesignLockedDeps {
  job: Job;
  ws: Workspace;
  sandbox: JobSandbox;
  provider: AgentProvider;
  tracker: RunTracker;
  stop: StopSwitch;
  log: Logger;
  /** Fetches the approved artifact over the signed channel. */
  fetchArtifact: () => Promise<ApprovedArtifact | null>;
  /** The integration manifest for this project, when the platform has one. */
  manifest?: (IntegrationManifest & ManifestContract) | null;
  maxTurns: number;
  maxWallMs: number;
  /** Where the verification script writes. Overridable for tests. */
  importOut?: string;
}

export interface CycleRecord {
  cycle: number;
  /** What this cycle was asked to do. */
  intent: "integration" | "repair";
  conformance: { ok: boolean; violations: string[]; violationDetails?: string[] };
  functional: { ran: boolean; ok: boolean; detail: string };
  visual: { ran: boolean; ok: boolean; detail: string };
  changedFiles: number;
  /** Did this cycle move anything? A cycle that fixes nothing does not earn another. */
  progressed: boolean;
}

export interface DesignLockedResult {
  ok: boolean;
  /** Where it stopped, when it did not finish. */
  failedAt: "artifact" | "ingest" | "build" | "measure" | "manifest" | "integration" | "verification" | null;
  artifact: ApprovedArtifact | null;
  baseline: DesignBaseline | null;
  report: ImportReport | null;
  cycles: CycleRecord[];
  problems: string[];
  /** Everything a person needs to see on the dashboard, in words. */
  summary: string;
}

/**
 * A snapshot of the project's own files: relative path -> size and modification time.
 *
 * `changedFiles` in the cycle record used to be the literal 0. The build record therefore told whoever read it
 * that a cycle had changed nothing even when Model B had just written a server and nine endpoints. Nothing
 * BEHAVED wrongly — the repair loop's `progressed` is computed from the violation counts, not from this — but the
 * evidence a person reads to decide what happened said something untrue.
 *
 * Deliberately not `git status`: this path runs with a workspace that may have no repository, and a count that
 * silently reads 0 whenever git is absent is the defect this replaces rather than a fix for it.
 */
function fileSnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const skip = /^(node_modules|dist|build|\.git|\.crestmont|\.vite|\.cache)$/;
  const walk = (dir: string, rel: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        try { const st = statSync(abs); out.set(r, `${st.size}:${st.mtimeMs}`); } catch { /* vanished mid-walk */ }
      }
    }
  };
  walk(root, "");
  return out;
}

/** Files added, removed or rewritten between two snapshots. */
function countChanged(before: Map<string, string>, after: Map<string, string>): number {
  let n = 0;
  for (const [p, sig] of after) if (before.get(p) !== sig) n++;
  for (const p of before.keys()) if (!after.has(p)) n++;
  return n;
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function bytesFromBase64(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

/**
 * Run a design-locked build.
 *
 * Never throws for an ordinary failure: a frontend that will not build, a model that cannot satisfy the
 * contract and an artifact that fails its hash are all ANSWERS the platform has to record and show someone,
 * not exceptions. It throws only when the workspace itself is unusable.
 */
export async function runDesignLockedJob(d: DesignLockedDeps): Promise<DesignLockedResult> {
  const problems: string[] = [];
  const cycles: CycleRecord[] = [];
  const out: DesignLockedResult = {
    ok: false, failedAt: null, artifact: null, baseline: null, report: null, cycles, problems, summary: "",
  };
  const note = (message: string) => d.tracker.note({ kind: "step", message });
  const importOut = d.importOut ?? IMPORT_OUT;

  // ── 1. the approved artifact ──────────────────────────────────────────────────────────────────────────────
  note("fetching the approved frontend artifact");
  const artifact = await d.fetchArtifact();
  if (!artifact) {
    out.failedAt = "artifact";
    problems.push("the platform has no approved frontend artifact for this project, so there is nothing to build against");
    return finish(out);
  }
  out.artifact = artifact;

  const bytes = bytesFromBase64(artifact.base64);
  const actual = sha256(bytes);
  if (actual !== artifact.sha256) {
    // The platform already checked this; the runner checks it again because it is the party about to unpack it.
    out.failedAt = "artifact";
    problems.push(`the artifact's bytes do not match the hash the platform authorised (${artifact.sha256.slice(0, 12)}… vs ${actual.slice(0, 12)}…); nothing was unpacked`);
    return finish(out);
  }
  if (!artifact.scanned) {
    out.failedAt = "artifact";
    problems.push(`the artifact was delivered without a scan verdict (status "${artifact.scanStatus}"); a build does not unpack an unscanned archive`);
    return finish(out);
  }
  note(`artifact v${artifact.version} verified (${(bytes.length / 1024).toFixed(0)} KB, ${artifact.framework ?? "unknown"}, ${artifact.scanStatus})`);

  // ── 2. ingest ─────────────────────────────────────────────────────────────────────────────────────────────
  const ingest = ingestArtifact({
    bytes: Buffer.from(bytes), destDir: d.ws.repo, source: "customer-upload",
    scan: { status: artifact.scanStatus },
  });
  if (!ingest.ok || !ingest.framework) {
    out.failedAt = "ingest";
    problems.push(...ingest.problems.map((p) => `${p.severity} ${p.code}: ${p.detail}`));
    return finish(out);
  }
  note(`imported as a ${ingest.framework} project (${ingest.extracted?.files ?? 0} files)`);

  // ── 3. build ──────────────────────────────────────────────────────────────────────────────────────────────
  const plan = planBuild(d.ws.repo, ingest.framework);
  if ("error" in plan) {
    out.failedAt = "build";
    problems.push(plan.error);
    return finish(out);
  }
  const built = await buildFrontend({ sandbox: d.sandbox, repo: d.ws.repo, plan });
  if (!built.ok || built.outputRoot === null) {
    out.failedAt = "build";
    problems.push(...built.problems);
    return finish(out);
  }
  note(`built; serving ${built.outputRoot || "the project root"}; the imported source is unchanged`);

  // ── 4. measure ────────────────────────────────────────────────────────────────────────────────────────────
  const measured = await d.sandbox.argv(["node", IMPORT_SCRIPT, "--root", built.outputRoot || ".", "--out", importOut], undefined, "frontend-import");
  if (measured.code !== 0) {
    out.failedAt = "measure";
    problems.push(`measuring the frontend failed (exit ${measured.code}): ${(measured.stderr || measured.stdout).slice(0, 500)}`);
    return finish(out);
  }
  let report: ImportReport;
  try { report = readImportReport(path.join(d.ws.repo, importOut)); }
  catch (err) { out.failedAt = "measure"; problems.push(String((err as Error)?.message ?? err)); return finish(out); }
  out.report = report;

  const baseline = baselineFrom(report, {
    artifactSha: artifact.sha256,
    sourceFingerprint: built.sourceAfter,
    approvedBy: `Founder (baseline v${artifact.baselineVersion})`,
  });
  out.baseline = baseline;
  writeBaseline(d.ws.repo, baseline);

  // The design the PLATFORM approved is the one that counts. If re-measuring this artifact produces a different
  // design, something has changed between approval and now and the build must not quietly proceed.
  if (baseline.fingerprint !== artifact.designFingerprint) {
    problems.push(`the frontend renders a different design from the one approved (approved ${artifact.designFingerprint.slice(0, 12)}…, measured ${baseline.fingerprint.slice(0, 12)}…). The build continues against the APPROVED baseline, and this difference is recorded for a person.`);
  }
  note(describeImport(report).split("\n")[0]);

  // ── 5. the contract ───────────────────────────────────────────────────────────────────────────────────────
  const manifest = d.manifest ?? null;
  if (!manifest) {
    out.failedAt = "manifest";
    problems.push("this project has no integration manifest, so there is no contract to build against and nothing to verify an implementation with");
    return finish(out);
  }
  const checked = validateManifest(manifest, {
    approvedPages: [...new Set(report.signatures.map((s) => s.page))],
    artifactSha: artifact.sha256,
  });
  if (!checked.ok || !checked.manifest) {
    out.failedAt = "manifest";
    problems.push(...checked.problems.filter((p) => p.severity === "reject").map((p) => `${p.code}: ${p.detail}`));
    return finish(out);
  }
  const gaps = completeness(manifest);
  for (const b of gaps.blockers) problems.push(`contract blocker ${b.code}: ${b.detail}`);

  const approvedPackage = existsSync(path.join(d.ws.repo, "package.json"))
    ? JSON.parse(readFileSync(path.join(d.ws.repo, "package.json"), "utf8")) as Record<string, unknown>
    : null;

  // ── 6. Model B, then verification, then bounded repair ────────────────────────────────────────────────────
  let prompt = integrationPrompt({ manifest, baseline, report, outputRoot: built.outputRoot, framework: ingest.framework });
  let previousViolations: string[] = [];

  for (let cycle = 1; cycle <= MAX_REPAIR_CYCLES + 1; cycle++) {
    if (d.stop.reason) { problems.push(`stopped: ${d.stop.reason}`); break; }
    const intent: CycleRecord["intent"] = cycle === 1 ? "integration" : "repair";
    note(`${intent} cycle ${cycle}`);

    const before = fileSnapshot(d.ws.repo);
    const run = await d.provider.run({
      phase: intent === "integration" ? "build" : "repair",
      prompt, maxTurns: d.maxTurns, maxBudgetUsd: 0, maxWallMs: d.maxWallMs,
      resumeSessionId: null, tracker: d.tracker, stop: d.stop,
      task: intent === "integration" ? "backend integration" : "contract repair",
      memory: () => integrationMemory(report, baseline),
    });
    if (run.status === "stopped") { problems.push(`${intent} cycle ${cycle} was stopped: ${run.stoppedBy ?? "unknown"}`); break; }
    // Counted here, before the rebuild and the gates, so it reflects what the MODEL did and not what verifying it did.
    const changedFiles = countChanged(before, fileSnapshot(d.ws.repo));

    // Model B does NOT get to say whether its own work is done. Each of these runs independently.
    const conf = checkConformance({ repo: d.ws.repo, manifest, baselinePackage: approvedPackage });
    const rebuilt = await d.sandbox.argv(["npm", "run", "build"], undefined, "npm run build");
    const visual = rebuilt.code !== 0
      ? { ran: false, ok: false, detail: `the project no longer builds (exit ${rebuilt.code})` }
      : await measureVisual(d, baseline, report, built.outputRoot, importOut, cycle, manifest);
    const functional = await runFunctional(d, manifest);

    const broken = conf.findings.filter((f) => f.severity === "violation");
    const violations = broken.map((f) => f.code);
    // Codes drive the progress comparison below -- they are stable and comparable. The detail is what a person
    // reads, so it is kept beside them rather than thrown away: three bare "table-not-defined" told nobody which
    // three tables, and that is what the gate's whole value depends on saying.
    const violationDetails = broken.map((f) => (f.file ? `${f.file}: ` : "") + f.detail);
    const progressed = cycle === 1 || violations.length < previousViolations.length
      || violations.some((v) => !previousViolations.includes(v)) === false && violations.length < previousViolations.length;

    cycles.push({
      cycle, intent,
      conformance: { ok: conf.ok, violations, violationDetails },
      functional, visual,
      changedFiles,
      progressed: cycle === 1 ? true : progressed,
    });

    if (conf.ok && functional.ok && visual.ok) {
      out.ok = true;
      note(`cycle ${cycle}: conforms, works, and the approved design held`);
      break;
    }

    // A cycle that fixed nothing does not earn another: that is how an afternoon disappears.
    if (cycle > 1 && !progressed) {
      problems.push(`repair cycle ${cycle} changed nothing measurable (${violations.length} violation(s) before and after); stopping rather than repeating it`);
      break;
    }
    if (cycle === MAX_REPAIR_CYCLES + 1) {
      problems.push(`${MAX_REPAIR_CYCLES} repair cycle(s) did not satisfy all three gates; escalating for a person`);
      break;
    }

    previousViolations = violations;
    const next = nextPrompt(conf, functional, visual, cycle);
    if (!next) {
      problems.push("the implementation does not pass, and there is nothing specific enough to ask for a repair of");
      break;
    }
    prompt = next;
  }

  if (!out.ok && !out.failedAt) out.failedAt = "verification";
  const last = cycles[cycles.length - 1];
  if (last) {
    if (!last.conformance.ok) problems.push(`contract: ${(last.conformance.violationDetails ?? last.conformance.violations).join("; ")}`);
    if (!last.functional.ok) problems.push(`functional: ${last.functional.detail}`);
    if (!last.visual.ok) problems.push(`visual: ${last.visual.detail}`);
  }
  return finish(out);
}

/** Re-render and compare with the approved baseline. */
async function measureVisual(
  d: DesignLockedDeps, baseline: DesignBaseline, before: ImportReport, outputRoot: string, importOut: string, cycle: number,
  manifest: IntegrationManifest & ManifestContract,
): Promise<CycleRecord["visual"]> {
  const dir = `${importOut}-cycle-${cycle}`;
  const r = await d.sandbox.argv(["node", IMPORT_SCRIPT, "--root", outputRoot || ".", "--out", dir], undefined, "frontend-import (verify)");
  if (r.code !== 0) return { ran: false, ok: false, detail: `re-measuring failed (exit ${r.code})` };
  let after: ImportReport;
  try { after = readImportReport(path.join(d.ws.repo, dir)); }
  catch (err) { return { ran: false, ok: false, detail: String((err as Error)?.message ?? err) }; }

  // The manifest, or the declarations in it are never read. `declaredChanges(manifest)` is what tells the drift
  // comparison which pages the backend was authorised to change the content of; without it `declared` is empty and
  // every rendering change is reported as "nothing in the integration manifest said this page would change" --
  // which is every successful build, since connecting a backend is what changes what a page renders. Measured on
  // the second Northgate run: the design signature held on all 21 page views and the gate still failed with 9
  // undeclared-content findings. A signature change is still design-drift whatever the manifest claims; this only
  // restores the content declarations the contract already carries.
  const v = verifyAgainstBaseline(baseline, after, { before, manifest });
  const drifted = v.drift.findings.filter((f) => f.kind !== "declared-content");
  const ok = v.drift.ok && v.stateChanges.length === 0;
  return {
    ran: true, ok,
    detail: ok
      ? `the approved design held across ${v.drift.compared} page view(s)`
      : visualSummary(drifted, v.stateChanges.length),
  };
}

/**
 * What drifted, in words that identify it.
 *
 * This printed `${page} [${aspects}]` and nothing else, so a build that had lost three components reported
 * "staff [palette, skeleton]" three times. Measured on the Northgate run: the approved staff page carries three
 * summary cards whose `h3` headings hold the only two accent colours on it, and Model B's rewrite deleted the whole
 * block. The finding already knew that -- `detail` names the elements that went and the approved colours no longer
 * painted -- and both this summary and the REPAIR BRIEF threw it away, so neither the person reading the result nor
 * the model asked to fix it was ever told what had changed. Two repair cycles changed nothing on this gate.
 */
export function visualSummary(drifted: readonly DriftFinding[], stateChanges: number): string {
  const head = `${drifted.length} drift finding(s)${stateChanges ? `, ${stateChanges} interactive state(s) changed` : ""}`;
  const each = drifted.slice(0, 3).map((f) => {
    const where = `${f.page}${f.viewport ? ` at ${f.viewport}` : ""}`;
    const what = f.aspects.length ? ` [${f.aspects.join(", ")}]` : "";
    return `${where}${what}${f.detail ? `: ${f.detail}` : ""}`;
  });
  return `${head}: ${each.join("; ")}${drifted.length > 3 ? `; and ${drifted.length - 3} more` : ""}`;
}

/**
 * Run the project's own acceptance checks.
 *
 * Independently executed, which is the point: Model B's opinion that its work is finished is not evidence. A
 * project that ships no runnable check reports that it could not be verified — never that it passed.
 */
async function runFunctional(d: DesignLockedDeps, manifest: IntegrationManifest & ManifestContract): Promise<CycleRecord["functional"]> {
  // The INDEPENDENT checks first, and they are the only ones that can make this gate pass.
  //
  // This used to look for `verify-backend.mjs` and run it. Model B writes that file, so the model authored both
  // the implementation and the test that judged it: a verifier that exits 0 without asserting anything produced
  // "all acceptance checks passed". Executing someone's own test independently does not make it independent.
  //
  // The integration manifest is what is independent. It is written before the work, it belongs to the project,
  // and its `apis` state per endpoint the status a well-formed, an invalid and an unauthenticated request must
  // each get. The runner writes its own driver from that, rewrites it every cycle so the model cannot edit it,
  // and runs it against the started application.
  const plan = acceptancePlan(d.ws.repo, manifest);
  writeAcceptanceDriver(d.ws.repo, plan);
  const run = await d.sandbox.argv(["node", "--no-warnings", DRIVER], undefined, "contract acceptance");
  const executed = readAcceptanceOutput(run.stdout);
  const verdict = summarise(executed);

  // A verifier the model wrote is run too, because it may exercise business flows the contract cannot describe
  // without credentials. It is corroboration and never the reason this gate passes: the independent checks above
  // have to pass first, and its own failure still fails the gate.
  const authored = ["verify-backend.mjs", "server/verify-backend.mjs", "test/acceptance.mjs"]
    .find((c) => existsSync(path.join(d.ws.repo, c)));
  let corroborated = false;
  let corroboration = "; the model produced no acceptance check of its own";
  if (authored) {
    const r = await d.sandbox.argv(["node", "--no-warnings", authored], undefined, "model-authored acceptance");
    corroborated = r.code === 0;
    corroboration = corroborated
      ? `; the model's own ${authored} also passed (corroboration only — it did not decide this gate)`
      : `; the model's own ${authored} failed (exit ${r.code}): ${(r.stdout || r.stderr).slice(-300)}`;
  }

  // The manifest's per-operation acceptance lines are narrower than anything executed above: "a submitted request
  // is stored as a row in appointments with status 'requested'" names a table and a value, and nothing here reads
  // the database. Where there is no corroboration at all they are reported one by one as UNDETERMINED, with their
  // own text, because that is the list the six-artifact campaign has to work through. Undetermined is never a pass.
  const checks = corroborated ? [...executed] : [...executed, ...coverageChecks(manifest)];
  writeAcceptanceResults(d.ws.repo, checks);
  const full = summarise(checks);

  // A model verifier that FAILED is evidence against, so it fails the gate even when the contract checks passed.
  if (authored && !corroborated && verdict.ok) {
    return { ran: true, ok: false, detail: `${verdict.detail}${corroboration}` };
  }
  return { ran: full.ran, ok: full.ok, detail: `${full.detail}${corroboration}` };
}


/** What to ask for next, built from whichever gate failed. */
function nextPrompt(conf: ConformanceReport, functional: CycleRecord["functional"], visual: CycleRecord["visual"], cycle: number): string | null {
  if (!conf.ok) return repairBrief(conf, { attempt: cycle, maxAttempts: MAX_REPAIR_CYCLES });

  const parts: string[] = ["# Repair", ""];
  parts.push(`Repair ${cycle} of ${MAX_REPAIR_CYCLES}. The implementation matches the contract. What is wrong is below.`);
  parts.push("");
  parts.push("**Do not change any visual design, markup structure, class name or style.** The frontend is approved and locked.");
  parts.push("");
  if (!visual.ok) {
    parts.push("## The approved design no longer renders as approved");
    parts.push(visual.detail);
    parts.push("");
    parts.push("**Do this:** find the change that altered the rendering and undo that part of it, keeping the backend behaviour. Do not redesign the page to match: restore what was approved.");
    parts.push("");
  }
  if (!functional.ok) {
    parts.push("## It does not work");
    parts.push(functional.detail);
    parts.push("");
    parts.push(functional.ran
      ? "**Do this:** fix the failing behaviour. Do not weaken the check to make it pass."
      : "**Do this:** write a runnable acceptance check that exercises each acceptance criterion against the real application, and make it pass. A criterion nobody can run is not satisfied.");
    parts.push("");
  }
  return parts.length > 5 ? parts.join("\n") : null;
}

function finish(out: DesignLockedResult): DesignLockedResult {
  const lines: string[] = [];
  if (out.artifact) lines.push(`artifact v${out.artifact.version} (${out.artifact.framework ?? "unknown"}), baseline v${out.artifact.baselineVersion}`);
  if (out.report) lines.push(describeImport(out.report).split("\n").slice(0, 3).join("\n"));
  for (const c of out.cycles) {
    lines.push(`cycle ${c.cycle} (${c.intent}): contract ${c.conformance.ok ? "ok" : (c.conformance.violationDetails ?? c.conformance.violations).join("; ")}; functional ${c.functional.ok ? "ok" : c.functional.detail}; visual ${c.visual.ok ? "ok" : c.visual.detail}`);
  }
  lines.push(out.ok
    ? "RESULT: the backend conforms to the contract, the acceptance checks pass, and the approved design held."
    : `RESULT: not complete${out.failedAt ? ` (stopped at ${out.failedAt})` : ""}.`);
  lines.push(...out.problems);
  out.summary = lines.join("\n");
  return out;
}

/** Write the evidence a person reads on the dashboard. */
export function writeEvidence(ws: Workspace, r: DesignLockedResult): string {
  const dir = path.join(ws.repo, ".crestmont");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "design-locked-result.json");
  writeFileSync(file, JSON.stringify({
    schema: "crestmont.design-locked-result/1",
    ok: r.ok, failedAt: r.failedAt,
    artifact: r.artifact ? { id: r.artifact.artifactId, version: r.artifact.version, sha256: r.artifact.sha256, framework: r.artifact.framework, scanStatus: r.artifact.scanStatus } : null,
    baseline: r.baseline ? { fingerprint: r.baseline.fingerprint, pages: r.baseline.signatures.length } : null,
    cycles: r.cycles, problems: r.problems, summary: r.summary,
  }, null, 2) + "\n");
  return file;
}

export { readIntegrationOutcome };
