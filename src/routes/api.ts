// JSON API: health, CI evidence ingestion, Stripe webhooks, readiness report. Moved from the
// foundation worker.ts unchanged in behaviour. /api routes never accept cookie-authenticated writes.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { HttpError, jsonResponse, securityHeaders } from "../app/http.ts";
import { captureLead, leadInput, notifyNewLead } from "../services/leads.ts";
import { parse } from "../lib/validate.ts";
import { ingestEvidence, verifyEvidenceSignature, IngestAuthError } from "../readiness/ingest.ts";
import { buildReport, loadReadinessInput, requirementsCsv } from "../readiness/report.ts";
import { verifyStripeSignature, recordStripeEvent, isStripeEventEnvelope, WebhookSignatureError, type StripeEvent } from "../domain/stripe-webhook.ts";
import { processStripeEvent, stripeEventCtx } from "../services/payments.ts";
import { can } from "../domain/authz.ts";
import { audit, rateLimit } from "../services/security.ts";
import { scheduled, SCHEDULE } from "../app/scheduled.ts";
import * as assistant from "../services/assistant.ts";
import { aiProviderFromEnv } from "../services/ai.ts";
import { loadContent } from "../services/cms.ts";
import { parseItems } from "../content/registry.ts";
import { effectivePrices } from "../services/pricing-approvals.ts";
import { ingestPushedSnapshot, GithubPushError } from "../services/github.ts";
import { runImport, ImportError, IMPORT_BATCHES_PER_HOUR } from "../services/crm-import.ts";

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

  // Research-agent / CRM import API v1 (docs/crm-identity/IMPORT-API.md). HMAC-signed machine endpoint (no cookies):
  // 503 until CRM_IMPORT_SECRET is set, 401 on a bad signature, rate-limited per client, idempotent per batch and record.
  r.post("/api/crm/v1/imports", async (ctx) => {
    const raw = await readBody(ctx.req);
    if (!ctx.env.CRM_IMPORT_SECRET) return jsonResponse(ctx, 503, { error: "CRM import API not configured" });
    try { await verifyEvidenceSignature(ctx.env.CRM_IMPORT_SECRET, raw, ctx.req.headers.get("x-crestmont-signature")); }
    catch (e) { if (e instanceof IngestAuthError) return jsonResponse(ctx, 401, { error: e.message }); throw e; }
    // The client name comes from the SIGNED body (a header could be swapped on a replayed request).
    let client = "research-agent";
    try { const b = JSON.parse(raw) as { client?: unknown }; if (b && typeof b === "object" && b.client !== undefined) client = String(b.client); } catch { /* runImport reports invalid JSON */ }
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(client)) return jsonResponse(ctx, 400, { error: "client must be 2–40 lowercase letters, digits or -" });
    const rl = await rateLimit(ctx.db, `crm-import:${client}`, IMPORT_BATCHES_PER_HOUR, 3600);
    if (!rl.allowed) return jsonResponse(ctx, 429, { error: `At most ${IMPORT_BATCHES_PER_HOUR} batches per hour`, retryAfterSeconds: 3600 - (Math.floor(Date.now() / 1000) % 3600) });
    try {
      const res = await runImport(ctx.db, raw, { client, idempotencyKey: (ctx.req.headers.get("idempotency-key") ?? "").trim() });
      await audit(ctx.db, { actorKind: "system", action: "crm.import_batch", subjectType: "crm_import_batch", subjectId: res.batchId, ip: ctx.ip ?? null, details: { client, dryRun: res.dryRun, replayed: res.replayed, counts: res.counts } });
      return jsonResponse(ctx, 200, res);
    } catch (e) {
      if (e instanceof ImportError) return jsonResponse(ctx, e.status, { error: e.message });
      throw e;
    }
  });

  r.get("/api/health", async (ctx) => {
    await ctx.db.prepare("SELECT 1").first();
    // CREST-GAP-055: the running Worker states whether its FILES (R2) binding exists, independent of the deploy-time
    // file-storage:<env> feed. "not_configured" = uploads are disabled on this environment. Binding presence only.
    return jsonResponse(ctx, 200, { status: "ok", environment: ctx.env.ENVIRONMENT, fileStorage: ctx.storage ? "bound" : "not_configured" });
  });

  r.post("/api/leads", async (ctx) => {
    const raw = await readBody(ctx.req);
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse(ctx, 400, { error: "Body must be a JSON object" });
    if (!(await verifyTurnstile(ctx, body.turnstileToken))) return jsonResponse(ctx, 400, { error: "Bot verification failed" });
    parse(leadInput, body); // invalid input is rejected (422) before it counts toward the budget (CREST-GAP-082)
    // Same per-IP budget as the browser lead forms (shared key), so the JSON API is not an unthrottled side door.
    const rl = await rateLimit(ctx.db, `leadform:${ctx.ip ?? "unknown"}`, 10, 3600);
    if (!rl.allowed) return jsonResponse(ctx, 429, { error: "Too many submissions from your network. Please wait an hour." });
    const { leadId } = await captureLead(ctx.db, body, { ip: ctx.ip ?? undefined, channel: "api_lead" });
    // CREST-GAP-005: staff notification (in-app + one staff email); never turns a saved lead into an error.
    try { await notifyNewLead(ctx, leadId, "api"); }
    catch (err) { console.error(JSON.stringify({ level: "error", msg: "staff lead notification failed", leadId, error: (err as Error).message })); }
    return jsonResponse(ctx, 201, { leadId });
  });

  // Public website assistant (docs/frontend/CHATBOT.md). GET says honestly whether live AI answers are available;
  // POST answers from approved facts only. Same-origin JSON only (a cross-site form cannot send application/json, and
  // the Origin must match), rate-limited, size-capped and budget-capped; no visitor text is stored.
  r.get("/api/assistant", async (ctx) => {
    const a = await assistant.assistantAvailability(ctx.db, aiProviderFromEnv(ctx.env));
    return jsonResponse(ctx, 200, { available: a.available, reason: a.reason, maxMessageChars: assistant.ASSISTANT_LIMITS.maxMessageChars });
  });
  r.post("/api/assistant", async (ctx) => {
    const origin = ctx.req.headers.get("origin");
    if (!origin || origin !== ctx.url.origin) return jsonResponse(ctx, 403, { code: "forbidden", message: "Cross-origin request blocked" });
    if (!/^application\/json\b/i.test(ctx.req.headers.get("content-type") ?? "")) return jsonResponse(ctx, 415, { code: "invalid", message: "Send JSON" });
    let body: unknown;
    try { body = JSON.parse(await readBody(ctx.req)); } catch (e) { if (e instanceof HttpError) throw e; return jsonResponse(ctx, 400, { code: "invalid", message: "Invalid JSON" }); }
    const session = String(ctx.req.headers.get("x-assistant-session") ?? "").slice(0, 64);
    const c = await loadContent(ctx, ["faq.items", "process.page"]);
    const facts: assistant.AssistantFacts = {
      pricesCents: await effectivePrices(ctx.db, ctx.now()),
      process: parseItems(c.get("process.page").steps ?? ""), faqs: parseItems(c.get("faq.items").items ?? ""),
      email: ctx.settings["contact.email"]?.trim() || "support@crestmontwebsitedevelopment.com",
    };
    const res = await assistant.answer(ctx.db, aiProviderFromEnv(ctx.env), { body, ip: ctx.ip ?? null, session: /^[a-z0-9-]{8,64}$/i.test(session) ? session : "", facts });
    return res.ok ? jsonResponse(ctx, 200, { reply: res.reply, links: res.links, ai: true }) : jsonResponse(ctx, res.status, { code: res.code, message: res.message });
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
    if (outcome === "new") await processStripeEvent(stripeEventCtx(ctx, ctx.env), evt);
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
