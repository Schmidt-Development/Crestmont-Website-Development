-- Auth credentials, tokens, rate limiting, outbound email bodies, quote acceptance, ticket SLA.
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN totp_secret TEXT;            -- base32, set only after confirmation
ALTER TABLE users ADD COLUMN totp_pending_secret TEXT;
ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;

CREATE TABLE auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verify','password_reset')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                    -- login_failed, login_locked, rate_limited, mfa_failed, session_revoked ...
  user_id TEXT,
  email TEXT,
  ip TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_security_events_created ON security_events(created_at);

-- Rendered email content. In development the "outbox" adapter stores mail here instead of sending;
-- those rows are marked provider='dev-outbox' and are never reported as delivered.
CREATE TABLE email_messages (
  delivery_id TEXT PRIMARY KEY REFERENCES email_deliveries(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('resend','dev-outbox')),
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT NOT NULL
);

-- Quote acceptance links for customers who do not have an account yet.
CREATE TABLE quote_access_tokens (
  token_hash TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Uploaded file bytes are kept in R2 (production) or the local disk adapter (development).
CREATE TABLE support_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  staffed_hours TEXT NOT NULL,
  first_response_target_hours INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE business_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_leads_created ON leads(created_at);
CREATE INDEX idx_tickets_updated ON tickets(updated_at);
CREATE INDEX idx_tasks_project ON tasks(project_id, status);
CREATE INDEX idx_messages_project ON messages(project_id, created_at);
CREATE INDEX idx_files_project ON files(project_id);
