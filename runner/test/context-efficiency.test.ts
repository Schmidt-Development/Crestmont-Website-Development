// Context efficiency: the runner must not spend its turns rediscovering what it already knows.
//
// These tests are written against the failure this repair exists for. Build bld_e65768e6b0853a425095a1f6 spent
// 567 model calls, 16,358,132 input tokens and 106 context resets across three segments and produced no
// screenshot, no stored revision and no design score. The dominant cost was rediscovery: the context-reset message
// instructed the model to "re-read the files you need", so it re-read the same unchanged pages, refilled the
// window and reset again.
//
// The model here is a FAKE OpenAI-compatible server and the token counts are deterministic counters it reports.
// These are mock/unit tests of the runner's bookkeeping; they are NOT GPU evidence and say nothing about a real
// model's output quality.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LocalProvider, estimateTokens, loadTranscript } from "../src/providers/local.ts";
import { RunTracker, StopSwitch } from "../src/agent.ts";
import { createWorkspace } from "../src/workspace.ts";
import { writeBriefFiles } from "../src/prompt.ts";
import { silentLogger } from "../src/log.ts";
import {
  DEFAULT_THRASH, changedSince, manifest, newLedger, recordCommand, recordDone, recordRead, recordReset,
  recordWrite, staleResets, thrashVerdict, unchangedSince,
} from "../src/providers/work-ledger.ts";
import type { PhaseRequest } from "../src/providers/types.ts";
import type { RunnerConfig } from "../src/config.ts";
import { makeConfig, makeJob, tmp, startFakeModel, fakeDocker } from "./helpers.ts";
import type { FakeModelReply, FakeModelRequest } from "./helpers.ts";

async function setup(handler: (r: FakeModelRequest, n: number) => FakeModelReply, local: Partial<RunnerConfig["local"]> = {}) {
  const model = await startFakeModel(handler);
  const base = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: tmp() });
  const cfg = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: tmp(), local: { ...base.local, ...local, baseUrl: model.url } });
  const ws = createWorkspace(tmp("aib-ws-"), { id: "bld_ctx", attempt: 1 });
  mkdirSync(path.join(ws.repo, "public"), { recursive: true });
  const job = makeJob();
  writeBriefFiles(ws.repo, job, job.requirements);
  const provider = new LocalProvider({ cfg, executor: fakeDocker().executor, log: silentLogger, clientRetries: 0 });
  await provider.prepare({ job, ws, skillNames: [], referenceDomains: [], processEnv: {}, systemPromptAppend: "" });
  return { model, ws, provider, cfg };
}
const req = (over: Partial<PhaseRequest> = {}): PhaseRequest => ({ phase: "build", prompt: "Phase 2 of 3: build. INSTRUCTION-MARKER-7Q.", maxTurns: 2000, maxBudgetUsd: 0, maxWallMs: 600_000, resumeSessionId: null, tracker: new RunTracker(), stop: new StopSwitch(), ...over });
const promptEstimate = (r: FakeModelRequest) => r.messages.reduce((n, m) => n + estimateTokens(JSON.stringify(m.content ?? "") + JSON.stringify(m.tool_calls ?? "")) + 8, 0) + estimateTokens(JSON.stringify(r.tools ?? []));
/** The reset message of the latest request, or "" when the latest context has not been reset. */
const resetMessage = (model: { requests: FakeModelRequest[] }): string => {
  const last = model.requests.at(-1);
  const m = last?.messages.find((x) => typeof x.content === "string" && /^CONTEXT RESET #/.test(x.content));
  return m ? String(m.content) : "";
};

// ── 1-3, 8: the ledger states what is already known, and knows when it goes stale ──

test("[AIB-CTX] the work ledger records what was read and written, and a file edited on disk afterwards reads as CHANGED (cached knowledge is invalidated)", () => {
  const repo = tmp("aib-ledger-");
  mkdirSync(path.join(repo, "public"), { recursive: true });
  writeFileSync(path.join(repo, "public", "index.html"), "<!doctype html><h1>one</h1>");
  writeFileSync(path.join(repo, "public", "about.html"), "<!doctype html><h1>about</h1>");
  const l = newLedger();

  recordRead(l, repo, "public/index.html");
  recordRead(l, repo, "public/about.html");
  assert.deepEqual(unchangedSince(l, repo).map((f) => f.p).sort(), ["public/about.html", "public/index.html"], "both files are known and unchanged");
  assert.deepEqual(changedSince(l, repo), [], "nothing has changed yet");

  // Somebody (the model, or a repair) rewrites one of them.
  writeFileSync(path.join(repo, "public", "index.html"), "<!doctype html><h1>two</h1>");
  assert.deepEqual(changedSince(l, repo).map((f) => f.p), ["public/index.html"], "the edited file is stale and worth re-reading");
  assert.deepEqual(unchangedSince(l, repo).map((f) => f.p), ["public/about.html"], "the untouched file is still known");

  // The manifest says both things plainly, and tells the model not to re-read the unchanged one.
  const m = manifest(l, repo, { phase: "build" });
  assert.match(m, /do NOT read these again/);
  assert.match(m, /public\/about\.html/);
  assert.match(m, /CHANGED since you read them/);

  // A write is recorded as the model's own work, which must survive into the manifest.
  recordWrite(l, repo, "public/services.html");
  assert.match(manifest(l, repo, { phase: "build" }), /Files YOU HAVE WRITTEN[^\n]*public\/services\.html/);
});

test("[AIB-CTX] the manifest carries completed work, open problems and the phase objective, so a reset cannot silently erase the active phase", () => {
  const repo = tmp("aib-ledger2-");
  const l = newLedger();
  recordDone(l, "phase build completed");
  recordCommand(l, "npm run check", true);
  recordCommand(l, "npm test", false);
  recordReset(l, "build");
  const m = manifest(l, repo, { phase: "build", objective: "PHASE-OBJECTIVE-MARKER", commit: "abcdef123456" });
  assert.match(m, /PHASE-OBJECTIVE-MARKER/, "the objective is restated");
  assert.match(m, /abcdef123456/, "the source commit is stated");
  assert.match(m, /Completed — do NOT repeat: phase build completed/);
  assert.match(m, /npm run check \[ok\]/);
  assert.match(m, /npm test \[FAILED\]/);
  assert.match(m, /Context resets in this phase: 1/);
  assert.match(m, /authoritative — not a model summary/, "the manifest is labelled as runner-observed fact");
});

test("[AIB-CTX] the manifest is bounded: a ledger with hundreds of files cannot itself fill the context window", () => {
  const repo = tmp("aib-ledger3-");
  mkdirSync(repo, { recursive: true });
  const l = newLedger();
  for (let i = 0; i < 400; i++) {
    const p = `src/m${i}.js`;
    writeFileSync(path.join(repo, `m${i}.js`), "x".repeat(200));
    recordRead(l, repo, `m${i}.js`);
    void p;
  }
  assert.ok(l.files.length <= 200, `the ledger itself is bounded (${l.files.length} files)`);
  // Its own default budget keeps it small even with the maximum number of files.
  const m = manifest(l, repo, { phase: "build" });
  assert.ok(m.length <= 4000 + 30, `the manifest respects its default budget (${m.length} chars)`);
  // And a caller with a tighter budget gets a truncated manifest, never an oversized one.
  const tight = manifest(l, repo, { phase: "build", maxChars: 500 });
  assert.ok(tight.length <= 500 + 30, `a tight budget is honoured (${tight.length} chars)`);
  assert.match(tight, /\[manifest truncated\]/);
});

// ── 6: a recovery loop is detected and bounded, but only when it is not making progress ──

test("[AIB-CTX] resets WITH progress are unlimited; resets with no progress between them are bounded and then stop with a diagnosis", () => {
  const l = newLedger();
  const repo = tmp("aib-ledger4-");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "a.txt"), "a");

  // A long, genuinely productive session: a write between every reset. This is continuity working as designed and
  // must never be interrupted, however many resets it needs.
  for (let i = 0; i < 60; i++) {
    recordReset(l, "build");
    recordWrite(l, repo, "a.txt");
    assert.equal(thrashVerdict(l, "build"), "ok", `reset ${i + 1} with progress stays ok`);
    assert.equal(staleResets(l, "build"), 0, "progress clears the stale counter");
  }
  assert.ok((l.resets.build ?? 0) >= 60, "the total reset count still records every reset");

  // Now the failure mode: resets with nothing achieved between them. Reading files is NOT progress.
  for (let i = 0; i < DEFAULT_THRASH.narrowAt; i++) { recordReset(l, "build"); recordRead(l, repo, "a.txt"); }
  assert.equal(thrashVerdict(l, "build"), "narrow", "a run of unproductive resets first asks for narrowing");
  for (let i = 0; i < DEFAULT_THRASH.stopAt - DEFAULT_THRASH.narrowAt; i++) { recordReset(l, "build"); recordRead(l, repo, "a.txt"); }
  assert.equal(thrashVerdict(l, "build"), "stop", "and is then bounded rather than continuing the same loop");

  // A single piece of real progress releases it again.
  recordWrite(l, repo, "a.txt");
  assert.equal(thrashVerdict(l, "build"), "ok");
});

test("[AIB-CTX] a failed command is not progress; a successful one is", () => {
  const l = newLedger();
  recordReset(l, "verify");
  recordCommand(l, "npm test", false);
  assert.equal(staleResets(l, "verify"), 1, "a failing command does not count as progress");
  recordCommand(l, "npm test", true);
  assert.equal(staleResets(l, "verify"), 0, "a passing command does");
});

// ── 1, 5: what the reset message actually tells the model ──

test("[AIB-CTX] the context-reset message tells the model NOT to re-read unchanged files and restates the phase instruction verbatim", async () => {
  const WINDOW = 16_384;
  let n = 0;
  const { model, provider, ws } = await setup((r) => {
    n++;
    if (n > 40) return { toolCalls: [{ name: "finish", arguments: { summary: "done" } }] };
    // Write a file, then read it back: the read is the behaviour the manifest is meant to make unnecessary.
    return n % 2 === 1
      ? { toolCalls: [{ name: "write_file", arguments: { path: `public/p${n}.html`, content: "<!doctype html>" + "y".repeat(2500) } }], usage: { prompt_tokens: promptEstimate(r), completion_tokens: 40 } }
      : { toolCalls: [{ name: "read_file", arguments: { path: `public/p${n - 1}.html` } }], usage: { prompt_tokens: promptEstimate(r), completion_tokens: 40 } };
  }, { contextTokens: WINDOW, maxOutputTokensPerCall: 1024 });
  try {
    const r = req();
    const res = await provider.run(r);
    assert.equal(res.status, "success", String(res.error));
    assert.ok((res.compactions ?? 0) >= 1, `the window was reset at least once (${res.compactions})`);
    const msg = resetMessage(model);
    assert.ok(msg, "the latest context begins with a reset message");
    assert.match(msg, /Do NOT re-read files listed below as already read and unchanged/);
    assert.doesNotMatch(msg, /re-read the files you need/, "the old instruction that caused the rediscovery loop is gone");
    assert.match(msg, /PROGRESS MANIFEST/, "the reset states runner-observed facts instead");
    assert.ok(msg.includes("INSTRUCTION-MARKER-7Q"), "the phase instruction is still restated verbatim");
    // The ledger travelled with the transcript, so a resumed segment inherits the same knowledge.
    const t = loadTranscript(ws, r.tracker.sessionId!)!;
    assert.equal(t.ledger?.schema, "crestmont.work-ledger/1");
    assert.ok((t.ledger?.files.length ?? 0) > 0, "the persisted transcript carries the ledger");
    assert.ok(t.ledger!.files.some((f) => f.wrote), "including which files the model wrote");
  } finally { await model.close(); }
});

// ── 4: large tool results cannot repeatedly consume most of the window ──

test("[AIB-CTX] several tool calls in ONE turn share a bounded output budget: four large reads cannot take most of the context window", async () => {
  const WINDOW = 16_384;
  // Many lines, not one huge line: read_file caps each LINE at 2,000 characters, so a single-line fixture would
  // never reach the per-turn budget this test is about.
  const BIG = Array.from({ length: 4000 }, (_, i) => `line ${i} ` + "z".repeat(60)).join(String.fromCharCode(10));
  let n = 0;
  const { model, provider, ws } = await setup((r) => {
    n++;
    if (n > 3) return { toolCalls: [{ name: "finish", arguments: { summary: "done" } }] };
    // Four big reads in a single assistant turn: the exact shape that put ~18,000 tokens into a 49,152-token
    // window in one turn on the real build.
    return {
      toolCalls: [
        { name: "read_file", arguments: { path: "public/big1.html" } },
        { name: "read_file", arguments: { path: "public/big2.html" } },
        { name: "read_file", arguments: { path: "public/big3.html" } },
        { name: "read_file", arguments: { path: "public/big4.html" } },
      ],
      usage: { prompt_tokens: promptEstimate(r), completion_tokens: 20 },
    };
  }, { contextTokens: WINDOW, maxOutputTokensPerCall: 1024 });
  try {
    for (const i of [1, 2, 3, 4]) writeFileSync(path.join(ws.repo, "public", `big${i}.html`), BIG);
    const r = req();
    const res = await provider.run(r);
    assert.equal(res.status, "success", String(res.error));
    // The four results of the FIRST turn, as they were actually put into the context.
    const withResults = model.requests.find((q) => q.messages.filter((m) => m.role === "tool").length >= 4);
    assert.ok(withResults, "a request carried the four tool results");
    const results = withResults!.messages.filter((m) => m.role === "tool").slice(0, 4).map((m) => String(m.content));
    const totalChars = results.reduce((a, s) => a + s.length, 0);
    const budget = Math.floor(WINDOW * 3.5 * 0.25);
    assert.ok(totalChars <= budget + 4 * 700, `the turn's four results share one budget (${totalChars} chars ≤ ~${budget})`);
    assert.ok(totalChars < BIG.length, "the raw files were far larger than what entered the context");
    // Every call still answered, and a clipped one says so and how to get the rest.
    for (const s of results) assert.ok(s.length > 0, "each call still returned something");
    assert.ok(results.some((s) => /clipped by the runner/.test(s)), "clipping is explicit, not silent");
    assert.ok(results.some((s) => /narrower range or use search/.test(s)), "and says how to retrieve the rest");
  } finally { await model.close(); }
});

// ── 7: the configured window is checked against what the fixed context actually needs ──

test("[AIB-CTX] a window too small for the fixed context fails with an actionable diagnosis naming the setting to change", async () => {
  // 2,048 tokens cannot hold the system prompt, the workspace message and the instruction.
  const { model, provider } = await setup(() => ({ toolCalls: [{ name: "finish", arguments: { summary: "x" } }] }), { contextTokens: 2048, maxOutputTokensPerCall: 512 });
  try {
    const res = await provider.run(req());
    assert.equal(res.status, "error");
    assert.match(String(res.error), /LOCAL_MODEL_\*_CONTEXT_TOKENS/, "the error names the setting to raise");
    assert.match(String(res.error), /num_ctx/, "and the model-side setting that must agree with it");
  } finally { await model.close(); }
});

// ── 40: a deterministic before/after benchmark of context recovery ──

test("[AIB-CTX] BENCHMARK (deterministic, not GPU evidence): the per-turn budget cuts tool-output characters served for the same four-read turn", async () => {
  const WINDOW = 49_152; // Node 1's configured window
  const BIG = Array.from({ length: 4000 }, (_, i) => `row ${i} ` + "q".repeat(60)).join(String.fromCharCode(10));
  // What the OLD rule served: each result capped on its own at min(16_000, window*3.5/6).
  const oldPerResult = Math.max(2000, Math.min(16_000, Math.floor(WINDOW * 3.5 / 6)));
  const oldTotal = 4 * oldPerResult;
  // What the NEW rule serves: a shared quarter-window budget across the turn.
  let n = 0;
  const { model, provider, ws } = await setup((r) => {
    n++;
    if (n > 1) return { toolCalls: [{ name: "finish", arguments: { summary: "done" } }] };
    return {
      toolCalls: [1, 2, 3, 4].map((i) => ({ name: "read_file", arguments: { path: `public/b${i}.html` } })),
      usage: { prompt_tokens: promptEstimate(r), completion_tokens: 20 },
    };
  }, { contextTokens: WINDOW, maxOutputTokensPerCall: 2048 });
  try {
    for (const i of [1, 2, 3, 4]) writeFileSync(path.join(ws.repo, "public", `b${i}.html`), BIG);
    const res = await provider.run(req());
    assert.equal(res.status, "success", String(res.error));
    const withResults = model.requests.find((q) => q.messages.filter((m) => m.role === "tool").length >= 4)!;
    const newTotal = withResults.messages.filter((m) => m.role === "tool").slice(0, 4).reduce((a, m) => a + String(m.content).length, 0);
    assert.ok(newTotal < oldTotal, `one four-read turn now serves fewer characters (${newTotal} vs ${oldTotal} before)`);
    // Expressed as a share of the window, which is what decides whether the next call resets.
    const shareNow = newTotal / (WINDOW * 3.5);
    assert.ok(shareNow <= 0.26, `one turn can no longer take more than about a quarter of the window (${(shareNow * 100).toFixed(1)}%)`);
    assert.ok(oldTotal / (WINDOW * 3.5) > 0.3, `the old rule could take over 30% in one turn (${((oldTotal / (WINDOW * 3.5)) * 100).toFixed(1)}%)`);
  } finally { await model.close(); }
});
