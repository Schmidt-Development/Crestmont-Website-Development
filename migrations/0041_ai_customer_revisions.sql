-- AI Builds: customer revision requests -> AI build revisions, and provider-independent run records.
-- (0041: 0038-0040 are in use or reserved on other open branches.)

-- How a customer's revision request (portal, `revisions`) reaches the AI builder. A Founder policy, not an assumption:
--   off             customer revisions are handled by staff only (no AI build is created from them)
--   owner_approval  (default) the request waits in Owner -> AI builds until an owner forwards it (and can edit the
--                   instruction); nothing runs or spends until then
--   auto            an entitled request (an included round, or a beyond-allowance round whose change order is approved)
--                   is queued as an AI revision automatically when the project is eligible
-- In every mode the existing entitlement rules decide whether a round may be worked on at all.
ALTER TABLE build_settings ADD COLUMN customer_revision_mode TEXT NOT NULL DEFAULT 'owner_approval'
  CHECK (customer_revision_mode IN ('off', 'owner_approval', 'auto'));

-- The customer revision an AI revision build works on (NULL = an owner-initiated revision).
ALTER TABLE build_jobs ADD COLUMN customer_revision_id TEXT REFERENCES revisions(id);
-- At most one live AI build per customer revision request; a failed or canceled one may be replaced.
CREATE UNIQUE INDEX idx_build_jobs_customer_revision_live ON build_jobs(customer_revision_id)
  WHERE customer_revision_id IS NOT NULL AND state NOT IN ('failed', 'canceled');

-- What actually ran each attempt (reported by the runner): provider id, model, and whether it is zero-cost.
ALTER TABLE build_runs ADD COLUMN provider TEXT;
ALTER TABLE build_runs ADD COLUMN model TEXT;
ALTER TABLE build_runs ADD COLUMN zero_cost INTEGER CHECK (zero_cost IS NULL OR zero_cost IN (0, 1));
