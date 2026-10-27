import type { ImplementationRecord } from "../status.ts";

// Records for this product area (CRM, sales/quotes, checkout, customer billing, refunds/disputes,
// finance). See requirements/status.ts for the rules. Anything that needs a real Stripe account is
// in_progress until a verified Stripe test-mode run exists (BLK-004).
const E = "engineering";
const STRIPE_RUN = "verified Stripe test-mode run (BLK-004) — only exercised against a fake adapter so far";

export const SALES_FINANCE: Record<string, ImplementationRecord> = {
  // ── CRM ──
  "CRM-001": { status: "in_progress", location: "src/services/leads.ts#captureLead + src/services/crm.ts#createManualLead + /staff/crm, /staff/crm/new", owner: E,
    missing: "campaign/referrer (UTM) attribution — source is tracked only as the form/channel (web_form, quote_form, manual, referral...)" },
  "CRM-002": { status: "implemented", location: "src/services/crm.ts (contacts, companies, customers) + /staff/crm/contacts, /staff/customers/:id", owner: E },
  "CRM-004": { status: "implemented", location: "src/services/crm.ts#addNote/addTask/completeTask + /staff/crm/leads/:id", owner: E },
  "CRM-005": { status: "implemented", location: "src/services/crm.ts#leadScope/listLeads/assignOwner + /staff/crm (board, list, filters, pagination) + /staff/crm/export.csv", owner: E },
  "CRM-006": { status: "implemented", location: "src/services/crm.ts#salesReport + /staff/sales (definitions on page)", owner: E },
  "CRM-007": { status: "in_progress", location: "/staff/crm/leads/:id linked quotes/orders/projects/tickets; webhook conversion via orders.lead_id", owner: E,
    missing: `AI receptionist lead creation (VOICE-003, other area); ${STRIPE_RUN}` },

  // ── Sales & catalog ──
  "CAT-003": { status: "implemented", location: "src/services/quotes.ts (custom lines → 50/25/25 via priceQuote) + /staff/quotes/new", owner: E },
  "CAT-007": { status: "in_progress", location: "server-side PACKAGES/priceQuote for every checkout and quote; client price fields ignored (tests/crm.test.ts)", owner: E,
    missing: "Founder approval workflow for price changes (pricing.change) — prices currently change only through code review of src/domain/catalog.ts" },
  "SALES-002": { status: "implemented", location: "src/services/quotes.ts#saveQuote (quote_versions per save) + /staff/quotes, /staff/quotes/:id", owner: E },
  "SALES-003": { status: "implemented", location: "src/services/quotes.ts#sendQuote (hashed quote_access_tokens, quote_sent email) + public /q/:token", owner: E },
  "SALES-004": { status: "in_progress", location: "/q/:token/accept → createQuoteOrder → /portal/billing/invoices/:id/pay → Stripe webhook → provisionProject (e2e test)", owner: E, missing: STRIPE_RUN },

  // ── Payments & billing ──
  "PAY-001": { status: "in_progress", location: "src/services/billing.ts#startPackageCheckout/startInvoiceCheckout + /checkout/:packageId", owner: "integration", missing: STRIPE_RUN },
  "PAY-004": { status: "in_progress", location: "src/services/billing.ts#startMaintenanceCheckout (gated on CAT-006) + billingPortalUrl + /portal/billing/manage", owner: "integration",
    missing: `${STRIPE_RUN}; maintenance sales blocked until Founder approves entitlements (CAT-006, BLK-010)` },
  "PAY-005": { status: "in_progress", location: "/portal/billing, /portal/billing/invoices/:id (invoice + receipt view), /staff/finance/invoices", owner: E,
    missing: `${STRIPE_RUN}; downloadable receipt document` },
  "PAY-007": { status: "in_progress", location: "src/services/refunds.ts + /portal/billing/refund-request + /staff/refunds/:id", owner: E,
    missing: "verified Stripe test-mode refund (BLK-004)" },
  "PAY-008": { status: "in_progress", location: "src/services/refunds.ts#listDisputes + /staff/disputes", owner: E,
    missing: "verified Stripe test-mode dispute events (BLK-004); staff notification when a dispute is opened (needs a hook in src/services/payments.ts)" },
  "PORTAL-008": { status: "in_progress", location: "src/routes/finance.ts /portal/billing* (orders, invoices, receipts, subscriptions, refund requests)", owner: E, missing: STRIPE_RUN },

  // ── Finance ──
  "FIN-001": { status: "implemented", location: "src/services/finance.ts#financeDashboard + FINANCE_DEFINITIONS + /staff/finance", owner: E },
  "FIN-002": { status: "in_progress", location: "src/services/finance.ts#addCost + /staff/finance/profitability (NULL = Unknown)", owner: E,
    missing: "automatic import of AI usage (ai_jobs.cost_microusd) and reconciled Stripe fees into project costs; currently entered manually" },
  "FIN-003": { status: "implemented", location: "src/services/finance.ts#projectProfitability + /staff/finance/profitability", owner: E },
  "FIN-004": { status: "implemented", location: "src/services/finance.ts#exportCsv + /staff/reports/*.csv", owner: E },
};
