// CREST-GAP-030: a failing staging browser journey must fail Deploy staging (after evidence and cleanup still run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("[TEST-002] Deploy staging fails when the staging browser journeys fail, after evidence and cleanup steps", () => {
  const wf = readFileSync(".github/workflows/deploy-staging.yml", "utf8");
  const e2e = wf.indexOf("id: e2e");
  const gate = wf.indexOf("Fail the deploy when the staging browser journeys failed");
  const cleanup = wf.indexOf("Remove credentials and evidence from the runner");
  assert.ok(e2e > 0 && gate > 0 && cleanup > 0);
  assert.ok(gate > cleanup, "the gate is the last step, so evidence, records and cleanup always run first");
  const step = wf.slice(gate, gate + 400);
  assert.match(step, /if: always\(\) && steps\.e2e\.outcome == 'failure'/);
  assert.match(step, /exit 1/);
});

test("[TEST-002] a failing CRM staging E2E fails Deploy staging without skipping hosted frontend verification, evidence or cleanup (deploy #69)", () => {
  const wf = readFileSync(".github/workflows/deploy-staging.yml", "utf8");
  const crm = wf.indexOf("id: crm_e2e");
  const frontend = wf.indexOf("id: frontend_browser");
  const cleanup = wf.indexOf("Remove credentials and evidence from the runner");
  const gate = wf.indexOf("Fail the deploy when the CRM duplicate protection E2E failed");
  assert.ok(crm > 0 && frontend > crm && cleanup > 0 && gate > cleanup, "the CRM gate is after cleanup");
  // Without continue-on-error a CRM failure skips every later step that lacks always(), including frontend_browser.
  assert.match(wf.slice(crm, frontend), /\n {8}continue-on-error: true\n/);
  const step = wf.slice(gate, gate + 400);
  assert.match(step, /if: always\(\) && steps\.crm_e2e\.outcome == 'failure'/);
  assert.match(step, /exit 1/);
});
