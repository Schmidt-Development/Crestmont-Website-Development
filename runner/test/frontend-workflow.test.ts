// The gated import workflow: five steps, each refusing to run without the one before it.
//
// The sandbox is faked here on purpose — Docker is exercised for real by `ci/frontend-import-poc.ts`, and what
// this file is for is the ORDER and the REFUSALS, which are easier to be sure of when every step can be made to
// fail on demand. The import report the fake measurement step writes is the real one from that Docker run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BASELINE_FILE, importFrontend, preserveOriginal, readBaseline, verifyDesignHeld, writeBaseline } from "../src/frontend/workflow.ts";
import type { ImportSandbox } from "../src/frontend/workflow.ts";
import { makeZip, zipDirectory } from "./fixtures/zip-writer.ts";
import type { DesignBaseline } from "../src/frontend/design-lock.ts";

const REAL = path.resolve(import.meta.dirname, "fixtures/real-import");
const FIXTURE = path.resolve(import.meta.dirname, "fixtures/summit-haul-frontend");
const tmp = () => mkdtempSync(path.join(tmpdir(), "fe-wf-"));

const run = (code = 0, stdout = "", stderr = "") => ({ code, stdout, stderr, timedOut: false, command: "fake" });

/**
 * A sandbox that records what it was asked to do.
 *
 * `onMeasure` writes the import report the real Docker run produced, so the steps after measurement are driven
 * by real data rather than by something invented to make them pass.
 */
function fakeSandbox(o: { repo: string; installCode?: number; buildCode?: number; measureCode?: number; report?: string; onBuild?: () => void } = { repo: "" }): ImportSandbox & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async install() {
      calls.push("install");
      return run(o.installCode ?? 0);
    },
    async argv(argv: string[]) {
      const label = argv.join(" ");
      if (label.includes("frontend-import.mjs")) {
        calls.push("measure");
        if ((o.measureCode ?? 0) !== 0) return run(o.measureCode!, "", "the browser did not start");
        const out = path.join(o.repo, argv[argv.indexOf("--out") + 1]);
        mkdirSync(out, { recursive: true });
        cpSync(o.report ?? path.join(REAL, "import-baseline.json"), path.join(out, "import.json"));
        return run(0);
      }
      calls.push("build");
      o.onBuild?.();
      if ((o.buildCode ?? 0) !== 0) return run(o.buildCode!, "", "vite: command not found");
      // A real build writes its output; the workflow checks for it rather than trusting the exit code.
      const dist = path.join(o.repo, "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(path.join(dist, "index.html"), "<!doctype html><div id=root></div>");
      return run(0);
    },
  };
}

const archive = () => zipDirectory(FIXTURE, { prefix: "summit-haul-frontend" });

test("[WF-001] a customer upload with no clean scan never reaches the sandbox", async () => {
  const repo = path.join(tmp(), "repo");
  const sandbox = fakeSandbox({ repo });

  const out = await importFrontend({
    archive: archive(), source: "customer-upload", scan: { status: "pending" },
    repo, sandbox, approvedBy: "Founder",
  });

  assert.equal(out.ok, false);
  assert.equal(out.failedAt, "ingest");
  assert.deepEqual(sandbox.calls, [], "nothing was installed, built or rendered");
  assert.ok(!existsSync(repo) || !existsSync(path.join(repo, "package.json")), "and nothing was extracted");
  assert.equal(out.ingest!.scanned, false);
});

test("[WF-002] the five steps run in order, and the baseline is written where it can be found again", async () => {
  const repo = path.join(tmp(), "repo");
  const sandbox = fakeSandbox({ repo });

  const out = await importFrontend({
    archive: archive(), source: "internal-fixture",
    repo, sandbox, approvedBy: "Founder (Noah)",
  });

  assert.equal(out.ok, true, out.problems.join("; "));
  assert.deepEqual(sandbox.calls, ["install", "build", "measure"], "install, then build, then measure");
  assert.equal(out.ingest!.framework, "vite");
  assert.equal(out.build!.preserved, true, "the imported source is byte-identical before and after");
  assert.equal(out.report!.signatures.length, 9);
  assert.equal(out.baseline!.approvedBy, "Founder (Noah)");
  assert.equal(out.baseline!.artifactSha, out.ingest!.artifactSha, "the baseline is tied to the archive it came from");

  // Written into the repo, under .crestmont/ — evidence, not part of the website.
  const file = path.join(repo, BASELINE_FILE);
  assert.ok(existsSync(file));
  const reread = readBaseline(repo)!;
  assert.equal(reread.fingerprint, out.baseline!.fingerprint);
  assert.ok(!existsSync(path.join(repo, "dist", ".crestmont")), "and not inside the built site");
});

test("[WF-003] a failing step stops the workflow there, with the real reason", async () => {
  const noInstall = path.join(tmp(), "repo");
  let out = await importFrontend({ archive: archive(), source: "internal-fixture", repo: noInstall, sandbox: fakeSandbox({ repo: noInstall, installCode: 1 }), approvedBy: "F" });
  assert.equal(out.failedAt, "build");
  assert.match(out.problems.join(" "), /dependency installation failed/);

  const noBuild = path.join(tmp(), "repo");
  out = await importFrontend({ archive: archive(), source: "internal-fixture", repo: noBuild, sandbox: fakeSandbox({ repo: noBuild, buildCode: 1 }), approvedBy: "F" });
  assert.equal(out.failedAt, "build");
  assert.match(out.problems.join(" "), /vite: command not found/, "the toolchain's own words, not a summary");

  const noMeasure = path.join(tmp(), "repo");
  const sb = fakeSandbox({ repo: noMeasure, measureCode: 2 });
  out = await importFrontend({ archive: archive(), source: "internal-fixture", repo: noMeasure, sandbox: sb, approvedBy: "F" });
  assert.equal(out.failedAt, "measure");
  assert.equal(out.baseline, null, "no baseline is frozen from a run that could not measure the pages");
  assert.deepEqual(sb.calls, ["install", "build", "measure"]);
});

test("[WF-004] a build that modified the imported source is not accepted", async () => {
  // The Founder's frontend is the deliverable. A build step that rewrites it has changed the thing that was
  // approved, whatever its exit code said.
  const repo = path.join(tmp(), "repo");
  const sandbox = fakeSandbox({
    repo,
    onBuild: () => writeFileSync(path.join(repo, "src", "styles.css"), "/* the build rewrote this */"),
  });

  const out = await importFrontend({ archive: archive(), source: "internal-fixture", repo, sandbox, approvedBy: "F" });
  assert.equal(out.ok, false);
  assert.equal(out.failedAt, "build");
  assert.equal(out.build!.preserved, false);
  assert.match(out.problems.join(" "), /modified the project's own source or assets/);
  assert.match(out.problems.join(" "), /must be preserved exactly/);
});

test("[WF-005] a plan for the wrong design stops the import before any work is planned", async () => {
  const repo = path.join(tmp(), "repo");
  const manifest = JSON.parse(readFileSync(path.join(REAL, "integration-manifest.json"), "utf8"));

  const out = await importFrontend({
    archive: archive(), source: "internal-fixture", repo, sandbox: fakeSandbox({ repo }), approvedBy: "F",
    manifest: { ...manifest, designFingerprint: "0".repeat(64) },
  });

  assert.equal(out.ok, false);
  assert.equal(out.failedAt, "plan");
  assert.ok(out.manifestProblems.some((p) => p.code === "design-mismatch"), JSON.stringify(out.manifestProblems));
  assert.ok(out.baseline, "the baseline was still frozen: the design is fine, the plan is not");
});

test("[WF-006] a plan that matches is checked against the real inventory", async () => {
  const repo = path.join(tmp(), "repo");
  // First freeze, to learn this run's fingerprints.
  const first = await importFrontend({ archive: archive(), source: "internal-fixture", repo, sandbox: fakeSandbox({ repo }), approvedBy: "F" });
  assert.ok(first.ok);

  const repo2 = path.join(tmp(), "repo");
  const manifest = JSON.parse(readFileSync(path.join(REAL, "integration-manifest.json"), "utf8"));
  const out = await importFrontend({
    archive: archive(), source: "internal-fixture", repo: repo2, sandbox: fakeSandbox({ repo: repo2 }), approvedBy: "F",
    manifest: { ...manifest, artifactSha: first.ingest!.artifactSha, designFingerprint: first.baseline!.fingerprint },
  });

  assert.equal(out.ok, true, out.problems.join("; ") + JSON.stringify(out.manifestProblems));
  assert.ok(out.verify);
  assert.equal(out.verify!.coverage!.needingBackend, 1);
  assert.deepEqual(out.verify!.coverage!.uncovered, [], "the quote form is on the plan");
  assert.deepEqual(out.verify!.declared, [{ page: "quote", expect: "content", reason: "quote-request-submit (form#quote-request)" }]);
});

test("[WF-007] verification refuses to pass when there is no baseline to compare against", async () => {
  const repo = path.join(tmp(), "repo");
  mkdirSync(repo, { recursive: true });
  const r = await verifyDesignHeld({ repo, sandbox: fakeSandbox({ repo }), outputRoot: "dist" });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /no frozen design baseline/);
  assert.equal(r.verify, null);
});

test("[WF-008] verification compares a fresh measurement with the frozen baseline", async () => {
  const repo = path.join(tmp(), "repo");
  mkdirSync(repo, { recursive: true });
  const baseline = JSON.parse(readFileSync(path.join(REAL, "design-baseline.json"), "utf8")) as DesignBaseline;
  writeBaseline(repo, baseline);

  const held = await verifyDesignHeld({
    repo, sandbox: fakeSandbox({ repo, report: path.join(REAL, "import-after-integration.json") }), outputRoot: "dist",
  });
  assert.equal(held.ok, true, JSON.stringify(held.verify?.drift.findings));
  assert.equal(held.verify!.drift.compared, 9);

  const drifted = await verifyDesignHeld({
    repo, sandbox: fakeSandbox({ repo, report: path.join(REAL, "import-after-drift.json") }), outputRoot: "dist",
  });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.verify!.drift.findings.filter((f) => f.kind === "design-drift").length, 9);
});

test("[WF-009] the original frontend is kept recoverable, without the build's leavings", async () => {
  const repo = path.join(tmp(), "repo");
  const out = await importFrontend({ archive: archive(), source: "internal-fixture", repo, sandbox: fakeSandbox({ repo }), approvedBy: "F" });
  assert.ok(out.ok);
  mkdirSync(path.join(repo, "node_modules", "react"), { recursive: true });
  writeFileSync(path.join(repo, "node_modules", "react", "index.js"), "// huge");

  const kept = path.join(tmp(), "original");
  preserveOriginal(repo, kept);

  assert.ok(existsSync(path.join(kept, "package.json")), "the Founder's project is there");
  assert.ok(existsSync(path.join(kept, "src", "styles.css")));
  assert.ok(!existsSync(path.join(kept, "node_modules")), "but not the installed dependencies");
  assert.ok(!existsSync(path.join(kept, "dist")), "nor the build output");
  assert.ok(!existsSync(path.join(kept, ".crestmont")), "nor our own evidence");
});

test("[WF-010] an archive that is not a frontend at all is refused before anything runs", async () => {
  const repo = path.join(tmp(), "repo");
  const sandbox = fakeSandbox({ repo });
  const out = await importFrontend({
    archive: makeZip([{ path: "main.py", body: "print('hi')" }, { path: "requirements.txt", body: "django==5.0" }]),
    source: "internal-fixture", repo, sandbox, approvedBy: "F",
  });
  assert.equal(out.ok, false);
  assert.equal(out.failedAt, "ingest");
  assert.deepEqual(sandbox.calls, []);
  assert.match(out.problems.join(" "), /no supported frontend was recognised/);
});
