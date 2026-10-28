import type { ImplementationRecord } from "../status.ts";

// Records for this product area (support, owner executive overview, launch readiness UI — area D).
// See requirements/status.ts for the rules. "implemented" only where UI + server + persistence +
// authz + validation + empty states + audit/notifications + tests all exist.
export const SUPPORT_OWNER: Record<string, ImplementationRecord> = {
  // ── Support (§32–§33) ──
  "SUP-001": { status: "implemented", location: "src/routes/support.ts /portal/support* + src/services/support.ts#createTicket/customerReply/reopenTicket (tests/support.test.ts)", owner: "engineering" },
  "SUP-002": { status: "implemented", location: "src/routes/support.ts /staff/support* + src/services/support.ts (TICKET_TRANSITIONS, assignTicket, escalateTicket, addInternalNote, listQueue)", owner: "engineering" },
  "SUP-003": { status: "in_progress", location: "src/services/support.ts#runSupportEscalationSweep/responseTiming/staffReply + POST /staff/support/sweep", owner: "engineering",
    missing: "sweep is manual (POST /staff/support/sweep) until a Worker cron trigger calls runSupportEscalationSweep; email delivery unverified until Resend exists (BLK-005)" },
  "SUP-004": { status: "in_progress", location: "src/services/support.ts#draftReply/staffReply (approval on ticket_messages.approved_by + ai_jobs via decideAiJob)", owner: "engineering",
    missing: "drafting verified only against a stubbed provider and the local-runner fixture (tests/ai-local-runner.test.ts); no real model output yet — needs the self-hosted runner provisioned (no API key required)" },
  "SUP-005": { status: "in_progress", location: "support_settings + /staff/support/settings + src/services/support.ts#hoursDisclosure (rejects 24/7 human-coverage wording)", owner: "founder",
    missing: "Founder has not set the actual staffed hours and first-response target; public support policy page must show them once set" },

  // ── Owner (§34–§35) ──
  "OWN-002": { status: "implemented", location: "src/routes/owner.ts /staff/owner#executiveMetrics (tests/readiness-ui.test.ts)", owner: "engineering" },

  // ── Launch Readiness Command Center (§36–§50) ──
  "READY-001": { status: "implemented", location: "src/routes/readiness.ts /staff/readiness/requirements(/:id) + /staff/readiness/runs/:id", owner: "engineering" },
  "READY-002": { status: "implemented", location: "src/readiness/engine.ts#computeRequirementStatuses + matrix columns (implementation vs dev/staging/prod verification vs state)", owner: "engineering" },
  "READY-003": { status: "implemented", location: "src/readiness/engine.ts#computeScores + /staff/readiness meters (counts, percentages, denominators; no combined score)", owner: "engineering" },
  "READY-005": { status: "in_progress", location: "src/services/github.ts#syncGithub + POST /staff/readiness/github/sync + /staff/readiness/engineering", owner: "engineering",
    missing: "GITHUB_TOKEN/GITHUB_REPO not provisioned in staging (no staging exists, BLK-003); GitHub Actions refused by billing (BLK-013); sync is on-demand only (no scheduled poll/webhook yet); code scanning needs GitHub Advanced Security" },
  "READY-006": { status: "in_progress", location: "src/routes/readiness.ts /staff/readiness/env/:env", owner: "engineering",
    missing: "staging and production environments do not exist; no deployment recorder, domain/TLS probe, error-rate or performance evidence source feeds these views yet" },
  "READY-007": { status: "implemented", location: "src/readiness/engine.ts#computeGates + /staff/readiness gate cards (status, required/current evidence, last verification, blockers, responsible, approval history)", owner: "engineering" },
  "READY-008": { status: "implemented", location: "src/services/readiness-admin.ts#recordFounderDecision/createReleaseCandidate + /staff/readiness/approve (Owner+MFA only; invalidated_at on new candidate)", owner: "engineering" },
  "READY-009": { status: "in_progress", location: "src/services/readiness-admin.ts#releaseTimeline + /staff/readiness/releases", owner: "engineering",
    missing: "deployments table is written by no deploy pipeline yet, so the timeline holds only release candidates and approvals" },
  "READY-010": { status: "implemented", location: "migrations/0008_support_readiness.sql (discovery register) + /staff/readiness/blockers* (create/edit/resolve-with-evidence/reopen, audited)", owner: "engineering" },
  "READY-011": { status: "implemented", location: "/staff/readiness/export.csv, /staff/readiness/report (print → Save as PDF), /staff/readiness/packet.json (SHA-256), /staff/readiness/snapshots", owner: "engineering" },
  "READY-012": { status: "in_progress", location: "src/services/readiness-admin.ts#feedStatuses/overallFeedHealth + GET /api/readiness/health (503 when unhealthy) + feed panel", owner: "engineering",
    missing: "scheduled reconciliation job and alerting on 503 (needs deployed Worker cron + monitoring, BLK-003)" },

};
