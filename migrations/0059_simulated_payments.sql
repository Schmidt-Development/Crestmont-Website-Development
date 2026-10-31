-- Test-only payment simulation (Founder E2E benchmark directive, 2026-10-30).
-- Stripe is not configured. A simulated payment is an Owner action (MFA step-up) that is refused in production,
-- refused unless PAYMENT_SIMULATION_ENABLED=true, and refused for any organization the Owner has not marked as a
-- fictional test organization. It enters the same internal payment-confirmation handler a verified Stripe webhook
-- uses (src/services/payments.ts confirmInvoicePayment); everything downstream is the real application workflow.
-- A simulated payment never authorizes real customer fulfillment: build eligibility requires the test-organization
-- mark, and customer preview sharing and production release are refused for projects paid by simulation.

-- Fictional test organizations (only these can receive a simulated payment).
ALTER TABLE organizations ADD COLUMN simulation_test_org INTEGER NOT NULL DEFAULT 0 CHECK (simulation_test_org IN (0,1));
ALTER TABLE organizations ADD COLUMN simulation_marked_by TEXT REFERENCES users(id);
ALTER TABLE organizations ADD COLUMN simulation_marked_at TEXT;

-- Which provider confirmed a payment. Existing rows are Stripe.
ALTER TABLE payments ADD COLUMN provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe','simulated'));
ALTER TABLE payments ADD COLUMN simulated_transaction_id TEXT;
CREATE UNIQUE INDEX payments_simulated_txn ON payments(simulated_transaction_id) WHERE simulated_transaction_id IS NOT NULL;
-- At most one simulated payment per invoice (duplicate-order protection even under concurrent deliveries).
CREATE UNIQUE INDEX payments_simulated_invoice ON payments(invoice_id) WHERE provider = 'simulated';

-- Every synthetic payment event, stored once by event id (duplicate deliveries are acknowledged, never re-applied).
CREATE TABLE simulated_payment_events (
  id TEXT PRIMARY KEY,                       -- evt_sim_…
  transaction_id TEXT NOT NULL,              -- txn_sim_…
  order_id TEXT,
  invoice_id TEXT,
  organization_id TEXT,
  customer_id TEXT,                          -- the customer administrator the order belongs to
  package_id TEXT,
  amount_cents INTEGER,
  currency TEXT,
  payment_status TEXT,                       -- SIMULATED_PAID | SIMULATED_FAILED | anything else (rejected)
  environment TEXT,
  correlation_id TEXT,
  event_created_at TEXT,
  payload TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied','rejected','failed_payment','duplicate_order')),
  reason TEXT,
  actor_user_id TEXT REFERENCES users(id),
  received_at TEXT NOT NULL
);
CREATE INDEX simulated_payment_events_txn ON simulated_payment_events(transaction_id);
CREATE INDEX simulated_payment_events_invoice ON simulated_payment_events(invoice_id, received_at);
