// Provider webhooks and their staff review pages (VOICE-003, EMAIL-003, FIN-002, PAY-009).
//  POST /api/webhooks/retell            Retell call events (call_started / call_ended / call_analyzed)
//  POST /api/webhooks/retell/functions  Retell custom-function calls → voice service functions
//  POST /api/webhooks/resend            Resend (Svix-signed) delivery events → delivery status + suppressions
//  GET  /staff/email-suppressions       suppression list (settings.operational); POST …/:id/remove
//  GET  /staff/finance/reconciliation   Stripe reconciliation findings + cost-import ledger (finance.read)
// Reviewing a finding is a finance.read action: it records a note only and changes no money state.
// /staff/email/suppressions is not used because platform.ts's /staff/email/:id is matched first.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatCents, formatDateTime, label } from "../lib/html.ts";
import { HttpError, jsonResponse, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { textarea, button, alert, badge, table, emptyState, kpi, pagination, pageParam, pageHead, linkButton, input, csrf, select, tabs } from "../ui/components.ts";
import { staffPage } from "./crm.ts";
import { readBody } from "./api.ts";
import { handleVoiceEvent } from "../services/voice.ts";
import { verifyRetellSignature, translateRetellEvent, translateRetellFunction, RetellAuthError, RetellPayloadError, type Translated } from "../adapters/retell.ts";
import * as mail from "../services/email-events.ts";
import * as rec from "../services/stripe-reconcile.ts";
import * as costs from "../services/cost-import.ts";

const q = (ctx: AppContext, k: string, max = 120) => (ctx.url.searchParams.get(k) ?? "").trim().slice(0, max);

async function retell(ctx: AppContext, translate: (db: AppContext["db"], raw: string) => Promise<Translated>, fn: boolean): Promise<Response> {
  const raw = await readBody(ctx.req);
  try {
    await verifyRetellSignature(ctx.env.RETELL_API_KEY, raw, ctx.req.headers.get("x-retell-signature"));
  } catch (e) {
    if (e instanceof RetellAuthError) throw new HttpError(401, e.message);
    throw e;
  }
  let t: Translated;
  try { t = await translate(ctx.db, raw); } catch (e) {
    if (e instanceof RetellPayloadError) return jsonResponse(ctx, 422, { error: e.message });
    throw e;
  }
  if (t.kind === "ack") return jsonResponse(ctx, 200, fn ? (t.body.result ?? t.body) : t.body);
  const res = await handleVoiceEvent(ctx.db, t.body);
  // Retell gives the function response body to the agent's LLM: return only the result object.
  if (fn) return jsonResponse(ctx, res.status, (res.body.result as Record<string, unknown> | undefined) ?? res.body);
  return jsonResponse(ctx, res.status, res.body);
}

export function register(r: Router): void {
  r.post("/api/webhooks/retell", (ctx) => retell(ctx, translateRetellEvent, false));
  r.post("/api/webhooks/retell/functions", (ctx) => retell(ctx, translateRetellFunction, true));

  r.post("/api/webhooks/resend", async (ctx) => {
    const raw = await readBody(ctx.req);
    let svixId: string;
    try {
      svixId = await mail.verifySvix(ctx.env.RESEND_WEBHOOK_SECRET, raw, ctx.req.headers);
    } catch (e) {
      if (e instanceof mail.SvixAuthError) throw new HttpError(401, e.message);
      throw e;
    }
    const out = await mail.handleResendEvent(ctx.db, svixId, raw);
    return jsonResponse(ctx, 200, { received: true, ...out });
  });

  // ── Email suppressions (EMAIL-003) ──
  const suppressionsPage = async (ctx: AppContext, errors: string[] = [], status = 200) => {
    requireStaff(ctx, "settings.operational");
    const show = q(ctx, "show") === "all";
    const search = q(ctx, "q", 254);
    const { page, limit, offset } = pageParam(ctx);
    const rows = await mail.listSuppressions(ctx.db, { includeRemoved: show, q: search || undefined, limit, offset });
    const events = await mail.recentEmailEvents(ctx.db, 15);
    const configured = !!ctx.env.RESEND_WEBHOOK_SECRET;
    const body = html`${pageHead("Email suppressions", linkButton("Delivery log", "/staff/email", "ghost", "sm"), "Email operations")}
${configured ? "" : alert("warn", "RESEND_WEBHOOK_SECRET is not set, so the Resend delivery webhook rejects every request and no bounces or complaints are being recorded. The list below only contains what was recorded while it was configured.")}
${errors.length ? alert("error", errors.join(" ")) : ""}
<p class="muted">Addresses that hard-bounced or marked a Crestmont email as spam (reported by Resend's signed delivery webhook). Every template, including security notices, is skipped for a suppressed address; the delivery log shows those messages as <strong>suppressed</strong> with the reason. Remove a suppression only after confirming the address works again or the person asked to receive mail.</p>
<form method="get" class="filters" action="/staff/email-suppressions">${input({ name: "q", label: "Email contains", value: search, maxlength: 254 })}${select({ name: "show", label: "Show", options: [{ value: "", label: "Active only" }, { value: "all", label: "Active and removed" }], value: show ? "all" : "" })}<div class="field">${button("Filter", { variant: "secondary", size: "sm" })}</div></form>
${table(rows.slice(0, limit), [
  { header: "Email", cell: (s) => s.email },
  { header: "Reason", cell: (s) => badge(s.reason === "complaint" ? "failed" : "bounced", label(s.reason)) },
  { header: "Detail", cell: (s) => s.detail ?? "—" },
  { header: "Since", cell: (s) => formatDateTime(s.created_at) },
  { header: "Status", cell: (s) => s.removed_at ? html`Removed ${formatDateTime(s.removed_at)} by ${s.removed_by_name ?? "—"}<br><span class="faint">${s.removal_note ?? ""}</span>` : badge("open", "Active") },
  { header: "", cell: (s) => s.removed_at ? "" : html`<form method="post" action="/staff/email-suppressions/${s.id}/remove" class="stack">${csrf(ctx)}${textarea({ name: "note", label: "Why remove?", rows: 2, maxlength: 500, required: true })}${button("Remove suppression", { variant: "danger", size: "sm" })}</form>` },
], { empty: emptyState("No suppressed addresses", configured ? "Hard bounces and spam complaints reported by Resend will appear here." : "Nothing has been recorded: the Resend delivery webhook is not configured.") })}
${pagination(ctx, page, rows.length > limit)}
<section class="section--tight"><h2>Recent delivery events</h2>${table(events, [
  { header: "Received", cell: (e) => formatDateTime(e.received_at) }, { header: "Event", cell: (e) => e.type }, { header: "Recipient", cell: (e) => e.recipient ?? "—" },
  { header: "Result", cell: (e) => label(e.outcome) }, { header: "Detail", cell: (e) => e.detail ?? "—" },
], { empty: emptyState("No delivery events received", "Signed Resend events appear here once the webhook is configured.") })}</section>`;
    return staffPage(ctx, "Email suppressions", body, status);
  };
  r.get("/staff/email-suppressions", (ctx) => suppressionsPage(ctx));
  r.post("/staff/email-suppressions/:id/remove", async (ctx, p) => {
    requireStaff(ctx, "settings.operational");
    try {
      const email = await mail.removeSuppression(ctx.db, p.id, ctx.user!.id, str(await ctx.form(), "note"));
      return redirect(ctx, "/staff/email-suppressions", { kind: "success", text: `Suppression removed; ${email} will receive mail again.` });
    } catch (e) {
      if (e instanceof mail.SuppressionError) return suppressionsPage(ctx, [e.message], 422);
      throw e;
    }
  });

  // ── Stripe reconciliation + cost import (PAY-009, FIN-002) ──
  const reconciliationPage = async (ctx: AppContext, errors: string[] = [], status = 200) => {
    requireStaff(ctx, "finance.read");
    const view = q(ctx, "view") === "costs" ? "costs" : "findings";
    const st = ["open", "cleared", "resolved"].includes(q(ctx, "status")) ? q(ctx, "status") : "";
    const { page, limit, offset } = pageParam(ctx);
    const reader = rec.stripeReader(ctx.env);
    const runs = await rec.recentRuns(ctx.db, 5);
    const head = html`${pageHead("Reconciliation & cost import", linkButton("Revenue", "/staff/finance", "ghost", "sm"), "Finance")}
${reader.ok ? "" : alert("warn", `Stripe-side reconciliation and fee lookup are not running: ${reader.reason}. Online payment is not configured yet, so nothing is compared with Stripe.`)}
${errors.length ? alert("error", errors.join(" ")) : ""}
${tabs([{ href: "/staff/finance/reconciliation", label: "Stripe findings", current: view === "findings" }, { href: "/staff/finance/reconciliation?view=costs", label: "Imported costs", current: view === "costs" }])}`;
    if (view === "costs") {
      const rows = await costs.listCostImports(ctx.db, limit, offset);
      const un = await costs.unattributedAiSummary(ctx.db);
      const body = html`${head}
<p class="muted">The daily <code>cost_import</code> job imports AI usage (ai_jobs.cost_microusd) and Stripe fees (payments.fee_cents) into project costs exactly once each. AI jobs whose input reference is <code>project:&lt;id&gt;</code> (or a ticket linked to a project) are charged to that project; others are recorded as company-wide AI cost. Unknown amounts stay Unknown, never $0.</p>
<div class="kpis">${kpi("Unattributed AI cost", formatCents(un?.known_cents ?? 0), `${un?.n ?? 0} jobs${un?.unknown ? `, ${un.unknown} with unknown cost` : ""}`)}</div>
${table(rows.slice(0, limit), [
  { header: "Imported", cell: (c) => formatDateTime(c.imported_at) },
  { header: "Source", cell: (c) => c.source === "ai_job" ? `AI job ${c.source_id}` : `Stripe fee, payment ${c.source_id}` },
  { header: "Project", cell: (c) => c.project_id ? html`<a href="/staff/projects/${c.project_id}">${c.project_name ?? c.project_id}</a>` : "—" },
  { header: "Amount", cell: (c) => c.project_cost_id === null ? "—" : c.amount_cents === null ? "Unknown" : formatCents(c.amount_cents), numeric: true },
  { header: "Note", cell: (c) => c.note ?? "—" },
], { empty: emptyState("Nothing imported yet", "Costs appear here after the daily cost import runs and finds AI jobs or Stripe fees.") })}
${pagination(ctx, page, rows.length > limit)}`;
      return staffPage(ctx, "Cost import", body, status);
    }
    const rows = await rec.listFindings(ctx.db, { status: st || undefined, limit, offset });
    const body = html`${head}
<p class="muted">The daily <code>stripe_side_reconcile</code> job lists the last ${rec.RECONCILE_WINDOW_DAYS} days of Stripe Checkout Sessions read-only and compares them with local invoices, payments and subscriptions. <strong>Findings never change payment state.</strong> Verified Stripe webhooks are the only thing that marks an invoice paid; a finding tells a person where to look. A finding that disappears on a later run is marked <em>cleared</em> automatically.</p>
<form method="get" class="filters" action="/staff/finance/reconciliation">${select({ name: "status", label: "Status", options: ["open", "cleared", "resolved"], value: st, includeBlank: "Any status" })}<div class="field">${button("Filter", { variant: "secondary", size: "sm" })}</div></form>
${table(rows.slice(0, limit), [
  { header: "Finding", cell: (f) => html`<strong>${rec.FINDING_KINDS[f.kind] ?? f.kind}</strong><br><span class="faint">${f.detail}</span>` },
  { header: "Customer", cell: (f) => f.org_name ?? "—" },
  { header: "Stripe / local", cell: (f) => `${f.stripe_amount_cents === null ? "—" : formatCents(f.stripe_amount_cents)} / ${f.local_amount_cents === null ? "—" : formatCents(f.local_amount_cents)}` },
  { header: "Seen", cell: (f) => html`${formatDateTime(f.first_seen_at)}<br><span class="faint">last ${formatDateTime(f.last_seen_at)}</span>` },
  { header: "Status", cell: (f) => f.status === "resolved" ? html`${badge("resolved", "Reviewed")}<br><span class="faint">${f.resolved_by_name ?? ""}: ${f.resolution_note ?? ""}</span>` : badge(f.status === "open" ? "open" : "closed", label(f.status)) },
  { header: "", cell: (f) => f.status !== "resolved" ? html`<form method="post" action="/staff/finance/reconciliation/${f.id}/resolve" class="stack">${csrf(ctx)}${textarea({ name: "note", label: "What you checked / did", rows: 2, maxlength: 1000, required: true })}${button("Mark reviewed", { variant: "secondary", size: "sm" })}</form>` : "" },
], { empty: emptyState("No reconciliation findings", reader.ok ? "Stripe and local records agree for the period checked." : "Reconciliation has not compared anything because payments are not configured.") })}
${pagination(ctx, page, rows.length > limit)}
<section class="section--tight"><h2>Recent runs</h2>${table(runs, [
  { header: "Started", cell: (x) => formatDateTime(x.started_at) }, { header: "Status", cell: (x) => badge(x.status === "ok" ? "verified" : x.status === "skipped" ? "not_configured" : x.status === "failed" ? "failing" : "queued", label(x.status)) },
  { header: "Checked", cell: (x) => x.objects_checked, numeric: true }, { header: "New findings", cell: (x) => x.findings_opened, numeric: true }, { header: "Detail", cell: (x) => x.detail ?? "—" },
], { empty: emptyState("No runs yet", "The reconciliation job records each run here.") })}</section>`;
    return staffPage(ctx, "Reconciliation", body, status);
  };
  r.get("/staff/finance/reconciliation", (ctx) => reconciliationPage(ctx));
  r.post("/staff/finance/reconciliation/:id/resolve", async (ctx, p) => {
    requireStaff(ctx, "finance.read");
    try {
      await rec.resolveFinding(ctx.db, p.id, ctx.user!.id, str(await ctx.form(), "note"));
      return redirect(ctx, "/staff/finance/reconciliation", { kind: "success", text: "Finding marked as reviewed. No payment or invoice was changed." });
    } catch (e) {
      if (e instanceof rec.FindingError) return reconciliationPage(ctx, [e.message], 422);
      throw e;
    }
  });
}
