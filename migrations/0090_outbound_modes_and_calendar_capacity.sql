-- Outbound calling modes, concurrency reservations and calendar capacity (Founder directive 2026-11-06, final master
-- prompt parts 2–6, 9). Numbered 0090: 0089 is reserved for the pre-purchase intake work. ADDITIVE except two index
-- replacements, which keep every row and only change which rows may coexist:
--   * uq_consultations_active_slot (one active booking per start time, across BOTH calendars) becomes a Founder-only
--     exclusivity index plus a five-per-slot capacity rule on the AI Outbound Calendar (trigger, so it is atomic).
--   * uq_sales_calls_open_lead / _phone (one open series per lead / per number) become one open series per lead / per
--     number AND MODE, so a requested callback can be queued while that prospect's sales call is still in progress.
--     Two calls can still never overlap on one number: the outreach-ledger lease (outreach-ledger.ts) is per number.
--
-- Nothing here dials anyone. Two Owner switches decide which mode may dial (src/services/sales-outbound.ts):
--   Scheduled AI Callbacks (callbacks_enabled, launch state ON) and AI Cold Outreach (the existing `enabled`, OFF).
-- Every existing environment and compliance gate still applies on top of them.

-- ───────────── Settings: the two modes and their limits ─────────────
ALTER TABLE sales_outbound_settings ADD COLUMN callbacks_enabled INTEGER NOT NULL DEFAULT 1 CHECK (callbacks_enabled IN (0,1));
-- Founder allocation: at most 15 concurrent cold calls (max_concurrent) and 5 slots reserved for scheduled callbacks.
ALTER TABLE sales_outbound_settings ADD COLUMN callback_reserved INTEGER NOT NULL DEFAULT 5 CHECK (callback_reserved BETWEEN 1 AND 5);
-- Retell's real concurrency limit for the sales workspace, and whether inbound receptionist calls share it. Unknown is
-- treated as shared (the conservative reading) until the Owner records otherwise from the Retell dashboard.
ALTER TABLE sales_outbound_settings ADD COLUMN provider_concurrency_limit INTEGER NOT NULL DEFAULT 20 CHECK (provider_concurrency_limit BETWEEN 1 AND 200);
ALTER TABLE sales_outbound_settings ADD COLUMN inbound_shares_capacity INTEGER NOT NULL DEFAULT 1 CHECK (inbound_shares_capacity IN (0,1));
ALTER TABLE sales_outbound_settings ADD COLUMN inbound_headroom INTEGER NOT NULL DEFAULT 2 CHECK (inbound_headroom BETWEEN 0 AND 20);
-- Cold-outreach ramp (Founder authorises activation and each increase; never automatic). Limits are editable.
ALTER TABLE sales_outbound_settings ADD COLUMN cold_stage TEXT NOT NULL DEFAULT 'launch' CHECK (cold_stage IN ('launch','pilot','stage_2','stage_3','stage_4','stage_5'));
ALTER TABLE sales_outbound_settings ADD COLUMN cold_stage_limits_json TEXT NOT NULL DEFAULT '{"launch":0,"pilot":10,"stage_2":25,"stage_3":50,"stage_4":100,"stage_5":200}';
ALTER TABLE sales_outbound_settings ADD COLUMN callback_max_per_day INTEGER NOT NULL DEFAULT 200 CHECK (callback_max_per_day BETWEEN 1 AND 1000);
-- The finalized allocation: cold outreach may use up to 15 concurrent calls (it stays OFF until the Owner switches it on,
-- and the launch stage allows 0 calls a day). Only the untouched default of 1 is raised; an Owner's value is kept.
UPDATE sales_outbound_settings SET max_concurrent = 15 WHERE id = 1 AND max_concurrent = 1;

-- ───────────── The queue: which mode a call series belongs to ─────────────
ALTER TABLE sales_calls ADD COLUMN mode TEXT NOT NULL DEFAULT 'cold' CHECK (mode IN ('cold','callback'));
-- The AI Outbound Calendar appointment a callback serves, and the conversation it continues (summary, reason).
ALTER TABLE sales_calls ADD COLUMN appointment_id TEXT REFERENCES consultations(id);
ALTER TABLE sales_calls ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}';
-- Set when a scheduled callback's time passed without a call (callbacks paused, outage): it is never dialled late.
ALTER TABLE sales_calls ADD COLUMN missed_at TEXT;
DROP INDEX IF EXISTS uq_sales_calls_open_lead;
DROP INDEX IF EXISTS uq_sales_calls_open_phone;
CREATE UNIQUE INDEX uq_sales_calls_open_lead_mode ON sales_calls(lead_id, mode) WHERE status IN ('queued','dialing','in_progress');
CREATE UNIQUE INDEX uq_sales_calls_open_phone_mode ON sales_calls(phone_e164, mode) WHERE status IN ('queued','dialing','in_progress');
CREATE INDEX idx_sales_calls_appointment ON sales_calls(appointment_id);
CREATE INDEX idx_sales_calls_mode_due ON sales_calls(mode, status, not_before);

-- ───────────── Concurrency reservations (atomic across overlapping scheduler runs) ─────────────
-- One row per concurrent call a mode may hold: 15 cold, 5 callback. A dial first claims a free row with one
-- conditional UPDATE (src/services/sales-outbound.ts#claimSlot), so two workers can never both take the last slot, and
-- cold outreach can never take a callback row. A row is freed when the call ends, fails, is retried or is swept as
-- stale; an expired reservation can be reclaimed, so a lost webhook never wedges capacity.
CREATE TABLE outbound_call_slots (
  slot_key TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('cold','callback')),
  slot_no INTEGER NOT NULL,
  sales_call_id TEXT,
  reserved_at TEXT,
  expires_at TEXT,
  UNIQUE (mode, slot_no)
);
CREATE UNIQUE INDEX uq_outbound_call_slots_call ON outbound_call_slots(sales_call_id) WHERE sales_call_id IS NOT NULL;
INSERT INTO outbound_call_slots (slot_key, mode, slot_no) VALUES
  ('cold_01','cold',1),('cold_02','cold',2),('cold_03','cold',3),('cold_04','cold',4),('cold_05','cold',5),
  ('cold_06','cold',6),('cold_07','cold',7),('cold_08','cold',8),('cold_09','cold',9),('cold_10','cold',10),
  ('cold_11','cold',11),('cold_12','cold',12),('cold_13','cold',13),('cold_14','cold',14),('cold_15','cold',15),
  ('callback_1','callback',1),('callback_2','callback',2),('callback_3','callback',3),('callback_4','callback',4),('callback_5','callback',5);

-- Dials per business day and mode, counted when a dial is claimed (a retry of the same attempt is not a new dial).
-- The daily limit is enforced by the same conditional upsert that counts, so overlapping runs cannot exceed it.
CREATE TABLE outbound_daily_dials (
  day TEXT NOT NULL,                     -- YYYY-MM-DD in the business time zone
  mode TEXT NOT NULL CHECK (mode IN ('cold','callback')),
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, mode)
);

-- ───────────── Calendars: five per 30-minute slot (AI), exclusive (Founder) ─────────────
DROP INDEX IF EXISTS uq_consultations_active_slot;
-- Founder appointments never overlap: one active Founder booking per start (all slots are aligned 30-minute slots).
CREATE UNIQUE INDEX uq_consultations_founder_slot ON consultations(starts_at) WHERE calendar = 'founder_callback' AND status IN ('requested','confirmed');
-- The same person cannot hold two active bookings for the same time on the same calendar.
CREATE UNIQUE INDEX uq_consultations_calendar_phone_slot ON consultations(calendar, starts_at, phone) WHERE status IN ('requested','confirmed') AND phone IS NOT NULL;
-- AI Outbound Calendar: at most five active bookings per slot. Enforced inside the inserting statement, so concurrent
-- bookings cannot overbook; a fifth booking succeeds and a sixth is refused.
CREATE TRIGGER trg_consultations_ai_capacity_insert BEFORE INSERT ON consultations
  WHEN NEW.calendar = 'ai_follow_up' AND NEW.status IN ('requested','confirmed')
    AND (SELECT COUNT(*) FROM consultations WHERE calendar = 'ai_follow_up' AND starts_at = NEW.starts_at AND status IN ('requested','confirmed')) >= 5
BEGIN
  SELECT RAISE(ABORT, 'ai_follow_up_slot_full');
END;
CREATE TRIGGER trg_consultations_ai_capacity_update BEFORE UPDATE OF status, starts_at, calendar ON consultations
  WHEN NEW.calendar = 'ai_follow_up' AND NEW.status IN ('requested','confirmed')
    AND (OLD.status NOT IN ('requested','confirmed') OR OLD.starts_at <> NEW.starts_at OR OLD.calendar <> NEW.calendar)
    AND (SELECT COUNT(*) FROM consultations WHERE calendar = 'ai_follow_up' AND starts_at = NEW.starts_at AND status IN ('requested','confirmed') AND id <> NEW.id) >= 5
BEGIN
  SELECT RAISE(ABORT, 'ai_follow_up_slot_full');
END;
