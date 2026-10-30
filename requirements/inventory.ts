// Crestmont requirements inventory — the approved denominator for readiness scoring.
// Source: "Crestmont Ultimate Master Engineering & Business Platform Build Directive" (Oct 2026).
// Every requirement keeps its directive section reference. Do NOT delete entries to
// improve percentages; disposition them through Founder-approved scope control instead.

export type Priority = "P0" | "P1" | "P2";
export type Category = "engineering" | "integration" | "security" | "business" | "founder";

export interface RequirementDef {
  id: string;
  subsystem: string;
  section: string;
  title: string;
  priority: Priority;
  category: Category;
  dependsOn?: string[];
}

type Row = [id: string, title: string, priority?: Priority, category?: Category, dependsOn?: string[]];

function group(subsystem: string, section: string, rows: Row[]): RequirementDef[] {
  return rows.map(([id, title, priority = "P0", category = "engineering", dependsOn]) => ({
    id, subsystem, section, title, priority, category, ...(dependsOn ? { dependsOn } : {}),
  }));
}

export const REQUIREMENTS: RequirementDef[] = [
  ...group("Brand", "§4,§9,§10", [
    ["BRAND-001", "Use the Founder-supplied gold shield logo as the canonical asset (no regeneration)", "P0", "business"],
    ["BRAND-002", "Design tokens: color, typography, spacing, breakpoints"],
    ["BRAND-003", "Component library: buttons, inputs, selects, tables, cards, dialogs, drawers, toasts"],
    ["BRAND-004", "Component library: status indicators, file upload, rich text, search/filter, pagination, date controls"],
    ["BRAND-005", "Accessible form validation, skeleton loaders, empty and error states"],
    ["BRAND-006", "Shared design language across public, customer, employee and owner surfaces", "P1"],
  ]),
  ...group("Identity", "§4", [
    ["IDENT-001", "Legal entity established and recorded", "P0", "business"],
    ["IDENT-002", "Registered business mailing address (no residential exposure)", "P0", "business"],
    ["IDENT-003", "Mailboxes/routing for support@, sales@, billing@, legal@", "P0", "integration"],
    ["IDENT-004", "Official domain crestmontwebsitedevelopment.com under Crestmont control with DNS", "P0", "integration"],
    ["IDENT-005", "Required business disclosures page", "P0", "business"],
  ]),
  ...group("Catalog", "§5–§7", [
    ["CAT-001", "Server-side catalog of approved services only (no ads/social/guarantees)"],
    ["CAT-002", "Starter $999 / Business $2,499 / Premium $4,999+ package entitlements enforced server-side"],
    ["CAT-003", "Custom development quoted separately"],
    ["CAT-004", "Payment rules: standard 100% upfront; custom 50/25/25"],
    ["CAT-005", "Maintenance plans $99/$199/$299 with defined entitlements"],
    ["CAT-006", "Maintenance entitlements approved by Founder before publishing", "P0", "founder"],
    ["CAT-007", "No unauthorized price changes; pricing changes require Founder approval"],
  ]),
  ...group("Public Website", "§11–§12", [
    ["WEB-001", "Homepage with all required sections and functioning CTAs"],
    ["WEB-002", "Services overview and individual service pages"],
    ["WEB-003", "Pricing and package comparison pages"],
    ["WEB-004", "About, development process, FAQs, contact"],
    ["WEB-005", "Custom quote request page wired to CRM", "P0", "engineering", ["CRM-001"]],
    ["WEB-006", "Registration, login and checkout pages", "P0", "engineering", ["AUTH-001"]],
    ["WEB-007", "Hosting/maintenance, technical SEO, redesign, custom development pages"],
    ["WEB-008", "Policy pages: privacy, terms, development agreement info, refund, cancellation, support, accessibility"],
    ["WEB-009", "No dead links, fake scarcity, fabricated counts/awards/ratings (automated link + content check)"],
    ["WEB-010", "SEO metadata, sitemap, robots", "P1"],
  ]),
  ...group("Portfolio", "§13–§16", [
    ["PORT-001", "Better Lansing Mechanics: genuine desktop + mobile screenshots via browser automation"],
    ["PORT-002", "Lansing Car Rentals: genuine desktop + mobile screenshots via browser automation"],
    ["PORT-003", "LCR Mentorship: genuine desktop + mobile screenshots via browser automation"],
    ["PORT-004", "Verified, accurate project descriptions (no unverified claims)"],
    ["PORT-005", "Documented Crestmont relationship to each portfolio business", "P0", "business"],
    ["PORT-006", "Case study pages, full-screen viewer, Visit Live Website links verified"],
    ["PORT-007", "Portfolio CMS: add/edit/reorder/publish/replace screenshots", "P0", "engineering", ["CMS-001"]],
  ]),
  ...group("Authentication", "§17–§18", [
    ["AUTH-001", "Registration, login, email verification"],
    ["AUTH-002", "Secure account recovery"],
    ["AUTH-003", "MFA required for staff, optional for customers"],
    ["AUTH-004", "Session management and revocation"],
    ["AUTH-005", "Rate limiting and suspicious activity logging", "P0", "security"],
    ["AUTH-006", "Secure staff invitations"],
    ["AUTH-007", "Server-side authorization on every endpoint", "P0", "security"],
    ["AUTH-008", "Tenant isolation with automated cross-customer denial tests", "P0", "security"],
  ]),
  ...group("Customer Portal", "§19", [
    ["PORTAL-001", "Dashboard overview from real records"],
    ["PORTAL-002", "Conditional guided onboarding"],
    ["PORTAL-003", "Project tracking: milestones, tasks, approvals, blockers, history"],
    ["PORTAL-004", "Files: upload, download, preview, replace, organize, restricted sharing", "P0", "engineering", ["FILE-001"]],
    ["PORTAL-005", "Messaging with attachments, read status, notifications"],
    ["PORTAL-006", "Revisions with allowance counting and change-order pricing", "P0", "engineering", ["PM-002"]],
    ["PORTAL-007", "Approvals: design, scope, revision, launch, final acceptance"],
    ["PORTAL-008", "Billing: orders, invoices, receipts, subscriptions, refund requests", "P0", "engineering", ["PAY-001"]],
    ["PORTAL-009", "Support tickets from portal", "P0", "engineering", ["SUP-001"]],
    ["PORTAL-010", "Handoff: URL, docs, access, ownership, training, final acceptance"],
  ]),
  ...group("CRM", "§20", [
    ["CRM-001", "Lead capture with source tracking from public forms"],
    ["CRM-002", "Contact and company records"],
    ["CRM-003", "Validated pipeline state machine incl. Lost/Rejected/Archived/Reopened"],
    ["CRM-004", "Follow-up tasks, notes, activity history"],
    ["CRM-005", "Lead ownership, search, filter, export"],
    ["CRM-006", "Conversion and attribution reporting", "P1"],
    ["CRM-007", "Integration with receptionist, quotes, Stripe, projects, support", "P0", "engineering", ["VOICE-003", "SALES-002", "PAY-001"]],
  ]),
  ...group("Sales", "§21", [
    ["SALES-001", "Server-side pricing calculation for packages and add-ons"],
    ["SALES-002", "Custom quote builder with versioning"],
    ["SALES-003", "Proposal generation and delivery"],
    ["SALES-004", "Customer quote acceptance → checkout → order → project provisioning", "P0", "engineering", ["PAY-001", "PM-001"]],
  ]),
  ...group("Payments", "§22–§24", [
    ["PAY-001", "Stripe test-mode checkout on dedicated Crestmont account", "P0", "integration"],
    ["PAY-002", "Webhook signature verification", "P0", "security"],
    ["PAY-003", "Webhook idempotency, duplicate & out-of-order handling, event store, dead-letter"],
    ["PAY-004", "Subscriptions and customer billing portal", "P0", "integration"],
    ["PAY-005", "Invoices and receipts"],
    ["PAY-006", "Custom milestone invoices 50/25/25 tied to project states, no duplicate billing"],
    ["PAY-007", "Refund workflow: request → support review → Founder approval → Stripe refund; AI excluded"],
    ["PAY-008", "Disputes handling"],
    ["PAY-009", "Reconciliation job"],
    ["PAY-010", "Live payments activated only after legal identity finalized", "P0", "business", ["IDENT-001"]],
  ]),
  ...group("Project Management", "§25–§28", [
    ["PM-001", "Validated project lifecycle state machine"],
    ["PM-002", "Revision allowance enforcement: Starter 2 / Business 3 / Premium 4"],
    ["PM-003", "Change orders: scope, price, approval, payment, task"],
    ["PM-004", "Milestones, tasks, dependencies, assignments, estimates, time tracking"],
    ["PM-005", "Inactivity reminders, escalation, pause and restart (never silent cancel)"],
    ["PM-006", "Customer release approval chain (7 checks) separate from platform launch"],
    ["PM-007", "Project costs and deployment/completion records"],
  ]),
  ...group("Employees", "§29–§31", [
    ["EMP-001", "Roles: Owner, Administrator, Sales, Developer, Project Manager, Support"],
    ["EMP-002", "Granular server-side permissions with audit on sensitive actions", "P0", "security"],
    ["EMP-003", "Employee dashboard: assigned work, queue, notifications, activity"],
  ]),
  ...group("Support", "§32–§33", [
    ["SUP-001", "Customer ticket submission with category and attachments"],
    ["SUP-002", "Staff queue: assignment, priority, internal notes, escalation, resolve, reopen"],
    ["SUP-003", "Notifications and response-time tracking"],
    ["SUP-004", "AI draft replies with human approval for sensitive replies"],
    ["SUP-005", "Published staffed hours; no false 24/7 human claims", "P0", "business"],
  ]),
  ...group("Owner Dashboard", "§34–§35", [
    ["OWN-001", "Owner navigation with all 32 modules, grouped and functional"],
    ["OWN-002", "Executive overview from real data"],
    ["OWN-003", "Business settings administration"],
  ]),
  ...group("Launch Readiness", "§36–§50", [
    ["READY-001", "Requirements traceability matrix generated from stored records"],
    ["READY-002", "Separate implementation and verification states"],
    ["READY-003", "Transparent scoring with fixed denominator and per-dimension metrics"],
    ["READY-004", "CI evidence ingestion (signed, idempotent)"],
    ["READY-005", "GitHub data source: branches, commits, PRs, CI, scans, tags", "P0", "integration"],
    ["READY-006", "Development / staging / production environment views"],
    ["READY-007", "Launch gates A–H with evidence, blockers, approval history"],
    ["READY-008", "Founder approval bound to release candidate commit + evidence set; invalidated by change"],
    ["READY-009", "Release history timeline"],
    ["READY-010", "Blocker register with categories"],
    ["READY-011", "Exports: PDF, CSV, release evidence packet; historical snapshots"],
    ["READY-012", "Freshness / stale detection and self-monitoring"],
  ]),
  ...group("AI Receptionist", "§51–§53", [
    ["VOICE-001", "Provider evaluation and recommendation before buying a number", "P0", "founder"],
    ["VOICE-002", "Inbound number provisioned on separate Crestmont configuration", "P0", "integration", ["VOICE-001"]],
    ["VOICE-003", "Call webhooks create CRM leads and callbacks", "P0", "engineering", ["CRM-001"]],
    ["VOICE-004", "Guardrails: AI disclosure, published pricing only, no guarantees/refunds/agreements"],
    ["VOICE-005", "Voice administration: calls, costs, errors, config versions, test results"],
    ["VOICE-006", "Recording/transcription consent handling", "P0", "security"],
  ]),
  ...group("AI Operations", "§54", [
    ["AIOPS-001", "AI job tracking: provider, model, status, cost, retries, approval"],
    ["AIOPS-002", "Bounded AI workflows (qualification, quote/support/content drafts, summaries)"],
    ["AIOPS-003", "Hard block on AI refunds, contracts, production releases", "P0", "security"],
  ]),
  ...group("Email", "§55", [
    ["EMAIL-001", "Resend integration with verified sending domain", "P0", "integration", ["IDENT-004"]],
    ["EMAIL-002", "Branded templates for all 20 required workflows"],
    ["EMAIL-003", "Delivery logs, retry and failure tracking, unsubscribe behaviour"],
  ]),
  ...group("Finance", "§56–§58", [
    ["FIN-001", "Financial dashboard metrics derived from persisted records with documented definitions"],
    ["FIN-002", "Cost tracking with unknown ≠ zero"],
    ["FIN-003", "Project profitability"],
    ["FIN-004", "Accounting exports with date ranges"],
  ]),
  ...group("CMS", "§59", [
    ["CMS-001", "CMS for site content with drafts, preview, publish, revision history"],
    ["CMS-002", "Role-based editing and audit logs"],
    ["CMS-003", "Pricing edits gated by Founder approval and never bypass server pricing"],
  ]),
  ...group("Data", "§60", [
    ["DATA-001", "Complete relational schema with constraints, indexes, migrations"],
    ["DATA-002", "Referential integrity and tenant scoping columns"],
  ]),
  ...group("Infrastructure", "§61–§63", [
    ["INFRA-001", "Architecture decision record for Cloudflare-first stack"],
    ["INFRA-002", "Separate dev / staging / production environments and secrets", "P0", "integration"],
    ["INFRA-003", "Dedicated private GitHub repository", "P0", "integration"],
    ["INFRA-004", "CI: tests, typecheck, security scan, build on every PR"],
    ["INFRA-005", "Branch protection, release tagging, deployment automation, rollback", "P0", "integration", ["INFRA-003"]],
    ["INFRA-006", "Monitoring, alerting and backups with tested recovery", "P0", "integration"],
  ]),
  ...group("Security", "§64–§66", [
    ["SEC-001", "Input validation and output encoding on all inputs/outputs", "P0", "security"],
    ["SEC-002", "CSRF, XSS, SSRF, SQL injection protections", "P0", "security"],
    ["SEC-003", "Private file storage: signed URLs, size/type limits, malware scan, access logging", "P0", "security"],
    ["SEC-004", "Secrets management and dependency scanning", "P0", "security"],
    ["SEC-005", "Append-only audit log", "P0", "security"],
    ["SEC-006", "Privacy: retention, export and deletion requests", "P0", "security"],
    ["SEC-007", "OWASP ASVS review report", "P0", "security"],
  ]),
  ...group("Files", "§65", [
    ["FILE-001", "R2-backed private file service with metadata and tenant checks"],
  ]),
  ...group("Legal", "§67", [
    ["LEGAL-001", "Draft terms, privacy, development, custom, maintenance agreements for attorney review", "P0", "business"],
    ["LEGAL-002", "Draft support, refund, cancellation, acceptable use, DPA policies", "P0", "business"],
    ["LEGAL-003", "Agreement acceptance records with versioning"],
    ["LEGAL-004", "Attorney review completed (never self-certified)", "P0", "business"],
    ["LEGAL-005", "Tax configuration", "P0", "business", ["IDENT-001"]],
  ]),
  ...group("Testing", "§68–§70", [
    ["TEST-001", "Unit and integration test suites wired to readiness evidence"],
    ["TEST-002", "33 required E2E journeys automated against staging", "P0", "engineering", ["INFRA-002"]],
    ["TEST-003", "Accessibility and responsive browser tests"],
    ["TEST-004", "Recovery / rollback tests"],
  ]),
  ...group("Continuity", "§72", [
    ["DOC-001", "Repository-tracked build ledger"],
    ["DOC-002", "Operational runbook, backup/recovery procedures, postlaunch monitoring plan", "P1"],
    ["DOC-003", "Founder acceptance checklist and final status report", "P1"],
  ]),
  ...group("Launch", "§44,§78–§79", [
    ["LAUNCH-001", "Founder explicit production launch authorization", "P0", "founder"],
    ["LAUNCH-002", "Production deployment matches approved release candidate", "P0", "engineering", ["READY-008"]],
    ["LAUNCH-003", "Post-deploy production verification of critical journeys", "P0", "engineering", ["LAUNCH-002"]],
  ]),
  // Founder addendum, 2026-10-27: automated paid-intake development (docs/ai-builds/). Added scope, not a
  // re-definition of the original 154: reports show the original registry and this addendum separately.
  ...group("AI Builds (addendum)", "Addendum 2026-10-27", [
    ["AIB-001", "Automatic build eligibility from a webhook-verified qualifying payment and submitted intake, in either order", "P0", "engineering", ["PAY-003", "PORTAL-002"]],
    ["AIB-002", "Durable, idempotent build queue (one job per order/revision; lost enqueues recovered by a sweep)", "P0", "engineering", ["AIB-001"]],
    ["AIB-003", "Runner leases, heartbeats, bounded retries and concurrency limits (no competing builds per project)", "P0", "engineering", ["AIB-002"]],
    ["AIB-004", "Interruption recovery and session resume from checkpoints", "P0", "engineering", ["AIB-003"]],
    ["AIB-005", "Orchestrator-enforced spending, runtime and turn limits, cumulative across revisions", "P0", "engineering", ["AIB-003"]],
    ["AIB-006", "Owner controls: global/project pause, cancel, retry, resume, revision, preview approval; honest stop semantics", "P0", "engineering", ["AIB-003"]],
    ["AIB-007", "Isolation: signed runner API, per-customer data scoping, no platform secrets in workspaces, customer-safe summaries", "P0", "security", ["AIB-003"]],
    ["AIB-008", "Versioned, immutable build brief snapshots with customer content treated as data", "P0", "engineering", ["AIB-001"]],
    ["AIB-009", "Owner AI Builds dashboard and documented frontend API/state contract", "P0", "engineering", ["AIB-006"]],
    ["AIB-010", "Build runner on the official Claude Agent SDK: isolated workspaces, versioned starters, curated skills, checks, previews", "P0", "engineering", ["AIB-003"]],
    ["AIB-011", "Real provider-backed end-to-end staging build (test payment → intake → isolated session → preview → owner review)", "P0", "integration", ["AIB-010", "INFRA-002"]],
  ]),
  ...group("AI Builds V4 (Founder architecture)", "Founder directive V4 2026-10-28: local dual-model on owned GPUs (supersedes V2/V3)", [
    ["AIB-012", "GPU worker registry and GPU-capacity-aware scheduling: many websites per worker up to its measured capacity, waiting websites hold no capacity, Founder priority with aging, owned hardware only, GPU workers and AI models dashboard", "P0", "engineering", ["AIB-003"]],
    ["AIB-013", "Architect master specification and autonomous BUILD→TEST→REVIEW→CORRECT loop with evidence gates, traceable continuations, loop guards and the models of every cycle recorded", "P0", "engineering", ["AIB-012"]],
    ["AIB-014", "Sensitive-action approval queue and nonblocking external-integration checklist (never marked live by the builder)", "P0", "engineering", ["AIB-013"]],
    ["AIB-015", "Local dual-model orchestrator: Model A (architect, fresh read-only reviewer, hard repairs) and Model B (builder) with task routing, a shared GPU inference scheduler (load/unload, VRAM tracking, switch timeouts and recovery, batching, fairness, performance log), concurrent website slots and $0 metered inference enforcement", "P0", "engineering", ["AIB-012"]],
    ["AIB-016", "Node 1 verification and acceptance: both models pulled and measured on the RTX 5090 (VRAM, throughput, switching, 1/2/4/8 concurrency), then one real internal website through the full lifecycle", "P0", "integration", ["AIB-015"]],
    ["AIB-017", "Private Crestmont review gate: a finished website is invisible to the customer (no preview, notification, review results or status detail) until staff approve it internally (MFA step-up) and explicitly share it; final approval only after internal approval", "P0", "security", ["AIB-006"]],
    ["AIB-018", "Trusted integration-execution layer: agents request catalogued test-environment operations; the runner runs them with scoped credentials the agent never sees, after Owner approval, with sanitized evidence", "P0", "security", ["AIB-014"]],
    ["AIB-019", "Test-only payment simulation (Stripe not configured): Owner-only, MFA step-up, refused in production and unless enabled, fictional test organizations only, enters the real payment-confirmation handler; duplicate/replay/amount/currency/failed/unauthorized events never unlock fulfillment; a simulated payment is never shown to a customer or released", "P0", "security", ["AIB-001"]],
    ["AIB-020", "Customer-to-website E2E benchmark: simulated payment → real CRM, quote, registration, onboarding, project and build dispatch → real Node 1 dual-model build, QA, repair cycles → private Founder review queue, with measured metrics", "P0", "integration", ["AIB-016", "AIB-019"]],
  ]),
];

/** The original Founder-approved registry (154). The AI Builds addendum is reported separately. */
export const ORIGINAL_REQUIREMENT_COUNT = 154;

const ids = new Set<string>();
for (const r of REQUIREMENTS) {
  if (ids.has(r.id)) throw new Error(`Duplicate requirement id ${r.id}`);
  ids.add(r.id);
}
for (const r of REQUIREMENTS) {
  for (const d of r.dependsOn ?? []) if (!ids.has(d)) throw new Error(`${r.id} depends on unknown ${d}`);
}
