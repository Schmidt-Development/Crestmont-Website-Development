-- Research worker metric samples, numbered 0064 (0063 is the quality engine). Additive: one new table, one index.
--
-- Why this exists: research_runners keeps only the worker's LATEST status, and research_runner_days only a per-day
-- cumulative total. Neither can answer "what was the throughput in hour 7", "what was the peak sustained hour" or
-- "which period was worst", which is exactly what a 24-hour proof run has to report. The worker already sends every
-- figure needed in its heartbeat (src/services/research.ts#heartbeat); this table keeps them over time.
--
-- One row per runner per 15-minute UTC bucket: the last heartbeat in each bucket wins, so a 60-second heartbeat
-- costs 96 rows per runner per day instead of 1,440. Counters are cumulative for the worker's own day (the worker
-- resumes from a checkpoint after a restart), so a rate is the difference between two samples within the same day.
-- Operational telemetry only: no business names, no phone numbers, no personal data. Pruned after 90 days by the
-- existing scheduled retention job, matching env_metrics.
CREATE TABLE research_runner_samples (
  bucket TEXT NOT NULL,                      -- UTC 15-minute bucket start, 'YYYY-MM-DDTHH:MM'
  runner_id TEXT NOT NULL,
  at TEXT NOT NULL,                          -- heartbeat time of the sample kept for this bucket
  day TEXT NOT NULL,                         -- the worker's own UTC day, so rates are never taken across a reset
  evaluated INTEGER NOT NULL DEFAULT 0 CHECK (evaluated >= 0),
  websites_checked INTEGER NOT NULL DEFAULT 0 CHECK (websites_checked >= 0),
  failed_jobs INTEGER NOT NULL DEFAULT 0 CHECK (failed_jobs >= 0),
  sent INTEGER NOT NULL DEFAULT 0 CHECK (sent >= 0),
  records_per_hour INTEGER NOT NULL DEFAULT 0 CHECK (records_per_hour >= 0),  -- the worker's own rolling 1-hour count
  queue_depth INTEGER NOT NULL DEFAULT 0 CHECK (queue_depth >= 0),
  outbox_depth INTEGER NOT NULL DEFAULT 0 CHECK (outbox_depth >= 0),
  in_flight INTEGER NOT NULL DEFAULT 0 CHECK (in_flight >= 0),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
  auth_failed INTEGER NOT NULL DEFAULT 0 CHECK (auth_failed IN (0,1)),
  -- Host resources as the worker measured them (resources.ts). NULL = not reported by that worker.
  cpu_pct INTEGER,
  ram_used_gb REAL,
  ram_total_gb REAL,
  rss_mb INTEGER,
  disk_free_gb INTEGER,
  gpu_util_pct INTEGER,                      -- NULL when the machine has no NVIDIA GPU
  gpu_mem_used_mb INTEGER,
  gpu_name TEXT,
  -- Optional drafting, kept apart from the pipeline: it never gates evaluation or delivery.
  drafts_pending INTEGER,
  drafts_done INTEGER,
  drafts_dropped INTEGER,
  drafts_deferrals INTEGER,                  -- times a draft stood down for the Website Builder's GPU
  PRIMARY KEY (bucket, runner_id)
);
CREATE INDEX idx_research_samples_at ON research_runner_samples(at);
