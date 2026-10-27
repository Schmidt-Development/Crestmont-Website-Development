-- Owner command-center modules: persistence for workflows the module pages require.

-- CRM duplicate detection and merge (CRM-002, CRM-005). A merged lead is kept (history, quotes and
-- audit stay intact) but points at the surviving lead and is archived; it is excluded from
-- duplicate detection and pipeline counts.
ALTER TABLE leads ADD COLUMN merged_into_lead_id TEXT REFERENCES leads(id);
ALTER TABLE leads ADD COLUMN merged_at TEXT;
CREATE INDEX idx_leads_merged ON leads(merged_into_lead_id);

-- Pairs of leads a person has reviewed and confirmed are NOT duplicates (lead_a < lead_b).
CREATE TABLE crm_duplicate_dismissals (
  lead_a TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  lead_b TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  dismissed_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (lead_a, lead_b),
  CHECK (lead_a < lead_b)
);

-- Quote withdrawal / decline bookkeeping (SALES-002). Status stays within the existing CHECK
-- ('rejected' = withdrawn by Crestmont or declined by the customer); these record who and why.
ALTER TABLE quotes ADD COLUMN closed_reason TEXT;
ALTER TABLE quotes ADD COLUMN closed_by TEXT REFERENCES users(id);
ALTER TABLE quotes ADD COLUMN closed_at TEXT;

-- Employee capacity for workload planning (EMP-003). NULL capacity = not set (utilisation is then
-- shown as unknown, never as 0%).
CREATE TABLE staff_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  job_title TEXT,
  weekly_capacity_minutes INTEGER CHECK (weekly_capacity_minutes IS NULL OR (weekly_capacity_minutes >= 0 AND weekly_capacity_minutes <= 6000)),
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- Project closure record (PM-007, PORTAL-010): who closed the project and the checklist state at
-- the time, kept alongside projects.completed_at.
ALTER TABLE projects ADD COLUMN closed_by TEXT REFERENCES users(id);
ALTER TABLE projects ADD COLUMN closure_notes TEXT;

CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at);
