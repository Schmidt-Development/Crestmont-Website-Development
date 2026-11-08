// The design-locked build, end to end through the orchestrator — without a model or Docker.
//
// What this pins down is the SEQUENCE and the REFUSALS: that a build fetches the artifact it was authorised to
// have and verifies it itself; that all three gates run independently; that Model B's own opinion is never the
// thing that decides; and that a repair cycle which fixes nothing does not earn another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_REPAIR_CYCLES, gateScore, measureProgress, runDesignLockedJob, writeEvidence } from "../src/frontend/design-locked-job.ts";
import type { DesignLockedDeps } from "../src/frontend/design-locked-job.ts";
import { zipDirectory } from "./fixtures/zip-writer.ts";
import { RunTracker, StopSwitch } from "../src/agent.ts";
import { silentLogger } from "../src/log.ts";
import { baselineFingerprint } from "../src/frontend/design-lock.ts";
import type { ApprovedArtifact, Job } from "../src/protocol.ts";
import type { IntegrationManifest, ManifestContract } from "../src/frontend/integration-manifest.ts";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/summit-haul-frontend");
const REAL = path.resolve(import.meta.dirname, "fixtures/real-import");
const tmp = () => mkdtempSync(path.join(tmpdir(), "dlj-"));

const ARCHIVE = zipDirectory(FIXTURE, { prefix: "summit-haul-frontend" });
const ARCHIVE_SHA = createHash("sha256").update(ARCHIVE).digest("hex");

const artifact = (over: Partial<ApprovedArtifact> = {}): ApprovedArtifact => ({
  artifactId: "fa_1", version: 1, baselineId: "dbl_1", baselineVersion: 1,
  designFingerprint: "239cc2854af8f6ee".padEnd(64, "0"),
  sha256: ARCHIVE_SHA, sizeBytes: ARCHIVE.length, framework: "vite", archiveRoot: "summit-haul-frontend",
  filename: "frontend.zip", base64: ARCHIVE.toString("base64"), scanStatus: "clean", scanned: true,
  ...over,
});

const MANIFEST: IntegrationManifest & ManifestContract = {
  schema: "crestmont.integration-manifest/1", artifactSha: ARCHIVE_SHA, designFingerprint: "d".repeat(64),
  operations: [{
    id: "quote-submit", page: "quote", element: "form#quote-request", kind: "form-submit",
    behaviour: "Persist a quote request.", expectChange: "content",
    acceptance: ["a submitted request is stored", "an invalid request is refused with 422"],
    dataModel: [{ table: "quote_requests", fields: ["name", "email"] }],
  }],
  dataModels: [{ table: "quote_requests", fields: ["name", "email", "created_at"] }],
  persistence: { enforcement: "required", technology: "sqlite", durable: true },
};

/** A sandbox that records what it was asked to run, and can be told how each command behaves. */
function fakeSandbox(o: {
  repo: string;
  buildCode?: number;
  measureCode?: number;
  report?: string;
  acceptanceCode?: number;
  /** Exit code of a verifier the model wrote, which is corroboration only. */
  modelAcceptanceCode?: number;
  /** Make the driver report a build-machine problem rather than a result about the application. */
  acceptanceEnvironment?: boolean;
  /** Called on each `npm run build`, so a test can mutate the repo the way a model would. */
  onBuild?: (n: number) => void;
}) {
  const calls: string[] = [];
  /** The exact argv of every command the job treated as a rebuild, so "none was run" is provable. */
  const buildLabels: string[] = [];
  let builds = 0;
  const run = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr, timedOut: false, command: "fake" });
  return {
    calls, buildLabels,
    async install() { calls.push("install"); return run(0); },
    async argv(argv: string[]) {
      const label = argv.join(" ");
      if (label.includes("frontend-import.mjs")) {
        calls.push(`measure:${argv[argv.indexOf("--out") + 1]}`);
        if ((o.measureCode ?? 0) !== 0) return run(o.measureCode!, "", "the browser did not start");
        const dir = path.join(o.repo, argv[argv.indexOf("--out") + 1]);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "import.json"), readFileSync(o.report ?? path.join(REAL, "import-baseline.json")));
        return run(0);
      }
      // The runner's OWN contract driver. It prints one JSON line of results, so the fake prints the same shape:
      // a fake that printed prose would make `summarise` report "no result", which is a failure and would be
      // indistinguishable from a real driver that crashed.
      if (label.includes("contract-acceptance.mjs")) {
        calls.push("contract-acceptance");
        if (o.acceptanceEnvironment) {
          return run(1, JSON.stringify({ results: [{
            id: "app:starts", ok: false, undetermined: true, environment: true,
            detail: "the port the application was given (8099) was taken while it was starting, so it could not be exercised; this is an environment failure on the build machine and not a result about the application",
          }] }));
        }
        const results = o.acceptanceCode
          ? [{ id: "app:starts", ok: true, detail: "started" },
             { id: "POST /api/x :: refuses anonymous", ok: false, detail: "declared 401, answered 200" }]
          : [{ id: "app:starts", ok: true, detail: "started" },
             { id: "POST /api/x :: refuses anonymous", ok: true, detail: "401 as declared" }];
        return run(o.acceptanceCode ?? 0, JSON.stringify({ results }));
      }
      // A verifier the MODEL wrote. Corroboration only: it can never make the gate pass.
      if (label.includes("verify-backend") || label.includes("acceptance")) {
        calls.push("acceptance");
        return run(o.modelAcceptanceCode ?? 0, o.modelAcceptanceCode ? "2/10 checks passed" : "10/10 checks passed");
      }
      calls.push("build");
      buildLabels.push(label);
      builds++;
      o.onBuild?.(builds);
      if ((o.buildCode ?? 0) !== 0) return run(o.buildCode!, "", "vite: command not found");
      mkdirSync(path.join(o.repo, "dist"), { recursive: true });
      writeFileSync(path.join(o.repo, "dist", "index.html"), "<!doctype html><div id=root></div>");
      return run(0);
    },
  };
}

/** A provider that writes whatever a cycle is supposed to have produced, and records the prompts it was given. */
function fakeProvider(o: { repo: string; onCycle?: (n: number, prompt: string) => void; status?: "success" | "stopped" } = { repo: "" }) {
  const prompts: string[] = [];
  let n = 0;
  return {
    prompts,
    id: "local" as const, paid: false, capabilities: [],
    async preflight() { return { errors: [], warnings: [] }; },
    async prepare() { /* nothing to do */ },
    async run(req: { prompt: string }) {
      n++;
      prompts.push(req.prompt);
      o.onCycle?.(n, req.prompt);
      return { status: o.status ?? "success", error: null, stoppedBy: o.status === "stopped" ? "test" : null };
    },
    async close() { /* nothing to do */ },
  };
}

const job = (over: Partial<Job> = {}): Job => ({
  id: "bld_dl", projectId: "prj_dl", attempt: 1, kind: "first_build", revision: 0,
  leaseToken: "t".repeat(64), leaseExpiresAt: "", heartbeatSeconds: 30, strategy: "standard",
  packageId: "business", starter: null,
  brief: { id: "b", version: 1, sha256: "x", content: {} as never },
  instruction: null, requirements: [], limits: {} as never, resume: null,
  ...over,
} as unknown as Job);

function deps(over: Partial<DesignLockedDeps> & { repo: string }): DesignLockedDeps {
  const ws = { dir: path.dirname(over.repo), ref: "ws", home: path.join(path.dirname(over.repo), "home"), repo: over.repo, tmp: "", checkpoints: "" };
  mkdirSync(ws.repo, { recursive: true });
  return {
    job: job(), ws: ws as never,
    sandbox: fakeSandbox({ repo: over.repo }) as never,
    provider: fakeProvider({ repo: over.repo }) as never,
    tracker: new RunTracker(), stop: new StopSwitch(), log: silentLogger,
    fetchArtifact: async () => artifact(),
    manifest: MANIFEST, maxTurns: 10, maxWallMs: 60_000,
    ...over,
  };
}

/** Make the repo conform: a real sqlite server with the contract's table. */
function writeConformingBackend(repo: string): void {
  writeFileSync(path.join(repo, "server.js"), [
    'import { DatabaseSync } from "node:sqlite";',
    'const db = new DatabaseSync("./data/site.db");',
    'db.exec(`CREATE TABLE IF NOT EXISTS quote_requests (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL)`);',
    'export function store(row) { db.prepare("INSERT INTO quote_requests VALUES (?,?,?,?)").run(row.id, row.name, row.email, row.at); }',
  ].join("\n"));
  writeFileSync(path.join(repo, "verify-backend.mjs"), "console.log('10/10 checks passed');\n");
}

test("[DLJ-01] a conforming, working, visually intact build completes", async () => {
  const repo = path.join(tmp(), "repo");
  const sandbox = fakeSandbox({ repo });
  const provider = fakeProvider({ repo, onCycle: () => writeConformingBackend(repo) });

  const r = await runDesignLockedJob(deps({ repo, sandbox: sandbox as never, provider: provider as never }));

  assert.equal(r.ok, true, r.summary);
  assert.equal(r.failedAt, null);
  assert.equal(r.cycles.length, 1, "it passed first time, so no repair was spent");
  assert.equal(r.cycles[0].intent, "integration");
  assert.ok(r.cycles[0].conformance.ok, r.cycles[0].conformance.violations.join(","));
  assert.ok(r.cycles[0].functional.ok, r.cycles[0].functional.detail);
  assert.ok(r.cycles[0].visual.ok, r.cycles[0].visual.detail);
  assert.match(r.summary, /the backend conforms to the contract, the acceptance checks pass, and the approved design held/);

  // Every gate really ran, in the sandbox, independently of what the model said.
  assert.ok(sandbox.calls.includes("acceptance"), sandbox.calls.join(","));
  assert.ok(sandbox.calls.filter((c) => c.startsWith("measure")).length >= 2, "measured once for the baseline and again to compare");
});

test("[DLJ-02] the artifact is verified by the runner before anything is unpacked", async () => {
  // The platform checks the hash too. The runner checks it again because it is the party about to unpack it.
  const repo = path.join(tmp(), "repo");
  const sandbox = fakeSandbox({ repo });
  const tampered = await runDesignLockedJob(deps({
    repo, sandbox: sandbox as never,
    fetchArtifact: async () => artifact({ sha256: "0".repeat(64) }),
  }));
  assert.equal(tampered.ok, false);
  assert.equal(tampered.failedAt, "artifact");
  assert.match(tampered.problems.join(" "), /do not match the hash the platform authorised/);
  assert.deepEqual(sandbox.calls, [], "nothing was built or measured");
  assert.ok(!existsSync(path.join(repo, "package.json")), "and nothing was extracted");

  // An artifact delivered without a scan verdict is refused outright.
  const unscanned = await runDesignLockedJob(deps({ repo: path.join(tmp(), "repo"), fetchArtifact: async () => artifact({ scanned: false, scanStatus: "pending" }) }));
  assert.equal(unscanned.failedAt, "artifact");
  assert.match(unscanned.problems.join(" "), /without a scan verdict/);

  // No approved artifact at all: the build says so rather than falling back to generating a frontend.
  const none = await runDesignLockedJob(deps({ repo: path.join(tmp(), "repo"), fetchArtifact: async () => null }));
  assert.equal(none.failedAt, "artifact");
  assert.match(none.problems.join(" "), /no approved frontend artifact/);
});

test("[DLJ-03] Model B cannot certify its own work: all three gates run independently", async () => {
  const repo = path.join(tmp(), "repo");
  // The model claims success and writes a summary saying it is done — but produces a JSON file store, which
  // violates the contract, and no acceptance check at all.
  const provider = fakeProvider({
    repo,
    onCycle: () => {
      writeFileSync(path.join(repo, "server.js"), [
        'import { writeFileSync, readFileSync } from "node:fs";',
        'const DATA = "./data/records.json";',
        'export function store(rows) { writeFileSync(DATA, JSON.stringify(rows)); }',
      ].join("\n"));
      mkdirSync(path.join(repo, ".crestmont"), { recursive: true });
      writeFileSync(path.join(repo, ".crestmont", "integration-summary.md"), "Fully implemented and verified. No open questions.");
    },
  });

  const r = await runDesignLockedJob(deps({ repo, provider: provider as never }));

  assert.equal(r.ok, false, "its own claim of success is not evidence");
  const first = r.cycles[0];
  assert.equal(first.conformance.ok, false);
  assert.ok(first.conformance.violations.includes("file-substituted-for-database"), first.conformance.violations.join(","));
  assert.equal(first.functional.ok, false);
  // The independent contract driver DID run — it is the runner's own, so it always does — and it still does not
  // make this gate pass, because the manifest's written acceptance criteria describe behaviour nothing exercised.
  // Unverified is not verified, whatever the model wrote about itself.
  assert.equal(first.functional.ran, true, "the runner's own driver runs whether or not the model wrote a test");
  assert.match(first.functional.detail, /could not be evaluated/, "and an unverifiable criterion is not a passing one");
  assert.match(first.functional.detail, /the model produced no acceptance check of its own/);
  // Each unestablished criterion is named, because that list is what has to be worked through next.
  assert.match(first.functional.detail, /acceptance\[0\]/, "the criteria are reported one by one, not as a count");
  const results = JSON.parse(readFileSync(path.join(repo, ".crestmont", "acceptance", "results.json"), "utf8")) as
    { counts: { pass: number; fail: number; undetermined: number }; checks: { id: string; undetermined?: boolean }[] };
  assert.ok(results.counts.undetermined > 0, "the undetermined criteria are kept as diagnostics beside the plan");
  assert.ok(results.checks.some((c) => c.undetermined && /acceptance\[/.test(c.id)));
  assert.match(r.summary, /RESULT: not complete/);
});

test("[DLJ-04] a contract violation is repaired, and the repair brief says what not to touch", async () => {
  const repo = path.join(tmp(), "repo");
  const provider = fakeProvider({
    repo,
    onCycle: (n) => {
      if (n === 1) {
        writeFileSync(path.join(repo, "server.js"), 'import { writeFileSync } from "node:fs";\nconst D = "./x.json";\nexport function store(r) { writeFileSync(D, JSON.stringify(r)); }');
        writeFileSync(path.join(repo, "verify-backend.mjs"), "console.log('ok');\n");
      } else {
        writeConformingBackend(repo);           // the repair lands
      }
    },
  });

  const r = await runDesignLockedJob(deps({ repo, provider: provider as never }));

  assert.equal(r.ok, true, r.summary);
  assert.equal(r.cycles.length, 2);
  assert.equal(r.cycles[0].intent, "integration");
  assert.equal(r.cycles[1].intent, "repair");
  assert.equal(r.cycles[0].conformance.ok, false);
  assert.equal(r.cycles[1].conformance.ok, true);

  // The second prompt is a repair brief, and it restates the design lock.
  const brief = provider.prompts[1];
  assert.match(brief, /does not match the approved contract/);
  assert.match(brief, /Store the data in sqlite/);
  assert.match(brief, /change any visual design, markup structure, class name or style/);
  assert.match(brief, /the behaviour you built is correct/, "it does not tell the model its working code was wrong");
});

test("[DLJ-05] a repair that fixes nothing does not earn another", async () => {
  // The failure this exists for: an afternoon of identical repair cycles.
  const repo = path.join(tmp(), "repo");
  const provider = fakeProvider({
    repo,
    onCycle: () => {
      writeFileSync(path.join(repo, "server.js"), 'import { writeFileSync } from "node:fs";\nconst D = "./x.json";\nexport function store(r) { writeFileSync(D, JSON.stringify(r)); }');
      writeFileSync(path.join(repo, "verify-backend.mjs"), "console.log('ok');\n");
    },
  });

  const r = await runDesignLockedJob(deps({ repo, provider: provider as never }));

  assert.equal(r.ok, false);
  assert.ok(r.cycles.length <= MAX_REPAIR_CYCLES + 1, `bounded (${r.cycles.length} cycles)`);
  assert.ok(r.cycles.length < MAX_REPAIR_CYCLES + 1, "and it stopped EARLY rather than spending every cycle");
  assert.match(r.problems.join(" "), /changed nothing measurable/);
  assert.equal(r.cycles.at(-1)!.progressed, false);
});

test("[DLJ-06] the visual gate is part of the verdict, not an afterthought", async () => {
  // Narrower than it looks, and said so on purpose. The fake sandbox returns the same report for every
  // measurement, so the baseline and the comparison agree by construction; what this pins is that the visual
  // gate RUNS on every cycle and that its result reaches the verdict and the summary. Drift detection itself is
  // proved against real before/after renders in `frontend-import-real.test.ts` ([REAL-005], [REAL-006]).
  const repo = path.join(tmp(), "repo");
  const sandbox = fakeSandbox({ repo });
  const provider = fakeProvider({ repo, onCycle: () => writeConformingBackend(repo) });
  const r = await runDesignLockedJob(deps({ repo, sandbox: sandbox as never, provider: provider as never }));

  assert.equal(r.cycles[0].visual.ran, true, "the visual gate was executed");
  assert.match(r.cycles[0].visual.detail, /page view/);
  assert.match(r.summary, /visual/);

  // It really re-rendered rather than reusing the baseline measurement.
  const measurements = sandbox.calls.filter((c) => c.startsWith("measure"));
  assert.ok(measurements.length >= 2, measurements.join(","));
  assert.notEqual(measurements[0], measurements[1], "the comparison writes to its own directory");
});

test("[DLJ-07] a frontend that will not build, or will not render, stops before Model B is asked for anything", async () => {
  const repo = path.join(tmp(), "repo");
  const provider = fakeProvider({ repo });
  const noBuild = await runDesignLockedJob(deps({ repo, sandbox: fakeSandbox({ repo, buildCode: 1 }) as never, provider: provider as never }));
  assert.equal(noBuild.failedAt, "build");
  assert.match(noBuild.problems.join(" "), /vite: command not found/);
  assert.equal(provider.prompts.length, 0, "no model time was spent on a frontend that does not build");

  const repo2 = path.join(tmp(), "repo");
  const provider2 = fakeProvider({ repo: repo2 });
  const noMeasure = await runDesignLockedJob(deps({ repo: repo2, sandbox: fakeSandbox({ repo: repo2, measureCode: 2 }) as never, provider: provider2 as never }));
  assert.equal(noMeasure.failedAt, "measure");
  assert.equal(provider2.prompts.length, 0);
});

test("[DLJ-08] a project with no integration manifest is stopped, not improvised", async () => {
  const repo = path.join(tmp(), "repo");
  const provider = fakeProvider({ repo });
  const r = await runDesignLockedJob(deps({ repo, manifest: null, provider: provider as never }));

  assert.equal(r.failedAt, "manifest");
  assert.match(r.problems.join(" "), /no integration manifest/);
  assert.match(r.problems.join(" "), /nothing to verify an implementation with/);
  assert.equal(provider.prompts.length, 0, "a model is not asked to guess the contract");
});

test("[DLJ-09] the evidence a person reads is written to the workspace", async () => {
  const repo = path.join(tmp(), "repo");
  const provider = fakeProvider({ repo, onCycle: () => writeConformingBackend(repo) });
  const d = deps({ repo, provider: provider as never });
  const r = await runDesignLockedJob(d);

  const file = writeEvidence(d.ws, r);
  assert.ok(existsSync(file));
  const ev = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(ev.schema, "crestmont.design-locked-result/1");
  assert.equal(ev.ok, true);
  assert.equal(ev.artifact.sha256, ARCHIVE_SHA);
  assert.equal(ev.artifact.scanStatus, "clean");
  assert.ok(ev.baseline.fingerprint);
  assert.equal(ev.cycles.length, 1);
  assert.ok(ev.summary.includes("RESULT"));
});

test("[DLJ-10] a measured design that differs from the approved one is reported, not silently accepted", async () => {
  const repo = path.join(tmp(), "repo");
  const provider = fakeProvider({ repo, onCycle: () => writeConformingBackend(repo) });
  const r = await runDesignLockedJob(deps({
    repo, provider: provider as never,
    fetchArtifact: async () => artifact({ designFingerprint: "9".repeat(64) }),
  }));

  assert.match(r.problems.join(" "), /renders a different design from the one approved/);
  assert.match(r.problems.join(" "), /continues against the APPROVED baseline/, "and says which one it used");
});

test("[DLJ-WIRE] a design-locked build reports its outcome to the platform, like every other build", () => {
  // This asserts the WIRING in runner/src/job.ts, by reading it, because the behaviour needs Docker, a model and a
  // control plane and is covered end to end by scripts/design-locked-e2e.ts --stage full. The invariant is worth a
  // cheap guard of its own because losing it is silent and expensive:
  //
  // The branch used to end `return designLockedSummary(dl)`. `designLockedSummary` sets `complete: null`, and
  // nothing else sends a completion — runner/src/main.ts only reads `summary.outcome` for its health record. So a
  // design-locked build told the platform NOTHING. The job sat in `building` until its lease expired and the sweep
  // failed it: no outcome, no report, no gate findings, no reason. Three independent gates had run and a person
  // could see none of it.
  const src = readFileSync(path.resolve(import.meta.dirname, "../src/job.ts"), "utf8").replace(/\r\n/g, "\n");
  const branch = /if \(job\.designLocked && sandbox\) \{([\s\S]*?)\n    \}/.exec(src);
  assert.ok(branch, "the design-locked branch of runJob was not found");
  // Comments stripped: this branch EXPLAINS the defect it fixes, and the explanation names the very code the
  // assertions below forbid.
  const body = branch[1].replace(/^\s*\/\/.*$/gm, "");

  assert.match(body, /return finish\(/, "the design-locked branch must complete through `finish`, the one path that calls client.complete");
  assert.doesNotMatch(body, /return designLockedSummary\(/, "a bare return skips the completion entirely: the platform never learns the outcome");
  assert.match(body, /checks: dls\.checks/, "the three gate outcomes must reach the platform, not just the verdict");
  assert.match(body, /stopReason: dls\.stopReason/, "the blocking reason is what a person reads first");

  // `finish` is what turns those checks into requirement evidence and composes the report.
  assert.match(src, /const finish = async \(outcome: Outcome, fields: \{[^}]*checks\?: CheckOutcome\[\]/, "finish still takes the checks");
  assert.match(src, /await client\.complete\(job, req\)/, "finish still reports to the platform");
});

test("[DLJ-11] the starter's own pages are not mistaken for a change to the approved design", async () => {
  // Measured on Node 1 (run 42405202273). The Founder's fixtures each measure ONE page, `index`, in three
  // viewports. A design-locked build lays the artifact over the starter, so the same fixture measured
  //
  //   index, public, public/404, public/admin, public/booking/confirmation, public/booking/manage
  //
  // and `baselineFingerprint` hashes every signature it is given. Eighteen against three can never match, so
  // every design-locked build reported "the frontend renders a different design from the one approved" and
  // finished `stopped` -- while the three `index` signatures were byte-for-byte identical to the approved ones.
  const report = JSON.parse(readFileSync(path.join(REAL, "import-baseline.json"), "utf8")) as {
    signatures: { page: string; viewport: string }[];
  };
  const pages = [...new Set(report.signatures.map((s) => s.page))];
  assert.ok(pages.length > 1, `the fixture must measure several pages for this test to mean anything: ${pages.join(", ")}`);

  // The approved design is ONE of those pages. The others stand in for what the starter brings.
  const approvedPage = pages[0];
  const approvedSignatures = report.signatures.filter((s) => s.page === approvedPage);
  const approvedFingerprint = baselineFingerprint(approvedSignatures as never);

  const repo = path.join(tmp(), "repo");
  const provider = fakeProvider({ repo, onCycle: () => writeConformingBackend(repo) });
  const r = await runDesignLockedJob(deps({
    repo, provider: provider as never,
    fetchArtifact: async () => artifact({ designFingerprint: approvedFingerprint }),
    fetchApprovedBaseline: async () => ({ signatures: approvedSignatures }),
  }));

  assert.ok(
    !r.problems.some((p) => /renders a different design from the one approved/.test(p)),
    `the approved page was reproduced exactly, so nothing should claim the design changed: ${JSON.stringify(r.problems)}`,
  );
  assert.ok(
    !r.problems.some((p) => /no longer render at all/.test(p)),
    `and the approved page does render: ${JSON.stringify(r.problems)}`,
  );

  // Without the approved page list the old, wider comparison still applies: the same build then reports the
  // difference, because it is comparing three signatures against all of them.
  const wider = await runDesignLockedJob(deps({
    repo: path.join(tmp(), "repo2"), provider: fakeProvider({ repo: path.join(tmp(), "repo2") }) as never,
    fetchArtifact: async () => artifact({ designFingerprint: approvedFingerprint }),
  }));
  assert.ok(
    wider.problems.some((p) => /renders a different design from the one approved/.test(p)),
    "the fallback is unchanged, so an older platform behaves exactly as before",
  );
});

test("[DLJ-12] an approved page that stops rendering is a failure, not a quieter fingerprint", async () => {
  // The other direction of the same change, and the one that must not be lost: narrowing the comparison to the
  // approved pages would be a way to pass by rendering none of them. A page the approved design contains and the
  // build does not is reported as exactly that.
  const repo = path.join(tmp(), "repo");
  const provider = fakeProvider({ repo, onCycle: () => writeConformingBackend(repo) });
  const r = await runDesignLockedJob(deps({
    repo, provider: provider as never,
    fetchArtifact: async () => artifact({ designFingerprint: "9".repeat(64) }),
    // An approved design with a page the measurement will not contain.
    fetchApprovedBaseline: async () => ({
      signatures: [{ page: "a-page-that-is-gone", viewport: "desktop", skeleton: [], palette: [], fonts: [], typeScale: [], landmarks: [], docHeight: 1 }],
    }),
  }));

  assert.ok(
    r.problems.some((p) => /a-page-that-is-gone.*no longer render at all/.test(p)),
    `a missing approved page is named: ${JSON.stringify(r.problems)}`,
  );
});

test("[DLJ-13] progress is movement in ANY of the three gates, and a regression cancels it", () => {
  // THE DEFECT. This was `violations.length < previousViolations.length` -- the only clause of three that could
  // ever be true, the others being subsumed by it. So "did this cycle help" meant "are there fewer CONTRACT
  // violations", and nothing else. A build whose contract already conformed and whose functional or visual gate
  // failed scored zero violations in every cycle, no progress from cycle 2, and was stopped after ONE repair
  // attempt with "changed nothing measurable" -- even if that attempt had fixed three of four failing checks.
  // `nextPrompt` was already writing functional and visual repair briefs the loop would not let it act on.
  const none: string[] = [];

  // The exact historical case: contract clean throughout, functional improving.
  const before = { violations: 0, functional: 4, visual: 0 };
  const after = { violations: 0, functional: 1, visual: 0 };
  const r1 = measureProgress(before, after, none, none);
  assert.equal(r1.progressed, true, "fixing three of four failing checks is progress");
  assert.deepEqual(r1.regressed, []);

  // Visual drift reducing is progress too.
  assert.equal(measureProgress({ violations: 2, functional: 0, visual: 5 }, { violations: 2, functional: 0, visual: 2 }, ["a", "b"], ["a", "b"]).progressed, true);

  // Nothing moved: not progress, and the loop is right to stop.
  assert.equal(measureProgress(before, before, none, none).progressed, false);

  // PHASE 4's RULE. A repair that improves functionality and damages the approved design has not improved
  // anything, and the regression is named rather than averaged away.
  const traded = measureProgress({ violations: 0, functional: 4, visual: 0 }, { violations: 0, functional: 0, visual: 3 }, none, none);
  assert.equal(traded.progressed, false, "functionality gained at the design's expense is not progress");
  assert.equal(traded.regressed.length, 1);
  assert.match(traded.regressed[0], /visual fidelity got worse \(0 → 3\)/);

  // A swap -- the same count, a different set -- is not progress either, or the loop trades one defect for
  // another until the budget is gone.
  const swapped = measureProgress({ violations: 1, functional: 0, visual: 0 }, { violations: 1, functional: 0, visual: 0 }, ["b"], ["a"]);
  assert.equal(swapped.progressed, false);
  assert.match(swapped.regressed[0], /changed without reducing/);

  // The first cycle has nothing to compare with, and is never judged as making no progress.
  assert.deepEqual(measureProgress(null, after, none, none), { progressed: true, regressed: [] });
});

test("[DLJ-14] an undetermined check counts against the score, so resolving one is progress", () => {
  // Undetermined is not a pass -- the whole acceptance design rests on that -- so it has to count as something
  // the repair loop can reduce. Otherwise a cycle that turns four unverifiable criteria into four verified
  // passes would score as "nothing changed".
  const withFour = gateScore(true, [], { ran: true, ok: false, detail: "", failed: 0, undetermined: 4 }, { ran: true, ok: true, detail: "", findings: 0 });
  assert.equal(withFour.functional, 4);
  const withOne = gateScore(true, [], { ran: true, ok: false, detail: "", failed: 1, undetermined: 0 }, { ran: true, ok: true, detail: "", findings: 0 });
  assert.equal(withOne.functional, 1);
  assert.equal(measureProgress(withFour, withOne, [], []).progressed, true);

  // A gate that reported no counts at all still scores: a failure is one, a pass is none.
  assert.equal(gateScore(true, [], { ran: false, ok: false, detail: "" }, { ran: false, ok: false, detail: "" }).functional, 1);
  assert.equal(gateScore(true, [], { ran: true, ok: true, detail: "" }, { ran: true, ok: true, detail: "" }).visual, 0);
});

// ── The static path ───────────────────────────────────────────────────────────────────────────────────────────
//
// WHY THIS FIXTURE EXISTS. Every test above this line uses `summit-haul-frontend`, a vite project with a build
// script, so `npm run build` was always the right thing to run and the repair loop's hardcoded rebuild was never
// questioned. The artifacts the Founder actually uploads are single self-contained HTML documents: no package
// manifest, no build step, nothing to compile. That path had no test, and it was broken in the one place it
// mattered — the rebuild between repair cycles — which is why four real staging builds each recorded exactly one
// visual finding reading "the project no longer builds (exit 1)" when the website was fine and npm was simply
// being asked for a script that a static site has no reason to own.
const STATIC_FIXTURE = path.resolve(import.meta.dirname, "fixtures/vesper-rowe-law");
const STATIC_ARCHIVE = zipDirectory(STATIC_FIXTURE, { prefix: "vesper-rowe-law" });
const STATIC_SHA = createHash("sha256").update(STATIC_ARCHIVE).digest("hex");

const staticArtifact = (): ApprovedArtifact => artifact({
  framework: "static", archiveRoot: "vesper-rowe-law", sha256: STATIC_SHA,
  sizeBytes: STATIC_ARCHIVE.length, base64: STATIC_ARCHIVE.toString("base64"),
  filename: "01-vesper-rowe-law.zip",
});

const STATIC_MANIFEST: IntegrationManifest & ManifestContract = {
  ...MANIFEST, artifactSha: STATIC_SHA,
  operations: [{ ...MANIFEST.operations[0], page: "index", element: "form#consult" }],
};

test("[DLJ-15] a static site has nothing to rebuild, so the visual gate still runs", async () => {
  const repo = path.join(tmp(), "repo");
  // buildCode 1 is what npm really answers when asked for a script the project does not define, which is
  // exactly what staging hit. A static site must reach its measurement anyway, because no build is owed.
  const sandbox = fakeSandbox({ repo, buildCode: 1 });
  const provider = fakeProvider({ repo, onCycle: () => writeConformingBackend(repo) });

  const r = await runDesignLockedJob(deps({
    repo, sandbox: sandbox as never, provider: provider as never,
    fetchArtifact: async () => staticArtifact(), manifest: STATIC_MANIFEST,
  }));

  // The point of the test: the gate reached its own measurement instead of being refused by npm.
  assert.equal(r.cycles.length >= 1, true, r.summary);
  assert.doesNotMatch(r.cycles[0].visual.detail, /no longer builds/,
    "a static site has no build script, and asking npm for one is not a fact about the website");
  assert.equal(r.cycles[0].visual.ran, true, `the visual gate did not run: ${r.cycles[0].visual.detail}`);

  // And it got there by not inventing a build step, rather than by tolerating a failing one.
  assert.ok(!sandbox.buildLabels.includes("npm run build"),
    `a static site was asked to build: ${sandbox.buildLabels.join(" | ")}`);
});

test("[DLJ-16] a build-machine failure is not sent to the model as a defect to repair", async () => {
  // Phase 3: "Do not ask Model B to repair infrastructure failures outside its responsibility." Staging did ask.
  // A leaked server from an earlier repair cycle held the one hardcoded port, the functional gate reported "the
  // application did not answer", and that sentence was pasted into a repair brief under the heading "It does not
  // work" -- for up to 189 turns, against an application that was fine.
  const repo = path.join(tmp(), "repo");
  const sandbox = fakeSandbox({ repo, acceptanceEnvironment: true });
  const provider = fakeProvider({ repo, onCycle: () => writeConformingBackend(repo) });

  const r = await runDesignLockedJob(deps({ repo, sandbox: sandbox as never, provider: provider as never }));

  // Not a pass: nothing was verified, and an unverified gate is never a pass.
  assert.equal(r.ok, false, "a build nobody could verify must not be accepted");
  assert.equal(r.cycles[0].functional.ok, false);
  assert.equal(r.cycles[0].functional.environment, 1, "the machine's failure is counted as the machine's");
  assert.equal(r.cycles[0].functional.failed ?? 0, 0, "and not as the implementation's");

  // The model was asked to build once, and never asked to repair the port.
  assert.equal(provider.prompts.length, 1, provider.prompts.map((p) => p.slice(0, 80)).join(" || "));
  for (const p of provider.prompts) {
    assert.doesNotMatch(p, /It does not work/, "an environment problem is not an implementation defect");
    assert.doesNotMatch(p, /did not answer|was taken while it was starting/, "and its text is not pasted into a brief");
  }

  // And a person reading the outcome is told it was the platform.
  assert.match(r.problems.join(" "), /platform failure, not a failure of the generated website/, r.problems.join(" | "));
});

test("[DLJ-17] an environment difference is not charged to Model B as design drift", async () => {
  // The gate asks "did Model B change the approved design?". It was answered by comparing the build's
  // measurement against the baseline measured during IMPORT -- a different container, a different run -- so any
  // difference between those two environments was permanent, unfixable drift blamed on the model. Measured: the
  // Founder's law firm document fingerprinted b2dd67f236668efb at import and 973c825990b3 in the build, from the
  // same bytes with the same ten pinned assets, consistently, a section 12207px lower at mobile. Three repair
  // cycles went on it and the gate could not be passed.
  //
  // Here the approved baseline carries a DIFFERENT palette from the one this build measures, which is what an
  // environment difference looks like: the design the build renders is not bit-identical to the approved record.
  // Model B changes nothing visual, so the gate must pass -- and the divergence from the approved design is
  // reported separately, by the drift check that owns that question.
  const report = JSON.parse(readFileSync(path.join(REAL, "import-baseline.json"), "utf8")) as {
    signatures: { page: string; viewport: string; palette?: string[] }[];
  };
  const page = report.signatures[0].page;
  const mine = report.signatures.filter((s) => s.page === page);
  assert.ok(mine.length > 0, "the fixture must measure at least one page view");

  // The approved record differs from what this environment renders, in a way no repair could reconcile.
  const approvedSignatures = mine.map((s) => ({ ...s, palette: ["rgb(1, 2, 3)", ...(s.palette ?? [])] }));

  const repo = path.join(tmp(), "repo");
  const provider = fakeProvider({ repo, onCycle: () => writeConformingBackend(repo) });
  const r = await runDesignLockedJob(deps({
    repo, provider: provider as never,
    fetchArtifact: async () => artifact({ designFingerprint: baselineFingerprint(approvedSignatures as never) }),
    fetchApprovedBaseline: async () => ({ signatures: approvedSignatures as never }),
  }));

  const visual = r.cycles[0]?.visual;
  assert.ok(visual, "no cycle ran, so the gate was never reached");
  assert.equal(visual.ran, true, `the visual gate did not run: ${visual.detail}`);
  assert.equal(visual.ok, true,
    `an environment difference was charged to Model B as drift: ${visual.detail}`);

  // And the difference from the approved design is still SAID, where a person reads it.
  assert.match(r.problems.join(" ") + r.summary,
    /renders a different design from the one approved/,
    "the divergence from the approved design must still be recorded, just not as the model's fault");
});

test("[DLJ-18] one unproductive cycle is ordinary; two in a row is stuck", async () => {
  // Iterations 10, 11 and 12 each stopped at cycle 2 of a permitted 4. Iteration 12 stopped with conformance
  // passing, the visual gate passing, and the functional gate ONE acceptance check short -- "the response does
  // not contain 1,900+" -- holding two unspent cycles. The rule meant to prevent waste was the reason the work
  // was abandoned, one string from done.
  const repo = path.join(tmp(), "repo");
  const provider = fakeProvider({
    repo,
    // Never satisfies the contract, so no cycle ever moves the score.
    onCycle: () => {
      writeFileSync(path.join(repo, "server.js"), 'import { writeFileSync } from "node:fs";\nconst D = "./x.json";\nexport function store(r) { writeFileSync(D, JSON.stringify(r)); }');
      writeFileSync(path.join(repo, "verify-backend.mjs"), "console.log('ok');\n");
    },
  });

  const r = await runDesignLockedJob(deps({ repo, provider: provider as never }));

  assert.equal(r.ok, false);
  // Cycle 1 integrates, cycle 2 moves nothing (tolerated), cycle 3 moves nothing (stuck) -> stop.
  assert.equal(r.cycles.length, 3,
    `one stall should be tolerated and the second should stop it: ${r.cycles.map((c) => `${c.cycle}:${c.progressed}`).join(" ")}`);
  assert.match(r.problems.join(" "), /both changed nothing measurable/,
    "and it says it was twice, not once");
  // Still bounded by the ceiling, which this does not raise.
  assert.ok(r.cycles.length <= MAX_REPAIR_CYCLES + 1, "the ceiling is unchanged");
});
