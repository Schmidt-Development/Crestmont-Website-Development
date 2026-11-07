// Importing an uploaded frontend: what the runner reports, and what it deliberately does not.
//
// The step between a scanned ZIP and a design a person can approve had nowhere to run on the deployed platform.
// This worker is where it runs. The behaviour worth pinning down is not the happy path -- it is which failures
// become the artifact's verdict and which do not, because getting that wrong either rejects the Founder's work
// over a sandbox that would not start, or leaves them watching a spinner for an archive that will never build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { importWorker } from "../src/frontend/import-worker.ts";
import { ControlPlaneError } from "../src/control-plane.ts";
import type { ImportOutcome } from "../src/frontend/workflow.ts";
import type { FrontendImportClaim } from "../src/protocol.ts";

const silent = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silent; },
} as unknown as Parameters<typeof importWorker>[0]["logger"];

const cfg = {
  runnerId: "test-runner",
  workspacesRoot: mkdtempSync(path.join(tmpdir(), "imp-")),
  jobSandbox: { dockerBin: "docker", image: "x", network: "none", memory: "2g", cpus: "2", diskMb: 1024, timeoutMs: 1000 },
} as unknown as Parameters<typeof importWorker>[0]["cfg"];

const BYTES = Buffer.from("a frontend archive");
const SHA = createHash("sha256").update(BYTES).digest("hex");

const claim = (over: Partial<FrontendImportClaim> = {}): FrontendImportClaim => ({
  artifactId: "fa_1", projectId: "prj_1", organizationId: "org_1", version: 1, sha256: SHA, sizeBytes: BYTES.length, ...over,
});

type Reported = Parameters<Parameters<typeof importWorker>[0]["client"]["reportFrontendImport"]>[0];

function fakeClient(o: {
  claim?: FrontendImportClaim | null;
  claimThrows?: unknown;
  bytes?: { artifactId: string; sha256: string; filename: string; base64: string } | null;
} = {}) {
  const reports: Reported[] = [];
  return {
    reports,
    client: {
      async claimFrontendImport() { if (o.claimThrows) throw o.claimThrows; return o.claim ?? null; },
      async frontendImportBytes() {
        return o.bytes === undefined
          ? { artifactId: "fa_1", sha256: SHA, filename: "frontend.zip", base64: BYTES.toString("base64") }
          : o.bytes;
      },
      async reportFrontendImport(r: Reported) { reports.push(r); },
    } as unknown as Parameters<typeof importWorker>[0]["client"],
  };
}

const outcome = (over: Partial<ImportOutcome> = {}): ImportOutcome => ({
  ok: true, failedAt: null, ingest: null, build: null, report: null,
  baseline: null, manifestProblems: [], verify: null, problems: [], ...over,
});

test("[IMP-01] nothing to import, and an older platform is asked only once", async () => {
  const empty = fakeClient({ claim: null });
  assert.equal(await importWorker({ client: empty.client, cfg, logger: silent, workRoot: cfg.workspacesRoot, runnerId: "r" }).serve(), "none");
  assert.deepEqual(empty.reports, [], "nothing is reported when there is nothing to do");

  // A control plane without the channel is a different answer from an empty queue, and the worker has to stop
  // asking. Flattening the two would leave it polling an older platform for ever.
  const old = fakeClient({ claimThrows: new ControlPlaneError(404, "not found", "/api/builds/runner/frontend/import/claim") });
  const w = importWorker({ client: old.client, cfg, logger: silent, workRoot: cfg.workspacesRoot, runnerId: "r" });
  assert.equal(await w.serve(), "unsupported");
  assert.equal(await w.serve(), "unsupported", "and it does not ask again");
});

test("[IMP-02] a measured design is reported with its baseline, and never as a rejection", async () => {
  const f = fakeClient({ claim: claim() });
  const baseline = { fingerprint: "b".repeat(64), signatures: [], renders: [] };
  const w = importWorker({
    client: f.client, cfg, logger: silent, workRoot: cfg.workspacesRoot, runnerId: "r",
    importer: async () => outcome({
      ok: true,
      baseline: baseline as never,
      ingest: { framework: "vite", archiveRoot: "site" } as never,
      report: { routes: [{ page: "index" }, { page: "quote" }] } as never,
    }),
  });

  assert.equal(await w.serve(), "done");
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].status, "imported");
  assert.equal(f.reports[0].artifactId, "fa_1");
  assert.equal(f.reports[0].framework, "vite", "what the ingest found, not a guess");
  assert.equal(f.reports[0].archiveRoot, "site");
  assert.equal((f.reports[0].baseline as { fingerprint: string }).fingerprint, baseline.fingerprint, "the measured design travels with it");
});

test("[IMP-03] an archive that will not build is the artifact's verdict, with the reasons", async () => {
  const f = fakeClient({ claim: claim() });
  const w = importWorker({
    client: f.client, cfg, logger: silent, workRoot: cfg.workspacesRoot, runnerId: "r",
    importer: async () => outcome({ ok: false, failedAt: "build", problems: ["npm install failed: no lockfile", "vite build produced no dist/"] }),
  });

  assert.equal(await w.serve(), "done");
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].status, "rejected", "this one IS about the artifact");
  assert.deepEqual(f.reports[0].problems, ["npm install failed: no lockfile", "vite build produced no dist/"],
    "and the person who uploaded it is told why");
  assert.equal(f.reports[0].baseline, undefined, "a rejection carries no baseline");
});

test("[IMP-04] an import that could not be carried out reports nothing at all", async () => {
  // The crux. A sandbox that will not start, a dropped connection, a missing image: none of that is a judgement
  // on the artifact, so nothing is sent. The platform's lease expires and offers it again -- the same path a
  // runner that died mid-import already takes. Reporting `rejected` here would throw away the Founder's upload
  // because of a fault on this machine.
  const f = fakeClient({ claim: claim() });
  const w = importWorker({
    client: f.client, cfg, logger: silent, workRoot: cfg.workspacesRoot, runnerId: "r",
    importer: async () => { throw new Error("docker: cannot connect to the daemon"); },
  });

  assert.equal(await w.serve(), "done");
  assert.deepEqual(f.reports, [], "no verdict is invented from an infrastructure failure");
});

test("[IMP-05] bytes that are not the claimed artifact are refused without being opened", async () => {
  const other = Buffer.from("a different archive entirely");
  const f = fakeClient({
    claim: claim(),
    bytes: { artifactId: "fa_1", sha256: SHA, filename: "frontend.zip", base64: other.toString("base64") },
  });
  let opened = false;
  const w = importWorker({
    client: f.client, cfg, logger: silent, workRoot: cfg.workspacesRoot, runnerId: "r",
    importer: async () => { opened = true; return outcome(); },
  });

  assert.equal(await w.serve(), "done");
  assert.equal(opened, false, "the archive is never opened when it is not the one that was claimed");
  assert.equal(f.reports[0]?.status, "rejected");
  assert.match(f.reports[0].problems?.[0] ?? "", /so the archive was not opened/);
  assert.match(f.reports[0].problems?.[0] ?? "", new RegExp(SHA.slice(0, 12)), "and both digests are named");
});

test("[IMP-06] an artifact the platform stops offering is left alone", async () => {
  // 409 while we held it: flagged, superseded, or released. The platform's decision, so the worker does not
  // argue with it and does not record a verdict of its own.
  const f = fakeClient({ claim: claim(), bytes: null });
  let opened = false;
  const w = importWorker({
    client: f.client, cfg, logger: silent, workRoot: cfg.workspacesRoot, runnerId: "r",
    importer: async () => { opened = true; return outcome(); },
  });

  assert.equal(await w.serve(), "done");
  assert.equal(opened, false);
  assert.deepEqual(f.reports, [], "no verdict is written over the platform's own");
});
