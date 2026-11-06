-- Design-locked frontends: the Founder supplies the design, the AI makes it work.
--
-- Three things this adds, and one it deliberately does not.
--
--   frontend_artifacts  one row per version of an approved frontend a project has received.
--   design_baselines    the frozen, versioned, IMMUTABLE record of how that frontend looks.
--   projects.design_locked / .frontend_state   which projects follow the new workflow, and where they are in it.
--
-- What it does NOT touch is `build_jobs.state`. That state machine is running live projects, and widening its
-- CHECK constraint to carry the new workflow would put every existing build at risk for a dashboard label. The
-- new workflow states live on `projects`, beside the old ones, and `build_jobs.build_phase` already has
-- 'design_locked' from migration 0076.

CREATE TABLE frontend_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  -- Monotonic per project. A later artifact never overwrites an earlier one: §13, "an approved design must not
  -- be silently replaced by a later artifact".
  version INTEGER NOT NULL CHECK (version >= 1),

  source TEXT NOT NULL CHECK (source IN ('upload', 'template', 'repository', 'internal_fixture')),
  -- The uploaded ZIP, as a row in `files`. That is where `scan_status` lives, and the import gate reads it from
  -- there rather than keeping a second copy that could disagree.
  file_id TEXT REFERENCES files(id),
  template_ref TEXT,
  repo_url TEXT,
  repo_commit TEXT,

  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  framework TEXT CHECK (framework IS NULL OR framework IN ('react', 'react-ts', 'vite', 'static')),
  -- The single top-level folder stripped on extraction, when the archive had one.
  archive_root TEXT,
  -- sha256 of the dependency lockfile, so "the same artifact" also means "the same dependency tree".
  lockfile_sha TEXT,

  -- What the scanner said about the FILE, copied here at decision time so the import record is self-contained.
  -- 'skipped_internal' is only ever a repository fixture, and it reads as what it is: not scanned.
  scan_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (scan_status IN ('pending', 'clean', 'infected', 'failed', 'skipped_internal')),

  status TEXT NOT NULL
    CHECK (status IN ('received', 'validating', 'rejected', 'quarantined', 'validated', 'imported', 'superseded')),
  -- The verdict's problems, verbatim, so a rejection can be explained to the person who uploaded it.
  problems_json TEXT NOT NULL DEFAULT '[]',

  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE (project_id, version)
);

CREATE INDEX frontend_artifacts_project ON frontend_artifacts (project_id, version DESC);
CREATE INDEX frontend_artifacts_status ON frontend_artifacts (status, created_at DESC);

CREATE TABLE design_baselines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES frontend_artifacts(id),
  version INTEGER NOT NULL CHECK (version >= 1),

  -- One value naming this exact design: sha256 over every page's canonical signature.
  fingerprint TEXT NOT NULL,
  -- sha256 over the frontend SOURCE that produced it (runner/src/orchestrator/repair-effect.ts).
  source_fingerprint TEXT,
  lockfile_sha TEXT,

  -- §4's manifests. JSON because each is a list the runner produced and the platform only reads back.
  route_manifest_json TEXT NOT NULL DEFAULT '[]',
  asset_manifest_json TEXT NOT NULL DEFAULT '[]',
  component_inventory_json TEXT NOT NULL DEFAULT '[]',
  interaction_inventory_json TEXT NOT NULL DEFAULT '[]',
  -- The locked design itself: skeleton, palette, fonts, type scale and frame, per page and viewport.
  signatures_json TEXT NOT NULL DEFAULT '[]',
  -- Desktop, tablet and mobile screenshots, and the interaction states (an open menu, a focused form).
  screenshots_json TEXT NOT NULL DEFAULT '[]',
  states_json TEXT NOT NULL DEFAULT '[]',
  viewports_json TEXT NOT NULL DEFAULT '[]',

  -- Approval is a person's act. A baseline with no approver is a draft, whatever else it holds.
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'superseded', 'rolled_back')),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  approval_note TEXT,
  -- Set when a later approved baseline replaced this one; the row itself is never rewritten.
  superseded_by TEXT REFERENCES design_baselines(id),
  superseded_at TEXT,

  created_at TEXT NOT NULL,

  UNIQUE (project_id, version),
  -- An approved baseline must name who approved it and when. This is the column that stops a build from
  -- claiming a design was signed off when nothing did the signing off.
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE INDEX design_baselines_project ON design_baselines (project_id, version DESC);
CREATE UNIQUE INDEX design_baselines_one_approved
  ON design_baselines (project_id) WHERE status = 'approved';

-- Immutability, enforced here rather than promised in a comment.
--
-- Once a baseline leaves 'draft', the design it records can never be edited: a changed frontend gets a NEW
-- version. Only the lifecycle columns stay writable, so a baseline can still be approved, superseded or rolled
-- back without its content ever moving.
CREATE TRIGGER design_baselines_immutable
BEFORE UPDATE OF
  fingerprint, source_fingerprint, lockfile_sha, artifact_id, version,
  route_manifest_json, asset_manifest_json, component_inventory_json, interaction_inventory_json,
  signatures_json, screenshots_json, states_json, viewports_json
ON design_baselines
FOR EACH ROW WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'a design baseline is immutable once it leaves draft; record a new version instead');
END;

-- An approved baseline is never deleted. Recovering the approved original is the whole point of §4, and a
-- rollback that found the row gone would have nothing to restore.
CREATE TRIGGER design_baselines_no_delete
BEFORE DELETE ON design_baselines
FOR EACH ROW WHEN OLD.status IN ('approved', 'superseded', 'rolled_back')
BEGIN
  SELECT RAISE(ABORT, 'an approved design baseline cannot be deleted; supersede it instead');
END;

-- Which projects follow the new architecture, and where they are in it.
--
-- `design_locked = 1` is also the gate that keeps a project out of the retired autonomous design pipeline
-- (§15 Phase D). Existing projects default to 0 and are entirely unaffected.
ALTER TABLE projects ADD COLUMN design_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN frontend_state TEXT;
ALTER TABLE projects ADD COLUMN active_baseline_id TEXT REFERENCES design_baselines(id);

CREATE INDEX projects_design_locked ON projects (design_locked, frontend_state);
