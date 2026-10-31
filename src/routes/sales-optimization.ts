// AI Sales Optimization (Owner only; SALESOPT-010). Founder decisions (approval, deployment, rollback, activation,
// targets, experiments) need salesopt.decide (Owner-only) and a fresh second factor (src/app/step-up.ts).
//  GET  /staff/sales-optimization
//  GET  /staff/sales-optimization/versions/:id
//  POST /staff/sales-optimization/control                 paused, auto_rollback, production_activated, thresholds
//  POST /staff/sales-optimization/targets                 stage, agent_id
//  POST /staff/sales-optimization/targets/:stage/verify   reads the agent from Retell (no write)
//  POST /staff/sales-optimization/versions                new version (manual edit of a parent)
//  POST /staff/sales-optimization/versions/:id/evaluate   run the evaluation harness
//  POST /staff/sales-optimization/versions/:id/decide     decision=approve|reject
//  POST /staff/sales-optimization/deploy                  stage, version_id, expected_current
//  POST /staff/sales-optimization/rollback                stage
//  POST /staff/sales-optimization/experiments             propose
//  POST /staff/sales-optimization/experiments/:id/decide  action=start|stop
//  POST /staff/sales-optimization/run                     run one optimization cycle now
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, label, type SafeHtml } from "../lib/html.ts";
import { HttpError, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { csrf, input, textarea, select, checkbox, button, formErrors, alert, badge, table, emptyState, kpi, pageHead, linkButton, dl } from "../ui/components.ts";
import { staffPage } from "./crm.ts";
import { can } from "../domain/authz.ts";
import { audit } from "../services/security.ts";
import { lineDiff } from "../services/voice.ts";
import * as reg from "../services/sales-opt/registry.ts";
import { computeMetrics, topFindings } from "../services/sales-opt/metrics.ts";
import { deploy, productionGate, rollback, rollbackCandidate, verifyTarget, PRODUCTION_FLAG } from "../services/sales-opt/deploy.ts";
import { startEvaluation, maybeQueueProposal } from "../services/sales-opt/jobs.ts";
import { proposeExperiment, decideExperimentStatus, experimentReport, runSalesOpt } from "../services/sales-opt/monitor.ts";
import { baselineSalesInstructions, PROTECTED_SALES_POLICY, SALES_POLICY_VERSION } from "../domain/sales-opt/policy.ts";
import { COMPLIANCE_CATEGORIES } from "../domain/sales-opt/analysis.ts";
import { SCENARIOS } from "../domain/sales-opt/evaluation.ts";
import { DEFAULT_THRESHOLDS, type SafetyThresholds } from "../domain/sales-opt/stats.ts";

const BASE = "/staff/sales-optimization";
const pct = (x: number | null, digits = 1) => (x === null ? "Unknown" : `${(x * 100).toFixed(digits)}%`);
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const back = (ctx: AppContext, text: string, kind: "success" | "error" = "success", to = BASE) => redirect(ctx, to, { kind, text });
const deps = (ctx: AppContext) => ({ db: ctx.db, env: ctx.env, fetch: ctx.env.overrides?.fetch ?? fetch, now: ctx.env.overrides?.now });
const now = (ctx: AppContext) => ctx.env.overrides?.now?.() ?? new Date();

/** Refusals render the page again with the reason and the refusal's status (409/422/429), like the other Owner pages. */
async function guarded(ctx: AppContext, fn: () => Promise<Response>, versionId?: string): Promise<Response> {
  try { return await fn(); } catch (e) {
    if (e instanceof reg.SalesOptError) return versionId ? versionPage(ctx, versionId, [e.message], e.status) : dashboard(ctx, [e.message], e.status);
    throw e;
  }
}

function versionStatusBadge(s: string): SafeHtml {
  const tone: Record<string, string> = { draft: "draft", evaluating: "in_progress", eval_failed: "failed", eval_passed: "recommended", approved: "approved", rejected: "rejected", retired: "archived" };
  return badge(tone[s] ?? s, label(s));
}

async function dashboard(ctx: AppContext, errors: string[] = [], status = 200) {
  requireStaff(ctx, "salesopt.read");
  const db = ctx.db;
  const t = now(ctx);
  await reg.ensureBaseline(db, baselineSalesInstructions());
  const ctl = await reg.loadControl(db);
  const targets = await reg.listTargets(db);
  const gate = await productionGate(db, ctx.env);
  const prod = await reg.deployedVersion(db, "production");
  const stg = await reg.deployedVersion(db, "staging");
  const from = new Date(t.getTime() - 30 * 86_400_000).toISOString();
  // KPI stage: production by default; ?stage=staging shows the staging agent's own measurements (validation runs).
  const kStage: reg.Stage = ctx.url.searchParams.get("stage") === "staging" ? "staging" : "production";
  const other: reg.Stage = kStage === "production" ? "staging" : "production";
  const m = await computeMetrics(db, { stage: kStage, from, to: t.toISOString() });
  const ms = await computeMetrics(db, { stage: other, from, to: t.toISOString() });
  const top = await topFindings(db, from);
  const versions = await reg.listVersions(db, 30);
  const evals = new Map((await db.prepare(`SELECT version_id, status, summary FROM so_eval_runs e WHERE created_at = (SELECT MAX(created_at) FROM so_eval_runs WHERE version_id = e.version_id)`).all<{ version_id: string; status: string; summary: string | null }>()).results.map((r) => [r.version_id, r]));
  const deployments = (await db.prepare(`SELECT d.*, v.seq FROM so_deployments d JOIN so_versions v ON v.id = d.version_id ORDER BY d.created_at DESC LIMIT 20`).all<{ id: string; stage: string; seq: number; kind: string; status: string; detail: string | null; created_at: string; published: number | null }>()).results;
  const incidents = (await db.prepare(`SELECT fi.category, fi.label, fi.created_at, f.stage, f.provider_call_id FROM so_findings fi JOIN so_call_facts f ON f.call_id = fi.call_id
      WHERE fi.basis = 'observed' AND fi.category IN (${[...COMPLIANCE_CATEGORIES].map(() => "?").join(",")}) ORDER BY fi.created_at DESC LIMIT 15`).bind(...COMPLIANCE_CATEGORIES)
    .all<{ category: string; label: string; created_at: string; stage: string; provider_call_id: string }>()).results;
  const proposals = (await db.prepare(`SELECT p.status, p.detail, p.created_at, v.seq FROM so_proposal_jobs p LEFT JOIN so_versions v ON v.id = p.version_id ORDER BY p.created_at DESC LIMIT 5`).all<{ status: string; detail: string | null; created_at: string; seq: number | null }>()).results;
  const jobs = (await db.prepare(`SELECT status, COUNT(*) AS n FROM ai_jobs WHERE workflow LIKE 'salesopt_%' AND created_at >= ? GROUP BY status`).bind(from).all<{ status: string; n: number }>()).results;
  const experiments = (await db.prepare(`SELECT e.*, b.seq AS bseq, c.seq AS cseq FROM so_experiments e JOIN so_versions b ON b.id = e.baseline_version_id JOIN so_versions c ON c.id = e.candidate_version_id ORDER BY e.created_at DESC LIMIT 5`)
    .all<{ id: string; status: string; bseq: number; cseq: number; candidate_share: number; min_connected_per_arm: number; decision: string | null; decision_detail: string | null; created_at: string }>()).results;
  const rbStaging = await rollbackCandidate(db, "staging"), rbProd = await rollbackCandidate(db, "production");
  // Runner status for sales-optimization jobs, from what the platform itself observed (ai_jobs + leases). A queued job
  // proves nothing about Node 1: only a claim (lease) or a completion stamped "self-hosted:<model>" does.
  const rj = (await db.prepare(`SELECT
      COALESCE(SUM(status = 'queued'), 0) AS queued, MIN(CASE WHEN status = 'queued' THEN created_at END) AS oldest_queued,
      COALESCE(SUM(status = 'running'), 0) AS running,
      COALESCE(SUM(status = 'failed' AND updated_at >= ?), 0) AS failed_30d
    FROM ai_jobs WHERE workflow LIKE 'salesopt_%'`).bind(from).first<{ queued: number; oldest_queued: string | null; running: number; failed_30d: number }>())!;
  // "ai.analysis_completed" is written only when a runner returned a model result for a sales-opt job (ai-runner.ts).
  const lastDone = await db.prepare(`SELECT created_at, details_json FROM audit_logs WHERE action = 'ai.analysis_completed' ORDER BY id DESC LIMIT 1`).first<{ created_at: string; details_json: string | null }>();
  let lastModel = "";
  try { const m = (JSON.parse(lastDone?.details_json ?? "{}") as { model?: unknown }).model; lastModel = typeof m === "string" ? m.slice(0, 80) : ""; } catch { lastModel = ""; }
  const failures = (await db.prepare(`SELECT error, COUNT(*) AS n FROM ai_jobs WHERE workflow LIKE 'salesopt_%' AND status = 'failed' AND updated_at >= ? GROUP BY error ORDER BY n DESC LIMIT 5`).bind(from).all<{ error: string | null; n: number }>()).results;
  const classify = (e: string | null) => !e ? "unknown" : /abandoned|did not complete/.test(e) ? "runner never finished (offline or not polling)" : /lease/.test(e) ? "runner lease expired (stopped mid-job)" : /local model|empty/.test(e) ? "model error on the runner" : e.slice(0, 80);
  const diag = (await db.prepare(`SELECT action, details_json, created_at FROM audit_logs WHERE action IN ('salesopt.ingest_failed','salesopt.deploy_failed','salesopt.deploy_aborted','salesopt.rollback_failed','salesopt.rollback_aborted','salesopt.proposal_rejected_automatically','salesopt.safety_breach','salesopt.webhook_replay_ignored','salesopt.wrong_workspace','salesopt.target_verified') ORDER BY id DESC LIMIT 10`)
    .all<{ action: string; details_json: string | null; created_at: string }>()).results;
  const ageMin = rj.oldest_queued ? Math.round((t.getTime() - Date.parse(rj.oldest_queued)) / 60_000) : null;
  const canDecide = !!ctx.actor && can(ctx.actor, "salesopt.decide");
  const th = ctl.thresholds;
  const latest = versions[0];

  const targetRow = (s: reg.Stage) => {
    const x = targets[s];
    return html`<tr><th scope="row">${label(s)}</th><td>${x ? html`<code>${x.agent_id}</code>` : html`<span class="faint">not registered</span>`}</td>
<td>${x?.verified_at ? (x.engine_type === "retell-llm" ? badge("verified", `Retell LLM ${x.llm_id ?? ""}`) : badge("failed", `Unsupported engine: ${x.engine_type ?? "unknown"}`)) : badge("not_configured", "Not verified")}</td>
<td>${x ? html`<form method="post" action="${BASE}/targets/${s}/verify">${csrf(ctx)}${button("Verify with Retell", { size: "sm", variant: "secondary" })}</form>` : ""}</td></tr>`;
  };

  const body = html`${pageHead("AI Sales Optimization", html`<form method="post" action="${BASE}/run" class="row">${csrf(ctx)}${button("Run cycle now", { size: "sm", variant: "secondary" })}</form>`, "AI")}
${formErrors(errors)}
${alert("warn", html`<strong>Scope.</strong> This engine evaluates and improves a <em>registered Retell sales agent</em>. It never places calls. This platform has no sales-calling path: outbound calls are limited to consented callbacks, reminders and support follow-ups (Founder decision D-14, MSA Sched. C.7). Enabling sales calling needs counsel's TCPA review and a separate, Founder-approved change.`)}
<p class="row"><span class="faint">Metrics shown for:</span> ${kStage === "production" ? html`<strong>production</strong> · <a href="${BASE}?stage=staging">staging</a>` : html`<a href="${BASE}">production</a> · <strong>staging</strong>`}</p>
${ctl.paused ? alert("info", "Optimization is paused: no analyses or proposals are queued. Safety monitoring keeps running.") : ""}

<div class="kpis grid grid-4">
${kpi("Production prompt version", prod ? `v${prod.seq}` : "None deployed", stg ? `Staging: v${stg.seq}` : "Staging: none")}
${kpi("Last optimization run", ctl.lastRunAt ? formatDateTime(ctl.lastRunAt) : "Never", ctl.lastRunDetail?.slice(0, 90) ?? undefined)}
${kpi(`Call attempts, ${kStage} (30 days)`, m.attempts, `${ms.attempts} on ${other} · test calls excluded`)}
${kpi("Connection rate", pct(m.connectionRate), `${m.connected} connected`)}
</div>
<div class="kpis grid grid-4">
${kpi("Verified conversion", pct(m.conversionRate, 2), m.connected ? `95% CI ${pct(m.conversionCi.low, 1)}–${pct(m.conversionCi.high, 1)} · ${m.sales} sales` : "No connected calls")}
${kpi("Attributed revenue", usd(m.revenueCents), `Stripe-verified, net of refunds/disputes · ${m.refundsOrDisputes} refunded/disputed`)}
${kpi("Opt-out rate", pct(m.optOutRate), `${m.optOuts} opt-outs`)}
${kpi("Compliance incidents", m.complianceFindings, `${pct(m.complianceRate)} of ${m.analysed} analysed calls`)}
</div>

<section class="card stack"><h2 class="card__title">Self-hosted model runner (Node 1)</h2>
${dl([
  ["Runner channel", ctx.env.BUILD_RUNNER_SECRET ? "BUILD_RUNNER_SECRET is set in this environment" : "BUILD_RUNNER_SECRET is not set: no runner can claim jobs"],
  ["Last job completed by a local model", lastDone ? `${formatDateTime(lastDone.created_at)}${lastModel ? ` (${lastModel})` : ""}` : "Never — no sales-optimization job has been completed by a self-hosted model in this environment"],
  ["Waiting", `${rj.queued} queued${ageMin !== null ? `, oldest ${ageMin} min` : ""} · ${rj.running} claimed and running`],
  ["Failed (30 days)", failures.length ? failures.map((f) => `${f.n}× ${classify(f.error)}`).join(" · ") : `${rj.failed_30d}`],
])}
<p class="faint">A queued job does not mean Node 1 is connected. Jobs not finished within 6 hours are abandoned; analyses then keep only the deterministic compliance checks, and evaluations end as errors (the version does not pass). Per-step runner tracing (D01–D13) is the Node diagnostics page of AI builds once that change is merged.</p>
</section>

<section class="card stack"><h2 class="card__title">Failure diagnostics</h2>
${diag.length ? table(diag, [
  { header: "When", cell: (r) => formatDateTime(r.created_at) },
  { header: "Event", cell: (r) => label(r.action.replace("salesopt.", "")) },
  { header: "Detail", cell: (r) => html`<span class="faint">${(r.details_json ?? "").slice(0, 160)}</span>` },
]) : html`<p class="faint">No ingestion, deployment, proposal or safety events yet.</p>`}
</section>

<section class="card stack"><h2 class="card__title">Integration health</h2>
${dl([
  ["Retell sales workspace key (RETELL_OUTBOUND_API_KEY)", ctx.env.RETELL_OUTBOUND_API_KEY ? "Set in this environment" : "Not set — nothing is sent to Retell"],
  ["Production deployment gate", gate.open ? "Open" : `Closed: ${gate.reasons.join("; ")}`],
  ["Self-hosted model jobs (30 days)", jobs.length ? jobs.map((j) => `${label(j.status)} ${j.n}`).join(" · ") : "None yet (needs the build runner with AI drafts enabled)"],
  ["Protected policy", `${SALES_POLICY_VERSION} (prices generated from the catalog)`],
  ["Attribution source", "Webhook-verified Stripe payments on orders linked to the call's lead (14-day window)"],
  ["Retell states (kept separate)", "1 draft prompt updated and read back — done here · 2 version published — Retell dashboard · 3 version assigned to a phone number — Retell Phone Numbers tab · 4 live traffic — never started by this platform"],
])}
<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Stage</th><th scope="col">Retell agent</th><th scope="col">Verified</th><th scope="col"></th></tr></thead><tbody>${targetRow("staging")}${targetRow("production")}</tbody></table></div>
${canDecide ? html`<form method="post" action="${BASE}/targets" class="row">${csrf(ctx)}${select({ name: "stage", label: "Stage", options: [{ value: "staging", label: "Staging" }, { value: "production", label: "Production" }] })}${input({ name: "agent_id", label: "Sales agent id (never the receptionist)", maxlength: 80, required: true })}${button("Register agent", { variant: "secondary" })}</form>` : ""}
</section>

${canDecide ? html`<form method="post" action="${BASE}/control" class="card stack">${csrf(ctx)}
<h2 class="card__title">Founder controls</h2>
${checkbox("paused", "Pause optimization (no new analyses or proposals)", { checked: ctl.paused })}
${checkbox("auto_rollback", "Roll back automatically to the last verified version when a safety limit is breached", { checked: ctl.autoRollback })}
${checkbox("production_activated", `Activate production deployments (also needs ${PRODUCTION_FLAG}=on in the production environment)`, { checked: ctl.productionActivated })}
<div class="grid grid-3">
${input({ name: "minConnected", label: "Minimum connected calls before judging", value: th.minConnected, maxlength: 6 })}
${input({ name: "maxOptOutRate", label: "Max opt-out rate (%)", value: +(th.maxOptOutRate * 100).toFixed(2), maxlength: 6 })}
${input({ name: "maxComplianceRate", label: "Max compliance rate (%)", value: +(th.maxComplianceRate * 100).toFixed(2), maxlength: 6 })}
${input({ name: "maxComplaintRate", label: "Max complaint rate (%)", value: +(th.maxComplaintRate * 100).toFixed(2), maxlength: 6 })}
${input({ name: "maxErrorRate", label: "Max error rate (%)", value: +(th.maxErrorRate * 100).toFixed(2), maxlength: 6 })}
${input({ name: "maxRefundRate", label: "Max refund/dispute rate (%)", value: +(th.maxRefundRate * 100).toFixed(2), maxlength: 6 })}
</div>
<div>${button("Save controls")}</div></form>` : ""}

<section class="section--tight"><h2>Top findings (30 days)</h2>${table(top, [
  { header: "Finding", cell: (r) => label(r.category) },
  { header: "Count", cell: (r) => r.count, numeric: true },
  { header: "Quoted in transcript", cell: (r) => r.observed, numeric: true },
], { empty: emptyState("No findings yet", "Findings appear after consented sales-call transcripts are analysed by the self-hosted model.") })}</section>

<section class="section--tight"><h2>Prompt versions and approval queue</h2>${table(versions, [
  { header: "Version", cell: (r) => html`<a href="${BASE}/versions/${r.id}">v${r.seq}</a>${r.parent_id ? html` <span class="faint">from v${versions.find((x) => x.id === r.parent_id)?.seq ?? "?"}</span>` : ""}` },
  { header: "Author", cell: (r) => r.author_kind === "ai" ? html`${badge("recommended", "AI")} <span class="faint">${r.author}</span>` : label(r.author_kind) },
  { header: "Status", cell: (r) => versionStatusBadge(r.status) },
  { header: "Evaluation", cell: (r) => { const e = evals.get(r.id); return e ? html`${badge(e.status === "passed" ? "pass" : e.status === "running" ? "in_progress" : "fail", label(e.status))} <span class="faint">${e.summary ?? ""}</span>` : html`<span class="faint">not run</span>`; } },
  { header: "Created", cell: (r) => formatDateTime(r.created_at) },
  { header: "Live on", cell: (r) => [prod?.id === r.id ? "production" : "", stg?.id === r.id ? "staging" : ""].filter(Boolean).join(", ") || "—" },
], { empty: emptyState("No versions", "Version 1 is created from the platform baseline.") })}
${proposals.length ? html`<p class="faint">Recent AI proposals: ${proposals.map((p) => `${label(p.status)}${p.seq ? ` (v${p.seq})` : ""}${p.detail ? ` — ${p.detail.slice(0, 120)}` : ""}`).join(" · ")}</p>` : ""}
${canDecide && !ctl.paused ? html`<form method="post" action="${BASE}/run" class="row">${csrf(ctx)}<input type="hidden" name="propose" value="1">${button("Ask the self-hosted model for a proposal now", { size: "sm", variant: "ghost" })}</form>` : ""}
</section>

<section class="section--tight"><h2>Deployment history</h2>${table(deployments, [
  { header: "When", cell: (r) => formatDateTime(r.created_at) },
  { header: "Stage", cell: (r) => label(r.stage) },
  { header: "Version", cell: (r) => `v${r.seq}` },
  { header: "Kind", cell: (r) => label(r.kind) },
  { header: "Result", cell: (r) => html`${badge(r.status === "verified" ? "verified" : r.status === "in_progress" ? "in_progress" : r.status === "superseded" ? "closed" : "failed", label(r.status))}${r.stage === "production" && r.status === "verified" && r.published === 0 ? html` ${badge("requires_founder_approval", "Publish in Retell")}` : ""}` },
  { header: "Detail", cell: (r) => html`<span class="faint">${(r.detail ?? "").slice(0, 200)}</span>` },
], { empty: emptyState("Nothing deployed yet", "Deploy an evaluated version to the staging agent first.") })}
${canDecide ? html`<div class="row">${rbStaging ? html`<form method="post" action="${BASE}/rollback">${csrf(ctx)}<input type="hidden" name="stage" value="staging">${button("Roll back staging", { size: "sm", variant: "danger" })}</form>` : ""}
${rbProd ? html`<form method="post" action="${BASE}/rollback">${csrf(ctx)}<input type="hidden" name="stage" value="production">${button("Roll back production to last known-good", { size: "sm", variant: "danger" })}</form>` : ""}</div>` : ""}
</section>

<section class="section--tight"><h2>Experiments</h2>${table(experiments, [
  { header: "Created", cell: (r) => formatDateTime(r.created_at) },
  { header: "Baseline → candidate", cell: (r) => `v${r.bseq} → v${r.cseq}` },
  { header: "Candidate share", cell: (r) => pct(r.candidate_share, 0), numeric: true },
  { header: "Minimum per arm", cell: (r) => r.min_connected_per_arm, numeric: true },
  { header: "Status", cell: (r) => badge(r.status === "running" ? "in_progress" : r.status === "proposed" ? "requires_founder_approval" : "closed", label(r.status)) },
  { header: "Recommendation", cell: (r) => html`${r.decision ? label(r.decision) : "—"} <span class="faint">${r.decision_detail ?? ""}</span>` },
  { header: "", cell: (r) => canDecide && ["proposed", "running"].includes(r.status) ? html`<form method="post" action="${BASE}/experiments/${r.id}/decide" class="row">${csrf(ctx)}${r.status === "proposed" ? button("Start", { size: "sm", name: "action", value: "start" }) : ""}${button("Stop", { size: "sm", variant: "danger", name: "action", value: "stop" })}</form>` : "" },
], { empty: emptyState("No experiments", "An experiment compares the production version with an evaluated candidate on balanced traffic.") })}
${canDecide && prod ? html`<form method="post" action="${BASE}/experiments" class="row">${csrf(ctx)}<input type="hidden" name="baseline_id" value="${prod.id}">
${select({ name: "candidate_id", label: "Candidate", options: versions.filter((v) => ["eval_passed", "approved"].includes(v.status) && v.id !== prod.id).map((v) => ({ value: v.id, label: `v${v.seq}` })), includeBlank: "Choose…" })}
${input({ name: "share", label: "Candidate share (%)", value: 20, maxlength: 2 })}${input({ name: "min", label: "Minimum connected calls per arm", value: 400, maxlength: 6 })}${button("Propose experiment", { variant: "secondary" })}</form>
<p class="faint">Nothing in this platform places sales calls, so an experiment only splits traffic once a Founder-approved dialler uses the routing described in docs/voice/SALES-OPTIMIZATION.md.</p>` : ""}
</section>

<section class="section--tight"><h2>Compliance incidents</h2>${table(incidents, [
  { header: "When", cell: (r) => formatDateTime(r.created_at) },
  { header: "Stage", cell: (r) => label(r.stage) },
  { header: "Type", cell: (r) => badge("failed", label(r.category)) },
  { header: "Finding", cell: (r) => r.label },
  { header: "Retell call", cell: (r) => html`<code>${r.provider_call_id}</code>` },
], { empty: emptyState("No compliance incidents recorded", "Observed policy breaches (quoted from transcripts or found by deterministic checks) appear here.") })}</section>

${latest ? html`<section class="card stack"><h2 class="card__title">New version</h2>
<p class="faint">Edits the optimizable instructions only. The protected policy is prepended automatically and cannot be changed here.</p>
<form method="post" action="${BASE}/versions" class="stack">${csrf(ctx)}<input type="hidden" name="parent_id" value="${latest.id}">
${textarea({ name: "instructions", label: `Instructions (based on v${latest.seq})`, value: latest.instructions, rows: 14, maxlength: 12_000, required: true })}
${input({ name: "rationale", label: "Why this change", maxlength: 500, required: true })}
<div>${button("Save as new version", { variant: "secondary" })}</div></form>
<details><summary>Protected policy (read-only)</summary><pre class="code-block">${PROTECTED_SALES_POLICY}</pre></details></section>` : ""}`;
  return staffPage(ctx, "AI Sales Optimization", body, status);
}

async function versionPage(ctx: AppContext, id: string, errors: string[] = [], status = 200) {
  requireStaff(ctx, "salesopt.read");
  const db = ctx.db;
  const v = await reg.getVersion(db, id);
  if (!v) throw new HttpError(404, "Version not found");
  const parent = v.parent_id ? await reg.getVersion(db, v.parent_id) : null;
  const run = await db.prepare(`SELECT * FROM so_eval_runs WHERE version_id = ? ORDER BY created_at DESC LIMIT 1`).bind(id).first<{ id: string; status: string; summary: string | null; created_at: string }>();
  const results = run ? (await db.prepare(`SELECT scenario, status, assertions_json FROM so_eval_results WHERE run_id = ?`).bind(run.id).all<{ scenario: string; status: string; assertions_json: string }>()).results : [];
  const prod = await reg.deployedVersion(db, "production");
  const stg = await reg.deployedVersion(db, "staging");
  const t = now(ctx);
  const from = new Date(t.getTime() - 30 * 86_400_000).toISOString();
  const mine = await computeMetrics(db, { from, to: t.toISOString(), versionId: v.id });
  const base = prod && prod.id !== v.id ? await computeMetrics(db, { from, to: t.toISOString(), versionId: prod.id }) : null;
  const canDecide = !!ctx.actor && can(ctx.actor, "salesopt.decide");
  let evidence: unknown[] = [];
  try { evidence = JSON.parse(v.evidence_json) as unknown[]; } catch { evidence = []; }
  const changes = (evidence[0] as { changes?: { area: string; change: string; evidence: string[] }[] } | undefined)?.changes ?? [];
  const cited = evidence.slice(changes.length ? 1 : 0) as { id: string; category: string }[];
  const found = cited.length ? new Map((await db.prepare(`SELECT id, label, evidence_quote FROM so_findings WHERE id IN (${cited.map(() => "?").join(",")})`).bind(...cited.map((c) => c.id)).all<{ id: string; label: string; evidence_quote: string | null }>()).results.map((r) => [r.id, r])) : new Map<string, { label: string; evidence_quote: string | null }>();
  const diff = lineDiff(parent?.instructions ?? "", v.instructions);
  const metricRow = (name: string, a: string, b: string | null) => html`<tr><th scope="row">${name}</th><td class="num">${a}</td><td class="num">${b ?? "—"}</td></tr>`;

  const body = html`${pageHead(`Version ${v.seq}`, linkButton("All versions", BASE, "ghost", "sm"), "AI Sales Optimization")}
${formErrors(errors)}
<section class="card stack">${dl([
  ["Status", versionStatusBadge(v.status)],
  ["Author", v.author_kind === "ai" ? `Self-hosted model (${v.author})` : v.author_kind === "import" ? "Platform baseline" : "Staff"],
  ["Parent", parent ? `v${parent.seq}` : "None"],
  ["Rationale", v.rationale],
  ["Policy", v.policy_version],
  ["Prompt SHA-256", html`<code>${v.prompt_sha256.slice(0, 16)}…</code>`],
  ["Approved", v.approved_at ? `${formatDateTime(v.approved_at)}` : "No"],
  ["Live", [prod?.id === v.id ? "production" : "", stg?.id === v.id ? "staging" : ""].filter(Boolean).join(", ") || "No"],
])}
<div class="row">
${["draft", "eval_failed", "eval_passed", "approved", "retired"].includes(v.status) ? html`<form method="post" action="${BASE}/versions/${v.id}/evaluate">${csrf(ctx)}${button("Run evaluation", { size: "sm", variant: "secondary" })}</form>` : ""}
${canDecide && v.status === "eval_passed" ? html`<form method="post" action="${BASE}/versions/${v.id}/decide" class="row">${csrf(ctx)}${button("Approve for production", { size: "sm", name: "decision", value: "approve" })}${button("Reject", { size: "sm", variant: "danger", name: "decision", value: "reject" })}</form>` : ""}
${canDecide && v.status === "draft" ? html`<form method="post" action="${BASE}/versions/${v.id}/decide">${csrf(ctx)}${button("Reject", { size: "sm", variant: "danger", name: "decision", value: "reject" })}</form>` : ""}
${canDecide && ["eval_passed", "approved"].includes(v.status) && stg?.id !== v.id ? html`<form method="post" action="${BASE}/deploy">${csrf(ctx)}<input type="hidden" name="stage" value="staging"><input type="hidden" name="version_id" value="${v.id}"><input type="hidden" name="expected_current" value="${stg?.id ?? ""}">${button("Deploy to staging agent", { size: "sm", variant: "secondary" })}</form>` : ""}
${canDecide && v.status === "approved" && prod?.id !== v.id ? html`<form method="post" action="${BASE}/deploy">${csrf(ctx)}<input type="hidden" name="stage" value="production"><input type="hidden" name="version_id" value="${v.id}"><input type="hidden" name="expected_current" value="${prod?.id ?? ""}">${button("Deploy to production agent", { size: "sm" })}</form>` : ""}
</div></section>

${changes.length ? html`<section class="section--tight"><h2>Proposed changes and evidence</h2>${table(changes, [
  { header: "Area", cell: (r) => label(r.area) },
  { header: "Change", cell: (r) => r.change },
  { header: "Evidence", cell: (r) => html`${r.evidence.map((id) => { const c = cited.find((x) => x.id === id); const f = found.get(id); return html`<div><span class="faint">${c ? label(c.category) : id}:</span> ${f?.label ?? "(finding no longer retained)"}${f?.evidence_quote ? html` — <q>${f.evidence_quote.slice(0, 200)}</q>` : ""}</div>`; })}` },
])}</section>` : ""}

<section class="section--tight"><h2>Changes from ${parent ? `v${parent.seq}` : "nothing"}</h2>
<pre class="code-block diff">${diff.map((d) => html`<span class="diff__${d.op === "+" ? "add" : d.op === "-" ? "del" : "ctx"}">${d.op} ${d.text}\n</span>`)}</pre></section>

<section class="section--tight"><h2>Evaluation ${run ? html`${badge(run.status === "passed" ? "pass" : run.status === "running" ? "in_progress" : "fail", label(run.status))}` : ""}</h2>
<p class="faint">Simulated with the self-hosted model and checked by deterministic policy assertions. Passing shows policy adherence on ${SCENARIOS.length} scripted scenarios; it does not show real-world sales performance.</p>
${table(SCENARIOS.map((s) => ({ s, r: results.find((x) => x.scenario === s.id) })), [
  { header: "Scenario", cell: (x) => x.s.title },
  { header: "Result", cell: (x) => x.r ? badge(x.r.status === "passed" ? "pass" : x.r.status === "queued" ? "queued" : "fail", label(x.r.status)) : html`<span class="faint">not run</span>` },
  { header: "Failed checks", cell: (x) => { if (!x.r) return ""; const a = JSON.parse(x.r.assertions_json) as { id: string; ok: boolean; detail: string }[]; const bad = a.filter((y) => !y.ok); return bad.length ? html`${bad.map((y) => html`<div><code>${y.id}</code> <span class="faint">${y.detail}</span></div>`)}` : "—"; } },
])}</section>

<section class="section--tight"><h2>Measured performance (30 days)</h2>
<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Metric</th><th scope="col" class="num">v${v.seq}</th><th scope="col" class="num">${prod && prod.id !== v.id ? `Production v${prod.seq}` : "Baseline"}</th></tr></thead><tbody>
${metricRow("Connected calls", String(mine.connected), base ? String(base.connected) : null)}
${metricRow("Verified conversion", pct(mine.conversionRate, 2), base ? pct(base.conversionRate, 2) : null)}
${metricRow("Revenue per connected call", mine.revenuePerConnectedCents === null ? "Unknown" : usd(mine.revenuePerConnectedCents), base ? (base.revenuePerConnectedCents === null ? "Unknown" : usd(base.revenuePerConnectedCents)) : null)}
${metricRow("Opt-out rate", pct(mine.optOutRate), base ? pct(base.optOutRate) : null)}
${metricRow("Compliance rate", pct(mine.complianceRate), base ? pct(base.complianceRate) : null)}
${metricRow("Average duration", mine.avgDurationS === null ? "Unknown" : `${mine.avgDurationS}s`, base ? (base.avgDurationS === null ? "Unknown" : `${base.avgDurationS}s`) : null)}
</tbody></table></div>
<p class="faint">Versions running in different periods or on different lead segments are not like-for-like; use an experiment for a controlled comparison.</p></section>

<details class="card"><summary><strong>Instructions</strong></summary><pre class="code-block">${v.instructions}</pre></details>`;
  return staffPage(ctx, `Sales prompt v${v.seq}`, body, status);
}

const pctField = (f: FormData, k: keyof SafetyThresholds) => { const n = Number(str(f, k)); return Number.isFinite(n) && n > 0 && n <= 100 ? n / 100 : DEFAULT_THRESHOLDS[k]; };

export function register(r: Router): void {
  r.get(BASE, (ctx) => dashboard(ctx));
  r.get(`${BASE}/versions/:id`, (ctx, p) => versionPage(ctx, p.id));

  r.post(`${BASE}/control`, async (ctx) => {
    requireStaff(ctx, "salesopt.decide");
    const f = await ctx.form();
    const minC = Number(str(f, "minConnected"));
    await reg.setControl(ctx.db, ctx.user!.id, {
      paused: !!f.get("paused"), autoRollback: !!f.get("auto_rollback"), productionActivated: !!f.get("production_activated"),
      thresholds: { minConnected: Number.isInteger(minC) && minC >= 20 && minC <= 100_000 ? minC : DEFAULT_THRESHOLDS.minConnected,
        maxOptOutRate: pctField(f, "maxOptOutRate"), maxComplianceRate: pctField(f, "maxComplianceRate"), maxComplaintRate: pctField(f, "maxComplaintRate"),
        maxErrorRate: pctField(f, "maxErrorRate"), maxRefundRate: pctField(f, "maxRefundRate") },
    });
    return back(ctx, "Controls saved.");
  });

  r.post(`${BASE}/targets`, (ctx) => guarded(ctx, async () => {
    requireStaff(ctx, "salesopt.decide");
    const f = await ctx.form();
    const stage = str(f, "stage") === "production" ? "production" : "staging";
    await reg.setTarget(ctx.db, ctx.user!.id, stage, str(f, "agent_id"));
    return back(ctx, `${label(stage)} sales agent registered. Verify it with Retell next.`);
  }));

  r.post(`${BASE}/targets/:stage/verify`, async (ctx, p) => {
    requireStaff(ctx, "salesopt.decide");
    if (p.stage !== "staging" && p.stage !== "production") throw new HttpError(404, "Unknown stage");
    const res = await verifyTarget(deps(ctx), p.stage, ctx.user!.id);
    return res.ok ? back(ctx, res.detail) : dashboard(ctx, [res.detail], 409);
  });

  r.post(`${BASE}/versions`, (ctx) => guarded(ctx, async () => {
    requireStaff(ctx, "salesopt.read");
    const f = await ctx.form();
    const v = await reg.createVersion(ctx.db, { parentId: str(f, "parent_id") || null, instructions: String(f.get("instructions") ?? ""), rationale: str(f, "rationale"), authorKind: "user", author: ctx.user!.id, actorUserId: ctx.user!.id });
    return back(ctx, `Version ${v.seq} saved. Run its evaluation next.`, "success", `${BASE}/versions/${v.id}`);
  }));

  r.post(`${BASE}/versions/:id/evaluate`, (ctx, p) => guarded(ctx, async () => {
    requireStaff(ctx, "salesopt.read");
    const res = await startEvaluation(ctx.db, p.id, ctx.user!.id);
    if (!res.staticOk) return versionPage(ctx, p.id, [`Static policy checks failed: ${res.problems.join(" ")}`], 422);
    return back(ctx, `Evaluation queued: ${SCENARIOS.length} scenarios for the self-hosted model.`, "success", `${BASE}/versions/${p.id}`);
  }, p.id));

  r.post(`${BASE}/versions/:id/decide`, (ctx, p) => guarded(ctx, async () => {
    requireStaff(ctx, "salesopt.decide");
    const f = await ctx.form();
    const approve = str(f, "decision") === "approve";
    await reg.transition(ctx.db, p.id, approve ? "approved" : "rejected", { userId: ctx.user!.id, note: str(f, "note") || null });
    return back(ctx, approve ? "Version approved. Deploy it to staging, verify, then to production." : "Version rejected.", "success", `${BASE}/versions/${p.id}`);
  }, p.id));

  r.post(`${BASE}/deploy`, (ctx) => guarded(ctx, async () => {
    requireStaff(ctx, "salesopt.decide");
    const f = await ctx.form();
    const stage = str(f, "stage") === "production" ? "production" : "staging";
    const res = await deploy(deps(ctx), { stage, versionId: str(f, "version_id"), expectedCurrentVersionId: str(f, "expected_current") || null, kind: "deploy", userId: ctx.user!.id, reason: `Founder deployment from dashboard` });
    if (res.status !== "verified") return dashboard(ctx, [`${label(stage)} deployment ${res.status}: ${res.detail}`], 409);
    return back(ctx, `${label(stage)} deployment verified: ${res.detail}`);
  }));

  r.post(`${BASE}/rollback`, (ctx) => guarded(ctx, async () => {
    requireStaff(ctx, "salesopt.decide");
    const f = await ctx.form();
    const stage = str(f, "stage") === "production" ? "production" : "staging";
    const res = await rollback(deps(ctx), stage, ctx.user!.id, "Founder rollback from dashboard");
    if (res.status !== "verified") return dashboard(ctx, [`${label(stage)} rollback ${res.status}: ${res.detail}`], 409);
    return back(ctx, `${label(stage)} rollback verified: ${res.detail}`);
  }));

  r.post(`${BASE}/experiments`, (ctx) => guarded(ctx, async () => {
    requireStaff(ctx, "salesopt.decide");
    const f = await ctx.form();
    await proposeExperiment(ctx.db, ctx.user!.id, { baselineId: str(f, "baseline_id"), candidateId: str(f, "candidate_id"), candidateShare: Number(str(f, "share")) / 100, minConnectedPerArm: Number(str(f, "min")) });
    return back(ctx, "Experiment proposed. Start it when the dialler is ready.");
  }));

  r.post(`${BASE}/experiments/:id/decide`, (ctx, p) => guarded(ctx, async () => {
    requireStaff(ctx, "salesopt.decide");
    const f = await ctx.form();
    const action = str(f, "action") === "start" ? "start" : "stop";
    await decideExperimentStatus(ctx.db, ctx.user!.id, p.id, action);
    if (action === "stop") { const rep = await experimentReport(ctx.db, p.id, now(ctx)); return back(ctx, `Experiment stopped. ${rep?.decision.detail ?? ""}`); }
    return back(ctx, "Experiment started.");
  }));

  r.post(`${BASE}/run`, (ctx) => guarded(ctx, async () => {
    requireStaff(ctx, "salesopt.decide");
    const f = await ctx.form();
    if (f.get("propose")) {
      const msg = await maybeQueueProposal(ctx.db, now(ctx), { force: true });
      await audit(ctx.db, { actorUserId: ctx.user!.id, action: "salesopt.proposal_requested", subjectType: "so_control", subjectId: "1", details: { result: msg.slice(0, 80) } });
      return back(ctx, `Proposal: ${msg}.`);
    }
    const detail = await runSalesOpt(deps(ctx));
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "salesopt.cycle_run", subjectType: "so_control", subjectId: "1" });
    return back(ctx, `Cycle complete: ${detail.slice(0, 300)}`);
  }));
}
