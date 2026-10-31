-- AI Website Builder: Founder decisions of 2026-10-28 (docs/ai-builds/README.md).
--   D1 owner approval of customer revisions, D2 preview retention 30 days after final approval,
--   D3 private authenticated previews, D5 owner-controlled customer production delivery.

-- ── D1: the Owner approves or rejects each customer revision request before any AI work starts ──
ALTER TABLE revisions ADD COLUMN ai_decision TEXT CHECK (ai_decision IS NULL OR ai_decision IN ('approved', 'rejected'));
ALTER TABLE revisions ADD COLUMN ai_decided_by TEXT REFERENCES users(id);
ALTER TABLE revisions ADD COLUMN ai_decided_at TEXT;
ALTER TABLE revisions ADD COLUMN ai_decision_note TEXT;
-- SHA-256 of the normalized request text: a repeated submission of the same open request is not a new round.
ALTER TABLE revisions ADD COLUMN request_hash TEXT;
CREATE INDEX idx_revisions_request_hash ON revisions(project_id, request_hash);

-- ── D2: preview retention ──
-- 30 days after the owner approves the final preview, superseded previews of the project are deleted (unless
-- preserved or extended). The approved preview itself is kept until its production deployment is verified.
UPDATE build_settings SET preview_retention_days = 30 WHERE preview_retention_days IS NULL;
ALTER TABLE build_jobs ADD COLUMN preview_preserved INTEGER NOT NULL DEFAULT 0 CHECK (preview_preserved IN (0, 1));
ALTER TABLE build_jobs ADD COLUMN preview_retain_until TEXT;
ALTER TABLE build_jobs ADD COLUMN preview_delete_reason TEXT CHECK (preview_delete_reason IS NULL OR preview_delete_reason IN ('owner', 'retention'));

-- ── D3: private previews ──
-- 1 = deployed behind the Crestmont preview gate (signed sign-in through the platform; nothing served without it).
ALTER TABLE build_jobs ADD COLUMN preview_gated INTEGER NOT NULL DEFAULT 0 CHECK (preview_gated IN (0, 1));
-- The owner shares a preview with the project's customer, who may then open it and record a review.
ALTER TABLE build_jobs ADD COLUMN customer_preview_shared_at TEXT;
ALTER TABLE build_jobs ADD COLUMN customer_preview_shared_by TEXT REFERENCES users(id);
ALTER TABLE build_jobs ADD COLUMN customer_review TEXT CHECK (customer_review IS NULL OR customer_review IN ('approved', 'changes_requested'));
ALTER TABLE build_jobs ADD COLUMN customer_reviewed_by TEXT REFERENCES users(id);
ALTER TABLE build_jobs ADD COLUMN customer_reviewed_at TEXT;
ALTER TABLE build_jobs ADD COLUMN customer_review_note TEXT;

-- ── D5: customer production delivery (owner-controlled; executed by the build runner) ──
-- One deployment identity per customer project: its own Worker name on the customer-hosting account (never the
-- Crestmont platform account), so one customer's release can never overwrite another's or Crestmont's.
CREATE TABLE site_targets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL DEFAULT 'cloudflare-workers' CHECK (provider IN ('cloudflare-workers')),
  worker_name TEXT NOT NULL UNIQUE CHECK (worker_name GLOB 'cm-site-*' AND length(worker_name) <= 63),
  -- A customer domain is attached only after a separate, explicit owner authorization.
  hostname TEXT UNIQUE,
  hostname_authorized_by TEXT REFERENCES users(id),
  hostname_authorized_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE site_deployments (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES site_targets(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  build_job_id TEXT NOT NULL REFERENCES build_jobs(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('release', 'rollback')),
  rollback_of TEXT REFERENCES site_deployments(id),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'authorized', 'deploying', 'live', 'verification_failed', 'failed', 'superseded', 'canceled')),
  state_reason TEXT,
  -- Snapshot at preparation: exactly what is released (the build's commit), where (worker, optional domain).
  source_repo TEXT,
  source_commit TEXT NOT NULL,
  workspace_ref TEXT,
  worker_name TEXT NOT NULL,
  hostname TEXT,
  prepared_by TEXT REFERENCES users(id),
  prepared_at TEXT NOT NULL,
  authorized_by TEXT REFERENCES users(id),
  authorized_at TEXT,
  authorization_note TEXT,
  lease_runner TEXT,
  lease_token_hash TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  deployed_at TEXT,
  verified_at TEXT,
  finished_at TEXT,
  deployed_url TEXT,
  content_sha256 TEXT,
  verification_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, version)
);
-- One release in flight per customer site.
CREATE UNIQUE INDEX idx_site_deployments_in_flight ON site_deployments(target_id) WHERE state IN ('prepared', 'authorized', 'deploying');
CREATE INDEX idx_site_deployments_state ON site_deployments(state, authorized_at);
CREATE TABLE site_deployment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT NOT NULL REFERENCES site_deployments(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  message TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'runner', 'user')),
  actor_user_id TEXT REFERENCES users(id)
);
CREATE INDEX idx_site_deployment_events ON site_deployment_events(deployment_id, id);
