-- Launch Readiness Command Center schema.
-- Implementation status and verification status are stored separately (§38).

CREATE TABLE requirements (
  id TEXT PRIMARY KEY,
  subsystem TEXT NOT NULL,
  section TEXT NOT NULL,
  title TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('P0','P1','P2')),
  category TEXT NOT NULL CHECK (category IN ('engineering','integration','security','business','founder')),
  owner TEXT,
  implementation_location TEXT,
  implementation_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (implementation_status IN ('not_started','in_progress','implemented')),
  disposition TEXT NOT NULL DEFAULT 'in_scope'
    CHECK (disposition IN ('in_scope','deferred_by_founder','excluded_by_founder')),
  disposition_approval_id TEXT REFERENCES release_approvals(id),
  blocked_reason TEXT,
  requires_founder_approval INTEGER NOT NULL DEFAULT 0,
  inventory_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE requirement_dependencies (
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  PRIMARY KEY (requirement_id, depends_on_id)
);

-- One row per evidence ingestion batch (CI run, staging run, health sweep...).
CREATE TABLE evidence_runs (
  id TEXT PRIMARY KEY,                 -- idempotency key supplied by the producer (e.g. gh run id + attempt)
  source TEXT NOT NULL CHECK (source IN ('ci','staging_e2e','production_check','manual_review','integration_probe')),
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  commit_sha TEXT NOT NULL,
  branch TEXT,
  run_url TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL
);
CREATE INDEX idx_evidence_runs_env ON evidence_runs(environment, finished_at);

CREATE TABLE test_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES evidence_runs(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  test_name TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed','failed','skipped')),
  duration_ms INTEGER,
  message TEXT,
  UNIQUE (run_id, requirement_id, test_name)
);
CREATE INDEX idx_test_evidence_req ON test_evidence(requirement_id);

CREATE TABLE integration_health (
  integration TEXT NOT NULL,           -- stripe, resend, auth, d1, r2, ai, voice, telephony, monitoring, dns, github
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  status TEXT NOT NULL CHECK (status IN ('not_configured','configured_unverified','verified','degraded','failing','blocked')),
  detail TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (integration, environment)
);

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  commit_sha TEXT NOT NULL,
  release_id TEXT REFERENCES releases(id),
  url TEXT,
  initiated_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed','rolled_back')),
  rollback_target_deployment_id TEXT REFERENCES deployments(id),
  deployed_at TEXT NOT NULL
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  config_sha256 TEXT NOT NULL,
  notes TEXT NOT NULL,
  rollback_plan TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE release_approvals (
  id TEXT PRIMARY KEY,
  release_id TEXT REFERENCES releases(id),
  kind TEXT NOT NULL CHECK (kind IN ('production_launch','scope_disposition','security_exception')),
  approver_user_id TEXT NOT NULL,      -- must be the Owner; enforced in application layer + audited
  commit_sha TEXT,
  config_sha256 TEXT,
  evidence_set_sha256 TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  notes TEXT,
  invalidated_at TEXT,
  invalidated_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE security_findings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  release_blocking INTEGER NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','resolved','accepted_risk')),
  resolution_evidence TEXT,
  opened_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE blockers (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('engineering','external_account','security','legal','founder_approval','production_incident')),
  description TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  subsystem TEXT NOT NULL,
  owner TEXT NOT NULL,
  required_action TEXT NOT NULL,
  dependency TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_evidence TEXT
);

CREATE TABLE blocker_requirements (
  blocker_id TEXT NOT NULL REFERENCES blockers(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, requirement_id)
);

CREATE TABLE readiness_snapshots (
  id TEXT PRIMARY KEY,
  taken_at TEXT NOT NULL,
  inventory_version TEXT NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE TABLE ingestion_status (
  source TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT
);
