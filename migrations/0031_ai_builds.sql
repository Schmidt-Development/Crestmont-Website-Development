-- AI Builds: automated first builds for eligible paid intakes (docs/ai-builds/).
-- Money in micro-USD (1 USD = 1 000 000) so agent costs keep their precision.

CREATE TABLE build_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  automation_enabled INTEGER NOT NULL DEFAULT 1 CHECK (automation_enabled IN (0,1)),
  globally_paused INTEGER NOT NULL DEFAULT 0 CHECK (globally_paused IN (0,1)),
  pause_reason TEXT,
  -- Projects created before this moment are never started automatically (owner backfill only).
  auto_start_after TEXT NOT NULL,
  run_budget_micro INTEGER NOT NULL DEFAULT 25000000 CHECK (run_budget_micro > 0),
  project_budget_micro INTEGER NOT NULL DEFAULT 75000000 CHECK (project_budget_micro > 0),
  max_runtime_minutes INTEGER NOT NULL DEFAULT 120 CHECK (max_runtime_minutes BETWEEN 5 AND 1440),
  max_turns INTEGER NOT NULL DEFAULT 200 CHECK (max_turns BETWEEN 1 AND 5000),
  max_concurrent INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrent BETWEEN 0 AND 50),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  lease_seconds INTEGER NOT NULL DEFAULT 180 CHECK (lease_seconds BETWEEN 30 AND 3600),
  model TEXT NOT NULL DEFAULT 'claude-sonnet-5-5',
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
INSERT INTO build_settings (id, auto_start_after, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE build_project_controls (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
  pause_reason TEXT,
  project_budget_micro INTEGER CHECK (project_budget_micro IS NULL OR project_budget_micro > 0),
  backfill_authorized_by TEXT REFERENCES users(id),
  backfill_authorized_at TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE build_briefs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, version)
);
CREATE TRIGGER build_briefs_immutable BEFORE UPDATE ON build_briefs BEGIN SELECT RAISE(ABORT, 'build briefs are immutable snapshots'); END;

CREATE TABLE build_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  order_id TEXT REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('first_build','revision')),
  revision INTEGER NOT NULL DEFAULT 0,
  -- Durable idempotency: one first build per project, one job per revision number.
  dedupe_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('awaiting_intake','awaiting_payment','queued','preparing','building','verifying','needs_information',
    'ready_for_review','approved','failed','canceled','budget_paused','paused')),
  state_reason TEXT,
  strategy TEXT NOT NULL CHECK (strategy IN ('standard','custom')),
  package_id TEXT,
  brief_id TEXT REFERENCES build_briefs(id),
  instruction TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('payment','intake','sweep','backfill','revision','retry','resume')),
  created_by TEXT REFERENCES users(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  not_before TEXT,
  cost_micro INTEGER NOT NULL DEFAULT 0 CHECK (cost_micro >= 0),
  turns INTEGER NOT NULL DEFAULT 0,
  agent_session_id TEXT,
  workspace_ref TEXT,
  checkpoint_key TEXT,
  source_repo TEXT, source_branch TEXT, source_commit TEXT,
  preview_url TEXT,
  report_md TEXT,
  missing_info_json TEXT,
  lease_runner TEXT, lease_token_hash TEXT, lease_expires_at TEXT, heartbeat_at TEXT, stop_reason TEXT,
  run_started_at TEXT, started_at TEXT, finished_at TEXT,
  cancel_requested_at TEXT, cancel_requested_by TEXT REFERENCES users(id),
  approved_by TEXT REFERENCES users(id), approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Never two competing builds for one project.
CREATE UNIQUE INDEX idx_build_jobs_one_active ON build_jobs(project_id) WHERE state IN ('queued','preparing','building','verifying');
CREATE INDEX idx_build_jobs_state ON build_jobs(state, created_at);

CREATE TABLE build_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES build_jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  runner_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  error TEXT,
  UNIQUE (job_id, attempt)
);

CREATE TABLE build_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES build_jobs(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('transition','activity','checkpoint','source','preview','usage','action','requirement','error')),
  from_state TEXT, to_state TEXT,
  message TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system','runner','user','webhook')),
  actor_user_id TEXT REFERENCES users(id),
  data_json TEXT
);
CREATE INDEX idx_build_events_job ON build_events(job_id, id);

CREATE TABLE build_requirements (
  job_id TEXT NOT NULL REFERENCES build_jobs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('remaining','implemented_unverified','verified','blocked')),
  evidence TEXT,
  blocker TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, key)
);

CREATE TABLE build_runners (
  runner_id TEXT PRIMARY KEY,
  version TEXT,
  capabilities TEXT,
  last_seen_at TEXT NOT NULL
);
