// Regression: Qwen 3.x thinking models on Ollama's OpenAI-compatible /v1/chat/completions.
// The Node 1 diagnostic (D11, native /api/chat) returned no text until it sent think:false (PR #95). The website
// builder uses /v1, where `think` is ignored and only reasoning_effort controls thinking. Without it the model
// reasons first, the reasoning counts against max_tokens, and a planning turn can end with empty content and
// finish_reason "length" — the builder then never receives a tool call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LocalProvider } from "../src/providers/local.ts";
import { OpenAICompatClient, parseChatResponse, DEFAULT_REASONING_EFFORT } from "../src/providers/openai-client.ts";
import { RunTracker, StopSwitch } from "../src/agent.ts";
import { createWorkspace } from "../src/workspace.ts";
import { writeBriefFiles } from "../src/prompt.ts";
import { silentLogger } from "../src/log.ts";
import { loadModels } from "../src/config.ts";
import type { RunnerConfig } from "../src/config.ts";
import type { PhaseRequest } from "../src/providers/types.ts";
import { makeConfig, makeJob, tmp, startFakeModel, fakeDocker } from "./helpers.ts";
import type { FakeModelReply, FakeModelRequest } from "./helpers.ts";

const finish = (summary = "done"): FakeModelReply => ({ toolCalls: [{ name: "finish", arguments: { summary } }] });

/** Behaves like Ollama 0.40 serving a Qwen thinking model on /v1: thinking unless reasoning_effort is "none". */
function ollamaQwenThinking(r: FakeModelRequest): FakeModelReply {
  if (r.reasoning_effort === "none") return finish("built");
  return { content: "", reasoning: "Let me plan the homepage... ".repeat(400), finish: "length", usage: { prompt_tokens: 3000, completion_tokens: r.max_tokens ?? 8192 } };
}

async function provider(baseUrl: string, models?: RunnerConfig["models"]) {
  const base = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: tmp() });
  const cfg = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: tmp(), local: { ...base.local, baseUrl, requestTimeoutMs: 30_000 }, ...(models ? { models } : {}) });
  const ws = createWorkspace(tmp("aib-ws-"), { id: "bld_reason", attempt: 1 });
  mkdirSync(path.join(ws.repo, "public"), { recursive: true });
  writeFileSync(path.join(ws.repo, "public", "index.html"), "<h1>Hello</h1>\n");
  const job = makeJob();
  writeBriefFiles(ws.repo, job, job.requirements);
  const p = new LocalProvider({ cfg, executor: fakeDocker().executor, log: silentLogger, clientRetries: 0, clientSleep: async () => {} });
  await p.prepare({ job, ws, skillNames: [], referenceDomains: [], processEnv: {}, systemPromptAppend: "" });
  return { p, cfg };
}

const req = (): PhaseRequest => ({ phase: "build", prompt: "Phase 2 of 3: build.", maxTurns: 10, maxBudgetUsd: 0, maxWallMs: 30_000, resumeSessionId: null, tracker: new RunTracker(), stop: new StopSwitch() });

test("[AIB-RUNNER] /v1 requests default to reasoning_effort \"none\"; an explicit choice is kept [fake model]", async () => {
  const m = await startFakeModel(() => ({ content: "ok" }));
  try {
    const c = new OpenAICompatClient({ baseUrl: m.url, apiKey: "ollama", timeoutMs: 5000, retries: 0 });
    await c.chat({ model: "qwen3.6:35b-a3b-q4_K_M", messages: [{ role: "user", content: "hi" }] });
    await c.chat({ model: "qwen3.6:35b-a3b-q4_K_M", messages: [{ role: "user", content: "hi" }], reasoning_effort: "low" });
    assert.equal(DEFAULT_REASONING_EFFORT, "none");
    assert.deepEqual(m.requests.map((r) => r.reasoning_effort), ["none", "low"]);
  } finally { await m.close(); }
});

test("[AIB-RUNNER] the builder gets usable tool calls from a Qwen thinking model on Ollama /v1 (no empty-output loop) [fake model]", async () => {
  const m = await startFakeModel((r) => ollamaQwenThinking(r));
  try {
    const { p } = await provider(m.url);
    const res = await p.run(req());
    assert.equal(res.status, "success", String(res.error));
    assert.ok(m.requests.length >= 1 && m.requests.every((r) => r.reasoning_effort === "none"), "every builder request disables thinking");
  } finally { await m.close(); }
});

test("[AIB-RUNNER] a configured reasoning level that exhausts the budget fails with a reasoning-specific error, not a silent loop [fake model]", async () => {
  const m = await startFakeModel((r) => ollamaQwenThinking(r));
  try {
    const models = loadModels({ LOCAL_MODEL_B_REASONING: "high" }, "qwen3.6:35b-a3b-q4_K_M");
    const { p } = await provider(m.url, models);
    const res = await p.run(req());
    assert.equal(res.status, "error");
    assert.match(String(res.error), /whole output budget on reasoning \(\d+ chars\)/);
    assert.ok(m.requests.every((r) => r.reasoning_effort === "high"));
  } finally { await m.close(); }
});

test("[AIB-RUNNER] parseChatResponse: reasoning is never the answer (Ollama `reasoning`, `reasoning_content`, inline <think>) [unit]", () => {
  const sep = parseChatResponse(JSON.stringify({ choices: [{ message: { content: "", reasoning: "abcd" }, finish_reason: "length" }] }), 1);
  assert.equal(sep.content, "");
  assert.equal(sep.reasoningChars, 4);
  const rc = parseChatResponse(JSON.stringify({ choices: [{ message: { content: "x", reasoning_content: "ab" }, finish_reason: "stop" }] }), 1);
  assert.equal(rc.reasoningChars, 2);
  const inline = parseChatResponse(JSON.stringify({ choices: [{ message: { content: "<think>plan</think>\n<h1>Hi</h1>" }, finish_reason: "stop" }] }), 1);
  assert.equal(inline.content, "<h1>Hi</h1>");
  assert.equal(inline.reasoningChars, 4);
  const cut = parseChatResponse(JSON.stringify({ choices: [{ message: { content: "<think>still planning" }, finish_reason: "length" }] }), 1);
  assert.equal(cut.content, "", "an unterminated <think> block is all reasoning");
  assert.equal(cut.reasoningChars, "still planning".length);
});

test("[AIB-RUNNER] LOCAL_MODEL_*_REASONING accepts none; unknown values are refused [unit]", () => {
  assert.equal(loadModels({ LOCAL_MODEL_B_REASONING: "none" }, "b").b.reasoning, "none");
  assert.equal(loadModels({}, "b").b.reasoning, null);
  assert.throws(() => loadModels({ LOCAL_MODEL_B_REASONING: "max" }, "b"), /must be high, medium, low or none/);
});
