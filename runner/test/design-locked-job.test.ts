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
import { MAX_REPAIR_CYCLES, runDesignLockedJob, writeEvidence } from "../src/frontend/design-locked-job.ts";
import type { DesignLockedDeps } from "../src/frontend/design-locked-job.ts";
import { zipDirectory } from "./fixtures/zip-writer.ts";
import { RunTracker, StopSwitch } from "../src/agent.ts";
import { silentLogger } from "../src/log.ts";
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
  /** Called on each `npm run build`, so a test can mutate the repo the way a model would. */
  onBuild?: (n: number) => void;
}) {
  const calls: string[] = [];
  let builds = 0;
  const run = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr, timedOut: false, command: "fake" });
  return {
    calls,
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
      if (label.includes("verify-backend") || label.includes("acceptance")) {
        calls.push("acceptance");
        return run(o.acceptanceCode ?? 0, o.acceptanceCode ? "2/10 checks passed" : "10/10 checks passed");
      }
      calls.push("build");
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
  assert.match(first.functional.detail, /no runnable acceptance check was produced/, "and an unverifiable criterion is not a passing one");
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
