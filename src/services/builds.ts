// AI Builds control plane (paid-intake automation). The Worker owns eligibility, the durable queue, leases,
// budgets, state, owner controls and records; a separate build runner (runner/, docs/ai-builds/) does the coding.
// Nothing here runs an agent: the payment webhook and the onboarding submit only write rows, so they stay fast.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { AppContext } from "../app/context.ts";
import type { StorageAdapter } from "../adapters/storage.ts";
import { HttpError } from "../app/http.ts";
import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from "../lib/crypto.ts";
import { randomToken } from "../lib/auth-crypto.ts";
import { PACKAGES, type PackageId } from "../domain/catalog.ts";
import {
  ACTIVE_STATES, BRIEF_RULES, BUILD_STATE_LABELS, PENDING_STATES, assertBuildTransition,
  type BriefGap, type BuildBrief, type BuildState, type RequirementStatus, REQUIREMENT_STATUSES,
} from "../domain/builds.ts";
import { audit } from "./security.ts";
import { assertQualityForApproval, recordQuality } from "./build-quality.ts";

import { redact } from "./monitoring.ts";
import { getOnboarding, allFields, isVisible, type Answers } from "./onboarding.ts";
import { sweepAiLeases } from "./ai-runner.ts";
import { notifyCustomer, notifyProjectTeam, type MailCtx } from "./notifications.ts";
import { previewSignInUrl, safePreviewPath } from "../lib/preview-token.ts";
import { sweepDeployments } from "./site-delivery.ts";
import { setStage, syncStageFromJob, seedIntegrationsFromBrief } from "./build-pipeline.ts";
import { activeBuilds, authenticateWorker, dispatch, effectivePriority, recordWorkerStatus, releaseAssignment, sweepWorkers, workerModeOn } from "./build-workers.ts";

/** The approved foundation every new build starts from (runner/starters/fullstack-v1). */
export const STARTER = Object.freeze({ name: "fullstack", version: "1" });

/**
 * A project keeps the starter it was first built on: revisions of a website built before the full-stack foundation
 * (no starter_ref recorded) continue on brochure v1, because the full-stack gates and protected files would break
 * that repository. Such legacy revisions cannot be scored by the quality engine; the staff page says so, and moving
 * the website to fullstack v1 is a rebuild decision for the Owner. Every new project starts on fullstack v1.
 */
async function starterFor(db: Db, job: { id: string; project_id: string; strategy: string }): Promise<{ starter: { name: string; version: string } | null; ref: string | null; quality: boolean }> {
  const prior = await db.prepare(`SELECT starter_ref FROM build_jobs WHERE project_id = ? AND id <> ? AND source_commit IS NOT NULL ORDER BY created_at LIMIT 1`).bind(job.project_id, job.id).first<{ starter_ref: string | null }>();
  if (prior && !prior.starter_ref) return job.strategy === "standard" ? { starter: { name: "brochure", version: "1" }, ref: "brochure-v1", quality: false } : { starter: null, ref: null, quality: false };
  if (prior?.starter_ref && prior.starter_ref !== `${STARTER.name}-v${STARTER.version}`) {
    const m = /^(.+)-v(\d+)$/.exec(prior.starter_ref);
    if (m) return { starter: { name: m[1], version: m[2] }, ref: prior.starter_ref, quality: m[1] === "fullstack" };
  }
  return { starter: { ...STARTER }, ref: `${STARTER.name}-v${STARTER.version}`, quality: true };
}

const MICRO = 1_000_000;
export const usdToMicro = (usd: unknown): number => {
  const n = typeof usd === "number" && Number.isFinite(usd) ? usd : 0;
  return Math.min(1e12, Math.max(0, Math.round(n * MICRO)));
};
export const microToUsd = (m: number) => Math.round(m) / MICRO;

// ── Settings ──

export interface BuildSettings {
  automation_enabled: number; globally_paused: number; pause_reason: string | null; auto_start_after: string;
  run_budget_micro: number; project_budget_micro: number; max_runtime_minutes: number; max_turns: number;
  max_concurrent: number; max_attempts: number; lease_seconds: number; model: string; updated_by: string | null; updated_at: string;
  /** Founder policy for customer revision requests (migration 0056): off | owner_approval (default) | auto. */
  customer_revision_mode: CustomerRevisionMode;
  /** Days before a superseded / finished build's preview is deleted; null = keep until an owner deletes it (0041). */
  preview_retention_days: number | null;
}
export const CUSTOMER_REVISION_MODES = ["off", "owner_approval", "auto"] as const;
export type CustomerRevisionMode = (typeof CUSTOMER_REVISION_MODES)[number];
export async function getBuildSettings(db: Db): Promise<BuildSettings> {
  const s = await db.prepare(`SELECT * FROM build_settings WHERE id = 1`).first<BuildSettings>();
  if (!s) throw new Error("build_settings row missing (migration 0031)");
  return s;
}

// ── Jobs ──

export interface BuildJob {
  id: string; project_id: string; organization_id: string; order_id: string | null; kind: "first_build" | "revision"; revision: number;
  dedupe_key: string; state: BuildState; state_reason: string | null; strategy: "standard" | "custom"; package_id: string | null;
  brief_id: string | null; instruction: string | null; trigger: string; created_by: string | null; attempts: number; max_attempts: number;
  not_before: string | null; cost_micro: number; turns: number; agent_session_id: string | null; workspace_ref: string | null;
  checkpoint_key: string | null; source_repo: string | null; source_branch: string | null; source_commit: string | null;
  preview_url: string | null; report_md: string | null; missing_info_json: string | null; lease_runner: string | null;
  lease_token_hash: string | null; lease_expires_at: string | null; heartbeat_at: string | null; stop_reason: string | null;
  run_started_at: string | null; started_at: string | null; finished_at: string | null; cancel_requested_at: string | null;
  cancel_requested_by: string | null; approved_by: string | null; approved_at: string | null; created_at: string; updated_at: string;
  /** The customer's revision request (portal `revisions`) this AI revision works on; null for owner-initiated revisions. */
  customer_revision_id: string | null;
  preview_name: string | null; preview_delete_requested_at: string | null; preview_delete_claimed_at: string | null; preview_deleted_at: string | null;
  preview_preserved: number; preview_retain_until: string | null; preview_delete_reason: string | null; preview_gated: number;
  customer_preview_shared_at: string | null; customer_preview_shared_by: string | null; customer_review: "approved" | "changes_requested" | null;
  customer_reviewed_by: string | null; customer_reviewed_at: string | null; customer_review_note: string | null;
  /** V4: GPU worker, what the website's agent is doing now (runner-reported), automated acceptance, private review gate. */
  worker_id: string | null; activity_state: string | null; current_model: string | null; current_task: string | null; activity_at: string | null;
  ai_acceptance: "passed" | "passed_pending_integrations" | "failed" | null;
  internal_approved_at: string | null; internal_approved_by: string | null; internal_approval_note: string | null;
  /** Quality engine (migration 0063): this job may enter internal approval only with a verified 10/10 scorecard. */
  quality_required?: number; starter_ref?: string | null;
}

export async function getJob(db: Db, id: string): Promise<BuildJob | null> {
  return db.prepare(`SELECT * FROM build_jobs WHERE id = ?`).bind(id).first<BuildJob>();
}

type Actor = { kind: "system" | "runner" | "user" | "webhook"; userId?: string | null };

async function event(db: Db, jobId: string, kind: string, message: string, actor: Actor, extra: { from?: string; to?: string; data?: unknown } = {}) {
  await db.prepare(`INSERT INTO build_events (job_id, at, kind, from_state, to_state, message, actor_kind, actor_user_id, data_json) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(jobId, nowIso(), kind, extra.from ?? null, extra.to ?? null, sanitize(message, 1000), actor.kind, actor.userId ?? null, extra.data === undefined ? null : JSON.stringify(extra.data)).run();
}

/** Compare-and-set state change with a recorded reason. Returns false when another writer changed the state first. */
async function transition(db: Db, job: Pick<BuildJob, "id" | "state">, to: BuildState, reason: string, actor: Actor, sets: Record<string, unknown> = {}): Promise<boolean> {
  assertBuildTransition(job.state, to);
  const cols = Object.keys(sets);
  const at = nowIso();
  const r = await db.prepare(`UPDATE build_jobs SET state = ?, state_reason = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join("")} WHERE id = ? AND state = ?`)
    .bind(to, reason, at, ...cols.map((c) => sets[c]), job.id, job.state).run();
  if (!r.meta?.changes) return false;
  await event(db, job.id, "transition", reason, actor, { from: job.state, to });
  // The project pipeline follows the job. V4: the GPU-worker affinity (where the workspace and checkpoints live) lasts
  // through reviews and revisions; it ends at final approval or cancellation. It never holds GPU capacity by itself.
  const p = await db.prepare(`SELECT project_id FROM build_jobs WHERE id = ?`).bind(job.id).first<{ project_id: string }>();
  if (p) {
    await syncStageFromJob(db, { project_id: p.project_id, state: to, state_reason: reason });
    if (["approved", "canceled"].includes(to)) await releaseAssignment(db, p.project_id, `build ${to.replace(/_/g, " ")}`);
  }
  return true;
}

export function sanitize(text: unknown, max = 500): string {
  // eslint-disable-next-line no-control-regex
  const s = redact(String(text ?? "")).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{10,}/g, "[redacted-token]")
    .replace(/\b(?:sk-ant|sk|rk)-[A-Za-z0-9_-]{10,}/g, "[redacted-key]")
    .replace(/\b(?:Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]")
    .replace(/[A-Za-z0-9+/]{48,}={0,2}/g, "[redacted-blob]");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ── Eligibility ──

export interface ProjectFacts {
  project: { id: string; organization_id: string; order_id: string | null; product_id: string | null; name: string; status: string; payment_schedule: string | null; created_at: string } | null;
  order: { id: string; organization_id: string; product_id: string | null; quote_version_id: string | null; status: string; kind: string } | null;
  qualifying: { id: string; status: string; paid_at: string | null; milestone_kind: string } | null;
  intakeSubmittedAt: string | null;
  verifiedCustomer: boolean;
  scopeRecorded: boolean;
  refunded: boolean;
  disputed: boolean;
  /** The qualifying payment came from the test-only payment simulation (migration 0059). */
  simulatedPayment?: boolean;
  /** The Owner marked the organization as a fictional test organization (required for a simulated payment to count). */
  simulationTestOrg?: boolean;
}

export async function projectFacts(db: Db, projectId: string): Promise<ProjectFacts> {
  const project = await db.prepare(`SELECT id, organization_id, order_id, product_id, name, status, payment_schedule, created_at FROM projects WHERE id = ?`).bind(projectId).first<NonNullable<ProjectFacts["project"]>>();
  if (!project) return { project: null, order: null, qualifying: null, intakeSubmittedAt: null, verifiedCustomer: false, scopeRecorded: false, refunded: false, disputed: false };
  const order = project.order_id ? await db.prepare(`SELECT id, organization_id, product_id, quote_version_id, status, kind FROM orders WHERE id = ?`).bind(project.order_id).first<NonNullable<ProjectFacts["order"]>>() : null;
  // The order's first invoice is the qualifying payment under the existing policy: 100% upfront ("full") for packages
  // and upfront quotes, or the 50% deposit ("deposit_50") for milestone quotes. Later 25% milestones never gate the first build.
  const qualifying = order ? await db.prepare(`SELECT id, status, paid_at, milestone_kind FROM invoices WHERE order_id = ? AND milestone_kind IN ('full','deposit_50') ORDER BY created_at LIMIT 1`).bind(order.id).first<NonNullable<ProjectFacts["qualifying"]>>() : null;
  const onboarding = await db.prepare(`SELECT completed_at FROM onboarding_responses WHERE project_id = ?`).bind(projectId).first<{ completed_at: string | null }>();
  const org = await db.prepare(`SELECT o.kind, o.simulation_test_org, EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = o.id AND m.role_id = 'customer_admin' AND u.email_verified_at IS NOT NULL AND u.disabled_at IS NULL) AS verified
                                 FROM organizations o WHERE o.id = ?`).bind(project.organization_id).first<{ kind: string; simulation_test_org: number; verified: number }>();
  const scopeRecorded = !!order && (order.product_id && order.product_id in PACKAGES
    ? true
    : !!(order.quote_version_id && (await db.prepare(`SELECT 1 FROM quote_versions WHERE id = ? AND COALESCE(TRIM(scope_text),'') <> ''`).bind(order.quote_version_id).first())));
  const pay = qualifying ? await db.prepare(`SELECT status, provider FROM payments WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1`).bind(qualifying.id).first<{ status: string; provider: string }>() : null;
  const refundRow = order ? await db.prepare(`SELECT 1 FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.order_id = ? AND r.status IN ('approved','issued')`).bind(order.id).first() : null;
  return {
    project, order, qualifying, intakeSubmittedAt: onboarding?.completed_at ?? null,
    verifiedCustomer: org?.kind === "customer" && !!org.verified && order?.organization_id === project.organization_id,
    scopeRecorded,
    refunded: !!refundRow || pay?.status === "refunded" || pay?.status === "partially_refunded",
    disputed: pay?.status === "disputed",
    simulatedPayment: pay?.provider === "simulated",
    simulationTestOrg: !!org?.simulation_test_org,
  };
}

/** True when any payment on the project's order came from the test-only payment simulation (migration 0059). */
export async function projectPaidBySimulation(db: Db, projectId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 FROM payments p JOIN projects pr ON pr.order_id = p.order_id WHERE pr.id = ? AND p.provider = 'simulated' LIMIT 1`).bind(projectId).first());
}

export type Eligibility = { verdict: "queued" | "awaiting_intake" | "awaiting_payment" | "ineligible"; reasons: string[] };

/** Pure decision from recorded facts. Payment truth is only an invoice marked paid by a verified Stripe webhook. */
export function decideEligibility(f: ProjectFacts): Eligibility {
  const bad: string[] = [];
  if (!f.project) return { verdict: "ineligible", reasons: ["project not found"] };
  if (["cancelled", "completed", "maintenance"].includes(f.project.status)) bad.push(`project is ${f.project.status}`);
  if (!f.order) bad.push("no order is linked to the project");
  else if (f.order.status === "cancelled" || f.order.status === "refunded") bad.push(`order is ${f.order.status}`);
  if (!f.verifiedCustomer) bad.push("the customer organization has no verified customer admin");
  if (!f.scopeRecorded) bad.push("the purchased package or accepted quote scope is not recorded");
  if (f.refunded) bad.push("a refund was approved or issued for this order");
  if (f.disputed) bad.push("the qualifying payment is disputed");
  // A simulated payment (test-only adapter) only ever unlocks a build for a fictional test organization.
  if (f.simulatedPayment && !f.simulationTestOrg) bad.push("the qualifying payment was simulated and the organization is not a marked test organization");
  if (bad.length) return { verdict: "ineligible", reasons: bad };
  const paid = f.qualifying?.status === "paid" && !!f.qualifying.paid_at;
  const intake = !!f.intakeSubmittedAt;
  if (!intake) return { verdict: "awaiting_intake", reasons: [paid ? "payment verified; required intake not submitted" : "intake and payment both outstanding"] };
  if (!paid) return { verdict: "awaiting_payment", reasons: [`intake submitted; qualifying ${f.qualifying?.milestone_kind ?? "payment"} not verified`] };
  return { verdict: "queued", reasons: ["verified payment and submitted intake"] };
}

async function projectControls(db: Db, projectId: string) {
  return db.prepare(`SELECT * FROM build_project_controls WHERE project_id = ?`).bind(projectId)
    .first<{ paused: number; pause_reason: string | null; project_budget_micro: number | null; backfill_authorized_at: string | null }>();
}

/**
 * Re-evaluates the first build of a project. Called after a verified payment, an intake submission, refunds,
 * disputes and cancellations, and by the scheduled sweep (which recovers any enqueue lost between recording a
 * payment and this call). Idempotent: one first build per project (dedupe_key), compare-and-set transitions.
 */
export async function syncProjectBuild(db: Db, projectId: string, trigger: "payment" | "intake" | "sweep" | "backfill", actor: Actor = { kind: "system" }): Promise<BuildJob | null> {
  const settings = await getBuildSettings(db);
  const f = await projectFacts(db, projectId);
  if (!f.project) return null;
  const decision = decideEligibility(f);
  const dedupe = `${projectId}:first`;
  let job = await db.prepare(`SELECT * FROM build_jobs WHERE dedupe_key = ?`).bind(dedupe).first<BuildJob>();
  if (!job) {
    if (decision.verdict === "ineligible" || !settings.automation_enabled) return null;
    const controls = await projectControls(db, projectId);
    // Historical projects never start on their own; the Owner backfills selected ones.
    if (f.project.created_at < settings.auto_start_after && !controls?.backfill_authorized_at) return null;
    const at = nowIso();
    const id = newId("bld");
    const strategy = f.order?.product_id && f.order.product_id in PACKAGES ? "standard" : "custom";
    const ins = await db.prepare(`INSERT OR IGNORE INTO build_jobs (id, project_id, organization_id, order_id, kind, revision, dedupe_key, state, state_reason, strategy, package_id, trigger, created_by, max_attempts, created_at, updated_at)
                                  VALUES (?,?,?,?, 'first_build', 0, ?, 'awaiting_intake', 'created', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, projectId, f.project.organization_id, f.order?.id ?? null, dedupe, strategy, strategy === "standard" ? f.order!.product_id : null, trigger, actor.userId ?? null, settings.max_attempts, at, at).run();
    job = await db.prepare(`SELECT * FROM build_jobs WHERE dedupe_key = ?`).bind(dedupe).first<BuildJob>();
    if (!job) return null;
    if (ins.meta?.changes) await event(db, job.id, "action", `Build record created (${trigger})`, actor);
  }
  return applyDecision(db, job, decision, actor);
}

async function applyDecision(db: Db, job: BuildJob, d: Eligibility, actor: Actor): Promise<BuildJob> {
  const reason = d.reasons.join("; ");
  if (d.verdict === "ineligible") {
    if ((PENDING_STATES as readonly string[]).includes(job.state) || ["needs_information", "failed", "budget_paused", "paused", "ready_for_review"].includes(job.state)) {
      await transition(db, job, "canceled", `No longer eligible: ${reason}`, actor, { finished_at: nowIso() });
    } else if ((ACTIVE_STATES as readonly string[]).includes(job.state) && !job.cancel_requested_at) {
      await db.prepare(`UPDATE build_jobs SET cancel_requested_at = ?, stop_reason = 'ineligible', updated_at = ? WHERE id = ? AND cancel_requested_at IS NULL`).bind(nowIso(), nowIso(), job.id).run();
      await event(db, job.id, "action", `Stop requested: no longer eligible (${reason})`, actor);
    }
  } else if ((PENDING_STATES as readonly string[]).includes(job.state) && job.state !== d.verdict) {
    if (d.verdict === "queued") await enqueue(db, job, reason, actor);
    else await transition(db, job, d.verdict, reason, actor);
  }
  return (await getJob(db, job.id))!;
}

async function enqueue(db: Db, job: BuildJob, reason: string, actor: Actor): Promise<boolean> {
  const brief = await snapshotBrief(db, job.project_id);
  try {
    const ok = await transition(db, job, "queued", reason, actor, { brief_id: brief.id, not_before: null });
    if (ok) await seedRequirements(db, job.id, brief.content, job.kind === "revision");
    if (ok) await seedIntegrationsFromBrief(db, job.project_id, job.organization_id, brief.content);
    return ok;
  } catch (e) {
    // Partial unique index: another build of this project is active. Stay pending; the sweep retries.
    if (/UNIQUE/i.test((e as Error).message)) { await event(db, job.id, "action", "Waiting: another build for this project is active", actor); return false; }
    throw e;
  }
}

// ── Brief ──

const lines = (v: unknown) => String(v ?? "").split(/\r?\n|,/).map((s) => s.trim().replace(/^[-*•\d.)\s]+/, "").trim()).filter(Boolean);
const str = (a: Answers, k: string) => (Array.isArray(a[k]) ? (a[k] as string[]).join(", ") : String(a[k] ?? "")).trim();
const arr = (a: Answers, k: string) => (Array.isArray(a[k]) ? (a[k] as string[]) : a[k] ? [String(a[k])] : []);

export async function buildBrief(db: Db, projectId: string): Promise<BuildBrief> {
  const f = await projectFacts(db, projectId);
  if (!f.project) throw new HttpError(404, "Project not found");
  const ob = await getOnboarding(db, projectId);
  const a: Answers = ob?.answers ?? {};
  const pkg = f.order?.product_id && f.order.product_id in PACKAGES ? PACKAGES[f.order.product_id as PackageId] : null;
  const quote = f.order?.quote_version_id ? await db.prepare(`SELECT scope_text, line_items_json FROM quote_versions WHERE id = ?`).bind(f.order.quote_version_id).first<{ scope_text: string | null; line_items_json: string | null }>().catch(() => null) : null;
  const scopeRow = await db.prepare(`SELECT scope_text FROM project_scopes WHERE project_id = ? ORDER BY version DESC LIMIT 1`).bind(projectId).first<{ scope_text: string }>();
  const files = (await db.prepare(`SELECT id, filename, content_type, size_bytes, folder FROM files WHERE project_id = ? AND deleted_at IS NULL AND replaced_by IS NULL AND scan_status NOT IN ('infected','failed') ORDER BY created_at`).bind(projectId)
    .all<{ id: string; filename: string; content_type: string; size_bytes: number; folder: string | null }>().catch(() => ({ results: [] as never[] }))).results;
  const requested = lines(a.pages);
  const limit = pkg?.pageLimit ?? 999;
  const lineItems = (() => { try { return (JSON.parse(quote?.line_items_json ?? "[]") as { description?: string }[]).map((l) => String(l.description ?? "").trim()).filter(Boolean); } catch { return []; } })();
  const featureDetail: Record<string, string> = { booking: "booking_details", ecommerce: "ecommerce_details", other: "functionality_other" };
  const features = arr(a, "functionality").map((k) => ({ key: k, details: featureDetail[k] ? str(a, featureDetail[k]) : "" }));
  const refs = lines(a.competitors).map((l) => { const m = /(https?:\/\/[^\s]+)/.exec(l); return m ? { url: m[1], note: l.replace(m[1], "").replace(/^[\s:–-]+/, "").trim() } : null; }).filter((x): x is { url: string; note: string } => !!x).slice(0, 10);
  const missing: BriefGap[] = [];
  for (const fld of allFields(f.order?.product_id ?? null)) {
    if (!isVisible(fld, a) || fld.type === "file") continue;
    const empty = Array.isArray(a[fld.name]) ? !(a[fld.name] as string[]).length : !String(a[fld.name] ?? "").trim();
    if (empty && fld.required) missing.push({ field: fld.name, label: fld.label, critical: true });
  }
  if (str(a, "has_branding") === "yes" && !files.some((x) => (x.folder ?? "").toLowerCase().includes("logo") || /logo/i.test(x.filename))) missing.push({ field: "logo", label: "Logo file", critical: false });
  if (str(a, "content_source") !== "crestmont_draft" && !str(a, "content_notes")) missing.push({ field: "content", label: "Written page content", critical: false });
  const assumptions: string[] = [];
  if (requested.length > limit) assumptions.push(`Only the first ${limit} requested pages are in the ${pkg?.name} package; the rest need a change order.`);
  if (!requested.length) assumptions.push(pkg ? "No pages were listed; build a sensible standard set within the page limit (Home, About, Services, Contact)." : "No page list; derive pages from the accepted scope.");
  if (str(a, "content_source") === "crestmont_draft") assumptions.push("Draft placeholder copy is clearly marked for customer review before launch.");
  const strategy: BuildBrief["strategy"] = pkg ? "standard" : "custom";
  const acceptance = pkg
    ? [...pkg.includes.map((i) => `Package item delivered: ${i}`), "Every page is responsive at 375, 768 and 1440 px without horizontal scroll", "Semantic headings, landmarks, labelled form fields and image alt text", "No broken internal links", "Contact form posts to a real handler or is clearly marked unconfigured"]
    : ["Requirements map covers every accepted scope item", "Architecture, data model and routes documented", "Core user flows implemented end to end where in first-pass scope", "Automated checks run and pass", "Prioritized remaining-work list"];
  return {
    schema: "crestmont.build-brief/1",
    project: { id: f.project.id, name: f.project.name },
    strategy,
    package: pkg ? { id: pkg.id, name: pkg.name, pageLimit: pkg.pageLimit, revisionRounds: pkg.revisionRounds, includes: [...pkg.includes] } : null,
    custom: pkg ? null : { scope: (quote?.scope_text ?? scopeRow?.scope_text ?? "").slice(0, 20000), lineItems: lineItems.slice(0, 100) },
    deliverables: pkg ? [...pkg.includes] : lineItems.length ? lineItems : lines(scopeRow?.scope_text).slice(0, 50),
    exclusions: pkg ? ["Features not listed in the package (custom functionality requires a quote or change order)", `More than ${pkg.pageLimit} pages`, "Production publishing, domain changes and live payments (owner-controlled)"] : ["Anything outside the accepted quote scope", "Production publishing, domain changes and live payments (owner-controlled)"],
    customerData: {
      business: { name: str(a, "business_name"), industry: str(a, "industry"), publicEmail: str(a, "contact_email"), publicPhone: str(a, "contact_phone") },
      goals: str(a, "goals"), audience: str(a, "target_audience"),
      brand: { hasBranding: str(a, "has_branding") === "yes", guidelines: str(a, "brand_guidelines"), style: str(a, "brand_style"), colors: str(a, "colors"),
        logoFileIds: files.filter((x) => /logo/i.test(x.filename) || (x.folder ?? "").toLowerCase().includes("logo")).map((x) => x.id) },
      pages: requested.slice(0, limit), pagesOverLimit: requested.slice(limit),
      features, integrations: arr(a, "integrations"), references: refs,
      content: { source: str(a, "content_source"), notes: str(a, "content_notes"), imagesSource: str(a, "images_source") },
      domain: { status: str(a, "domain_status"), name: str(a, "domain_name"), hosting: str(a, "hosting") },
      additionalNotes: [str(a, "advanced_features"), str(a, "integration_details"), str(a, "special_instructions"),
        ...lines(a.competitors).filter((l) => !/https?:\/\//.test(l)).map((l) => `Reference note: ${l}`)].filter(Boolean).join("\n\n"),
    },
    files: files.map((x) => ({ id: x.id, name: x.filename, contentType: x.content_type, size: x.size_bytes, folder: x.folder })),
    missingInformation: missing,
    assumptions,
    acceptanceCriteria: acceptance,
    rules: [...BRIEF_RULES],
  };
}

/** Immutable, versioned snapshot; a new version only when the content changed. */
export async function snapshotBrief(db: Db, projectId: string): Promise<{ id: string; version: number; content: BuildBrief }> {
  const content = await buildBrief(db, projectId);
  const json = JSON.stringify(content);
  const sha = await sha256Hex(json);
  const latest = await db.prepare(`SELECT id, version, sha256, content_json FROM build_briefs WHERE project_id = ? ORDER BY version DESC LIMIT 1`).bind(projectId).first<{ id: string; version: number; sha256: string; content_json: string }>();
  if (latest && latest.sha256 === sha) return { id: latest.id, version: latest.version, content: JSON.parse(latest.content_json) as BuildBrief };
  const id = newId("brf");
  const version = (latest?.version ?? 0) + 1;
  await db.prepare(`INSERT INTO build_briefs (id, project_id, version, content_json, sha256, created_at) VALUES (?,?,?,?,?,?)`).bind(id, projectId, version, json, sha, nowIso()).run();
  return { id, version, content };
}

async function seedRequirements(db: Db, jobId: string, brief: BuildBrief, revision: boolean) {
  if (revision) return; // revisions are scoped by their instruction; the runner reports the items it touches
  const items: { key: string; label: string }[] = [];
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
  for (const p of brief.customerData.pages) items.push({ key: `page:${slug(p)}`, label: `Page: ${p.slice(0, 120)}` });
  for (const ft of brief.customerData.features) items.push({ key: `feature:${slug(ft.key)}`, label: `Feature: ${ft.key.replace(/_/g, " ")}` });
  for (const [i, d] of brief.deliverables.entries()) items.push({ key: `deliverable:${i + 1}`, label: d.slice(0, 200) });
  for (const [i, c] of brief.acceptanceCriteria.entries()) items.push({ key: `acceptance:${i + 1}`, label: c.slice(0, 200) });
  const at = nowIso();
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.key)) continue;
    seen.add(it.key);
    await db.prepare(`INSERT OR IGNORE INTO build_requirements (job_id, key, label, status, updated_at) VALUES (?,?,?, 'remaining', ?)`).bind(jobId, it.key, it.label, at).run();
  }
}

// ── Runner API ──

export class RunnerAuthError extends Error { readonly status = 401; }
export class LeaseLostError extends Error { readonly status = 409; }

export async function verifyRunnerSignature(secret: string | undefined, body: string, header: string | null, nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
  if (!secret) throw new HttpError(503, "Build runner not configured");
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) throw new RunnerAuthError("Missing or malformed signature");
  if (Math.abs(nowSeconds - Number(m[1])) > 600) throw new RunnerAuthError("Signature timestamp outside tolerance");
  if (!timingSafeEqualHex(m[2], await hmacSha256Hex(secret, `${m[1]}.${body}`))) throw new RunnerAuthError("Signature mismatch");
}

async function activeCount(db: Db) {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM build_jobs WHERE state IN ('preparing','building','verifying')`).first<{ n: number }>())!.n;
}
export async function projectSpendMicro(db: Db, projectId: string): Promise<number> {
  return (await db.prepare(`SELECT COALESCE(SUM(cost_micro),0) AS c FROM build_jobs WHERE project_id = ?`).bind(projectId).first<{ c: number }>())!.c;
}
async function projectBudgetMicro(db: Db, projectId: string, s: BuildSettings) {
  return (await projectControls(db, projectId))?.project_budget_micro ?? s.project_budget_micro;
}

/** Capability a runner announces when its model costs nothing per token (the self-hosted local provider). */
export const ZERO_COST_CAPABILITY = "zero-token-cost";

/** Runner capabilities as recorded: strings only, bounded. */
export function runnerCapabilities(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).filter((c): c is string => typeof c === "string").map((c) => c.slice(0, 40)).slice(0, 20);
}

/**
 * Paid-AI gate on the platform side. A runner that does not declare zero token cost is treated as paid (unknown or
 * older runners included) and gets no work unless the Worker explicitly allows paid providers. This is the second key
 * next to the runner's own RUNNER_ALLOW_PAID_PROVIDER; budgets still apply on top.
 */
export function paidProviderRefused(capabilities: string[], allowPaidProvider: boolean): boolean {
  return !allowPaidProvider && !capabilities.includes(ZERO_COST_CAPABILITY);
}

export async function claimJob(db: Db, runner: { runnerId: string; version?: string; capabilities?: unknown; workerId?: unknown; workerKey?: unknown; status?: unknown }, now = new Date(), opts: { allowPaidProvider?: boolean } = {}) {
  const runnerId = String(runner.runnerId ?? "").slice(0, 64);
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(runnerId)) throw new HttpError(422, "runnerId must be 1-64 characters of [A-Za-z0-9._:-]");
  const at = now.toISOString();
  const capabilities = runnerCapabilities(runner.capabilities);
  const version = String(runner.version ?? "").slice(0, 40);
  await db.prepare(`INSERT INTO build_runners (runner_id, version, capabilities, last_seen_at) VALUES (?,?,?,?) ON CONFLICT(runner_id) DO UPDATE SET version = excluded.version, capabilities = excluded.capabilities, last_seen_at = excluded.last_seen_at`)
    .bind(runnerId, version, JSON.stringify(capabilities), at).run();
  if (paidProviderRefused(capabilities, !!opts.allowPaidProvider)) return { job: null, reason: "paid_provider_not_authorized" as const };
  // V4 worker mode: once GPU workers are registered, every claim names its worker; a worker receives work only for the
  // websites assigned to it, up to its concurrent-build capacity (a website waiting for a person holds none).
  let worker: Awaited<ReturnType<typeof authenticateWorker>> | null = null;
  if (await workerModeOn(db)) {
    worker = await authenticateWorker(db, runner.workerId, runner.workerKey);
    await recordWorkerStatus(db, worker, runnerId, runner.status && typeof runner.status === "object" ? runner.status as Record<string, unknown> : {}, now);
    await dispatch(db, now);
    const fresh = await db.prepare(`SELECT dispatch_paused, max_active_projects, cost_class FROM build_workers WHERE id = ?`).bind(worker.id).first<{ dispatch_paused: number; max_active_projects: number; cost_class: string }>();
    if (fresh?.dispatch_paused) return { job: null, reason: "paused" as const };
    if (fresh?.cost_class !== "owned-hardware") return { job: null, reason: "paid_provider_not_authorized" as const };
    if (await activeBuilds(db, worker.id) >= (fresh?.max_active_projects ?? 1)) return { job: null, reason: "at_capacity" as const };
  }
  const s = await getBuildSettings(db);
  if (s.globally_paused || !s.automation_enabled) return { job: null, reason: "paused" as const };
  if (await activeCount(db) >= s.max_concurrent) return { job: null, reason: "at_capacity" as const };
  const rows = worker
    ? (await db.prepare(`SELECT j.*, COALESCE(pl.priority, 0) AS _priority FROM build_jobs j JOIN build_assignments a ON a.project_id = j.project_id AND a.released_at IS NULL AND a.worker_id = ?
        LEFT JOIN build_project_controls c ON c.project_id = j.project_id LEFT JOIN build_pipeline pl ON pl.project_id = j.project_id
        WHERE j.state = 'queued' AND (j.not_before IS NULL OR j.not_before <= ?) AND COALESCE(c.paused,0) = 0 ORDER BY COALESCE(pl.priority, 0) DESC, j.created_at LIMIT 200`).bind(worker.id, at).all<BuildJob & { _priority: number }>()).results
    : (await db.prepare(`SELECT j.*, COALESCE(pl.priority, 0) AS _priority FROM build_jobs j LEFT JOIN build_project_controls c ON c.project_id = j.project_id LEFT JOIN build_pipeline pl ON pl.project_id = j.project_id
      WHERE j.state = 'queued' AND (j.not_before IS NULL OR j.not_before <= ?) AND COALESCE(c.paused,0) = 0 ORDER BY COALESCE(pl.priority, 0) DESC, j.created_at LIMIT 200`).bind(at).all<BuildJob & { _priority: number }>()).results;
  // Founder priority first, raised by waiting time (no starvation); then arrival.
  const candidates = rows.map((r) => ({ r, e: effectivePriority(r._priority, r.created_at, now) })).sort((a, b) => b.e - a.e || (a.r.created_at < b.r.created_at ? -1 : a.r.created_at > b.r.created_at ? 1 : 0)).map((x) => x.r).slice(0, 10);
  for (const c of candidates) {
    const budget = await projectBudgetMicro(db, c.project_id, s);
    const spent = await projectSpendMicro(db, c.project_id);
    if (spent >= budget) { await transition(db, c, "budget_paused", `Project budget reached ($${microToUsd(spent).toFixed(2)} of $${microToUsd(budget).toFixed(2)}); raise the limit to continue`, { kind: "system" }); continue; }
    const pick = await starterFor(db, c);
    const token = randomToken(32);
    const leaseUntil = new Date(now.getTime() + s.lease_seconds * 1000).toISOString();
    const r = await db.prepare(`UPDATE build_jobs SET state = 'preparing', state_reason = 'claimed by runner', lease_runner = ?, lease_token_hash = ?, lease_expires_at = ?, heartbeat_at = ?,
        run_started_at = ?, started_at = COALESCE(started_at, ?), attempts = attempts + 1, stop_reason = NULL, worker_id = COALESCE(?, worker_id), updated_at = ?,
        quality_required = ?, starter_ref = ?
      WHERE id = ? AND state = 'queued' AND (SELECT COUNT(*) FROM build_jobs WHERE state IN ('preparing','building','verifying')) < ?
        AND (? IS NULL OR (SELECT COUNT(*) FROM build_jobs WHERE worker_id = ? AND state IN ('preparing','building','verifying')) < (SELECT max_active_projects FROM build_workers WHERE id = ?))`)
      .bind(runnerId, await sha256Hex(token), leaseUntil, at, at, at, worker?.id ?? null, at, pick.quality ? 1 : 0, pick.ref, c.id, s.max_concurrent, worker?.id ?? null, worker?.id ?? null, worker?.id ?? null).run();
    if (!r.meta?.changes) continue; // another runner won this job (or capacity filled): try the next
    const job = (await getJob(db, c.id))!;
    await db.prepare(`INSERT OR IGNORE INTO build_runs (id, job_id, attempt, runner_id, started_at, session_id, zero_cost) VALUES (?,?,?,?,?,?,?)`)
      .bind(newId("brun"), job.id, job.attempts, runnerId, at, job.agent_session_id, capabilities.includes(ZERO_COST_CAPABILITY) ? 1 : 0).run();
    // Audit: which runner build and which kind of provider (zero-cost or paid) took this attempt.
    const billing = capabilities.includes(ZERO_COST_CAPABILITY) ? "zero-cost provider" : "PAID provider";
    await event(db, job.id, "transition", `Claimed by runner ${runnerId}${worker ? ` for worker ${worker.label}` : ""} (attempt ${job.attempts}; ${billing})`, { kind: "runner" },
      { from: "queued", to: "preparing", data: { runnerVersion: version, capabilities, paidProvider: !capabilities.includes(ZERO_COST_CAPABILITY) } });
    const brief = job.brief_id ? await db.prepare(`SELECT id, version, sha256, content_json FROM build_briefs WHERE id = ?`).bind(job.brief_id).first<{ id: string; version: number; sha256: string; content_json: string }>() : null;
    const reqs = (await db.prepare(`SELECT key, label, status FROM build_requirements WHERE job_id = ? ORDER BY key`).bind(job.id).all<{ key: string; label: string; status: string }>()).results;
    const remaining = Math.max(0, budget - spent);
    return {
      job: {
        id: job.id, projectId: job.project_id, attempt: job.attempts, kind: job.kind, revision: job.revision,
        leaseToken: token, leaseExpiresAt: leaseUntil, heartbeatSeconds: Math.max(10, Math.floor(s.lease_seconds / 4)),
        // Full-Stack Builder V2: every package, and custom builds, start from the full-stack foundation and are scored by
        // the permanent quality engine (protocol v1.5). A runner that ignores "quality" still cannot get past
        // completeJob / internalApprove without a verified 10/10 scorecard.
        strategy: job.strategy, packageId: job.package_id ?? (job.strategy === "custom" ? "custom" : null), starter: pick.starter, ...(pick.quality ? { quality: "required" as const } : {}),
        brief: brief ? { id: brief.id, version: brief.version, sha256: brief.sha256, content: JSON.parse(brief.content_json) } : null,
        instruction: job.instruction, requirements: reqs,
        // V2: the Architect's master specification when one exists (the orchestrator then skips the architect step).
        spec: await db.prepare(`SELECT spec_json, spec_version FROM build_pipeline WHERE project_id = ?`).bind(job.project_id).first<{ spec_json: string | null; spec_version: number }>()
          .then((r) => r?.spec_json ? { version: r.spec_version, content: JSON.parse(r.spec_json) } : null),
        worker: worker ? { id: worker.id, label: worker.label, maxActiveProjects: worker.max_active_projects } : null,
        limits: { model: s.model, maxTurns: s.max_turns, maxRuntimeMinutes: s.max_runtime_minutes, runBudgetUsd: microToUsd(Math.min(s.run_budget_micro, remaining)), projectBudgetRemainingUsd: microToUsd(remaining) },
        resume: job.agent_session_id || job.source_commit ? { sessionId: job.agent_session_id, workspaceRef: job.workspace_ref, checkpointKey: job.checkpoint_key, sourceRepo: job.source_repo, sourceBranch: job.source_branch, sourceCommit: job.source_commit } : null,
      },
    };
  }
  return { job: null, reason: "none_queued" as const };
}

/** The job a runner request refers to, only while that runner holds its lease (V2 orchestrator endpoints). */
export async function leasedJob(db: Db, jobId: unknown, token: unknown): Promise<BuildJob> { return leased(db, jobId, token); }

async function leased(db: Db, jobId: unknown, token: unknown): Promise<BuildJob> {
  if (typeof jobId !== "string" || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) throw new LeaseLostError("lease_lost");
  const job = await getJob(db, jobId);
  if (!job || !job.lease_token_hash || !(ACTIVE_STATES as readonly string[]).includes(job.state) || !timingSafeEqualHex(job.lease_token_hash, await sha256Hex(token))) throw new LeaseLostError("lease_lost");
  return job;
}

/** Activity states a runner reports for a build (V4 scheduler view). */
export const ACTIVITY_STATES = ["preparing", "gpu_running", "gpu_waiting", "model_switching", "testing", "reviewing", "idle"];

/** Provider id and model the runner reports (provider-independent record of what actually ran this attempt). */
const okProvider = (v: unknown) => typeof v === "string" && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(v) ? v : null;
const okModel = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/.test(v) ? v : null;

async function recordRunUsage(db: Db, job: BuildJob, runCostUsd: unknown, turns: unknown, sessionId?: unknown, provider?: unknown, model?: unknown) {
  const micro = usdToMicro(runCostUsd);
  if (okProvider(provider) || okModel(model)) {
    await db.prepare(`UPDATE build_runs SET provider = COALESCE(?, provider), model = COALESCE(?, model) WHERE job_id = ? AND attempt = ?`)
      .bind(okProvider(provider), okModel(model), job.id, job.attempts).run();
  }
  await db.prepare(`UPDATE build_runs SET cost_micro = MAX(cost_micro, ?), turns = MAX(turns, ?), session_id = COALESCE(?, session_id) WHERE job_id = ? AND attempt = ?`)
    .bind(micro, Math.max(0, Math.floor(Number(turns) || 0)), typeof sessionId === "string" ? sessionId.slice(0, 100) : null, job.id, job.attempts).run();
  await db.prepare(`UPDATE build_jobs SET cost_micro = (SELECT COALESCE(SUM(cost_micro),0) FROM build_runs WHERE job_id = ?), turns = (SELECT COALESCE(SUM(turns),0) FROM build_runs WHERE job_id = ?),
                    agent_session_id = COALESCE(?, agent_session_id), updated_at = ? WHERE id = ?`)
    .bind(job.id, job.id, typeof sessionId === "string" ? sessionId.slice(0, 100) : null, nowIso(), job.id).run();
  return micro;
}

/** The orchestrator — not the prompt — enforces cancellation, pauses, budgets and runtime here. */
export async function heartbeat(db: Db, b: Record<string, unknown>, now = new Date()) {
  const job = await leased(db, b.jobId, b.leaseToken);
  const s = await getBuildSettings(db);
  const runMicro = await recordRunUsage(db, job, b.runCostUsd, b.turns, b.sessionId, b.provider, b.model);
  const stage = b.stage;
  if ((stage === "building" || stage === "verifying" || stage === "preparing") && stage !== job.state) {
    try { await transition(db, job, stage, `Runner stage: ${stage}`, { kind: "runner" }); } catch { /* invalid stage order is ignored */ }
  }
  // V4 scheduler view: what this website's agent is doing now (GPU running / waiting / switching, tests, review).
  const o = b.orchestration && typeof b.orchestration === "object" ? b.orchestration as Record<string, unknown> : null;
  if (o) {
    const act = ACTIVITY_STATES.includes(o.activity as string) ? o.activity as string : null;
    const model = okModel(o.model);
    const task = typeof o.task === "string" && /^[a-z_]{2,40}$/.test(o.task) ? o.task : null;
    if (act) await db.prepare(`UPDATE build_jobs SET activity_state = ?, current_model = COALESCE(?, current_model), current_task = COALESCE(?, current_task), activity_at = ? WHERE id = ?`).bind(act, model, task, now.toISOString(), job.id).run();
  }
  for (const a of (Array.isArray(b.activity) ? b.activity : []).slice(0, 20)) {
    const x = a as { kind?: unknown; message?: unknown };
    await event(db, job.id, "activity", String(x.message ?? ""), { kind: "runner" }, { data: { kind: String(x.kind ?? "note").slice(0, 20) } });
  }
  const controls = await projectControls(db, job.project_id);
  const budget = controls?.project_budget_micro ?? s.project_budget_micro;
  const spent = await projectSpendMicro(db, job.project_id);
  const runtimeMin = job.run_started_at ? (now.getTime() - Date.parse(job.run_started_at)) / 60000 : 0;
  let stop: "canceled" | "paused" | "budget" | "runtime" | "ineligible" | null = null;
  if (job.cancel_requested_at) stop = job.stop_reason === "ineligible" ? "ineligible" : "canceled";
  else if (s.globally_paused || controls?.paused) stop = "paused";
  else if (runMicro >= s.run_budget_micro || spent >= budget) stop = "budget";
  else if (runtimeMin >= s.max_runtime_minutes || (Number(b.turns) || 0) >= s.max_turns) stop = "runtime";
  if (stop) {
    await db.prepare(`UPDATE build_jobs SET stop_reason = ?, updated_at = ? WHERE id = ?`).bind(stop, nowIso(), job.id).run();
    if (job.stop_reason !== stop) await event(db, job.id, "action", `Runner told to stop: ${stop}`, { kind: "system" }, { data: { runCostUsd: microToUsd(runMicro), projectSpendUsd: microToUsd(spent), runtimeMinutes: Math.round(runtimeMin) } });
    return { continue: false, reason: stop };
  }
  const leaseUntil = new Date(now.getTime() + s.lease_seconds * 1000).toISOString();
  await db.prepare(`UPDATE build_jobs SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?`).bind(leaseUntil, now.toISOString(), now.toISOString(), job.id).run();
  return { continue: true, leaseExpiresAt: leaseUntil };
}

const okUrl = (u: unknown) => typeof u === "string" && /^https:\/\/[^\s<>"']{3,500}$/.test(u) ? u : null;
const okRef = (u: unknown, max = 300) => typeof u === "string" && /^[\w./:@+-]{1,300}$/.test(u) ? u.slice(0, max) : null;

export async function checkpoint(db: Db, storage: StorageAdapter | null, b: Record<string, unknown>) {
  const job = await leased(db, b.jobId, b.leaseToken);
  let key: string | null = null;
  if (typeof b.archiveBase64 === "string" && b.archiveBase64.length) {
    if (!storage) throw new HttpError(409, "File storage is not configured on this environment; checkpoint archive not stored");
    if (b.archiveBase64.length > 28_000_000) throw new HttpError(413, "Checkpoint archive larger than 20 MB");
    const bytes = Uint8Array.from(atob(b.archiveBase64), (c) => c.charCodeAt(0));
    const n = ((await db.prepare(`SELECT COUNT(*) AS n FROM build_events WHERE job_id = ? AND kind = 'checkpoint'`).bind(job.id).first<{ n: number }>())!.n) + 1;
    key = `builds/${job.id}/ckpt-${n}.tgz`;
    await storage.put(key, bytes, "application/gzip");
  }
  await db.prepare(`UPDATE build_jobs SET agent_session_id = COALESCE(?, agent_session_id), workspace_ref = COALESCE(?, workspace_ref), checkpoint_key = COALESCE(?, checkpoint_key),
      source_repo = COALESCE(?, source_repo), source_branch = COALESCE(?, source_branch), source_commit = COALESCE(?, source_commit), updated_at = ? WHERE id = ?`)
    .bind(okRef(b.sessionId, 100), okRef(b.workspaceRef), key, okUrl(b.sourceRepo) ?? okRef(b.sourceRepo), okRef(b.sourceBranch, 200), okRef(b.sourceCommit, 64), nowIso(), job.id).run();
  await event(db, job.id, "checkpoint", `Checkpoint saved${key ? " with session archive" : ""}${typeof b.sourceCommit === "string" ? ` at ${b.sourceCommit.slice(0, 12)}` : ""}`, { kind: "runner" });
  return { checkpointKey: key };
}

/** Protocol v1.1: a runner on another host fetches the job's latest checkpoint archive to resume the session. */
export async function fetchCheckpoint(db: Db, storage: StorageAdapter | null, b: Record<string, unknown>) {
  const job = await leased(db, b.jobId, b.leaseToken);
  if (!job.checkpoint_key || b.checkpointKey !== job.checkpoint_key) throw new HttpError(404, "Checkpoint not found for this build");
  if (!storage) throw new HttpError(409, "File storage is not configured");
  const obj = await storage.get(job.checkpoint_key);
  if (!obj) throw new HttpError(404, "Checkpoint archive missing");
  const bytes = obj.body instanceof Uint8Array ? obj.body : new Uint8Array(await new Response(obj.body as BodyInit).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await event(db, job.id, "checkpoint", "Runner fetched the checkpoint archive to resume", { kind: "runner" });
  return { archiveBase64: btoa(bin) };
}

export async function reportRequirements(db: Db, b: Record<string, unknown>) {
  const job = await leased(db, b.jobId, b.leaseToken);
  let n = 0;
  for (const raw of (Array.isArray(b.items) ? b.items : []).slice(0, 300)) {
    const it = raw as Record<string, unknown>;
    const key = typeof it.key === "string" && /^[\w:.-]{1,80}$/.test(it.key) ? it.key : null;
    const status = (REQUIREMENT_STATUSES as readonly string[]).includes(String(it.status)) ? (it.status as RequirementStatus) : null;
    if (!key || !status) continue;
    if (status === "verified" && !String(it.evidence ?? "").trim()) continue; // "verified" requires evidence of a check that ran
    await db.prepare(`INSERT INTO build_requirements (job_id, key, label, status, evidence, blocker, updated_at) VALUES (?,?,?,?,?,?,?)
                      ON CONFLICT(job_id, key) DO UPDATE SET status = excluded.status, evidence = excluded.evidence, blocker = excluded.blocker, updated_at = excluded.updated_at,
                        label = CASE WHEN excluded.label <> '' THEN excluded.label ELSE build_requirements.label END`)
      .bind(job.id, key, sanitize(it.label ?? key, 200), status, it.evidence ? sanitize(it.evidence, 1000) : null, it.blocker ? sanitize(it.blocker, 500) : null, nowIso()).run();
    n++;
  }
  await event(db, job.id, "requirement", `${n} requirement update(s)`, { kind: "runner" });
  return { updated: n };
}

export async function runnerFile(db: Db, storage: StorageAdapter | null, b: Record<string, unknown>) {
  const job = await leased(db, b.jobId, b.leaseToken);
  if (!storage) throw new HttpError(409, "File storage is not configured");
  const f = await db.prepare(`SELECT id, r2_key, filename, content_type, size_bytes, scan_status FROM files WHERE id = ? AND organization_id = ? AND (project_id = ? OR project_id IS NULL) AND deleted_at IS NULL`)
    .bind(String(b.fileId ?? ""), job.organization_id, job.project_id).first<{ id: string; r2_key: string; filename: string; content_type: string; size_bytes: number; scan_status: string }>();
  if (!f) throw new HttpError(404, "File not found for this build");
  // Quarantined files (infected, or the scan itself failed) never reach the build sandbox. Unscanned files are passed
  // with scanStatus "pending" so the runner never treats them as clean.
  if (f.scan_status === "infected" || f.scan_status === "failed") throw new HttpError(409, f.scan_status === "infected" ? "File failed malware scanning" : "File is quarantined: its malware scan failed");
  if (f.size_bytes > 15_000_000) throw new HttpError(413, "File larger than 15 MB");
  const obj = await storage.get(f.r2_key);
  if (!obj) throw new HttpError(404, "File content missing");
  let bin = "";
  const bytes = obj.body instanceof Uint8Array ? obj.body : new Uint8Array(await new Response(obj.body as BodyInit).arrayBuffer());
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await event(db, job.id, "activity", `Runner fetched project file ${f.filename.slice(0, 80)}`, { kind: "runner" });
  return { name: f.filename, contentType: f.content_type, scanStatus: f.scan_status, base64: btoa(bin) };
}

/** Worker names the runner deploys previews under (runner/src/checks.ts PREVIEW_NAME). */
export const PREVIEW_NAME = /^cm-prv-[a-z0-9][a-z0-9-]{1,55}$/;
const okPreviewName = (v: unknown) => typeof v === "string" && PREVIEW_NAME.test(v) ? v : null;

/** Preview hosts allowed by default: the per-project Cloudflare Workers preview the brochure starter deploys to. */
export const DEFAULT_PREVIEW_HOSTS = [".workers.dev"];

export function previewHostList(raw: string | undefined): string[] {
  const list = String(raw ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => /^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h));
  return list.length ? list : DEFAULT_PREVIEW_HOSTS;
}

/** A preview URL is recorded only when it is https and its host is (a subdomain of) an allowed preview host. */
export function previewUrlAllowed(url: string, hosts: string[]): boolean {
  let host: string;
  try { const u = new URL(url); if (u.protocol !== "https:" || u.username || u.password) return false; host = u.hostname.toLowerCase(); } catch { return false; }
  return hosts.some((h) => h.startsWith(".") ? host.endsWith(h) && host.length > h.length : host === h || host.endsWith(`.${h}`));
}

export async function completeJob(db: Db, b: Record<string, unknown>, notify?: (job: BuildJob, to: BuildState) => Promise<void>, opts: { previewHosts?: string[] } = {}) {
  const job = await leased(db, b.jobId, b.leaseToken);
  const s = await getBuildSettings(db);
  await recordRunUsage(db, job, b.runCostUsd, b.turns, b.sessionId, b.provider, b.model);
  const outcome = String(b.outcome ?? "");
  const at = nowIso();
  const reportedPreview = okUrl(b.previewUrl);
  const previewHosts = opts.previewHosts ?? DEFAULT_PREVIEW_HOSTS;
  const previewRejected = reportedPreview && !previewUrlAllowed(reportedPreview, previewHosts) ? reportedPreview : null;
  const common = {
    lease_token_hash: null, lease_expires_at: null, lease_runner: null, finished_at: at,
    source_repo: okUrl(b.sourceRepo) ?? okRef(b.sourceRepo) ?? job.source_repo, source_branch: okRef(b.sourceBranch, 200) ?? job.source_branch,
    source_commit: okRef(b.sourceCommit, 64) ?? job.source_commit,
    // A build delivered to review shows only the preview this attempt deployed: an older URL (an earlier attempt or the
    // previous revision) would let the owner approve a site that is not the one under review.
    preview_url: outcome === "ready_for_review" ? (previewRejected ? null : reportedPreview) : (previewRejected ? null : reportedPreview) ?? job.preview_url,
    // The preview Worker's name, kept so the runner can delete it later (only for a preview that was recorded).
    preview_name: reportedPreview && !previewRejected ? okPreviewName(b.previewName) : outcome === "ready_for_review" ? null : job.preview_name,
    // Founder decision D3: only a preview the runner reports as deployed behind the private-preview gate is shareable.
    preview_gated: reportedPreview && !previewRejected ? (b.previewGated === true && okPreviewName(b.previewName) ? 1 : 0) : outcome === "ready_for_review" ? 0 : job.preview_gated,
    report_md: typeof b.report === "string" ? sanitize(b.report, 50_000) : job.report_md,
  };
  const err = typeof b.error === "string" ? sanitize(b.error, 2000) : null;
  let to: BuildState;
  let reason: string;
  let extra: Record<string, unknown> = {};
  // Quality engine: every reported scorecard is verified and stored; a quality-required build cannot be delivered
  // to internal approval without a verified, eligible (10/10) one. There is no exception per package.
  const quality = b.quality !== undefined && b.quality !== null ? await recordQuality(db, job, outcome, b.quality) : null;
  if (outcome === "ready_for_review" && job.quality_required && (!quality || !quality.eligible)) {
    to = "failed";
    reason = !quality ? "Quality engine: the build reported no quality scorecard; it cannot enter internal approval"
      : !quality.ok ? `Quality engine: the scorecard failed the platform's verification (${quality.problems.slice(0, 3).join("; ")})`
      : `Quality engine: ${quality.score}/10 within the approved scope; only a verified 10/10 can enter internal approval`;
    extra = { activity_state: null };
    await db.prepare(`UPDATE build_runs SET ended_at = ?, outcome = 'failed', error = ? WHERE job_id = ? AND attempt = ?`).bind(at, reason, job.id, job.attempts).run();
    const ok = await transition(db, job, to, reason, { kind: "runner" }, { ...common, preview_url: job.preview_url, preview_name: job.preview_name, preview_gated: job.preview_gated, ...extra });
    if (!ok) throw new LeaseLostError("lease_lost");
    await setStage(db, job.project_id, "FAILED_NEEDS_INTERVENTION", reason, "system");
    await audit(db, { actorKind: "system", action: "builds.quality_refused", subjectType: "build_job", subjectId: job.id, organizationId: job.organization_id, details: { score: quality?.score ?? null, verified: quality?.ok ?? false } });
    if (notify) await notify((await getJob(db, job.id))!, to);
    return { state: to };
  }
  if (outcome === "ready_for_review") { to = "ready_for_review"; reason = "Build finished: awaiting private internal approval (not visible to the customer)"; extra = { activity_state: null }; }
  else if (outcome === "needs_information") {
    to = "needs_information"; reason = "Blocked on information only the customer or owner can provide";
    extra = { missing_info_json: JSON.stringify((Array.isArray(b.missingInformation) ? b.missingInformation : []).slice(0, 30).map((x) => sanitize(x, 300))) };
  } else if (outcome === "stopped") {
    const sr = job.stop_reason;
    to = sr === "paused" ? "paused" : sr === "budget" || sr === "runtime" ? "budget_paused" : sr === "canceled" || sr === "ineligible" ? "canceled" : "failed";
    reason = sr === "budget" ? "Stopped at a spending limit; partial work preserved" : sr === "runtime" ? "Stopped at the runtime or turn limit; partial work preserved"
      : sr === "paused" ? "Paused by the owner; partial work preserved" : sr === "ineligible" ? "Stopped: the order is no longer eligible" : sr === "canceled" ? "Canceled by the owner" : `Runner stopped without a server request${err ? `: ${err}` : ""}`;
  } else if (outcome === "released") {
    // Runner shutdown: work is checkpointed; requeue without spending an attempt (protocol v1.1).
    to = job.cancel_requested_at ? "canceled" : "queued";
    // A runner may ask for the build back no earlier than a given time (≤ 8 days), e.g. while its model server recovers.
    const nb = typeof b.notBefore === "string" && !Number.isNaN(Date.parse(b.notBefore)) && Date.parse(b.notBefore) > Date.now() && Date.parse(b.notBefore) < Date.now() + 8 * 86400_000 ? new Date(b.notBefore).toISOString() : null;
    reason = job.cancel_requested_at ? "Canceled while the runner was shutting down" : nb ? `Released by the runner until ${nb.slice(0, 16).replace("T", " ")} UTC${err ? `: ${err}` : ""}; resumes from its checkpoint, no paid fallback` : `Runner released the build (shutdown)${err ? `: ${err}` : ""}; it resumes from its checkpoint`;
    extra = to === "queued" ? { attempts: Math.max(0, job.attempts - 1), finished_at: null, activity_state: null, ...(nb ? { not_before: nb } : {}) } : {};
  } else if (outcome === "failed") {
    if (job.attempts < job.max_attempts && !job.cancel_requested_at) {
      const backoffMin = Math.min(60, 2 ** job.attempts);
      to = "queued"; reason = `Attempt ${job.attempts} failed${err ? `: ${err}` : ""}; retrying in ${backoffMin} min`;
      extra = { not_before: new Date(Date.now() + backoffMin * 60000).toISOString(), finished_at: null };
    } else { to = "failed"; reason = `Failed after ${job.attempts} attempt(s)${err ? `: ${err}` : ""}`; }
  } else throw new HttpError(422, "Unknown outcome");
  await db.prepare(`UPDATE build_runs SET ended_at = ?, outcome = ?, error = ? WHERE job_id = ? AND attempt = ?`).bind(at, outcome, err, job.id, job.attempts).run();
  const ok = await transition(db, job, to, reason, { kind: "runner" }, { ...common, ...extra });
  if (!ok) throw new LeaseLostError("lease_lost");
  if (previewRejected) await event(db, job.id, "error", `Preview URL not recorded: its host is not an allowed preview host (${previewHosts.join(", ")})`, { kind: "system" }, { data: { url: previewRejected.slice(0, 300) } });
  if (common.preview_url && common.preview_url !== job.preview_url) await event(db, job.id, "preview", "Preview published", { kind: "runner" }, { data: { url: common.preview_url } });
  if (common.source_commit && common.source_commit !== job.source_commit) await event(db, job.id, "source", `Source at ${common.source_commit.slice(0, 12)}`, { kind: "runner" }, { data: { repo: common.source_repo, branch: common.source_branch } });
  void s;
  if (notify) await notify((await getJob(db, job.id))!, to);
  return { state: to };
}

// ── Scheduled sweep ──

export async function sweepBuilds(db: Db, now = new Date()): Promise<string> {
  const s = await getBuildSettings(db);
  const at = now.toISOString();
  let expired = 0, synced = 0;
  for (const j of (await db.prepare(`SELECT * FROM build_jobs WHERE state IN ('preparing','building','verifying') AND lease_expires_at < ?`).bind(at).all<BuildJob>()).results) {
    await db.prepare(`UPDATE build_runs SET ended_at = ?, outcome = 'lease_expired' WHERE job_id = ? AND attempt = ? AND ended_at IS NULL`).bind(at, j.id, j.attempts).run();
    const clear = { lease_token_hash: null, lease_expires_at: null, lease_runner: null };
    if (j.cancel_requested_at) await transition(db, j, "canceled", "Runner stopped responding after a stop request; partial work preserved", { kind: "system" }, { ...clear, finished_at: at });
    else if (j.attempts < j.max_attempts) await transition(db, j, "queued", `Runner lease expired (no heartbeat since ${j.heartbeat_at ?? "claim"}); will resume`, { kind: "system" }, clear);
    else await transition(db, j, "failed", `Runner lease expired on the final attempt (${j.attempts})`, { kind: "system" }, { ...clear, finished_at: at });
    expired++;
  }
  // Recover enqueues lost between recording a payment and enqueueing, and re-check eligibility of pending builds.
  const projects = (await db.prepare(`SELECT p.id FROM projects p LEFT JOIN build_project_controls c ON c.project_id = p.id
      WHERE p.status NOT IN ('cancelled','completed','maintenance') AND (p.created_at >= ? OR c.backfill_authorized_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM build_jobs j WHERE j.project_id = p.id AND j.state NOT IN ('awaiting_intake','awaiting_payment','queued'))
      LIMIT 200`).bind(s.auto_start_after).all<{ id: string }>()).results;
  for (const p of projects) { await syncProjectBuild(db, p.id, "sweep"); synced++; }
  for (const j of (await db.prepare(`SELECT DISTINCT project_id FROM build_jobs WHERE state IN ('needs_information','failed','budget_paused','paused','ready_for_review','preparing','building','verifying') LIMIT 200`).all<{ project_id: string }>()).results) {
    const d = decideEligibility(await projectFacts(db, j.project_id));
    if (d.verdict === "ineligible") {
      for (const job of (await db.prepare(`SELECT * FROM build_jobs WHERE project_id = ? AND state NOT IN ('canceled','approved')`).bind(j.project_id).all<BuildJob>()).results) await applyDecision(db, job, d, { kind: "system" });
    }
  }
  const ai = await sweepAiLeases(db, now);
  const previews = await sweepPreviewRetention(db, now);
  const releases = await sweepDeployments(db, now);
  await sweepWorkers(db, now);
  return `${expired} expired lease(s) handled, ${synced} project(s) re-evaluated, ${ai} AI draft lease(s) requeued, ${previews} preview(s) past retention, ${releases} stalled release(s) failed`;
}

/** Safe wrapper for hooks inside payment/intake/refund flows: never breaks the caller; the sweep recovers failures. */
export async function syncProjectBuildSafe(db: Db, projectId: string | null | undefined, trigger: "payment" | "intake" | "sweep"): Promise<void> {
  if (!projectId) return;
  try { await syncProjectBuild(db, projectId, trigger); }
  catch (e) { console.error(JSON.stringify({ level: "warn", msg: "build sync deferred to sweep", projectId, error: (e as Error).message })); }
}

// ── Owner actions ──

type OwnerCtx = Pick<AppContext, "db"> & { userId: string };

export async function updateBuildSettings(c: OwnerCtx, v: { automationEnabled: boolean; runBudgetUsd: number; projectBudgetUsd: number; maxRuntimeMinutes: number; maxTurns: number; maxConcurrent: number; maxAttempts: number; model: string; customerRevisionMode?: CustomerRevisionMode; previewRetentionDays?: number | null }) {
  if (v.previewRetentionDays !== undefined && !(Number.isInteger(v.previewRetentionDays) && v.previewRetentionDays! >= 1 && v.previewRetentionDays! <= 365)) throw new HttpError(422, "Preview retention must be 1–365 days (Founder decision: 30 days after final approval).");
  if (v.customerRevisionMode !== undefined && !(CUSTOMER_REVISION_MODES as readonly string[]).includes(v.customerRevisionMode)) throw new HttpError(422, "Choose how customer revision requests reach the AI builder.");
  if (!(v.runBudgetUsd > 0 && v.runBudgetUsd <= 1000)) throw new HttpError(422, "Per-run limit must be between $0.01 and $1,000.");
  if (!(v.projectBudgetUsd >= v.runBudgetUsd && v.projectBudgetUsd <= 10000)) throw new HttpError(422, "Per-project limit must be at least the per-run limit and at most $10,000.");
  if (!(Number.isInteger(v.maxRuntimeMinutes) && v.maxRuntimeMinutes >= 5 && v.maxRuntimeMinutes <= 1440)) throw new HttpError(422, "Runtime limit must be 5–1440 minutes.");
  if (!(Number.isInteger(v.maxTurns) && v.maxTurns >= 1 && v.maxTurns <= 5000)) throw new HttpError(422, "Turn limit must be 1–5000.");
  if (!(Number.isInteger(v.maxConcurrent) && v.maxConcurrent >= 0 && v.maxConcurrent <= 50)) throw new HttpError(422, "Concurrent builds must be 0–50.");
  if (!(Number.isInteger(v.maxAttempts) && v.maxAttempts >= 1 && v.maxAttempts <= 10)) throw new HttpError(422, "Attempts must be 1–10.");
  // Provider-neutral model identifiers: hosted names (vendor-model-version), Ollama tags (family:size) and namespaced ids (org/model).
  if (!/^[a-z0-9][a-z0-9._:/-]{2,80}$/i.test(v.model) || /\.\.|\/\//.test(v.model)) throw new HttpError(422, "Enter a model identifier, for example qwen3-coder:30b for a self-hosted model.");
  await c.db.prepare(`UPDATE build_settings SET automation_enabled = ?, run_budget_micro = ?, project_budget_micro = ?, max_runtime_minutes = ?, max_turns = ?, max_concurrent = ?, max_attempts = ?, model = ?,
      customer_revision_mode = COALESCE(?, customer_revision_mode), preview_retention_days = CASE WHEN ? = 1 THEN ? ELSE preview_retention_days END,
      updated_by = ?, updated_at = ? WHERE id = 1`)
    .bind(v.automationEnabled ? 1 : 0, usdToMicro(v.runBudgetUsd), usdToMicro(v.projectBudgetUsd), v.maxRuntimeMinutes, v.maxTurns, v.maxConcurrent, v.maxAttempts, v.model, v.customerRevisionMode ?? null,
      v.previewRetentionDays === undefined ? 0 : 1, v.previewRetentionDays ?? null, c.userId, nowIso()).run();
  await audit(c.db, { actorUserId: c.userId, action: "builds.settings_updated", subjectType: "build_settings", subjectId: "1", details: v });
}

export async function setGlobalPause(c: OwnerCtx, paused: boolean, reason: string) {
  if (paused && reason.trim().length < 3) throw new HttpError(422, "Give a reason for pausing.");
  await c.db.prepare(`UPDATE build_settings SET globally_paused = ?, pause_reason = ?, updated_by = ?, updated_at = ? WHERE id = 1`).bind(paused ? 1 : 0, paused ? reason.trim().slice(0, 300) : null, c.userId, nowIso()).run();
  await audit(c.db, { actorUserId: c.userId, action: paused ? "builds.paused_globally" : "builds.resumed_globally", subjectType: "build_settings", subjectId: "1", details: { reason: reason.trim() || undefined } });
  for (const j of (await c.db.prepare(`SELECT id FROM build_jobs WHERE state IN ('preparing','building','verifying')`).all<{ id: string }>()).results) {
    await event(c.db, j.id, "action", paused ? `Automation paused globally: ${reason.trim()}` : "Automation resumed globally", { kind: "user", userId: c.userId });
  }
}

export async function setProjectControls(c: OwnerCtx, projectId: string, v: { paused?: boolean; reason?: string; projectBudgetUsd?: number | null; backfill?: boolean }) {
  const p = await c.db.prepare(`SELECT id, organization_id FROM projects WHERE id = ?`).bind(projectId).first<{ id: string; organization_id: string }>();
  if (!p) throw new HttpError(404, "Project not found");
  if (v.paused && (v.reason ?? "").trim().length < 3) throw new HttpError(422, "Give a reason for pausing.");
  if (v.projectBudgetUsd != null && !(v.projectBudgetUsd > 0 && v.projectBudgetUsd <= 10000)) throw new HttpError(422, "Project limit must be between $0.01 and $10,000.");
  const at = nowIso();
  await c.db.prepare(`INSERT INTO build_project_controls (project_id, paused, pause_reason, project_budget_micro, backfill_authorized_by, backfill_authorized_at, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET paused = COALESCE(?, paused), pause_reason = CASE WHEN ? IS NULL THEN pause_reason WHEN ? = 1 THEN ? ELSE NULL END,
        project_budget_micro = CASE WHEN ? = 1 THEN ? ELSE project_budget_micro END,
        backfill_authorized_by = CASE WHEN ? = 1 THEN ? ELSE backfill_authorized_by END, backfill_authorized_at = CASE WHEN ? = 1 THEN ? ELSE backfill_authorized_at END,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(projectId, v.paused ? 1 : 0, v.paused ? v.reason!.trim() : null, v.projectBudgetUsd != null ? usdToMicro(v.projectBudgetUsd) : null, v.backfill ? c.userId : null, v.backfill ? at : null, c.userId, at,
      v.paused === undefined ? null : v.paused ? 1 : 0, v.paused === undefined ? null : 1, v.paused ? 1 : 0, v.paused ? v.reason!.trim() : null,
      v.projectBudgetUsd !== undefined ? 1 : 0, v.projectBudgetUsd != null ? usdToMicro(v.projectBudgetUsd) : null,
      v.backfill ? 1 : 0, c.userId, v.backfill ? 1 : 0, at).run();
  const action = v.backfill ? "builds.backfill_authorized" : v.paused !== undefined ? (v.paused ? "builds.project_paused" : "builds.project_resumed") : "builds.project_budget_set";
  await audit(c.db, { actorUserId: c.userId, action, subjectType: "project", subjectId: projectId, organizationId: p.organization_id, details: v });
  if (v.backfill) return syncProjectBuild(c.db, projectId, "backfill", { kind: "user", userId: c.userId });
  return null;
}

async function ownerJob(c: OwnerCtx, id: string): Promise<BuildJob> {
  const j = await getJob(c.db, id);
  if (!j) throw new HttpError(404, "Build not found");
  return j;
}
const userActor = (c: OwnerCtx): Actor => ({ kind: "user", userId: c.userId });

export async function cancelBuild(c: OwnerCtx, id: string, reason: string) {
  if (reason.trim().length < 3) throw new HttpError(422, "Give a reason for cancelling.");
  const j = await ownerJob(c, id);
  if (["canceled", "approved"].includes(j.state)) throw new HttpError(409, `A ${BUILD_STATE_LABELS[j.state].toLowerCase()} build cannot be cancelled.`);
  if ((ACTIVE_STATES as readonly string[]).includes(j.state)) {
    await c.db.prepare(`UPDATE build_jobs SET cancel_requested_at = ?, cancel_requested_by = ?, stop_reason = 'canceled', updated_at = ? WHERE id = ?`).bind(nowIso(), c.userId, nowIso(), id).run();
    await event(c.db, id, "action", `Cancel requested: ${reason.trim()} — the runner stops at its next heartbeat and preserves partial work`, userActor(c));
  } else {
    await transition(c.db, j, "canceled", `Canceled by owner: ${reason.trim()}`, userActor(c), { finished_at: nowIso(), cancel_requested_by: c.userId, cancel_requested_at: nowIso() });
  }
  await audit(c.db, { actorUserId: c.userId, action: "builds.canceled", subjectType: "build_job", subjectId: id, organizationId: j.organization_id, details: { from: j.state, reason: reason.trim() } });
}

async function requireEligible(db: Db, projectId: string) {
  const d = decideEligibility(await projectFacts(db, projectId));
  if (d.verdict !== "queued") throw new HttpError(409, `This project is not eligible for an automated build: ${d.reasons.join("; ")}`);
}
async function requireBudget(db: Db, projectId: string) {
  const s = await getBuildSettings(db);
  const budget = await projectBudgetMicro(db, projectId, s);
  const spent = await projectSpendMicro(db, projectId);
  if (spent >= budget) throw new HttpError(409, `The project's build budget is used ($${microToUsd(spent).toFixed(2)} of $${microToUsd(budget).toFixed(2)}). Raise the project limit first.`);
}

/** Retry a failed build (new attempts) or resume a paused / budget-paused / needs-information one from its saved session. */
export async function retryBuild(c: OwnerCtx, id: string, mode: "retry" | "resume") {
  const j = await ownerJob(c, id);
  const allowed = mode === "retry" ? ["failed"] : ["paused", "budget_paused", "needs_information", "failed"];
  if (!allowed.includes(j.state)) throw new HttpError(409, `Only ${allowed.join(", ").replace(/_/g, " ")} builds can be ${mode === "retry" ? "retried" : "resumed"}.`);
  if (mode === "resume" && !j.agent_session_id && !j.source_commit) throw new HttpError(409, "No saved session or source to resume from; use Retry.");
  await requireEligible(c.db, j.project_id);
  await requireBudget(c.db, j.project_id);
  const s = await getBuildSettings(c.db);
  try {
    await transition(c.db, j, "queued", mode === "retry" ? "Retry requested by owner" : "Resume requested by owner (continues the saved session)", userActor(c),
      { max_attempts: j.attempts + s.max_attempts, not_before: null, stop_reason: null, cancel_requested_at: null, finished_at: null });
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) throw new HttpError(409, "Another build for this project is already queued or running.");
    throw e;
  }
  await audit(c.db, { actorUserId: c.userId, action: `builds.${mode}`, subjectType: "build_job", subjectId: id, organizationId: j.organization_id });
}

/**
 * The build a new revision starts from: the newest build that did not fail and was not canceled (a failed or canceled
 * revision is skipped, so its partial source is never the base and it does not block later revisions). It must have
 * reached owner review. `nextRevision` is the next unused revision number (failed/canceled ones keep theirs).
 */
async function revisableBuild(db: Db, projectId: string): Promise<{ prev: BuildJob; nextRevision: number }> {
  const prev = await db.prepare(`SELECT * FROM build_jobs WHERE project_id = ? AND state NOT IN ('failed','canceled') ORDER BY revision DESC, created_at DESC LIMIT 1`).bind(projectId).first<BuildJob>();
  if (!prev) throw new HttpError(409, "This project has no build to revise yet.");
  if (!["ready_for_review", "approved", "needs_information"].includes(prev.state)) throw new HttpError(409, `The latest build is ${BUILD_STATE_LABELS[prev.state].toLowerCase()}; revise after it reaches owner review.`);
  const max = await db.prepare(`SELECT MAX(revision) AS m FROM build_jobs WHERE project_id = ?`).bind(projectId).first<{ m: number | null }>();
  return { prev, nextRevision: (max?.m ?? prev.revision) + 1 };
}

/**
 * One path for every AI revision (owner-written or a customer's request): same eligibility, budget, brief snapshot,
 * source continuation and duplicate protection. Returns the new build id.
 */
async function queueRevisionJob(db: Db, projectId: string, instruction: string, actor: Actor, customerRevision: { id: string; round: number } | null): Promise<string> {
  const text = instruction.trim();
  if (text.length < 10 || text.length > 5000) throw new HttpError(422, "Write the revision instruction (10–5000 characters).");
  const { prev, nextRevision } = await revisableBuild(db, projectId);
  await requireEligible(db, projectId);
  await requireBudget(db, projectId);
  const s = await getBuildSettings(db);
  const brief = await snapshotBrief(db, projectId);
  const id = newId("bld");
  const rev = nextRevision;
  const at = nowIso();
  const reason = customerRevision ? `Customer revision round ${customerRevision.round} queued` : "Revision submitted by owner";
  try {
    await db.prepare(`INSERT INTO build_jobs (id, project_id, organization_id, order_id, kind, revision, dedupe_key, state, state_reason, strategy, package_id, brief_id, instruction, trigger, created_by, max_attempts,
        agent_session_id, workspace_ref, checkpoint_key, source_repo, source_branch, source_commit, customer_revision_id, created_at, updated_at)
        VALUES (?,?,?,?, 'revision', ?, ?, 'queued', ?, ?, ?, ?, ?, 'revision', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, projectId, prev.organization_id, prev.order_id, rev, `${projectId}:r${rev}`, reason, prev.strategy, prev.package_id, brief.id, text, actor.userId ?? null, s.max_attempts,
        // The revision starts from the previous source; its preview stays empty until the revision deploys its own
        // (the previous build keeps its preview URL in its own record).
        prev.agent_session_id, prev.workspace_ref, prev.checkpoint_key, prev.source_repo, prev.source_branch, prev.source_commit, customerRevision?.id ?? null, at, at).run();
  } catch (e) {
    const m = (e as Error).message;
    if (/UNIQUE/i.test(m) && /customer_revision/i.test(m)) throw new HttpError(409, "This customer revision already has an AI build in progress.");
    if (/UNIQUE/i.test(m)) throw new HttpError(409, "A revision is already queued or running for this project.");
    throw e;
  }
  await event(db, id, "transition", customerRevision ? `Revision ${rev} queued for customer revision round ${customerRevision.round}` : `Revision ${rev} queued by owner`, actor,
    { to: "queued", data: { previous: prev.id, customerRevisionId: customerRevision?.id ?? null } });
  return id;
}

export async function submitRevision(c: OwnerCtx, projectId: string, instruction: string) {
  const id = await queueRevisionJob(c.db, projectId, instruction, userActor(c), null);
  const j = (await getJob(c.db, id))!;
  await audit(c.db, { actorUserId: c.userId, action: "builds.revision_submitted", subjectType: "build_job", subjectId: id, organizationId: j.organization_id, details: { revision: j.revision } });
  return id;
}

// ── Customer revision requests (portal) → AI revisions ──

export interface CustomerRevision {
  id: string; projectId: string; organizationId: string; projectName: string; organizationName: string; round: number; text: string; status: string;
  createdAt: string; included: boolean; changeOrderStatus: string | null;
  /** Whether the existing entitlement rules allow work on this round (included, or its change order approved/paid). */
  entitled: boolean;
  /** The live AI build for this request, if any (failed/canceled ones may be replaced). */
  liveJob: { id: string; state: BuildState; previewUrl: string | null } | null;
  /** The most recent AI build for this request (any state), for history and preview association. */
  latestJob: { id: string; state: BuildState; previewUrl: string | null } | null;
  /** Owner decision (Founder decision D1): null = awaiting the owner's review. */
  decision: "approved" | "rejected" | null; decidedAt: string | null; decisionNote: string | null;
  /** The project's current reviewable build (what the owner compares the request against). */
  currentBuild: { id: string; state: BuildState } | null;
}

/** Mirrors updateRevisionStatus in services/projects.ts: a beyond-allowance round needs an approved/paid change order. */
export function revisionEntitled(included: boolean, changeOrderStatus: string | null): boolean {
  return included || (!!changeOrderStatus && ["approved", "paid", "completed"].includes(changeOrderStatus));
}

const CUSTOMER_REVISION_SQL = `SELECT r.id, r.project_id, r.round, r.request_text, r.status, r.created_at, r.included, c.status AS co_status,
    r.ai_decision, r.ai_decided_at, r.ai_decision_note,
    p.organization_id, p.name AS project_name, o.name AS org_name
  FROM revisions r JOIN projects p ON p.id = r.project_id JOIN organizations o ON o.id = p.organization_id
  LEFT JOIN change_orders c ON c.id = r.billable_change_order_id`;
type CustomerRevisionRow = { id: string; project_id: string; round: number; request_text: string; status: string; created_at: string; included: number; co_status: string | null; organization_id: string; project_name: string; org_name: string;
  ai_decision: "approved" | "rejected" | null; ai_decided_at: string | null; ai_decision_note: string | null };

async function toCustomerRevision(db: Db, r: CustomerRevisionRow): Promise<CustomerRevision> {
  const jobs = (await db.prepare(`SELECT id, state, preview_url FROM build_jobs WHERE customer_revision_id = ? ORDER BY created_at DESC`).bind(r.id).all<{ id: string; state: BuildState; preview_url: string | null }>()).results;
  const live = jobs.find((j) => !["failed", "canceled"].includes(j.state));
  const view = (j: { id: string; state: BuildState; preview_url: string | null } | undefined) => j ? { id: j.id, state: j.state, previewUrl: j.preview_url } : null;
  return {
    id: r.id, projectId: r.project_id, organizationId: r.organization_id, projectName: r.project_name, organizationName: r.org_name, round: r.round, text: r.request_text,
    status: r.status, createdAt: r.created_at, included: !!r.included, changeOrderStatus: r.co_status, entitled: revisionEntitled(!!r.included, r.co_status),
    liveJob: view(live), latestJob: view(jobs[0]),
    decision: r.ai_decision, decidedAt: r.ai_decided_at, decisionNote: r.ai_decision_note,
    currentBuild: await db.prepare(`SELECT id, state FROM build_jobs WHERE project_id = ? AND state NOT IN ('failed','canceled') ORDER BY revision DESC, created_at DESC LIMIT 1`)
      .bind(r.project_id).first<{ id: string; state: BuildState }>() ?? null,
  };
}

export async function getCustomerRevision(db: Db, revisionId: string): Promise<CustomerRevision | null> {
  const r = await db.prepare(`${CUSTOMER_REVISION_SQL} WHERE r.id = ?`).bind(revisionId).first<CustomerRevisionRow>();
  return r ? toCustomerRevision(db, r) : null;
}

/** Open customer requests (submitted / in progress, not rejected) for the owner's AI builds queue. */
export async function customerRevisionQueue(db: Db, limit = 50): Promise<CustomerRevision[]> {
  const rows = (await db.prepare(`${CUSTOMER_REVISION_SQL} WHERE r.status IN ('submitted','in_progress') AND COALESCE(r.ai_decision, '') <> 'rejected' ORDER BY r.created_at LIMIT ?`).bind(limit).all<CustomerRevisionRow>()).results;
  return Promise.all(rows.map((r) => toCustomerRevision(db, r)));
}

/**
 * Queue an AI revision for a customer's revision request. Owner path (mode owner_approval or auto; the owner may edit
 * the instruction) and the automatic path (mode auto) share every check: the request is open and entitled under the
 * existing rules, the project is eligible and within budget, its latest build reached owner review, and no live AI
 * build exists for the same request. The customer's text is untrusted data (REVISION-REQUEST.md, rules first).
 */
export async function forwardCustomerRevision(db: Db, revisionId: string, actor: Actor, opts: { instruction?: string; mail?: MailCtx } = {}): Promise<string> {
  const s = await getBuildSettings(db);
  if (s.customer_revision_mode === "off") throw new HttpError(409, "Customer revisions are not sent to the AI builder (Owner → AI builds → Customer revisions: off).");
  const r = await getCustomerRevision(db, revisionId);
  if (!r) throw new HttpError(404, "Revision request not found");
  if (r.decision === "rejected") throw new HttpError(409, "This revision request was rejected; it cannot start an AI build.");
  if (!["submitted", "in_progress"].includes(r.status)) throw new HttpError(409, `This revision request is ${r.status.replace(/_/g, " ")}; only open requests can be sent to the AI builder.`);
  if (!r.entitled) throw new HttpError(409, "This round is beyond the included revisions; its change order must be approved before any work starts.");
  const triage = await db.prepare(`SELECT customer_kind, category_at FROM revisions WHERE id = ?`).bind(revisionId).first<{ customer_kind: string; category_at: string | null }>();
  if (triage?.customer_kind === "problem" && !triage.category_at) throw new HttpError(409, "Classify this problem report first (project → Revisions); no AI build starts before triage.");
  if (r.liveJob) throw new HttpError(409, "This customer revision already has an AI build in progress.");
  const instruction = (opts.instruction ?? "").trim() || r.text.trim();
  if (instruction.length > 5000) throw new HttpError(422, "The customer's request is longer than 5,000 characters; edit it into an instruction before sending it to the AI builder.");
  const id = await queueRevisionJob(db, r.projectId, instruction, actor, { id: r.id, round: r.round });
  // The owner's approval (D1) is recorded once; work has started (the customer's page shows "in progress").
  const firstApproval = r.decision !== "approved";
  await db.prepare(`UPDATE revisions SET status = CASE WHEN status = 'submitted' THEN 'in_progress' ELSE status END,
      ai_decision = 'approved', ai_decided_by = COALESCE(ai_decided_by, ?), ai_decided_at = COALESCE(ai_decided_at, ?) WHERE id = ?`).bind(actor.userId ?? null, nowIso(), r.id).run();
  if (firstApproval && opts.mail) {
    await notifyCustomer(opts.mail, r.projectId, { kind: "revision", mail: { template: "revision_update", data: { event: "accepted", round: r.round } }, path: `/portal/projects/${r.projectId}/revisions`, key: `revacc:${r.id}` });
  }
  await audit(db, { actorUserId: actor.userId ?? null, actorKind: actor.kind === "user" ? "user" : "system", action: "builds.customer_revision_forwarded", subjectType: "build_job", subjectId: id,
    organizationId: r.organizationId, details: { revisionId: r.id, round: r.round, edited: !!(opts.instruction ?? "").trim(), mode: s.customer_revision_mode } });
  return id;
}

/**
 * Founder decision D1: the owner rejects a customer revision request. No AI build starts, the request is closed for
 * staff work, it does not use an included round, and the customer is told why.
 */
export async function rejectCustomerRevision(c: OwnerCtx & { mail?: MailCtx }, revisionId: string, reason: string) {
  const why = reason.trim();
  if (why.length < 3 || why.length > 1000) throw new HttpError(422, "Give the customer a reason (3–1000 characters).");
  const r = await getCustomerRevision(c.db, revisionId);
  if (!r) throw new HttpError(404, "Revision request not found");
  if (r.decision === "rejected") throw new HttpError(409, "This revision request was already rejected.");
  if (r.liveJob) throw new HttpError(409, "An AI build is working on this request; cancel it first.");
  if (r.status !== "submitted") throw new HttpError(409, `This revision request is ${r.status.replace(/_/g, " ")}; only a request awaiting review can be rejected.`);
  const res = await c.db.prepare(`UPDATE revisions SET ai_decision = 'rejected', ai_decided_by = ?, ai_decided_at = ?, ai_decision_note = ? WHERE id = ? AND status = 'submitted' AND ai_decision IS NULL`)
    .bind(c.userId, nowIso(), why, r.id).run();
  if (!res.meta?.changes) throw new HttpError(409, "This revision request changed meanwhile; reload and try again.");
  await audit(c.db, { actorUserId: c.userId, action: "builds.customer_revision_rejected", subjectType: "project", subjectId: r.projectId, organizationId: r.organizationId, details: { revisionId: r.id, round: r.round, reason: why } });
  if (c.mail) await notifyCustomer(c.mail, r.projectId, { kind: "revision", mail: { template: "revision_update", data: { event: "declined", round: r.round, reason: why } }, path: `/portal/projects/${r.projectId}/revisions`, key: `revdec:${r.id}` });
}

/** Mode `auto`: queue an entitled customer request when everything allows it; otherwise leave it for the owner. Never throws. */
export async function syncCustomerRevisionSafe(db: Db, revisionId: string): Promise<string | null> {
  try {
    const s = await getBuildSettings(db);
    if (s.customer_revision_mode !== "auto" || s.globally_paused || !s.automation_enabled) return null;
    const r = await getCustomerRevision(db, revisionId);
    const triage = await db.prepare(`SELECT customer_kind, category, category_at FROM revisions WHERE id = ?`).bind(revisionId).first<{ customer_kind: string; category: string; category_at: string | null }>();
    // A customer's problem report waits for staff triage; a scope change waits for its change order (entitled below).
    if (!triage || (triage.customer_kind === "problem" && !triage.category_at)) return null;
    if (!r || !r.entitled || r.liveJob || r.decision === "rejected" || !["submitted", "in_progress"].includes(r.status) || r.text.trim().length > 5000) return null;
    if ((await projectControls(db, r.projectId))?.paused) return null;
    return await forwardCustomerRevision(db, revisionId, { kind: "system" });
  } catch (e) {
    console.error(JSON.stringify({ level: "warn", msg: "customer revision not queued automatically; it waits for the owner", revisionId, error: (e as Error).message }));
    return null;
  }
}

export async function approveBuild(c: OwnerCtx, id: string, notes: string) {
  const j = await ownerJob(c, id);
  if (j.state !== "ready_for_review") throw new HttpError(409, "Only a build in owner review can be approved.");
  if (!j.preview_url) throw new HttpError(409, "This build has no preview to approve.");
  if (j.preview_deleted_at || j.preview_delete_requested_at) throw new HttpError(409, "This build's preview was deleted (or is being deleted); it cannot be approved.");
  if (!j.internal_approved_at) throw new HttpError(409, "Approve the build internally first (private Crestmont review), then give the final approval.");
  await transition(c.db, j, "approved", `Preview approved by owner for the delivery process${notes.trim() ? `: ${notes.trim()}` : ""}`, userActor(c), { approved_by: c.userId, approved_at: nowIso() });
  await audit(c.db, { actorUserId: c.userId, action: "builds.preview_approved", subjectType: "build_job", subjectId: id, organizationId: j.organization_id, details: { preview: j.preview_url, commit: j.source_commit, customerRevisionId: j.customer_revision_id } });
  if (j.customer_revision_id) {
    // Approval records the owner's decision only. Delivering the round to the customer stays a staff step
    // (project → Revisions → mark delivered), which notifies the customer and asks for their approval.
    await event(c.db, id, "action", "AI result approved for this customer revision; deliver it to the customer from the project's Revisions tab", userActor(c), { data: { customerRevisionId: j.customer_revision_id } });
  }
}

// ── Preview lifecycle: deletion on owner request or after the retention period (performed by the runner) ──

// ── Preview retention (Founder decision D2): 30 days after the owner approves the final preview ──

export type PreviewRetentionStatus =
  | "none" | "deleted" | "deletion_pending" | "preserved" | "in_progress" | "awaiting_approval"
  | "approved_kept" | "scheduled" | "kept_unrecoverable";

export interface PreviewRetention {
  status: PreviewRetentionStatus;
  /** When the scheduled cleanup deletes the preview (status "scheduled"), else null. */
  deleteAfter: string | null;
  note: string;
}

const RETENTION_TEXT: Record<PreviewRetentionStatus, string> = {
  none: "No preview",
  deleted: "Deleted",
  deletion_pending: "Deletion requested; the runner deletes it when idle",
  preserved: "Preserved by the owner (never deleted automatically)",
  in_progress: "Kept: the build is in progress or awaiting owner review",
  awaiting_approval: "Kept until the owner approves a final preview for this project",
  approved_kept: "Approved preview: kept until its production deployment is verified",
  scheduled: "Scheduled for deletion",
  kept_unrecoverable: "Kept: this is the only recoverable copy of the site (no project repository or checkpoint)",
};

/** A build's site can be rebuilt without its preview only when its source exists outside the runner's workspace. */
function sourceRecoverable(j: Pick<BuildJob, "source_commit" | "source_repo" | "checkpoint_key">): boolean {
  return !!j.source_commit && (/^https:\/\//.test(j.source_repo ?? "") || !!j.checkpoint_key);
}

/**
 * The retention decision for every preview of a project. Never automatic for a build still in progress or awaiting
 * owner review; the approved build's preview is kept until its production deployment is verified live; superseded
 * previews (older builds, and builds that failed or were canceled) are deleted `preview_retention_days` (30) after the
 * owner's approval — later if the owner extended them, never if preserved or if the preview is the only recoverable
 * copy of the site.
 */
export async function previewRetentionPlan(db: Db, projectId: string, now = new Date()): Promise<Map<string, PreviewRetention>> {
  const s = await getBuildSettings(db);
  const days = s.preview_retention_days ?? 30;
  const jobs = (await db.prepare(`SELECT * FROM build_jobs WHERE project_id = ? ORDER BY created_at`).bind(projectId).all<BuildJob>()).results;
  const approved = jobs.filter((x) => x.state === "approved" && x.approved_at).sort((a, b) => (a.approved_at! < b.approved_at! ? 1 : -1))[0] ?? null;
  const handoff = approved ? await db.prepare(`SELECT verified_at FROM site_deployments WHERE build_job_id = ? AND state IN ('live','superseded') AND verified_at IS NOT NULL ORDER BY verified_at LIMIT 1`)
    .bind(approved.id).first<{ verified_at: string }>() : null;
  const plus = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86400_000).toISOString();
  const out = new Map<string, PreviewRetention>();
  const put = (id: string, status: PreviewRetentionStatus, deleteAfter: string | null = null) => out.set(id, { status, deleteAfter, note: RETENTION_TEXT[status] });
  for (const j of jobs) {
    if (!j.preview_url && !j.preview_name) { put(j.id, "none"); continue; }
    if (j.preview_deleted_at) { put(j.id, "deleted"); continue; }
    if (j.preview_delete_requested_at) { put(j.id, "deletion_pending", j.preview_delete_requested_at); continue; }
    if (j.preview_preserved) { put(j.id, "preserved"); continue; }
    const stopped = ["approved", "failed", "canceled"].includes(j.state);
    // No final approval yet: nothing expires (active builds and previews awaiting owner review are never automatic).
    if (!approved) { put(j.id, stopped ? "awaiting_approval" : "in_progress"); continue; }
    let base: string;
    if (j.id === approved.id) {
      if (!handoff) { put(j.id, "approved_kept"); continue; }
      base = handoff.verified_at;
    } else if (j.created_at < approved.created_at) {
      base = approved.approved_at!; // superseded by the approved build, whatever state it was left in
    } else if (stopped) {
      base = j.finished_at ?? j.updated_at; // a later attempt that failed or was canceled
    } else { put(j.id, "in_progress"); continue; } // newer work in progress or awaiting review
    if (!sourceRecoverable(j)) { put(j.id, "kept_unrecoverable"); continue; }
    let due = plus(base, days);
    if (j.preview_retain_until && j.preview_retain_until > due) due = j.preview_retain_until;
    put(j.id, "scheduled", due);
  }
  void now;
  return out;
}

export async function previewRetentionFor(db: Db, j: BuildJob, now = new Date()): Promise<PreviewRetention> {
  return (await previewRetentionPlan(db, j.project_id, now)).get(j.id) ?? { status: "none", deleteAfter: null, note: RETENTION_TEXT.none };
}

/** Scheduled cleanup (15-minute sweep): previews past their date become deletion requests, each audited. */
export async function sweepPreviewRetention(db: Db, now = new Date()): Promise<number> {
  const at = now.toISOString();
  const projects = (await db.prepare(`SELECT DISTINCT project_id FROM build_jobs WHERE preview_name IS NOT NULL AND preview_deleted_at IS NULL AND preview_delete_requested_at IS NULL AND preview_preserved = 0 LIMIT 200`)
    .all<{ project_id: string }>()).results;
  let n = 0;
  for (const p of projects) {
    for (const [id, r] of await previewRetentionPlan(db, p.project_id, now)) {
      if (r.status !== "scheduled" || !r.deleteAfter || r.deleteAfter > at) continue;
      const job = (await getJob(db, id))!;
      if (!job.preview_name) continue; // a preview without a recorded Worker name cannot be deleted by the runner
      const res = await db.prepare(`UPDATE build_jobs SET preview_delete_requested_at = ?, preview_delete_reason = 'retention', updated_at = ? WHERE id = ? AND preview_delete_requested_at IS NULL AND preview_deleted_at IS NULL AND preview_preserved = 0`)
        .bind(at, at, id).run();
      if (!res.meta?.changes) continue;
      await event(db, id, "preview", `Preview retention ended (${r.deleteAfter.slice(0, 10)}); deletion requested`, { kind: "system" }, { data: { name: job.preview_name } });
      await audit(db, { actorKind: "system", action: "builds.preview_expired", subjectType: "build_job", subjectId: id, organizationId: job.organization_id, details: { name: job.preview_name, deleteAfter: r.deleteAfter } });
      n++;
    }
  }
  return n;
}

/** Owner action: delete this build's preview Worker. The runner (which holds the preview credential) does it. */
export async function requestPreviewDeletion(c: OwnerCtx, id: string) {
  const j = await ownerJob(c, id);
  if (!j.preview_name || j.preview_deleted_at) throw new HttpError(409, "This build has no preview to delete.");
  if (["preparing", "building", "verifying"].includes(j.state)) throw new HttpError(409, "Wait until the build stops before deleting its preview.");
  const r = await previewRetentionFor(c.db, j);
  if (r.status === "approved_kept") throw new HttpError(409, "This is the approved preview; it is kept until its production deployment is verified.");
  if (!sourceRecoverable(j)) throw new HttpError(409, "This preview is the only recoverable copy of the site (no project repository or checkpoint); it cannot be deleted.");
  await c.db.prepare(`UPDATE build_jobs SET preview_delete_requested_at = COALESCE(preview_delete_requested_at, ?), preview_delete_reason = COALESCE(preview_delete_reason, 'owner'), updated_at = ? WHERE id = ?`).bind(nowIso(), nowIso(), id).run();
  await event(c.db, id, "preview", "Preview deletion requested by owner; the runner deletes it when idle", userActor(c), { data: { name: j.preview_name } });
  await audit(c.db, { actorUserId: c.userId, action: "builds.preview_delete_requested", subjectType: "build_job", subjectId: id, organizationId: j.organization_id, details: { name: j.preview_name } });
}

/** Owner: preserve a preview (never deleted automatically), release it, or extend its retention by 30 days. */
export async function setPreviewRetention(c: OwnerCtx, id: string, action: string) {
  const j = await ownerJob(c, id);
  if (!j.preview_name && !j.preview_url) throw new HttpError(409, "This build has no preview.");
  if (j.preview_deleted_at) throw new HttpError(409, "This preview was already deleted.");
  if (!["preserve", "release", "extend"].includes(action)) throw new HttpError(422, "Choose preserve, release or extend.");
  if (j.preview_delete_claimed_at) throw new HttpError(409, "The runner is deleting this preview right now; try again in a few minutes.");
  const now = nowIso();
  let detail: Record<string, unknown> = { action };
  if (action === "preserve") {
    await c.db.prepare(`UPDATE build_jobs SET preview_preserved = 1, preview_delete_requested_at = CASE WHEN preview_delete_reason = 'retention' THEN NULL ELSE preview_delete_requested_at END,
        preview_delete_reason = CASE WHEN preview_delete_reason = 'retention' THEN NULL ELSE preview_delete_reason END, updated_at = ? WHERE id = ?`).bind(now, id).run();
  } else if (action === "release") {
    await c.db.prepare(`UPDATE build_jobs SET preview_preserved = 0, updated_at = ? WHERE id = ?`).bind(now, id).run();
  } else {
    const current = await previewRetentionFor(c.db, j);
    const from = current.deleteAfter && current.deleteAfter > now ? current.deleteAfter : now;
    const until = new Date(Date.parse(from) + 30 * 86400_000).toISOString();
    await c.db.prepare(`UPDATE build_jobs SET preview_retain_until = ?, preview_delete_requested_at = CASE WHEN preview_delete_reason = 'retention' THEN NULL ELSE preview_delete_requested_at END,
        preview_delete_reason = CASE WHEN preview_delete_reason = 'retention' THEN NULL ELSE preview_delete_reason END, updated_at = ? WHERE id = ?`).bind(until, now, id).run();
    detail = { action, until };
  }
  await event(c.db, id, "preview", action === "preserve" ? "Preview preserved by owner" : action === "release" ? "Preview no longer preserved; normal retention applies" : `Preview retention extended to ${String(detail.until).slice(0, 10)}`, userActor(c));
  await audit(c.db, { actorUserId: c.userId, action: "builds.preview_retention_changed", subjectType: "build_job", subjectId: id, organizationId: j.organization_id, details: detail });
}

/**
 * Previews the runner should delete now: requested by the owner or by the retention sweep (never decided here).
 * Each is handed out once per hour until the runner reports back, so a failed deletion is retried safely.
 */
// ── Private previews (Founder decision D3) ──
// Previews are deployed behind the runner's gate; the only way in is a 5-minute sign-in link signed here after the
// platform has checked who is asking. Staff with builds.read can open any preview; a customer only a gated, shared,
// undeleted preview of their own organization's project.

export type PreviewAccess = { gated: boolean; available: boolean; reason: string | null };

export function previewAccess(j: Pick<BuildJob, "preview_url" | "preview_name" | "preview_deleted_at" | "preview_gated">, secret: string | undefined): PreviewAccess {
  if (!j.preview_url || !j.preview_name) return { gated: false, available: false, reason: "This build has no preview." };
  if (j.preview_deleted_at) return { gated: !!j.preview_gated, available: false, reason: "This preview was deleted." };
  if (!j.preview_gated) return { gated: false, available: true, reason: "Deployed before private previews: it is public. Delete it or run a new build." };
  if (!secret || secret.length < 32) return { gated: true, available: false, reason: "BUILD_PREVIEW_GATE_SECRET is not configured on the platform, so no sign-in link can be issued." };
  return { gated: true, available: true, reason: null };
}

/** Staff: a sign-in link for a build's preview (audited). An ungated legacy preview is opened directly. */
export async function staffPreviewLink(c: OwnerCtx, secret: string | undefined, id: string, next?: string): Promise<string> {
  const j = await ownerJob(c, id);
  const a = previewAccess(j, secret);
  if (!a.available) throw new HttpError(409, a.reason ?? "Preview unavailable.");
  await audit(c.db, { actorUserId: c.userId, action: "builds.preview_opened", subjectType: "build_job", subjectId: j.id, organizationId: j.organization_id, details: { name: j.preview_name, gated: a.gated } });
  return a.gated ? previewSignInUrl(secret!, j.preview_name!, j.preview_url!, { next: safePreviewPath(next), audience: "owner" }) : j.preview_url!;
}

/**
 * Staff: the private Crestmont review (V4 §7 F). A finished build waits in AWAITING_INTERNAL_APPROVAL, invisible to the
 * customer, until a staff member with builds.configure approves it here (MFA step-up on the route). The automated
 * acceptance verdict is shown but never decides: approving a build that did not pass it needs a written reason.
 * Approval does not share anything; sharing the preview with the customer is a separate, explicit action.
 */
export async function internalApprove(c: OwnerCtx, id: string, note: string) {
  const j = await ownerJob(c, id);
  // Builds approved before the internal review existed can be recorded too, so their previews can still be shared.
  if (j.state !== "ready_for_review" && j.state !== "approved") throw new HttpError(409, "Only a finished build that is awaiting internal approval can be approved internally.");
  if (j.internal_approved_at) throw new HttpError(409, "This build is already approved internally.");
  await assertQualityForApproval(c.db, { id: j.id, quality_required: j.quality_required ?? 0 });
  if (!j.preview_url || j.preview_deleted_at || j.preview_delete_requested_at) throw new HttpError(409, "Review the preview first: this build has no preview that still exists.");
  const text = note.trim().slice(0, 1000);
  if (j.ai_acceptance !== "passed" && j.ai_acceptance !== "passed_pending_integrations" && text.length < 10) {
    throw new HttpError(422, "This build did not pass the automated acceptance review. Explain in the note (at least 10 characters) why it may go ahead.");
  }
  const r = await c.db.prepare(`UPDATE build_jobs SET internal_approved_at = ?, internal_approved_by = ?, internal_approval_note = ?, updated_at = ? WHERE id = ? AND internal_approved_at IS NULL AND state IN ('ready_for_review','approved')`)
    .bind(nowIso(), c.userId, text || null, nowIso(), id).run();
  if (!r.meta?.changes) throw new HttpError(409, "The build changed meanwhile; reload and try again.");
  await event(c.db, id, "action", `Approved in the private Crestmont review${j.ai_acceptance !== "passed" ? ` (automated acceptance: ${j.ai_acceptance ?? "not run"}; override noted)` : ""}`, userActor(c), { data: { note: text || null } });
  await audit(c.db, { actorUserId: c.userId, action: "builds.internal_approved", subjectType: "build_job", subjectId: id, organizationId: j.organization_id, details: { aiAcceptance: j.ai_acceptance, override: j.ai_acceptance !== "passed" && j.ai_acceptance !== "passed_pending_integrations" } });
  if (j.state === "ready_for_review") await setStage(c.db, j.project_id, "READY_FOR_CUSTOMER_PREVIEW", "Approved internally; not shared with the customer yet", "user");
}

/** Owner: share (or stop sharing) a gated preview with the project's customer, who can then open and review it. */
export async function sharePreview(c: OwnerCtx & { mail?: MailCtx }, id: string, share: boolean) {
  const j = await ownerJob(c, id);
  if (!share) {
    if (!j.customer_preview_shared_at) throw new HttpError(409, "This preview is not shared.");
    await c.db.prepare(`UPDATE build_jobs SET customer_preview_shared_at = NULL, customer_preview_shared_by = NULL, updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
    if (j.state === "ready_for_review") await setStage(c.db, j.project_id, "READY_FOR_CUSTOMER_PREVIEW", "Preview no longer shared with the customer", "user");
  } else {
    if (!j.preview_gated || !j.preview_name || !j.preview_url || j.preview_deleted_at) throw new HttpError(409, "Only a private (gated) preview that still exists can be shared with the customer.");
    if (!["ready_for_review", "approved"].includes(j.state)) throw new HttpError(409, "Share a preview once the build is in owner review or approved.");
    if (await projectPaidBySimulation(c.db, j.project_id)) throw new HttpError(409, "This project was paid by a SIMULATED payment (internal test). Its website is never shown to a customer.");
    // V4 §7 F/G: the customer sees a website only after a staff member approved it in the private review.
    if (!j.internal_approved_at) throw new HttpError(409, "Approve this build internally first (private Crestmont review). The customer cannot see it before that.");
    if (j.customer_preview_shared_at) throw new HttpError(409, "This preview is already shared with the customer.");
    await c.db.prepare(`UPDATE build_jobs SET customer_preview_shared_at = ?, customer_preview_shared_by = ?, customer_review = NULL, customer_reviewed_by = NULL, customer_reviewed_at = NULL, customer_review_note = NULL, updated_at = ? WHERE id = ?`)
      .bind(nowIso(), c.userId, nowIso(), id).run();
  }
  await event(c.db, id, "preview", share ? "Preview shared with the customer" : "Preview no longer shared with the customer", userActor(c));
  if (share && j.state === "ready_for_review") await setStage(c.db, j.project_id, "CUSTOMER_PREVIEW", "Private preview shared with the customer after internal approval", "user");
  await audit(c.db, { actorUserId: c.userId, action: "builds.preview_shared", subjectType: "build_job", subjectId: id, organizationId: j.organization_id, details: { shared: share } });
  if (share && c.mail) await notifyCustomer(c.mail, j.project_id, { kind: "project", mail: { template: "project_update", data: { event: "preview_shared" } }, path: `/portal/projects/${j.project_id}/revisions`, key: `prvshare:${id}` });
}

export interface CustomerPreview { buildId: string; label: string; sharedAt: string; review: "approved" | "changes_requested" | null; reviewNote: string | null; reviewedAt: string | null; available: boolean }

/** Previews shared with a customer organization's project (tenant-scoped by organization and project). */
export async function customerPreviews(db: Db, organizationId: string, projectId: string): Promise<CustomerPreview[]> {
  const rows = (await db.prepare(`SELECT * FROM build_jobs WHERE organization_id = ? AND project_id = ? AND customer_preview_shared_at IS NOT NULL ORDER BY created_at DESC LIMIT 20`)
    .bind(organizationId, projectId).all<BuildJob>()).results;
  return rows.map((j) => ({
    buildId: j.id, label: j.kind === "revision" ? `Revision ${j.revision}` : "First build", sharedAt: j.customer_preview_shared_at!,
    review: j.customer_review, reviewNote: j.customer_review_note, reviewedAt: j.customer_reviewed_at,
    available: !!j.preview_gated && !!j.preview_url && !!j.preview_name && !j.preview_deleted_at,
  }));
}

async function customerJob(db: Db, organizationId: string, projectId: string, buildId: string): Promise<BuildJob> {
  const j = await db.prepare(`SELECT * FROM build_jobs WHERE id = ? AND organization_id = ? AND project_id = ? AND customer_preview_shared_at IS NOT NULL`).bind(buildId, organizationId, projectId).first<BuildJob>();
  if (!j) throw new HttpError(404, "Preview not found");
  return j;
}

/** Customer: a sign-in link for a preview shared with their own project (audited). Never an ungated preview. */
export async function customerPreviewLink(db: Db, secret: string | undefined, u: { organizationId: string; userId: string }, projectId: string, buildId: string): Promise<string> {
  const j = await customerJob(db, u.organizationId, projectId, buildId);
  const a = previewAccess(j, secret);
  if (!a.available || !a.gated) throw new HttpError(409, "This preview is not available any more. Contact your project team.");
  await audit(db, { actorUserId: u.userId, action: "portal.preview_opened", subjectType: "build_job", subjectId: j.id, organizationId: j.organization_id, details: { name: j.preview_name } });
  return previewSignInUrl(secret!, j.preview_name!, j.preview_url!, { audience: "customer" });
}

/** Customer review of a shared preview (step 4 of the delivery workflow). Account administrators only. */
export async function customerReviewPreview(c: { db: Db; mail?: MailCtx }, u: { organizationId: string; userId: string }, projectId: string, buildId: string, decision: string, note: string) {
  // Tenant scope first: another organization's ids are 404 whatever the form says.
  const j = await customerJob(c.db, u.organizationId, projectId, buildId);
  if (decision !== "approved" && decision !== "changes_requested") throw new HttpError(422, "Choose whether the preview is ready or needs changes.");
  const text = note.trim().slice(0, 2000);
  if (decision === "changes_requested" && text.length < 3) throw new HttpError(422, "Describe what should change.");
  if (j.preview_deleted_at || !j.preview_gated) throw new HttpError(409, "This preview is not available any more.");
  await c.db.prepare(`UPDATE build_jobs SET customer_review = ?, customer_reviewed_by = ?, customer_reviewed_at = ?, customer_review_note = ?, updated_at = ? WHERE id = ?`)
    .bind(decision, u.userId, nowIso(), text || null, nowIso(), j.id).run();
  await event(c.db, j.id, "preview", decision === "approved" ? "Customer approved the preview" : "Customer requested changes to the preview", { kind: "user", userId: u.userId }, { data: { note: text || null } });
  if (j.state === "ready_for_review") await setStage(c.db, j.project_id, decision === "approved" ? "CUSTOMER_PREVIEW" : "CUSTOMER_FEEDBACK", decision === "approved" ? "The customer approved the preview; final approval is a staff decision" : "The customer requested changes (a revision follows the customer-revision policy)", "user");
  await audit(c.db, { actorUserId: u.userId, action: "portal.preview_reviewed", subjectType: "build_job", subjectId: j.id, organizationId: j.organization_id, details: { decision } });
  if (c.mail) await notifyProjectTeam(c.mail, j.project_id, { kind: "project", mail: { template: "project_update", data: { event: "preview_reviewed", decision, note: text || null } }, path: `/staff/builds/${j.id}`, key: `prvrev:${j.id}:${decision}:${Date.now()}`, exceptUserId: u.userId });
}

export async function claimExpiredPreviews(db: Db, now = new Date()) {
  const at = now.toISOString();
  const reclaimBefore = new Date(now.getTime() - 3600_000).toISOString();
  const rows = (await db.prepare(`SELECT j.id, j.preview_name FROM build_jobs j
      WHERE j.preview_name IS NOT NULL AND j.preview_deleted_at IS NULL AND j.preview_delete_requested_at IS NOT NULL AND j.preview_preserved = 0
        AND (j.preview_delete_claimed_at IS NULL OR j.preview_delete_claimed_at < ?)
        AND j.state NOT IN ('preparing','building','verifying')
      ORDER BY j.preview_delete_requested_at LIMIT 10`).bind(reclaimBefore).all<{ id: string; preview_name: string }>()).results
    .filter((r) => PREVIEW_NAME.test(r.preview_name));
  for (const r of rows) await db.prepare(`UPDATE build_jobs SET preview_delete_claimed_at = ? WHERE id = ?`).bind(at, r.id).run();
  return { previews: rows.map((r) => ({ jobId: r.id, previewName: r.preview_name })) };
}

export async function reportPreviewDeleted(db: Db, b: Record<string, unknown>) {
  const job = typeof b.jobId === "string" ? await getJob(db, b.jobId) : null;
  if (!job || !job.preview_name || !job.preview_delete_claimed_at) throw new HttpError(404, "No preview deletion pending for this build");
  if (b.ok === true) {
    await db.prepare(`UPDATE build_jobs SET preview_deleted_at = ?, preview_delete_claimed_at = NULL, updated_at = ? WHERE id = ?`).bind(nowIso(), nowIso(), job.id).run();
    await event(db, job.id, "preview", `Preview ${job.preview_name} deleted by the runner`, { kind: "runner" }, { data: { name: job.preview_name, reason: job.preview_delete_reason } });
    await audit(db, { actorKind: "system", action: "builds.preview_deleted", subjectType: "build_job", subjectId: job.id, organizationId: job.organization_id, details: { name: job.preview_name, reason: job.preview_delete_reason } });
  } else {
    await db.prepare(`UPDATE build_jobs SET preview_delete_claimed_at = NULL WHERE id = ?`).bind(job.id).run();
    await event(db, job.id, "error", `Preview deletion failed (retried within the hour): ${sanitize(b.error ?? "unknown error", 300)}`, { kind: "runner" });
  }
  return { ok: true };
}

// ── Read models (owner dashboard + frontend contract) ──

export interface BuildSummary {
  id: string; projectId: string; projectName: string; organizationName: string; orderId: string | null; kind: string; revision: number;
  packageId: string | null; strategy: string; state: BuildState; stateLabel: string; stateReason: string | null;
  eligibility: Eligibility; startedAt: string | null; finishedAt: string | null; heartbeatAt: string | null; elapsedSeconds: number | null;
  costUsd: number; projectSpendUsd: number; runBudgetUsd: number; projectBudgetUsd: number;
  requirements: Record<RequirementStatus, number>; previewUrl: string | null;
  source: { repo: string | null; branch: string | null; commit: string | null }; attempts: number; maxAttempts: number;
  cancelRequested: boolean; projectPaused: boolean; updatedAt: string;
  /** The customer revision request this build works on (null for first builds and owner-written revisions). */
  customerRevision: { id: string; round: number } | null;
  /** Founder decision D2: what happens to this build's preview and when (scheduled deletion date). */
  previewRetention: PreviewRetention;
  /** Founder decision D3: previews are private; the preview opens through Crestmont sign-in only. */
  preview: { gated: boolean; sharedWithCustomer: boolean; customerReview: "approved" | "changes_requested" | null };
}

export async function summarize(db: Db, j: BuildJob, now = new Date()): Promise<BuildSummary> {
  const s = await getBuildSettings(db);
  const names = await db.prepare(`SELECT p.name AS p, o.name AS o FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.id = ?`).bind(j.project_id).first<{ p: string; o: string }>();
  const counts = { remaining: 0, implemented_unverified: 0, verified: 0, blocked: 0 } as Record<RequirementStatus, number>;
  for (const r of (await db.prepare(`SELECT status, COUNT(*) AS n FROM build_requirements WHERE job_id = ? GROUP BY status`).bind(j.id).all<{ status: RequirementStatus; n: number }>()).results) counts[r.status] = r.n;
  const controls = await projectControls(db, j.project_id);
  const end = j.finished_at ? Date.parse(j.finished_at) : now.getTime();
  return {
    id: j.id, projectId: j.project_id, projectName: names?.p ?? "", organizationName: names?.o ?? "", orderId: j.order_id, kind: j.kind, revision: j.revision,
    packageId: j.package_id, strategy: j.strategy, state: j.state, stateLabel: BUILD_STATE_LABELS[j.state], stateReason: j.state_reason,
    eligibility: decideEligibility(await projectFacts(db, j.project_id)),
    startedAt: j.started_at, finishedAt: j.finished_at, heartbeatAt: j.heartbeat_at, elapsedSeconds: j.started_at ? Math.max(0, Math.round((end - Date.parse(j.started_at)) / 1000)) : null,
    costUsd: microToUsd(j.cost_micro), projectSpendUsd: microToUsd(await projectSpendMicro(db, j.project_id)),
    runBudgetUsd: microToUsd(s.run_budget_micro), projectBudgetUsd: microToUsd(controls?.project_budget_micro ?? s.project_budget_micro),
    requirements: counts, previewUrl: j.preview_url, source: { repo: j.source_repo, branch: j.source_branch, commit: j.source_commit },
    attempts: j.attempts, maxAttempts: j.max_attempts, cancelRequested: !!j.cancel_requested_at, projectPaused: !!controls?.paused, updatedAt: j.updated_at,
    customerRevision: j.customer_revision_id
      ? { id: j.customer_revision_id, round: (await db.prepare(`SELECT round FROM revisions WHERE id = ?`).bind(j.customer_revision_id).first<{ round: number }>())?.round ?? 0 }
      : null,
    previewRetention: await previewRetentionFor(db, j, now),
    preview: { gated: !!j.preview_gated, sharedWithCustomer: !!j.customer_preview_shared_at, customerReview: j.customer_review },
  };
}

export async function listBuilds(db: Db, f: { state?: string; q?: string; limit: number; offset: number }) {
  const where: string[] = [], binds: unknown[] = [];
  if (f.state) { where.push(`j.state = ?`); binds.push(f.state); }
  if (f.q) { where.push(`(p.name LIKE ? OR o.name LIKE ? OR j.id = ?)`); binds.push(`%${f.q}%`, `%${f.q}%`, f.q); }
  const rows = (await db.prepare(`SELECT j.* FROM build_jobs j JOIN projects p ON p.id = j.project_id JOIN organizations o ON o.id = j.organization_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY j.updated_at DESC LIMIT ? OFFSET ?`).bind(...binds, f.limit, f.offset).all<BuildJob>()).results;
  return rows;
}

export async function buildDetail(db: Db, id: string) {
  const j = await getJob(db, id);
  if (!j) throw new HttpError(404, "Build not found");
  const requirements = (await db.prepare(`SELECT key, label, status, evidence, blocker, updated_at FROM build_requirements WHERE job_id = ? ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'remaining' THEN 1 WHEN 'implemented_unverified' THEN 2 ELSE 3 END, key`).bind(id).all()).results;
  const events = (await db.prepare(`SELECT id, at, kind, from_state, to_state, message, actor_kind, actor_user_id FROM build_events WHERE job_id = ? ORDER BY id DESC LIMIT 200`).bind(id).all()).results;
  const runs = (await db.prepare(`SELECT attempt, runner_id, started_at, ended_at, outcome, cost_micro, turns, session_id, error, provider, model, zero_cost FROM build_runs WHERE job_id = ? ORDER BY attempt`).bind(id).all<{ cost_micro: number }>()).results
    .map((r) => ({ ...r, cost_usd: microToUsd(r.cost_micro) }));
  const brief = j.brief_id ? await db.prepare(`SELECT id, version, sha256, created_at FROM build_briefs WHERE id = ?`).bind(j.brief_id).first() : null;
  return { job: j, summary: await summarize(db, j), requirements, events, runs, brief, report: j.report_md, missingInformation: j.missing_info_json ? JSON.parse(j.missing_info_json) as string[] : [] };
}

export async function runnerStatus(db: Db, now = new Date()) {
  const r = await db.prepare(`SELECT runner_id, version, capabilities, last_seen_at FROM build_runners ORDER BY last_seen_at DESC LIMIT 1`).first<{ runner_id: string; version: string | null; capabilities: string | null; last_seen_at: string }>();
  if (!r) return null;
  let caps: string[] = [];
  try { caps = runnerCapabilities(JSON.parse(r.capabilities ?? "[]")); } catch { /* unreadable: treated as no capabilities */ }
  return { runner_id: r.runner_id, version: r.version, last_seen_at: r.last_seen_at, capabilities: caps, zeroCost: caps.includes(ZERO_COST_CAPABILITY), online: now.getTime() - Date.parse(r.last_seen_at) < 5 * 60e3 };
}

/** Customer-facing summary: own organization only, no internal detail, no percentages. */
export async function customerBuildStatus(db: Db, organizationId: string, projectId: string) {
  const j = await db.prepare(`SELECT * FROM build_jobs WHERE project_id = ? AND organization_id = ? ORDER BY revision DESC, created_at DESC LIMIT 1`).bind(projectId, organizationId).first<BuildJob>();
  if (!j) return null;
  return { state: j.state, updatedAt: j.updated_at };
}
