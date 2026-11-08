-- Maintenance agreement + verified first subscription payment BEFORE a website goes live (Founder directive 2026-11-08).
--
-- Until now the maintenance activation was opened only AFTER launch (FD-27: "nothing is billed before launch"), so a
-- website could go live before the customer had signed the maintenance agreement or paid the first month. The
-- required sequence is now: website ready for customer review -> customer signs the maintenance agreement ->
-- customer activates the subscription in Stripe Checkout -> the signed Stripe webhook confirms the FIRST payment
-- succeeded -> only then may the website be published. The server enforces it at every release path
-- (src/services/launch-gate.ts).
--
-- 1. maintenance_activations is rebuilt once (SQLite cannot widen a CHECK): the activation can now be opened when the
--    website is ready for review (trigger 'ready_for_review'), `opened_at` records that moment, and `launched_at`
--    becomes nullable and is set only when the website actually goes live. Every existing row is copied unchanged
--    (opened_at = its launched_at, which is when it was opened). Nothing references this table.
-- 2. subscription_initial_payments records, from the signed invoice.paid webhook only, that a subscription's FIRST
--    invoice was paid. Keyed by the Stripe subscription id rather than the local subscriptions row, so it is correct
--    whichever of customer.subscription.created / invoice.paid arrives first. A refund or dispute of that payment
--    marks it reversed, which closes the launch gate again. A Checkout redirect never writes here.

PRAGMA defer_foreign_keys = true;

CREATE TABLE maintenance_activations_v2 (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  order_id TEXT REFERENCES orders(id),
  plan_id TEXT NOT NULL CHECK (plan_id IN ('essential', 'professional', 'executive')),
  status TEXT NOT NULL CHECK (status IN ('due', 'awaiting_plan_verification', 'active', 'cancelled')),
  trigger TEXT NOT NULL CHECK (trigger IN ('deployment_recorded', 'release_live', 'ready_for_review')),
  opened_at TEXT NOT NULL,
  launched_at TEXT,
  subscription_id TEXT REFERENCES subscriptions(id),
  activated_at TEXT,
  cancelled_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status <> 'cancelled' OR cancelled_reason IS NOT NULL)
);
INSERT INTO maintenance_activations_v2 (id, organization_id, project_id, order_id, plan_id, status, trigger, opened_at, launched_at,
  subscription_id, activated_at, cancelled_reason, created_at, updated_at)
SELECT id, organization_id, project_id, order_id, plan_id, status, trigger, launched_at, launched_at,
  subscription_id, activated_at, cancelled_reason, created_at, updated_at
FROM maintenance_activations;
DROP TABLE maintenance_activations;
ALTER TABLE maintenance_activations_v2 RENAME TO maintenance_activations;
CREATE INDEX maintenance_activations_org ON maintenance_activations (organization_id, status);

CREATE TABLE subscription_initial_payments (
  stripe_subscription_id TEXT PRIMARY KEY,
  stripe_invoice_id TEXT NOT NULL,
  stripe_payment_intent_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  paid_at TEXT NOT NULL,
  event_id TEXT NOT NULL,
  reversed_at TEXT,
  reversal_reason TEXT CHECK (reversal_reason IS NULL OR reversal_reason IN ('refunded', 'disputed')),
  created_at TEXT NOT NULL
);
CREATE INDEX subscription_initial_payments_pi ON subscription_initial_payments (stripe_payment_intent_id);
