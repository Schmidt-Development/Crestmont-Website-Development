// AI Builds — runner API (signed), owner dashboard ("AI builds"), JSON contract for the frontend session,
// and the customer-facing summary. Contract: docs/ai-builds/FRONTEND-CONTRACT.md, protocol: RUNNER-PROTOCOL.md.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, type SafeHtml } from "../lib/html.ts";
import { HttpError, jsonResponse, redirect, str } from "../app/http.ts";
import { requireStaff, requireCustomerOrg } from "../app/app.ts";
import { can } from "../domain/authz.ts";
import { BUILD_STATES, BUILD_STATE_LABELS, BUILD_STATE_CUSTOMER, type BuildState } from "../domain/builds.ts";
import { alert, badge, button, csrf, dl, emptyState, input, kpi, pageHead, pageParam, pagination, select, table, textarea, checkbox, actionForm, linkButton } from "../ui/components.ts";
import { staffPage } from "./crm.ts";
import * as B from "../services/builds.ts";
import * as AIR from "../services/ai-runner.ts";
import * as D from "../services/site-delivery.ts";
import * as W from "../services/build-workers.ts";
import * as PL from "../services/build-pipeline.ts";
import { notify } from "../services/notifications.ts";

const RUNNER = "/api/builds/runner";
const usd = (n: number) => `$${n.toFixed(2)}`;
const dur = (s: number | null) => s === null ? "—" : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
const STATE_BADGE: Partial<Record<BuildState, string>> = { ready_for_review: "ok", approved: "ok", failed: "bad", canceled: "muted", needs_information: "warn", budget_paused: "warn", paused: "warn", building: "info", verifying: "info", preparing: "info", queued: "info" };
const stateBadge = (s: BuildState) => badge(STATE_BADGE[s] ?? "info", BUILD_STATE_LABELS[s]);

class RunnerUnavailable extends Error {}
const unavailable = (ctx: AppContext) => jsonResponse(ctx, 503, { error: "Build runner not configured" });
/** Runner endpoint wrapper: without the Worker secret, execution is unavailable (503), not an internal error. */
const runnerRoute = (fn: (ctx: AppContext) => Promise<Response>) => async (ctx: AppContext) => {
  if (!ctx.env.BUILD_RUNNER_SECRET) return unavailable(ctx);
  try { return await fn(ctx); } catch (e) { if (e instanceof RunnerUnavailable) return unavailable(ctx); throw e; }
};

async function runnerBody(ctx: AppContext): Promise<Record<string, unknown>> {
  const raw = await ctx.req.text();
  if (raw.length > 30_000_000) throw new HttpError(413, "Request too large");
  await B.verifyRunnerSignature(ctx.env.BUILD_RUNNER_SECRET, raw, ctx.req.headers.get("x-crestmont-runner-signature"));
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, "Malformed JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
  return body as Record<string, unknown>;
}

/** Owner / administrator / PM alerts when a build needs a person. */
async function notifyStaff(ctx: AppContext, job: B.BuildJob, to: BuildState) {
  if (!["ready_for_review", "needs_information", "failed", "budget_paused"].includes(to)) return;
  const pm = await ctx.db.prepare(`SELECT project_manager_id FROM projects WHERE id = ?`).bind(job.project_id).first<{ project_manager_id: string | null }>();
  const owners = (await ctx.db.prepare(`SELECT DISTINCT user_id FROM memberships WHERE role_id = 'owner'`).all<{ user_id: string }>()).results.map((r) => r.user_id);
  const body = to === "ready_for_review" ? "An AI first build is ready for owner review." : to === "needs_information" ? "An AI build needs information before it can continue."
    : to === "failed" ? "An AI build failed after its retries." : "An AI build stopped at its spending limit.";
  for (const u of new Set([...owners, ...(pm?.project_manager_id ? [pm.project_manager_id] : [])])) await notify(ctx.db, u, { kind: "build", subjectType: "build_job", subjectId: job.id, body });
}

/** Off-site redirect to a preview sign-in link: never cached, never leaks the link as a referrer. */
function previewRedirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export function register(r: Router): void {
  // ───── Runner API (HMAC-signed; no cookies) ─────
  r.post(`${RUNNER}/claim`, runnerRoute(async (ctx) => { const b = await runnerBody(ctx); return jsonResponse(ctx, 200, await B.claimJob(ctx.db, { runnerId: typeof b.runnerId === "string" ? b.runnerId : "", version: typeof b.version === "string" ? b.version : "", capabilities: b.capabilities, workerId: b.workerId, workerKey: b.workerKey, status: b.workerStatus }, ctx.now(), { allowPaidProvider: ctx.env.BUILD_ALLOW_PAID_PROVIDER === "true" })); }));
  r.post(`${RUNNER}/heartbeat`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.heartbeat(ctx.db, await runnerBody(ctx), ctx.now()))));
  r.post(`${RUNNER}/checkpoint`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.checkpoint(ctx.db, ctx.storage, await runnerBody(ctx)))));
  r.post(`${RUNNER}/checkpoint/fetch`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.fetchCheckpoint(ctx.db, ctx.storage, await runnerBody(ctx)))));
  // Self-hosted AI drafts (ai_jobs with provider local-runner), same signed channel.
  r.post(`${RUNNER}/ai/claim`, runnerRoute(async (ctx) => { const b = await runnerBody(ctx); return jsonResponse(ctx, 200, await AIR.claimAiJob(ctx.db, typeof b.runnerId === "string" ? b.runnerId : "", ctx.now())); }));
  r.post(`${RUNNER}/ai/complete`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await AIR.completeAiJob(ctx.db, await runnerBody(ctx)))));
  // Preview lifecycle (protocol v1.2): previews to delete, and the runner's report for each.
  // Customer production delivery (protocol v1.4; Founder decision D5): Owner-authorized releases only.
  r.post(`${RUNNER}/deployments/claim`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await D.claimDeployment(ctx.db, await runnerBody(ctx), ctx.now()))));
  r.post(`${RUNNER}/deployments/complete`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await D.completeDeployment(ctx.db, await runnerBody(ctx), ctx))));
  // Architecture V2 (local orchestrator ⇄ platform): specification, review cycles, integrations, approvals, worker status.
  const leasedBody = async (ctx: AppContext) => { const b = await runnerBody(ctx); return { b, job: await B.leasedJob(ctx.db, b.jobId, b.leaseToken) }; };
  r.post(`${RUNNER}/pipeline/spec`, runnerRoute(async (ctx) => { const { b, job } = await leasedBody(ctx); return jsonResponse(ctx, 200, await PL.storeSpec(ctx.db, job, b.spec, String(b.provider ?? ""))); }));
  r.post(`${RUNNER}/cycles/submit`, runnerRoute(async (ctx) => { const { b, job } = await leasedBody(ctx); return jsonResponse(ctx, 200, await PL.submitCycle(ctx.db, job, b)); }));
  r.post(`${RUNNER}/integrations/report`, runnerRoute(async (ctx) => { const { b, job } = await leasedBody(ctx); return jsonResponse(ctx, 200, await PL.reportIntegrations(ctx.db, job, b.items)); }));
  r.post(`${RUNNER}/approvals/request`, runnerRoute(async (ctx) => { const { b, job } = await leasedBody(ctx); return jsonResponse(ctx, 200, await PL.requestApproval(ctx.db, job, b, String(b.runnerId ?? "runner"))); }));
  r.post(`${RUNNER}/approvals/list`, runnerRoute(async (ctx) => { const { job } = await leasedBody(ctx); return jsonResponse(ctx, 200, { approvals: await PL.approvalsForJob(ctx.db, job.id) }); }));
  r.post(`${RUNNER}/workers/status`, runnerRoute(async (ctx) => {
    const b = await runnerBody(ctx);
    const w = await W.authenticateWorker(ctx.db, b.workerId, b.workerKey);
    await W.recordWorkerStatus(ctx.db, w, typeof b.runnerId === "string" ? b.runnerId.slice(0, 64) : "", b.status && typeof b.status === "object" ? b.status as Record<string, unknown> : {}, ctx.now());
    return jsonResponse(ctx, 200, { ok: true });
  }));
  r.post(`${RUNNER}/previews/claim`, runnerRoute(async (ctx) => { await runnerBody(ctx); return jsonResponse(ctx, 200, await B.claimExpiredPreviews(ctx.db, ctx.now())); }));
  r.post(`${RUNNER}/previews/deleted`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.reportPreviewDeleted(ctx.db, await runnerBody(ctx)))));
  r.post(`${RUNNER}/requirements`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.reportRequirements(ctx.db, await runnerBody(ctx)))));
  r.post(`${RUNNER}/files`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.runnerFile(ctx.db, ctx.storage, await runnerBody(ctx)))));
  r.post(`${RUNNER}/complete`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.completeJob(ctx.db, await runnerBody(ctx), (j, to) => notifyStaff(ctx, j, to), { previewHosts: B.previewHostList(ctx.env.BUILD_PREVIEW_HOSTS) }))));

  // ───── JSON contract for the dashboard frontend (staff session) ─────
  r.get("/api/builds", async (ctx) => {
    requireStaff(ctx, "builds.read");
    const { limit, offset } = pageParam(ctx);
    const state = ctx.url.searchParams.get("state") ?? "";
    const rows = await B.listBuilds(ctx.db, { state: (BUILD_STATES as readonly string[]).includes(state) ? state : undefined, q: (ctx.url.searchParams.get("q") ?? "").slice(0, 80) || undefined, limit: limit + 1, offset });
    const s = await B.getBuildSettings(ctx.db);
    return jsonResponse(ctx, 200, {
      settings: settingsView(s), runner: await B.runnerStatus(ctx.db, ctx.now()),
      builds: await Promise.all(rows.slice(0, limit).map((j) => B.summarize(ctx.db, j, ctx.now()))), hasMore: rows.length > limit,
      customerRevisions: await B.customerRevisionQueue(ctx.db),
    });
  });
  r.get("/api/builds/:id", async (ctx, p) => {
    requireStaff(ctx, "builds.read");
    const d = await B.buildDetail(ctx.db, p.id);
    const { job, ...rest } = d;
    return jsonResponse(ctx, 200, { ...rest, instruction: job.instruction, kind: job.kind, revision: job.revision, agentSessionId: job.agent_session_id, checkpointAvailable: !!job.checkpoint_key });
  });

  // ───── Owner dashboard ─────
  r.get("/staff/builds", async (ctx) => {
    requireStaff(ctx, "builds.read");
    const { page, limit, offset } = pageParam(ctx);
    const state = ctx.url.searchParams.get("state") ?? "";
    const q = (ctx.url.searchParams.get("q") ?? "").slice(0, 80);
    const rows = await B.listBuilds(ctx.db, { state: (BUILD_STATES as readonly string[]).includes(state) ? state : undefined, q: q || undefined, limit: limit + 1, offset });
    const sums = await Promise.all(rows.slice(0, limit).map((j) => B.summarize(ctx.db, j, ctx.now())));
    const s = await B.getBuildSettings(ctx.db);
    const runner = await B.runnerStatus(ctx.db, ctx.now());
    const counts = Object.fromEntries((await ctx.db.prepare(`SELECT state, COUNT(*) AS n FROM build_jobs GROUP BY state`).all<{ state: string; n: number }>()).results.map((r) => [r.state, r.n]));
    const configure = can(ctx.actor!, "builds.configure");
    const manageBuilds = can(ctx.actor!, "builds.manage");
    const custRevs = await B.customerRevisionQueue(ctx.db);
    const modeText: Record<B.CustomerRevisionMode, string> = {
      off: "Off: customer revision requests are handled by staff only.",
      owner_approval: "Owner approval (Founder decision): every request waits here until an owner approves it (it then enters the build queue) or rejects it (no AI build; the customer is told why).",
      auto: "Automatic: entitled requests are queued as AI revisions when the project is eligible.",
    };
    const entitlement = (r: B.CustomerRevision) => r.included ? badge("ok", "Included round") : r.entitled ? badge("ok", "Change order approved") : badge("warn", r.changeOrderStatus ? `Change order ${r.changeOrderStatus}` : "Change order required");
    const body = html`${pageHead("AI builds", undefined, "Automated first builds for paid intakes")}
${!ctx.env.BUILD_RUNNER_SECRET ? alert("warn", html`<strong>Execution unavailable.</strong> No build runner is configured on this environment (BUILD_RUNNER_SECRET is not set), so eligible builds wait in the queue and nothing is generated. Setup: docs/ai-builds/RUNNER-SETUP.md.`)
  : runner?.online ? alert("success", `Runner ${runner.runner_id} (v${runner.version ?? "?"}) last checked in ${formatDateTime(runner.last_seen_at)}.`)
  : alert("warn", runner ? `Runner ${runner.runner_id} last checked in ${formatDateTime(runner.last_seen_at)}; it is not polling now, so queued builds are waiting.` : "No build runner has connected yet; queued builds are waiting.")}
${runner && !runner.zeroCost && ctx.env.BUILD_ALLOW_PAID_PROVIDER !== "true" ? alert("warn", html`<strong>Paid provider refused.</strong> Runner ${runner.runner_id} does not declare zero token cost (a paid model provider), so it gets no builds. Paid AI needs BUILD_ALLOW_PAID_PROVIDER=true on this environment as well as the runner's own opt-in; budgets still apply.`) : ""}
${s.globally_paused ? alert("warn", html`<strong>Automation paused.</strong> ${s.pause_reason ?? ""}`) : ""}
<div class="kpis">${kpi("Queued", counts.queued ?? 0)}${kpi("Running", (counts.preparing ?? 0) + (counts.building ?? 0) + (counts.verifying ?? 0))}${kpi("In owner review", counts.ready_for_review ?? 0)}${kpi("Need attention", (counts.needs_information ?? 0) + (counts.failed ?? 0) + (counts.budget_paused ?? 0))}</div>
<form method="get" class="filters row">${select({ name: "state", label: "State", options: BUILD_STATES.map((x) => ({ value: x, label: BUILD_STATE_LABELS[x] })), value: state, includeBlank: "All states" })}${input({ name: "q", label: "Search", value: q, placeholder: "Customer or project" })}${button("Filter", { variant: "secondary", size: "sm" })}</form>
${table(sums, [
  { header: "Customer / project", cell: (x) => html`<a href="/staff/builds/${x.id}">${x.organizationName}</a><br><span class="faint">${x.projectName}${x.kind === "revision" ? ` · revision ${x.revision}` : ""}</span>` },
  { header: "Package", cell: (x) => x.packageId ?? "Custom" },
  { header: "State", cell: (x) => html`${stateBadge(x.state)}${x.cancelRequested ? html` ${badge("warn", "Stop requested")}` : ""}${x.projectPaused ? html` ${badge("warn", "Project paused")}` : ""}` },
  { header: "Eligibility", cell: (x) => x.eligibility.verdict === "queued" ? "Eligible" : x.eligibility.reasons.join("; ") },
  { header: "Requirements", cell: (x) => `${x.requirements.verified} verified · ${x.requirements.implemented_unverified} unverified · ${x.requirements.blocked} blocked · ${x.requirements.remaining} remaining` },
  { header: "Cost", cell: (x) => `${usd(x.costUsd)} (project ${usd(x.projectSpendUsd)} of ${usd(x.projectBudgetUsd)})`, numeric: true },
  { header: "Elapsed", cell: (x) => dur(x.elapsedSeconds) },
  { header: "Preview", cell: (x) => x.previewRetention.status === "scheduled" ? `Deletes ${x.previewRetention.deleteAfter!.slice(0, 10)}` : x.previewRetention.status === "none" ? "—" : x.previewRetention.note },
], { empty: emptyState("No AI builds yet", "A build record appears when a paid project created after automation was enabled has its intake or verified payment. Older projects are started only through Backfill.") })}
${pagination(ctx, page, rows.length > limit)}
<section class="card"><h2 class="card__title">Customer revision requests</h2>
<p class="faint">${modeText[s.customer_revision_mode]} Entitlement follows the project's revision allowance: rounds beyond it need an approved change order. Approving an AI result never delivers it; staff deliver the round from the project's Revisions tab.</p>
${table(custRevs, [
  { header: "Customer / project", cell: (r) => html`${r.organizationName}<br><a class="faint" href="/staff/projects/${r.projectId}?tab=revisions">${r.projectName}</a>` },
  { header: "Round", cell: (r) => html`${r.round} ${badge("info", r.status.replace(/_/g, " "))}`, numeric: true },
  { header: "Request (customer text)", cell: (r) => r.text.length > 240 ? `${r.text.slice(0, 240)}…` : r.text },
  { header: "Entitlement", cell: (r) => entitlement(r) },
  { header: "Website now", cell: (r) => r.currentBuild ? html`<a href="/staff/builds/${r.currentBuild.id}">${BUILD_STATE_LABELS[r.currentBuild.state]}</a>` : "No build yet" },
  { header: "AI build", cell: (r) => {
    const j = r.liveJob ?? r.latestJob;
    return j ? html`<a href="/staff/builds/${j.id}">${BUILD_STATE_LABELS[j.state]}</a>` : r.decision === "approved" ? "Approved" : badge("warn", "Awaiting owner review");
  } },
  { header: "", cell: (r) => manageBuilds && s.customer_revision_mode !== "off" && r.entitled && !r.liveJob
    ? html`<form method="post" action="/staff/builds/customer-revisions/${r.id}/forward" class="stack">${csrf(ctx)}${textarea({ name: "instruction", label: "Instruction for the AI builder (edit if needed)", value: r.text.slice(0, 5000), maxlength: 5000, rows: 3, id: `f-instr-${r.id}` })}${button(r.latestJob ? "Start AI build again" : "Approve and start AI build", { variant: "primary", size: "sm" })}</form>
${r.status === "submitted" && !r.decision ? html`<form method="post" action="/staff/builds/customer-revisions/${r.id}/reject" class="stack">${csrf(ctx)}${input({ name: "reason", label: "Reason (sent to the customer)", required: true, maxlength: 1000, id: `f-rej-${r.id}` })}${button("Reject request", { variant: "danger", size: "sm" })}</form>` : ""}`
    : "" },
], { empty: emptyState("No open customer revision requests", "Requests customers submit in the portal appear here while they are open.") })}
</section>
<section class="card"><h2 class="card__title">Controls</h2>
${can(ctx.actor!, "builds.manage") ? html`<form method="post" action="/staff/builds/pause" class="row">${csrf(ctx)}${s.globally_paused
  ? html`<input type="hidden" name="paused" value="0">${button("Resume automation", { variant: "primary", size: "sm" })}`
  : html`<input type="hidden" name="paused" value="1">${input({ name: "reason", label: "Reason", required: true, maxlength: 300 })}${button("Pause all automation", { variant: "danger", size: "sm" })}`}</form>` : ""}
${configure ? html`<form method="post" action="/staff/builds/settings" class="stack">${csrf(ctx)}
<div class="grid grid-3">${input({ name: "run_budget", label: "Per-run limit (USD)", type: "number", step: "0.01", value: B.microToUsd(s.run_budget_micro) })}${input({ name: "project_budget", label: "Per-project limit (USD, cumulative incl. revisions)", type: "number", step: "0.01", value: B.microToUsd(s.project_budget_micro) })}${input({ name: "model", label: "Model", value: s.model, hint: "Sent to the runner. The self-hosted runner uses its own LOCAL_MODEL instead (named in every build report)." })}
${input({ name: "max_runtime", label: "Max runtime (minutes)", type: "number", value: s.max_runtime_minutes })}${input({ name: "max_turns", label: "Max agent turns", type: "number", value: s.max_turns })}${input({ name: "max_concurrent", label: "Concurrent builds", type: "number", value: s.max_concurrent })}
${input({ name: "max_attempts", label: "Automatic attempts", type: "number", value: s.max_attempts })}</div>
${checkbox("automation_enabled", "Start eligible first builds automatically", { checked: !!s.automation_enabled })}
${input({ name: "preview_retention_days", label: "Preview retention after final approval (days)", type: "number", value: s.preview_retention_days ?? 30, hint: "Founder decision: 30. Superseded previews are deleted this many days after the owner approves the final preview; the approved one stays until its production deployment is verified; previews in progress or review never expire." })}
${select({ name: "customer_revision_mode", label: "Customer revision requests", value: s.customer_revision_mode, options: [
  { value: "off", label: "Off (staff only)" }, { value: "owner_approval", label: "Owner approval (default)" }, { value: "auto", label: "Automatic for entitled rounds" }] })}
<p class="faint">Limits are enforced by the platform at every runner heartbeat, not by the prompt. Projects created before ${formatDateTime(s.auto_start_after)} are never started automatically; use Backfill on a project to include it.</p>
<div class="form-actions">${button("Save limits")}</div></form>
<form method="post" action="/staff/builds/backfill" class="row">${csrf(ctx)}${input({ name: "project_id", label: "Backfill project id", required: true, maxlength: 60, hint: "Authorizes one existing project for automated builds; it starts only if eligible." })}${button("Backfill", { variant: "secondary", size: "sm" })}</form>` : ""}
</section>`;
    return staffPage(ctx, "AI builds", body);
  });

  const workerKeyPage = (ctx: AppContext, label: string, workerId: string, key: string) => staffPage(ctx, "Builder worker key", html`${pageHead("Builder worker key", linkButton("Builder accounts", "/staff/builds/workers", "ghost", "sm"))}
${alert("warn", html`Shown <strong>once</strong>. Put it in the build machine's secrets folder for <strong>${label}</strong> (<code>worker_${workerId}_key</code>) and reference it from the orchestrator's worker list. It is a Crestmont enrollment key, not a Claude or OpenAI credential; it cannot be shown again (rotate it if lost).`)}
<section class="card"><p>Worker id: <code>${workerId}</code></p><p>Enrollment key: <code>${key}</code></p></section>`);
  r.get("/staff/builds/workers", async (ctx) => {
    requireStaff(ctx, "builds.read");
    const configure = can(ctx.actor!, "builds.configure");
    const workers = await W.listWorkers(ctx.db);
    const av = new Map((await W.workerAvailability(ctx.db, ctx.now())).map((a) => [a.workerId, a]));
    const assignments = new Map((await ctx.db.prepare(`SELECT a.worker_id, a.project_id, p.name FROM build_assignments a JOIN projects p ON p.id = a.project_id WHERE a.released_at IS NULL`).all<{ worker_id: string; project_id: string; name: string }>()).results.map((r) => [r.worker_id, r]));
    const jobsBy = new Map((await ctx.db.prepare(`SELECT worker_id, COUNT(*) AS n, SUM(CASE WHEN state IN ('preparing','building','verifying') THEN 1 ELSE 0 END) AS live FROM build_jobs WHERE worker_id IS NOT NULL GROUP BY worker_id`).all<{ worker_id: string; n: number; live: number }>()).results.map((r) => [r.worker_id, r]));
    const body = html`${pageHead("Builder accounts", linkButton("Pipeline", "/staff/builds/pipeline", "ghost", "sm"), "AI builds")}
${alert("info", html`Each worker is one Claude account signed in on Node 1 and owns <strong>one customer website at a time</strong>, through its whole development and review cycle. New websites go to the eligible worker with the lowest <em>verified</em> weekly usage; workers without verified usage follow, least recently assigned first. Usage is shown only when the orchestrator read it through an authorized interface; it is never estimated. No account passwords or provider tokens are stored here.`)}
${table(workers, [
  { header: "Worker", cell: (w) => html`<strong>${w.label}</strong><br><span class="faint">${w.provider_kind === "claude-code" ? "Claude Code · existing Claude plan" : "self-hosted model · $0"}${w.account_label ? html` · ${w.account_label}` : ""}</span>` },
  { header: "Availability", cell: (w) => { const a = av.get(w.id); return a?.eligible ? badge("ok", "Available") : badge(w.enabled ? "warn" : "muted", a?.reason ?? "—"); } },
  { header: "Assigned website", cell: (w) => { const a = assignments.get(w.id); return a ? html`<a href="/staff/builds/projects/${a.project_id}/pipeline">${a.name}</a>` : "—"; } },
  { header: "Sessions", cell: (w) => `${jobsBy.get(w.id)?.live ?? 0} active · up to ${w.max_sessions} per website` },
  { header: "Weekly usage", cell: (w) => av.get(w.id)?.usageVerified ? `${w.usage_percent}% (verified: ${w.usage_source}, ${formatDateTime(w.usage_reported_at!)})` : "Not available (no authorized usage interface)" },
  { header: "Last health check", cell: (w) => html`${w.last_seen_at ? formatDateTime(w.last_seen_at) : "never"}${w.rate_limited_until ? html`<br>${badge("warn", `rate-limited until ${formatDateTime(w.rate_limited_until)}`)}` : ""}${w.last_error ? html`<br><span class="faint">${w.last_error}</span>` : ""}` },
  { header: "Jobs", cell: (w) => String(jobsBy.get(w.id)?.n ?? 0) },
  { header: "", cell: (w) => !configure || !w.enabled ? "" : html`<form method="post" action="/staff/builds/workers/${w.id}/update" class="row">${csrf(ctx)}${w.dispatch_paused ? html`<input type="hidden" name="action" value="resume">${button("Resume dispatch", { variant: "secondary", size: "sm" })}` : html`<input type="hidden" name="action" value="pause">${input({ name: "reason", label: "Pause reason", maxlength: 300, id: `f-wp-${w.id}` })}${button("Pause dispatch", { variant: "secondary", size: "sm" })}`}</form>
<form method="post" action="/staff/builds/workers/${w.id}/update" class="row">${csrf(ctx)}<input type="hidden" name="action" value="sessions">${input({ name: "max_sessions", label: "Sessions per website", type: "number", value: w.max_sessions, id: `f-ws-${w.id}` })}${button("Save", { variant: "ghost", size: "sm" })}</form>
<form method="post" action="/staff/builds/workers/${w.id}/rotate-key" class="row">${csrf(ctx)}${button("Rotate enrollment key", { variant: "ghost", size: "sm" })}</form>
<form method="post" action="/staff/builds/workers/${w.id}/update" class="row">${csrf(ctx)}<input type="hidden" name="action" value="remove">${button("Remove worker", { variant: "danger", size: "sm" })}</form>` },
], { empty: emptyState("No builder workers", "Without registered workers the builder runs in single-runner mode. Register one worker per Claude account (or local model) the orchestrator serves.") })}
${configure ? html`<section class="card stack"><h2 class="card__title">Register a worker</h2><form method="post" action="/staff/builds/workers" class="stack">${csrf(ctx)}
${input({ name: "label", label: "Name", required: true, maxlength: 80, id: "f-w-label" })}
${select({ name: "provider_kind", label: "Type", options: [{ value: "claude-code", label: "Claude Code (existing Claude plan sign-in on Node 1)" }, { value: "local-model", label: "Self-hosted model (optional)" }], id: "f-w-kind" })}
${input({ name: "account_label", label: "Claude account (email, identifier only)", maxlength: 120, id: "f-w-account" })}
${input({ name: "max_sessions", label: "Sessions per website", type: "number", value: 1, id: "f-w-sessions" })}
${button("Register worker", { size: "sm" })}</form><p class="faint">The account itself is signed in on the build machine with the provider's own login, in that worker's own configuration folder. Crestmont never sees the password or token.</p></section>` : ""}`;
    return staffPage(ctx, "Builder accounts", body);
  });
  r.get("/staff/builds/pipeline", async (ctx) => {
    requireStaff(ctx, "builds.read");
    const rows = (await ctx.db.prepare(`SELECT pl.project_id, pl.stage, pl.stage_reason, pl.updated_at, p.name, o.name AS org,
        (SELECT w.label FROM build_assignments a JOIN build_workers w ON w.id = a.worker_id WHERE a.project_id = pl.project_id AND a.released_at IS NULL) AS worker,
        (SELECT c.decision || ' (cycle ' || c.cycle || ', score ' || COALESCE(c.score, 0) || ')' FROM build_cycles c WHERE c.project_id = pl.project_id ORDER BY c.created_at DESC LIMIT 1) AS review,
        (SELECT COUNT(*) FROM build_integrations i WHERE i.project_id = pl.project_id AND i.live_status <> 'verified_live') AS integrations,
        (SELECT COUNT(*) FROM build_approvals ap WHERE ap.project_id = pl.project_id AND ap.status = 'pending') AS approvals,
        (SELECT COUNT(*) FROM build_jobs j WHERE j.project_id = pl.project_id AND j.state IN ('preparing','building','verifying')) AS sessions
      FROM build_pipeline pl JOIN projects p ON p.id = pl.project_id JOIN organizations o ON o.id = pl.organization_id ORDER BY pl.updated_at DESC LIMIT 200`)
      .all<{ project_id: string; stage: PL.Stage; stage_reason: string | null; updated_at: string; name: string; org: string; worker: string | null; review: string | null; integrations: number; approvals: number; sessions: number }>()).results;
    const count = (f: (r: typeof rows[number]) => boolean) => rows.filter(f).length;
    const av = await W.workerAvailability(ctx.db, ctx.now());
    const spend = await ctx.db.prepare(`SELECT COALESCE(SUM(cost_micro),0) AS paid FROM build_runs WHERE COALESCE(zero_cost, 0) = 0`).first<{ paid: number }>();
    const pending = (await ctx.db.prepare(`SELECT ap.*, p.name FROM build_approvals ap JOIN projects p ON p.id = ap.project_id WHERE ap.status = 'pending' ORDER BY ap.requested_at`).all<{ id: string; kind: string; summary: string; detail: string | null; requested_at: string; name: string; project_id: string }>()).results;
    const configure = can(ctx.actor!, "builds.configure");
    const body = html`${pageHead("AI website pipeline", linkButton("Builder accounts", "/staff/builds/workers", "ghost", "sm"), "AI builds")}
<div class="kpis">${kpi("Website orders", rows.length)}${kpi("Active", count((r) => ["WORKER_ASSIGNED", "BUILDING", "TESTING", "AI_REVIEW", "REVISION_REQUIRED"].includes(r.stage)))}${kpi("Queued", count((r) => ["QUEUED", "WAITING_FOR_WORKER_CAPACITY"].includes(r.stage)))}${kpi("Builders available", `${av.filter((a) => a.eligible).length} of ${av.length}`)}${kpi("Awaiting Founder approval", count((r) => r.stage === "READY_FOR_FOUNDER_APPROVAL"))}${kpi("Additional AI spend", `$${B.microToUsd(spend?.paid ?? 0).toFixed(2)}`, (spend?.paid ?? 0) === 0 ? "policy $0: subscriptions and owned hardware only" : "NOT ZERO: investigate the runs")}</div>
<section class="card"><h2 class="card__title">Approvals required</h2>${table(pending, [
  { header: "Website", cell: (a) => html`<a href="/staff/builds/projects/${a.project_id}/pipeline">${a.name}</a>` }, { header: "Kind", cell: (a) => a.kind.replace(/_/g, " ") },
  { header: "Request", cell: (a) => html`${a.summary}${a.detail ? html`<br><span class="faint">${a.detail}</span>` : ""}` }, { header: "Requested", cell: (a) => formatDateTime(a.requested_at) },
  { header: "", cell: (a) => configure ? html`<form method="post" action="/staff/builds/approvals/${a.id}/decide" class="stack">${csrf(ctx)}${input({ name: "note", label: "Note (required to reject)", maxlength: 1000, id: `f-apv-${a.id}` })}<div class="row">${button("Approve", { name: "decision", value: "approve", size: "sm" })}${button("Reject", { variant: "ghost", name: "decision", value: "reject", size: "sm" })}</div></form>` : "" },
], { empty: html`<p class="muted">Nothing needs your authorization. Routine development continues without approvals.</p>` })}</section>
<section class="card"><h2 class="card__title">Websites</h2>${table(rows, [
  { header: "Website", cell: (r) => html`<a href="/staff/builds/projects/${r.project_id}/pipeline">${r.name}</a><br><span class="faint">${r.org}</span>` },
  { header: "Stage", cell: (r) => html`${badge(r.stage === "FAILED_NEEDS_INTERVENTION" ? "bad" : r.stage.startsWith("WAITING") ? "warn" : r.stage === "READY_FOR_FOUNDER_APPROVAL" ? "ok" : "info", PL.STAGE_LABELS[r.stage])}<br><span class="faint">${r.stage_reason ?? ""}</span>` },
  { header: "Worker", cell: (r) => r.worker ?? "—" }, { header: "Sessions", cell: (r) => String(r.sessions) },
  { header: "Latest AI review", cell: (r) => r.review ?? "—" },
  { header: "Open integrations", cell: (r) => String(r.integrations) }, { header: "Approvals", cell: (r) => String(r.approvals) },
  { header: "Updated", cell: (r) => formatDateTime(r.updated_at) },
], { empty: emptyState("No websites in the pipeline yet", "A website enters the pipeline when its build is created from a paid intake.") })}</section>`;
    return staffPage(ctx, "AI website pipeline", body);
  });
  r.get("/staff/builds/:id", async (ctx, p) => {
    requireStaff(ctx, "builds.read");
    const d = await B.buildDetail(ctx.db, p.id);
    const j = d.job, x = d.summary;
    const manage = can(ctx.actor!, "builds.manage"), configure = can(ctx.actor!, "builds.configure");
    const previewAccess = B.previewAccess(j, ctx.env.BUILD_PREVIEW_GATE_SECRET);
    const act = (path: string, label: string, extra: SafeHtml = html``, variant: "primary" | "secondary" | "danger" = "secondary") =>
      html`<form method="post" action="/staff/builds/${j.id}/${path}" class="row">${csrf(ctx)}${extra}${button(label, { variant, size: "sm" })}</form>`;
    const body = html`${pageHead(`${x.organizationName} — ${x.kind === "revision" ? `revision ${x.revision}` : "first build"}`, linkButton("All builds", "/staff/builds", "ghost", "sm"), x.projectName)}
<p>${stateBadge(x.state)} <span class="muted">${x.stateReason ?? ""}</span></p>
${x.cancelRequested ? alert("warn", "Stop requested: the runner stops at its next heartbeat and preserves partial work.") : ""}
${dl([["Project", html`<a href="/staff/projects/${x.projectId}">${x.projectName}</a>`], ["Order", x.orderId], ["Package", x.packageId ?? "Custom (quoted)"], ["Strategy", x.strategy],
  ["Eligibility", x.eligibility.verdict === "queued" ? "Eligible: verified payment and submitted intake" : x.eligibility.reasons.join("; ")],
  ["Started", x.startedAt ? formatDateTime(x.startedAt) : "—"], ["Elapsed", dur(x.elapsedSeconds)], ["Latest heartbeat", x.heartbeatAt ? formatDateTime(x.heartbeatAt) : "—"],
  ["Attempts", `${x.attempts} of ${x.maxAttempts}`], ["Cost", `${usd(x.costUsd)} this build · project ${usd(x.projectSpendUsd)} of ${usd(x.projectBudgetUsd)} · per-run limit ${usd(x.runBudgetUsd)}`],
  ["Preview", j.preview_deleted_at ? `Deleted ${formatDateTime(j.preview_deleted_at)}${j.preview_name ? ` (${j.preview_name})` : ""}`
    : x.previewUrl ? html`${previewAccess.available ? html`<a href="/staff/builds/${j.id}/preview" rel="noopener noreferrer" target="_blank">Open preview</a> ` : ""}${j.preview_gated ? badge("ok", "Private") : badge("warn", "Public (legacy)")} <span class="faint">${j.preview_name ?? ""}</span>${previewAccess.reason ? html`<br><span class="faint">${previewAccess.reason}</span>` : ""}${j.preview_delete_requested_at ? html` ${badge("warn", "Deletion requested")}` : ""}` : "Not available"],
  ["Customer preview", j.customer_preview_shared_at ? html`Shared ${formatDateTime(j.customer_preview_shared_at)}${j.customer_review ? html` · ${badge(j.customer_review === "approved" ? "ok" : "warn", j.customer_review === "approved" ? "Customer approved" : "Customer requested changes")}${j.customer_review_note ? html` <span class="faint">${j.customer_review_note}</span>` : ""}` : html` · ${badge("pending", "Awaiting customer review")}`}` : "Not shared"],
  ["Source", x.source.repo ? `${x.source.repo}${x.source.branch ? ` @ ${x.source.branch}` : ""}${x.source.commit ? ` (${x.source.commit.slice(0, 12)})` : ""}` : "Not available"],
  ["Preview retention", x.previewRetention.status === "scheduled" ? `Scheduled for deletion on ${formatDateTime(x.previewRetention.deleteAfter!)}${j.preview_retain_until ? " (extended)" : ""}` : x.previewRetention.note],
  ["Brief", d.brief ? `version ${(d.brief as { version: number }).version}` : "—"], ["Revision instruction", j.instruction],
  ["Customer revision", x.customerRevision ? html`Round ${x.customerRevision.round} (<a href="/staff/projects/${x.projectId}?tab=revisions">project revisions</a>)` : "—"]])}
${d.missingInformation.length ? alert("warn", html`<strong>Information needed:</strong> ${d.missingInformation.join("; ")}`) : ""}
<section class="card"><h2 class="card__title">Requirements</h2><p class="faint">Statuses come from the runner with evidence; "verified" requires a check that ran. Counts are not a completion promise.</p>
${table(d.requirements as { key: string; label: string; status: string; evidence: string | null; blocker: string | null }[], [
  { header: "Requirement", cell: (r) => r.label }, { header: "Status", cell: (r) => badge(r.status === "verified" ? "ok" : r.status === "blocked" ? "bad" : r.status === "remaining" ? "muted" : "info", r.status.replace(/_/g, " ")) },
  { header: "Evidence / blocker", cell: (r) => r.blocker ?? r.evidence ?? "—" }], { empty: emptyState("No requirements", "Requirements are seeded from the brief when the build is queued.") })}</section>
${manage ? html`<section class="card stack"><h2 class="card__title">Actions</h2>
${!["canceled", "approved"].includes(j.state) ? act("cancel", "Cancel build", input({ name: "reason", label: "Reason", required: true, maxlength: 300, id: "f-cancel-reason" }), "danger") : ""}
${j.state === "failed" ? act("retry", "Retry") : ""}
${["paused", "budget_paused", "needs_information", "failed"].includes(j.state) && (j.agent_session_id || j.source_commit) ? act("resume", "Resume saved session") : ""}
${["ready_for_review", "approved", "needs_information"].includes(j.state) ? act("revision", "Submit revision", textarea({ name: "instruction", label: "Revision instruction", required: true, maxlength: 5000, rows: 3 }), "primary") : ""}
${configure && j.state === "ready_for_review" && !j.preview_deleted_at && !j.preview_delete_requested_at ? act("approve", "Approve preview for delivery", input({ name: "notes", label: "Notes", maxlength: 500, id: "f-approve-notes" }), "primary") : ""}
${j.preview_gated && !j.preview_deleted_at && ["ready_for_review", "approved"].includes(j.state) ? j.customer_preview_shared_at ? act("share-preview", "Stop sharing preview with customer", html`<input type="hidden" name="action" value="unshare">`) : act("share-preview", "Share private preview with customer", html`<input type="hidden" name="action" value="share">`) : ""}
${j.preview_name && !j.preview_deleted_at && !j.preview_delete_requested_at && !["preparing", "building", "verifying"].includes(j.state) && !["approved_kept", "kept_unrecoverable"].includes(x.previewRetention.status) ? act("delete-preview", "Delete preview") : ""}
${(j.preview_name || j.preview_url) && !j.preview_deleted_at && !j.preview_delete_claimed_at ? html`<form method="post" action="/staff/builds/${j.id}/preview-retention" class="row">${csrf(ctx)}${j.preview_preserved
  ? button("Stop preserving preview", { variant: "secondary", size: "sm", name: "action", value: "release" })
  : html`${button("Preserve preview", { variant: "secondary", size: "sm", name: "action", value: "preserve" })}${button("Extend retention by 30 days", { variant: "secondary", size: "sm", name: "action", value: "extend" })}`}</form>` : ""}
${html`<form method="post" action="/staff/builds/projects/${j.project_id}/pause" class="row">${csrf(ctx)}${x.projectPaused ? html`<input type="hidden" name="paused" value="0">${button("Resume project automation", { variant: "secondary", size: "sm" })}` : html`<input type="hidden" name="paused" value="1">${input({ name: "reason", label: "Reason", required: true, maxlength: 300, id: "f-project-pause" })}${button("Pause this project", { variant: "secondary", size: "sm" })}`}</form>`}
${configure ? html`<form method="post" action="/staff/builds/projects/${j.project_id}/budget" class="row">${csrf(ctx)}${input({ name: "project_budget", label: "Project limit (USD)", type: "number", step: "0.01", value: x.projectBudgetUsd, id: "f-project-budget" })}${button("Set project limit", { variant: "secondary", size: "sm" })}</form>` : ""}
<p class="faint">Approving a preview records the owner decision only; it never publishes to production, changes domains, charges the customer or emails them. Publishing is a separate, owner-authorized release: ${html`<a href="/staff/builds/projects/${j.project_id}/delivery">Production delivery</a>`}.</p></section>` : ""}
${d.report ? html`<section class="card"><h2 class="card__title">Build report</h2><pre class="code-block">${d.report}</pre></section>` : ""}
<section class="card"><h2 class="card__title">Attempts</h2>${table(d.runs as unknown as { attempt: number; runner_id: string; started_at: string; ended_at: string | null; outcome: string | null; cost_usd: number; turns: number; error: string | null; provider: string | null; model: string | null; zero_cost: number | null }[], [
  { header: "#", cell: (r) => r.attempt }, { header: "Runner", cell: (r) => r.runner_id },
  { header: "Provider / model", cell: (r) => html`${r.provider ?? "—"}${r.model ? ` · ${r.model}` : ""}${r.zero_cost === 1 ? html` ${badge("ok", "zero-cost")}` : r.zero_cost === 0 ? html` ${badge("warn", "paid")}` : ""}` }, { header: "Started", cell: (r) => formatDateTime(r.started_at) }, { header: "Ended", cell: (r) => r.ended_at ? formatDateTime(r.ended_at) : "—" },
  { header: "Outcome", cell: (r) => r.outcome ?? "running" }, { header: "Cost", cell: (r) => usd(r.cost_usd), numeric: true }, { header: "Turns", cell: (r) => r.turns, numeric: true }, { header: "Error", cell: (r) => r.error ?? "—" }],
  { empty: emptyState("No attempts yet", "An attempt starts when a runner claims the build.") })}</section>
<section class="card"><h2 class="card__title">Activity</h2><p class="faint">Sanitized: secrets, keys, emails and long blobs are removed before storage.</p>${table(d.events as { at: string; kind: string; message: string; actor_kind: string }[], [
  { header: "When", cell: (e) => formatDateTime(e.at) }, { header: "Type", cell: (e) => e.kind }, { header: "By", cell: (e) => e.actor_kind }, { header: "Detail", cell: (e) => e.message }])}</section>`;
    return staffPage(ctx, "AI build", body);
  });

  const owner = (ctx: AppContext) => ({ db: ctx.db, userId: ctx.user!.id });
  const back = (ctx: AppContext, path: string, text: string) => redirect(ctx, path, { kind: "success", text });
  const fail = (ctx: AppContext, path: string, e: unknown) => {
    if (e instanceof HttpError && e.status < 500 && e.status !== 403 && e.status !== 404) return redirect(ctx, path, { kind: "error", text: e.message });
    throw e;
  };

  r.post("/staff/builds/pause", async (ctx) => {
    requireStaff(ctx, "builds.manage");
    const f = await ctx.form();
    try { await B.setGlobalPause(owner(ctx), str(f, "paused") === "1", str(f, "reason")); } catch (e) { return fail(ctx, "/staff/builds", e); }
    return back(ctx, "/staff/builds", str(f, "paused") === "1" ? "Automation paused. Running builds stop at their next heartbeat; nothing new starts." : "Automation resumed.");
  });
  r.post("/staff/builds/settings", async (ctx) => {
    requireStaff(ctx, "builds.configure");
    const f = await ctx.form();
    const n = (k: string) => Number(str(f, k));
    try {
      await B.updateBuildSettings(owner(ctx), { automationEnabled: !!f.get("automation_enabled"), runBudgetUsd: n("run_budget"), projectBudgetUsd: n("project_budget"), maxRuntimeMinutes: n("max_runtime"), maxTurns: n("max_turns"), maxConcurrent: n("max_concurrent"), maxAttempts: n("max_attempts"), model: str(f, "model"),
        customerRevisionMode: (str(f, "customer_revision_mode") || undefined) as B.CustomerRevisionMode | undefined,
        previewRetentionDays: f.has("preview_retention_days") ? Number(str(f, "preview_retention_days") || "NaN") : undefined });
    } catch (e) { return fail(ctx, "/staff/builds", e); }
    return back(ctx, "/staff/builds", "Limits saved.");
  });
  r.post("/staff/builds/backfill", async (ctx) => {
    requireStaff(ctx, "builds.configure");
    const id = str(await ctx.form(), "project_id");
    let job: B.BuildJob | null;
    try { job = await B.setProjectControls(owner(ctx), id, { backfill: true }); } catch (e) { return fail(ctx, "/staff/builds", e); }
    return job ? back(ctx, `/staff/builds/${job.id}`, `Backfill authorized: ${BUILD_STATE_LABELS[job.state]}.`) : redirect(ctx, "/staff/builds", { kind: "info", text: "Backfill authorized, but the project is not eligible yet (or automation is off); it starts when it becomes eligible." });
  });
  r.post("/staff/builds/projects/:projectId/pause", async (ctx, p) => {
    requireStaff(ctx, "builds.manage");
    const f = await ctx.form();
    const paused = str(f, "paused") === "1";
    try { await B.setProjectControls(owner(ctx), p.projectId, { paused, reason: str(f, "reason") }); } catch (e) { return fail(ctx, "/staff/builds", e); }
    const last = await ctx.db.prepare(`SELECT id FROM build_jobs WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`).bind(p.projectId).first<{ id: string }>();
    return back(ctx, last ? `/staff/builds/${last.id}` : "/staff/builds", paused ? "Project automation paused." : "Project automation resumed.");
  });
  r.post("/staff/builds/projects/:projectId/budget", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const v = Number(str(await ctx.form(), "project_budget"));
    const last = await ctx.db.prepare(`SELECT id FROM build_jobs WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`).bind(p.projectId).first<{ id: string }>();
    const to = last ? `/staff/builds/${last.id}` : "/staff/builds";
    try { await B.setProjectControls(owner(ctx), p.projectId, { projectBudgetUsd: v }); } catch (e) { return fail(ctx, to, e); }
    return back(ctx, to, "Project limit saved.");
  });
  r.post("/staff/builds/:id/cancel", async (ctx, p) => {
    requireStaff(ctx, "builds.manage");
    try { await B.cancelBuild(owner(ctx), p.id, str(await ctx.form(), "reason")); } catch (e) { return fail(ctx, `/staff/builds/${p.id}`, e); }
    return back(ctx, `/staff/builds/${p.id}`, "Cancellation recorded.");
  });
  for (const mode of ["retry", "resume"] as const) {
    r.post(`/staff/builds/:id/${mode}`, async (ctx, p) => {
      requireStaff(ctx, "builds.manage");
      try { await B.retryBuild(owner(ctx), p.id, mode); } catch (e) { return fail(ctx, `/staff/builds/${p.id}`, e); }
      return back(ctx, `/staff/builds/${p.id}`, mode === "retry" ? "Queued for retry." : "Queued to resume the saved session.");
    });
  }
  r.post("/staff/builds/:id/revision", async (ctx, p) => {
    requireStaff(ctx, "builds.manage");
    const j = await B.getJob(ctx.db, p.id);
    if (!j) throw new HttpError(404, "Build not found");
    let id: string;
    try { id = await B.submitRevision(owner(ctx), j.project_id, str(await ctx.form(), "instruction")); } catch (e) { return fail(ctx, `/staff/builds/${p.id}`, e); }
    return back(ctx, `/staff/builds/${id}`, "Revision queued. It continues from the previous build's source and session; the project budget is cumulative.");
  });
  r.post("/staff/builds/:id/approve", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    try { await B.approveBuild(owner(ctx), p.id, str(await ctx.form(), "notes")); } catch (e) { return fail(ctx, `/staff/builds/${p.id}`, e); }
    return back(ctx, `/staff/builds/${p.id}`, "Preview approved for the delivery process. Nothing was published or sent to the customer.");
  });

  r.post("/staff/builds/:id/preview-retention", async (ctx, p) => {
    requireStaff(ctx, "builds.manage");
    try { await B.setPreviewRetention(owner(ctx), p.id, str(await ctx.form(), "action")); } catch (e) { return fail(ctx, `/staff/builds/${p.id}`, e); }
    return back(ctx, `/staff/builds/${p.id}`, "Preview retention updated.");
  });
  r.post("/staff/builds/:id/delete-preview", async (ctx, p) => {
    requireStaff(ctx, "builds.manage");
    try { await B.requestPreviewDeletion(owner(ctx), p.id); } catch (e) { return fail(ctx, `/staff/builds/${p.id}`, e); }
    return back(ctx, `/staff/builds/${p.id}`, "Preview deletion requested. The runner deletes it from the preview account when idle.");
  });
  r.post("/staff/builds/customer-revisions/:id/forward", async (ctx, p) => {
    requireStaff(ctx, "builds.manage");
    let id: string;
    try { id = await B.forwardCustomerRevision(ctx.db, p.id, { kind: "user", userId: ctx.user!.id }, { instruction: str(await ctx.form(), "instruction"), mail: ctx }); } catch (e) { return fail(ctx, "/staff/builds", e); }
    return back(ctx, `/staff/builds/${id}`, "Revision approved and queued for the AI builder. It continues from the latest build; deliver the result from the project's Revisions tab after review.");
  });
  r.post("/staff/builds/customer-revisions/:id/reject", async (ctx, p) => {
    requireStaff(ctx, "builds.manage");
    try { await B.rejectCustomerRevision({ ...owner(ctx), mail: ctx }, p.id, str(await ctx.form(), "reason")); } catch (e) { return fail(ctx, "/staff/builds", e); }
    return back(ctx, "/staff/builds", "Revision request rejected. No AI build starts; the customer was told why and the round is not used.");
  });

  // ───── Private previews (Founder decision D3) ─────
  r.get("/staff/builds/:id/preview", async (ctx, p) => {
    requireStaff(ctx, "builds.read");
    let to: string;
    try { to = await B.staffPreviewLink(owner(ctx), ctx.env.BUILD_PREVIEW_GATE_SECRET, p.id, ctx.url.searchParams.get("next") ?? "/"); } catch (e) { return fail(ctx, `/staff/builds/${p.id}`, e); }
    return previewRedirect(to);
  });
  r.post("/staff/builds/:id/share-preview", async (ctx, p) => {
    requireStaff(ctx, "builds.manage");
    const share = str(await ctx.form(), "action") !== "unshare";
    try { await B.sharePreview({ ...owner(ctx), mail: ctx }, p.id, share); } catch (e) { return fail(ctx, `/staff/builds/${p.id}`, e); }
    return back(ctx, `/staff/builds/${p.id}`, share ? "Preview shared. The customer was notified and can open it from their portal while signed in." : "The customer can no longer open this preview.");
  });
  r.get("/portal/projects/:id/previews/:buildId", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    let to: string;
    try { to = await B.customerPreviewLink(ctx.db, ctx.env.BUILD_PREVIEW_GATE_SECRET, { organizationId: org.organizationId, userId: ctx.user!.id }, p.id, p.buildId); } catch (e) { return fail(ctx, `/portal/projects/${p.id}/revisions`, e); }
    return previewRedirect(to);
  });
  r.post("/portal/projects/:id/previews/:buildId/review", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    if (org.role !== "customer_admin") throw new HttpError(403, "An account administrator reviews website previews.");
    const f = await ctx.form();
    try { await B.customerReviewPreview({ db: ctx.db, mail: ctx }, { organizationId: org.organizationId, userId: ctx.user!.id }, p.id, p.buildId, str(f, "decision"), str(f, "note")); } catch (e) { return fail(ctx, `/portal/projects/${p.id}/revisions`, e); }
    return redirect(ctx, `/portal/projects/${p.id}/revisions`, { kind: "success", text: "Thank you. Your project team has your review." });
  });

  // ───── Architecture V2: Builder Accounts, pipeline overview, approvals, integrations ─────
  r.post("/staff/builds/workers", async (ctx) => {
    requireStaff(ctx, "builds.configure");
    const f = await ctx.form();
    let res: { id: string; enrollmentKey: string };
    try { res = await W.registerWorker(owner(ctx), { label: str(f, "label"), providerKind: str(f, "provider_kind"), maxSessions: Number(str(f, "max_sessions") || "1"), accountLabel: str(f, "account_label") }); } catch (e) { return fail(ctx, "/staff/builds/workers", e); }
    return workerKeyPage(ctx, str(f, "label"), res.id, res.enrollmentKey);
  });
  r.post("/staff/builds/workers/:id/update", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const f = await ctx.form();
    try { await W.updateWorker(owner(ctx), p.id, str(f, "action"), { reason: str(f, "reason"), maxSessions: f.has("max_sessions") ? Number(str(f, "max_sessions") || "NaN") : undefined }); } catch (e) { return fail(ctx, "/staff/builds/workers", e); }
    return back(ctx, "/staff/builds/workers", "Worker updated.");
  });
  r.post("/staff/builds/workers/:id/rotate-key", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    let key: string;
    try { key = await W.rotateWorkerKey(owner(ctx), p.id); } catch (e) { return fail(ctx, "/staff/builds/workers", e); }
    const w = (await W.getWorker(ctx.db, p.id))!;
    return workerKeyPage(ctx, w.label, w.id, key);
  });
  r.post("/staff/builds/projects/:id/reassign", async (ctx, p) => {
    requireStaff(ctx, "builds.manage");
    try { await W.reassignProject(owner(ctx), p.id, str(await ctx.form(), "reason")); } catch (e) { return fail(ctx, `/staff/builds/projects/${p.id}/pipeline`, e); }
    return back(ctx, `/staff/builds/projects/${p.id}/pipeline`, "Released from its worker; the dispatcher assigns the next eligible worker.");
  });
  r.get("/staff/builds/projects/:id/pipeline", async (ctx, p) => {
    requireStaff(ctx, "builds.read");
    const proj = await ctx.db.prepare(`SELECT id, name FROM projects WHERE id = ?`).bind(p.id).first<{ id: string; name: string }>();
    if (!proj) throw new HttpError(404, "Project not found");
    const pl = await PL.getPipeline(ctx.db, p.id);
    const spec = pl?.spec_json ? JSON.parse(pl.spec_json) as PL.MasterSpec : null;
    const cycles = (await ctx.db.prepare(`SELECT * FROM build_cycles WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`).bind(p.id).all<{ id: string; job_id: string; cycle: number; prompt: string; prompt_source: string; reviewer_provider: string | null; proposed_decision: string | null; decision: string | null; decision_reason: string | null; next_prompt: string | null; score: number | null; findings_json: string | null; created_at: string }>()).results;
    const ints = (await ctx.db.prepare(`SELECT * FROM build_integrations WHERE project_id = ? ORDER BY key`).bind(p.id).all<{ id: string; key: string; name: string; purpose: string; credentials_required: string; setup_instructions: string; permissions_required: string; code_status: string; mock_status: string; live_status: string; human_action: string; responsible: string }>()).results;
    const events = (await ctx.db.prepare(`SELECT * FROM build_pipeline_events WHERE project_id = ? ORDER BY id DESC LIMIT 100`).bind(p.id).all<{ at: string; from_stage: string | null; to_stage: string; message: string; actor_kind: string }>()).results;
    const asg = await W.activeAssignment(ctx.db, p.id);
    const configure = can(ctx.actor!, "builds.configure"), manage = can(ctx.actor!, "builds.manage");
    const body = html`${pageHead(proj.name, linkButton("Pipeline", "/staff/builds/pipeline", "ghost", "sm"), "AI website pipeline")}
${dl([["Stage", pl ? html`${PL.STAGE_LABELS[pl.stage]} <span class="faint">${pl.stage_reason ?? ""}</span>` : "Not in the pipeline yet"], ["Worker", asg ? (await W.getWorker(ctx.db, asg.worker_id))?.label ?? asg.worker_id : "None"],
  ["Specification", spec ? `v${pl!.spec_version} from ${pl!.architect_provider ?? "?"} · ${spec.tasks.length} tasks · ${spec.acceptanceCriteria.length} acceptance criteria` : "None yet"]])}
${manage && asg ? html`<form method="post" action="/staff/builds/projects/${p.id}/reassign" class="row">${csrf(ctx)}${input({ name: "reason", label: "Reassign reason", required: true, maxlength: 300, id: "f-reassign" })}${button("Reassign to another worker", { variant: "secondary", size: "sm" })}</form>` : ""}
<section class="card"><h2 class="card__title">External integrations</h2><p class="faint">Engineering continues with mocks; only the live connection waits. "Live" is recorded by a person after a real test, never inferred from mock tests.</p>${table(ints, [
  { header: "Integration", cell: (i) => html`<strong>${i.name}</strong><br><span class="faint">${i.purpose}</span>` },
  { header: "Needs", cell: (i) => html`${i.credentials_required}<br><span class="faint">${i.permissions_required}</span>` },
  { header: "Setup", cell: (i) => i.setup_instructions },
  { header: "Code / mock / live", cell: (i) => html`${badge(i.code_status === "implemented" ? "ok" : "pending", i.code_status.replace(/_/g, " "))} ${badge(i.mock_status === "passed" ? "ok" : i.mock_status === "failed" ? "bad" : "pending", `mock ${i.mock_status.replace(/_/g, " ")}`)} ${badge(i.live_status === "verified_live" ? "ok" : "warn", i.live_status.replace(/_/g, " "))}` },
  { header: "Action / owner", cell: (i) => `${i.human_action} (${i.responsible.replace(/_/g, " ")})` },
  { header: "", cell: (i) => configure ? html`<form method="post" action="/staff/builds/integrations/${i.id}/live" class="row">${csrf(ctx)}${i.live_status === "verified_live" ? html`<input type="hidden" name="live" value="0">${button("Mark not live", { variant: "ghost", size: "sm" })}` : html`<input type="hidden" name="live" value="1">${button("I verified it live", { variant: "secondary", size: "sm" })}`}</form>` : "" },
], { empty: html`<p class="muted">No external integrations.</p>` })}</section>
<section class="card"><h2 class="card__title">Review cycles and prompt history</h2>${table(cycles, [
  { header: "Cycle", cell: (c) => html`<a href="/staff/builds/${c.job_id}">${c.cycle}</a>` },
  { header: "Prompt", cell: (c) => html`<details><summary>${c.prompt_source}</summary><pre class="code-block">${c.prompt}</pre></details>` },
  { header: "Decision", cell: (c) => html`${badge(c.decision === "ESCALATED" ? "bad" : c.decision?.startsWith("READY") ? "ok" : "info", c.decision ?? "—")}${c.proposed_decision && c.proposed_decision !== c.decision ? html`<br><span class="faint">reviewer proposed ${c.proposed_decision}</span>` : ""}<br><span class="faint">${c.decision_reason ?? ""}</span>` },
  { header: "Score", cell: (c) => c.score === null ? "—" : `${Math.round(c.score * 100)}%` },
  { header: "Next prompt", cell: (c) => c.next_prompt ? html`<details><summary>corrective prompt</summary><pre class="code-block">${c.next_prompt}</pre></details>` : "—" },
  { header: "When", cell: (c) => formatDateTime(c.created_at) },
], { empty: html`<p class="muted">No review cycles yet.</p>` })}</section>
${spec ? html`<section class="card"><h2 class="card__title">Master specification</h2><details><summary>Acceptance criteria (${spec.acceptanceCriteria.length})</summary><ul>${spec.acceptanceCriteria.map((a) => html`<li><code>${a.id}</code> ${a.text} <span class="faint">(${a.verification})</span></li>`)}</ul></details>
<details><summary>Tasks (${spec.tasks.length})</summary><ul>${spec.tasks.map((t) => html`<li><code>${t.id}</code> [${t.workstream}] ${t.title}${t.dependsOn.length ? html` <span class="faint">after ${t.dependsOn.join(", ")}</span>` : ""}</li>`)}</ul></details>
<details><summary>Provisional assumptions (${spec.assumptions.length})</summary><ul>${spec.assumptions.map((a) => html`<li>${a.text}</li>`)}</ul></details>
<details><summary>Master prompt</summary><pre class="code-block">${spec.masterPrompt}</pre></details></section>` : ""}
<section class="card"><h2 class="card__title">Stage history</h2>${table(events, [{ header: "When", cell: (e) => formatDateTime(e.at) }, { header: "Stage", cell: (e) => `${e.from_stage ?? "—"} → ${e.to_stage}` }, { header: "By", cell: (e) => e.actor_kind }, { header: "Detail", cell: (e) => e.message }])}</section>`;
    return staffPage(ctx, proj.name, body);
  });
  r.post("/staff/builds/approvals/:id/decide", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const f = await ctx.form();
    try { await PL.decideApproval(owner(ctx), p.id, str(f, "decision") === "approve", str(f, "note")); } catch (e) { return fail(ctx, "/staff/builds/pipeline", e); }
    return back(ctx, "/staff/builds/pipeline", "Decision recorded. The orchestrator acts on it at its next check.");
  });
  r.post("/staff/builds/integrations/:id/live", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const row = await ctx.db.prepare(`SELECT project_id FROM build_integrations WHERE id = ?`).bind(p.id).first<{ project_id: string }>();
    if (!row) throw new HttpError(404, "Integration not found");
    try { await PL.markIntegrationLive(owner(ctx), p.id, str(await ctx.form(), "live") === "1"); } catch (e) { return fail(ctx, `/staff/builds/projects/${row.project_id}/pipeline`, e); }
    return back(ctx, `/staff/builds/projects/${row.project_id}/pipeline`, "Integration status updated.");
  });

  // ───── Customer production delivery (Founder decision D5) ─────
  r.get("/staff/builds/projects/:id/delivery", async (ctx, p) => {
    requireStaff(ctx, "builds.read");
    const v = await D.deliveryView(ctx.db, p.id);
    const configure = can(ctx.actor!, "builds.configure");
    const t = v.target, b = v.approvedBuild;
    const inFlight = v.deployments.find((d) => ["prepared", "authorized", "deploying"].includes(d.state));
    const body = html`${pageHead("Production delivery", linkButton("All builds", "/staff/builds", "ghost", "sm"), v.project.name)}
${alert("info", html`Approving a preview never publishes it. A release is prepared from the approved build, <strong>explicitly authorized by the Owner</strong>, deployed by the build runner to this customer's own Worker on the customer-hosting account, then verified. Nothing is deployed until a runner with <code>PRODUCTION_DEPLOY_COMMAND</code> is configured.`)}
<section class="card"><h2 class="card__title">Deployment target</h2>${t ? dl([["Worker", t.worker_name], ["Provider", "Cloudflare Workers (customer-hosting account, never the Crestmont platform account)"],
  ["Customer domain", t.hostname ? `${t.hostname} (authorized ${formatDateTime(t.hostname_authorized_at!)})` : "None — the site is reachable only on its workers.dev address until a domain is authorized"], ["Status", t.enabled ? "Enabled" : "Disabled"]])
  : html`<p class="muted">No target yet.</p>${configure ? html`<form method="post" action="/staff/builds/projects/${v.project.id}/site-target" class="row">${csrf(ctx)}${button("Create production target", { size: "sm" })}</form>` : ""}`}
${t && configure ? html`<form method="post" action="/staff/builds/projects/${v.project.id}/site-domain" class="stack">${csrf(ctx)}${input({ name: "hostname", label: "Authorize customer domain (leave empty to remove)", value: t.hostname ?? "", maxlength: 253, id: "f-site-host" })}${input({ name: "confirm", label: "Type the domain again", maxlength: 253, id: "f-site-host-confirm" })}${button("Save domain authorization", { variant: "secondary", size: "sm" })}</form><p class="faint">Attaching a domain is a separate Owner decision; it takes effect with the next authorized release. Domain purchase and DNS are not done here.</p>` : ""}</section>
<section class="card"><h2 class="card__title">Prepare a release</h2>${b ? html`<p>Approved build: <a href="/staff/builds/${b.id}">${b.kind === "revision" ? `revision ${b.revision}` : "first build"}</a> · commit ${(b.source_commit ?? "").slice(0, 12)} · approved ${formatDateTime(b.approved_at!)}${b.customer_preview_shared_at ? html` · customer review: ${b.customer_review ? badge(b.customer_review === "approved" ? "ok" : "warn", b.customer_review === "approved" ? "approved" : "changes requested") : badge("pending", "pending")}` : " · not shared with the customer"}</p>
${v.blockers.filter((x) => !x.includes("record why")).length ? alert("warn", html`<ul>${v.blockers.filter((x) => !x.includes("record why")).map((x) => html`<li>${x}</li>`)}</ul>`) : ""}
${configure && !inFlight ? html`<form method="post" action="/staff/builds/${b.id}/prepare-release" class="stack">${csrf(ctx)}${b.customer_preview_shared_at ? "" : input({ name: "customer_review_na", label: "Why customer review does not apply (required when the preview was not shared)", maxlength: 300, id: "f-crna" })}${button("Prepare release (does not deploy)", { size: "sm" })}</form>` : inFlight ? html`<p class="faint">A release is already ${D.DEPLOYMENT_STATE_LABELS[inFlight.state].toLowerCase()}.</p>` : ""}` : html`<p class="muted">No approved build yet.</p>`}</section>
<section class="card"><h2 class="card__title">Releases</h2>${table(v.deployments, [
  { header: "Version", cell: (d) => html`v${d.version}${d.kind === "rollback" ? html` ${badge("info", "rollback")}` : ""}` },
  { header: "State", cell: (d) => html`${badge(d.state === "live" ? "ok" : ["failed", "verification_failed"].includes(d.state) ? "bad" : ["prepared", "authorized", "deploying"].includes(d.state) ? "pending" : "muted", D.DEPLOYMENT_STATE_LABELS[d.state])}${d.state_reason ? html`<br><span class="faint">${d.state_reason}</span>` : ""}` },
  { header: "Source", cell: (d) => html`<a href="/staff/builds/${d.build_job_id}">${d.source_commit.slice(0, 12)}</a>` },
  { header: "Prepared / authorized", cell: (d) => html`${formatDateTime(d.prepared_at)}${d.authorized_at ? html`<br>authorized ${formatDateTime(d.authorized_at)}` : ""}` },
  { header: "Evidence", cell: (d) => d.verification_json ? (() => { const x = JSON.parse(d.verification_json) as { url: string | null; httpStatus: number | null; matched: boolean | null; actualSha256: string | null }; return html`${x.url ?? "—"} · HTTP ${x.httpStatus ?? "—"} · ${x.matched === true ? "content matches the release" : x.matched === false ? "content does NOT match" : "no content check"}${x.actualSha256 ? html`<br><span class="faint">sha256 ${x.actualSha256.slice(0, 16)}…</span>` : ""}`; })() : d.error ?? "—" },
  { header: "Actions", cell: (d) => !configure ? "" : d.state === "prepared" ? html`<form method="post" action="/staff/builds/releases/${d.id}/authorize" class="stack">${csrf(ctx)}${input({ name: "confirm", label: `Type ${d.worker_name} to authorize`, required: true, maxlength: 80, id: `f-auth-${d.id}` })}${input({ name: "note", label: "Note", maxlength: 500, id: `f-auth-note-${d.id}` })}${button("Authorize production release", { variant: "danger", size: "sm" })}</form>${cancelForm(d.id)}`
    : d.state === "authorized" ? cancelForm(d.id)
    : d.state === "superseded" && d.verified_at && !inFlight ? html`<form method="post" action="/staff/builds/releases/${d.id}/rollback" class="row">${csrf(ctx)}${button(`Prepare rollback to v${d.version}`, { variant: "secondary", size: "sm" })}</form>` : "" },
], { empty: emptyState("No releases yet", "Prepare a release from the approved build. Nothing is published until the Owner authorizes it.") })}</section>
${v.deployments.length ? html`<section class="card"><h2 class="card__title">Release history</h2>${table(v.deployments.flatMap((d) => d.events.map((e) => ({ ...e, version: d.version }))), [
  { header: "When", cell: (e) => formatDateTime(e.at) }, { header: "Version", cell: (e) => `v${e.version}` }, { header: "By", cell: (e) => e.actor_kind }, { header: "Detail", cell: (e) => e.message }])}</section>` : ""}`;
    function cancelForm(id: string) { return html`<form method="post" action="/staff/builds/releases/${id}/cancel" class="row">${csrf(ctx)}${input({ name: "reason", label: "Cancel reason", required: true, maxlength: 300, id: `f-cancel-${id}` })}${button("Cancel release", { variant: "ghost", size: "sm" })}</form>`; }
    return staffPage(ctx, "Production delivery", body);
  });
  const deliveryBack = async (ctx: AppContext, projectId: string, text: string) => back(ctx, `/staff/builds/projects/${projectId}/delivery`, text);
  const projectOfDeployment = async (ctx: AppContext, id: string) => (await D.getDeployment(ctx.db, id))?.project_id ?? null;
  r.post("/staff/builds/projects/:id/site-target", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    try { await D.createSiteTarget(owner(ctx), p.id); } catch (e) { return fail(ctx, `/staff/builds/projects/${p.id}/delivery`, e); }
    return deliveryBack(ctx, p.id, "Production target created. Nothing was deployed.");
  });
  r.post("/staff/builds/projects/:id/site-domain", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const f = await ctx.form();
    try { await D.setSiteHostname(owner(ctx), p.id, str(f, "hostname") || null, str(f, "confirm")); } catch (e) { return fail(ctx, `/staff/builds/projects/${p.id}/delivery`, e); }
    return deliveryBack(ctx, p.id, "Domain authorization saved. It is attached only by the next authorized release.");
  });
  r.post("/staff/builds/:id/prepare-release", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const job = await B.getJob(ctx.db, p.id);
    if (!job) throw new HttpError(404, "Build not found");
    try { await D.prepareRelease(owner(ctx), p.id, str(await ctx.form(), "customer_review_na")); } catch (e) { return fail(ctx, `/staff/builds/projects/${job.project_id}/delivery`, e); }
    return deliveryBack(ctx, job.project_id, "Release prepared. Nothing is deployed until the Owner authorizes it.");
  });
  r.post("/staff/builds/releases/:id/authorize", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const pid = await projectOfDeployment(ctx, p.id);
    if (!pid) throw new HttpError(404, "Release not found");
    const f = await ctx.form();
    try { await D.authorizeRelease(owner(ctx), p.id, str(f, "confirm"), str(f, "note")); } catch (e) { return fail(ctx, `/staff/builds/projects/${pid}/delivery`, e); }
    return deliveryBack(ctx, pid, "Production release authorized. The build runner deploys and verifies it; the result appears here.");
  });
  r.post("/staff/builds/releases/:id/cancel", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const pid = await projectOfDeployment(ctx, p.id);
    if (!pid) throw new HttpError(404, "Release not found");
    try { await D.cancelRelease(owner(ctx), p.id, str(await ctx.form(), "reason")); } catch (e) { return fail(ctx, `/staff/builds/projects/${pid}/delivery`, e); }
    return deliveryBack(ctx, pid, "Release canceled.");
  });
  r.post("/staff/builds/releases/:id/rollback", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const pid = await projectOfDeployment(ctx, p.id);
    if (!pid) throw new HttpError(404, "Release not found");
    try { await D.prepareRollback(owner(ctx), p.id); } catch (e) { return fail(ctx, `/staff/builds/projects/${pid}/delivery`, e); }
    return deliveryBack(ctx, pid, "Rollback prepared. It needs the Owner's authorization like any release.");
  });

  // ───── Customer-facing summary (own organization; no internal detail) ─────
  r.get("/portal/projects/:id/build-status", async (ctx, p) => {
    const org = requireCustomerOrg(ctx);
    const proj = await ctx.db.prepare(`SELECT id FROM projects WHERE id = ? AND organization_id = ?`).bind(p.id, org.organizationId).first();
    if (!proj) throw new HttpError(404, "Project not found");
    const s = await B.customerBuildStatus(ctx.db, org.organizationId, p.id);
    return jsonResponse(ctx, 200, s ? { status: BUILD_STATE_CUSTOMER[s.state], updatedAt: s.updatedAt } : { status: null, updatedAt: null });
  });
}

function settingsView(s: B.BuildSettings) {
  return {
    automationEnabled: !!s.automation_enabled, globallyPaused: !!s.globally_paused, pauseReason: s.pause_reason, autoStartAfter: s.auto_start_after,
    runBudgetUsd: B.microToUsd(s.run_budget_micro), projectBudgetUsd: B.microToUsd(s.project_budget_micro), maxRuntimeMinutes: s.max_runtime_minutes,
    maxTurns: s.max_turns, maxConcurrent: s.max_concurrent, maxAttempts: s.max_attempts, model: s.model,
    customerRevisionMode: s.customer_revision_mode, previewRetentionDays: s.preview_retention_days,
  };
}
void actionForm;
