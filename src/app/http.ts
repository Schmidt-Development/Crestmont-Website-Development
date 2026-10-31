// Response helpers, cookies, CSRF and security headers.
import type { AppContext } from "./context.ts";
import type { SafeHtml } from "../lib/html.ts";
import { timingSafeEqualHex } from "../lib/crypto.ts";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' https://fonts.googleapis.com",
  // Inline style ATTRIBUTES only (layout values rendered through the escaping template). Style
  // elements, external sheets and all scripts remain restricted to self (ASVS finding F-12).
  "style-src-attr 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "connect-src 'self'",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

/** PAGE_CSP with additional frame-src origins (portfolio demos). Only bare https origins are accepted. */
export function pageCsp(extraFrameSrc: string[] = []): string {
  const extra = extraFrameSrc.filter((o) => /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(o));
  return extra.length ? PAGE_CSP.replace("frame-src https://challenges.cloudflare.com", `frame-src https://challenges.cloudflare.com ${[...new Set(extra)].join(" ")}`) : PAGE_CSP;
}

export function securityHeaders(kind: "page" | "api" = "page", frameSrc: string[] = []): Record<string, string> {
  return {
    "content-security-policy": kind === "page" ? pageCsp(frameSrc) : "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    // Replaced per environment by src/app/app.ts (hstsValue) on every Worker response.
    "strict-transport-security": DEFAULT_HSTS,
  };
}

export const DEFAULT_HSTS = "max-age=63072000; includeSubDomains";

/**
 * Strict-Transport-Security for this environment (CREST-GAP-029). Without HSTS_MAX_AGE the long-standing default
 * (2 years, includeSubDomains) is kept, which is what staging and development send. With HSTS_MAX_AGE (production's first
 * release uses 300) the header is exactly that max-age, and includeSubDomains only when HSTS_INCLUDE_SUBDOMAINS = "on".
 * An unusable value falls back to 300 rather than to the 2-year default, so a typo can never pin browsers for years.
 */
export function hstsValue(env: { HSTS_MAX_AGE?: string; HSTS_INCLUDE_SUBDOMAINS?: string }): string {
  const raw = env.HSTS_MAX_AGE?.trim();
  if (raw === undefined || raw === "") return DEFAULT_HSTS;
  const n = /^\d{1,9}$/.test(raw) ? Number(raw) : 300;
  return `max-age=${n}${env.HSTS_INCLUDE_SUBDOMAINS === "on" ? "; includeSubDomains" : ""}`;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAge?: number; secure: boolean; httpOnly?: boolean; sameSite?: "Lax" | "Strict" }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    opts.maxAge !== undefined ? `Max-Age=${opts.maxAge}` : "",
    opts.httpOnly === false ? "" : "HttpOnly",
    opts.secure ? "Secure" : "",
    `SameSite=${opts.sameSite ?? "Lax"}`,
  ].filter(Boolean).join("; ");
}

export function isSecure(ctx: AppContext): boolean {
  return ctx.url.protocol === "https:";
}

/**
 * Cookie names (CREST-GAP-086): over HTTPS the session and CSRF cookies use the `__Host-` prefix, which browsers only
 * accept with Secure, Path=/ and no Domain — so a sibling subdomain or another *.workers.dev site cannot plant or
 * shadow them. Plain-HTTP development keeps the bare names. Reads accept both, so existing sessions keep working.
 */
export const hostCookieName = (base: "cm_session" | "cm_csrf", secure: boolean) => (secure ? `__Host-${base}` : base);
export function readHostCookie(cookies: Record<string, string>, base: "cm_session" | "cm_csrf"): string | undefined {
  return cookies[`__Host-${base}`] ?? cookies[base];
}

function withCookies(ctx: AppContext, headers: Headers): void {
  for (const c of ctx.setCookies) headers.append("set-cookie", c);
}

export function htmlResponse(ctx: AppContext, body: SafeHtml, status = 200): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": ctx.user ? "no-store" : "no-cache", ...securityHeaders("page", ctx.frameSrc) });
  withCookies(ctx, headers);
  return new Response("<!doctype html>" + body.value, { status, headers });
}

export function redirect(ctx: AppContext, location: string, flash?: { kind: "success" | "error" | "info"; text: string }): Response {
  const safe = location.startsWith("/") && !location.startsWith("//") ? location : "/";
  if (flash) ctx.setCookies.push(cookie("cm_flash", JSON.stringify(flash), { maxAge: 60, secure: isSecure(ctx) }));
  const headers = new Headers({ location: safe, ...securityHeaders("page") });
  withCookies(ctx, headers);
  return new Response(null, { status: 303, headers });
}

export function jsonResponse(ctx: AppContext | null, status: number, body: unknown, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...securityHeaders("api"), ...extra });
  if (ctx) withCookies(ctx, headers);
  return new Response(JSON.stringify(body), { status, headers });
}

export function download(ctx: AppContext, body: BodyInit, filename: string, contentType: string): Response {
  const headers = new Headers({
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename.replace(/[^\w.\- ]/g, "_")}"`,
    "cache-control": "no-store",
    ...securityHeaders("api"),
  });
  withCookies(ctx, headers);
  return new Response(body, { headers });
}

/** Double-submit CSRF with Origin check (SEC-002). Applied to every state-changing form route. */
export async function assertCsrf(ctx: AppContext): Promise<void> {
  const origin = ctx.req.headers.get("origin");
  if (origin && origin !== ctx.url.origin) throw new HttpError(403, "Cross-origin request blocked");
  if (!origin) {
    const ref = ctx.req.headers.get("referer");
    // A malformed Referer is refused like a foreign one (403), never a 500 (CREST-GAP-101).
    let refOrigin: string | null = null;
    if (ref) { try { refOrigin = new URL(ref).origin; } catch { refOrigin = "invalid"; } }
    if (ref && refOrigin !== ctx.url.origin) throw new HttpError(403, "Cross-origin request blocked");
  }
  const form = await ctx.form();
  const sent = String(form.get("_csrf") ?? "");
  const cookieVal = readHostCookie(parseCookies(ctx.req.headers.get("cookie")), "cm_csrf") ?? "";
  if (!sent || !cookieVal || sent.length !== cookieVal.length || !timingSafeEqualHex(sent, cookieVal)) {
    throw new HttpError(403, "Your form expired. Reload the page and try again.");
  }
}

export function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}
