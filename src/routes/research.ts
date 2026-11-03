// Lead research — signed worker API and the Owner/administrator research operations page.
//  POST /api/research/runner/heartbeat   (HMAC, RESEARCH_RUNNER_SECRET) worker status in, controls out
//  POST /api/research/runner/batch       (HMAC) idempotent batch of prospects with evidence
//  GET  /staff/research                  dashboard + prospect queue (lead.read_all)
//  POST /staff/research/settings         pause/resume, thresholds (Owner only)
//  POST /staff/research/promote          prospect → CRM lead (lead.write_all), audited
//  POST /staff/research/dismiss          prospect dismissed with a reason (lead.write_all), audited
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, safeHttpsUrl, type SafeHtml } from "../lib/html.ts";
import { HttpError, jsonResponse, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { can, isOwner } from "../domain/authz.ts";
import { alert, badge, button, csrf, emptyState, input, kpi, pageHead, pageParam, pagination, select, table, textarea, checkbox, actionForm, barChart, dl } from "../ui/components.ts";
import { staffPage } from "./crm.ts";
import { verifyRunnerSignature } from "../services/builds.ts";
import { claimSignatureOnce } from "../services/security.ts";
import * as R from "../services/research.ts";
import { eligibilityCensus, importRate, promotionTotals, recentRuns, runAutoPromotion, TARGET_PER_MINUTE } from "../services/research-promote.ts";
import { WEBSITE_CLASSES, WEBSITE_CLASS_LABELS, PROSPECT_STATUSES, type Finding } from "../domain/research.ts";

const RUNNER = "/api/research/runner";
const MAX_BODY = 5_000_000;

/** Signed worker body: HMAC over `t.body` with RESEARCH_RUNNER_SECRET, a mandatory single-use _nonce, JSON object. */
async function runnerBody(ctx: AppContext): Promise<Record<string, unknown>> {
  // RESEARCH_RUNNER_SECRET is the Founder's (shared with the Node 1 worker, docs/research/RUNBOOK.md §1). On staging only,
  // the deploy-derived RESEARCH_E2E_RUNNER_SECRET is also accepted so the deploy's live E2E can authenticate without
  // overwriting the Founder's value (it did, silently, when the two drifted apart: every heartbeat → "Signature mismatch").
  // Production never honours the E2E key.
  const secrets = [ctx.env.RESEARCH_RUNNER_SECRET, ctx.env.ENVIRONMENT === "staging" ? ctx.env.RESEARCH_E2E_RUNNER_SECRET : undefined].filter((s): s is string => !!s);
  // Not configured → no worker can authenticate (fail closed with 401, the same answer as a bad signature).
  if (!secrets.length) throw new HttpError(401, "Research worker not configured");
  const raw = await ctx.req.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, "Request too large");
  const header = ctx.req.headers.get("x-crestmont-research-signature");
  let lastError: Error | null = null;
  for (const secret of secrets) {
    try { await verifyRunnerSignature(secret, raw, header); lastError = null; break; }
    catch (e) { lastError = e as Error; }
  }
  if (lastError) throw new HttpError(401, lastError.message);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, "Malformed JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
  const nonce = (body as Record<string, unknown>)._nonce;
  if (typeof nonce !== "string" || !/^[0-9a-f]{32,64}$/.test(nonce)) throw new HttpError(400, "Signed body must carry a _nonce");
  if (!(await claimSignatureOnce(ctx.db, `research:${nonce}`))) throw new HttpError(409, "Replayed request");
  return body as Record<string, unknown>;
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const SEVERITY_TONE: Record<string, string> = { critical: "bad", high: "warn", medium: "info", low: "" };
const STATUS_LABEL: Record<string, string> = { qualified: "Qualified", not_qualified: "Not qualified", review: "Needs review", promoted: "In CRM", existing_crm: "Already in CRM", suppressed: "Do not call", dismissed: "Dismissed" };

function findingsList(p: R.ProspectRow): SafeHtml {
  const f = JSON.parse(p.findings_json) as Finding[];
  if (!f.length) return html`<p class="faint">No website findings recorded.</p>`;
  return html`<ul class="research-findings">${f.map((x) => html`<li>${badge(SEVERITY_TONE[x.severity] ? x.severity : "low", x.severity)} <strong>${x.title}</strong> — ${x.evidence}
<div class="faint">${x.method} · confidence ${Math.round(x.confidence * 100)}% · ${formatDateTime(x.observedAt)} · <a href="${safeHttpsUrl(x.url)}" rel="noopener noreferrer nofollow">${x.url}</a>${x.reproduction ? html` · Reproduce: ${x.reproduction}` : ""}</div></li>`)}</ul>`;
}

function prospectDetail(ctx: AppContext, p: R.ProspectRow): SafeHtml {
  const web = JSON.parse(p.website_json) as { confidence: number; checkedAt: string; identitySignals: string[]; checks: { stage: string; method: string; result: string; at: string }[] };
  const sources = JSON.parse(p.sources_json) as { source: string; sourceId: string; license: string; release?: string; retrievedAt: string }[];
  const reasons = JSON.parse(p.qualification_json) as string[];
  const gate = JSON.parse(p.eligibility_json) as string[];
  const canWrite = can(ctx.actor!, "lead.write_all");
  return html`<details class="research-detail"><summary>Evidence</summary>
${dl([
    ["Address", [p.address_line, p.city, p.state, p.zip].filter(Boolean).join(", ") || "—"],
    ["Phone", p.phone_e164 ?? "—"], ["Email", p.email ?? "—"],
    ["Website", p.website_url ? html`<a href="${safeHttpsUrl(p.website_url)}" rel="noopener noreferrer nofollow">${p.website_url}</a>` : "—"],
    ["Website result", `${WEBSITE_CLASS_LABELS[p.website_class]} (confidence ${Math.round(web.confidence * 100)}%, checked ${formatDateTime(web.checkedAt)})`],
    ["Identity", `${Math.round(p.identity_confidence * 100)}% — ${web.identitySignals.join("; ") || "no matching signals recorded"}`],
    ["Score", `${p.score}/100${reasons.length ? ` — ${reasons.join("; ")}` : ""}`],
    ["Suggested package", p.recommended_package ?? "—"],
    ["Time zone", p.time_zone ?? "Not established"],
    ["Last verified", formatDateTime(p.last_verified_at)],
  ])}
<h4>Website checks</h4>${web.checks.length ? html`<ol class="faint">${web.checks.map((c) => html`<li>Stage ${c.stage}: ${c.method} — ${c.result} (${formatDateTime(c.at)})</li>`)}</ol>` : html`<p class="faint">None recorded.</p>`}
<h4>Findings</h4>${findingsList(p)}
${p.summary || p.brief ? html`<h4>Local-model draft <span class="faint">(${p.model ?? "model unknown"}; verify before use)</span></h4>${p.summary ? html`<p>${p.summary}</p>` : ""}${p.brief ? html`<p class="faint">${p.brief}</p>` : ""}` : ""}
<h4>Automated calling</h4><p>${badge("blocked", "Not released")} ${gate.join(" · ")}</p>
<h4>Provenance</h4><ul class="faint">${sources.map((s) => html`<li>${s.source} ${s.sourceId}${s.release ? ` (release ${s.release})` : ""} · ${s.license} · retrieved ${formatDateTime(s.retrievedAt)}</li>`)}</ul>
${canWrite && (p.status === "qualified" || p.status === "review") ? html`<div class="actions">${actionForm(ctx, "/staff/research/promote", "Create CRM lead", { variant: "primary", hidden: { prospect_id: p.id }, confirm: "Create a CRM lead (company, contact and lead) from this research record?" })}</div>` : ""}
${canWrite && p.status !== "promoted" && p.status !== "dismissed" ? html`<form method="post" action="/staff/research/dismiss" class="inline-form">${csrf(ctx)}<input type="hidden" name="prospect_id" value="${p.id}">${input({ name: "reason", label: "Dismiss reason", required: true, maxlength: 300 })}${button("Dismiss", { variant: "ghost", size: "sm" })}</form>` : ""}
${p.crm_lead_id ? html`<p><a href="/staff/crm/leads/${p.crm_lead_id}">Open CRM lead</a></p>` : ""}
</details>`;
}

async function page(ctx: AppContext): Promise<Response> {
  requireStaff(ctx, "lead.read_all");
  const now = ctx.now();
  const [d, settings, sources, census, promotion30, promotionRuns, rate60, rate15] = await Promise.all([
    R.dashboard(ctx.db, now), R.loadSettings(ctx.db), R.listSources(ctx.db),
    eligibilityCensus(ctx.db), promotionTotals(ctx.db, new Date(now.getTime() - 30 * 86400e3).toISOString()), recentRuns(ctx.db, 8),
    // Both read from the leads table, so what is shown is what the CRM actually holds, not what the promoter counted.
    importRate(ctx.db, 60, now), importRate(ctx.db, 15, now),
  ]);
  // Only the records that genuinely need a person are listed here. General prospect browsing belongs in the CRM:
  // once a prospect is promoted it is an ordinary CRM lead, and a second browser over the same businesses was the
  // "duplicate prospects management section" this page used to carry.
  const pg = pageParam(ctx);
  const rows = await R.listProspects(ctx.db, { status: "review" }, pg);
  const hasNext = rows.length > pg.limit;
  const runner = d.runners[0];
  const runnerStatus = runner ? JSON.parse(runner.status_json) as Record<string, unknown> : null;
  const online = runner ? now.getTime() - Date.parse(runner.last_seen_at) < R.RUNNER_ONLINE_S * 1000 : false;
  const refresh = (runnerStatus?.sources ?? {}) as Record<string, { lastRefreshAt?: string; release?: string; state?: string; error?: string }>;
  const owner = isOwner(ctx.actor!);
  const wc = runnerStatus?.classCounts;
  const workerClasses = wc && typeof wc === "object" && !Array.isArray(wc) ? Object.fromEntries(Object.entries(wc as Record<string, unknown>).filter(([, v]) => typeof v === "number" && Number.isFinite(v)).map(([k, v]) => [k, Math.max(0, Math.floor(v as number))])) as Record<string, number> : null;
  const body = html`
${pageHead("Lead research", undefined, "Sales")}
${settings.paused ? alert("warn", html`<strong>Research is paused.</strong> ${settings.pause_reason ?? ""} The worker keeps its queue and sends nothing until resumed.`) : ""}
${!ctx.env.RESEARCH_RUNNER_SECRET ? alert("warn", html`<strong>No research worker can connect.</strong> RESEARCH_RUNNER_SECRET is not set on this environment. Setup: docs/research/RUNBOOK.md.`) : ""}
${alert("info", html`<strong>Automated calling is off for research prospects.</strong> A number in an open dataset is not permission to place AI-voice calls. Every prospect is held by the outbound eligibility gate until a counsel-approved consent design exists (Founder decision D-14). Promoting a prospect creates a CRM lead for people to work; it never queues a call.`)}
<section class="kpis">
${kpi("Candidates evaluated today", d.evaluatedToday, "worker-reported; one row per business it finished checking")}
${kpi("Unique businesses received today", d.receivedToday ?? 0, `${d.rejectedToday} rejected by validation`)}
${kpi("Websites checked today", d.websitesToday, "worker-reported")}
${kpi("Research-qualified today", d.qualifiedToday, "meets the evidence rule; not the same as sales-qualified")}
${kpi("Eligible for the CRM now", census.eligibleNow, "qualified, at or above the threshold, nothing blocking")}
${kpi("CRM leads from research", d.crmLeadsFromResearch, `${d.crmLeadsFromResearchToday} created today`)}
${kpi("Needs a person", census.needsPerson, "shared number, or the same business as another record")}
${kpi("Awaiting verification", d.awaitingVerification, "website unverified or identity uncertain: cannot qualify")}
${kpi("Businesses on record", d.total)}
${kpi("Verified callable today", d.callable, "automated calling gate (fail-closed, always 0)")}
</section>
<p class="faint">Every figure above counts a different thing and they are never added together. "Research-qualified" means the
evidence rule in <code>src/domain/research.ts#qualify</code> passed. "Eligible for the CRM" is the population automatic
promotion is responsible for. A CRM lead is a sales record a person works; it is not permission to call anyone.</p>
<div class="grid grid--2">
<section class="card"><h2 class="card__title">Worker health</h2>
${runner ? dl([
    ["Worker", html`${runner.runner_id} ${online ? badge("healthy", "Online") : badge("failing", "Offline")}`],
    ["Version", runner.version ?? "—"], ["Last check-in", formatDateTime(runner.last_seen_at)],
    ["Queue depth", String(runnerStatus?.queueDepth ?? "—")], ["Websites checked today", String(d.websitesToday)],
    ["Failed jobs today", String(d.failedToday)],
    ["Throughput", runnerStatus?.recordsPerHour !== undefined ? `${runnerStatus.recordsPerHour} records/hour (worker-measured)` : "—"],
    ["Local model", String(runnerStatus?.model ?? "—")],
    // Source freshness stays on the page as operational information; the licence and configuration table it used to sit in is gone
    // (that configuration belongs in admin tooling, and the attribution line below records the legal obligation).
    ["Source refresh", sources.filter((x) => x.enabled).map((x) => `${x.source}: ${refresh[x.source]?.lastRefreshAt ? `${formatDateTime(refresh[x.source]!.lastRefreshAt!)}${refresh[x.source]!.release ? ` (${refresh[x.source]!.release})` : ""}` : "never"}`).join(" · ") || "no source enabled"],
    ["Resources", runnerStatus?.resources ? JSON.stringify(runnerStatus.resources).slice(0, 300) : "—"],
  ]) : emptyState("No worker has connected", "Install the research worker on the Windows workstation (docs/research/RUNBOOK.md). Until then nothing is researched.")}
</section>
<section class="card"><h2 class="card__title">Website classification</h2>
${workerClasses ? html`<h3 class="faint">Everything the worker evaluated (worker-reported)</h3>${barChart(WEBSITE_CLASSES.map((k) => ({ label: WEBSITE_CLASS_LABELS[k], value: workerClasses[k] ?? 0, display: String(workerClasses[k] ?? 0) })))}<h3 class="faint">Sent to the platform as possible opportunities</h3>` : ""}
${d.total ? barChart(d.byClass.map((c) => ({ label: c.label, value: c.n, display: String(c.n) }))) : html`<p class="faint">No prospects yet.</p>`}
<p class="faint">"No official website found" means the documented checks found none; it is not proof that the business has no website.</p>
</section>
</div>
<div class="grid grid--2">
<section class="card"><h2 class="card__title">Research → CRM</h2>
${dl([
    ["Eligible for the CRM now", String(census.eligibleNow)],
    ["Already a CRM lead", String(census.alreadyPromoted)],
    ["Matched an existing CRM contact", String(census.existingCrm)],
    ["Needs a person (shared number / same business)", String(census.needsPerson)],
    ["Suppressed (do-not-call, erasure)", String(census.suppressed)],
    ["Below the current threshold", String(census.belowThreshold)],
    ["Awaiting verification", String(census.awaitingVerification)],
    ["Not qualified", String(census.notQualified)],
    ["Dismissed by a person", String(census.dismissed)],
    ["Out of promotion attempts", String(census.outOfAttempts)],
  ])}
<p class="faint">These account for all ${census.totalOnRecord} businesses on record: every record is either eligible, already
in the CRM, or has a stated reason it is not. Automatic promotion is
<strong>${settings.auto_promote ? "on" : "off"}</strong>.</p>
${/* The import rate, counted from the CRM's own rows over a real clock window. "Reported" is the promoter's own
      tally of the same thing: the two must agree, and showing them side by side is what makes a disagreement
      visible instead of invisible. */ ""}
<h3 class="faint">Import rate (counted from the CRM, not from the promoter)</h3>
${dl([
    ["New leads in the last hour", html`<strong>${rate60.leads}</strong> <span class="faint">= ${rate60.perMinute.toFixed(1)}/minute (target ${TARGET_PER_MINUTE})</span>`],
    ["New leads in the last 15 minutes", html`${rate15.leads} <span class="faint">= ${rate15.perMinute.toFixed(1)}/minute</span>`],
    ["The promoter's own count, last hour", html`${rate60.reported} <span class="faint">${rate60.reported === rate60.leads ? "agrees with the CRM" : "DOES NOT match the CRM row count — investigate"}</span>`],
    ["Runs in the last hour", html`${rate60.runs} <span class="faint">${rate60.locked} skipped because the previous run was still going</span>`],
    ["Slowest / mean run", `${rate60.slowestMs} ms / ${rate60.meanMs} ms`],
    ["Failures / awaiting retry", html`${rate60.failed} <span class="faint">${rate60.retried} prospects are waiting on a retry</span>`],
    ["Held back for a shared identifier", html`${rate60.deferredIdentity} <span class="faint">promoted on a later run, never alongside the record they share it with</span>`],
    ["Eligible and waiting", String(rate60.backlog)],
  ])}
${settings.auto_promote
    ? rate60.belowTarget
      ? alert("warn", html`<strong>Below target.</strong> ${rate60.leads} new leads in the last hour (${rate60.perMinute.toFixed(1)}/minute against ${TARGET_PER_MINUTE}) while ${rate60.backlog} eligible prospects are waiting. The Owners are emailed about this once an hour.`)
      : rate60.backlog === 0
        ? html`<p class="faint">Nothing eligible is waiting, so the rate is whatever research delivers. A low figure here is the backlog being clear, not a fault.</p>`
        : html`<p class="faint">At or above target.</p>`
    : html`<p class="faint">Automatic promotion is off, so the only new leads are the ones a person promoted.</p>`}
${promotionRuns.length ? html`<h3 class="faint">Recent promotion runs (30 days: ${promotion30.examined} examined, ${promotion30.promoted} new leads)</h3>
${table(promotionRuns, [
    { header: "Started", cell: (r) => formatDateTime(String(r.started_at)) },
    { header: "Trigger", cell: (r) => String(r.trigger) },
    { header: "New leads", numeric: true, cell: (r) => Number(r.promoted ?? 0) },
    { header: "Existing", numeric: true, cell: (r) => Number(r.existing_crm ?? 0) },
    { header: "Review", numeric: true, cell: (r) => Number(r.review ?? 0) },
    { header: "Blocked", numeric: true, cell: (r) => Number(r.suppressed ?? 0) + Number(r.rejected ?? 0) },
    { header: "Left", numeric: true, cell: (r) => Number(r.remaining ?? 0) },
    { header: "Took", numeric: true, cell: (r) => (r.duration_ms === null ? "—" : `${Number(r.duration_ms)} ms`) },
    { header: "Why it stopped", cell: (r) => String(r.stopped_reason) },
  ])}` : html`<p class="faint">No automatic promotion run has happened yet.</p>`}
<p class="faint">Data sources in use: ${sources.filter((x) => x.enabled).map((x) => x.attribution).join("; ") || "none enabled"}.
Licences and permitted use are recorded per record and in <code>docs/research/DATA-SOURCES.md</code>.</p>
</section>
<section class="card"><h2 class="card__title">Received in the last 24 hours</h2>
${d.hourly.length ? barChart(d.hourly.map((h) => ({ label: `${h.hour.slice(11)}:00 UTC`, value: h.n, display: String(h.n) }))) : html`<p class="faint">Nothing received in the last 24 hours.</p>`}
</section>
</div>
${owner ? html`<section class="card"><h2 class="card__title">Controls (Owner)</h2>
<form method="post" action="/staff/research/settings" class="form-grid">${csrf(ctx)}
${checkbox("paused", "Pause research (the worker stops sending; nothing is lost)", { checked: !!settings.paused, value: "1" })}
${input({ name: "reason", label: "Reason (required when pausing)", value: settings.pause_reason ?? "", maxlength: 300 })}
${input({ name: "threshold", label: "Qualification threshold (0-100)", type: "number", min: 0, max: 100, value: settings.qualify_threshold, required: true })}
${input({ name: "max_batch", label: "Maximum prospects per batch", type: "number", min: 1, max: 500, value: settings.max_batch, required: true })}
${checkbox("auto_promote", "Create CRM leads automatically for eligible qualified prospects", { checked: !!settings.auto_promote, value: "1" })}
${input({ name: "auto_promote_max_per_run", label: "Most CRM leads one promotion run may create", type: "number", min: 1, max: 2000, value: settings.auto_promote_max_per_run, required: true })}
${button("Save", { variant: "primary" })}</form>
<p class="faint">Automatic promotion runs every 15 minutes, in bounded batches, through the CRM's own intake engine, so
customer matching, do-not-call, suppression, duplicate review and the audit record all apply exactly as they do when a
person promotes. It keeps working while research is paused: pausing stops new research, it does not strand the backlog.
Records needing a human decision are never promoted automatically. Creating a CRM lead still releases nobody for
calling.</p>
<form method="post" action="/staff/research/reconcile" class="inline-form">${csrf(ctx)}
${button(`Reconcile the backlog now (${census.eligibleNow} eligible)`, { variant: "secondary" })}</form>
<p class="faint">Last changed ${formatDateTime(settings.updated_at)}.</p></section>` : ""}
<section class="card"><h2 class="card__title">Needs a person (${census.needsPerson})</h2>
<p class="faint">Only the records a machine must not decide: a phone number shared by two businesses, or two dataset
records that look like the same business. Everything else eligible becomes a CRM lead automatically. Promoted leads are
worked in the <a href="/staff/crm/leads">CRM</a>, which is the single place sales records live.</p>
${table(rows.slice(0, pg.limit), [
    { header: "Business", cell: (p) => html`<strong>${p.name}</strong><div class="faint">${p.category ?? ""}${p.city ? ` · ${p.city}, ${p.state ?? ""}` : ""}</div>${prospectDetail(ctx, p)}` },
    { header: "Website", cell: (p) => html`${WEBSITE_CLASS_LABELS[p.website_class]}${p.max_severity ? html`<div>${badge(SEVERITY_TONE[p.max_severity] ? p.max_severity : "low", `${p.findings_count} finding(s), worst ${p.max_severity}`)}</div>` : ""}` },
    { header: "Score", numeric: true, cell: (p) => p.score },
    { header: "Status", cell: (p) => html`${badge(p.status === "qualified" ? "qualified" : p.status === "review" ? "review" : p.status === "suppressed" ? "blocked" : "", STATUS_LABEL[p.status])}${p.shared_phone ? html` ${badge("warn", "Shared phone")}` : ""}${p.status_detail ? html`<div class="faint">${p.status_detail}</div>` : ""}` },
    { header: "Verified", cell: (p) => formatDateTime(p.last_verified_at) },
  ], { empty: emptyState("Nothing needs a person", "Records appear here only when a shared phone number or two records of one business need a human decision.") })}
${pagination(ctx, pg.page, hasNext)}
</section>`;
  return staffPage(ctx, "Lead research", body);
}

export function register(r: Router): void {
  r.post(`${RUNNER}/heartbeat`, async (ctx) => jsonResponse(ctx, 200, await R.heartbeat(ctx.db, await runnerBody(ctx), ctx.now())));
  r.post(`${RUNNER}/batch`, async (ctx) => jsonResponse(ctx, 200, await R.ingestBatch(ctx.db, await runnerBody(ctx), ctx.now())));

  r.get("/staff/research", page);

  r.post("/staff/research/settings", async (ctx) => {
    requireStaff(ctx);
    if (!isOwner(ctx.actor!)) throw new HttpError(403, "Only the Owner can change research controls.");
    const f = await ctx.form();
    const issues = await R.saveSettings(ctx.db, ctx.actor!, {
      paused: str(f, "paused") === "1", reason: str(f, "reason"),
      threshold: Number(str(f, "threshold")), maxBatch: Number(str(f, "max_batch")),
      // An absent numeric field means "leave it as it is", not zero: a form that does not carry this input must not
      // fail validation, and must not silently rewrite the Owner's setting.
      autoPromote: str(f, "auto_promote") === "1",
      autoPromoteMaxPerRun: str(f, "auto_promote_max_per_run") === "" ? undefined : Number(str(f, "auto_promote_max_per_run")),
    });
    if (issues.length) return redirect(ctx, "/staff/research", { kind: "error", text: issues.join(". ") });
    return redirect(ctx, "/staff/research", { kind: "success", text: "Research controls saved." });
  });

  // Drains one bounded batch of the eligible backlog on demand. The Owner asking is itself the decision, so this
  // works whether or not the automatic setting is on, and it works while research is paused: pausing stops new
  // research, it does not strand prospects already on file. Every promotion still goes through the CRM intake engine.
  r.post("/staff/research/reconcile", async (ctx) => {
    requireStaff(ctx);
    if (!isOwner(ctx.actor!)) throw new HttpError(403, "Only the Owner can run a research reconciliation.");
    const r0 = await runAutoPromotion(ctx.db, { trigger: "owner", now: ctx.now(), actor: ctx.actor!, actorUserId: ctx.actor!.userId ?? null });
    const text = r0.examined === 0
      ? "Nothing was eligible for the CRM, so no lead was created."
      : `${r0.examined} examined: ${r0.promoted} new CRM lead(s), ${r0.existingCrm} already a CRM contact, ${r0.review} sent for review, ${r0.suppressed} suppressed, ${r0.rejected} refused by the CRM, ${r0.failed} failed. ${r0.remaining} still eligible${r0.remaining ? " — run it again to continue" : ""}.`;
    return redirect(ctx, "/staff/research", { kind: r0.failed ? "error" : "success", text });
  });

  r.post("/staff/research/promote", async (ctx) => {
    requireStaff(ctx, "lead.write_all");
    const id = str(await ctx.form(), "prospect_id");
    if (!/^rp_[A-Za-z0-9_-]{4,64}$/.test(id)) throw new HttpError(404, "Prospect not found");
    try {
      const { leadId } = await R.promote(ctx.db, ctx.actor!, id);
      return redirect(ctx, `/staff/crm/leads/${leadId}`, { kind: "success", text: "CRM lead created from research. Automated calling stays off for it." });
    } catch (e) {
      if ((e as HttpError).status === 409) return redirect(ctx, "/staff/research", { kind: "error", text: (e as Error).message });
      throw e;
    }
  });

  r.post("/staff/research/dismiss", async (ctx) => {
    requireStaff(ctx, "lead.write_all");
    const f = await ctx.form();
    const id = str(f, "prospect_id");
    if (!/^rp_[A-Za-z0-9_-]{4,64}$/.test(id)) throw new HttpError(404, "Prospect not found");
    await R.dismiss(ctx.db, ctx.actor!, id, str(f, "reason"));
    return redirect(ctx, "/staff/research", { kind: "success", text: "Prospect dismissed." });
  });
}
