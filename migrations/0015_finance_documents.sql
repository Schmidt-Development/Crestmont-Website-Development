-- Finance documents, Stripe Invoices and ledger reconciliation (PAY-005, PAY-006, PAY-009, FIN-002).

-- ───────────── Stripe Invoice mirror for milestone invoices (PAY-006) ─────────────
-- invoices.stripe_invoice_id already exists (0001). These columns record what Stripe returned the last
-- time the invoice was created/finalized or reported by a webhook. They never mark the local invoice
-- paid: invoices.status changes only through verified Stripe webhooks (src/services/payments.ts).
ALTER TABLE invoices ADD COLUMN stripe_invoice_status TEXT;        -- draft|open|paid|void|uncollectible (Stripe's value)
ALTER TABLE invoices ADD COLUMN stripe_invoice_number TEXT;
ALTER TABLE invoices ADD COLUMN stripe_hosted_invoice_url TEXT;
ALTER TABLE invoices ADD COLUMN stripe_invoice_error TEXT;
ALTER TABLE invoices ADD COLUMN stripe_invoice_synced_at TEXT;

-- ───────────── Reconciliation scopes (PAY-009) ─────────────
-- 'checkout': Checkout Sessions vs invoices/payments/subscriptions (0012).
-- 'ledger':   Stripe Invoices, balance transactions and payouts vs invoices/payments/refunds.
ALTER TABLE reconciliation_runs ADD COLUMN scope TEXT NOT NULL DEFAULT 'checkout' CHECK (scope IN ('checkout','ledger'));

-- Findings gain ledger discrepancy kinds and a typed resolution. SQLite cannot change a CHECK
-- constraint in place, so the table is rebuilt with the same columns plus the new ones.
CREATE TABLE reconciliation_findings_v2 (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('paid_in_stripe_unpaid_locally','unknown_local_invoice','amount_mismatch',
    'payment_missing_locally','subscription_missing_locally','paid_locally_not_in_stripe',
    'stripe_invoice_missing_locally','stripe_invoice_amount_mismatch','stripe_invoice_status_mismatch','local_stripe_invoice_not_found',
    'balance_txn_missing_locally','balance_txn_amount_mismatch','fee_mismatch','refund_missing_locally',
    'payout_amount_mismatch','payout_failed')),
  scope TEXT NOT NULL DEFAULT 'checkout' CHECK (scope IN ('checkout','ledger')),
  stripe_object_id TEXT,
  invoice_id TEXT,
  payment_id TEXT,
  organization_id TEXT,
  stripe_amount_cents INTEGER,
  local_amount_cents INTEGER,
  detail TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','cleared','resolved')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_run_id TEXT REFERENCES reconciliation_runs(id),
  resolved_by TEXT REFERENCES users(id),
  resolved_at TEXT,
  resolution_note TEXT,
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('no_action_needed','corrected_locally','corrected_in_stripe','refunded_or_credited','escalated_to_accountant')),
  reopened_count INTEGER NOT NULL DEFAULT 0
);
INSERT INTO reconciliation_findings_v2 (id, fingerprint, kind, scope, stripe_object_id, invoice_id, payment_id, organization_id, stripe_amount_cents, local_amount_cents,
    detail, status, first_seen_at, last_seen_at, last_run_id, resolved_by, resolved_at, resolution_note, resolution)
  SELECT id, fingerprint, kind, 'checkout', stripe_object_id, invoice_id, payment_id, organization_id, stripe_amount_cents, local_amount_cents,
    detail, status, first_seen_at, last_seen_at, last_run_id, resolved_by, resolved_at, resolution_note, CASE WHEN status = 'resolved' THEN 'no_action_needed' END
  FROM reconciliation_findings;
DROP TABLE reconciliation_findings;
ALTER TABLE reconciliation_findings_v2 RENAME TO reconciliation_findings;
CREATE INDEX idx_reconciliation_findings_status ON reconciliation_findings(status, last_seen_at);
CREATE INDEX idx_reconciliation_findings_kind ON reconciliation_findings(kind, status);

-- Payouts seen in Stripe and how they compare with local records. Read-only mirror for review.
CREATE TABLE stripe_payouts (
  id TEXT PRIMARY KEY,                 -- po_…
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,                -- Stripe payout status (paid, pending, in_transit, canceled, failed)
  arrival_date TEXT,
  stripe_created TEXT NOT NULL,
  txn_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  stripe_net_cents INTEGER,            -- sum of net of the payout's balance transactions (excluding the payout itself)
  local_expected_cents INTEGER,        -- from local payments − fees − refunds; NULL = unknown (a fee or match is missing)
  state TEXT NOT NULL CHECK (state IN ('matched','mismatch','incomplete','failed','pending')),
  detail TEXT,
  last_run_id TEXT REFERENCES reconciliation_runs(id),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX idx_stripe_payouts_created ON stripe_payouts(stripe_created);
