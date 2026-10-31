-- Outbound AI sales representative (Retell), numbered 0060: 0051 lead research (#48), 0055 inbound receptionist functions (#68), 0056–0059 AI builder and simulated payments (#66, #67). Additive only. Proposed requirement ids OUTSALES-001..009 (not added to the
-- Founder-approved inventory; tests are tagged with existing VOICE/CRM/SEC/PAY ids meanwhile).
--
-- NOTHING HERE DIALS ANYONE BY ITSELF. A sales call is placed only when every one of these holds, re-checked right
-- before the dial (src/services/sales-outbound.ts#processSalesQueue, src/domain/sales-eligibility.ts):
--   * RETELL_SALES_OUTBOUND = "on" in the environment (separate from RETELL_OUTBOUND, which covers consented follow-ups)
--   * sales_outbound_settings.enabled = 1 with an approved caller number and a dedicated sales agent id
--   * an active, unrevoked compliance approval (Founder + counsel reference) for AI-voice sales outreach (D-14)
--   * documented prior express WRITTEN consent for AI/artificial-voice sales calls to that exact number
--   * a national DNC scrub of that number no older than 31 days with result "clear", and not on voice_dnc
--   * known recipient time zone and line type; inside the conservative recipient-local sales calling window
--   * the Owner's monthly voice budget open; per-number caps and the outreach ledger lease available

-- One row. Starts OFF. Concurrency is capped at Retell's documented pay-as-you-go workspace limit (20) and is shared
-- with the receptionist, so the default is 1.
CREATE TABLE sales_outbound_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  agent_id TEXT,
  from_number TEXT,
  max_concurrent INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrent BETWEEN 1 AND 20),
  max_dials_per_run INTEGER NOT NULL DEFAULT 3 CHECK (max_dials_per_run BETWEEN 1 AND 20),
  max_dials_per_day INTEGER NOT NULL DEFAULT 25 CHECK (max_dials_per_day BETWEEN 1 AND 500),
  max_attempts_per_lead INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts_per_lead BETWEEN 1 AND 3),
  retry_after_hours INTEGER NOT NULL DEFAULT 48 CHECK (retry_after_hours BETWEEN 4 AND 720),
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
INSERT INTO sales_outbound_settings (id, enabled, updated_at) VALUES (1, 0, '2026-10-31T00:00:00.000Z');

-- Founder + counsel approval of the consent design for AI-voice sales calls. Without an active row nothing dials.
CREATE TABLE sales_compliance_approvals (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('ai_voice_sales_outbound')),
  approved_by TEXT NOT NULL REFERENCES users(id),
  counsel_reference TEXT NOT NULL,     -- e.g. counsel memo id / engagement letter reference
  notes TEXT,
  approved_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id)
);
CREATE UNIQUE INDEX uq_sales_compliance_active ON sales_compliance_approvals(scope) WHERE revoked_at IS NULL;

-- Prior express written consent for AI-voice SALES calls to one number (47 CFR 64.1200(f)(9)). Evidence points to the
-- signed record (form id, e-sign reference), never to "it was listed publicly".
CREATE TABLE sales_call_consents (
  id TEXT PRIMARY KEY,
  phone_e164 TEXT NOT NULL,
  lead_id TEXT REFERENCES leads(id),
  consent_type TEXT NOT NULL CHECK (consent_type IN ('prior_express_written')),
  covers_ai_voice INTEGER NOT NULL CHECK (covers_ai_voice = 1),
  line_type TEXT NOT NULL CHECK (line_type IN ('mobile','landline','voip')),
  signer_name TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  disclosure_text TEXT NOT NULL,       -- the exact consent language the person agreed to
  captured_at TEXT NOT NULL,
  recorded_by TEXT REFERENCES users(id),
  recorded_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE INDEX idx_sales_call_consents_phone ON sales_call_consents(phone_e164) WHERE revoked_at IS NULL;

-- Do-not-call registry scrubs (national and state lists). Only a "clear" result within 31 days lets a number be dialled.
CREATE TABLE sales_dnc_scrubs (
  id TEXT PRIMARY KEY,
  phone_e164 TEXT NOT NULL,
  registry TEXT NOT NULL CHECK (registry IN ('national','state')),
  result TEXT NOT NULL CHECK (result IN ('clear','listed')),
  source_ref TEXT NOT NULL,            -- SAN / download id / vendor reference
  checked_at TEXT NOT NULL,
  recorded_by TEXT REFERENCES users(id),
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_sales_dnc_scrubs_phone ON sales_dnc_scrubs(phone_e164, checked_at);

-- The outbound sales queue: one row per dial attempt series for a lead. provider_call_id links Retell's call.
CREATE TABLE sales_calls (
  id TEXT PRIMARY KEY,                 -- scall_…
  lead_id TEXT NOT NULL REFERENCES leads(id),
  phone_e164 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('blocked','queued','dialing','in_progress','completed','failed','cancelled')),
  status_detail TEXT,
  not_before TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  transient_failures INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_call_id TEXT UNIQUE,
  eligibility_json TEXT NOT NULL DEFAULT '[]',
  dynamic_variables_json TEXT NOT NULL DEFAULT '{}',
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('no_answer','voicemail','wrong_number','not_interested','interested','follow_up_requested','consultation_booked','checkout_sent','payment_confirmed','do_not_call','technical_failure','unclassified')),
  outcome_source TEXT,
  disposition TEXT,                    -- the agent's own disposition (update_outbound_lead.sales_outcome)
  disconnection_reason TEXT,
  duration_ms INTEGER,
  cost_microusd INTEGER,
  requested_by TEXT REFERENCES users(id),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finalized_at TEXT
);
CREATE INDEX idx_sales_calls_due ON sales_calls(status, not_before);
CREATE INDEX idx_sales_calls_lead ON sales_calls(lead_id);
-- At most one open series per lead and per number: a second enqueue is refused, never a second dial.
CREATE UNIQUE INDEX uq_sales_calls_open_lead ON sales_calls(lead_id) WHERE status IN ('queued','dialing','in_progress');
CREATE UNIQUE INDEX uq_sales_calls_open_phone ON sales_calls(phone_e164) WHERE status IN ('queued','dialing','in_progress');

-- Sales discovery facts kept beside the CRM lead (one row per lead). The lead itself (stage, interest, notes) stays the
-- system of record; this holds the structured fields the CRM has no column for.
CREATE TABLE sales_lead_profiles (
  lead_id TEXT PRIMARY KEY REFERENCES leads(id),
  verified_contact_name TEXT,
  verified_role TEXT,
  verified_email TEXT,
  service_interests_json TEXT NOT NULL DEFAULT '[]',
  budget_range TEXT,
  purchase_timeline TEXT,
  objections_json TEXT NOT NULL DEFAULT '[]',
  qualification TEXT CHECK (qualification IS NULL OR qualification IN ('unknown','qualified','not_qualified','needs_review')),
  sales_outcome TEXT,
  next_steps TEXT,
  updated_via TEXT,
  updated_at TEXT NOT NULL
);

-- Secure purchase links. The link leads to Crestmont's existing /checkout/<package> flow (sign-in, verified email,
-- agreement acceptance, then Stripe Checkout); only its SHA-256 is stored.
CREATE TABLE sales_checkout_links (
  id TEXT PRIMARY KEY,                 -- slk_…
  lead_id TEXT NOT NULL REFERENCES leads(id),
  package_id TEXT NOT NULL CHECK (package_id IN ('starter','business','premium')),
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  sales_call_id TEXT REFERENCES sales_calls(id),
  provider_call_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  clicked_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_sales_checkout_links_lead ON sales_checkout_links(lead_id);

-- Every sales email (idempotent per lead, kind and day) and prospects who unsubscribed from sales email.
CREATE TABLE sales_emails (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  kind TEXT NOT NULL CHECK (kind IN ('package_information','checkout_link','approved_quote','consultation_confirmation','follow_up','onboarding_instructions')),
  recipient TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  delivery_id TEXT,
  delivery_status TEXT,
  provider_call_id TEXT,
  unsubscribe_token_hash TEXT UNIQUE,  -- SHA-256 of the one-click unsubscribe token in the email footer
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sales_emails_lead ON sales_emails(lead_id, created_at);
CREATE TABLE sales_email_optouts (
  email TEXT PRIMARY KEY,              -- lower-cased
  source TEXT NOT NULL CHECK (source IN ('unsubscribe_link','do_not_contact','staff')),
  created_at TEXT NOT NULL
);

-- Follow-ups agreed on a call (CRM task, consultation or a later AI call). One open follow-up per lead and kind.
CREATE TABLE sales_followups (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  kind TEXT NOT NULL CHECK (kind IN ('staff_callback','consultation','ai_follow_up_call')),
  status TEXT NOT NULL CHECK (status IN ('scheduled','requested','pending_eligibility','completed','cancelled')),
  due_at TEXT,
  consultation_id TEXT,
  sales_call_id TEXT,
  notes TEXT,
  provider_call_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_sales_followups_open ON sales_followups(lead_id, kind) WHERE status IN ('scheduled','requested','pending_eligibility');

-- Idempotency for outbound custom functions (Retell sends no invocation id): one row per call + name + args hash.
CREATE TABLE sales_function_events (
  provider_call_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','error')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider_call_id, event_key)
);
