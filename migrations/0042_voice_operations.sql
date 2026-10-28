-- Retell backend completion (VOICE-003..006): call detail, business hours / transfers / scheduling
-- configuration, consultation bookings, and the consent-gated outbound-call foundation.
-- Numbered 0042: 0040, 0041, 0043-0045 are reserved for other closeout streams (CREST-GAP-053).
-- Every new capability is OFF / unconfigured by default. Nothing here contacts Retell.

-- ───────────── Call detail from Retell's call object ─────────────
ALTER TABLE calls ADD COLUMN to_number TEXT;
ALTER TABLE calls ADD COLUMN duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0);
ALTER TABLE calls ADD COLUMN disconnection_reason TEXT;
-- Environment the call was routed for (inbound webhook / outbound metadata); NULL = not stamped (e.g. dashboard web call).
ALTER TABLE calls ADD COLUMN environment TEXT CHECK (environment IS NULL OR environment IN ('development','staging','production'));
ALTER TABLE calls ADD COLUMN outbound_request_id TEXT;
CREATE INDEX idx_calls_from ON calls(from_number);

-- ───────────── Receptionist operating configuration ─────────────
-- One row. config_json is validated by src/services/voice-settings.ts (the only writer); defaults are
-- "unconfigured" everywhere: no hours, no transfer number, scheduling off, outbound off.
CREATE TABLE voice_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- ───────────── Consultations booked by phone (the platform had no booking store) ─────────────
-- A slot is held while 'requested' or 'confirmed'. The partial unique index makes double-booking the
-- same start time impossible even under concurrent requests; overlap with a different start is checked in code.
CREATE TABLE consultations (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id),
  call_id TEXT REFERENCES calls(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  starts_at TEXT NOT NULL,                 -- UTC ISO
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 10 AND 240),
  timezone TEXT NOT NULL,                  -- business time zone used to offer the slot
  status TEXT NOT NULL CHECK (status IN ('requested','confirmed','cancelled','completed','no_show')),
  confirmation_code TEXT NOT NULL UNIQUE,  -- spoken + emailed; required with the phone to change a booking
  topic TEXT,
  source TEXT NOT NULL CHECK (source IN ('ai_receptionist','staff')),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),
  rescheduled_from TEXT REFERENCES consultations(id),
  cancel_reason TEXT,
  decided_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_consultations_active_slot ON consultations(starts_at) WHERE status IN ('requested','confirmed');
CREATE INDEX idx_consultations_starts ON consultations(starts_at);
CREATE INDEX idx_consultations_lead ON consultations(lead_id);

-- ───────────── Outbound calling foundation (disabled by default) ─────────────
-- Do-not-call list. Kept after a caller-data erasure: honouring an opt-out requires remembering it.
CREATE TABLE voice_dnc (
  phone_e164 TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('caller_request','staff','provider_dnc')),
  detail TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Per-purpose consent to be called. Outbound eligibility requires an unrevoked row for the exact purpose.
CREATE TABLE voice_call_consents (
  id TEXT PRIMARY KEY,
  phone_e164 TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('callback','consultation_reminder','support_followup')),
  source TEXT NOT NULL CHECK (source IN ('caller_request','staff_recorded')),
  evidence TEXT NOT NULL,                  -- e.g. "call:<id>" or the staff note
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  recorded_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_voice_call_consents_phone ON voice_call_consents(phone_e164, purpose);

CREATE TABLE voice_outbound_requests (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('callback','consultation_reminder','support_followup')),
  phone_e164 TEXT NOT NULL,
  contact_name TEXT,
  reason TEXT NOT NULL,
  lead_id TEXT REFERENCES leads(id),
  consultation_id TEXT REFERENCES consultations(id),
  consent_id TEXT REFERENCES voice_call_consents(id),
  status TEXT NOT NULL CHECK (status IN ('pending_approval','approved','dialing','completed','no_answer','failed','cancelled','blocked')),
  status_detail TEXT,
  requested_by TEXT REFERENCES users(id),  -- NULL = created by the platform (e.g. a caller's callback request)
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 3),
  next_attempt_at TEXT,
  provider_call_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,    -- sent to Retell create-phone-call (per attempt suffix)
  cost_microusd INTEGER,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_voice_outbound_status ON voice_outbound_requests(status, next_attempt_at);
CREATE INDEX idx_voice_outbound_phone ON voice_outbound_requests(phone_e164, created_at);
