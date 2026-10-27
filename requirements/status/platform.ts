import type { ImplementationRecord } from "../status.ts";

// Platform administration, AI operations and AI receptionist (area E). Honest records: a
// requirement is "implemented" only when UI, server, persistence, authz, validation, errors, empty
// states, audit and tests all exist AND nothing it needs is still external/blocked.
export const PLATFORM: Record<string, ImplementationRecord> = {
  // ── Employees ──
  "EMP-001": { status: "implemented", location: "src/routes/platform.ts /staff/employees + src/services/employees.ts", owner: "engineering" },
  "EMP-002": { status: "in_progress", location: "src/domain/authz.ts + src/services/employees.ts + requireStaff on every platform route", owner: "engineering",
    missing: "audit coverage of sensitive actions in other areas is reviewed per area; no cross-area audit-coverage test yet" },
  "AUTH-006": { status: "implemented", location: "src/services/auth.ts#createInvitation + /staff/employees/invite (staff_invitation email)", owner: "engineering" },

  // ── Owner settings ──
  "OWN-003": { status: "implemented", location: "src/routes/platform.ts /staff/settings (business_settings + support_settings, audited; pricing excluded)", owner: "engineering" },

  // ── Email ──
  "EMAIL-002": { status: "in_progress", location: "src/services/mailer.ts EMAIL_TEMPLATES + /staff/email/templates preview catalogue", owner: "engineering",
    missing: "templates use generic layout with per-workflow copy written at call sites; no Founder-approved copy review; not delivered through Resend yet (BLK-005)" },
  "EMAIL-003": { status: "in_progress", location: "/staff/email delivery log, filters, retry (Resend only), integration health for domain authentication", owner: "engineering",
    missing: "Resend delivery/bounce webhooks and suppression list; real sending domain verification (BLK-005)" },

  // ── AI operations ──
  "AIOPS-001": { status: "implemented", location: "/staff/ai (+ /staff/ai/:id) — provider, model, status, cost (Unknown when NULL), retries, errors, approval; src/services/monitoring.ts#retryAiJob", owner: "engineering" },
  "AIOPS-002": { status: "in_progress", location: "src/services/ai.ts workflows; approval/retry in /staff/ai", owner: "engineering",
    missing: "no AI provider key configured, so no workflow has produced a real draft; per-workflow entry points live in other areas" },
  "AIOPS-003": { status: "in_progress", location: "src/domain/authz.ts OWNER_ONLY for non-user actors; AI output is draft-only (decideAiJob); voice agent has no refund/contract/pricing functions", owner: "engineering",
    missing: "verification in staging" },

  // ── AI receptionist ──
  "VOICE-001": { status: "in_progress", location: "docs/voice/PROVIDER-EVALUATION.md", owner: "founder",
    missing: "Founder decision on the recommendation (Retell AI, separate Crestmont workspace) and budget — BLK-009" },
  "VOICE-002": { status: "in_progress", location: "/staff/voice shows 'None purchased'; integration_health telephony = not_configured", owner: "founder",
    missing: "no provider account, workspace or number exists; purchase requires Founder approval (BLK-009)" },
  "VOICE-003": { status: "in_progress", location: "POST /api/webhooks/voice + src/services/voice.ts (signed, idempotent; leads source ai_receptionist, callback tasks, tickets for verified matches)", owner: "engineering",
    missing: "provider-specific adapter (e.g. Retell X-Retell-Signature mapping) after VOICE-001 decision; never exercised by a real provider" },
  "VOICE-004": { status: "in_progress", location: "src/services/voice.ts VOICE_GUARDRAILS, publishedPricing, configProblems; versioned voice_agent_configs", owner: "engineering",
    missing: "guardrails not yet loaded into a real provider agent or tested with live calls" },
  "VOICE-005": { status: "in_progress", location: "/staff/voice (provider/number/agent status, volume, history, conversion, escalations, errors, costs, config versions + diff, test calls)", owner: "engineering",
    missing: "§53 requires real provider data; only signed test events exist until a provider is connected" },
  "VOICE-006": { status: "in_progress", location: "src/services/voice.ts call_ended handling (transcript/summary/recording dropped without consent)", owner: "engineering",
    missing: "consent prompt must be configured in the provider agent; recording disclosure in privacy policy (LEGAL-001)" },

  // ── Infrastructure ──
  "INFRA-006": { status: "in_progress", location: "/staff/monitoring, /staff/backups, src/services/monitoring.ts#recordAppError, docs/BACKUP-RECOVERY.md", owner: "engineering",
    missing: "no external monitoring/alerting; no automated D1/R2 backups; no restore drill in staging/production (BLK-003); app.ts 500 handler must call recordAppError" },

  // ── Security ──
  "SEC-001": { status: "in_progress", location: "src/lib/validate.ts, src/lib/html.ts escaping, csvCell formula guard, platform form validation", owner: "engineering",
    missing: "coverage of every area's endpoints confirmed by independent review" },
  "SEC-004": { status: "in_progress", location: "/staff/security secrets presence (names only) + zero runtime dependencies; RUNBOOK §4 rotation", owner: "engineering",
    missing: "secrets not provisioned per environment (BLK-003); CI dependency/code scanning has never run (BLK-013)" },
  "SEC-006": { status: "in_progress", location: "/account/privacy (export + deletion request) + /staff/security#privacy processing; src/services/privacy.ts", owner: "engineering",
    missing: "written retention schedule (sessions, security events, email bodies, app errors); attorney-reviewed privacy policy (LEGAL-004)" },
  "SEC-007": { status: "in_progress", location: "docs/security/ASVS-REVIEW.md", owner: "engineering",
    missing: "self-review only; findings F-01..F-17 open; independent review / penetration test against staging required" },

  // ── Docs ──
  "DOC-002": { status: "in_progress", location: "docs/RUNBOOK.md + docs/BACKUP-RECOVERY.md", owner: "engineering",
    missing: "postlaunch monitoring plan depends on alerting choice; procedures not yet exercised in staging" },
};
