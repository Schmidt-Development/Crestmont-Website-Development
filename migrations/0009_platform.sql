-- Platform administration, AI operations and AI receptionist (area E).
-- Error log, backup/restore register, voice agent configuration and call events, privacy
-- request processing fields, AI job retry linkage.

-- ───────────── Monitoring (INFRA-006) ─────────────
-- Unhandled server errors recorded by the 500 handler. Messages are truncated and never
-- include request bodies or secrets.
CREATE TABLE app_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  method TEXT,
  status INTEGER NOT NULL DEFAULT 500,
  message TEXT NOT NULL,
  stack TEXT,
  environment TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_app_errors_created ON app_errors(created_at);

-- ───────────── Backup & recovery register (INFRA-006, DOC-002) ─────────────
CREATE TABLE backup_records (
  id TEXT PRIMARY KEY,
  what TEXT NOT NULL,                  -- e.g. "D1 crestmont-staging full export"
  location TEXT NOT NULL,              -- where the artefact is stored
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  method TEXT NOT NULL CHECK (method IN ('d1_export','d1_time_travel_bookmark','r2_versioning','r2_copy','manual_other')),
  taken_at TEXT NOT NULL,
  size_bytes INTEGER,                  -- NULL = unknown
  sha256 TEXT,
  result TEXT NOT NULL CHECK (result IN ('succeeded','failed','partial')),
  verified_by TEXT REFERENCES users(id),
  evidence TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_backup_records_taken ON backup_records(taken_at);

CREATE TABLE restore_tests (
  id TEXT PRIMARY KEY,
  backup_record_id TEXT REFERENCES backup_records(id),
  what TEXT NOT NULL,
  target TEXT NOT NULL,                -- where it was restored to (never production for drills)
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  performed_at TEXT NOT NULL,
  performed_by TEXT NOT NULL REFERENCES users(id),
  verified_by TEXT REFERENCES users(id),
  result TEXT NOT NULL CHECK (result IN ('passed','failed','partial')),
  duration_minutes INTEGER,            -- observed RTO for the drill; NULL = not measured
  data_loss_minutes INTEGER,           -- observed RPO; NULL = not measured
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_restore_tests_performed ON restore_tests(performed_at);

-- ───────────── AI receptionist (VOICE-003..006) ─────────────
CREATE TABLE voice_agent_configs (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE CHECK (version >= 1),
  prompt_text TEXT NOT NULL,
  change_note TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  activated_by TEXT REFERENCES users(id),
  activated_at TEXT
);
CREATE UNIQUE INDEX uq_voice_agent_config_active ON voice_agent_configs(active) WHERE active = 1;

ALTER TABLE calls ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1));
ALTER TABLE calls ADD COLUMN transcript TEXT;             -- stored only when recording_consent = 1
ALTER TABLE calls ADD COLUMN recording_url TEXT;          -- stored only when recording_consent = 1
ALTER TABLE calls ADD COLUMN error TEXT;
ALTER TABLE calls ADD COLUMN agent_config_version INTEGER;
ALTER TABLE calls ADD COLUMN escalated_at TEXT;
ALTER TABLE calls ADD COLUMN created_at TEXT;
CREATE INDEX idx_calls_started ON calls(started_at);

-- Every webhook event and function call per call. UNIQUE(call_id, event_key) gives idempotency
-- for re-delivered events; result_json is replayed to the provider on duplicates.
CREATE TABLE voice_events (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- call_started, call_ended, fn:get_published_pricing, fn:create_lead, ...
  status TEXT NOT NULL CHECK (status IN ('ok','error')),
  detail TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (call_id, event_key)
);
CREATE INDEX idx_voice_events_kind ON voice_events(kind, created_at);

-- ───────────── Privacy (SEC-006) ─────────────
ALTER TABLE privacy_requests ADD COLUMN processed_by TEXT REFERENCES users(id);
ALTER TABLE privacy_requests ADD COLUMN notes TEXT;
CREATE INDEX idx_privacy_requests_status ON privacy_requests(status, created_at);

-- ───────────── AI operations (AIOPS-001) ─────────────
ALTER TABLE ai_jobs ADD COLUMN retry_of TEXT REFERENCES ai_jobs(id);
-- Prompt retained for jobs started through retry-capable paths, so a failed job can be re-run
-- without reconstructing input. Contains the same business data the job was given.
CREATE TABLE ai_job_inputs (
  job_id TEXT PRIMARY KEY REFERENCES ai_jobs(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_e_ai_jobs_status ON ai_jobs(status, created_at);
CREATE INDEX idx_e_email_deliveries_status ON email_deliveries(status, created_at);
CREATE INDEX idx_e_audit_logs_created ON audit_logs(created_at);
CREATE INDEX idx_e_audit_logs_action ON audit_logs(action);

-- ───────────── Integration health (§36) ─────────────
-- Fingerprint (truncated SHA-256) of the configuration that was probed; a changed key drops the
-- previous verification. verified_at is set only by a successful provider call.
ALTER TABLE integration_health ADD COLUMN config_fingerprint TEXT;
ALTER TABLE integration_health ADD COLUMN verified_at TEXT;
