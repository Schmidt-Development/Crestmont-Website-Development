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
import { notify } from "../services/notifications.ts";
import { claimSignatureOnce, securityEvent } from "../services/security.ts";
import * as DX from "../services/runner-diagnostics.ts";

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
  try {
    await B.verifyRunnerSignature(ctx.env.BUILD_RUNNER_SECRET, raw, ctx.req.headers.get("x-crestmont-runner-signature"));
  } catch (e) {
    // Observability (Node 1 diagnostic): a runner that is running but cannot authenticate was invisible before.
    // Recorded at most once a minute (runners poll every few seconds); the reason only, never the header or body.
    // Only well-formed signatures (a runner with the wrong secret or clock), so unsigned internet scanners never
    // take the once-a-minute slot.
    if (e instanceof B.RunnerAuthError && !/Missing or malformed/.test(e.message)) {
      const recent = await ctx.db.prepare(`SELECT 1 FROM security_events WHERE kind = 'runner_auth_failed' AND created_at > ?`).bind(new Date(ctx.now().getTime() - 60_000).toISOString()).first();
      if (!recent) await securityEvent(ctx.db, "runner_auth_failed", { ip: ctx.ip, detail: `${e.message} on ${ctx.url.pathname}` });
    }
    throw e;
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, "Malformed JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
  // Replay protection (CREST-GAP-087): runners put a random `_nonce` in every signed body; a captured request cannot
  // be sent again. Runners older than the nonce are accepted until RUNNER_REQUIRE_NONCE=yes.
  const nonce = (body as Record<string, unknown>)._nonce;
  if (typeof nonce === "string" && /^[0-9a-f]{32,64}$/.test(nonce)) {
    if (!(await claimSignatureOnce(ctx.db, `runner:${nonce}`))) throw new HttpError(409, "Replayed request");
  } else if (ctx.env.RUNNER_REQUIRE_NONCE === "yes") throw new HttpError(400, "Signed body must carry a _nonce");
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

export function register(r: Router): void {
  // ───── Runner API (HMAC-signed; no cookies) ─────
  r.post(`${RUNNER}/claim`, runnerRoute(async (ctx) => { const b = await runnerBody(ctx); return jsonResponse(ctx, 200, await B.claimJob(ctx.db, { runnerId: typeof b.runnerId === "string" ? b.runnerId : "", version: typeof b.version === "string" ? b.version : "", capabilities: Array.isArray(b.capabilities) ? b.capabilities.map(String) : [] }, ctx.now())); }));
  r.post(`${RUNNER}/heartbeat`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.heartbeat(ctx.db, await runnerBody(ctx), ctx.now()))));
  r.post(`${RUNNER}/checkpoint`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.checkpoint(ctx.db, ctx.storage, await runnerBody(ctx)))));
  r.post(`${RUNNER}/checkpoint/fetch`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.fetchCheckpoint(ctx.db, ctx.storage, await runnerBody(ctx)))));
  // Self-hosted AI drafts (ai_jobs with provider local-runner), same signed channel.
  r.post(`${RUNNER}/ai/claim`, runnerRoute(async (ctx) => { const b = await runnerBody(ctx); return jsonResponse(ctx, 200, await AIR.claimAiJob(ctx.db, typeof b.runnerId === "string" ? b.runnerId : "", ctx.now())); }));
  r.post(`${RUNNER}/ai/complete`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await AIR.completeAiJob(ctx.db, await runnerBody(ctx)))));
  // Node 1 diagnostic: runner-side checkpoints D07–D11 (lease-token authenticated, migration 0047).
  r.post(`${RUNNER}/ai/checkpoint`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await DX.recordRunnerCheckpoint(ctx.db, await runnerBody(ctx)))));
  r.post(`${RUNNER}/requirements`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.reportRequirements(ctx.db, await runnerBody(ctx)))));
  r.post(`${RUNNER}/files`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.runnerFile(ctx.db, ctx.storage, await runnerBody(ctx)))));
  r.post(`${RUNNER}/complete`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.completeJob(ctx.db, await runnerBody(ctx), (j, to) => notifyStaff(ctx, j, to)))));

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
    });
  });
  r.get("/api/builds/:id", async (ctx, p) => {
    requireStaff(ctx, "builds.read");
    const d = await B.buildDetail(ctx.db, p.id);
    const { job, ...rest } = d;
    return jsonResponse(ctx, 200, { ...rest, instruction: job.instruction, kind: job.kind, revision: job.revision, agentSessionId: job.agent_session_id, checkpointAvailable: !!job.checkpoint_key });
  });

  // ───── Owner dashboard ─────
  // ───── Node 1 dispatch-to-GPU diagnostic (Owner) ─────
  r.get("/staff/builds/diagnostics", (ctx) => diagnosticsPage(ctx));
  r.post("/staff/builds/diagnostics", async (ctx) => {
    requireStaff(ctx, "builds.configure");
    const d = await DX.createDiagnostic(ctx.db, ctx.user!.id);
    return redirect(ctx, `/staff/builds/diagnostics/${d.id}`, { kind: "success", text: `Diagnostic job queued (${d.correlationId}). The runner picks it up on its next idle poll.` });
  });
  r.get("/staff/builds/diagnostics/:id", (ctx, p) => diagnosticDetail(ctx, p.id));

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
    const body = html`${pageHead("AI builds", can(ctx.actor!, "builds.configure") ? linkButton("Node diagnostics", "/staff/builds/diagnostics", "ghost", "sm") : undefined, "Automated first builds for paid intakes")}
${!ctx.env.BUILD_RUNNER_SECRET ? alert("warn", html`<strong>Execution unavailable.</strong> No build runner is configured on this environment (BUILD_RUNNER_SECRET is not set), so eligible builds wait in the queue and nothing is generated. Setup: docs/ai-builds/RUNNER-SETUP.md.`)
  : runner?.online ? alert("success", `Runner ${runner.runner_id} (v${runner.version ?? "?"}) last checked in ${formatDateTime(runner.last_seen_at)}.`)
  : alert("warn", runner ? `Runner ${runner.runner_id} last checked in ${formatDateTime(runner.last_seen_at)}; it is not polling now, so queued builds are waiting.` : "No build runner has connected yet; queued builds are waiting.")}
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
], { empty: emptyState("No AI builds yet", "A build record appears when a paid project created after automation was enabled has its intake or verified payment. Older projects are started only through Backfill.") })}
${pagination(ctx, page, rows.length > limit)}
<section class="card"><h2 class="card__title">Controls</h2>
${can(ctx.actor!, "builds.manage") ? html`<form method="post" action="/staff/builds/pause" class="row">${csrf(ctx)}${s.globally_paused
  ? html`<input type="hidden" name="paused" value="0">${button("Resume automation", { variant: "primary", size: "sm" })}`
  : html`<input type="hidden" name="paused" value="1">${input({ name: "reason", label: "Reason", required: true, maxlength: 300 })}${button("Pause all automation", { variant: "danger", size: "sm" })}`}</form>` : ""}
${configure ? html`<form method="post" action="/staff/builds/settings" class="stack">${csrf(ctx)}
<div class="grid grid-3">${input({ name: "run_budget", label: "Per-run limit (USD)", type: "number", step: "0.01", value: B.microToUsd(s.run_budget_micro) })}${input({ name: "project_budget", label: "Per-project limit (USD, cumulative incl. revisions)", type: "number", step: "0.01", value: B.microToUsd(s.project_budget_micro) })}${input({ name: "model", label: "Model", value: s.model })}
${input({ name: "max_runtime", label: "Max runtime (minutes)", type: "number", value: s.max_runtime_minutes })}${input({ name: "max_turns", label: "Max agent turns", type: "number", value: s.max_turns })}${input({ name: "max_concurrent", label: "Concurrent builds", type: "number", value: s.max_concurrent })}
${input({ name: "max_attempts", label: "Automatic attempts", type: "number", value: s.max_attempts })}</div>
${checkbox("automation_enabled", "Start eligible first builds automatically", { checked: !!s.automation_enabled })}
<p class="faint">Limits are enforced by the platform at every runner heartbeat, not by the prompt. Projects created before ${formatDateTime(s.auto_start_after)} are never started automatically; use Backfill on a project to include it.</p>
<div class="form-actions">${button("Save limits")}</div></form>
<form method="post" action="/staff/builds/backfill" class="row">${csrf(ctx)}${input({ name: "project_id", label: "Backfill project id", required: true, maxlength: 60, hint: "Authorizes one existing project for automated builds; it starts only if eligible." })}${button("Backfill", { variant: "secondary", size: "sm" })}</form>` : ""}
</section>`;
    return staffPage(ctx, "AI builds", body);
  });

  r.get("/staff/builds/:id", async (ctx, p) => {
    requireStaff(ctx, "builds.read");
    const d = await B.buildDetail(ctx.db, p.id);
    const j = d.job, x = d.summary;
    const manage = can(ctx.actor!, "builds.manage"), configure = can(ctx.actor!, "builds.configure");
    const act = (path: string, label: string, extra: SafeHtml = html``, variant: "primary" | "secondary" | "danger" = "secondary") =>
      html`<form method="post" action="/staff/builds/${j.id}/${path}" class="row">${csrf(ctx)}${extra}${button(label, { variant, size: "sm" })}</form>`;
    const body = html`${pageHead(`${x.organizationName} — ${x.kind === "revision" ? `revision ${x.revision}` : "first build"}`, linkButton("All builds", "/staff/builds", "ghost", "sm"), x.projectName)}
<p>${stateBadge(x.state)} <span class="muted">${x.stateReason ?? ""}</span></p>
${x.cancelRequested ? alert("warn", "Stop requested: the runner stops at its next heartbeat and preserves partial work.") : ""}
${dl([["Project", html`<a href="/staff/projects/${x.projectId}">${x.projectName}</a>`], ["Order", x.orderId], ["Package", x.packageId ?? "Custom (quoted)"], ["Strategy", x.strategy],
  ["Eligibility", x.eligibility.verdict === "queued" ? "Eligible: verified payment and submitted intake" : x.eligibility.reasons.join("; ")],
  ["Started", x.startedAt ? formatDateTime(x.startedAt) : "—"], ["Elapsed", dur(x.elapsedSeconds)], ["Latest heartbeat", x.heartbeatAt ? formatDateTime(x.heartbeatAt) : "—"],
  ["Attempts", `${x.attempts} of ${x.maxAttempts}`], ["Cost", `${usd(x.costUsd)} this build · project ${usd(x.projectSpendUsd)} of ${usd(x.projectBudgetUsd)} · per-run limit ${usd(x.runBudgetUsd)}`],
  ["Preview", x.previewUrl ? html`<a href="${x.previewUrl}" rel="noopener noreferrer" target="_blank">${x.previewUrl}</a>` : "Not available"],
  ["Source", x.source.repo ? `${x.source.repo}${x.source.branch ? ` @ ${x.source.branch}` : ""}${x.source.commit ? ` (${x.source.commit.slice(0, 12)})` : ""}` : "Not available"],
  ["Brief", d.brief ? `version ${(d.brief as { version: number }).version}` : "—"], ["Revision instruction", j.instruction]])}
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
${configure && j.state === "ready_for_review" ? act("approve", "Approve preview for delivery", input({ name: "notes", label: "Notes", maxlength: 500, id: "f-approve-notes" }), "primary") : ""}
${html`<form method="post" action="/staff/builds/projects/${j.project_id}/pause" class="row">${csrf(ctx)}${x.projectPaused ? html`<input type="hidden" name="paused" value="0">${button("Resume project automation", { variant: "secondary", size: "sm" })}` : html`<input type="hidden" name="paused" value="1">${input({ name: "reason", label: "Reason", required: true, maxlength: 300, id: "f-project-pause" })}${button("Pause this project", { variant: "secondary", size: "sm" })}`}</form>`}
${configure ? html`<form method="post" action="/staff/builds/projects/${j.project_id}/budget" class="row">${csrf(ctx)}${input({ name: "project_budget", label: "Project limit (USD)", type: "number", step: "0.01", value: x.projectBudgetUsd, id: "f-project-budget" })}${button("Set project limit", { variant: "secondary", size: "sm" })}</form>` : ""}
<p class="faint">Approving a preview records the owner decision only; it never publishes to production, changes domains, charges the customer or emails them.</p></section>` : ""}
${d.report ? html`<section class="card"><h2 class="card__title">Build report</h2><pre class="code-block">${d.report}</pre></section>` : ""}
<section class="card"><h2 class="card__title">Attempts</h2>${table(d.runs as unknown as { attempt: number; runner_id: string; started_at: string; ended_at: string | null; outcome: string | null; cost_usd: number; turns: number; error: string | null }[], [
  { header: "#", cell: (r) => r.attempt }, { header: "Runner", cell: (r) => r.runner_id }, { header: "Started", cell: (r) => formatDateTime(r.started_at) }, { header: "Ended", cell: (r) => r.ended_at ? formatDateTime(r.ended_at) : "—" },
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
      await B.updateBuildSettings(owner(ctx), { automationEnabled: !!f.get("automation_enabled"), runBudgetUsd: n("run_budget"), projectBudgetUsd: n("project_budget"), maxRuntimeMinutes: n("max_runtime"), maxTurns: n("max_turns"), maxConcurrent: n("max_concurrent"), maxAttempts: n("max_attempts"), model: str(f, "model") });
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
  };
}
void actionForm;

// ───── Node 1 diagnostic pages ─────
const ago = (sec: number) => sec < 120 ? `${sec} s ago` : sec < 7200 ? `${Math.round(sec / 60)} min ago` : `${Math.round(sec / 3600)} h ago`;

async function diagnosticsPage(ctx: AppContext) {
  requireStaff(ctx, "builds.configure");
  const c = await DX.runnerConnectivity(ctx.db, ctx.env, ctx.now());
  const list = await DX.listDiagnostics(ctx.db);
  const body = html`${pageHead("Node diagnostics", undefined, "AI builds")}
<p class="muted">One small, real job on the runner channel: the self-hosted runner claims it, runs it on its local Ollama model and returns the result. Every step D01–D13 is recorded by the side that observed it, so the first step that fails or cannot be proven is visible here without access to the machine.</p>
${c.secretConfigured ? "" : alert("error", "BUILD_RUNNER_SECRET is not set on this Worker: every runner call is answered 503, so no runner can receive work. Provide the secret (GitHub secret BUILD_RUNNER_SECRET for staging) and redeploy.")}
<section class="section--tight"><h2>What the platform can see</h2>
${table(c.runners, [
  { header: "Runner", cell: (r) => r.runner_id },
  { header: "Version", cell: (r) => r.version ?? "—" },
  { header: "Last call", cell: (r) => html`${formatDateTime(r.last_seen_at)} (${ago(r.ageSeconds)}) ${r.fresh ? badge("ok", "fresh") : badge("bad", "stale")}` },
  { header: "Capabilities", cell: (r) => r.capabilities ?? "—" },
], { empty: emptyState("No runner has ever authenticated", "No signed claim has reached this platform. Either no runner is running, it points at another URL, or its secret does not match (see rejected calls below).") })}
<h3>Rejected runner calls (latest)</h3>
${table(c.rejected, [
  { header: "When", cell: (r) => formatDateTime(r.created_at) }, { header: "Reason", cell: (r) => r.detail ?? "—" }, { header: "From", cell: (r) => r.ip ?? "—" },
], { empty: emptyState("None recorded", "No runner call was rejected for a bad signature.") })}</section>
<section class="section--tight"><h2>Run a diagnostic</h2>
<form method="post" action="/staff/builds/diagnostics">${csrf(ctx)}<p class="faint">Workload: “${DX.DIAGNOSTIC_PROMPT}” on the runner's configured local model. It runs when the runner is idle (no build in progress). Results are kept here; nothing is sent to a customer.</p>${button("Queue diagnostic job")}</form></section>
<section class="section--tight"><h2>Diagnostics</h2>
${table(list, [
  { header: "Created", cell: (d) => html`<a href="/staff/builds/diagnostics/${d.id}">${formatDateTime(d.created_at)}</a>` },
  { header: "Correlation", cell: (d) => d.correlation_id },
  { header: "Job", cell: (d) => d.status },
  { header: "Checkpoints passed", cell: (d) => `${d.passed} / 13` },
], { empty: emptyState("No diagnostics yet", "Queue one above.") })}</section>`;
  return staffPage(ctx, "Node diagnostics", body);
}

async function diagnosticDetail(ctx: AppContext, id: string) {
  requireStaff(ctx, "builds.configure");
  const d = await DX.getDiagnostic(ctx.db, id);
  if (!d) throw new HttpError(404, "Diagnostic not found");
  const f = d.firstFailure;
  const body = html`${pageHead(`Diagnostic ${d.correlationId}`, linkButton("All diagnostics", "/staff/builds/diagnostics", "ghost", "sm"), "Node diagnostics")}
${f ? alert(f.status === "fail" ? "error" : "warn", html`First ${f.status === "fail" ? "failed" : "unproven"} step: <strong>${f.code} — ${f.label}</strong>${f.row?.error ? html`: ${f.row.error}` : f.status === "missing" ? (DX.RUNNER_CHECKPOINTS.includes(f.code) && d.steps.some((s) => s.code === "D12" && s.row)
  ? (/runner predates diagnostics/.test(d.steps.find((s) => s.code === "D12")!.row!.evidence ?? "") ? " (not reported: this runner version predates diagnostics)" : " (the runner sent a result but this checkpoint never arrived: see the runner log)")
  : " (not reached yet)") : ""}`) : alert("success", "All 13 steps recorded as passed.")}
${dl([["Job", `${d.aiJobId} (${d.jobStatus})`], ["Model reported", d.model ?? "—"], ["Error", d.jobError ?? "—"]])}
${table(d.steps, [
  { header: "Step", cell: (s) => html`<strong>${s.code}</strong> ${s.label}` },
  { header: "Result", cell: (s) => s.status === "pass" ? badge("ok", "pass") : s.status === "fail" ? badge("bad", "fail") : badge("muted", "not recorded") },
  { header: "At (UTC)", cell: (s) => s.row ? html`${s.row.at}${s.row.source === "runner" ? html`<br><span class="faint">runner clock; received ${s.row.recorded_at}</span>` : ""}` : "—" },
  { header: "+ elapsed", cell: (s) => s.elapsedMs === null ? "—" : `${(s.elapsedMs / 1000).toFixed(2)} s` },
  { header: "Component / worker", cell: (s) => s.row ? html`${s.row.component}${s.row.worker ? html`<br><span class="faint">${s.row.worker}</span>` : ""}` : "—" },
  { header: "Evidence / error", cell: (s) => s.row ? html`${s.row.error ? html`<span class="text-bad">${s.row.error}</span><br>` : ""}<code class="faint">${s.row.evidence ?? ""}</code>` : "—" },
])}
<section class="section--tight"><h2>Returned artifact</h2>${d.output ? html`<pre style="white-space:pre-wrap;max-height:28rem;overflow:auto">${d.output}</pre>` : emptyState("No artifact", "Nothing has been returned to the platform for this job.")}</section>
<section class="section--tight"><h2>Runner-reported metrics</h2><pre style="white-space:pre-wrap">${JSON.stringify(d.result, null, 2)}</pre></section>`;
  return staffPage(ctx, "Node diagnostic", body);
}
