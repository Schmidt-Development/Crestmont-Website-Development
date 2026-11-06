-- Founder Calendar ↔ Google Calendar (Founder directive 2026-11-06, priority 1). ADDITIVE ONLY.
--
-- The internal Founder Calendar (consultations, calendar = 'founder_callback') stays the booking record. Google Calendar
-- is the external availability source (free/busy of the Founder's primary + the dedicated calendar) and the place the
-- Founder sees each appointment. Nothing here stores the content of the Founder's personal events.

-- One connection per environment. The refresh token is sealed with AES-GCM (src/lib/totp-secrets.ts sealWithKey,
-- MFA_ENCRYPTION_KEY) and never shown or logged.
CREATE TABLE google_calendar_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_email TEXT NOT NULL,
  refresh_token_sealed TEXT NOT NULL,
  scopes TEXT NOT NULL,
  calendar_id TEXT,                       -- the dedicated "Crestmont — Founder Appointments" calendar
  calendar_created INTEGER NOT NULL DEFAULT 0 CHECK (calendar_created IN (0,1)),
  connected_by TEXT REFERENCES users(id),
  connected_at TEXT NOT NULL,
  last_check_at TEXT,
  last_check_ok INTEGER CHECK (last_check_ok IS NULL OR last_check_ok IN (0,1)),
  last_check_detail TEXT
);

-- Short-lived OAuth state (CSRF + PKCE verifier), bound to the Owner who started the connection.
CREATE TABLE google_oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  code_verifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Per Founder appointment: the mirrored Google event and its sync state (pending → synced | failed, retried by the
-- scheduled job). A stable client-chosen event id means a retry can never create a second event.
ALTER TABLE consultations ADD COLUMN google_event_id TEXT;
ALTER TABLE consultations ADD COLUMN google_sync_status TEXT CHECK (google_sync_status IS NULL OR google_sync_status IN ('pending','synced','failed','not_connected'));
ALTER TABLE consultations ADD COLUMN google_sync_error TEXT;
ALTER TABLE consultations ADD COLUMN google_synced_at TEXT;
ALTER TABLE consultations ADD COLUMN google_sync_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_consultations_google_sync ON consultations(google_sync_status) WHERE calendar = 'founder_callback';
