-- AI Build preview: an immutable snapshot of the generated website at each meaningful revision.
--
-- WHY. Until now the only build artifact in storage was the checkpoint archive (builds/<job>/ckpt-N.tgz), whose
-- payload is a git bundle: the Founder could read a cycle's metadata in build_cycles but could not SEE the website
-- that cycle produced without opening Node 1 and finding the workspace. These tables hold the rendered frontend of
-- each revision, so every cycle stays inspectable after the build has moved on -- including a revision the repair
-- ratchet reverted, which is exactly the one that would otherwise be lost.
--
-- Immutability is the point: a later cycle NEVER overwrites an earlier snapshot. (job_id, attempt, cycle) is unique
-- and rows are inserted, not updated, so "the latest preview" cannot destroy the evidence of what came before.
--
-- The generated backend is deliberately NOT stored or executed here. Only static frontend files are kept, and they
-- are served with a sandboxing Content-Security-Policy, so untrusted generated code can never run with a staff
-- session's privileges. What the backend actually does is evidenced by the runner's own gates and persistence check.

CREATE TABLE build_revisions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES build_jobs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  -- Which cycle produced it. Cycle 0 is the first generated revision, before any review.
  cycle INTEGER NOT NULL CHECK (cycle >= 0),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  phase TEXT NOT NULL CHECK (phase IN ('build', 'repair', 'final')),
  commit_sha TEXT,
  -- The quality score this revision measured, when a scorecard was computed for it.
  score REAL,
  -- The reviewer/platform decision recorded for the cycle, for the history view.
  decision TEXT,
  -- Ratchet state, reported by the runner: the best verified revision so far, and one it rolled back.
  is_best INTEGER NOT NULL DEFAULT 0 CHECK (is_best IN (0, 1)),
  reverted INTEGER NOT NULL DEFAULT 0 CHECK (reverted IN (0, 1)),
  -- Why it was reverted, in the runner's words, so the Founder sees the reason and not just the fact.
  reverted_reason TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, attempt, cycle)
);
CREATE INDEX idx_build_revisions_job ON build_revisions(job_id, attempt, cycle);
CREATE INDEX idx_build_revisions_project ON build_revisions(project_id, created_at);

-- One row per file in the snapshot. The path is the website-relative path ("index.html",
-- "assets/site.css", ".crestmont/screenshots/home-desktop.png"); storage_key is where the bytes live.
CREATE TABLE build_revision_files (
  revision_id TEXT NOT NULL REFERENCES build_revisions(id),
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('page', 'asset', 'screenshot')),
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  PRIMARY KEY (revision_id, path)
);
CREATE INDEX idx_build_revision_files_kind ON build_revision_files(revision_id, kind);
