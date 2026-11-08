import type { ImplementationRecord } from "../status.ts";

// Records for this workstream. See requirements/status.ts for the rules.
const E = "engineering";

export const LEGAL_COMMERCE: Record<string, ImplementationRecord> = {
  "LEGAL-003": { status: "implemented", owner: E,
    location: "migrations/0011_agreements_pricing.sql (9 seeded draft versions with body_text + body_sha256, attorney_reviewed=0, immutability triggers; acceptance context/ip/user_agent) + src/services/agreements.ts (recordAcceptance at registration, quote acceptance, package checkout, maintenance checkout — only after the explicit checkbox; auto-stores a new exact version when rendered text differs; audited) + scripts/agreement-versions.ts (drift check / new-version SQL) + /portal/agreements, /staff/legal (customers.read), /legal/:kind/versions[/:version] in src/routes/legal.ts + tests/legal-commerce.test.ts [LEGAL-003]" },
  "CAT-007": { status: "implemented", owner: E,
    location: "src/services/pricing-approvals.ts (propose: quote.write|settings.operational with reason + effective date; approve/reject: Owner user with MFA + pricing.change only, AI/automation refused; immutable price_overrides; effectivePrice used by package checkout, maintenance checkout, new package quotes and /, /pricing, /pricing/compare, /hosting-maintenance; every step audited + notifications) + /staff/pricing in src/routes/legal.ts + migrations/0011 + tests/legal-commerce.test.ts [CAT-007]; catalog.ts priceQuote unchanged and pure; existing orders/invoices/quote versions keep stored prices" },
  "PAY-005": { status: "in_progress", owner: E,
    location: "Receipts done: /portal/billing/receipts/:paymentId (org-scoped) and /staff/finance/receipts/:paymentId (finance.read) with sequential customer-facing numbers (Receipt 001 / Invoice 001, migration 0100; the legacy CWD-R-000001 reference and invoice/order/Stripe references are staff-only 'Technical details'), business identity from settings (honest pending text when unset), print stylesheet + ?view=print 'Download (print to PDF)'; linked from /portal/billing and invoice pages (src/services/receipts.ts, src/routes/legal.ts, tests [PAY-005]/[AUTH-008])",
    missing: "verified Stripe test-mode run (BLK-004) — payments and receipts are only exercised with seeded/fake-adapter data; no server-generated PDF file (browser print-to-PDF only); receipts are not yet linked from staff invoice list rows" },
};
