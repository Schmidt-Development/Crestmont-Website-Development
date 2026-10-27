import type { ImplementationRecord } from "../status.ts";

// Records for this workstream (first-party backend closeout, session 3). See requirements/status.ts for the rules
// (later files override earlier ones). Several entries here only correct "missing" notes that had gone stale.
export const BACKEND: Record<string, ImplementationRecord> = {
  "LEGAL-001": { status: "in_progress", owner: "founder",
    location: "src/content/legal.ts: terms, privacy (now including the cm_attr attribution cookie and phone-call recording/AI disclosure), development agreement summary, full draft custom development agreement and maintenance agreement; versioned in migrations/0030_legal_drafts_2.sql (attorney_reviewed = 0)",
    missing: "attorney review (LEGAL-004); legal entity name (IDENT-001); warranty period, liability limits, governing law and dispute terms are deliberately left for attorney review; maintenance entitlements await Founder approval (CAT-006)" },
  "LEGAL-002": { status: "in_progress", owner: "founder",
    location: "src/content/legal.ts: support, refund, cancellation, acceptable use policies and a draft data processing addendum (/legal/data-processing), versioned in migrations/0030_legal_drafts_2.sql",
    missing: "attorney review (LEGAL-004); the DPA's subprocessor list and jurisdiction-specific clauses are added at that review" },
  "PM-005": { status: "in_progress", owner: "engineering",
    location: "src/services/projects.ts#runInactivitySweep + daily cron (src/app/scheduled.ts) + tests/scheduled.test.ts; customer-facing policy published in /legal/cancellation, /legal/development-agreement and /legal/custom-development-agreement (reminder, escalation and pause days come from DEFAULT_INACTIVITY_POLICY, never silent cancellation)",
    missing: "cron execution evidence from the deployed staging Worker has not yet been confirmed" },
  "VOICE-006": { status: "in_progress", owner: "engineering",
    location: "src/services/voice.ts call_ended handling (transcript/summary/recording dropped without consent) + privacy policy 'Phone calls' section (AI disclosure, recording only after notice/consent)",
    missing: "the consent prompt must be configured in a real provider agent (no voice provider account, BLK-009)" },
  "BRAND-006": { status: "in_progress", owner: "engineering",
    location: "public/assets/app.css (UX block) + tests/e2e/visual.e2e.ts (375/768/1440 sweep of public, portal, staff and owner pages: overflow, landmarks, accessible names incl. labelled tab bars, upscaled images, tap targets, WCAG contrast, visible focus; allow-list empty)",
    missing: "the visual sweep runs against the local development server, not the deployed staging build; portfolio pages audited only in their pending-screenshot state (BLK-007)" },
  "EMAIL-003": { status: "in_progress", owner: "engineering",
    location: "/staff/email delivery log + retry (links the suppression list); POST /api/webhooks/resend (Svix-verified, idempotent per svix-id) → email_deliveries status + email_suppressions; suppressed recipients skipped by both email adapters; /staff/email-suppressions view/remove (audited); tests/integrations.test.ts",
    missing: "No Resend account or webhook secret (BLK-005): Svix verification and event mapping are tested only with locally signed payloads, never with a real Resend delivery" },
  "READY-005": { status: "in_progress", owner: "engineering",
    location: "src/services/github.ts#syncGithub + POST /staff/readiness/github/sync + scheduled github_sync job every 15 minutes (src/app/scheduled.ts) + /staff/readiness/engineering",
    missing: "GITHUB_TOKEN/GITHUB_REPO not provisioned as staging secrets; code scanning data needs GitHub Advanced Security; no live sync evidence yet" },
  "SEC-002": { status: "implemented", owner: "engineering",
    location: "CSRF double-submit + Origin check on every non-/api form POST (src/app/http.ts assertCsrf); auto-escaping html template and CSP (src/lib/html.ts, src/app/http.ts); parameterised SQL everywhere; SSRF: central egress allowlist on the Worker's global fetch (src/lib/egress.ts, installed in src/worker.ts) with the environment probe limited to its validated host; tests/asvs-hardening.test.ts, tests/security*.test.ts" },
  "SEC-007": { status: "in_progress", owner: "engineering",
    location: "docs/security/ASVS-REVIEW.md (self-review; F-04, F-06, F-07, F-11, F-12, F-13 fixed with tests; F-01 partly resolved by the staging environment)",
    missing: "independent review / penetration test against staging (F-16); open: F-02 malware scanning (no scanner service), F-03 external alerting channel (Founder decision), F-05 PBKDF2 iteration ceiling, F-08 API CSRF exemption guarded by review, F-09 audit retention period (Founder/attorney), F-10 CI scanning evidence, F-14 TLS settings on the production zone, F-15 anti-automation on authenticated business actions" },
};
