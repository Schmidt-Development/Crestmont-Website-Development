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
  r.post(`${RUNNER}/claim`, runnerRoute(async (ctx) => { const b = await runnerBody(ctx); return jsonResponse(ctx, 200, await B.claimJob(ctx.db, { runnerId: typeof b.runnerId === "string" ? b.runnerId : "", version: typeof b.version === "string" ? b.version : "", capabilities: b.capabilities }, ctx.now(), { allowPaidProvider: ctx.env.BUILD_ALLOW_PAID_PROVIDER === "true" })); }));
  r.post(`${RUNNER}/heartbeat`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.heartbeat(ctx.db, await runnerBody(ctx), ctx.now()))));
  r.post(`${RUNNER}/checkpoint`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.checkpoint(ctx.db, ctx.storage, await runnerBody(ctx)))));
  r.post(`${RUNNER}/checkpoint/fetch`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await B.fetchCheckpoint(ctx.db, ctx.storage, await runnerBody(ctx)))));
  // Self-hosted AI drafts (ai_jobs with provider local-runner), same signed channel.
  r.post(`${RUNNER}/ai/claim`, runnerRoute(async (ctx) => { const b = await runnerBody(ctx); return jsonResponse(ctx, 200, await AIR.claimAiJob(ctx.db, typeof b.runnerId === "string" ? b.runnerId : "", ctx.now())); }));
  r.post(`${RUNNER}/ai/complete`, runnerRoute(async (ctx) => jsonResponse(ctx, 200, await AIR.completeAiJob(ctx.db, await runnerBody(ctx)))));
  // Preview lifecycle (protocol v1.2): previews to delete, and the runner's report for each.
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
<p class="faint">Approving a preview records the owner decision only; it never publishes to production, changes domains, charges the customer or emails them.</p></section>` : ""}
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
