// Silent cron failure detection (READY-012, INFRA-006). Found on staging 2026-10-27: no job:* feed had ever been
// recorded there, i.e. the cron-triggered jobs were not running, yet health reported ok.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";
import { scheduled } from "../src/app/scheduled.ts";

type Health = { status: string; feeds: { source: string; required: boolean; status: string }[] };
const health = async (t: Awaited<ReturnType<typeof createTestApp>>) => { const r = await t.client().get("/api/readiness/health"); return { code: r.status, body: await r.json() as Health }; };
async function staging(liveForMinutes: number | null) {
  const t = await createTestApp({ ENVIRONMENT: "staging" } as never);
  // The required CI feed is healthy in these scenarios, so only the scheduler decides.
  await t.db.prepare(`INSERT INTO ingestion_status (source, last_success_at, last_attempt_at, last_error) VALUES ('ci', ?, ?, NULL)`).bind(new Date().toISOString(), new Date().toISOString()).run();
  if (liveForMinutes !== null) await t.db.prepare(`INSERT INTO deployments (id, environment, commit_sha, initiated_by, status, deployed_at) VALUES ('dep_t', 'staging', ?, 'test', 'succeeded', ?)`)
    .bind("a".repeat(40), new Date(Date.now() - liveForMinutes * 60_000).toISOString()).run();
  return t;
}

test("[READY-012] [INFRA-006] deployed environments require the scheduler: never-run or stale cron jobs make /api/readiness/health answer 503 (so the external monitor alerts)", async () => {
  let t = await staging(180);
  let h = await health(t);
  assert.equal(h.code, 503, "cron jobs that never ran on a deployed environment are a failure, not silence");
  assert.deepEqual(h.body.feeds.find((f) => f.source === "scheduler"), { source: "scheduler", required: true, status: "unavailable", lastSuccessAt: null });
  // After the 15-minute and daily jobs run, health recovers.
  await scheduled({ cron: "*/15 * * * *" }, t.env);
  await scheduled({ cron: "17 11 * * *" }, t.env);
  h = await health(t);
  assert.equal(h.code, 200);
  assert.equal(h.body.feeds.find((f) => f.source === "scheduler")!.status, "healthy");
  // A 15-minute job that stopped 2 hours ago is stale.
  await t.db.prepare(`UPDATE ingestion_status SET last_success_at = ? WHERE source = 'job:build_sweep'`).bind(new Date(Date.now() - 2 * 3_600_000).toISOString()).run();
  h = await health(t);
  assert.equal(h.code, 503);
  assert.equal(h.body.feeds.find((f) => f.source === "scheduler")!.status, "stale");

  // Grace: within the first hour after the first deployment, and the daily job is not expected before 26 h.
  t = await staging(20);
  assert.equal((await health(t)).body.feeds.find((f) => f.source === "scheduler")!.status, "healthy");
  t = await staging(300);
  await scheduled({ cron: "*/15 * * * *" }, t.env);
  assert.equal((await health(t)).code, 200, "daily jobs need not have run in the first 26 hours");

  // Development has no scheduler: no feed, no effect.
  const dev = await createTestApp();
  assert.equal((await health(dev)).body.feeds.some((f) => f.source === "scheduler"), false);
});

test("[TEST-004] [INFRA-005] [INFRA-006] signed rollback-rehearsal and restore-drill evidence each feed a recovery health signal; a failed drill degrades /api/readiness/health", async () => {
  const { ingestEvidence } = await import("../src/readiness/ingest.ts");
  const { rehearsalEvidence } = await import("../scripts/rollback-rehearsal.ts");
  const { drillEvidence } = await import("../scripts/restore-drill.ts");
  const t = await createTestApp();
  await t.db.prepare(`INSERT INTO ingestion_status (source, last_success_at, last_attempt_at, last_error) VALUES ('ci', ?, ?, NULL)`).bind(new Date().toISOString(), new Date().toISOString()).run();
  const now = new Date().toISOString();
  await ingestEvidence(t.db, JSON.stringify(rehearsalEvidence({ commit: "c".repeat(40), runId: "gh-1-1-rollback", startedAt: now, rollback: true, rollforward: true })));
  await ingestEvidence(t.db, JSON.stringify(drillEvidence({ passed: true, tables: 90, rows: 432, problems: [] }, { commit: "c".repeat(40), runId: "gh-2-1-restore", startedAt: now })));
  let h = await health(t);
  assert.equal(h.code, 200);
  for (const s of ["recovery:rollback:staging", "recovery:restore:staging"]) assert.equal(h.body.feeds.find((f) => f.source === s)?.status, "healthy", s);
  await ingestEvidence(t.db, JSON.stringify(rehearsalEvidence({ commit: "c".repeat(40), runId: "gh-3-1-rollback", startedAt: now, rollback: false, rollforward: true })));
  h = await health(t);
  assert.equal(h.code, 503, "a failed rollback rehearsal alerts");
  assert.equal(h.body.feeds.find((f) => f.source === "recovery:rollback:staging")?.status, "failing");
});

test("[SEC-006] [READY-006] request metrics older than 90 days are purged by the daily retention job; recent buckets stay", async () => {
  const { runRetention } = await import("../src/services/retention.ts");
  const t = await createTestApp();
  const hour = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 13);
  for (const d of [1, 89, 91, 400]) await t.db.prepare(`INSERT INTO env_metrics (environment, hour, area, requests) VALUES ('staging', ?, 'site', 1)`).bind(hour(d)).run();
  const r = await runRetention({ db: t.db, storage: t.storage });
  assert.equal(r.find((x) => x.category === "env_metrics")?.affected, 2);
  assert.deepEqual((await t.db.prepare(`SELECT hour FROM env_metrics ORDER BY hour DESC`).all<{ hour: string }>()).results.map((x) => x.hour), [hour(1), hour(89)]);
});
