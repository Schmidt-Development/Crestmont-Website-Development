// READY-013: the acceptance registry is the validated manifest that makes automatic readiness possible.
// These tests are the guardrails on the normal engineering workflow: a requirement cannot enter the inventory
// without a way to prove it, and an acceptance entry cannot name a gate that does not exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REQUIREMENTS } from "../requirements/inventory.ts";
import { ACCEPTANCE, ACCEPTANCE_ENTRY_IDS, acceptanceFingerprint } from "../requirements/acceptance.ts";
import { createTestDb } from "./support/sqlite-d1.ts";

/** Every `[REQ-ID]` tag in the test suite — the requirement-to-test mapping the evidence reporter reads. */
function taggedRequirements(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|mjs)$/.test(name)) continue;
      for (const m of readFileSync(p, "utf8").matchAll(/\[([A-Z]+-\d{3})\]/g)) out.add(m[1]);
    }
  };
  walk("tests");
  return out;
}

test("[READY-013] every requirement in the approved inventory resolves to an acceptance", () => {
  const missing = REQUIREMENTS.filter((r) => !ACCEPTANCE[r.id]).map((r) => r.id);
  assert.deepEqual(missing, [], "a requirement with no acceptance can never be derived");
  assert.equal(Object.keys(ACCEPTANCE).length, REQUIREMENTS.length);
});

test("[READY-013] every explicit acceptance entry names a requirement that exists", () => {
  const ids = new Set(REQUIREMENTS.map((r) => r.id));
  assert.deepEqual(ACCEPTANCE_ENTRY_IDS.filter((id) => !ids.has(id)), [], "an entry for an unknown id is a typo nobody would notice");
});

test("[READY-013] every external gate names a blocker or a security finding that really exists", async () => {
  const db = createTestDb();
  const blockers = new Set((await db.prepare(`SELECT id FROM blockers`).all<{ id: string }>()).results.map((r) => r.id));
  const findings = new Set((await db.prepare(`SELECT id FROM security_findings`).all<{ id: string }>()).results.map((r) => r.id));
  const bad: string[] = [];
  for (const [id, a] of Object.entries(ACCEPTANCE)) {
    if (!a.external) continue;
    if (!a.external.blocker && !a.external.finding) { bad.push(`${id}: gate names neither a blocker nor a finding`); continue; }
    if (a.external.blocker && !blockers.has(a.external.blocker)) bad.push(`${id}: unknown blocker ${a.external.blocker}`);
    if (a.external.finding && !findings.has(a.external.finding)) bad.push(`${id}: unknown finding ${a.external.finding}`);
  }
  assert.deepEqual(bad, []);
});

test("[READY-013] every platform requirement is provable: it has a tagged test, or an external gate that stands in for one", () => {
  const tagged = taggedRequirements();
  // The five AI systems are developed and proven in their own sessions; a platform requirement with neither a
  // test nor a declared external fact would simply sit at NOT_IMPLEMENTED forever with nobody noticing.
  const unprovable = REQUIREMENTS
    .filter((r) => ACCEPTANCE[r.id].tracking === "platform" && !tagged.has(r.id) && !ACCEPTANCE[r.id].external)
    .map((r) => r.id);
  assert.deepEqual(unprovable, [],
    "add a test tagged [ID] for this requirement, or declare the external fact that establishes it in requirements/acceptance.ts");
});

test("[READY-013] an externally tracked AI requirement with no evidence derives as NOT_IMPLEMENTED, never as done", async () => {
  const { deriveRequirementStates } = await import("../src/readiness/derive.ts");
  const ids = ["VOICE-002", "AIB-010", "SALESOPT-012"];
  const d = deriveRequirementStates({
    requirements: ids.map((id) => ({ id, category: "integration", subsystem: "AI Receptionist", disposition: "in_scope" })),
    evidence: [], deployments: [], openBlockerRequirementIds: new Map(), now: new Date(),
  });
  assert.ok(d.every((x) => x.state === "NOT_IMPLEMENTED" && !x.complete), "no evidence means no claim");
  assert.ok(d.every((x) => x.tracking === "external_ai"));
});

test("[READY-013] the five AI systems are tracked separately and never scored inside the platform", () => {
  const ai = REQUIREMENTS.filter((r) => ACCEPTANCE[r.id].tracking === "external_ai");
  assert.ok(ai.length >= 39, "the AI subsystems stay externally tracked");
  assert.ok(ai.every((r) => /^(VOICE|SALESOPT|AIB)-/.test(r.id)), "only the AI subsystems are externally tracked");
  const platform = REQUIREMENTS.filter((r) => ACCEPTANCE[r.id].tracking === "platform");
  assert.ok(platform.some((r) => r.id === "PAY-001") && platform.some((r) => r.id === "READY-013"));
});

test("[READY-013] the acceptance fingerprint changes when a gate changes, so D1 cannot keep an old rule", () => {
  const a = acceptanceFingerprint("PAY-001");
  assert.ok(a.length > 0);
  assert.notEqual(a, acceptanceFingerprint("DATA-001"), "different rules must fingerprint differently");
  assert.equal(a, acceptanceFingerprint("PAY-001"), "and the same rule must be stable");
  assert.equal(acceptanceFingerprint("NOPE-999"), "");
});

test("[READY-013] requirements/status files no longer carry status: they are documentation only", async () => {
  // The readiness engine must not import the declarations as a source of truth. ingest.ts may still read them
  // for the "where is this implemented" text, but nothing may write implementation_status from them.
  const engine = readFileSync("src/readiness/engine.ts", "utf8");
  const derive = readFileSync("src/readiness/derive.ts", "utf8");
  assert.ok(!/requirements\/status/.test(engine), "the engine must not read the hand-maintained declarations");
  assert.ok(!/requirements\/status/.test(derive), "the derivation must not read the hand-maintained declarations");
  const ingest = readFileSync("src/readiness/ingest.ts", "utf8");
  assert.ok(!/SET implementation_status/.test(ingest), "nothing may write implementation_status from a declaration");
});

// ───────────── Blocker attribution (migration 0078) ─────────────
//
// A requirement completes the moment its named external gate clears. BLK-006 had accumulated twelve
// requirements — the mailing address, the retention schedule, commissioning an independent penetration test,
// the staffed support hours and the production launch authorization alongside the attorney review — so
// finishing the legal review would have reported all of them as done. These two tests keep each gate
// answering only for itself.

test("[READY-013] the acceptance registry and the blocker register agree on what gates what", async () => {
  const db = createTestDb();
  await (await import("../src/readiness/ingest.ts")).syncRequirements(db);
  await (await import("../src/services/readiness-admin.ts")).applySeedBlockerLinks(db);
  const links = new Set((await db.prepare(`SELECT blocker_id, requirement_id FROM blocker_requirements`)
    .all<{ blocker_id: string; requirement_id: string }>()).results.map((r) => `${r.blocker_id}/${r.requirement_id}`));
  const unlinked: string[] = [];
  for (const [id, a] of Object.entries(ACCEPTANCE)) {
    if (a.external?.blocker && !links.has(`${a.external.blocker}/${id}`)) unlinked.push(`${a.external.blocker}/${id}`);
  }
  // A gate the register does not know about is invisible on the blocker page: the requirement reads as
  // blocked with nothing listed as blocking it, and resolving the blocker would not clear it.
  assert.deepEqual(unlinked, [], "link these in a migration's blocker_seed_links");
});

test("[READY-013] resolving the legal-review blocker completes the legal review and nothing else", async () => {
  const { deriveRequirementStates } = await import("../src/readiness/derive.ts");

  // Everything BLK-006 used to gate, with the gate it answers to now.
  const ids = ["IDENT-001", "IDENT-002", "IDENT-005", "LAUNCH-001", "LEGAL-001", "LEGAL-002", "LEGAL-004", "LEGAL-005", "PAY-010", "SEC-006", "SEC-007", "SUP-005"];
  const gate = (id: string) => ACCEPTANCE[id].external?.blocker;

  // These five facts are separable and each has its own blocker; none may still hang off BLK-006.
  assert.equal(gate("IDENT-002"), "BLK-016", "a mailing address is not an attorney review");
  assert.equal(gate("IDENT-005"), "BLK-016");
  assert.equal(gate("SEC-007"), "BLK-017", "an independent penetration test is not an attorney review");
  assert.equal(gate("SEC-006"), "BLK-018", "a retention schedule is not an attorney review");
  assert.equal(gate("SUP-005"), "BLK-019", "staffed support hours are not an attorney review");
  assert.equal(gate("LAUNCH-001"), "BLK-020", "a production launch authorization is not an attorney review");
  assert.equal(gate("LEGAL-004"), "BLK-006", "the attorney review itself still answers to BLK-006");

  const now = new Date("2026-11-05T12:00:00Z");
  const row = (id: string) => ({
    requirement_id: id, outcome: "passed" as const, test_name: `[${id}] proof`, run_id: "r1",
    environment: "development" as const, source: "ci", commit_sha: "c1", branch: "main",
    finished_at: "2026-11-05T11:00:00Z",
  });
  // A succeeded staging deployment of the same commit, so a STAGING_VERIFIED requirement (SEC-006) is held
  // back by its gate alone and not by missing deployment evidence.
  const deployments = [{ id: "dep_1", environment: "staging" as const, commit_sha: "c1", status: "succeeded", deployed_at: "2026-11-05T11:30:00Z" }];
  const derive = (open: string[]) => new Map(deriveRequirementStates({
    requirements: ids.map((id) => ({ id, category: "security", subsystem: "Platform", disposition: "in_scope" })),
    evidence: ids.map(row),
    deployments,
    openBlockerRequirementIds: new Map(),
    openBlockerIds: new Set(open),
    openFindingIds: new Set<string>(),
    now,
  }).map((d) => [d.id, d]));

  const open = ["BLK-006", "BLK-016", "BLK-017", "BLK-018", "BLK-019", "BLK-020"];
  const before = derive(open);
  assert.deepEqual(ids.filter((id) => before.get(id)!.complete), [], "all twelve start blocked");
  assert.ok(ids.every((id) => before.get(id)!.state === "BLOCKED"));

  // The attorney finishes. Only what the attorney's review actually establishes may move.
  const after = derive(open.filter((b) => b !== "BLK-006"));
  assert.deepEqual(ids.filter((id) => after.get(id)!.complete).sort(),
    ["IDENT-001", "LEGAL-001", "LEGAL-002", "LEGAL-004", "LEGAL-005", "PAY-010"],
    "resolving BLK-006 must not complete the penetration test, the retention schedule, the support hours, the mailing address or the launch authorization");
  for (const id of ["IDENT-002", "IDENT-005", "SEC-006", "SEC-007", "SUP-005", "LAUNCH-001"]) {
    assert.equal(after.get(id)!.state, "BLOCKED", `${id} is still waiting on its own gate`);
  }
});
