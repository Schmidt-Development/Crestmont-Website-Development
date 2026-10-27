// Cloudflare Worker entry point (API). Static public pages are served from Workers static assets.
import type { Db } from "./lib/db.ts";
import { ValidationError } from "./lib/validate.ts";
import { captureLead } from "./services/leads.ts";
import { ingestEvidence, verifyEvidenceSignature, IngestAuthError } from "./readiness/ingest.ts";
import { buildReport, loadReadinessInput, requirementsCsv } from "./readiness/report.ts";
import { verifyStripeSignature, recordStripeEvent, WebhookSignatureError, type StripeEvent } from "./domain/stripe-webhook.ts";

export interface Env {
  DB: Db;
  ENVIRONMENT: "development" | "staging" | "production";
  EVIDENCE_INGEST_SECRET?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  TURNSTILE_SECRET?: string;
  /** Resolves the authenticated staff actor. Wired to the managed auth provider; absent ⇒ every protected route returns 401. */
  resolveActor?: (req: Request) => Promise<import("./domain/authz.ts").Actor | null>;
}

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
};

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extra } });

const MAX_BODY = 1_000_000;
async function readBody(req: Request): Promise<string> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) throw Object.assign(new Error("Payload too large"), { status: 413 });
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error("Payload too large"), { status: 413 });
  return text;
}

async function verifyTurnstile(env: Env, token: unknown, ip: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return env.ENVIRONMENT === "development"; // fail closed outside development
  if (typeof token !== "string" || !token) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  return ((await r.json()) as { success?: boolean }).success === true;
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const route = `${req.method} ${url.pathname}`;
  try {
    switch (route) {
      case "GET /api/health": {
        await env.DB.prepare("SELECT 1").first();
        return json(200, { status: "ok", environment: env.ENVIRONMENT });
      }
      case "POST /api/leads": {
        const raw = await readBody(req);
        const body = JSON.parse(raw) as Record<string, unknown>;
        const ip = req.headers.get("cf-connecting-ip");
        if (!(await verifyTurnstile(env, body.turnstileToken, ip))) return json(400, { error: "Bot verification failed" });
        const { leadId } = await captureLead(env.DB, body, { ip: ip ?? undefined });
        return json(201, { leadId });
      }
      case "POST /api/readiness/evidence": {
        const raw = await readBody(req);
        await verifyEvidenceSignature(env.EVIDENCE_INGEST_SECRET, raw, req.headers.get("x-crestmont-signature"));
        return json(200, await ingestEvidence(env.DB, raw));
      }
      case "POST /api/webhooks/stripe": {
        const raw = await readBody(req);
        await verifyStripeSignature(raw, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET ?? "");
        const evt = JSON.parse(raw) as StripeEvent;
        const outcome = await recordStripeEvent(env.DB, evt, raw);
        // Processing runs from the queue consumer (not yet implemented — PAY-003 remains in progress).
        return json(200, { received: true, duplicate: outcome === "duplicate" });
      }
      case "GET /api/readiness":
      case "GET /api/readiness/requirements.csv": {
        const actor = env.resolveActor ? await env.resolveActor(req) : null;
        if (!actor) return json(401, { error: "Authentication required" });
        const { can } = await import("./domain/authz.ts");
        if (!can(actor, "readiness.read")) return json(403, { error: "Forbidden" });
        const report = await buildReport(await loadReadinessInput(env.DB));
        if (route.endsWith(".csv")) {
          return new Response(requirementsCsv(report), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="crestmont-readiness-${report.generatedAt.slice(0, 10)}.csv"`, ...SECURITY_HEADERS } });
        }
        return json(200, report, { "cache-control": "no-store" });
      }
      default:
        return json(404, { error: "Not found" });
    }
  } catch (err) {
    if (err instanceof ValidationError) return json(422, { error: "Invalid input", issues: err.issues });
    if (err instanceof SyntaxError) return json(400, { error: "Malformed JSON" });
    if (err instanceof IngestAuthError || err instanceof WebhookSignatureError) return json(401, { error: err.message });
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) return json(status, { error: (err as Error).message });
    console.error(JSON.stringify({ level: "error", route, message: (err as Error).message }));
    return json(500, { error: "Internal error" });
  }
}

export default { fetch: handle };
