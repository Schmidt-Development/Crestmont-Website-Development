-- A per-entry lease for native readiness work (2026-11-20, "UNIVERSAL AUTONOMOUS PORTFOLIO ENGINE"): the 15-minute
-- job, an Owner-approved prepare round, a staff "Check again" and a bulk Add may overlap. Each step first claims the
-- entry atomically (UPDATE … WHERE the lease is free or expired); a second worker finds it taken and leaves it alone,
-- so an entry is never advanced twice at once (no duplicate rule, pull request or verification). The lease expires on
-- its own, so a worker that stops mid-step (timeout, deploy, crash) never blocks the entry for longer than that.
ALTER TABLE portfolio_projects ADD COLUMN native_lease_until TEXT;
