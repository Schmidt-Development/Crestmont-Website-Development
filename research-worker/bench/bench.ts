// 10,000-record pipeline benchmark (SYNTHETIC). Runs the real worker code — state file, stage A-E evaluation,
// audits, outbox, signed delivery into the real platform pipeline (in-process, in-memory SQLite) — over generated
// TEST DATA businesses whose websites are simulated with a fixed network latency. It measures the software's own
// throughput and resource use; it does NOT measure internet latency, robots/politeness waits, real site mix, DuckDB
// dataset scans, Playwright/Lighthouse, or the local model. Real numbers come from running the worker on the
// workstation and reading its measured counters (docs/research/RUNBOOK.md §Benchmark).
//
//   node --no-warnings research-worker/bench/bench.ts [--n 10000] [--latency 250] [--concurrency 64] [--json out.json]
import { createTestApp } from "../../tests/support/app.ts";
import { handle } from "../../src/app/app.ts";
import { State } from "../src/state.ts";
import { loadConfig } from "../src/config.ts";
import { Platform } from "../src/crm-client.ts";
import { ResearchWorker } from "../src/orchestrator.ts";
import { silentLogger } from "../src/log.ts";
import { snapshot } from "../src/resources.ts";
import { FakeHttp, cand, ok, status, page } from "../test/helpers.ts";
import type { FetchResult } from "../src/http.ts";
import type { SqliteDb } from "../../dev/sqlite-d1.ts";
import { writeFileSync } from "node:fs";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg("n", 10_000), LATENCY = arg("latency", 250), CONC = arg("concurrency", 64);
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

const SECRET = "bench-research-secret-0123456789abcdef0123";
const app = await createTestApp({ RESEARCH_RUNNER_SECRET: SECRET });
const raw = (app.db as SqliteDb).raw;
raw.prepare(`UPDATE research_settings SET paused = 0, max_batch = 200 WHERE id = 1`).run();
const fetchImpl = (async (url: string | URL, init?: RequestInit) => handle(new Request(url, init), app.env)) as typeof fetch;
const cfg = loadConfig({ CRESTMONT_URL: "https://crestmont.test", RESEARCH_RUNNER_SECRET: SECRET, COMMON_CRAWL: "off", PLAYWRIGHT: "off", HTTP_CONCURRENCY: String(CONC) });

// Synthetic mix (TEST DATA): 35% healthy site, 20% site with issues, 10% broken, 25% no website field, 10% no phone.
const routes: Record<string, FetchResult> = {};
const items = Array.from({ length: N }, (_, i) => {
  const kind = i % 20;
  const area = ["517", "616", "313", "248", "734", "269", "989", "810"][i % 8];
  const phone = kind >= 18 ? [] : [`+1${area}${String(200 + Math.floor(i / 8) % 700)}${String(1000 + (i % 9000)).padStart(4, "0")}`];
  const domain = `bench-business-${i}.example`, url = `https://${domain}/`;
  const shown = phone[0] ? `(${phone[0].slice(2, 5)}) ${phone[0].slice(5, 8)}-${phone[0].slice(8)}` : "";
  if (kind < 7) routes[url] = ok(url, page({ title: `Bench Business ${i}`, phone: shown || "(517) 555-2000", street: `${100 + i} Main Street` }));
  else if (kind < 11) routes[url] = ok(url, page({ title: `Bench Business ${i}`, phone: shown || "(517) 555-2000", street: `${100 + i} Main Street`, viewport: false, lang: false }));
  else if (kind < 13) routes[url] = status(url, 503);
  return cand({ businessKey: `overture:bench${i}`, name: `Bench Business ${i}`, phones: phone, websites: kind >= 13 && kind < 18 ? [] : [url], address: { line: `${100 + i} Main St`, city: "Lansing", state: "MI", zip: "48933" } });
});
const http = new FakeHttp(routes, LATENCY);
const state = new State(":memory:");
const worker = new ResearchWorker({ cfg: { ...cfg, http: { ...cfg.http, brokenAttempts: 1 } }, state, http: http as never, platform: new Platform(cfg.platformUrl, SECRET, fetchImpl), sources: [], cc: null, browser: null, model: null, log: silentLogger });
await worker.heartbeat();

const r0 = await snapshot(process.cwd());
const t0 = Date.now();
for (const c of items) state.upsertCandidate(c, "MI", new Date(), 30);
const ingestMs = Date.now() - t0;
let peakRss = 0, cpuSamples: number[] = [];
const sampler = setInterval(async () => { const s = await snapshot(process.cwd()); peakRss = Math.max(peakRss, s.rssMb); cpuSamples.push(s.cpuPct); }, 1000);
const ac = new AbortController();
const work = worker.workLoop(ac.signal);
while (state.backlog() > 0) await new Promise((r) => setTimeout(r, 200));
ac.abort(); await work;
const workMs = Date.now() - t0 - ingestMs;
const d0 = Date.now();
await worker.deliverOnce();
const deliverMs = Date.now() - d0;
clearInterval(sampler);
const totalMs = Date.now() - t0;

const q = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
const counts = worker.status().classCounts;
const verified = (counts.VERIFIED_OFFICIAL_WEBSITE ?? 0) + (counts.VERIFIED_WEBSITE_ISSUES ?? 0) + (counts.VERIFIED_WEBSITE_BROKEN ?? 0);
const result = {
  kind: "SYNTHETIC (simulated websites; not a live or hardware-representative figure)",
  records: N, simulatedLatencyMs: LATENCY, concurrency: CONC, httpRequests: http.requests.length,
  ingestMs, verifyAuditMs: workMs, deliverMs, totalMs,
  recordsPerHour: Math.round(N / (totalMs / 3600e3)),
  uniqueBusinesses: (state.db.prepare(`SELECT COUNT(DISTINCT business_key) AS n FROM candidates`).get() as { n: number }).n,
  phoneAvailability: items.filter((c) => c.phones.length).length / N,
  websiteVerificationRate: verified / N,
  classCounts: counts,
  sentToPlatform: q(`SELECT COUNT(*) AS n FROM research_prospects`),
  qualifiedYield: q(`SELECT COUNT(*) AS n FROM research_prospects WHERE qualified = 1`) / N,
  eligibleCallableYield: q(`SELECT COUNT(*) AS n FROM research_prospects WHERE eligibility = 'eligible'`) / N,
  falsePositiveRate: "not measurable on synthetic data: requires a manually verified sample of live results (RUNBOOK §Benchmark)",
  resources: { before: r0, peakRssMb: peakRss, avgCpuPct: cpuSamples.length ? Math.round(cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length) : null, after: await snapshot(process.cwd()) },
  incrementalExternalFees: "$0 (no external API called)",
};
console.log(JSON.stringify(result, null, 2));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2));
process.exit(0);
