import type { ImplementationRecord } from "../status.ts";

// Records for the staging E2E workstream. See requirements/status.ts for the rules (later files override earlier ones).
export const E2E: Record<string, ImplementationRecord> = {
  "TEST-002": {
    status: "in_progress",
    location: "tests/e2e/staging-journeys.e2e.ts (33 journeys, one test each, tagged [TEST-002] + the specific requirement) + tests/e2e/staging.e2e.ts; run by .github/workflows/deploy-staging.yml (\"Browser journey on the preview\") against the deployed preview; scripts/evidence-reporter.mjs records skips as \"skipped\", never \"passed\"",
    owner: "engineering",
    missing:
      "Staging evidence not yet observed: the suite has only been rehearsed locally (dev server on a staging-shaped database: migrations + seed-staging + staging-access). " +
      "Automated against staging (21): 1 lead via quote form, 2 lead in CRM + assignment, 3 quote + proposal, 4 registration + quote acceptance (deposit invoice, honest 'payment not configured'), " +
      "8 conditional onboarding (sample Ridgeline; one-shot — skips on later runs once submitted), 9 file upload/preview/delete (skips honestly if R2 is not enabled on staging), 10 PM assigns task, 11 developer completes task + milestone update seen by customer (restored), " +
      "12 notification (portal + email outbox), 13 design review, 14 revision request, 15 allowance counter, 16 final launch approval, 18 internal QA certification with deployment still refused, 20 handoff received, " +
      "21 ticket submitted, 22 staff reply/internal note, 23 ticket resolved, 26 refund request → support review → Founder decision, 29 signed CI evidence ingestion shown to the Owner, 30 staging verification ingestion updates readiness (LAUNCH-003, staging view). " +
      "Explicitly skipped (12): 5, 6, 7, 17, 19, 24, 25 — BLK-004 (no Stripe test-mode account: no checkout, payment, webhook, provisioning, milestone payments, deployment chain, subscriptions or failed-payment recovery); " +
      "27, 28 — BLK-009 (no AI receptionist provider / voice webhook); 31, 32, 33 — LAUNCH-001 (Founder approval must not be recorded by a demo account on shared staging; no production deployment or health to verify). " +
      "Post-payment journeys run on the seeded sample projects because new projects need a Stripe payment.",
  },
};
