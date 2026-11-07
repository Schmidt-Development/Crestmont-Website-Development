-- Readiness evidence rollups (READY-013). ADDITIVE: two derived tables, two indexes, one trigger. No existing row changes.
--
-- Staging certification run 42345838991 (2026-11-07) failed BRAND-006: /staff/research, /staff/sales and /staff/quotes
-- returned HTTP 500 at 375px with "D1 DB is overloaded. Too many resources consumed within a 10 second window".
-- Cloudflare's per-statement analytics for that window (Staging D1 analytics run 42349394337) put the readiness evidence
-- queries far ahead of everything else: the per-requirement aggregate in src/readiness/evidence-load.ts (about 400,000
-- rows read per call — every test_evidence row joined to its run) and runSummaries() in readiness-admin.ts (every row
-- of every run in an environment, to show 15). The aggregate is cached per isolate, but every evidence ingest changes
-- the cache key, and each isolate then pays the full scan again — during a certification, evidence arrives while the
-- dashboard sweep runs.
--
-- Both aggregates are monotone over an append-only history (tests/evidence-append-only.test.ts pins that nothing
-- updates or deletes evidence): MAX of times, MIN of row ids, and counts. So they are kept up to date as rows arrive,
-- by a trigger in the same statement as the insert (atomic with the ingest batch), and read in a few hundred rows.
-- An insert skipped by ON CONFLICT DO NOTHING fires no trigger, so duplicates are never counted twice.

CREATE TABLE evidence_rollup (
  requirement_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  source TEXT NOT NULL,
  any_at TEXT NOT NULL,           -- MAX(finished_at) of the group's runs
  ns_at TEXT,                     -- MAX(finished_at) over non-skipped rows
  pass_at TEXT,                   -- MAX(finished_at) over passed rows
  f_id INTEGER,                   -- MIN(test_evidence.id) over failed rows
  p_id INTEGER,                   -- MIN(test_evidence.id) over passed rows
  PRIMARY KEY (requirement_id, environment, source)
);

CREATE TABLE evidence_run_counts (
  run_id TEXT PRIMARY KEY,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0
);

-- Backfill from the existing history: exactly the aggregates the readers used to compute on every load.
INSERT INTO evidence_rollup (requirement_id, environment, source, any_at, ns_at, pass_at, f_id, p_id)
  SELECT te.requirement_id, er.environment, er.source,
         MAX(er.finished_at),
         MAX(CASE WHEN te.outcome <> 'skipped' THEN er.finished_at END),
         MAX(CASE WHEN te.outcome = 'passed' THEN er.finished_at END),
         MIN(CASE WHEN te.outcome = 'failed' THEN te.id END),
         MIN(CASE WHEN te.outcome = 'passed' THEN te.id END)
    FROM test_evidence te JOIN evidence_runs er ON er.id = te.run_id
   GROUP BY te.requirement_id, er.environment, er.source;

INSERT INTO evidence_run_counts (run_id, passed, failed, skipped)
  SELECT te.run_id, SUM(te.outcome = 'passed'), SUM(te.outcome = 'failed'), SUM(te.outcome = 'skipped')
    FROM test_evidence te JOIN evidence_runs er ON er.id = te.run_id
   GROUP BY te.run_id;

-- Kept current from here on. Scalar MAX()/MIN() return NULL if either side is NULL, hence the COALESCEs.
CREATE TRIGGER test_evidence_rollup AFTER INSERT ON test_evidence
BEGIN
  INSERT INTO evidence_rollup (requirement_id, environment, source, any_at, ns_at, pass_at, f_id, p_id)
    SELECT NEW.requirement_id, er.environment, er.source, er.finished_at,
           CASE WHEN NEW.outcome <> 'skipped' THEN er.finished_at END,
           CASE WHEN NEW.outcome = 'passed' THEN er.finished_at END,
           CASE WHEN NEW.outcome = 'failed' THEN NEW.id END,
           CASE WHEN NEW.outcome = 'passed' THEN NEW.id END
      FROM evidence_runs er WHERE er.id = NEW.run_id
    ON CONFLICT (requirement_id, environment, source) DO UPDATE SET
      any_at = MAX(any_at, excluded.any_at),
      ns_at = COALESCE(MAX(ns_at, excluded.ns_at), ns_at, excluded.ns_at),
      pass_at = COALESCE(MAX(pass_at, excluded.pass_at), pass_at, excluded.pass_at),
      f_id = COALESCE(MIN(f_id, excluded.f_id), f_id, excluded.f_id),
      p_id = COALESCE(MIN(p_id, excluded.p_id), p_id, excluded.p_id);
  INSERT INTO evidence_run_counts (run_id, passed, failed, skipped)
    SELECT NEW.run_id, NEW.outcome = 'passed', NEW.outcome = 'failed', NEW.outcome = 'skipped'
      FROM evidence_runs er WHERE er.id = NEW.run_id
    ON CONFLICT (run_id) DO UPDATE SET
      passed = passed + excluded.passed, failed = failed + excluded.failed, skipped = skipped + excluded.skipped;
END;

-- The filtered pass looks rows up by commit and by run time instead of scanning the history.
CREATE INDEX idx_evidence_runs_commit ON evidence_runs(commit_sha);
CREATE INDEX idx_evidence_runs_finished ON evidence_runs(finished_at);
