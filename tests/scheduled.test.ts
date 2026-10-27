import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";
import { runJobs, SCHEDULE } from "../src/app/scheduled.ts";
import { readFileSync } from "node:fs";

test("[READY-012] scheduled jobs run independently and record their health for self-monitoring", async () => {
  const { db, env } = await createTestApp();
  const results = await runJobs(env, ["requirements", "stripe_reconcile", "support_escalation", "github_sync", "inactivity", "integration_health"]);
  for (const [job, r] of Object.entries(results)) assert.equal(r.ok, true, `${job}: ${r.detail}`);
  assert.match(results.github_sync.detail, /not configured/);
  const rows = (await db.prepare(`SELECT source, last_success_at, last_error FROM ingestion_status WHERE source LIKE 'job:%'`).all<{ source: string; last_success_at: string | null; last_error: string | null }>()).results;
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => r.last_success_at && !r.last_error));
  const blocked = await db.prepare(`SELECT COUNT(*) n FROM blocker_requirements`).first<{ n: number }>();
  assert.ok(blocked!.n > 0, "discovery blocker links applied by the requirements job");
});

test("[PM-005] the daily schedule runs the inactivity sweep; cron triggers match wrangler.toml", () => {
  assert.ok(Object.values(SCHEDULE).flat().includes("inactivity"));
  const toml = readFileSync("wrangler.toml", "utf8");
  for (const cron of Object.keys(SCHEDULE)) assert.ok(toml.includes(`"${cron}"`), `wrangler.toml declares ${cron}`);
});

test("[READY-012] a failing job is recorded as failing without stopping the others", async () => {
  const { db, env } = await createTestApp();
  await db.prepare(`DROP TABLE stripe_events`).run();
  const results = await runJobs(env, ["stripe_reconcile", "support_escalation"]);
  assert.equal(results.stripe_reconcile.ok, false);
  assert.equal(results.support_escalation.ok, true);
  const row = await db.prepare(`SELECT last_error FROM ingestion_status WHERE source = 'job:stripe_reconcile'`).first<{ last_error: string }>();
  assert.match(row!.last_error, /stripe_events/);
});
