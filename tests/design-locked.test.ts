// Design-locked frontends: versioning, immutability, approval, rollback, and the retirement gate.
//
// The Founder supplies the design; the AI makes it work. That only holds if four things are true, and each is
// settled here against the real schema and the real services:
//
//   - a later artifact can never silently replace an approved design (§13);
//   - an approved baseline cannot be edited or deleted, by anyone, ever (§4);
//   - a design-locked project cannot enter the retired autonomous design phase (§15 Phase D, §17.18);
//   - rolling back restores the previous approved frontend WITHOUT discarding backend work (§17.20).
//
// Existing projects are untouched by all of it (§17.17), which is also checked rather than assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, TEST_PASSWORD } from "./support/app.ts";
import * as DL from "../src/services/design-locked.ts";
import * as B from "../src/services/builds.ts";
import * as MS from "../src/services/malware-scan.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import { sha256Hex } from "../src/lib/crypto.ts";
import { makeZip } from "../runner/test/fixtures/zip-writer.ts";
import type { Env } from "../src/app/context.ts";

type Db = Env["DB"];

async function project(db: Db, organizationId: string, name = "Summit Haul Co."): Promise<string> {
  const id = newId("prj");
  const at = nowIso();
  await db.prepare(
    `INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at)
     VALUES (?, ?, ?, 'development', 2, 'upfront', ?, ?)`,
  ).bind(id, organizationId, name, at, at).run();
  return id;
}

const baselineInput = (over: Partial<DL.BaselineInput> = {}): DL.BaselineInput => ({
  fingerprint: "a".repeat(64),
  sourceFingerprint: "b".repeat(64),
  routes: [{ page: "index" }, { page: "quote" }],
  assets: [{ path: "logo.svg", sha256: "c".repeat(64) }],
  components: [{ name: "Layout" }],
  interactions: [
    { page: "quote", element: "form#quote-request", needsBackend: true, functional: false },
    { page: "index", element: "button.nav-toggle", needsBackend: false, functional: true },
  ],
  signatures: [{ page: "index", viewport: "desktop" }, { page: "index", viewport: "mobile" }],
  screenshots: [{ page: "index", viewport: "desktop", sha: "d".repeat(64) }],
  states: [{ page: "index", viewport: "mobile", state: "nav-open", sha: "e".repeat(64) }],
  viewports: ["desktop", "tablet", "mobile"],
  ...over,
});

async function approvedProject(db: Db, orgId: string, approverId: string) {
  const projectId = await project(db, orgId);
  const artifact = await DL.recordArtifact(db, {
    projectId, organizationId: orgId, source: "upload", sha256: "1".repeat(64), sizeBytes: 26_000, uploadedBy: approverId, scanStatus: "clean",
  });
  await DL.recordVerdict(db, artifact.id, { status: "imported", framework: "vite", archiveRoot: "summit-haul-frontend" });
  const draft = await DL.recordBaseline(db, artifact.id, baselineInput());
  const approved = await DL.approveBaseline(db, draft.id, { approvedBy: approverId, note: "Looks right." });
  return { projectId, artifact, approved };
}

test("[DLK-01] an artifact is versioned per project and never overwrites the one before it", async () => {
  const { db, close } = await createTestApp();
  try {
    const staff = await createStaff(db, "owner");
    const cust = await createCustomer(db);
    const projectId = await project(db, cust.organizationId);

    const a1 = await DL.recordArtifact(db, { projectId, organizationId: cust.organizationId, source: "upload", sha256: "1".repeat(64), sizeBytes: 100, uploadedBy: staff.id, scanStatus: "clean" });
    const a2 = await DL.recordArtifact(db, { projectId, organizationId: cust.organizationId, source: "upload", sha256: "2".repeat(64), sizeBytes: 200, uploadedBy: staff.id, scanStatus: "clean" });

    assert.equal(a1.version, 1);
    assert.equal(a2.version, 2, "a second upload is a new version, not a replacement");
    assert.equal((await DL.listArtifacts(db, projectId)).length, 2);
    assert.equal((await DL.latestArtifact(db, projectId))!.id, a2.id);
    assert.equal((await DL.getArtifact(db, a1.id))!.sha256, "1".repeat(64), "the first artifact is still exactly as it was");

    // Receiving an artifact puts the project into the workflow.
    assert.equal((await DL.frontendState(db, projectId)).state, "validating_artifact");

    // An internal fixture is recorded as not scanned, in those words — never as a pass.
    const fixture = await DL.recordArtifact(db, { projectId, organizationId: cust.organizationId, source: "internal_fixture", sha256: "3".repeat(64), sizeBytes: 50 });
    assert.equal(fixture.scan_status, "skipped_internal");
  } finally { close(); }
});

test("[DLK-02] a rejected or quarantined artifact moves the project to a failure state and keeps the reason", async () => {
  const { db, close } = await createTestApp();
  try {
    const staff = await createStaff(db, "owner");
    const cust = await createCustomer(db);
    const projectId = await project(db, cust.organizationId);
    const a = await DL.recordArtifact(db, { projectId, organizationId: cust.organizationId, source: "upload", sha256: "f".repeat(64), sizeBytes: 999, uploadedBy: staff.id, scanStatus: "clean" });

    await DL.recordVerdict(db, a.id, {
      status: "quarantined",
      problems: [{ severity: "quarantine", code: "unsafe-path", detail: "path traversal", path: "../../etc/passwd" }],
      actorId: staff.id,
    });

    const after = (await DL.getArtifact(db, a.id))!;
    assert.equal(after.status, "quarantined");
    assert.equal((await DL.frontendState(db, projectId)).state, "artifact_quarantined");
    const problems = JSON.parse(after.problems_json) as { code: string; path: string }[];
    assert.equal(problems[0].code, "unsafe-path", "the reason is kept so the uploader can be told what was wrong");
    assert.equal(problems[0].path, "../../etc/passwd");

    // Nothing was locked: a quarantined artifact never becomes a design.
    assert.equal((await DL.frontendState(db, projectId)).designLocked, false);
    assert.equal(await DL.approvedBaseline(db, projectId), null);
  } finally { close(); }
});

test("[DLK-03] a baseline needs measurements, and only a person can approve it", async () => {
  const { db, close } = await createTestApp();
  try {
    const staff = await createStaff(db, "owner");
    const cust = await createCustomer(db);
    const projectId = await project(db, cust.organizationId);
    const a = await DL.recordArtifact(db, { projectId, organizationId: cust.organizationId, source: "upload", sha256: "9".repeat(64), sizeBytes: 10, uploadedBy: staff.id, scanStatus: "clean" });

    await assert.rejects(() => DL.recordBaseline(db, a.id, baselineInput({ signatures: [] })), /at least one measured page/);
    await assert.rejects(() => DL.recordBaseline(db, a.id, baselineInput({ screenshots: [] })), /no visual record/);
    await assert.rejects(() => DL.recordBaseline(db, a.id, baselineInput({ fingerprint: "" })), /design fingerprint/);

    const draft = await DL.recordBaseline(db, a.id, baselineInput());
    assert.equal(draft.status, "draft", "measuring a design does not approve it");
    assert.equal(draft.version, 1);
    assert.equal((await DL.frontendState(db, projectId)).designLocked, false, "and does not lock the project");
    assert.equal((await DL.frontendState(db, projectId)).state, "awaiting_approval");

    await assert.rejects(() => DL.approveBaseline(db, draft.id, { approvedBy: "" }), /who approved it/);

    const approved = await DL.approveBaseline(db, draft.id, { approvedBy: staff.id, note: "Approved." });
    assert.equal(approved.status, "approved");
    assert.equal(approved.approved_by, staff.id);
    assert.ok(approved.approved_at);
    const s = await DL.frontendState(db, projectId);
    assert.equal(s.designLocked, true, "approval is what locks the design");
    assert.equal(s.state, "design_locked");
    assert.equal(s.activeBaselineId, approved.id);

    // Approving twice is a mistake, not an idempotent no-op.
    await assert.rejects(() => DL.approveBaseline(db, draft.id, { approvedBy: staff.id }), /already approved/);
  } finally { close(); }
});

test("[DLK-04] an approved baseline is immutable and cannot be deleted", async () => {
  const { db, close } = await createTestApp();
  try {
    const staff = await createStaff(db, "owner");
    const cust = await createCustomer(db);
    const { approved, projectId } = await approvedProject(db, cust.organizationId, staff.id);

    // The design itself: refused by the database, not by a convention in application code.
    await assert.rejects(
      () => db.prepare(`UPDATE design_baselines SET fingerprint = ? WHERE id = ?`).bind("0".repeat(64), approved.id).run(),
      /immutable once it leaves draft/,
    );
    await assert.rejects(
      () => db.prepare(`UPDATE design_baselines SET signatures_json = '[]' WHERE id = ?`).bind(approved.id).run(),
      /immutable once it leaves draft/,
    );
    await assert.rejects(
      () => db.prepare(`UPDATE design_baselines SET screenshots_json = '[]' WHERE id = ?`).bind(approved.id).run(),
      /immutable once it leaves draft/,
    );
    await assert.rejects(
      () => db.prepare(`DELETE FROM design_baselines WHERE id = ?`).bind(approved.id).run(),
      /cannot be deleted; supersede it instead/,
    );

    // It really is unchanged.
    const still = (await DL.getBaseline(db, approved.id))!;
    assert.equal(still.fingerprint, "a".repeat(64));
    assert.equal(JSON.parse(still.signatures_json).length, 2);
    assert.equal(JSON.parse(still.screenshots_json).length, 1);
    assert.equal(JSON.parse(still.states_json).length, 1, "the interaction states are part of the record too");
    assert.deepEqual(JSON.parse(still.viewports_json), ["desktop", "tablet", "mobile"]);
    assert.equal(JSON.parse(still.asset_manifest_json)[0].path, "logo.svg");
    assert.equal(JSON.parse(still.route_manifest_json).length, 2);

    // Lifecycle columns stay writable, or a baseline could never be superseded.
    await db.prepare(`UPDATE design_baselines SET approval_note = 'still editable' WHERE id = ?`).bind(approved.id).run();
    assert.equal((await DL.getBaseline(db, approved.id))!.approval_note, "still editable");
    assert.equal((await DL.frontendState(db, projectId)).activeBaselineId, approved.id);
  } finally { close(); }
});

test("[DLK-05] a later artifact supersedes the approved design explicitly, and only one is ever active", async () => {
  const { db, close } = await createTestApp();
  try {
    const staff = await createStaff(db, "owner");
    const cust = await createCustomer(db);
    const { projectId, approved: first } = await approvedProject(db, cust.organizationId, staff.id);

    // A second artifact arrives. Until someone approves it, the first design is still the approved one.
    const a2 = await DL.recordArtifact(db, { projectId, organizationId: cust.organizationId, source: "upload", sha256: "2".repeat(64), sizeBytes: 30_000, uploadedBy: staff.id, scanStatus: "clean" });
    await DL.recordVerdict(db, a2.id, { status: "imported", framework: "vite" });
    const draft2 = await DL.recordBaseline(db, a2.id, baselineInput({ fingerprint: "9".repeat(64) }));

    assert.equal((await DL.approvedBaseline(db, projectId))!.id, first.id, "the approved design is NOT replaced by an upload");
    assert.equal(draft2.version, 2);

    const second = await DL.approveBaseline(db, draft2.id, { approvedBy: staff.id, note: "New homepage." });
    assert.equal(second.status, "approved");

    const old = (await DL.getBaseline(db, first.id))!;
    assert.equal(old.status, "superseded", "the previous one is superseded, not deleted");
    assert.equal(old.superseded_by, second.id);
    assert.ok(old.superseded_at);
    assert.equal(old.fingerprint, "a".repeat(64), "and its record is still intact");

    // Exactly one approved baseline per project, enforced by a partial unique index.
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM design_baselines WHERE project_id = ? AND status = 'approved'`).bind(projectId).first<{ n: number }>();
    assert.equal(n!.n, 1);
    assert.equal((await DL.frontendState(db, projectId)).activeBaselineId, second.id);

    // The replacement is attributable: an audit row names who did it and what it replaced.
    const log = await db.prepare(`SELECT details_json FROM audit_logs WHERE action = 'design_baseline.approved' ORDER BY rowid DESC LIMIT 1`).first<{ details_json: string }>();
    const d = JSON.parse(log!.details_json);
    assert.equal(d.supersededId, first.id);
    assert.equal(d.supersededVersion, 1);
  } finally { close(); }
});

test("[DLK-06] rollback restores the previous approved frontend without touching backend work", async () => {
  const { db, close } = await createTestApp();
  try {
    const staff = await createStaff(db, "owner");
    const cust = await createCustomer(db);
    const { projectId, approved: v1 } = await approvedProject(db, cust.organizationId, staff.id);

    const a2 = await DL.recordArtifact(db, { projectId, organizationId: cust.organizationId, source: "upload", sha256: "2".repeat(64), sizeBytes: 1, uploadedBy: staff.id, scanStatus: "clean" });
    await DL.recordVerdict(db, a2.id, { status: "imported", framework: "vite" });
    const v2 = await DL.approveBaseline(db, (await DL.recordBaseline(db, a2.id, baselineInput({ fingerprint: "7".repeat(64) }))).id, { approvedBy: staff.id });

    // Backend work exists for this project. Rolling the DESIGN back must not disturb it.
    const jobId = newId("bld");
    await db.prepare(
      `INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, strategy, trigger, created_at, updated_at, build_phase)
       VALUES (?, ?, ?, 'first_build', 0, ?, 'building', 'standard', 'payment', ?, ?, 'functionality')`,
    ).bind(jobId, projectId, cust.organizationId, `${projectId}:rollback`, nowIso(), nowIso()).run();

    await assert.rejects(() => DL.rollbackBaseline(db, projectId, { toBaselineId: v2.id, actorId: staff.id, reason: "x" }), /already the approved one/);
    await assert.rejects(() => DL.rollbackBaseline(db, projectId, { toBaselineId: v1.id, actorId: staff.id, reason: "  " }), /must record why/);

    const back = await DL.rollbackBaseline(db, projectId, { toBaselineId: v1.id, actorId: staff.id, reason: "The new hero was not signed off." });

    assert.equal(back.id, v1.id);
    assert.equal(back.status, "approved");
    assert.equal(back.fingerprint, "a".repeat(64), "the previously approved design, byte for byte");
    assert.equal(back.superseded_by, null, "and it is no longer marked as superseded");
    assert.equal((await DL.getBaseline(db, v2.id))!.status, "rolled_back");
    assert.equal((await DL.frontendState(db, projectId)).activeBaselineId, v1.id);
    assert.equal((await DL.frontendState(db, projectId)).designLocked, true, "the project is still design-locked");

    // §17.20: the backend work is untouched.
    const job = await db.prepare(`SELECT state, build_phase FROM build_jobs WHERE id = ?`).bind(jobId).first<{ state: string; build_phase: string }>();
    assert.equal(job!.state, "building", "the build is exactly where it was");
    assert.equal(job!.build_phase, "functionality");

    // And both versions are still on the record.
    assert.equal((await DL.listBaselines(db, projectId)).length, 2);
  } finally { close(); }
});

test("[DLK-07] a design-locked project cannot enter the retired autonomous design phase", async () => {
  const { db, close } = await createTestApp();
  try {
    const staff = await createStaff(db, "owner");
    const cust = await createCustomer(db);
    const { projectId } = await approvedProject(db, cust.organizationId, staff.id);

    const gate = await DL.designGenerationAllowed(db, projectId);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /design-locked/);
    assert.match(gate.reason, /autonomous frontend generation is retired/);

    // A new build for this project starts at design_locked, never at design.
    const jobId = newId("bld");
    await db.prepare(
      `INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, strategy, trigger, created_at, updated_at)
       VALUES (?, ?, ?, 'first_build', 0, ?, 'queued', 'standard', 'payment', ?, ?)`,
    ).bind(jobId, projectId, cust.organizationId, `${projectId}:gate`, nowIso(), nowIso()).run();
    assert.equal((await db.prepare(`SELECT build_phase FROM build_jobs WHERE id = ?`).bind(jobId).first<{ build_phase: string }>())!.build_phase, "design", "the column default");

    const applied = await DL.applyDesignLock(db, jobId, projectId);
    assert.equal(applied.applied, true);
    assert.equal(applied.phase, "design_locked");
    assert.ok(applied.baselineId, "the approved baseline is attached");
    assert.equal((await db.prepare(`SELECT build_phase FROM build_jobs WHERE id = ?`).bind(jobId).first<{ build_phase: string }>())!.build_phase, "design_locked");
    assert.equal((await DL.frontendState(db, projectId)).state, "building_backend");

    // The skip is recorded, with the reason, so nobody later wonders why the design phase never ran.
    const log = await db.prepare(`SELECT details_json FROM audit_logs WHERE action = 'builds.design_generation_skipped' ORDER BY rowid DESC LIMIT 1`).first<{ details_json: string }>();
    assert.ok(log, "an audit row explains it");
    assert.match(JSON.parse(log!.details_json).reason, /Founder supplied the frontend/);

    assert.equal((await DL.designPhaseAllowedForJob(db, jobId)).allowed, false);
  } finally { close(); }
});

test("[DLK-08] projects that predate this architecture are entirely unaffected", async () => {
  const { db, close } = await createTestApp();
  try {
    const cust = await createCustomer(db);
    const legacy = await project(db, cust.organizationId, "A project from before");

    const s = await DL.frontendState(db, legacy);
    assert.equal(s.designLocked, false);
    assert.equal(s.state, null, "no workflow state at all");
    assert.equal(s.activeBaselineId, null);

    const gate = await DL.designGenerationAllowed(db, legacy);
    assert.equal(gate.allowed, true, "the original build path still runs for it");
    assert.match(gate.reason, /predates the design-locked architecture/);

    // And the gate is a no-op on its builds.
    const jobId = newId("bld");
    await db.prepare(
      `INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, strategy, trigger, created_at, updated_at)
       VALUES (?, ?, ?, 'first_build', 0, ?, 'queued', 'standard', 'payment', ?, ?)`,
    ).bind(jobId, legacy, cust.organizationId, `${legacy}:legacy`, nowIso(), nowIso()).run();

    const applied = await DL.applyDesignLock(db, jobId, legacy);
    assert.equal(applied.applied, false);
    assert.equal((await db.prepare(`SELECT build_phase FROM build_jobs WHERE id = ?`).bind(jobId).first<{ build_phase: string }>())!.build_phase, "design", "still the design phase");
    assert.equal((await DL.frontendState(db, legacy)).state, null, "and still outside the new workflow");

    // The dashboard shows only projects that are in the new workflow.
    const rows = await DL.dashboard(db);
    assert.deepEqual(rows.filter((r) => r.projectId === legacy), []);
  } finally { close(); }
});

test("[DLK-09] the dashboard shows what §13 asks for, from one query", async () => {
  const { db, close } = await createTestApp();
  try {
    const staff = await createStaff(db, "owner");
    const cust = await createCustomer(db);
    const { projectId } = await approvedProject(db, cust.organizationId, staff.id);

    const rows = await DL.dashboard(db);
    const row = rows.find((r) => r.projectId === projectId)!;
    assert.ok(row, "the design-locked project is listed");

    assert.equal(row.projectName, "Summit Haul Co.");
    assert.equal(row.designLocked, true);
    assert.equal(row.state, "design_locked");
    assert.equal(row.artifactVersion, 1);
    assert.equal(row.artifactStatus, "imported");
    assert.equal(row.framework, "vite");
    assert.equal(row.scanStatus, "clean");
    assert.equal(row.baselineVersion, 1);
    assert.equal(row.baselineStatus, "approved");
    assert.ok(row.approvedAt);
    assert.equal(row.fingerprint, "a".repeat(64));
    assert.equal(row.routes, 2);
    assert.equal(row.interactionsNeedingBackend, 1, "the quote form; the working menu toggle is not counted");

    // Scoped by organization when asked.
    assert.equal((await DL.dashboard(db, { organizationId: cust.organizationId })).length, 1);
    assert.equal((await DL.dashboard(db, { organizationId: "org_nobody" })).length, 0);
  } finally { close(); }
});

test("[DLK-10] every workflow state in §13 is reachable and nothing else is", async () => {
  const { db, close } = await createTestApp();
  try {
    const cust = await createCustomer(db);
    const projectId = await project(db, cust.organizationId);

    for (const s of DL.FRONTEND_STATES) {
      await DL.setFrontendState(db, projectId, s);
      assert.equal((await DL.frontendState(db, projectId)).state, s);
    }
    await assert.rejects(() => DL.setFrontendState(db, projectId, "whatever" as DL.FrontendState), /unknown frontend state/);

    // The nine states the Founder named, in order, plus the intervention states.
    assert.deepEqual(DL.FRONTEND_STATES.slice(0, 9), [
      "awaiting_frontend", "validating_artifact", "awaiting_approval", "design_locked",
      "building_backend", "integrating", "verifying", "ready_for_review", "approved_for_release",
    ]);
    assert.ok(DL.LOCKED_STATES.includes("design_locked"));
    assert.ok(!DL.LOCKED_STATES.includes("awaiting_frontend"));
  } finally { close(); }
});

test("[DLK-11] an approved frontend attaches to an EXISTING project in place, preserving its work", async () => {
  // The general capability: a project whose build already ran and left real work behind — a workspace, a
  // checkpoint, source commits, an agent session. Accepting a frontend artifact must attach to THAT project
  // rather than requiring a new one, and must not disturb anything already there. Any project carrying prior
  // build work takes this path; nothing here is specific to one customer.
  const { db, close } = await createTestApp();
  try {
    const staff = await createStaff(db, "owner");
    const cust = await createCustomer(db);
    const projectId = await project(db, cust.organizationId, "A project with prior build work");

    const jobId = newId("bld");
    await db.prepare(
      `INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, state_reason, strategy,
         package_id, trigger, attempts, turns, agent_session_id, workspace_ref, checkpoint_key, source_commit,
         build_phase, created_at, updated_at, finished_at)
       VALUES (?, ?, ?, 'first_build', 0, ?, 'failed', 'Repair loop stalled', 'standard', 'business', 'payment', 1, 200,
         ?, ?, ?, ?, 'design', ?, ?, ?)`,
    ).bind(jobId, projectId, cust.organizationId, `${projectId}:first`, "ses_prior", "ws_prior",
      "builds/bld_prior/ckpt-36.tgz", "c0ffee1", nowIso(), nowIso(), nowIso()).run();

    const before = (await db.prepare(`SELECT * FROM build_jobs WHERE id = ?`).bind(jobId).first<Record<string, unknown>>())!;

    // 1. The Founder's replacement frontend is attached to the SAME project.
    const artifact = await DL.recordArtifact(db, {
      projectId, organizationId: cust.organizationId, source: "upload",
      sha256: "5".repeat(64), sizeBytes: 26_300, uploadedBy: staff.id, scanStatus: "clean",
    });
    assert.equal(artifact.project_id, projectId, "no new project, no new customer, no new order");
    assert.equal(artifact.version, 1);

    // 2. It is imported and measured, then a person approves it.
    await DL.recordVerdict(db, artifact.id, { status: "imported", framework: "vite", archiveRoot: "summit-haul-frontend", actorId: staff.id });
    const draft = await DL.recordBaseline(db, artifact.id, baselineInput({ fingerprint: "239cc2854af8f6ee".padEnd(64, "0") }));
    const approved = await DL.approveBaseline(db, draft.id, { approvedBy: staff.id, note: "The replacement frontend." });

    assert.equal(approved.status, "approved");
    assert.equal((await DL.frontendState(db, projectId)).designLocked, true);

    // 3. THE POINT OF §16: every piece of the existing build is exactly as it was.
    const after = (await db.prepare(`SELECT * FROM build_jobs WHERE id = ?`).bind(jobId).first<Record<string, unknown>>())!;
    for (const column of ["state", "state_reason", "attempts", "turns", "agent_session_id", "workspace_ref",
      "checkpoint_key", "source_commit", "package_id", "created_at", "finished_at"]) {
      assert.equal(after[column], before[column], `${column} is unchanged`);
    }
    assert.equal(after.checkpoint_key, "builds/bld_prior/ckpt-36.tgz", "the checkpoint still points at the saved work");

    // 4. Whatever the earlier build produced did NOT become the baseline. The only baseline is the artifact.
    const baselines = await DL.listBaselines(db, projectId);
    assert.equal(baselines.length, 1);
    assert.equal(baselines[0].artifact_id, artifact.id);

    // 5. Retrying that failed build now continues as BACKEND work. Without the gate on the retry path it would
    //    resume at `design` and start inventing a frontend again, on a project whose design is already approved.
    //    This is the one route that creates no new build row, so the creation-time gate never runs for it.
    assert.equal(after.build_phase, "design", "it is still sitting in the retired phase");
    const applied = await DL.applyDesignLock(db, jobId, projectId);
    assert.equal(applied.applied, true);
    assert.equal(applied.baselineId, approved.id, "and the approved baseline is attached to it");
    assert.equal(
      (await db.prepare(`SELECT build_phase FROM build_jobs WHERE id = ?`).bind(jobId).first<{ build_phase: string }>())!.build_phase,
      "design_locked",
      "the retried build starts from the frozen design, not from a blank page",
    );
    assert.equal((await DL.frontendState(db, projectId)).state, "building_backend");

    // 6. And the saved work is STILL untouched after the conversion.
    const converted = (await db.prepare(`SELECT * FROM build_jobs WHERE id = ?`).bind(jobId).first<Record<string, unknown>>())!;
    assert.equal(converted.checkpoint_key, before.checkpoint_key);
    assert.equal(converted.agent_session_id, before.agent_session_id);
    assert.equal(converted.turns, 200, "the 200 turns it already spent are still on the record");
  } finally { close(); }
});

// ── authenticated delivery to the runner ────────────────────────────────────────────────────────────────────

/** A build holding a live lease, which is the only authorization the delivery endpoint accepts. */
async function leasedBuild(db: Db, projectId: string, organizationId: string) {
  const jobId = newId("bld");
  const at = nowIso();
  await db.prepare(
    `INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, strategy, trigger, created_at, updated_at)
     VALUES (?, ?, ?, 'first_build', 0, ?, 'building', 'standard', 'payment', ?, ?)`,
  ).bind(jobId, projectId, organizationId, `${projectId}:${jobId}`, at, at).run();
  return { id: jobId, project_id: projectId, organization_id: organizationId };
}

/** An artifact whose bytes are really in storage, scanned clean, and whose baseline a person approved. */
async function approvedArtifactWithBytes(t: Awaited<ReturnType<typeof createTestApp>>, projectId: string, orgId: string, approverId: string, bytes: Uint8Array) {
  const sha = await sha256Hex(bytes);
  const fileId = newId("file");
  const key = `org/${orgId}/${projectId}/${fileId}.zip`;
  await t.storage.put(key, bytes, "application/zip");
  await t.db.prepare(
    `INSERT INTO files (id, organization_id, project_id, r2_key, filename, content_type, size_bytes, sha256, scan_status, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, 'frontend.zip', 'application/zip', ?, ?, 'clean', ?, ?)`,
  ).bind(fileId, orgId, projectId, key, bytes.length, sha, approverId, nowIso()).run();

  const artifact = await DL.recordArtifact(t.db, {
    projectId, organizationId: orgId, source: "upload", fileId, sha256: sha, sizeBytes: bytes.length,
    uploadedBy: approverId, scanStatus: "clean",
  });
  await DL.recordVerdict(t.db, artifact.id, { status: "imported", framework: "vite", archiveRoot: "site" });
  const draft = await DL.recordBaseline(t.db, artifact.id, baselineInput());
  const approved = await DL.approveBaseline(t.db, draft.id, { approvedBy: approverId });
  return { artifact, approved, fileId, sha, key };
}

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);

test("[DEL-01] the runner is given the approved artifact, verified byte for byte", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const { artifact, approved, sha } = await approvedArtifactWithBytes(t, projectId, cust.organizationId, staff.id, ZIP);
    const job = await leasedBuild(t.db, projectId, cust.organizationId);

    const d = await DL.deliverApprovedArtifact(t.db, t.storage, job);

    assert.equal(d.artifactId, artifact.id);
    assert.equal(d.version, 1);
    assert.equal(d.baselineId, approved.id, "the delivery names the baseline that authorises it");
    assert.equal(d.designFingerprint, approved.fingerprint);
    assert.equal(d.sha256, sha);
    assert.equal(d.framework, "vite");
    assert.equal(d.archiveRoot, "site");
    assert.equal(d.scanned, true);
    assert.equal(d.scanStatus, "clean");

    // The bytes really are the artifact.
    const got = Uint8Array.from(atob(d.base64), (c) => c.charCodeAt(0));
    assert.deepEqual([...got], [...ZIP]);
    assert.equal(await sha256Hex(got), sha, "and they hash to the approved artifact");

    // Delivery is recorded, with the job that received it.
    const log = await t.db.prepare(`SELECT details_json FROM audit_logs WHERE action = 'frontend_artifact.delivered' ORDER BY rowid DESC LIMIT 1`).first<{ details_json: string }>();
    assert.equal(JSON.parse(log!.details_json).jobId, job.id);
  } finally { t.close(); }
});

test("[DEL-02] a build cannot reach another project's frontend", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const a = await createCustomer(t.db, "a@example.com", "Customer A");
    const b = await createCustomer(t.db, "b@example.com", "Customer B");
    const projectA = await project(t.db, a.organizationId, "A");
    const projectB = await project(t.db, b.organizationId, "B");
    await approvedArtifactWithBytes(t, projectA, a.organizationId, staff.id, ZIP);

    // B's build has a lease, and B has no approved frontend. It gets nothing — not A's.
    const jobB = await leasedBuild(t.db, projectB, b.organizationId);
    await assert.rejects(() => DL.deliverApprovedArtifact(t.db, t.storage, jobB), (e: DL.DeliveryError) => {
      assert.match(e.message, /no approved design baseline/);
      assert.equal(e.status, 409);
      return true;
    });

    // Even with A's project id in the job row, the artifact still resolves from the job's own project — the
    // request never names an artifact, so there is nothing to tamper with.
    const jobA = await leasedBuild(t.db, projectA, a.organizationId);
    const d = await DL.deliverApprovedArtifact(t.db, t.storage, jobA);
    assert.equal(d.sha256, await sha256Hex(ZIP));
  } finally { t.close(); }
});

test("[DEL-03] a later, unapproved upload cannot reach a running build", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const first = await approvedArtifactWithBytes(t, projectId, cust.organizationId, staff.id, ZIP);

    // A second artifact is uploaded and imported, but nobody approves it.
    const other = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9]);
    const sha2 = await sha256Hex(other);
    const fileId = newId("file");
    const key = `org/${cust.organizationId}/${projectId}/${fileId}.zip`;
    await t.storage.put(key, other, "application/zip");
    await t.db.prepare(
      `INSERT INTO files (id, organization_id, project_id, r2_key, filename, content_type, size_bytes, sha256, scan_status, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, 'new.zip', 'application/zip', ?, ?, 'clean', ?, ?)`,
    ).bind(fileId, cust.organizationId, projectId, key, other.length, sha2, staff.id, nowIso()).run();
    const second = await DL.recordArtifact(t.db, { projectId, organizationId: cust.organizationId, source: "upload", fileId, sha256: sha2, sizeBytes: other.length, uploadedBy: staff.id, scanStatus: "clean" });
    await DL.recordVerdict(t.db, second.id, { status: "imported", framework: "vite" });
    await DL.recordBaseline(t.db, second.id, baselineInput({ fingerprint: "b".repeat(64) }));

    const job = await leasedBuild(t.db, projectId, cust.organizationId);
    const d = await DL.deliverApprovedArtifact(t.db, t.storage, job);

    assert.equal(d.artifactId, first.artifact.id, "the APPROVED artifact, not the newest one");
    assert.equal(d.sha256, first.sha);
    assert.notEqual(d.sha256, sha2);
  } finally { t.close(); }
});

test("[DEL-04] an artifact that is not clean is never delivered, whatever it was when it was recorded", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const { fileId } = await approvedArtifactWithBytes(t, projectId, cust.organizationId, staff.id, ZIP);
    const job = await leasedBuild(t.db, projectId, cust.organizationId);

    // It was clean when it was approved. A later scan flags it.
    await t.db.prepare(`UPDATE files SET scan_status = 'infected' WHERE id = ?`).bind(fileId).run();
    await assert.rejects(() => DL.deliverApprovedArtifact(t.db, t.storage, job), /not clean \(scan status "infected"\)/);

    await t.db.prepare(`UPDATE files SET scan_status = 'pending' WHERE id = ?`).bind(fileId).run();
    await assert.rejects(() => DL.deliverApprovedArtifact(t.db, t.storage, job), /not clean \(scan status "pending"\)/);

    // A deleted file is gone, not silently skipped.
    await t.db.prepare(`UPDATE files SET scan_status = 'clean', deleted_at = ? WHERE id = ?`).bind(nowIso(), fileId).run();
    await assert.rejects(() => DL.deliverApprovedArtifact(t.db, t.storage, job), (e: DL.DeliveryError) => {
      assert.equal(e.status, 410);
      return true;
    });
  } finally { t.close(); }
});

test("[DEL-05] bytes swapped in storage are caught by the hash, not served", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const { key } = await approvedArtifactWithBytes(t, projectId, cust.organizationId, staff.id, ZIP);
    const job = await leasedBuild(t.db, projectId, cust.organizationId);

    // The object is replaced without the row changing — the case a hash recorded in the database exists for.
    await t.storage.put(key, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef]), "application/zip");

    await assert.rejects(() => DL.deliverApprovedArtifact(t.db, t.storage, job), /do not hash to the approved artifact/);
  } finally { t.close(); }
});

test("[DEL-06] a project with no approved design gets nothing, and an internal fixture is not delivered this way", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const job = await leasedBuild(t.db, projectId, cust.organizationId);

    // Measured but not approved: still nothing.
    await assert.rejects(() => DL.deliverApprovedArtifact(t.db, t.storage, job), /no approved design baseline/);

    const fixture = await DL.recordArtifact(t.db, { projectId, organizationId: cust.organizationId, source: "internal_fixture", sha256: "f".repeat(64), sizeBytes: 10 });
    await DL.recordVerdict(t.db, fixture.id, { status: "imported", framework: "static" });
    const draft = await DL.recordBaseline(t.db, fixture.id, baselineInput());
    await DL.approveBaseline(t.db, draft.id, { approvedBy: staff.id });

    // A repository fixture has no uploaded file and nothing scanned it, so it is refused rather than served
    // with a claim it is clean.
    await assert.rejects(() => DL.deliverApprovedArtifact(t.db, t.storage, job), /internal fixture with no stored file/);
  } finally { t.close(); }
});

// ── the staff screens ───────────────────────────────────────────────────────────────────────────────────────

test("[DLR-01] the dashboard and the project page render what a person needs to decide", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const artifact = await DL.recordArtifact(t.db, {
      projectId, organizationId: cust.organizationId, source: "upload", sha256: "1".repeat(64),
      sizeBytes: 26_000, uploadedBy: staff.id, scanStatus: "clean",
    });
    await DL.recordVerdict(t.db, artifact.id, { status: "imported", framework: "vite" });
    await DL.recordBaseline(t.db, artifact.id, baselineInput());

    const client = await t.client().login(staff.email, TEST_PASSWORD, staff.secret);
    const list = await client.get("/staff/builds/frontends");
    assert.equal(list.status, 200);
    const listHtml = await list.text();
    assert.match(listHtml, /Summit Haul Co\./);
    assert.match(listHtml, /awaiting approval/, "the state a person has to act on");

    const page = await client.get(`/staff/builds/frontends/${projectId}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /scanned clean/, "the scan verdict is shown, not assumed");
    assert.match(html, /vite/);
    assert.match(html, /Approve and lock/, "an owner is offered the approval");
    assert.match(html, /waiting for a person to approve it/);
    assert.match(html, /never be edited/, "the page says what approval means");
  } finally { t.close(); }
});

test("[DLR-02] approval is an owner's act; a read-only member cannot take it", async () => {
  const t = await createTestApp();
  try {
    const owner = await createStaff(t.db, "owner");
    const viewer = await createStaff(t.db, "support", "support@crestmont.test");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const artifact = await DL.recordArtifact(t.db, { projectId, organizationId: cust.organizationId, source: "upload", sha256: "2".repeat(64), sizeBytes: 10, uploadedBy: owner.id, scanStatus: "clean" });
    await DL.recordVerdict(t.db, artifact.id, { status: "imported", framework: "vite" });
    const draft = await DL.recordBaseline(t.db, artifact.id, baselineInput());

    // Someone without `builds.configure` sees the page but is not offered the control.
    const readOnly = await t.client().login(viewer.email, TEST_PASSWORD, viewer.secret);
    const seen = await readOnly.get(`/staff/builds/frontends/${projectId}`);
    if (seen.status === 200) {
      const html = await seen.text();
      assert.ok(!/Approve and lock/.test(html), "the approval control is not offered");
      assert.match(html, /do not have permission/);
    } else {
      assert.ok([302, 303, 403].includes(seen.status), `or the page itself is refused (${seen.status})`);
    }

    // And posting the form directly is refused, not merely hidden.
    const forced = await readOnly.post(`/staff/builds/frontends/${projectId}/baselines/${draft.id}/approve`, {});
    assert.ok([302, 303, 403].includes(forced.status), `a hidden control is not a permission check (${forced.status})`);
    assert.equal((await DL.getBaseline(t.db, draft.id))!.status, "draft", "nothing was approved");

    // The owner can.
    const asOwner = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);
    const ok = await asOwner.post(`/staff/builds/frontends/${projectId}/baselines/${draft.id}/approve`, { note: "Looks right." });
    assert.ok([302, 303].includes(ok.status), `approval redirects back (${ok.status})`);
    const approved = (await DL.getBaseline(t.db, draft.id))!;
    assert.equal(approved.status, "approved");
    assert.equal(approved.approved_by, owner.id, "attributed to the person who took it");
    assert.equal((await DL.frontendState(t.db, projectId)).designLocked, true);
  } finally { t.close(); }
});

test("[DLR-03] state.json reports the gate, the artifacts and the baselines", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const artifact = await DL.recordArtifact(t.db, { projectId, organizationId: cust.organizationId, source: "upload", sha256: "3".repeat(64), sizeBytes: 10, uploadedBy: staff.id, scanStatus: "clean" });
    await DL.recordVerdict(t.db, artifact.id, { status: "imported", framework: "react-ts" });
    const draft = await DL.recordBaseline(t.db, artifact.id, baselineInput());

    const client = await t.client().login(staff.email, TEST_PASSWORD, staff.secret);
    let body = await (await client.get(`/staff/builds/frontends/${projectId}/state`)).json() as Record<string, unknown>;
    assert.equal(body.designLocked, false);
    assert.equal(body.designGenerationAllowed, true, "before approval the old path is still the one that would run");
    assert.equal((body.artifacts as unknown[]).length, 1);
    assert.equal((body.baselines as { status: string }[])[0].status, "draft");

    await DL.approveBaseline(t.db, draft.id, { approvedBy: staff.id });
    body = await (await client.get(`/staff/builds/frontends/${projectId}/state`)).json() as Record<string, unknown>;
    assert.equal(body.designLocked, true);
    assert.equal(body.designGenerationAllowed, false, "approval closes the retired path for this project");
    assert.match(String(body.designGenerationReason), /autonomous frontend generation is retired/);
    assert.equal((body.baselines as { status: string }[])[0].status, "approved");
  } finally { t.close(); }
});

test("[DLR-04] an anonymous visitor reaches none of it", async () => {
  const t = await createTestApp();
  try {
    const anon = t.client();
    for (const p of ["/staff/builds/frontends", "/staff/builds/frontends/prj_x", "/staff/builds/frontends/prj_x/state.json"]) {
      const r = await anon.get(p);
      assert.ok([302, 303, 401, 403, 404].includes(r.status), `${p} is not public (${r.status})`);
    }
  } finally { t.close(); }
});

test("[DLK-12] a scan verdict reaches the artifact: clean is shown as clean, infected quarantines the project, and neither undoes a person's progress", async () => {
  // Found by running the whole chain against a real ClamAV daemon (scripts/design-locked-e2e.ts). The scanner
  // wrote its verdict to `files` and nothing told the frontend artifact, so a scanned artifact showed "pending" on
  // the dashboard for ever and an infected one never entered §13's `artifact_quarantined`. Delivery was never at
  // risk — it re-reads the live files row — but every human-facing signal was wrong.
  const t = await createTestApp();
  const staff = await createStaff(t.db, "owner", "dlk12@crestmont.test");
  const org = (await createCustomer(t.db, "dlk12-customer@example.com")).organizationId;

  /** A file row plus an artifact pointing at it, as the staff upload route creates them. */
  const upload = async (projectId: string) => {
    const fileId = newId("file");
    const at = nowIso();
    const sha = await sha256Hex(`bytes-${fileId}`);
    await t.db.prepare(
      `INSERT INTO files (id, organization_id, project_id, filename, r2_key, content_type, size_bytes, sha256, scan_status, uploaded_by, created_at)
       VALUES (?, ?, ?, 'frontend.zip', ?, 'application/zip', 2048, ?, 'pending', ?, ?)`,
    ).bind(fileId, org, projectId, `frontend-artifacts/${fileId}.zip`, sha, staff.id, at).run();
    const artifact = await DL.recordArtifact(t.db, {
      projectId, organizationId: org, source: "upload", fileId, sha256: sha, sizeBytes: 2048, uploadedBy: staff.id, scanStatus: "pending",
    });
    return { fileId, artifact, sha };
  };

  const verdict = async (fileId: string, sha: string, v: "clean" | "infected" | "failed", signature: string | null = null) =>
    MS.recordScanResult(t.db, { fileId, verdict: v, engine: "ClamAV 1.5.1", scannedSha256: sha, signature, scannedAt: nowIso() });

  try {
    // ── clean ───────────────────────────────────────────────────────────────────────────────────────────────────
    const cleanProject = await project(t.db, org, "Clean upload");
    const clean = await upload(cleanProject);
    assert.equal((await DL.getArtifact(t.db, clean.artifact.id))!.scan_status, "pending", "it starts pending");

    await verdict(clean.fileId, clean.sha, "clean");
    assert.equal((await DL.getArtifact(t.db, clean.artifact.id))!.scan_status, "clean", "the dashboard now shows what the scanner found");
    assert.notEqual((await DL.frontendState(t.db, cleanProject)).state, "artifact_quarantined", "a clean verdict quarantines nothing");

    // ── infected ────────────────────────────────────────────────────────────────────────────────────────────────
    const badProject = await project(t.db, org, "Infected upload");
    const bad = await upload(badProject);
    await verdict(bad.fileId, bad.sha, "infected", "Win.Test.EICAR_HDB-1");

    const quarantined = (await DL.getArtifact(t.db, bad.artifact.id))!;
    assert.equal(quarantined.scan_status, "infected");
    assert.equal(quarantined.status, "quarantined", "the artifact itself is quarantined, not merely flagged");
    assert.equal((await DL.frontendState(t.db, badProject)).state, "artifact_quarantined", "§13's quarantine state is actually entered");
    assert.match(quarantined.problems_json, /infected/i, "the reason is recorded for whoever reads it");

    // ── a re-scan must not undo a person's approval ─────────────────────────────────────────────────────────────
    // The regression this guards: using recordVerdict for every verdict would have reset an imported, approved
    // artifact to "validating" the next time a routine re-scan came back clean.
    const liveProject = await project(t.db, org, "Approved and re-scanned");
    const live = await upload(liveProject);
    await verdict(live.fileId, live.sha, "clean");
    await DL.recordVerdict(t.db, live.artifact.id, { status: "imported", framework: "vite", archiveRoot: "site" });
    const draft = await DL.recordBaseline(t.db, live.artifact.id, baselineInput());
    await DL.approveBaseline(t.db, draft.id, { approvedBy: staff.id });
    assert.equal((await DL.frontendState(t.db, liveProject)).state, "design_locked");

    await verdict(live.fileId, live.sha, "clean");
    assert.equal((await DL.frontendState(t.db, liveProject)).state, "design_locked", "a re-scan does not drag an approved project backwards");
    assert.equal((await DL.getArtifact(t.db, live.artifact.id))!.status, "imported", "nor the artifact");

    // An infected re-scan of an already-approved artifact DOES quarantine it: that is not progress being undone,
    // that is new information about the same bytes.
    await verdict(live.fileId, live.sha, "infected", "Win.Test.EICAR_HDB-1");
    assert.equal((await DL.frontendState(t.db, liveProject)).state, "artifact_quarantined");
  } finally { await t.close(); }
});

test("[DLR-05] the project page is enough to run an artifact through: the inventory, the artifact, rejection, and a build that refuses honestly", async () => {
  // The staff page used to end at the baselines table. A person could upload and approve, and then had nothing:
  // no view of what the browser actually found, no way to reject a wrong artifact, no way to start the backend
  // job, and no sight of what any of the three gates decided. These are the controls that make the workflow
  // usable, and each is asserted to do something rather than merely to be on the page.
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const fileId = newId("file");
    const at = nowIso();
    const sha = await sha256Hex("artifact-bytes");
    await t.db.prepare(
      `INSERT INTO files (id, organization_id, project_id, filename, r2_key, content_type, size_bytes, sha256, scan_status, uploaded_by, created_at)
       VALUES (?, ?, ?, 'frontend.zip', ?, 'application/zip', 30569, ?, 'clean', ?, ?)`,
    ).bind(fileId, cust.organizationId, projectId, `frontend-artifacts/${fileId}.zip`, sha, staff.id, at).run();

    const artifact = await DL.recordArtifact(t.db, {
      projectId, organizationId: cust.organizationId, source: "upload", fileId, sha256: sha,
      sizeBytes: 30_569, uploadedBy: staff.id, scanStatus: "clean",
    });
    await DL.recordVerdict(t.db, artifact.id, { status: "imported", framework: "vite" });
    // A measurement with a real shape: two pages, one inert form, one thing that could not be read.
    await DL.recordBaseline(t.db, artifact.id, baselineInput({
      routes: [{ page: "index", title: "Home" }, { page: "quote", title: "Get a quote" }],
      interactions: [
        { page: "quote", element: "form#quote-request", label: "Quote request", needsBackend: true, functional: false },
        { page: "index", element: "button.nav-toggle", label: "Menu", needsBackend: false, functional: true },
        { page: "index", element: "table.prices", label: "Price table", needsBackend: false, functional: false, undetermined: true },
      ],
    }));

    // Approved, so the page is past "approve one above" and on to whether a build can start.
    const draft = (await DL.listBaselines(t.db, projectId)).find((b) => b.status === "draft")!;
    await DL.approveBaseline(t.db, draft.id, { approvedBy: staff.id });

    const client = await t.client().login(staff.email, TEST_PASSWORD, staff.secret);
    const page = async () => (await client.get(`/staff/builds/frontends/${projectId}`)).text();

    // ── what the browser found ────────────────────────────────────────────────────────────────────────────────
    let body = await page();
    assert.match(body, /The imported frontend/, "the measurement is shown, not just its fingerprint");
    assert.match(body, /form#quote-request/, "the inert form is named as waiting on a backend");
    assert.doesNotMatch(body, /button\.nav-toggle[\s\S]{0,400}Waiting on a backend/, "working client-side behaviour is not listed as work");
    assert.match(body, /Could not be read from the markup/, "an undetermined element is a question, not an inference");
    assert.match(body, /table\.prices/);

    // ── the artifact itself ───────────────────────────────────────────────────────────────────────────────────
    assert.match(body, new RegExp(`/files/${fileId}`), "the exact submitted bytes are downloadable");
    assert.match(body, /no stored screenshots to show/, "it says plainly that there are no images, rather than implying there are");

    // ── a build that will not start, and says why ─────────────────────────────────────────────────────────────
    // This project has no paid order and no intake, so the platform's own rule refuses it. The page must give the
    // reason rather than a button that fails.
    assert.match(body, /will not queue a build yet/, "the refusal is explained on the page");
    const refused = await client.post(`/staff/builds/frontends/${projectId}/build`, {});
    assert.equal(refused.status, 409, "and the endpoint refuses it too, with the same rule");
    assert.match(await refused.text(), /No build was queued/);
    assert.equal(
      (await t.db.prepare(`SELECT COUNT(*) AS n FROM build_jobs WHERE project_id = ?`).bind(projectId).first<{ n: number }>())!.n,
      0, "nothing was queued");

    // ── rejecting the artifact ────────────────────────────────────────────────────────────────────────────────
    const noReason = await client.post(`/staff/builds/frontends/${projectId}/artifacts/${artifact.id}/reject`, {});
    assert.equal(noReason.status, 422, "a rejection without a reason is not a decision anyone can act on");

    const rejected = await client.post(`/staff/builds/frontends/${projectId}/artifacts/${artifact.id}/reject`, { reason: "wrong business" });
    assert.ok([302, 303].includes(rejected.status), `rejection accepted (${rejected.status})`);
    assert.equal((await DL.getArtifact(t.db, artifact.id))!.status, "rejected");
    assert.equal((await DL.frontendState(t.db, projectId)).state, "artifact_rejected");
    assert.match((await DL.getArtifact(t.db, artifact.id))!.problems_json, /wrong business/, "the reason is kept");

    body = await page();
    assert.match(body, /artifact rejected/, "the state is visible afterwards");

    // Another tenant's artifact cannot be rejected through this project's path.
    const other = await createCustomer(t.db, "other-tenant@example.com");
    const otherProject = await project(t.db, other.organizationId, "Someone else");
    const strayed = await client.post(`/staff/builds/frontends/${otherProject}/artifacts/${artifact.id}/reject`, { reason: "x" });
    assert.equal(strayed.status, 404, "an artifact belonging to another project is not reachable through this one");
  } finally { await t.close(); }
});

// ── the way in ────────────────────────────────────────────────────────────────────────────────────────────────
//
// The upload endpoint has always taken a project id, and the only screen that offered one was a project's own
// page -- which does not exist until an artifact has been uploaded against it. So a first artifact could not be
// uploaded at all without making database rows by hand or going through a customer purchase. These cover the
// screen that fixes that, and every refusal it has to keep.

/**
 * A real ZIP with an entry in it.
 *
 * An end-of-central-directory record on its own is a valid empty ZIP and the platform refuses it: `validateUpload`
 * requires a local file header (PK), which an empty archive does not have. That refusal is right -- a
 * frontend with no files in it is not a frontend -- so the fixture is a ZIP that actually contains something.
 */
function zipFile(name = "frontend.zip"): File {
  const zip = makeZip([{ path: "index.html", body: Buffer.from("<!doctype html><title>t</title>") }]);
  // Copied into a plain Uint8Array: a Node Buffer may be backed by a SharedArrayBuffer, which BlobPart is not.
  return new File([new Uint8Array(zip)], name, { type: "application/zip" });
}

test("[DLU-01] the dashboard offers the upload, and only to someone who may configure builds", async () => {
  const t = await createTestApp();
  try {
    const owner = await createStaff(t.db, "owner");
    const asOwner = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);

    const page = await asOwner.get("/staff/builds/frontends");
    assert.equal(page.status, 200);
    const text = await page.text();
    assert.match(text, /Upload frontend artifact/, "the control is on the dashboard, not buried inside a project");
    assert.match(text, /\/staff\/builds\/frontends\/new/, "and it points at the upload screen");
    assert.match(text, /nothing needs to be set up first/i, "an empty dashboard is a starting point, not a dead end");

    const viewer = await createStaff(t.db, "support");
    const asViewer = await t.client().login(viewer.email, TEST_PASSWORD, viewer.secret);
    const seen = await asViewer.get("/staff/builds/frontends");
    if (seen.status === 200) {
      assert.ok(!/Upload frontend artifact/.test(await seen.text()), "a reader is not offered the upload");
    }
  } finally { t.close(); }
});

test("[DLU-02] a first artifact goes up with no project, no order and nothing seeded by hand", async () => {
  const t = await createTestApp();
  try {
    const owner = await createStaff(t.db, "owner");
    const asOwner = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);

    const form = await asOwner.get("/staff/builds/frontends/new");
    assert.equal(form.status, 200);
    const formText = await form.text();
    assert.match(formText, /name="artifact"/, "there is a file field");
    assert.match(formText, /enctype="multipart\/form-data"/);
    assert.match(formText, /scanned/i, "and it says the ZIP is scanned before anything in it is read");

    const res = await asOwner.post("/staff/builds/frontends/new", {
      target: "new", name: "Northgate Dental test", artifact: zipFile(),
    });
    assert.equal(res.status, 303, (await res.text()).slice(0, 300));

    const location = res.headers.get("location") ?? "";
    const projectId = location.split("/").pop() ?? "";
    assert.match(projectId, /^prj_/, `redirected to ${location}`);

    const project = await t.db.prepare(
      `SELECT p.name, p.order_id, org.kind, org.name AS orgName
         FROM projects p JOIN organizations org ON org.id = p.organization_id WHERE p.id = ?`,
    ).bind(projectId).first<{ name: string; order_id: string | null; kind: string; orgName: string }>();
    assert.equal(project?.name, "Northgate Dental test");
    assert.equal(project?.order_id, null, "a test project has no order behind it, which is the point");
    assert.equal(project?.kind, "internal", "and belongs to an internal organization");
    assert.match(project?.orgName ?? "", /Artifact Builder tests/, "named so it is never mistaken for paid work");

    const artifact = await DL.latestArtifact(t.db, projectId);
    assert.ok(artifact, "the artifact was recorded against the new project");
    assert.equal(artifact?.scan_status, "pending", "and it is not clean until a scanner says so");
    const file = await t.db.prepare(`SELECT scan_status FROM files WHERE id = ?`).bind(artifact?.file_id)
      .first<{ scan_status: string }>();
    assert.equal(file?.scan_status, "pending", "the platform's own upload path set that, not this route");

    const dash = await asOwner.get("/staff/builds/frontends");
    assert.match(await dash.text(), /Northgate Dental test/, "and the project is on the dashboard now");

    const created = await t.db.prepare(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'project.created' AND subject_id = ?`,
    ).bind(projectId).first<{ n: number }>();
    assert.equal(created?.n, 1, "creating it is audited like any other creation");
  } finally { t.close(); }
});

test("[DLU-03] a refused file leaves nothing behind", async () => {
  const t = await createTestApp();
  try {
    const owner = await createStaff(t.db, "owner");
    const asOwner = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);
    const before = (await t.db.prepare(`SELECT COUNT(*) AS n FROM projects`).first<{ n: number }>())?.n ?? 0;

    const wrongName = await asOwner.post("/staff/builds/frontends/new", {
      target: "new", name: "Should not exist",
      artifact: new File([new TextEncoder().encode("not a zip at all")], "frontend.txt", { type: "text/plain" }),
    });
    assert.equal(wrongName.status, 422, (await wrongName.text()).slice(0, 200));

    // Bytes that are not a ZIP under a name that says they are: storeUpload is the authority and still refuses,
    // which is the case that needs the project to be taken back.
    const lying = await asOwner.post("/staff/builds/frontends/new", {
      target: "new", name: "Should not exist either",
      artifact: new File([new TextEncoder().encode("not a zip at all")], "frontend.zip", { type: "application/zip" }),
    });
    assert.equal(lying.status, 422, (await lying.text()).slice(0, 200));

    const after = (await t.db.prepare(`SELECT COUNT(*) AS n FROM projects`).first<{ n: number }>())?.n ?? 0;
    assert.equal(after, before, "a wrong file does not leave a project behind on every attempt");
    const named = await t.db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE name LIKE 'Should not exist%'`)
      .first<{ n: number }>();
    assert.equal(named?.n, 0);
  } finally { t.close(); }
});

test("[DLU-04] a customer and a staff reader cannot upload", async () => {
  const t = await createTestApp();
  try {
    const cust = await createCustomer(t.db);
    const reader = await createStaff(t.db, "support");
    const asCustomer = await t.client().login(cust.email, TEST_PASSWORD, cust.secret);
    const asReader = await t.client().login(reader.email, TEST_PASSWORD, reader.secret);

    for (const [who, c] of [["customer", asCustomer], ["reader", asReader]] as const) {
      const got = await c.get("/staff/builds/frontends/new");
      assert.ok(got.status >= 300, `${who}: GET answered ${got.status}`);
      const posted = await c.post("/staff/builds/frontends/new", { target: "new", name: "Not allowed", artifact: zipFile() });
      assert.ok(posted.status >= 300 && posted.status !== 303, `${who}: POST answered ${posted.status}`);
    }

    const n = (await t.db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE name = 'Not allowed'`).first<{ n: number }>())?.n ?? 0;
    assert.equal(n, 0, "and nothing was created by trying");
  } finally { t.close(); }
});

test("[DLU-05] an existing project can be chosen, and a quarantined one is not offered", async () => {
  const t = await createTestApp();
  try {
    const owner = await createStaff(t.db, "owner");
    const asOwner = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);
    const cust = await createCustomer(t.db);
    const ok = await project(t.db, cust.organizationId, "Riverbend Library");
    const bad = await project(t.db, cust.organizationId, "Quarantined project");
    await t.db.prepare(`UPDATE projects SET frontend_state = 'artifact_quarantined' WHERE id = ?`).bind(bad).run();

    const names = (await DL.uploadTargets(t.db, { limit: 50 })).map((x) => x.projectName);
    assert.ok(names.includes("Riverbend Library"), names.join(", "));
    assert.ok(!names.includes("Quarantined project"), "a quarantined artifact is dealt with, not piled on");

    const page = await asOwner.get("/staff/builds/frontends/new");
    assert.match(await page.text(), /Riverbend Library/, "the eligible project is offered on the screen");

    const res = await asOwner.post("/staff/builds/frontends/new", { target: "existing", projectId: ok, artifact: zipFile() });
    assert.equal(res.status, 303, (await res.text()).slice(0, 200));
    assert.equal(res.headers.get("location"), `/staff/builds/frontends/${ok}`);
    assert.ok(await DL.latestArtifact(t.db, ok), "the artifact landed on the project that was chosen");

    const unknown = await asOwner.post("/staff/builds/frontends/new", {
      target: "existing", projectId: "prj_does_not_exist", artifact: zipFile(),
    });
    assert.equal(unknown.status, 422);
  } finally { t.close(); }
});

// ── the import step ───────────────────────────────────────────────────────────────────────────────────────────
//
// Between a scanned ZIP and a design a person can approve, something has to unpack, build and measure it. Nothing
// on the deployed platform did: recordVerdict was reached only from the reject route, recordBaseline from nowhere,
// and the two runner-facing frontend endpoints both require a baseline that is ALREADY approved. So an uploaded
// artifact was scanned and then had nothing to approve, and the Founder could not get past the upload.

async function cleanArtifact(t: Awaited<ReturnType<typeof createTestApp>>, projectId: string, organizationId: string, staffId: string, body = "artifact-bytes") {
  const fileId = newId("file");
  const at = nowIso();
  const bytes = new TextEncoder().encode(body);
  const sha = await sha256Hex(bytes);
  const key = `frontend-artifacts/${fileId}.zip`;
  await t.storage.put(key, bytes, "application/zip");
  await t.db.prepare(
    `INSERT INTO files (id, organization_id, project_id, filename, r2_key, content_type, size_bytes, sha256, scan_status, uploaded_by, created_at)
     VALUES (?, ?, ?, 'frontend.zip', ?, 'application/zip', ?, ?, 'clean', ?, ?)`,
  ).bind(fileId, organizationId, projectId, key, bytes.length, sha, staffId, at).run();
  const artifact = await DL.recordArtifact(t.db, {
    projectId, organizationId, source: "upload", fileId, sha256: sha,
    sizeBytes: bytes.length, uploadedBy: staffId, scanStatus: "clean",
  });
  return { artifact, fileId, sha, bytes };
}

test("[DLI-01] only a clean artifact is offered for import, and only to one runner", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);

    // Nothing to do yet.
    assert.equal(await DL.claimArtifactForImport(t.db, { runnerId: "r1" }), null, "an empty queue offers nothing");

    // An artifact still awaiting its scan is not work yet.
    const pendingFile = newId("file");
    const at = nowIso();
    const pendingSha = await sha256Hex("pending-bytes");
    await t.db.prepare(
      `INSERT INTO files (id, organization_id, project_id, filename, r2_key, content_type, size_bytes, sha256, scan_status, uploaded_by, created_at)
       VALUES (?, ?, ?, 'frontend.zip', ?, 'application/zip', 12, ?, 'pending', ?, ?)`,
    ).bind(pendingFile, cust.organizationId, projectId, `frontend-artifacts/${pendingFile}.zip`, pendingSha, staff.id, at).run();
    await DL.recordArtifact(t.db, {
      projectId, organizationId: cust.organizationId, source: "upload", fileId: pendingFile,
      sha256: pendingSha, sizeBytes: 12, uploadedBy: staff.id, scanStatus: "pending",
    });
    assert.equal(await DL.claimArtifactForImport(t.db, { runnerId: "r1" }), null, "an unscanned artifact is not offered");

    // A clean one is.
    const { artifact } = await cleanArtifact(t, projectId, cust.organizationId, staff.id);
    const first = await DL.claimArtifactForImport(t.db, { runnerId: "r1" });
    assert.equal(first?.artifactId, artifact.id, "the clean artifact is claimed");
    assert.equal(first?.sha256, artifact.sha256);

    // And a second runner gets nothing, because the claim is the status change itself.
    assert.equal(await DL.claimArtifactForImport(t.db, { runnerId: "r2" }), null, "two runners never take the same artifact");
    assert.equal((await DL.getArtifact(t.db, artifact.id))?.status, "validating");
    const state = await DL.frontendState(t.db, projectId);
    assert.equal(state.state, "validating_artifact", "and the project says what is happening to it");
  } finally { t.close(); }
});

test("[DLI-02] a claim that was never finished becomes claimable again", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const { artifact } = await cleanArtifact(t, projectId, cust.organizationId, staff.id);

    assert.ok(await DL.claimArtifactForImport(t.db, { runnerId: "r1" }));
    // Still held a moment later.
    assert.equal(await DL.claimArtifactForImport(t.db, { runnerId: "r2", staleMs: 60_000 }), null);
    // A runner that died leaves the row behind; after the lease it is work again rather than stuck for ever.
    const later = await DL.claimArtifactForImport(t.db, { runnerId: "r2", now: new Date(Date.now() + 25 * 60_000) });
    assert.equal(later?.artifactId, artifact.id, "the lease expires instead of losing the artifact");

    // And a runner can hand it back deliberately.
    await DL.releaseImportClaim(t.db, artifact.id);
    assert.equal((await DL.getArtifact(t.db, artifact.id))?.status, "received");
  } finally { t.close(); }
});

test("[DLI-03] the bytes are delivered only while claimed, only when clean, and only if they still hash right", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const { artifact, fileId, bytes } = await cleanArtifact(t, projectId, cust.organizationId, staff.id);

    // Not claimed: nothing is handed over.
    await assert.rejects(
      () => DL.deliverArtifactForImport(t.db, t.storage, artifact.id),
      (e: Error) => /not being imported/.test(e.message),
      "an unclaimed artifact is not delivered",
    );

    await DL.claimArtifactForImport(t.db, { runnerId: "r1" });
    const got = await DL.deliverArtifactForImport(t.db, t.storage, artifact.id);
    assert.equal(got.sha256, artifact.sha256);
    assert.equal(Buffer.from(got.base64, "base64").toString("utf8"), new TextDecoder().decode(bytes), "the bytes are the ones stored");

    // The scanning gate is read NOW, not from what was recorded when the artifact arrived.
    await t.db.prepare(`UPDATE files SET scan_status = 'infected' WHERE id = ?`).bind(fileId).run();
    await assert.rejects(
      () => DL.deliverArtifactForImport(t.db, t.storage, artifact.id),
      (e: Error) => /is infected, so it is not delivered/.test(e.message),
      "an artifact flagged after it was recorded is refused at delivery",
    );

    // A swapped object in storage is caught by the hash, not trusted from the row.
    await t.db.prepare(`UPDATE files SET scan_status = 'clean' WHERE id = ?`).bind(fileId).run();
    const file = await t.db.prepare(`SELECT r2_key FROM files WHERE id = ?`).bind(fileId).first<{ r2_key: string }>();
    await t.storage.put(file!.r2_key, new TextEncoder().encode("something else entirely"), "application/zip");
    await assert.rejects(
      () => DL.deliverArtifactForImport(t.db, t.storage, artifact.id),
      (e: Error) => /no longer hash/.test(e.message),
      "bytes that do not hash to the record are refused",
    );
  } finally { t.close(); }
});

test("[DLI-04] a measured design lands where a person can approve it, and nothing here approves it", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const { artifact } = await cleanArtifact(t, projectId, cust.organizationId, staff.id);
    await DL.claimArtifactForImport(t.db, { runnerId: "r1" });

    await DL.recordVerdict(t.db, artifact.id, { status: "imported", framework: "vite" });
    const baseline = await DL.recordBaseline(t.db, artifact.id, baselineInput());

    assert.equal(baseline.status, "draft", "a measured baseline is a draft: the import never approves one");
    const state = await DL.frontendState(t.db, projectId);
    assert.equal(state.state, "awaiting_approval", "the project is waiting for a person");
    assert.equal(state.designLocked, false, "and nothing is locked until they say so");

    // The person approves, and only then is it locked.
    await DL.approveBaseline(t.db, baseline.id, { approvedBy: staff.id });
    const after = await DL.frontendState(t.db, projectId);
    assert.equal(after.designLocked, true);
    assert.equal(after.activeBaselineId, baseline.id);
  } finally { t.close(); }
});

test("[DLI-05] an import that failed is recorded as the artifact's verdict, with its reasons", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const { artifact } = await cleanArtifact(t, projectId, cust.organizationId, staff.id);
    await DL.claimArtifactForImport(t.db, { runnerId: "r1" });

    await DL.recordVerdict(t.db, artifact.id, {
      status: "rejected",
      problems: ["npm install failed: no lockfile", "the build produced no dist/"],
    });

    const after = await DL.getArtifact(t.db, artifact.id);
    assert.equal(after?.status, "rejected");
    assert.match(after?.problems_json ?? "", /no lockfile/, "the reasons are kept for the person who uploaded it");
    const state = await DL.frontendState(t.db, projectId);
    assert.equal(state.state, "artifact_rejected", "and the dashboard shows it as needing attention");
    assert.equal(await DL.claimArtifactForImport(t.db, { runnerId: "r2" }), null, "a rejected artifact is not retried for ever");
  } finally { t.close(); }
});

// ── approving at submission ───────────────────────────────────────────────────────────────────────────────────
//
// The Founder's requirement is that submitting a finished frontend carries it into the backend queue without
// another button press. Approval is the one step that must be a person's AND must name a measured design, and at
// submission there is no design yet. So the acknowledgement is recorded then and becomes an approval only after a
// clean scan, a successful import and a measurement -- against THAT baseline. These cover every case where
// applying it would mean approving something other than what was acknowledged.

test("[DLS-01] an acknowledgement becomes an approval only once the design has been measured", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const { artifact } = await cleanArtifact(t, projectId, cust.organizationId, staff.id);
    await t.db.prepare(`UPDATE frontend_artifacts SET approval_intent_by = ?, approval_intent_at = ? WHERE id = ?`)
      .bind(staff.id, nowIso(), artifact.id).run();

    // Measured? No. So there is nothing to approve, and saying so is the whole point.
    const early = await DL.applySubmissionApproval(t.db, artifact.id, "dbl_nope");
    assert.equal(early.applied, false);
    assert.match("why" in early ? early.why : "", /no measured design|not measured|was not measured/i, JSON.stringify(early));
    assert.equal((await DL.frontendState(t.db, projectId)).designLocked, false, "and nothing is locked");

    // Now the import happens.
    await DL.recordVerdict(t.db, artifact.id, { status: "imported", framework: "vite" });
    const baseline = await DL.recordBaseline(t.db, artifact.id, baselineInput());
    assert.equal(baseline.status, "draft", "the measurement itself approves nothing");

    const applied = await DL.applySubmissionApproval(t.db, artifact.id, baseline.id);
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.equal("approvedBy" in applied ? applied.approvedBy : "", staff.id, "the approval names the person who acknowledged it");

    const after = await DL.getBaseline(t.db, baseline.id);
    assert.equal(after?.status, "approved");
    assert.equal(after?.approved_by, staff.id);
    assert.match(after?.approval_note ?? "", new RegExp(artifact.sha256.slice(0, 12)), "and records the artifact's own checksum");
    assert.match(after?.approval_note ?? "", /v1/, "and the artifact version");

    const state = await DL.frontendState(t.db, projectId);
    assert.equal(state.designLocked, true, "only now is the design locked");
    assert.equal(state.activeBaselineId, baseline.id);

    const row = await t.db.prepare(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'design_baseline.approved' AND actor_user_id = ? AND subject_id = ?`,
    ).bind(staff.id, baseline.id).first<{ n: number }>();
    assert.equal(row?.n, 1, "audited as the person's own decision, like a manual approval");
  } finally { t.close(); }
});

test("[DLS-02] an acknowledgement never approves an artifact that was not measured from those bytes", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);

    // A rejected artifact: acknowledged, but there is no design.
    const a = await cleanArtifact(t, projectId, cust.organizationId, staff.id, "first-bytes");
    await t.db.prepare(`UPDATE frontend_artifacts SET approval_intent_by = ?, approval_intent_at = ? WHERE id = ?`)
      .bind(staff.id, nowIso(), a.artifact.id).run();
    await DL.recordVerdict(t.db, a.artifact.id, { status: "rejected", problems: ["it will not build"] });
    const rejected = await DL.applySubmissionApproval(t.db, a.artifact.id, "dbl_none");
    assert.equal(rejected.applied, false);
    assert.match("why" in rejected ? rejected.why : "", /rejected/i, JSON.stringify(rejected));

    // A baseline measured from a DIFFERENT artifact must not be approved by this one's acknowledgement.
    const b = await cleanArtifact(t, projectId, cust.organizationId, staff.id, "second-bytes");
    await DL.recordVerdict(t.db, b.artifact.id, { status: "imported", framework: "vite" });
    const other = await DL.recordBaseline(t.db, b.artifact.id, baselineInput());

    const c = await cleanArtifact(t, projectId, cust.organizationId, staff.id, "third-bytes");
    await t.db.prepare(`UPDATE frontend_artifacts SET approval_intent_by = ?, approval_intent_at = ? WHERE id = ?`)
      .bind(staff.id, nowIso(), c.artifact.id).run();
    await DL.recordVerdict(t.db, c.artifact.id, { status: "imported", framework: "vite" });

    const crossed = await DL.applySubmissionApproval(t.db, c.artifact.id, other.id);
    assert.equal(crossed.applied, false, "one artifact's acknowledgement cannot approve another's design");
    assert.match("why" in crossed ? crossed.why : "", /not measured from this artifact/i, JSON.stringify(crossed));
    assert.equal((await DL.getBaseline(t.db, other.id))?.status, "draft", "and the other baseline is untouched");
  } finally { t.close(); }
});

test("[DLS-03] an acknowledgement approves once, however many times a report arrives", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const { artifact } = await cleanArtifact(t, projectId, cust.organizationId, staff.id);
    await t.db.prepare(`UPDATE frontend_artifacts SET approval_intent_by = ?, approval_intent_at = ? WHERE id = ?`)
      .bind(staff.id, nowIso(), artifact.id).run();
    await DL.recordVerdict(t.db, artifact.id, { status: "imported", framework: "vite" });
    const baseline = await DL.recordBaseline(t.db, artifact.id, baselineInput());

    assert.equal((await DL.applySubmissionApproval(t.db, artifact.id, baseline.id)).applied, true);
    const again = await DL.applySubmissionApproval(t.db, artifact.id, baseline.id);
    assert.equal(again.applied, false, "a retry, a restart or a second report does not approve twice");
    assert.match("why" in again ? again.why : "", /already/i, JSON.stringify(again));

    const approvals = await t.db.prepare(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'design_baseline.approved' AND subject_id = ?`,
    ).bind(baseline.id).first<{ n: number }>();
    assert.equal(approvals?.n, 1, "and exactly one approval is on the record");
  } finally { t.close(); }
});

test("[DLS-04] a submission with no acknowledgement is never approved on its own", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const { artifact } = await cleanArtifact(t, projectId, cust.organizationId, staff.id);
    await DL.recordVerdict(t.db, artifact.id, { status: "imported", framework: "vite" });
    const baseline = await DL.recordBaseline(t.db, artifact.id, baselineInput());

    const none = await DL.applySubmissionApproval(t.db, artifact.id, baseline.id);
    assert.equal(none.applied, false, "nobody said it, so nothing is approved");
    assert.match("why" in none ? none.why : "", /no approval acknowledgement/i, JSON.stringify(none));
    assert.equal((await DL.getBaseline(t.db, baseline.id))?.status, "draft");
    assert.equal((await DL.frontendState(t.db, projectId)).designLocked, false,
      "the measurements are there to review and the decision is still a person's");
  } finally { t.close(); }
});

test("[DLS-05] recordArtifact keeps the acknowledgement with the upload, and audits it as its own statement", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const sha = await sha256Hex("ack-bytes");
    const a = await DL.recordArtifact(t.db, {
      projectId, organizationId: cust.organizationId, source: "upload", sha256: sha,
      sizeBytes: 9, uploadedBy: staff.id, scanStatus: "pending", approvalIntentBy: staff.id,
    });

    const row = await t.db.prepare(`SELECT approval_intent_by, approval_intent_at, approval_intent_applied_at FROM frontend_artifacts WHERE id = ?`)
      .bind(a.id).first<{ approval_intent_by: string; approval_intent_at: string; approval_intent_applied_at: string | null }>();
    assert.equal(row?.approval_intent_by, staff.id);
    assert.ok(row?.approval_intent_at, "and when it was said");
    assert.equal(row?.approval_intent_applied_at, null, "and it has not been acted on yet");

    const said = await t.db.prepare(
      `SELECT details_json FROM audit_logs WHERE action = 'frontend_artifact.approval_acknowledged' AND subject_id = ?`,
    ).bind(a.id).first<{ details_json: string }>();
    assert.ok(said, "the acknowledgement is audited in its own right");
    assert.match(said!.details_json, new RegExp(sha.slice(0, 12)), "naming the bytes it was said about");
    assert.match(said!.details_json, /clean scan/, "and what it waits for");
  } finally { t.close(); }
});

// ── and then a backend build ──────────────────────────────────────────────────────────────────────────────────
//
// Approving a design is only half of "submit a finished frontend and a backend build starts". The other half is
// build eligibility, which exists so no customer's website is built before it is paid for: an order, a verified
// customer admin, recorded scope, a paid qualifying invoice, submitted intake. Crestmont's OWN test project has
// none of those and never will, so every Founder test artifact was scanned, imported, measured, approved -- and
// then silently never built, because `syncProjectBuild` returned null.

test("[DLS-06] Crestmont's own approved project reaches a queued build, with no order and no payment", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const made = await DL.createTestProject(t.db, { name: "Queue fixture", actorId: staff.id });

    // Before the approval there is nothing to build: no approved design, no order, no payment.
    assert.equal(await B.syncProjectBuild(t.db, made.projectId, "backfill"), null, "an unapproved internal project starts nothing");
    const facts = await B.projectFacts(t.db, made.projectId);
    assert.equal(facts.internalApprovedDesign, false);
    assert.equal(B.decideEligibility(facts).verdict, "ineligible");

    const { artifact } = await cleanArtifact(t, made.projectId, made.organizationId, staff.id);
    await t.db.prepare(`UPDATE frontend_artifacts SET approval_intent_by = ?, approval_intent_at = ? WHERE id = ?`)
      .bind(staff.id, nowIso(), artifact.id).run();
    await DL.recordVerdict(t.db, artifact.id, { status: "imported", framework: "static" });
    const baseline = await DL.recordBaseline(t.db, artifact.id, baselineInput());
    assert.equal((await DL.applySubmissionApproval(t.db, artifact.id, baseline.id)).applied, true);

    // The approval IS the authorization, and it is the only thing that changed.
    const after = await B.projectFacts(t.db, made.projectId);
    assert.equal(after.internalApprovedDesign, true);
    assert.equal(after.order, null, "still no order");
    assert.equal(after.qualifying, null, "still no payment");
    const decision = B.decideEligibility(after);
    assert.equal(decision.verdict, "queued", decision.reasons.join("; "));
    assert.match(decision.reasons.join(" "), /approval is the authorization/, decision.reasons.join("; "));

    const job = await B.syncProjectBuild(t.db, made.projectId, "backfill", { kind: "user", userId: staff.id });
    assert.ok(job, "a build job exists");
    assert.equal(job.state, "queued", `the build is queued, not held: ${job.state} (${job.state_reason})`);
    assert.equal(job.project_id, made.projectId);
    assert.equal(job.order_id, null);
    // `build_phase` is a column rather than a field of BuildJob, so it is read where it lives.
    const phase = await t.db.prepare(`SELECT build_phase FROM build_jobs WHERE id = ?`).bind(job.id).first<{ build_phase: string }>();
    assert.equal(phase?.build_phase, "design_locked", "and it skips autonomous design generation, as a design-locked build must");

    // It is in the queue the screen shows, with a position.
    const snap = await B.queueSnapshot(t.db);
    assert.equal(snap.queued.filter((q) => q.jobId === job.id).length, 1, JSON.stringify(snap));
  } finally { t.close(); }
});

test("[DLS-07] an approved design does not pay for a customer's build", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = await project(t.db, cust.organizationId);
    const { artifact } = await cleanArtifact(t, projectId, cust.organizationId, staff.id);
    await DL.recordVerdict(t.db, artifact.id, { status: "imported", framework: "vite" });
    const baseline = await DL.recordBaseline(t.db, artifact.id, baselineInput());
    await DL.approveBaseline(t.db, baseline.id, { approvedBy: staff.id, note: "approved by hand" });
    assert.equal((await DL.getBaseline(t.db, baseline.id))?.status, "approved", "the design really is approved");

    // A customer organization is not internal, so the shortcut must not apply however the design was approved.
    const facts = await B.projectFacts(t.db, projectId);
    assert.equal(facts.internalApprovedDesign, false, "a customer project is never Crestmont's own");
    const decision = B.decideEligibility(facts);
    assert.equal(decision.verdict, "ineligible", decision.reasons.join("; "));
    assert.match(decision.reasons.join(" "), /no order is linked/, decision.reasons.join("; "));
    assert.equal(await B.syncProjectBuild(t.db, projectId, "backfill"), null, "and nothing is queued for it");
  } finally { t.close(); }
});
