// Emergency re-lock for staging (OFF by default). Founder decision 2026-10-28: the staging website is public, like a
// normal website; no preview password is issued and the deploy workflow no longer sets one. Owner, staff and customer
// accounts keep their own authentication, mandatory staff MFA, step-up, rate limits and authorization exactly as in
// production — none of those ever depended on this gate.
//
// The gate runs ONLY when the deployment explicitly sets PREVIEW_GATE = "required" (never in production). A leftover
// STAGING_ACCESS_PASSWORD secret alone does nothing. To re-lock staging in an emergency: set PREVIEW_GATE = "required"
// in [env.staging] and a STAGING_ACCESS_PASSWORD secret (it fails closed with 503 until the secret exists). Signed
// machine endpoints (webhooks, CI evidence, deployments), the health check and assets stay reachable when locked.
import type { Env } from "./context.ts";
import { hmacSha256Hex, timingSafeEqualHex } from "../lib/crypto.ts";
import { escapeHtml } from "../lib/html.ts";
import { rateLimit, securityEvent } from "../services/security.ts";

export const PREVIEW_COOKIE = "cm_preview";
const PASS_TTL_S = 12 * 3600;

const EXEMPT = [/^\/api\/health$/, /^\/api\/webhooks\//, /^\/api\/builds\/runner\//, /^\/api\/readiness\/(evidence|deployments|release-candidates|release-authorization|health|github-snapshot)$/, /^\/api\/scheduled\/run$/, /^\/assets\//];

/** Never in production. Only when the deployment explicitly sets PREVIEW_GATE = "required" (then fails closed without a password). */
export function previewGateEnabled(env: Env): boolean {
  if (env.ENVIRONMENT === "production") return false;
  return env.PREVIEW_GATE === "required";
}

async function passValue(env: Env, issuedAt: number): Promise<string> {
  return `${issuedAt}.${await hmacSha256Hex(env.STAGING_ACCESS_PASSWORD!, `preview-pass:${issuedAt}`)}`;
}

async function validPass(env: Env, cookieValue: string | undefined, now = Date.now()): Promise<boolean> {
  const m = /^(\d{10})\.([0-9a-f]{64})$/.exec(cookieValue ?? "");
  if (!m) return false;
  const issued = Number(m[1]);
  if (now / 1000 - issued > PASS_TTL_S || issued > now / 1000 + 60) return false;
  return timingSafeEqualHex((await passValue(env, issued)).split(".")[1], m[2]);
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; } }
  }
  return undefined;
}

function page(message: string, next: string, status: number): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Crestmont staging preview</title><meta name="robots" content="noindex, nofollow"><link rel="stylesheet" href="/assets/app.css"></head>
<body><main id="main" class="auth-shell"><div class="auth-card card card--gold">
<div class="brand" style="justify-content:center;display:flex;margin-bottom:2rem"><img class="brand__mark" src="/assets/brand/crestmont-crest.png" width="42" height="41" alt=""><span><span class="brand__word">CRESTMONT</span><span class="brand__sub">WEBSITE DEVELOPMENT</span></span></div>
<h1 style="font-size:1.8rem">Staging preview</h1>
<p class="muted">This is a private pre-launch preview with test data only. No real payments, emails or phone calls happen here.</p>
${message ? `<div class="alert alert--error" role="alert">${escapeHtml(message)}</div>` : ""}
<form method="post" action="/__preview-access"><input type="hidden" name="next" value="${escapeHtml(next)}">
<div class="field"><label for="f-preview">Preview password</label><input class="input" id="f-preview" name="password" type="password" autocomplete="current-password" required></div>
<div class="form-actions"><button class="btn btn--primary" type="submit">Enter preview</button></div></form></div></main></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow",
      "content-security-policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'",
      "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    },
  });
}

/** Returns a Response when the gate handles the request, or null to continue into the application. */
export async function previewGate(req: Request, env: Env): Promise<Response | null> {
  if (!previewGateEnabled(env)) return null;
  const url = new URL(req.url);
  if (EXEMPT.some((re) => re.test(url.pathname))) return null;
  if (!env.STAGING_ACCESS_PASSWORD) {
    // Staging without a configured password stays locked (e.g. the moment between first deploy and secret creation).
    return new Response("Crestmont staging preview is locked: no preview password is configured yet.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  }
  if (url.pathname === "/__preview-access" && req.method === "POST") {
    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
    const now = Date.now();
    // Shared across all Worker instances (D1-backed), unlike in-memory counters.
    const rl = await rateLimit(env.DB, `preview:${ip}`, 10, 900);
    if (!rl.allowed) { await securityEvent(env.DB, "rate_limited", { ip, detail: "staging preview gate" }); return page("Too many attempts. Try again in 15 minutes.", "/", 429); }
    const form = await req.formData().catch(() => new FormData());
    const next = String(form.get("next") ?? "/");
    const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
    const given = String(form.get("password") ?? "");
    const expected = env.STAGING_ACCESS_PASSWORD!;
    // Compare HMACs so the comparison is constant-time regardless of length.
    const ok = timingSafeEqualHex(await hmacSha256Hex("cmp", given), await hmacSha256Hex("cmp", expected));
    if (!ok) {
      await securityEvent(env.DB, "preview_gate_failed", { ip });
      return page("That password is not correct.", safeNext, 401);
    }
    const issued = Math.floor(now / 1000);
    const headers = new Headers({ location: safeNext, "cache-control": "no-store" });
    headers.append("set-cookie", `${PREVIEW_COOKIE}=${encodeURIComponent(await passValue(env, issued))}; Path=/; Max-Age=${PASS_TTL_S}; HttpOnly; Secure; SameSite=Lax`);
    return new Response(null, { status: 303, headers });
  }
  if (await validPass(env, readCookie(req, PREVIEW_COOKIE))) return null;
  if (url.pathname.startsWith("/api/")) return new Response(JSON.stringify({ error: "Staging preview access required" }), { status: 401, headers: { "content-type": "application/json" } });
  return page("", url.pathname + url.search, 401);
}
