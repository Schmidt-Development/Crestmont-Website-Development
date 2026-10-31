// Node 1 benchmark harness (Founder V4 §3, §6, §12): MEASURES the configured models on the real model server.
//   node --no-warnings src/benchmark.ts [--concurrency 1,2,4,8] [--repeats 2] [--out /workspaces/benchmarks]
// (inside the runner container: docker compose ... run --rm --no-deps runner node --no-warnings src/benchmark.ts)
//
// For Model A and Model B (or the single model) it records, with timestamps and the host's GPU sample:
//   - cold load time and the memory the model really takes (Ollama /api/ps size_vram), and whether it is fully on the GPU;
//   - generation speed on a fixed coding prompt (completion tokens / request time) at 1, 2, 4, 8 concurrent requests,
//     with p50/p95 latency and errors (the concurrency limit is chosen from these numbers, not assumed);
//   - model-switch overhead A→B and B→A (unload + load);
//   - tool-calling sanity (a valid call of a given tool) and structured-answer sanity (valid JSON on request).
// It writes benchmark-<time>.json and .md. Every figure is a measurement from this run; nothing is estimated, and a
// step that fails is reported as failed. Website quality (planning, frontend, security, revisions, reviewer accuracy,
// human correction effort) is not measured here: that is the acceptance procedure in docs/ai-builds/ORCHESTRATOR.md.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { loadConfig, type ModelProfile } from "./config.ts";
import { OpenAICompatClient } from "./providers/openai-client.ts";
import { OllamaResidency, sameModel } from "./inference/ollama.ts";
import { readGpuTelemetry } from "./inference/gpu.ts";

export const CODING_PROMPT = "Write a complete, accessible HTML page for a small bakery: a header with navigation (Home, Menu, About, Contact), a hero section, a three-item menu grid with prices, opening hours and a contact form with labels. Use semantic HTML and a small embedded CSS block with a mobile-first layout. Output only the HTML.";

export interface LoadResult { model: string; ok: boolean; loadMs: number | null; vramMb: number | null; error?: string }
export interface ConcurrencyResult { model: string; concurrency: number; ok: number; errors: number; aggregateTokensPerSecond: number | null; perRequestTokensPerSecond: number | null; p50Ms: number | null; p95Ms: number | null; errorSamples: string[] }
export interface SwitchResult { from: string; to: string; ok: boolean; ms: number | null; error?: string }
export interface SanityResult { model: string; toolCall: boolean; json: boolean; notes: string[] }
export interface BenchmarkReport {
  schema: "crestmont.benchmark/1"; host: string; startedAt: string; finishedAt: string; baseUrl: string; mode: string;
  models: { tag: string; role: string }[]; gpu: unknown; loads: LoadResult[]; concurrency: ConcurrencyResult[]; switches: SwitchResult[]; sanity: SanityResult[];
  settings: { maxTokens: number; repeats: number; levels: number[] };
}

const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface BenchDeps { fetchImpl?: typeof fetch; now?: () => number; log?: (line: string) => void }

export async function runBenchmark(o: { baseUrl: string; apiKey: string; models: ModelProfile[]; mode: string; levels: number[]; repeats: number; maxTokens: number; telemetryFile: string; requestTimeoutMs: number }, d: BenchDeps = {}): Promise<BenchmarkReport> {
  const now = d.now ?? Date.now;
  const log = d.log ?? (() => {});
  const res = new OllamaResidency(o.baseUrl, d.fetchImpl);
  const client = new OpenAICompatClient({ baseUrl: o.baseUrl, apiKey: o.apiKey, timeoutMs: o.requestTimeoutMs, retries: 0, fetchImpl: d.fetchImpl });
  const report: BenchmarkReport = { schema: "crestmont.benchmark/1", host: hostname(), startedAt: new Date(now()).toISOString(), finishedAt: "", baseUrl: o.baseUrl, mode: o.mode,
    models: o.models.map((m) => ({ tag: m.tag, role: m.role })), gpu: readGpuTelemetry(o.telemetryFile), loads: [], concurrency: [], switches: [], sanity: [], settings: { maxTokens: o.maxTokens, repeats: o.repeats, levels: o.levels } };
  const unloadAll = async () => { for (const m of await res.loaded()) await res.unload(m.model); };
  const timed = async (fn: () => Promise<void>) => { const t = now(); await fn(); return now() - t; };

  for (const m of o.models) {
    log(`== ${m.tag} (${m.role})`);
    // Cold load and real memory.
    try {
      await unloadAll();
      const ms = await timed(() => res.load(m.tag, "30m"));
      const loaded = (await res.loaded()).find((x) => sameModel(x.model, m.tag));
      report.loads.push({ model: m.tag, ok: true, loadMs: ms, vramMb: loaded?.vramMb ?? null });
      log(`   loaded in ${ms} ms, ${loaded?.vramMb ?? "?"} MB in GPU memory`);
    } catch (err) { report.loads.push({ model: m.tag, ok: false, loadMs: null, vramMb: null, error: (err as Error).message.slice(0, 200) }); log(`   load FAILED: ${(err as Error).message}`); continue; }
    // Throughput at each concurrency level.
    for (const level of o.levels) {
      const lat: number[] = [], errs: string[] = [];
      let tokens = 0, tokenMs = 0, okN = 0;
      const t0 = now();
      for (let r = 0; r < o.repeats; r++) {
        await Promise.all(Array.from({ length: level }, async () => {
          const t = now();
          try {
            const out = await client.chat({ model: m.tag, messages: [{ role: "user", content: CODING_PROMPT }], max_tokens: o.maxTokens, temperature: 0.2 });
            const ms = now() - t;
            lat.push(ms); okN++; tokens += out.completionTokens; tokenMs += ms;
          } catch (err) { errs.push((err as Error).message.slice(0, 160)); }
        }));
      }
      const wall = now() - t0;
      report.concurrency.push({ model: m.tag, concurrency: level, ok: okN, errors: errs.length, aggregateTokensPerSecond: okN && wall ? round1(tokens / (wall / 1000)) : null,
        perRequestTokensPerSecond: okN && tokenMs ? round1(tokens / (tokenMs / 1000)) : null, p50Ms: pct(lat, 0.5), p95Ms: pct(lat, 0.95), errorSamples: errs.slice(0, 3) });
      log(`   concurrency ${level}: ${okN} ok, ${errs.length} errors, ${report.concurrency.at(-1)!.aggregateTokensPerSecond ?? "-"} tok/s total, p95 ${report.concurrency.at(-1)!.p95Ms ?? "-"} ms`);
    }
    // Tool-calling and JSON sanity (the agent loop depends on both).
    const notes: string[] = [];
    let toolCall = false, json = false;
    try {
      const out = await client.chat({ model: m.tag, max_tokens: 512, temperature: 0, messages: [{ role: "user", content: "Read the file public/index.html using the read_file tool." }],
        tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }] });
      const c = out.toolCalls[0];
      const args = typeof c?.arguments === "string" ? JSON.parse(c.arguments) : c?.arguments;
      toolCall = c?.name === "read_file" && typeof (args as { path?: unknown })?.path === "string";
      if (!toolCall) notes.push(`no valid read_file call (got ${c?.name ?? "text"})`);
    } catch (err) { notes.push(`tool call request failed: ${(err as Error).message.slice(0, 120)}`); }
    try {
      const out = await client.chat({ model: m.tag, max_tokens: 1024, temperature: 0, messages: [{ role: "user", content: "Answer with one JSON object only: {\"decision\": one of \"FIX_DEFECTS\" or \"READY\", \"findings\": [strings]} for a page whose contact form has no labels." }] });
      const text = out.content ?? "";
      const body = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
      json = !!body && typeof JSON.parse(body) === "object";
    } catch (err) { notes.push(`JSON answer invalid or failed: ${(err as Error).message.slice(0, 120)}`); }
    report.sanity.push({ model: m.tag, toolCall, json, notes });
  }
  // Switch overhead (dual mode): each direction measured as unload + load.
  if (o.models.length === 2) {
    for (const [a, b] of [[o.models[0], o.models[1]], [o.models[1], o.models[0]]]) {
      try {
        await unloadAll();
        await res.load(a.tag, "30m");
        const ms = await timed(async () => { await res.unload(a.tag); await res.load(b.tag, "30m"); });
        report.switches.push({ from: a.tag, to: b.tag, ok: true, ms });
        log(`switch ${a.tag} → ${b.tag}: ${ms} ms`);
      } catch (err) { report.switches.push({ from: a.tag, to: b.tag, ok: false, ms: null, error: (err as Error).message.slice(0, 200) }); }
    }
  }
  report.finishedAt = new Date(now()).toISOString();
  return report;
}

export function benchmarkMarkdown(r: BenchmarkReport): string {
  const lines = [`# Node 1 model benchmark (MEASURED)`, "", `Host ${r.host}, ${r.startedAt} → ${r.finishedAt}. Model server ${r.baseUrl}. Mode: ${r.mode}.`,
    `GPU sample at start: ${r.gpu ? JSON.stringify(r.gpu) : "not reported (no host sampler file)"}.`, "",
    "## Load and memory", "", "| Model | Load | GPU memory | Result |", "|---|---|---|---|",
    ...r.loads.map((l) => `| ${l.model} | ${l.loadMs ?? "-"} ms | ${l.vramMb ?? "-"} MB | ${l.ok ? "ok" : `FAILED: ${l.error}`} |`), "",
    `## Generation speed (max ${r.settings.maxTokens} tokens, ${r.settings.repeats} round(s) per level)`, "", "| Model | Concurrent | OK | Errors | Total tok/s | Per-request tok/s | p50 | p95 |", "|---|---|---|---|---|---|---|---|",
    ...r.concurrency.map((c) => `| ${c.model} | ${c.concurrency} | ${c.ok} | ${c.errors} | ${c.aggregateTokensPerSecond ?? "-"} | ${c.perRequestTokensPerSecond ?? "-"} | ${c.p50Ms ?? "-"} ms | ${c.p95Ms ?? "-"} ms |`), "",
    "## Model switching", "", ...(r.switches.length ? ["| From | To | Time |", "|---|---|---|", ...r.switches.map((s) => `| ${s.from} | ${s.to} | ${s.ok ? `${s.ms} ms` : `FAILED: ${s.error}`} |`)] : ["Single-model mode: no switching."]), "",
    "## Tool calling and JSON", "", "| Model | Tool call | JSON answer | Notes |", "|---|---|---|---|",
    ...r.sanity.map((s) => `| ${s.model} | ${s.toolCall ? "ok" : "FAILED"} | ${s.json ? "ok" : "FAILED"} | ${s.notes.join("; ") || ""} |`), "",
    "Use the highest concurrency level whose p95 latency and error count stay acceptable as INFERENCE_MAX_CONCURRENT (installer -GpuConcurrency), and the GPU worker's concurrent website builds on the dashboard.", ""];
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  const arg = (name: string, d: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const cfg = loadConfig();
  const models = cfg.models.mode === "dual" ? [cfg.models.a, cfg.models.b] : [{ ...cfg.models.b, tag: cfg.local.model }];
  const levels = arg("concurrency", "1,2,4,8").split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 32);
  const report = await runBenchmark({ baseUrl: cfg.local.baseUrl, apiKey: cfg.local.apiKey, models, mode: cfg.models.mode, levels, repeats: Math.max(1, Number(arg("repeats", "2")) || 2), maxTokens: Math.max(64, Number(arg("max-tokens", "1024")) || 1024), telemetryFile: cfg.inference.telemetryFile, requestTimeoutMs: cfg.local.requestTimeoutMs },
    { log: (l) => process.stdout.write(`${l}\n`) });
  const out = arg("out", path.join(cfg.workspacesRoot, "benchmarks"));
  mkdirSync(out, { recursive: true });
  const stem = path.join(out, `benchmark-${report.startedAt.replace(/[:.]/g, "-")}`);
  writeFileSync(`${stem}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${stem}.md`, benchmarkMarkdown(report));
  process.stdout.write(`\nWritten: ${stem}.json and ${stem}.md\n`);
  return report.loads.every((l) => l.ok) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`benchmark: ${(e as Error).message}\n`); process.exit(1); });
}
