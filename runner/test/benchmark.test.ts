// The Node 1 benchmark harness against a FAKE Ollama (native API + OpenAI-compatible API). Proves the harness measures
// and reports correctly (loads, memory, concurrency, switching, tool/JSON sanity, failures shown as failures). The
// numbers here are from the fake server and mean nothing about real hardware.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runBenchmark, benchmarkMarkdown } from "../src/benchmark.ts";
import type { ModelProfile } from "../src/config.ts";

const prof = (tag: string, role: ModelProfile["role"]): ModelProfile => ({ tag, role, contextTokens: 65536, vramMb: 0, quantization: null, reasoning: null, vision: false, license: null });

test("[AIB-016] benchmark harness (fake model server): cold loads with real memory figures, 1/2/4 concurrency, A↔B switch times, tool-call and JSON sanity, failures reported", async () => {
  let inMemory: string[] = [];
  let concurrent = 0, peak = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/ps") return res.end(JSON.stringify({ models: inMemory.map((m) => ({ name: m, size_vram: (m.startsWith("arch") ? 19500 : 25100) * 1048576 })) }));
      if (req.url === "/api/generate") {
        if (body.keep_alive === 0) inMemory = inMemory.filter((m) => m !== body.model);
        else { if (body.model === "broken:1b") { res.statusCode = 500; return res.end(JSON.stringify({ error: "CUDA out of memory" })); } await new Promise((r) => setTimeout(r, 15)); inMemory = [...inMemory, String(body.model)]; }
        return res.end(JSON.stringify({ done: true }));
      }
      if (req.url === "/v1/chat/completions") {
        concurrent++; peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
        const tools = body.tools as unknown[] | undefined;
        const msg = tools ? { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"public/index.html\"}" } }] }
          : String((body.messages as { content: string }[])[0].content).includes("JSON object") ? { role: "assistant", content: "{\"decision\":\"FIX_DEFECTS\",\"findings\":[\"labels\"]}" } : { role: "assistant", content: "<html>…</html>" };
        return res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 200 } }));
      }
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    const r = await runBenchmark({ baseUrl: base, apiKey: "ollama", models: [prof("arch:27b", "architect_reviewer"), prof("build:35b", "builder")], mode: "dual", levels: [1, 2, 4], repeats: 1, maxTokens: 256, telemetryFile: "/nonexistent", requestTimeoutMs: 5000 });
    assert.deepEqual(r.loads.map((l) => [l.model, l.ok, l.vramMb]), [["arch:27b", true, 19500], ["build:35b", true, 25100]]);
    assert.ok(r.loads.every((l) => (l.loadMs ?? 0) >= 10));
    assert.deepEqual(r.concurrency.map((c) => [c.model, c.concurrency, c.ok, c.errors]), [["arch:27b", 1, 1, 0], ["arch:27b", 2, 2, 0], ["arch:27b", 4, 4, 0], ["build:35b", 1, 1, 0], ["build:35b", 2, 2, 0], ["build:35b", 4, 4, 0]]);
    assert.equal(peak, 4, "the 4-request level really sent 4 at once");
    assert.ok(r.concurrency.every((c) => (c.aggregateTokensPerSecond ?? 0) > 0 && c.p95Ms !== null));
    assert.deepEqual(r.switches.map((s) => [s.from, s.to, s.ok]), [["arch:27b", "build:35b", true], ["build:35b", "arch:27b", true]]);
    assert.deepEqual(r.sanity.map((s) => [s.toolCall, s.json]), [[true, true], [true, true]]);
    assert.equal(r.gpu, null, "no host sample → not reported");
    const md = benchmarkMarkdown(r);
    assert.match(md, /# Node 1 model benchmark \(MEASURED\)/);
    assert.match(md, /not reported \(no host sampler file\)/);
    // A model that cannot load is reported as FAILED, never with invented figures.
    const bad = await runBenchmark({ baseUrl: base, apiKey: "ollama", models: [prof("broken:1b", "single")], mode: "single", levels: [1], repeats: 1, maxTokens: 64, telemetryFile: "/nonexistent", requestTimeoutMs: 5000 });
    assert.equal(bad.loads[0].ok, false);
    assert.equal(bad.concurrency.length, 0);
    assert.match(benchmarkMarkdown(bad), /FAILED: model server \/api\/generate answered 500/);
  } finally { server.close(); }
});
