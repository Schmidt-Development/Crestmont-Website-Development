// Founder V4 inference layer, SIMULATED: a scripted model-residency backend and fake HTTP servers stand in for Ollama
// and the GPU. These tests prove the routing table, the GPU scheduler's rules (batching, switching, timeouts, recovery,
// fairness, concurrency, telemetry honesty) and the Ollama API calls. They do not measure anything on Node 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { ROUTING, TASKS, route, revisionTask, repairTask, buildTask } from "../src/inference/router.ts";
import { InferenceScheduler, ModelUnavailableError } from "../src/inference/scheduler.ts";
import { OllamaResidency, ollamaNativeBase, type LoadedModel, type Residency } from "../src/inference/ollama.ts";
import { readGpuTelemetry, parseNvidiaSmiCsv, GPU_SOURCE } from "../src/inference/gpu.ts";
import { buildWorkerStatus, ModelDetailsCache } from "../src/inference/status.ts";
import { loadConfig, loadModels, type ModelProfile } from "../src/config.ts";
import { makeConfig, tmp, delay } from "./helpers.ts";

const A: ModelProfile = { tag: "qwen3.8:27b-q4_K_M", role: "architect_reviewer", contextTokens: 65536, vramMb: 18000, quantization: "Q4_K_M", reasoning: null, vision: true, license: "Apache-2.0" };
const B: ModelProfile = { tag: "qwen3.6:35b-a3b-q4_K_M", role: "builder", contextTokens: 65536, vramMb: 24000, quantization: "Q4_K_M", reasoning: null, vision: true, license: "Apache-2.0" };
const MODELS = { a: A, b: B, mode: "dual" as const };

test("[AIB-015] router: the Founder's routing table, revisions by difficulty, repairs escalate to Model A when repeated, architectural or integration-heavy", () => {
  const expected: Record<string, "A" | "B"> = { requirements_analysis: "A", architecture: "A", planning: "A", frontend: "B", backend: "B", debugging: "B", complex_change: "A",
    repeated_failure: "A", complex_integration: "A", review: "A", final_review: "A", revision: "B", difficult_revision: "A" };
  assert.deepEqual(ROUTING, expected);
  for (const t of TASKS) assert.equal(route(t, MODELS).model.tag, expected[t] === "A" ? A.tag : B.tag);
  assert.equal(route("frontend", { a: B, b: B, mode: "single" }).model.tag, B.tag, "single-model mode: one model for every task");
  assert.match(route("review", { a: B, b: B, mode: "single" }).reason, /single-model mode/);
  assert.equal(revisionTask("Change the hero image and make the phone number bigger.").task, "revision");
  assert.equal(revisionTask("Add Stripe checkout for the gift boxes").task, "difficult_revision");
  assert.equal(revisionTask("x".repeat(1600)).task, "difficult_revision");
  const base = { outstanding: ["check:links"], sameFailureRepeats: 1, findings: ["the menu link is broken"], escalateAfterRepeats: 2 };
  assert.equal(repairTask(base).task, "debugging");
  assert.equal(repairTask({ ...base, sameFailureRepeats: 2 }).task, "repeated_failure");
  assert.equal(repairTask({ ...base, findings: ["The data model is wrong: bookings are stored per page"] }).task, "complex_change");
  assert.equal(repairTask({ ...base, outstanding: ["criterion:integration-stripe", "security:webhook signature not verified", "check:links"] }).task, "complex_integration");
  assert.equal(buildTask({ tasks: [{ workstream: "backend" }, { workstream: "api" }, { workstream: "frontend" }] }), "backend");
  assert.equal(buildTask(null), "frontend");
});

/** Scripted residency: what is "in GPU memory", with optional load failures and delays. */
function fakeResidency(o: { initial?: LoadedModel[]; failLoad?: (m: string) => boolean; loadMs?: number } = {}) {
  const log: string[] = [];
  let loaded: LoadedModel[] = [...(o.initial ?? [])];
  const r: Residency = {
    async loaded() { return loaded.map((m) => ({ ...m })); },
    async load(model) { log.push(`load ${model}`); if (o.loadMs) await delay(o.loadMs); if (o.failLoad?.(model)) throw new Error("CUDA out of memory"); loaded = [...loaded, { model, vramMb: model === A.tag ? 19500 : 25100 }]; },
    async unload(model) { log.push(`unload ${model}`); loaded = loaded.filter((m) => m.model !== model); },
  };
  return { r, log, get loaded() { return loaded; } };
}

function sched(res: Residency, over: Partial<ConstructorParameters<typeof InferenceScheduler>[0]> = {}) {
  return new InferenceScheduler({ models: [A, B], maxConcurrent: 1, vramTotalMb: 32607, vramReserveMb: 4096, switchTimeoutMs: 2000, maxWaitBeforeSwitchMs: 200, minDwellMs: 0, idleGraceMs: 30, keepAlive: "30m", residency: res, cooldownMs: 500, ...over });
}

const job = (s: InferenceScheduler, model: string, projectId: string, ms = 20, order?: string[]) =>
  s.run({ model, projectId, task: model === A.tag ? "review" : "frontend" }, async () => { order?.push(`${projectId}:${model === A.tag ? "A" : "B"}`); await delay(ms); return { promptTokens: 100, completionTokens: 50, wallMs: ms }; }, undefined, (r) => r);

test("[AIB-015] GPU scheduler: a model owned by another application on the same Ollama (Node 1: HQ/JARVIS) is never unloaded", async () => {
  const jarvis = "qwen3:30b-a3b";
  const f = fakeResidency({ initial: [{ model: jarvis, vramMb: 19000 }, { model: B.tag, vramMb: 25100 }] });
  const s = sched(f.r);
  await Promise.all([job(s, B.tag, "p1"), job(s, A.tag, "p2")]);
  assert.ok(!f.log.includes(`unload ${jarvis}`), "the foreign model was not unloaded");
  assert.deepEqual(f.log, [`unload ${B.tag}`, `load ${A.tag}`], "only Crestmont's own model was switched");
  assert.ok(f.loaded.some((m) => m.model === jarvis), "the foreign model is still resident as far as the runner is concerned");
});

test("[AIB-015] GPU scheduler: Model A and Model B never share the 32 GB GPU when they do not fit (18 + 24 GB + reserve); one model at a time, switches unload then load", async () => {
  const f = fakeResidency({ initial: [{ model: B.tag, vramMb: 25100 }] });
  const s = sched(f.r);
  assert.equal(s.canCoReside([A.tag, B.tag]), false, "18 GB + 24 GB + 4 GB reserve > 32 GB");
  const order: string[] = [];
  await Promise.all([job(s, B.tag, "p1", 20, order), job(s, A.tag, "p2", 20, order)]);
  assert.deepEqual(order, ["p1:B", "p2:A"]);
  assert.deepEqual(f.log, [`unload ${B.tag}`, `load ${A.tag}`], "unloaded B before loading A");
  assert.deepEqual(f.loaded.map((m) => m.model), [A.tag]);
  const st = s.status();
  assert.equal(st.switches.count, 1);
  assert.equal(st.switches.failures, 0);
  assert.equal(st.resident[0].vramMb, 19500, "measured size from the model server replaces the estimate");
  assert.equal(st.perModel[A.tag].requests, 1);
  assert.equal(st.perModel[B.tag].tokensPerSecond, 2500);
  // Unknown GPU size: never assumes they fit.
  assert.equal(sched(f.r, { vramTotalMb: 0 }).canCoReside([A.tag, B.tag]), false);
  // Small models that fit (with the reserve) may share it.
  const small = new InferenceScheduler({ models: [{ ...A, vramMb: 9000 }, { ...B, vramMb: 12000 }], maxConcurrent: 2, vramTotalMb: 32607, vramReserveMb: 4096, switchTimeoutMs: 1000, maxWaitBeforeSwitchMs: 100, keepAlive: "30m", residency: fakeResidency().r });
  assert.equal(small.canCoReside([A.tag, B.tag]), true);
  s.close(); small.close();
});

test("[AIB-015] GPU scheduler: batches by model (the loaded model's queue first), a waiting request switches after its wait limit, the GPU concurrency limit holds, websites are served fairly", async () => {
  const f = fakeResidency({ initial: [{ model: B.tag, vramMb: 25100 }] });
  const s = sched(f.r, { maxConcurrent: 1, maxWaitBeforeSwitchMs: 120, idleGraceMs: 1000 });
  const order: string[] = [];
  let peak = 0;
  const watch = setInterval(() => { peak = Math.max(peak, s.status().active); }, 2);
  // Three websites on B keep the GPU busy; a review (A) arrives meanwhile.
  const all = [job(s, B.tag, "w1", 40, order), job(s, B.tag, "w2", 40, order), job(s, A.tag, "w3", 10, order), job(s, B.tag, "w1", 40, order), job(s, B.tag, "w4", 40, order)];
  await Promise.all(all);
  clearInterval(watch);
  assert.equal(peak, 1, "never more than the configured concurrent GPU requests");
  assert.deepEqual(order.slice(0, 3), ["w1:B", "w2:B", "w4:B"], "B requests run first (batching); the second w1 request yields to w4 (fairness)");
  assert.ok(order.indexOf("w3:A") >= 3, "the review waited for the batch or its limit, not longer");
  assert.ok(s.status().switches.count >= 1);
  // An idle loaded model is switched away from after the grace period, without waiting for the full limit.
  const g = fakeResidency({ initial: [{ model: B.tag, vramMb: 25100 }] });
  const s2 = sched(g.r, { idleGraceMs: 30, maxWaitBeforeSwitchMs: 60_000 });
  const t0 = Date.now();
  await job(s2, A.tag, "solo", 5);
  assert.ok(Date.now() - t0 < 2000, "no 60 s wait when nothing else uses the GPU");
  s.close(); s2.close();
});

test("[AIB-015] GPU scheduler: a failed model load is retried once, then the model cools down and only its waiting requests fail (ModelUnavailableError); the other model keeps working; switch timeouts apply", async () => {
  const f = fakeResidency({ initial: [{ model: B.tag, vramMb: 25100 }], failLoad: (m) => m === A.tag });
  const s = sched(f.r, { idleGraceMs: 10 });
  await assert.rejects(job(s, A.tag, "p1"), ModelUnavailableError);
  assert.equal(f.log.filter((l) => l === `load ${A.tag}`).length, 2, "retried once");
  const st = s.status();
  assert.equal(st.switches.failures, 1);
  assert.match(st.state, /failed: .*qwen3\.8/);
  await assert.rejects(job(s, A.tag, "p2"), /could not be loaded recently/, "cooldown: no reload storm");
  // Model B still serves (reloaded after the failed switch unloaded it).
  const b = await job(s, B.tag, "p3");
  assert.equal(b.completionTokens, 50);
  assert.equal(s.activity("p3"), null);
  // A load that hangs longer than the switch timeout fails instead of blocking the GPU forever.
  const slow = fakeResidency({ initial: [{ model: B.tag, vramMb: 25100 }], loadMs: 400 });
  const r2: Residency = { ...slow.r, load: (m, k) => slow.r.load(m, k) }; // the timeout signal is the scheduler's own
  const s2 = sched({ loaded: r2.loaded, unload: r2.unload, load: async (m, k, signal) => { await new Promise((res, rej) => { const t = setTimeout(res, 400); signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("switch timed out")); }); }); return r2.load(m, k); } }, { switchTimeoutMs: 50, idleGraceMs: 5 });
  await assert.rejects(job(s2, A.tag, "p4"), /could not be loaded/);
  s.close(); s2.close();
});

test("[AIB-015] GPU scheduler: per-website activity (waiting, switching, running) and abort while queued", async () => {
  const f = fakeResidency({ initial: [{ model: B.tag, vramMb: 25100 }], loadMs: 60 });
  const s = sched(f.r, { idleGraceMs: 1000, maxWaitBeforeSwitchMs: 5000 });
  const running = job(s, B.tag, "busy", 80);
  await delay(5);
  assert.equal(s.activity("busy")?.state, "gpu_running");
  const ac = new AbortController();
  const waiting = s.run({ model: A.tag, projectId: "rev", task: "review" }, async () => 1, ac.signal);
  await delay(5);
  assert.equal(s.activity("rev")?.state, "gpu_waiting");
  assert.equal(s.status().queued, 1);
  ac.abort();
  await assert.rejects(waiting, /aborted/);
  assert.equal(s.status().queued, 0);
  await running;
  s.close();
});

test("[AIB-015] Ollama residency: /api/ps, load (empty prompt + keep_alive), unload (keep_alive 0), /api/show details; native base from the /v1 URL", async () => {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  let inMemory: string[] = ["qwen3.6:35b-a3b-q4_K_M"];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      calls.push({ path: req.url!, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/ps") return res.end(JSON.stringify({ models: inMemory.map((m) => ({ name: m, model: m, size: 26e9, size_vram: m.startsWith("qwen3.8") ? 20447232000 : 26318848000 })) }));
      if (req.url === "/api/generate") { if (body!.keep_alive === 0) inMemory = inMemory.filter((m) => m !== body!.model); else inMemory.push(String(body!.model)); return res.end(JSON.stringify({ done: true })); }
      if (req.url === "/api/show") return res.end(JSON.stringify({ license: "                                 Apache License\n                           Version 2.0", details: { family: "qwen38", parameter_size: "27.4B", quantization_level: "Q4_K_M" } }));
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    assert.equal(ollamaNativeBase(base), base.replace(/\/v1$/, ""));
    const o = new OllamaResidency(base);
    assert.deepEqual(await o.loaded(), [{ model: "qwen3.6:35b-a3b-q4_K_M", vramMb: 25100 }]);
    await o.unload("qwen3.6:35b-a3b-q4_K_M");
    await o.load("qwen3.8:27b-q4_K_M", "30m");
    assert.deepEqual(calls.filter((c) => c.path === "/api/generate").map((c) => c.body), [{ model: "qwen3.6:35b-a3b-q4_K_M", keep_alive: 0, stream: false }, { model: "qwen3.8:27b-q4_K_M", prompt: "", keep_alive: "30m", stream: false }]);
    assert.deepEqual(await o.loaded(), [{ model: "qwen3.8:27b-q4_K_M", vramMb: 19500 }]);
    assert.deepEqual(await o.details("qwen3.8:27b-q4_K_M"), { family: "qwen38", parameterSize: "27.4B", quantization: "Q4_K_M", license: "Apache-2.0" });
  } finally { server.close(); }
});

test("[AIB-015] GPU telemetry and worker status are reported only as measured: stale or missing samples are 'not reported'; configured model sizes are labelled estimates", async () => {
  const dir = tmp("aib-gpu-");
  const file = path.join(dir, "gpu.json");
  assert.equal(readGpuTelemetry(file), null, "no sampler → not reported");
  writeFileSync(file, JSON.stringify({ at: new Date(Date.now() - 10 * 60_000).toISOString(), name: "NVIDIA GeForce RTX 5090", memoryTotalMb: 32607, memoryUsedMb: 20000, utilizationPercent: 80 }));
  assert.equal(readGpuTelemetry(file), null, "a sample older than 3 minutes is not reported");
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), name: "NVIDIA GeForce RTX 5090", driver: "581.57", memoryTotalMb: 32607, memoryUsedMb: 20000, utilizationPercent: 80 }));
  assert.deepEqual({ ...readGpuTelemetry(file)!, at: "" }, { name: "NVIDIA GeForce RTX 5090", driver: "581.57", vramTotalMb: 32607, vramUsedMb: 20000, utilPercent: 80, at: "", source: GPU_SOURCE });
  assert.deepEqual(parseNvidiaSmiCsv("NVIDIA GeForce RTX 5090, 581.57, 32607, 1203, 4"), { name: "NVIDIA GeForce RTX 5090", driver: "581.57", vramTotalMb: 32607, vramUsedMb: 1203, utilPercent: 4 });
  assert.equal(parseNvidiaSmiCsv("garbage"), null);
  const f = fakeResidency({ initial: [{ model: B.tag, vramMb: 25100 }] });
  const s = sched(f.r);
  await job(s, B.tag, "p1");
  const cfg = makeConfig({ controlPlaneUrl: "http://x", skillsSourceDir: "x", models: MODELS, inference: { ...makeConfig({ controlPlaneUrl: "http://x", skillsSourceDir: "x" }).inference, telemetryFile: file } });
  const st = await buildWorkerStatus(cfg, s, { total: 4, busy: 1 }, new ModelDetailsCache({ ...f.r, details: async () => ({ family: "qwen", parameterSize: "27B", quantization: "Q4_K_M", license: "Apache-2.0" }) }));
  assert.equal(st.gpu?.source, GPU_SOURCE);
  assert.equal(st.inference?.state, `ready: ${B.tag}`);
  assert.deepEqual(st.models!.map((m) => [m.tag, m.role, m.vramMb, m.vramSource]), [[A.tag, "architect_reviewer", 18000, "configured-estimate"], [B.tag, "builder", 25100, "measured"]]);
  assert.equal(st.models![1].requests, 1);
  assert.deepEqual([st.slotsTotal, st.slotsBusy], [4, 1]);
  s.close();
});

test("[AIB-015] configuration: Model A / Model B (dual) or one model (single); the V3 Claude subscription provider is gone; reasoning values validated", () => {
  const env = { CONTROL_PLANE_URL: "https://c.example", BUILD_RUNNER_SECRET: "s".repeat(40), RUNNER_WORKSPACES: tmp(), SKILLS_SOURCE_DIR: tmp(), PATH: "/usr/bin" };
  const dual = loadConfig({ ...env, LOCAL_MODEL_A: A.tag, LOCAL_MODEL_B: B.tag, LOCAL_MODEL_CONTEXT_TOKENS: "65536", LOCAL_MODEL_A_VRAM_MB: "18000", LOCAL_MODEL_A_VISION: "true", RUNNER_SLOTS: "4", INFERENCE_MAX_CONCURRENT: "2", GPU_VRAM_TOTAL_MB: "32607" });
  assert.equal(dual.models.mode, "dual");
  assert.deepEqual([dual.models.a.tag, dual.models.a.role, dual.models.a.quantization, dual.models.a.vramMb, dual.models.a.vision], [A.tag, "architect_reviewer", "Q4_K_M", 18000, true]);
  assert.deepEqual([dual.models.b.tag, dual.models.b.role, dual.local.model], [B.tag, "builder", B.tag]);
  assert.deepEqual([dual.slots, dual.inference.maxConcurrent, dual.inference.vramTotalMb, dual.advisor.architect, dual.advisor.reviewer], [4, 2, 32607, "local", "local"]);
  const single = loadConfig({ ...env, LOCAL_MODEL: "qwen3-coder:30b-a3b-q4_K_M" });
  assert.equal(single.models.mode, "single");
  assert.equal(single.models.a.tag, single.models.b.tag);
  assert.throws(() => loadConfig({ ...env, LOCAL_MODEL: "x", RUNNER_AGENT_PROVIDER: "claude-code" }), /removed \(Founder directive V4\)/);
  assert.throws(() => loadConfig({ ...env }), /LOCAL_MODEL_B \(or LOCAL_MODEL\)/);
  assert.throws(() => loadModels({ LOCAL_MODEL_A: "a", LOCAL_MODEL_A_REASONING: "max" }, "b"), /must be high, medium or low/);
});

test("[AIB-015] review fixes: an unreachable model server puts no model on cooldown; cooldown errors are recognisable as 'could not be loaded'; no busy re-arming while requests drain", async () => {
  // 1. Start-up residency check fails (server down), then succeeds: the waiting request runs; no cooldown, no failed state.
  let down = true;
  const f = fakeResidency();
  const flaky: Residency = { ...f.r, loaded: async () => { if (down) throw new Error("connect ECONNREFUSED"); return f.r.loaded(); } };
  const s = new InferenceScheduler({ models: [A, B], maxConcurrent: 1, vramTotalMb: 32607, vramReserveMb: 4096, switchTimeoutMs: 1000, maxWaitBeforeSwitchMs: 50, minDwellMs: 0, idleGraceMs: 5, keepAlive: "30m", residency: flaky, reconcileRetryMs: 30 });
  const p = job(s, B.tag, "p1");
  await delay(50);
  assert.doesNotMatch(s.status().state, /failed/);
  down = false;
  assert.equal((await p).completionTokens, 50);
  assert.equal(s.status().switches.failures, 0);
  s.close();
  // 2. Cooldown message matches the runner's model-unavailable handling.
  const g = fakeResidency({ initial: [{ model: B.tag, vramMb: 25100 }], failLoad: (m) => m === A.tag });
  const s2 = sched(g.r, { idleGraceMs: 5 });
  await assert.rejects(job(s2, A.tag, "x"), /could not be loaded/);
  await assert.rejects(job(s2, A.tag, "y"), /could not be loaded recently/);
  s2.close();
  // 3. Pump is not re-armed every 20 ms while a long request drains.
  const h = fakeResidency({ initial: [{ model: B.tag, vramMb: 25100 }] });
  const s3 = sched(h.r, { maxWaitBeforeSwitchMs: 10, idleGraceMs: 5 });
  let pumps = 0;
  const orig = (s3 as unknown as { pump: () => void }).pump.bind(s3);
  (s3 as unknown as { pump: () => void }).pump = () => { pumps++; orig(); };
  await Promise.all([job(s3, B.tag, "long", 400), (async () => { await delay(5); await job(s3, A.tag, "rev", 5); })()]);
  assert.ok(pumps < 30, `pump ran ${pumps} times`);
  s3.close();
});
