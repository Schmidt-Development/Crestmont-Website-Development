-- FD-27 / FD-21 / Founder clarifications 1–2 (2026-11):
--  * maintenance_activations: the recurring maintenance subscription starts at approved launch, never at purchase. When
--    a project's site first goes live (a recorded customer deployment or a verified live release, both of which require
--    the customer's final launch approval), one activation is opened for the plan committed on the order
--    (orders.maintenance_plan_id, migration 0064). Status:
--      due                         plan sellable; the customer starts the subscription for that plan (or a higher one)
--      awaiting_plan_verification  the plan's benefits are not yet operationally verified (FD-05, clarification 8),
--                                  so nothing can be billed; the Owner sees it
--      active                      a subscription for the plan exists (from the signed Stripe webhook)
--      cancelled                   closed by the Owner with a reason
--  * subscriptions failure / suspension fields: a failed monthly payment that stays unresolved for seven days makes the
--    hosting ELIGIBLE for suspension after notices; suspension itself is a documented Owner decision. Nothing here
--    deletes a website or customer data. Payment clears the failure and restores hosting.

CREATE TABLE maintenance_activations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  order_id TEXT REFERENCES orders(id),
  plan_id TEXT NOT NULL CHECK (plan_id IN ('essential', 'professional', 'executive')),
  status TEXT NOT NULL CHECK (status IN ('due', 'awaiting_plan_verification', 'active', 'cancelled')),
  trigger TEXT NOT NULL CHECK (trigger IN ('deployment_recorded', 'release_live')),
  launched_at TEXT NOT NULL,
  subscription_id TEXT REFERENCES subscriptions(id),
  activated_at TEXT,
  cancelled_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status <> 'cancelled' OR cancelled_reason IS NOT NULL)
);
CREATE INDEX maintenance_activations_org ON maintenance_activations (organization_id, status);

ALTER TABLE subscriptions ADD COLUMN payment_failed_at TEXT;
ALTER TABLE subscriptions ADD COLUMN suspension_eligible_at TEXT;
ALTER TABLE subscriptions ADD COLUMN suspension_reminder_sent_at TEXT;
ALTER TABLE subscriptions ADD COLUMN hosting_suspended_at TEXT;
ALTER TABLE subscriptions ADD COLUMN hosting_suspended_by TEXT REFERENCES users(id);
ALTER TABLE subscriptions ADD COLUMN hosting_suspension_reason TEXT;
ALTER TABLE subscriptions ADD COLUMN hosting_restored_at TEXT;
