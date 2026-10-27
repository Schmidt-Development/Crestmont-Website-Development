import type { ImplementationRecord } from "../status.ts";

// Records for this workstream (provider webhooks, cost import, Stripe-side reconciliation).
// See requirements/status.ts for the rules. Anything that needs a real provider account stays
// in_progress with its blocker id: nothing here has been exercised against a live provider.
const E = "engineering";
export const INTEGRATIONS: Record<string, ImplementationRecord> = {
  "VOICE-003": {
    status: "in_progress", owner: E,
    location: "POST /api/webhooks/voice (provider-agnostic) + POST /api/webhooks/retell and /api/webhooks/retell/functions (src/routes/hooks.ts, src/adapters/retell.ts → src/services/voice.ts); docs/voice/RETELL-INTEGRATION.md; tests/integrations.test.ts, tests/voice.test.ts",
    missing: "No Retell workspace/agent exists for Crestmont (BLK-009): signature scheme and payload mapping follow Retell's docs and are tested only with locally signed test payloads; needs a staging test call from the Crestmont workspace as evidence. Outcome for call_ended is derived from platform-recorded function calls (Retell sends none).",
  },
  "EMAIL-003": {
    status: "in_progress", owner: E,
    location: "/staff/email delivery log + retry; POST /api/webhooks/resend (Svix-verified, idempotent per svix-id) → email_deliveries status + email_suppressions; suppressed recipients skipped by both email adapters (status 'suppressed' with reason); /staff/email-suppressions view/remove (audited); tests/integrations.test.ts",
    missing: "No Resend account or webhook secret (BLK-005): Svix verification and event mapping are tested only with locally signed payloads, never with a real Resend delivery. The /staff/email page (platform area) still says suppression is not connected and does not link to /staff/email-suppressions.",
  },
  "FIN-002": {
    status: "in_progress", owner: E,
    location: "src/services/finance.ts#addCost + /staff/finance/profitability (NULL = Unknown); daily cost_import job (src/services/cost-import.ts): ai_jobs.cost_microusd → project_costs ai_usage by input_ref convention (project:<id>, ticket:<id>; others unattributed), Stripe fees via read-only GET payment_intents?expand[]=latest_charge.balance_transaction → payments.fee_cents + payment_fee cost; idempotent ledger cost_imports; /staff/finance/reconciliation?view=costs",
    missing: "Stripe fee lookup untested against a real Stripe test account (BLK-004). Existing AI workflows use lead:/ticket: input refs, so most AI cost is unattributed until project workflows use project:<id>. Hosting, software licence and third-party API costs are manual entries only (no provider billing APIs connected).",
  },
  "PAY-009": {
    status: "in_progress", owner: E,
    location: "stripe_reconcile job (retries stored events, every 15 min) + daily stripe_side_reconcile job (src/services/stripe-reconcile.ts): read-only GET /v1/checkout/sessions compared with invoices/payments/subscriptions → reconciliation_findings (never marks anything paid); /staff/finance/reconciliation review with audited notes; owner notifications; tests/integrations.test.ts",
    missing: "Needs a dedicated Crestmont Stripe test account (BLK-004) to run against real data; payouts/balance-transaction reconciliation and Stripe Invoices (non-Checkout) are not compared. No nav link: the page is reached from /staff/finance only by URL until the finance area adds one.",
  },
};
