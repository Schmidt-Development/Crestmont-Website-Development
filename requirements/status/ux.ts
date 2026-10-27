import type { ImplementationRecord } from "../status.ts";

// Records for this workstream (UX / design system). See requirements/status.ts for the rules.
// Evidence: tests/ux.test.ts (integration) and tests/e2e/visual.e2e.ts (Chromium, development server only).
export const UX: Record<string, ImplementationRecord> = {
  "BRAND-003": { status: "implemented", owner: "engineering",
    location: "src/ui/components.ts (button, input, select, table, card classes, drawerShell/drawerAttrs/drawerBody, toast via layout flash) + public/assets/app.css; drawer used for the CRM board lead quick view (/staff/crm → /staff/crm/leads/:id/quick, plain page without JS)" },
  "BRAND-004": { status: "implemented", owner: "engineering",
    location: "src/ui/components.ts (badge, fileInput, pagination, filters, dateRange with this month / last 30 days / quarter / year presets used by rangeForm on /staff/sales, /staff/finance*, /staff/reports; richText) + src/ui/markdown.ts safe markdown renderer used for CMS 'richtext' fields (about.page body, service intros) with app.js toolbar + live preview" },
  "BRAND-005": { status: "implemented", owner: "engineering",
    location: "src/ui/components.ts (aria-invalid + aria-describedby linking errors and hints on input/select/textarea, formErrors summary, emptyState, errorPage, skeleton) + layout skeleton template shown by app.js while slow server-rendered pages (readiness, owner, finance, reports, sales) load" },
  "BRAND-006": { status: "in_progress", owner: "engineering",
    location: "public/assets/app.css (UX block: audit fixes) + tests/e2e/visual.e2e.ts (375/768/1440 sweep of 59 public, portal, staff and owner pages: overflow, landmarks, names, upscaled images, tap targets; computed WCAG contrast; visible focus)",
    missing: "visual audit runs against the local development server only (not a deployed staging build); /portal/support and /staff/readiness/blockers still render an unlabelled <nav class=\"tabs\"> owned by the support and readiness areas (allow-listed in the test until fixed); portfolio pages are audited only in their pending-screenshot state (BLK-007)" },
  "CRM-001": { status: "implemented", owner: "engineering",
    location: "migrations/0014_ux.sql (leads.utm_* / referrer / landing_page) + src/services/leads.ts (first-party HttpOnly cm_attr cookie set by publicLayout, hidden fields on /quote and /contact, DNT/GPC drops referrer, referrer reduced to origin+path) + lead detail 'Attribution' + /staff/sales campaign attribution breakdown (source / medium / campaign, scoped by leadScope)" },
  "PORTAL-005": { status: "in_progress", owner: "engineering",
    location: "src/services/messages.ts (general conversation: project_id NULL, notifyGeneral in-app + email, listGeneralConversations, generalUnreadForStaff) + /portal/messages/general, /staff/conversations, /staff/conversations/:orgId (internal notes, read status, attachments) + project threads (area B)",
    missing: "notification email delivery depends on Resend (not configured; development outbox only); no real-time updates (page refresh)" },
  "SEC-003": { status: "in_progress", owner: "engineering",
    location: "src/services/share-links.ts + migrations/0014_ux.sql share_links (SHA-256 token hash only, ≤ 7-day expiry, revocation, per-IP rate limit, audit on create/view/download/deny/revoke, single file per link, infected/failed never shared, unscanned requires acknowledgement) + /files/:id/share, /share/:token; plus src/services/files.ts upload limits and access-logged downloads (area B)",
    missing: "no malware scanning service is configured (every file stays scan_status 'pending'; sharing requires the creator to acknowledge it is unscanned); share links are not yet exercised on a deployed environment" },
  "EMP-002": { status: "in_progress", owner: "engineering",
    location: "tests/ux.test.ts cross-area audit coverage test (refund decision, role change, user disable, pricing CMS publish, release approval, file download, project cancel, settings change, share link) through real routes; src/domain/authz.ts + requireStaff guards",
    missing: "the coverage test asserts the listed sensitive actions only; an exhaustive route-by-route audit inventory has not been produced" },
  "TEST-003": { status: "in_progress", owner: "engineering",
    location: "tests/e2e/visual.e2e.ts (375 / 768 tablet / 1440 sweeps with landmark, accessible-name, aria-describedby, contrast, focus and tap-target rule checks) + tests/e2e/core.e2e.ts + tests/e2e/journeys.e2e.ts",
    missing: "rule checks are hand-written, not a full WCAG rule engine (axe-level); runs locally against the development server, not against staging or in CI (CI blocked, BLK-013)" },
};
