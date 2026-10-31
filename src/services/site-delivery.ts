// Customer production delivery (Founder decision D5, 2026-10-28).
//
// Approving a preview never publishes anything. Delivery is a separate, Owner-controlled workflow:
//   1-5  AI build → automated checks → owner review → customer review when the preview was shared → owner final approval
//   6    prepare a release: a numbered version of the approved build's committed source for this customer's own target
//   7    the Owner explicitly authorizes it (step-up MFA, typing the target's Worker name)
//   8    the build runner deploys it with the customer-hosting credentials it alone holds (never the agent or sandbox)
//   9    the runner verifies the live site serves exactly the released index page
//   10   the platform records state, evidence, versions and audit history; rollback is a new authorized release
//
// Isolation: each customer project has one target (site_targets) with its own Worker name cm-site-<project> on the
// customer-hosting account (never the Crestmont platform account or a preview name); names and domains are unique,
// so one customer's release cannot overwrite another's. One release in flight per target (unique partial index).
// Nothing here deploys by itself: without a runner configured with PRODUCTION_DEPLOY_COMMAND nothing is claimed.

import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { AppContext } from "../app/context.ts";
import { HttpError } from "../app/http.ts";
import { sha256Hex, timingSafeEqualHex } from "../lib/crypto.ts";
import { randomToken } from "../lib/auth-crypto.ts";
import { audit } from "./security.ts";
import { notifyCustomer, type MailCtx } from "./notifications.ts";
import { getJob, LeaseLostError, sanitize, type BuildJob } from "./builds.ts";

type OwnerCtx = Pick<AppContext, "db"> & { userId: string };

export const SITE_WORKER = /^cm-site-[a-z0-9][a-z0-9-]{1,55}$/;
export const SITE_HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Domains that are never a customer's: Crestmont's own and the shared workers.dev zone. */
const RESERVED_HOST = /(^|\.)(crestmont[a-z0-9-]*\.[a-z.]+|workers\.dev|pages\.dev)$/i;
export const DEPLOY_LEASE_SECONDS = 1800;

export type DeploymentState = "prepared" | "authorized" | "deploying" | "live" | "verification_failed" | "failed" | "superseded" | "canceled";
export const DEPLOYMENT_STATE_LABELS: Record<DeploymentState, string> = {
  prepared: "Prepared — awaiting owner authorization", authorized: "Authorized — waiting for the runner", deploying: "Deploying",
  live: "Live and verified", verification_failed: "Deployed — verification failed", failed: "Failed", superseded: "Superseded", canceled: "Canceled",
};

export interface SiteTarget {
  id: string; project_id: string; organization_id: string; provider: string; worker_name: string; hostname: string | null;
  hostname_authorized_by: string | null; hostname_authorized_at: string | null; enabled: number; created_by: string | null; created_at: string; updated_at: string;
}
export interface SiteDeployment {
  id: string; target_id: string; project_id: string; organization_id: string; build_job_id: string; version: number; kind: "release" | "rollback";
  rollback_of: string | null; state: DeploymentState; state_reason: string | null; source_repo: string | null; source_commit: string; workspace_ref: string | null;
  worker_name: string; hostname: string | null; prepared_by: string | null; prepared_at: string; authorized_by: string | null; authorized_at: string | null;
  authorization_note: string | null; lease_runner: string | null; lease_token_hash: string | null; lease_expires_at: string | null; attempts: number;
  started_at: string | null; deployed_at: string | null; verified_at: string | null; finished_at: string | null; deployed_url: string | null;
  content_sha256: string | null; verification_json: string | null; error: string | null; created_at: string; updated_at: string;
}

/** The Worker name of a project's production site: cm-site-<project id>. */
export function siteWorkerName(projectId: string): string {
  return `cm-site-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50)}`;
}

export async function getTarget(db: Db, projectId: string): Promise<SiteTarget | null> {
  return db.prepare(`SELECT * FROM site_targets WHERE project_id = ?`).bind(projectId).first<SiteTarget>();
}
export async function getDeployment(db: Db, id: string): Promise<SiteDeployment | null> {
  return db.prepare(`SELECT * FROM site_deployments WHERE id = ?`).bind(id).first<SiteDeployment>();
}

async function event(db: Db, d: Pick<SiteDeployment, "id">, from: string | null, to: string | null, message: string, actor: { kind: "system" | "runner" | "user"; userId?: string | null }) {
  await db.prepare(`INSERT INTO site_deployment_events (deployment_id, at, from_state, to_state, message, actor_kind, actor_user_id) VALUES (?,?,?,?,?,?,?)`)
    .bind(d.id, nowIso(), from, to, message.slice(0, 1000), actor.kind, actor.userId ?? null).run();
}

const projectOf = async (db: Db, projectId: string) => {
  const p = await db.prepare(`SELECT id, organization_id, name FROM projects WHERE id = ?`).bind(projectId).first<{ id: string; organization_id: string; name: string }>();
  if (!p) throw new HttpError(404, "Project not found");
  return p;
};

/** Owner: create the project's deployment identity (its own Worker on the customer-hosting account). */
export async function createSiteTarget(c: OwnerCtx, projectId: string): Promise<SiteTarget> {
  const p = await projectOf(c.db, projectId);
  if (await getTarget(c.db, projectId)) throw new HttpError(409, "This project already has a production target.");
  const name = siteWorkerName(projectId);
  if (!SITE_WORKER.test(name) || /crestmont/i.test(name)) throw new HttpError(422, "Could not derive a customer site Worker name for this project.");
  const id = newId("st");
  try {
    await c.db.prepare(`INSERT INTO site_targets (id, project_id, organization_id, worker_name, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(id, p.id, p.organization_id, name, c.userId, nowIso(), nowIso()).run();
  } catch { throw new HttpError(409, "That Worker name is already used by another target."); }
  await audit(c.db, { actorUserId: c.userId, action: "builds.site_target_created", subjectType: "project", subjectId: p.id, organizationId: p.organization_id, details: { workerName: name } });
  return (await getTarget(c.db, projectId))!;
}

/** Owner: authorize (or remove) the customer's own domain. Attached only by the next authorized release. */
export async function setSiteHostname(c: OwnerCtx, projectId: string, hostname: string | null, confirm: string) {
  const t = await getTarget(c.db, projectId);
  if (!t) throw new HttpError(409, "Create the production target first.");
  const host = hostname?.trim().toLowerCase().replace(/\.$/, "") || null;
  if (host !== null) {
    if (!SITE_HOSTNAME.test(host) || RESERVED_HOST.test(host)) throw new HttpError(422, "Enter the customer's own domain (for example www.example.com). Crestmont and workers.dev domains are not allowed.");
    if (confirm.trim().toLowerCase() !== host) throw new HttpError(422, "Type the domain again to confirm you are authorizing it.");
    const used = await c.db.prepare(`SELECT 1 FROM site_targets WHERE hostname = ? AND id <> ?`).bind(host, t.id).first();
    if (used) throw new HttpError(409, "That domain is already assigned to another customer's site.");
  }
  await c.db.prepare(`UPDATE site_targets SET hostname = ?, hostname_authorized_by = ?, hostname_authorized_at = ?, updated_at = ? WHERE id = ?`)
    .bind(host, host ? c.userId : null, host ? nowIso() : null, nowIso(), t.id).run();
  await audit(c.db, { actorUserId: c.userId, action: "builds.site_domain_changed", subjectType: "project", subjectId: projectId, organizationId: t.organization_id, details: { from: t.hostname, to: host } });
}

/** Why the approved build cannot be released yet (empty = ready). Mirrors the Founder's workflow steps 1–5. */
export async function releaseBlockers(db: Db, job: BuildJob, customerReviewNotApplicable: string): Promise<string[]> {
  const out: string[] = [];
  if (job.state !== "approved") out.push("The owner has not approved this build (step 5).");
  const latest = await db.prepare(`SELECT id FROM build_jobs WHERE project_id = ? AND state = 'approved' ORDER BY approved_at DESC LIMIT 1`).bind(job.project_id).first<{ id: string }>();
  if (job.state === "approved" && latest?.id !== job.id) out.push("A newer build of this project was approved; release that one (earlier versions are restored with a rollback).");
  if (!job.source_commit || !job.source_repo || !/^https:\/\//.test(job.source_repo)) out.push("The build's source is not in the project repository (configure PROJECT_REPO_* on the runner).");
  if (job.customer_preview_shared_at) {
    if (job.customer_review !== "approved") out.push(job.customer_review === "changes_requested" ? "The customer requested changes to this preview (step 4)." : "The customer has not reviewed the shared preview yet (step 4).");
  } else if (customerReviewNotApplicable.trim().length < 3) out.push("The preview was not shared with the customer: share it for review, or record why customer review does not apply (step 4).");
  const t = await getTarget(db, job.project_id);
  if (!t) out.push("Create the project's production target first.");
  else if (!t.enabled) out.push("The production target is disabled.");
  return out;
}

const nextVersion = async (db: Db, projectId: string) =>
  ((await db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM site_deployments WHERE project_id = ?`).bind(projectId).first<{ v: number }>())?.v ?? 0) + 1;

async function insertDeployment(c: OwnerCtx, t: SiteTarget, job: BuildJob, kind: "release" | "rollback", rollbackOf: string | null, reason: string | null): Promise<string> {
  const id = newId("sd");
  const version = await nextVersion(c.db, job.project_id);
  try {
    await c.db.prepare(`INSERT INTO site_deployments (id, target_id, project_id, organization_id, build_job_id, version, kind, rollback_of, state, state_reason, source_repo, source_commit, workspace_ref, worker_name, hostname, prepared_by, prepared_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,'prepared',?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, t.id, job.project_id, job.organization_id, job.id, version, kind, rollbackOf, reason, job.source_repo, job.source_commit, job.workspace_ref ?? null, t.worker_name, t.hostname, c.userId, nowIso(), nowIso(), nowIso()).run();
  } catch {
    throw new HttpError(409, "Another release of this site is already prepared or in progress; authorize, cancel or finish it first.");
  }
  await event(c.db, { id }, null, "prepared", `${kind === "rollback" ? "Rollback" : "Release"} v${version} prepared from ${job.source_commit!.slice(0, 12)}`, { kind: "user", userId: c.userId });
  return id;
}

/** Step 6: prepare a release of the approved build. Deploys nothing. */
export async function prepareRelease(c: OwnerCtx, buildJobId: string, customerReviewNotApplicable = ""): Promise<string> {
  const job = await getJob(c.db, buildJobId);
  if (!job) throw new HttpError(404, "Build not found");
  const blockers = await releaseBlockers(c.db, job, customerReviewNotApplicable);
  if (blockers.length) throw new HttpError(409, blockers.join(" "));
  const t = (await getTarget(c.db, job.project_id))!;
  const live = await c.db.prepare(`SELECT id FROM site_deployments WHERE target_id = ? AND state = 'live' AND source_commit = ?`).bind(t.id, job.source_commit).first();
  if (live) throw new HttpError(409, "This exact version is already live.");
  const reason = job.customer_preview_shared_at ? "Customer approved the preview" : `Customer review not applicable: ${sanitize(customerReviewNotApplicable, 300)}`;
  const id = await insertDeployment(c, t, job, "release", null, reason);
  await audit(c.db, { actorUserId: c.userId, action: "builds.site_release_prepared", subjectType: "project", subjectId: job.project_id, organizationId: job.organization_id, details: { deploymentId: id, buildJobId: job.id, commit: job.source_commit } });
  return id;
}

/** Rollback: a new release of an earlier verified version (it needs its own Owner authorization). */
export async function prepareRollback(c: OwnerCtx, deploymentId: string): Promise<string> {
  const prev = await getDeployment(c.db, deploymentId);
  if (!prev) throw new HttpError(404, "Release not found");
  if (!["live", "superseded"].includes(prev.state) || !prev.verified_at) throw new HttpError(409, "Only a version that was live and verified can be restored.");
  if (prev.state === "live") throw new HttpError(409, "That version is the one live now.");
  const t = await getTarget(c.db, prev.project_id);
  if (!t || t.id !== prev.target_id || !t.enabled) throw new HttpError(409, "The production target changed or is disabled.");
  const job = await getJob(c.db, prev.build_job_id);
  if (!job) throw new HttpError(409, "The build of that version no longer exists.");
  const id = await insertDeployment(c, t, { ...job, source_repo: prev.source_repo, source_commit: prev.source_commit }, "rollback", prev.id, `Restores v${prev.version}`);
  await audit(c.db, { actorUserId: c.userId, action: "builds.site_rollback_prepared", subjectType: "project", subjectId: prev.project_id, organizationId: prev.organization_id, details: { deploymentId: id, restores: prev.id, version: prev.version } });
  return id;
}

/** Step 7: the Owner's explicit authorization (route requires owner permission and a recent MFA step-up). */
export async function authorizeRelease(c: OwnerCtx, deploymentId: string, confirm: string, note: string) {
  const d = await getDeployment(c.db, deploymentId);
  if (!d) throw new HttpError(404, "Release not found");
  if (d.state !== "prepared") throw new HttpError(409, `This release is ${DEPLOYMENT_STATE_LABELS[d.state].toLowerCase()}.`);
  if (confirm.trim() !== d.worker_name) throw new HttpError(422, `Type the site's Worker name (${d.worker_name}) to authorize this production release.`);
  const t = await getTarget(c.db, d.project_id);
  if (!t || t.id !== d.target_id || !t.enabled || t.worker_name !== d.worker_name) throw new HttpError(409, "The production target changed since this release was prepared; cancel it and prepare again.");
  if ((t.hostname ?? null) !== (d.hostname ?? null)) throw new HttpError(409, "The authorized domain changed since this release was prepared; cancel it and prepare again.");
  if (d.kind === "release") {
    const job = await getJob(c.db, d.build_job_id);
    // Re-checked at authorization: the build is still the approved one and the customer review still holds.
    const notApplicable = d.state_reason?.startsWith("Customer review not applicable") ? "recorded at preparation" : "";
    const blockers = job ? await releaseBlockers(c.db, job, notApplicable) : ["The build no longer exists."];
    if (blockers.length) throw new HttpError(409, blockers.join(" "));
  }
  const res = await c.db.prepare(`UPDATE site_deployments SET state = 'authorized', authorized_by = ?, authorized_at = ?, authorization_note = ?, updated_at = ? WHERE id = ? AND state = 'prepared'`)
    .bind(c.userId, nowIso(), sanitize(note, 500) || null, nowIso(), d.id).run();
  if (!res.meta?.changes) throw new HttpError(409, "This release changed meanwhile; reload.");
  await event(c.db, d, "prepared", "authorized", `Owner authorized production ${d.kind} v${d.version} to ${d.worker_name}${d.hostname ? ` (${d.hostname})` : ""}`, { kind: "user", userId: c.userId });
  await audit(c.db, { actorUserId: c.userId, action: "builds.site_release_authorized", subjectType: "project", subjectId: d.project_id, organizationId: d.organization_id, details: { deploymentId: d.id, version: d.version, worker: d.worker_name, hostname: d.hostname, commit: d.source_commit } });
}

export async function cancelRelease(c: OwnerCtx, deploymentId: string, reason: string) {
  const d = await getDeployment(c.db, deploymentId);
  if (!d) throw new HttpError(404, "Release not found");
  if (!["prepared", "authorized"].includes(d.state)) throw new HttpError(409, d.state === "deploying" ? "The runner is deploying this release; it cannot be canceled now." : "Only a prepared or authorized release can be canceled.");
  const why = sanitize(reason, 300);
  if (why.length < 3) throw new HttpError(422, "Give a reason.");
  const res = await c.db.prepare(`UPDATE site_deployments SET state = 'canceled', state_reason = ?, finished_at = ?, updated_at = ? WHERE id = ? AND state IN ('prepared','authorized')`)
    .bind(why, nowIso(), nowIso(), d.id).run();
  if (!res.meta?.changes) throw new HttpError(409, "The runner picked this release up meanwhile.");
  await event(c.db, d, d.state, "canceled", `Canceled: ${why}`, { kind: "user", userId: c.userId });
  await audit(c.db, { actorUserId: c.userId, action: "builds.site_release_canceled", subjectType: "project", subjectId: d.project_id, organizationId: d.organization_id, details: { deploymentId: d.id, reason: why } });
}

// ── Runner side (HMAC-signed endpoints) ──

export async function claimDeployment(db: Db, b: Record<string, unknown>, now = new Date()) {
  const caps = Array.isArray(b.capabilities) ? b.capabilities.filter((x): x is string => typeof x === "string") : [];
  if (!caps.includes("production-deploy")) return { deployment: null };
  const runnerId = typeof b.runnerId === "string" ? b.runnerId.slice(0, 64) : "";
  const at = now.toISOString();
  const d = await db.prepare(`SELECT d.* FROM site_deployments d JOIN site_targets t ON t.id = d.target_id WHERE d.state = 'authorized' AND t.enabled = 1 ORDER BY d.authorized_at LIMIT 1`).first<SiteDeployment>();
  if (!d) return { deployment: null };
  if (!SITE_WORKER.test(d.worker_name)) return { deployment: null };
  const token = randomToken(32);
  const res = await db.prepare(`UPDATE site_deployments SET state = 'deploying', lease_runner = ?, lease_token_hash = ?, lease_expires_at = ?, attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ? AND state = 'authorized'`)
    .bind(runnerId, await sha256Hex(token), new Date(now.getTime() + DEPLOY_LEASE_SECONDS * 1000).toISOString(), at, at, d.id).run();
  if (!res.meta?.changes) return { deployment: null };
  await event(db, d, "authorized", "deploying", `Runner ${runnerId || "?"} started the deployment`, { kind: "runner" });
  return { deployment: { id: d.id, leaseToken: token, kind: d.kind, version: d.version, projectId: d.project_id, workerName: d.worker_name, hostname: d.hostname, sourceRepo: d.source_repo, sourceCommit: d.source_commit } };
}

const okHttps = (u: unknown) => typeof u === "string" && /^https:\/\/[^\s<>"']{3,500}$/.test(u) ? u : null;
const okSha = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null;

export async function completeDeployment(db: Db, b: Record<string, unknown>, mail?: MailCtx) {
  const id = typeof b.deploymentId === "string" ? b.deploymentId : "";
  const token = typeof b.leaseToken === "string" && /^[0-9a-f]{64}$/.test(b.leaseToken) ? b.leaseToken : null;
  const d = id ? await getDeployment(db, id) : null;
  if (!d || !token || d.state !== "deploying" || !d.lease_token_hash || !timingSafeEqualHex(d.lease_token_hash, await sha256Hex(token))) throw new LeaseLostError("lease_lost");
  const at = nowIso();
  const v = b.verification && typeof b.verification === "object" ? b.verification as Record<string, unknown> : null;
  const verification = v ? {
    url: okHttps(v.url), httpStatus: typeof v.httpStatus === "number" ? v.httpStatus : null, expectedSha256: okSha(v.expectedSha256),
    actualSha256: okSha(v.actualSha256), matched: typeof v.matched === "boolean" ? v.matched : null, attempts: typeof v.attempts === "number" ? Math.min(100, v.attempts) : 0,
  } : null;
  const deployed = b.result === "deployed";
  const verified = deployed && !!verification && verification.httpStatus === 200 && (verification.matched === true || (verification.matched === null && verification.expectedSha256 === null));
  const to: DeploymentState = verified ? "live" : deployed ? "verification_failed" : "failed";
  const error = typeof b.error === "string" ? sanitize(b.error, 2000) : null;
  await db.prepare(`UPDATE site_deployments SET state = ?, state_reason = ?, lease_token_hash = NULL, lease_expires_at = NULL, deployed_at = ?, verified_at = ?, finished_at = ?, deployed_url = ?, content_sha256 = ?, verification_json = ?, error = ?, updated_at = ? WHERE id = ?`)
    .bind(to, verified ? "Deployed and verified" : error ?? (deployed ? "Deployed; the live site did not match the release" : "Deployment failed"), deployed ? at : null, verified ? at : null, at,
      okHttps(b.deployedUrl), okSha(b.contentSha256), verification ? JSON.stringify(verification) : null, error, at, d.id).run();
  await event(db, d, "deploying", to, verified ? `Live and verified (${verification!.url ?? "no URL"}, index sha256 ${verification!.actualSha256?.slice(0, 12) ?? "n/a"})` : `${DEPLOYMENT_STATE_LABELS[to]}${error ? `: ${error}` : ""}`, { kind: "runner" });
  if (verified) {
    for (const old of (await db.prepare(`SELECT id, state FROM site_deployments WHERE target_id = ? AND state = 'live' AND id <> ?`).bind(d.target_id, d.id).all<{ id: string; state: string }>()).results) {
      await db.prepare(`UPDATE site_deployments SET state = 'superseded', updated_at = ? WHERE id = ?`).bind(at, old.id).run();
      await event(db, old, "live", "superseded", `Superseded by v${d.version}`, { kind: "system" });
    }
  }
  await audit(db, { actorKind: "system", action: verified ? "builds.site_release_live" : "builds.site_release_failed", subjectType: "project", subjectId: d.project_id, organizationId: d.organization_id, details: { deploymentId: d.id, version: d.version, state: to } });
  if (verified && mail) await notifyCustomer(mail, d.project_id, { kind: "project", mail: { template: "project_update", data: { event: "site_released", version: d.version, siteUrl: d.hostname ? `https://${d.hostname}` : null } }, path: `/portal/projects/${d.project_id}`, key: `siterel:${d.id}` });
  return { state: to };
}

/** Sweep: a deployment whose runner vanished is failed, never retried automatically (the live state is unknown). */
export async function sweepDeployments(db: Db, now = new Date()): Promise<number> {
  const at = now.toISOString();
  const rows = (await db.prepare(`SELECT * FROM site_deployments WHERE state = 'deploying' AND lease_expires_at < ?`).bind(at).all<SiteDeployment>()).results;
  for (const d of rows) {
    await db.prepare(`UPDATE site_deployments SET state = 'failed', state_reason = ?, lease_token_hash = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND state = 'deploying'`)
      .bind("The runner stopped reporting during the deployment; check the live site before preparing another release.", at, at, d.id).run();
    await event(db, d, "deploying", "failed", "Runner lease expired during deployment (not retried automatically)", { kind: "system" });
    await audit(db, { actorKind: "system", action: "builds.site_release_failed", subjectType: "project", subjectId: d.project_id, organizationId: d.organization_id, details: { deploymentId: d.id, reason: "lease_expired" } });
  }
  return rows.length;
}

export interface DeliveryView {
  project: { id: string; name: string; organizationId: string };
  target: SiteTarget | null;
  deployments: (SiteDeployment & { events: { at: string; message: string; actor_kind: string }[] })[];
  approvedBuild: BuildJob | null;
  blockers: string[];
}

export async function deliveryView(db: Db, projectId: string): Promise<DeliveryView> {
  const p = await projectOf(db, projectId);
  const target = await getTarget(db, projectId);
  const approvedBuild = await db.prepare(`SELECT * FROM build_jobs WHERE project_id = ? AND state = 'approved' ORDER BY approved_at DESC LIMIT 1`).bind(projectId).first<BuildJob>();
  const deployments = (await db.prepare(`SELECT * FROM site_deployments WHERE project_id = ? ORDER BY version DESC LIMIT 50`).bind(projectId).all<SiteDeployment>()).results;
  const withEvents = [];
  for (const d of deployments) withEvents.push({ ...d, events: (await db.prepare(`SELECT at, message, actor_kind FROM site_deployment_events WHERE deployment_id = ? ORDER BY id`).bind(d.id).all<{ at: string; message: string; actor_kind: string }>()).results });
  return { project: { id: p.id, name: p.name, organizationId: p.organization_id }, target, deployments: withEvents, approvedBuild, blockers: approvedBuild ? (await releaseBlockers(db, approvedBuild, "")) : ["No build of this project is approved yet."] };
}
