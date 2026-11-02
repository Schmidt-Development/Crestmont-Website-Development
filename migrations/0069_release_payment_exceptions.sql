-- FD-16 (Founder decision, 2026-11): the Founder may authorize a documented launch/payment exception through an
-- authenticated, MFA-protected workflow (Owner-only permission, step-up MFA, recorded reason). An exception waives
-- ONLY the unpaid scheduled milestones of one project's release-readiness payment check. It never waives a simulated
-- test payment, an unpaid change order or any approval, and it is never automatic. Revoking it restores the check.
CREATE TABLE release_payment_exceptions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  reason TEXT NOT NULL CHECK (length(reason) >= 20),
  unpaid_at_grant TEXT NOT NULL,              -- the milestones that were unpaid when the exception was granted
  granted_by TEXT NOT NULL REFERENCES users(id),
  granted_at TEXT NOT NULL,
  revoked_by TEXT REFERENCES users(id),
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE UNIQUE INDEX release_payment_exceptions_active ON release_payment_exceptions (project_id) WHERE revoked_at IS NULL;
