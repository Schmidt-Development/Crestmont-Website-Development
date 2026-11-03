// Acceptance registry (READY-013). The authoritative, machine-checkable statement of WHAT PROVES each
// requirement — replacing the hand-maintained implementation declarations in requirements/status/*.ts as the
// source of readiness status.
//
// Why this exists: implementation status used to be asserted by a human editing requirements/status/*.ts.
// Nothing recomputed it when engineering work actually landed, so the dashboard drifted from reality (the
// 2026-11-02 audit found eleven merged-ready PRs that moved the tally by zero). Here a requirement declares
// the evidence that closes it; src/readiness/derive.ts then derives the state from evidence that CI, the
// staging deploy and the production checks already post. No status is ever typed by hand.
//
// Adding a requirement: add it to requirements/inventory.ts and give it an entry here (or let it take the
// category default). tests/acceptance-registry.test.ts refuses an inventory id with no resolvable acceptance,
// an acceptance entry for an unknown id, an external gate naming an unknown blocker, and a code requirement
// with no tagged test in the suite. The requirement then appears on the dashboard at the next evidence
// ingest — see syncRequirementsIfStale in src/readiness/ingest.ts.

import { REQUIREMENTS, type Category } from "./inventory.ts";

/** The lowest derived state at which a requirement counts as done. Nothing below it is "complete". */
export type CompleteAt = "IMPLEMENTED" | "STAGING_VERIFIED" | "PRODUCTION_VERIFIED";

/** How a requirement is tracked for scoring. `platform` is the launch denominator; `external_ai` is one of the
 *  five separately-developed AI systems and is reported beside the platform, never inside its percentages. */
export type Tracking = "platform" | "external_ai";

export interface Acceptance {
  /** Human-readable acceptance criteria: what a reader should be able to check. */
  criteria: string;
  /** The state at which this requirement is complete. */
  completeAt: CompleteAt;
  tracking: Tracking;
  /**
   * A fact no code can establish (a legal entity, a vendor account, a Founder decision, a captured
   * screenshot, an independent review). The requirement cannot pass `completeAt` while the named gate is
   * open, however many tests pass; once the gate clears, the fact itself is the evidence. Name a blocker
   * from the blocker register or a release-blocking security finding — whichever actually holds it up.
   */
  external?: { blocker?: string; finding?: string; note: string };
  /**
   * Evidence sources that must each show a pass for the requirement to reach `completeAt`, beyond the
   * default CI evidence. Used where CI exercises only a fake adapter and a live run is what really proves it.
   */
  requires?: ("staging_e2e" | "production_check" | "integration_probe")[];
}

/** Category defaults, applied when a requirement has no explicit entry below. */
const DEFAULTS: Record<Category, Pick<Acceptance, "completeAt" | "tracking">> = {
  engineering: { completeAt: "IMPLEMENTED", tracking: "platform" },
  security: { completeAt: "IMPLEMENTED", tracking: "platform" },
  integration: { completeAt: "STAGING_VERIFIED", tracking: "platform" },
  business: { completeAt: "IMPLEMENTED", tracking: "platform" },
  founder: { completeAt: "IMPLEMENTED", tracking: "platform" },
};

const CRITERIA_DEFAULT: Record<Category, string> = {
  engineering: "Every test tagged with this requirement passes in CI at the current commit.",
  security: "Every test tagged with this requirement passes in CI at the current commit.",
  integration: "Tagged tests pass in CI and the integration is exercised against the live service on staging.",
  business: "Every test tagged with this requirement passes in CI at the current commit.",
  founder: "Every test tagged with this requirement passes in CI at the current commit.",
};

/** The five separately-developed AI systems. Audited and merged in their own sessions; tracked, never scored here. */
const EXTERNAL_AI_SUBSYSTEMS = new Set([
  "AI Receptionist",
  "AI Sales Optimization (addendum)",
  "AI Builds (addendum)",
  "AI Builds V4 (Founder architecture)",
]);

type Entry = Partial<Acceptance> & { criteria: string };

/**
 * Explicit entries. Everything here states either (a) a fact outside the codebase that gates the requirement,
 * or (b) that CI alone is not proof because CI exercises a fake. Requirements absent from this map take the
 * category default, which is the common case and needs no maintenance.
 */
const ENTRIES: Record<string, Entry> = {
  // ── Identity: nothing in the repository can establish these ──
  "IDENT-001": { criteria: "A legal entity exists and its registered name is stored in business settings.", external: { blocker: "BLK-006", note: "Founder forms the entity and enters the registered name" } },
  "IDENT-002": { criteria: "A registered, non-residential business mailing address is stored in business settings.", external: { blocker: "BLK-006", note: "Founder obtains the address and enters it" } },
  "IDENT-003": { criteria: "support@, sales@, billing@ and legal@ receive mail and the routes are verified.", external: { blocker: "BLK-005", note: "Founder creates and verifies the mailbox routes" } },
  "IDENT-004": { criteria: "crestmontwebsitedevelopment.com is a zone on the Crestmont Cloudflare account with its nameservers switched.", external: { blocker: "BLK-011", note: "Founder adds the zone and switches nameservers at the registrar" } },
  "IDENT-005": { criteria: "The disclosures page renders the real legal name and address, not a pending state.", external: { blocker: "BLK-006", note: "depends on IDENT-001 and IDENT-002" } },

  // ── Catalog: entitlements are a Founder decision, not code ──
  "CAT-005": { criteria: "The three maintenance plans are purchasable, which requires their entitlements to be approved.", external: { blocker: "BLK-010", note: "Founder approves or amends the proposed entitlements (FD-05)" }, completeAt: "STAGING_VERIFIED", requires: ["staging_e2e"] },
  "CAT-006": { criteria: "The Founder has recorded approval of the maintenance entitlements.", external: { blocker: "BLK-010", note: "the decision itself" } },

  // ── Portfolio: genuine screenshots and documented relationships ──
  "PORT-001": { criteria: "Genuine desktop and mobile screenshots of the live site are captured and approved.", external: { blocker: "BLK-007", note: "run the capture workflow; Founder reviews the captures" } },
  "PORT-002": { criteria: "Genuine desktop and mobile screenshots of the live site are captured and approved.", external: { blocker: "BLK-007", note: "run the capture workflow; Founder reviews the captures" } },
  "PORT-003": { criteria: "Genuine desktop and mobile screenshots of the live site are captured and approved.", external: { blocker: "BLK-007", note: "run the capture workflow; Founder reviews the captures" } },
  "PORT-004": { criteria: "Descriptions are checked against the live sites once genuine screenshots exist.", external: { blocker: "BLK-007", note: "depends on the captures" } },
  "PORT-005": { criteria: "Crestmont's relationship to each portfolio business is documented by the Founder.", external: { blocker: "BLK-008", note: "Founder documents each relationship" } },
  "PORT-006": { criteria: "Case studies are published with verified live links, which needs captures and relationships.", external: { blocker: "BLK-007", note: "depends on PORT-001..005" } },

  // ── Payments: CI exercises fakes; a live Stripe test-mode run is the proof ──
  "PAY-001": { criteria: "A customer completes a hosted Stripe test-mode checkout on the deployed site (staging journey 5).", completeAt: "STAGING_VERIFIED", requires: ["staging_e2e"] },
  "PAY-004": { criteria: "The customer opens the Stripe billing portal on the deployed site (journey 24) and maintenance subscriptions are purchasable.", completeAt: "STAGING_VERIFIED", requires: ["staging_e2e"], external: { blocker: "BLK-010", note: "subscriptions cannot be sold until entitlements are approved" } },
  "PAY-010": { criteria: "Live payments are activated only after the legal identity and the Founder's launch authorization.", external: { blocker: "BLK-006", note: "depends on IDENT-001/002, LEGAL-004/005 and LAUNCH-001" } },

  // ── Support ──
  "SUP-004": { criteria: "A real model produces a draft reply through the self-hosted runner.", external: { blocker: "BLK-009", note: "needs the Node 1 runner, which belongs to the AI Builds workstream" } },
  "SUP-005": { criteria: "The Founder has set the staffed hours and first-response target, and the public policy page shows them.", external: { blocker: "BLK-006", note: "Founder sets the hours in Settings" } },

  // ── AI operations (platform-side, but needs the external runner) ──
  "AIOPS-002": { criteria: "A real local model produces a bounded AI draft through the self-hosted runner.", external: { blocker: "BLK-009", note: "needs the Node 1 runner" } },

  // ── Email: the adapter is CI-proven against fixtures; delivery needs a verified sending domain ──
  "EMAIL-001": { criteria: "A real message is delivered through Resend from a verified sending domain.", completeAt: "STAGING_VERIFIED", requires: ["integration_probe"], external: { blocker: "BLK-005", note: "Founder creates the Resend account and verifies the domain" } },

  // ── Files and storage: R2 and a malware scanner are account-level and vendor decisions ──
  "FILE-001": { criteria: "An upload, preview and delete round trip succeeds against R2 on the deployed site (journey 9).", completeAt: "STAGING_VERIFIED", requires: ["staging_e2e"], external: { blocker: "BLK-003", note: "R2 must be enabled on the Cloudflare account" } },
  "PORTAL-004": { criteria: "Files upload, preview and delete on the deployed site and are malware-scanned before sharing.", completeAt: "STAGING_VERIFIED", requires: ["staging_e2e"], external: { finding: "F-02", note: "R2 must be enabled and a malware scanner chosen" } },
  "SEC-003": { criteria: "Private file storage enforces signed URLs, limits and access logging, and uploads are malware-scanned before sharing.", external: { finding: "F-02", note: "no malware scanning service is configured; the Founder picks a provider" } },

  // ── Security assurance: an independent review is not something the repository can assert ──
  "SEC-006": { criteria: "Approved retention periods are applied and the retention job runs in a deployed Worker.", completeAt: "STAGING_VERIFIED", external: { blocker: "BLK-006", note: "Founder and counsel approve the retention schedule, then the Owner applies it" } },
  "SEC-007": { criteria: "An independent review or penetration test of staging is completed and its release-blocking findings are closed.", external: { blocker: "BLK-006", note: "Founder commissions the test (F-16)" } },

  // ── Infrastructure ──
  "INFRA-002": { criteria: "Development, staging and production environments each exist with their own secrets.", completeAt: "PRODUCTION_VERIFIED", external: { blocker: "BLK-003", note: "production resources are created at launch; R2 enabled" } },
  "INFRA-005": { criteria: "Branch protection, release tagging and deployment automation are in place and a rollback has been exercised.", completeAt: "STAGING_VERIFIED", requires: ["staging_e2e"] },
  "INFRA-006": { criteria: "Monitoring, alerting and backups run, and a restore drill passes.", completeAt: "STAGING_VERIFIED", requires: ["staging_e2e"] },

  // ── Infrastructure facts no test can assert ──
  "INFRA-003": { criteria: "A dedicated private repository exists and holds the platform.", completeAt: "IMPLEMENTED", external: { blocker: "BLK-002", note: "the repository exists and every workflow runs in it" } },

  // ── Launch readiness itself ──
  "READY-005": { criteria: "The GitHub snapshot feed is healthy, including code scanning.", completeAt: "STAGING_VERIFIED", external: { blocker: "BLK-003", note: "code scanning must be enabled on the repository" } },

  // ── Legal: an attorney's review is never self-certified ──
  "LEGAL-001": { criteria: "The agreement drafts have been reviewed by an attorney.", external: { blocker: "BLK-006", note: "attorney review (LEGAL-004)" } },
  "LEGAL-002": { criteria: "The policy drafts have been reviewed by an attorney.", external: { blocker: "BLK-006", note: "attorney review (LEGAL-004)" } },
  "LEGAL-004": { criteria: "An attorney has reviewed the legal suite and the review is recorded. Never self-certified.", external: { blocker: "BLK-006", note: "engage an attorney" } },
  "LEGAL-005": { criteria: "Tax registration, jurisdictions and rates are configured on advice from an accountant.", external: { blocker: "BLK-006", note: "Founder and accountant decide the tax position" } },

  // ── Testing and launch ──
  "TEST-002": { criteria: "The 33 required journeys run against the deployed staging site with no failures.", completeAt: "STAGING_VERIFIED", requires: ["staging_e2e"] },
  "TEST-004": { criteria: "The rollback rehearsal and the restore drill both pass against staging.", completeAt: "STAGING_VERIFIED", requires: ["staging_e2e"] },
  "LAUNCH-001": { criteria: "The Founder has recorded the production launch authorization.", external: { blocker: "BLK-006", note: "the Founder's own decision, after gates A-F pass" } },
  "LAUNCH-002": { criteria: "A production deployment matches the Founder-approved release candidate.", completeAt: "PRODUCTION_VERIFIED", external: { blocker: "BLK-003", note: "there is no production environment yet" } },
  "LAUNCH-003": { criteria: "Post-deploy production checks pass for the deployed commit.", completeAt: "PRODUCTION_VERIFIED", external: { blocker: "BLK-003", note: "there is no production deployment yet" } },
};

function resolve(id: string, subsystem: string, category: Category): Acceptance {
  const base = DEFAULTS[category];
  const tracking: Tracking = EXTERNAL_AI_SUBSYSTEMS.has(subsystem) ? "external_ai" : base.tracking;
  const e = ENTRIES[id];
  if (!e) return { criteria: CRITERIA_DEFAULT[category], completeAt: base.completeAt, tracking };
  return { criteria: e.criteria, completeAt: e.completeAt ?? base.completeAt, tracking, ...(e.external ? { external: e.external } : {}), ...(e.requires ? { requires: e.requires } : {}) };
}

/** Acceptance for every requirement in the approved inventory. Built once; ids come from the inventory, never from here. */
export const ACCEPTANCE: Record<string, Acceptance> = Object.fromEntries(
  REQUIREMENTS.map((r) => [r.id, resolve(r.id, r.subsystem, r.category)]),
);

/** Explicit entry ids, for the registry test: an entry for an id the inventory does not hold is a mistake. */
export const ACCEPTANCE_ENTRY_IDS = Object.keys(ENTRIES);

/** Identity of the registry, so a changed acceptance rule makes the stored copy stale and is re-synced. */
export function acceptanceFingerprint(id: string): string {
  const a = ACCEPTANCE[id];
  if (!a) return "";
  return [a.completeAt, a.tracking, a.external?.blocker ?? "-", a.external?.finding ?? "-", (a.requires ?? []).join("+") || "-"].join("|");
}
