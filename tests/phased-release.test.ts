// Phased release (docs/PHASED-LAUNCH.md): Founder scope dispositions for the separately-developed AI systems.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestApp, createStaff } from "./support/app.ts";
import { REQUIREMENTS } from "../requirements/inventory.ts";
import { ACCEPTANCE } from "../requirements/acceptance.ts";
import { PRODUCTION_GATES, NEVER_DEFERRABLE, SECURITY_DEFERRAL_RATIONALE, PHASE_1, deferral, phaseConfigProblems, productionVars } from "../src/readiness/phased-release.ts";
import { productionBlock } from "../scripts/provision-production.ts";
import { checkPhase } from "../scripts/phase-check.ts";
import * as ra from "../src/services/readiness-admin.ts";
import { releaseAuthorization } from "../src/services/deployments.ts";

const toml = readFileSync("wrangler.toml", "utf8");
const ALL_AI = PRODUCTION_GATES.map((g) => g.subsystem);
const tracked = (id: string) => ACCEPTANCE[id].tracking;

test("phased release policy: no platform requirement is deferrable — authentication, security, payments, legal and launch always count", () => {
  const platform = REQUIREMENTS.filter((r) => tracked(r.id) === "platform");
  assert.ok(platform.length > 100);
  for (const r of platform) assert.equal(deferral({ ...r, tracking: "platform" }).ok, false, `${r.id} must never be deferrable`);
});

test("phased release policy: every AI system has a production gate, every AI security requirement has an explicit decision, and AIB-019 stays in scope", () => {
  const ai = REQUIREMENTS.filter((r) => tracked(r.id) === "external_ai");
  for (const s of new Set(ai.map((r) => r.subsystem))) assert.ok(PRODUCTION_GATES.some((g) => g.subsystem === s), `${s} has no production gate`);
  // A new AI security requirement must be decided on (a rationale or never-deferrable), not silently deferrable or not.
  for (const r of ai.filter((x) => x.category === "security")) assert.ok(SECURITY_DEFERRAL_RATIONALE[r.id] || NEVER_DEFERRABLE[r.id], `${r.id} needs an explicit decision`);
  for (const id of [...Object.keys(SECURITY_DEFERRAL_RATIONALE), ...Object.keys(NEVER_DEFERRABLE)]) assert.equal(tracked(id), "external_ai", `${id} is not an AI-system requirement`);
  const sim = REQUIREMENTS.find((r) => r.id === "AIB-019")!;
  const d = deferral({ ...sim, tracking: "external_ai" });
  assert.equal(d.ok, false);
  assert.match(!d.ok ? d.reason : "", /live payment path/);
  assert.equal(deferral({ ...REQUIREMENTS.find((r) => r.id === "AIB-010")!, tracking: "external_ai" }).ok, true);
});

test("phased release: the committed production configuration keeps every AI system off; switching one on, or a forbidden secret, refuses the deploy", () => {
  assert.deepEqual(checkPhase(toml, ALL_AI, JSON.stringify([{ name: "TURNSTILE_SECRET" }, { name: "EVIDENCE_INGEST_SECRET" }, { name: "MFA_ENCRYPTION_KEY" }])), []);
  const vars = productionVars(productionBlock(toml));
  assert.equal(vars.AI_BUILD_AUTOMATION, "off");
  assert.equal(vars.ENVIRONMENT, "production");
  const on = toml.replace('AI_BUILD_AUTOMATION = "off"', 'AI_BUILD_AUTOMATION = "on"');
  assert.notEqual(on, toml);
  assert.match(checkPhase(on, ["AI Builds (addendum)"], null).join(" "), /AI_BUILD_AUTOMATION is "on"/);
  assert.match(checkPhase(toml.replace(', AI_BUILD_AUTOMATION = "off"', ""), ["AI Builds V4 (Founder architecture)"], null).join(" "), /AI_BUILD_AUTOMATION is not set/, "the gate must be stated, not implied");
  for (const [subsystem, secret] of [["AI Builds (addendum)", "BUILD_RUNNER_SECRET"], ["AI Builds (addendum)", "AI_BUILD_AUTOMATION"], ["AI Receptionist", "RETELL_INBOUND_API_KEY"], ["AI Sales Optimization (addendum)", "RETELL_OUTBOUND_API_KEY"]]) {
    assert.match(phaseConfigProblems([subsystem], vars, [secret]).join(" "), new RegExp(`holds the secret ${secret}`));
  }
  assert.deepEqual(phaseConfigProblems([], { AI_BUILD_AUTOMATION: "on" }, ["BUILD_RUNNER_SECRET"]), [], "with nothing deferred the full scope is released and judged by the gates");
});

async function founderApp() {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner", "founder@crestmont.test");
  const oc = await t.client().login(owner.email, undefined, owner.secret);
  return { ...t, owner, oc };
}
const ctxOf = (t: Awaited<ReturnType<typeof founderApp>>) => ({ db: t.db, now: () => new Date() });
const disposition = async (t: Awaited<ReturnType<typeof founderApp>>, id: string) => (await t.db.prepare(`SELECT disposition, disposition_approval_id FROM requirements WHERE id = ?`).bind(id).first<{ disposition: string; disposition_approval_id: string | null }>())!;

test("phased release: the Founder defers AI-builder requirements; the gates stop counting them, the evidence set changes and an earlier launch approval is voided", async () => {
  const t = await founderApp();
  const commit = "abc1234def5678abc1234def5678abc1234def56";
  assert.equal((await t.oc.post("/staff/readiness/releases", { commit_sha: commit, config_sha256: "a".repeat(64), notes: "Phase 1 candidate", rollback_plan: "wrangler rollback to the previous version" })).status, 303);
  const evSet = /name="evidence_set" value="([0-9a-f]{64})"/.exec(await (await t.oc.get("/staff/readiness/approve")).text())![1];
  assert.equal((await t.oc.post("/staff/readiness/approve", { decision: "approved", confirm_commit: commit, evidence_set: evSet, notes: "test" })).status, 303);
  assert.equal((await releaseAuthorization(ctxOf(t), commit)).authorized, true, "precondition: a valid approval exists");
  const before = (await ra.loadReport(ctxOf(t))).report;
  const gateA = (r: typeof before) => Number(/\/(\d+) implemented/.exec(r.gates.find((g) => g.id === "A")!.currentEvidence)![1]);

  const res = await t.oc.post("/staff/readiness/phased-release/defer", { id: ["AIB-010", "AIB-015"], notes: "Phase 1 opens the non-AI offering; the builder is certified separately.", confirm: PHASE_1.confirmPhrase });
  assert.equal(res.status, 303);
  for (const id of ["AIB-010", "AIB-015"]) assert.equal((await disposition(t, id)).disposition, "deferred_by_founder");
  const rec = (await t.db.prepare(`SELECT kind, decision, notes, approver_user_id, evidence_set_sha256 FROM release_approvals WHERE id = ?`).bind((await disposition(t, "AIB-010")).disposition_approval_id).first<Record<string, string>>())!;
  assert.equal(rec.kind, "scope_disposition");
  assert.equal(rec.approver_user_id, t.owner.id);
  assert.match(rec.notes, /phase-1-non-ai: deferred AIB-010, AIB-015/);
  assert.match(rec.notes, /AI_BUILD_AUTOMATION = "off"/, "the decision records the production gate it relies on");
  const after = (await ra.loadReport(ctxOf(t))).report;
  assert.equal(gateA(after), gateA(before) - 2, "deferred requirements leave the gate denominators");
  assert.notEqual(after.evidenceSetSha256, before.evidenceSetSha256);
  assert.equal(after.requirements.find((r) => r.id === "AIB-010")!.state, before.requirements.find((r) => r.id === "AIB-010")!.state, "a deferral never changes the requirement's real state");
  const auth = await releaseAuthorization(ctxOf(t), commit);
  assert.equal(auth.authorized, false, "the approval was for a different scope");
  assert.deepEqual(auth.phasedRelease.deferred.map((d) => d.id), ["AIB-010", "AIB-015"]);
  const audited = await t.db.prepare(`SELECT details_json FROM audit_logs WHERE action = 'release.scope_deferred'`).first<{ details_json: string }>();
  assert.ok(audited);

  // Reinstating puts it straight back into every gate (and also voids approvals, since scope changed again).
  assert.equal((await t.oc.post("/staff/readiness/phased-release/reinstate", { id: "AIB-015" })).status, 303);
  assert.equal((await disposition(t, "AIB-015")).disposition, "in_scope");
  assert.equal(gateA((await ra.loadReport(ctxOf(t))).report), gateA(before) - 1);
  const page = await (await t.oc.get("/staff/readiness/phased-release")).text();
  assert.match(page, /Deferred \(1\)/);
  assert.match(page, /AIB-019/);
  assert.match(page, /Stays in scope/);
  t.close();
});

test("phased release: platform requirements, AIB-019, a missing confirmation and a non-Founder are all refused, and nothing changes", async () => {
  const t = await founderApp();
  const snapshot = async () => (await t.db.prepare(`SELECT COUNT(*) AS n FROM requirements WHERE disposition <> 'in_scope'`).first<{ n: number }>())!.n;
  const good = { notes: "Phase 1 opens the non-AI offering; the builder is certified separately.", confirm: PHASE_1.confirmPhrase };
  for (const [form, why] of [
    [{ ...good, id: ["SEC-007"] }, /SEC-007 is not an AI-system requirement/],
    [{ ...good, id: ["AIB-010", "PAY-010"] }, /PAY-010 is not an AI-system requirement/],
    [{ ...good, id: ["AIB-019"] }, /never deferrable/],
    [{ ...good, id: ["AIB-010"], confirm: "yes" }, /Type &quot;defer for phase 1&quot; to confirm/],
    [{ ...good, id: ["AIB-010"], notes: "ok" }, /reason for the deferral/],
  ] as [Record<string, string | string[]>, RegExp][]) {
    const res = await t.oc.post("/staff/readiness/phased-release/defer", form);
    assert.equal(res.status, 422);
    assert.match(await res.text(), why);
  }
  assert.equal(await snapshot(), 0, "all-or-nothing: a request with one ineligible id defers nothing");
  const admin = await createStaff(t.db, "administrator", "admin@crestmont.test");
  const ac = await t.client().login(admin.email, undefined, admin.secret);
  assert.equal((await ac.post("/staff/readiness/phased-release/defer", { ...good, id: ["AIB-010"] })).status, 403);
  // An Owner account that is not the Founder (FOUNDER_EMAIL set) is refused and the refusal is audited.
  t.env.FOUNDER_EMAIL = "someone-else@crestmont.test";
  assert.equal((await t.oc.post("/staff/readiness/phased-release/defer", { ...good, id: ["AIB-010"] })).status, 403);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'release.scope_deferral_refused'`).first());
  assert.equal(await snapshot(), 0);
  t.close();
});
