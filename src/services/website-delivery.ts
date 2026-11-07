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

export type DeliveryStatus =
  | "assigned" | "customer_visible" | "review_requested" | "revision_requested" | "approved" | "delivered" | "superseded";

export interface DeliveryRow {
  id: string;
  project_id: string;
  organization_id: string;
  job_id: string;
  source_project_id: string;
  revision_attempt: number;
  revision_cycle: number;
  artifact_id: string | null;
  baseline_id: string | null;
  contract_id: string | null;
  status: DeliveryStatus;
  assigned_by: string;
  assigned_at: string;
  visible_at: string | null;
  visible_by: string | null;
  customer_reviewed_at: string | null;
  customer_decision: "approved" | "revision_requested" | null;
  customer_note: string | null;
  superseded_by: string | null;
  superseded_at: string | null;
  note: string | null;
  created_at: string;
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
  // Superseding takes three statements, and the order is forced by two constraints that pull against each other.
  //
  // `superseded_by` is a foreign key to this table, so it cannot be set to a row that does not exist yet -- and
  // the partial unique index allows only one row per project with `superseded_at IS NULL`, so the new row cannot
  // be inserted while the old one is still live. Setting `superseded_at` first frees the index, the insert then
  // succeeds, and the link back is written last. Both orderings of the obvious two-statement version fail, one
  // with a foreign-key violation and one with a uniqueness violation.
  if (previous) {
    await db.prepare(`UPDATE website_deliveries SET status = 'superseded', superseded_at = ? WHERE id = ?`)
      .bind(at, previous.id).run();
  }
  await db.prepare(
    `INSERT INTO website_deliveries (id, project_id, organization_id, job_id, source_project_id,
       revision_attempt, revision_cycle, artifact_id, baseline_id, contract_id, status,
       assigned_by, assigned_at, visible_at, visible_by, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, project.id, project.organization_id, i.jobId, elig.job.project_id,
    elig.revision.attempt, elig.revision.cycle,
    artifact?.artifact_id ?? null, artifact?.baseline_id ?? null, artifact?.contract_id ?? null,
    i.makeVisible ? "customer_visible" : "assigned",
    i.actorId, at, i.makeVisible ? at : null, i.makeVisible ? i.actorId : null,
    i.note?.slice(0, 500) ?? null, at,
  ).run();
  if (previous) {
    await db.prepare(`UPDATE website_deliveries SET superseded_by = ? WHERE id = ?`).bind(id, previous.id).run();
  }

  await audit(db, {
    actorUserId: i.actorId, actorKind: "user", action: "website_delivery.assigned",
    subjectType: "project", subjectId: project.id, organizationId: project.organization_id,
    details: {
      deliveryId: id, jobId: i.jobId, sourceProjectId: elig.job.project_id,
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
  await db.prepare(`UPDATE website_deliveries SET visible_at = ?, visible_by = ?, status = 'customer_visible' WHERE id = ? AND superseded_at IS NULL`)
    .bind(at, o.actorId, deliveryId).run();
  await audit(db, {
    actorUserId: o.actorId, actorKind: "user", action: "website_delivery.made_visible",
    subjectType: "project", subjectId: d.project_id, organizationId: d.organization_id,
    details: { deliveryId, jobId: d.job_id, revision: `${d.revision_attempt}-${d.revision_cycle}` },
    ip: o.ip ?? null,
  });
  return { ok: true, delivery: (await byId(db, deliveryId))! };
}

/**
 * Go back to a delivery this project has had before.
 *
 * A new row rather than un-superseding the old one: the old row records what was live between two moments, and
 * rewriting it would lose that. The snapshot delivered is the one the earlier row named, so a rollback shows the
 * customer exactly what they saw before -- not "the latest revision of that job", which may since have moved.
 */
export async function rollbackTo(
  db: Db,
  o: { projectId: string; deliveryId: string; actorId: string; ip?: string | null },
): Promise<{ ok: true; delivery: DeliveryRow } | { ok: false; why: string }> {
  const past = await byId(db, o.deliveryId);
  if (!past) return { ok: false, why: "no such delivery" };
  if (past.project_id !== o.projectId) return { ok: false, why: "that delivery belongs to another project" };
  if (!past.superseded_at) return { ok: false, why: "that delivery is already the current one" };

  const at = nowIso();
  const current = await activeForProject(db, o.projectId);
  const id = newId("wdl");
  // Same three-step supersede as `assignToProject`; see the note there for why the order is forced.
  if (current) {
    await db.prepare(`UPDATE website_deliveries SET status = 'superseded', superseded_at = ? WHERE id = ?`)
      .bind(at, current.id).run();
  }
  await db.prepare(
    `INSERT INTO website_deliveries (id, project_id, organization_id, job_id, source_project_id,
       revision_attempt, revision_cycle, artifact_id, baseline_id, contract_id, status,
       assigned_by, assigned_at, visible_at, visible_by, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, past.project_id, past.organization_id, past.job_id, past.source_project_id,
    past.revision_attempt, past.revision_cycle, past.artifact_id, past.baseline_id, past.contract_id,
    past.visible_at ? "customer_visible" : "assigned",
    o.actorId, at, past.visible_at ? at : null, past.visible_at ? o.actorId : null,
    `rolled back to the website delivered on ${past.assigned_at}`, at,
  ).run();
  if (current) {
    await db.prepare(`UPDATE website_deliveries SET superseded_by = ? WHERE id = ?`).bind(id, current.id).run();
  }

  await audit(db, {
    actorUserId: o.actorId, actorKind: "user", action: "website_delivery.rolled_back",
    subjectType: "project", subjectId: past.project_id, organizationId: past.organization_id,
    details: { deliveryId: id, restoredFrom: past.id, jobId: past.job_id, revision: `${past.revision_attempt}-${past.revision_cycle}`, supersedes: current?.id ?? null },
    ip: o.ip ?? null,
  });
  return { ok: true, delivery: (await byId(db, id))! };
}

/**
 * The customer's own verdict on a website they were shown.
 *
 * Recorded only from a customer act, and never inferred from the website being visible. "They can see it" is not
 * "they approved it", and the difference is the whole reason these are separate columns.
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

  const at = nowIso();
  await db.prepare(
    `UPDATE website_deliveries SET customer_reviewed_at = ?, customer_decision = ?, customer_note = ?, status = ?
      WHERE id = ? AND superseded_at IS NULL`,
  ).bind(at, o.decision, o.note?.slice(0, 1000) ?? null, o.decision === "approved" ? "approved" : "revision_requested", d.id).run();
  await audit(db, {
    actorUserId: o.actorId, actorKind: "user", action: "website_delivery.customer_decision",
    subjectType: "project", subjectId: d.project_id, organizationId: d.organization_id,
    details: { deliveryId: d.id, decision: o.decision, jobId: d.job_id },
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
  current: { deliveryId: string; jobId: string; revision: string; visible: boolean } | null;
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
        ? { deliveryId: current.id, jobId: current.job_id, revision: `${current.revision_attempt}-${current.revision_cycle}`, visible: !!current.visible_at }
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
};
