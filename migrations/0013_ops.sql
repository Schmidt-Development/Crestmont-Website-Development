-- Operations (INFRA-005, READY-006, READY-009, LAUNCH-002, SEC-006, TEST-004).
-- Deployment recorder provenance, release-candidate binding check, retention run log and the
-- secure-deletion marker for soft-deleted files. Additive only.

-- ───────────── Deployment recorder (READY-009, LAUNCH-002) ─────────────
-- release_check: result of comparing a production deployment's commit with the Founder-approved
-- release candidate at the moment it was first recorded. 'mismatch' also opens a
-- production_incident blocker (incident_blocker_id) so Gate H and the production view show it.
ALTER TABLE deployments ADD COLUMN release_check TEXT CHECK (release_check IS NULL OR release_check IN ('matches_approved_release','mismatch','not_applicable'));
ALTER TABLE deployments ADD COLUMN release_check_detail TEXT;
ALTER TABLE deployments ADD COLUMN run_url TEXT;
ALTER TABLE deployments ADD COLUMN updated_at TEXT;
CREATE INDEX idx_deployments_env_time ON deployments(environment, deployed_at);

-- ───────────── Retention (SEC-006) ─────────────
-- One row per category per retention run. Counts only; no deleted content is copied here.
CREATE TABLE retention_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  category TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('always','configured','skipped')),
  cutoff TEXT,
  affected INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);
CREATE INDEX idx_retention_runs_ran ON retention_runs(ran_at);

-- Soft-deleted files whose bytes were removed from object storage by the retention job.
-- The metadata row is kept (other records reference it); only the stored object is destroyed.
ALTER TABLE files ADD COLUMN purged_at TEXT;

CREATE INDEX idx_sessions_expires ON sessions(expires_at);
