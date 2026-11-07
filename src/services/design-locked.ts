// Design-locked frontends: the platform side of "the Founder decides how it looks".
//
// This module owns the two records migration 0080 added — the artifact a project received and the baseline
// frozen from it — plus the workflow state the dashboard reads. It owns no opinion about design: the runner
// measures, this stores, and a person approves.
//
// Three rules it exists to enforce, and which nothing else in the codebase can be relied on to enforce:
//
//   1. A LATER ARTIFACT NEVER SILENTLY REPLACES AN APPROVED DESIGN (§13). Approving a new baseline supersedes
//      the old one explicitly, and the old row is kept so a rollback has something to restore.
//   2. ONLY AN AUTHORIZED PERSON APPROVES OR REPLACES A BASELINE (§13). Approval takes a user id, and the route
//      layer checks the role; nothing here invents an approver.
//   3. A DESIGN-LOCKED PROJECT DOES NOT ENTER THE RETIRED PIPELINE (§15 Phase D). `designGenerationAllowed`
//      is the single question the build path asks, so the gate cannot be half-applied.

// The integration manifest's format is defined once, in the module that enforces it for the runner. A second
// copy of the rules here is exactly how `renders` and `screenshots` drifted apart until every import report
// was refused; the file is a pure validator with no imports of its own, so it bundles into the Worker as is.
import { validateManifest, MANIFEST_SCHEMA, completeness, coverage } from "../../runner/src/frontend/integration-manifest.ts";
import type {
  IntegrationManifest, InteractionItem, ManifestContract, MissingRequirement, OperationKind,
} from "../../runner/src/frontend/integration-manifest.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { sha256Hex } from "../lib/crypto.ts";
import type { StorageAdapter } from "../adapters/storage.ts";

/** §13's workflow. Kept on `projects`, beside the existing status, never replacing it. */
export const FRONTEND_STATES = [
  "awaiting_frontend",
  "validating_artifact",
  "awaiting_approval",
  "design_locked",
  "building_backend",
  "integrating",
  "verifying",
  "ready_for_review",
  "approved_for_release",
  // Failure and intervention states, which §13 allows for explicitly.
  "artifact_rejected",
  "artifact_quarantined",
  "blocked",
] as const;
export type FrontendState = (typeof FRONTEND_STATES)[number];

/** The states in which a design has been frozen and must not be re-invented. */
export const LOCKED_STATES: readonly FrontendState[] = [
  "design_locked", "building_backend", "integrating", "verifying", "ready_for_review", "approved_for_release",
];

export type ArtifactSource = "upload" | "template" | "repository" | "internal_fixture";
export type ArtifactStatus = "received" | "validating" | "rejected" | "quarantined" | "validated" | "imported" | "superseded";
export type BaselineStatus = "draft" | "approved" | "superseded" | "rolled_back";
export type Framework = "react" | "react-ts" | "vite" | "static";

export interface FrontendArtifact {
  id: string;
  project_id: string;
  organization_id: string;
  version: number;
  source: ArtifactSource;
  file_id: string | null;
  template_ref: string | null;
  repo_url: string | null;
  repo_commit: string | null;
  sha256: string;
  size_bytes: number;
  framework: Framework | null;
  archive_root: string | null;
  lockfile_sha: string | null;
  scan_status: string;
  status: ArtifactStatus;
  problems_json: string;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DesignBaselineRow {
  id: string;
  project_id: string;
  artifact_id: string;
  version: number;
  fingerprint: string;
  source_fingerprint: string | null;
  lockfile_sha: string | null;
  route_manifest_json: string;
  asset_manifest_json: string;
  component_inventory_json: string;
  interaction_inventory_json: string;
  signatures_json: string;
  screenshots_json: string;
  states_json: string;
  viewports_json: string;
  status: BaselineStatus;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
  superseded_by: string | null;
  superseded_at: string | null;
  created_at: string;
}

export class DesignLockError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ── artifacts ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Record a frontend artifact a project has received.
 *
 * The version is allocated here rather than passed in, so two uploads racing cannot both claim version 2 — the
 * UNIQUE (project_id, version) index turns that into an error instead of a silent overwrite.
 */
/**
 * Projects an artifact can be uploaded against, newest first.
 *
 * The upload endpoint has always needed a project id, and the only screen that offered it was a project's own
 * page -- so with no design-locked project yet there was nowhere to start, and the Founder could not upload a
 * first artifact without making database rows by hand. This is the list that screen needs.
 *
 * A project already carrying an approved, locked design is still eligible: a later artifact is how a design is
 * revised, and approving it is a deliberate, audited act (approveBaseline). What is excluded is a project whose
 * current artifact is quarantined, because the next step there is to deal with that, not to pile another on.
 */
export async function uploadTargets(db: Db, o: { limit?: number } = {}): Promise<
  { projectId: string; projectName: string; organizationId: string; organizationName: string; state: string | null; designLocked: boolean }[]
> {
  const rows = await db.prepare(
    `SELECT p.id AS projectId, p.name AS projectName, p.organization_id AS organizationId, org.name AS organizationName,
            p.frontend_state AS state, COALESCE(p.design_locked, 0) AS designLocked
       FROM projects p
       JOIN organizations org ON org.id = p.organization_id
      WHERE p.status NOT IN ('cancelled')
        AND COALESCE(p.frontend_state, '') != 'artifact_quarantined'
      ORDER BY p.updated_at DESC
      LIMIT ?`,
  ).bind(Math.min(Math.max(1, o.limit ?? 50), 200)).all<{
    projectId: string; projectName: string; organizationId: string; organizationName: string; state: string | null; designLocked: number;
  }>();
  return (rows.results ?? []).map((r) => ({ ...r, designLocked: r.designLocked === 1 }));
}

/** The one organization test projects belong to, created on first use so nothing has to be seeded by hand. */
export const TEST_ORG_NAME = "Crestmont internal — Artifact Builder tests";

/**
 * A project for testing the builder, with no order behind it.
 *
 * Every other project in the platform comes from a paid order (provisionProject), which is the right rule for a
 * customer project and the wrong one for trying an artifact: it would mean inventing an order, an invoice and a
 * payment to upload a ZIP. `projects.order_id` is nullable and `uq_projects_order` is partial, so a project
 * without one is legitimate and collides with nothing.
 *
 * It is marked plainly -- an `internal` organization with a name that says what it is -- so it is never mistaken
 * for work someone is paying for, and it is audited like any other creation.
 */
export async function createTestProject(
  db: Db,
  o: { name: string; actorId: string; ip?: string | null },
): Promise<{ projectId: string; organizationId: string }> {
  const name = o.name.trim();
  if (name.length < 2 || name.length > 120) throw new Error("A test project needs a name of 2–120 characters.");

  const at = nowIso();
  let org = await db.prepare(`SELECT id FROM organizations WHERE kind = 'internal' AND name = ? LIMIT 1`)
    .bind(TEST_ORG_NAME).first<{ id: string }>();
  if (!org) {
    const orgId = newId("org");
    await db.prepare(`INSERT INTO organizations (id, name, kind, created_at) VALUES (?,?,'internal',?)`)
      .bind(orgId, TEST_ORG_NAME, at).run();
    org = { id: orgId };
  }

  const projectId = newId("prj");
  await db.prepare(
    `INSERT INTO projects (id, organization_id, order_id, product_id, name, status, revision_allowance, payment_schedule, created_at, updated_at)
     VALUES (?,?,NULL,NULL,?, 'design', 0, 'upfront', ?, ?)`,
  ).bind(projectId, org.id, name, at, at).run();

  await audit(db, {
    actorUserId: o.actorId, action: "project.created", subjectType: "project", subjectId: projectId,
    organizationId: org.id, details: { purpose: "artifact-builder-test", order: null }, ip: o.ip ?? null,
  });
  return { projectId, organizationId: org.id };
}

/**
 * Remove a test project that was created a moment ago for an artifact the upload path then refused.
 *
 * Deliberately narrow. It refuses to touch anything with an order, anything outside the internal test
 * organization, and anything that already has an artifact or a baseline -- so it can only ever undo the row this
 * request created, never a project someone is using. The deletion is audited like the creation was.
 */
export async function deleteEmptyTestProject(
  db: Db,
  projectId: string,
  o: { actorId: string; ip?: string | null },
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT p.id, p.organization_id
       FROM projects p JOIN organizations org ON org.id = p.organization_id
      WHERE p.id = ? AND p.order_id IS NULL AND org.kind = 'internal' AND org.name = ?
        AND NOT EXISTS (SELECT 1 FROM frontend_artifacts a WHERE a.project_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM design_baselines b WHERE b.project_id = p.id)`,
  ).bind(projectId, TEST_ORG_NAME).first<{ id: string; organization_id: string }>();
  if (!row) return false;
  await db.prepare(`DELETE FROM projects WHERE id = ?`).bind(projectId).run();
  await audit(db, {
    actorUserId: o.actorId, action: "project.deleted", subjectType: "project", subjectId: projectId,
    organizationId: row.organization_id, details: { reason: "the artifact it was created for was refused" }, ip: o.ip ?? null,
  });
  return true;
}

// ── the import step: from a scanned artifact to a measured design ─────────────────────────────────────────────
//
// Between "the Founder uploaded a ZIP" and "a person approves the design" something has to unpack it, build it and
// measure it. Nothing on the deployed platform did. `recordVerdict` was reached only from the reject route,
// `recordBaseline` from nowhere at all, and both runner-facing frontend endpoints serve a leased BUILD and require
// a baseline that is already approved -- so an uploaded artifact was scanned and then had nothing to approve.
// The step existed only inside scripts/design-locked-e2e.ts, which drives a sandbox in-process.
//
// These three functions are that channel, and they add no new state: `status` already has 'received' for an
// artifact nobody has looked at and 'validating' for one being looked at, which is the lease. A claim is a
// conditional UPDATE, so two runners cannot take the same artifact, and a runner that dies leaves a 'validating'
// row that becomes claimable again after `staleMs`.

export interface ImportClaim {
  artifactId: string;
  projectId: string;
  organizationId: string;
  version: number;
  sha256: string;
  sizeBytes: number;
}

/** How long a claimed artifact stays claimed before another runner may take it. */
export const IMPORT_LEASE_MS = 20 * 60_000;

/**
 * Take one artifact that is waiting to be imported, or nothing.
 *
 * Only a CLEAN artifact is ever offered. An artifact still pending a scan is not work yet, and an infected or
 * failed one is not work at all -- the gate is read from `files.scan_status` at this moment rather than from the
 * copy taken when the artifact was recorded, because what matters is its status now.
 */
export async function claimArtifactForImport(
  db: Db,
  o: { runnerId: string; now?: Date; staleMs?: number } = { runnerId: "" },
): Promise<ImportClaim | null> {
  const now = o.now ?? new Date();
  const at = now.toISOString();
  const stale = new Date(now.getTime() - (o.staleMs ?? IMPORT_LEASE_MS)).toISOString();

  // One conditional UPDATE is the whole lease: whichever runner's statement matches the row first gets it, and the
  // `status IN (...)` in the WHERE means the loser's statement changes nothing and returns no row.
  const picked = await db.prepare(
    `UPDATE frontend_artifacts SET status = 'validating', updated_at = ?
      WHERE id = (
        SELECT a.id FROM frontend_artifacts a
          JOIN files f ON f.id = a.file_id
          JOIN projects p ON p.id = a.project_id
         WHERE f.scan_status = 'clean'
           AND (a.status = 'received' OR (a.status = 'validating' AND a.updated_at < ?))
           AND p.status NOT IN ('cancelled')
         ORDER BY a.created_at ASC
         LIMIT 1
      )
      AND (status = 'received' OR (status = 'validating' AND updated_at < ?))
      RETURNING id, project_id, organization_id, version, sha256, size_bytes`,
  ).bind(at, stale, stale).first<{
    id: string; project_id: string; organization_id: string; version: number; sha256: string; size_bytes: number;
  }>();
  if (!picked) return null;

  await setFrontendState(db, picked.project_id, "validating_artifact");
  await audit(db, {
    actorUserId: null, action: "frontend_artifact.import_claimed", subjectType: "frontendArtifact", subjectId: picked.id,
    organizationId: picked.organization_id, details: { runnerId: o.runnerId.slice(0, 64), version: picked.version },
  });
  return {
    artifactId: picked.id, projectId: picked.project_id, organizationId: picked.organization_id,
    version: picked.version, sha256: picked.sha256, sizeBytes: picked.size_bytes,
  };
}

export interface ImportBytes {
  artifactId: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  filename: string;
  /** The archive itself. The runner checks this against `sha256` before it opens it. */
  base64: string;
}

/**
 * The bytes of an artifact that is being imported.
 *
 * The same quarantine gate as `deliverApprovedArtifact`, applied at the moment of delivery and not trusted from
 * the record: an artifact recorded clean and later flagged must not be handed over because of what was true
 * earlier. It is offered only while claimed, so nothing can pull bytes for an artifact nobody is importing.
 */
export async function deliverArtifactForImport(
  db: Db,
  storage: StorageAdapter | null,
  artifactId: string,
): Promise<ImportBytes> {
  if (!storage) throw new DeliveryError("file storage is not configured", 409);
  const a = await getArtifact(db, artifactId);
  if (!a) throw new DeliveryError("no such artifact", 404);
  if (a.status !== "validating") throw new DeliveryError(`this artifact is ${a.status}, not being imported`, 409);
  if (!a.file_id) throw new DeliveryError("this artifact has no stored file", 409);

  const file = await db.prepare(`SELECT id, filename, scan_status, size_bytes, r2_key FROM files WHERE id = ?`)
    .bind(a.file_id).first<{ id: string; filename: string; scan_status: string; size_bytes: number; r2_key: string }>();
  if (!file) throw new DeliveryError("the artifact's file no longer exists", 409);
  if (file.scan_status !== "clean") {
    throw new DeliveryError(`the artifact's file is ${file.scan_status}, so it is not delivered`, 409);
  }

  const obj = await storage.get(file.r2_key);
  if (!obj) throw new DeliveryError("the artifact's bytes are missing from storage", 409);
  // `StoredObject.body` is a stream in R2 and bytes on local disk; read both the same way, as the approved
  // delivery below does, so the import behaves identically in development and in staging.
  const bytes = obj.body instanceof Uint8Array
    ? obj.body
    : new Uint8Array(obj.body instanceof ArrayBuffer ? obj.body : await new Response(obj.body).arrayBuffer());

  // Hashed from the bytes actually read, never trusted from the row: this is the check that catches a swapped
  // object in storage between the scan and the import.
  const digest = await sha256Hex(bytes);
  if (digest !== a.sha256) {
    throw new DeliveryError("the stored bytes no longer hash to the artifact's recorded sha256; delivery refused", 409);
  }
  return {
    artifactId: a.id, version: a.version, sha256: a.sha256, sizeBytes: file.size_bytes,
    filename: file.filename, base64: Buffer.from(bytes).toString("base64"),
  };
}

/** Put a claimed artifact back for another attempt, when the runner could not finish (a crash, a lost sandbox). */
export async function releaseImportClaim(db: Db, artifactId: string): Promise<void> {
  await db.prepare(`UPDATE frontend_artifacts SET status = 'received', updated_at = ? WHERE id = ? AND status = 'validating'`)
    .bind(nowIso(), artifactId).run();
}

export async function recordArtifact(db: Db, a: {
  projectId: string;
  organizationId: string;
  source: ArtifactSource;
  sha256: string;
  sizeBytes: number;
  fileId?: string | null;
  templateRef?: string | null;
  repoUrl?: string | null;
  repoCommit?: string | null;
  uploadedBy?: string | null;
  scanStatus?: string;
  /**
   * The person acknowledging, at submission, that this is the approved design.
   *
   * Not an approval. Approval is the one step that must be a person's AND must name a measured design, and at
   * submission there is no design yet -- nothing has been scanned, unpacked or measured. This records who said it
   * and leaves `applySubmissionApproval` to act on it once a baseline exists.
   */
  approvalIntentBy?: string | null;
}): Promise<FrontendArtifact> {
  const at = nowIso();
  const next = (await db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM frontend_artifacts WHERE project_id = ?`)
    .bind(a.projectId).first<{ v: number }>())?.v ?? 0;

  const id = newId("fa");
  const scan = a.scanStatus ?? (a.source === "internal_fixture" ? "skipped_internal" : "pending");

  await db.prepare(
    `INSERT INTO frontend_artifacts (id, project_id, organization_id, version, source, file_id, template_ref,
       repo_url, repo_commit, sha256, size_bytes, scan_status, status, uploaded_by, created_at, updated_at,
       approval_intent_by, approval_intent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?)`,
  ).bind(id, a.projectId, a.organizationId, next + 1, a.source, a.fileId ?? null, a.templateRef ?? null,
    a.repoUrl ?? null, a.repoCommit ?? null, a.sha256, a.sizeBytes, scan, a.uploadedBy ?? null, at, at,
    a.approvalIntentBy ?? null, a.approvalIntentBy ? at : null).run();

  await setFrontendState(db, a.projectId, "validating_artifact");
  if (a.approvalIntentBy) {
    // Recorded as its own entry, because "this person said the submitted frontend is the approved design" is a
    // separate statement from "this person uploaded a file", and the approval it later becomes refers back to it.
    await audit(db, {
      organizationId: a.organizationId, actorUserId: a.approvalIntentBy, actorKind: "user",
      action: "frontend_artifact.approval_acknowledged", subjectType: "frontendArtifact", subjectId: id,
      details: { version: next + 1, sha256: a.sha256, appliesAfter: "a clean scan, a successful import and a measured design" },
    });
  }
  await audit(db, {
    organizationId: a.organizationId, actorUserId: a.uploadedBy ?? null, actorKind: a.uploadedBy ? "user" : "system",
    action: "frontend_artifact.received", subjectType: "frontend_artifact", subjectId: id,
    details: { projectId: a.projectId, version: next + 1, source: a.source, sha256: a.sha256, sizeBytes: a.sizeBytes, scanStatus: scan },
  });

  return (await getArtifact(db, id))!;
}

export async function getArtifact(db: Db, id: string): Promise<FrontendArtifact | null> {
  return await db.prepare(`SELECT * FROM frontend_artifacts WHERE id = ?`).bind(id).first<FrontendArtifact>();
}

export async function latestArtifact(db: Db, projectId: string): Promise<FrontendArtifact | null> {
  return await db.prepare(`SELECT * FROM frontend_artifacts WHERE project_id = ? ORDER BY version DESC LIMIT 1`)
    .bind(projectId).first<FrontendArtifact>();
}

export async function listArtifacts(db: Db, projectId: string): Promise<FrontendArtifact[]> {
  return (await db.prepare(`SELECT * FROM frontend_artifacts WHERE project_id = ? ORDER BY version DESC`)
    .bind(projectId).all<FrontendArtifact>()).results;
}

/** Record the import verdict. A rejection carries the problems so the uploader can be told what was wrong. */
export async function recordVerdict(db: Db, id: string, v: {
  status: Exclude<ArtifactStatus, "received" | "superseded">;
  framework?: Framework | null;
  archiveRoot?: string | null;
  lockfileSha?: string | null;
  scanStatus?: string;
  problems?: unknown[];
  actorId?: string | null;
}): Promise<FrontendArtifact> {
  const a = await getArtifact(db, id);
  if (!a) throw new DesignLockError("no such frontend artifact", 404);

  await db.prepare(
    `UPDATE frontend_artifacts SET status = ?, framework = COALESCE(?, framework), archive_root = COALESCE(?, archive_root),
       lockfile_sha = COALESCE(?, lockfile_sha), scan_status = COALESCE(?, scan_status), problems_json = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(v.status, v.framework ?? null, v.archiveRoot ?? null, v.lockfileSha ?? null, v.scanStatus ?? null,
    JSON.stringify(v.problems ?? []), nowIso(), id).run();

  const state: FrontendState = v.status === "rejected" ? "artifact_rejected"
    : v.status === "quarantined" ? "artifact_quarantined"
    : v.status === "imported" ? "awaiting_approval"
    : "validating_artifact";
  await setFrontendState(db, a.project_id, state);

  await audit(db, {
    organizationId: a.organization_id, actorUserId: v.actorId ?? null, actorKind: v.actorId ? "user" : "ai",
    action: `frontend_artifact.${v.status}`, subjectType: "frontend_artifact", subjectId: id,
    details: { projectId: a.project_id, version: a.version, framework: v.framework ?? a.framework, problems: (v.problems ?? []).length },
  });

  return (await getArtifact(db, id))!;
}

/**
 * A scan verdict has landed on a stored file. Tell any frontend artifact that file belongs to.
 *
 * WHY THIS EXISTS. `frontend_artifacts.scan_status` was written once, at upload, as 'pending', and nothing ever
 * updated it: `recordVerdict` was reached only from the import path and from tests. Two consequences, found by
 * running the whole chain against a real ClamAV daemon rather than a stand-in:
 *
 *   · An artifact the scanner had confirmed clean still showed "pending" on the design-locked dashboard. Staff
 *     reading that would conclude scanning was not working, which is the opposite of the truth.
 *   · An INFECTED artifact never moved the project to `artifact_quarantined`. That state is specified in §13 and
 *     DLK-02 covers it, but nothing in the running system ever entered it, so the project sat in
 *     `validating_artifact` with no explanation of why it would never progress.
 *
 * Neither was exploitable: `deliverApprovedArtifact` re-reads the live `files.scan_status` at delivery, so an
 * unclean artifact was always refused a build. What was broken was everyone's view of it.
 *
 * Only an infected verdict changes the artifact's own status and the project's state. A clean or failed verdict
 * touches the scan column alone — a routine re-scan coming back clean must not drag an artifact that is already
 * imported and awaiting a person's approval back to "validating".
 */
export async function applyScanVerdict(
  db: Db,
  fileId: string,
  verdict: "clean" | "infected" | "failed",
  o: { engine?: string | null } = {},
): Promise<{ artifactIds: string[] }> {
  if (!fileId) return { artifactIds: [] };
  const rows = (await db.prepare(`SELECT id FROM frontend_artifacts WHERE file_id = ?`).bind(fileId)
    .all<{ id: string }>()).results;
  const artifactIds: string[] = [];

  for (const r of rows) {
    if (verdict === "infected") {
      await recordVerdict(db, r.id, {
        status: "quarantined",
        scanStatus: "infected",
        problems: [`the malware scanner reported this artifact infected${o.engine ? ` (${o.engine})` : ""}`],
      });
    } else {
      await db.prepare(`UPDATE frontend_artifacts SET scan_status = ?, updated_at = ? WHERE id = ?`)
        .bind(verdict, nowIso(), r.id).run();
    }
    artifactIds.push(r.id);
  }
  return { artifactIds };
}

// ── baselines ───────────────────────────────────────────────────────────────────────────────────────────────

export interface BaselineInput {
  fingerprint: string;
  sourceFingerprint?: string | null;
  lockfileSha?: string | null;
  routes?: unknown[];
  assets?: unknown[];
  components?: unknown[];
  interactions?: unknown[];
  signatures?: unknown[];
  screenshots?: unknown[];
  states?: unknown[];
  viewports?: string[];
}

/**
 * Record a baseline measured from an artifact. It is a DRAFT: nothing here approves anything.
 *
 * A second draft for the same artifact replaces the first, because a draft is just the latest measurement. Once
 * a baseline is approved the migration's trigger makes it immutable, so this can never touch it.
 */
export async function recordBaseline(db: Db, artifactId: string, b: BaselineInput): Promise<DesignBaselineRow> {
  const a = await getArtifact(db, artifactId);
  if (!a) throw new DesignLockError("no such frontend artifact", 404);
  if (!b.fingerprint) throw new DesignLockError("a baseline needs a design fingerprint");
  if (!(b.signatures?.length)) throw new DesignLockError("a baseline needs at least one measured page");
  if (!(b.screenshots?.length)) throw new DesignLockError("a baseline needs at least one screenshot: there would be no visual record");

  // Replace an existing draft for this artifact rather than piling up versions for the same measurement.
  const draft = await db.prepare(`SELECT id FROM design_baselines WHERE artifact_id = ? AND status = 'draft'`)
    .bind(artifactId).first<{ id: string }>();
  if (draft) await db.prepare(`DELETE FROM design_baselines WHERE id = ?`).bind(draft.id).run();

  const next = (await db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM design_baselines WHERE project_id = ?`)
    .bind(a.project_id).first<{ v: number }>())?.v ?? 0;
  const id = newId("dbl");

  await db.prepare(
    `INSERT INTO design_baselines (id, project_id, artifact_id, version, fingerprint, source_fingerprint, lockfile_sha,
       route_manifest_json, asset_manifest_json, component_inventory_json, interaction_inventory_json,
       signatures_json, screenshots_json, states_json, viewports_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
  ).bind(id, a.project_id, artifactId, next + 1, b.fingerprint, b.sourceFingerprint ?? null, b.lockfileSha ?? a.lockfile_sha,
    JSON.stringify(b.routes ?? []), JSON.stringify(b.assets ?? []), JSON.stringify(b.components ?? []),
    JSON.stringify(b.interactions ?? []), JSON.stringify(b.signatures ?? []), JSON.stringify(b.screenshots ?? []),
    JSON.stringify(b.states ?? []), JSON.stringify(b.viewports ?? []), nowIso()).run();

  await setFrontendState(db, a.project_id, "awaiting_approval");
  return (await getBaseline(db, id))!;
}

/**
 * Act on an acknowledgement given at submission, now that the design exists.
 *
 * The Founder's requirement is that submitting a finished frontend carries it into the backend queue without
 * another button press. Approval still has to be a person's and still has to name a measured design, so the
 * acknowledgement is recorded at submission (`recordArtifact`'s `approvalIntentBy`) and becomes an approval only
 * here -- after the artifact has been scanned clean, imported and measured.
 *
 * Every refusal below is a case where approving would mean approving something that does not exist or is not the
 * thing acknowledged:
 *
 *   · no acknowledgement -- nobody said it, so nothing is approved;
 *   · already applied -- an acknowledgement approves once, even if a baseline is recorded again;
 *   · the artifact is not `imported` -- it was rejected, quarantined or never measured;
 *   · the baseline is not a draft, or belongs to another artifact -- not the design that was measured from these
 *     bytes.
 *
 * It goes through `approveBaseline`, so the record, the supersession of a previous design and the audit row are
 * exactly what a manual approval writes. Nothing here is a second approval path.
 */
export async function applySubmissionApproval(
  db: Db,
  artifactId: string,
  baselineId: string,
): Promise<{ applied: true; approvedBy: string; baselineVersion: number } | { applied: false; why: string }> {
  const a = await db.prepare(
    `SELECT id, status, project_id, sha256, version, approval_intent_by, approval_intent_applied_at
       FROM frontend_artifacts WHERE id = ?`,
  ).bind(artifactId).first<{
    id: string; status: string; project_id: string; sha256: string; version: number;
    approval_intent_by: string | null; approval_intent_applied_at: string | null;
  }>();
  if (!a) return { applied: false, why: "no such artifact" };
  if (!a.approval_intent_by) return { applied: false, why: "the submission carried no approval acknowledgement" };
  if (a.approval_intent_applied_at) return { applied: false, why: "the acknowledgement has already been applied" };
  if (a.status !== "imported") return { applied: false, why: `the artifact is ${a.status}, so there is no measured design to approve` };

  const b = await getBaseline(db, baselineId);
  if (!b || b.artifact_id !== artifactId) return { applied: false, why: "that baseline was not measured from this artifact" };
  if (b.status !== "draft") return { applied: false, why: `that baseline is already ${b.status}` };

  // Stamped FIRST and conditionally, so two reports for the same artifact cannot both approve.
  const stamped = await db.prepare(
    `UPDATE frontend_artifacts SET approval_intent_applied_at = ?, updated_at = ?
      WHERE id = ? AND approval_intent_applied_at IS NULL`,
  ).bind(nowIso(), nowIso(), artifactId).run();
  if (!stamped.meta.changes) return { applied: false, why: "the acknowledgement was applied by another report" };

  await approveBaseline(db, baselineId, {
    approvedBy: a.approval_intent_by,
    note: `approved at submission and applied after measurement (artifact v${a.version}, sha256 ${a.sha256.slice(0, 12)}…)`,
  });
  return { applied: true, approvedBy: a.approval_intent_by, baselineVersion: b.version };
}

export async function getBaseline(db: Db, id: string): Promise<DesignBaselineRow | null> {
  return await db.prepare(`SELECT * FROM design_baselines WHERE id = ?`).bind(id).first<DesignBaselineRow>();
}

export async function approvedBaseline(db: Db, projectId: string): Promise<DesignBaselineRow | null> {
  return await db.prepare(`SELECT * FROM design_baselines WHERE project_id = ? AND status = 'approved'`)
    .bind(projectId).first<DesignBaselineRow>();
}

// -- the integration contract -----------------------------------------------------------------------------------
//
// A design-locked build is judged by three gates, and contract conformance needs a contract. The runner has
// required one since that path was written and read it from `build_pipeline.spec_json`, which holds a master
// specification -- a different thing, for the retired frontend-generation path. Nothing wrote an integration
// manifest and no screen accepted one, so every submitted artifact reached a queued build and stopped at
// "this project has no integration manifest". These functions give the contract a home and a way in.

export interface ContractRow {
  id: string;
  project_id: string;
  artifact_id: string;
  baseline_id: string;
  design_fingerprint: string;
  artifact_sha256: string;
  version: number;
  manifest_json: string;
  operations: number;
  visual_states: number;
  recorded_by: string | null;
  note: string | null;
  superseded_at: string | null;
  created_at: string;
  /** "staff" when a person wrote it, "model-a" when it was drafted from the measured frontend. */
  authored_by: string;
  author_model: string | null;
  /** The requirements the contract could not establish, as JSON. Flagged for a person, never invented. */
  review_flags_json: string;
}

/** The contract a build would be held to right now, or null when none has been recorded. */
export async function activeContract(db: Db, projectId: string): Promise<ContractRow | null> {
  return await db.prepare(
    `SELECT * FROM design_locked_contracts WHERE project_id = ? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`,
  ).bind(projectId).first<ContractRow>();
}

export async function listContracts(db: Db, projectId: string): Promise<ContractRow[]> {
  return (await db.prepare(`SELECT * FROM design_locked_contracts WHERE project_id = ? ORDER BY version DESC`)
    .bind(projectId).all<ContractRow>()).results;
}

/**
 * Operation kinds that are served over HTTP, so a criterion about them can be established by a request.
 *
 * `navigation` and `admin` are left out: the first needs no backend surface of its own, and the second is
 * release-gated and exercised by a person. Every other kind must carry at least one acceptance probe, because a
 * criterion nothing can execute is reported UNDETERMINED -- and an UNDETERMINED criterion fails the functional
 * gate. A contract with no probes is therefore a contract whose build cannot pass, and accepting one would mean
 * queueing work that is guaranteed to stop at verification.
 */
const PROBEABLE: readonly OperationKind[] = ["data-read", "data-write", "form-submit", "search", "auth", "payment", "upload"];

/** Kinds that put a row somewhere, and so need the storage to be declared rather than left to the builder. */
const PERSISTING: readonly OperationKind[] = ["data-write", "form-submit", "payment", "upload"];

export interface ContractVerdict {
  ok: boolean;
  /** Why it was refused. Every one of them, not the first: a draft is corrected against the whole list. */
  problems: string[];
  /** Recorded, not refused. */
  warnings: string[];
  /** Requirements the contract could not establish from the frontend. Flagged for a person; never invented. */
  reviewFlags: MissingRequirement[];
}

/**
 * THE INDEPENDENT VALIDATOR.
 *
 * A contract may now be drafted by Model A (Founder decision, 2026-11-07) instead of written by hand, which moves
 * all of the weight onto this function: it is the only thing standing between "a model wrote down what it intends
 * to be judged against" and "a build is held to it". So it runs HERE, on the platform, in the request that records
 * the contract -- not in the runner that authored it, and not as a step the author can skip, soften or re-run with
 * a friendlier threshold. It is deterministic: the same draft and the same measurement always give the same
 * verdict, and no model is consulted.
 *
 * What it establishes, in the Founder's terms:
 *
 *   schema correctness, artifact SHA, design fingerprint   `validateManifest`, against this project's own
 *                                                          approved baseline and artifact.
 *   consistency with the measured frontend                  every operation points at a page and an element the
 *                                                          measurement actually found. An operation on an
 *                                                          invented element is work nobody can check.
 *   operation coverage                                      every interaction the measurement says needs a
 *                                                          backend is either claimed by an operation or named
 *                                                          in `outOfScope`. Silence is not a decision.
 *   technical feasibility                                   `completeness`: a payment with no approved provider,
 *                                                          a login with no auth contract, a write to a table
 *                                                          nobody modelled, a secret that does not exist.
 *   verifiability                                           an HTTP-served operation carries a probe, and work
 *                                                          that stores data declares where it is stored.
 *
 * A genuinely unknowable business requirement is NOT a refusal: it belongs in `missing`, comes back as a review
 * flag, and is shown to a person. That is the difference between flagging a gap and inventing a fact.
 */
export function validateContractDraft(
  raw: unknown,
  measured: {
    approvedPages: readonly string[];
    interactions: readonly InteractionItem[];
    designFingerprint: string;
    artifactSha: string;
  },
): ContractVerdict & { manifest: (IntegrationManifest & ManifestContract) | null } {
  const problems: string[] = [];
  const warnings: string[] = [];

  const m = (raw ?? {}) as Partial<IntegrationManifest>;
  if (m.schema !== MANIFEST_SCHEMA) {
    return {
      ok: false, warnings, reviewFlags: [], manifest: null,
      problems: [`a contract must declare schema "${MANIFEST_SCHEMA}" (this one says ${JSON.stringify(m.schema ?? null)}). A master specification is not an integration contract.`],
    };
  }

  const checked = validateManifest(m as IntegrationManifest, {
    approvedPages: measured.approvedPages,
    designFingerprint: measured.designFingerprint,
    artifactSha: measured.artifactSha,
  });
  for (const p of checked.problems) {
    (p.severity === "reject" ? problems : warnings).push(`${p.code}: ${p.detail}`);
  }
  if (!checked.ok || !checked.manifest) {
    return { ok: false, problems: problems.length ? problems : ["the contract did not validate against the approved design"], warnings, reviewFlags: [], manifest: null };
  }
  const manifest = checked.manifest as IntegrationManifest & ManifestContract;

  // ── consistency with the measurement, and coverage of it ──
  //
  // `coverage` is given the inventory the import measured, so both halves are judged against the same facts the
  // author was given: an operation on an element that is not there, and an element that needs a backend and that
  // no operation claims.
  const cov = coverage(manifest, measured.interactions);
  for (const op of cov.unmatched) {
    problems.push(`unmeasured-element: operation "${op.id}" is about "${op.element}" on page "${op.page}", and the measurement found no such interactive element there. An operation on something that is not in the approved frontend cannot be built or checked.`);
  }
  // An uncovered interaction may be declined, but it has to be declined BY NAME: the element identifier must
  // appear in one of the `outOfScope` lines. A general apology does not say which button is staying dead.
  const declined = (manifest.outOfScope ?? []).join(" \u0001 ");
  for (const i of cov.uncovered) {
    if (declined.includes(i.element)) {
      warnings.push(`out-of-scope: "${i.element}" on "${i.page}" needs a backend and is deliberately not in the plan`);
      continue;
    }
    problems.push(`uncovered-interaction: "${i.element}" on page "${i.page}" (${i.role}) needs a backend and no operation claims it. Either plan it, or name that exact element in outOfScope and say why it is being left.`);
  }

  // ── feasibility ──
  const complete = completeness(manifest);
  for (const b of complete.blockers) {
    problems.push(`${b.code}${b.operationId ? ` [${b.operationId}]` : ""}: ${b.detail}`);
  }

  // ── verifiability ──
  for (const op of manifest.operations) {
    if (PROBEABLE.includes(op.kind) && !(op.acceptanceProbes ?? []).length) {
      problems.push(`no-probe [${op.id}]: a ${op.kind} operation is served over HTTP, so at least one of its acceptance criteria must carry an acceptanceProbe naming a declared api path and the status it must get. Without one the criterion is reported UNDETERMINED, which fails the functional gate.`);
    }
  }
  const persists = manifest.operations.some((op) => PERSISTING.includes(op.kind));
  if (persists && !manifest.persistence?.technology) {
    problems.push("no-persistence: this plan stores data and does not declare where. A build measured once stored its rows in a JSON file while the contract named a table, and every behavioural check still passed; declare persistence.technology, and whether it is `required` or `any`.");
  }

  // Declared endpoints must be distinct and look like paths: two operations probing the same path expecting
  // different things is not a contract, it is a coin toss.
  const paths = new Map<string, number>();
  for (const a of manifest.apis ?? []) {
    const key = `${String(a.method ?? "GET").toUpperCase()} ${String(a.path ?? "")}`;
    paths.set(key, (paths.get(key) ?? 0) + 1);
    if (!String(a.path ?? "").startsWith("/")) problems.push(`api-path: "${String(a.path)}" is not a path; it must begin with "/"`);
  }
  for (const [key, n] of paths) if (n > 1) problems.push(`duplicate-api: ${key} is declared ${n} times`);

  const ok = problems.length === 0;
  return { ok, problems, warnings, reviewFlags: complete.missing, manifest: ok ? manifest : null };
}

/** The measured design a contract is judged against, read off the baseline's own stored measurement. */
function measurementOf(baseline: DesignBaselineRow, artifactSha: string): {
  approvedPages: string[]; interactions: InteractionItem[]; designFingerprint: string; artifactSha: string;
} {
  const parse = <T>(s: unknown): T[] => {
    try { const v = JSON.parse(String(s ?? "[]")); return Array.isArray(v) ? (v as T[]) : []; } catch { return []; }
  };
  const pages = parse<{ page?: unknown }>(baseline.signatures_json).map((x) => String(x.page ?? "")).filter(Boolean);
  // The inventory as the import recorded it. `functional` means it already works without a backend, so it is not
  // waiting for one -- the same reduction `inventoryOf` makes in the runner, applied to the stored rows.
  const interactions = parse<{ page?: unknown; element?: unknown; role?: unknown; needsBackend?: unknown; functional?: unknown }>(baseline.interaction_inventory_json)
    .map((i) => ({
      page: String(i.page ?? ""), element: String(i.element ?? ""), role: String(i.role ?? ""),
      needsBackend: !!i.needsBackend && !i.functional,
    }))
    .filter((i) => i.page && i.element);
  return { approvedPages: [...new Set(pages)], interactions, designFingerprint: baseline.fingerprint, artifactSha };
}

/**
 * Record an integration contract for a project's approved design.
 *
 * Validated against the design it names, not merely parsed. The manifest declares pages and interactive elements,
 * and those names only mean something in one measured design: `validateManifest` is given the pages the baseline
 * actually measured, so a contract naming a page that does not exist is refused here rather than failing inside a
 * build an hour later. The artifact checksum and design fingerprint must match the approved baseline's, which is
 * what stops a contract written for an earlier design from being applied to a newer one.
 *
 * Returns the problems instead of throwing them, because the person pasting a contract needs to see all of them at
 * once, not the first.
 */
export async function recordContract(
  db: Db,
  projectId: string,
  raw: unknown,
  o: {
    /** The person recording it, or null when Model A drafted it. */
    recordedBy: string | null;
    /** Who wrote it. Provenance, kept on the row: a verification report's weight depends on it. */
    authoredBy?: "staff" | "model-a";
    /** The model tag that drafted it. A tag, never a prompt or a transcript. */
    authorModel?: string | null;
    note?: string | null;
    ip?: string | null;
  },
): Promise<
  | { ok: true; contract: ContractRow; warnings: string[]; reviewFlags: MissingRequirement[] }
  | { ok: false; problems: string[]; warnings?: string[] }
> {
  const baseline = await approvedBaseline(db, projectId);
  if (!baseline) {
    return { ok: false, problems: ["this project has no approved design yet, and a contract is written against one: approve the measured design first"] };
  }
  const artifact = await getArtifact(db, baseline.artifact_id);
  if (!artifact) return { ok: false, problems: ["the approved design's artifact is missing"] };

  // One gate, whoever is recording. A draft from Model A and a contract pasted by a person go through exactly the
  // same deterministic validation against exactly the same measured design: a model cannot be given an easier
  // check than a human, and a human cannot be given an easier one than a model.
  const checked = validateContractDraft(raw, measurementOf(baseline, artifact.sha256));
  if (!checked.ok || !checked.manifest) {
    return { ok: false, problems: checked.problems, warnings: checked.warnings };
  }

  const at = nowIso();
  const authoredBy = o.authoredBy ?? "staff";
  const prev = await activeContract(db, projectId);
  const next = ((await db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM design_locked_contracts WHERE project_id = ?`)
    .bind(projectId).first<{ v: number }>())?.v ?? 0) + 1;
  const id = newId("dlc");
  const manifest = checked.manifest;

  // The previous version is superseded, never removed: what an earlier build was held to is evidence.
  if (prev) await db.prepare(`UPDATE design_locked_contracts SET superseded_at = ? WHERE id = ?`).bind(at, prev.id).run();
  await db.prepare(
    `INSERT INTO design_locked_contracts (id, project_id, artifact_id, baseline_id, design_fingerprint, artifact_sha256,
       version, manifest_json, operations, visual_states, recorded_by, note, created_at,
       authored_by, author_model, review_flags_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, projectId, baseline.artifact_id, baseline.id, baseline.fingerprint, artifact.sha256, next,
    JSON.stringify(manifest), manifest.operations.length, (manifest.visualStates ?? []).length,
    o.recordedBy, o.note?.slice(0, 500) ?? null, at,
    authoredBy, authoredBy === "model-a" ? (o.authorModel ?? null) : null, JSON.stringify(checked.reviewFlags)).run();

  await audit(db, {
    actorUserId: o.recordedBy,
    // A drafted contract is the AI's act, and the audit says so rather than attributing it to whoever happened to
    // approve the design. `actorKind` is the only honest place for that distinction.
    actorKind: authoredBy === "model-a" ? "ai" : o.recordedBy ? "user" : "system",
    action: "design_locked_contract.recorded", subjectType: "project", subjectId: projectId,
    organizationId: artifact.organization_id,
    details: {
      version: next, supersedes: prev?.version ?? null, baselineId: baseline.id, baselineVersion: baseline.version,
      designFingerprint: baseline.fingerprint.slice(0, 12), artifactSha: artifact.sha256.slice(0, 12),
      operations: manifest.operations.length, visualStates: (manifest.visualStates ?? []).length,
      authoredBy, authorModel: authoredBy === "model-a" ? (o.authorModel ?? null) : null,
      warnings: checked.warnings.slice(0, 20),
      reviewFlags: checked.reviewFlags.map((f) => f.what).slice(0, 20),
    },
    ip: o.ip ?? null,
  });
  return { ok: true, contract: (await activeContract(db, projectId))!, warnings: checked.warnings, reviewFlags: checked.reviewFlags };
}

/**
 * A drafted contract the validator refused, written to the audit log.
 *
 * Without this, a refusal is a sentence in a runner log on a machine in a cupboard, and the project simply sits
 * there with an approved design and no build. The attempt is evidence: it says the authoring ran, what the
 * validator objected to, and how many tries were spent -- which is also how anyone can tell a bounded correction
 * loop from a runner quietly grinding against the same objection for ever.
 */
export async function recordContractRefusal(
  db: Db,
  projectId: string,
  o: { problems: readonly string[]; attempt: number; attemptsAllowed: number; authorModel?: string | null },
): Promise<void> {
  const org = await db.prepare(`SELECT organization_id FROM projects WHERE id = ?`).bind(projectId)
    .first<{ organization_id: string }>();
  await audit(db, {
    actorKind: "ai", action: "design_locked_contract.refused", subjectType: "project", subjectId: projectId,
    organizationId: org?.organization_id ?? null,
    details: {
      attempt: o.attempt, attemptsAllowed: o.attemptsAllowed, authorModel: o.authorModel ?? null,
      problems: o.problems.slice(0, 20).map((p) => p.slice(0, 300)),
    },
  });
}

export async function listBaselines(db: Db, projectId: string): Promise<DesignBaselineRow[]> {
  return (await db.prepare(`SELECT * FROM design_baselines WHERE project_id = ? ORDER BY version DESC`)
    .bind(projectId).all<DesignBaselineRow>()).results;
}

/**
 * A person approves a design, which locks it.
 *
 * `approvedBy` is required and is never defaulted. If a baseline is already approved for this project it is
 * SUPERSEDED, explicitly and audibly — §13's "an approved design must not be silently replaced by a later
 * artifact" is enforced by making the replacement a recorded, attributable act rather than a side effect.
 */
export async function approveBaseline(db: Db, baselineId: string, o: { approvedBy: string; note?: string }): Promise<DesignBaselineRow> {
  const b = await getBaseline(db, baselineId);
  if (!b) throw new DesignLockError("no such design baseline", 404);
  if (!o.approvedBy) throw new DesignLockError("a design baseline must record who approved it");
  if (b.status !== "draft") throw new DesignLockError(`this baseline is already ${b.status}; approve a new version instead`, 409);

  const at = nowIso();
  const current = await approvedBaseline(db, b.project_id);

  const statements = [];
  if (current) {
    statements.push(db.prepare(`UPDATE design_baselines SET status = 'superseded', superseded_by = ?, superseded_at = ? WHERE id = ?`)
      .bind(baselineId, at, current.id));
  }
  statements.push(db.prepare(`UPDATE design_baselines SET status = 'approved', approved_by = ?, approved_at = ?, approval_note = ? WHERE id = ?`)
    .bind(o.approvedBy, at, o.note ?? null, baselineId));
  statements.push(db.prepare(`UPDATE projects SET design_locked = 1, active_baseline_id = ?, frontend_state = 'design_locked', updated_at = ? WHERE id = ?`)
    .bind(baselineId, at, b.project_id));
  statements.push(db.prepare(`UPDATE frontend_artifacts SET status = 'imported', updated_at = ? WHERE id = ?`).bind(at, b.artifact_id));
  if (current) {
    statements.push(db.prepare(`UPDATE frontend_artifacts SET status = 'superseded', updated_at = ? WHERE id = ? AND id <> ?`)
      .bind(at, current.artifact_id, b.artifact_id));
  }
  await db.batch(statements);

  const org = (await db.prepare(`SELECT organization_id FROM projects WHERE id = ?`).bind(b.project_id).first<{ organization_id: string }>())?.organization_id ?? "";
  await audit(db, {
    organizationId: org, actorUserId: o.approvedBy, action: "design_baseline.approved",
    subjectType: "design_baseline", subjectId: baselineId,
    details: { projectId: b.project_id, version: b.version, fingerprint: b.fingerprint, supersededId: current?.id ?? null, supersededVersion: current?.version ?? null, note: o.note ?? null },
  });

  return (await getBaseline(db, baselineId))!;
}

/**
 * Roll back to a previously approved baseline.
 *
 * §17.20: the previously approved frontend is restored WITHOUT losing legitimate backend work. Nothing here
 * touches the build, the workspace or any code — it moves which baseline the verification gate compares
 * against. The backend the AI has written is unaffected, which is the whole point.
 */
export async function rollbackBaseline(db: Db, projectId: string, o: { toBaselineId: string; actorId: string; reason: string }): Promise<DesignBaselineRow> {
  const target = await getBaseline(db, o.toBaselineId);
  if (!target || target.project_id !== projectId) throw new DesignLockError("no such design baseline for this project", 404);
  if (target.status === "draft") throw new DesignLockError("that baseline was never approved, so there is nothing to roll back to", 409);
  if (!o.reason?.trim()) throw new DesignLockError("a rollback must record why");

  const at = nowIso();
  const current = await approvedBaseline(db, projectId);
  if (current?.id === o.toBaselineId) throw new DesignLockError("that baseline is already the approved one", 409);

  const statements = [];
  if (current) {
    statements.push(db.prepare(`UPDATE design_baselines SET status = 'rolled_back', superseded_at = ? WHERE id = ?`).bind(at, current.id));
  }
  statements.push(db.prepare(`UPDATE design_baselines SET status = 'approved', superseded_by = NULL, superseded_at = NULL WHERE id = ?`).bind(o.toBaselineId));
  statements.push(db.prepare(`UPDATE projects SET active_baseline_id = ?, design_locked = 1, updated_at = ? WHERE id = ?`).bind(o.toBaselineId, at, projectId));
  await db.batch(statements);

  const org = (await db.prepare(`SELECT organization_id FROM projects WHERE id = ?`).bind(projectId).first<{ organization_id: string }>())?.organization_id ?? "";
  await audit(db, {
    organizationId: org, actorUserId: o.actorId, action: "design_baseline.rolled_back",
    subjectType: "design_baseline", subjectId: o.toBaselineId,
    details: { projectId, fromVersion: current?.version ?? null, toVersion: target.version, reason: o.reason },
  });

  return (await getBaseline(db, o.toBaselineId))!;
}

// ── workflow state and the Phase D gate ─────────────────────────────────────────────────────────────────────

export async function setFrontendState(db: Db, projectId: string, state: FrontendState): Promise<void> {
  if (!FRONTEND_STATES.includes(state)) throw new DesignLockError(`unknown frontend state "${state}"`);
  await db.prepare(`UPDATE projects SET frontend_state = ?, updated_at = ? WHERE id = ?`).bind(state, nowIso(), projectId).run();
}

export async function frontendState(db: Db, projectId: string): Promise<{ designLocked: boolean; state: FrontendState | null; activeBaselineId: string | null }> {
  const p = await db.prepare(`SELECT design_locked, frontend_state, active_baseline_id FROM projects WHERE id = ?`)
    .bind(projectId).first<{ design_locked: number; frontend_state: string | null; active_baseline_id: string | null }>();
  return {
    designLocked: !!p?.design_locked,
    state: (p?.frontend_state as FrontendState | null) ?? null,
    activeBaselineId: p?.active_baseline_id ?? null,
  };
}

/**
 * THE PHASE D GATE (§15, §17.18).
 *
 * The one question the build path asks before running the retired autonomous frontend-design stage. A single
 * function, so the gate cannot be applied in one place and forgotten in another — and it refuses on the project
 * flag alone, not on the workflow state, so a project that is design-locked can never fall back into design
 * generation by moving between states.
 */
export async function designGenerationAllowed(db: Db, projectId: string): Promise<{ allowed: boolean; reason: string }> {
  const s = await frontendState(db, projectId);
  if (s.designLocked) {
    return {
      allowed: false,
      reason: "this project is design-locked: the Founder supplied the frontend, and autonomous frontend generation is retired for it",
    };
  }
  return { allowed: true, reason: "this project predates the design-locked architecture and still uses the original build path" };
}

/** Start a project on the new workflow. Nothing is locked yet: it is waiting for a frontend. */
export async function enableDesignLocked(db: Db, projectId: string, actorId: string): Promise<void> {
  const at = nowIso();
  await db.prepare(`UPDATE projects SET frontend_state = COALESCE(frontend_state, 'awaiting_frontend'), updated_at = ? WHERE id = ?`).bind(at, projectId).run();
  const org = (await db.prepare(`SELECT organization_id FROM projects WHERE id = ?`).bind(projectId).first<{ organization_id: string }>())?.organization_id ?? "";
  await audit(db, {
    organizationId: org, actorUserId: actorId, action: "project.design_locked_workflow_enabled",
    subjectType: "project", subjectId: projectId, details: { state: "awaiting_frontend" },
  });
}

// ── the dashboard read model (§13) ──────────────────────────────────────────────────────────────────────────

export interface DesignLockedRow {
  projectId: string;
  projectName: string;
  organizationId: string;
  packageId: string | null;
  state: FrontendState | null;
  designLocked: boolean;
  artifactVersion: number | null;
  artifactStatus: ArtifactStatus | null;
  framework: Framework | null;
  scanStatus: string | null;
  baselineVersion: number | null;
  baselineStatus: BaselineStatus | null;
  approvedAt: string | null;
  fingerprint: string | null;
  routes: number;
  interactionsNeedingBackend: number;
  updatedAt: string;
}

/** Everything §13 asks the dashboard to show, in one query per project list. */
export async function dashboard(db: Db, o: { organizationId?: string; limit?: number } = {}): Promise<DesignLockedRow[]> {
  const limit = Math.min(Math.max(1, o.limit ?? 100), 500);
  const rows = (await db.prepare(
    `SELECT p.id AS projectId, p.name AS projectName, p.organization_id AS organizationId, p.design_locked AS designLocked,
            p.frontend_state AS state, p.updated_at AS updatedAt, pr.package_id AS packageId,
            fa.version AS artifactVersion, fa.status AS artifactStatus, fa.framework AS framework, fa.scan_status AS scanStatus,
            b.version AS baselineVersion, b.status AS baselineStatus, b.approved_at AS approvedAt, b.fingerprint AS fingerprint,
            b.route_manifest_json AS routesJson, b.interaction_inventory_json AS interactionsJson
       FROM projects p
       LEFT JOIN (SELECT project_id, MAX(version) AS v FROM frontend_artifacts GROUP BY project_id) m ON m.project_id = p.id
       LEFT JOIN frontend_artifacts fa ON fa.project_id = p.id AND fa.version = m.v
       LEFT JOIN design_baselines b ON b.id = p.active_baseline_id
       LEFT JOIN (SELECT project_id, package_id FROM build_jobs GROUP BY project_id) pr ON pr.project_id = p.id
      WHERE (p.design_locked = 1 OR p.frontend_state IS NOT NULL)
        ${o.organizationId ? "AND p.organization_id = ?" : ""}
      ORDER BY p.updated_at DESC LIMIT ?`,
  ).bind(...(o.organizationId ? [o.organizationId, limit] : [limit])).all<Record<string, unknown>>()).results;

  const count = (json: unknown, pick?: (x: Record<string, unknown>) => boolean): number => {
    try {
      const a = JSON.parse(String(json ?? "[]")) as Record<string, unknown>[];
      return pick ? a.filter(pick).length : a.length;
    } catch { return 0; }
  };

  return rows.map((r) => ({
    projectId: String(r.projectId),
    projectName: String(r.projectName),
    organizationId: String(r.organizationId),
    packageId: (r.packageId as string | null) ?? null,
    state: (r.state as FrontendState | null) ?? null,
    designLocked: !!r.designLocked,
    artifactVersion: (r.artifactVersion as number | null) ?? null,
    artifactStatus: (r.artifactStatus as ArtifactStatus | null) ?? null,
    framework: (r.framework as Framework | null) ?? null,
    scanStatus: (r.scanStatus as string | null) ?? null,
    baselineVersion: (r.baselineVersion as number | null) ?? null,
    baselineStatus: (r.baselineStatus as BaselineStatus | null) ?? null,
    approvedAt: (r.approvedAt as string | null) ?? null,
    fingerprint: (r.fingerprint as string | null) ?? null,
    routes: count(r.routesJson),
    interactionsNeedingBackend: count(r.interactionsJson, (x) => x.needsBackend === true && x.functional !== true),
    updatedAt: String(r.updatedAt),
  }));
}

// ── the build path (§15 Phase D, §17.18) ────────────────────────────────────────────────────────────────────

/**
 * Put a newly created build on the right footing for its project.
 *
 * A design-locked project never enters the `design` phase, because that phase IS autonomous frontend design.
 * It starts at `design_locked` with the approved baseline already attached, so Model B's first turn is backend
 * integration against a frozen design rather than an invitation to invent a layout.
 *
 * Called immediately after a build row is inserted. For every project that is not design-locked this is a
 * no-op, which is how the existing pipeline is left exactly as it was.
 */
export async function applyDesignLock(db: Db, jobId: string, projectId: string): Promise<{ applied: boolean; phase: string; baselineId: string | null }> {
  const s = await frontendState(db, projectId);
  if (!s.designLocked) return { applied: false, phase: "design", baselineId: null };

  const baseline = await approvedBaseline(db, projectId);
  await db.prepare(`UPDATE build_jobs SET build_phase = 'design_locked', updated_at = ? WHERE id = ?`).bind(nowIso(), jobId).run();
  await setFrontendState(db, projectId, "building_backend");

  const org = (await db.prepare(`SELECT organization_id FROM projects WHERE id = ?`).bind(projectId).first<{ organization_id: string }>())?.organization_id ?? "";
  await audit(db, {
    organizationId: org, actorKind: "system", action: "builds.design_generation_skipped",
    subjectType: "build_job", subjectId: jobId,
    details: {
      projectId,
      reason: "the project is design-locked: the Founder supplied the frontend and autonomous frontend generation is retired for it",
      baselineId: baseline?.id ?? null, baselineVersion: baseline?.version ?? null, fingerprint: baseline?.fingerprint ?? null,
    },
  });

  return { applied: true, phase: "design_locked", baselineId: baseline?.id ?? null };
}

/**
 * May this job run the retired design phase?
 *
 * The phase machinery asks before putting a job into `design`. Returning false here is what makes the gate
 * impossible to route around by moving a job between phases.
 */
export async function designPhaseAllowedForJob(db: Db, jobId: string): Promise<{ allowed: boolean; reason: string }> {
  const j = await db.prepare(`SELECT project_id FROM build_jobs WHERE id = ?`).bind(jobId).first<{ project_id: string }>();
  if (!j) return { allowed: true, reason: "no such job" };
  return await designGenerationAllowed(db, j.project_id);
}

// ── authenticated delivery to the runner ────────────────────────────────────────────────────────────────────
//
// Node 1 asks for "the frontend for the job I hold a lease on". It does not get to name an artifact, a project
// or a version, and that is the whole design: every parameter it could supply is a parameter it could get
// wrong or be tricked into supplying. The artifact is resolved from the job's own project and from the
// baseline a person APPROVED, so:
//
//   - cross-project access is impossible: the project comes from the leased job, never from the request;
//   - substitution is impossible: the artifact is the one the approved baseline points at, not the newest
//     upload, so a later unapproved upload cannot reach a running build;
//   - expired authorization cannot be reused: `leasedJob` already refuses a job whose lease has moved on;
//   - an unscanned or infected artifact is never served, whatever its status was when it was recorded.

export class DeliveryError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export interface ArtifactDelivery {
  artifactId: string;
  version: number;
  /** The baseline that authorises this artifact. A build is only ever given an APPROVED design. */
  baselineId: string;
  baselineVersion: number;
  designFingerprint: string;
  sha256: string;
  sizeBytes: number;
  framework: Framework | null;
  archiveRoot: string | null;
  filename: string;
  /** The archive itself. The runner checks this against `sha256` before it opens it. */
  base64: string;
  scanStatus: string;
  /** False for a repository fixture. Never "assumed true". */
  scanned: boolean;
}

/**
 * The approved frontend for a leased build.
 *
 * `job` comes from `leasedJob`, so possession of a valid lease is the authorization. Nothing about which
 * artifact is returned is taken from the request.
 */
export async function deliverApprovedArtifact(
  db: Db,
  storage: StorageAdapter | null,
  job: { id: string; project_id: string; organization_id: string },
): Promise<ArtifactDelivery> {
  const state = await frontendState(db, job.project_id);
  if (!state.designLocked || !state.activeBaselineId) {
    throw new DeliveryError("this project has no approved design baseline, so there is no authorised frontend to deliver", 409);
  }

  const baseline = await getBaseline(db, state.activeBaselineId);
  if (!baseline || baseline.status !== "approved") {
    throw new DeliveryError("the project's active baseline is not approved", 409);
  }
  // Belt and braces. The baseline is reached through the project, and the project through the leased job, so
  // this can only fail if the two records have been made inconsistent some other way.
  if (baseline.project_id !== job.project_id) {
    throw new DeliveryError("the approved baseline belongs to a different project", 403);
  }

  const artifact = await getArtifact(db, baseline.artifact_id);
  if (!artifact) throw new DeliveryError("the approved baseline points at an artifact that no longer exists", 409);
  if (artifact.project_id !== job.project_id) throw new DeliveryError("the approved artifact belongs to a different project", 403);

  // The scanning gate, applied again at delivery. An artifact may have been recorded clean and later flagged;
  // what matters is its status now, at the moment it is about to be unpacked and built.
  const scanned = artifact.source !== "internal_fixture";
  if (scanned) {
    const file = artifact.file_id
      ? await db.prepare(`SELECT scan_status, r2_key, filename, size_bytes, sha256, deleted_at FROM files WHERE id = ?`)
        .bind(artifact.file_id).first<{ scan_status: string; r2_key: string; filename: string; size_bytes: number; sha256: string; deleted_at: string | null }>()
      : null;
    if (!file) throw new DeliveryError("the approved artifact has no stored file", 409);
    if (file.deleted_at) throw new DeliveryError("the approved artifact's file has been deleted", 410);
    if (file.scan_status !== "clean") {
      throw new DeliveryError(`the approved artifact is not clean (scan status "${file.scan_status}"); it is not delivered to a build`, 409);
    }
    if (file.sha256 !== artifact.sha256) {
      throw new DeliveryError("the stored file's hash does not match the artifact record; the artifact is not delivered", 409);
    }
    if (!storage) throw new DeliveryError("file storage is not configured, so the artifact cannot be read", 503);

    const obj = await storage.get(file.r2_key);
    if (!obj) throw new DeliveryError("the approved artifact's bytes are missing from storage", 410);
    // `StoredObject.body` is a stream in R2 and bytes on local disk; both are read the same way here so the
    // delivery behaves identically in development and in staging.
    const bytes = obj.body instanceof Uint8Array
      ? obj.body
      : new Uint8Array(obj.body instanceof ArrayBuffer ? obj.body : await new Response(obj.body).arrayBuffer());

    // The hash is recomputed from the bytes actually read, not trusted from the row. This is the check that
    // catches a swapped object in storage.
    const actual = await sha256Hex(bytes);
    if (actual !== artifact.sha256) {
      throw new DeliveryError("the stored bytes do not hash to the approved artifact's sha256; delivery refused", 409);
    }

    await audit(db, {
      organizationId: job.organization_id, actorKind: "system", action: "frontend_artifact.delivered",
      subjectType: "frontend_artifact", subjectId: artifact.id,
      details: { jobId: job.id, projectId: job.project_id, version: artifact.version, baselineId: baseline.id, sha256: artifact.sha256, sizeBytes: bytes.length },
    });

    return {
      artifactId: artifact.id, version: artifact.version,
      baselineId: baseline.id, baselineVersion: baseline.version, designFingerprint: baseline.fingerprint,
      sha256: artifact.sha256, sizeBytes: bytes.length,
      framework: artifact.framework, archiveRoot: artifact.archive_root,
      filename: file.filename, base64: base64FromBytes(bytes),
      scanStatus: file.scan_status, scanned: true,
    };
  }

  // A repository fixture has no uploaded file. It is delivered only where one is configured, and the record
  // says plainly that nothing scanned it.
  throw new DeliveryError("this artifact is an internal fixture with no stored file; it is supplied to the runner directly, not through delivery", 409);
}

function base64FromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
