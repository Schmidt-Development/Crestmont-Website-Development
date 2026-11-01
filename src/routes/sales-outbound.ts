// Outbound AI sales representative: Retell custom-function endpoint, public purchase/unsubscribe links, and the Owner's
// control page. Calls are never placed from a request handler; the scheduled job does that (src/app/scheduled.ts).
//  POST /api/webhooks/retell/outbound/functions   Retell custom functions for the SALES agent (X-Retell-Signature)
//  POST /api/sales-outbound/retell-audit         read-only live Retell audit of the sales agent (scheduler signature)
//  GET  /buy/:token                               secure purchase link → existing /checkout/<package> flow
//  GET  /sales/unsubscribe/:token                 sales email unsubscribe (confirm page); POST performs it
//  GET  /staff/sales-outbound                     Owner page (voice.manage): switches, compliance records, queue
//  POST /staff/sales-outbound/settings            switches and limits (step-up MFA)
//  POST /staff/sales-outbound/compliance          record / revoke the Founder + counsel approval (step-up MFA)
//  POST /staff/sales-outbound/consents            record documented prior express written consent for one number
//  POST /staff/sales-outbound/dnc-scrubs          record a National/State DNC registry check result
//  POST /staff/sales-outbound/queue               queue one CRM lead (gate evaluated and recorded)
//  POST /staff/sales-outbound/queue/:id/cancel    cancel a queued call
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, label } from "../lib/html.ts";
import { HttpError, jsonResponse, redirect, htmlResponse, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { csrf, input, textarea, select, checkbox, button, formErrors, alert, badge, table, emptyState, pageHead } from "../ui/components.ts";
import { publicLayout } from "../ui/layout.ts";
import { staffPage } from "./crm.ts";
import { readBody } from "./api.ts";
import { RetellAuthError } from "../adapters/retell.ts";
import { verifyRetellWorkspace } from "../adapters/retell-workspaces.ts";
import { handleSalesFunction, openCheckoutLink, unsubscribeSalesEmail } from "../services/sales-functions.ts";
import * as so from "../services/sales-outbound.ts";
import { listTargets } from "../services/sales-opt/registry.ts";
import { verifyEvidenceSignature, IngestAuthError } from "../readiness/ingest.ts";
import { rateLimit, audit } from "../services/security.ts";
import { auditOutboundRetell } from "../services/retell-outbound-audit.ts";

async function salesFunctions(ctx: AppContext): Promise<Response> {
  const raw = await readBody(ctx.req);
  try {
    // Outbound (sales) workspace only: a request signed with the receptionist's key, or any other key, is refused (401).
    await verifyRetellWorkspace(ctx.env, ["outbound"], raw, ctx.req.headers.get("x-retell-signature"));
  } catch (e) {
    if (e instanceof RetellAuthError) throw new HttpError(401, e.message);
    throw e;
  }
  let res;
  try {
    res = await handleSalesFunction(ctx.db, raw, ctx.url.searchParams.get("lead_id"), {
      mail: { email: ctx.email, db: ctx.db, settings: ctx.settings }, baseUrl: ctx.baseUrl, environment: ctx.env.ENVIRONMENT,
      paymentsConfigured: ctx.payments.configured, now: ctx.env.overrides?.now,
    });
  } catch (e) {
    if (e instanceof SyntaxError) return jsonResponse(ctx, 422, { message: "Body is not valid JSON" });
    throw e;
  }
  // Retell stringifies the body for the agent's LLM: the result object only.
  return jsonResponse(ctx, res.status, res.body);
}

const linkPage = (ctx: AppContext, title: string, text: string, status: number) => htmlResponse(ctx, publicLayout(ctx, { title, noindex: true },
  html`<section class="section"><div class="container stack" style="max-width:640px"><h1>${title}</h1><p class="lede">${text}</p><div class="row"><a class="btn btn--primary" href="/pricing">See packages</a><a class="btn btn--ghost" href="/contact">Contact us</a></div></div></section>`), status);

async function ownerPage(ctx: AppContext, errors: string[] = [], status = 200): Promise<Response> {
  requireStaff(ctx, "voice.manage");
  const s = await so.loadSalesSettings(ctx.db);
  const sw = await so.salesOutboundSwitch(ctx.db, ctx.env);
  const approval = await so.activeComplianceApproval(ctx.db);
  const stage = ctx.env.ENVIRONMENT === "production" ? "production" : "staging";
  const sieTarget = (await listTargets(ctx.db))[stage];
  const sieLine = !s.agent_id ? "No sales agent id saved yet." : !sieTarget ? `The sales agent is not registered as the Self-Improvement Engine's ${stage} target, so calls are not attributed to prompt versions.`
    : sieTarget.agent_id !== s.agent_id ? `The Self-Improvement Engine's ${stage} target is a different agent; calls are not attributed to prompt versions.`
    : `The sales agent is the Self-Improvement Engine's ${stage} target${sieTarget.verified_at ? " (verified with Retell)" : " (not verified with Retell yet)"}: calls carry crestmont_so_version.`;
  const queue = (await ctx.db.prepare(`SELECT s.*, co.name AS business FROM sales_calls s JOIN leads l ON l.id = s.lead_id JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id
      ORDER BY CASE s.status WHEN 'dialing' THEN 0 WHEN 'in_progress' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, s.updated_at DESC LIMIT 50`).all<so.SalesCallRow & { business: string | null }>()).results;
  const consents = (await ctx.db.prepare(`SELECT id, phone_e164, line_type, signer_name, evidence_ref, captured_at, revoked_at FROM sales_call_consents ORDER BY recorded_at DESC LIMIT 20`).all<{ id: string; phone_e164: string; line_type: string; signer_name: string; evidence_ref: string; captured_at: string; revoked_at: string | null }>()).results;
  const body = html`${pageHead("AI sales calls (outbound)", undefined, "AI receptionist")}
${formErrors(errors)}
${sw.enabled ? alert("warn", "Outbound AI sales calling is ON. Every call is still re-checked against the compliance gate immediately before dialling.") : alert("info", html`Outbound AI sales calling is <strong>off</strong>. ${sw.reasons.join(" · ")}`)}
<p class="muted">Founder decision D-14 keeps AI-voice sales calls closed until counsel approves a consent design. A number in a public dataset is not consent. A lead is dialled only with documented prior express written consent covering AI-voice calls to that number, a National Do Not Call Registry check within 31 days, a known state and time zone, and inside the conservative calling window (weekdays 10:00–19:00 recipient time, no federal holidays).</p>
<p class="muted">Retell workspace: outbound (RETELL_OUTBOUND_API_KEY ${so.outboundKeyConfigured(ctx.env) ? "configured" : "NOT configured"}). ${sieLine}</p>
<section class="card stack"><h2 class="card__title">Compliance approval</h2>
${approval ? html`<p>${badge("active", "Active")} Counsel reference <strong>${approval.reference}</strong>, approved ${formatDateTime(approval.approvedAt)}.</p>
<form method="post" action="/staff/sales-outbound/compliance">${csrf(ctx)}<input type="hidden" name="action" value="revoke">${button("Revoke approval (stops every queued call)", { variant: "danger", size: "sm" })}</form>`
  : html`<form method="post" action="/staff/sales-outbound/compliance" class="stack">${csrf(ctx)}<input type="hidden" name="action" value="approve">
${input({ name: "counsel_reference", label: "Counsel's reference for the approved consent design", required: true, maxlength: 200 })}
${textarea({ name: "notes", label: "Notes (scope, states excluded, conditions)", rows: 3, maxlength: 1000 })}
${checkbox("confirm", "I am the Founder and counsel has approved AI-voice sales calls under the recorded consent design.", { required: true })}
<div class="form-actions">${button("Record approval")}</div></form>`}</section>
<section class="card stack"><h2 class="card__title">Switches and limits</h2>
<form method="post" action="/staff/sales-outbound/settings" class="stack">${csrf(ctx)}
${checkbox("enabled", "Enable outbound AI sales calls in this environment (RETELL_SALES_OUTBOUND must also be on)", { checked: s.enabled === 1 })}
${input({ name: "agent_id", label: "Retell sales agent id (separate from the receptionist)", value: s.agent_id ?? "", maxlength: 80 })}
${input({ name: "from_number", label: "Approved caller number (E.164, Retell-owned or imported)", value: s.from_number ?? "", maxlength: 20 })}
${input({ name: "max_concurrent", label: "Concurrent calls (1–20; Retell's workspace limit is shared with the receptionist)", type: "number", value: s.max_concurrent, min: 1, max: 20 })}
${input({ name: "max_per_run", label: "Dials per 15-minute run", type: "number", value: s.max_dials_per_run, min: 1, max: 20 })}
${input({ name: "max_per_day", label: "Dials per day", type: "number", value: s.max_dials_per_day, min: 1, max: 500 })}
${input({ name: "max_attempts", label: "Attempts per lead", type: "number", value: s.max_attempts_per_lead, min: 1, max: 3 })}
${input({ name: "retry_after_hours", label: "Hours between attempts", type: "number", value: s.retry_after_hours, min: 4, max: 720 })}
<div class="form-actions">${button("Save")}</div></form></section>
<section class="card stack"><h2 class="card__title">Record written consent for one number</h2>
<form method="post" action="/staff/sales-outbound/consents" class="stack">${csrf(ctx)}
${input({ name: "phone", label: "Number (E.164)", required: true, maxlength: 20 })}${input({ name: "lead_id", label: "CRM lead id (optional)", maxlength: 64 })}
${select({ name: "line_type", label: "Line type", options: ["mobile", "landline", "voip"] })}${input({ name: "signer_name", label: "Signed by", required: true, maxlength: 120 })}
${input({ name: "evidence_ref", label: "Signed record reference (form submission / e-signature id)", required: true, maxlength: 300 })}
${textarea({ name: "disclosure_text", label: "Exact consent language agreed to (must disclose AI / artificial-voice calls)", rows: 3, maxlength: 4000, required: true })}
${input({ name: "captured_at", label: "Consent given at (ISO date/time)", required: true, maxlength: 40 })}
<div class="form-actions">${button("Record consent", { variant: "secondary" })}</div></form>
${table(consents, [{ header: "Number", cell: (c) => c.phone_e164 }, { header: "Line", cell: (c) => c.line_type }, { header: "Signed by", cell: (c) => c.signer_name }, { header: "Evidence", cell: (c) => c.evidence_ref },
  { header: "Given", cell: (c) => formatDateTime(c.captured_at) }, { header: "Status", cell: (c) => (c.revoked_at ? badge("cancelled", "Revoked") : badge("active", "Active")) }], { empty: emptyState("No consents recorded", "No number can be dialled for sales without one.") })}</section>
<section class="card stack"><h2 class="card__title">Record a do-not-call registry check</h2>
<form method="post" action="/staff/sales-outbound/dnc-scrubs" class="stack">${csrf(ctx)}
${input({ name: "phone", label: "Number (E.164)", required: true, maxlength: 20 })}${select({ name: "registry", label: "Registry", options: ["national", "state"] })}
${select({ name: "result", label: "Result", options: ["clear", "listed"] })}${input({ name: "source_ref", label: "Registry download / vendor reference", required: true, maxlength: 200 })}
${input({ name: "checked_at", label: "Checked at (ISO date/time)", required: true, maxlength: 40 })}
<div class="form-actions">${button("Record check", { variant: "secondary" })}</div></form></section>
<section class="card stack"><h2 class="card__title">Queue</h2>
<form method="post" action="/staff/sales-outbound/queue" class="row">${csrf(ctx)}${input({ name: "lead_id", label: "CRM lead id", required: true, maxlength: 64 })}<div class="field">${button("Queue lead (gate is checked now and before dialling)", { variant: "secondary", size: "sm" })}</div></form>
${table(queue, [
  { header: "Business", cell: (r) => r.business ?? r.lead_id }, { header: "Status", cell: (r) => badge(r.status, label(r.status)) },
  { header: "Detail", cell: (r) => r.status_detail ?? (r.outcome ? `Outcome: ${label(r.outcome)} (${label(r.outcome_source ?? "")})` : "—") },
  { header: "Attempts", cell: (r) => `${r.attempts}/${r.max_attempts}` }, { header: "Updated", cell: (r) => formatDateTime(r.updated_at) },
  { header: "", cell: (r) => (r.status === "queued" ? html`<form method="post" action="/staff/sales-outbound/queue/${r.id}/cancel">${csrf(ctx)}${button("Cancel", { variant: "ghost", size: "sm" })}</form>` : "") },
], { empty: emptyState("Nothing queued", "Queued leads appear here with the gate's reasons when they are blocked.") })}</section>`;
  return staffPage(ctx, "AI sales calls", body, status);
}

export function register(r: Router): void {
  r.post("/api/webhooks/retell/outbound/functions", (ctx) => salesFunctions(ctx));
  // Read-only audit of the sales agent's live Retell configuration (src/services/retell-outbound-audit.ts), run with this
  // Worker's RETELL_OUTBOUND_API_KEY so no person or CI job needs the value. Machine endpoint signed like
  // /api/scheduled/run (SCHEDULER_TRIGGER_SECRET). Nothing is written to Retell; no call is placed.
  r.post("/api/sales-outbound/retell-audit", async (ctx) => {
    const raw = await readBody(ctx.req);
    if (!ctx.env.SCHEDULER_TRIGGER_SECRET) return jsonResponse(ctx, 503, { error: "Audit trigger not configured" });
    try { await verifyEvidenceSignature(ctx.env.SCHEDULER_TRIGGER_SECRET, raw, ctx.req.headers.get("x-crestmont-scheduler-signature")); }
    catch (e) { if (e instanceof IngestAuthError) return jsonResponse(ctx, 401, { error: e.message }); throw e; }
    const rl = await rateLimit(ctx.db, "sales-retell-audit", 3, 300);
    if (!rl.allowed) return jsonResponse(ctx, 429, { error: "Ran recently; try again in a few minutes" });
    const result = await auditOutboundRetell({ db: ctx.db, env: ctx.env, fetch: ctx.env.overrides?.fetch ?? fetch, baseUrl: ctx.baseUrl });
    await audit(ctx.db, { actorKind: "system", action: "sales_outbound.retell_audit", subjectType: "retell_agent", subjectId: result.agentId, details: { status: result.status, failed: result.findings.filter((f) => !f.ok).length, total: result.findings.length } });
    return jsonResponse(ctx, 200, result);
  });

  r.get("/buy/:token", async (ctx, p) => {
    const res = await openCheckoutLink(ctx.db, p.token, ctx.env.overrides?.now?.() ?? new Date());
    if (!res.ok) return linkPage(ctx, res.reason === "expired" ? "This link has expired" : "This link is not valid", "Purchase links from Crestmont are valid for 7 days. Ask us for a new one, or choose a package on our pricing page.", res.reason === "expired" ? 410 : 404);
    return redirect(ctx, `/checkout/${res.packageId}?ref=sales`);
  });

  r.get("/sales/unsubscribe/:token", (ctx, p) => htmlResponse(ctx, publicLayout(ctx, { title: "Unsubscribe", noindex: true },
    html`<section class="section"><div class="container stack" style="max-width:640px"><h1>Stop sales emails from Crestmont?</h1><form method="post" action="/sales/unsubscribe/${p.token}">${csrf(ctx)}<div class="form-actions">${button("Unsubscribe")}</div></form></div></section>`)));
  r.post("/sales/unsubscribe/:token", async (ctx, p) => {
    await unsubscribeSalesEmail(ctx.db, p.token);
    // Same answer whether or not the token matched: reveals nothing about the address.
    return linkPage(ctx, "You're unsubscribed", "You won't receive sales emails from Crestmont at that address. Emails about an account or a purchase you make are not affected.", 200);
  });

  r.get("/staff/sales-outbound", (ctx) => ownerPage(ctx));
  r.post("/staff/sales-outbound/settings", async (ctx) => {
    requireStaff(ctx, "voice.manage");
    const f = await ctx.form();
    const n = (k: string) => Number(str(f, k));
    const problems = await so.saveSalesSettings(ctx.db, ctx.user!.id, { enabled: !!f.get("enabled"), agentId: str(f, "agent_id"), fromNumber: str(f, "from_number"),
      maxConcurrent: n("max_concurrent"), maxPerRun: n("max_per_run"), maxPerDay: n("max_per_day"), maxAttempts: n("max_attempts"), retryAfterHours: n("retry_after_hours") });
    return problems.length ? ownerPage(ctx, problems, 422) : redirect(ctx, "/staff/sales-outbound", { kind: "success", text: "Saved." });
  });
  const guarded = (fn: (ctx: AppContext, f: FormData) => Promise<string>) => async (ctx: AppContext) => {
    requireStaff(ctx, "voice.manage");
    const f = await ctx.form();
    try { return redirect(ctx, "/staff/sales-outbound", { kind: "success", text: await fn(ctx, f) }); }
    catch (e) { if (e instanceof so.SalesOutboundError) return ownerPage(ctx, [e.message], e.status); throw e; }
  };
  r.post("/staff/sales-outbound/compliance", guarded(async (ctx, f) => {
    if (str(f, "action") === "revoke") { await so.revokeComplianceApproval(ctx.db, ctx.user!.id); return "Approval revoked; queued calls were cancelled."; }
    if (!f.get("confirm")) throw new so.SalesOutboundError("Confirm that counsel approved the consent design.");
    await so.recordComplianceApproval(ctx.db, ctx.user!.id, str(f, "counsel_reference"), str(f, "notes"));
    return "Compliance approval recorded.";
  }));
  r.post("/staff/sales-outbound/consents", guarded(async (ctx, f) => {
    await so.recordSalesConsent(ctx.db, ctx.user!.id, { phone: str(f, "phone"), leadId: str(f, "lead_id") || null, lineType: str(f, "line_type"), signerName: str(f, "signer_name"), evidenceRef: str(f, "evidence_ref"), disclosureText: str(f, "disclosure_text"), capturedAt: str(f, "captured_at") });
    return "Consent recorded.";
  }));
  r.post("/staff/sales-outbound/dnc-scrubs", guarded(async (ctx, f) => {
    await so.recordDncScrub(ctx.db, ctx.user!.id, { phone: str(f, "phone"), registry: str(f, "registry") as "national", result: str(f, "result") as "clear", sourceRef: str(f, "source_ref"), checkedAt: str(f, "checked_at") });
    return "Registry check recorded.";
  }));
  r.post("/staff/sales-outbound/queue", guarded(async (ctx, f) => {
    const row = await so.enqueueSalesCall(ctx.db, str(f, "lead_id"), { requestedBy: ctx.user!.id });
    return row.status === "queued" ? `Queued (${row.id}).` : `Not queued: ${row.status_detail ?? row.status}`;
  }));
  r.post("/staff/sales-outbound/queue/:id/cancel", async (ctx, p) => {
    requireStaff(ctx, "voice.manage");
    const f = await ctx.form();
    try { await so.cancelSalesCall(ctx.db, ctx.user!.id, p.id, str(f, "note")); } catch (e) { if (e instanceof so.SalesOutboundError) return ownerPage(ctx, [e.message], e.status); throw e; }
    return redirect(ctx, "/staff/sales-outbound", { kind: "success", text: "Cancelled." });
  });
}
