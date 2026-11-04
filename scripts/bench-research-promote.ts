// Local benchmark for the research → CRM promotion path (src/services/research-promote.ts).
//
// It runs on node:sqlite, NOT on Cloudflare D1, so its wall-clock figure is NOT a staging throughput figure. What it
// measures is the number that actually decides throughput on D1: **sequential round trips per promoted prospect**.
// A D1 binding costs roughly 20-120 ms per round trip, and a promotion that waits for 16 of them in series can never
// run faster than 16 × that latency however fast the database is. Statements per prospect matter too, for the
// 1,000-statements-per-invocation limit and for D1 row-write billing.
//
//   node --no-warnings scripts/bench-research-promote.ts [--prospects 200] [--concurrency 1] [--latency 60]
//
// --latency models a D1 round trip in milliseconds and prints the projected per-minute throughput for the measured
// round-trip count, which is the figure to compare against the 25-new-leads-per-minute target.
import { openDb } from "../dev/sqlite-d1.ts";
import type { Db, DbStatement } from "../src/lib/db.ts";
import { runAutoPromotion } from "../src/services/research-promote.ts";
import { ingestBatch } from "../src/services/research.ts";
import type { ProspectInput } from "../src/domain/research.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const total = arg("--prospects", 200);
// A D1 round trip splits into wire time, which overlaps between queries, and service time inside the
// single-threaded database, which does not. `--latency` is accepted as the sum of the two for older invocations.
const latencyMs = arg("--latency", 60);
const serviceMs = arg("--service", Math.round(latencyMs / 3));
const rttMs = arg("--rtt", latencyMs - serviceMs);
const CONNECTIONS = arg("--connections", 6);       // the platform's simultaneous-connection limit per invocation
const budgetMs = arg("--budget", 20_000);
const concurrency = arg("--concurrency", 6);

const base = openDb();
let statements = 0;      // every statement sent, including each one inside a batch (D1 row-write billing)
let roundTrips = 0;      // every await that crosses the wire; a batch is ONE round trip however many statements
// Counting round trips is not enough: two reads issued together cost one wait, not two, so a total count cannot tell
// a serial chain from a parallel one. The wrapper therefore WAITS on every round trip — but it has to wait the way
// D1 actually behaves, not the way a parallel database would, or the model flatters concurrency and the numbers
// mean nothing:
//
//   - a Worker invocation may hold at most SIX simultaneous connections to D1, so a seventh query waits for a slot;
//   - each D1 database is a single Durable Object and PROCESSES QUERIES ONE AT A TIME, so queries issued together
//     are serialized by the database itself.
//
// So a query takes a connection slot, spends --rtt on the wire (which overlaps with other queries' wire time),
// then queues for the single-threaded database and spends --service there (which overlaps with nothing). Throughput
// is therefore bounded by the service time, and concurrency buys only the overlap of the wire legs. An earlier
// version of this script waited --latency with no connection cap and no database lock, which modelled a database
// that serves six queries at once; its concurrency figures described a machine that does not exist.
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The single-threaded database: one query at a time, in arrival order. */
let dbQueue: Promise<void> = Promise.resolve();
const serialized = <T>(f: () => Promise<T>): Promise<T> => {
  const run = dbQueue.then(() => (serviceMs > 0 ? sleep(serviceMs) : Promise.resolve()));
  dbQueue = run.then(() => undefined, () => undefined);
  return run.then(f);
};

/** The six-connection cap, as a semaphore. */
let free = CONNECTIONS;
const waiting: (() => void)[] = [];
const takeSlot = (): Promise<void> => (free > 0 ? (free--, Promise.resolve()) : new Promise<void>((r) => waiting.push(r)));
const giveSlot = () => { const next = waiting.shift(); if (next) next(); else free++; };

let peakInFlight = 0, inFlight = 0;
const trip = async <T>(f: () => Promise<T>): Promise<T> => {
  roundTrips++;
  await takeSlot();
  inFlight++; peakInFlight = Math.max(peakInFlight, inFlight);
  try {
    if (rttMs > 0) await sleep(rttMs / 2);          // request on the wire
    const out = await serialized(f);                // queued behind the single-threaded database
    if (rttMs > 0) await sleep(rttMs / 2);          // response on the wire
    return out;
  } finally { inFlight--; giveSlot(); }
};
const db: Db = {
  prepare: (sql) => {
    const wrap = (r: DbStatement): DbStatement => Object.assign(Object.create(Object.getPrototypeOf(r)), r, {
      bind: (...v: unknown[]) => wrap(r.bind(...v)),
      all: () => { statements++; return trip(() => r.all()); },
      first: () => { statements++; return trip(() => r.first()); },
      run: () => { statements++; return trip(() => r.run()); },
    });
    return wrap(base.prepare(sql));
  },
  batch: (st) => { statements += st.length; return trip(() => base.batch(st)); },
};

// Real-shaped prospects: a verified website with findings, a unique phone and a unique domain per business, so every
// one is a genuinely new CRM lead and none is held back for duplicate review. That is the path being measured.
const NOW = new Date().toISOString();
const prospect = (i: number): ProspectInput => ({
  businessKey: `overture:bench-${i}`,
  name: `Bench Plumbing ${i} (TEST DATA)`, category: "plumber",
  address: { line: `${100 + i} Main St`, city: "Lansing", state: "MI", zip: "48933" },
  phones: [`+1517${String(5550000 + i).padStart(7, "0")}`], emails: [], domains: [`bench-${i}.example`],
  sources: [{ source: "overture", sourceId: `s${i}`, license: "CDLA-Permissive-2.0", release: "2026-10-21.0", retrievedAt: NOW }],
  website: { classification: "VERIFIED_WEBSITE_ISSUES", url: `https://bench-${i}.example/`, confidence: 0.9, checkedAt: NOW,
    identitySignals: ["phone on page matches"], checks: [{ stage: "C", method: "HTTP GET", result: "200", at: NOW }] },
  findings: [
    { code: "no_viewport_meta", title: "No mobile viewport meta tag", severity: "high", confidence: 0.9, url: `https://bench-${i}.example/`, method: "HTTP GET (no JS)", observedAt: NOW, evidence: "No <meta name=viewport> in the returned HTML" },
    { code: "images_without_alt", title: "Images without alt text", severity: "medium", confidence: 0.8, url: `https://bench-${i}.example/`, method: "HTTP GET (no JS)", observedAt: NOW, evidence: "7 of 9 images had no alt attribute" },
  ],
  identityConfidence: 0.9, lastVerifiedAt: NOW,
} as ProspectInput);

// Seed through the real ingest path so statuses, scores and qualification are what the promoter will actually meet.
await base.prepare(`UPDATE research_settings SET paused = 0, auto_promote = 1, auto_promote_max_per_run = ?, max_batch = 500 WHERE id = 1`).bind(Math.max(total, 1)).run();
for (let off = 0; off < total; off += 200) {
  const items = Array.from({ length: Math.min(200, total - off) }, (_, k) => prospect(off + k));
  await ingestBatch(base, { batchId: `bench-batch-${String(off).padStart(6, "0")}`, runnerId: "bench-runner", prospects: items }, new Date());
}
const eligible = (await base.prepare(`SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'qualified' AND qualified = 1`).first<{ n: number }>())!.n;

statements = 0; roundTrips = 0;
const t0 = performance.now();
const r = await runAutoPromotion(db, { trigger: "owner", limit: Math.max(total, 1), budgetMs, concurrency });
const ms = performance.now() - t0;

const leads = (await base.prepare(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent'`).first<{ n: number }>())!.n;
const inNew = (await base.prepare(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent' AND stage = 'new'`).first<{ n: number }>())!.n;
const attributed = (await base.prepare(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent' AND utm_source = 'crestmont-research' AND intake_decision_id IS NOT NULL`).first<{ n: number }>())!.n;
const doubled = (await base.prepare(`SELECT COUNT(*) AS n FROM (SELECT crm_lead_id FROM research_prospects WHERE crm_lead_id IS NOT NULL AND status = 'promoted' GROUP BY crm_lead_id HAVING COUNT(*) > 1)`).first<{ n: number }>())!.n;

const perProspect = r.promoted ? roundTrips / r.promoted : 0;
const stmtsPer = r.promoted ? statements / r.promoted : 0;
const msPerProspect = r.promoted ? ms / r.promoted : 0;
const unit = rttMs + serviceMs;
// Critical path, in round-trip equivalents, as actually walked.
const depth = unit > 0 ? ms / unit : 0;
const depthPerProspect = r.promoted ? depth / r.promoted : 0;
const perMinute = msPerProspect ? 60_000 / msPerProspect : 0;
// The floor the single-threaded database imposes on its own: every statement must pass through it in turn, so no
// amount of concurrency can beat this.
const serviceFloorMs = r.promoted ? (statements * serviceMs) / r.promoted : 0;
const serviceFloorPerMinute = serviceFloorMs > 0 ? 60_000 / serviceFloorMs : 0;

const out = [
  `# Research → CRM promotion model (node:sqlite with D1 behaviour simulated; NOT a measurement)`,
  ``,
  `Seeded ${total} prospects, ${eligible} eligible. Budget ${budgetMs} ms, concurrency ${concurrency}, connection cap ${CONNECTIONS}.`,
  ``,
  `## What the promoter did`,
  `- examined ${r.examined}, promoted ${r.promoted}, existing ${r.existingCrm}, review ${r.review}, suppressed ${r.suppressed}, rejected ${r.rejected}, failed ${r.failed}`,
  `- stopped because: ${r.stoppedReason}; remaining ${r.remaining}`,
  `- CRM leads with origin research_agent: ${leads} (in stage new: ${inNew}; with research attribution and an intake decision: ${attributed})`,
  `- leads claimed as new by more than one prospect: ${doubled} (must be 0)`,
  ``,
  `## MODEL, not a measurement`,
  `This runs on node:sqlite with D1's behaviour simulated: ${rttMs} ms of wire time per round trip (which overlaps`,
  `between queries), ${serviceMs} ms inside a database that serves ONE query at a time, and at most ${CONNECTIONS}`,
  `simultaneous connections. Every figure below is therefore a model. The only measurement of the real rate is the`,
  `staging certification (scripts/research-promotion-certify.ts), which counts rows in the CRM.`,
  ``,
  `## Cost per promoted prospect`,
  `- round trips issued: ${perProspect.toFixed(1)}  ·  statements: ${stmtsPer.toFixed(1)} (D1 bills rows read and written)`,
  `- critical path walked: ${depthPerProspect.toFixed(1)} round-trip equivalents per prospect (${Math.round(msPerProspect)} ms each)`,
  `- peak connections in flight: ${peakInFlight} of ${CONNECTIONS} allowed`,
  ``,
  `## Modelled throughput`,
  `- ${perMinute.toFixed(1)} new leads/minute at concurrency ${concurrency}`,
  `- the single-threaded database's own floor: **${serviceFloorPerMinute.toFixed(1)}/minute** (${stmtsPer.toFixed(1)} statements x ${serviceMs} ms each, which no concurrency can beat)`,
  `- a ${budgetMs} ms run budget fits about ${Math.floor(budgetMs / Math.max(msPerProspect, 1))} prospects`,
  `- D1 allows 1,000 queries per invocation, so at ${perProspect.toFixed(1)} round trips the ceiling is ${Math.floor(1000 / Math.max(perProspect, 0.001))} prospects in one invocation`,
];
console.log(out.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out.join("\n")}\n`);
}
