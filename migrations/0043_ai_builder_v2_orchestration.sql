-- AI Website Builder architecture V2 (2026-10-28): builder workers, one website per worker, pipeline stages,
-- architect/reviewer cycles, external-integration checklist, sensitive-action approvals.
-- Provider-independent: a "worker" is any registered, Owner-authorized builder identity (a self-hosted model, a
-- Claude Code installation, an API-backed agent). No account passwords or provider tokens are stored here; a worker
-- proves itself with a Crestmont enrollment key (hash only) on top of the signed runner channel.

CREATE TABLE build_workers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  -- local-model | claude-code | anthropic-api | openai-api | other
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('local-model', 'claude-code', 'anthropic-api', 'openai-api', 'other')),
  -- Per-token billing: paid workers never receive work while the paid-spend cap is 0 (the $0 target).
  billing TEXT NOT NULL DEFAULT 'zero-cost' CHECK (billing IN ('zero-cost', 'subscription', 'metered')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  dispatch_paused INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_paused IN (0, 1)),
  pause_reason TEXT,
  -- Concurrent development sessions this worker may run for its one website (bounded by hardware/provider rules).
  max_sessions INTEGER NOT NULL DEFAULT 1 CHECK (max_sessions BETWEEN 1 AND 16),
  enrollment_key_hash TEXT NOT NULL,
  runner_id TEXT,
  -- Usage as reported through an authorized interface only; NULL = not available (never estimated).
  usage_percent REAL CHECK (usage_percent IS NULL OR (usage_percent >= 0 AND usage_percent <= 100)),
  usage_source TEXT,
  usage_reported_at TEXT,
  rate_limited_until TEXT,
  last_seen_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  last_assigned_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One customer website per worker at a time; one worker per website at a time.
CREATE TABLE build_assignments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  worker_id TEXT NOT NULL REFERENCES build_workers(id),
  assigned_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  selection_json TEXT
);
CREATE UNIQUE INDEX idx_build_assignments_worker_active ON build_assignments(worker_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX idx_build_assignments_project_active ON build_assignments(project_id) WHERE released_at IS NULL;

-- Durable project pipeline stage (the Founder's V2 lifecycle), alongside the per-build job states.
CREATE TABLE build_pipeline (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  stage TEXT NOT NULL CHECK (stage IN ('INTAKE_RECEIVED', 'ARCHITECTING', 'READY_FOR_DISPATCH', 'QUEUED', 'WORKER_ASSIGNED', 'BUILDING', 'TESTING',
    'AI_REVIEW', 'REVISION_REQUIRED', 'WAITING_FOR_WORKER_CAPACITY', 'WAITING_FOR_HUMAN_AUTHORIZATION', 'WAITING_FOR_EXTERNAL_SETUP',
    'READY_FOR_FINAL_QA', 'READY_FOR_FOUNDER_APPROVAL', 'APPROVED_FOR_DELIVERY', 'DELIVERED', 'FAILED_NEEDS_INTERVENTION')),
  stage_reason TEXT,
  spec_json TEXT,
  spec_version INTEGER NOT NULL DEFAULT 0,
  architect_provider TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE build_pipeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  at TEXT NOT NULL,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  message TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'runner', 'user'))
);
CREATE INDEX idx_build_pipeline_events ON build_pipeline_events(project_id, id);

-- BUILD → TEST → REVIEW → NEW PROMPT cycles (one row per completed implementation cycle of a build job).
CREATE TABLE build_cycles (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES build_jobs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  cycle INTEGER NOT NULL CHECK (cycle >= 1),
  prompt TEXT NOT NULL,
  prompt_source TEXT NOT NULL CHECK (prompt_source IN ('architect', 'reviewer', 'owner', 'runner')),
  evidence_json TEXT,
  reviewer_provider TEXT,
  -- Reviewer decision as proposed, and the platform's authoritative decision after the evidence and loop guards.
  proposed_decision TEXT,
  decision TEXT CHECK (decision IS NULL OR decision IN ('CONTINUE_BUILDING', 'FIX_DEFECTS', 'RUN_MORE_TESTS', 'WAIT_FOR_EXTERNAL_SETUP',
    'NEEDS_HUMAN_AUTHORIZATION', 'READY_FOR_FINAL_QA', 'READY_FOR_FOUNDER_APPROVAL', 'ESCALATED')),
  decision_reason TEXT,
  next_prompt TEXT,
  score REAL,
  failure_signature TEXT,
  findings_json TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  UNIQUE (job_id, cycle)
);

-- External integration checklist: live connections wait; engineering does not.
CREATE TABLE build_integrations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  credentials_required TEXT NOT NULL,
  setup_instructions TEXT NOT NULL,
  permissions_required TEXT NOT NULL,
  code_status TEXT NOT NULL DEFAULT 'not_started' CHECK (code_status IN ('not_started', 'in_progress', 'implemented')),
  mock_status TEXT NOT NULL DEFAULT 'not_tested' CHECK (mock_status IN ('not_tested', 'passed', 'failed')),
  live_status TEXT NOT NULL DEFAULT 'not_connected' CHECK (live_status IN ('not_connected', 'awaiting_credentials', 'verified_live')),
  human_action TEXT NOT NULL,
  responsible TEXT NOT NULL CHECK (responsible IN ('founder', 'customer', 'crestmont_staff')),
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, key)
);

-- Sensitive actions a build needs a person for. Routine development never comes here.
CREATE TABLE build_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  job_id TEXT REFERENCES build_jobs(id),
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  dedupe_key TEXT NOT NULL UNIQUE,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT
);
CREATE INDEX idx_build_approvals_status ON build_approvals(status, requested_at);

-- Cost layer: hard cap on metered AI spend (USD micro). 0 = refuse every paid call (the Founder's $0 target).
ALTER TABLE build_settings ADD COLUMN paid_spend_cap_micro INTEGER NOT NULL DEFAULT 0 CHECK (paid_spend_cap_micro >= 0);
ALTER TABLE build_settings ADD COLUMN max_review_cycles INTEGER NOT NULL DEFAULT 8 CHECK (max_review_cycles BETWEEN 1 AND 50);
ALTER TABLE build_settings ADD COLUMN worker_stale_minutes INTEGER NOT NULL DEFAULT 15 CHECK (worker_stale_minutes BETWEEN 2 AND 1440);
ALTER TABLE build_jobs ADD COLUMN worker_id TEXT REFERENCES build_workers(id);
