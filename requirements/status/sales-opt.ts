import type { ImplementationRecord } from "../status.ts";

// AI Sales Optimization addendum (2026-10-30). Every record is in_progress: the code, persistence, authz, UI and
// tests exist, but no Retell sales agent, no real call, no self-hosted runner run and no real payment has gone
// through it. Tests use signed fixtures and a fake Retell API; they are not evidence of a live integration.
const NOT_LIVE = "never exercised against a real Retell sales agent, the self-hosted runner or live Stripe payments (no sales agent exists; BLK-009, D-14)";
export const SALES_OPT: Record<string, ImplementationRecord> = {
  "SALESOPT-001": { status: "in_progress", owner: "engineering", location: "src/services/sales-opt/ingest.ts via POST /api/webhooks/retell (after X-Retell-Signature verification); so_call_facts, so_webhook_receipts", missing: NOT_LIVE },
  "SALESOPT-002": { status: "in_progress", owner: "engineering", location: "src/services/sales-opt/attribution.ts (payments written only by the verified Stripe webhook; so_attributions unique per payment+call)", missing: `${NOT_LIVE}; no checkout-link tool exists for the agent, so the checkout_link rule is unused` },
  "SALESOPT-003": { status: "in_progress", owner: "engineering", location: "src/domain/sales-opt/analysis.ts (grounding, deterministic findings) + src/services/sales-opt/jobs.ts (runner channel, input scrubbing)", missing: `${NOT_LIVE}; analysis quality of the local model is unmeasured` },
  "SALESOPT-004": { status: "in_progress", owner: "engineering", location: "src/services/sales-opt/metrics.ts + src/domain/sales-opt/stats.ts", missing: NOT_LIVE },
  "SALESOPT-005": { status: "in_progress", owner: "security", location: "src/domain/sales-opt/policy.ts (PROTECTED_SALES_POLICY from the catalog, salesPolicyViolations) + parseProposal", missing: "policy text and baseline instructions need Founder and counsel review; deterministic checks are pattern-based and can miss paraphrases" },
  "SALESOPT-006": { status: "in_progress", owner: "engineering", location: "migrations/0047_sales_optimization.sql so_versions (immutability triggers) + src/services/sales-opt/registry.ts", missing: "Founder review of the workflow on staging" },
  "SALESOPT-007": { status: "in_progress", owner: "engineering", location: "src/domain/sales-opt/evaluation.ts (19 scenarios, deterministic assertions) + jobs.ts startEvaluation/consumeEvaluations", missing: "no simulation has run on the self-hosted model yet" },
  "SALESOPT-008": { status: "in_progress", owner: "security", location: "src/services/sales-opt/deploy.ts (get-agent, get-retell-llm, update-retell-llm; lock, CAS, drift, read-back, restore, rollback)", missing: `${NOT_LIVE}; publishing a Retell version and pinning the phone number stay manual dashboard steps` },
  "SALESOPT-009": { status: "in_progress", owner: "engineering", location: "src/services/sales-opt/monitor.ts experiments + stats.ts decideExperiment/assignArm", missing: "no dialler uses experimentRouting (nothing in the platform places sales calls)" },
  "SALESOPT-010": { status: "in_progress", owner: "engineering", location: "/staff/sales-optimization (+ /versions/:id), src/routes/sales-optimization.ts", missing: "Founder walkthrough on staging" },
  "SALESOPT-011": { status: "in_progress", owner: "security", location: "scheduled job sales_opt (src/app/scheduled.ts), monitorDeployments auto-rollback, purgeOrphanedEvidence, salesopt.read/decide Owner-only + step-up", missing: NOT_LIVE },
  "SALESOPT-012": { status: "in_progress", owner: "integration", location: "docs/voice/SALES-OPTIMIZATION.md §Staging activation", missing: "not demonstrated: needs a Retell staging sales agent, RETELL_API_KEY on staging, the runner with AI drafts enabled, and Stripe test payments" },
};
