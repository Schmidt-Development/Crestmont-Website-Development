// Project delivery service (PM-001..PM-007, PORTAL-003/006/007/010, EMP-003).
// All lifecycle changes go through the validated state machine in src/domain/project.ts.
import type { AppContext } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { HttpError } from "../app/http.ts";
import { can, isOwner, type Actor } from "../domain/authz.ts";
import {
  transitionProject, resumeProject as resumeDomain, inactivityAction, decideRevision, customerReleaseReadiness,
  DEFAULT_INACTIVITY_POLICY, type ProjectStatus, type InactivityPolicy,
} from "../domain/project.ts";
import { TransitionError } from "../domain/state-machine.ts";
import { issueMilestoneInvoice } from "./commerce.ts";
import { notify, notifyCustomer, notifyProjectTeam, type MailCtx } from "./notifications.ts";

export interface ProjectRow {
  id: string; organization_id: string; order_id: string | null; product_id: string | null; name: string; status: ProjectStatus;
  paused_from_status: ProjectStatus | null; revision_allowance: number; payment_schedule: "upfront" | "milestone_50_25_25";
  last_customer_activity_at: string | null; created_at: string; updated_at: string; project_manager_id: string | null;
  live_url: string | null; target_launch_at: string | null; cancel_reason: string | null; completed_at: string | null;
}

type Ctx = MailCtx & Pick<AppContext, "now">;
type ActorRef = { actorUserId?: string | null; actorKind: "user" | "system" | "ai" | "webhook"; note?: string };

export const CUSTOMER_APPROVAL_KINDS = ["scope", "design", "revision", "customer_launch", "final_acceptance"] as const;
export const STAFF_APPROVAL_KINDS = ["engineering_complete", "internal_qa", "security_accessibility", "deployment_authorized"] as const;
export type CustomerApprovalKind = (typeof CUSTOMER_APPROVAL_KINDS)[number];
export type StaffApprovalKind = (typeof STAFF_APPROVAL_KINDS)[number];

export const APPROVAL_LABELS: Record<string, string> = {
  scope: "Scope approval", design: "Design approval", revision: "Revision approval", customer_launch: "Final launch approval",
  final_acceptance: "Final acceptance", engineering_complete: "Engineering completion", internal_qa: "Internal QA",
  security_accessibility: "Security & accessibility checks", deployment_authorized: "Deployment authorization", payment_verified: "Payment verification",
};

/** Statuses where the project waits on the customer; only these accrue inactivity. */
export const CUSTOMER_WAITING_STATUSES: ProjectStatus[] = ["awaiting_onboarding", "customer_review", "final_approval"];

const conflict = (e: unknown): never => {
  if (e instanceof TransitionError) throw new HttpError(409, e.message);
  throw e;
};

// ───────────── Access ─────────────

export async function getOrgProject(db: Db, organizationId: string, id: string): Promise<ProjectRow> {
  const p = await db.prepare(`SELECT * FROM projects WHERE id = ? AND organization_id = ?`).bind(id, organizationId).first<ProjectRow>();
  if (!p) throw new HttpError(404, "Project not found");
  return p;
}

export async function getProject(db: Db, id: string): Promise<ProjectRow | null> {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).bind(id).first<ProjectRow>();
}

/** Staff can see a project with project.read_all, or when they are its PM / assigned to it / assigned to one of its tasks. */
export async function staffCanSeeProject(db: Db, actor: Actor, userId: string, projectId: string): Promise<boolean> {
  if (can(actor, "project.read_all")) return true;
  if (!can(actor, "project.read_assigned")) return false;
  const r = await db.prepare(
    `SELECT 1 FROM projects p WHERE p.id = ? AND (p.project_manager_id = ?
       OR EXISTS (SELECT 1 FROM assignments a WHERE a.subject_type = 'project' AND a.subject_id = p.id AND a.user_id = ? AND a.ended_at IS NULL)
       OR EXISTS (SELECT 1 FROM assignments a JOIN tasks t ON t.id = a.subject_id WHERE a.subject_type = 'task' AND t.project_id = p.id AND a.user_id = ? AND a.ended_at IS NULL))`,
  ).bind(projectId, userId, userId, userId).first();
  return !!r;
}

export async function getStaffProject(ctx: AppContext, id: string): Promise<ProjectRow> {
  const p = await getProject(ctx.db, id);
  if (!p || !(await staffCanSeeProject(ctx.db, ctx.actor!, ctx.user!.id, id))) throw new HttpError(404, "Project not found");
  return p;
}

/** SQL fragment + binds restricting `p` (projects alias) to what the staff member can see. */
export function visibleProjectsSql(actor: Actor, userId: string): { sql: string; binds: unknown[] } {
  if (can(actor, "project.read_all")) return { sql: "1", binds: [] };
  return {
    sql: `(p.project_manager_id = ? OR EXISTS (SELECT 1 FROM assignments a WHERE a.subject_type = 'project' AND a.subject_id = p.id AND a.user_id = ? AND a.ended_at IS NULL)
           OR EXISTS (SELECT 1 FROM assignments a JOIN tasks t ON t.id = a.subject_id WHERE a.subject_type = 'task' AND t.project_id = p.id AND a.user_id = ? AND a.ended_at IS NULL))`,
    binds: [userId, userId, userId],
  };
}

function requireCoordinator(actor: Actor) {
  if (!can(actor, "project.coordinate")) throw new HttpError(403, "Only project managers can do that.");
}

// ───────────── Lifecycle ─────────────

async function hasApproval(db: Db, projectId: string, kind: string): Promise<boolean> {
  const r = await db.prepare(`SELECT decision FROM approvals WHERE project_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(projectId, kind).first<{ decision: string }>();
  return r?.decision === "approved";
}

/** Validated status change (pause included). Extra business gates: scope must be approved before design, readiness before deployment, a deployment record before completion. */
export async function changeProjectStatus(ctx: Ctx | MailCtx, projectId: string, to: ProjectStatus, actor: ActorRef): Promise<void> {
  const db = ctx.db;
  const p = await getProject(db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  const from = p.status;
  try { transitionProject(from, to); } catch (e) { conflict(e); }
  if (to === "design") {
    const scope = await db.prepare(`SELECT approved_at FROM project_scopes WHERE project_id = ? ORDER BY version DESC LIMIT 1`).bind(projectId).first<{ approved_at: string | null }>();
    if (!scope?.approved_at) throw new HttpError(409, "The latest scope version must be approved before design starts.");
  }
  if (to === "deployment") {
    const r = await releaseReadiness(db, projectId);
    if (!r.ready) throw new HttpError(409, `Release readiness is incomplete: ${r.missing.join(", ")}`);
  }
  if (to === "completed") {
    const d = await db.prepare(`SELECT 1 FROM customer_deployments WHERE project_id = ?`).bind(projectId).first();
    if (!d) throw new HttpError(409, "Record the deployment before completing the project.");
  }
  const at = nowIso();
  const res = await db.prepare(`UPDATE projects SET status = ?, paused_from_status = ?, updated_at = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END WHERE id = ? AND status = ?`)
    .bind(to, to === "paused" ? from : null, at, to, at, projectId, from).run();
  if (res.meta.changes !== 1) throw new HttpError(409, "The project changed while you were editing. Reload and try again.");
  await audit(db, { actorUserId: actor.actorUserId ?? null, actorKind: actor.actorKind, action: to === "paused" ? "project.paused" : "project.status_changed", subjectType: "project", subjectId: projectId, organizationId: p.organization_id, details: { from, to, note: actor.note } });
  await notifyCustomer(ctx, projectId, { kind: "project_status", template: "project_update", subject: to === "paused" ? "Your project has been paused" : "Your project moved to a new stage",
    body: to === "paused" ? `Your project is paused${actor.note ? `: ${actor.note}` : ""}. Reply in your portal any time to restart it.` : `Status changed from ${labelStatus(from)} to ${labelStatus(to)}.`,
    path: `/portal/projects/${projectId}`, key: `status:${projectId}:${to}:${at}`, exceptUserId: actor.actorUserId ?? undefined });
}

export function labelStatus(s: string): string { return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()); }

/** Restart procedure: return to the status the project was paused from and start a fresh inactivity cycle. */
export async function resumeProject(ctx: Ctx | MailCtx, projectId: string, actor: ActorRef): Promise<ProjectStatus> {
  const p = await getProject(ctx.db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  let to: ProjectStatus;
  try { to = resumeDomain(p.status, p.paused_from_status); } catch (e) { return conflict(e); }
  const at = nowIso();
  const res = await ctx.db.prepare(`UPDATE projects SET status = ?, paused_from_status = NULL, last_customer_activity_at = ?, updated_at = ? WHERE id = ? AND status = 'paused'`).bind(to, at, at, projectId).run();
  if (res.meta.changes !== 1) throw new HttpError(409, "Project is not paused.");
  await audit(ctx.db, { actorUserId: actor.actorUserId ?? null, actorKind: actor.actorKind, action: "project.resumed", subjectType: "project", subjectId: projectId, organizationId: p.organization_id, details: { to, note: actor.note } });
  await notifyCustomer(ctx, projectId, { kind: "project_status", template: "project_update", subject: "Your project has restarted", body: `Work has resumed. Current stage: ${labelStatus(to)}.`, path: `/portal/projects/${projectId}`, key: `resume:${projectId}:${at}` });
  return to;
}

/** Owner-only, with a reason. Never automatic (§27). */
export async function cancelProject(ctx: MailCtx, actor: Actor, projectId: string, reason: string): Promise<void> {
  if (!isOwner(actor)) throw new HttpError(403, "Only the Owner can cancel a customer project.");
  if (reason.trim().length < 10) throw new HttpError(422, "Give a cancellation reason of at least 10 characters.");
  const p = await getProject(ctx.db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  if (["completed", "maintenance", "cancelled"].includes(p.status)) throw new HttpError(409, `A ${labelStatus(p.status).toLowerCase()} project cannot be cancelled.`);
  const at = nowIso();
  await ctx.db.prepare(`UPDATE projects SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ? AND status = ?`).bind(reason.trim(), at, projectId, p.status).run();
  await audit(ctx.db, { actorUserId: actor.userId, action: "project.cancelled", subjectType: "project", subjectId: projectId, organizationId: p.organization_id, details: { from: p.status, reason: reason.trim() } });
  await notifyCustomer(ctx, projectId, { kind: "project_status", template: "project_update", subject: "Your project was cancelled", body: "Your project has been cancelled. Your project manager will contact you about next steps.", path: `/portal/projects/${projectId}`, key: `cancel:${projectId}` });
}

export async function touchCustomerActivity(db: Db, organizationId: string, projectId: string): Promise<void> {
  await db.prepare(`UPDATE projects SET last_customer_activity_at = ? WHERE id = ? AND organization_id = ?`).bind(nowIso(), projectId, organizationId).run();
}

// ───────────── Scope ─────────────

export async function addScopeVersion(ctx: MailCtx, actor: Actor, projectId: string, scopeText: string): Promise<number> {
  requireCoordinator(actor);
  if (scopeText.trim().length < 20) throw new HttpError(422, "Scope text must be at least 20 characters.");
  const p = await getProject(ctx.db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  const v = ((await ctx.db.prepare(`SELECT MAX(version) AS v FROM project_scopes WHERE project_id = ?`).bind(projectId).first<{ v: number | null }>())?.v ?? 0) + 1;
  await ctx.db.prepare(`INSERT INTO project_scopes (id, project_id, version, scope_text) VALUES (?,?,?,?)`).bind(newId("scp"), projectId, v, scopeText.trim()).run();
  await audit(ctx.db, { actorUserId: actor.userId, action: "scope.version_created", subjectType: "project", subjectId: projectId, organizationId: p.organization_id, details: { version: v } });
  return v;
}

// ───────────── Approvals ─────────────

export async function requestCustomerApproval(ctx: MailCtx, actor: Actor, projectId: string, kind: CustomerApprovalKind, note: string, subjectId?: string | null): Promise<string> {
  requireCoordinator(actor);
  const p = await getProject(ctx.db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  if (kind === "final_acceptance") {
    const h = await ctx.db.prepare(`SELECT published_at FROM handoffs WHERE project_id = ?`).bind(projectId).first<{ published_at: string | null }>();
    if (!h?.published_at) throw new HttpError(409, "Publish the handoff before asking for final acceptance.");
  }
  const open = await ctx.db.prepare(`SELECT id FROM approval_requests WHERE project_id = ? AND kind = ? AND resolved_at IS NULL AND COALESCE(subject_id,'') = COALESCE(?, '')`).bind(projectId, kind, subjectId ?? null).first<{ id: string }>();
  if (open) throw new HttpError(409, "There is already an open request for that approval.");
  const id = newId("apr");
  await ctx.db.prepare(`INSERT INTO approval_requests (id, project_id, kind, subject_id, note, requested_by, created_at) VALUES (?,?,?,?,?,?,?)`).bind(id, projectId, kind, subjectId ?? null, note.trim() || null, actor.userId, nowIso()).run();
  await audit(ctx.db, { actorUserId: actor.userId, action: "approval.requested", subjectType: "project", subjectId: projectId, organizationId: p.organization_id, details: { kind, requestId: id } });
  await notifyCustomer(ctx, projectId, { kind: "approval_request", template: "approval_request", subject: `Your approval is needed: ${APPROVAL_LABELS[kind]}`, body: note.trim() || `Please review and record your decision for: ${APPROVAL_LABELS[kind]}.`, path: `/portal/projects/${projectId}/approvals`, key: `apr:${id}` });
  return id;
}

/** Customer decision on scope/design/revision/launch/final acceptance. Requires customer.approve (customer_admin) for the project's organization. */
export async function recordCustomerApproval(ctx: MailCtx, actor: Actor, input: { organizationId: string; projectId: string; kind: CustomerApprovalKind; decision: "approved" | "rejected"; notes: string; userId: string; subjectId?: string | null }): Promise<string> {
  if (!can(actor, "customer.approve", { organizationId: input.organizationId })) throw new HttpError(403, "Only an account administrator for your organization can record approvals.");
  if (!(CUSTOMER_APPROVAL_KINDS as readonly string[]).includes(input.kind)) throw new HttpError(422, "Unknown approval type");
  if (input.decision === "rejected" && input.notes.trim().length < 3) throw new HttpError(422, "Tell us what needs to change when rejecting.");
  const p = await getOrgProject(ctx.db, input.organizationId, input.projectId);
  if (p.status === "cancelled") throw new HttpError(409, "This project is cancelled.");
  const db = ctx.db;
  const at = nowIso();
  const id = newId("apv");
  const stmts = [
    db.prepare(`INSERT INTO approvals (id, project_id, kind, decision, decided_by, notes, created_at) VALUES (?,?,?,?,?,?,?)`).bind(id, p.id, input.kind, input.decision, input.userId, input.notes.trim() || null, at),
    db.prepare(`UPDATE approval_requests SET resolved_at = ?, approval_id = ? WHERE project_id = ? AND kind = ? AND resolved_at IS NULL AND (? IS NULL OR subject_id = ? OR subject_id IS NULL)`)
      .bind(at, id, p.id, input.kind, input.subjectId ?? null, input.subjectId ?? null),
    db.prepare(`UPDATE projects SET last_customer_activity_at = ?, updated_at = ? WHERE id = ?`).bind(at, at, p.id),
  ];
  if (input.kind === "scope" && input.decision === "approved") {
    stmts.push(db.prepare(`UPDATE project_scopes SET approved_at = ?, approved_by = ? WHERE project_id = ? AND version = (SELECT MAX(version) FROM project_scopes WHERE project_id = ?) AND approved_at IS NULL`).bind(at, input.userId, p.id, p.id));
  }
  if (input.kind === "revision" && input.subjectId) {
    if (input.decision === "approved") stmts.push(db.prepare(`UPDATE revisions SET status = 'approved' WHERE id = ? AND project_id = ? AND status = 'delivered'`).bind(input.subjectId, p.id));
    else stmts.push(db.prepare(`UPDATE revisions SET status = 'in_progress' WHERE id = ? AND project_id = ? AND status = 'delivered'`).bind(input.subjectId, p.id));
  }
  if (input.kind === "final_acceptance") {
    const h = await db.prepare(`SELECT published_at FROM handoffs WHERE project_id = ?`).bind(p.id).first<{ published_at: string | null }>();
    if (!h?.published_at) throw new HttpError(409, "The handoff has not been published yet.");
    if (input.decision === "approved") stmts.push(db.prepare(`UPDATE handoffs SET accepted_at = ?, accepted_by = ? WHERE project_id = ? AND accepted_at IS NULL`).bind(at, input.userId, p.id));
  }
  await db.batch(stmts);
  await audit(db, { actorUserId: input.userId, action: `approval.${input.decision}`, subjectType: "project", subjectId: p.id, organizationId: p.organization_id, details: { kind: input.kind, approvalId: id, notes: input.notes.trim() || undefined, subjectId: input.subjectId ?? undefined } });
  if (input.kind === "final_acceptance" && input.decision === "approved" && p.status === "deployment") {
    await changeProjectStatus(ctx, p.id, "completed", { actorUserId: input.userId, actorKind: "user", note: "Final acceptance recorded by customer" }).catch(() => undefined);
  }
  await notifyProjectTeam(ctx, p.id, { kind: "approval_decision", template: "approval_request", subject: `Customer ${input.decision}: ${APPROVAL_LABELS[input.kind]}`, body: input.notes.trim() || `${APPROVAL_LABELS[input.kind]} was ${input.decision}.`, path: `/staff/projects/${p.id}?tab=approvals`, key: `apv:${id}` });
  return id;
}

/** Internal release-chain approvals recorded by staff with project.coordinate. */
export async function recordStaffApproval(ctx: MailCtx, actor: Actor, projectId: string, kind: StaffApprovalKind, decision: "approved" | "rejected", notes: string): Promise<string> {
  requireCoordinator(actor);
  if (!(STAFF_APPROVAL_KINDS as readonly string[]).includes(kind)) throw new HttpError(422, "Unknown approval type");
  const p = await getProject(ctx.db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  if (kind === "deployment_authorized" && decision === "approved") {
    const r = await releaseReadiness(ctx.db, projectId);
    const others = r.missing.filter((m) => m !== "deployment_authorized");
    if (others.length) throw new HttpError(409, `Deployment cannot be authorized until every other check passes: ${others.join(", ")}`);
  }
  const id = newId("apv");
  await ctx.db.prepare(`INSERT INTO approvals (id, project_id, kind, decision, decided_by, notes, created_at) VALUES (?,?,?,?,?,?,?)`).bind(id, projectId, kind, decision, actor.userId, notes.trim() || null, nowIso()).run();
  await audit(ctx.db, { actorUserId: actor.userId, action: `approval.${decision}`, subjectType: "project", subjectId: projectId, organizationId: p.organization_id, details: { kind, approvalId: id, internal: true } });
  return id;
}

export interface ReadinessCheck { key: string; label: string; ok: boolean; detail: string }

/** The 7-check customer release panel (§28). Uses customerReleaseReadiness plus customer review evidence and unpaid change orders. */
export async function releaseReadiness(db: Db, projectId: string): Promise<{ ready: boolean; missing: string[]; checks: ReadinessCheck[] }> {
  const p = await db.prepare(`SELECT payment_schedule FROM projects WHERE id = ?`).bind(projectId).first<{ payment_schedule: "upfront" | "milestone_50_25_25" }>();
  if (!p) throw new HttpError(404, "Project not found");
  const approvals = (await db.prepare(`SELECT kind, decision, created_at FROM approvals WHERE project_id = ? ORDER BY created_at, rowid`).bind(projectId).all<{ kind: string; decision: "approved" | "rejected"; created_at: string }>()).results;
  const invoices = (await db.prepare(`SELECT milestone_kind, status FROM invoices WHERE project_id = ?`).bind(projectId).all<{ milestone_kind: string | null; status: string }>()).results;
  const paid = invoices.filter((i) => i.status === "paid" && i.milestone_kind).map((i) => i.milestone_kind!);
  const base = customerReleaseReadiness({ approvals: approvals.map((a) => ({ kind: a.kind, decision: a.decision, createdAt: a.created_at })), schedule: p.payment_schedule, paidMilestones: paid });
  const reviewed = !!(await db.prepare(`SELECT 1 FROM audit_logs WHERE subject_type = 'project' AND subject_id = ? AND action = 'project.status_changed' AND details_json LIKE '%"to":"customer_review"%' LIMIT 1`).bind(projectId).first());
  const openChangeOrders = invoices.filter((i) => i.milestone_kind === "change_order" && i.status === "open").length;
  const missing = [...base.missing];
  if (!reviewed) missing.push("customer_review");
  if (openChangeOrders) missing.push("payment:change_order");
  const latest = (k: string) => { const r = approvals.filter((a) => a.kind === k).at(-1); return r ? r.decision : null; };
  const paymentMissing = base.missing.find((m) => m.startsWith("payment:"));
  const check = (key: string, label: string): ReadinessCheck => {
    const d = latest(key);
    return { key, label, ok: d === "approved", detail: d === "approved" ? "Approved" : d === "rejected" ? "Rejected — needs rework" : "Not recorded" };
  };
  const checks: ReadinessCheck[] = [
    check("engineering_complete", "1. Engineering completion"),
    check("internal_qa", "2. Internal QA"),
    check("security_accessibility", "3. Security and accessibility checks"),
    { key: "customer_review", label: "4. Customer review", ok: reviewed, detail: reviewed ? "Customer review stage reached" : "Project has not been in customer review" },
    check("customer_launch", "5. Customer approval (final launch approval)"),
    { key: "payment_verified", label: "6. Required payment verification", ok: !paymentMissing && !openChangeOrders,
      detail: paymentMissing ? `Unpaid: ${paymentMissing.slice(8).split(",").join(", ")}` : openChangeOrders ? `${openChangeOrders} change-order invoice(s) unpaid` : "All required invoices paid" },
    check("deployment_authorized", "7. Deployment authorization"),
  ];
  return { ready: missing.length === 0, missing, checks };
}

export async function issueProjectMilestoneInvoice(ctx: MailCtx, actor: Actor, projectId: string, kind: "design_25" | "prelaunch_25"): Promise<string> {
  requireCoordinator(actor);
  const id = await issueMilestoneInvoice(ctx.db, projectId, kind, actor.userId!);
  await notifyCustomer(ctx, projectId, { kind: "invoice", template: "invoice", subject: "A new invoice is ready", body: kind === "design_25" ? "Your 25% design milestone invoice is ready to pay." : "Your 25% pre-launch invoice is ready to pay.", path: `/portal/billing/invoices/${id}`, key: `inv:${id}` });
  return id;
}

// ───────────── Deployment, handoff, costs ─────────────

export async function recordDeployment(ctx: MailCtx, actor: Actor, projectId: string, url: string, commitSha: string | null): Promise<string> {
  requireCoordinator(actor);
  if (!/^https:\/\/[^\s/$.?#].[^\s]*$/i.test(url)) throw new HttpError(422, "Deployment URL must be an https:// address.");
  if (commitSha && !/^[0-9a-f]{7,40}$/i.test(commitSha)) throw new HttpError(422, "Commit SHA must be 7–40 hex characters.");
  const p = await getProject(ctx.db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  if (!["final_approval", "deployment"].includes(p.status)) throw new HttpError(409, "Deployments are recorded from Final approval or Deployment status.");
  const r = await releaseReadiness(ctx.db, projectId);
  if (!r.ready) throw new HttpError(409, `Release readiness is incomplete: ${r.missing.join(", ")}`);
  if (p.status === "final_approval") await changeProjectStatus(ctx, projectId, "deployment", { actorUserId: actor.userId, actorKind: "user", note: "Deployment recorded" });
  const id = newId("dep");
  await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO customer_deployments (id, project_id, url, commit_sha, deployed_by, deployed_at) VALUES (?,?,?,?,?,?)`).bind(id, projectId, url, commitSha, actor.userId, nowIso()),
    ctx.db.prepare(`UPDATE projects SET live_url = ?, updated_at = ? WHERE id = ?`).bind(url, nowIso(), projectId),
  ]);
  await audit(ctx.db, { actorUserId: actor.userId, action: "deployment.recorded", subjectType: "project", subjectId: projectId, organizationId: p.organization_id, details: { deploymentId: id, url, commitSha } });
  return id;
}

export interface HandoffInput { website_url: string; documentation: string; access_instructions: string; ownership_notes: string; training_notes: string; documentation_file_id: string | null }

export async function saveHandoff(ctx: MailCtx, actor: Actor, projectId: string, h: HandoffInput, publish: boolean): Promise<void> {
  requireCoordinator(actor);
  const p = await getProject(ctx.db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  if (h.website_url && !/^https?:\/\//i.test(h.website_url)) throw new HttpError(422, "Website URL must start with https://");
  if (h.documentation_file_id) {
    const f = await ctx.db.prepare(`SELECT 1 FROM files WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`).bind(h.documentation_file_id, p.organization_id).first();
    if (!f) throw new HttpError(422, "Documentation file must belong to this customer.");
  }
  if (publish) {
    const missing = (["website_url", "documentation", "access_instructions", "ownership_notes", "training_notes"] as const).filter((k) => !h[k].trim());
    if (missing.length) throw new HttpError(422, `Complete every handoff section before publishing: ${missing.join(", ").replace(/_/g, " ")}`);
  }
  const at = nowIso();
  await ctx.db.prepare(`INSERT INTO handoffs (project_id, website_url, documentation, access_instructions, ownership_notes, training_notes, documentation_file_id, published_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET website_url = excluded.website_url, documentation = excluded.documentation, access_instructions = excluded.access_instructions,
      ownership_notes = excluded.ownership_notes, training_notes = excluded.training_notes, documentation_file_id = excluded.documentation_file_id,
      published_at = COALESCE(handoffs.published_at, excluded.published_at), updated_at = excluded.updated_at`)
    .bind(projectId, h.website_url || null, h.documentation || null, h.access_instructions || null, h.ownership_notes || null, h.training_notes || null, h.documentation_file_id, publish ? at : null, at).run();
  await audit(ctx.db, { actorUserId: actor.userId, action: publish ? "handoff.published" : "handoff.saved", subjectType: "project", subjectId: projectId, organizationId: p.organization_id });
  if (publish) await notifyCustomer(ctx, projectId, { kind: "handoff", template: "handoff", subject: "Your website handoff is ready", body: "Your website URL, documentation, access instructions, ownership records and training notes are ready. Review them and record your final acceptance.", path: `/portal/projects/${projectId}/handoff`, key: `handoff:${projectId}` });
}

export const COST_CATEGORIES = ["labor", "hosting", "ai_usage", "third_party_api", "software_license", "payment_fee", "other"] as const;

export async function addProjectCost(db: Db, actor: Actor, projectId: string, c: { category: string; amountCents: number | null; description: string; incurredOn: string }): Promise<string> {
  requireCoordinator(actor);
  if (!(COST_CATEGORIES as readonly string[]).includes(c.category)) throw new HttpError(422, "Choose a cost category.");
  if (c.amountCents !== null && (!Number.isInteger(c.amountCents) || c.amountCents < 0)) throw new HttpError(422, "Amount must be a non-negative number, or blank when unknown.");
  if (c.description.trim().length < 3) throw new HttpError(422, "Describe the cost.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.incurredOn)) throw new HttpError(422, "Date must be YYYY-MM-DD.");
  const p = await getProject(db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  const id = newId("cost");
  await db.prepare(`INSERT INTO project_costs (id, project_id, category, amount_cents, description, incurred_on) VALUES (?,?,?,?,?,?)`).bind(id, projectId, c.category, c.amountCents, c.description.trim(), c.incurredOn).run();
  await audit(db, { actorUserId: actor.userId, action: "project_cost.recorded", subjectType: "project", subjectId: projectId, organizationId: p.organization_id, details: { category: c.category, amountCents: c.amountCents } });
  return id;
}

// ───────────── Staff assignment ─────────────

async function requireStaffUser(db: Db, userId: string): Promise<{ id: string; email: string; display_name: string }> {
  const u = await db.prepare(`SELECT u.id, u.email, u.display_name FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.id = ? AND u.disabled_at IS NULL AND m.role_id IN ('owner','administrator','developer','project_manager','support','sales') LIMIT 1`).bind(userId).first<{ id: string; email: string; display_name: string }>();
  if (!u) throw new HttpError(422, "Choose an active staff member.");
  return u;
}

export async function setProjectManager(ctx: MailCtx, actor: Actor, projectId: string, userId: string): Promise<void> {
  requireCoordinator(actor);
  const u = await requireStaffUser(ctx.db, userId);
  const pm = await ctx.db.prepare(`SELECT 1 FROM memberships WHERE user_id = ? AND role_id IN ('project_manager','owner')`).bind(userId).first();
  if (!pm) throw new HttpError(422, "The project manager must hold the Project Manager or Owner role.");
  const p = await getProject(ctx.db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  await ctx.db.prepare(`UPDATE projects SET project_manager_id = ?, updated_at = ? WHERE id = ?`).bind(userId, nowIso(), projectId).run();
  await audit(ctx.db, { actorUserId: actor.userId, action: "project.pm_assigned", subjectType: "project", subjectId: projectId, organizationId: p.organization_id, details: { userId } });
  await notify(ctx.db, u.id, { kind: "assignment", subjectType: "project", subjectId: projectId, body: `You are the project manager for ${p.name}.` });
}

export async function assign(ctx: MailCtx, actor: Actor, subjectType: "project" | "task", subjectId: string, userId: string): Promise<void> {
  requireCoordinator(actor);
  const u = await requireStaffUser(ctx.db, userId);
  const projectId = subjectType === "project" ? subjectId : (await ctx.db.prepare(`SELECT project_id FROM tasks WHERE id = ?`).bind(subjectId).first<{ project_id: string }>())?.project_id;
  if (!projectId) throw new HttpError(404, "Not found");
  const p = await getProject(ctx.db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  const exists = await ctx.db.prepare(`SELECT 1 FROM assignments WHERE subject_type = ? AND subject_id = ? AND user_id = ? AND ended_at IS NULL`).bind(subjectType, subjectId, userId).first();
  if (exists) return;
  await ctx.db.prepare(`INSERT INTO assignments (id, subject_type, subject_id, user_id, assigned_by, created_at) VALUES (?,?,?,?,?,?)`).bind(newId("asg"), subjectType, subjectId, userId, actor.userId, nowIso()).run();
  await audit(ctx.db, { actorUserId: actor.userId, action: "assignment.created", subjectType, subjectId, organizationId: p.organization_id, details: { userId, projectId } });
  await notify(ctx.db, u.id, { kind: "assignment", subjectType, subjectId, body: subjectType === "project" ? `You were assigned to ${p.name}.` : `You were assigned a task on ${p.name}.` });
}

export async function unassign(db: Db, actor: Actor, assignmentId: string): Promise<void> {
  requireCoordinator(actor);
  const a = await db.prepare(`SELECT * FROM assignments WHERE id = ? AND ended_at IS NULL`).bind(assignmentId).first<{ id: string; subject_type: string; subject_id: string; user_id: string }>();
  if (!a) throw new HttpError(404, "Assignment not found");
  await db.prepare(`UPDATE assignments SET ended_at = ? WHERE id = ?`).bind(nowIso(), assignmentId).run();
  await audit(db, { actorUserId: actor.userId, action: "assignment.ended", subjectType: a.subject_type, subjectId: a.subject_id, details: { userId: a.user_id } });
}

// ───────────── Milestones ─────────────

export const MILESTONE_STATUSES = ["pending", "in_progress", "done", "blocked"] as const;

async function requireMilestoneEditor(db: Db, actor: Actor, userId: string, projectId: string) {
  if (can(actor, "project.coordinate")) return;
  if (!can(actor, "milestone.update") || !(await staffCanSeeProject(db, actor, userId, projectId))) throw new HttpError(403, "You cannot update milestones on this project.");
}

export async function createMilestone(db: Db, actor: Actor, projectId: string, name: string, dueAt: string | null): Promise<string> {
  requireCoordinator(actor);
  if (name.trim().length < 2) throw new HttpError(422, "Milestone name is required.");
  if (dueAt && !/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) throw new HttpError(422, "Due date must be YYYY-MM-DD.");
  const p = await getProject(db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  const pos = ((await db.prepare(`SELECT MAX(position) AS m FROM milestones WHERE project_id = ?`).bind(projectId).first<{ m: number | null }>())?.m ?? 0) + 1;
  const id = newId("ms");
  await db.prepare(`INSERT INTO milestones (id, project_id, name, position, status, due_at) VALUES (?,?,?,?, 'pending', ?)`).bind(id, projectId, name.trim(), pos, dueAt).run();
  await audit(db, { actorUserId: actor.userId, action: "milestone.created", subjectType: "project", subjectId: projectId, organizationId: p.organization_id, details: { milestoneId: id, name: name.trim() } });
  return id;
}

export async function updateMilestone(db: Db, actor: Actor, userId: string, milestoneId: string, patch: { name?: string; status?: string; dueAt?: string | null }): Promise<string> {
  const m = await db.prepare(`SELECT m.*, p.organization_id FROM milestones m JOIN projects p ON p.id = m.project_id WHERE m.id = ?`).bind(milestoneId).first<{ id: string; project_id: string; name: string; status: string; due_at: string | null; organization_id: string }>();
  if (!m) throw new HttpError(404, "Milestone not found");
  await requireMilestoneEditor(db, actor, userId, m.project_id);
  if ((patch.name !== undefined || patch.dueAt !== undefined) && !can(actor, "project.coordinate")) throw new HttpError(403, "Only project managers can rename or reschedule milestones.");
  if (patch.status && !(MILESTONE_STATUSES as readonly string[]).includes(patch.status)) throw new HttpError(422, "Unknown milestone status");
  if (patch.dueAt && !/^\d{4}-\d{2}-\d{2}$/.test(patch.dueAt)) throw new HttpError(422, "Due date must be YYYY-MM-DD.");
  const status = patch.status ?? m.status;
  await db.prepare(`UPDATE milestones SET name = ?, status = ?, due_at = ?, completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE NULL END WHERE id = ?`)
    .bind(patch.name?.trim() || m.name, status, patch.dueAt === undefined ? m.due_at : patch.dueAt, status, nowIso(), milestoneId).run();
  await audit(db, { actorUserId: userId, action: "milestone.updated", subjectType: "project", subjectId: m.project_id, organizationId: m.organization_id, details: { milestoneId, from: m.status, to: status, name: patch.name, dueAt: patch.dueAt } });
  return m.project_id;
}

export async function deleteMilestone(db: Db, actor: Actor, milestoneId: string): Promise<string> {
  requireCoordinator(actor);
  const m = await db.prepare(`SELECT m.project_id, p.organization_id FROM milestones m JOIN projects p ON p.id = m.project_id WHERE m.id = ?`).bind(milestoneId).first<{ project_id: string; organization_id: string }>();
  if (!m) throw new HttpError(404, "Milestone not found");
  await db.batch([
    db.prepare(`UPDATE tasks SET milestone_id = NULL WHERE milestone_id = ?`).bind(milestoneId),
    db.prepare(`DELETE FROM milestones WHERE id = ?`).bind(milestoneId),
  ]);
  await audit(db, { actorUserId: actor.userId, action: "milestone.deleted", subjectType: "project", subjectId: m.project_id, organizationId: m.organization_id, details: { milestoneId } });
  return m.project_id;
}

// ───────────── Tasks, dependencies, time ─────────────

export const TASK_STATUSES = ["todo", "in_progress", "review", "done", "blocked"] as const;
export interface TaskRow { id: string; project_id: string; milestone_id: string | null; title: string; description: string | null; status: string; estimate_minutes: number | null; due_at: string | null; completed_at: string | null; created_at: string }

export async function createTask(db: Db, actor: Actor, projectId: string, t: { title: string; description?: string; milestoneId?: string | null; estimateMinutes?: number | null; dueAt?: string | null; assigneeId?: string | null }): Promise<string> {
  requireCoordinator(actor);
  if (t.title.trim().length < 2 || t.title.length > 200) throw new HttpError(422, "Task title must be 2–200 characters.");
  if (t.estimateMinutes !== null && t.estimateMinutes !== undefined && (!Number.isInteger(t.estimateMinutes) || t.estimateMinutes < 0 || t.estimateMinutes > 100_000)) throw new HttpError(422, "Estimate must be a whole number of minutes.");
  if (t.dueAt && !/^\d{4}-\d{2}-\d{2}$/.test(t.dueAt)) throw new HttpError(422, "Due date must be YYYY-MM-DD.");
  const p = await getProject(db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  if (t.milestoneId && !(await db.prepare(`SELECT 1 FROM milestones WHERE id = ? AND project_id = ?`).bind(t.milestoneId, projectId).first())) throw new HttpError(422, "Milestone does not belong to this project.");
  const id = newId("task");
  await db.prepare(`INSERT INTO tasks (id, project_id, milestone_id, title, description, status, estimate_minutes, due_at, created_at) VALUES (?,?,?,?,?, 'todo', ?,?,?)`)
    .bind(id, projectId, t.milestoneId || null, t.title.trim(), t.description?.trim() || null, t.estimateMinutes ?? null, t.dueAt || null, nowIso()).run();
  await audit(db, { actorUserId: actor.userId, action: "task.created", subjectType: "task", subjectId: id, organizationId: p.organization_id, details: { projectId, title: t.title.trim() } });
  return id;
}

export async function getTask(db: Db, taskId: string): Promise<(TaskRow & { organization_id: string }) | null> {
  return db.prepare(`SELECT t.*, p.organization_id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).bind(taskId).first<TaskRow & { organization_id: string }>();
}

export async function isAssignedToTask(db: Db, userId: string, taskId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 FROM assignments WHERE subject_type = 'task' AND subject_id = ? AND user_id = ? AND ended_at IS NULL`).bind(taskId, userId).first());
}

/** Coordinators may update any task; others need task.update_assigned AND an active assignment to that task. */
async function requireTaskEditor(db: Db, actor: Actor, userId: string, task: TaskRow): Promise<void> {
  if (can(actor, "project.coordinate") && (await staffCanSeeProject(db, actor, userId, task.project_id))) return;
  if (can(actor, "task.update_assigned") && (await isAssignedToTask(db, userId, task.id))) return;
  throw new HttpError(403, "You can only update tasks assigned to you.");
}

export async function unfinishedDependencies(db: Db, taskId: string): Promise<{ id: string; title: string; status: string }[]> {
  return (await db.prepare(`SELECT t.id, t.title, t.status FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id WHERE d.task_id = ? AND t.status <> 'done'`).bind(taskId).all<{ id: string; title: string; status: string }>()).results;
}

export async function setTaskStatus(db: Db, actor: Actor, userId: string, taskId: string, status: string): Promise<TaskRow> {
  const t = await getTask(db, taskId);
  if (!t) throw new HttpError(404, "Task not found");
  await requireTaskEditor(db, actor, userId, t);
  if (!(TASK_STATUSES as readonly string[]).includes(status)) throw new HttpError(422, "Unknown task status");
  if (status === "done") {
    const open = await unfinishedDependencies(db, taskId);
    if (open.length) throw new HttpError(409, `This task depends on unfinished work: ${open.map((o) => o.title).join(", ")}`);
  }
  await db.prepare(`UPDATE tasks SET status = ?, completed_at = CASE WHEN ? = 'done' THEN ? ELSE NULL END WHERE id = ?`).bind(status, status, nowIso(), taskId).run();
  await audit(db, { actorUserId: userId, action: "task.status_changed", subjectType: "task", subjectId: taskId, organizationId: t.organization_id, details: { projectId: t.project_id, from: t.status, to: status } });
  return t;
}

export async function updateTask(db: Db, actor: Actor, userId: string, taskId: string, patch: { title?: string; description?: string; estimateMinutes?: number | null; dueAt?: string | null; milestoneId?: string | null }): Promise<TaskRow> {
  requireCoordinator(actor);
  const t = await getTask(db, taskId);
  if (!t) throw new HttpError(404, "Task not found");
  if (patch.title !== undefined && (patch.title.trim().length < 2 || patch.title.length > 200)) throw new HttpError(422, "Task title must be 2–200 characters.");
  if (patch.dueAt && !/^\d{4}-\d{2}-\d{2}$/.test(patch.dueAt)) throw new HttpError(422, "Due date must be YYYY-MM-DD.");
  if (patch.estimateMinutes !== undefined && patch.estimateMinutes !== null && (!Number.isInteger(patch.estimateMinutes) || patch.estimateMinutes < 0)) throw new HttpError(422, "Estimate must be a whole number of minutes.");
  if (patch.milestoneId && !(await db.prepare(`SELECT 1 FROM milestones WHERE id = ? AND project_id = ?`).bind(patch.milestoneId, t.project_id).first())) throw new HttpError(422, "Milestone does not belong to this project.");
  await db.prepare(`UPDATE tasks SET title = ?, description = ?, estimate_minutes = ?, due_at = ?, milestone_id = ? WHERE id = ?`)
    .bind(patch.title?.trim() ?? t.title, patch.description === undefined ? t.description : patch.description.trim() || null,
      patch.estimateMinutes === undefined ? t.estimate_minutes : patch.estimateMinutes, patch.dueAt === undefined ? t.due_at : patch.dueAt || null,
      patch.milestoneId === undefined ? t.milestone_id : patch.milestoneId || null, taskId).run();
  await audit(db, { actorUserId: userId, action: "task.updated", subjectType: "task", subjectId: taskId, organizationId: t.organization_id, details: { projectId: t.project_id } });
  return t;
}

export async function deleteTask(db: Db, actor: Actor, taskId: string): Promise<string> {
  requireCoordinator(actor);
  const t = await getTask(db, taskId);
  if (!t) throw new HttpError(404, "Task not found");
  const logged = await db.prepare(`SELECT 1 FROM time_entries WHERE task_id = ?`).bind(taskId).first();
  if (logged) throw new HttpError(409, "This task has logged time and cannot be deleted. Mark it blocked or done instead.");
  if (await db.prepare(`SELECT 1 FROM change_orders WHERE task_id = ?`).bind(taskId).first()) throw new HttpError(409, "This task belongs to a change order and cannot be deleted.");
  await db.batch([
    db.prepare(`UPDATE assignments SET ended_at = ? WHERE subject_type = 'task' AND subject_id = ? AND ended_at IS NULL`).bind(nowIso(), taskId),
    db.prepare(`DELETE FROM tasks WHERE id = ?`).bind(taskId),
  ]);
  await audit(db, { actorUserId: actor.userId, action: "task.deleted", subjectType: "task", subjectId: taskId, organizationId: t.organization_id, details: { projectId: t.project_id, title: t.title } });
  return t.project_id;
}

/** Would adding task → dependsOn create a cycle? (Is `task` reachable from `dependsOn` through dependencies?) */
export async function wouldCreateCycle(db: Db, taskId: string, dependsOnId: string): Promise<boolean> {
  if (taskId === dependsOnId) return true;
  const seen = new Set<string>();
  const queue = [dependsOnId];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const next = (await db.prepare(`SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ?`).bind(cur).all<{ id: string }>()).results;
    queue.push(...next.map((n) => n.id));
  }
  return false;
}

export async function addDependency(db: Db, actor: Actor, taskId: string, dependsOnId: string): Promise<void> {
  requireCoordinator(actor);
  const [a, b] = [await getTask(db, taskId), await getTask(db, dependsOnId)];
  if (!a || !b) throw new HttpError(404, "Task not found");
  if (a.project_id !== b.project_id) throw new HttpError(422, "Dependencies must be within the same project.");
  if (await wouldCreateCycle(db, taskId, dependsOnId)) throw new HttpError(409, "That dependency would create a cycle.");
  await db.prepare(`INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?,?)`).bind(taskId, dependsOnId).run();
  await audit(db, { actorUserId: actor.userId, action: "task.dependency_added", subjectType: "task", subjectId: taskId, organizationId: a.organization_id, details: { projectId: a.project_id, dependsOn: dependsOnId } });
}

export async function removeDependency(db: Db, actor: Actor, taskId: string, dependsOnId: string): Promise<void> {
  requireCoordinator(actor);
  const t = await getTask(db, taskId);
  if (!t) throw new HttpError(404, "Task not found");
  await db.prepare(`DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?`).bind(taskId, dependsOnId).run();
  await audit(db, { actorUserId: actor.userId, action: "task.dependency_removed", subjectType: "task", subjectId: taskId, organizationId: t.organization_id, details: { projectId: t.project_id, dependsOn: dependsOnId } });
}

/** Time tracking. Only coordinators may attach an hourly cost; otherwise it is stored as NULL (unknown), never 0. */
export async function logTime(db: Db, actor: Actor, userId: string, taskId: string, e: { minutes: number; workedOn: string; hourlyCostCents: number | null }): Promise<string> {
  const t = await getTask(db, taskId);
  if (!t) throw new HttpError(404, "Task not found");
  await requireTaskEditor(db, actor, userId, t);
  if (!Number.isInteger(e.minutes) || e.minutes < 1 || e.minutes > 24 * 60) throw new HttpError(422, "Minutes must be between 1 and 1440.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.workedOn)) throw new HttpError(422, "Date must be YYYY-MM-DD.");
  let cost = e.hourlyCostCents;
  if (cost !== null && !can(actor, "project.coordinate")) cost = null;
  if (cost !== null && (!Number.isInteger(cost) || cost < 0)) throw new HttpError(422, "Hourly cost must be a non-negative amount.");
  const id = newId("time");
  await db.prepare(`INSERT INTO time_entries (id, task_id, user_id, minutes, hourly_cost_cents, worked_on) VALUES (?,?,?,?,?,?)`).bind(id, taskId, userId, e.minutes, cost, e.workedOn).run();
  await audit(db, { actorUserId: userId, action: "time.logged", subjectType: "task", subjectId: taskId, organizationId: t.organization_id, details: { projectId: t.project_id, minutes: e.minutes } });
  return id;
}

// ───────────── Revisions & change orders ─────────────

export interface RevisionRow { id: string; project_id: string; round: number; request_text: string; status: string; billable_change_order_id: string | null; submitted_by: string; created_at: string; included: number; delivered_at: string | null; delivery_notes: string | null }

export async function revisionUsage(db: Db, projectId: string): Promise<{ allowance: number; used: number; total: number }> {
  const r = await db.prepare(`SELECT p.revision_allowance AS allowance, (SELECT COUNT(*) FROM revisions WHERE project_id = p.id AND included = 1) AS used, (SELECT COUNT(*) FROM revisions WHERE project_id = p.id) AS total FROM projects p WHERE p.id = ?`).bind(projectId).first<{ allowance: number; used: number; total: number }>();
  return r ?? { allowance: 0, used: 0, total: 0 };
}

const REVISION_OPEN_STATUSES: ProjectStatus[] = ["design", "development", "internal_qa", "customer_review", "revisions", "final_approval"];

/** Customer submits a revision request. Within the allowance it is an included round; beyond it, the round is recorded as billable and a change order is required. */
export async function requestRevision(ctx: MailCtx, input: { organizationId: string; projectId: string; userId: string; text: string }): Promise<{ revisionId: string; decision: ReturnType<typeof decideRevision> }> {
  const text = input.text.trim();
  if (text.length < 10) throw new HttpError(422, "Describe the changes you need (at least 10 characters).");
  if (text.length > 10_000) throw new HttpError(422, "Revision requests are limited to 10,000 characters.");
  const p = await getOrgProject(ctx.db, input.organizationId, input.projectId);
  if (!REVISION_OPEN_STATUSES.includes(p.status)) throw new HttpError(409, "Revisions can be requested once design work has started and before launch.");
  const pending = await ctx.db.prepare(`SELECT 1 FROM revisions WHERE project_id = ? AND included = 0 AND billable_change_order_id IS NULL AND status = 'submitted'`).bind(p.id).first();
  if (pending) throw new HttpError(409, "A request beyond your included revisions is waiting for a change-order proposal. We will send pricing shortly.");
  const usage = await revisionUsage(ctx.db, p.id);
  const decision = decideRevision(p.revision_allowance, usage.used);
  const id = newId("rev");
  const at = nowIso();
  await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO revisions (id, project_id, round, request_text, status, submitted_by, created_at, included) VALUES (?,?,?,?, 'submitted', ?,?,?)`)
      .bind(id, p.id, usage.total + 1, text, input.userId, at, decision.kind === "included" ? 1 : 0),
    ctx.db.prepare(`UPDATE projects SET last_customer_activity_at = ?, updated_at = ? WHERE id = ?`).bind(at, at, p.id),
  ]);
  await audit(ctx.db, { actorUserId: input.userId, action: "revision.requested", subjectType: "project", subjectId: p.id, organizationId: p.organization_id, details: { revisionId: id, round: usage.total + 1, decision: decision.kind } });
  if (decision.kind === "included" && p.status === "customer_review") {
    await changeProjectStatus(ctx, p.id, "revisions", { actorUserId: input.userId, actorKind: "user", note: `Revision round ${decision.round} requested` }).catch(() => undefined);
  }
  await notifyProjectTeam(ctx, p.id, { kind: "revision", template: "revision_update", subject: decision.kind === "included" ? `Revision round ${decision.round} requested` : "Revision beyond allowance — change order needed",
    body: decision.kind === "included" ? `Included round ${decision.round} of ${p.revision_allowance}.` : `The customer has used all ${p.revision_allowance} included rounds. Propose a change order with scope and price.`,
    path: `/staff/projects/${p.id}?tab=revisions`, key: `rev:${id}` });
  return { revisionId: id, decision };
}

export async function updateRevisionStatus(ctx: MailCtx, actor: Actor, userId: string, revisionId: string, status: "in_progress" | "delivered", notes: string): Promise<string> {
  const r = await ctx.db.prepare(`SELECT r.*, p.organization_id FROM revisions r JOIN projects p ON p.id = r.project_id WHERE r.id = ?`).bind(revisionId).first<RevisionRow & { organization_id: string }>();
  if (!r) throw new HttpError(404, "Revision not found");
  if (!can(actor, "project.coordinate") && !(can(actor, "task.update_assigned") && (await staffCanSeeProject(ctx.db, actor, userId, r.project_id)))) throw new HttpError(403, "You cannot update revisions on this project.");
  if (!r.included) {
    const co = r.billable_change_order_id ? await ctx.db.prepare(`SELECT status FROM change_orders WHERE id = ?`).bind(r.billable_change_order_id).first<{ status: string }>() : null;
    if (!co || !["approved", "paid", "completed"].includes(co.status)) throw new HttpError(409, "This round is beyond the included allowance; its change order must be approved first.");
  }
  const allowedFrom: Record<string, string[]> = { in_progress: ["submitted", "in_progress"], delivered: ["submitted", "in_progress"] };
  if (!allowedFrom[status].includes(r.status)) throw new HttpError(409, `A ${r.status} revision cannot move to ${status}.`);
  const at = nowIso();
  await ctx.db.prepare(`UPDATE revisions SET status = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END, delivery_notes = COALESCE(?, delivery_notes) WHERE id = ?`)
    .bind(status, status, at, notes.trim() || null, revisionId).run();
  await audit(ctx.db, { actorUserId: userId, action: "revision.status_changed", subjectType: "project", subjectId: r.project_id, organizationId: r.organization_id, details: { revisionId, from: r.status, to: status } });
  if (status === "delivered") {
    await ctx.db.prepare(`INSERT INTO approval_requests (id, project_id, kind, subject_id, note, requested_by, created_at) VALUES (?,?, 'revision', ?,?,?,?)`).bind(newId("apr"), r.project_id, revisionId, `Review revision round ${r.round}`, userId, at).run();
    await notifyCustomer(ctx, r.project_id, { kind: "revision", template: "revision_update", subject: `Revision round ${r.round} is ready for review`, body: notes.trim() || "Your requested changes are ready. Review them and approve or ask for adjustments.", path: `/portal/projects/${r.project_id}/revisions`, key: `revdel:${revisionId}` });
  }
  return r.project_id;
}

export interface ChangeOrderRow { id: string; project_id: string; scope_text: string; price_cents: number; status: string; invoice_id: string | null; task_id: string | null; created_at: string; decided_at: string | null; decision_notes: string | null; invoice_status?: string | null }

export async function proposeChangeOrder(ctx: MailCtx, actor: Actor, projectId: string, input: { scope: string; priceCents: number; revisionId?: string | null }): Promise<string> {
  requireCoordinator(actor);
  if (input.scope.trim().length < 10) throw new HttpError(422, "Describe the change-order scope (at least 10 characters).");
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0 || input.priceCents > 100_000_000) throw new HttpError(422, "Enter a valid price.");
  const p = await getProject(ctx.db, projectId);
  if (!p) throw new HttpError(404, "Project not found");
  if (input.revisionId) {
    const r = await ctx.db.prepare(`SELECT billable_change_order_id FROM revisions WHERE id = ? AND project_id = ?`).bind(input.revisionId, projectId).first<{ billable_change_order_id: string | null }>();
    if (!r) throw new HttpError(422, "Revision not found on this project.");
    if (r.billable_change_order_id) throw new HttpError(409, "That revision already has a change order.");
  }
  const id = newId("co");
  const stmts = [ctx.db.prepare(`INSERT INTO change_orders (id, project_id, scope_text, price_cents, status, proposed_by, created_at) VALUES (?,?,?,?, 'proposed', ?,?)`).bind(id, projectId, input.scope.trim(), input.priceCents, actor.userId, nowIso())];
  if (input.revisionId) stmts.push(ctx.db.prepare(`UPDATE revisions SET billable_change_order_id = ? WHERE id = ? AND project_id = ?`).bind(id, input.revisionId, projectId));
  await ctx.db.batch(stmts);
  await audit(ctx.db, { actorUserId: actor.userId, action: "change_order.proposed", subjectType: "change_order", subjectId: id, organizationId: p.organization_id, details: { projectId, priceCents: input.priceCents, revisionId: input.revisionId ?? undefined } });
  await notifyCustomer(ctx, projectId, { kind: "change_order", template: "change_order", subject: "A change order needs your approval", body: `Proposed additional work. Review the scope and price, then approve or decline.`, path: `/portal/projects/${projectId}/revisions`, key: `co:${id}` });
  return id;
}

/** Customer approves/declines. Approval creates an open change_order invoice (when priced) and the delivery task. */
export async function decideChangeOrder(ctx: MailCtx, actor: Actor, input: { organizationId: string; changeOrderId: string; userId: string; decision: "approved" | "rejected"; notes: string }): Promise<{ invoiceId: string | null }> {
  if (!can(actor, "customer.approve", { organizationId: input.organizationId })) throw new HttpError(403, "Only an account administrator can approve change orders.");
  const co = await ctx.db.prepare(`SELECT c.*, p.organization_id, p.name AS project_name FROM change_orders c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.organization_id = ?`)
    .bind(input.changeOrderId, input.organizationId).first<ChangeOrderRow & { organization_id: string; project_name: string }>();
  if (!co) throw new HttpError(404, "Change order not found");
  if (co.status !== "proposed") throw new HttpError(409, "This change order was already decided.");
  const at = nowIso();
  const contact = await ctx.db.prepare(`SELECT id FROM contacts WHERE user_id = ? LIMIT 1`).bind(input.userId).first<{ id: string }>();
  let invoiceId: string | null = null;
  if (input.decision === "rejected") {
    await ctx.db.batch([
      ctx.db.prepare(`UPDATE change_orders SET status = 'rejected', decided_by = ?, decided_at = ?, decision_notes = ? WHERE id = ? AND status = 'proposed'`).bind(input.userId, at, input.notes.trim() || null, co.id),
      ctx.db.prepare(`UPDATE revisions SET billable_change_order_id = NULL WHERE billable_change_order_id = ? AND status = 'submitted'`).bind(co.id),
    ]);
  } else {
    const taskId = newId("task");
    invoiceId = co.price_cents > 0 ? newId("inv") : null;
    const stmts = [
      ctx.db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, created_at) VALUES (?,?,?,?, 'todo', ?)`).bind(taskId, co.project_id, `Change order: ${co.scope_text.slice(0, 120)}`, co.scope_text, at),
      ctx.db.prepare(`UPDATE change_orders SET status = 'approved', decided_by = ?, decided_at = ?, decision_notes = ?, approved_by_contact_id = ?, invoice_id = ?, task_id = ? WHERE id = ? AND status = 'proposed'`)
        .bind(input.userId, at, input.notes.trim() || null, contact?.id ?? null, invoiceId, taskId, co.id),
    ];
    if (invoiceId) {
      stmts.unshift(ctx.db.prepare(`INSERT INTO invoices (id, organization_id, project_id, milestone_kind, amount_cents, status, description, created_at) VALUES (?,?,?, 'change_order', ?, 'open', ?, ?)`)
        .bind(invoiceId, co.organization_id, co.project_id, co.price_cents, `Change order — ${co.scope_text.slice(0, 140)}`, at));
    }
    await ctx.db.batch(stmts);
  }
  await ctx.db.prepare(`UPDATE projects SET last_customer_activity_at = ? WHERE id = ?`).bind(at, co.project_id).run();
  await audit(ctx.db, { actorUserId: input.userId, action: `change_order.${input.decision}`, subjectType: "change_order", subjectId: co.id, organizationId: co.organization_id, details: { projectId: co.project_id, invoiceId, priceCents: co.price_cents } });
  await notifyProjectTeam(ctx, co.project_id, { kind: "change_order", template: "change_order", subject: `Change order ${input.decision}`, body: `${co.project_name}: change order ${input.decision}${invoiceId ? " — invoice issued to the customer" : ""}.`, path: `/staff/projects/${co.project_id}?tab=revisions`, key: `codec:${co.id}` });
  return { invoiceId };
}

/** Marks approved change orders paid once their invoice is paid (invoice payment is handled by billing). */
export async function syncChangeOrderPayments(db: Db, projectId: string): Promise<void> {
  await db.prepare(`UPDATE change_orders SET status = 'paid' WHERE project_id = ? AND status = 'approved' AND invoice_id IN (SELECT id FROM invoices WHERE status = 'paid')`).bind(projectId).run();
}

export async function listChangeOrders(db: Db, projectId: string): Promise<ChangeOrderRow[]> {
  await syncChangeOrderPayments(db, projectId);
  return (await db.prepare(`SELECT c.*, i.status AS invoice_status FROM change_orders c LEFT JOIN invoices i ON i.id = c.invoice_id WHERE c.project_id = ? ORDER BY c.created_at DESC`).bind(projectId).all<ChangeOrderRow>()).results;
}

export async function listRevisions(db: Db, projectId: string): Promise<(RevisionRow & { co_status: string | null; co_price: number | null })[]> {
  return (await db.prepare(`SELECT r.*, c.status AS co_status, c.price_cents AS co_price FROM revisions r LEFT JOIN change_orders c ON c.id = r.billable_change_order_id WHERE r.project_id = ? ORDER BY r.round DESC`).bind(projectId).all<RevisionRow & { co_status: string | null; co_price: number | null }>()).results;
}

// ───────────── History ─────────────

/** Actions safe to show customers in project history (no internal notes, costs, time or staff-only approvals). */
const CUSTOMER_HISTORY_ACTIONS = ["project.provisioned", "project.status_changed", "project.paused", "project.resumed", "project.cancelled", "onboarding.completed",
  "approval.requested", "approval.approved", "approval.rejected", "revision.requested", "revision.status_changed", "change_order.proposed", "change_order.approved",
  "change_order.rejected", "deployment.recorded", "handoff.published", "milestone.updated", "scope.version_created", "invoice.milestone_issued", "file.uploaded"];

export interface HistoryRow { action: string; actor_kind: string; actor_name: string | null; details_json: string | null; created_at: string }

export async function projectHistory(db: Db, projectId: string, forCustomer: boolean, limit = 50): Promise<HistoryRow[]> {
  const like = `%"projectId":"${projectId.replace(/[%_"]/g, "")}"%`;
  const rows = (await db.prepare(`SELECT a.action, a.actor_kind, u.display_name AS actor_name, a.details_json, a.created_at FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE (a.subject_type = 'project' AND a.subject_id = ?) OR a.details_json LIKE ? ORDER BY a.id DESC LIMIT ?`).bind(projectId, like, limit * 2).all<HistoryRow>()).results;
  const filtered = forCustomer ? rows.filter((r) => CUSTOMER_HISTORY_ACTIONS.includes(r.action) && !(r.details_json ?? "").includes('"internal":true')) : rows;
  return filtered.slice(0, limit);
}

export function describeHistory(r: HistoryRow): string {
  let d: Record<string, unknown> = {};
  try { d = r.details_json ? JSON.parse(r.details_json) : {}; } catch { /* ignore */ }
  const kind = typeof d.kind === "string" ? APPROVAL_LABELS[d.kind] ?? d.kind : "";
  switch (r.action) {
    case "project.provisioned": return "Project created";
    case "project.status_changed": return `Status: ${labelStatus(String(d.from))} → ${labelStatus(String(d.to))}${d.note ? ` (${d.note})` : ""}`;
    case "project.paused": return `Project paused${d.note ? ` — ${d.note}` : ""}`;
    case "project.resumed": return `Project resumed (${labelStatus(String(d.to))})`;
    case "project.cancelled": return "Project cancelled";
    case "onboarding.completed": return "Onboarding submitted";
    case "approval.requested": return `Approval requested: ${kind}`;
    case "approval.approved": return `${kind} approved`;
    case "approval.rejected": return `${kind} rejected`;
    case "revision.requested": return `Revision round ${d.round} requested${d.decision === "change_order_required" ? " (beyond allowance)" : ""}`;
    case "revision.status_changed": return `Revision moved to ${labelStatus(String(d.to))}`;
    case "change_order.proposed": return "Change order proposed";
    case "change_order.approved": return "Change order approved";
    case "change_order.rejected": return "Change order declined";
    case "deployment.recorded": return "Website deployed";
    case "handoff.published": return "Handoff published";
    case "milestone.updated": return `Milestone updated${d.to ? ` (${labelStatus(String(d.to))})` : ""}`;
    case "scope.version_created": return `Scope version ${d.version} drafted`;
    case "invoice.milestone_issued": return "Milestone invoice issued";
    case "file.uploaded": return `File uploaded${d.filename ? `: ${d.filename}` : ""}`;
    default: return r.action.replace(/[._]/g, " ");
  }
}

// ───────────── Inactivity (PM-005) ─────────────

export interface SweepResult { projectId: string; action: "remind" | "escalate" | "pause"; reminder?: number }

/**
 * Sends reminders, escalates to the PM and pauses inactive projects. Never cancels.
 * Idempotent: what was done is recorded per inactivity cycle in inactivity_notices; the cycle key is the
 * project's last_customer_activity_at, so any customer activity (or a resume) starts a fresh cycle.
 */
export async function runInactivitySweep(ctx: Ctx, policy: InactivityPolicy = DEFAULT_INACTIVITY_POLICY): Promise<SweepResult[]> {
  const db = ctx.db;
  const now = ctx.now();
  const results: SweepResult[] = [];
  const projects = (await db.prepare(`SELECT id, organization_id, name, status, last_customer_activity_at, created_at FROM projects WHERE status IN (${CUSTOMER_WAITING_STATUSES.map(() => "?").join(",")})`)
    .bind(...CUSTOMER_WAITING_STATUSES).all<{ id: string; organization_id: string; name: string; status: ProjectStatus; last_customer_activity_at: string | null; created_at: string }>()).results;
  for (const p of projects) {
    const cycle = p.last_customer_activity_at ?? p.created_at;
    const days = Math.floor((now.getTime() - new Date(cycle).getTime()) / 86_400_000);
    if (days < 1) continue;
    const sent = (await db.prepare(`SELECT kind, COUNT(*) AS n FROM inactivity_notices WHERE project_id = ? AND cycle_key = ? GROUP BY kind`).bind(p.id, cycle).all<{ kind: string; n: number }>()).results;
    const reminders = sent.find((s) => s.kind === "remind")?.n ?? 0;
    const escalated = (sent.find((s) => s.kind === "escalate")?.n ?? 0) > 0;
    const action = inactivityAction(days, { reminders, escalated }, policy);
    if (action.kind === "none") continue;
    const seq = action.kind === "remind" ? action.reminder : 1;
    // Claim the notice first; a concurrent or repeated sweep fails the primary key and does nothing.
    const claim = await db.prepare(`INSERT OR IGNORE INTO inactivity_notices (project_id, cycle_key, kind, seq, created_at) VALUES (?,?,?,?,?)`).bind(p.id, cycle, action.kind, seq, now.toISOString()).run();
    if (claim.meta.changes !== 1) continue;
    if (action.kind === "remind") {
      await notifyCustomer(ctx, p.id, { kind: "inactivity_reminder", template: "project_update", subject: "Your project is waiting on you",
        body: `We have not heard from you in ${days} days. Your project is waiting at "${labelStatus(p.status)}". Under our inactivity policy, projects are paused after ${policy.pauseAfterDays} days without a response; they are never cancelled automatically.`,
        path: `/portal/projects/${p.id}`, key: `inact:${p.id}:${cycle}:remind:${seq}` });
      await audit(db, { actorKind: "system", action: "project.inactivity_reminder", subjectType: "project", subjectId: p.id, organizationId: p.organization_id, details: { days, reminder: seq } });
    } else if (action.kind === "escalate") {
      await notifyProjectTeam(ctx, p.id, { kind: "inactivity_escalation", template: "project_update", pmOnly: true, subject: "Inactive customer project needs follow-up",
        body: `${p.name} has had no customer activity for ${days} days (status: ${labelStatus(p.status)}). Please contact the customer.`, path: `/staff/projects/${p.id}`, key: `inact:${p.id}:${cycle}:escalate` });
      await audit(db, { actorKind: "system", action: "project.inactivity_escalated", subjectType: "project", subjectId: p.id, organizationId: p.organization_id, details: { days } });
    } else {
      try {
        await changeProjectStatus(ctx, p.id, "paused", { actorKind: "system", note: `No customer activity for ${days} days (inactivity policy)` });
      } catch (e) {
        await db.prepare(`DELETE FROM inactivity_notices WHERE project_id = ? AND cycle_key = ? AND kind = 'pause'`).bind(p.id, cycle).run();
        throw e;
      }
      await notifyProjectTeam(ctx, p.id, { kind: "inactivity_paused", template: "project_update", pmOnly: true, subject: "Project paused for inactivity", body: `${p.name} was paused after ${days} days without customer activity.`, path: `/staff/projects/${p.id}`, key: `inact:${p.id}:${cycle}:pause` });
    }
    results.push({ projectId: p.id, action: action.kind, reminder: action.kind === "remind" ? seq : undefined });
  }
  return results;
}
