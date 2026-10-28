-- AI Website Builder orchestration, Founder directive V4 (2026-10-28): local dual-model website development on owned
-- GPUs. Replaces the V3 Claude-subscription worker design. This file was never applied to a shared database (it
-- shipped only on the unmerged PR #16 branch; staging migrates from main), so it was rewritten in place instead of
-- stacking a corrective migration. Any database that ran an earlier draft of it must be recreated.
--
--  * build_workers   GPU workers: inference servers on owned hardware (Node 1 first; more GPUs later). A worker proves
--                    itself with a Crestmont enrollment key (hash only) on top of the signed runner channel. Many
--                    websites share one worker; capacity is its measured concurrency, not one website per worker.
--  * build_models    the models each GPU worker serves (Model A architect/reviewer, Model B builder), as reported.
--  * build_assignments   project → GPU worker affinity (workspace and checkpoints live there); one worker per project.
--  * build_pipeline  durable project lifecycle stage, priority and the architect's master specification.
--  * build_cycles    BUILD → TEST → REVIEW → CORRECT cycles with the models that ran them.
--  * build_integrations / build_approvals   external setup checklist; sensitive actions that need a person.
-- No metered (pay-per-use) inference kinds exist. Rented GPUs or paid endpoints need a separate Founder approval and
-- budget (V4 §10); the cost classes for them exist only so the registry can describe them, and are refused.

CREATE TABLE build_workers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  -- Kind of inference worker. Only local-gpu is accepted today (owned hardware, $0 metered inference).
  provider_kind TEXT NOT NULL DEFAULT 'local-gpu' CHECK (provider_kind IN ('local-gpu')),
  cost_class TEXT NOT NULL DEFAULT 'owned-hardware' CHECK (cost_class IN ('owned-hardware', 'rented-gpu', 'dedicated-server')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  dispatch_paused INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_paused IN (0, 1)),
  pause_reason TEXT,
  -- Website builds this worker may run at the same time (its runner's slots), set by the Owner from benchmarks.
  max_active_projects INTEGER NOT NULL DEFAULT 1 CHECK (max_active_projects BETWEEN 1 AND 32),
  enrollment_key_hash TEXT NOT NULL,
  runner_id TEXT,
  -- Telemetry as reported by the worker; NULL = not reported (never estimated by the platform).
  hardware_json TEXT,
  vram_total_mb INTEGER,
  vram_used_mb INTEGER,
  gpu_util_percent REAL CHECK (gpu_util_percent IS NULL OR (gpu_util_percent >= 0 AND gpu_util_percent <= 100)),
  telemetry_source TEXT,
  loaded_models_json TEXT,
  model_state TEXT,
  active_requests INTEGER,
  queued_requests INTEGER,
  max_concurrent_requests INTEGER,
  slots_total INTEGER,
  slots_busy INTEGER,
  throughput_json TEXT,
  switch_json TEXT,
  telemetry_at TEXT,
  last_seen_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  last_assigned_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE build_models (
  worker_id TEXT NOT NULL REFERENCES build_workers(id),
  model_tag TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('architect_reviewer', 'builder', 'single')),
  family TEXT,
  parameter_size TEXT,
  quantization TEXT,
  context_tokens INTEGER,
  -- Memory: measured (Ollama /api/ps while loaded) or the configured estimate; the source says which.
  vram_mb INTEGER,
  vram_source TEXT,
  license TEXT,
  tokens_per_second REAL,
  requests INTEGER NOT NULL DEFAULT 0,
  loaded INTEGER NOT NULL DEFAULT 0 CHECK (loaded IN (0, 1)),
  last_ok_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (worker_id, model_tag)
);

-- Project → GPU worker affinity. One worker per website at a time; a worker serves many websites (no worker index).
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
CREATE UNIQUE INDEX idx_build_assignments_project_active ON build_assignments(project_id) WHERE released_at IS NULL;
CREATE INDEX idx_build_assignments_worker ON build_assignments(worker_id, released_at);

-- Durable project lifecycle (V4 §7): intake → architecture → development → testing → AI review → revisions →
-- internal approval → customer preview → customer feedback → final approval → authorized delivery.
CREATE TABLE build_pipeline (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  stage TEXT NOT NULL CHECK (stage IN ('INTAKE_RECEIVED', 'ARCHITECTING', 'QUEUED', 'WAITING_FOR_GPU_CAPACITY', 'WORKER_ASSIGNED', 'BUILDING', 'TESTING',
    'AI_REVIEW', 'REVISION_REQUIRED', 'WAITING_FOR_HUMAN_AUTHORIZATION', 'WAITING_FOR_EXTERNAL_SETUP', 'AWAITING_INTERNAL_APPROVAL',
    'READY_FOR_CUSTOMER_PREVIEW', 'CUSTOMER_PREVIEW', 'CUSTOMER_FEEDBACK', 'APPROVED_FOR_DELIVERY', 'DELIVERED', 'FAILED_NEEDS_INTERVENTION')),
  stage_reason TEXT,
  -- Founder control: higher runs first (-5..5); waiting time raises the effective priority so nothing starves.
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -5 AND 5),
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

-- BUILD → TEST → REVIEW → CORRECT cycles (one row per completed implementation cycle of a build job).
CREATE TABLE build_cycles (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES build_jobs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  cycle INTEGER NOT NULL CHECK (cycle >= 1),
  prompt TEXT NOT NULL,
  prompt_source TEXT NOT NULL CHECK (prompt_source IN ('architect', 'reviewer', 'owner', 'runner')),
  -- Sessions of this cycle: [{id, role, model, task, status}].
  sessions_json TEXT,
  evidence_json TEXT,
  reviewer_provider TEXT,
  -- Models that built and reviewed this cycle, and why the router chose them.
  builder_model TEXT,
  reviewer_model TEXT,
  routing_json TEXT,
  proposed_decision TEXT,
  decision TEXT CHECK (decision IS NULL OR decision IN ('CONTINUE_BUILDING', 'FIX_DEFECTS', 'RUN_MORE_TESTS', 'WAIT_FOR_EXTERNAL_SETUP',
    'NEEDS_HUMAN_AUTHORIZATION', 'READY_FOR_FINAL_QA', 'READY_FOR_INTERNAL_APPROVAL', 'ESCALATED')),
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
  -- Result of an approved test-environment operation run by the trusted integration layer (never by the agent).
  sandbox_status TEXT NOT NULL DEFAULT 'not_run' CHECK (sandbox_status IN ('not_run', 'passed', 'failed')),
  sandbox_evidence TEXT,
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
  -- For integration_operation approvals: the exact catalogued operation the trusted layer may run once approved.
  operation TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  dedupe_key TEXT NOT NULL UNIQUE,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT
);
CREATE INDEX idx_build_approvals_status ON build_approvals(status, requested_at);

ALTER TABLE build_settings ADD COLUMN max_review_cycles INTEGER NOT NULL DEFAULT 8 CHECK (max_review_cycles BETWEEN 1 AND 50);
ALTER TABLE build_settings ADD COLUMN worker_stale_minutes INTEGER NOT NULL DEFAULT 15 CHECK (worker_stale_minutes BETWEEN 2 AND 1440);
ALTER TABLE build_jobs ADD COLUMN worker_id TEXT REFERENCES build_workers(id);
-- What the website's agent is doing now, as the runner reports it (scheduler view; V4 §6).
ALTER TABLE build_jobs ADD COLUMN activity_state TEXT;
ALTER TABLE build_jobs ADD COLUMN current_model TEXT;
ALTER TABLE build_jobs ADD COLUMN current_task TEXT;
ALTER TABLE build_jobs ADD COLUMN activity_at TEXT;
-- Automated acceptance verdict of the platform referee for this build: passed | failed | NULL (no review cycle ran).
ALTER TABLE build_jobs ADD COLUMN ai_acceptance TEXT;
-- Private Crestmont review gate (V4 §7 F): nothing reaches the customer before a staff member approves it here.
ALTER TABLE build_jobs ADD COLUMN internal_approved_at TEXT;
ALTER TABLE build_jobs ADD COLUMN internal_approved_by TEXT REFERENCES users(id);
ALTER TABLE build_jobs ADD COLUMN internal_approval_note TEXT;
