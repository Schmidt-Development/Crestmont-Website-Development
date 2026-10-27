-- UX workstream: UTM attribution on leads (CRM-001) and time-limited signed share links (SEC-003).

-- First-party campaign attribution captured by the public lead forms. All optional; NULL = not known
-- (direct visit, no campaign parameters, or referrer withheld because of Do-Not-Track / GPC).
ALTER TABLE leads ADD COLUMN utm_source TEXT;
ALTER TABLE leads ADD COLUMN utm_medium TEXT;
ALTER TABLE leads ADD COLUMN utm_campaign TEXT;
ALTER TABLE leads ADD COLUMN utm_term TEXT;
ALTER TABLE leads ADD COLUMN utm_content TEXT;
ALTER TABLE leads ADD COLUMN referrer TEXT;
ALTER TABLE leads ADD COLUMN landing_page TEXT;
CREATE INDEX idx_leads_utm ON leads(utm_source, utm_medium, utm_campaign);

-- Share links: only the SHA-256 of the random token is stored; the token itself is shown once.
CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  file_id TEXT NOT NULL REFERENCES files(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  unscanned_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (unscanned_acknowledged IN (0,1)),
  note TEXT,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id),
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT
);
CREATE INDEX idx_share_links_file ON share_links(file_id);
