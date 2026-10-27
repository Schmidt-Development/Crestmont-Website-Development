// Request pipeline: build context → load session → CSRF for forms → route → render errors.
import type { AppContext, Env } from "./context.ts";
import { Router } from "../lib/router.ts";
import { HttpError, assertCsrf, cookie, htmlResponse, isSecure, jsonResponse, parseCookies, redirect } from "./http.ts";
import { randomToken } from "../lib/auth-crypto.ts";
import { loadSession } from "../services/auth.ts";
import { OutboxEmail, ResendEmail } from "../adapters/email.ts";
import { R2Storage, type R2BucketLike } from "../adapters/storage.ts";
import { NoPayments, StripeTestPayments } from "../adapters/payments.ts";
import { ValidationError } from "../lib/validate.ts";
import { errorPage } from "../ui/layout.ts";
import { registerAll } from "../routes/index.ts";
import { can, STAFF_ROLES, type Permission } from "../domain/authz.ts";
import { recordAppError } from "../services/monitoring.ts";

let router: Router | null = null;
function getRouter(): Router {
  if (!router) { router = new Router(); registerAll(router); }
  return router;
}

export async function buildContext(req: Request, env: Env): Promise<AppContext> {
  const url = new URL(req.url);
  const cookies = parseCookies(req.headers.get("cookie"));
  let formCache: Promise<FormData> | null = null;
  const now = env.overrides?.now ?? (() => new Date());
  const ctx: AppContext = {
    req, url, env, db: env.DB,
    email: env.overrides?.email ?? (env.RESEND_API_KEY && env.ENVIRONMENT !== "development"
      ? new ResendEmail(env.DB, env.RESEND_API_KEY, env.EMAIL_FROM ?? "Crestmont <support@crestmontwebsitedevelopment.com>")
      : new OutboxEmail(env.DB)),
    storage: env.overrides?.storage !== undefined ? env.overrides.storage : env.FILES ? new R2Storage(env.FILES as R2BucketLike) : null,
    payments: env.overrides?.payments ?? (env.STRIPE_SECRET_KEY ? new StripeTestPayments(env.STRIPE_SECRET_KEY) : new NoPayments()),
    ip: req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null,
    now,
    baseUrl: env.APP_URL ?? url.origin,
    user: null, actor: null, sessionId: null, sessionMfaVerified: false,
    csrfToken: cookies.cm_csrf && /^[0-9a-f]{32}$/.test(cookies.cm_csrf) ? cookies.cm_csrf : "",
    flash: null,
    setCookies: [],
    settings: {},
    form: () => {
      if (!formCache) formCache = req.clone().formData().catch(() => new FormData());
      return formCache;
    },
  };
  if (!ctx.csrfToken) {
    ctx.csrfToken = randomToken(16);
    ctx.setCookies.push(cookie("cm_csrf", ctx.csrfToken, { secure: isSecure(ctx), httpOnly: true, sameSite: "Strict", maxAge: 60 * 60 * 24 }));
  }
  if (cookies.cm_flash) {
    try {
      const f = JSON.parse(cookies.cm_flash);
      if (f && ["success", "error", "info"].includes(f.kind) && typeof f.text === "string") ctx.flash = { kind: f.kind, text: f.text.slice(0, 300) };
    } catch { /* ignore */ }
    ctx.setCookies.push(cookie("cm_flash", "", { maxAge: 0, secure: isSecure(ctx) }));
  }
  const session = await loadSession(env.DB, cookies.cm_session);
  if (session) {
    ctx.user = session.user; ctx.actor = session.actor; ctx.sessionId = session.sessionId; ctx.sessionMfaVerified = session.mfaVerified;
  } else if (env.resolveActor) {
    ctx.actor = await env.resolveActor(req);
  }
  try {
    const rows = (await env.DB.prepare(`SELECT key, value FROM business_settings`).all<{ key: string; value: string }>()).results;
    for (const r of rows) ctx.settings[r.key] = r.value;
  } catch { /* table may not exist in legacy test databases */ }
  return ctx;
}

// ── Guards used by route modules ──
export function requireUser(ctx: AppContext): asserts ctx is AppContext & { user: NonNullable<AppContext["user"]>; actor: NonNullable<AppContext["actor"]> } {
  if (!ctx.user || !ctx.actor) throw new HttpError(401, "Please sign in.");
}

export function requireStaff(ctx: AppContext, perm?: Permission): void {
  requireUser(ctx);
  if (!ctx.user!.isStaff) throw new HttpError(403, "This area is for Crestmont staff.");
  if (!ctx.sessionMfaVerified) throw new HttpError(401, "MFA_REQUIRED");
  if (perm && !can(ctx.actor!, perm)) throw new HttpError(403, "You do not have permission to do that.");
}

/** Returns the customer organization the signed-in customer is acting for (first membership, or ?org= when they belong to several). */
export function requireCustomerOrg(ctx: AppContext): { organizationId: string; organizationName: string; role: string } {
  requireUser(ctx);
  const customer = ctx.user!.memberships.filter((m) => !(STAFF_ROLES as readonly string[]).includes(m.role));
  if (!customer.length) throw new HttpError(403, "This account is not linked to a customer organization.");
  const wanted = ctx.url.searchParams.get("org");
  const m = (wanted && customer.find((c) => c.organizationId === wanted)) || customer[0];
  if (!ctx.sessionMfaVerified) throw new HttpError(401, "MFA_REQUIRED");
  return m;
}

const STATIC_TYPES: Record<string, string> = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", png: "image/png", jpg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", txt: "text/plain" };
export const staticContentType = (path: string) => STATIC_TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream";

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/assets/") && env.ASSETS) return env.ASSETS.fetch(req);
  let ctx: AppContext | null = null;
  try {
    ctx = await buildContext(req, env);
    const match = getRouter().match(req.method, url.pathname);
    if (!match) {
      if (url.pathname.startsWith("/api/")) return jsonResponse(ctx, 404, { error: "Not found" });
      return htmlResponse(ctx, errorPage(ctx, 404, "Page not found", "The page you were looking for does not exist or has moved."), 404);
    }
    // Every state-changing browser route is CSRF-protected centrally. /api/* routes authenticate
    // with signatures (webhooks, CI evidence) or are JSON-only and never accept cookies for writes.
    if (req.method !== "GET" && req.method !== "HEAD" && !url.pathname.startsWith("/api/")) await assertCsrf(ctx);
    return await match.handler(ctx, match.params);
  } catch (err) {
    const isApi = url.pathname.startsWith("/api/");
    if (err instanceof ValidationError) {
      return isApi ? jsonResponse(ctx, 422, { error: "Invalid input", issues: err.issues }) : htmlError(ctx, req, env, 422, "Please check your input", err.issues.join(". "));
    }
    if (err instanceof SyntaxError && isApi) return jsonResponse(ctx, 400, { error: "Malformed JSON" });
    const status = (err as { status?: number }).status;
    if (status === 401 && !isApi) {
      if ((err as Error).message === "MFA_REQUIRED" && ctx) return redirect(ctx, `/mfa?next=${encodeURIComponent(url.pathname)}`);
      if (ctx) return redirect(ctx, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    }
    if (status && status >= 400 && status < 500) {
      return isApi ? jsonResponse(ctx, status, { error: (err as Error).message }) : htmlError(ctx, req, env, status, status === 403 ? "Access denied" : "Request could not be completed", (err as Error).message);
    }
    await recordAppError(env.DB, { path: url.pathname, method: req.method, message: (err as Error).message, stack: (err as Error).stack, environment: env.ENVIRONMENT });
    console.error(JSON.stringify({ level: "error", path: url.pathname, message: (err as Error).message, stack: (err as Error).stack?.split("\n").slice(0, 4).join(" | ") }));
    return isApi ? jsonResponse(ctx, 500, { error: "Internal error" }) : htmlError(ctx, req, env, 500, "Something went wrong", "The error has been logged. Please try again shortly.");
  }
}

async function htmlError(ctx: AppContext | null, req: Request, env: Env, status: number, title: string, message: string): Promise<Response> {
  const c = ctx ?? (await buildContext(req, env).catch(() => null));
  if (!c) return new Response(title, { status });
  return htmlResponse(c, errorPage(c, status, title, message), status);
}
