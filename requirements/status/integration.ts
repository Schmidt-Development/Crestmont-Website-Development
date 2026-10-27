import type { ImplementationRecord } from "../status.ts";

// Integrator-verified updates after cross-area integration (loaded last, so these supersede area records).
// Each entry cites the code and the test that proves it; anything still missing is stated.
export const INTEGRATION: Record<string, ImplementationRecord> = {
  "OWN-001": { status: "implemented", location: "src/routes/nav.ts (32 §34 modules, grouped) + tests/navigation.test.ts", owner: "engineering" },
  "PORTAL-009": { status: "implemented", location: "/portal/support* (src/routes/support.ts) + tests/support.test.ts, tests/navigation.test.ts, e2e SUP-001", owner: "engineering" },
  "WEB-006": { status: "implemented", location: "/register, /login (src/routes/auth.ts), /checkout/:packageId (src/routes/crm.ts); payment itself tracked under PAY-001", owner: "engineering" },
  "TEST-003": { status: "in_progress", location: "tests/e2e/core.e2e.ts, tests/e2e/journeys.e2e.ts (375px sweep over 41 pages, labels, h1, alt, ids)", owner: "engineering", missing: "automated WCAG rule engine (axe-level) and tablet breakpoint sweep; runs locally only, not against staging" },
  "PAY-003": { status: "in_progress", location: "src/services/payments.ts#processStripeEvent + retryFailedStripeEvents (cron */15, src/app/scheduled.ts)", owner: "engineering", missing: "not yet running in a deployed Worker (BLK-003); never fed by real Stripe events (BLK-004)" },
  "PAY-009": { status: "in_progress", location: "src/app/scheduled.ts stripe_reconcile job (retries stored events)", owner: "engineering", missing: "Stripe-side reconciliation (compare charges/payouts via the Stripe API) needs a Stripe account (BLK-004)" },
  "PAY-008": { status: "in_progress", location: "src/services/payments.ts dispute handling + Owner/support notification + /staff/disputes", owner: "engineering", missing: "verified Stripe test-mode dispute events (BLK-004)" },
  "PM-003": { status: "in_progress", location: "src/services/projects.ts change orders + webhook marks change order paid (src/services/payments.ts)", owner: "engineering", missing: "verified Stripe test-mode payment (BLK-004)" },
  "PM-005": { status: "in_progress", location: "src/services/projects.ts#runInactivitySweep + daily cron (src/app/scheduled.ts) + tests/scheduled.test.ts", owner: "engineering", missing: "not yet running in a deployed Worker (BLK-003); customer-facing inactivity policy text not published" },
  "SUP-003": { status: "in_progress", location: "src/services/support.ts#runSupportEscalationSweep + cron */15 (src/app/scheduled.ts)", owner: "engineering", missing: "not yet running in a deployed Worker (BLK-003); email delivery unverified (BLK-005)" },
  "READY-012": { status: "in_progress", location: "ingestion_status job:* health + /api/readiness/health 503 + tests/scheduled.test.ts", owner: "engineering", missing: "external alerting on 503 (BLK-003)" },
  "INFRA-006": { status: "in_progress", location: "recordAppError wired in src/app/app.ts; /staff/monitoring, /staff/backups", owner: "engineering", missing: "external alerting, automated D1/R2 backups and a staging restore drill (BLK-003)" },
  "INFRA-004": { status: "in_progress", location: ".github/workflows/ci.yml; org Actions verified running on sibling repo (better-lansing-mechanics runs 40444896179, 40443970413, 40443286479 green under Schmidt-Development)", owner: "engineering", missing: "a verified green Crestmont run with job logs (this session cannot read Crestmont Actions results; BLK-013)" },
};
