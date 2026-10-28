// JSON API: health, CI evidence ingestion, Stripe webhooks, readiness report. Moved from the
// foundation worker.ts unchanged in behaviour. /api routes never accept cookie-authenticated writes.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { HttpError, jsonResponse, securityHeaders } from "../app/http.ts";
import { captureLead } from "../services/leads.ts";
import { ingestEvidence, verifyEvidenceSignature, IngestAuthError } from "../readiness/ingest.ts";
import { buildReport, loadReadinessInput, requirementsCsv } from "../readiness/report.ts";
import { verifyStripeSignature, recordStripeEvent, isStripeEventEnvelope, WebhookSignatureError, type StripeEvent } from "../domain/stripe-webhook.ts";
import { processStripeEvent, stripeInvoiceLookup } from "../services/payments.ts";
import { can } from "../domain/authz.ts";
import { audit, rateLimit } from "../services/security.ts";
import { scheduled, SCHEDULE } from "../app/scheduled.ts";
import { ingestPushedSnapshot, GithubPushError } from "../services/github.ts";

const MAX_BODY = 1_000_000;
export async function readBody(req: Request): Promise<string> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) throw new HttpError(413, "Payload too large");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Payload too large");
  return text;
}

export async function verifyTurnstile(ctx: AppContext, token: unknown): Promise<boolean> {
  const env = ctx.env;
  if (!env.TURNSTILE_SECRET) return env.ENVIRONMENT === "development"; // fail closed outside development
  if (typeof token !== "string" || !token) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", token);
  if (ctx.ip) form.set("remoteip", ctx.ip);
  const f = env.overrides?.fetch ?? fetch; // test seam; production uses the global fetch
  const r = await f("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  return ((await r.json()) as { success?: boolean }).success === true;
}

export function register(r: Router) {
  // Backup scheduler (READY-012, INFRA-006): runs the same job sets as the Worker's Cron Triggers, on demand, if native
  // triggers ever fail (they were unavailable on Workers Free; native triggers run since the Paid upgrade, 2026-10-28).
  // HMAC-signed like the other machine endpoints; 503 when no key is configured; at most one run per set per 5 minutes.
  r.post("/api/scheduled/run", async (ctx) => {
    const raw = await readBody(ctx.req);
    if (!ctx.env.SCHEDULER_TRIGGER_SECRET) return jsonResponse(ctx, 503, { error: "External scheduler not configured" });
    try { await verifyEvidenceSignature(ctx.env.SCHEDULER_TRIGGER_SECRET, raw, ctx.req.headers.get("x-crestmont-scheduler-signature")); }
    catch (e) { if (e instanceof IngestAuthError) return jsonResponse(ctx, 401, { error: e.message }); throw e; }
    let cron: unknown;
    try { cron = (JSON.parse(raw) as { cron?: unknown }).cron; } catch { return jsonResponse(ctx, 400, { error: "Body must be JSON" }); }
    if (typeof cron !== "string" || !SCHEDULE[cron]) return jsonResponse(ctx, 422, { error: "Unknown schedule" });
    const rl = await rateLimit(ctx.db, `scheduler:${cron}`, 1, 300);
    if (!rl.allowed) return jsonResponse(ctx, 429, { error: "Already ran within the last 5 minutes" });
    await scheduled({ cron }, ctx.env);
    return jsonResponse(ctx, 200, { ran: SCHEDULE[cron] });
  });

  r.get("/api/health", async (ctx) => {
    await ctx.db.prepare("SELECT 1").first();
    return jsonResponse(ctx, 200, { status: "ok", environment: ctx.env.ENVIRONMENT });
  });

  r.post("/api/leads", async (ctx) => {
    const raw = await readBody(ctx.req);
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse(ctx, 400, { error: "Body must be a JSON object" });
    if (!(await verifyTurnstile(ctx, body.turnstileToken))) return jsonResponse(ctx, 400, { error: "Bot verification failed" });
    const { leadId } = await captureLead(ctx.db, body, { ip: ctx.ip ?? undefined });
    return jsonResponse(ctx, 201, { leadId });
  });

  r.post("/api/readiness/evidence", async (ctx) => {
    const raw = await readBody(ctx.req);
    try {
      await verifyEvidenceSignature(ctx.env.EVIDENCE_INGEST_SECRET, raw, ctx.req.headers.get("x-crestmont-signature"));
    } catch (e) {
      if (e instanceof IngestAuthError) throw new HttpError(401, e.message);
      throw e;
    }
    return jsonResponse(ctx, 200, await ingestEvidence(ctx.db, raw));
  });

  // READY-005: GitHub snapshot pushed by the deploy workflow (scripts/post-github-snapshot.ts), signed with
  // the same HMAC scheme and secret as evidence. Lets the GitHub view work without a PAT on the Worker.
  r.post("/api/readiness/github-snapshot", async (ctx) => {
    const raw = await readBody(ctx.req);
    try {
      await verifyEvidenceSignature(ctx.env.EVIDENCE_INGEST_SECRET, raw, ctx.req.headers.get("x-crestmont-signature"));
    } catch (e) {
      if (e instanceof IngestAuthError) throw new HttpError(401, e.message);
      throw e;
    }
    try {
      return jsonResponse(ctx, 200, await ingestPushedSnapshot(ctx, raw));
    } catch (e) {
      if (e instanceof GithubPushError) return jsonResponse(ctx, e.status, { error: e.message });
      throw e;
    }
  });

  r.post("/api/webhooks/stripe", async (ctx) => {
    const raw = await readBody(ctx.req);
    try {
      await verifyStripeSignature(raw, ctx.req.headers.get("stripe-signature"), ctx.env.STRIPE_WEBHOOK_SECRET ?? "");
    } catch (e) {
      if (e instanceof WebhookSignatureError) throw new HttpError(401, e.message);
      throw e;
    }
    const evt = JSON.parse(raw) as StripeEvent;
    if (!isStripeEventEnvelope(evt)) return jsonResponse(ctx, 400, { error: "Malformed event" });
    const outcome = await recordStripeEvent(ctx.db, evt, raw);
    if (outcome === "new") await processStripeEvent({ db: ctx.db, email: ctx.email, baseUrl: ctx.baseUrl, stripeLookup: stripeInvoiceLookup(ctx.env.STRIPE_SECRET_KEY, ctx.env.overrides?.fetch ?? fetch) }, evt);
    return jsonResponse(ctx, 200, { received: true, duplicate: outcome === "duplicate" });
  });

  const readiness = async (ctx: AppContext, csv: boolean) => {
    if (!ctx.actor) return jsonResponse(ctx, 401, { error: "Authentication required" });
    if (!can(ctx.actor, "readiness.read")) return jsonResponse(ctx, 403, { error: "Forbidden" });
    const report = await buildReport(await loadReadinessInput(ctx.db));
    if (csv) {
      await audit(ctx.db, { actorUserId: ctx.actor.userId ?? null, actorKind: ctx.actor.kind === "user" ? "user" : "system", action: "readiness.exported", subjectType: "readiness_report", details: { format: "requirements_csv", via: "api" } });
      return new Response(requirementsCsv(report), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="crestmont-readiness-${report.generatedAt.slice(0, 10)}.csv"`, ...securityHeaders("api") } });
    }
    return jsonResponse(ctx, 200, report);
  };
  r.get("/api/readiness", (ctx) => readiness(ctx, false));
  r.get("/api/readiness/requirements.csv", (ctx) => readiness(ctx, true));
}
