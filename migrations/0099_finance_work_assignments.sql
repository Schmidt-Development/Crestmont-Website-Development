-- Financial issues in My Work (Founder directive 2026-11-08): who is looking after each one.
--
-- The issues themselves are NOT copied into a new table. They are read live from the records that already describe
-- them -- reconciliation_findings (Stripe vs local records), subscriptions with a failed payment, refund requests to
-- review, open disputes, and a failed cost import -- so an issue appears the moment its record says so and disappears
-- the moment it is genuinely resolved, with no second copy to keep in step and nothing to duplicate on a retry.
--
-- The only new fact is the assignment: which employee is handling the issue. `item_key` names the issue the same way
-- src/services/finance-work.ts does (e.g. "finding:rcf_...", "subscription:sub_...", "refund:ref_...",
-- "dispute:dsp_...", "job:cost_import"). One row per issue; reassigning replaces it and is audited.
CREATE TABLE finance_work_assignments (
  item_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  assigned_by TEXT NOT NULL REFERENCES users(id),
  assigned_at TEXT NOT NULL
);
