-- Delivering a finished website to an EXISTING customer project.
--
-- WHY THIS IS A NEW RECORD RATHER THAN A COLUMN. A build already belongs to a project: `build_jobs.project_id`.
-- But the projects the Artifact Builder runs under are Crestmont's own -- `createTestProject` makes one per
-- upload, in the internal organisation -- so the project a website was BUILT under is not the project a customer
-- bought. Writing the customer's project id onto the build would rewrite its history and lose which artifact,
-- baseline and contract it was actually produced from.
--
-- So delivery is its own fact: this website, this snapshot, delivered to that project, by that person, at that
-- time. The build keeps its own provenance; the customer's project gains a deliverable.
--
-- WHAT IT POINTS AT. The exact immutable snapshot, by (job, attempt, cycle), which is how `build_revisions`
-- already identifies a stored website. Not "the latest revision of that job": a customer who is shown version 3
-- must keep seeing version 3 when the builder produces version 4, and a rollback has to be able to name the one
-- it is rolling back to.
--
-- ASSIGNED IS NOT VISIBLE. Two timestamps, because they are two decisions: staff assign a finished website to a
-- project, and somebody then decides the customer may see it. A website being on a project is not a statement
-- that the customer has been shown it, and neither is a statement that they approved it.
--
-- ONE ACTIVE DELIVERY PER PROJECT, enforced by a partial unique index rather than by hoping. Superseding is how a
-- replacement happens; nothing is deleted, so the previous version stays available for a rollback and the history
-- says who changed it and when.

CREATE TABLE website_deliveries (
  id TEXT PRIMARY KEY,

  -- The customer's EXISTING project, and its organisation. The organisation is stored as well as derivable
  -- because every portal read filters on it, and because an assignment that disagrees with the project's own
  -- organisation is a cross-customer mistake this column makes visible instead of silently plausible.
  project_id TEXT NOT NULL REFERENCES projects(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),

  -- The finished build, and the project it was built under (Crestmont's own, usually).
  job_id TEXT NOT NULL REFERENCES build_jobs(id),
  source_project_id TEXT NOT NULL REFERENCES projects(id),

  -- The exact stored snapshot being delivered. `build_revisions` is keyed by (job_id, attempt, cycle).
  revision_attempt INTEGER NOT NULL,
  revision_cycle INTEGER NOT NULL,

  -- What it was made from, so a delivery can be traced back without re-deriving it from the build.
  artifact_id TEXT REFERENCES frontend_artifacts(id),
  baseline_id TEXT REFERENCES design_baselines(id),
  contract_id TEXT REFERENCES design_locked_contracts(id),

  -- assigned            on a project, not yet shown to the customer
  -- customer_visible    the customer can open it in their portal
  -- review_requested    the customer has been asked to review it
  -- revision_requested  the customer asked for changes
  -- approved            the customer approved it
  -- delivered           handed over
  -- superseded          replaced by a later delivery; kept for history and rollback
  status TEXT NOT NULL CHECK (status IN (
    'assigned', 'customer_visible', 'review_requested', 'revision_requested', 'approved', 'delivered', 'superseded'
  )),

  assigned_by TEXT NOT NULL REFERENCES users(id),
  assigned_at TEXT NOT NULL,
  -- When the customer was first able to see it. NULL means they never have been.
  visible_at TEXT,
  visible_by TEXT REFERENCES users(id),
  -- The customer's own acts, which are never inferred from visibility.
  customer_reviewed_at TEXT,
  customer_decision TEXT CHECK (customer_decision IS NULL OR customer_decision IN ('approved', 'revision_requested')),
  customer_note TEXT,

  superseded_by TEXT REFERENCES website_deliveries(id),
  superseded_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL,

  -- There is deliberately NO unique constraint on (project, job, revision).
  --
  -- The first draft of this table had one, to stop an accidental duplicate, and the audit-proving guard caught
  -- what it actually forbids: a ROLLBACK re-delivers a snapshot this project has had before, by design, and
  -- re-assigning the same finished website after a replacement is an ordinary thing to want. Both insert a
  -- second row with that same tuple, and both would have failed on a constraint violation in production.
  --
  -- What was really wanted is "one LIVE delivery per project", which the partial unique index below says exactly.
  -- Everything else is history, and history repeats itself.

  -- Visibility is a decision, so it has to have been made by somebody.
  CHECK (visible_at IS NULL OR visible_by IS NOT NULL)
);

-- The rule that stops two live websites on one project. A superseded row is history and does not compete.
CREATE UNIQUE INDEX website_deliveries_one_active
  ON website_deliveries (project_id) WHERE superseded_at IS NULL;

-- The portal's own read: everything live for this customer.
CREATE INDEX website_deliveries_org ON website_deliveries (organization_id, superseded_at);
-- And the staff read: what has become of this build.
CREATE INDEX website_deliveries_job ON website_deliveries (job_id, superseded_at);
