// Delivering a finished website to an existing customer project.
//
// The step that was missing. The Artifact Builder produces a complete website under one of Crestmont's own
// projects -- `createTestProject` makes one per upload -- and there was no way to hand that website to the
// customer who is actually buying it without creating a duplicate project and losing the build's provenance.
//
// This module is that handover, and it is deliberately conservative about three things:
//
//   1. WHAT MAY BE DELIVERED. Only a build that has genuinely finished and has a stored snapshot. A failed,
//      cancelled, queued, paused or still-running build is not a website, and a build whose mandatory gates
//      failed is not a finished one. Staff can inspect any of those internally; none of them can be assigned.
//   2. WHO IT GOES TO. The project is named explicitly and its organisation is read from the project itself, so
//      an assignment cannot quietly land on another customer's project. Both are stored, and they must agree.
//   3. WHEN THE CUSTOMER SEES IT. Assigning is not showing. They are two decisions by two acts, because "this
//      website is on your project" and "please look at this website" are different statements -- and neither is
//      "the customer approved it", which only the customer can say.
//
// Nothing here deletes or overwrites a build artifact. A replacement supersedes; the previous delivery stays for
// the history and for a rollback.

import type { Db } from "../lib/db.ts";
import { likeContains, newId, nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { validateExternalUrl } from "../domain/external-url.ts";

export type DeliveryStatus =
  | "assigned" | "customer_visible" | "review_requested" | "revision_requested" | "approved" | "delivered" | "superseded" | "archived";

/**
 * Where the delivered website comes from (migration 0097). Each has its own columns and its own way of being
 * opened: an AI build is served from its stored snapshot through the signed preview capability; an external
 * website is opened at its own HTTPS address in a new tab, and Crestmont never fetches, frames or proxies it.
 */
export type DeliverySource = "ai_build" | "external_url";

export interface DeliveryRow {
  id: string;
  project_id: string;
  organization_id: string;
  source: DeliverySource;
  /** 1, 2, 3 ... within the project. A replacement or a restore is always a new number. */
  version: number;
  website_name: string | null;
  /** external_url only. */
  website_url: string | null;
  /** ai_build only (NULL for an external website). */
  job_id: string | null;
  source_project_id: string | null;
  revision_attempt: number | null;
  revision_cycle: number | null;
  artifact_id: string | null;
  baseline_id: string | null;
  contract_id: string | null;
  status: DeliveryStatus;
  assigned_by: string;
  assigned_at: string;
  assigned_to: string | null;
  visible_at: string | null;
  visible_by: string | null;
  customer_reviewed_at: string | null;
  customer_decision: "approved" | "revision_requested" | null;
  customer_note: string | null;
  customer_decided_by: string | null;
  superseded_by: string | null;
  superseded_at: string | null;
  archived_at: string | null;
  archived_by: string | null;
  restored_from: string | null;
  /** Staff-only internal notes. Never rendered in the customer portal. */
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** The next version number for a project. Versions are never reused, so "version 2" always names one row. */
export async function nextVersion(db: Db, projectId: string): Promise<number> {
  const r = await db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM website_deliveries WHERE project_id = ?`)
    .bind(projectId).first<{ v: number }>();
  return (r?.v ?? 0) + 1;
}

/** Build states that mean the work is finished. Anything else is in progress, stopped or dead. */
const FINISHED = ["ready_for_review", "approved"] as const;

export interface Eligibility {
  ok: boolean;
  /** Why not, in words a person can act on. */
  reasons: string[];
  /** The newest stored snapshot, when there is one. */
  revision: { attempt: number; cycle: number } | null;
  job: { id: string; project_id: string; organization_id: string; state: string } | null;
}

/**
 * May this build be delivered to a customer at all?
 *
 * Read rather than asserted: the answer is shown next to the assign control, so a build that cannot be delivered
 * says why instead of offering an action that will fail.
 */
export async function eligibility(db: Db, jobId: string): Promise<Eligibility> {
  const job = await db.prepare(`SELECT id, project_id, organization_id, state FROM build_jobs WHERE id = ?`)
    .bind(jobId).first<{ id: string; project_id: string; organization_id: string; state: string }>();
  if (!job) return { ok: false, reasons: ["no such build"], revision: null, job: null };

  const reasons: string[] = [];
  if (!(FINISHED as readonly string[]).includes(job.state)) {
    reasons.push(`this build is "${job.state}"; only a finished build (${FINISHED.join(" or ")}) can be delivered to a customer`);
  }

  // The snapshot is what a customer would actually open, so a build with none has nothing to deliver however
  // finished it claims to be.
  const rev = await db.prepare(
    `SELECT attempt, cycle FROM build_revisions WHERE job_id = ? ORDER BY attempt DESC, cycle DESC LIMIT 1`,
  ).bind(jobId).first<{ attempt: number; cycle: number }>();
  if (!rev) reasons.push("this build has stored no website snapshot, so there is nothing for a customer to open");

  // A recorded scorecard that did not pass its mandatory gates is a build that is not finished, whatever its
  // state column says. Absence of a scorecard is not treated as failure: not every build path records one, and
  // inventing a verdict from a missing row is how an unverified website becomes a delivered one.
  const q = await db.prepare(
    `SELECT outcome, verified, design_certified, design_blockers_json FROM build_quality
      WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(jobId).first<{ outcome: string; verified: number; design_certified: number; design_blockers_json: string }>();
  if (q) {
    if (!q.verified) reasons.push("this build's quality scorecard is not verified, so its acceptance criteria have no evidence behind them");
    let blockers: unknown[] = [];
    try { const v = JSON.parse(q.design_blockers_json ?? "[]"); blockers = Array.isArray(v) ? v : []; } catch { blockers = []; }
    if (blockers.length) reasons.push(`this build has ${blockers.length} unresolved design blocker(s), so its approved design is not preserved`);
  }

  return { ok: reasons.length === 0, reasons, revision: rev ? { attempt: rev.attempt, cycle: rev.cycle } : null, job };
}

/** The delivery a project is showing right now, or null. */
export async function activeForProject(db: Db, projectId: string): Promise<DeliveryRow | null> {
  return db.prepare(`SELECT * FROM website_deliveries WHERE project_id = ? AND superseded_at IS NULL`)
    .bind(projectId).first<DeliveryRow>();
}

/** Every delivery a project has had, newest first. History, not state. */
export async function historyForProject(db: Db, projectId: string): Promise<DeliveryRow[]> {
  return (await db.prepare(`SELECT * FROM website_deliveries WHERE project_id = ? ORDER BY assigned_at DESC`)
    .bind(projectId).all<DeliveryRow>()).results;
}

/** What this build has been delivered to, if anything. */
export async function deliveriesOfJob(db: Db, jobId: string): Promise<DeliveryRow[]> {
  return (await db.prepare(`SELECT * FROM website_deliveries WHERE job_id = ? ORDER BY assigned_at DESC`)
    .bind(jobId).all<DeliveryRow>()).results;
}

/**
 * The customer-visible delivery for an organisation's project.
 *
 * The portal's only read. It filters on the ORGANISATION as well as the project, so a project id from another
 * customer returns nothing rather than returning a row that a later check has to notice.
 */
export async function visibleForCustomer(db: Db, organizationId: string, projectId: string): Promise<DeliveryRow | null> {
  return db.prepare(
    `SELECT * FROM website_deliveries
      WHERE project_id = ? AND organization_id = ? AND superseded_at IS NULL AND visible_at IS NOT NULL`,
  ).bind(projectId, organizationId).first<DeliveryRow>();
}

export interface AssignInput {
  jobId: string;
  /** The EXISTING customer project. Its organisation is read from it, never supplied by the caller. */
  projectId: string;
  actorId: string;
  /** Show it to the customer in the same act. Off by default: assigning and showing are two decisions. */
  makeVisible?: boolean;
  note?: string | null;
  ip?: string | null;
}

/**
 * Assign a finished website to an existing customer project.
 *
 * Supersedes whatever that project was showing, rather than refusing or duplicating: replacing the website on a
 * project is the ordinary case, and the partial unique index would refuse a second live row anyway. The previous
 * delivery keeps its row, so `rollbackTo` has something to go back to and the history says who changed it.
 */
export async function assignToProject(
  db: Db,
  i: AssignInput,
): Promise<{ ok: true; delivery: DeliveryRow; superseded: string | null } | { ok: false; why: string }> {
  const elig = await eligibility(db, i.jobId);
  if (!elig.ok || !elig.revision || !elig.job) {
    return { ok: false, why: elig.reasons.join("; ") || "this build cannot be delivered" };
  }

  const project = await db.prepare(`SELECT id, organization_id, name, status FROM projects WHERE id = ?`)
    .bind(i.projectId).first<{ id: string; organization_id: string; name: string; status: string }>();
  if (!project) return { ok: false, why: "no such project" };
  if (project.status === "cancelled") return { ok: false, why: `"${project.name}" is cancelled, so a website is not delivered to it` };

  // The build's own organisation is Crestmont's for an Artifact Builder project, so it is NOT required to match.
  // What matters is that the website lands on the project that was named and on that project's own customer.
  const at = nowIso();
  const previous = await activeForProject(db, i.projectId);

  // The provenance of what is being delivered, read from the build's own project rather than assumed.
  const artifact = await db.prepare(
    `SELECT a.id AS artifact_id, b.id AS baseline_id, c.id AS contract_id
       FROM frontend_artifacts a
       LEFT JOIN design_baselines b ON b.artifact_id = a.id AND b.status = 'approved'
       LEFT JOIN design_locked_contracts c ON c.project_id = a.project_id AND c.superseded_at IS NULL
      WHERE a.project_id = ? AND a.status = 'imported'
      ORDER BY a.version DESC LIMIT 1`,
  ).bind(elig.job.project_id).first<{ artifact_id: string; baseline_id: string | null; contract_id: string | null }>();

  const id = newId("wdl");
  const version = await nextVersion(db, project.id);
  // Superseding takes three statements, and the order is forced by two constraints that pull against each other.
  //
  // `superseded_by` is a foreign key to this table, so it cannot be set to a row that does not exist yet -- and
  // the partial unique index allows only one row per project with `superseded_at IS NULL`, so the new row cannot
  // be inserted while the old one is still live. Setting `superseded_at` first frees the index, the insert then
  // succeeds, and the link back is written last. Both orderings of the obvious two-statement version fail, one
  // with a foreign-key violation and one with a uniqueness violation.
  if (previous) {
    await db.prepare(`UPDATE website_deliveries SET status = 'superseded', superseded_at = ?, updated_at = ? WHERE id = ?`)
      .bind(at, at, previous.id).run();
  }
  await db.prepare(
    `INSERT INTO website_deliveries (id, project_id, organization_id, source, version, website_name, job_id, source_project_id,
       revision_attempt, revision_cycle, artifact_id, baseline_id, contract_id, status,
       assigned_by, assigned_at, assigned_to, visible_at, visible_by, note, created_at, updated_at)
     VALUES (?,?,?,'ai_build',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, project.id, project.organization_id, version, previous?.website_name ?? null, i.jobId, elig.job.project_id,
    elig.revision.attempt, elig.revision.cycle,
    artifact?.artifact_id ?? null, artifact?.baseline_id ?? null, artifact?.contract_id ?? null,
    i.makeVisible ? "customer_visible" : "assigned",
    i.actorId, at, previous?.assigned_to ?? i.actorId, i.makeVisible ? at : null, i.makeVisible ? i.actorId : null,
    i.note?.slice(0, 500) ?? null, at, at,
  ).run();
  if (previous) {
    await db.prepare(`UPDATE website_deliveries SET superseded_by = ? WHERE id = ?`).bind(id, previous.id).run();
  }

  await audit(db, {
    actorUserId: i.actorId, actorKind: "user", action: "website_delivery.assigned",
    subjectType: "project", subjectId: project.id, organizationId: project.organization_id,
    details: {
      deliveryId: id, source: "ai_build", version, jobId: i.jobId, sourceProjectId: elig.job.project_id,
      revision: `${elig.revision.attempt}-${elig.revision.cycle}`,
      supersedes: previous?.id ?? null, visibleToCustomer: !!i.makeVisible,
      artifactId: artifact?.artifact_id ?? null, baselineId: artifact?.baseline_id ?? null,
    },
    ip: i.ip ?? null,
  });

  return { ok: true, delivery: (await byId(db, id))!, superseded: previous?.id ?? null };
}

export async function byId(db: Db, id: string): Promise<DeliveryRow | null> {
  return db.prepare(`SELECT * FROM website_deliveries WHERE id = ?`).bind(id).first<DeliveryRow>();
}

/**
 * Let the customer see a delivery that is already assigned to their project.
 *
 * Separate from assigning on purpose. A website can sit on a project while somebody checks it, and the moment it
 * becomes visible to a customer is a decision worth recording by itself.
 */
export async function makeVisibleToCustomer(
  db: Db,
  deliveryId: string,
  o: { actorId: string; ip?: string | null },
): Promise<{ ok: true; delivery: DeliveryRow } | { ok: false; why: string }> {
  const d = await byId(db, deliveryId);
  if (!d) return { ok: false, why: "no such delivery" };
  if (d.superseded_at) return { ok: false, why: "this delivery has been superseded; show the current one instead" };
  if (d.visible_at) return { ok: true, delivery: d };

  const at = nowIso();
  await db.prepare(`UPDATE website_deliveries SET visible_at = ?, visible_by = ?, status = 'customer_visible', updated_at = ? WHERE id = ? AND superseded_at IS NULL`)
    .bind(at, o.actorId, at, deliveryId).run();
  await audit(db, {
    actorUserId: o.actorId, actorKind: "user", action: "website_delivery.made_visible",
    subjectType: "project", subjectId: d.project_id, organizationId: d.organization_id,
    details: { deliveryId, source: d.source, version: d.version, jobId: d.job_id, websiteUrl: d.website_url,
      revision: d.source === "ai_build" ? `${d.revision_attempt}-${d.revision_cycle}` : null },
    ip: o.ip ?? null,
  });
  return { ok: true, delivery: (await byId(db, deliveryId))! };
}

/**
 * Go back to a delivery this project has had before.
 *
 * A new row rather than un-superseding the old one: the old row records what was live between two moments, and
 * rewriting it would lose that. The website delivered is the one the earlier row named -- the same stored snapshot
 * for an AI build, the same address for an external website -- so a restore shows the customer exactly what they
 * saw before. It gets the next version number and no customer decision: an approval of the earlier version is the
 * customer's verdict on THAT version, and is never carried forward onto a new one.
 *
 * `makeVisible` decides whether the restored version is shown to the customer straight away. Left out, it follows
 * the earlier version (the original behaviour of this function).
 */
export async function rollbackTo(
  db: Db,
  o: { projectId: string; deliveryId: string; actorId: string; makeVisible?: boolean; ip?: string | null },
): Promise<{ ok: true; delivery: DeliveryRow } | { ok: false; why: string }> {
  const past = await byId(db, o.deliveryId);
  if (!past) return { ok: false, why: "no such delivery" };
  if (past.project_id !== o.projectId) return { ok: false, why: "that delivery belongs to another project" };
  if (!past.superseded_at) return { ok: false, why: "that delivery is already the current one" };

  const at = nowIso();
  const current = await activeForProject(db, o.projectId);
  const id = newId("wdl");
  const version = await nextVersion(db, o.projectId);
  const visible = o.makeVisible ?? !!past.visible_at;
  // Same three-step supersede as `assignToProject`; see the note there for why the order is forced.
  if (current) {
    await db.prepare(`UPDATE website_deliveries SET status = 'superseded', superseded_at = ?, updated_at = ? WHERE id = ?`)
      .bind(at, at, current.id).run();
  }
  await db.prepare(
    `INSERT INTO website_deliveries (id, project_id, organization_id, source, version, website_name, website_url,
       job_id, source_project_id, revision_attempt, revision_cycle, artifact_id, baseline_id, contract_id, status,
       assigned_by, assigned_at, assigned_to, visible_at, visible_by, restored_from, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, past.project_id, past.organization_id, past.source, version, past.website_name, past.website_url,
    past.job_id, past.source_project_id, past.revision_attempt, past.revision_cycle, past.artifact_id, past.baseline_id, past.contract_id,
    visible ? "customer_visible" : "assigned",
    o.actorId, at, current?.assigned_to ?? past.assigned_to ?? o.actorId, visible ? at : null, visible ? o.actorId : null,
    past.id, `restored from version ${past.version} (delivered ${past.assigned_at})`, at, at,
  ).run();
  if (current) {
    await db.prepare(`UPDATE website_deliveries SET superseded_by = ? WHERE id = ?`).bind(id, current.id).run();
  }

  await audit(db, {
    actorUserId: o.actorId, actorKind: "user", action: "website_delivery.rolled_back",
    subjectType: "project", subjectId: past.project_id, organizationId: past.organization_id,
    details: {
      deliveryId: id, version, restoredFrom: past.id, restoredVersion: past.version, source: past.source,
      jobId: past.job_id, websiteUrl: past.website_url,
      revision: past.source === "ai_build" ? `${past.revision_attempt}-${past.revision_cycle}` : null,
      supersedes: current?.id ?? null, visibleToCustomer: visible,
    },
    ip: o.ip ?? null,
  });
  return { ok: true, delivery: (await byId(db, id))! };
}

/**
 * The customer's own verdict on a website they were shown.
 *
 * Recorded only from a customer act, and never inferred from the website being visible. "They can see it" is not
 * "they approved it", and the difference is the whole reason these are separate columns.
 *
 * One decision per version: once the customer has approved or asked for changes, that is the record for that
 * version and it is not silently overwritten. A revised website is a new version with its own decision.
 */
export async function recordCustomerDecision(
  db: Db,
  o: {
    organizationId: string; projectId: string; decision: "approved" | "revision_requested";
    actorId: string; note?: string | null; ip?: string | null;
  },
): Promise<{ ok: true; delivery: DeliveryRow } | { ok: false; why: string }> {
  const d = await visibleForCustomer(db, o.organizationId, o.projectId);
  if (!d) return { ok: false, why: "there is no website available on this project" };
  if (d.customer_decision) {
    return { ok: false, why: `you already ${d.customer_decision === "approved" ? "approved" : "requested changes to"} this version of the website` };
  }
  const note = o.note?.trim().slice(0, 1000) || null;
  if (o.decision === "revision_requested" && !note) return { ok: false, why: "please describe the changes you would like" };

  const at = nowIso();
  await db.prepare(
    `UPDATE website_deliveries SET customer_reviewed_at = ?, customer_decision = ?, customer_note = ?, customer_decided_by = ?,
        status = ?, updated_at = ?
      WHERE id = ? AND superseded_at IS NULL AND customer_decision IS NULL`,
  ).bind(at, o.decision, note, o.actorId || null, o.decision === "approved" ? "approved" : "revision_requested", at, d.id).run();
  await audit(db, {
    actorUserId: o.actorId, actorKind: "user", action: "website_delivery.customer_decision",
    subjectType: "project", subjectId: d.project_id, organizationId: d.organization_id,
    details: { deliveryId: d.id, decision: o.decision, version: d.version, source: d.source, jobId: d.job_id },
    ip: o.ip ?? null,
  });
  return { ok: true, delivery: (await byId(db, d.id))! };
}

export interface AssignTarget {
  projectId: string;
  projectName: string;
  organizationId: string;
  organizationName: string;
  status: string;
  /** What that project is already showing, so nobody replaces a live website without seeing it. */
  current: { deliveryId: string; jobId: string | null; revision: string; visible: boolean } | null;
}

/**
 * The existing projects a finished website may be assigned to.
 *
 * Crestmont's own internal organisation is excluded: those are the builder's working projects, not customers, and
 * offering them as delivery targets is how a website gets "delivered" to nobody.
 */
export async function assignTargets(db: Db, o: { query?: string; limit?: number } = {}): Promise<AssignTarget[]> {
  // `likeContains` rather than a hand-built pattern: D1 refuses a LIKE pattern over 50 bytes, so a long search
  // term was a 500 rather than an empty result. The fuzzer found it with twenty characters.
  const q = (o.query ?? "").trim().toLowerCase();
  const like = likeContains(q);
  const rows = (await db.prepare(
    `SELECT p.id AS project_id, p.name AS project_name, p.status, o.id AS organization_id, o.name AS organization_name
       FROM projects p JOIN organizations o ON o.id = p.organization_id
      WHERE o.kind <> 'internal'
        AND p.status <> 'cancelled'
        AND (? = '' OR LOWER(p.name) LIKE ? ESCAPE '\\' OR LOWER(o.name) LIKE ? ESCAPE '\\')
      ORDER BY o.name, p.name
      LIMIT ?`,
  ).bind(q, like, like, Math.min(200, Math.max(1, o.limit ?? 50))).all<{
    project_id: string; project_name: string; status: string; organization_id: string; organization_name: string;
  }>()).results;

  const out: AssignTarget[] = [];
  for (const r of rows) {
    const current = await activeForProject(db, r.project_id);
    out.push({
      projectId: r.project_id, projectName: r.project_name, organizationId: r.organization_id,
      organizationName: r.organization_name, status: r.status,
      current: current
        ? {
          deliveryId: current.id, jobId: current.job_id, visible: !!current.visible_at,
          revision: current.source === "ai_build" ? `${current.revision_attempt}-${current.revision_cycle}` : `external website, version ${current.version}`,
        }
        : null,
    });
  }
  return out;
}

/** The delivery status in words, for both the staff page and the portal. */
export const DELIVERY_LABEL: Record<DeliveryStatus, string> = {
  assigned: "Assigned to project",
  customer_visible: "Available to customer",
  review_requested: "Customer review requested",
  revision_requested: "Revision requested",
  approved: "Approved by customer",
  delivered: "Delivered",
  superseded: "Replaced by a later version",
  archived: "Archived",
};


// ── Website Delivery tab: externally hosted websites (migration 0097) ─────────────────────────────────────────────
//
// Everything below is independent of the AI Website Builder and the Artifact Builder: it reads and writes only
// `website_deliveries`, `projects`, `organizations` and `users`, and never a build job, revision or artifact.

export const WEBSITE_NAME_MAX = 120;
export const NOTE_MAX = 2000;

type Result<T> = { ok: true } & T | { ok: false; why: string };

/** A customer project a website may be delivered to: it exists, belongs to a customer, and is not cancelled. */
async function customerProject(db: Db, projectId: string) {
  return db.prepare(
    `SELECT p.id, p.name, p.status, p.organization_id, o.name AS organization_name, o.kind
       FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.id = ?`,
  ).bind(projectId).first<{ id: string; name: string; status: string; organization_id: string; organization_name: string; kind: string }>();
}

/** Is this user active Crestmont staff? (Only staff may be responsible for a delivery.) */
export async function isActiveStaff(db: Db, userId: string): Promise<boolean> {
  return !!(await db.prepare(
    `SELECT 1 AS ok FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.user_id = ? AND u.disabled_at IS NULL
        AND m.role_id IN ('owner','administrator','sales','developer','project_manager','support')`,
  ).bind(userId).first());
}

/** Active staff, for the "assigned staff member" choice. */
export async function staffMembers(db: Db): Promise<{ id: string; display_name: string }[]> {
  return (await db.prepare(
    `SELECT DISTINCT u.id, u.display_name FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE u.disabled_at IS NULL AND m.role_id IN ('owner','administrator','sales','developer','project_manager','support')
      ORDER BY u.display_name LIMIT 200`,
  ).all<{ id: string; display_name: string }>()).results;
}

function cleanName(v: string | null | undefined): string {
  return (v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export interface ExternalInput {
  /** The EXISTING customer project. Its organisation is read from it, never supplied by the caller. */
  projectId: string;
  websiteName: string;
  websiteUrl: string;
  note?: string | null;
  /** Save & Share (true) or Save Draft (false). */
  share: boolean;
  actorId: string;
  assignedTo?: string | null;
  ip?: string | null;
}

/** Field-by-field validation for the Add Website form, so every problem is reported at once. */
export function validateExternalInput(i: { projectId?: string; websiteName?: string; websiteUrl?: string; note?: string | null }): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!i.projectId) errors.projectId = "Choose the customer's existing project.";
  const name = cleanName(i.websiteName);
  if (!name) errors.websiteName = "Give the website a name, for example \u201cHarbor Dental website\u201d.";
  else if (name.length > WEBSITE_NAME_MAX) errors.websiteName = `Keep the name under ${WEBSITE_NAME_MAX} characters.`;
  const url = validateExternalUrl(i.websiteUrl);
  if (!url.ok) errors.websiteUrl = url.error;
  if ((i.note ?? "").length > NOTE_MAX) errors.note = `Keep internal notes under ${NOTE_MAX} characters.`;
  return errors;
}

/**
 * Insert a new external-website version on a project, superseding whatever was live there.
 * Shared by "add a website" and "replace the website", which differ only in how they are reached and audited.
 */
async function insertExternalVersion(
  db: Db,
  project: { id: string; organization_id: string },
  v: { name: string; url: string; note: string | null; share: boolean; actorId: string; assignedTo: string },
): Promise<{ id: string; version: number; superseded: string | null }> {
  const at = nowIso();
  const previous = await activeForProject(db, project.id);
  const version = await nextVersion(db, project.id);
  const id = newId("wdl");
  if (previous) {
    await db.prepare(`UPDATE website_deliveries SET status = 'superseded', superseded_at = ?, updated_at = ? WHERE id = ?`)
      .bind(at, at, previous.id).run();
  }
  await db.prepare(
    `INSERT INTO website_deliveries (id, project_id, organization_id, source, version, website_name, website_url, status,
       assigned_by, assigned_at, assigned_to, visible_at, visible_by, note, created_at, updated_at)
     VALUES (?,?,?,'external_url',?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, project.id, project.organization_id, version, v.name, v.url, v.share ? "customer_visible" : "assigned",
    v.actorId, at, v.assignedTo, v.share ? at : null, v.share ? v.actorId : null, v.note, at, at,
  ).run();
  if (previous) await db.prepare(`UPDATE website_deliveries SET superseded_by = ? WHERE id = ?`).bind(id, previous.id).run();
  return { id, version, superseded: previous?.id ?? null };
}

/**
 * Attach an externally hosted website to an existing customer project.
 *
 * Needs no build, artifact, revision, baseline or contract. The project must already exist and belong to a
 * customer; nothing here creates a customer or a project. The first website on a project is version 1.
 */
export async function createExternal(db: Db, i: ExternalInput): Promise<Result<{ delivery: DeliveryRow; superseded: string | null }>> {
  const errors = validateExternalInput(i);
  if (Object.keys(errors).length) return { ok: false, why: Object.values(errors).join(" ") };
  const url = validateExternalUrl(i.websiteUrl);
  if (!url.ok) return { ok: false, why: url.error };

  const project = await customerProject(db, i.projectId);
  if (!project) return { ok: false, why: "That project does not exist." };
  if (project.kind !== "customer") return { ok: false, why: "Websites are delivered to customer projects only, not Crestmont's own internal projects." };
  if (project.status === "cancelled") return { ok: false, why: `"${project.name}" is cancelled, so a website is not delivered to it.` };
  const assignedTo = i.assignedTo || i.actorId;
  if (i.assignedTo && !(await isActiveStaff(db, i.assignedTo))) return { ok: false, why: "The assigned staff member must be an active Crestmont staff account." };

  const made = await insertExternalVersion(db, project, {
    name: cleanName(i.websiteName), url: url.url, note: i.note?.trim().slice(0, NOTE_MAX) || null,
    share: i.share, actorId: i.actorId, assignedTo,
  });
  await audit(db, {
    actorUserId: i.actorId, actorKind: "user", action: "website_delivery.created",
    subjectType: "project", subjectId: project.id, organizationId: project.organization_id,
    details: {
      deliveryId: made.id, source: "external_url", version: made.version, websiteUrl: url.url, websiteHost: url.host,
      visibleToCustomer: i.share, supersedes: made.superseded, assignedTo,
    },
    ip: i.ip ?? null,
  });
  return { ok: true, delivery: (await byId(db, made.id))!, superseded: made.superseded };
}

/** The newest version on a project: the one the dashboard shows and the one every action applies to. */
export async function headForProject(db: Db, projectId: string): Promise<DeliveryRow | null> {
  return db.prepare(`SELECT * FROM website_deliveries WHERE project_id = ? ORDER BY version DESC LIMIT 1`)
    .bind(projectId).first<DeliveryRow>();
}

/**
 * Replace the website on a project with a new address: a NEW version, never an edit of the old one.
 *
 * The previous version keeps its address, its notes and its customer decision. The new version starts with no
 * decision: approving version 1 is not approving version 2.
 */
export async function replaceWithExternal(
  db: Db,
  o: { deliveryId: string; websiteUrl: string; websiteName?: string | null; note?: string | null; share: boolean; actorId: string; ip?: string | null },
): Promise<Result<{ delivery: DeliveryRow }>> {
  const d = await byId(db, o.deliveryId);
  if (!d) return { ok: false, why: "That website delivery does not exist." };
  const head = await headForProject(db, d.project_id);
  if (head?.id !== d.id) return { ok: false, why: `This is version ${d.version}; a later version exists. Replace the current version instead.` };
  const name = cleanName(o.websiteName) || d.website_name || "";
  const errors = validateExternalInput({ projectId: d.project_id, websiteName: name, websiteUrl: o.websiteUrl, note: o.note });
  if (Object.keys(errors).length) return { ok: false, why: Object.values(errors).join(" ") };
  const url = validateExternalUrl(o.websiteUrl);
  if (!url.ok) return { ok: false, why: url.error };
  const project = await customerProject(db, d.project_id);
  if (!project || project.organization_id !== d.organization_id) return { ok: false, why: "This delivery's project could not be confirmed." };
  if (project.status === "cancelled") return { ok: false, why: `"${project.name}" is cancelled, so a website is not delivered to it.` };

  const made = await insertExternalVersion(db, project, {
    name, url: url.url, note: o.note?.trim().slice(0, NOTE_MAX) || null, share: o.share, actorId: o.actorId,
    assignedTo: d.assigned_to ?? o.actorId,
  });
  await audit(db, {
    actorUserId: o.actorId, actorKind: "user", action: "website_delivery.replaced",
    subjectType: "project", subjectId: project.id, organizationId: project.organization_id,
    details: {
      deliveryId: made.id, version: made.version, replaces: d.id, replacedVersion: d.version, previousSource: d.source,
      previousUrl: d.website_url, websiteUrl: url.url, visibleToCustomer: o.share, supersedes: made.superseded,
    },
    ip: o.ip ?? null,
  });
  return { ok: true, delivery: (await byId(db, made.id))! };
}

/**
 * Edit the current version's details that are not the website itself: its name, the responsible staff member and
 * the internal notes. The address is never edited in place -- a different address is a new version.
 */
export async function updateDetails(
  db: Db,
  o: { deliveryId: string; websiteName?: string | null; assignedTo?: string | null; note?: string | null; actorId: string; ip?: string | null },
): Promise<Result<{ delivery: DeliveryRow }>> {
  const d = await byId(db, o.deliveryId);
  if (!d) return { ok: false, why: "That website delivery does not exist." };
  const head = await headForProject(db, d.project_id);
  if (head?.id !== d.id) return { ok: false, why: `Version ${d.version} is history and is not edited; edit the current version.` };
  const name = o.websiteName === undefined ? d.website_name : cleanName(o.websiteName) || null;
  if (d.source === "external_url" && !name) return { ok: false, why: "An external website needs a name." };
  if (name && name.length > WEBSITE_NAME_MAX) return { ok: false, why: `Keep the name under ${WEBSITE_NAME_MAX} characters.` };
  const note = o.note === undefined ? d.note : o.note?.trim().slice(0, NOTE_MAX) || null;
  if ((o.note ?? "").length > NOTE_MAX) return { ok: false, why: `Keep internal notes under ${NOTE_MAX} characters.` };
  const assignedTo = o.assignedTo === undefined || o.assignedTo === "" ? d.assigned_to : o.assignedTo;
  if (assignedTo && assignedTo !== d.assigned_to && !(await isActiveStaff(db, assignedTo))) {
    return { ok: false, why: "The assigned staff member must be an active Crestmont staff account." };
  }

  const changed: string[] = [];
  if (name !== d.website_name) changed.push("websiteName");
  if (note !== d.note) changed.push("internalNotes");
  if (assignedTo !== d.assigned_to) changed.push("assignedTo");
  if (!changed.length) return { ok: true, delivery: d };

  const at = nowIso();
  await db.prepare(`UPDATE website_deliveries SET website_name = ?, note = ?, assigned_to = ?, updated_at = ? WHERE id = ?`)
    .bind(name, note, assignedTo, at, d.id).run();
  await audit(db, {
    actorUserId: o.actorId, actorKind: "user", action: "website_delivery.updated",
    subjectType: "project", subjectId: d.project_id, organizationId: d.organization_id,
    // The internal notes themselves are not copied into the audit log; that they changed is.
    details: { deliveryId: d.id, version: d.version, changed, websiteName: { from: d.website_name, to: name }, assignedTo: { from: d.assigned_to, to: assignedTo } },
    ip: o.ip ?? null,
  });
  return { ok: true, delivery: (await byId(db, d.id))! };
}

/**
 * Withdraw the live website from the customer without replacing it. The row is kept as history (and can be
 * restored as a new version); the customer stops seeing it immediately.
 */
export async function archive(
  db: Db,
  o: { deliveryId: string; actorId: string; ip?: string | null },
): Promise<Result<{ delivery: DeliveryRow }>> {
  const d = await byId(db, o.deliveryId);
  if (!d) return { ok: false, why: "That website delivery does not exist." };
  if (d.superseded_at) return { ok: false, why: d.status === "archived" ? "This version is already archived." : "Only the current version can be archived." };
  const at = nowIso();
  await db.prepare(
    `UPDATE website_deliveries SET status = 'archived', archived_at = ?, archived_by = ?, superseded_at = ?, updated_at = ?
      WHERE id = ? AND superseded_at IS NULL`,
  ).bind(at, o.actorId, at, at, d.id).run();
  await audit(db, {
    actorUserId: o.actorId, actorKind: "user", action: "website_delivery.archived",
    subjectType: "project", subjectId: d.project_id, organizationId: d.organization_id,
    details: { deliveryId: d.id, version: d.version, source: d.source, wasVisibleToCustomer: !!d.visible_at },
    ip: o.ip ?? null,
  });
  return { ok: true, delivery: (await byId(db, d.id))! };
}

// ── Dashboard reads ───────────────────────────────────────────────────────────────────────────────────────────

export type ApprovalFilter = "" | "awaiting" | "approved" | "revision_requested" | "not_shared";
export type StatusFilter = "" | "draft" | "shared" | "approved" | "revision_requested" | "archived";

export interface DashboardRow extends DeliveryRow {
  project_name: string;
  organization_name: string;
  assigned_to_name: string | null;
  assigned_by_name: string | null;
  version_count: number;
}

/**
 * One row per project: its newest version. Filtered by a free-text search over customer, project and website
 * name, and by delivery and approval status. Paginated, with the true total.
 */
export async function dashboard(
  db: Db,
  f: { q?: string; status?: StatusFilter; approval?: ApprovalFilter; organizationId?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: DashboardRow[]; total: number }> {
  const q = (f.q ?? "").trim().toLowerCase().slice(0, 200);
  const like = likeContains(q);
  const where: string[] = [`w.version = (SELECT MAX(x.version) FROM website_deliveries x WHERE x.project_id = w.project_id)`];
  const binds: unknown[] = [];
  if (q) {
    where.push(`(LOWER(o.name) LIKE ? ESCAPE '\\' OR LOWER(p.name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(w.website_name, '')) LIKE ? ESCAPE '\\')`);
    binds.push(like, like, like);
  }
  if (f.organizationId) { where.push(`w.organization_id = ?`); binds.push(f.organizationId); }
  switch (f.status) {
    case "draft": where.push(`w.superseded_at IS NULL AND w.visible_at IS NULL`); break;
    case "shared": where.push(`w.superseded_at IS NULL AND w.visible_at IS NOT NULL`); break;
    case "approved": where.push(`w.superseded_at IS NULL AND w.customer_decision = 'approved'`); break;
    case "revision_requested": where.push(`w.superseded_at IS NULL AND w.customer_decision = 'revision_requested'`); break;
    case "archived": where.push(`w.status = 'archived'`); break;
  }
  switch (f.approval) {
    case "awaiting": where.push(`w.visible_at IS NOT NULL AND w.customer_decision IS NULL AND w.superseded_at IS NULL`); break;
    case "approved": where.push(`w.customer_decision = 'approved'`); break;
    case "revision_requested": where.push(`w.customer_decision = 'revision_requested'`); break;
    case "not_shared": where.push(`w.visible_at IS NULL`); break;
  }
  const from = `FROM website_deliveries w JOIN projects p ON p.id = w.project_id JOIN organizations o ON o.id = w.organization_id
    WHERE ${where.join(" AND ")}`;
  const total = (await db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const rows = (await db.prepare(
    `SELECT w.*, p.name AS project_name, o.name AS organization_name,
            (SELECT display_name FROM users WHERE id = w.assigned_to) AS assigned_to_name,
            (SELECT display_name FROM users WHERE id = w.assigned_by) AS assigned_by_name,
            (SELECT COUNT(*) FROM website_deliveries c WHERE c.project_id = w.project_id) AS version_count
       ${from}
      ORDER BY w.updated_at DESC, w.id LIMIT ? OFFSET ?`,
  ).bind(...binds, Math.min(100, Math.max(1, f.limit ?? 25)), Math.max(0, f.offset ?? 0)).all<DashboardRow>()).results;
  return { rows, total };
}

export interface VersionRow extends DeliveryRow {
  assigned_by_name: string | null;
  assigned_to_name: string | null;
  visible_by_name: string | null;
  decided_by_name: string | null;
}

/** Every version a project has had, newest first, with the people involved. */
export async function versionsForProject(db: Db, projectId: string): Promise<VersionRow[]> {
  return (await db.prepare(
    `SELECT w.*,
            (SELECT display_name FROM users WHERE id = w.assigned_by) AS assigned_by_name,
            (SELECT display_name FROM users WHERE id = w.assigned_to) AS assigned_to_name,
            (SELECT display_name FROM users WHERE id = w.visible_by) AS visible_by_name,
            (SELECT display_name FROM users WHERE id = w.customer_decided_by) AS decided_by_name
       FROM website_deliveries w WHERE w.project_id = ? ORDER BY w.version DESC`,
  ).bind(projectId).all<VersionRow>()).results;
}

/** Customer organisations for the Add Website search. Crestmont's own internal organisation is never offered. */
export async function customerChoices(db: Db, query = ""): Promise<{ id: string; name: string; projects: number }[]> {
  const q = query.trim().toLowerCase().slice(0, 200);
  return (await db.prepare(
    `SELECT o.id, o.name, (SELECT COUNT(*) FROM projects p WHERE p.organization_id = o.id AND p.status <> 'cancelled') AS projects
       FROM organizations o
      WHERE o.kind = 'customer' AND (? = '' OR LOWER(o.name) LIKE ? ESCAPE '\\')
      ORDER BY o.name LIMIT 50`,
  ).bind(q, likeContains(q)).all<{ id: string; name: string; projects: number }>()).results;
}

/** One customer organisation's projects that may receive a website. */
export async function projectChoices(db: Db, organizationId: string): Promise<{ id: string; name: string; status: string }[]> {
  return (await db.prepare(
    `SELECT p.id, p.name, p.status FROM projects p JOIN organizations o ON o.id = p.organization_id
      WHERE p.organization_id = ? AND o.kind = 'customer' AND p.status <> 'cancelled' ORDER BY p.created_at DESC LIMIT 200`,
  ).bind(organizationId).all<{ id: string; name: string; status: string }>()).results;
}

export async function organizationName(db: Db, organizationId: string): Promise<string | null> {
  return (await db.prepare(`SELECT name FROM organizations WHERE id = ? AND kind = 'customer'`).bind(organizationId)
    .first<{ name: string }>())?.name ?? null;
}

/** "Draft", "Shared with customer", "Archived"... as one plain phrase for staff. */
export function visibilityLabel(d: DeliveryRow): string {
  if (d.status === "archived") return "Archived";
  if (d.superseded_at) return "Replaced";
  return d.visible_at ? "Visible to customer" : "Draft \u2014 staff only";
}

/** The customer's decision on this version, in words. */
export function approvalLabel(d: DeliveryRow): string {
  if (d.customer_decision === "approved") return "Approved";
  if (d.customer_decision === "revision_requested") return "Changes requested";
  if (!d.visible_at) return "Not shared yet";
  if (d.superseded_at) return "No decision";
  return "Awaiting customer";
}
