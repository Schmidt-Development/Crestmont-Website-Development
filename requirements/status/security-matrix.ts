import type { ImplementationRecord } from "../status.ts";

// Records for this workstream. See requirements/status.ts for the rules (later files override earlier ones).
// Route security matrix: every route registered in src/routes/*.ts is enumerated from the router itself
// (src/routes/index.ts#listRoutes) and must be classified in tests/support/route-inventory.ts, so a new
// route without an access class (and, when it changes state or exports data, an audit class) fails CI.
export const SECURITY_MATRIX: Record<string, ImplementationRecord> = {
  "AUTH-007": { status: "implemented", owner: "engineering",
    location: "requireStaff/requireCustomerOrg/requireUser guards (src/app/app.ts) + record-level checks in src/services/*; "
      + "tests/security-matrix.test.ts proves on EVERY route: anonymous denial, password-only (pre-MFA) denial, customer→staff and staff→portal denial, "
      + "customer-member denial of admin-only actions, sales/developer record scoping, and no shadowed routes (inventory: tests/support/route-inventory.ts)" },
  "AUTH-008": { status: "implemented", owner: "engineering",
    location: "org-scoped queries (requireCustomerOrg → getOrgProject/getOrgFile/getTicketForOrg/...); tests/security-tenancy.test.ts: two populated tenants, "
      + "customer A replays every id-addressed customer route (GET+POST) with every one of B's record ids, list/export pages with ?org=<B>, form-field id smuggling "
      + "(customer and staff forms), assigned-only staff scoping, and a database-wide cross-tenant link invariant" },
  "EMP-002": { status: "implemented", owner: "engineering",
    location: "src/domain/authz.ts + per-route permission guards; tests/security-matrix.test.ts role matrix (every staff role × every staff route); "
      + "exhaustive route-by-route audit inventory in tests/support/route-inventory.ts proven by tests/security-audit.test.ts (each audited route performed for real "
      + "and its audit_logs action + actor asserted; exemptions carry a reason; staff email views redact single-use secrets)" },
  "SEC-001": { status: "implemented", owner: "engineering",
    location: "src/lib/validate.ts, src/lib/html.ts auto-escaping, csvCell formula guards, signed-webhook envelope checks; tests/security-fuzz.test.ts fuzzes every POST "
      + "route's actual form fields (discovered at runtime), every GET route's query parameters and every signed JSON endpoint (valid signatures), then sweeps "
      + "every page, every rendered email, every CSV export and the invoice/receipt PDFs for unescaped payloads" },
};
