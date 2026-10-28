import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { declaredCrons, sameSchedules, registeredCrons } from "../scripts/verify-crons.ts";
import { SCHEDULE } from "../src/app/scheduled.ts";

test("[INFRA-006] [READY-012] staging deploy verifies and repairs cron trigger registration against wrangler.toml; production is never touched", () => {
  const toml = readFileSync("wrangler.toml", "utf8");
  const staging = declaredCrons(toml, "staging");
  assert.deepEqual(staging, Object.keys(SCHEDULE).sort(), "wrangler.toml staging crons match the job schedule");
  assert.deepEqual(declaredCrons(toml, "production"), staging);
  assert.deepEqual(registeredCrons({ result: { schedules: [{ cron: "17 11 * * *" }, { cron: "*/15 * * * *" }] } }).sort(), staging);
  assert.deepEqual(registeredCrons({ result: { schedules: [] } }), []);
  assert.deepEqual(registeredCrons(null), []);
  assert.equal(sameSchedules(["17 11 * * *", "*/15 * * * *"], staging), true);
  assert.equal(sameSchedules([], staging), false);
  assert.equal(sameSchedules(["*/15 * * * *"], staging), false);
  const wf = readFileSync(".github/workflows/deploy-staging.yml", "utf8");
  assert.match(wf, /scripts\/verify-crons\.ts --env staging/);
  assert.doesNotMatch(readFileSync(".github/workflows/deploy-production.yml", "utf8"), /verify-crons/);
  assert.match(readFileSync("scripts/verify-crons.ts", "utf8"), /if \(env !== "staging"\) throw/);
});

test("[INFRA-006] cron registration and rollback steps publish their own health signals (so failures are visible without Actions access)", async () => {
  const { cronEvidence } = await import("../scripts/verify-crons.ts");
  const { rehearsalEvidence } = await import("../scripts/rollback-rehearsal.ts");
  const { recoveryDrillOutcomes, parseEvidence } = await import("../src/readiness/ingest.ts");
  const now = new Date().toISOString();
  assert.deepEqual(recoveryDrillOutcomes(parseEvidence(cronEvidence({ env: "staging", commit: "a".repeat(40), runId: "r1", startedAt: now, ok: false, detail: "GET schedules: HTTP 403" }))), [["cron-triggers", false, "GET schedules: HTTP 403"]]);
  assert.deepEqual(recoveryDrillOutcomes(parseEvidence(rehearsalEvidence({ commit: "a".repeat(40), runId: "r2", startedAt: now, rollback: false, rollforward: true }))),
    [["recovery:rollback", false], ["recovery:rollback-step", false, "rollback step failed"], ["recovery:rollforward-step", true, undefined]]);
  const wf = readFileSync(".github/workflows/deploy-staging.yml", "utf8");
  assert.ok(wf.indexOf("Evidence ingest secret") < wf.indexOf("Verify cron triggers"), "cron evidence is posted after the ingest secret exists");
  assert.match(wf, /post-evidence\.ts evidence\/cron-triggers\.json/);
});

test("[INFRA-006] failing infrastructure feeds expose a short sanitized public reason; nothing else does", async () => {
  const { publicReason } = await import("../src/routes/readiness.ts");
  assert.deepEqual(publicReason({ source: "cron-triggers:staging", status: "failing", detail: "Last attempt failed: GET schedules: HTTP 403 token abcdefghijklmnopqrstuvwxyz0123456789ABCD" }), { reason: "GET schedules: HTTP 403 token [redacted]" });
  assert.deepEqual(publicReason({ source: "recovery:rollback-step:staging", status: "healthy", detail: "x" }), {});
  assert.deepEqual(publicReason({ source: "ci", status: "failing", detail: "Last attempt failed: something" }), {}, "other feeds keep details staff-only");
});

test("[INFRA-006] the Workers Free cron limit is recorded as skipped (external scheduler in use), other registration errors fail", async () => {
  const { cronEvidence, isCronLimit } = await import("../scripts/verify-crons.ts");
  const { recoveryDrillOutcomes, parseEvidence } = await import("../src/readiness/ingest.ts");
  const msg = 'PUT schedules: HTTP 400 {"errors":[{"code":10072,"message":"This account has reached the Workers Free limit of 5 cron triggers per account."}]}';
  assert.equal(isCronLimit(msg), true);
  const ev = cronEvidence({ env: "staging", commit: "a".repeat(40), runId: "r", startedAt: new Date().toISOString(), ok: false, detail: msg });
  assert.equal(ev.results[0].outcome, "skipped");
  assert.equal(recoveryDrillOutcomes(parseEvidence(ev))[0][1], true);
  assert.equal(cronEvidence({ env: "staging", commit: "a".repeat(40), runId: "r", startedAt: new Date().toISOString(), ok: false, detail: "GET schedules: HTTP 403" }).results[0].outcome, "failed");
});
