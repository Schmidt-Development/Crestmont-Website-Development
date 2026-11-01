-- Permanent quality engine (Founder directive "10/10 quality engine", 2026-11-01).
--  * build_quality: every scorecard a runner reports, with the platform's own verification of it. A build whose job
--    requires quality enters internal approval only with a VERIFIED, eligible (10/10) scorecard.
--  * revisions.category: Crestmont's own defects never consume a customer's revision allowance; scope changes go
--    through change orders. The original approved scope stays in project_scopes (versioned).
--  * builder_improvements: reusable causes found by the quality engine become proposals for the builder itself,
--    which change nothing until a person approves them (and then still go through code review and deployment).

ALTER TABLE build_jobs ADD COLUMN quality_required INTEGER NOT NULL DEFAULT 0 CHECK (quality_required IN (0, 1));
ALTER TABLE build_jobs ADD COLUMN starter_ref TEXT;

CREATE TABLE build_quality (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES build_jobs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  attempt INTEGER NOT NULL,
  iteration INTEGER NOT NULL,
  package_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  score REAL NOT NULL CHECK (score >= 0 AND score <= 10),
  applicable INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  waiting_external INTEGER NOT NULL CHECK (waiting_external IN (0, 1)),
  -- The platform's own check of the reported scorecard (structure, evidence, applicability, arithmetic).
  verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
  verification_problems_json TEXT NOT NULL DEFAULT '[]',
  criteria_json TEXT NOT NULL,
  defects_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_build_quality_job ON build_quality(job_id, created_at);
CREATE INDEX idx_build_quality_project ON build_quality(project_id, created_at);

ALTER TABLE revisions ADD COLUMN category TEXT NOT NULL DEFAULT 'customer_revision' CHECK (category IN ('customer_revision', 'builder_defect', 'scope_change'));
ALTER TABLE revisions ADD COLUMN category_reason TEXT;
ALTER TABLE revisions ADD COLUMN category_by TEXT REFERENCES users(id);
ALTER TABLE revisions ADD COLUMN category_at TEXT;
-- What the customer said when submitting: a change request or a report that something does not work as agreed.
ALTER TABLE revisions ADD COLUMN customer_kind TEXT NOT NULL DEFAULT 'change' CHECK (customer_kind IN ('change', 'problem'));

CREATE TABLE builder_improvements (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  defect_class TEXT NOT NULL CHECK (defect_class IN ('starter', 'builder_prompt', 'architecture', 'integration', 'test_coverage', 'deployment', 'security')),
  criterion TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  proposed_fix TEXT NOT NULL,
  regression_test TEXT NOT NULL,
  affected_components TEXT NOT NULL,
  risk TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_job_id TEXT REFERENCES build_jobs(id),
  last_job_id TEXT REFERENCES build_jobs(id),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'implemented')),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_builder_improvements_status ON builder_improvements(status, updated_at);
