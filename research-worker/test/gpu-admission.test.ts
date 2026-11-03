// Cooperative GPU admission and non-blocking drafts. Node 1 shares one RTX 5090 and one Ollama with the AI Website
// Builder, so these tests pin the promise that matters: research never takes the GPU from a website build, and a
// missing draft never costs a prospect, a delivery or a throughput count. All businesses and tags are TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GpuAdmission, sameModelTag } from "../src/gpu-admission.ts";
import { LocalModel } from "../src/model.ts";
import { State } from "../src/state.ts";
import { loadConfig } from "../src/config.ts";
import { ResearchWorker } from "../src/orchestrator.ts";
import { Platform } from "../src/crm-client.ts";
import { silentLogger } from "../src/log.ts";
import { FakeHttp, cand, ok, page } from "./helpers.ts";

const MODEL = "qwen2.5:7b-instruct";
const BUILDER_MODEL = "qwen3-coder:30b";
const NO_GPU = async () => null;
const idleGpu = async () => ({ utilPct: 2, memUsedMb: 1_000, memTotalMb: 32_000, name: "NVIDIA GeForce RTX 5090" });

/** Ollama /api/ps double. */
const ps = (models: string[], ok = true): typeof fetch =>
  (async (url: string | URL) => {
    assert.match(String(url), /\/api\/ps$/);
    if (!ok) throw new Error("connection refused (fixture)");
    return new Response(JSON.stringify({ models: models.map((m) => ({ name: m, model: m, size: 1, size_vram: 1 })) }), { status: 200 });
  }) as typeof fetch;

const admission = (over: Record<string, unknown> = {}) => new GpuAdmission({
  baseUrl: "http://127.0.0.1:11434", modelTag: MODEL, maxUtilPct: 25, minFreeMb: 8_000,
  keepAlive: "30s", backoffMs: 0, fetchImpl: ps([]), gpuImpl: NO_GPU, ...over,
});

test("admission refuses the GPU while the Website Builder's model is resident", async () => {
  const a = admission({ fetchImpl: ps([BUILDER_MODEL]), gpuImpl: idleGpu });
  const d = await a.check();
  assert.equal(d.allowed, false);
  assert.match(d.reason, /another application's model is resident/);
  assert.match(d.reason, new RegExp(BUILDER_MODEL));
  assert.equal(a.stats.refusedForeignModel, 1);
});

test("admission refuses when Ollama does not answer: unknown GPU state is never treated as free", async () => {
  const a = admission({ fetchImpl: ps([], false) });
  const d = await a.check();
  assert.equal(d.allowed, false);
  assert.match(d.reason, /GPU state unknown/);
  assert.equal(a.stats.refusedUnknown, 1);
});

test("admission refuses while the GPU is busy even with no foreign model loaded", async () => {
  const a = admission({ fetchImpl: ps([MODEL]), gpuImpl: async () => ({ utilPct: 80, memUsedMb: 20_000, memTotalMb: 32_000, name: "RTX 5090" }) });
  const d = await a.check();
  assert.equal(d.allowed, false);
  assert.match(d.reason, /80% busy/);
  assert.equal(a.stats.refusedBusy, 1);
});

test("admission refuses to load a second model without memory headroom, but not when ours is already resident", async () => {
  const tight = async () => ({ utilPct: 1, memUsedMb: 30_000, memTotalMb: 32_000, name: "RTX 5090" });
  const cold = admission({ fetchImpl: ps([]), gpuImpl: tight });
  const d1 = await cold.check();
  assert.equal(d1.allowed, false);
  assert.match(d1.reason, /headroom/);
  // Already loaded: drafting needs no new memory, so the headroom rule does not apply.
  const warm = admission({ fetchImpl: ps([MODEL]), gpuImpl: tight });
  assert.equal((await warm.check()).allowed, true);
});

test("admission allows an idle GPU, and a host with no NVIDIA GPU has nothing to contend for", async () => {
  assert.equal((await admission({ fetchImpl: ps([MODEL]), gpuImpl: idleGpu }).check()).allowed, true);
  const none = await admission({ fetchImpl: ps([]), gpuImpl: NO_GPU }).check();
  assert.equal(none.allowed, true);
  assert.match(none.reason, /no NVIDIA GPU/);
});

test("a refusal is sticky for the backoff window, so a busy builder is not polled per prospect", async () => {
  const a = admission({ fetchImpl: ps([BUILDER_MODEL]), gpuImpl: idleGpu, backoffMs: 60_000 });
  await a.check();
  await a.check();
  await a.check();
  assert.equal(a.stats.checks, 1, "only the first check reached Ollama");
});

test("model tags compare on the base name, so qwen2.5:7b-instruct and its :latest are one model", () => {
  assert.equal(sameModelTag("llama3", "llama3:latest"), true);
  assert.equal(sameModelTag("qwen2.5:7b-instruct", "qwen2.5:7b-instruct"), true);
  assert.equal(sameModelTag("qwen2.5:7b-instruct", BUILDER_MODEL), false);
});

test("a refused draft never calls Ollama and is reported as deferred, not failed", async () => {
  let generated = 0;
  const m = new LocalModel({ baseUrl: "http://127.0.0.1:11434", name: MODEL, timeoutMs: 1000, numCtx: 4096, concurrency: 1,
    admission: admission({ fetchImpl: ps([BUILDER_MODEL]), gpuImpl: idleGpu }) });
  const d = await m.draft({ name: "Riverside Plumbing", category: "plumber", city: "Lansing", state: "MI", websiteClass: "VERIFIED_WEBSITE_BROKEN",
    websiteUrl: null, findings: [], recommendedPackage: "business", allowedDomains: [] },
    (async () => { generated++; return new Response("{}"); }) as typeof fetch);
  assert.equal(generated, 0, "the GPU was never asked to generate anything");
  assert.equal(d.deferred, true);
  assert.equal(d.summary, null);
  assert.deepEqual(d.rejected, [], "a deferral is not a rejected draft");
  assert.equal(m.failures, 0, "a deferral is not a failure");
  assert.equal(m.deferred, 1);
});

test("an allowed draft sends a short keep_alive so research does not squat the builder's VRAM", async () => {
  let body: Record<string, unknown> = {};
  const m = new LocalModel({ baseUrl: "http://127.0.0.1:11434", name: MODEL, timeoutMs: 1000, numCtx: 4096, concurrency: 1,
    keepAlive: "30s", admission: admission({ fetchImpl: ps([MODEL]), gpuImpl: idleGpu }) });
  await m.draft({ name: "Riverside Plumbing", category: "plumber", city: "Lansing", state: "MI", websiteClass: "VERIFIED_WEBSITE_BROKEN",
    websiteUrl: null, findings: [], recommendedPackage: "business", allowedDomains: [] },
    (async (_u: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ summary: "A website check found the listed site does not load.", brief: "Ask whether they know the site is down." }) } }), { status: 200 });
    }) as typeof fetch);
  assert.equal(body.keep_alive, "30s");
  assert.equal(body.model, MODEL);
});

test("config defaults keep the GPU guard on, drafts off, and the model on loopback", () => {
  const c = loadConfig({ CRESTMONT_URL: "https://staging.example.workers.dev", RESEARCH_RUNNER_SECRET: "s".repeat(40) });
  assert.equal(c.model.name, null, "drafting is opt-in: no RESEARCH_MODEL means no GPU use at all");
  assert.equal(c.model.gpuGuard, true);
  assert.equal(c.model.keepAlive, "30s");
  assert.equal(c.model.maxGpuUtilPct, 25);
  assert.equal(c.model.minFreeVramMb, 8_000);
  assert.throws(() => loadConfig({ CRESTMONT_URL: "https://s.example.workers.dev", RESEARCH_RUNNER_SECRET: "s".repeat(40), MODEL_KEEP_ALIVE: "forever" }), /MODEL_KEEP_ALIVE/);
});

// ───────────── drafting is off the critical path ─────────────

/** A worker over one broken-site business, whose platform calls are captured instead of sent. */
async function workerOverOneBrokenSite(model: LocalModel | null) {
  const SITE = "https://riverside-plumbing.example/";
  const http = new FakeHttp({ [SITE]: { url: SITE, finalUrl: SITE, status: 503, chain: [{ url: SITE, status: 503 }], headers: {}, body: "", bytes: 0, ms: 100, error: null, robotsBlocked: false } });
  const state = new State(":memory:");
  const batches: { batchId: string; body: string }[] = [];
  const platform = {
    heartbeat: async () => ({ paused: false, pauseReason: null, qualifyThreshold: 60, maxBatch: 100, enabledSources: ["overture"], serverTime: new Date().toISOString() }),
    batch: async (_r: string, batchId: string, body: string) => {
      batches.push({ batchId, body });
      return { accepted: JSON.parse(body).length, created: JSON.parse(body).length, updated: 0, unchanged: 0, rejected: [] as { key: string; issues: string[] }[], replay: false };
    },
  } as unknown as Platform;
  const cfg = loadConfig({ CRESTMONT_URL: "https://staging.example.workers.dev", RESEARCH_RUNNER_SECRET: "s".repeat(40), COMMON_CRAWL: "off", HTTP_CONCURRENCY: "4" });
  const worker = new ResearchWorker({ cfg: { ...cfg, http: { ...cfg.http, brokenAttempts: 1 } }, state, http: http as never, platform, sources: [], cc: null, browser: null, model, log: silentLogger });
  await worker.heartbeat();
  state.upsertCandidate(cand({ businessKey: "overture:draft1" }), "MI", new Date(), 30);
  const ac = new AbortController();
  const loop = worker.workLoop(ac.signal);
  for (let i = 0; i < 200 && state.backlog() > 0; i++) await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await loop;
  return { worker, state, batches, platform };
}

test("a prospect is delivered on its evidence while the GPU is busy; the draft is queued, not awaited", async () => {
  // Admission always refuses: a build is using the GPU for the whole run.
  const model = new LocalModel({ baseUrl: "http://127.0.0.1:11434", name: MODEL, timeoutMs: 1000, numCtx: 4096, concurrency: 1,
    admission: admission({ fetchImpl: ps([BUILDER_MODEL]), gpuImpl: idleGpu }) });
  const { worker, state, batches } = await workerOverOneBrokenSite(model);
  const sent = await worker.deliverOnce();
  assert.equal(sent.sent, 1, "the prospect was delivered without waiting for any draft");
  assert.equal(batches.length, 1);
  const [record] = JSON.parse(batches[0].body) as { summary: string | null; website: { classification: string } }[];
  assert.equal(record.website.classification, "VERIFIED_WEBSITE_BROKEN");
  assert.equal(record.summary ?? null, null, "delivered with no wording rather than delayed for it");
  const st = worker.status();
  assert.equal(st.drafts.pending, 1, "the draft is waiting for a free GPU");
  assert.equal(st.evaluated, 1);
  state.close();
});

test("a draft attached later re-delivers the prospect without counting it as evaluated twice", async () => {
  // Admission allows, and the model returns usable wording.
  const model = new LocalModel({ baseUrl: "http://127.0.0.1:11434", name: MODEL, timeoutMs: 1000, numCtx: 4096, concurrency: 1,
    admission: admission({ fetchImpl: ps([MODEL]), gpuImpl: idleGpu }) });
  const { worker, state, batches } = await workerOverOneBrokenSite(model);
  assert.equal((await worker.deliverOnce()).sent, 1);
  assert.equal(worker.status().evaluated, 1);

  const ac = new AbortController();
  const drafting = worker.draftLoop(ac.signal);
  const generate = (async () => new Response(JSON.stringify({ message: { content: JSON.stringify({
    summary: "The listed website for this plumber did not load when it was checked.",
    brief: "Mention that the listed address did not load and ask whether they are aware.",
  }) } }), { status: 200 })) as typeof fetch;
  // Drive one draft through the real queue by calling the model the same way the loop does.
  for (let i = 0; i < 100 && worker.status().drafts.done === 0; i++) {
    const d = await model.draft({ name: "Riverside Plumbing", category: "plumber", city: "Lansing", state: "MI", websiteClass: "VERIFIED_WEBSITE_BROKEN",
      websiteUrl: null, findings: [], recommendedPackage: "business", allowedDomains: [] }, generate);
    assert.equal(d.deferred, undefined);
    const prospect = { ...JSON.parse((state.db.prepare(`SELECT result FROM candidates WHERE business_key = 'overture:draft1'`).get() as { result: string }).result), summary: d.summary, brief: d.brief, model: d.model };
    assert.equal(state.attachDraft("overture:draft1", prospect, new Date()), true);
    break;
  }
  ac.abort();
  await drafting;

  assert.equal(worker.status().evaluated, 1, "attaching a draft must not inflate the day's evaluated count");
  assert.equal((await worker.deliverOnce()).sent, 1, "the drafted prospect is re-delivered");
  assert.equal(batches.length, 2);
  const [redelivered] = JSON.parse(batches[1].body) as { summary: string | null }[];
  assert.match(String(redelivered.summary), /did not load/);
  state.close();
});

test("attachDraft refuses an unknown or unchanged record, so no empty re-delivery is queued", () => {
  const state = new State(":memory:");
  assert.equal(state.attachDraft("overture:missing", { a: 1 }, new Date()), false);
  state.upsertCandidate(cand({ businessKey: "overture:d2" }), "MI", new Date(), 30);
  state.finish("overture:d2", { a: 1 }, new Date());
  assert.equal(state.attachDraft("overture:d2", { a: 1 }, new Date()), false, "same content: nothing to re-send");
  assert.equal(state.attachDraft("overture:d2", { a: 1, summary: "s" }, new Date()), true);
  assert.equal((state.db.prepare(`SELECT stage FROM candidates WHERE business_key = 'overture:d2'`).get() as { stage: string }).stage, "ready");
  state.close();
});

test("the draft queue is bounded: overflow is dropped, never allowed to grow without limit", async () => {
  const SITE2 = "https://riverside-plumbing.example/";
  const http = new FakeHttp({ [SITE2]: ok(SITE2, page({ viewport: false, lang: false })) });
  const state = new State(":memory:");
  const platform = { heartbeat: async () => ({ paused: false, pauseReason: null, qualifyThreshold: 60, maxBatch: 100, enabledSources: ["overture"], serverTime: "" }) } as unknown as Platform;
  const cfg = loadConfig({ CRESTMONT_URL: "https://staging.example.workers.dev", RESEARCH_RUNNER_SECRET: "s".repeat(40), COMMON_CRAWL: "off", MODEL_DRAFT_QUEUE_LIMIT: "0" });
  assert.equal(cfg.model.draftQueueLimit, 0);
  const model = new LocalModel({ baseUrl: "http://127.0.0.1:11434", name: MODEL, timeoutMs: 1000, numCtx: 4096, concurrency: 1, admission: admission({ fetchImpl: ps([MODEL]), gpuImpl: idleGpu }) });
  const worker = new ResearchWorker({ cfg, state, http: http as never, platform, sources: [], cc: null, browser: null, model, log: silentLogger });
  await worker.heartbeat();
  state.upsertCandidate(cand({ businessKey: "overture:draft3" }), "MI", new Date(), 30);
  const ac = new AbortController();
  const loop = worker.workLoop(ac.signal);
  for (let i = 0; i < 200 && state.backlog() > 0; i++) await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await loop;
  assert.equal(worker.status().drafts.pending, 0, "with no room the draft is dropped, not queued");
  state.close();
});
