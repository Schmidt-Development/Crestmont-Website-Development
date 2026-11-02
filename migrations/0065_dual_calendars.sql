-- Dual internal calendars (Founder requirement, 2026-11): every callback, follow-up and consultation the AI receptionist
-- or the outbound AI sales agent records lands on exactly one of two staff-only calendars:
--   ai_follow_up      Calendar A "AI Follow-Up": routine callbacks, follow-up calls, questions, qualification, reminders.
--   founder_callback  Calendar B "Founder Callback": ONLY when the customer explicitly asked to speak with the Founder
--                     (founder_reason = 'customer_requested_founder') or an escalation rule the Founder approved applies
--                     (founder_reason = 'rule:<rule id>', see src/domain/calendars.ts; the approved list starts EMPTY).
-- The routing rules live in src/domain/calendars.ts; this schema only guarantees that a Founder entry always says why
-- and that an AI entry never carries a Founder reason. Existing rows default to ai_follow_up (no reason).
-- Numbered 0065: 0064 is claimed by PR #108 (order maintenance commitment), 0066 by the maintenance activation branch.

-- ───────────── Consultations (time-slot bookings) carry their calendar on the booking row itself ─────────────
-- Written in the same INSERT as the booking, so a booking can never exist without its calendar (or vice versa).
ALTER TABLE consultations ADD COLUMN founder_reason TEXT
  CHECK (founder_reason IS NULL OR founder_reason = 'customer_requested_founder' OR founder_reason GLOB 'rule:[a-z0-9]*');
ALTER TABLE consultations ADD COLUMN calendar TEXT NOT NULL DEFAULT 'ai_follow_up'
  CHECK ((calendar = 'ai_follow_up' AND founder_reason IS NULL) OR (calendar = 'founder_callback' AND founder_reason IS NOT NULL));
CREATE INDEX idx_consultations_calendar ON consultations(calendar, starts_at);

-- ───────────── Callbacks and follow-ups (no fixed slot) ─────────────
-- One row per callback / follow-up the AI recorded. It holds no personal data of its own: the contact comes from the
-- lead, the wording from the linked CRM task, so the existing caller-erasure and privacy flows already cover it.
-- An entry is open while its CRM task is not completed and its sales follow-up (if any) is still open.
CREATE TABLE calendar_callbacks (
  id TEXT PRIMARY KEY,
  calendar TEXT NOT NULL CHECK (calendar IN ('ai_follow_up','founder_callback')),
  founder_reason TEXT CHECK (founder_reason IS NULL OR founder_reason = 'customer_requested_founder' OR founder_reason GLOB 'rule:[a-z0-9]*'),
  kind TEXT NOT NULL CHECK (kind IN ('callback','escalation','support_callback','sales_staff_callback','sales_ai_follow_up')),
  source TEXT NOT NULL CHECK (source IN ('ai_receptionist','ai_sales','staff')),
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  call_id TEXT REFERENCES calls(id),                 -- inbound receptionist call
  provider_call_id TEXT,                            -- outbound sales call (Retell call id)
  sales_followup_id TEXT REFERENCES sales_followups(id),
  task_activity_id TEXT REFERENCES crm_activities(id) ON DELETE CASCADE,
  due_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),
  created_at TEXT NOT NULL,
  CHECK ((calendar = 'ai_follow_up' AND founder_reason IS NULL) OR (calendar = 'founder_callback' AND founder_reason IS NOT NULL))
);
CREATE INDEX idx_calendar_callbacks_calendar ON calendar_callbacks(calendar, due_at);
CREATE INDEX idx_calendar_callbacks_lead ON calendar_callbacks(lead_id);
