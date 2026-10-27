// Re-audit 2026-10-27 (docs/REQUIREMENTS-REAUDIT-2026-10-27.md): staging now exists, so "BLK-003: staging does not exist"
// is no longer the reason these are open. Only the `missing` text changes here — every status stays as recorded.
export const REAUDIT_MISSING: Record<string, string> = {
  "INFRA-002": "staging exists and deploys on push (D1 + secrets installed by the deploy workflow); production resources are not created (requires LAUNCH-001) and R2 is not enabled on the account",
  "READY-004": "staging receives signed CI evidence (public /api/readiness/health shows the ci feed healthy); mark implemented after the Owner readiness view's ingestion record for a real CI run is confirmed",
  "READY-006": "staging deploys are recorded, but no error-rate or performance evidence source feeds the environment views; production does not exist",
  "READY-009": "staging deploys are recorded by the workflow; the timeline has no production deployment (LAUNCH-001) and no rollback rehearsal record until staging-rollback-rehearsal runs",
  "PAY-003": "event processing and the */15 retry cron are deployed on staging but have never been fed by real Stripe events (BLK-004)",
  "SUP-003": "the escalation sweep runs on the staging cron; confirm a scheduled_job_runs record, and email delivery is unverified until Resend exists (BLK-005)",
  "PM-005": "the daily inactivity cron is deployed on staging — a recorded scheduled_job_runs execution is still to be confirmed; customer-facing inactivity policy text not published",
};
