import type { ImplementationRecord } from "../status.ts";

// Operations / infrastructure workstream (INFRA-002, INFRA-005, TEST-004, READY-006, READY-009, SEC-006,
// DOC-002, DOC-003, LAUNCH-002, LAUNCH-003). See requirements/status.ts for the rules.
// Anything that can only be proven against a real Cloudflare staging/production environment stays
// in_progress with BLK-003 until a real run has happened: workflows and code that exist but have never
// executed are not "implemented".
export const OPS: Record<string, ImplementationRecord> = {
  "INFRA-002": { status: "in_progress", location: "wrangler.toml [env.staging]/[env.production] (separate D1, R2, crons, workers_dev); docs/DEPLOYMENT.md §2–§5 (per-environment secrets, GitHub environments)", owner: "engineering",
    missing: "no staging or production resources exist (empty database_id, no buckets, no secrets set) — BLK-003; never deployed" },
  "INFRA-005": { status: "in_progress", location: ".github/workflows/deploy-staging.yml, deploy-production.yml (manual, production environment, release-authorization gate, post-deploy checks, wrangler rollback), release.yml (v* tags → GitHub release + release candidate); scripts/post-deployment.ts, release-candidate.ts, release-authorization.ts, production-checks.ts; docs/DEPLOYMENT.md §6 branch protection; tests/ops.test.ts [INFRA-005]", owner: "engineering",
    missing: "workflows have never run (Cloudflare BLK-003, Actions billing BLK-013); branch protection and the production environment's required reviewers must be configured by the Founder in GitHub settings; rollback never exercised in staging" },
  "TEST-004": { status: "in_progress", location: "scripts/backup-export.ts, scripts/restore-verify.ts (records restore_tests); deployment rollback records linked to targets (src/services/deployments.ts); tests/ops.test.ts [TEST-004]", owner: "engineering",
    missing: "round trip and rollback linkage proven in development only; no D1 export/restore drill or Worker rollback rehearsal in staging (BLK-003)" },
  "READY-006": { status: "in_progress", location: "src/routes/readiness.ts /staff/readiness/env/:env fed by POST /api/readiness/deployments + env_probe job (src/services/deployments.ts#probeEnvironments → integration_health dns/monitoring, production_check evidence) + /staff/ops", owner: "engineering",
    missing: "staging and production do not exist, so the views have no deployment or probe data yet (BLK-003); no error-rate or performance evidence source" },
  "READY-009": { status: "in_progress", location: "POST /api/readiness/deployments (signed; src/services/deployments.ts#recordDeployment) → deployments table → releaseTimeline /staff/readiness/releases + /staff/ops; tests/ops.test.ts [READY-009]", owner: "engineering",
    missing: "no real deployment has been recorded: the deploy workflows that call the recorder cannot run until BLK-003 is resolved" },
  "SEC-006": { status: "in_progress", location: "/account/privacy + src/services/privacy.ts (export/deletion); src/services/retention.ts + daily retention job + /staff/ops/retention (Owner-set periods) + docs/RETENTION-SCHEDULE.md; tests/ops.test.ts [SEC-006]", owner: "engineering",
    missing: "retention schedule is a proposal pending Founder/attorney approval (personal-data periods are off until set); privacy policy must state the approved periods (LEGAL-004); job not yet running in a deployed Worker (BLK-003)" },
  "DOC-002": { status: "in_progress", location: "docs/RUNBOOK.md, docs/BACKUP-RECOVERY.md, docs/POSTLAUNCH-MONITORING.md, docs/DEPLOYMENT.md", owner: "engineering",
    missing: "external alerting channel not chosen (Founder decision, ASVS F-03); procedures not yet exercised in staging (BLK-003)" },
  "DOC-003": { status: "implemented", location: "docs/FOUNDER-ACCEPTANCE-CHECKLIST.md (gates A–H, §75, §79); /staff/readiness/founder-report (+ .md) and scripts/founder-report.ts generating the §77 report from buildReport(); tests/ops.test.ts [DOC-003]", owner: "engineering" },
  "LAUNCH-002": { status: "in_progress", location: "GET /api/readiness/release-authorization (read-only, signed or staff; exact commit + config + evidence set via approvalValidity); deploy-production.yml gate; recordDeployment release_check → production_incident blocker + /staff/ops indicator; tests/ops.test.ts [LAUNCH-002]", owner: "engineering",
    missing: "mechanism only — never exercised against a real production deployment (BLK-003); depends on the Founder's approval (LAUNCH-001)" },
  "LAUNCH-003": { status: "in_progress", location: "scripts/production-checks.ts (health, home, pricing, contact, login, headers, staff redirect, readiness health) posted as production_check evidence by deploy-production.yml; env_probe job; tests/ops.test.ts [LAUNCH-003]", owner: "engineering",
    missing: "no production environment (BLK-003); checks cover public pages and auth gates only — authenticated critical journeys in production need a Founder-approved test account policy" },
};
