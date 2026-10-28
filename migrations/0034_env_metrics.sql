-- READY-006: first-party error-rate and latency evidence for the environment views.
-- READY-005: GitHub snapshots pushed by GitHub Actions (workflow token) instead of pulled with a PAT.

-- Per-environment hourly request buckets written by the Worker itself (src/services/env-metrics.ts).
-- One UPSERT per request into the row of (environment, hour, area). No PII: no paths, ids, IPs or
-- user data, only a coarse area (api | staff | portal | live | site) and counters.
CREATE TABLE env_metrics (
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  hour TEXT NOT NULL,                       -- UTC hour bucket, 'YYYY-MM-DDTHH'
  area TEXT NOT NULL CHECK (area IN ('api','staff','portal','live','site')),
  requests INTEGER NOT NULL DEFAULT 0,
  errors_5xx INTEGER NOT NULL DEFAULT 0,    -- responses with status >= 500 (includes intentional 503s)
  unhandled INTEGER NOT NULL DEFAULT 0,     -- unhandled exceptions turned into a 500 by src/app/app.ts
  duration_ms_sum INTEGER NOT NULL DEFAULT 0,
  duration_ms_max INTEGER NOT NULL DEFAULT 0,
  -- Server wall-clock duration histogram (upper bounds in ms): <=100, <=300, <=1000, <=3000, >3000.
  le_100 INTEGER NOT NULL DEFAULT 0,
  le_300 INTEGER NOT NULL DEFAULT 0,
  le_1000 INTEGER NOT NULL DEFAULT 0,
  le_3000 INTEGER NOT NULL DEFAULT 0,
  gt_3000 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (environment, hour, area)
);

-- External response-time samples taken by scripts/production-checks.ts after each deploy and
-- ingested with the evidence document (src/readiness/ingest.ts). Page = fixed public path, never ids.
CREATE TABLE env_latency (
  run_id TEXT NOT NULL REFERENCES evidence_runs(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  page TEXT NOT NULL,
  samples INTEGER NOT NULL,
  failed_samples INTEGER NOT NULL DEFAULT 0,
  p50_ms INTEGER,                           -- NULL when no sample succeeded (shown as Unknown)
  p95_ms INTEGER,
  max_ms INTEGER,
  measured_at TEXT NOT NULL,
  PRIMARY KEY (run_id, page)
);
CREATE INDEX idx_env_latency_env ON env_latency(environment, measured_at);

-- GitHub snapshots: 'pull' = fetched by the Worker with GITHUB_TOKEN; 'push' = posted by GitHub Actions.
ALTER TABLE github_sync ADD COLUMN source TEXT NOT NULL DEFAULT 'pull' CHECK (source IN ('pull','push'));
ALTER TABLE github_sync ADD COLUMN run_url TEXT;
