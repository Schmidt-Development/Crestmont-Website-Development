// Operations (INFRA-005, READY-006, READY-009, LAUNCH-002, LAUNCH-003, SEC-006, DOC-003).
//
// Signed automation endpoints (HMAC-SHA256 with EVIDENCE_INGEST_SECRET, the same scheme as
// /api/readiness/evidence; fail closed when the secret is not configured):
//   POST /api/readiness/deployments            record / update a deployment (GitHub Actions)
//   POST /api/readiness/release-candidates     create a release candidate from a v* tag
//   GET  /api/readiness/release-authorization  read-only: is this exact commit Founder-approved?
// Staff pages:
//   /staff/ops                      deployments with release-candidate match, environment URLs and probes
//   /staff/ops/retention            retention schedule, staff-set periods (Owner), run history
//   /staff/readiness/founder-report §77 final status report from readiness records (+ .md download)
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, label, safeUrl, type SafeHtml } from "../lib/html.ts";
import { HttpError, download, htmlResponse, jsonResponse, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { appLayout } from "../ui/layout.ts";
import { csrf, input, button, formErrors, alert, badge, table, emptyState, pageHead, dl, kpi, actionForm, tabs } from "../ui/components.ts";
import { staffNav } from "./nav.ts";
import { can, isOwner } from "../domain/authz.ts";
import { verifyEvidenceSignature, IngestAuthError } from "../readiness/ingest.ts";
import { ValidationError } from "../lib/validate.ts";
import { nowIso } from "../lib/db.ts";
import { readBody } from "./api.ts";
import { audit } from "../services/security.ts";
import * as ra from "../services/readiness-admin.ts";
import * as dep from "../services/deployments.ts";
import * as ret from "../services/retention.ts";

// ───────────── Signed automation ─────────────

async function verifySigned(ctx: AppContext, body: string): Promise<void> {
  try {
    await verifyEvidenceSignature(ctx.env.EVIDENCE_INGEST_SECRET, body, ctx.req.headers.get("x-crestmont-signature"));
  } catch (e) {
    if (e instanceof IngestAuthError) throw new HttpError(401, e.message);
    throw e;
  }
}

/** Canonical string signed for GET requests: path + query exactly as sent. */
export const signedGetCanonical = (url: URL) => `GET ${url.pathname}${url.search}`;

const apiError = (ctx: AppContext, e: unknown) => {
  if (e instanceof dep.DeploymentError) return jsonResponse(ctx, e.status, { error: e.message });
  throw e;
};

// ───────────── Founder report (§77, DOC-003) ─────────────

export interface SubsystemRow {
  subsystem: string; total: number; implemented: number; tested: number; passing: number; failing: number;
  stagingVerified: number; productionVerified: number; blocked: number; blockers: string[]; evidence: string[]; remaining: string[];
}

export interface FounderReport {
  generatedAt: string; evidenceSetSha256: string; scores: ra.Report["scores"]; gates: ra.Report["gates"]; decision: ra.Report["decision"];
  subsystems: SubsystemRow[]; openBlockers: number; markdown: string;
}

const yn = (n: number, total: number) => (n === total ? "yes" : `no (${n}/${total})`);
const missingOf = (loc: string | null | undefined) => /\(missing: ([\s\S]*)\)$/.exec(loc ?? "")?.[1] ?? null;
const mdCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/** Builds the §77 report from the same buildReport() output the dashboard uses. No number is typed by hand. */
export async function buildFounderReport(ctx: Pick<AppContext, "db" | "now">): Promise<FounderReport> {
  const { report } = await ra.loadReport(ctx);
  const locs = await ra.requirementLocations(ctx.db);
  const blockers = await ra.listBlockers(ctx.db);
  const openBlockers = blockers.filter((b) => b.status === "open");
  const order: string[] = [];
  const groups = new Map<string, ra.Report["requirements"]>();
  for (const r of report.requirements) {
    if (!groups.has(r.subsystem)) { groups.set(r.subsystem, []); order.push(r.subsystem); }
    groups.get(r.subsystem)!.push(r);
  }
  const ENVS = ["development", "staging", "production"] as const;
  const subsystems: SubsystemRow[] = order.map((name) => {
    const rs = groups.get(name)!;
    const blockerIds = [...new Set(rs.flatMap((r) => r.blockers))].sort();
    const remaining: string[] = [];
    for (const r of rs) {
      if (r.implementation !== "implemented") remaining.push(`${r.id}: ${missingOf(locs.get(r.id)?.location) ?? `implementation ${label(r.implementation).toLowerCase()}`}`);
      else if (r.state === "test_failed") remaining.push(`${r.id}: fix failing tests`);
      else if (r.verification.staging !== "passed" && r.verification.production !== "passed") remaining.push(`${r.id}: verify in staging`);
    }
    for (const id of blockerIds) {
      const b = openBlockers.find((x) => x.id === id);
      if (b) remaining.push(`${id}: ${b.required_action}`);
    }
    return {
      subsystem: name, total: rs.length,
      implemented: rs.filter((r) => r.implementation === "implemented").length,
      tested: rs.filter((r) => ENVS.some((e) => r.verification[e] !== "none")).length,
      passing: rs.filter((r) => ENVS.some((e) => r.verification[e] === "passed") && !ENVS.some((e) => r.verification[e] === "failed")).length,
      failing: rs.filter((r) => r.state === "test_failed").length,
      stagingVerified: rs.filter((r) => r.verification.staging === "passed").length,
      productionVerified: rs.filter((r) => r.verification.production === "passed").length,
      blocked: rs.filter((r) => r.state === "blocked").length,
      blockers: blockerIds,
      evidence: [...new Set(rs.flatMap((r) => r.evidenceRunIds))].sort(),
      remaining,
    };
  });

  const c = report.scores.counts;
  const lines: string[] = [];
  lines.push(`# Crestmont — final status report (§77)`, "");
  lines.push(`Generated ${report.generatedAt} from the readiness records (requirements inventory, implementation records, ingested evidence, blocker register, approvals and deployments). Every figure below is computed by the same engine as /staff/readiness; nothing is entered by hand.`, "");
  lines.push(`**Launch decision:** ${report.decision.summary}`, "");
  lines.push(`Evidence set: \`${report.evidenceSetSha256}\``, "");
  lines.push(`## Inventory totals`, "", `| Measure | Count | Of inventory | Percent |`, `|---|---:|---:|---:|`);
  for (const [k, l] of [["implemented", "Implemented"], ["tested", "Tested (any environment)"], ["passing", "Passing"], ["failing", "Failing"], ["blocked", "Blocked"], ["verifiedInStaging", "Verified in staging"], ["productionVerified", "Production verified"]] as const) {
    lines.push(`| ${l} | ${c[k].count} | ${c[k].total} | ${c[k].percent}% |`);
  }
  lines.push("", `Denominator: ${report.scores.denominator.total} requirements. ${report.scores.denominator.definition}`, "");
  lines.push(`## Launch gates`, "", `| Gate | Status | Current evidence | Blockers |`, `|---|---|---|---|`);
  for (const g of report.gates) lines.push(`| ${g.id} — ${g.name} | ${g.status} | ${mdCell(g.currentEvidence)} | ${g.blockers.join(", ") || "—"} |`);
  lines.push("", `## Subsystems`, "", "“yes” means every requirement in the subsystem meets the condition; otherwise the count is shown.", "");
  lines.push(`| Subsystem | Implemented | Tested | Staging verified | Production verified | Blocked | Evidence | Remaining action |`, `|---|---|---|---|---|---|---|---|`);
  for (const s of subsystems) {
    const ev = s.evidence.length ? `${s.evidence.slice(0, 3).map((e) => `\`${e}\``).join(", ")}${s.evidence.length > 3 ? ` +${s.evidence.length - 3} more` : ""}` : "none";
    const rem = s.remaining.length ? `${s.remaining.slice(0, 4).join("; ")}${s.remaining.length > 4 ? `; +${s.remaining.length - 4} more` : ""}` : "none";
    lines.push(`| ${mdCell(s.subsystem)} | ${yn(s.implemented, s.total)} | ${s.failing ? `no (${s.failing} failing)` : yn(s.passing, s.total)} | ${yn(s.stagingVerified, s.total)} | ${yn(s.productionVerified, s.total)} | ${s.blocked ? `yes (${s.blockers.join(", ") || `${s.blocked} requirement(s)`})` : "no"} | ${ev} | ${mdCell(rem)} |`);
  }
  lines.push("", `## Open blockers (${openBlockers.length})`, "");
  if (!openBlockers.length) lines.push("None recorded.");
  for (const b of openBlockers) lines.push(`- **${b.id}** (${b.category}, ${b.severity}) — ${mdCell(b.description)} → ${mdCell(b.required_action)} *(owner: ${b.owner})*`);
  lines.push("", report.decision.launched ? "" : "Crestmont is **not production-ready**: release-blocking requirements remain unresolved.", "");

  return { generatedAt: report.generatedAt, evidenceSetSha256: report.evidenceSetSha256, scores: report.scores, gates: report.gates, decision: report.decision, subsystems, openBlockers: openBlockers.length, markdown: lines.join("\n") };
}

// ───────────── Staff pages ─────────────

const page = (ctx: AppContext, title: string, body: SafeHtml, status = 200) =>
  htmlResponse(ctx, appLayout(ctx, { title, nav: staffNav(ctx), home: "/staff", area: "Operations" }, body), status);

const subnav = (ctx: AppContext) => tabs([
  ["/staff/ops", "Deployments & environments"], ["/staff/ops/retention", "Data retention"], ["/staff/readiness/founder-report", "Founder status report"],
].map(([href, l]) => ({ href, label: l, current: ctx.url.pathname === href })));

const short = (s: string | null | undefined) => (s ? s.slice(0, 7) : "—");

function releaseBadge(d: dep.DeploymentView): SafeHtml {
  if (d.release_check === "mismatch") return badge("fail", "Does not match approved release");
  if (d.release_check === "matches_approved_release") return badge("pass", "Matches approved release");
  return d.environment === "production" ? badge("unavailable", "Not checked") : html`<span class="faint">n/a</span>`;
}

async function opsPage(ctx: AppContext, errors: string[] = [], status = 200): Promise<Response> {
  requireStaff(ctx, "readiness.read");
  const deps = await dep.listDeployments(ctx.db, undefined, 100);
  const envs = await dep.environmentStatus(ctx.db, ctx.settings);
  const canEdit = can(ctx.actor!, "settings.operational");
  const mismatches = deps.filter((d) => d.environment === "production" && d.release_check === "mismatch" && d.status !== "rolled_back" && d.status !== "failed");
  const prod = deps.find((d) => d.environment === "production" && d.status === "succeeded") ?? null;
  const stag = deps.find((d) => d.environment === "staging" && d.status === "succeeded") ?? null;
  const rc = await ra.currentReleaseCandidate(ctx.db);
  return page(ctx, "Deployments & environments", html`${pageHead("Deployments & environments", undefined, "Operations")}${subnav(ctx)}${formErrors(errors)}
${mismatches.length ? alert("error", html`<strong>Production does not match the Founder-approved release candidate.</strong> ${mismatches.map((d) => html`Deployment ${d.id} (commit <code>${d.commit_sha}</code>)${d.incident_blocker_id ? html` — incident <a href="/staff/readiness/blockers/${d.incident_blocker_id}">${d.incident_blocker_id}</a>` : ""}. `)}`) : ""}
<div class="grid grid-4 kpis">${kpi("Production", prod ? short(prod.commit_sha) : "Never deployed", prod ? formatDateTime(prod.deployed_at) : "No production deployment recorded")}
${kpi("Staging", stag ? short(stag.commit_sha) : "Never deployed", stag ? formatDateTime(stag.deployed_at) : "No staging deployment recorded")}
${kpi("Release candidate", rc ? short(rc.commit_sha) : "None", rc ? `${rc.id} · ${formatDateTime(rc.created_at)}` : "No release candidate")}
${kpi("Deployments recorded", deps.length, "All environments")}</div>
<section class="card stack" aria-labelledby="dep-h"><h2 id="dep-h" style="font-size:1.4rem">Deployment history</h2>
<p class="faint">Recorded by the signed GitHub Actions deploy workflows (POST /api/readiness/deployments). Production deployments are compared with the commit of the Founder-approved release candidate when first recorded (LAUNCH-002); a mismatch opens a critical production-incident blocker that also fails Gate H.</p>
${table(deps, [
    { header: "Deployment", cell: (d) => html`${d.id}${d.run_url ? html` <a href="${safeUrl(d.run_url)}" rel="noopener">run</a>` : ""}` },
    { header: "Env", cell: (d) => label(d.environment) },
    { header: "Commit", cell: (d) => html`<code title="${d.commit_sha}">${short(d.commit_sha)}</code>` },
    { header: "Status", cell: (d) => badge(d.status) },
    { header: "Verification", cell: (d) => badge(d.verification_status ?? "not_started", label(d.verification_status ?? "not recorded")) },
    { header: "Release candidate", cell: (d) => html`${releaseBadge(d)}${d.release_check_detail && d.release_check !== "not_applicable" ? html`<br><span class="faint" style="font-size:.8rem">${d.release_check_detail}</span>` : ""}` },
    { header: "Rollback target", cell: (d) => d.rollback_target_deployment_id ?? "—" },
    { header: "When", cell: (d) => formatDateTime(d.deployed_at) },
    { header: "By", cell: (d) => d.initiated_by },
  ], { empty: emptyState("No deployments recorded", "Staging and production have never been deployed. Deployments appear here when the deploy workflows run (they need the Cloudflare account, BLK-003)."), caption: "Deployments" })}</section>
<section class="card stack" aria-labelledby="env-h"><h2 id="env-h" style="font-size:1.4rem">Environment probes</h2>
<p class="faint">Every 15 minutes the scheduled probe checks DNS resolution, TLS (a completed HTTPS request) and <code>/api/health</code> for each configured URL and records the result as the <em>dns</em> and <em>monitoring</em> integration rows of that environment. Production probe results are also recorded as production_check evidence for the deployed commit when they change. Unconfigured environments are not probed and nothing is recorded for them.</p>
${table(envs, [
    { header: "Environment", cell: (e) => label(e.environment) },
    { header: "URL", cell: (e) => (e.url ? html`<a href="${safeUrl(e.url)}" rel="noopener">${e.url}</a>` : html`<span class="faint">Not set</span>`) },
    { header: "DNS / TLS", cell: (e) => { const r = e.rows.find((x) => x.integration === "dns"); return r ? html`${badge(r.status)}<br><span class="faint" style="font-size:.8rem">${r.detail ?? ""} (${formatDateTime(r.checked_at)})</span>` : html`<span class="faint">No probe recorded</span>`; } },
    { header: "Health", cell: (e) => { const r = e.rows.find((x) => x.integration === "monitoring"); return r ? html`${badge(r.status)}<br><span class="faint" style="font-size:.8rem">${r.detail ?? ""} (${formatDateTime(r.checked_at)})</span>` : html`<span class="faint">No probe recorded</span>`; } },
  ])}
${canEdit ? html`<form class="stack" method="post" action="/staff/ops/environments">${csrf(ctx)}<div class="grid grid-2">
${input({ name: "staging_url", label: "Staging URL", value: ctx.settings[dep.envUrlKey("staging")] ?? "", placeholder: "https://staging.example.com", hint: "Public https origin only. Leave empty to stop probing." })}
${input({ name: "production_url", label: "Production URL", value: ctx.settings[dep.envUrlKey("production")] ?? "", placeholder: "https://crestmontwebsitedevelopment.com", hint: "Public https origin only. Leave empty to stop probing." })}</div>
<div class="form-actions">${button("Save environment URLs", { variant: "secondary" })}</div></form>
${actionForm(ctx, "/staff/ops/probe", "Run environment probe now", { variant: "ghost" })}` : ""}</section>`, status);
}

async function retentionPage(ctx: AppContext, errors: string[] = [], status = 200): Promise<Response> {
  requireStaff(ctx, "settings.operational");
  const history = await ret.retentionHistory(ctx.db, 80);
  const owner = isOwner(ctx.actor!);
  return page(ctx, "Data retention", html`${pageHead("Data retention", undefined, "Operations")}${subnav(ctx)}${formErrors(errors)}
${alert("warn", html`<strong>Proposed schedule — pending Founder and attorney approval.</strong> The personal-data periods below are proposals (docs/RETENTION-SCHEDULE.md). They are applied only after the Owner sets a period here; until then that category is never purged. Audit logs, financial records and agreements are never deleted by this job.`)}
<section class="card stack"><h2 style="font-size:1.4rem">Always applied (expired operational data)</h2>
${table(ret.ALWAYS_RULES, [{ header: "Category", cell: (r) => r.label }, { header: "Rule", cell: (r) => r.description }])}</section>
<section class="card stack"><h2 style="font-size:1.4rem">Applied only when configured</h2>
${table(ret.CONFIGURABLE_RULES, [
    { header: "Category", cell: (r) => r.label },
    { header: "What happens", cell: (r) => r.description },
    { header: "Proposed", cell: (r) => `${r.proposedDays} days`, numeric: true },
    { header: "Configured", cell: (r) => { const d = ret.configuredDays(ctx.settings, r); return d === null ? badge("not_configured", "Off") : typeof d === "string" ? badge("failing", "Invalid") : `${d} days`; } },
  ])}
${owner ? html`<form class="stack" method="post" action="/staff/ops/retention">${csrf(ctx)}
<p class="faint">Only the Owner can turn a period on, after Founder/attorney approval of the schedule. Leave a field empty to keep that category off.</p>
<div class="grid grid-2">${ret.CONFIGURABLE_RULES.map((r) => input({ name: r.key, label: `${r.label} (days)`, type: "number", min: r.minDays, max: r.maxDays, value: ctx.settings[r.key] ?? "", hint: `${r.minDays}–${r.maxDays}; proposed ${r.proposedDays}` }))}</div>
<div class="form-actions">${button("Save retention periods")}</div></form>` : html`<p class="faint">Only the Owner can change retention periods.</p>`}</section>
<section class="card stack"><h2 style="font-size:1.4rem">Run history</h2>
${table(history, [{ header: "Ran", cell: (h) => formatDateTime(h.ran_at) }, { header: "Category", cell: (h) => h.category }, { header: "Mode", cell: (h) => badge(h.mode === "skipped" ? "not_configured" : "active", label(h.mode)) },
    { header: "Cutoff", cell: (h) => formatDateTime(h.cutoff) }, { header: "Affected", cell: (h) => h.affected, numeric: true }, { header: "Detail", cell: (h) => h.detail ?? "" }],
    { empty: emptyState("No retention runs yet", "The retention job runs daily from the scheduled worker (not yet deployed, BLK-003). Development runs appear here when the job is run locally.") })}</section>`, status);
}

async function founderReportPage(ctx: AppContext): Promise<Response> {
  requireStaff(ctx, "readiness.read");
  const fr = await buildFounderReport(ctx);
  const c = fr.scores.counts;
  return page(ctx, "Founder status report", html`${pageHead("Final status report", html`<a class="btn btn--secondary btn--sm" href="/staff/readiness/founder-report.md">Download Markdown</a>`, "Launch readiness")}${subnav(ctx)}
${alert(fr.decision.launched ? "success" : "warn", html`<strong>${fr.decision.summary}</strong> Computed ${formatDateTime(fr.generatedAt)} from the readiness records; the same figures appear on /staff/readiness.`)}
<div class="grid grid-4 kpis">${kpi("Implemented", `${c.implemented.count} / ${c.implemented.total}`, `${c.implemented.percent}%`)}${kpi("Passing", `${c.passing.count} / ${c.passing.total}`, `${c.passing.percent}%`)}
${kpi("Verified in staging", `${c.verifiedInStaging.count} / ${c.verifiedInStaging.total}`, `${c.verifiedInStaging.percent}%`)}${kpi("Production verified", `${c.productionVerified.count} / ${c.productionVerified.total}`, `${c.productionVerified.percent}%`)}</div>
<section class="card stack"><h2 style="font-size:1.4rem">Subsystems (§77)</h2>
${table(fr.subsystems, [
    { header: "Subsystem", cell: (s) => s.subsystem },
    { header: "Implemented", cell: (s) => yn(s.implemented, s.total) },
    { header: "Tested", cell: (s) => (s.failing ? `no (${s.failing} failing)` : yn(s.passing, s.total)) },
    { header: "Staging verified", cell: (s) => yn(s.stagingVerified, s.total) },
    { header: "Production verified", cell: (s) => yn(s.productionVerified, s.total) },
    { header: "Blocked", cell: (s) => (s.blocked ? html`yes ${s.blockers.map((b) => html`<a href="/staff/readiness/blockers/${b}">${b}</a> `)}` : "no") },
    { header: "Evidence", cell: (s) => (s.evidence.length ? html`${s.evidence.slice(0, 3).map((id) => html`<a href="/staff/readiness/runs/${encodeURIComponent(id)}">${id.length > 18 ? id.slice(0, 16) + "…" : id}</a> `)}${s.evidence.length > 3 ? ` +${s.evidence.length - 3}` : ""}` : "none") },
    { header: "Remaining action", cell: (s) => (s.remaining.length ? html`<span style="font-size:.85rem">${s.remaining.slice(0, 4).join("; ")}${s.remaining.length > 4 ? `; +${s.remaining.length - 4} more` : ""}</span>` : "none") },
  ], { caption: "Final status per subsystem" })}</section>
<section class="card stack"><h2 style="font-size:1.4rem">Gates</h2>${table(fr.gates, [{ header: "Gate", cell: (g) => `${g.id} — ${g.name}` }, { header: "Status", cell: (g) => badge(g.status) }, { header: "Current evidence", cell: (g) => g.currentEvidence }])}</section>
<p class="faint">Open blockers: ${fr.openBlockers}. Evidence set <code>${fr.evidenceSetSha256}</code>. The acceptance checklist mapping these figures to gates A–H is docs/FOUNDER-ACCEPTANCE-CHECKLIST.md.</p>`);
}

// ───────────── Registration ─────────────

export function register(r: Router): void {
  r.post("/api/readiness/deployments", async (ctx) => {
    const raw = await readBody(ctx.req);
    await verifySigned(ctx, raw);
    try { return jsonResponse(ctx, 200, await dep.recordDeployment(ctx, raw)); } catch (e) { return apiError(ctx, e); }
  });

  r.post("/api/readiness/release-candidates", async (ctx) => {
    const raw = await readBody(ctx.req);
    await verifySigned(ctx, raw);
    try { return jsonResponse(ctx, 200, await dep.createCandidateFromTag(ctx, raw)); } catch (e) { return apiError(ctx, e); }
  });

  // Read-only. Signed (automation) or a staff session with readiness.read. Grants nothing.
  r.get("/api/readiness/release-authorization", async (ctx) => {
    const staff = !!ctx.actor && ctx.actor.kind === "user" && can(ctx.actor, "readiness.read");
    if (!staff) await verifySigned(ctx, signedGetCanonical(ctx.url));
    const commit = ctx.url.searchParams.get("commit") ?? "";
    const config = ctx.url.searchParams.get("config");
    if (!/^[0-9a-fA-F]{7,40}$/.test(commit)) throw new ValidationError(["commit must be a hexadecimal git SHA"]);
    if (config !== null && !/^[0-9a-f]{64}$/.test(config)) throw new ValidationError(["config must be a 64-character SHA-256 hex digest"]);
    const a = await dep.releaseAuthorization(ctx, commit);
    const rc = a.releaseCandidate ? await ra.currentReleaseCandidate(ctx.db) : null;
    if (a.authorized && config !== null && rc && rc.config_sha256 !== config) {
      return jsonResponse(ctx, 200, { ...a, authorized: false, reason: "Deployment configuration differs from the approved release candidate configuration." });
    }
    return jsonResponse(ctx, 200, a);
  });

  r.get("/staff/ops", (ctx) => opsPage(ctx));
  r.post("/staff/ops/environments", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const f = await ctx.form();
    const errors: string[] = [];
    for (const env of dep.PROBE_ENVIRONMENTS) {
      const value = str(f, `${env}_url`);
      if (value === (ctx.settings[dep.envUrlKey(env)] ?? "")) continue;
      try { await dep.saveEnvUrl(ctx.db, ctx.user!.id, env, value); } catch (e) { if (e instanceof dep.DeploymentError) errors.push(`${label(env)}: ${e.message}`); else throw e; }
    }
    if (errors.length) return opsPage(ctx, errors, 422);
    return redirect(ctx, "/staff/ops", { kind: "success", text: "Environment URLs saved." });
  });
  r.post("/staff/ops/probe", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    const out = await dep.probeEnvironments(ctx);
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "ops.environment_probe", subjectType: "environment", details: out.map((o) => ({ env: o.environment, ran: o.ran, detail: o.detail })) });
    return redirect(ctx, "/staff/ops", { kind: out.some((o) => o.ran) ? "success" : "info", text: out.map((o) => `${o.environment}: ${o.detail}`).join(" · ") });
  });

  r.get("/staff/ops/retention", (ctx) => retentionPage(ctx));
  r.post("/staff/ops/retention", async (ctx) => {
    requireStaff(ctx, "settings.operational");
    if (!isOwner(ctx.actor!)) throw new HttpError(403, "Only the Owner can set retention periods (pending Founder/attorney approval of the schedule).");
    const f = await ctx.form();
    const errors: string[] = [];
    const changes: { key: string; value: string }[] = [];
    for (const rule of ret.CONFIGURABLE_RULES) {
      const v = str(f, rule.key);
      if (v === (ctx.settings[rule.key] ?? "")) continue;
      if (v && typeof ret.configuredDays({ [rule.key]: v }, rule) === "string") { errors.push(`${rule.label}: whole days between ${rule.minDays} and ${rule.maxDays}`); continue; }
      changes.push({ key: rule.key, value: v });
    }
    if (errors.length) return retentionPage(ctx, errors, 422);
    if (changes.length) {
      const at = nowIso();
      await ctx.db.batch(changes.map((c) => c.value
        ? ctx.db.prepare(`INSERT INTO business_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(c.key, c.value, ctx.user!.id, at)
        : ctx.db.prepare(`DELETE FROM business_settings WHERE key = ?`).bind(c.key)));
      await audit(ctx.db, { actorUserId: ctx.user!.id, action: "retention.periods_updated", subjectType: "business_settings", details: { changes } });
    }
    return redirect(ctx, "/staff/ops/retention", { kind: "success", text: changes.length ? `Saved: ${changes.map((c) => c.key).join(", ")}.` : "No changes." });
  });

  r.get("/staff/readiness/founder-report", (ctx) => founderReportPage(ctx));
  r.get("/staff/readiness/founder-report.md", async (ctx) => {
    requireStaff(ctx, "readiness.read");
    const fr = await buildFounderReport(ctx);
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "readiness.exported", subjectType: "readiness_report", details: { format: "founder_report", evidenceSetSha256: fr.evidenceSetSha256 } });
    return download(ctx, fr.markdown, `crestmont-final-status-${fr.generatedAt.slice(0, 10)}.md`, "text/markdown; charset=utf-8");
  });
}
