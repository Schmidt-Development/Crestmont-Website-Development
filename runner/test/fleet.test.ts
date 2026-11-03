// Phase 6: multi-GPU registration and dispatch. Node 1 has one GPU, so a second device is proven the only way it
// honestly can be at this point: with real schedulers over fake residencies, which is where the dispatch decision
// actually lives. No GPU is provisioned and no service is started.
//
// The single-device case is checked first and hardest, because that is what Node 1 runs today: registering nothing
// new must change nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDevices, type GpuDevice } from "../src/inference/devices.ts";
import { GpuFleet } from "../src/inference/fleet.ts";
import { InferenceScheduler } from "../src/inference/scheduler.ts";
import type { Residency, LoadedModel } from "../src/inference/ollama.ts";
import { loadConfig } from "../src/config.ts";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "fleet-"));
const A = { tag: "qwen3.8:27b-q4_K_M", role: "architect_reviewer", contextTokens: 49152, vramMb: 18748, reasoning: null, vision: true, license: "Apache-2.0", quantization: "Q4_K_M" };
const B = { tag: "qwen3.6:35b-a3b-q4_K_M", role: "builder", contextTokens: 49152, vramMb: 22594, reasoning: null, vision: false, license: "Apache-2.0", quantization: "Q4_K_M" };
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A residency that tracks what is loaded, with no model server. */
function fakeResidency(initial: LoadedModel[] = []): Residency {
  let loaded = [...initial];
  return {
    loaded: async () => [...loaded],
    load: async (m: string) => { loaded = [{ model: m, vramMb: m === A.tag ? A.vramMb : B.vramMb }]; },
    unload: async (m: string) => { loaded = loaded.filter((x) => x.model !== m); },
  } as unknown as Residency;
}

function fleetOf(devices: GpuDevice[], initial: Record<number, LoadedModel[]> = {}): GpuFleet {
  return new GpuFleet({
    devices,
    makeScheduler: (d) => new InferenceScheduler({
      models: [A, B] as never, maxConcurrent: 1, vramTotalMb: d.vramTotalMb, vramReserveMb: 4096,
      switchTimeoutMs: 2000, maxWaitBeforeSwitchMs: 20, minDwellMs: 0, idleGraceMs: 1, keepAlive: "1m",
      endpoint: d, residency: fakeResidency(initial[d.index] ?? []),
    }),
  });
}

const DEV = (index: number, port: number, vramMb = 32607): GpuDevice => ({ index, baseUrl: `http://127.0.0.1:${port}/v1`, vramTotalMb: vramMb, label: `gpu${index}` });

// ── registration ───────────────────────────────────────────────────────────────────────────────────────────────────

test("[FLEET] an installation that registers nothing gets exactly the one GPU it had", () => {
  for (const spec of [undefined, "", "   "]) {
    const d = parseDevices(spec, { baseUrl: "http://host.docker.internal:11434/v1", vramTotalMb: 32563 });
    assert.deepEqual(d, [{ index: 0, baseUrl: "http://host.docker.internal:11434/v1", vramTotalMb: 32563, label: "gpu0" }]);
  }
  // And through the real configuration loader, which is what the installed runner uses.
  const cfg = loadConfig({ CONTROL_PLANE_URL: "https://c.example", BUILD_RUNNER_SECRET: "s".repeat(40), RUNNER_WORKSPACES: tmp(), SKILLS_SOURCE_DIR: tmp(), PATH: "/usr/bin", LOCAL_MODEL: "qwen3-coder:30b", LOCAL_MODEL_BASE_URL: "http://host.docker.internal:11434/v1", GPU_VRAM_TOTAL_MB: "32563" });
  assert.equal(cfg.inference.devices.length, 1);
  assert.deepEqual([cfg.inference.devices[0].index, cfg.inference.devices[0].baseUrl, cfg.inference.devices[0].vramTotalMb], [0, "http://host.docker.internal:11434/v1", 32563]);
});

test("[FLEET] registering a second GPU is one configuration entry, and per-device VRAM is kept", () => {
  const d = parseDevices("0=http://127.0.0.1:11434/v1#32563,1=http://127.0.0.1:11435/v1#49140", { baseUrl: "unused", vramTotalMb: 0 });
  assert.deepEqual(d.map((x) => [x.index, x.baseUrl, x.vramTotalMb, x.label]), [
    [0, "http://127.0.0.1:11434/v1", 32563, "gpu0"],
    [1, "http://127.0.0.1:11435/v1", 49140, "gpu1"],
  ]);
  // Out-of-order entries are sorted, and a missing size falls back to the single-GPU figure.
  const d2 = parseDevices("2=http://127.0.0.1:11436/v1,0=http://127.0.0.1:11434/v1", { baseUrl: "unused", vramTotalMb: 32563 });
  assert.deepEqual(d2.map((x) => x.index), [0, 2]);
  assert.equal(d2[1].vramTotalMb, 32563);
});

test("[FLEET] a malformed device list stops the runner at startup instead of silently losing a GPU", () => {
  const fb = { baseUrl: "http://127.0.0.1:11434/v1", vramTotalMb: 32563 };
  assert.throws(() => parseDevices("gpu0=http://127.0.0.1:11434/v1", fb), /not index=baseUrl/);
  assert.throws(() => parseDevices("0=http://a/v1,0=http://b/v1", fb), /listed twice/);
  assert.throws(() => parseDevices("0=not-a-url", fb), /invalid base URL/);
  assert.throws(() => parseDevices("0=ftp://127.0.0.1/v1", fb), /http or https/);
  assert.throws(() => parseDevices("0=http://same/v1,1=http://same/v1", fb), /one model server owns one device/);
});

// ── dispatch ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("[FLEET] with one GPU the fleet is that GPU: every request goes to it and nothing is aggregated away", async () => {
  const fleet = fleetOf([DEV(0, 11434)]);
  try {
    const endpoints: string[] = [];
    for (const model of [B.tag, A.tag, B.tag]) {
      await fleet.run({ model, projectId: "p1", task: "build" }, async (ep) => { endpoints.push(`${ep.label}|${ep.baseUrl}`); return 1; }, undefined, () => ({ promptTokens: 1, completionTokens: 1, wallMs: 1 }));
    }
    assert.deepEqual(new Set(endpoints), new Set(["gpu0|http://127.0.0.1:11434/v1"]));
    // status() is the device's own status, untouched, so existing reporting behaves exactly as before.
    const st = fleet.status();
    assert.equal(st.maxConcurrent, 1);
    assert.equal(st.active, 0);
    assert.equal(fleet.deviceStatus().length, 1);
    assert.equal(fleet.deviceStatus()[0].dispatched, 3);
  } finally { fleet.close(); }
});

test("[FLEET] a request goes to a GPU that already holds its model, to avoid a 5-6 s model switch", async () => {
  const fleet = fleetOf([DEV(0, 11434), DEV(1, 11435)]);
  const run = (model: string, project: string) => fleet.run({ model, projectId: project, task: "build" }, async () => 1, undefined, () => ({ promptTokens: 1, completionTokens: 1, wallMs: 1 }));
  try {
    // A scheduler only knows what is loaded once it has reconciled with its own model server, so warm both devices
    // first -- which is also the only state in which switch-avoidance can mean anything.
    await run(B.tag, "p1");                                   // tie -> gpu0, which loads the builder
    const second = await fleet.pick(A.tag);
    assert.equal(second.index, 1, "the reviewer goes to the GPU that would not have to evict the builder");
    await run(A.tag, "p2");                                   // gpu1 loads the reviewer
    // Both residencies are now known, and each model has a home.
    assert.equal(fleet.pick(B.tag).index, 0, "the builder goes where the builder is loaded");
    assert.equal(fleet.pick(A.tag).index, 1, "the reviewer goes where the reviewer is loaded");
    // Neither device had to switch models: that is the whole point of the rule.
    const rows = fleet.deviceStatus();
    assert.deepEqual(rows.map((r) => r.inference.switches.count), [0, 0], `no model switches: ${JSON.stringify(rows.map((r) => r.inference.switches))}`);
    assert.deepEqual(rows.map((r) => r.inference.resident.map((x) => x.model)), [[B.tag], [A.tag]]);
  } finally { fleet.close(); }
});

test("[FLEET] when no GPU holds the model, the least loaded one takes it, and ties break deterministically", async () => {
  const fleet = fleetOf([DEV(0, 11434), DEV(1, 11435)]);
  try {
    // Nothing loaded, nothing busy: a tie, so the lowest index wins -- the same answer every time.
    assert.equal(fleet.pick(B.tag).index, 0);
    assert.equal(fleet.pick(B.tag).index, 0);
    // Occupy gpu0 and the next request must go to gpu1 rather than queue behind the busy device.
    let release: (() => void) | null = null;
    const held = fleet.run({ model: B.tag, projectId: "p1", task: "build" }, () => new Promise<number>((r) => { release = () => r(1); }), undefined, () => null);
    await tick(20);
    assert.equal(fleet.pick(B.tag).index, 1, "a free GPU beats a busy one");
    release!();
    await held;
  } finally { fleet.close(); }
});

test("[FLEET] four projects across two GPUs: both are used, and each request runs on the device it was given", async () => {
  const fleet = fleetOf([DEV(0, 11434), DEV(1, 11435)]);
  try {
    const seen: { project: string; device: number; baseUrl: string }[] = [];
    await Promise.all(["p1", "p2", "p3", "p4"].map((project) => fleet.run(
      { model: B.tag, projectId: project, task: "build" },
      async (ep) => { seen.push({ project, device: ep.index, baseUrl: ep.baseUrl }); await tick(15); return 1; },
      undefined, () => ({ promptTokens: 1, completionTokens: 1, wallMs: 15 }))));
    assert.equal(seen.length, 4, "every project ran");
    assert.equal(new Set(seen.map((s) => s.project)).size, 4);
    assert.equal(new Set(seen.map((s) => s.device)).size, 2, `both GPUs were used: ${JSON.stringify(seen)}`);
    // The endpoint each request was handed matches the device it was dispatched to: a request can never be sent to a
    // GPU's queue and then executed against another GPU's model server.
    for (const s of seen) assert.equal(s.baseUrl, `http://127.0.0.1:${11434 + s.device}/v1`, JSON.stringify(s));
    const rows = fleet.deviceStatus();
    assert.equal(rows.reduce((n, r) => n + r.dispatched, 0), 4);
    assert.ok(rows.every((r) => r.dispatched > 0), `work reached both GPUs: ${JSON.stringify(rows.map((r) => r.dispatched))}`);
  } finally { fleet.close(); }
});

test("[FLEET] a GPU too small for the model is not chosen while a GPU that fits is free", () => {
  // gpu0 is an 8 GB card: the 22.6 GB builder cannot be loaded on it at all. gpu1 can hold it.
  const fleet = fleetOf([DEV(0, 11434, 8192), DEV(1, 11435, 32607)]);
  try {
    assert.equal(fleet.pick(B.tag).index, 1, "the model goes to the GPU that can hold it");
  } finally { fleet.close(); }
});

test("[FLEET] fleet-wide status adds up capacity and never claims one GPU's state is the fleet's", async () => {
  const fleet = fleetOf([DEV(0, 11434), DEV(1, 11435)], { 0: [{ model: B.tag, vramMb: B.vramMb }] });
  try {
    await fleet.run({ model: B.tag, projectId: "p1", task: "build" }, async () => 1, undefined, () => ({ promptTokens: 10, completionTokens: 20, wallMs: 100 }));
    const st = fleet.status();
    assert.equal(st.maxConcurrent, 2, "two devices at one concurrent request each");
    assert.match(st.state, /gpu0:/, `every device's state is named: ${st.state}`);
    assert.match(st.state, /gpu1:/, st.state);
    assert.equal(st.active, 0);
    assert.equal(st.queued, 0);
    assert.equal(st.perModel[B.tag].requests, 1, "counters are summed across devices");
  } finally { fleet.close(); }
});

test("[FLEET] a fleet needs at least one device", () => {
  assert.throws(() => new GpuFleet({ devices: [], makeScheduler: () => { throw new Error("unreachable"); } }), /at least one device/);
});
