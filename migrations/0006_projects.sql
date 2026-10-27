-- Projects & customer portal collaboration (area B): internal notes, revision accounting,
-- change-order decisions, customer approval requests, idempotent inactivity notices, handoff text.

-- Internal staff notes share the project thread but are never shown to customers.
ALTER TABLE messages ADD COLUMN internal INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0,1));

-- Every revision round is counted; included = 0 marks rounds beyond the package allowance (billable via change order).
ALTER TABLE revisions ADD COLUMN included INTEGER NOT NULL DEFAULT 1 CHECK (included IN (0,1));
ALTER TABLE revisions ADD COLUMN delivered_at TEXT;
ALTER TABLE revisions ADD COLUMN delivery_notes TEXT;

ALTER TABLE change_orders ADD COLUMN proposed_by TEXT REFERENCES users(id);
ALTER TABLE change_orders ADD COLUMN decided_by TEXT REFERENCES users(id);
ALTER TABLE change_orders ADD COLUMN decided_at TEXT;
ALTER TABLE change_orders ADD COLUMN decision_notes TEXT;

ALTER TABLE tasks ADD COLUMN description TEXT;
ALTER TABLE tasks ADD COLUMN completed_at TEXT;

ALTER TABLE projects ADD COLUMN cancel_reason TEXT;
ALTER TABLE projects ADD COLUMN completed_at TEXT;

ALTER TABLE handoffs ADD COLUMN documentation TEXT;
ALTER TABLE handoffs ADD COLUMN updated_at TEXT;

-- Staff ask the customer for a decision (scope, design, revision, customer_launch, final_acceptance).
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('scope','design','revision','customer_launch','final_acceptance')),
  subject_id TEXT,                 -- e.g. the revision id for kind = 'revision'
  note TEXT,
  requested_by TEXT NOT NULL REFERENCES users(id),
  approval_id TEXT REFERENCES approvals(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_approval_requests_project ON approval_requests(project_id, resolved_at);

-- What the inactivity sweep already did in the current inactivity cycle (cycle_key = last activity timestamp).
CREATE TABLE inactivity_notices (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cycle_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('remind','escalate','pause')),
  seq INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, cycle_key, kind, seq)
);

CREATE INDEX idx_files_org ON files(organization_id, deleted_at);
CREATE INDEX idx_assignments_subject ON assignments(subject_type, subject_id, ended_at);
CREATE INDEX idx_revisions_project ON revisions(project_id);
CREATE INDEX idx_change_orders_project ON change_orders(project_id);
