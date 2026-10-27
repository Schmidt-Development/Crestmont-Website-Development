-- 0012 Integration hooks: Resend delivery events + suppressions (EMAIL-003), automatic cost import
-- (FIN-002) and Stripe-side reconciliation findings (PAY-009).

-- ───────────── Retell (VOICE-003 / VOICE-006) ─────────────
-- Calls and events reuse calls / voice_events. Retell has no consent field of its own, so the agent
-- calls the record_consent custom function after asking; the answer is kept here (grant-only) and
-- passed to the voice service with call_started / call_ended.
CREATE TABLE retell_call_consents (
  provider_call_id TEXT PRIMARY KEY,
  consent INTEGER NOT NULL CHECK (consent IN (0,1)),
  recorded_at TEXT NOT NULL
);

-- ───────────── Resend delivery events (EMAIL-003) ─────────────
-- One row per Svix message id: the idempotency key for webhook redelivery.
CREATE TABLE email_webhook_events (
  svix_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  provider_message_id TEXT,            -- Resend data.email_id
  delivery_id TEXT REFERENCES email_deliveries(id),
  recipient TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied','ignored','unmatched')),
  detail TEXT,
  event_created_at TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX idx_email_webhook_events_msg ON email_webhook_events(provider_message_id);
CREATE INDEX idx_email_webhook_events_received ON email_webhook_events(received_at);

-- Recipients that must not be mailed again (hard bounce or spam complaint). History is kept:
-- removal sets removed_at; at most one active row per address.
CREATE TABLE email_suppressions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,                 -- lower-cased
  reason TEXT NOT NULL CHECK (reason IN ('hard_bounce','complaint')),
  detail TEXT,
  source_event_id TEXT,                -- svix id that caused it
  created_at TEXT NOT NULL,
  removed_at TEXT,
  removed_by TEXT REFERENCES users(id),
  removal_note TEXT
);
CREATE UNIQUE INDEX uq_email_suppressions_active ON email_suppressions(email) WHERE removed_at IS NULL;

-- ───────────── Automatic cost import (FIN-002) ─────────────
-- Ledger of what has been imported, so a source record is never imported twice.
-- project_cost_id is NULL when nothing was written to project_costs (e.g. a fee for a payment
-- that has no project). No FK on project_cost_id: the ledger row is written first in the same
-- batch and the cost row is inserted only if this ledger row was the one created.
CREATE TABLE cost_imports (
  source TEXT NOT NULL CHECK (source IN ('ai_job','stripe_fee')),
  source_id TEXT NOT NULL,
  project_cost_id TEXT,
  project_id TEXT REFERENCES projects(id),
  amount_cents INTEGER,                -- NULL = unknown
  note TEXT,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
);
CREATE INDEX idx_cost_imports_project ON cost_imports(project_id);

-- ───────────── Stripe-side reconciliation (PAY-009) ─────────────
CREATE TABLE reconciliation_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','ok','skipped','failed')),
  detail TEXT,
  objects_checked INTEGER NOT NULL DEFAULT 0,
  findings_opened INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_reconciliation_runs_started ON reconciliation_runs(started_at);

-- Findings are for human review only. Nothing here ever marks an invoice or payment paid;
-- verified Stripe webhooks remain the only source of payment truth.
CREATE TABLE reconciliation_findings (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,    -- kind + Stripe object / local id: one finding per discrepancy
  kind TEXT NOT NULL CHECK (kind IN ('paid_in_stripe_unpaid_locally','unknown_local_invoice','amount_mismatch',
    'payment_missing_locally','subscription_missing_locally','paid_locally_not_in_stripe')),
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
  resolution_note TEXT
);
CREATE INDEX idx_reconciliation_findings_status ON reconciliation_findings(status, last_seen_at);
