import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currentVersionIds, versionsNewestFirst, pickRollback, rehearsalEvidence } from "../scripts/rollback-rehearsal.ts";
import { parseEvidence } from "../src/readiness/ingest.ts";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";

test("[TEST-004] [INFRA-005] staging rollback rehearsal: picks the serving and previous versions defensively and records signed staging evidence", () => {
  // Shapes vary by Wrangler version; both nested and flat forms are accepted.
  const status = JSON.stringify([{ id: "dep-1", versions: [{ version_id: C, percentage: 100 }] }]);
  const list = "⛅️ wrangler\n" + JSON.stringify([{ id: A, metadata: { created_on: "2026-10-26T10:00:00Z" } }, { id: C, metadata: { created_on: "2026-10-27T10:00:00Z" } }, { id: B, created_on: "2026-10-27T09:00:00Z" }]);
  assert.deepEqual(currentVersionIds(status), [C]);
  assert.deepEqual(versionsNewestFirst(list).map((v) => v.id), [C, B, A]);
  assert.deepEqual(pickRollback(status, list), { current: C, previous: B, previousIsOlderCode: false });
  // With trigger annotations: skip secret-only versions and the serving code's own upload.
  const D = "44444444-4444-4444-8444-444444444444", E = "55555555-5555-4555-8555-555555555555";
  const ann = (id: string, at: string, t: string) => ({ id, metadata: { created_on: at }, annotations: { "workers/triggered_by": t } });
  const list2 = JSON.stringify([ann(E, "2026-10-27T10:03:00Z", "secret"), ann(D, "2026-10-27T10:02:00Z", "secret"), ann(C, "2026-10-27T10:00:00Z", "upload"), ann(B, "2026-10-26T09:01:00Z", "secret"), ann(A, "2026-10-26T09:00:00Z", "upload")]);
  assert.deepEqual(pickRollback(JSON.stringify({ versions: [{ version_id: E, percentage: 100 }] }), list2), { current: E, previous: A, previousIsOlderCode: true });
  assert.throws(() => pickRollback(JSON.stringify([{ versions: [{ version_id: B, percentage: 50 }, { version_id: C, percentage: 50 }] }]), list), /exactly one version/);
  assert.throws(() => pickRollback(status, JSON.stringify([{ id: C, created_on: "2026-10-27T10:00:00Z" }])), /no earlier/);
  const ev = parseEvidence(rehearsalEvidence({ commit: "b".repeat(40), runId: "gh-9-1-rollback", startedAt: new Date().toISOString(), rollback: true, rollforward: false }));
  assert.deepEqual(ev.results.map((r) => [r.requirementId, r.outcome]), [["TEST-004", "failed"], ["INFRA-005", "failed"]]);
  const wf = readFileSync(".github/workflows/staging-rollback-rehearsal.yml", "utf8");
  assert.match(wf, /workflow_dispatch:/);
  assert.doesNotMatch(wf, /schedule:|--env production|crestmont-platform-production/);
  assert.match(wf, /workflow_run:[\s\S]*Deploy staging[\s\S]*workflow_run\.conclusion == 'success'/, "rehearsed after every successful staging deploy");
  assert.match(wf, /Roll forward[\s\S]*if: always\(\)/, "the serving version is always restored");
});
