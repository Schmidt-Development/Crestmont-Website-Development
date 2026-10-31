// Provider webhooks and their staff review pages (VOICE-003, EMAIL-003, FIN-002, PAY-009).
//  POST /api/webhooks/retell            Retell call events (call_started / call_ended / call_analyzed)
//  POST /api/webhooks/retell/functions  Retell custom-function calls → voice service functions
//  POST /api/webhooks/retell/inbound    Retell inbound-call webhook (per phone number): number binding, env stamp, dynamic variables
//  POST /api/webhooks/resend            Resend (Svix-signed) delivery events → delivery status + suppressions
//  GET  /staff/email-suppressions       suppression list (settings.operational); POST …/:id/remove
//  GET  /staff/finance/reconciliation   Stripe reconciliation findings, payouts + cost-import ledger (finance.read; src/routes/reconciliation.ts)
// Reviewing a finding is a finance.read action: it records a note only and changes no money state.
// /staff/email/suppressions is not used because platform.ts's /staff/email/:id is matched first.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, label } from "../lib/html.ts";
import { HttpError, jsonResponse, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { textarea, button, alert, badge, table, emptyState, pagination, pageParam, pageHead, linkButton, input, csrf, select } from "../ui/components.ts";
import { staffPage } from "./crm.ts";
import { readBody } from "./api.ts";
import { handleVoiceEvent, VOICE_FUNCTIONS } from "../services/voice.ts";
import { translateRetellEvent, translateRetellFunction, translateRetellInbound, RetellAuthError, RetellPayloadError, type Translated, type RetellCtx } from "../adapters/retell.ts";
import * as mail from "../services/email-events.ts";
import { registerReconciliation } from "./reconciliation.ts";
import { verifyRetellWorkspace, type RetellWorkspace } from "../adapters/retell-workspaces.ts";
import { ingestSalesEvent } from "../services/sales-opt/ingest.ts";
import { audit } from "../services/security.ts";

const q = (ctx: AppContext, k: string, max = 120) => (ctx.url.searchParams.get(k) ?? "").trim().slice(0, max);

// Which Retell workspace may call each route (retell-workspaces.ts). The workspace is proven by the signature itself.
// Call events: both (the sales agent's events feed the sales optimizer through this route). Functions and the inbound-call
// webhook: the receptionist's (inbound) workspace only.
// Functions: both workspaces may call the endpoint (the sales agent records consent with record_consent), but every
// receptionist function except record_consent is refused unless the inbound workspace signed the request.
const EVENT_WORKSPACES = ["inbound", "outbound"] as const;
const FUNCTION_WORKSPACES = ["inbound", "outbound"] as const;
const RECEPTIONIST_ONLY = ["inbound"] as const;
const RECEPTIONIST_FUNCTIONS = new Set<string>(VOICE_FUNCTIONS);

async function retell(ctx: AppContext, translate: (db: AppContext["db"], raw: string, rc: RetellCtx) => Promise<Translated>, fn: boolean, workspaces: readonly RetellWorkspace[]): Promise<Response> {
  const raw = await readBody(ctx.req);
  try {
    const ws = await verifyRetellWorkspace(ctx.env, workspaces, raw, ctx.req.headers.get("x-retell-signature"));
    if (fn && ws === "outbound") {
      // The body is authentic (the outbound key verified it); its function name decides whether that workspace may run it.
      let name: unknown;
      try { name = (JSON.parse(raw) as { name?: unknown }).name; } catch { /* invalid JSON is answered below */ }
      if (typeof name === "string" && RECEPTIONIST_FUNCTIONS.has(name)) {
        await audit(ctx.db, { actorKind: "webhook", action: "voice.wrong_workspace", subjectType: "webhook", subjectId: "retell", details: { function: name.slice(0, 60), workspace: ws } });
        return jsonResponse(ctx, 403, { error: "This function belongs to the receptionist's Retell workspace.", result: { error: "This function isn't available on this line. Apologise and offer a callback." } });
      }
    }
  } catch (e) {
    if (e instanceof RetellAuthError) throw new HttpError(401, e.message);
    throw e;
  }
  const now = ctx.env.overrides?.now;
  let t: Translated;
  try { t = await translate(ctx.db, raw, { environment: ctx.env.ENVIRONMENT, now }); } catch (e) {
    if (e instanceof RetellPayloadError || e instanceof SyntaxError) return jsonResponse(ctx, 422, { error: e instanceof SyntaxError ? "Body is not valid JSON" : e.message });
    throw e;
  }
  // Sales-optimization facts (SALESOPT-001): recorded after the voice handler, only for a registered sales agent.
  // A failure here never changes the response to Retell (the voice handler's result stands) but is audited.
  const salesFacts = async () => {
    if (translate !== translateRetellEvent) return;
    try { await ingestSalesEvent(ctx.db, raw, ctx.req.headers.get("x-retell-signature"), { environment: ctx.env.ENVIRONMENT, now }); }
    catch (e) {
      try { await audit(ctx.db, { actorKind: "webhook", action: "salesopt.ingest_failed", subjectType: "webhook", subjectId: "retell", details: { error: (e as Error).message.slice(0, 200) } }); }
      catch { /* never fail the receptionist's response because of the optimizer */ }
    }
  };
  if (t.kind === "ack") { await salesFacts(); return jsonResponse(ctx, t.status ?? 200, fn ? ((t.body.result as Record<string, unknown> | undefined) ?? t.body) : t.body); }
  // Consultation confirmations go through the platform's existing mail pipeline (Resend outside development).
  const res = await handleVoiceEvent(ctx.db, t.body, { mail: { email: ctx.email, db: ctx.db, settings: ctx.settings }, baseUrl: ctx.baseUrl, now, paymentsConfigured: ctx.payments.configured });
  if (res.status < 300) await salesFacts();
  // Retell gives the function response body to the agent's LLM: return only the result object.
  if (fn) return jsonResponse(ctx, res.status, (res.body.result as Record<string, unknown> | undefined) ?? res.body);
  return jsonResponse(ctx, res.status, res.body);
}

export function register(r: Router): void {
  r.post("/api/webhooks/retell", (ctx) => retell(ctx, translateRetellEvent, false, EVENT_WORKSPACES));
  r.post("/api/webhooks/retell/functions", (ctx) => retell(ctx, translateRetellFunction, true, FUNCTION_WORKSPACES));
  r.post("/api/webhooks/retell/inbound", (ctx) => retell(ctx, translateRetellInbound, false, RECEPTIONIST_ONLY));

  r.post("/api/webhooks/resend", async (ctx) => {
    const raw = await readBody(ctx.req);
    let svixId: string;
    try {
      svixId = await mail.verifySvix(ctx.env.RESEND_WEBHOOK_SECRET, raw, ctx.req.headers);
    } catch (e) {
      if (e instanceof mail.SvixAuthError) throw new HttpError(401, e.message);
      throw e;
    }
    const out = await mail.handleResendEvent(ctx.db, svixId, raw, ctx.env.ENVIRONMENT);
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

  // ── Stripe reconciliation + cost import (PAY-009, FIN-002): src/routes/reconciliation.ts ──
  registerReconciliation(r);
}
