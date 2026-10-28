// Step-up MFA policy (docs/AUTH-PRODUCTION.md gap 2). MFA is completed once at sign-in, but staff sessions last up
// to 12 hours, so the actions below also need a TOTP (or recovery-code) verification within the last
// STEP_UP_MAX_AGE_MINUTES. This file is the single list of those actions; src/app/app.ts applies it to every
// matching request through requireRecentMfa() before the route runs. Without a recent verification a browser is
// sent to /mfa/step-up?next=<page> and returned afterwards; a JSON route answers 401. Users without MFA enrolled
// (customers who did not opt in) are not affected; staff always have MFA.

export const STEP_UP_MAX_AGE_MINUTES = 10;

/** "METHOD /pattern" → the sensitive action it performs. */
export const STEP_UP_ROUTES: Readonly<Record<string, string>> = {
  // Release approval (Founder-protected)
  "POST /staff/readiness/approve": "release approval",
  // Role and membership changes
  "POST /staff/employees/invite": "staff invitation",
  "POST /staff/employees/:id/role": "role change",
  "POST /staff/employees/:id/disable": "staff account disable",
  "POST /staff/employees/:id/enable": "staff account enable",
  "POST /staff/employees/:id/mfa-reset": "two-factor reset",
  // Refund and payout decisions (Founder-protected)
  "POST /staff/refunds/:id/decide": "refund decision",
  "POST /staff/refunds/:id/issue": "refund payout",
  // Integration / secret-bearing settings
  "POST /staff/integrations/:name/verify": "integration credential probe",
  "POST /staff/ops/environments": "environment endpoints",
  "POST /staff/builds/settings": "automation limits and model",
  "POST /staff/ai/budget": "paid AI budget",
  // MFA changes (replacing an enrolled authenticator; first enrolment is unaffected because no MFA exists yet)
  "GET /mfa/setup": "authenticator change",
  "POST /mfa/setup": "authenticator change",
  // Data exports that are not file-named (the rest are matched by isDataExport)
  "POST /account/privacy/export": "personal data export",
};

/** Bulk data exports: CSV/JSON/Markdown downloads, finance report files, and ?format=csv views of staff pages. */
export function isDataExport(method: string, pattern: string, url: URL): boolean {
  if (method !== "GET") return false;
  if (!pattern.startsWith("/staff/") && !pattern.startsWith("/api/")) return false;
  if (/\.(csv|json|md)$/.test(pattern) || pattern === "/staff/reports/:file") return true;
  return url.searchParams.get("format") === "csv";
}

/** The sensitive action a request performs, or null when step-up does not apply. */
export function stepUpAction(method: string, pattern: string, url: URL): string | null {
  return STEP_UP_ROUTES[`${method} ${pattern}`] ?? (isDataExport(method, pattern, url) ? "data export" : null);
}

/**
 * Where to return after the step-up: the page itself for a GET; for a form POST, the same-origin page that held
 * the form (Referer) or `fallback`. Only same-origin relative paths are ever returned.
 */
export function stepUpReturnPath(req: Request, url: URL, fallback: string): string {
  if (req.method === "GET" || req.method === "HEAD") return url.pathname + url.search;
  const ref = req.headers.get("referer");
  if (ref) {
    try {
      const r = new URL(ref);
      if (r.origin === url.origin && !r.pathname.startsWith("/mfa")) return r.pathname + r.search;
    } catch { /* ignore malformed referer */ }
  }
  return fallback;
}

/** A same-origin path to redirect to after sign-in / MFA, or `fallback`. Rejects absolute, protocol-relative and backslash forms. */
export function safeNextPath(n: string | null | undefined, fallback: string): string {
  if (!n || n.length > 2000 || !n.startsWith("/") || n.startsWith("//") || n.startsWith("/\\") || /[\u0000-\u001f\\]/.test(n)) return fallback;
  try {
    const u = new URL(n, "http://same.origin.invalid");
    if (u.origin !== "http://same.origin.invalid") return fallback;
    return u.pathname + u.search + u.hash;
  } catch { return fallback; }
}
