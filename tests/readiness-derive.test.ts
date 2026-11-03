// READY-013: readiness status is derived from evidence, never asserted. These tests fix the rules that keep
// the dashboard honest — a merge is not a deployment, a deployment is not a certification, and evidence
// certifies only the commit it ran at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRequirementStates, implementationFrom, integrationHead, type DeriveInput, type DeriveEvidenceRow, type DeriveDeploymentRow } from "../src/readiness/derive.ts";
import type { Acceptance } from "../requirements/acceptance.ts";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T0 = "2026-11-02T10:00:00.000Z";
const T1 = "2026-11-02T12:00:00.000Z";
const NOW = new Date("2026-11-02T12:30:00.000Z");

const req = (id: string, category = "engineering") => ({ id, category, subsystem: "Test", disposition: "in_scope" });

function ev(p: Partial<DeriveEvidenceRow> & { requirement_id: string; outcome: DeriveEvidenceRow["outcome"] }): DeriveEvidenceRow {
  return {
    test_name: "t", run_id: "run-1", environment: "development", source: "ci",
    commit_sha: HEAD, branch: "main", finished_at: T1, ...p,
  };
}
const deploy = (p: Partial<DeriveDeploymentRow> = {}): DeriveDeploymentRow =>
  ({ id: "dep-1", environment: "staging", commit_sha: HEAD, status: "succeeded", deployed_at: T1, ...p });

const ACC = (over: Partial<Acceptance> = {}): Acceptance =>
  ({ criteria: "c", completeAt: "IMPLEMENTED", tracking: "platform", ...over });

function run(over: Partial<DeriveInput> & { evidence: DeriveEvidenceRow[] }, acceptance: Record<string, Acceptance> = { "REQ-001": ACC() }) {
  const input: DeriveInput = {
    requirements: [req("REQ-001")], deployments: [], openBlockerRequirementIds: new Map(),
    now: NOW, acceptance, ...over,
  };
  return deriveRequirementStates(input)[0];
}

// ───────────── the progress ladder ─────────────

test("[READY-013] a passing CI run on the default branch reaches MERGED, never further on its own", () => {
  const d = run({ evidence: [ev({ requirement_id: "REQ-001", outcome: "passed" })] });
  assert.equal(d.state, "MERGED");
  assert.equal(d.progress, "MERGED");
  assert.equal(d.provenCommit, HEAD);
  assert.equal(implementationFrom(d), "implemented");
});

test("[READY-013] a passing CI run off the default branch is IMPLEMENTED but not MERGED", () => {
  const d = run({ evidence: [ev({ requirement_id: "REQ-001", outcome: "passed", branch: "feature/x" })] });
  assert.equal(d.state, "IMPLEMENTED");
});

test("[READY-013] Scenario E: a merge alone never advances a requirement to deployed or verified", () => {
  // Tests pass at HEAD and HEAD is on main, but nothing has been deployed.
  const d = run({ evidence: [ev({ requirement_id: "REQ-001", outcome: "passed" })], deployments: [] });
  assert.equal(d.state, "MERGED");
  assert.notEqual(d.state, "DEPLOYED_STAGING");
  assert.notEqual(d.state, "STAGING_VERIFIED");
});

test("[READY-013] a deployment at the proven commit reaches DEPLOYED_STAGING but not STAGING_VERIFIED", () => {
  const d = run({ evidence: [ev({ requirement_id: "REQ-001", outcome: "passed" })], deployments: [deploy()] });
  assert.equal(d.state, "DEPLOYED_STAGING");
  assert.match(d.detail, /deployed but not certified/i);
});

test("[READY-013] Scenario C: staging evidence at the deployed commit advances to STAGING_VERIFIED", () => {
  const d = run({
    evidence: [
      ev({ requirement_id: "REQ-001", outcome: "passed" }),
      ev({ requirement_id: "REQ-001", outcome: "passed", source: "staging_e2e", environment: "staging", run_id: "run-2" }),
    ],
    deployments: [deploy()],
  });
  assert.equal(d.state, "STAGING_VERIFIED");
  assert.deepEqual(d.evidenceRunIds.sort(), ["run-1", "run-2"]);
});

test("[READY-013] a deployment at a different commit than the tests passed at does not count", () => {
  const d = run({ evidence: [ev({ requirement_id: "REQ-001", outcome: "passed" })], deployments: [deploy({ commit_sha: OLD })] });
  assert.equal(d.state, "MERGED");
  assert.match(d.detail, /latest staging deployment is at/);
});

test("[READY-013] a failed deployment never counts as deployed", () => {
  const d = run({ evidence: [ev({ requirement_id: "REQ-001", outcome: "passed" })], deployments: [deploy({ status: "failed" })] });
  assert.equal(d.state, "MERGED");
});

test("[READY-013] production evidence at the deployed production commit reaches PRODUCTION_VERIFIED", () => {
  const d = run({
    evidence: [
      ev({ requirement_id: "REQ-001", outcome: "passed" }),
      ev({ requirement_id: "REQ-001", outcome: "passed", source: "staging_e2e", environment: "staging", run_id: "s" }),
      ev({ requirement_id: "REQ-001", outcome: "passed", source: "production_check", environment: "production", run_id: "p" }),
    ],
    deployments: [deploy(), deploy({ id: "dep-2", environment: "production" })],
  }, { "REQ-001": ACC({ completeAt: "PRODUCTION_VERIFIED" }) });
  assert.equal(d.state, "PRODUCTION_VERIFIED");
  assert.equal(d.complete, true);
});

// ───────────── negative paths ─────────────

test("[READY-013] Scenario D: a failing test at head REGRESSES a requirement that previously passed", () => {
  const d = run({
    evidence: [
      ev({ requirement_id: "REQ-001", outcome: "passed", commit_sha: OLD, finished_at: T0, run_id: "old" }),
      ev({ requirement_id: "REQ-001", outcome: "failed" }),
    ],
  });
  assert.equal(d.state, "REGRESSED");
  assert.equal(d.complete, false);
  assert.match(d.detail, /last passed at bbbbbbb/);
  assert.equal(implementationFrom(d), "in_progress");
});

test("[READY-013] failing staging evidence at the deployed commit regresses a verified requirement", () => {
  const d = run({
    evidence: [
      ev({ requirement_id: "REQ-001", outcome: "passed" }),
      ev({ requirement_id: "REQ-001", outcome: "failed", source: "staging_e2e", environment: "staging", run_id: "s" }),
    ],
    deployments: [deploy()],
  });
  assert.equal(d.state, "REGRESSED");
  assert.match(d.detail, /Staging evidence at that commit FAILED/);
});

test("[READY-013] a test that has never passed is NOT_IMPLEMENTED, not regressed", () => {
  const d = run({ evidence: [ev({ requirement_id: "REQ-001", outcome: "failed" })] });
  assert.equal(d.state, "NOT_IMPLEMENTED");
  assert.match(d.detail, /never passed/);
});

test("[READY-013] Scenario F: evidence from an older commit cannot certify the current head", () => {
  const d = run({
    evidence: [
      ev({ requirement_id: "REQ-001", outcome: "passed", commit_sha: OLD, finished_at: T0, run_id: "old" }),
      // head moves: another requirement's CI run defines the new head
      ev({ requirement_id: "REQ-002", outcome: "passed" }),
    ],
    requirements: [req("REQ-001"), req("REQ-002")],
  }, { "REQ-001": ACC(), "REQ-002": ACC() });
  assert.equal(d.state, "EVIDENCE_STALE");
  assert.equal(d.complete, false);
  assert.match(d.detail, /no CI evidence for this requirement at the current head/);
});

test("[READY-013] skipped results are never a pass and never a failure", () => {
  const d = run({ evidence: [ev({ requirement_id: "REQ-001", outcome: "skipped" })] });
  assert.equal(d.state, "NOT_IMPLEMENTED");
  assert.match(d.detail, /every result so far is skipped or failing/);
});

test("[READY-013] a skipped staging journey leaves a requirement deployed but not certified", () => {
  const d = run({
    evidence: [
      ev({ requirement_id: "REQ-001", outcome: "passed" }),
      ev({ requirement_id: "REQ-001", outcome: "skipped", source: "staging_e2e", environment: "staging", run_id: "s" }),
    ],
    deployments: [deploy()],
  }, { "REQ-001": ACC({ completeAt: "STAGING_VERIFIED" }) });
  assert.equal(d.state, "DEPLOYED_STAGING");
  assert.equal(d.complete, false);
});

test("[READY-013] a requirement with no tagged test at all is NOT_IMPLEMENTED and says so", () => {
  const d = run({ evidence: [ev({ requirement_id: "REQ-002", outcome: "passed" })] });
  assert.equal(d.state, "NOT_IMPLEMENTED");
  assert.match(d.detail, /No test is tagged with this requirement/);
});

// ───────────── blockers and external gates ─────────────

test("[READY-013] an open blocker holds a requirement at BLOCKED while still showing the work done", () => {
  const d = run({
    evidence: [ev({ requirement_id: "REQ-001", outcome: "passed" })],
    openBlockerRequirementIds: new Map([["REQ-001", ["BLK-010"]]]),
  }, { "REQ-001": ACC({ external: { blocker: "BLK-010", note: "Founder approves entitlements" } }) });
  assert.equal(d.state, "BLOCKED");
  assert.equal(d.progress, "MERGED", "the code progress is still visible behind the blocker");
  assert.equal(d.complete, false);
  assert.match(d.detail, /Blocked by BLK-010: Founder approves entitlements/);
});

test("[READY-013] a regression outranks a blocker so it is never hidden", () => {
  const d = run({
    evidence: [
      ev({ requirement_id: "REQ-001", outcome: "passed", commit_sha: OLD, finished_at: T0, run_id: "old" }),
      ev({ requirement_id: "REQ-001", outcome: "failed" }),
    ],
    openBlockerRequirementIds: new Map([["REQ-001", ["BLK-010"]]]),
  });
  assert.equal(d.state, "REGRESSED");
});

test("[READY-013] a resolved blocker releases the requirement without any status edit", () => {
  const evidence = [ev({ requirement_id: "REQ-001", outcome: "passed" })];
  const acc = { "REQ-001": ACC({ external: { blocker: "BLK-010", note: "n" } }) };
  assert.equal(run({ evidence, openBlockerRequirementIds: new Map([["REQ-001", ["BLK-010"]]]) }, acc).state, "BLOCKED");
  assert.equal(run({ evidence, openBlockerRequirementIds: new Map() }, acc).state, "MERGED");
});

// ───────────── required evidence sources ─────────────

test("[READY-013] a requirement that demands staging evidence is not complete on CI alone", () => {
  const acc = { "REQ-001": ACC({ completeAt: "STAGING_VERIFIED", requires: ["staging_e2e"] }) };
  const d = run({ evidence: [ev({ requirement_id: "REQ-001", outcome: "passed" })] }, acc);
  assert.equal(d.complete, false);
  assert.match(d.detail, /Still needs passing staging_e2e evidence/);
});

test("[READY-013] the demanded source must pass at the proven commit, not an older one", () => {
  const acc = { "REQ-001": ACC({ completeAt: "STAGING_VERIFIED", requires: ["staging_e2e"] }) };
  const d = run({
    evidence: [
      ev({ requirement_id: "REQ-001", outcome: "passed" }),
      ev({ requirement_id: "REQ-001", outcome: "passed", source: "staging_e2e", environment: "staging", commit_sha: OLD, finished_at: T0, run_id: "s-old" }),
    ],
    deployments: [deploy()],
  }, acc);
  assert.equal(d.complete, false, "staging evidence from an older commit does not satisfy the requirement");
});

// ───────────── robustness ─────────────

test("[READY-013] duplicate evidence rows do not change the verdict or double-count runs", () => {
  const one = ev({ requirement_id: "REQ-001", outcome: "passed" });
  const a = run({ evidence: [one] });
  const b = run({ evidence: [one, { ...one }, { ...one, test_name: "t2" }] });
  assert.equal(a.state, b.state);
  assert.deepEqual(b.evidenceRunIds, ["run-1"]);
});

test("[READY-013] out-of-order evidence is judged by commit, not arrival order", () => {
  const rows = [
    ev({ requirement_id: "REQ-001", outcome: "passed" }),
    ev({ requirement_id: "REQ-001", outcome: "failed", commit_sha: OLD, finished_at: T0, run_id: "old" }),
  ];
  assert.equal(run({ evidence: rows }).state, "MERGED");
  assert.equal(run({ evidence: [...rows].reverse() }).state, "MERGED", "order of the rows must not matter");
});

test("[READY-013] repeated derivation is idempotent", () => {
  const input: DeriveInput = {
    requirements: [req("REQ-001")], evidence: [ev({ requirement_id: "REQ-001", outcome: "passed" })],
    deployments: [deploy()], openBlockerRequirementIds: new Map(), now: NOW, acceptance: { "REQ-001": ACC() },
  };
  assert.deepEqual(deriveRequirementStates(input), deriveRequirementStates(input));
});

test("[READY-013] concurrent merges: the newest CI run on the default branch defines the head", () => {
  const rows = [
    ev({ requirement_id: "REQ-001", outcome: "passed", commit_sha: OLD, finished_at: T0 }),
    ev({ requirement_id: "REQ-002", outcome: "passed", commit_sha: HEAD, finished_at: T1 }),
  ];
  assert.equal(integrationHead(rows), HEAD);
  assert.equal(integrationHead([...rows].reverse()), HEAD);
});

test("[READY-013] a branch build never redefines the head while default-branch CI exists", () => {
  const rows = [
    ev({ requirement_id: "REQ-001", outcome: "passed", commit_sha: HEAD, finished_at: T0 }),
    ev({ requirement_id: "REQ-001", outcome: "passed", commit_sha: "cccccccccccccccccccccccccccccccccccccccc", branch: "feature/x", finished_at: T1, run_id: "br" }),
  ];
  assert.equal(integrationHead(rows), HEAD);
});

test("[READY-013] with no CI evidence at all nothing is certified and nothing throws", () => {
  const d = run({ evidence: [] });
  assert.equal(integrationHead([]), null);
  assert.equal(d.state, "NOT_IMPLEMENTED");
  assert.equal(d.headCommit, null);
  assert.equal(d.complete, false);
});

test("[READY-013] unavailable external services only withhold evidence; they never fabricate a pass", () => {
  // GitHub or Cloudflare being down means no new evidence rows: the requirement goes stale, never verified.
  const d = run({
    evidence: [ev({ requirement_id: "REQ-001", outcome: "passed", commit_sha: OLD, finished_at: T0, run_id: "old" }),
      ev({ requirement_id: "REQ-002", outcome: "passed" })],
    requirements: [req("REQ-001"), req("REQ-002")],
  }, { "REQ-001": ACC(), "REQ-002": ACC() });
  assert.equal(d.state, "EVIDENCE_STALE");
});

test("[READY-013] evidence older than the freshness window is flagged stale even when it is at the head", () => {
  const d = run({
    evidence: [ev({ requirement_id: "REQ-001", outcome: "passed", finished_at: "2026-10-01T00:00:00.000Z" })],
    freshnessHours: 72,
  });
  assert.equal(d.state, "MERGED");
  assert.equal(d.stale, true, "the verdict stands at its commit but the dashboard must show it is old");
});

test("[READY-013] AI subsystems are tracked separately and never scored as platform work", async () => {
  const { ACCEPTANCE } = await import("../requirements/acceptance.ts");
  assert.equal(ACCEPTANCE["VOICE-001"].tracking, "external_ai");
  assert.equal(ACCEPTANCE["SALESOPT-001"].tracking, "external_ai");
  assert.equal(ACCEPTANCE["AIB-001"].tracking, "external_ai");
  assert.equal(ACCEPTANCE["PAY-001"].tracking, "platform");
});
