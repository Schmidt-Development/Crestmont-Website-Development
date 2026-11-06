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
import * as MS from "../src/services/malware-scan.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import { sha256Hex } from "../src/lib/crypto.ts";
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
