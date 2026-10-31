-- AI Sales Optimization engine (SALESOPT-001..012; docs/voice/SALES-OPTIMIZATION.md).
-- Evaluates calls handled by a registered Retell SALES agent, attributes verified Stripe outcomes, analyses consented
-- transcripts with the self-hosted model, and manages immutable prompt versions, evaluations, gated deployments and
-- experiments. EVERYTHING IS OFF BY DEFAULT: no target is registered, optimization is paused, production deployment
-- is not activated. Nothing here dials a phone number, and nothing here changes the inbound receptionist.

-- ───────────── Control (one row) ─────────────
-- paused: no analysis/proposal jobs are queued. production_activated: Founder-only gate (set with step-up; the
-- environment flag SALES_OPT_PRODUCTION=on is also required). auto_rollback: roll back on safety-threshold breach.
CREATE TABLE so_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 1 CHECK (paused IN (0,1)),
  production_activated INTEGER NOT NULL DEFAULT 0 CHECK (production_activated IN (0,1)),
  auto_rollback INTEGER NOT NULL DEFAULT 1 CHECK (auto_rollback IN (0,1)),
  thresholds_json TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT,
  last_run_detail TEXT,
  last_proposal_at TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
INSERT INTO so_control (id, paused, production_activated, auto_rollback, updated_at) VALUES (1, 1, 0, 1, '1970-01-01T00:00:00Z');

-- ───────────── Targets: which Retell agent is "the sales agent" in each stage ─────────────
-- A target is never the receptionist: the service refuses an agent id equal to the receptionist's inbound/outbound id.
CREATE TABLE so_targets (
  stage TEXT PRIMARY KEY CHECK (stage IN ('staging','production')),
  agent_id TEXT NOT NULL,
  llm_id TEXT,                       -- resolved from get-agent (response_engine.llm_id); NULL until verified
  engine_type TEXT,                  -- response_engine.type reported by Retell; only 'retell-llm' can be deployed
  verified_at TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- ───────────── Immutable prompt-version registry ─────────────
-- Content columns can never change (trigger). Only status columns move, through src/domain/sales-opt/versions.ts.
CREATE TABLE so_versions (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  parent_id TEXT REFERENCES so_versions(id),
  instructions TEXT NOT NULL,          -- editable part (the protected policy is prepended at composition time)
  prompt_sha256 TEXT NOT NULL,         -- sha256 of the composed prompt (policy + instructions)
  policy_version TEXT NOT NULL,
  diff_json TEXT NOT NULL,             -- structured line diff against the parent
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','ai','import')),
  author TEXT NOT NULL,                -- user id, or self-hosted model tag
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','evaluating','eval_failed','eval_passed','rejected','approved','retired')),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  decision_note TEXT,
  status_updated_at TEXT NOT NULL
);
CREATE TRIGGER so_versions_content_immutable BEFORE UPDATE OF id, seq, parent_id, instructions, prompt_sha256, policy_version, diff_json, rationale, evidence_json, author_kind, author, created_at ON so_versions
BEGIN SELECT RAISE(ABORT, 'prompt versions are immutable'); END;
CREATE TRIGGER so_versions_no_delete BEFORE DELETE ON so_versions BEGIN SELECT RAISE(ABORT, 'prompt versions are never deleted'); END;
-- At most one AI-generated proposal awaiting a decision at a time (prevents proposal floods).
CREATE UNIQUE INDEX uq_so_versions_open_ai ON so_versions(author_kind) WHERE author_kind = 'ai' AND status IN ('draft','evaluating','eval_passed');

-- ───────────── Call facts (one row per sales-agent call) ─────────────
CREATE TABLE so_call_facts (
  call_id TEXT PRIMARY KEY REFERENCES calls(id),
  provider_call_id TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL CHECK (stage IN ('staging','production')),
  agent_id TEXT NOT NULL,
  retell_agent_version INTEGER,
  version_id TEXT REFERENCES so_versions(id),     -- platform version deployed to this stage when the call started
  experiment_id TEXT,
  arm TEXT CHECK (arm IS NULL OR arm IN ('baseline','candidate')),
  lead_id TEXT REFERENCES leads(id),
  segment TEXT,                                   -- lead segment from signed metadata (crestmont_segment); NULL = unknown
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  dial_outcome TEXT,                              -- Retell disconnection_reason
  connected INTEGER CHECK (connected IS NULL OR connected IN (0,1)),
  call_status TEXT,
  tools_json TEXT NOT NULL DEFAULT '[]',          -- [{name, ok}] tool invocations (names only; arguments never stored)
  product_discussed TEXT,
  pricing_discussed INTEGER NOT NULL DEFAULT 0,
  checkout_link_generated INTEGER NOT NULL DEFAULT 0,
  checkout_link_delivered INTEGER NOT NULL DEFAULT 0,
  follow_up_requested INTEGER NOT NULL DEFAULT 0,
  opt_out INTEGER NOT NULL DEFAULT 0,
  human_escalation INTEGER NOT NULL DEFAULT 0,
  qualified INTEGER CHECK (qualified IS NULL OR qualified IN (0,1)),
  user_sentiment TEXT,
  error TEXT,
  last_event TEXT NOT NULL,
  last_event_rank INTEGER NOT NULL,              -- call_started 1 < call_ended 2 < call_analyzed 3 (out-of-order safety)
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_so_call_facts_version ON so_call_facts(stage, version_id, started_at);
CREATE INDEX idx_so_call_facts_lead ON so_call_facts(lead_id, ended_at);

-- Signed webhook receipts: an exact replay of an already-processed signed delivery is acknowledged and ignored.
CREATE TABLE so_webhook_receipts (
  signature_sha256 TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  provider_call_id TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX idx_so_webhook_receipts_received ON so_webhook_receipts(received_at);

-- ───────────── Verified sales attribution (from webhook-verified payments only) ─────────────
CREATE TABLE so_attributions (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  call_id TEXT NOT NULL REFERENCES calls(id),
  version_id TEXT REFERENCES so_versions(id),
  experiment_id TEXT,
  arm TEXT,
  lead_id TEXT REFERENCES leads(id),
  order_id TEXT REFERENCES orders(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  rule TEXT NOT NULL CHECK (rule IN ('checkout_link','last_touch')),
  credit REAL NOT NULL CHECK (credit > 0 AND credit <= 1),   -- multi-touch: equal split across touches in the window
  is_last_touch INTEGER NOT NULL CHECK (is_last_touch IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('paid','refunded','partially_refunded','disputed','cancelled')),
  repeat_customer INTEGER NOT NULL DEFAULT 0 CHECK (repeat_customer IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payment_id, call_id)
);
CREATE INDEX idx_so_attributions_version ON so_attributions(version_id, status);

-- ───────────── Local-model analyses ─────────────
CREATE TABLE so_analyses (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(id),
  analyzer TEXT NOT NULL,             -- analysis prompt version, so a new analyzer can re-run
  ai_job_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','done','failed','skipped')),
  model TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (call_id, analyzer)
);
CREATE TABLE so_findings (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES so_analyses(id),
  call_id TEXT NOT NULL REFERENCES calls(id),
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('observed','interpreted')),   -- observed = quote verified verbatim in the transcript
  evidence_line INTEGER,
  evidence_quote TEXT,                 -- NULLed when the call transcript is purged by retention
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_so_findings_category ON so_findings(category, created_at);
CREATE INDEX idx_so_findings_call ON so_findings(call_id);

-- Improvement-proposal jobs sent to the self-hosted model, with the evidence they were allowed to cite.
CREATE TABLE so_proposal_jobs (
  ai_job_id TEXT PRIMARY KEY,
  parent_version_id TEXT NOT NULL REFERENCES so_versions(id),
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','accepted','rejected','failed')),
  version_id TEXT REFERENCES so_versions(id),
  detail TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

-- ───────────── Evaluation harness ─────────────
CREATE TABLE so_eval_runs (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES so_versions(id),
  status TEXT NOT NULL CHECK (status IN ('running','passed','failed','error')),
  static_ok INTEGER NOT NULL CHECK (static_ok IN (0,1)),
  summary TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE so_eval_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES so_eval_runs(id),
  scenario TEXT NOT NULL,
  ai_job_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','passed','failed','error')),
  assertions_json TEXT NOT NULL DEFAULT '[]',
  judge_score REAL,                    -- advisory local-model score; never the pass criterion
  transcript TEXT,                     -- simulated conversation (no real customer data)
  completed_at TEXT,
  UNIQUE (run_id, scenario)
);

-- ───────────── Deployments (staging and production) ─────────────
-- One in-flight deployment per stage (partial unique index) → two jobs can never overwrite each other.
CREATE TABLE so_deployments (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('staging','production')),
  version_id TEXT NOT NULL REFERENCES so_versions(id),
  expected_current_version_id TEXT,      -- compare-and-swap: what the caller believed was deployed
  kind TEXT NOT NULL CHECK (kind IN ('deploy','rollback')),
  status TEXT NOT NULL CHECK (status IN ('in_progress','verified','failed','aborted','superseded','rolled_back')),
  agent_id TEXT, llm_id TEXT,
  snapshot_prompt_sha256 TEXT,           -- remote prompt before the change
  snapshot_prompt TEXT,                  -- remote prompt before the change (for drift review; never contains customer data)
  snapshot_retell_version INTEGER,
  readback_sha256 TEXT,
  retell_version_after INTEGER,
  published INTEGER,                     -- is_published as read back (publishing is a Retell dashboard step)
  detail TEXT,
  initiated_by TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX uq_so_deployments_inflight ON so_deployments(stage) WHERE status = 'in_progress';
CREATE INDEX idx_so_deployments_stage ON so_deployments(stage, created_at);

-- ───────────── Controlled experiments ─────────────
CREATE TABLE so_experiments (
  id TEXT PRIMARY KEY,
  baseline_version_id TEXT NOT NULL REFERENCES so_versions(id),
  candidate_version_id TEXT NOT NULL REFERENCES so_versions(id),
  candidate_share REAL NOT NULL CHECK (candidate_share > 0 AND candidate_share <= 0.5),
  min_connected_per_arm INTEGER NOT NULL CHECK (min_connected_per_arm >= 100),
  status TEXT NOT NULL CHECK (status IN ('proposed','running','stopped','completed')),
  decision TEXT,
  decision_detail TEXT,
  approved_by TEXT REFERENCES users(id),
  created_by TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE UNIQUE INDEX uq_so_experiments_running ON so_experiments(status) WHERE status = 'running';
