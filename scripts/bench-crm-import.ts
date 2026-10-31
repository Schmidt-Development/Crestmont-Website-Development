// Local benchmark for the CRM import path (src/services/crm-import.ts). Runs on node:sqlite, NOT on Cloudflare D1:
// it measures D1 statements per record (the number that matters for the 1,000-queries-per-invocation limit) and local
// throughput. D1 adds network latency per statement; measure on staging before relying on throughput figures.
//   node --no-warnings scripts/bench-crm-import.ts [--records 2000] [--batch 50] [--dup-rate 0.2]
import { openDb } from "../dev/sqlite-d1.ts";
import type { Db, DbStatement } from "../src/lib/db.ts";
import { runImport, IMPORT_API_VERSION, MAX_RECORDS } from "../src/services/crm-import.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const total = arg("--records", 2000), batchSize = Math.min(arg("--batch", MAX_RECORDS), MAX_RECORDS), dupRate = arg("--dup-rate", 0.2);
const base = openDb();
let statements = 0;
// Counts every statement sent to the database (single queries and each statement inside a batch).
const db: Db = {
  prepare: (sql) => {
    const wrap = (r: DbStatement): DbStatement => Object.assign(Object.create(Object.getPrototypeOf(r)), r, {
      bind: (...v: unknown[]) => wrap(r.bind(...v)),
      all: () => { statements++; return r.all(); }, first: () => { statements++; return r.first(); }, run: () => { statements++; return r.run(); },
    });
    return wrap(base.prepare(sql));
  },
  batch: (st) => { statements += st.length; return base.batch(st); },
};

const rec = (i: number) => {
  const k = Math.random() < dupRate && i > 10 ? Math.floor(Math.random() * i) : i;  // a share of records repeat earlier businesses
  return { externalId: `bench-${i}`, business: { name: `Bench Business ${k}`, website: `https://bench-${k}.example`, location: { city: "Detroit", region: "MI" } },
    phones: [{ value: `+1313${String(5550000 + (k % 10000)).padStart(7, "0")}` }], emails: k % 3 === 0 ? [{ value: `owner@bench-${k}.example` }] : [], confidence: 50 };
};
const t0 = performance.now();
const counts: Record<string, number> = {};
let maxPerBatch = 0;
for (let b = 0; b * batchSize < total; b++) {
  const before = statements;
  const records = Array.from({ length: Math.min(batchSize, total - b * batchSize) }, (_, j) => rec(b * batchSize + j));
  const res = await runImport(db, JSON.stringify({ apiVersion: IMPORT_API_VERSION, records }), { client: "bench", idempotencyKey: `bench-batch-${b}` });
  for (const [k, v] of Object.entries(res.counts)) counts[k] = (counts[k] ?? 0) + v;
  maxPerBatch = Math.max(maxPerBatch, statements - before);
}
const ms = performance.now() - t0;
console.log(JSON.stringify({
  environment: "node:sqlite (local) — not Cloudflare D1", records: total, batchSize, dupRate, outcomes: counts,
  statementsPerRecord: +(statements / total).toFixed(1), maxStatementsPerBatch: maxPerBatch, d1QueryLimitPerInvocation: 1000,
  seconds: +(ms / 1000).toFixed(2), recordsPerSecondLocal: Math.round(total / (ms / 1000)),
}, null, 2));
