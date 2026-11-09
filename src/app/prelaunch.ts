// Pre-launch restriction for production (Founder's F6 authorization, 2026-11-09): production may be deployed and
// smoke-tested, but customer access stays closed until the Founder separately authorizes the public launch.
//
// While closed, the public website is visible and the Owner and staff sign in and work normally, but nothing lets a
// member of the public become a customer or contact Crestmont through production: self-registration, the quote and
// contact forms, the public lead API, the website assistant and package checkout answer "not open yet" (HTTP 503).
// Payments are separately closed by PAYMENTS_LIVE_AUTHORIZED (src/domain/payments-mode.ts); this gate does not change
// that. Staff-sent proposal links (/q/:token) stay usable: a person decided to send them.
//
// Opening is one committed line, part of the public-launch authorization: PUBLIC_LAUNCH = "open" in
// wrangler.toml [env.production] vars. Staging and development are never restricted.
import type { Env } from "./context.ts";
import { securityHeaders } from "./http.ts";

export const PUBLIC_LAUNCH_OPEN = "open";

export function customerAccessOpen(env: Pick<Env, "ENVIRONMENT" | "PUBLIC_LAUNCH">): boolean {
  return env.ENVIRONMENT !== "production" || env.PUBLIC_LAUNCH === PUBLIC_LAUNCH_OPEN;
}

/** Public entry points that turn a visitor into a customer or a lead. */
export function isCustomerEntry(method: string, path: string): boolean {
  if (path === "/register" || path.startsWith("/checkout/") || path === "/checkout") return true;
  if (method !== "POST") return false;
  return path === "/quote" || path === "/contact" || path === "/api/leads" || path === "/api/assistant";
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Opening soon · Crestmont Website Development</title><link rel="stylesheet" href="/assets/app.css"></head>
<body><main id="main" class="section"><div class="container stack" style="max-width:640px">
<p class="eyebrow">Crestmont Website Development</p><h1>We are opening soon</h1>
<p>New accounts, enquiries and orders are not open yet. Please check back shortly.</p>
<p><a class="btn btn--secondary" href="/">Back to the website</a></p></div></main></body></html>`;

/** null when the request may proceed; otherwise the "not open yet" response. */
export function prelaunchGate(req: Request, env: Pick<Env, "ENVIRONMENT" | "PUBLIC_LAUNCH">): Response | null {
  if (customerAccessOpen(env)) return null;
  const url = new URL(req.url);
  if (!isCustomerEntry(req.method, url.pathname)) return null;
  const api = url.pathname.startsWith("/api/");
  const headers = { ...securityHeaders(api ? "api" : "page"), "content-type": api ? "application/json; charset=utf-8" : "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "86400" };
  return new Response(api ? JSON.stringify({ error: "not_open_yet", message: "Crestmont is not accepting new enquiries or accounts yet." }) : PAGE, { status: 503, headers });
}
