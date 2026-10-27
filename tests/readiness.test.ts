import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./support/sqlite-d1.ts";
import { syncRequirements, ingestEvidence, signEvidence } from "../src/readiness/ingest.ts";
import { loadReadinessInput, buildReport, requirementsCsv } from "../src/readiness/report.ts";
import { approvalValidity, computeRequirementStatuses, ingestionHealth } from "../src/readiness/engine.ts";
import { REQUIREMENTS } from "../requirements/inventory.ts";
import { handle } from "../src/worker.ts";
const ENVS_NONE = (v: Record<string, string>) => Object.values(v).every((x) => x === "none");

const evidence = (runId: string, results: { requirementId: string; outcome: "passed" | "failed" }[], over: Record<string, unknown> = {}) => JSON.stringify({
  runId, source: "ci", environment: "development", commitSha: "abc1234", branch: "main",
  startedAt: "2026-10-26T10:00:00Z", finishedAt: (over.finishedAt as string) ?? "2026-10-26T10:05:00Z",
  results: results.map((r) => ({ ...r, testName: `t ${r.requirementId}` })), ...over,
});

async function seeded() {
  const db = createTestDb();
  await syncRequirements(db);
  return db;
}

test("[READY-001] traceability matrix is generated from stored requirement records", async () => {
  const db = await seeded();
  const report = await buildReport(await loadReadinessInput(db));
  assert.equal(report.requirements.length, REQUIREMENTS.length);
  assert.ok(report.requirements.every((r) => ENVS_NONE(r.verification)), "no verification without evidence");
  assert.equal(report.requirements.find((r) => r.id === "CRM-003")!.state, "test_pending");
  assert.equal(report.scores.denominator.total, REQUIREMENTS.length);
});

test("[READY-004] signed CI evidence is ingested idempotently and unknown ids are reported", async () => {
  const db = await seeded();
  const body = evidence("gh-1-1", [{ requirementId: "CRM-001", outcome: "passed" }, { requirementId: "ZZZ-999", outcome: "passed" }]);
  const env = { DB: db, ENVIRONMENT: "development" as const, EVIDENCE_INGEST_SECRET: "s3cret" };
  const post = async (sig: string) => handle(new Request("https://x/api/readiness/evidence", { method: "POST", body, headers: { "x-crestmont-signature": sig } }), env);
  assert.equal((await post("t=1,v1=" + "0".repeat(64))).status, 401);
  const ok = await post(await signEvidence("s3cret", body));
  assert.equal(ok.status, 200);
  const r = await ok.json() as { status: string; accepted: number; unknownRequirements: string[] };
  assert.deepEqual([r.status, r.accepted, r.unknownRequirements], ["ingested", 1, ["ZZZ-999"]]);
  const again = await (await post(await signEvidence("s3cret", body))).json() as { status: string };
  assert.equal(again.status, "duplicate");
  assert.equal((db.raw.prepare(`SELECT COUNT(*) n FROM test_evidence`).get() as { n: number }).n, 1);
});

test("[READY-002] implementation and verification are tracked separately and latest failure wins", async () => {
  const db = await seeded();
  // Pin the records this test reasons about so it does not depend on other areas' live status files.
  db.raw.exec(`UPDATE requirements SET implementation_status='implemented' WHERE id IN ('DATA-001','SALES-001');
               UPDATE requirements SET implementation_status='in_progress' WHERE id='CRM-001'`);
  await ingestEvidence(db, evidence("r1", [{ requirementId: "DATA-001", outcome: "passed" }, { requirementId: "CRM-001", outcome: "passed" }]));
  let report = await buildReport(await loadReadinessInput(db));
  const get = (id: string) => report.requirements.find((r) => r.id === id)!;
  assert.equal(get("DATA-001").state, "verified_in_development");
  assert.equal(get("DATA-001").verification.staging, "none");
  assert.equal(get("SALES-001").state, "test_pending");
  // Passing tests on a partially built requirement do not promote it to implemented.
  assert.equal(get("CRM-001").implementation, "in_progress");
  assert.equal(get("CRM-001").state, "in_progress");
  assert.equal(get("CRM-001").verification.development, "passed");
  await ingestEvidence(db, evidence("r2", [{ requirementId: "DATA-001", outcome: "failed" }], { finishedAt: "2026-10-26T11:00:00Z" }));
  report = await buildReport(await loadReadinessInput(db));
  assert.equal(get("DATA-001").state, "test_failed");
});

test("[READY-003] blocked requirements stay in the denominator and dimensions are separate", async () => {
  const db = await seeded();
  db.raw.exec(`INSERT INTO blockers (id,category,description,severity,subsystem,owner,required_action,status,created_at)
               VALUES ('BLK-1','external_account','No Stripe account','high','Payments','Founder','Create account','open','x');
               INSERT INTO blocker_requirements VALUES ('BLK-1','PAY-001');`);
  const report = await buildReport(await loadReadinessInput(db));
  assert.equal(report.requirements.find((r) => r.id === "PAY-001")!.state, "blocked");
  assert.equal(report.scores.counts.blocked.count, 1);
  assert.equal(report.scores.counts.blocked.total, REQUIREMENTS.length);
  assert.equal("overall" in report.scores, false);
  assert.ok(Object.keys(report.scores.dimensions).length >= 7);
});

test("[READY-007] gates fail or are not evaluable without evidence; nothing reports launch-ready", async () => {
  const db = await seeded();
  const report = await buildReport(await loadReadinessInput(db));
  assert.deepEqual(report.gates.map((g) => g.id), ["A", "B", "C", "D", "E", "F", "G", "H"]);
  assert.ok(report.gates.every((g) => g.status !== "pass"));
  assert.equal(report.decision.launched, false);
  assert.match(report.decision.summary, /Not production-ready/);
});

test("[READY-012] stale or failing evidence feeds are surfaced, not trusted", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  assert.equal(ingestionHealth([], now)[0].status, "unavailable");
  assert.equal(ingestionHealth([{ source: "ci", last_success_at: "2026-10-01T00:00:00Z", last_attempt_at: "2026-10-01T00:00:00Z", last_error: null }], now)[0].status, "stale");
  assert.equal(ingestionHealth([{ source: "ci", last_success_at: "2026-10-26T10:00:00Z", last_attempt_at: "2026-10-26T11:00:00Z", last_error: "boom" }], now)[0].status, "failing");
  const statuses = computeRequirementStatuses({
    requirements: [{ id: "X-001", subsystem: "s", section: "", title: "t", priority: "P0", category: "engineering", implementation_status: "implemented", disposition: "in_scope", blocked_reason: null, requires_founder_approval: 0 }],
    evidence: [{ requirement_id: "X-001", outcome: "passed", test_name: "t", run_id: "r", environment: "development", source: "ci", commit_sha: "a", finished_at: "2026-10-01T00:00:00Z" }],
    blockers: [], findings: [], ingestion: [], approvals: [], integrations: [], releaseCandidate: null, productionDeployment: null, now,
  });
  assert.equal(statuses[0].stale, true);
});

test("[READY-008] Founder approval binds to commit, config and evidence set and is invalidated by change", () => {
  const rc = { commit_sha: "aaa", config_sha256: "cfg1" };
  const base = { id: "a1", kind: "production_launch", decision: "approved" as const, commit_sha: "aaa", config_sha256: "cfg1", evidence_set_sha256: "ev1", invalidated_at: null, created_at: "x", approver_is_owner: true };
  assert.equal(approvalValidity(base, rc, "ev1").valid, true);
  assert.match(approvalValidity(base, { ...rc, commit_sha: "bbb" }, "ev1").reason, /commit changed/);
  assert.match(approvalValidity(base, { ...rc, config_sha256: "cfg2" }, "ev1").reason, /configuration changed/);
  assert.match(approvalValidity(base, rc, "ev2").reason, /Evidence set changed/);
  assert.match(approvalValidity({ ...base, approver_is_owner: false }, rc, "ev1").reason, /Owner/);
  assert.equal(approvalValidity(undefined, rc, "ev1").valid, false);
});

test("[READY-011] CSV export is derived from the report and guards formula injection", async () => {
  const db = await seeded();
  db.raw.exec(`UPDATE requirements SET title='=HYPERLINK("http://evil")' WHERE id='CRM-001'`);
  const report = await buildReport(await loadReadinessInput(db));
  const csv = requirementsCsv(report);
  assert.equal(csv.trim().split("\n").length, REQUIREMENTS.length + 1);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`));
});
