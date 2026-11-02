-- FD-26 / FD-27 (Founder decisions, 2026-11): every website package order records the hosting/maintenance plan the
-- customer chose. The plan must be at or above the package's minimum (Starter → Essential, Business → Professional,
-- Premium → Executive); upgrades are allowed. Recording the plan is a commitment, not a charge: recurring billing
-- starts only when the customer approves and launches the completed website (MAINTENANCE_BILLING_START).
--  * maintenance_plan_id: the chosen plan (NULL only for orders created before this migration, quote orders whose
--    plan is set in the approved quote, and subscription orders).
--  * maintenance_plan_source: 'customer_selected' when the customer picked it at checkout; 'minimum_default' when an
--    internal path (seed data, tests, staff tooling) created the order without a customer choice.

ALTER TABLE orders ADD COLUMN maintenance_plan_id TEXT CHECK (maintenance_plan_id IS NULL OR maintenance_plan_id IN ('essential', 'professional', 'executive'));
ALTER TABLE orders ADD COLUMN maintenance_plan_source TEXT CHECK (maintenance_plan_source IS NULL OR maintenance_plan_source IN ('customer_selected', 'minimum_default'));
