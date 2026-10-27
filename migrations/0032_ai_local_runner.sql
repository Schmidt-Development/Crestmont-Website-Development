-- Self-hosted AI drafts (AIOPS-002 / SUP-004 without a paid API): queued ai_jobs are leased to the build runner,
-- which calls the local model and returns the draft for human approval.
CREATE TABLE ai_job_leases (
  job_id TEXT PRIMARY KEY REFERENCES ai_jobs(id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_ai_jobs_queue ON ai_jobs(status, provider, created_at);
