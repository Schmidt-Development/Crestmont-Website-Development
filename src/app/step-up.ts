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
  // Hosting suspension decisions (Founder clarifications 1–2)
  "POST /staff/billing/hosting/suspend": "hosting suspension",
  "POST /staff/billing/hosting/restore": "hosting restoration",
  // Integration / secret-bearing settings
  "POST /staff/integrations/:name/verify": "integration credential probe",
  "POST /staff/ops/environments": "environment endpoints",
  "POST /staff/builds/settings": "automation limits and model",
  // Customer production delivery (Founder decision D5): the Owner's explicit authorizations
  "POST /staff/builds/releases/:id/authorize": "customer production release",
  "POST /staff/builds/projects/:id/site-domain": "customer domain authorization",
  // AI builder V4: GPU worker enrollment keys, sensitive-action approvals, the private review gate before a customer
  // can see a website, and the final approval before delivery
  "POST /staff/builds/workers": "GPU worker enrollment",
  "POST /staff/builds/workers/:id/rotate-key": "GPU worker key rotation",
  "POST /staff/builds/approvals/:id/decide": "AI builder sensitive-action approval",
  "POST /staff/builds/:id/internal-approve": "internal approval of an AI-built website",
  "POST /staff/builds/:id/share-preview": "sharing a website preview with the customer",
  "POST /staff/builds/:id/approve": "final approval of an AI-built website",
  "POST /staff/ai/budget": "paid AI budget",
  // Test-only payment simulation (internal E2E benchmarks; refused in production)
  "POST /staff/test-payments/organizations/:id/mark": "marking a fictional test organization",
  "POST /staff/test-payments/simulate": "simulated test payment",
  // AI Sales Optimization (Founder decisions that can change the live sales agent)
  "POST /staff/sales-optimization/control": "sales optimizer controls",
  "POST /staff/sales-optimization/targets": "sales agent targets",
  "POST /staff/sales-optimization/versions/:id/decide": "sales prompt approval",
  "POST /staff/sales-optimization/deploy": "sales agent deployment",
  "POST /staff/sales-optimization/rollback": "sales agent rollback",
  "POST /staff/sales-optimization/experiments/:id/decide": "sales experiment decision",
  // Outbound AI sales calls (Founder + counsel approval and the switches that let the platform dial prospects)
  "POST /staff/sales-outbound/settings": "outbound sales calling switches",
  "POST /staff/sales-outbound/compliance": "outbound sales compliance approval",
  // MFA changes (replacing an enrolled authenticator; first enrolment is unaffected because no MFA exists yet)
  "GET /mfa/setup": "authenticator change",
  "POST /mfa/setup": "authenticator change",
  // Data exports that are not file-named (the rest are matched by isDataExport)
  "POST /account/privacy/export": "personal data export",
  // Added by the security readiness review (2026-10-28): irreversible data deletion, retention periods,
  // Founder-protected pricing and tax settings, and membership changes not covered above.
  "POST /staff/privacy/:id/process": "privacy deletion (anonymisation)",
  "POST /staff/crm/identity-erasure": "CRM identity erasure",
  "POST /staff/voice/caller-erasure": "caller data erasure",
  "POST /staff/ops/retention": "data retention periods",
  "POST /staff/pricing/:id/decide": "price change decision",
  "POST /staff/settings/tax": "tax configuration",
  "POST /staff/settings/tax/jurisdictions": "tax jurisdictions",
  "POST /staff/employees/invitations/:id/revoke": "staff invitation revoke",
  // Customer team changes (applies only to customers who enabled two-factor authentication)
  "POST /portal/team": "customer team invitation",
  "POST /portal/team/members/:userId/role": "customer role change",
  "POST /portal/team/members/:userId/remove": "customer member removal",
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
