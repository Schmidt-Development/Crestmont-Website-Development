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
