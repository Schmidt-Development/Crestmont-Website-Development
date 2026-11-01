// Node 1 dispatch-to-GPU diagnostic, runner side. FIXTURES ONLY: a fake control plane (signed HTTP) and a fake
// Ollama (fetch stub). These prove the runner reports each step honestly and stops at the first failure. They are NOT
// evidence of GPU execution: that needs runner/windows/Test-Node1Dispatch.ps1 and a diagnostic job on Node 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlPlaneClient } from "../src/control-plane.ts";
import { silentLogger } from "../src/log.ts";
import { serveOneDraft } from "../src/drafts.ts";
import { nativeBase, diagnosticChatBody, diagnosticContent, emptyReason } from "../src/diagnostic.ts";
import { OpenAICompatClient } from "../src/providers/openai-client.ts";
import { startFakeControlPlane, SECRET } from "./helpers.ts";

const MODEL = "qwen3.6:35b-a3b-q4_K_M";
const job = (over: Record<string, unknown> = {}) => ({
  id: "ai_diag", workflow: "gpu_diagnostic", system: "Reply with one complete HTML document and nothing else.",
  prompt: "Generate a minimal HTML document containing a title, heading and paragraph for a fictional junk removal company called Junk in the Trunk.",
  leaseToken: "d".repeat(64), leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), maxOutputTokens: 800, diagnostic: { correlationId: "corr_0123456789abcdef" }, ...over,
});
const HTML = "<!doctype html><html><head><title>Junk in the Trunk</title></head><body><h1>Junk in the Trunk</h1><p>Your junk, our trunk.</p></body></html>";
const GB = 1024 ** 3;

/** Fake Ollama native API. `mode` selects a failure. */
function fakeOllama(mode: "ok" | "down" | "missing" | "cpu" | "partial" | "thinker" = "ok") {
  const calls: { path: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (mode === "down") throw new TypeError("fetch failed: connect ECONNREFUSED 192.168.65.254:11434");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (path === "/api/version") return json(200, { version: "0.32.0" });
    if (path === "/api/generate") return mode === "missing" ? json(404, { error: `model '${MODEL}' not found` }) : json(200, { done: true });
    if (path === "/api/ps") return json(200, { models: [{ name: MODEL, size: 24 * GB, size_vram: mode === "cpu" ? 0 : mode === "partial" ? 12 * GB : 24 * GB, details: { parameter_size: "35B", quantization_level: "Q4_K_M" } }] });
    // "thinker": behaves like Ollama with a Qwen 3.x thinking model — unless the request says think:false, the whole
    // num_predict budget goes to message.thinking and message.content is empty (the D11 failure seen on Node 1).
    if (path === "/api/chat" && mode === "thinker" && (calls.at(-1)!.body as { think?: unknown }).think !== false)
      return json(200, { model: MODEL, message: { role: "assistant", content: "", thinking: "Okay, the user wants a minimal HTML page… ".repeat(60) }, done_reason: "length", prompt_eval_count: 51, eval_count: 2000, eval_duration: 20e9 });
    if (path === "/api/chat") return json(200, { model: MODEL, message: { role: "assistant", content: "```html\n" + HTML + "\n```" }, done_reason: "stop", total_duration: 3.2e9, load_duration: 0.4e9, prompt_eval_count: 51, prompt_eval_duration: 0.1e9, eval_count: 88, eval_duration: 1.6e9 });
    return json(404, { error: "unknown" });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
async function run(mode: "ok" | "down" | "missing" | "cpu" | "partial" | "thinker") {
  const cp = await startFakeControlPlane({ jobs: [], aiJobs: [job()] });
  const o = fakeOllama(mode);
  try {
    const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: "node1", sleep: async () => {} });
    const out = await serveOneDraft({ client, model: new OpenAICompatClient({ baseUrl: "http://unused.invalid/v1", apiKey: "x", timeoutMs: 1000 }), modelName: MODEL, baseUrl: "http://host.docker.internal:11434/v1", fetchImpl: o.fetchImpl, log: silentLogger });
    const cps = cp.byPath("ai/checkpoint").map((c) => c.body as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any
    const done = cp.byPath("ai/complete")[0]?.body as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    return { out, cps, done, ollama: o.calls };
  } finally { await cp.close(); }
}

test("[AIB-021] runner diagnostic: D07–D11 reported in order with Ollama's own evidence; result returned with metrics and the correlation id [fixtures]", async () => {
  assert.equal(nativeBase("http://host.docker.internal:11434/v1"), "http://host.docker.internal:11434");
  assert.equal(nativeBase("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434");
  const r = await run("ok");
  assert.equal(r.out, "completed");
  assert.deepEqual(r.cps.map((c) => [c.code, c.ok]), [["D07", true], ["D08", true], ["D09", true], ["D10", true], ["D11", true]]);
  for (const c of r.cps) { assert.equal(c.correlationId, "corr_0123456789abcdef"); assert.equal(c.leaseToken, "d".repeat(64)); assert.ok(!Number.isNaN(Date.parse(c.at))); }
  assert.equal(r.cps[0].evidence.configuredModel, MODEL);
  assert.ok("hostLabel" in r.cps[0].evidence && "containerHost" in r.cps[0].evidence);
  assert.equal(r.cps[2].evidence.model.gpuPercent, 100);
  assert.equal(r.cps[4].evidence.tokensPerSecond, 55);
  assert.equal(r.cps[4].evidence.looksLikeRequestedHtml, true);
  assert.deepEqual(r.ollama.map((c) => c.path), ["/api/version", "/api/generate", "/api/ps", "/api/chat", "/api/ps"]);
  const chat = r.ollama.find((c) => c.path === "/api/chat")!.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(chat.model, MODEL, "the configured model, never a substitute");
  assert.equal(chat.options.temperature, 0);
  assert.equal(r.done!.text, HTML, "Markdown fences are removed; nothing else is changed");
  assert.equal(r.done!.correlationId, "corr_0123456789abcdef");
  assert.equal(r.done!.outputTokens, 88);
  assert.equal(r.done!.diagnostic.residency.gpuPercent, 100);
  assert.equal(r.done!.diagnostic.ollamaVersion, "0.32.0");
});

test("[AIB-021] runner diagnostic: stops at the first failing step and says why (Ollama down, model missing, CPU only) [fixtures]", async () => {
  const down = await run("down");
  assert.deepEqual(down.cps.map((c) => [c.code, c.ok]), [["D07", true], ["D08", false]]);
  assert.match(down.cps[1].error, /Ollama did not answer at http:\/\/host\.docker\.internal:11434: .*ECONNREFUSED/);
  assert.match(down.done!.error, /Ollama did not answer/);
  assert.equal(down.out, "failed");
  const missing = await run("missing");
  assert.deepEqual(missing.cps.map((c) => [c.code, c.ok]), [["D07", true], ["D08", true], ["D09", false]]);
  assert.match(missing.cps[2].error, /did not load: \/api\/generate → HTTP 404: model 'qwen3\.6:35b-a3b-q4_K_M' not found/);
  assert.ok(!missing.ollama.some((c) => c.path === "/api/chat"), "no inference attempted, no other model tried");
  const cpu = await run("cpu");
  assert.equal(cpu.cps.at(-1)!.code, "D09");
  assert.match(cpu.cps.at(-1)!.error, /none of it is in GPU memory/);
  const partial = await run("partial");
  assert.equal(partial.cps.at(-1)!.code, "D09");
  assert.match(partial.cps.at(-1)!.error, /only 50% of the model is in GPU memory/);
});

test("[AIB-021] runner diagnostic D11: a Qwen thinking model answers with text because the request sends think:false (regression: 'the model returned no text' on Node 1) [fixtures]", async () => {
  const r = await run("thinker");
  const chat = r.ollama.find((c) => c.path === "/api/chat")!.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(chat.think, false, "D11 must disable the reasoning phase");
  assert.equal(chat.stream, false);
  assert.equal(chat.model, MODEL);
  assert.ok(chat.options.num_predict >= 800 && chat.options.num_predict <= 4000);
  assert.equal(r.out, "completed");
  const d11 = r.cps.find((c) => c.code === "D11")!;
  assert.equal(d11.ok, true, d11.error);
  assert.equal(d11.evidence.think, false);
  assert.equal(d11.evidence.looksLikeRequestedHtml, true);
  assert.match(r.done!.text, /<title>Junk in the Trunk<\/title>/);
});

test("[AIB-021] runner diagnostic D11: reasoning is never passed off as the answer, and an empty answer says why [fixtures]", () => {
  assert.deepEqual(diagnosticContent({ message: { content: "", thinking: "abc" } }), { content: "", thinkingChars: 3 });
  assert.deepEqual(diagnosticContent({ message: { content: "<think>plan</think>\n```html\n<p>x</p>\n```" } }), { content: "<p>x</p>", thinkingChars: 4 });
  // An unterminated inline <think> (budget ran out mid-thought) is reasoning, not an answer.
  assert.deepEqual(diagnosticContent({ message: { content: "<think>still thinking" } }), { content: "", thinkingChars: 14 });
  assert.match(emptyReason({ done_reason: "length", eval_count: 2000 }, 1200), /only reasoning \(1200 chars of thinking, 2000 tokens, done_reason length\)/);
  assert.equal(emptyReason({ done_reason: "stop", eval_count: 0 }, 0), "the model returned no text (0 tokens, done_reason stop)");
  const body = diagnosticChatBody(MODEL, { system: "s", prompt: "p", maxOutputTokens: 0 });
  assert.equal(body.think, false);
  assert.equal(body.options.num_predict, 1500);
  assert.equal(diagnosticChatBody(MODEL, { system: "s", prompt: "p", maxOutputTokens: 99_999 }).options.num_predict, 4000);
});
