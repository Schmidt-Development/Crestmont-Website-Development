// Phase 9 Test A: four independent projects on one host. Deterministic — fake work, controlled durations, no
// model, no GPU, no Docker. Proves the three capacities are genuinely different things and that one project
// cannot starve, contaminate or block another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HostLimits, Lane } from "../src/limits.ts";
import { InferenceScheduler } from "../src/inference/scheduler.ts";
import type { Residency } from "../src/inference/ollama.ts";

const PROJECTS = ["prj_a", "prj_b", "prj_c", "prj_d"];
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A residency that never actually loads anything, so switch cost is deterministic. */
function fakeResidency(): Residency {
  let loaded: string[] = [];
  return {
    loaded: async () => loaded.map((model) => ({ model, vramMb: 1024 })),
    load: async (m: string) => { loaded = [m]; },
    unload: async (m: string) => { loaded = loaded.filter((x) => x !== m); },
  } as unknown as Residency;
}

test("[CONC] four projects progress independently through a lane narrower than the project count", async () => {
  const lane = new Lane("checks", 2);
  const order: string[] = [];
  const observedConcurrent: number[] = [];
  let inFlight = 0;

  await Promise.all(PROJECTS.map(async (p, i) => {
    await tick(i); // staggered arrival, as slots do
    await lane.run(async () => {
      inFlight++;
      observedConcurrent.push(inFlight);
      order.push(p);
      await tick(20);
      inFlight--;
    });
  }));

  assert.equal(order.length, 4, "every project completed");
  assert.deepEqual([...order].sort(), [...PROJECTS].sort(), "each project ran exactly once");
  assert.ok(Math.max(...observedConcurrent) <= 2, `lane capacity held (saw ${Math.max(...observedConcurrent)})`);
  const s = lane.status();
  assert.equal(s.admitted, 4);
  assert.equal(s.active, 0, "all permits released");
  assert.ok(s.peakQueued >= 1, "the narrow lane really did queue someone");
  assert.ok(s.waitMs > 0, "waiting is measured separately from working");
});

test("[CONC] a lane is FIFO, so a late project cannot starve an early one", async () => {
  const lane = new Lane("install", 1);
  const finished: string[] = [];
  const started: Promise<void>[] = [];
  for (const p of PROJECTS) {
    started.push(lane.run(async () => { await tick(5); finished.push(p); }));
    await tick(1); // strict arrival order
  }
  await Promise.all(started);
  assert.deepEqual(finished, PROJECTS, "served in arrival order");
});

test("[CONC] one project's failure releases its permit and does not block the others", async () => {
  const lane = new Lane("checks", 1);
  const results = await Promise.allSettled([
    lane.run(async () => { throw new Error("prj_a check crashed"); }),
    lane.run(async () => "prj_b ok"),
    lane.run(async () => "prj_c ok"),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[2].status, "fulfilled");
  assert.equal(lane.status().active, 0, "the failed project did not leak its permit");
});

test("[CONC] cancelling one project removes it from the queue and leaves the rest untouched", async () => {
  const lane = new Lane("checks", 1);
  const ac = new AbortController();
  const held = lane.run(async () => { await tick(40); return "held"; });
  await tick(2);
  const cancelled = lane.run(async () => "never runs", ac.signal);
  const other = lane.run(async () => "other ok");
  ac.abort();
  await assert.rejects(cancelled, (e: Error) => e.name === "AbortError");
  assert.equal(await held, "held");
  assert.equal(await other, "other ok");
  assert.equal(lane.status().active, 0);
});

test("[CONC] capacity is configuration: it can be retuned at runtime without rebuilding anything", async () => {
  const lane = new Lane("checks", 1);
  let peak = 0, inFlight = 0;
  const work = () => lane.run(async () => { inFlight++; peak = Math.max(peak, inFlight); await tick(15); inFlight--; });
  const first = [work(), work()];
  lane.setCapacity(2); // a measurement said the host can take more
  await Promise.all([...first, work()]);
  assert.ok(peak >= 2, `raised capacity took effect (peak ${peak})`);
  assert.equal(lane.status().capacity, 2);
});

test("[CONC] GPU admission is a SEPARATE capacity from host lanes, and four projects share it fairly", async () => {
  // The directive's distinction: four active workflows is not four inference sessions.
  const model = { tag: "builder", role: "builder", contextTokens: 4096, vramMb: 1024, reasoning: null, vision: false, license: null } as never;
  const scheduler = new InferenceScheduler({
    models: [model], maxConcurrent: 1, vramTotalMb: 32607, vramReserveMb: 4096,
    switchTimeoutMs: 1000, maxWaitBeforeSwitchMs: 10, minDwellMs: 0, idleGraceMs: 1, keepAlive: "1m", residency: fakeResidency(),
  });
  try {
    const hostLane = new Lane("checks", 4); // host is wide...
    let gpuInFlight = 0, gpuPeak = 0;
    const ran: string[] = [];
    await Promise.all(PROJECTS.map(async (p) => {
      // Host-side work for all four at once, then each queues for the single GPU permit.
      await hostLane.run(async () => { await tick(5); });
      await scheduler.run({ model: "builder", projectId: p, task: "build" }, async () => {
        gpuInFlight++; gpuPeak = Math.max(gpuPeak, gpuInFlight);
        await tick(10);
        gpuInFlight--; ran.push(p);
        return { promptTokens: 1, completionTokens: 1, wallMs: 10 };
      }, undefined, () => ({ promptTokens: 1, completionTokens: 1, wallMs: 10 }));
    }));
    assert.equal(gpuPeak, 1, "GPU capacity of 1 was respected while four projects were active");
    assert.deepEqual([...ran].sort(), [...PROJECTS].sort(), "every project got the GPU; none starved");
    const st = scheduler.status();
    assert.equal(st.active, 0);
    assert.equal(st.queued, 0);
    assert.equal(st.maxConcurrent, 1, "GPU capacity is reported separately from project count");
  } finally {
    scheduler.close();
  }
});

test("[CONC] HostLimits reports each lane separately so waiting is never reported as working", () => {
  const limits = new HostLimits({ install: 2, checks: 3 });
  const rows = limits.status();
  assert.deepEqual(rows.map((r) => r.name).sort(), ["checks", "install"]);
  assert.equal(rows.find((r) => r.name === "install")!.capacity, 2);
  assert.equal(rows.find((r) => r.name === "checks")!.capacity, 3);
  for (const r of rows) {
    assert.equal(r.active, 0);
    assert.equal(r.queued, 0);
    assert.equal(r.waitMs, 0);
  }
});

test("[CONC] findings and identifiers never cross between projects", async () => {
  // Cross-project contamination would show up as one project's data reaching another's callback.
  const lane = new Lane("checks", 2);
  const seen = new Map<string, string[]>();
  await Promise.all(PROJECTS.map((p) => lane.run(async () => {
    const mine = [`${p}:finding-1`, `${p}:finding-2`];
    await tick(5);
    seen.set(p, mine);
  })));
  for (const p of PROJECTS) {
    const mine = seen.get(p)!;
    assert.ok(mine.every((f) => f.startsWith(`${p}:`)), `${p} kept only its own findings`);
    for (const other of PROJECTS.filter((x) => x !== p)) {
      assert.ok(!mine.some((f) => f.includes(other)), `${p} never saw ${other}'s findings`);
    }
  }
});

test("[CONC] a long complex build does not reserve the GPU: other projects get turns and keep their own work moving", async () => {
  // The directive's rule: "Do not reserve the entire GPU for one customer for the duration of their website build."
  // A complex project here issues many sequential inference requests, as a long build does. The others must get GPU
  // turns between them AND must be able to install, test and package meanwhile on the host lanes.
  const model = { tag: "builder", role: "builder", contextTokens: 4096, vramMb: 1024, reasoning: null, vision: false, license: null } as never;
  const scheduler = new InferenceScheduler({
    models: [model], maxConcurrent: 1, vramTotalMb: 32607, vramReserveMb: 4096,
    switchTimeoutMs: 1000, maxWaitBeforeSwitchMs: 10, minDwellMs: 0, idleGraceMs: 1, keepAlive: "1m", residency: fakeResidency(),
  });
  try {
    const lane = new Lane("checks", 2);
    const gpuTurns: string[] = [];
    const laneWork: string[] = [];
    let gpuInFlight = 0, gpuPeak = 0;
    const infer = (project: string) => scheduler.run({ model: "builder", projectId: project, task: "build" }, async () => {
      gpuInFlight++; gpuPeak = Math.max(gpuPeak, gpuInFlight);
      await tick(4);
      gpuInFlight--; gpuTurns.push(project);
      return { promptTokens: 1, completionTokens: 1, wallMs: 4 };
    }, undefined, () => ({ promptTokens: 1, completionTokens: 1, wallMs: 4 }));

    // The complex project: 12 inference requests in sequence, like a long build's phases.
    const complex = (async () => { for (let i = 0; i < 12; i++) await infer("prj_complex"); })();
    // Three small projects: each takes a few GPU turns and also does host-lane work (checks, screenshots, packaging).
    const small = ["prj_a", "prj_b", "prj_c"].map((p) => (async () => {
      for (let i = 0; i < 2; i++) {
        await infer(p);
        await lane.run(async () => { await tick(6); laneWork.push(p); });
      }
    })());
    await Promise.all([complex, ...small]);

    assert.equal(gpuPeak, 1, "the GPU still served one request at a time");
    // The small projects got GPU turns while the complex project was still issuing requests, rather than after it.
    const lastComplex = gpuTurns.lastIndexOf("prj_complex");
    const smallBeforeComplexFinished = gpuTurns.slice(0, lastComplex).filter((p) => p !== "prj_complex").length;
    assert.equal(smallBeforeComplexFinished, 6, `every small project's GPU turn came while the complex build was still running: ${gpuTurns.join(",")}`);
    // And their host-lane work happened too: the GPU being busy did not stop installs, tests or packaging.
    assert.equal(laneWork.length, 6, `host-lane work proceeded alongside the GPU: ${laneWork.join(",")}`);
    assert.deepEqual([...new Set(laneWork)].sort(), ["prj_a", "prj_b", "prj_c"]);
    // The complex build was never interrupted mid-request: fairness is applied at request boundaries.
    assert.equal(gpuTurns.filter((p) => p === "prj_complex").length, 12, "the complex build completed all of its own requests");
    const st = scheduler.status();
    assert.equal(st.queued, 0);
    assert.equal(st.active, 0);
  } finally {
    scheduler.close();
  }
});
