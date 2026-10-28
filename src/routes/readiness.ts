// Launch Readiness Command Center (READY-001..012, §36–§50). Every view is computed from stored
// records through buildReport(); there is no manually maintained percentage anywhere.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, label, safeUrl, type SafeHtml } from "../lib/html.ts";
import { HttpError, download, htmlResponse, jsonResponse, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { appLayout } from "../ui/layout.ts";
import { csrf, input, textarea, select, button, linkButton, formErrors, alert, badge, table, emptyState, pageHead, dl, checkbox, actionForm, kpi, tabs, nl2br } from "../ui/components.ts";
import { staffNav } from "./nav.ts";
import { can, isOwner } from "../domain/authz.ts";
import { audit } from "../services/security.ts";
import { requirementsCsv } from "../readiness/report.ts";
import { ENVS, type Env as ReadyEnv, type Metric, type RequirementStatus } from "../readiness/engine.ts";
import * as ra from "../services/readiness-admin.ts";
import { githubConfig, hasPushedSnapshot, latestGithubSync, syncGithub, type GithubRun, type GithubSyncRow } from "../services/github.ts";
import { errorRateSummary, latestLatency, type ErrorRateSummary, type LatencyRun } from "../services/env-metrics.ts";

const page = (ctx: AppContext, title: string, body: SafeHtml, status = 200) =>
  htmlResponse(ctx, appLayout(ctx, { title, nav: staffNav(ctx), home: "/staff", area: "Launch readiness" }, body), status);

const subnav = (ctx: AppContext) => tabs([
  ["/staff/readiness", "Overview"], ["/staff/readiness/requirements", "Requirements"], ["/staff/readiness/engineering", "Engineering"],
  ["/staff/readiness/env/development", "Development"], ["/staff/readiness/env/staging", "Staging"], ["/staff/readiness/env/production", "Production"],
  ["/staff/readiness/blockers", "Blockers"], ["/staff/readiness/security", "Security"], ["/staff/readiness/releases", "Releases"],
  ["/staff/readiness/snapshots", "Snapshots"], ["/staff/readiness/report", "Report & exports"],
].map(([href, l]) => ({ href, label: l, current: ctx.url.pathname === href || (href !== "/staff/readiness" && ctx.url.pathname.startsWith(href + "/")) })));

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "—");
const pct = (m: Metric) => `${m.count} / ${m.total} (${m.percent}%)`;

export const DIMENSIONS: { key: keyof ra.Report["scores"]["dimensions"]; label: string; definition: string }[] = [
  { key: "engineeringCompletion", label: "Engineering completion", definition: "Engineering-category requirements whose explicit implementation record is “implemented” ÷ all engineering-category requirements." },
  { key: "developmentVerification", label: "Development verification", definition: "Requirements whose latest development evidence passed ÷ the full inventory." },
  { key: "stagingCertification", label: "Staging certification", definition: "Requirements whose latest staging evidence passed ÷ the full inventory." },
  { key: "productionVerification", label: "Production verification", definition: "Requirements whose latest production evidence passed ÷ the full inventory." },
  { key: "integrationReadiness", label: "Integration readiness", definition: "Integration-category requirements passing in staging or production ÷ all integration-category requirements." },
  { key: "securityReadiness", label: "Security readiness", definition: "Security-category requirements passing in staging or production ÷ all security-category requirements." },
  { key: "businessLegalReadiness", label: "Business / legal readiness", definition: "Business- and Founder-category requirements implemented and not blocked ÷ all business- and Founder-category requirements." },
];
const COUNTS: { key: keyof ra.Report["scores"]["counts"]; label: string }[] = [
  { key: "implemented", label: "Implemented" }, { key: "tested", label: "Tested (any environment)" }, { key: "passing", label: "Passing" }, { key: "failing", label: "Failing" },
  { key: "blocked", label: "Blocked" }, { key: "verifiedInStaging", label: "Verified in staging" }, { key: "productionVerified", label: "Production verified" },
];

function feedPanel(feeds: ra.FeedStatus[]): SafeHtml {
  const health = ra.overallFeedHealth(feeds);
  return html`<section class="card stack" aria-labelledby="feeds-h"><h2 id="feeds-h" style="font-size:1.4rem">Evidence feed health</h2>
${health.ok ? alert("success", "All required evidence feeds are healthy.") : alert("error", html`<strong>Evidence ingestion is not healthy — the figures below may not reflect current engineering reality.</strong> ${health.reason}`)}
${table(feeds, [
    { header: "Source", cell: (f) => html`${f.source}${f.required ? html` <span class="faint">(required)</span>` : ""}` },
    { header: "Status", cell: (f) => badge(f.status) },
    { header: "Detail", cell: (f) => f.detail },
    { header: "Last success", cell: (f) => formatDateTime(f.lastSuccessAt) },
    { header: "Last attempt", cell: (f) => formatDateTime(f.lastAttemptAt) },
  ])}
<p class="faint">Machine-readable: <a href="/api/readiness/health">/api/readiness/health</a> returns HTTP 503 while a required feed is stale, failing or unavailable.</p></section>`;
}

function metersPanel(report: ra.Report): SafeHtml {
  const d = report.scores.dimensions;
  return html`<section class="stack" aria-labelledby="dims-h"><h2 id="dims-h" style="font-size:1.4rem">Readiness dimensions</h2>
<p class="muted">Seven separate measurements. <strong>No combined readiness score is computed</strong>, by design: averaging these would hide which dimension is not ready. ${report.scores.note}</p>
<div class="grid grid-4 kpis">${DIMENSIONS.map((m) => kpi(m.label, `${d[m.key].percent}%`, `${d[m.key].count} of ${d[m.key].total}`, d[m.key].percent))}</div>
<details class="card"><summary>Denominators and definitions</summary>${dl(DIMENSIONS.map((m) => [m.label, `${m.definition} (${d[m.key].count} ÷ ${d[m.key].total})`] as [string, string]))}
<p class="faint" style="margin-top:1rem">Inventory denominator: ${report.scores.denominator.total} requirements. ${report.scores.denominator.definition}</p></details>
<div class="table-wrap"><table class="table"><caption class="visually-hidden">Requirement counts</caption><thead><tr><th scope="col">Count</th><th scope="col" class="num">Requirements</th><th scope="col" class="num">Of inventory</th><th scope="col" class="num">Percent</th></tr></thead>
<tbody>${COUNTS.map((c) => { const m = report.scores.counts[c.key]; return html`<tr><td>${c.label}</td><td class="num">${m.count}</td><td class="num">${m.total}</td><td class="num">${m.percent}%</td></tr>`; })}</tbody></table></div></section>`;
}

async function gatesPanel(ctx: AppContext, report: ra.Report): Promise<SafeHtml> {
  const last = await ra.gateLastVerification(ctx.db);
  const approvals = await ra.listApprovals(ctx.db);
  const rc = await ra.currentReleaseCandidate(ctx.db);
  const history = (gate: string) => {
    const rows = gate === "G" ? approvals.filter((a) => a.kind === "production_launch") : gate === "C" ? approvals.filter((a) => a.kind === "security_exception") : gate === "A" || gate === "D" ? approvals.filter((a) => a.kind === "scope_disposition") : [];
    if (!rows.length) return html`<span class="faint">None recorded</span>`;
    return html`<ul>${rows.slice(0, 5).map((a) => {
      const v = a.kind === "production_launch" ? ra.validityOf(a, rc, report.evidenceSetSha256) : null;
      return html`<li>${formatDateTime(a.created_at)} · ${a.approver_name ?? a.approver_user_id} · ${badge(a.decision)}${a.commit_sha ? html` · ${short(a.commit_sha)}` : ""}${v ? html` · ${v.valid ? badge("pass", "Valid") : badge("stale", "Not valid")} ${v.reason}` : ""}</li>`;
    })}</ul>`;
  };
  return html`<section class="stack" aria-labelledby="gates-h"><h2 id="gates-h" style="font-size:1.4rem">Launch gates A–H</h2>
${report.gates.map((g) => html`<article class="card" data-gate="${g.id}"><div class="row row--between"><h3 style="font-size:1.25rem;margin:0">Gate ${g.id} — ${g.name}</h3>${badge(g.status)}</div>
${dl([["Required evidence", g.requiredEvidence], ["Current evidence", g.currentEvidence], ["Last verification", formatDateTime(last[g.id])],
    ["Blockers", g.blockers.length ? html`${g.blockers.map((b) => html`<a href="/staff/readiness/blockers/${b}">${b}</a> `)}` : "None open"],
    ["Responsible", g.responsible], ["Approval history", history(g.id)]])}
${g.status === "not_evaluable" ? html`<p class="faint" style="margin-top:.5rem">Not evaluable: the evidence this gate depends on is missing, stale or failing, so it cannot be reported as passing.</p>` : ""}</article>`)}</section>`;
}

const decisionPanel = (report: ra.Report) => html`<section class="card card--gold" aria-labelledby="dec-h"><h2 id="dec-h" style="font-size:1.4rem">Launch decision</h2>
<p><strong>${report.decision.summary}</strong></p>
${dl([["Ready for Founder approval", report.decision.readyForFounderApproval ? "Yes — gates A–F pass" : "No — gates A–F do not all pass"], ["Launched and verified", report.decision.launched ? "Yes" : "No"],
  ["Evidence set", html`<code>${report.evidenceSetSha256}</code>`], ["Computed", formatDateTime(report.generatedAt)]])}</section>`;

// ───────── Requirements matrix ─────────

function verifBadge(v: string) { return badge(v === "passed" ? "pass" : v === "failed" ? "fail" : "not_started", v === "none" ? "None" : label(v)); }

function matrix(rows: RequirementStatus[], locs: Awaited<ReturnType<typeof ra.requirementLocations>>): SafeHtml {
  return table(rows, [
    { header: "ID", cell: (r) => html`<a href="/staff/readiness/requirements/${r.id}">${r.id}</a>` },
    { header: "Requirement", cell: (r) => html`${r.title}<br><span class="faint">${r.subsystem} · ${r.priority} · ${r.category}${r.disposition !== "in_scope" ? ` · ${label(r.disposition)}` : ""}</span>` },
    { header: "Implementation", cell: (r) => badge(r.implementation) },
    { header: "Location", cell: (r) => html`<span class="faint" style="font-size:.8rem">${locs.get(r.id)?.location ?? "Not recorded"}</span>` },
    { header: "Dev", cell: (r) => verifBadge(r.verification.development) },
    { header: "Staging", cell: (r) => verifBadge(r.verification.staging) },
    { header: "Prod", cell: (r) => verifBadge(r.verification.production) },
    { header: "State", cell: (r) => badge(r.state) },
    { header: "Last verified", cell: (r) => html`${formatDateTime(r.lastVerifiedAt)}${r.stale ? html` ${badge("stale")}` : ""}` },
    { header: "Blockers", cell: (r) => (r.blockers.length ? html`${r.blockers.map((b) => html`<a href="/staff/readiness/blockers/${b}">${b}</a> `)}` : "—") },
    { header: "Evidence", cell: (r) => (r.evidenceRunIds.length ? html`${r.evidenceRunIds.map((id) => html`<a href="/staff/readiness/runs/${encodeURIComponent(id)}">${id.length > 18 ? id.slice(0, 16) + "…" : id}</a> `)}` : "—") },
  ], { empty: emptyState("No requirements match", "Clear the filters to see the full inventory."), caption: "Requirements traceability matrix" });
}

const STATES = ["not_started", "in_progress", "implemented", "test_pending", "test_failed", "verified_in_development", "verified_in_staging", "production_verified", "blocked", "requires_founder_approval"];

function filterRequirements(ctx: AppContext, all: RequirementStatus[], locs: Awaited<ReturnType<typeof ra.requirementLocations>>) {
  const sp = ctx.url.searchParams;
  const f = { subsystem: sp.get("subsystem") ?? "", state: sp.get("state") ?? "", category: sp.get("category") ?? "", priority: sp.get("priority") ?? "", impl: sp.get("impl") ?? "",
    env: sp.get("env") ?? "", verification: sp.get("verification") ?? "", q: (sp.get("q") ?? "").trim().toLowerCase(), stale: sp.get("stale") === "1" };
  const rows = all.filter((r) => (!f.subsystem || r.subsystem === f.subsystem) && (!f.state || r.state === f.state) && (!f.category || r.category === f.category)
    && (!f.priority || r.priority === f.priority) && (!f.impl || r.implementation === f.impl)
    && (!f.env || !f.verification || ((ENVS as string[]).includes(f.env) && r.verification[f.env as ReadyEnv] === f.verification))
    && (!f.stale || r.stale)
    && (!f.q || `${r.id} ${r.title} ${r.subsystem} ${locs.get(r.id)?.location ?? ""}`.toLowerCase().includes(f.q)));
  return { f, rows };
}

// ───────── Blocker forms ─────────

function blockerForm(ctx: AppContext, action: string, v: Partial<ra.BlockerInput>, submit: string): SafeHtml {
  return html`<form class="card stack" method="post" action="${action}">${csrf(ctx)}
<div class="grid grid-2">${select({ name: "category", label: "Category", options: [...ra.BLOCKER_CATEGORIES], value: v.category, includeBlank: "Choose", required: true })}
${select({ name: "severity", label: "Severity", options: [...ra.BLOCKER_SEVERITIES], value: v.severity, includeBlank: "Choose", required: true })}</div>
${textarea({ name: "description", label: "Description", value: v.description, rows: 3, required: true, maxlength: 2000 })}
<div class="grid grid-2">${input({ name: "subsystem", label: "Affected subsystem", value: v.subsystem, required: true, maxlength: 100 })}
${input({ name: "owner", label: "Owner", value: v.owner, required: true, maxlength: 100, placeholder: "Founder, Engineering, …" })}</div>
${textarea({ name: "required_action", label: "Required action", value: v.required_action, rows: 2, required: true, maxlength: 2000 })}
${input({ name: "dependency", label: "Dependency (optional)", value: v.dependency, maxlength: 300 })}
${input({ name: "requirement_ids", label: "Blocked requirements (optional)", value: v.requirement_ids, hint: "Requirement ids separated by spaces or commas, e.g. PAY-001 PAY-004" })}
<div class="form-actions">${button(submit)}</div></form>`;
}

const blockerInput = (f: FormData): ra.BlockerInput => ({ category: str(f, "category"), description: str(f, "description"), severity: str(f, "severity"), subsystem: str(f, "subsystem"),
  owner: str(f, "owner"), required_action: str(f, "required_action"), dependency: str(f, "dependency"), requirement_ids: str(f, "requirement_ids") });

const readinessErr = (e: unknown) => (e instanceof ra.ReadinessError ? e : null);

// ───────── GitHub panel ─────────

function runRow(r: GithubRun) {
  return html`<tr><td>${r.url ? html`<a href="${safeUrl(r.url)}" rel="noopener">${r.name ?? r.id}</a>` : r.name ?? r.id}</td><td>${r.branch ?? "—"}</td><td><code>${short(r.headSha)}</code></td>
<td>${badge(r.outcome === "not_started" ? "failed" : r.outcome, r.outcome === "not_started" ? "Failed — not started" : label(r.outcome))}</td><td>${r.reason ?? (r.conclusion ? `GitHub conclusion: ${r.conclusion}` : r.status ?? "")}</td><td>${formatDateTime(r.createdAt)}</td></tr>`;
}

async function githubPanel(ctx: AppContext): Promise<SafeHtml> {
  const configured = githubConfig(ctx.env);
  const canSync = can(ctx.actor!, "settings.operational");
  const syncBtn = canSync ? actionForm(ctx, "/staff/readiness/github/sync", "Sync GitHub now") : "";
  const pushed = await hasPushedSnapshot(ctx.db);
  if (!configured && !pushed) {
    return html`<section class="card stack"><div class="row row--between"><h2 style="font-size:1.4rem;margin:0">GitHub</h2>${badge("not_configured")}</div>
${alert("warn", "GitHub source not configured. No snapshot has been pushed by GitHub Actions (the staging deploy workflow posts one with its read-only workflow token), and GITHUB_TOKEN / GITHUB_REPO are not set for a server-side pull. No GitHub data is shown until one of them provides it.")}${syncBtn}</section>`;
  }
  const { latest, lastGood } = await latestGithubSync(ctx.db);
  const failing = latest && !latest.ok;
  const snap = lastGood?.snapshot;
  const stale = !!snap && (failing || ctx.now().getTime() - Date.parse(lastGood!.fetched_at) > 24 * 3_600_000);
  const repo = configured?.repo ?? latest?.repo ?? "";
  const sourceNote = (row: GithubSyncRow | null) => !row ? "" : row.source === "push"
    ? html`<p class="faint" data-github-source="push">Source: snapshot pushed by GitHub Actions with the workflow's read-only token${row.run_url ? html` (<a href="${safeUrl(row.run_url)}" rel="noopener">workflow run</a>)` : ""}.${configured ? "" : " Server-side pull is not configured (no GITHUB_TOKEN on this Worker); data refreshes on each deploy."}</p>`
    : html`<p class="faint" data-github-source="pull">Source: pulled by this server with GITHUB_TOKEN.</p>`;
  return html`<section class="card stack"><div class="row row--between"><h2 style="font-size:1.4rem;margin:0">GitHub — ${repo}</h2>${configured ? syncBtn : ""}</div>
${!latest ? alert("warn", "Configured but never synced. Run a sync to load repository data.") : ""}${sourceNote(lastGood ?? latest)}
${failing ? alert("error", html`<strong>Last GitHub sync failed</strong> at ${formatDateTime(latest!.fetched_at)}: ${latest!.error}`) : ""}
${snap ? html`${stale ? alert("warn", html`<strong>Stale data.</strong> The data below is from the last successful sync at ${formatDateTime(lastGood!.fetched_at)} and may not be current.`) : html`<p class="faint">Synchronised ${formatDateTime(lastGood!.fetched_at)}.</p>`}
${dl([["Default branch", snap.defaultBranch], ["Head commit", snap.head ? html`${snap.head.url ? html`<a href="${safeUrl(snap.head.url)}" rel="noopener"><code>${short(snap.head.sha)}</code></a>` : html`<code>${short(snap.head.sha)}</code>`} ${snap.head.message} <span class="faint">— ${snap.head.author ?? "unknown"}, ${formatDateTime(snap.head.date)}</span>` : "No commits"],
    ["Latest successful workflow run", snap.latestSuccess ? html`${snap.latestSuccess.name ?? snap.latestSuccess.id} @ <code>${short(snap.latestSuccess.headSha)}</code> · ${formatDateTime(snap.latestSuccess.createdAt)}` : "None in recent runs"],
    ["Latest failed workflow run", snap.latestFailure ? html`${snap.latestFailure.name ?? snap.latestFailure.id} @ <code>${short(snap.latestFailure.headSha)}</code> · ${snap.latestFailure.outcome === "not_started" ? "jobs did not start" : "failed"}${snap.latestFailure.reason ? html` — ${snap.latestFailure.reason}` : ""}` : "None in recent runs"],
    ["Open pull requests", String(snap.pulls.length)], ["Code scanning", snap.codeScanning.detail],
    ["Release tags", snap.tags.length ? snap.tags.slice(0, 8).map((t) => t.name).join(", ") : "No tags"]])}
<h3 style="font-size:1.15rem">Workflow runs</h3>
${snap.runs.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Workflow</th><th scope="col">Branch</th><th scope="col">Commit</th><th scope="col">Outcome</th><th scope="col">Reason / conclusion</th><th scope="col">Created</th></tr></thead><tbody>${snap.runs.map(runRow)}</tbody></table></div>` : html`<p class="faint">No workflow runs returned by GitHub.</p>`}
<h3 style="font-size:1.15rem">Open pull requests</h3>
${table(snap.pulls, [{ header: "#", cell: (p) => (p.url ? html`<a href="${safeUrl(p.url)}" rel="noopener">#${p.number}</a>` : `#${p.number}`) }, { header: "Title", cell: (p) => html`${p.title}${p.draft ? html` ${badge("draft")}` : ""}` }, { header: "Author", cell: (p) => p.author ?? "—" }, { header: "Opened", cell: (p) => formatDateTime(p.createdAt) }], { empty: html`<p class="faint">No open pull requests.</p>` })}
<h3 style="font-size:1.15rem">Recent commits</h3>
${table(snap.commits, [{ header: "Commit", cell: (c) => html`<code>${short(c.sha)}</code>` }, { header: "Message", cell: (c) => c.message }, { header: "Author", cell: (c) => c.author ?? "—" }, { header: "Date", cell: (c) => formatDateTime(c.date) }], { empty: html`<p class="faint">No commits.</p>` })}`
    : html`<p class="faint">No successful GitHub sync has been recorded, so no repository data is shown.</p>`}</section>`;
}

// ───────── Environment view ─────────

const ENV_INTEGRATIONS: Record<string, string[]> = {
  development: ["d1", "r2", "auth", "stripe", "resend", "ai", "github"],
  staging: ["d1", "r2", "auth", "stripe", "resend", "ai", "voice", "telephony", "monitoring", "dns", "github"],
  production: ["d1", "r2", "auth", "stripe", "resend", "ai", "voice", "telephony", "monitoring", "dns"],
};

const UNKNOWN = "Unknown";
const ms = (n: number | null | undefined) => (n === null || n === undefined ? UNKNOWN : `${n} ms`);

/** READY-006: error rate (last 24 h, first-party) and latency (server buckets + post-deploy samples). Missing data = "Unknown", never 0. */
function errorLatencySection(env: ra.Environment, thisServer: boolean, serverEnv: string, er: ErrorRateSummary | null, lat: LatencyRun | null): SafeHtml {
  const rate = er ? `${(Math.round(er.errorRate * 10_000) / 100).toFixed(2)}%` : UNKNOWN;
  const why = thisServer
    ? `No request has been recorded for ${env} in the last 24 hours, so the error rate is unknown.`
    : `This server runs as ${serverEnv}. Each environment's Worker records its own request metrics in its own database, so ${env} error-rate data is not visible here.`;
  const p95Upper = er ? (er.p95UpperMs === null ? "> 3000 ms" : `≤ ${er.p95UpperMs} ms`) : UNKNOWN;
  return html`<section class="card stack" aria-labelledby="perf-h" data-env-metrics="${er ? "recorded" : "unknown"}"><h2 id="perf-h" style="font-size:1.4rem">Error rate and latency</h2>
<div class="grid grid-4 kpis">${kpi("Error rate (24 h)", rate, er ? `${er.errors5xx} of ${er.requests} requests answered 5xx` : "No request metrics recorded")}
${kpi("Unhandled exceptions (24 h)", er ? er.unhandled : UNKNOWN, er ? "Turned into HTTP 500 by the app" : "No request metrics recorded")}
${kpi("Server time p95 (24 h)", p95Upper, er ? `avg ${er.avgMs} ms · max ${er.maxMs} ms` : "No request metrics recorded")}
${kpi("Post-deploy p95 (worst page)", lat && lat.pages.length ? (lat.pages.some((p) => p.p95 === null) ? UNKNOWN : ms(Math.max(...lat.pages.map((p) => p.p95 as number)))) : UNKNOWN, lat ? `Sampled ${formatDateTime(lat.measuredAt)}` : "No timing evidence ingested")}</div>
${er ? html`<p class="faint">Recorded by this ${env} Worker since ${formatDateTime(er.since)}: one hourly counter row per area, no paths, ids or user data. Server time is wall-clock time inside the Worker (Workers timers advance across I/O such as database calls); percentiles are histogram bucket upper bounds. 5xx includes intentional 503 answers (e.g. degraded readiness health).</p>
${table(er.byArea, [{ header: "Area", cell: (a) => a.area }, { header: "Requests", cell: (a) => a.requests, numeric: true }, { header: "5xx", cell: (a) => a.errors5xx, numeric: true }, { header: "Unhandled", cell: (a) => a.unhandled, numeric: true }], { caption: "Requests by area (last 24 h)" })}`
    : alert("info", why)}
<h3 style="font-size:1.1rem">Post-deploy response times</h3>
${lat ? html`<p class="faint">From <a href="/staff/readiness/runs/${encodeURIComponent(lat.runId)}">${lat.runId}</a> (commit <code>${short(lat.commitSha)}</code>), measured from the CI runner after deployment, network time included. Percentiles use successful samples only.</p>
${table(lat.pages, [{ header: "Page", cell: (p) => html`<code>${p.page}</code>` }, { header: "Samples", cell: (p) => p.samples, numeric: true }, { header: "Failed", cell: (p) => p.failed, numeric: true },
    { header: "p50", cell: (p) => ms(p.p50), numeric: true }, { header: "p95", cell: (p) => ms(p.p95), numeric: true }, { header: "Max", cell: (p) => ms(p.max), numeric: true }], { caption: "Response times per page" })}`
    : html`<p class="faint">${UNKNOWN}: no post-deploy timing evidence has been ingested for ${env}. scripts/production-checks.ts records it on every ${env === "production" ? "production" : "staging"} deploy.</p>`}</section>`;
}

async function envView(ctx: AppContext, env: ra.Environment): Promise<Response> {
  const { report } = await ra.loadReport(ctx);
  const deps = await ra.deployments(ctx.db, env, 20);
  const current = deps.find((d) => d.status === "succeeded") ?? null;
  const integ = await ra.integrationRows(ctx.db, env);
  const runs = await ra.runSummaries(ctx.db, { environment: env, limit: 15 });
  const findings = (await ra.listFindings(ctx.db)).filter((f) => f.status === "open");
  const blockers = (await ra.listBlockers(ctx.db)).filter((b) => b.status === "open");
  const reqs = report.requirements;
  const verified = reqs.filter((r) => r.verification[env] === "passed").length;
  const failed = reqs.filter((r) => r.verification[env] === "failed");
  const named = ENV_INTEGRATIONS[env];
  const integRows = [...named.map((n) => integ.find((i) => i.integration === n) ?? { integration: n, environment: env, status: "none", detail: "No health record — unverified", checked_at: "" }),
    ...integ.filter((i) => !named.includes(i.integration))];
  const reqRow = (id: string) => reqs.find((r) => r.id === id);
  const verificationRows = [
    ["Stripe sandbox (PAY-001)", "PAY-001"], ["Email delivery (EMAIL-001)", "EMAIL-001"], ["AI receptionist simulation (VOICE-003)", "VOICE-003"],
    ["Accessibility & responsive (TEST-003)", "TEST-003"], ["E2E journeys (TEST-002)", "TEST-002"], ["Recovery / rollback (TEST-004)", "TEST-004"],
  ].map(([l, id]) => ({ label: l, id, r: reqRow(id) }));
  const thisServer = ctx.env.ENVIRONMENT === env;
  const migrations = env === "development" && thisServer ? await ra.migrationStatus(ctx.db) : null;
  let recentErrors: { path: string; message: string; created_at: string }[] | null = null;
  if (thisServer) {
    try { recentErrors = (await ctx.db.prepare(`SELECT path, message, created_at FROM app_errors ORDER BY created_at DESC LIMIT 10`).all<{ path: string; message: string; created_at: string }>()).results; } catch { recentErrors = null; }
  }
  const latestCommit = current?.commit_sha ?? (await ctx.db.prepare(`SELECT commit_sha, branch, finished_at FROM evidence_runs WHERE environment = ? ORDER BY finished_at DESC LIMIT 1`).bind(env).first<{ commit_sha: string }>())?.commit_sha ?? null;
  const rollback = env === "production" ? (current?.rollback_target_deployment_id ?? deps.filter((d) => d.status === "succeeded")[1]?.id ?? null) : null;
  const errorRate = await errorRateSummary(ctx.db, env, ctx.now(), 24);
  const latency = await latestLatency(ctx.db, env);

  return page(ctx, `${label(env)} environment`, html`${pageHead(`${label(env)} environment`, undefined, "Launch readiness")}${subnav(ctx)}
${thisServer ? alert("info", `This server is running as ${env}; the database answered a health query just now.`) : ""}
<div class="grid grid-4 kpis">${kpi("Current deployment", current ? short(current.commit_sha) : "None", current ? formatDateTime(current.deployed_at) : `No ${env} deployment recorded`)}
${kpi("Commit under test", short(latestCommit), latestCommit ? (current ? "Deployed commit" : "From latest evidence run") : "No evidence runs")}
${kpi("Requirements verified here", `${verified} / ${reqs.length}`, `${Math.round((verified / Math.max(1, reqs.length)) * 1000) / 10}% of the inventory`, (verified / Math.max(1, reqs.length)) * 100)}
${kpi("Failing here", failed.length, failed.length ? "Latest evidence failed" : "No failing evidence")}</div>
${!current ? alert(env === "development" ? "info" : "warn", env === "development" ? "No development deployment is recorded; development evidence comes from CI and local test runs." : `No ${env} deployment exists. ${env === "staging" ? "Staging" : "Production"} has never been deployed, so nothing about ${env} is verified.`) : ""}
<section class="card stack"><h2 style="font-size:1.4rem">Deployment</h2>
${current ? dl([["Deployment", current.id], ["Commit", html`<code>${current.commit_sha}</code>`], ["URL", current.url ? html`<a href="${safeUrl(current.url)}" rel="noopener">${current.url}</a>` : "—"], ["Deployed", formatDateTime(current.deployed_at)],
    ["Initiated by", current.initiated_by], ["Release", current.release_id ?? "—"], ["CI run", current.ci_run_id ?? "—"], ["Verification", badge(current.verification_status ?? "not_started", label(current.verification_status ?? "not recorded"))],
    ...(env === "production" ? [["Rollback target", rollback ?? "No earlier successful production deployment"] as [string, string]] : [])])
    : html`<p class="faint">No deployment recorded.${env === "production" ? " Rollback target: none (no production deployment exists)." : ""}</p>`}
${deps.length > 1 ? html`<h3 style="font-size:1.1rem">Deployment history</h3>${table(deps, [{ header: "Deployment", cell: (d) => d.id }, { header: "Commit", cell: (d) => html`<code>${short(d.commit_sha)}</code>` }, { header: "Status", cell: (d) => badge(d.status) }, { header: "When", cell: (d) => formatDateTime(d.deployed_at) }, { header: "By", cell: (d) => d.initiated_by }])}` : ""}</section>
<section class="card stack"><h2 style="font-size:1.4rem">Environment health</h2>
${table(integRows, [{ header: "Integration", cell: (i) => i.integration }, { header: "Status", cell: (i) => badge(i.status === "none" ? "unavailable" : i.status, i.status === "none" ? "Unverified" : undefined) }, { header: "Detail", cell: (i) => i.detail ?? "—" }, { header: "Checked", cell: (i) => (i.checked_at ? formatDateTime(i.checked_at) : "—") }])}</section>
<section class="card stack"><h2 style="font-size:1.4rem">Verification in ${env}</h2>
${table(verificationRows, [{ header: "Check", cell: (v) => v.label }, { header: "Result", cell: (v) => (v.r ? verifBadge(v.r.verification[env]) : "—") }, { header: "State", cell: (v) => (v.r ? badge(v.r.state) : "—") }, { header: "Requirement", cell: (v) => html`<a href="/staff/readiness/requirements/${v.id}">${v.id}</a>` }])}</section>
${errorLatencySection(env, thisServer, ctx.env.ENVIRONMENT, errorRate, latency)}
<section class="card stack"><h2 style="font-size:1.4rem">Test / E2E runs in ${env}</h2>
${table(runs, [{ header: "Run", cell: (r) => html`<a href="/staff/readiness/runs/${encodeURIComponent(r.id)}">${r.id}</a>` }, { header: "Source", cell: (r) => label(r.source) }, { header: "Commit", cell: (r) => html`<code>${short(r.commit_sha)}</code>` },
    { header: "Passed", cell: (r) => r.passed, numeric: true }, { header: "Failed", cell: (r) => r.failed, numeric: true }, { header: "Finished", cell: (r) => formatDateTime(r.finished_at) }],
    { empty: emptyState(`No ${env} evidence`, `No test or E2E evidence has been ingested for ${env}.`) })}
${failed.length ? html`<h3 style="font-size:1.1rem">Failing requirements</h3><p>${failed.map((r) => html`<a href="/staff/readiness/requirements/${r.id}">${r.id}</a> `)}</p>` : ""}</section>
${migrations ? html`<section class="card stack"><h2 style="font-size:1.4rem">Database migrations</h2><p>${migrations.applied.length} applied: ${migrations.applied.map((m) => m.name).join(", ")}</p></section>` : ""}
${recentErrors !== null ? html`<section class="card stack"><h2 style="font-size:1.4rem">Recent server errors</h2>${table(recentErrors, [{ header: "When", cell: (e) => formatDateTime(e.created_at) }, { header: "Path", cell: (e) => e.path }, { header: "Message", cell: (e) => e.message }], { empty: html`<p class="faint">No server errors recorded.</p>` })}</section>` : ""}
<div class="grid grid-2"><section class="card stack"><h2 style="font-size:1.4rem">Open security findings</h2>${table(findings, [{ header: "Finding", cell: (f) => f.title }, { header: "Severity", cell: (f) => badge(f.severity === "critical" ? "urgent" : f.severity, label(f.severity)) }, { header: "Blocking", cell: (f) => (f.release_blocking ? "Yes" : "No") }], { empty: html`<p class="faint">No open security findings are recorded. That is not the same as a completed security review (SEC-007).</p>` })}</section>
<section class="card stack"><h2 style="font-size:1.4rem">Outstanding blockers</h2>${table(blockers.slice(0, 15), [{ header: "Blocker", cell: (b) => html`<a href="/staff/readiness/blockers/${b.id}">${b.id}</a>` }, { header: "Description", cell: (b) => b.description }, { header: "Severity", cell: (b) => label(b.severity) }], { empty: html`<p class="faint">No open blockers.</p>` })}
${blockers.length > 15 ? html`<p><a href="/staff/readiness/blockers">All ${blockers.length} open blockers</a></p>` : ""}</section></div>`);
}

// ───────── Snapshot comparison ─────────

function compareSummaries(current: ra.ReportSummary, past: ra.ReportSummary, pastLabel: string): SafeHtml {
  const dimRows = DIMENSIONS.map((d) => {
    const c = current.scores.dimensions[d.key], p = past.scores.dimensions[d.key];
    return html`<tr><td>${d.label}</td><td class="num">${pct(p)}</td><td class="num">${pct(c)}</td><td class="num">${c.count - p.count >= 0 ? "+" : ""}${c.count - p.count}</td></tr>`;
  });
  const cntRows = COUNTS.map((d) => {
    const c = current.scores.counts[d.key], p = past.scores.counts[d.key];
    return html`<tr><td>${d.label}</td><td class="num">${pct(p)}</td><td class="num">${pct(c)}</td><td class="num">${c.count - p.count >= 0 ? "+" : ""}${c.count - p.count}</td></tr>`;
  });
  const gateRows = current.gates.map((g) => html`<tr><td>Gate ${g.id} — ${g.name}</td><td>${badge(past.gates.find((x) => x.id === g.id)?.status ?? "unavailable")}</td><td>${badge(g.status)}</td><td></td></tr>`);
  return html`<div class="table-wrap"><table class="table"><caption class="visually-hidden">Snapshot comparison</caption><thead><tr><th scope="col">Measure</th><th scope="col" class="num">${pastLabel}</th><th scope="col" class="num">Current</th><th scope="col" class="num">Change</th></tr></thead>
<tbody>${dimRows}${cntRows}${gateRows}<tr><td>Open blockers</td><td class="num">${past.openBlockers}</td><td class="num">${current.openBlockers}</td><td class="num">${current.openBlockers - past.openBlockers}</td></tr>
<tr><td>Evidence set</td><td><code>${past.evidenceSetSha256.slice(0, 16)}…</code></td><td><code>${current.evidenceSetSha256.slice(0, 16)}…</code></td><td>${past.evidenceSetSha256 === current.evidenceSetSha256 ? "Unchanged" : "Changed"}</td></tr></tbody></table></div>`;
}

// ───────── Founder approval ─────────

function requireFounder(ctx: AppContext): void {
  requireStaff(ctx, "readiness.read");
  if (!isOwner(ctx.actor!) || !can(ctx.actor!, "release.approve_production")) throw new HttpError(403, "Only the Owner can open the Founder approval panel. No other role, AI agent or automation may record Founder authorization.");
}

async function approvalPanel(ctx: AppContext, errors: string[] = [], status = 200): Promise<Response> {
  const { input: readinessInput, report } = await ra.loadReport(ctx);
  const rc = await ra.currentReleaseCandidate(ctx.db);
  const approvals = (await ra.listApprovals(ctx.db, "production_launch"));
  const findings = await ra.listFindings(ctx.db);
  const openFindings = findings.filter((f) => f.status === "open");
  const integ = await ra.integrationRows(ctx.db);
  const blockers = (await ra.listBlockers(ctx.db)).filter((b) => b.status === "open");
  const gate = (id: string) => report.gates.find((g) => g.id === id)!;
  const latest = approvals[0];
  const v = latest ? ra.validityOf(latest, rc, report.evidenceSetSha256) : null;
  const feeds = await ra.feedStatuses(ctx, readinessInput);
  return page(ctx, "Founder approval", html`${pageHead("Founder approval panel", undefined, "Launch readiness")}${subnav(ctx)}
${formErrors(errors)}
${alert("info", "Only the Owner can record a production launch decision. The decision is bound to the exact release candidate commit, its configuration digest and the current evidence set. A newer release candidate or any change in evidence makes it invalid.")}
${!ra.overallFeedHealth(feeds).ok ? alert("error", html`<strong>Evidence feeds are not healthy:</strong> ${ra.overallFeedHealth(feeds).reason}`) : ""}
${latest ? html`<div class="card">${dl([["Latest decision", html`${badge(latest.decision)} by ${latest.approver_name ?? latest.approver_user_id} on ${formatDateTime(latest.created_at)}`],
    ["Validity", html`${v!.valid ? badge("pass", "Valid") : badge("stale", "Not valid")} ${v!.reason}`], ["Bound to", html`commit <code>${latest.commit_sha ?? "—"}</code>, config <code>${(latest.config_sha256 ?? "—").slice(0, 16)}…</code>, evidence <code>${(latest.evidence_set_sha256 ?? "—").slice(0, 16)}…</code>`],
    ...(latest.invalidated_at ? [["Invalidated", `${formatDateTime(latest.invalidated_at)} — ${latest.invalidated_reason ?? ""}`] as [string, string]] : [])])}</div>` : ""}
${!rc ? emptyState("No release candidate", "An Owner or administrator must create a release candidate on the Releases page before a launch decision can be recorded.", linkButton("Releases", "/staff/readiness/releases", "secondary")) : html`
<section class="card stack"><h2 style="font-size:1.4rem">Launch candidate ${rc.id}</h2>
${dl([["Commit", html`<code>${rc.commit_sha}</code>`], ["Configuration SHA-256", html`<code>${rc.config_sha256}</code>`], ["Created", formatDateTime(rc.created_at)],
    ["Staging certification (Gate E)", html`${badge(gate("E").status)} ${gate("E").currentEvidence}`], ["Security (Gate C)", html`${badge(gate("C").status)} ${gate("C").currentEvidence}; ${openFindings.length} open findings`],
    ["Integrations (Gate D)", html`${badge(gate("D").status)} ${gate("D").currentEvidence}; ${integ.filter((i) => i.status !== "verified").length} integration records not verified`],
    ["Open issues", `${blockers.length} open blockers, ${report.scores.counts.failing.count} failing requirements`], ["Gates A–F", report.decision.readyForFounderApproval ? "All pass" : report.decision.summary],
    ["Evidence set", html`<code>${report.evidenceSetSha256}</code>`]])}
<h3 style="font-size:1.15rem">Release notes</h3><div>${nl2br(rc.notes)}</div>
<h3 style="font-size:1.15rem">Rollback plan</h3><div>${nl2br(rc.rollback_plan)}</div></section>
<section class="card stack"><h3 style="font-size:1.15rem">Gates</h3>${table(report.gates, [{ header: "Gate", cell: (g) => `${g.id} — ${g.name}` }, { header: "Status", cell: (g) => badge(g.status) }, { header: "Current evidence", cell: (g) => g.currentEvidence }, { header: "Blockers", cell: (g) => g.blockers.join(", ") || "—" }])}</section>
<form class="card card--gold stack" method="post" action="/staff/readiness/approve">${csrf(ctx)}
<input type="hidden" name="evidence_set" value="${report.evidenceSetSha256}">
${!report.decision.readyForFounderApproval ? alert("warn", "Gates A–F are not all passing. You may still record a rejection; an approval now would authorize a launch against failing evidence.") : ""}
${select({ name: "decision", label: "Decision", options: [{ value: "rejected", label: "Reject this release candidate" }, { value: "approved", label: "Approve production launch of this release candidate" }], required: true })}
${input({ name: "confirm_commit", label: "Type the full commit SHA to confirm", required: true, hint: `Must equal ${rc.commit_sha}`, maxlength: 40 })}
${textarea({ name: "notes", label: "Notes (optional)", rows: 3, maxlength: 4000 })}
<div class="form-actions">${button("Record Founder decision")}</div></form>`}
<section class="card stack"><h2 style="font-size:1.4rem">Approval history</h2>${table(approvals, [{ header: "When", cell: (a) => formatDateTime(a.created_at) }, { header: "Decision", cell: (a) => badge(a.decision) }, { header: "By", cell: (a) => `${a.approver_name ?? a.approver_user_id}${a.approver_is_owner ? " (Owner)" : ""}` },
    { header: "Commit", cell: (a) => html`<code>${short(a.commit_sha)}</code>` }, { header: "Validity", cell: (a) => { const x = ra.validityOf(a, rc, report.evidenceSetSha256); return html`${x.valid ? badge("pass", "Valid") : badge("stale", "Not valid")} ${x.reason}`; } }], { empty: html`<p class="faint">No launch decision has been recorded.</p>` })}</section>`, status);
}

// ───────── Registration ─────────

/** Failing infrastructure feeds (cron registration, recovery drills) carry a short public reason: these texts come from
 *  the platform's own CI scripts (HTTP status codes, step names), never from users. Token-like strings are removed. */
export function publicReason(f: { source: string; status: string; detail: string }): { reason?: string } {
  if (f.status !== "failing" || !/^(cron-triggers|recovery):|^job:_invocation$/.test(f.source)) return {};
  const text = f.detail.replace(/^Last attempt failed:\s*/, "").replace(/[A-Za-z0-9_\-]{32,}/g, "[redacted]").replace(/[^\x20-\x7e]/g, "").slice(0, 200);
  return text ? { reason: text } : {};
}

export function register(r: Router): void {
  // Self-monitoring (READY-012, §50). Unauthenticated callers get statuses only; staff also get details.
  r.get("/api/readiness/health", async (ctx) => {
    const { input, report } = await ra.loadReport(ctx);
    const feeds = await ra.feedStatuses(ctx, input);
    const h = ra.overallFeedHealth(feeds);
    const detailed = !!ctx.actor && can(ctx.actor, "readiness.read");
    // ?view=report: the same body with HTTP 200 for tools that cannot read error responses. Monitors use the default.
    const asReport = new URL(ctx.req.url).searchParams.get("view") === "report";
    return jsonResponse(ctx, h.ok || asReport ? 200 : 503, {
      ...(asReport ? { httpStatus: h.ok ? 200 : 503 } : {}),
      status: h.ok ? "ok" : "degraded", checkedAt: report.generatedAt,
      feeds: feeds.map((f) => ({ source: f.source, required: f.required, status: f.status, lastSuccessAt: f.lastSuccessAt, ...(detailed ? { detail: f.detail, lastAttemptAt: f.lastAttemptAt } : publicReason(f)) })),
      ...(detailed ? { reason: h.reason, evidenceSetSha256: report.evidenceSetSha256, decision: report.decision.summary } : {}),
    });
  });

  r.get("/staff/readiness", async (ctx) => {
    requireStaff(ctx, "readiness.read");
    const { input, report } = await ra.loadReport(ctx);
    const feeds = await ra.feedStatuses(ctx, input);
    return page(ctx, "Launch readiness", html`${pageHead("Launch Readiness Command Center", html`${linkButton("Export CSV", "/staff/readiness/export.csv", "ghost", "sm")}${linkButton("Printable report", "/staff/readiness/report", "ghost", "sm")}${isOwner(ctx.actor!) ? linkButton("Founder approval", "/staff/readiness/approve", "secondary", "sm") : ""}`, "Launch readiness")}
${subnav(ctx)}
<p class="muted">Computed ${formatDateTime(report.generatedAt)} from ${report.requirements.length} stored requirement records, ingested test evidence, the blocker register, security findings, integration health, releases and approvals.</p>
${feedPanel(feeds)}${decisionPanel(report)}${metersPanel(report)}${await gatesPanel(ctx, report)}`);
  });

  // ───────── Requirements ─────────
  r.get("/staff/readiness/requirements", async (ctx) => {
    requireStaff(ctx, "readiness.read");
    const { report } = await ra.loadReport(ctx);
    const locs = await ra.requirementLocations(ctx.db);
    const { f, rows } = filterRequirements(ctx, report.requirements, locs);
    const subsystems = [...new Set(report.requirements.map((x) => x.subsystem))];
    return page(ctx, "Requirements", html`${pageHead("Requirements traceability matrix", linkButton("Export CSV", "/staff/readiness/export.csv", "ghost", "sm"), "Launch readiness")}${subnav(ctx)}
<form class="filters row" method="get" action="/staff/readiness/requirements">
${select({ name: "subsystem", label: "Subsystem", options: subsystems.map((s) => ({ value: s, label: s })), value: f.subsystem, includeBlank: "All" })}
${select({ name: "state", label: "State", options: STATES, value: f.state, includeBlank: "All" })}
${select({ name: "impl", label: "Implementation", options: ["not_started", "in_progress", "implemented"], value: f.impl, includeBlank: "All" })}
${select({ name: "category", label: "Category", options: ["engineering", "integration", "security", "business", "founder"], value: f.category, includeBlank: "All" })}
${select({ name: "priority", label: "Priority", options: [{ value: "P0", label: "P0" }, { value: "P1", label: "P1" }, { value: "P2", label: "P2" }], value: f.priority, includeBlank: "All" })}
${select({ name: "env", label: "Environment", options: [...ENVS], value: f.env, includeBlank: "Any" })}
${select({ name: "verification", label: "Verification", options: ["passed", "failed", "none"], value: f.verification, includeBlank: "Any" })}
${input({ name: "q", label: "Search", value: f.q, placeholder: "ID, title, location" })}
${checkbox("stale", "Stale only", { checked: f.stale })}
<div class="form-actions">${button("Filter", { variant: "secondary", size: "sm" })}${linkButton("Reset", "/staff/readiness/requirements", "ghost", "sm")}</div></form>
<p class="faint">${rows.length} of ${report.requirements.length} requirements. Implementation status comes from explicit records; verification comes only from ingested evidence.</p>
${matrix(rows, locs)}`);
  });

  r.get("/staff/readiness/requirements/:id", async (ctx, p) => {
    requireStaff(ctx, "readiness.read");
    const { report } = await ra.loadReport(ctx);
    const status = report.requirements.find((x) => x.id === p.id);
    const d = await ra.requirementDetail(ctx.db, p.id);
    if (!status || !d) throw new HttpError(404, "Requirement not found.");
    const depRow = (x: { id: string; title: string; implementation_status: string }) => html`<li><a href="/staff/readiness/requirements/${x.id}">${x.id}</a> ${x.title} ${badge(x.implementation_status)}</li>`;
    return page(ctx, p.id, html`${pageHead(`${p.id} — ${status.title}`, linkButton("Matrix", "/staff/readiness/requirements", "ghost", "sm"), status.subsystem)}${subnav(ctx)}
<div class="grid grid-2" style="align-items:start"><section class="card">${dl([["State", badge(status.state)], ["Implementation", badge(status.implementation)], ["Implementation location", String(d.req.implementation_location ?? "Not recorded")],
      ["Owner", String(d.req.owner ?? "—")], ["Directive section", String(d.req.section)], ["Priority / category", `${status.priority} · ${status.category}`], ["Disposition", label(status.disposition)],
      ["Development", verifBadge(status.verification.development)], ["Staging", verifBadge(status.verification.staging)], ["Production", verifBadge(status.verification.production)],
      ["Last verified", html`${formatDateTime(status.lastVerifiedAt)}${status.stale ? html` ${badge("stale")}` : ""}`], ["Blocked reason", String(d.req.blocked_reason ?? "—")]])}</section>
<section class="card stack"><h2 style="font-size:1.3rem">Dependencies</h2>${d.dependsOn.length ? html`<p>Depends on:</p><ul>${d.dependsOn.map(depRow)}</ul>` : html`<p class="faint">No dependencies.</p>`}
${d.dependents.length ? html`<p>Required by:</p><ul>${d.dependents.map(depRow)}</ul>` : ""}
<h2 style="font-size:1.3rem">Blockers</h2>${d.blockers.length ? html`<ul>${d.blockers.map((b) => html`<li><a href="/staff/readiness/blockers/${b.id}">${b.id}</a> ${badge(b.status)} ${b.description}</li>`)}</ul>` : html`<p class="faint">No blockers linked.</p>`}</section></div>
<section class="card stack"><h2 style="font-size:1.3rem">Test evidence history</h2>
${table(d.evidence, [{ header: "Finished", cell: (e) => formatDateTime(e.finished_at) }, { header: "Run", cell: (e) => html`<a href="/staff/readiness/runs/${encodeURIComponent(e.run_id)}">${e.run_id}</a>` }, { header: "Env", cell: (e) => e.environment }, { header: "Source", cell: (e) => label(e.source) },
      { header: "Commit", cell: (e) => html`<code>${short(e.commit_sha)}</code>` }, { header: "Test", cell: (e) => e.test_name }, { header: "Outcome", cell: (e) => badge(e.outcome === "passed" ? "pass" : e.outcome === "failed" ? "fail" : "not_started", label(e.outcome)) }, { header: "Message", cell: (e) => e.message ?? "" }],
      { empty: emptyState("No evidence", "No test evidence has been ingested for this requirement, so it is unverified in every environment.") })}</section>`);
  });

  r.get("/staff/readiness/runs/:id", async (ctx, p) => {
    requireStaff(ctx, "readiness.read");
    const d = await ra.evidenceRun(ctx.db, p.id);
    if (!d) throw new HttpError(404, "Evidence run not found.");
    const failed = d.results.filter((x) => x.outcome === "failed").length;
    return page(ctx, `Run ${d.run.id}`, html`${pageHead(`Evidence run ${d.run.id}`, undefined, "Launch readiness")}${subnav(ctx)}
<div class="card">${dl([["Source", label(d.run.source)], ["Environment", d.run.environment], ["Commit", html`<code>${d.run.commit_sha}</code>`], ["Branch", d.run.branch ?? "—"],
      ["CI run", d.run.run_url ? html`<a href="${safeUrl(d.run.run_url)}" rel="noopener">${d.run.run_url}</a>` : "—"], ["Started", formatDateTime(d.run.started_at)], ["Finished", formatDateTime(d.run.finished_at)], ["Received", formatDateTime(d.run.received_at)],
      ["Payload SHA-256", html`<code>${d.run.payload_sha256}</code>`], ["Results", `${d.results.length - failed} passed/skipped, ${failed} failed`]])}</div>
${table(d.results, [{ header: "Requirement", cell: (x) => html`<a href="/staff/readiness/requirements/${x.requirement_id}">${x.requirement_id}</a>` }, { header: "Test", cell: (x) => x.test_name }, { header: "Outcome", cell: (x) => badge(x.outcome === "passed" ? "pass" : x.outcome === "failed" ? "fail" : "not_started", label(x.outcome)) }, { header: "ms", cell: (x) => x.duration_ms ?? "", numeric: true }, { header: "Message", cell: (x) => x.message ?? "" }])}`);
  });

  // ───────── Engineering / live build status (§40) ─────────
  r.get("/staff/readiness/engineering", async (ctx) => {
    requireStaff(ctx, "readiness.read");
    const { input, report } = await ra.loadReport(ctx);
    const feeds = await ra.feedStatuses(ctx, input);
    const ciRuns = await ra.runSummaries(ctx.db, { source: "ci", limit: 15 });
    const latestOk = ciRuns.find((x) => x.failed === 0 && x.passed > 0) ?? null;
    const latestFail = ciRuns.find((x) => x.failed > 0) ?? null;
    const latest = ciRuns[0] ?? null;
    const failedTests = latest ? await ra.failedTestsOfRun(ctx.db, latest.id) : [];
    const findings = (await ra.listFindings(ctx.db)).filter((f) => f.status === "open");
    const engBlockers = (await ra.listBlockers(ctx.db)).filter((b) => b.status === "open" && b.category === "engineering");
    const deps = await ra.deployments(ctx.db, undefined, 10);
    const gh = await latestGithubSync(ctx.db);
    const ghHead = gh.lastGood?.snapshot.head ?? null;
    const lastSync = [...feeds.map((f) => f.lastSuccessAt)].filter((x): x is string => !!x).sort().at(-1) ?? null;
    return page(ctx, "Engineering", html`${pageHead("Live build status", undefined, "Launch readiness")}${subnav(ctx)}
<div class="grid grid-4 kpis">${kpi("Current branch", gh.lastGood?.snapshot.defaultBranch ?? latest?.branch ?? "Unknown", gh.lastGood ? "From GitHub" : latest ? "From latest CI evidence" : "No source")}
${kpi("Latest commit", short(ghHead?.sha ?? latest?.commit_sha), ghHead ? `GitHub · ${formatDateTime(ghHead.date)}` : latest ? `CI evidence · ${formatDateTime(latest.finished_at)}` : "No source")}
${kpi("Latest successful build", latestOk ? short(latestOk.commit_sha) : "None", latestOk ? formatDateTime(latestOk.finished_at) : "No passing CI run ingested")}
${kpi("Latest failed build", latestFail ? short(latestFail.commit_sha) : "None", latestFail ? `${latestFail.failed} failed · ${formatDateTime(latestFail.finished_at)}` : "No failing CI run ingested")}</div>
<div class="grid grid-4 kpis">${kpi("Failed tests (latest run)", failedTests.length, latest ? `Run ${latest.id}` : "No run")}${kpi("Open security findings", findings.length, `${findings.filter((f) => f.release_blocking).length} release-blocking`)}
${kpi("Engineering blockers", engBlockers.length)}${kpi("Last successful synchronisation", lastSync ? formatDateTime(lastSync) : "Never", ra.overallFeedHealth(feeds).ok ? "Feeds healthy" : "Feeds NOT healthy")}</div>
${feedPanel(feeds)}
${await githubPanel(ctx)}
<section class="card stack"><h2 style="font-size:1.4rem">CI evidence runs</h2>
${table(ciRuns, [{ header: "Run", cell: (x) => html`<a href="/staff/readiness/runs/${encodeURIComponent(x.id)}">${x.id}</a>` }, { header: "Branch", cell: (x) => x.branch ?? "—" }, { header: "Commit", cell: (x) => html`<code>${short(x.commit_sha)}</code>` },
      { header: "Passed", cell: (x) => x.passed, numeric: true }, { header: "Failed", cell: (x) => x.failed, numeric: true }, { header: "Finished", cell: (x) => formatDateTime(x.finished_at) }, { header: "Received", cell: (x) => formatDateTime(x.received_at) },
      { header: "Link", cell: (x) => (x.run_url ? html`<a href="${safeUrl(x.run_url)}" rel="noopener">CI</a>` : "—") }], { empty: emptyState("No CI evidence", "No CI run has posted evidence to this environment. Gate B cannot pass until one does.") })}
<h3 style="font-size:1.15rem">Failed tests in the latest run</h3>
${table(failedTests, [{ header: "Requirement", cell: (x) => html`<a href="/staff/readiness/requirements/${x.requirement_id}">${x.requirement_id}</a>` }, { header: "Test", cell: (x) => x.test_name }, { header: "Message", cell: (x) => x.message ?? "" }], { empty: html`<p class="faint">${latest ? "No failed tests in the latest run." : "No run ingested."}</p>` })}</section>
<div class="grid grid-2"><section class="card stack"><h2 style="font-size:1.4rem">Active engineering blockers</h2>${table(engBlockers, [{ header: "Blocker", cell: (b) => html`<a href="/staff/readiness/blockers/${b.id}">${b.id}</a>` }, { header: "Description", cell: (b) => b.description }], { empty: html`<p class="faint">None open.</p>` })}</section>
<section class="card stack"><h2 style="font-size:1.4rem">Deployments</h2>${table(deps, [{ header: "Env", cell: (d) => d.environment }, { header: "Commit", cell: (d) => html`<code>${short(d.commit_sha)}</code>` }, { header: "Status", cell: (d) => badge(d.status) }, { header: "When", cell: (d) => formatDateTime(d.deployed_at) }], { empty: html`<p class="faint">No deployment has been recorded in any environment.</p>` })}</section></div>
<p class="faint">Evidence freshness: requirement evidence older than 72 hours is flagged stale (${report.requirements.filter((x) => x.stale).length} stale requirements). <a href="/staff/readiness/requirements?stale=1">View stale</a>.</p>`);
  });

  r.post("/staff/readiness/github/sync", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const res = await syncGithub(ctx, ctx.user!.id);
    return redirect(ctx, "/staff/readiness/engineering", res.status === "ok" ? { kind: "success", text: "GitHub data synchronised." }
      : res.status === "not_configured" ? { kind: "info", text: "GitHub source not configured: set GITHUB_TOKEN and GITHUB_REPO." } : { kind: "error", text: `GitHub sync failed: ${res.error.slice(0, 200)}` });
  });

  r.get("/staff/readiness/env/:env", async (ctx, p) => {
    requireStaff(ctx, "readiness.read");
    if (!(ra.ENVIRONMENTS as readonly string[]).includes(p.env)) throw new HttpError(404, "Unknown environment.");
    return envView(ctx, p.env as ra.Environment);
  });

  // ───────── Blockers (§47) ─────────
  r.get("/staff/readiness/blockers", async (ctx) => {
    requireStaff(ctx, "readiness.read");
    await ra.applySeedBlockerLinks(ctx.db);
    const all = await ra.listBlockers(ctx.db);
    const show = ctx.url.searchParams.get("show") ?? "open";
    const rows = show === "all" ? all : all.filter((b) => b.status === (show === "resolved" ? "resolved" : "open"));
    const canEdit = can(ctx.actor!, "settings.operational");
    return page(ctx, "Blockers", html`${pageHead("Blocker register", canEdit ? linkButton("New blocker", "/staff/readiness/blockers/new", "primary", "sm") : undefined, "Launch readiness")}${subnav(ctx)}
<nav class="tabs" aria-label="Blocker status">${[["open", "Open"], ["resolved", "Resolved"], ["all", "All"]].map(([k, l]) => html`<a href="/staff/readiness/blockers?show=${k}"${k === show ? html` aria-current="page"` : ""}>${l} (${k === "all" ? all.length : all.filter((b) => b.status === k).length})</a>`)}</nav>
${ra.BLOCKER_CATEGORIES.map((c) => {
      const inCat = rows.filter((b) => b.category === c);
      return html`<section class="stack" data-category="${c}"><h2 style="font-size:1.35rem">${c === "founder_approval" ? "Founder approvals" : c === "external_account" ? "External account blockers" : c === "production_incident" ? "Production incidents" : `${label(c)} blockers`} <span class="faint">(${inCat.length})</span></h2>
${table(inCat, [{ header: "ID", cell: (b) => html`<a href="/staff/readiness/blockers/${b.id}">${b.id}</a>` }, { header: "Description", cell: (b) => b.description }, { header: "Severity", cell: (b) => badge(b.severity === "critical" ? "urgent" : b.severity, label(b.severity)) },
        { header: "Subsystem", cell: (b) => b.subsystem }, { header: "Owner", cell: (b) => b.owner }, { header: "Required action", cell: (b) => b.required_action }, { header: "Status", cell: (b) => badge(b.status) },
        { header: "Requirements", cell: (b) => (b.requirement_ids.length ? html`${b.requirement_ids.map((id) => html`<a href="/staff/readiness/requirements/${id}">${id}</a> `)}` : "—") }, { header: "Created", cell: (b) => formatDateTime(b.created_at) }],
        { empty: html`<p class="faint">None ${show === "all" ? "recorded" : show}.</p>` })}</section>`;
    })}`);
  });

  r.get("/staff/readiness/blockers/new", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    return page(ctx, "New blocker", html`${pageHead("New blocker", linkButton("Register", "/staff/readiness/blockers", "ghost", "sm"), "Launch readiness")}${blockerForm(ctx, "/staff/readiness/blockers/new", {}, "Create blocker")}`);
  });
  r.post("/staff/readiness/blockers/new", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const v = blockerInput(await ctx.form());
    try {
      const id = await ra.createBlocker(ctx.db, ctx.user!.id, v);
      return redirect(ctx, `/staff/readiness/blockers/${id}`, { kind: "success", text: `Blocker ${id} recorded.` });
    } catch (e) {
      const err = readinessErr(e);
      if (err) return page(ctx, "New blocker", html`${pageHead("New blocker", undefined, "Launch readiness")}${formErrors(err.message.split(". "))}${blockerForm(ctx, "/staff/readiness/blockers/new", v, "Create blocker")}`, 422);
      throw e;
    }
  });

  const blockerPage = async (ctx: AppContext, id: string, errors: string[] = [], status = 200, v?: ra.BlockerInput) => {
    const b = await ra.getBlocker(ctx.db, id);
    if (!b) throw new HttpError(404, "Blocker not found.");
    const canEdit = can(ctx.actor!, "settings.operational");
    const history = (await ctx.db.prepare(`SELECT a.action, a.created_at, a.details_json, u.display_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.subject_type = 'blocker' AND a.subject_id = ? ORDER BY a.id DESC LIMIT 30`).bind(id)
      .all<{ action: string; created_at: string; details_json: string | null; display_name: string | null }>()).results;
    return page(ctx, b.id, html`${pageHead(`${b.id} — ${label(b.category)}`, linkButton("Register", "/staff/readiness/blockers", "ghost", "sm"), "Blocker")}${subnav(ctx)}${formErrors(errors)}
<div class="grid grid-2" style="align-items:start"><section class="card">${dl([["Status", badge(b.status)], ["Description", b.description], ["Severity", label(b.severity)], ["Subsystem", b.subsystem], ["Owner", b.owner], ["Required action", b.required_action],
      ["Dependency", b.dependency ?? "—"], ["Created", formatDateTime(b.created_at)], ["Resolved", formatDateTime(b.resolved_at)], ["Resolution evidence", b.resolution_evidence ?? "—"],
      ["Requirements", b.requirement_ids.length ? html`${b.requirement_ids.map((x) => html`<a href="/staff/readiness/requirements/${x}">${x}</a> `)}` : "—"]])}</section>
<section class="stack">${canEdit && b.status === "open" ? html`<form class="card stack" method="post" action="/staff/readiness/blockers/${b.id}/resolve">${csrf(ctx)}
${textarea({ name: "evidence", label: "Resolution evidence (required)", rows: 4, required: true, maxlength: 4000, hint: "What changed, and where it can be verified (commit, document, account id, test run)." })}
<div class="form-actions">${button("Resolve blocker")}</div></form>` : ""}
${canEdit && b.status === "resolved" ? html`<form class="card stack" method="post" action="/staff/readiness/blockers/${b.id}/reopen">${csrf(ctx)}${input({ name: "reason", label: "Reason for reopening", required: true })}<div class="form-actions">${button("Reopen", { variant: "secondary" })}</div></form>` : ""}
<div class="card"><h2 style="font-size:1.2rem">History</h2>${history.length ? html`<ul class="timeline">${history.map((h) => html`<li>${formatDateTime(h.created_at)} · ${h.display_name ?? "system"} · ${h.action}</li>`)}</ul>` : html`<p class="faint">No recorded changes since the register was created.</p>`}</div></section></div>
${canEdit ? html`<h2 style="font-size:1.3rem">Edit</h2>${blockerForm(ctx, `/staff/readiness/blockers/${b.id}`, v ?? { ...b, dependency: b.dependency ?? "", requirement_ids: b.requirement_ids.join(" ") }, "Save changes")}` : ""}`, status);
  };
  r.get("/staff/readiness/blockers/:id", async (ctx, p) => { requireStaff(ctx, "readiness.read"); return blockerPage(ctx, p.id); });
  r.post("/staff/readiness/blockers/:id", async (ctx, p) => {
    requireStaff(ctx, "settings.operational");
    const v = blockerInput(await ctx.form());
    try { await ra.updateBlocker(ctx.db, ctx.user!.id, p.id, v); return redirect(ctx, `/staff/readiness/blockers/${p.id}`, { kind: "success", text: "Blocker updated." }); }
    catch (e) { const err = readinessErr(e); if (err) return blockerPage(ctx, p.id, err.message.split(". "), err.status, v); throw e; }
  });
  r.post("/staff/readiness/blockers/:id/resolve", async (ctx, p) => {
    requireStaff(ctx, "settings.operational");
    try { await ra.resolveBlocker(ctx.db, ctx.user!.id, p.id, str(await ctx.form(), "evidence")); return redirect(ctx, `/staff/readiness/blockers/${p.id}`, { kind: "success", text: "Blocker resolved with evidence." }); }
    catch (e) { const err = readinessErr(e); if (err) return blockerPage(ctx, p.id, [err.message], err.status); throw e; }
  });
  r.post("/staff/readiness/blockers/:id/reopen", async (ctx, p) => {
    requireStaff(ctx, "settings.operational");
    try { await ra.reopenBlocker(ctx.db, ctx.user!.id, p.id, str(await ctx.form(), "reason")); return redirect(ctx, `/staff/readiness/blockers/${p.id}`, { kind: "success", text: "Blocker reopened." }); }
    catch (e) { const err = readinessErr(e); if (err) return blockerPage(ctx, p.id, [err.message], err.status); throw e; }
  });

  // ───────── Security findings ─────────
  const securityPage = async (ctx: AppContext, errors: string[] = [], status = 200) => {
    const all = await ra.listFindings(ctx.db);
    const canEdit = can(ctx.actor!, "settings.operational");
    return page(ctx, "Security findings", html`${pageHead("Security findings register", undefined, "Launch readiness")}${subnav(ctx)}${formErrors(errors)}
<p class="muted">Gate C passes only with no open release-blocking findings and security requirements verified in staging. Critical and high findings are always release-blocking. Accepting a risk is a Founder-only security exception.</p>
${table(all, [{ header: "Finding", cell: (f) => html`${f.title}${f.detail ? html`<br><span class="faint">${f.detail}</span>` : ""}` }, { header: "Severity", cell: (f) => badge(f.severity === "critical" ? "urgent" : f.severity, label(f.severity)) },
      { header: "Blocking", cell: (f) => (f.release_blocking ? badge("blocked", "Release-blocking") : "No") }, { header: "Source", cell: (f) => f.source }, { header: "Status", cell: (f) => badge(f.status) }, { header: "Opened", cell: (f) => formatDateTime(f.opened_at) },
      { header: "Resolution", cell: (f) => (f.status !== "open" ? html`${f.resolution_evidence ?? ""} <span class="faint">${formatDateTime(f.resolved_at)}</span>` : canEdit ? html`<form method="post" action="/staff/readiness/security/${f.id}/resolve" class="stack">${csrf(ctx)}
<label class="visually-hidden" for="ev-${f.id}">Resolution evidence</label><textarea class="textarea" id="ev-${f.id}" name="evidence" rows="2" required placeholder="Evidence (fix commit, retest run…)"></textarea>
<select class="select" name="outcome" aria-label="Outcome"><option value="resolved">Resolved</option>${isOwner(ctx.actor!) ? html`<option value="accepted_risk">Accept risk (Founder exception)</option>` : ""}</select>${button("Record", { variant: "secondary", size: "sm" })}</form>` : "Open") }],
      { empty: emptyState("No security findings recorded", "No findings have been recorded. This does not mean a security review has been completed — see SEC-007.") })}
${canEdit ? html`<form class="card stack" method="post" action="/staff/readiness/security">${csrf(ctx)}<h2 style="font-size:1.3rem">Record a finding</h2>
${input({ name: "title", label: "Title", required: true, maxlength: 300 })}
<div class="grid grid-2">${select({ name: "severity", label: "Severity", options: [...ra.FINDING_SEVERITIES], includeBlank: "Choose", required: true })}${input({ name: "source", label: "Source", required: true, placeholder: "CodeQL, ASVS review, pen test…" })}</div>
${textarea({ name: "detail", label: "Detail", rows: 3, maxlength: 4000 })}${checkbox("release_blocking", "Release-blocking (always on for critical and high)")}
<div class="form-actions">${button("Record finding")}</div></form>` : ""}`, status);
  };
  r.get("/staff/readiness/security", async (ctx) => { requireStaff(ctx, "readiness.read"); return securityPage(ctx); });
  r.post("/staff/readiness/security", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const f = await ctx.form();
    try { await ra.addFinding(ctx.db, ctx.user!.id, { title: str(f, "title"), severity: str(f, "severity"), release_blocking: f.get("release_blocking") === "1", source: str(f, "source"), detail: str(f, "detail") }); return redirect(ctx, "/staff/readiness/security", { kind: "success", text: "Finding recorded." }); }
    catch (e) { const err = readinessErr(e); if (err) return securityPage(ctx, err.message.split(". "), err.status); throw e; }
  });
  r.post("/staff/readiness/security/:id/resolve", async (ctx, p) => {
    requireStaff(ctx, "settings.operational");
    const f = await ctx.form();
    try { await ra.resolveFinding(ctx.db, ctx.actor!, ctx.user!.id, p.id, str(f, "outcome"), str(f, "evidence")); return redirect(ctx, "/staff/readiness/security", { kind: "success", text: "Finding updated." }); }
    catch (e) { const err = readinessErr(e); if (err) return securityPage(ctx, [err.message], err.status); throw e; }
  });

  // ───────── Releases & timeline (§45–§46) ─────────
  const releasesPage = async (ctx: AppContext, errors: string[] = [], v: Record<string, string> = {}, status = 200) => {
    const { report } = await ra.loadReport(ctx);
    const rc = await ra.currentReleaseCandidate(ctx.db);
    const events = await ra.releaseTimeline(ctx.db);
    const canCreate = can(ctx.actor!, "settings.operational");
    return page(ctx, "Releases", html`${pageHead("Releases & release history", isOwner(ctx.actor!) ? linkButton("Founder approval panel", "/staff/readiness/approve", "secondary", "sm") : undefined, "Launch readiness")}${subnav(ctx)}${formErrors(errors)}
${rc ? html`<div class="card">${dl([["Current release candidate", rc.id], ["Commit", html`<code>${rc.commit_sha}</code>`], ["Config SHA-256", html`<code>${rc.config_sha256}</code>`], ["Created", formatDateTime(rc.created_at)], ["Current evidence set", html`<code>${report.evidenceSetSha256}</code>`],
      ["Founder approval (Gate G)", html`${badge(report.gates.find((g) => g.id === "G")!.status)} ${report.gates.find((g) => g.id === "G")!.currentEvidence}`]])}</div>` : alert("info", "No release candidate has been created.")}
<section class="card stack"><h2 style="font-size:1.4rem">Release timeline</h2>
${events.length ? html`<ul class="timeline">${events.map((e) => html`<li data-kind="${e.kind}"><strong>${formatDateTime(e.at)}</strong> · ${e.title} ${badge(e.status)}<br><span class="faint">${e.detail}</span></li>`)}</ul>` : emptyState("No release history", "No release candidates, approvals or deployments have been recorded. Staging and production have never been deployed.")}</section>
${canCreate ? html`<form class="card stack" method="post" action="/staff/readiness/releases">${csrf(ctx)}<h2 style="font-size:1.3rem">Create release candidate</h2>
<p class="faint">Creating a candidate invalidates any outstanding Founder launch approval for an earlier candidate.</p>
${input({ name: "commit_sha", label: "Commit SHA", value: v.commit_sha, required: true, maxlength: 40 })}
${input({ name: "config_sha256", label: "Configuration SHA-256", value: v.config_sha256, required: true, maxlength: 64, hint: "SHA-256 of the deployment configuration (wrangler config + non-secret vars) for this candidate." })}
${textarea({ name: "notes", label: "Release notes", value: v.notes, rows: 4, required: true })}
${textarea({ name: "rollback_plan", label: "Rollback plan", value: v.rollback_plan, rows: 3, required: true })}
<div class="form-actions">${button("Create release candidate")}</div></form>` : ""}`, status);
  };
  r.get("/staff/readiness/releases", async (ctx) => { requireStaff(ctx, "readiness.read"); return releasesPage(ctx); });
  r.post("/staff/readiness/releases", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const f = await ctx.form();
    const v = { commit_sha: str(f, "commit_sha"), config_sha256: str(f, "config_sha256"), notes: str(f, "notes"), rollback_plan: str(f, "rollback_plan") };
    try { const id = await ra.createReleaseCandidate(ctx.db, ctx.user!.id, v); return redirect(ctx, "/staff/readiness/releases", { kind: "success", text: `Release candidate ${id} created.` }); }
    catch (e) { const err = readinessErr(e); if (err) return releasesPage(ctx, err.message.split(". "), v, err.status); throw e; }
  });

  r.get("/staff/readiness/approve", async (ctx) => { requireFounder(ctx); return approvalPanel(ctx); });
  r.post("/staff/readiness/approve", async (ctx) => {
    requireFounder(ctx);
    const f = await ctx.form();
    try {
      await ra.recordFounderDecision(ctx, ctx.actor!, ctx.user!.id, { decision: str(f, "decision"), notes: str(f, "notes"), confirmCommit: str(f, "confirm_commit"), expectedEvidenceSet: str(f, "evidence_set") });
      return redirect(ctx, "/staff/readiness/approve", { kind: "success", text: "Founder decision recorded and bound to the release candidate and evidence set." });
    } catch (e) { const err = readinessErr(e); if (err) return approvalPanel(ctx, [err.message], err.status); throw e; }
  });

  // ───────── Exports & snapshots (§48) ─────────
  r.get("/staff/readiness/export.csv", async (ctx) => {
    requireStaff(ctx, "readiness.read");
    const { report } = await ra.loadReport(ctx);
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "readiness.exported", subjectType: "readiness_report", details: { format: "requirements_csv" } });
    return download(ctx, requirementsCsv(report), `crestmont-readiness-${report.generatedAt.slice(0, 10)}.csv`, "text/csv; charset=utf-8");
  });
  r.get("/staff/readiness/packet.json", async (ctx) => {
    requireStaff(ctx, "readiness.read");
    const p = await ra.evidencePacket(ctx);
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "readiness.exported", subjectType: "readiness_report", details: { format: "evidence_packet", sha256: p.sha256 } });
    const res = download(ctx, p.body, `crestmont-release-evidence-${p.generatedAt.slice(0, 19).replace(/:/g, "")}.json`, "application/json; charset=utf-8");
    res.headers.set("x-evidence-packet-sha256", p.sha256);
    return res;
  });

  r.get("/staff/readiness/report", async (ctx) => {
    requireStaff(ctx, "readiness.read");
    const { input, report } = await ra.loadReport(ctx);
    const feeds = await ra.feedStatuses(ctx, input);
    const locs = await ra.requirementLocations(ctx.db);
    const blockers = await ra.listBlockers(ctx.db);
    const { f, rows } = filterRequirements(ctx, report.requirements, locs);
    const filtered = rows.length !== report.requirements.length;
    return page(ctx, "Readiness report", html`<div class="readiness-report">${pageHead("Crestmont launch readiness report", html`${linkButton("Export CSV", "/staff/readiness/export.csv", "ghost", "sm")}${linkButton("Evidence packet (JSON)", "/staff/readiness/packet.json", "ghost", "sm")}`, `Generated ${formatDateTime(report.generatedAt)}`)}
<div class="no-print">${subnav(ctx)}${alert("info", html`<strong>PDF export:</strong> use your browser's Print command and choose “Save as PDF”. This page has a print stylesheet; there is no separate server-generated PDF. The CSV and the evidence packet are generated from the same report.`)}
<form class="filters row" method="get" action="/staff/readiness/report">${select({ name: "subsystem", label: "Subsystem", options: [...new Set(report.requirements.map((x) => x.subsystem))].map((s) => ({ value: s, label: s })), value: f.subsystem, includeBlank: "All" })}
${select({ name: "env", label: "Environment", options: [...ENVS], value: f.env, includeBlank: "Any" })}${select({ name: "verification", label: "Verification", options: ["passed", "failed", "none"], value: f.verification, includeBlank: "Any" })}
${select({ name: "state", label: "State", options: STATES, value: f.state, includeBlank: "All" })}<div class="form-actions">${button("Filter", { variant: "secondary", size: "sm" })}</div></form></div>
${feedPanel(feeds)}${decisionPanel(report)}${metersPanel(report)}${await gatesPanel(ctx, report)}
<section class="stack"><h2 style="font-size:1.4rem">Failed requirements</h2>${matrix(report.requirements.filter((x) => x.state === "test_failed"), locs)}</section>
<section class="stack"><h2 style="font-size:1.4rem">Open blockers</h2>${table(blockers.filter((b) => b.status === "open"), [{ header: "ID", cell: (b) => b.id }, { header: "Category", cell: (b) => label(b.category) }, { header: "Description", cell: (b) => b.description }, { header: "Severity", cell: (b) => label(b.severity) }, { header: "Owner", cell: (b) => b.owner }, { header: "Requirements", cell: (b) => b.requirement_ids.join(" ") || "—" }], { empty: html`<p class="faint">No open blockers.</p>` })}</section>
<section class="stack"><h2 style="font-size:1.4rem">Requirements${filtered ? ` (filtered: ${rows.length} of ${report.requirements.length})` : ""}</h2>${matrix(rows, locs)}</section>
<p class="faint">Evidence set ${report.evidenceSetSha256}. This report, the CSV export and the evidence packet are all produced by the same buildReport() computation.</p></div>`);
  });

  r.get("/staff/readiness/snapshots", async (ctx) => {
    requireStaff(ctx, "readiness.read");
    const snaps = await ra.listSnapshots(ctx.db);
    const { report } = await ra.loadReport(ctx);
    const current = ra.reportSummary(report);
    return page(ctx, "Snapshots", html`${pageHead("Historical snapshots", can(ctx.actor!, "settings.operational") ? actionForm(ctx, "/staff/readiness/snapshots", "Save snapshot now", { variant: "primary" }) : undefined, "Launch readiness")}${subnav(ctx)}
${table(snaps, [{ header: "Taken", cell: (s) => html`<a href="/staff/readiness/snapshots/${s.id}">${formatDateTime(s.taken_at)}</a>` }, { header: "By", cell: (s) => s.taken_by_name ?? "—" },
      ...DIMENSIONS.slice(0, 4).map((d) => ({ header: d.label, cell: (s: (typeof snaps)[number]) => `${s.summary.scores.dimensions[d.key].percent}%`, numeric: true })),
      { header: "Gates passing", cell: (s) => s.summary.gates.filter((g) => g.status === "pass").length, numeric: true }, { header: "Evidence set", cell: (s) => html`<code>${s.summary.evidenceSetSha256.slice(0, 10)}…</code>` }],
      { empty: emptyState("No snapshots yet", "Save a snapshot to keep a point-in-time copy of the computed report for later comparison.") })}
${snaps[0] ? html`<section class="card stack"><h2 style="font-size:1.3rem">Latest snapshot vs current</h2>${compareSummaries(current, snaps[0].summary, formatDateTime(snaps[0].taken_at))}</section>` : ""}`);
  });
  r.post("/staff/readiness/snapshots", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const id = await ra.saveSnapshot(ctx, ctx.user!.id);
    return redirect(ctx, `/staff/readiness/snapshots/${id}`, { kind: "success", text: "Snapshot saved." });
  });
  r.get("/staff/readiness/snapshots/:id", async (ctx, p) => {
    requireStaff(ctx, "readiness.read");
    const s = await ra.getSnapshot(ctx.db, p.id);
    if (!s) throw new HttpError(404, "Snapshot not found.");
    const { report } = await ra.loadReport(ctx);
    return page(ctx, "Snapshot", html`${pageHead(`Snapshot ${formatDateTime(s.taken_at)}`, linkButton("All snapshots", "/staff/readiness/snapshots", "ghost", "sm"), "Launch readiness")}${subnav(ctx)}
<p class="muted">Taken by ${s.taken_by_name ?? "unknown"} · inventory ${s.inventory_version}. Decision at the time: ${s.summary.decision.summary}</p>
<section class="card stack"><h2 style="font-size:1.3rem">Snapshot vs current</h2>${compareSummaries(ra.reportSummary(report), s.summary, "Snapshot")}</section>`);
  });
}
