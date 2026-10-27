// Explicit implementation records (READY-002). Passing tests never promote a requirement to
// "implemented" on their own: a requirement is implemented only when every applicable layer in
// §3 exists. Partial work is "in_progress" with a note of what is missing.

export interface ImplementationRecord {
  status: "in_progress" | "implemented";
  location: string;
  owner: string;
  missing?: string;
}

export const IMPLEMENTATION: Record<string, ImplementationRecord> = {
  // ── Implemented: pure server-side rules / schema where no UI layer applies ──
  "CAT-002": { status: "implemented", location: "src/domain/catalog.ts", owner: "engineering" },
  "CAT-004": { status: "implemented", location: "src/domain/catalog.ts#priceQuote", owner: "engineering" },
  "SALES-001": { status: "implemented", location: "src/domain/catalog.ts#priceQuote", owner: "engineering" },
  "CRM-003": { status: "implemented", location: "src/domain/crm.ts", owner: "engineering" },
  "PM-001": { status: "implemented", location: "src/domain/project.ts", owner: "engineering" },
  "DATA-001": { status: "implemented", location: "migrations/", owner: "engineering" },
  "DATA-002": { status: "implemented", location: "migrations/", owner: "engineering" },
  "SEC-005": { status: "implemented", location: "migrations/0001_core.sql (audit triggers)", owner: "engineering" },
  "PAY-002": { status: "implemented", location: "src/domain/stripe-webhook.ts#verifyStripeSignature", owner: "engineering" },
  "INFRA-001": { status: "implemented", location: "docs/adr/0001-stack.md", owner: "engineering" },
  "DOC-001": { status: "implemented", location: "docs/BUILD_LEDGER.md", owner: "engineering" },

  // ── In progress: server layer exists and is tested; other layers still missing ──
  "CAT-001": { status: "in_progress", location: "src/domain/catalog.ts#APPROVED_SERVICES", owner: "engineering", missing: "public services pages" },
  "CAT-006": { status: "in_progress", location: "src/domain/catalog.ts#MAINTENANCE_PLANS", owner: "founder", missing: "Founder approval of proposed entitlements" },
  "WEB-005": { status: "in_progress", location: "src/worker.ts POST /api/leads", owner: "engineering", missing: "quote request page UI" },
  "WEB-009": { status: "in_progress", location: "src/domain/catalog.ts#findProhibitedClaims", owner: "engineering", missing: "link checker + content scan in CI over built pages" },
  "CRM-001": { status: "in_progress", location: "src/services/leads.ts#captureLead", owner: "engineering", missing: "CRM UI, source attribution reporting" },
  "CRM-004": { status: "in_progress", location: "src/services/leads.ts#changeLeadStage", owner: "engineering", missing: "follow-up tasks, notes UI" },
  "PM-002": { status: "in_progress", location: "src/domain/project.ts#decideRevision", owner: "engineering", missing: "revision service, portal UI" },
  "PM-005": { status: "in_progress", location: "src/domain/project.ts#inactivityAction", owner: "engineering", missing: "scheduled job, notifications" },
  "PM-006": { status: "in_progress", location: "src/domain/project.ts#customerReleaseReadiness", owner: "engineering", missing: "approval UI, deployment service" },
  "PAY-003": { status: "in_progress", location: "src/domain/stripe-webhook.ts", owner: "engineering", missing: "queue consumer that applies events, reconciliation" },
  "PAY-006": { status: "in_progress", location: "src/domain/project.ts#milestoneInvoiceAllowed + uq_invoice_project_milestone", owner: "engineering", missing: "Stripe invoice creation" },
  "PAY-007": { status: "in_progress", location: "src/domain/refunds.ts", owner: "engineering", missing: "refund service, Stripe refund call, UI, notifications" },
  "EMP-002": { status: "in_progress", location: "src/domain/authz.ts", owner: "engineering", missing: "audit on every sensitive route, admin UI" },
  "AUTH-007": { status: "in_progress", location: "src/worker.ts", owner: "engineering", missing: "managed auth provider wiring (resolveActor)" },
  "AUTH-008": { status: "in_progress", location: "src/domain/authz.ts#can", owner: "engineering", missing: "tenant-scoped queries for every customer resource" },
  "AIOPS-003": { status: "in_progress", location: "src/domain/authz.ts OWNER_ONLY", owner: "engineering", missing: "AI job runner enforcing the boundary" },
  "SEC-001": { status: "in_progress", location: "src/lib/validate.ts", owner: "engineering", missing: "coverage of all future endpoints" },
  "SEC-002": { status: "in_progress", location: "parameterised SQL throughout; CSP headers in src/worker.ts", owner: "engineering", missing: "CSRF for session routes, SSRF guard, XSS review of UI" },
  "READY-001": { status: "in_progress", location: "src/readiness/*", owner: "engineering", missing: "dashboard UI" },
  "READY-002": { status: "in_progress", location: "src/readiness/engine.ts", owner: "engineering", missing: "dashboard UI" },
  "READY-003": { status: "in_progress", location: "src/readiness/engine.ts#computeScores", owner: "engineering", missing: "dashboard UI" },
  "READY-004": { status: "in_progress", location: "src/readiness/ingest.ts + .github/workflows/ci.yml", owner: "engineering", missing: "deployed endpoint receiving real CI runs" },
  "READY-007": { status: "in_progress", location: "src/readiness/engine.ts#computeGates", owner: "engineering", missing: "gate UI, approval history view" },
  "READY-008": { status: "in_progress", location: "src/readiness/engine.ts#approvalValidity", owner: "engineering", missing: "Founder approval panel + recording endpoint" },
  "READY-010": { status: "in_progress", location: "migrations/0002_readiness.sql + seeds/blockers.sql", owner: "engineering", missing: "blocker management UI" },
  "READY-011": { status: "in_progress", location: "src/readiness/report.ts#requirementsCsv", owner: "engineering", missing: "PDF export, evidence packet, snapshots job" },
  "READY-012": { status: "in_progress", location: "src/readiness/engine.ts#ingestionHealth", owner: "engineering", missing: "scheduled reconciliation, alerting" },
  "INFRA-004": { status: "in_progress", location: ".github/workflows/ci.yml", owner: "engineering", missing: "has never run — no repository yet" },
  "TEST-001": { status: "in_progress", location: "tests/ + scripts/evidence-reporter.mjs", owner: "engineering", missing: "coverage of remaining subsystems" },
};
