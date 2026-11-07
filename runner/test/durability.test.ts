// Phase 4B: the durable side of four-project concurrency. Restart recovery, the duplicate-claim guard, independent
// per-project checkpoints and cancellation that stays inside one project. Deterministic: fake docker executor, fake
// control plane, no model, no GPU, no containers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { JobSandbox } from "../src/sandbox.ts";
import type { DockerExecutor } from "../src/sandbox.ts";
import { createWorkspace, findLocalWorkspace, latestCheckpointFile } from "../src/workspace.ts";
import { newHealthState, healthStatus } from "../src/health.ts";
import { HostLimits } from "../src/limits.ts";
import { makeConfig, makeJob, startFakeControlPlane, testManifest, makeSkillsDir, SECRET } from "./helpers.ts";
import { ControlPlaneClient } from "../src/control-plane.ts";
import { runSlots } from "../src/main.ts";
import { silentLogger } from "../src/log.ts";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "dur-"));
const ok = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
/** A config good enough for the slot bookkeeping under test (no model, no container, no build). */
const cfg0 = () => makeConfig({ controlPlaneUrl: "http://127.0.0.1:1", skillsSourceDir: makeSkillsDir(testManifest()) });

/** A docker executor that answers `ps` from a scripted container list and records every call. */
function fakeDocker(containers: { name: string; runner: string }[]): { exec: DockerExecutor; calls: string[][]; removed: string[] } {
  const calls: string[][] = [];
  const removed: string[] = [];
  const exec: DockerExecutor = async (args) => {
    calls.push(args);
    if (args[0] === "ps") return { ...ok, stdout: containers.map((c) => `${c.name}\t${c.runner}`).join("\n") };
    if (args[0] === "rm") { removed.push(args[args.length - 1]); return ok; }
    return ok;
  };
  return { exec, calls, removed };
}

test("[DUR] restart recovery: a crash cannot leave this runner's build sandboxes holding CPU and memory", async () => {
  const cfg = cfg0().jobSandbox;
  const d = fakeDocker([
    { name: "cm-job-bld_a-a1-aaa", runner: cfg.runnerId },
    { name: "cm-job-bld_b-a1-bbb", runner: cfg.runnerId },
    { name: "cm-job-bld_c-a1-ccc", runner: cfg.runnerId },
    { name: "cm-job-bld_d-a1-ddd", runner: cfg.runnerId },
  ]);
  const r = await JobSandbox.reapOrphans(cfg, d.exec, silentLogger);
  assert.equal(r.removed.length, 4, "all four slots' leftovers are cleared before the new slots start");
  assert.deepEqual(r.removed.sort(), d.removed.sort());
  assert.deepEqual(r.unlabelled, []);
  assert.deepEqual(r.errors, []);
  const ps = d.calls.find((c) => c[0] === "ps")!;
  assert.ok(ps.includes("label=crestmont.role=build-sandbox"), "it looks only at build sandboxes");
});

test("[DUR] another runner's sandboxes on the same Docker host are never removed", async () => {
  const cfg = cfg0().jobSandbox;
  const d = fakeDocker([
    { name: "cm-job-mine-a1-aaa", runner: cfg.runnerId },
    { name: "cm-job-theirs-a1-bbb", runner: "win-some-other-runner" },
    { name: "cm-job-old-a1-ccc", runner: "" },  // a release from before the runner label
  ]);
  const r = await JobSandbox.reapOrphans(cfg, d.exec, silentLogger);
  assert.deepEqual(r.removed, ["cm-job-mine-a1-aaa"]);
  assert.equal(r.unlabelled.length, 2, "containers whose owner is someone else, or unknown, are reported not removed");
  assert.ok(r.unlabelled.some((x) => x.includes("win-some-other-runner")));
  assert.ok(!d.removed.includes("cm-job-theirs-a1-bbb"));
  assert.ok(!d.removed.includes("cm-job-old-a1-ccc"));
});

test("[DUR] every sandbox is stamped with the runner that owns it, so the reaper can tell them apart", () => {
  const cfg = cfg0().jobSandbox;
  const ws = createWorkspace(tmp(), { id: "bld_label", attempt: 1 });
  const sb = new JobSandbox(cfg, ws, "bld_label", async () => ok, silentLogger);
  const flags = sb.hardeningFlags("none");
  assert.ok(flags.includes(`crestmont.runner=${cfg.runnerId}`), flags.join(" "));
  assert.ok(flags.includes("crestmont.role=build-sandbox"));
  assert.ok(flags.includes("crestmont.job=bld_label"));
});

test("[DUR] a cleanup failure is reported and never stops the runner from starting", async () => {
  const cfg = cfg0().jobSandbox;
  const exec: DockerExecutor = async (args) => args[0] === "ps"
    ? { ...ok, stdout: `cm-job-stuck-a1-aaa\t${cfg.runnerId}` }
    : { code: 1, stdout: "", stderr: "container is restarting", timedOut: false, notFound: false };
  const r = await JobSandbox.reapOrphans(cfg, exec, silentLogger);
  assert.deepEqual(r.removed, []);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /could not remove cm-job-stuck-a1-aaa/);
});

test("[DUR] an unreachable Docker is reported as one problem, not as a pile of removals", async () => {
  const cfg = cfg0().jobSandbox;
  const r = await JobSandbox.reapOrphans(cfg, async () => ({ code: 1, stdout: "", stderr: "docker daemon not running", timedOut: false, notFound: false }), silentLogger);
  assert.deepEqual(r.removed, []);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /could not list build sandboxes/);
});

test("[DUR] four projects get four independent workspaces, and each resolves back to its own after a restart", () => {
  const root = tmp();
  const refs = ["bld_p1", "bld_p2", "bld_p3", "bld_p4"].map((id) => {
    const ws = createWorkspace(root, { id, attempt: 1 });
    writeFileSync(path.join(ws.repo, "who.txt"), id);
    writeFileSync(path.join(ws.checkpoints, "ckpt-1.tgz"), id);
    return { id, ref: ws.ref, dir: ws.dir };
  });
  assert.equal(new Set(refs.map((r) => r.ref)).size, 4, "no two projects share a workspace ref");
  assert.equal(new Set(refs.map((r) => r.dir)).size, 4);
  // Restart: the runner resolves each workspaceRef from the claim and finds that project's own files and checkpoint.
  for (const r of refs) {
    const found = findLocalWorkspace(root, r.ref);
    assert.ok(found, `${r.id} is found again by its ref`);
    assert.equal(readFileSync(path.join(found!.repo, "who.txt"), "utf8"), r.id, "a project's repository is its own");
    const cp = latestCheckpointFile(found!);
    assert.ok(cp && readFileSync(cp, "utf8") === r.id, "a project's checkpoint is its own");
  }
});

test("[DUR] one project's checkpoints do not become another's latest", () => {
  const root = tmp();
  const a = createWorkspace(root, { id: "bld_a", attempt: 1 });
  const b = createWorkspace(root, { id: "bld_b", attempt: 1 });
  for (const n of [1, 2, 3]) writeFileSync(path.join(a.checkpoints, `ckpt-${n}.tgz`), `a${n}`);
  writeFileSync(path.join(b.checkpoints, "ckpt-1.tgz"), "b1");
  assert.equal(readFileSync(latestCheckpointFile(a)!, "utf8"), "a3", "the latest is this project's highest, by number not by name");
  assert.equal(readFileSync(latestCheckpointFile(b)!, "utf8"), "b1");
  assert.ok(existsSync(path.join(a.checkpoints, "ckpt-1.tgz")), "earlier checkpoints are kept as evidence");
});

test("[DUR] health never reports four busy slots as four-way progress while three are queued", () => {
  const h = newHealthState({ runnerId: "r", version: "1.1.0", provider: "local", model: "m", slots: 4 });
  h.runningJobs = ["bld_a", "bld_b", "bld_c", "bld_d"];
  h.currentJob = "bld_d";
  h.lastClaimAt = new Date().toISOString();
  h.lastClaimOk = true;
  h.lanes = [{ name: "install", capacity: 1, active: 1, queued: 0, peakQueued: 1, waitMs: 500, admitted: 2 },
             { name: "checks", capacity: 1, active: 1, queued: 2, peakQueued: 2, waitMs: 1200, admitted: 3 }];
  h.inference = { state: "builder", active: 1, queued: 1, switches: 4 };
  const s = healthStatus(h);
  assert.equal(s.ok, true);
  assert.match(s.reason, /running 4 builds, 3 waiting for a lane or the GPU/);
  assert.equal(h.slots, 4, "the configured slot count is reported beside what is running");

  // `newHealthState` defaults slots to 1 for callers that have no config, and main() is NOT one of them: it has
  // `cfg.slots`, ran that many claim loops, and still reported one slot on the endpoint an operator checks to
  // confirm capacity. The wiring lives inside main(), which is not exported, so this asserts the call site.
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const call = main.match(/newHealthState\(\{.*/);
  assert.ok(call, "main() must build the health state");
  assert.match(call[0], /slots: cfg\.slots/, `the health endpoint must report the configured capacity: ${call[0]}`);
});

test("[DUR] lane figures reported to the platform separate waiting from working", async () => {
  const limits = new HostLimits({ install: 1, checks: 1 });
  let release: (() => void) | null = null;
  const held = limits.checks.run(() => new Promise<void>((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 5));
  const queued = [limits.checks.run(async () => {}), limits.checks.run(async () => {})];
  await new Promise((r) => setTimeout(r, 5));
  const checks = limits.status().find((l) => l.name === "checks")!;
  assert.equal(checks.active, 1, "one project is working");
  assert.equal(checks.queued, 2, "two are waiting, and are counted as waiting");
  assert.equal(checks.capacity, 1);
  release!();
  await Promise.all([held, ...queued]);
  const after = limits.status().find((l) => l.name === "checks")!;
  assert.equal(after.active, 0);
  assert.equal(after.queued, 0);
  assert.equal(after.admitted, 3, "every project was served");
  assert.ok(after.waitMs > 0, "the time spent waiting is kept, so a narrow lane is visible as a narrow lane");
});

test("[DUR] two slots of one runner never build the same project twice: the second hands it back as released", async () => {
  // The control plane leases jobs, so a duplicate means a server-side fault -- but the slots share this process, so the
  // local check belongs here too. Without it the second slot builds the same project into a second workspace and the
  // two attempts race over one repository.
  const job = makeJob();
  const cp = await startFakeControlPlane({ jobs: [job, { ...job }] });  // the same job handed to two slots
  try {
    const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: "r" });
    const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(testManifest()) });
    let building = 0, peakBuilding = 0;
    let releaseFirst: (() => void) | null = null;
    const firstHeld = new Promise<void>((r) => { releaseFirst = r; });
    const runJobImpl = (async (j: { id: string }) => {
      building++;
      peakBuilding = Math.max(peakBuilding, building);
      if (building === 1) await firstHeld;      // slot 0 holds the job while slot 1 claims it
      building--;
      return { outcome: "ready_for_review", turns: 1, complete: null, checks: [] };
    }) as never;

    // Slot 1's claim is what must be refused, so let both slots start at once.
    const loops = runSlots({ cfg, client, manifest: testManifest(), logger: silentLogger, shouldStop: () => false, once: true, runJobImpl }, 2, 0);
    // Wait for the release: it arrives only once the duplicate has been dealt with.
    const deadline = Date.now() + 10_000;
    while (cp.byPath("complete").length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    releaseFirst!();
    await loops;

    assert.equal(peakBuilding, 1, "only one slot ever built this project");
    const completes = cp.byPath("complete");
    const released = completes.filter((c) => c.body.outcome === "released");
    assert.equal(released.length, 1, `exactly one release; got ${JSON.stringify(completes.map((c) => c.body.outcome))}`);
    assert.match(String(released[0].body.error), /duplicate claim within one runner/);
    assert.equal(released[0].body.jobId, job.id);
  } finally { await cp.close(); }
});

test("[DUR] a project that finishes releases its slot, so the next project is not blocked by the last one's id", async () => {
  const a = makeJob(), b = makeJob();
  const cp = await startFakeControlPlane({ jobs: [a, b] });
  try {
    const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: "r" });
    const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(testManifest()) });
    const built: string[] = [];
    const runJobImpl = (async (j: { id: string }) => {
      built.push(j.id);
      // A crash must release the id just as a clean finish does.
      if (j.id === a.id) throw new Error("project a crashed");
      return { outcome: "ready_for_review", turns: 1, complete: null, checks: [] };
    }) as never;
    const shared = { modelOk: true, active: new Set<string>() };
    await runSlots({ cfg, client, manifest: testManifest(), logger: silentLogger, shouldStop: () => built.length >= 2, once: false, runJobImpl, shared,
      sleep: async () => {} }, 1, 0);
    assert.deepEqual(built, [a.id, b.id], "both projects ran; the crashed one did not leave its id held");
    assert.equal(shared.active.size, 0, "no project id is still marked active");
  } finally { await cp.close(); }
});

test("[DUR] an uploaded frontend is still imported while every slot is building", async () => {
  // Imports ran in slot 0's idle branch, under a comment saying an import must never take a slot from a build. At
  // one slot that was true and harmless. At four, all four building means NOTHING is ever imported: the submitted
  // frontend cannot be measured, so it cannot be approved, so it cannot be queued -- until a build finishes, and a
  // build is the long thing. This holds every slot busy and requires the import to happen anyway.
  const jobs = [makeJob(), makeJob(), makeJob(), makeJob()];
  const cp = await startFakeControlPlane({ jobs });
  try {
    const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: "r" });
    const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(testManifest()) });

    let building = 0, peak = 0;
    let imported = 0;
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => { release = r; });
    const runJobImpl = (async () => {
      building++; peak = Math.max(peak, building);
      await held;                       // every slot stays in a build until the import has happened
      building--;
      return { outcome: "ready_for_review", turns: 1, complete: null, checks: [] };
    }) as never;

    let stop = false;
    // A real (tiny) timer, not a no-op: a loop that only ever awaits already-resolved promises drains the microtask
    // queue forever and the timer phase never runs, so this test's own polling below would never advance.
    const tick = async () => { await new Promise((r) => setTimeout(r, 1)); };
    const loops = runSlots({
      cfg, client, manifest: testManifest(), logger: silentLogger, shouldStop: () => stop, once: false, runJobImpl,
      sleep: tick,
      // It imports only once every slot is occupied, so the import happening at all IS the assertion.
      imports: { serve: async () => { if (building < 4 || imported > 0) { await tick(); return "none"; } imported++; return "done"; } },
    }, 4, 0);

    const deadline = Date.now() + 20_000;
    while (imported === 0 && Date.now() < deadline) await tick();
    stop = true;
    release();
    await loops;

    assert.equal(peak, 4, `all four slots have to be in a build for this to prove anything (peak ${peak})`);
    assert.equal(imported, 1, "the uploaded frontend was imported while all four slots were building");
  } finally { await cp.close(); }
});
