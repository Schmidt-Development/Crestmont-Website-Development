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
const latencyMs = arg("--latency", 60);
const budgetMs = arg("--budget", 20_000);

const base = openDb();
let statements = 0;      // every statement sent, including each one inside a batch (D1 row-write billing, 1k limit)
let roundTrips = 0;      // every await that crosses the wire; a batch is ONE round trip however many statements
const db: Db = {
  prepare: (sql) => {
    const wrap = (r: DbStatement): DbStatement => Object.assign(Object.create(Object.getPrototypeOf(r)), r, {
      bind: (...v: unknown[]) => wrap(r.bind(...v)),
      all: () => { statements++; roundTrips++; return r.all(); },
      first: () => { statements++; roundTrips++; return r.first(); },
      run: () => { statements++; roundTrips++; return r.run(); },
    });
    return wrap(base.prepare(sql));
  },
  batch: (st) => { statements += st.length; roundTrips++; return base.batch(st); },
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
const r = await runAutoPromotion(db, { trigger: "owner", limit: Math.max(total, 1), budgetMs });
const ms = performance.now() - t0;

const leads = (await base.prepare(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent'`).first<{ n: number }>())!.n;
const inNew = (await base.prepare(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent' AND stage = 'new'`).first<{ n: number }>())!.n;
const attributed = (await base.prepare(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent' AND utm_source = 'crestmont-research' AND intake_decision_id IS NOT NULL`).first<{ n: number }>())!.n;
const doubled = (await base.prepare(`SELECT COUNT(*) AS n FROM (SELECT crm_lead_id FROM research_prospects WHERE crm_lead_id IS NOT NULL AND status = 'promoted' GROUP BY crm_lead_id HAVING COUNT(*) > 1)`).first<{ n: number }>())!.n;

const perProspect = r.promoted ? roundTrips / r.promoted : 0;
const stmtsPer = r.promoted ? statements / r.promoted : 0;
// On D1 the floor is the serial chain: one prospect cannot finish faster than its own round trips × latency.
const serialMsPerProspect = perProspect * latencyMs;
const perMinuteSerial = serialMsPerProspect ? 60_000 / serialMsPerProspect : 0;

const out = [
  `# Research → CRM promotion benchmark (node:sqlite; NOT a D1 throughput figure)`,
  ``,
  `Seeded ${total} prospects, ${eligible} eligible. Budget ${budgetMs} ms.`,
  ``,
  `## What the promoter did`,
  `- examined ${r.examined}, promoted ${r.promoted}, existing ${r.existingCrm}, review ${r.review}, suppressed ${r.suppressed}, rejected ${r.rejected}, failed ${r.failed}`,
  `- stopped because: ${r.stoppedReason}; remaining ${r.remaining}`,
  `- CRM leads with origin research_agent: ${leads} (in stage new: ${inNew}; with research attribution and an intake decision: ${attributed})`,
  `- leads claimed as new by more than one prospect: ${doubled} (must be 0)`,
  ``,
  `## Cost per promoted prospect — the figures that decide D1 throughput`,
  `- **sequential round trips: ${perProspect.toFixed(1)}**`,
  `- statements: ${stmtsPer.toFixed(1)} (D1 bills row reads and writes, and caps 1,000 statements per invocation)`,
  `- local wall clock: ${(ms / Math.max(r.promoted, 1)).toFixed(1)} ms (in-process SQLite; no network)`,
  ``,
  `## Projection at ${latencyMs} ms per D1 round trip`,
  `- one prospect takes about ${Math.round(serialMsPerProspect)} ms of waiting`,
  `- **serial throughput: ${perMinuteSerial.toFixed(1)} new leads/minute** — the 25/minute target needs ${(25 / Math.max(perMinuteSerial, 0.001)).toFixed(1)}× this`,
  `- a ${budgetMs} ms budget fits about ${Math.floor(budgetMs / Math.max(serialMsPerProspect, 1))} prospects per serial run`,
  `- reaching 25/minute therefore needs either fewer round trips per prospect or that many promotions in flight at once`,
];
console.log(out.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out.join("\n")}\n`);
}
