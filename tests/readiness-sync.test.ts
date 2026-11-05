// READY-013: proof, against a real database, that Launch Readiness updates itself.
//
// Every test below drives the platform the way CI and the staging deploy drive it — post evidence, record a
// deployment, resolve a blocker — and then asserts what the Owner would see. Nothing here edits
// requirements/status/*.ts and nothing sets a status by hand; that is the point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./support/sqlite-d1.ts";
import { syncRequirements, ingestEvidence } from "../src/readiness/ingest.ts";
import { loadReadinessInput, buildReport } from "../src/readiness/report.ts";
import { syncDerivedStates, recentSyncs, recentTransitions, regressions } from "../src/readiness/sync.ts";
import { recordDeployment } from "../src/services/deployments.ts";
import { resolveBlocker, applySeedBlockerLinks } from "../src/services/readiness-admin.ts";
import { REQUIREMENTS } from "../requirements/inventory.ts";
import { ACCEPTANCE } from "../requirements/acceptance.ts";

const C1 = "1111111111111111111111111111111111111111";
const C2 = "2222222222222222222222222222222222222222";

/** A requirement proven by CI alone, and one that demands a live staging run. */
const CI_ONLY = REQUIREMENTS.filter((r) => ACCEPTANCE[r.id].completeAt === "IMPLEMENTED" && !ACCEPTANCE[r.id].external && ACCEPTANCE[r.id].tracking === "platform")[0].id;
const NEEDS_STAGING = "PAY-001";

const ciDoc = (runId: string, commit: string, results: { requirementId: string; outcome: "passed" | "failed" | "skipped" }[], at = "2026-11-02T10:00:00Z") =>
  JSON.stringify({ runId, source: "ci", environment: "development", commitSha: commit, branch: "main",
    startedAt: at, finishedAt: at, results: results.map((r) => ({ ...r, testName: `t ${r.requirementId}` })) });

const stagingDoc = (runId: string, commit: string, results: { requirementId: string; outcome: "passed" | "failed" | "skipped" }[], at = "2026-11-02T11:00:00Z") =>
  JSON.stringify({ runId, source: "staging_e2e", environment: "staging", commitSha: commit, branch: "main",
    startedAt: at, finishedAt: at, results: results.map((r) => ({ ...r, testName: `journey ${r.requirementId}` })) });

const deployDoc = (id: string, commit: string, environment = "staging", status = "succeeded", deployedAt = "2026-11-02T10:30:00Z") =>
  JSON.stringify({ deploymentId: id, environment, commitSha: commit, status, initiatedBy: "github-actions:test", deployedAt });

async function platform() {
  const db = createTestDb();
  await syncRequirements(db);
  await applySeedBlockerLinks(db);
  // A real Owner row, so resolving a blocker goes through the production path (it records who resolved it).
  db.raw.prepare(`INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,?,?)`)
    .run("user_owner", "owner@crestmont.test", "Owner", "2026-11-02T09:00:00Z");
  return db;
}
const ctx = (db: Awaited<ReturnType<typeof platform>>) => ({ db, now: () => new Date("2026-11-02T12:00:00Z") });

async function stateOf(db: Awaited<ReturnType<typeof platform>>, id: string) {
  const report = await buildReport(await loadReadinessInput(db, new Date("2026-11-02T12:00:00Z")));
  return report.requirements.find((r) => r.id === id)!;
}

// ───────────── Scenario A: a mapped change receives evidence and the status moves by itself ─────────────

test("[READY-013] Scenario A: passing CI evidence advances a requirement with no manual status edit", async () => {
  const db = await platform();
  assert.equal((await stateOf(db, CI_ONLY)).autoState, "NOT_IMPLEMENTED");
  await ingestEvidence(db, ciDoc("gh-1", C1, [{ requirementId: CI_ONLY, outcome: "passed" }]));
  const after = await stateOf(db, CI_ONLY);
  assert.equal(after.autoState, "MERGED");
  assert.equal(after.autoComplete, true);
  assert.equal(after.implementation, "implemented");
  assert.equal(after.provenCommit, C1);
});

// ───────────── Scenario B: a new requirement appears on its own ─────────────

test("[READY-013] Scenario B: a requirement registered in the inventory appears at the next ingest", async () => {
  const db = await platform();
  // A deploy that predates the new requirement: D1 does not know READY-013 yet.
  db.raw.prepare(`DELETE FROM requirements WHERE id = 'READY-013'`).run();
  assert.equal((db.raw.prepare(`SELECT COUNT(*) n FROM requirements WHERE id='READY-013'`).get() as { n: number }).n, 0);

  await ingestEvidence(db, ciDoc("gh-new", C1, [{ requirementId: "READY-013", outcome: "passed" }]));

  const row = await stateOf(db, "READY-013");
  assert.equal(row.autoState, "MERGED", "the new requirement is registered and derived in the same ingest");
  assert.equal(row.title, REQUIREMENTS.find((r) => r.id === "READY-013")!.title);
  const persisted = db.raw.prepare(`SELECT state FROM requirement_state WHERE requirement_id='READY-013'`).get() as { state: string };
  assert.equal(persisted.state, "MERGED");
});

// ───────────── Scenario C: deployment then staging evidence ─────────────

test("[READY-013] Scenario C: a deployment plus staging evidence advances a requirement to STAGING_VERIFIED", async () => {
  const db = await platform();
  await ingestEvidence(db, ciDoc("gh-2", C1, [{ requirementId: NEEDS_STAGING, outcome: "passed" }]));
  // BLK-004 is resolved by migration 0070, so nothing gates PAY-001 but the live run itself.
  assert.equal((await stateOf(db, NEEDS_STAGING)).autoState, "MERGED");

  await recordDeployment(ctx(db), deployDoc("dep-1", C1));
  assert.equal((await stateOf(db, NEEDS_STAGING)).autoState, "DEPLOYED_STAGING", "deployed, but nothing is certified yet");

  await ingestEvidence(db, stagingDoc("gh-2-e2e", C1, [{ requirementId: NEEDS_STAGING, outcome: "passed" }]));
  const done = await stateOf(db, NEEDS_STAGING);
  assert.equal(done.autoState, "STAGING_VERIFIED");
  assert.equal(done.autoComplete, true, "PAY-001's acceptance is a live Stripe run, and it now has one");
});

// ───────────── Scenario D: regression ─────────────

test("[READY-013] Scenario D: a failing test downgrades a verified requirement and records the regression", async () => {
  const db = await platform();
  await ingestEvidence(db, ciDoc("gh-3", C1, [{ requirementId: CI_ONLY, outcome: "passed" }]));
  assert.equal((await stateOf(db, CI_ONLY)).autoState, "MERGED");

  // The next commit breaks it.
  await ingestEvidence(db, ciDoc("gh-4", C2, [{ requirementId: CI_ONLY, outcome: "failed" }], "2026-11-02T11:30:00Z"));
  const after = await stateOf(db, CI_ONLY);
  assert.equal(after.autoState, "REGRESSED");
  assert.equal(after.autoComplete, false);
  assert.equal(after.implementation, "in_progress");

  const hist = await recentTransitions(db, { requirementId: CI_ONLY });
  assert.deepEqual(hist.map((h) => h.to_state).slice(0, 2), ["REGRESSED", "MERGED"], "both transitions are on record");
  assert.ok((await regressions(db)).some((r) => r.requirement_id === CI_ONLY));
});

// ───────────── Scenario E: a merge proves nothing on its own ─────────────

test("[READY-013] Scenario E: merging without evidence never advances a requirement", async () => {
  const db = await platform();
  // A deployment of a commit for which this requirement has no passing test.
  await ingestEvidence(db, ciDoc("gh-5", C1, [{ requirementId: CI_ONLY, outcome: "passed" }]));
  await recordDeployment(ctx(db), deployDoc("dep-2", C1));
  const other = await stateOf(db, NEEDS_STAGING);
  assert.equal(other.autoState, "NOT_IMPLEMENTED", "a deployment carrying the commit proves nothing about an untested requirement");
  assert.equal(other.autoComplete, false);
});

// ───────────── Scenario F: stale evidence ─────────────

test("[READY-013] Scenario F: evidence from an older commit cannot certify the new head", async () => {
  const db = await platform();
  await ingestEvidence(db, ciDoc("gh-6", C1, [{ requirementId: CI_ONLY, outcome: "passed" }]));
  assert.equal((await stateOf(db, CI_ONLY)).autoState, "MERGED");

  // A later commit whose CI run did not cover this requirement at all.
  await ingestEvidence(db, ciDoc("gh-7", C2, [{ requirementId: "DATA-001", outcome: "passed" }], "2026-11-02T11:45:00Z"));
  const after = await stateOf(db, CI_ONLY);
  assert.equal(after.autoState, "EVIDENCE_STALE");
  assert.equal(after.autoComplete, false, "a verdict earned at an older commit does not carry forward");
  assert.match(after.autoDetail, /no CI evidence for this requirement at the current head/);
});

test("[READY-013] staging evidence from an older commit does not certify a newly deployed one", async () => {
  const db = await platform();
  await ingestEvidence(db, ciDoc("gh-8", C1, [{ requirementId: NEEDS_STAGING, outcome: "passed" }]));
  await recordDeployment(ctx(db), deployDoc("dep-3", C1));
  await ingestEvidence(db, stagingDoc("gh-8-e2e", C1, [{ requirementId: NEEDS_STAGING, outcome: "passed" }]));
  assert.equal((await stateOf(db, NEEDS_STAGING)).autoState, "STAGING_VERIFIED");

  // New commit, new CI pass, new deployment — but no new staging run yet.
  await ingestEvidence(db, ciDoc("gh-9", C2, [{ requirementId: NEEDS_STAGING, outcome: "passed" }], "2026-11-02T11:50:00Z"));
  await recordDeployment(ctx(db), deployDoc("dep-4", C2, "staging", "succeeded", "2026-11-02T11:55:00Z"));
  const after = await stateOf(db, NEEDS_STAGING);
  assert.equal(after.autoState, "DEPLOYED_STAGING");
  assert.equal(after.autoComplete, false, "the old staging pass must not certify the new deployment");
});

// ───────────── Scenario G: no manual status maintenance ─────────────

test("[READY-013] Scenario G: every transition above happens with requirements/status untouched", async () => {
  const db = await platform();
  const declared = db.raw.prepare(`SELECT implementation_status s FROM requirements WHERE id = ?`).get(CI_ONLY) as { s: string };
  await ingestEvidence(db, ciDoc("gh-10", C1, [{ requirementId: CI_ONLY, outcome: "passed" }]));
  await recordDeployment(ctx(db), deployDoc("dep-5", C1));
  const after = await stateOf(db, CI_ONLY);
  const stillDeclared = db.raw.prepare(`SELECT implementation_status s FROM requirements WHERE id = ?`).get(CI_ONLY) as { s: string };
  assert.equal(stillDeclared.s, declared.s, "the legacy declaration column was never written");
  assert.equal(after.autoState, "DEPLOYED_STAGING", "and the state advanced anyway");
  assert.equal(after.implementation, "implemented", "the implementation status the Owner sees is derived");
});

// ───────────── blockers release automatically ─────────────

test("[READY-013] resolving a blocker releases its requirements without any status edit", async () => {
  const db = await platform();
  // PORT-001 waits on BLK-007 (genuine screenshots of the live sites), which is still open.
  await ingestEvidence(db, ciDoc("gh-11", C1, [{ requirementId: "PORT-001", outcome: "passed" }]));
  assert.equal((await stateOf(db, "PORT-001")).autoState, "BLOCKED", "PORT-001 waits on the captures");

  await resolveBlocker(db, "user_owner", "BLK-007", "Genuine captures of the live sites reviewed and accepted by the Founder (TEST DATA).");
  const after = await stateOf(db, "PORT-001");
  assert.equal(after.autoState, "MERGED");
  assert.equal(after.autoComplete, true);
});

test("[READY-013] a requirement no test can prove is established by its external fact, not by a declaration", async () => {
  const db = await platform();
  // INFRA-003 (a dedicated repository exists) is attested by BLK-002, which migration 0002 records as resolved.
  const row = await stateOf(db, "INFRA-003");
  assert.equal(row.autoState, "IMPLEMENTED");
  assert.equal(row.autoComplete, true);
  assert.match(row.autoDetail, /Established by BLK-002, which is resolved/);
});

// ───────────── synchronisation is idempotent, retryable and auditable ─────────────

test("[READY-013] synchronisation is idempotent: a second run with no new facts changes nothing", async () => {
  const db = await platform();
  await ingestEvidence(db, ciDoc("gh-12", C1, [{ requirementId: CI_ONLY, outcome: "passed" }]));
  const a = await syncDerivedStates(db, "manual");
  const b = await syncDerivedStates(db, "manual");
  assert.equal(b.changed, 0, "nothing moved the second time");
  assert.equal(a.requirements, b.requirements);
  const hist = db.raw.prepare(`SELECT COUNT(*) n FROM requirement_state_history`).get() as { n: number };
  const c = await syncDerivedStates(db, "manual");
  assert.equal(c.changed, 0);
  assert.equal((db.raw.prepare(`SELECT COUNT(*) n FROM requirement_state_history`).get() as { n: number }).n, hist.n, "no history is written when nothing changes");
});

test("[READY-013] every synchronisation is recorded, so the Owner can see when readiness was last recalculated", async () => {
  const db = await platform();
  await ingestEvidence(db, ciDoc("gh-13", C1, [{ requirementId: CI_ONLY, outcome: "passed" }]));
  await recordDeployment(ctx(db), deployDoc("dep-6", C1));
  const syncs = await recentSyncs(db, 10);
  assert.ok(syncs.length >= 2);
  assert.ok(syncs.some((s) => s.trigger === "evidence:ci"), "the ingest recorded its own sync");
  assert.ok(syncs.some((s) => s.trigger === "deployment:staging"), "so did the deployment");
  assert.ok(syncs.every((s) => s.error === null && s.requirements > 0));
});

test("[READY-013] a failed synchronisation is recorded rather than leaving the dashboard silently stale", async () => {
  const db = await platform();
  const broken = { ...db, prepare: (sql: string) => (/FROM requirements/.test(sql) ? { all: async () => { throw new Error("D1 unavailable"); }, bind: () => ({ all: async () => { throw new Error("D1 unavailable"); } }) } : db.prepare(sql)) } as unknown as typeof db;
  await assert.rejects(syncDerivedStates(broken, "manual"), /D1 unavailable/);
  const syncs = await recentSyncs(db, 5);
  assert.equal(syncs[0].error, "D1 unavailable");
  assert.equal(syncs[0].changed, 0);
});

// ───────────── robustness against real-world event disorder ─────────────

test("[READY-013] duplicate evidence delivery is idempotent and does not re-write history", async () => {
  const db = await platform();
  const doc = ciDoc("gh-14", C1, [{ requirementId: CI_ONLY, outcome: "passed" }]);
  await ingestEvidence(db, doc);
  const before = (db.raw.prepare(`SELECT COUNT(*) n FROM requirement_state_history`).get() as { n: number }).n;
  const again = await ingestEvidence(db, doc);
  assert.equal(again.status, "duplicate");
  assert.equal((db.raw.prepare(`SELECT COUNT(*) n FROM requirement_state_history`).get() as { n: number }).n, before);
});

test("[READY-013] out-of-order arrival: late evidence for an older commit does not revive it", async () => {
  const db = await platform();
  await ingestEvidence(db, ciDoc("gh-15", C2, [{ requirementId: CI_ONLY, outcome: "failed" }], "2026-11-02T11:00:00Z"));
  // A delayed run from the previous commit arrives afterwards.
  await ingestEvidence(db, ciDoc("gh-16", C1, [{ requirementId: CI_ONLY, outcome: "passed" }], "2026-11-02T10:00:00Z"));
  const after = await stateOf(db, CI_ONLY);
  assert.equal(after.autoState, "REGRESSED", "the head commit still fails; a late pass from an older commit cannot clear it");
});

test("[READY-013] concurrent merges: readiness follows the newest default-branch CI run", async () => {
  const db = await platform();
  await ingestEvidence(db, ciDoc("gh-17", C1, [{ requirementId: CI_ONLY, outcome: "passed" }], "2026-11-02T10:00:00Z"));
  await ingestEvidence(db, ciDoc("gh-18", C2, [{ requirementId: CI_ONLY, outcome: "passed" }], "2026-11-02T10:05:00Z"));
  const after = await stateOf(db, CI_ONLY);
  assert.equal(after.provenCommit, C2);
  assert.equal(after.autoState, "MERGED");
});

test("[READY-013] a failed staging deployment never advances anything", async () => {
  const db = await platform();
  await ingestEvidence(db, ciDoc("gh-19", C1, [{ requirementId: NEEDS_STAGING, outcome: "passed" }]));
  await recordDeployment(ctx(db), deployDoc("dep-7", C1, "staging", "failed"));
  assert.equal((await stateOf(db, NEEDS_STAGING)).autoState, "MERGED", "a failed deploy is not a deployment");
});

test("[READY-013] a skipped staging journey leaves the requirement deployed but uncertified", async () => {
  const db = await platform();
  await ingestEvidence(db, ciDoc("gh-20", C1, [{ requirementId: NEEDS_STAGING, outcome: "passed" }]));
  await recordDeployment(ctx(db), deployDoc("dep-8", C1));
  await ingestEvidence(db, stagingDoc("gh-20-e2e", C1, [{ requirementId: NEEDS_STAGING, outcome: "skipped" }]));
  const after = await stateOf(db, NEEDS_STAGING);
  assert.equal(after.autoState, "DEPLOYED_STAGING");
  assert.equal(after.autoComplete, false, "a skip is never a pass");
});

// ───────────── the Owner Dashboard shows it ─────────────

test("[READY-013] the dashboard shows when readiness was last recalculated, against which commit, and why", async () => {
  const { createTestApp, createStaff } = await import("./support/app.ts");
  const app = await createTestApp();
  const staff = await createStaff(app.db, "owner", "owner@crestmont.test", "Olivia Owner");
  const owner = await app.client().login(staff.email, undefined, staff.secret);
  await ingestEvidence(app.db, ciDoc("gh-ui-1", C1, [{ requirementId: CI_ONLY, outcome: "passed" }]));
  await recordDeployment({ db: app.db, now: () => new Date("2026-11-02T12:00:00Z") }, deployDoc("dep-ui", C1));

  const main = await (await owner.get("/staff/readiness")).text();
  assert.match(main, /data-panel="derivation"/, "the automatic status panel is rendered");
  assert.match(main, /Last recalculated/);
  assert.match(main, /Judged against commit/);
  assert.match(main, /Latest deployment/);
  assert.match(main, /evidence:ci|deployment:staging/, "the trigger of the last sync is shown");

  const detail = await (await owner.get(`/staff/readiness/requirements/${CI_ONLY}`)).text();
  assert.match(detail, /data-panel="derivation-detail"/);
  assert.match(detail, /Why this status/);
  assert.match(detail, /Acceptance criteria/);
  assert.match(detail, /DEPLOYED[ _]STAGING/, "the derived state is shown on the requirement");

  const csv = await (await owner.get("/staff/readiness/export.csv")).text();
  assert.match(csv.split("\n")[0], /derived_state,complete,complete_at,tracking,proven_commit,head_commit,why/);
});
