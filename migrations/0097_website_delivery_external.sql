-- Website Delivery: externally hosted websites, numbered versions, and archiving.
--
-- WHY A REBUILD. Migration 0096 made a delivery mean exactly one thing: a stored AI-build snapshot, named by
-- (job, attempt, cycle), all NOT NULL. A website that was built by hand, by an outside developer or with any other
-- tool and is already hosted somewhere has no build job and no revision -- and inventing a fake job to satisfy
-- those columns would put a website on a customer's project with a provenance it never had. SQLite cannot relax a
-- NOT NULL or widen a CHECK in place, so the table is rebuilt once, with every existing row copied unchanged.
--
-- WHAT IS NEW.
--   source        'ai_build' (the existing behaviour, preview served by the signed /build-preview capability) or
--                 'external_url' (a website hosted elsewhere, opened in a new tab; never framed or proxied).
--                 A CHECK ties each source to its own columns, so neither can masquerade as the other.
--   version       1, 2, 3 ... per project. Every replacement and every restore is a NEW row with the next number;
--                 historical rows are never rewritten, and each version carries its own customer decision.
--   website_name  The human-readable title staff gave it.
--   website_url   The external HTTPS address (external_url only). Validated by the application before it is
--                 stored (https only, no credentials, no private or internal hosts); the CHECK here is a backstop.
--   assigned_to   The staff member responsible for this delivery.
--   archived_*    Withdrawn from the customer without a replacement. An archived row is history, like a
--                 superseded one, so it frees the "one live delivery per project" slot.
--   restored_from Which earlier version a restore copied.
--   customer_decided_by  Who, on the customer's side, made the decision.
--   updated_at    Last change to the row, for the dashboard.
--
-- EXISTING ROWS keep their ids, columns and meaning. They become source = 'ai_build', are numbered per project in
-- the order they were assigned, and take updated_at from their most recent recorded event.
--
-- The table references itself (superseded_by, restored_from). Those references are written against the NEW table's
-- temporary name, so dropping the old table never touches them; renaming the table rewrites them to the final name
-- (ALTER TABLE ... RENAME updates every reference to the renamed table, its own included). Foreign-key checks are
-- also deferred to the end of the migration's transaction, as a belt-and-braces measure for D1.

PRAGMA defer_foreign_keys = true;

CREATE TABLE website_deliveries_v2 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),

  source TEXT NOT NULL DEFAULT 'ai_build' CHECK (source IN ('ai_build', 'external_url')),
  version INTEGER NOT NULL CHECK (version >= 1),
  website_name TEXT,
  website_url TEXT,

  -- ai_build only.
  job_id TEXT REFERENCES build_jobs(id),
  source_project_id TEXT REFERENCES projects(id),
  revision_attempt INTEGER,
  revision_cycle INTEGER,
  artifact_id TEXT REFERENCES frontend_artifacts(id),
  baseline_id TEXT REFERENCES design_baselines(id),
  contract_id TEXT REFERENCES design_locked_contracts(id),

  status TEXT NOT NULL CHECK (status IN (
    'assigned', 'customer_visible', 'review_requested', 'revision_requested', 'approved', 'delivered', 'superseded', 'archived'
  )),

  assigned_by TEXT NOT NULL REFERENCES users(id),
  assigned_at TEXT NOT NULL,
  assigned_to TEXT REFERENCES users(id),
  visible_at TEXT,
  visible_by TEXT REFERENCES users(id),
  customer_reviewed_at TEXT,
  customer_decision TEXT CHECK (customer_decision IS NULL OR customer_decision IN ('approved', 'revision_requested')),
  customer_note TEXT,
  customer_decided_by TEXT REFERENCES users(id),

  superseded_by TEXT REFERENCES website_deliveries_v2(id),
  superseded_at TEXT,
  archived_at TEXT,
  archived_by TEXT REFERENCES users(id),
  restored_from TEXT REFERENCES website_deliveries_v2(id),
  -- Staff-only internal notes. Never rendered in the customer portal.
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (visible_at IS NULL OR visible_by IS NOT NULL),
  -- Each source has its own columns, and only those.
  CHECK (
    (source = 'ai_build'
      AND job_id IS NOT NULL AND source_project_id IS NOT NULL
      AND revision_attempt IS NOT NULL AND revision_cycle IS NOT NULL
      AND website_url IS NULL)
    OR
    (source = 'external_url'
      AND website_url IS NOT NULL AND substr(website_url, 1, 8) = 'https://'
      AND website_name IS NOT NULL
      AND job_id IS NULL AND source_project_id IS NULL
      AND revision_attempt IS NULL AND revision_cycle IS NULL
      AND artifact_id IS NULL AND baseline_id IS NULL AND contract_id IS NULL)
  ),
  -- Archived is history: it is no longer live, and somebody did it.
  CHECK (status <> 'archived' OR (archived_at IS NOT NULL AND archived_by IS NOT NULL AND superseded_at IS NOT NULL))
);

INSERT INTO website_deliveries_v2 (
  id, project_id, organization_id, source, version, website_name, website_url,
  job_id, source_project_id, revision_attempt, revision_cycle, artifact_id, baseline_id, contract_id,
  status, assigned_by, assigned_at, assigned_to, visible_at, visible_by,
  customer_reviewed_at, customer_decision, customer_note, customer_decided_by,
  superseded_by, superseded_at, archived_at, archived_by, restored_from, note, created_at, updated_at
)
SELECT
  id, project_id, organization_id, 'ai_build',
  ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY assigned_at, created_at, id),
  NULL, NULL,
  job_id, source_project_id, revision_attempt, revision_cycle, artifact_id, baseline_id, contract_id,
  status, assigned_by, assigned_at, assigned_by, visible_at, visible_by,
  customer_reviewed_at, customer_decision, customer_note, NULL,
  superseded_by, superseded_at, NULL, NULL, NULL, note, created_at,
  MAX(created_at, COALESCE(visible_at, ''), COALESCE(customer_reviewed_at, ''), COALESCE(superseded_at, ''))
FROM website_deliveries;

DROP TABLE website_deliveries;
ALTER TABLE website_deliveries_v2 RENAME TO website_deliveries;

-- Same rules as 0096: one live delivery per project; superseded and archived rows are history.
CREATE UNIQUE INDEX website_deliveries_one_active ON website_deliveries (project_id) WHERE superseded_at IS NULL;
-- Version numbers are unique within a project, so "version 2" always names one row.
CREATE UNIQUE INDEX website_deliveries_version ON website_deliveries (project_id, version);
CREATE INDEX website_deliveries_org ON website_deliveries (organization_id, superseded_at);
CREATE INDEX website_deliveries_job ON website_deliveries (job_id, superseded_at);
CREATE INDEX website_deliveries_updated ON website_deliveries (updated_at);
