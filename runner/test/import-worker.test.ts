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
import { JobSandbox } from "../src/sandbox.ts";
import type { JobSandboxConfig } from "../src/config.ts";
import { createWorkspace } from "../src/workspace.ts";
import { ControlPlaneError } from "../src/control-plane.ts";
import type { ImportOutcome } from "../src/frontend/workflow.ts";
import type { FrontendImportClaim } from "../src/protocol.ts";
import type { ContractAuthoringInput } from "../src/frontend/contract-author.ts";

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
  /** Thrown by the `imported` report only, so the rejection that follows it still goes through. */
  reportThrows?: unknown;
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
      async reportFrontendImport(r: Reported) {
        reports.push(r);
        if (o.reportThrows && r.status === "imported") throw o.reportThrows;
      },
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
      report: { routes: [{ page: "index" }, { page: "quote" }], interactions: [], states: [], renders: [{ page: "index", viewport: "desktop", sha: "a".repeat(64) }] } as never,
    }),
  });

  assert.equal(await w.serve(), "done");
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].status, "imported");
  assert.equal(f.reports[0].artifactId, "fa_1");
  assert.equal(f.reports[0].framework, "vite", "what the ingest found, not a guess");
  assert.equal(f.reports[0].archiveRoot, "site");
  assert.equal((f.reports[0].baseline as { fingerprint: string }).fingerprint, baseline.fingerprint, "the measured design travels with it");
  // The same measurement's inventory travels beside it, or the platform records a design with no routes and the
  // Artifact Builder screen reports zero pages for a frontend it just measured.
  const m = f.reports[0].measurement as { routes: unknown[]; viewports: string[] } | null;
  assert.ok(m, "the measurement is sent");
  assert.equal(m.routes.length, 2, "the routes the measurement found");
  assert.deepEqual(m.viewports, ["desktop"], "and the viewports it captured");
});

test("[IMP-07] the import's workspace sits where a sandbox on the workspaces volume can mount it", async () => {
  // Measured on Node 1: every import died at
  //   cannot access path /var/lib/docker/volumes/crestmont-workspaces/_data/<ref>/repo: no such file
  // and the worker, correctly treating that as infrastructure, retried for ever and left a created container
  // behind each time. `JobSandbox` mounts `volume-subpath=<ref>/repo`, ONE segment from the volume root, so a
  // workspace nested in a per-artifact subdirectory can never be mounted. This pins the workspace's position.
  const f = fakeClient({ claim: claim() });
  let repo = "";
  const w = importWorker({
    client: f.client, cfg, logger: silent, workRoot: cfg.workspacesRoot, runnerId: "r",
    importer: async (args: { repo: string }) => { repo = args.repo; return outcome({ ok: false, problems: ["stopped here on purpose"] }); },
  });
  assert.equal(await w.serve(), "done");

  const root = path.resolve(cfg.workspacesRoot);
  const rel = path.relative(root, path.resolve(repo));
  const parts = rel.split(path.sep);
  assert.equal(parts.length, 2, `the workspace must be <root>/<ref>/repo, so repo is two segments below the root; got ${rel}`);
  assert.equal(parts[1], "repo");
  assert.match(parts[0], /^import-fa_1-a1-[0-9a-f]{6}$/, `and the ref says what it is and is unique per claim: ${parts[0]}`);
});

test("[IMP-08] a sandbox on the workspaces volume refuses a workspace it could not mount, before creating a container", async () => {
  // The guard for [IMP-07], at the place that builds the mount. Without it the only report was the daemon's, about
  // a path nobody had asked for, after a container had already been created and left behind.
  const root = mkdtempSync(path.join(tmpdir(), "imp-root-"));
  const sandboxCfg = {
    dockerBin: "docker", image: "x", runnerId: "r", volume: "crestmont-workspaces", workspacesRoot: root,
    cpus: "2", memory: "2g", pidsLimit: 512, tmpfsMb: 256, commandTimeoutMs: 1000, installTimeoutMs: 1000,
    installNetwork: "n", installProxy: "", registry: "", diskQuotaMb: 1024, uid: 10001,
    allowedBuildScripts: [], browserCheck: false,
  } as unknown as JobSandboxConfig;

  const good = createWorkspace(root, { id: "import-fa_1", attempt: 1 });
  const flags = new JobSandbox(sandboxCfg, good, "fa_1", (async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false })) as never).mountFlags();
  assert.ok(flags.some((x) => x === `type=volume,src=crestmont-workspaces,dst=/workspace/repo,volume-subpath=${good.ref}/repo`), flags.join(" "));

  const nested = createWorkspace(path.join(root, "import-fa_2"), { id: "import-fa_2", attempt: 1 });
  assert.throws(
    () => new JobSandbox(sandboxCfg, nested, "fa_2", (async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false })) as never).mountFlags(),
    /not directly under the workspaces root/,
    "a workspace the mount cannot reach is refused here, not by the daemon",
  );

  // With no volume the mounts are absolute host paths, so nesting is none of this check's business.
  const noVolume = { ...sandboxCfg, volume: "" } as typeof sandboxCfg;
  assert.ok(new JobSandbox(noVolume, nested, "fa_2", (async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false })) as never).mountFlags().some((x) => x.includes("type=bind")));
});

test("[IMP-09] a measured design the platform refuses becomes the artifact's verdict, not an endless retry", async () => {
  // Measured on Node 1: three artifacts looped on the import lease for ever. Each was measured, each reported, and
  // each report came back 400 `a baseline needs at least one screenshot: there would be no visual record` -- the
  // platform refusing the measured design. The worker read a failed report as infrastructure (which is right for a
  // sandbox that would not start) and left the claim to expire, so the same artifact was measured and refused
  // again every twenty minutes, holding the single import lane while it did.
  //
  // A 4xx is the platform refusing WHAT WAS MEASURED. The measured design is the only one this import produced, so
  // sending it again cannot succeed: it is the artifact's verdict, in the platform's own words.
  const baseline = { fingerprint: "b".repeat(64), signatures: [], renders: [] };
  const f = fakeClient({
    claim: claim(),
    reportThrows: new ControlPlaneError(400, JSON.stringify({ error: "a baseline needs at least one screenshot: there would be no visual record" }), "/frontend/import/report"),
  });
  const w = importWorker({
    client: f.client, cfg, logger: silent, workRoot: cfg.workspacesRoot, runnerId: "r",
    importer: async () => outcome({ ok: true, baseline: baseline as never, problems: ["a note from the measurement"] }),
  });

  assert.equal(await w.serve(), "done");
  assert.equal(f.reports.length, 2, `the refused report, then the verdict: ${JSON.stringify(f.reports.map((r) => r.status))}`);
  assert.equal(f.reports[0].status, "imported");
  assert.equal(f.reports[1].status, "rejected", "the artifact gets a verdict rather than another lap");
  const why = (f.reports[1].problems ?? []).join(" | ");
  assert.match(why, /would not accept the measured design/, why);
  assert.match(why, /at least one screenshot/, `in the platform's own words: ${why}`);
  assert.match(why, /a note from the measurement/, "and the measurement's own notes are kept");
});

test("[IMP-10] a platform that is merely unreachable still reports nothing, so the claim is offered again", async () => {
  // The other half of [IMP-09]: 5xx, a timeout or a socket error says nothing about the artifact. Rejecting the
  // Founder's work because the platform had a bad minute would be the worst possible answer, so nothing is sent
  // and the lease expiry re-offers it -- which is also how a runner that dies mid-import is handled.
  for (const thrown of [
    new ControlPlaneError(500, "upstream error", "/frontend/import/report"),
    new ControlPlaneError(502, "bad gateway", "/frontend/import/report"),
    new Error("fetch failed"),
  ]) {
    const f = fakeClient({ claim: claim(), reportThrows: thrown });
    const w = importWorker({
      client: f.client, cfg, logger: silent, workRoot: cfg.workspacesRoot, runnerId: "r",
      importer: async () => outcome({ ok: true, baseline: { fingerprint: "c".repeat(64), signatures: [], renders: [] } as never }),
    });
    assert.equal(await w.serve(), "done");
    assert.equal(f.reports.filter((r) => r.status === "rejected").length, 0,
      `${thrown instanceof ControlPlaneError ? thrown.status : "network"}: the artifact must not be blamed for the platform being unreachable`);
  }
});

test("[IMP-11] the import closes its sandbox, whatever the outcome", async () => {
  // A sandbox is started detached, so one that outlives its import keeps its CPU and memory caps. Nothing closed
  // the import lane's: thirteen were found running on Node 1, 6 CPUs and 8 GB each, one per import since the
  // channel started working. The build path closes its own through the provider; this lane had no such owner.
  //
  // The fake executor records what docker was asked to do, which is how `close()` is observed without Docker.
  for (const [label, outcomeOf] of [
    ["a measured design", () => outcome({ ok: true, baseline: { fingerprint: "a".repeat(64), signatures: [], renders: [] } as never })],
    ["a rejected archive", () => outcome({ ok: false, failedAt: "ingest", problems: ["it will not build"] })],
    ["an import that threw", () => { throw new Error("the sandbox died mid-import"); }],
  ] as const) {
    const calls: string[][] = [];
    const f = fakeClient({ claim: claim() });
    const w = importWorker({
      client: f.client, cfg, logger: silent, workRoot: cfg.workspacesRoot, runnerId: "r",
      executor: (async (args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false }; }) as never,
      // The real importFrontend starts the sandbox; a close is a no-op on one that never started, so the fake
      // has to start it too or this test would pass against the bug.
      importer: (async (args: { sandbox: { start(): Promise<void> } }) => { await args.sandbox.start(); return outcomeOf(); }) as never,
    });

    assert.equal(await w.serve(), "done", label);
    const removed = calls.filter((c) => c[0] === "rm" && c[1] === "-f").map((c) => c[2]);
    assert.ok(
      removed.some((n) => n.startsWith("cm-job-import-fa_1-a1-")),
      `${label}: the import sandbox must be removed; docker was asked ${JSON.stringify(calls.map((c) => c.slice(0, 2)))}`,
    );
  }
});

test("[IMP-12] a sandbox that will not close does not lose the import's outcome", async () => {
  // The outcome has already been decided and reported by the time the close runs. Losing it to a cleanup failure
  // would be the wrong trade, so the failure is logged and the startup reaper is the backstop.
  const f = fakeClient({ claim: claim() });
  const warned: string[] = [];
  let imported = false;
  const noisy = {
    debug() {}, info() {}, error() {},
    warn(msg: string) { warned.push(msg); },
    child() { return noisy; },
  } as unknown as Parameters<typeof importWorker>[0]["logger"];

  const w = importWorker({
    client: f.client, cfg, logger: noisy, workRoot: cfg.workspacesRoot, runnerId: "r",
    // Only the CLOSING rm fails. `start()` clears any stale container of the same name with an rm of its own, and
    // failing that one would be a sandbox that never started -- a different case, covered by [IMP-04].
    executor: (async (args: string[]) => {
      if (args[0] === "rm" && imported) throw new Error("docker is not answering");
      return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
    }) as never,
    importer: (async (args: { sandbox: { start(): Promise<void> } }) => {
      await args.sandbox.start();
      imported = true;
      return outcome({ ok: false, failedAt: "ingest", problems: ["it will not build"] });
    }) as never,
  });

  assert.equal(await w.serve(), "done", "the import still finishes");
  assert.equal(f.reports.length, 1, "and its verdict was still reported");
  assert.equal(f.reports[0].status, "rejected");
  assert.ok(warned.some((m) => /could not be closed/.test(m)), `and the failure is said out loud: ${warned.join(" | ")}`);
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

test("[IMP-13] the import drafts a contract when the platform says it is waiting for one, and otherwise does not", async () => {
  // The platform no longer queues a backend build on approval alone: a design-locked build judged against nothing
  // stops thirteen seconds after it starts, which is what six Founder artifacts each produced. It approves the
  // design, says `awaitingContract`, and the draft is written here -- in this claim, while the measurement and the
  // unpacked artifact are both still in hand.
  const measured = outcome({
    ok: true,
    baseline: { fingerprint: "c".repeat(64), signatures: [], renders: [] } as never,
    report: {
      routes: [{ page: "index", file: "index.html", title: "Home" }],
      interactions: [{ page: "index", element: "form#quote", role: "form", needsBackend: true, functional: false }],
      states: [], renders: [{ page: "index", viewport: "desktop" }],
    } as never,
  });

  for (const [label, answer, expectDrafts] of [
    ["waiting for a contract", { awaitingContract: true, projectId: "prj_9", designFingerprint: "c".repeat(64) }, 1],
    ["not waiting", { awaitingContract: false, queued: "bld_1" }, 0],
    ["an older platform that says nothing", null, 0],
  ] as const) {
    const drafted: ContractAuthoringInput[] = [];
    const submissions: unknown[] = [];
    const client = {
      async claimFrontendImport() { return claim(); },
      async frontendImportBytes() { return { artifactId: "fa_1", sha256: SHA, filename: "frontend.zip", base64: BYTES.toString("base64") }; },
      async reportFrontendImport() { return answer; },
      async submitFrontendContract(r: unknown) { submissions.push(r); return { recorded: true, version: 1, queued: "bld_2" }; },
    } as unknown as Parameters<typeof importWorker>[0]["client"];

    const w = importWorker({
      client, cfg, logger: silent, workRoot: cfg.workspacesRoot, runnerId: "r",
      executor: (async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false })) as never,
      importer: (async () => measured) as never,
      contractAuthor: () => async (i) => { drafted.push(i); return { operations: [] }; },
      authorModel: "qwen-test:32b",
    });

    assert.equal(await w.serve(), "done", label);
    assert.equal(drafted.length, expectDrafts, `${label}: ${drafted.length} draft(s)`);
    assert.equal(submissions.length, expectDrafts, `${label}: ${submissions.length} submission(s)`);
    if (expectDrafts) {
      // The draft is written against the project and the design the platform named, and about what was measured.
      assert.equal(drafted[0].projectId, "prj_9", "the platform's own answer decides which project, not the claim");
      assert.equal(drafted[0].designFingerprint, "c".repeat(64));
      assert.equal(drafted[0].artifactSha, SHA);
      assert.equal(drafted[0].interactions.length, 1);
      const sent = submissions[0] as { authorModel: string; attemptsAllowed: number; manifest: { artifactSha: string } };
      assert.equal(sent.authorModel, "qwen-test:32b", "provenance travels with the draft");
      assert.equal(sent.manifest.artifactSha, SHA, "and the two hashes are stamped on before it is sent");
      assert.ok(sent.attemptsAllowed >= 1, "the bound is declared to the platform, so a refusal can be counted");
    }
  }
});

test("[IMP-14] a contract that cannot be drafted does not undo the import", async () => {
  // By the time authoring runs, the measured design is recorded and APPROVED. Nothing about a failed draft may
  // turn that into a rejection: the design is good, the plan is missing, and those are different verdicts about
  // different things. The project waits visibly for a contract instead.
  const measured = outcome({
    ok: true,
    baseline: { fingerprint: "c".repeat(64), signatures: [], renders: [] } as never,
    report: {
      routes: [{ page: "index", file: "index.html", title: "Home" }],
      interactions: [], states: [], renders: [],
    } as never,
  });

  for (const [label, author] of [
    ["the session threw", () => async () => { throw new Error("the model server is not answering"); }],
    ["every draft was refused", () => async () => ({ operations: [] })],
  ] as const) {
    const reports: { status: string }[] = [];
    const client = {
      async claimFrontendImport() { return claim(); },
      async frontendImportBytes() { return { artifactId: "fa_1", sha256: SHA, filename: "frontend.zip", base64: BYTES.toString("base64") }; },
      async reportFrontendImport(r: { status: string }) { reports.push(r); return { awaitingContract: true, projectId: "prj_9", designFingerprint: "c".repeat(64) }; },
      async submitFrontendContract() { return { recorded: false, problems: ["uncovered-interaction: something"] }; },
    } as unknown as Parameters<typeof importWorker>[0]["client"];

    const w = importWorker({
      client, cfg, logger: silent, workRoot: cfg.workspacesRoot, runnerId: "r",
      executor: (async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false })) as never,
      importer: (async () => measured) as never,
      contractAuthor: author as never,
    });

    assert.equal(await w.serve(), "done", label);
    assert.equal(reports.length, 1, `${label}: the import reported exactly once`);
    assert.equal(reports[0].status, "imported", `${label}: and it still reported the design as measured`);
  }
});
