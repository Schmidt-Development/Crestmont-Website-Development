import type { ImplementationRecord } from "../status.ts";

// Shared core built in session 2 (request pipeline, auth, design system, commerce plumbing).
export const CORE: Record<string, ImplementationRecord> = {
  "BRAND-001": { status: "implemented", location: "public/assets/brand/ (original byte-identical; crest = lossless crop at 2x density)", owner: "engineering" },
  "BRAND-002": { status: "implemented", location: "public/assets/app.css :root tokens", owner: "engineering" },
  "BRAND-003": { status: "in_progress", location: "src/ui/components.ts + app.css", owner: "engineering", missing: "drawer usage in dashboards" },
  "BRAND-004": { status: "in_progress", location: "src/ui/components.ts", owner: "engineering", missing: "rich-text editing, date range control" },
  "BRAND-005": { status: "in_progress", location: "src/ui/components.ts", owner: "engineering", missing: "skeleton usage on slow views" },
  "AUTH-001": { status: "implemented", location: "src/services/auth.ts + src/routes/auth.ts", owner: "engineering" },
  "AUTH-002": { status: "implemented", location: "src/services/auth.ts#requestPasswordReset/resetPassword", owner: "engineering" },
  "AUTH-003": { status: "implemented", location: "src/lib/auth-crypto.ts (RFC 6238) + /mfa routes; staff enforced in requireStaff", owner: "engineering" },
  "AUTH-004": { status: "implemented", location: "sessions table + /account session management", owner: "engineering" },
  "AUTH-005": { status: "implemented", location: "src/services/security.ts + login lockout", owner: "engineering" },
  "AUTH-006": { status: "implemented", location: "src/services/auth.ts#createInvitation/acceptInvitation + /invite", owner: "engineering" },
  "AUTH-007": { status: "in_progress", location: "src/app/app.ts guards (requireStaff/requireCustomerOrg)", owner: "engineering", missing: "applied to every product-area route as they are built" },
  "SEC-002": { status: "in_progress", location: "src/app/http.ts (CSRF, CSP), src/lib/html.ts (escaping), parameterised SQL", owner: "engineering", missing: "SSRF review once outbound integrations are configured" },
  "PAY-003": { status: "in_progress", location: "src/services/payments.ts#processStripeEvent", owner: "engineering", missing: "scheduled reconciliation trigger (cron) in deployed worker" },
  "EMAIL-003": { status: "in_progress", location: "src/adapters/email.ts (delivery log, retries)", owner: "engineering", missing: "Resend delivery webhooks; unverified until Resend account exists" },
  "INFRA-003": { status: "implemented", location: "github.com/noahschmidt10/Crestmont-Website-Development (private)", owner: "founder" },
  "INFRA-004": { status: "in_progress", location: ".github/workflows/ci.yml", owner: "engineering", missing: "jobs refused by GitHub billing (BLK-013)" },
};
