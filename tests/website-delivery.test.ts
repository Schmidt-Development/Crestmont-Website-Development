// Handing a finished website to an existing customer project, and the customer seeing it.
//
// The builder produces a complete website under one of Crestmont's own projects. Everything here is about the
// handover: which builds may be delivered at all, that the website lands on the project that was named and on
// nobody else's, that assigning is not showing and showing is not approving, and that a replacement keeps the
// history a rollback needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer } from "./support/app.ts";
import * as WD from "../src/services/website-delivery.ts";
import { newId, nowIso } from "../src/lib/db.ts";

type App = Awaited<ReturnType<typeof createTestApp>>;

/** A customer organisation with one project, which is what a website is delivered TO. */
async function customerProject(t: App, name: string): Promise<{ orgId: string; projectId: string; userId: string }> {
  const c = await createCustomer(t.db);
  const projectId = newId("prj");
  const at = nowIso();
  await t.db.prepare(
    `INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at)
     VALUES (?, ?, ?, 'development', 2, 'upfront', ?, ?)`,
  ).bind(projectId, c.organizationId, name, at, at).run();
  return { orgId: c.organizationId, projectId, userId: c.id };
}

/** A finished build with a stored snapshot: what the builder leaves behind. */
async function finishedBuild(
  t: App, actorId: string,
  o: { state?: string; withRevision?: boolean; quality?: { verified: number; blockers?: string[] } } = {},
): Promise<{ jobId: string; sourceProjectId: string }> {
  const made = await (await import("../src/services/design-locked.ts")).createTestProject(t.db, {
    name: `Builder project ${newId("x").slice(-6)}`, actorId,
  });
  const jobId = newId("bld");
  const at = nowIso();
  await t.db.prepare(
    `INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, strategy, package_id, trigger, created_at, updated_at)
     VALUES (?, ?, ?, 'first_build', 0, ?, ?, 'standard', 'business', 'sweep', ?, ?)`,
  ).bind(jobId, made.projectId, made.organizationId, `${made.projectId}:first`, o.state ?? "ready_for_review", at, at).run();

  if (o.withRevision !== false) {
    const rev = newId("brev");
    await t.db.prepare(
      `INSERT INTO build_revisions (id, job_id, project_id, cycle, attempt, phase, score, decision, is_best, reverted, file_count, total_bytes, created_at)
       VALUES (?, ?, ?, 0, 1, 'build', 9, 'ACCEPT', 1, 0, 1, 80, ?)`,
    ).bind(rev, jobId, made.projectId, at).run();
  }
  if (o.quality) {
    await t.db.prepare(
      `INSERT INTO build_quality (id, job_id, project_id, attempt, iteration, package_id, outcome, score, applicable, passed, eligible, waiting_external, verified,
         verification_problems_json, criteria_json, defects_json, created_at, schema_version, rubric_json, design_certified, design_blockers_json)
       VALUES (?, ?, ?, 1, 1, 'business', 'pass', 9, 10, 10, 1, 0, ?, '[]', '[]', '[]', ?, 'crestmont.quality-scorecard/2', '{}', 1, ?)`,
    ).bind(newId("bq"), jobId, made.projectId, o.quality.verified, at, JSON.stringify(o.quality.blockers ?? [])).run();
  }
  return { jobId, sourceProjectId: made.projectId };
}

test("[WDL-01] only a finished build with a stored website may be delivered", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    // Every state that is not finished, and the reason given for each. A customer may inspect none of these.
    for (const state of ["queued", "building", "verifying", "failed", "canceled", "needs_information", "paused"]) {
      const b = await finishedBuild(t, staff.id, { state });
      const e = await WD.eligibility(t.db, b.jobId);
      assert.equal(e.ok, false, `${state} must not be deliverable`);
      assert.match(e.reasons.join(" "), new RegExp(`"${state}"`), e.reasons.join(" "));
    }

    // Finished, but nothing was ever stored: there is nothing for a customer to open.
    const empty = await finishedBuild(t, staff.id, { withRevision: false });
    const e1 = await WD.eligibility(t.db, empty.jobId);
    assert.equal(e1.ok, false);
    assert.match(e1.reasons.join(" "), /stored no website snapshot/);

    // A scorecard that is not verified means its acceptance criteria have no evidence behind them.
    const unverified = await finishedBuild(t, staff.id, { quality: { verified: 0 } });
    const e2 = await WD.eligibility(t.db, unverified.jobId);
    assert.equal(e2.ok, false);
    assert.match(e2.reasons.join(" "), /not verified/);

    // And an unresolved design blocker means the approved design was not preserved.
    const drifted = await finishedBuild(t, staff.id, { quality: { verified: 1, blockers: ["palette changed on index"] } });
    const e3 = await WD.eligibility(t.db, drifted.jobId);
    assert.equal(e3.ok, false);
    assert.match(e3.reasons.join(" "), /design blocker/);

    // Finished, stored, verified: deliverable, and it names the snapshot that would be delivered.
    const good = await finishedBuild(t, staff.id, { quality: { verified: 1 } });
    const e4 = await WD.eligibility(t.db, good.jobId);
    assert.ok(e4.ok, e4.reasons.join("; "));
    assert.deepEqual(e4.revision, { attempt: 1, cycle: 0 });

    // A build with no scorecard at all is not treated as failed. Inventing a verdict from a missing row is how an
    // unverified website becomes a delivered one; absence of evidence is handled by the state and the snapshot.
    const noCard = await finishedBuild(t, staff.id);
    assert.ok((await WD.eligibility(t.db, noCard.jobId)).ok);
  } finally { t.close(); }
});

test("[WDL-02] a website is assigned to the named project, and to that project's customer", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await customerProject(t, "Vesper Rowe Law");
    const b = await finishedBuild(t, staff.id, { quality: { verified: 1 } });

    const r = await WD.assignToProject(t.db, { jobId: b.jobId, projectId: cust.projectId, actorId: staff.id });
    assert.ok(r.ok, "ok" in r && !r.ok ? r.why : "");
    assert.equal(r.delivery.project_id, cust.projectId);
    assert.equal(r.delivery.organization_id, cust.orgId, "the customer comes from the project, never from the caller");
    assert.equal(r.delivery.source_project_id, b.sourceProjectId, "and the build keeps its own provenance");
    assert.equal(r.delivery.revision_attempt, 1);
    assert.equal(r.delivery.status, "assigned");
    assert.equal(r.delivery.visible_at, null, "assigning is not showing");

    // The customer cannot see it yet, because nobody has said they may.
    assert.equal(await WD.visibleForCustomer(t.db, cust.orgId, cust.projectId), null);

    // Attributed.
    const said = await t.db.prepare(
      `SELECT actor_user_id, details_json FROM audit_logs WHERE action = 'website_delivery.assigned' AND subject_id = ?`,
    ).bind(cust.projectId).first<{ actor_user_id: string; details_json: string }>();
    assert.ok(said);
    assert.equal(said.actor_user_id, staff.id);
    assert.match(said.details_json, /"visibleToCustomer":false/);

    // Then shown, as its own act.
    const vis = await WD.makeVisibleToCustomer(t.db, r.delivery.id, { actorId: staff.id });
    assert.ok(vis.ok);
    assert.equal(vis.delivery.status, "customer_visible");
    const seen = await WD.visibleForCustomer(t.db, cust.orgId, cust.projectId);
    assert.equal(seen?.id, r.delivery.id);
  } finally { t.close(); }
});

test("[WDL-03] one customer cannot see another customer's website", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const a = await customerProject(t, "Customer A project");
    const bCust = await customerProject(t, "Customer B project");
    const build = await finishedBuild(t, staff.id, { quality: { verified: 1 } });

    const r = await WD.assignToProject(t.db, { jobId: build.jobId, projectId: a.projectId, actorId: staff.id, makeVisible: true });
    assert.ok(r.ok);

    // The portal's read is filtered on the ORGANISATION as well as the project, so customer B asking for customer
    // A's project id gets nothing -- rather than a row that some later check has to notice.
    assert.equal(await WD.visibleForCustomer(t.db, bCust.orgId, a.projectId), null, "B cannot read A's delivery by project id");
    assert.equal(await WD.visibleForCustomer(t.db, a.orgId, bCust.projectId), null, "and the reverse");
    assert.ok(await WD.visibleForCustomer(t.db, a.orgId, a.projectId), "while A can read their own");

    // And B's own decision cannot land on A's delivery.
    const decided = await WD.recordCustomerDecision(t.db, {
      organizationId: bCust.orgId, projectId: a.projectId, decision: "approved", actorId: bCust.userId,
    });
    assert.equal(decided.ok, false);
    assert.match("why" in decided ? decided.why : "", /no website available/i);
  } finally { t.close(); }
});

test("[WDL-04] a replacement supersedes, keeps the history, and can be rolled back to", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await customerProject(t, "Replacement project");
    const first = await finishedBuild(t, staff.id, { quality: { verified: 1 } });
    const second = await finishedBuild(t, staff.id, { quality: { verified: 1 } });

    const v1 = await WD.assignToProject(t.db, { jobId: first.jobId, projectId: cust.projectId, actorId: staff.id, makeVisible: true });
    assert.ok(v1.ok);
    const v2 = await WD.assignToProject(t.db, { jobId: second.jobId, projectId: cust.projectId, actorId: staff.id, makeVisible: true });
    assert.ok(v2.ok);
    assert.equal(v2.superseded, v1.delivery.id, "the replacement says what it replaced");

    // One live delivery, and the customer sees the new one.
    const live = await WD.activeForProject(t.db, cust.projectId);
    assert.equal(live?.id, v2.delivery.id);
    assert.equal((await WD.visibleForCustomer(t.db, cust.orgId, cust.projectId))?.job_id, second.jobId);

    // The old one is kept, with the link forward, because what was live between two moments is evidence.
    const old = await WD.byId(t.db, v1.delivery.id);
    assert.equal(old?.status, "superseded");
    assert.equal(old?.superseded_by, v2.delivery.id);
    assert.equal((await WD.historyForProject(t.db, cust.projectId)).length, 2);

    // Rolling back delivers the EARLIER snapshot again -- a new row naming the old one, never an edit of it.
    const back = await WD.rollbackTo(t.db, { projectId: cust.projectId, deliveryId: v1.delivery.id, actorId: staff.id });
    assert.ok(back.ok, "ok" in back && !back.ok ? back.why : "");
    assert.equal(back.delivery.job_id, first.jobId, "the customer sees what they saw before");
    assert.notEqual(back.delivery.id, v1.delivery.id, "as a new delivery, so the history is not rewritten");
    assert.equal((await WD.byId(t.db, v2.delivery.id))?.status, "superseded");
    assert.equal((await WD.activeForProject(t.db, cust.projectId))?.id, back.delivery.id);
    assert.equal((await WD.historyForProject(t.db, cust.projectId)).length, 3);

    // A rollback to another project's delivery is refused.
    const other = await customerProject(t, "Someone else");
    const wrong = await WD.rollbackTo(t.db, { projectId: other.projectId, deliveryId: v1.delivery.id, actorId: staff.id });
    assert.equal(wrong.ok, false);
    assert.match("why" in wrong ? wrong.why : "", /another project/);
  } finally { t.close(); }
});

test("[WDL-05] the customer's approval is their own act, never inferred from being able to see it", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await customerProject(t, "Decision project");
    const b = await finishedBuild(t, staff.id, { quality: { verified: 1 } });
    const r = await WD.assignToProject(t.db, { jobId: b.jobId, projectId: cust.projectId, actorId: staff.id, makeVisible: true });
    assert.ok(r.ok);

    // Visible, and not approved. These are different columns for exactly this reason.
    assert.equal(r.delivery.customer_decision, null);
    assert.equal(r.delivery.status, "customer_visible");

    const decided = await WD.recordCustomerDecision(t.db, {
      organizationId: cust.orgId, projectId: cust.projectId, decision: "revision_requested",
      actorId: cust.userId, note: "the hero photograph is the wrong one",
    });
    assert.ok(decided.ok);
    assert.equal(decided.delivery.customer_decision, "revision_requested");
    assert.equal(decided.delivery.status, "revision_requested");
    assert.match(decided.delivery.customer_note!, /hero photograph/);
    assert.ok(decided.delivery.customer_reviewed_at);

    const said = await t.db.prepare(
      `SELECT actor_user_id FROM audit_logs WHERE action = 'website_delivery.customer_decision' AND subject_id = ?`,
    ).bind(cust.projectId).first<{ actor_user_id: string }>();
    assert.equal(said?.actor_user_id, cust.userId, "recorded as the customer's, not as staff's");
  } finally { t.close(); }
});

test("[WDL-06] the delivery targets are real customer projects, and a long search is not a crash", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await customerProject(t, "Vesper Rowe Law");
    // A builder project lives in Crestmont's own internal organisation; offering it as a delivery target is how a
    // website gets "delivered" to nobody.
    const internal = await finishedBuild(t, staff.id, { quality: { verified: 1 } });

    const all = await WD.assignTargets(t.db, {});
    assert.ok(all.some((x) => x.projectId === cust.projectId), "the customer's project is offered");
    assert.ok(!all.some((x) => x.projectId === internal.sourceProjectId), "Crestmont's own builder project is not");

    const found = await WD.assignTargets(t.db, { query: "vesper" });
    assert.deepEqual(found.map((x) => x.projectId), [cust.projectId]);
    assert.equal((await WD.assignTargets(t.db, { query: "nothing matches this" })).length, 0);

    // D1 refuses a LIKE pattern over 50 bytes, so a long search term used to be a 500. The GET fuzzer found it.
    assert.equal((await WD.assignTargets(t.db, { query: "A".repeat(5000) })).length, 0);

    // What a project is already showing travels with the target, so nobody replaces a live website unknowingly.
    const r = await WD.assignToProject(t.db, { jobId: internal.jobId, projectId: cust.projectId, actorId: staff.id, makeVisible: true });
    assert.ok(r.ok);
    const after = (await WD.assignTargets(t.db, { query: "vesper" }))[0];
    assert.equal(after.current?.jobId, internal.jobId);
    assert.equal(after.current?.visible, true);
    assert.equal(after.current?.revision, "1-0");
  } finally { t.close(); }
});
