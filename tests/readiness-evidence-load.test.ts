// The bounded evidence load (src/readiness/evidence-load.ts) must give EXACTLY the report the full history gives.
// Randomized histories — branches, sources, environments, skipped rows, ties on finished_at, several tests per
// requirement per run, deployments that do and do not match the head — are written to a real migrated database and the
// whole report is compared: every requirement status, every gate, the scores, the decision and the evidence-set hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./support/sqlite-d1.ts";
import { ingestEvidence, syncRequirements } from "../src/readiness/ingest.ts";
import { buildReport, loadReadinessInput } from "../src/readiness/report.ts";
import { allEvidence, relevantEvidence } from "../src/readiness/evidence-load.ts";
import { REQUIREMENTS } from "../requirements/inventory.ts";
import { readFileSync } from "node:fs";

/** Small deterministic PRNG so a failure reproduces from its seed. */
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

async function history(seed: number, runs: number, commitCount = 6) {
  const r = rng(seed), pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const db = createTestDb();
  await syncRequirements(db);
  const reqIds = REQUIREMENTS.map((x) => x.id).slice(0, 40); // a working set, so requirements collect many results
  const commits = Array.from({ length: commitCount }, (_, i) => (i.toString(16).padStart(8, "0") + "c0ffee".repeat(6)).slice(0, 40));
  const SOURCES = [["ci", "development"], ["ci", "development"], ["staging_e2e", "staging"], ["production_check", "production"], ["integration_probe", "staging"]] as const;
  const t0 = Date.parse("2026-11-01T00:00:00Z");
  const stmts = [];
  for (let i = 0; i < runs; i++) {
    const [source, environment] = pick(SOURCES);
    // Ties on purpose: roughly one run in five shares its finished_at with the previous one.
    const at = new Date(t0 + (r() < 0.2 ? i - 1 : i) * 3_600_000).toISOString();
    const id = `run-${seed}-${i}`;
    stmts.push(db.prepare(`INSERT INTO evidence_runs (id, source, environment, commit_sha, branch, run_url, started_at, finished_at, received_at, payload_sha256) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, source, environment, pick(commits), source === "ci" ? pick(["main", "main", "feature"]) : "main", null, at, at, at, "x".repeat(64)));
    for (const req of reqIds) {
      if (r() < 0.55) continue;
      const tests = 1 + Math.floor(r() * 3);
      for (let k = 0; k < tests; k++) {
        const outcome = r() < 0.7 ? "passed" : r() < 0.6 ? "failed" : "skipped";
        stmts.push(db.prepare(`INSERT INTO test_evidence (run_id, requirement_id, test_name, outcome) VALUES (?,?,?,?)`).bind(id, req, `t${k}`, outcome));
      }
    }
  }
  // Deployments: sometimes at a commit that has evidence, sometimes not; failures and ties too.
  for (const [j, env] of (["staging", "production", "staging", "production"] as const).entries()) {
    if (r() < 0.25) continue;
    stmts.push(db.prepare(`INSERT INTO deployments (id, environment, commit_sha, initiated_by, status, deployed_at) VALUES (?,?,?,?,?,?)`)
      .bind(`dep-${seed}-${j}`, env, pick(commits), "ci", r() < 0.8 ? "succeeded" : "failed", new Date(t0 + Math.floor(r() * runs) * 3_600_000).toISOString()));
  }
  for (let i = 0; i < stmts.length; i += 400) await db.batch(stmts.slice(i, i + 400));
  return db;
}

const now = new Date("2026-11-06T00:00:00Z");

test("[READY-013] the bounded evidence load gives exactly the full-history report (randomized histories, ties included)", async () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
    const db = await history(seed, 30 + (seed % 7) * 10);
    const bounded = await loadReadinessInput(db, now);
    const full = { ...bounded, evidence: await allEvidence(db) };
    assert.ok(bounded.evidence.length <= full.evidence.length);
    const [a, b] = [await buildReport(full), await buildReport(bounded)];
    assert.deepEqual(b.requirements, a.requirements, `seed ${seed}: requirement statuses`);
    assert.deepEqual(b.gates, a.gates, `seed ${seed}: gates`);
    assert.deepEqual(b.scores, a.scores, `seed ${seed}: scores`);
    assert.deepEqual(b.decision, a.decision, `seed ${seed}: decision`);
    assert.equal(b.evidenceSetSha256, a.evidenceSetSha256, `seed ${seed}: evidence set (what a Founder approval is bound to)`);
  }
});

test("[READY-013] the bounded load does not grow with history: 300 runs read about what 30 do", async () => {
  // Realistic: nearly every run is a new commit (a CI run or a deploy per merge).
  const db = await history(7, 300, 120);
  const all = (await allEvidence(db)).length, some = (await relevantEvidence(db)).length;
  assert.ok(all > 5000, `a long history (${all} rows)`);
  assert.ok(some < all / 5, `the report reads ${some} of ${all} rows`);
});

/** Counts the two statements a cache miss runs (the rollup read and the filtered pass). */
function spy(db: Awaited<ReturnType<typeof history>>) {
  let scans = 0;
  const wrapped = {
    prepare: (sql: string) => { if (/FROM evidence_rollup|json_each\(\?1\)/.test(sql)) scans++; return db.prepare(sql); },
    batch: (s: unknown[]) => db.batch(s as never),
  } as unknown as typeof db;
  return { db: wrapped, scans: () => scans };
}

test("[READY-013] back-to-back readiness pages scan the history once; new evidence or a new deployment is seen at once", async () => {
  const { withTransientRetry } = await import("../src/lib/db.ts");
  const base = await history(42, 60, 30);
  const s = spy(base);
  // A fresh retry wrapper per request, exactly as handle() does: the cache must key on the real database.
  const first = await relevantEvidence(withTransientRetry(s.db));
  for (let i = 0; i < 4; i++) assert.deepEqual(await relevantEvidence(withTransientRetry(s.db)), first);
  assert.equal(s.scans(), 2, "one aggregate and one filtered pass for five page loads");
  // New evidence (append-only: a higher row id) invalidates.
  await base.prepare(`INSERT INTO evidence_runs (id, source, environment, commit_sha, branch, started_at, finished_at, received_at, payload_sha256) VALUES ('run-new','ci','development','${"e".repeat(40)}','main','2026-11-09T00:00:00Z','2026-11-09T00:00:00Z','2026-11-09T00:00:00Z','${"x".repeat(64)}')`).run();
  await base.prepare(`INSERT INTO test_evidence (run_id, requirement_id, test_name, outcome) VALUES ('run-new', ?, 't', 'failed')`).bind(REQUIREMENTS[0].id).run();
  const after = await relevantEvidence(withTransientRetry(s.db));
  assert.equal(s.scans(), 4);
  assert.ok(after.some((r) => r.run_id === "run-new"), "the new run is in the next report");
  assert.deepEqual(after, await allEvidence(base).then(async () => relevantEvidence(base)), "and the cached result equals a fresh load");
  // A new succeeded deployment changes the judged commits, so it invalidates too.
  await base.prepare(`INSERT INTO deployments (id, environment, commit_sha, initiated_by, status, deployed_at) VALUES ('dep-new','staging','${"e".repeat(40)}','ci','succeeded','2026-11-09T01:00:00Z')`).run();
  await relevantEvidence(withTransientRetry(s.db));
  assert.equal(s.scans(), 6);
  // Another database never sees this one's entry.
  const other = await history(43, 20, 10);
  assert.deepEqual(await relevantEvidence(other), (await loadReadinessInput(other, now)).evidence);
  const bounded = await loadReadinessInput(other, now);
  const [a, b] = [await buildReport({ ...bounded, evidence: await allEvidence(other) }), await buildReport(bounded)];
  assert.equal(b.evidenceSetSha256, a.evidenceSetSha256);
});

// ───────────── Rollups (migration 0091): the aggregates are kept as rows arrive, never recomputed from the history ─────────────

const FULL_AGG = `SELECT te.requirement_id AS r, er.environment AS env, er.source AS src, MAX(er.finished_at) AS any_at,
    MAX(CASE WHEN te.outcome <> 'skipped' THEN er.finished_at END) AS ns_at, MAX(CASE WHEN te.outcome = 'passed' THEN er.finished_at END) AS pass_at,
    MIN(CASE WHEN te.outcome = 'failed' THEN te.id END) AS f_id, MIN(CASE WHEN te.outcome = 'passed' THEN te.id END) AS p_id
  FROM test_evidence te JOIN evidence_runs er ON er.id = te.run_id GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
const ROLLUP = `SELECT requirement_id AS r, environment AS env, source AS src, any_at, ns_at, pass_at, f_id, p_id FROM evidence_rollup ORDER BY 1, 2, 3`;
const FULL_COUNTS = `SELECT er.id AS run_id, COALESCE(SUM(te.outcome='passed'),0) AS passed, COALESCE(SUM(te.outcome='failed'),0) AS failed, COALESCE(SUM(te.outcome='skipped'),0) AS skipped
  FROM evidence_runs er LEFT JOIN test_evidence te ON te.run_id = er.id GROUP BY er.id ORDER BY er.id`;
const COUNTS = `SELECT er.id AS run_id, COALESCE(c.passed,0) AS passed, COALESCE(c.failed,0) AS failed, COALESCE(c.skipped,0) AS skipped
  FROM evidence_runs er LEFT JOIN evidence_run_counts c ON c.run_id = er.id ORDER BY er.id`;
const rowsOf = (db: Awaited<ReturnType<typeof history>>, sql: string) => db.raw.prepare(sql).all().map((x) => ({ ...x }));

test("[READY-013] the evidence rollups equal the full-history aggregates: trigger-maintained, backfilled, and through ingest with duplicates", async () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21]) {
    const db = await history(seed, 30 + seed * 3);
    assert.deepEqual(rowsOf(db, ROLLUP), rowsOf(db, FULL_AGG), `seed ${seed}: rollup kept by the trigger`);
    assert.deepEqual(rowsOf(db, COUNTS), rowsOf(db, FULL_COUNTS), `seed ${seed}: run counts kept by the trigger`);
    // The migration's own backfill, replayed on the same history, produces the same rows.
    const sql = readFileSync("migrations/0091_evidence_rollups.sql", "utf8").replace(/^\s*--.*$/gm, "").split("CREATE TRIGGER")[0];
    const backfill = [...sql.matchAll(/INSERT INTO evidence_(rollup|run_counts) \([^)]*\)\s+SELECT[\s\S]*?;/g)].map((m) => m[0]);
    assert.equal(backfill.length, 2, "two backfill statements");
    db.raw.exec(`DELETE FROM evidence_rollup; DELETE FROM evidence_run_counts; ${backfill.join("\n")}`);
    assert.deepEqual(rowsOf(db, ROLLUP), rowsOf(db, FULL_AGG), `seed ${seed}: backfill`);
    assert.deepEqual(rowsOf(db, COUNTS), rowsOf(db, FULL_COUNTS), `seed ${seed}: backfilled counts`);
  }
  // Through the real ingest path: a re-sent run is a duplicate, and a repeated result inside one run is skipped by
  // ON CONFLICT DO NOTHING, which fires no trigger, so nothing is counted twice.
  const db = createTestDb();
  await syncRequirements(db);
  const [a, b] = [REQUIREMENTS[0].id, REQUIREMENTS[1].id];
  const doc = (runId: string, finishedAt: string, results: { requirementId: string; testName: string; outcome: string }[]) => JSON.stringify({
    runId, source: "ci", environment: "development", commitSha: "a".repeat(40), branch: "main", startedAt: finishedAt, finishedAt, results });
  await ingestEvidence(db, doc("i-1", "2026-11-01T00:00:00Z", [{ requirementId: a, testName: "t", outcome: "passed" }, { requirementId: a, testName: "t", outcome: "passed" }, { requirementId: b, testName: "u", outcome: "skipped" }]));
  await ingestEvidence(db, doc("i-1", "2026-11-01T00:00:00Z", [{ requirementId: a, testName: "t", outcome: "failed" }]));
  await ingestEvidence(db, doc("i-2", "2026-11-02T00:00:00Z", [{ requirementId: a, testName: "t", outcome: "failed" }, { requirementId: b, testName: "u", outcome: "passed" }]));
  assert.deepEqual(rowsOf(db, ROLLUP), rowsOf(db, FULL_AGG));
  assert.deepEqual(rowsOf(db, COUNTS), rowsOf(db, FULL_COUNTS));
  assert.deepEqual(rowsOf(db, COUNTS).map((x) => [x.run_id, x.passed, x.failed, x.skipped]), [["i-1", 1, 0, 1], ["i-2", 1, 1, 0]]);
});

test("[READY-013] a readiness cache miss and the run list never scan test_evidence (query plans)", async () => {
  const db = await history(7, 120, 60);
  const seen: { sql: string; binds: unknown[] }[] = [];
  const spyDb = {
    prepare: (sql: string) => {
      const st = db.prepare(sql);
      const entry = { sql, binds: [] as unknown[] };
      seen.push(entry);
      return new Proxy(st, { get: (t, p) => p === "bind" ? (...b: unknown[]) => { entry.binds = b; return (t as any).bind(...b); } : (t as any)[p] });
    },
    batch: (s: unknown[]) => db.batch(s as never),
  } as unknown as typeof db;
  await relevantEvidence(spyDb);
  const { runSummaries } = await import("../src/services/readiness-admin.ts");
  await runSummaries(spyDb, { environment: "staging", limit: 15 });
  await runSummaries(spyDb, { source: "ci", limit: 15 });
  const scans: string[] = [];
  for (const { sql, binds } of seen) {
    if (!/test_evidence|evidence_rollup|evidence_run_counts/.test(sql)) continue;
    const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[])) as { detail: string }[]).map((x) => x.detail);
    // A SCAN reads the whole history; idx_test_evidence_req reads a requirement's whole history per lookup. Rows must be
    // reached by id or through their run (sqlite_autoindex_test_evidence_1 is UNIQUE (run_id, requirement_id, test_name)).
    for (const d of plan) if (/^SCAN (te|test_evidence)\b|idx_test_evidence_req/.test(d)) scans.push(`${sql.replace(/\s+/g, " ").slice(0, 80)}… → ${d}`);
  }
  assert.ok(seen.some((s) => /FROM evidence_rollup/.test(s.sql)), "the rollup is read");
  assert.deepEqual(scans, [], "no statement scans the evidence history");
});
