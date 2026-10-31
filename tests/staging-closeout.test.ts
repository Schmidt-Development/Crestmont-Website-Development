// Staging closeout (2026-10-28). Root causes found in deploy #57 and in /api/readiness/health:
//  - the rollback rehearsal tried to roll back across a secret change (credential rotation): Cloudflare refuses (10220)
//    and forcing it would restore the old secrets, yet the feed went "failing", so health answered 503 and the
//    scheduled monitor failed;
//  - journey 1's Turnstile wait used page.waitForFunction, which the site's CSP (no 'unsafe-eval') refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createTestApp } from "./support/app.ts";
import { pickRollback, rehearsalEvidence, NO_SAFE_TARGET } from "../scripts/rollback-rehearsal.ts";
import { ingestEvidence, recoveryDrillOutcomes, parseEvidence, UNAVAILABLE_PREFIX } from "../src/readiness/ingest.ts";

const status = (id: string) => JSON.stringify({ versions: [{ version_id: id, percentage: 100 }] });
const ver = (id: string, minutesAgo: number, trigger: string) => ({ id, created_on: new Date(Date.now() - minutesAgo * 60_000).toISOString(), annotations: { "workers/triggered_by": trigger } });
const U = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-${String(n).repeat(12)}`;

test("[TEST-004] [INFRA-005] rollback target: a secret change after the previous code version is detected (deploy #57: rotation → 10220)", () => {
  // Deploy #56 uploaded A, then the rotation put STAGING_ACCESS_PASSWORD (secret-only A'); deploy #57 uploaded B.
  const after57 = JSON.stringify([ver(U(3), 1, "upload"), ver(U(2), 120, "secret"), ver(U(1), 121, "upload")]);
  assert.deepEqual(pickRollback(status(U(3)), after57), { current: U(3), previous: U(1), previousIsOlderCode: true, secretChanged: true });
  // The next deploy uploads C under the same secrets: B is a safe target again.
  const after58 = JSON.stringify([ver(U(4), 1, "upload"), ver(U(3), 60, "upload"), ver(U(2), 120, "secret"), ver(U(1), 121, "upload")]);
  assert.deepEqual(pickRollback(status(U(4)), after58), { current: U(4), previous: U(3), previousIsOlderCode: true, secretChanged: false });
  // Serving a secret-only version on top of the code (secret put after the deploy): the previous code predates it.
  const secretOnTop = JSON.stringify([ver(U(5), 1, "secret"), ver(U(4), 30, "upload"), ver(U(3), 60, "upload")]);
  assert.deepEqual(pickRollback(status(U(5)), secretOnTop), { current: U(5), previous: U(3), previousIsOlderCode: true, secretChanged: true });
  // No secret change anywhere: unchanged behaviour.
  const plain = JSON.stringify([ver(U(7), 1, "upload"), ver(U(6), 30, "upload")]);
  assert.equal(pickRollback(status(U(7)), plain).secretChanged, false);
});

test("[TEST-004] [INFRA-005] a rehearsal with no safe target is 'unavailable' (reason shown), health stays 200; a real rollback failure still degrades it", async () => {
  const t = await createTestApp();
  await t.db.prepare(`INSERT INTO ingestion_status (source, last_success_at, last_attempt_at, last_error) VALUES ('ci', ?, ?, NULL)`).bind(new Date().toISOString(), new Date().toISOString()).run();
  const health = async () => { const r = await t.client().get("/api/readiness/health"); return { code: r.status, body: await r.json() as { feeds: { source: string; status: string; reason?: string }[] } }; };
  const now = new Date().toISOString();
  await ingestEvidence(t.db, JSON.stringify(rehearsalEvidence({ commit: "c".repeat(40), runId: "gh-1-1-rollback", startedAt: now, rollback: true, rollforward: true })));
  assert.equal((await health()).code, 200);

  const skipped = rehearsalEvidence({ commit: "c".repeat(40), runId: "gh-2-1-rollback", startedAt: now, rollback: "skipped", rollforward: "skipped" });
  assert.ok(skipped.results.every((r) => r.outcome === "skipped" && r.message === NO_SAFE_TARGET), "recorded as skipped with the reason, never passed");
  assert.deepEqual(recoveryDrillOutcomes(parseEvidence(skipped)).map(([f, ok, , u]) => [f, ok, u]),
    [["recovery:rollback", false, true], ["recovery:rollback-step", false, true], ["recovery:rollforward-step", false, true]]);
  const before = (await t.db.prepare(`SELECT last_success_at FROM ingestion_status WHERE source = 'recovery:rollback:staging'`).first<{ last_success_at: string }>())!.last_success_at;
  await ingestEvidence(t.db, JSON.stringify(skipped));
  let h = await health();
  assert.equal(h.code, 200, "no safe target after a secret change is not an outage");
  for (const s of ["recovery:rollback:staging", "recovery:rollback-step:staging", "recovery:rollforward-step:staging"]) assert.equal(h.body.feeds.find((f) => f.source === s)?.status, "unavailable", s);
  const row = await t.db.prepare(`SELECT last_error, last_success_at FROM ingestion_status WHERE source = 'recovery:rollback:staging'`).first<{ last_error: string; last_success_at: string }>();
  assert.ok(row!.last_error.startsWith(UNAVAILABLE_PREFIX + "no safe rollback target"), "the reason is kept");
  assert.equal(row!.last_success_at, before, "no new success is recorded for a skipped rehearsal");

  // A genuine rollback failure is still a failure.
  await ingestEvidence(t.db, JSON.stringify(rehearsalEvidence({ commit: "c".repeat(40), runId: "gh-3-1-rollback", startedAt: now, rollback: false, rollforward: true, detail: "health_check_failed: /api/health HTTP 500 after 60 s" })));
  h = await health();
  assert.equal(h.code, 503);
  assert.equal(h.body.feeds.find((f) => f.source === "recovery:rollback-step:staging")?.status, "failing");
  // And a later successful rehearsal is healthy again.
  await ingestEvidence(t.db, JSON.stringify(rehearsalEvidence({ commit: "c".repeat(40), runId: "gh-4-1-rollback", startedAt: new Date().toISOString(), rollback: true, rollforward: true })));
  assert.equal((await health()).code, 200);
});

test("[TEST-004] rehearsal workflow: no rollback is attempted (or forced) across a secret change; evidence says skipped", () => {
  const wf = readFileSync(".github/workflows/staging-rollback-rehearsal.yml", "utf8");
  assert.match(wf, /read -r cur prev secrets <<< "\$\(node --no-warnings scripts\/rollback-rehearsal\.ts pick/);
  assert.match(wf, /id: back\n\s+if: steps\.pick\.outputs\.secrets != 'secret-changed'/);
  assert.match(wf, /id: fwd\n\s+if: always\(\) && steps\.pick\.outcome == 'success' && steps\.pick\.outputs\.secrets != 'secret-changed'/);
  assert.match(wf, /--rollback "\$\{\{ steps\.pick\.outputs\.secrets == 'secret-changed' && 'skipped'/);
  assert.doesNotMatch(wf, /force=true|--force/, "a rollback across a secret change is never forced (it would restore old secrets)");
});

test("[TEST-002] e2e harness never evaluates code in the page under the site's CSP (deploy #57 journey 1: waitForFunction → EvalError)", () => {
  for (const f of readdirSync("tests/e2e").filter((n) => n.endsWith(".ts"))) {
    assert.doesNotMatch(readFileSync(`tests/e2e/${f}`, "utf8").replace(/\/\/.*$/gm, ""), /\.waitForFunction\(/, `${f}: use locators (CSP-safe); waitForFunction is refused by the site's CSP`);
  }
});
