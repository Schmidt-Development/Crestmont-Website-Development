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
import { WEBSITE_CLASSES, WEBSITE_CLASS_LABELS, PROSPECT_STATUSES, type Finding } from "../domain/research.ts";

const RUNNER = "/api/research/runner";
const MAX_BODY = 5_000_000;

/** Signed worker body: HMAC over `t.body` with RESEARCH_RUNNER_SECRET, a mandatory single-use _nonce, JSON object. */
async function runnerBody(ctx: AppContext): Promise<Record<string, unknown>> {
  const secret = ctx.env.RESEARCH_RUNNER_SECRET;
  // Not configured → no worker can authenticate (fail closed with 401, the same answer as a bad signature).
  if (!secret) throw new HttpError(401, "Research worker not configured");
  const raw = await ctx.req.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, "Request too large");
  try { await verifyRunnerSignature(secret, raw, ctx.req.headers.get("x-crestmont-research-signature")); }
  catch (e) { throw new HttpError(401, (e as Error).message); }
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
  const [d, settings, sources] = await Promise.all([R.dashboard(ctx.db, now), R.loadSettings(ctx.db), R.listSources(ctx.db)]);
  const status = ctx.url.searchParams.get("status") ?? "";
  const cls = ctx.url.searchParams.get("class") ?? "";
  const state = (ctx.url.searchParams.get("state") ?? "").toUpperCase();
  const f = {
    status: (PROSPECT_STATUSES as readonly string[]).includes(status) ? status : undefined,
    cls: (WEBSITE_CLASSES as readonly string[]).includes(cls) ? cls : undefined,
    state: /^[A-Z]{2}$/.test(state) ? state : undefined,
  };
  const pg = pageParam(ctx);
  const rows = await R.listProspects(ctx.db, f, pg);
  const hasNext = rows.length > pg.limit;
  const runner = d.runners[0];
  const runnerStatus = runner ? JSON.parse(runner.status_json) as Record<string, unknown> : null;
  const online = runner ? now.getTime() - Date.parse(runner.last_seen_at) < R.RUNNER_ONLINE_S * 1000 : false;
  const refresh = (runnerStatus?.sources ?? {}) as Record<string, { lastRefreshAt?: string; release?: string; state?: string; error?: string }>;
  const owner = isOwner(ctx.actor!);
  const body = html`
${pageHead("Lead research", undefined, "Sales")}
${settings.paused ? alert("warn", html`<strong>Research is paused.</strong> ${settings.pause_reason ?? ""} The worker keeps its queue and sends nothing until resumed.`) : ""}
${!ctx.env.RESEARCH_RUNNER_SECRET ? alert("warn", html`<strong>No research worker can connect.</strong> RESEARCH_RUNNER_SECRET is not set on this environment. Setup: docs/research/RUNBOOK.md.`) : ""}
${alert("info", html`<strong>Automated calling is off for research prospects.</strong> A number in an open dataset is not permission to place AI-voice calls. Every prospect is held by the outbound eligibility gate until a counsel-approved consent design exists (Founder decision D-14). Promoting a prospect creates a CRM lead for people to work; it never queues a call.`)}
<section class="kpis">
${kpi("Candidates evaluated today", d.evaluatedToday, "reported by the worker")}
${kpi("Received today", d.receivedToday ?? 0, `${d.rejectedToday} rejected by validation`)}
${kpi("Qualified today", d.qualifiedToday, `${d.qualifiedAll} awaiting a decision`)}
${kpi("Verified callable today", d.callable, "automated calling gate (fail-closed)")}
${kpi("Duplicates prevented today", d.dupToday, `${d.dupAll} all time`)}
${kpi("Businesses on record", d.total)}
${kpi("Awaiting verification or review", d.awaiting)}
${kpi("Research → CRM import success", pct(d.importRate), `${d.promoted30} imported, ${d.blocked30} blocked (30 days)`)}
</section>
<div class="grid grid--2">
<section class="card"><h2 class="card__title">Worker health</h2>
${runner ? dl([
    ["Worker", html`${runner.runner_id} ${online ? badge("healthy", "Online") : badge("failing", "Offline")}`],
    ["Version", runner.version ?? "—"], ["Last check-in", formatDateTime(runner.last_seen_at)],
    ["Queue depth", String(runnerStatus?.queueDepth ?? "—")], ["Websites checked today", String(d.websitesToday)],
    ["Failed jobs today", String(d.failedToday)],
    ["Throughput", runnerStatus?.recordsPerHour !== undefined ? `${runnerStatus.recordsPerHour} records/hour (worker-measured)` : "—"],
    ["Local model", String(runnerStatus?.model ?? "—")],
    ["Resources", runnerStatus?.resources ? JSON.stringify(runnerStatus.resources).slice(0, 300) : "—"],
  ]) : emptyState("No worker has connected", "Install the research worker on the Windows workstation (docs/research/RUNBOOK.md). Until then nothing is researched.")}
</section>
<section class="card"><h2 class="card__title">Website classification</h2>
${d.total ? barChart(d.byClass.map((c) => ({ label: c.label, value: c.n, display: String(c.n) }))) : html`<p class="faint">No prospects yet.</p>`}
<p class="faint">"No official website found" means the documented checks found none; it is not proof that the business has no website.</p>
</section>
</div>
<div class="grid grid--2">
<section class="card"><h2 class="card__title">Sources</h2>
${table(sources, [
    { header: "Source", cell: (s) => html`${s.source} ${s.enabled ? badge("active", "On") : badge("paused", "Off")}` },
    { header: "Licence and use", cell: (s) => html`${s.license}<div class="faint">${s.use_terms}${s.disabled_reason ? html`<br><strong>Off:</strong> ${s.disabled_reason}` : ""}</div>` },
    { header: "Records", numeric: true, cell: (s) => d.coverage.find((c) => c.source === s.source)?.n ?? 0 },
    { header: "Last refresh", cell: (s) => refresh[s.source]?.lastRefreshAt ? `${formatDateTime(refresh[s.source].lastRefreshAt!)}${refresh[s.source].release ? ` (${refresh[s.source].release})` : ""}` : "—" },
  ])}
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
${button("Save", { variant: "primary" })}</form>
<p class="faint">Last changed ${formatDateTime(settings.updated_at)}.</p></section>` : ""}
<section class="card"><h2 class="card__title">Prospects</h2>
<form method="get" class="filters">
${select({ name: "status", label: "Status", options: PROSPECT_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })), value: f.status ?? "", includeBlank: "Any" })}
${select({ name: "class", label: "Website", options: WEBSITE_CLASSES.map((c) => ({ value: c, label: WEBSITE_CLASS_LABELS[c] })), value: f.cls ?? "", includeBlank: "Any" })}
${input({ name: "state", label: "State", value: f.state ?? "", maxlength: 2 })}
${button("Filter", { variant: "secondary", size: "sm" })}</form>
${table(rows.slice(0, pg.limit), [
    { header: "Business", cell: (p) => html`<strong>${p.name}</strong><div class="faint">${p.category ?? ""}${p.city ? ` · ${p.city}, ${p.state ?? ""}` : ""}</div>${prospectDetail(ctx, p)}` },
    { header: "Website", cell: (p) => html`${WEBSITE_CLASS_LABELS[p.website_class]}${p.max_severity ? html`<div>${badge(SEVERITY_TONE[p.max_severity] ? p.max_severity : "low", `${p.findings_count} finding(s), worst ${p.max_severity}`)}</div>` : ""}` },
    { header: "Score", numeric: true, cell: (p) => p.score },
    { header: "Status", cell: (p) => html`${badge(p.status === "qualified" ? "qualified" : p.status === "review" ? "review" : p.status === "suppressed" ? "blocked" : "", STATUS_LABEL[p.status])}${p.shared_phone ? html` ${badge("warn", "Shared phone")}` : ""}${p.status_detail ? html`<div class="faint">${p.status_detail}</div>` : ""}` },
    { header: "Verified", cell: (p) => formatDateTime(p.last_verified_at) },
  ], { empty: emptyState("No prospects", "Prospects appear here when the research worker sends evidence. Nothing is invented: an empty list means nothing has been researched yet.") })}
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
    });
    if (issues.length) return redirect(ctx, "/staff/research", { kind: "error", text: issues.join(". ") });
    return redirect(ctx, "/staff/research", { kind: "success", text: "Research controls saved." });
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
