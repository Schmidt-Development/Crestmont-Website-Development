// AI Website Builder V4 (Founder, 2026-10-28; local dual-model): durable project pipeline, architect specification,
// the ARCHITECT → BUILD → TEST → REVIEW → CORRECT loop, the external-integration checklist and the approval queue.
//
// Division of work ("the orchestrator is a controller"):
//  - The local orchestrator (the build runner on a GPU worker) runs Model A (architect, reviewer, hard repairs) and
//    Model B (builder, routine fixes) on the shared GPU, with the reviewer in a fresh read-only session, and reports here.
//  - The platform is the durable, auditable system of record and the referee: it stores the specification, every
//    cycle's evidence and decision, and it can overrule the reviewer when the evidence contradicts it (a "ready"
//    verdict with failing checks or without screenshots), and it stops loops that make no progress. No AI verdict can
//    move a website past the private Crestmont review: that takes a staff decision (builds.ts internal approval).

import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { AppContext } from "../app/context.ts";
import { HttpError } from "../app/http.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { audit } from "./security.ts";

type OwnerCtx = Pick<AppContext, "db"> & { userId: string };

export const STAGES = ["INTAKE_RECEIVED", "ARCHITECTING", "QUEUED", "WAITING_FOR_GPU_CAPACITY", "WORKER_ASSIGNED", "BUILDING", "TESTING", "AI_REVIEW",
  "REVISION_REQUIRED", "WAITING_FOR_HUMAN_AUTHORIZATION", "WAITING_FOR_EXTERNAL_SETUP", "AWAITING_INTERNAL_APPROVAL", "READY_FOR_CUSTOMER_PREVIEW",
  "CUSTOMER_PREVIEW", "CUSTOMER_FEEDBACK", "APPROVED_FOR_DELIVERY", "DELIVERED", "FAILED_NEEDS_INTERVENTION"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = {
  INTAKE_RECEIVED: "Intake received", ARCHITECTING: "Architecting (Model A)", QUEUED: "Queued", WAITING_FOR_GPU_CAPACITY: "Waiting for GPU capacity",
  WORKER_ASSIGNED: "GPU worker assigned", BUILDING: "Building", TESTING: "Testing", AI_REVIEW: "AI review (Model A)", REVISION_REQUIRED: "Automatic corrections",
  WAITING_FOR_HUMAN_AUTHORIZATION: "Waiting for authorization", WAITING_FOR_EXTERNAL_SETUP: "Waiting for external setup",
  AWAITING_INTERNAL_APPROVAL: "Awaiting internal approval (private)", READY_FOR_CUSTOMER_PREVIEW: "Internally approved, not shared",
  CUSTOMER_PREVIEW: "Customer preview", CUSTOMER_FEEDBACK: "Customer feedback", APPROVED_FOR_DELIVERY: "Final approval: ready for delivery",
  DELIVERED: "Delivered", FAILED_NEEDS_INTERVENTION: "Needs intervention",
};

export const DECISIONS = ["CONTINUE_BUILDING", "FIX_DEFECTS", "RUN_MORE_TESTS", "WAIT_FOR_EXTERNAL_SETUP", "NEEDS_HUMAN_AUTHORIZATION", "READY_FOR_FINAL_QA", "READY_FOR_INTERNAL_APPROVAL"] as const;
export type Decision = (typeof DECISIONS)[number] | "ESCALATED";
const CONTINUE: readonly Decision[] = ["CONTINUE_BUILDING", "FIX_DEFECTS", "RUN_MORE_TESTS"];
const READY: readonly Decision[] = ["READY_FOR_FINAL_QA", "READY_FOR_INTERNAL_APPROVAL"];
/** Decision names of earlier runners, mapped to the current ones. */
const LEGACY_DECISIONS: Record<string, Decision> = { READY_FOR_FOUNDER_APPROVAL: "READY_FOR_INTERNAL_APPROVAL" };

export async function getPipeline(db: Db, projectId: string) {
  return db.prepare(`SELECT * FROM build_pipeline WHERE project_id = ?`).bind(projectId)
    .first<{ project_id: string; organization_id: string; stage: Stage; stage_reason: string | null; priority: number; spec_json: string | null; spec_version: number; architect_provider: string | null; updated_at: string }>();
}

/** Durable stage change with an event; no-op when the stage and reason are unchanged (idempotent). */
export async function setStage(db: Db, projectId: string, stage: Stage, reason: string, actor: "system" | "runner" | "user" = "system") {
  const cur = await getPipeline(db, projectId);
  if (cur && cur.stage === stage && cur.stage_reason === reason) return;
  const at = nowIso();
  if (!cur) {
    const p = await db.prepare(`SELECT organization_id FROM projects WHERE id = ?`).bind(projectId).first<{ organization_id: string }>();
    if (!p) return;
    await db.prepare(`INSERT OR IGNORE INTO build_pipeline (project_id, organization_id, stage, stage_reason, updated_at) VALUES (?,?,?,?,?)`).bind(projectId, p.organization_id, stage, reason.slice(0, 500), at).run();
  } else {
    await db.prepare(`UPDATE build_pipeline SET stage = ?, stage_reason = ?, updated_at = ? WHERE project_id = ?`).bind(stage, reason.slice(0, 500), at, projectId).run();
  }
  await db.prepare(`INSERT INTO build_pipeline_events (project_id, at, from_stage, to_stage, message, actor_kind) VALUES (?,?,?,?,?,?)`)
    .bind(projectId, at, cur?.stage ?? null, stage, reason.slice(0, 1000), actor).run();
}

/** Keeps the pipeline stage in step with the build job (called on every job transition). */
export async function syncStageFromJob(db: Db, job: { project_id: string; state: string; state_reason?: string | null }) {
  const map: Record<string, Stage | null> = {
    awaiting_intake: "INTAKE_RECEIVED", awaiting_payment: "INTAKE_RECEIVED", queued: "QUEUED", preparing: "BUILDING", building: "BUILDING", verifying: "TESTING",
    // A finished build is parked privately: the customer sees nothing until a staff member approves it (V4 §7 F).
    ready_for_review: "AWAITING_INTERNAL_APPROVAL", approved: "APPROVED_FOR_DELIVERY", failed: "FAILED_NEEDS_INTERVENTION", budget_paused: "FAILED_NEEDS_INTERVENTION",
    needs_information: "WAITING_FOR_HUMAN_AUTHORIZATION", paused: null, canceled: null,
  };
  const stage = map[job.state];
  if (!stage) return;
  // A queued job whose project already has a worker keeps WORKER_ASSIGNED / WAITING_FOR_GPU_CAPACITY from the dispatcher.
  if (stage === "QUEUED") {
    const cur = await getPipeline(db, job.project_id);
    if (cur && ["WORKER_ASSIGNED", "WAITING_FOR_GPU_CAPACITY", "REVISION_REQUIRED"].includes(cur.stage)) return;
  }
  await setStage(db, job.project_id, stage, job.state_reason ?? `Build ${job.state.replace(/_/g, " ")}`);
}

// ── Architect specification (structured master specification from the AI Architect) ──

export interface MasterSpec {
  schema: "crestmont.master-spec/1";
  projectSpec: string;
  designSpec: string;
  technicalArchitecture: string;
  tasks: { id: string; title: string; workstream: string; paths: string[]; dependsOn: string[] }[];
  acceptanceCriteria: { id: string; text: string; verification: "automated" | "screenshot" | "manual" }[];
  integrations: { key: string; name: string; purpose: string }[];
  securityRequirements: string[];
  testingRequirements: string[];
  assumptions: { text: string; provisional: true }[];
  referenceImages: { fileId: string; classification: "customer_asset" | "reference_only" | "needs_license" }[];
  masterPrompt: string;
}

const s = (v: unknown, max: number) => typeof v === "string" ? v.slice(0, max) : "";
const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9._:-]{1,60}$/.test(v) ? v : null;

/** Validate the structured specification; returns problems (empty = valid). Untrusted: it came from a model. */
export function validateSpec(raw: unknown): { spec: MasterSpec | null; problems: string[] } {
  const p: string[] = [];
  const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!o) return { spec: null, problems: ["specification is not an object"] };
  if (o.schema !== "crestmont.master-spec/1") p.push("schema must be crestmont.master-spec/1");
  for (const k of ["projectSpec", "designSpec", "technicalArchitecture", "masterPrompt"]) if (typeof o[k] !== "string" || !(o[k] as string).trim()) p.push(`${k} is required`);
  const tasks = Array.isArray(o.tasks) ? o.tasks : [];
  if (!tasks.length) p.push("tasks must list at least one task");
  const ac = Array.isArray(o.acceptanceCriteria) ? o.acceptanceCriteria : [];
  if (!ac.length) p.push("acceptanceCriteria must list at least one criterion");
  const taskIds = new Set<string>();
  const outTasks: MasterSpec["tasks"] = [];
  for (const t of tasks.slice(0, 200)) {
    const r = t as Record<string, unknown>;
    const tid = id(r.id);
    if (!tid || taskIds.has(tid)) { p.push("every task needs a unique id"); continue; }
    taskIds.add(tid);
    outTasks.push({ id: tid, title: s(r.title, 300), workstream: s(r.workstream, 60) || "general", paths: (Array.isArray(r.paths) ? r.paths : []).filter((x): x is string => typeof x === "string" && !x.includes("..") && !x.startsWith("/")).slice(0, 50), dependsOn: (Array.isArray(r.dependsOn) ? r.dependsOn : []).map(id).filter((x): x is string => !!x) });
  }
  for (const t of outTasks) for (const d of t.dependsOn) if (!taskIds.has(d)) p.push(`task ${t.id} depends on unknown task ${d}`);
  if (hasCycle(outTasks)) p.push("task dependency graph has a cycle");
  const outAc: MasterSpec["acceptanceCriteria"] = [];
  const acIds = new Set<string>();
  for (const a of ac.slice(0, 300)) {
    const r = a as Record<string, unknown>;
    const aid = id(r.id);
    if (!aid || acIds.has(aid)) { p.push("every acceptance criterion needs a unique id"); continue; }
    acIds.add(aid);
    outAc.push({ id: aid, text: s(r.text, 500), verification: r.verification === "screenshot" || r.verification === "manual" ? r.verification : "automated" });
  }
  if (p.length) return { spec: null, problems: p };
  const list = (v: unknown, max = 100) => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 500)).slice(0, max);
  return {
    spec: {
      schema: "crestmont.master-spec/1", projectSpec: s(o.projectSpec, 20000), designSpec: s(o.designSpec, 20000), technicalArchitecture: s(o.technicalArchitecture, 20000),
      tasks: outTasks, acceptanceCriteria: outAc,
      integrations: (Array.isArray(o.integrations) ? o.integrations : []).map((x) => x as Record<string, unknown>).map((x) => ({ key: id(x.key) ?? "", name: s(x.name, 100), purpose: s(x.purpose, 300) })).filter((x) => x.key).slice(0, 50),
      securityRequirements: list(o.securityRequirements), testingRequirements: list(o.testingRequirements),
      assumptions: list(o.assumptions as unknown).map((text) => ({ text, provisional: true as const })),
      referenceImages: (Array.isArray(o.referenceImages) ? o.referenceImages : []).map((x) => x as Record<string, unknown>).map((x) => ({ fileId: s(x.fileId, 64), classification: (["customer_asset", "reference_only", "needs_license"].includes(x.classification as string) ? x.classification : "needs_license") as MasterSpec["referenceImages"][number]["classification"] })).filter((x) => x.fileId).slice(0, 100),
      masterPrompt: s(o.masterPrompt, 60000),
    },
    problems: [],
  };
}

function hasCycle(tasks: { id: string; dependsOn: string[] }[]): boolean {
  const g = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const state = new Map<string, number>();
  const visit = (n: string): boolean => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    for (const d of g.get(n) ?? []) if (visit(d)) return true;
    state.set(n, 2);
    return false;
  };
  return tasks.some((t) => visit(t.id));
}

/** Runner: store the Architect's specification (versioned) and seed the integration checklist from it. */
export async function storeSpec(db: Db, job: { id: string; project_id: string; organization_id: string }, raw: unknown, provider: string) {
  const { spec, problems } = validateSpec(raw);
  if (!spec) throw new HttpError(422, `Invalid specification: ${problems.slice(0, 10).join("; ")}`);
  const prov = /^[a-z0-9][a-z0-9:._-]{0,59}$/.test(provider) ? provider : "unknown";
  await setStage(db, job.project_id, "ARCHITECTING", `Specification received from ${prov}`, "runner");
  await db.prepare(`UPDATE build_pipeline SET spec_json = ?, spec_version = spec_version + 1, architect_provider = ?, updated_at = ? WHERE project_id = ?`).bind(JSON.stringify(spec), prov, nowIso(), job.project_id).run();
  for (const i of spec.integrations) await ensureIntegration(db, job.project_id, job.organization_id, i.key, i.name, i.purpose);
  await audit(db, { actorKind: "system", action: "builds.spec_recorded", subjectType: "project", subjectId: job.project_id, organizationId: job.organization_id, details: { provider: prov, tasks: spec.tasks.length, criteria: spec.acceptanceCriteria.length } });
  await setStage(db, job.project_id, "BUILDING", "Building from the master specification", "runner");
  return { specVersion: (await getPipeline(db, job.project_id))!.spec_version };
}

// ── Review cycles ──

export interface CycleEvidence {
  summary: string;
  changedFiles: string[];
  commits: string[];
  checks: { id: string; ok: boolean; detail?: string }[];
  screenshots: { path: string; viewport: "desktop" | "mobile"; page: string }[];
  criteria: { id: string; status: "passed" | "failed" | "not_verified" }[];
  defects: string[];
  integrationBlockers: string[];
  securityFindings: string[];
  recommendedNext: string[];
}

export function parseEvidence(raw: unknown): CycleEvidence {
  const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const strs = (v: unknown, n = 200, max = 500) => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, max)).slice(0, n);
  return {
    summary: s(o.summary, 5000),
    changedFiles: strs(o.changedFiles, 500, 300),
    commits: strs(o.commits, 50, 64).filter((c) => /^[0-9a-f]{7,64}$/.test(c)),
    checks: (Array.isArray(o.checks) ? o.checks : []).slice(0, 100).map((c) => c as Record<string, unknown>).filter((c) => id(c.id)).map((c) => ({ id: id(c.id)!, ok: c.ok === true, detail: s(c.detail, 500) })),
    screenshots: (Array.isArray(o.screenshots) ? o.screenshots : []).slice(0, 200).map((c) => c as Record<string, unknown>)
      .filter((c) => typeof c.path === "string" && !String(c.path).includes("..") && (c.viewport === "desktop" || c.viewport === "mobile"))
      .map((c) => ({ path: s(c.path, 300), viewport: c.viewport as "desktop" | "mobile", page: s(c.page, 200) })),
    criteria: (Array.isArray(o.criteria) ? o.criteria : []).slice(0, 300).map((c) => c as Record<string, unknown>).filter((c) => id(c.id))
      .map((c) => ({ id: id(c.id)!, status: (c.status === "passed" || c.status === "failed" ? c.status : "not_verified") as "passed" | "failed" | "not_verified" })),
    defects: strs(o.defects), integrationBlockers: strs(o.integrationBlockers), securityFindings: strs(o.securityFindings), recommendedNext: strs(o.recommendedNext),
  };
}

/** Outstanding work the evidence itself shows (never the builder's self-report alone). */
export function outstanding(e: CycleEvidence): string[] {
  return [
    ...e.checks.filter((c) => !c.ok).map((c) => `check:${c.id}`),
    ...e.criteria.filter((c) => c.status !== "passed").map((c) => `criterion:${c.id}`),
    ...e.defects.map((d) => `defect:${d.slice(0, 80)}`),
    ...e.securityFindings.map((d) => `security:${d.slice(0, 80)}`),
  ];
}

const progressScore = (e: CycleEvidence) => {
  const total = e.checks.length + e.criteria.length;
  return total ? (e.checks.filter((c) => c.ok).length + e.criteria.filter((c) => c.status === "passed").length) / total : 0;
};

/**
 * Runner: one completed implementation cycle with the reviewer's proposed decision. The platform decides:
 *  - "ready" decisions need passing checks, every criterion passed, and desktop + mobile screenshots;
 *  - WAIT_FOR_EXTERNAL_SETUP needs nothing else outstanding but integration blockers;
 *  - a continuation needs a corrective prompt that names the outstanding items it addresses;
 *  - loop guards: max cycles, the same failure signature three cycles in a row, or no progress over three cycles
 *    → ESCALATED (FAILED_NEEDS_INTERVENTION), work preserved.
 * Idempotent per (job, cycle).
 */
export async function submitCycle(db: Db, job: { id: string; project_id: string; organization_id: string }, b: Record<string, unknown>) {
  const cycle = Number(b.cycle);
  if (!Number.isInteger(cycle) || cycle < 1 || cycle > 1000) throw new HttpError(422, "cycle must be a positive integer");
  const existing = await db.prepare(`SELECT decision, decision_reason, next_prompt FROM build_cycles WHERE job_id = ? AND cycle = ?`).bind(job.id, cycle).first<{ decision: Decision; decision_reason: string; next_prompt: string | null }>();
  if (existing) return { cycle, decision: existing.decision, reason: existing.decision_reason, continue: CONTINUE.includes(existing.decision), prompt: existing.next_prompt };
  const last = await db.prepare(`SELECT cycle FROM build_cycles WHERE job_id = ? ORDER BY cycle DESC LIMIT 1`).bind(job.id).first<{ cycle: number }>();
  if (cycle !== (last?.cycle ?? 0) + 1) throw new HttpError(409, `expected cycle ${(last?.cycle ?? 0) + 1}`);
  const ev = parseEvidence(b.evidence);
  const rawDecision = LEGACY_DECISIONS[b.decision as string] ?? b.decision;
  const proposed = (DECISIONS as readonly string[]).includes(rawDecision as string) ? rawDecision as Decision : null;
  const nextPrompt = s(b.nextPrompt, 60000).trim() || null;
  const addresses = (Array.isArray(b.addresses) ? b.addresses : []).filter((x): x is string => typeof x === "string").slice(0, 200);
  const promptUsed = s(b.prompt, 60000) || "(not recorded)";
  const source = ["architect", "reviewer", "owner", "runner"].includes(b.promptSource as string) ? b.promptSource as string : "runner";
  const provider = /^[a-z0-9][a-z0-9:._-]{0,59}$/.test(String(b.reviewerProvider ?? "")) ? String(b.reviewerProvider) : "unknown";
  const open = outstanding(ev);
  const nonIntegrationOpen = open.filter((o) => !o.startsWith("criterion:integration"));
  const hasDesktop = ev.screenshots.some((x) => x.viewport === "desktop"), hasMobile = ev.screenshots.some((x) => x.viewport === "mobile");
  const signature = await sha256Hex([...open].sort().join("\n"));
  const score = Math.round(progressScore(ev) * 1000) / 1000;
  const settings = await db.prepare(`SELECT max_review_cycles AS m FROM build_settings WHERE id = 1`).first<{ m: number }>();
  const maxCycles = settings?.m ?? 8;
  const prior = (await db.prepare(`SELECT failure_signature, score FROM build_cycles WHERE job_id = ? ORDER BY cycle DESC LIMIT 3`).bind(job.id).all<{ failure_signature: string | null; score: number | null }>()).results;

  let decision: Decision = proposed ?? "FIX_DEFECTS";
  let reason = proposed ? `Reviewer (${provider}): ${proposed}` : "No valid reviewer decision; treated as FIX_DEFECTS";
  if (READY.includes(decision) && (open.length || !hasDesktop || !hasMobile)) {
    decision = "FIX_DEFECTS";
    reason = `Overruled: the evidence does not support "${proposed}" (${open.length ? `${open.length} outstanding item(s)` : ""}${!hasDesktop || !hasMobile ? `${open.length ? "; " : ""}desktop and mobile screenshots are required` : ""})`;
  }
  if (decision === "WAIT_FOR_EXTERNAL_SETUP" && (nonIntegrationOpen.length || !ev.integrationBlockers.length)) {
    decision = nonIntegrationOpen.length ? "CONTINUE_BUILDING" : "READY_FOR_FINAL_QA";
    reason = nonIntegrationOpen.length ? "Overruled: independent work remains; external setup does not stop it" : "Overruled: no integration blocker is reported";
    if (decision === "READY_FOR_FINAL_QA" && (!hasDesktop || !hasMobile)) { decision = "FIX_DEFECTS"; reason = "Overruled: desktop and mobile screenshots are required"; }
  }
  if (CONTINUE.includes(decision)) {
    if (!nextPrompt) { decision = "ESCALATED"; reason = "The reviewer asked for more work without a corrective prompt"; }
    else if (!open.length && decision !== "RUN_MORE_TESTS" && !addresses.length) { decision = "ESCALATED"; reason = "Continuation is not traceable to outstanding work or failed criteria"; }
  }
  if (CONTINUE.includes(decision)) {
    const sameRuns = prior.length >= 2 && prior.slice(0, 2).every((p) => p.failure_signature === signature);
    // No progress: nothing in the last three cycles (this one included) beat the score of three cycles ago.
    const stalled = prior.length >= 3 && Math.max(score, prior[0].score ?? 0, prior[1].score ?? 0) <= (prior[2].score ?? 0);
    if (cycle >= maxCycles) { decision = "ESCALATED"; reason = `Reached the limit of ${maxCycles} review cycles`; }
    else if (sameRuns && open.length) { decision = "ESCALATED"; reason = "The same failures repeated in three consecutive cycles"; }
    else if (stalled) { decision = "ESCALATED"; reason = "No measurable progress over the last three cycles"; }
  }
  const finalPrompt = CONTINUE.includes(decision) ? nextPrompt : null;
  const sessions = (Array.isArray(b.sessions) ? b.sessions : []).slice(0, 50).map((x) => x as Record<string, unknown>).map((x) => ({
    id: s(x.id, 40), role: s(x.role, 30), model: s(x.model, 120), workstream: s(x.workstream, 60), tasks: (Array.isArray(x.tasks) ? x.tasks : []).map((t) => s(t, 60)).slice(0, 50), mode: s(x.mode, 20), status: s(x.status, 30), note: s(x.note, 300),
  }));
  const model = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/.test(v) ? v : null;
  const routing = b.routing && typeof b.routing === "object" ? JSON.stringify(b.routing).slice(0, 2000) : null;
  await db.prepare(`INSERT INTO build_cycles (id, job_id, project_id, cycle, prompt, prompt_source, sessions_json, evidence_json, reviewer_provider, builder_model, reviewer_model, routing_json, proposed_decision, decision, decision_reason, next_prompt, score, failure_signature, findings_json, created_at, reviewed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(newId("cyc"), job.id, job.project_id, cycle, promptUsed, source, JSON.stringify(sessions), JSON.stringify(ev), provider, model(b.builderModel), model(b.reviewerModel), routing, proposed, decision, reason.slice(0, 1000), finalPrompt, score, signature, JSON.stringify({ outstanding: open.slice(0, 200), addresses }), nowIso(), nowIso()).run();
  // The automated acceptance verdict of this build (the internal-approval page shows it; it never approves anything).
  const acceptance = READY.includes(decision) ? "passed" : decision === "WAIT_FOR_EXTERNAL_SETUP" ? "passed_pending_integrations" : "failed";
  await db.prepare(`UPDATE build_jobs SET ai_acceptance = ?, updated_at = ? WHERE id = ?`).bind(acceptance, nowIso(), job.id).run();
  const stage: Stage = CONTINUE.includes(decision) ? "REVISION_REQUIRED" : decision === "ESCALATED" ? "FAILED_NEEDS_INTERVENTION"
    : decision === "WAIT_FOR_EXTERNAL_SETUP" ? "WAITING_FOR_EXTERNAL_SETUP" : decision === "NEEDS_HUMAN_AUTHORIZATION" ? "WAITING_FOR_HUMAN_AUTHORIZATION" : "AI_REVIEW";
  await setStage(db, job.project_id, stage, `Cycle ${cycle}: ${READY.includes(decision) ? "AI acceptance passed; the build finishes and waits for internal approval" : reason}`, "runner");
  await audit(db, { actorKind: "system", action: "builds.review_cycle", subjectType: "build_job", subjectId: job.id, organizationId: job.organization_id, details: { cycle, proposed, decision, outstanding: open.length, score, builderModel: model(b.builderModel), reviewerModel: model(b.reviewerModel) } });
  return { cycle, decision, reason, continue: CONTINUE.includes(decision), prompt: finalPrompt };
}

// ── External integration checklist ──

interface CatalogItem { name: string; purpose: string; credentials: string; setup: string; permissions: string; responsible: "founder" | "customer" | "crestmont_staff" }
export const INTEGRATION_CATALOG: Record<string, CatalogItem> = {
  stripe: { name: "Stripe payments", purpose: "Take payments on the customer's site", credentials: "Customer's Stripe secret key (sk_live_…), publishable key, webhook signing secret (whsec_…)", setup: "Customer: Stripe Dashboard → Developers → API keys; add a webhook endpoint for the site's /api/stripe/webhook with the events the adapter lists; store the keys as Worker secrets on the customer's production target (never in the repository).", permissions: "Stripe account owner or administrator", responsible: "customer" },
  resend: { name: "Resend email", purpose: "Send contact-form and transactional email", credentials: "Resend API key (sending access, one domain)", setup: "Customer or Founder: create a Resend account, verify the sending domain's DNS records, create a sending-only key, store it as a Worker secret.", permissions: "DNS access for the sending domain", responsible: "customer" },
  twilio: { name: "Twilio SMS/voice", purpose: "Text or call notifications", credentials: "Account SID, auth token or API key, a verified sender number", setup: "Customer: Twilio console → create an API key; buy or verify a number; complete messaging registration where required; store as Worker secrets.", permissions: "Twilio account administrator", responsible: "customer" },
  retell: { name: "Retell voice agent", purpose: "AI phone agent", credentials: "Retell API key, agent id", setup: "Founder: Retell dashboard → API keys; configure the agent; store as Worker secrets.", permissions: "Retell workspace administrator", responsible: "founder" },
  google_calendar: { name: "Google Calendar", purpose: "Bookings in the customer's calendar", credentials: "OAuth client (id + secret) and a consent grant by the calendar owner", setup: "Customer: Google Cloud console → OAuth consent screen + OAuth client; the calendar owner signs in once to grant access; store tokens server-side.", permissions: "Google Workspace/Account owner of the calendar", responsible: "customer" },
  google_oauth: { name: "Google sign-in", purpose: "Let site visitors sign in with Google", credentials: "OAuth client id + secret, authorized redirect URIs", setup: "Customer: Google Cloud console → OAuth client (Web) with the production redirect URI; verification may be needed for sensitive scopes.", permissions: "Google Cloud project owner", responsible: "customer" },
  domain: { name: "Customer domain", purpose: "Serve the site on the customer's domain", credentials: "None stored: DNS change at the registrar", setup: "Founder authorizes the domain in Production delivery (DELIVERY.md); the customer or Founder adds the DNS records Cloudflare shows. Purchases and transfers are manual.", permissions: "Registrar / DNS access", responsible: "founder" },
  external_db: { name: "External database", purpose: "Read or write the customer's existing data", credentials: "Least-privilege database credentials for a dedicated user", setup: "Customer: create a dedicated user limited to the needed tables; provide the connection details through a secure channel; store as Worker secrets.", permissions: "Database administrator", responsible: "customer" },
  booking: { name: "Booking system", purpose: "Online booking", credentials: "Booking provider API key or embed id", setup: "Customer: provider dashboard → API/embed settings; share the key through the portal (never email).", permissions: "Booking account administrator", responsible: "customer" },
};

export async function ensureIntegration(db: Db, projectId: string, organizationId: string, key: string, name?: string, purpose?: string) {
  const cat = INTEGRATION_CATALOG[key];
  await db.prepare(`INSERT OR IGNORE INTO build_integrations (id, project_id, organization_id, key, name, purpose, credentials_required, setup_instructions, permissions_required, human_action, responsible, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(newId("int"), projectId, organizationId, key, cat?.name ?? (name || key), cat?.purpose ?? (purpose || "Requested integration"), cat?.credentials ?? "To be confirmed with the provider",
      cat?.setup ?? "Founder: confirm the provider, create a least-privilege credential, store it as a Worker secret on the customer's target.", cat?.permissions ?? "Provider account administrator",
      cat ? `Provide ${cat.credentials.split(",")[0]}` : "Confirm provider and credentials", cat?.responsible ?? "founder", nowIso()).run();
}

/** Seed the checklist from the intake brief (features and integrations the customer asked for). */
export async function seedIntegrationsFromBrief(db: Db, projectId: string, organizationId: string, brief: { customerData: { features: { key: string }[]; integrations: string[]; domain: { status: string } } }) {
  const keys = new Set<string>();
  for (const f of brief.customerData.features) {
    if (f.key === "ecommerce") keys.add("stripe");
    if (f.key === "booking") keys.add("booking");
    if (f.key === "contact_form") keys.add("resend");
  }
  for (const i of brief.customerData.integrations) { const k = i.toLowerCase().replace(/[^a-z0-9]+/g, "_"); keys.add(k in INTEGRATION_CATALOG ? k : k.slice(0, 40)); }
  if (brief.customerData.domain.status && brief.customerData.domain.status !== "none") keys.add("domain");
  for (const k of keys) if (/^[a-z0-9_]{2,40}$/.test(k)) await ensureIntegration(db, projectId, organizationId, k);
}

/** Runner: code and mock status per integration. "verified_live" is never accepted from the runner. */
export async function reportIntegrations(db: Db, job: { project_id: string; organization_id: string }, items: unknown) {
  let n = 0;
  for (const it of (Array.isArray(items) ? items : []).slice(0, 50)) {
    const r = it as Record<string, unknown>;
    const key = typeof r.key === "string" && /^[a-z0-9_]{2,40}$/.test(r.key) ? r.key : null;
    if (!key) continue;
    await ensureIntegration(db, job.project_id, job.organization_id, key, s(r.name, 100), s(r.purpose, 300));
    const code = ["not_started", "in_progress", "implemented"].includes(r.codeStatus as string) ? r.codeStatus as string : null;
    const mock = ["not_tested", "passed", "failed"].includes(r.mockStatus as string) ? r.mockStatus as string : null;
    // Set only by the runner's trusted integration layer after an approved test-environment operation (sanitized).
    const sandbox = ["passed", "failed"].includes(r.sandboxStatus as string) ? r.sandboxStatus as string : null;
    const evidence = sandbox ? s(r.sandboxEvidence, 1000).replace(/[A-Za-z0-9_\-]{24,}/g, "[redacted]") || null : null;
    await db.prepare(`UPDATE build_integrations SET code_status = COALESCE(?, code_status), mock_status = COALESCE(?, mock_status),
        sandbox_status = COALESCE(?, sandbox_status), sandbox_evidence = CASE WHEN ? IS NULL THEN sandbox_evidence ELSE ? END,
        live_status = CASE WHEN live_status = 'verified_live' THEN live_status ELSE 'awaiting_credentials' END, updated_at = ? WHERE project_id = ? AND key = ?`)
      .bind(code, mock, sandbox, sandbox, evidence, nowIso(), job.project_id, key).run();
    n++;
  }
  return { updated: n };
}

/** Owner: record that a live connection was verified by a person (never inferred from mock tests). */
export async function markIntegrationLive(c: OwnerCtx, integrationId: string, live: boolean) {
  const row = await c.db.prepare(`SELECT project_id, organization_id, key FROM build_integrations WHERE id = ?`).bind(integrationId).first<{ project_id: string; organization_id: string; key: string }>();
  if (!row) throw new HttpError(404, "Integration not found");
  await c.db.prepare(`UPDATE build_integrations SET live_status = ?, updated_at = ? WHERE id = ?`).bind(live ? "verified_live" : "awaiting_credentials", nowIso(), integrationId).run();
  await audit(c.db, { actorUserId: c.userId, action: "builds.integration_live_status", subjectType: "project", subjectId: row.project_id, organizationId: row.organization_id, details: { key: row.key, live } });
}

// ── Sensitive-action approvals (routine development never comes here) ──

export const APPROVAL_KINDS = ["credential_request", "external_account_connection", "sensitive_customer_system", "paid_usage_increase", "purchase",
  "infrastructure_permission", "production_publish", "dns_change", "destructive_outside_workspace", "privileged_access", "security_or_legal_decision",
  // V4 §8: run one catalogued operation of the trusted integration layer against a test environment.
  "integration_operation"] as const;
/** Operation ids of the runner's trusted integration catalogue (runner/src/integrations/catalog.ts). */
export const OPERATION_ID = /^[a-z0-9_]{2,40}\.[a-z0-9_]{2,60}$/;

export async function requestApproval(db: Db, job: { id: string; project_id: string; organization_id: string }, b: Record<string, unknown>, requestedBy: string) {
  const kind = (APPROVAL_KINDS as readonly string[]).includes(b.kind as string) ? b.kind as string : null;
  if (!kind) throw new HttpError(422, `kind must be one of ${APPROVAL_KINDS.join(", ")}`);
  const summary = s(b.summary, 500).trim();
  if (summary.length < 5) throw new HttpError(422, "summary is required");
  const operation = kind === "integration_operation" ? (typeof b.operation === "string" && OPERATION_ID.test(b.operation) ? b.operation : null) : null;
  if (kind === "integration_operation" && !operation) throw new HttpError(422, "operation must name a catalogued integration operation (provider.action)");
  const dedupe = await sha256Hex(`${job.project_id}|${kind}|${operation ?? ""}|${summary.toLowerCase()}`);
  const ex = await db.prepare(`SELECT id, status FROM build_approvals WHERE dedupe_key = ?`).bind(dedupe).first<{ id: string; status: string }>();
  if (ex) return { id: ex.id, status: ex.status, duplicate: true };
  const aid = newId("apv");
  await db.prepare(`INSERT INTO build_approvals (id, project_id, organization_id, job_id, kind, summary, detail, operation, dedupe_key, requested_by, requested_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(aid, job.project_id, job.organization_id, job.id, kind, summary, s(b.detail, 5000) || null, operation, dedupe, requestedBy.slice(0, 64), nowIso()).run();
  await audit(db, { actorKind: "system", action: "builds.approval_requested", subjectType: "project", subjectId: job.project_id, organizationId: job.organization_id, details: { approvalId: aid, kind } });
  return { id: aid, status: "pending", duplicate: false };
}

export async function decideApproval(c: OwnerCtx, approvalId: string, approve: boolean, note: string) {
  const a = await c.db.prepare(`SELECT * FROM build_approvals WHERE id = ?`).bind(approvalId).first<{ id: string; status: string; project_id: string; organization_id: string; kind: string }>();
  if (!a) throw new HttpError(404, "Approval not found");
  if (a.status !== "pending") throw new HttpError(409, "Already decided.");
  if (!approve && note.trim().length < 3) throw new HttpError(422, "Give a reason for rejecting.");
  await c.db.prepare(`UPDATE build_approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'`).bind(approve ? "approved" : "rejected", c.userId, nowIso(), note.trim().slice(0, 1000) || null, a.id).run();
  await audit(c.db, { actorUserId: c.userId, action: "builds.approval_decided", subjectType: "project", subjectId: a.project_id, organizationId: a.organization_id, details: { approvalId: a.id, kind: a.kind, approve } });
}

/** Runner: the decisions on this job's requests (the orchestrator acts only on approved ones). */
export async function approvalsForJob(db: Db, jobId: string) {
  // The job's own requests, plus the project's decisions on integration operations from earlier builds (the platform
  // keeps one request per project and operation, so a revision sees the Owner's existing decision).
  return (await db.prepare(`SELECT id, kind, summary, operation, status, decision_note FROM build_approvals WHERE job_id = ?
      OR (kind = 'integration_operation' AND project_id = (SELECT project_id FROM build_jobs WHERE id = ?)) ORDER BY requested_at`).bind(jobId, jobId).all<{ id: string; kind: string; summary: string; operation: string | null; status: string; decision_note: string | null }>()).results;
}
