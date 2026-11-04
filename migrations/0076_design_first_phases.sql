-- Design-first AI website builder: weighted categories, persisted build phases and a durable design freeze.
--
-- WHY. bld_50e28bbd1cd033ad9ddfad02 revision 1-3 was certified 9.4/10 with a vertically stacked desktop navigation
-- (site.css:109 sets flex-direction: column outside any media query; the min-width:64rem block never resets it) and
-- zero images against a brief asking for licensed photography. It scored 9.4 because 18 of 19 applicable criteria
-- passed and `visual_design` was one binary PASS worth 1/19 of the total. A customer buys the look and a working
-- website, so those are now 40 + 40 of 100 points, scored item by item, and a measured visual defect caps the
-- visual category instead of nudging it.
--
-- ADDITIVE ONLY. Nothing here rewrites a stored score. Existing build_quality rows keep their schema /1 numbers and
-- are identified as legacy by schema_version, which defaults to /1 for every row that already exists -- so the old
-- Junk in the Trunk scorecard stays readable and visible for history, and is never presented as having passed the
-- new weighted visual rubric. build_revisions and build_revision_files are untouched except for new nullable
-- columns: the four stored snapshots keep their exact bytes.
--
-- WHY THE PHASE IS A COLUMN AND NOT A VARIABLE. The design freeze has to survive a runner restart, a container
-- replacement, a GPU model change, a checkpoint restore, a paused and resumed build and multi-segment execution.
-- An in-memory flag survives none of those, and a build that forgets it froze its design re-enters the design phase
-- and spends GPU time redesigning a certified website.

-- ── The build's phase, persisted on the job ───────────────────────────────────────────────────────────────────────
-- 'design' is the correct default for a new job AND for every historical one: a build that predates this migration
-- never passed a design gate, so claiming any later phase for it would be a backfilled fiction.
ALTER TABLE build_jobs ADD COLUMN build_phase TEXT NOT NULL DEFAULT 'design'
  CHECK (build_phase IN ('design', 'design_locked', 'functionality', 'final_qa', 'waiting', 'complete'));
-- The freeze that is currently authoritative for this job (build_design_freezes.id), or NULL when none is. Declared
-- without a REFERENCES clause deliberately: SQLite resolves a foreign key at write time, and this column is added
-- before the table it points at exists, so a declared constraint here would depend on statement order inside one
-- migration. The relationship is enforced in services/build-phases.ts, which is the only writer.
ALTER TABLE build_jobs ADD COLUMN design_freeze_id TEXT;

-- ── Weighted scorecard columns on build_quality ───────────────────────────────────────────────────────────────────
-- score/applicable/passed stay exactly as they are for schema /1 rows. For /2 rows `score` carries the overall
-- out of 10 (totalPoints / 10) so every existing reader keeps working, and the category points are new columns.
ALTER TABLE build_quality ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'crestmont.quality-scorecard/1';
ALTER TABLE build_quality ADD COLUMN build_phase TEXT;
ALTER TABLE build_quality ADD COLUMN design_points REAL;
ALTER TABLE build_quality ADD COLUMN functionality_points REAL;
ALTER TABLE build_quality ADD COLUMN other_points REAL;
ALTER TABLE build_quality ADD COLUMN total_points REAL;
-- The per-item rubric, the measured hard visual failures, the evidenced viewports and the review's provenance.
ALTER TABLE build_quality ADD COLUMN rubric_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE build_quality ADD COLUMN design_certified INTEGER NOT NULL DEFAULT 0 CHECK (design_certified IN (0, 1));
-- Why the design is not certified, in the platform's own words (never the model's).
ALTER TABLE build_quality ADD COLUMN design_blockers_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX idx_build_quality_schema ON build_quality(job_id, schema_version, created_at);

-- ── The design freeze ─────────────────────────────────────────────────────────────────────────────────────────────
-- One row per certification. Rows are inserted, never updated in place except to record invalidation, so the
-- history of what was frozen when stays intact and a later cycle cannot quietly rewrite an earlier certification.
CREATE TABLE build_design_freezes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES build_jobs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  -- The stored snapshot that holds the approved design (build_revisions.attempt / .cycle).
  revision_attempt INTEGER NOT NULL,
  revision_cycle INTEGER NOT NULL,
  -- The immutable checkpoint: the commit whose tree IS the approved design.
  commit_sha TEXT,
  design_points REAL NOT NULL CHECK (design_points >= 0 AND design_points <= 40),
  -- The full rubric, per-item, with the reviewer's own notes: the evidence the certification rests on.
  rubric_json TEXT NOT NULL,
  -- Which viewports were evidenced, and the screenshot paths inside the snapshot.
  viewports_json TEXT NOT NULL DEFAULT '[]',
  screenshots_json TEXT NOT NULL DEFAULT '[]',
  -- sha256 of the frontend source and assets that produced it, so a later cycle can tell whether the design moved.
  source_fingerprint TEXT,
  -- Gallery references whose images a vision model actually saw (design_reference_uses.model_saw), by id.
  design_references_json TEXT NOT NULL DEFAULT '[]',
  -- The reviewer that certified it, named rather than "the AI", and whether it genuinely received images.
  reviewer TEXT NOT NULL,
  reviewer_model TEXT,
  images_seen INTEGER NOT NULL DEFAULT 0,
  certified_at TEXT NOT NULL,
  -- 1 only once the PLATFORM has re-verified the scorecard the certification came from. A runner saying 40/40 is
  -- not a design freeze; this column is what the functionality phase gate actually reads.
  platform_verified INTEGER NOT NULL DEFAULT 0 CHECK (platform_verified IN (0, 1)),
  -- Set when later work changed the frozen presentation and the design no longer certifies.
  invalidated_at TEXT,
  invalidated_reason TEXT,
  UNIQUE (job_id, attempt, revision_attempt, revision_cycle)
);
CREATE INDEX idx_build_design_freezes_job ON build_design_freezes(job_id, certified_at);

-- ── Phase milestones ──────────────────────────────────────────────────────────────────────────────────────────────
-- Reaching a phase is an explicit, durable fact the stall guard may treat as progress, and a resumed job reads its
-- own history here rather than inferring it from scores.
CREATE TABLE build_phase_milestones (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES build_jobs(id),
  attempt INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('design', 'design_locked', 'functionality', 'final_qa', 'waiting', 'complete')),
  -- Which cycle reached it, and the category points at that moment.
  cycle INTEGER,
  design_points REAL,
  functionality_points REAL,
  other_points REAL,
  -- Why the gate opened, or (for a refusal) why it did not.
  reason TEXT NOT NULL,
  blockers_json TEXT NOT NULL DEFAULT '[]',
  entered INTEGER NOT NULL DEFAULT 1 CHECK (entered IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_build_phase_milestones_job ON build_phase_milestones(job_id, created_at);

-- ── Per-cycle category scores, for the Founder's revision comparison ──────────────────────────────────────────────
ALTER TABLE build_cycles ADD COLUMN build_phase TEXT;
ALTER TABLE build_cycles ADD COLUMN design_points REAL;
ALTER TABLE build_cycles ADD COLUMN functionality_points REAL;
ALTER TABLE build_cycles ADD COLUMN other_points REAL;
-- The ACTIVE phase's own category score: the number the stall guard compares, rather than the overall progress
-- fraction in `score`, which falls when a build improves its design at the cost of unbuilt backend work.
ALTER TABLE build_cycles ADD COLUMN primary_progress REAL;
-- 1 when this cycle completed a rubric item, froze a phase or verified an integration: progress the number may not
-- show yet, and the difference between "converging slowly" and "stalled".
ALTER TABLE build_cycles ADD COLUMN milestone INTEGER NOT NULL DEFAULT 0 CHECK (milestone IN (0, 1));
ALTER TABLE build_cycles ADD COLUMN ratchet_action TEXT;

-- ── Category scores on each stored revision, so revisions stay comparable ─────────────────────────────────────────
-- build_revisions.phase keeps its existing meaning ('build' | 'repair' | 'final': what the cycle was doing) and its
-- CHECK constraint, which cannot be widened without rebuilding the table. The BUILD phase is a separate column.
ALTER TABLE build_revisions ADD COLUMN build_phase TEXT;
ALTER TABLE build_revisions ADD COLUMN design_points REAL;
ALTER TABLE build_revisions ADD COLUMN functionality_points REAL;
ALTER TABLE build_revisions ADD COLUMN other_points REAL;
-- 1 for the snapshot a design freeze points at: the authoritative visual baseline.
ALTER TABLE build_revisions ADD COLUMN is_design_baseline INTEGER NOT NULL DEFAULT 0 CHECK (is_design_baseline IN (0, 1));

-- ── Efficiency metrics per phase ──────────────────────────────────────────────────────────────────────────────────
-- Measured, not estimated. "GPU savings" claimed without these columns would be an architectural expectation
-- presented as a measurement, which is exactly what the quality engine exists to refuse.
CREATE TABLE build_phase_metrics (
  job_id TEXT NOT NULL REFERENCES build_jobs(id),
  attempt INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('design', 'design_locked', 'functionality', 'final_qa', 'waiting', 'complete')),
  inference_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  review_ms INTEGER NOT NULL DEFAULT 0,
  implementation_ms INTEGER NOT NULL DEFAULT 0,
  revisions INTEGER NOT NULL DEFAULT 0,
  reviews INTEGER NOT NULL DEFAULT 0,
  rollbacks INTEGER NOT NULL DEFAULT 0,
  ineffective_repairs INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, attempt, phase)
);
