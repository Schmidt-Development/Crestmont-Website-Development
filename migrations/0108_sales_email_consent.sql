-- Marketing-email eligibility (Owner decision 2026-11-13, option a; src/services/sales-email-consent.ts).
--
-- The commercial template sales_info may only be sent to an address the RECIPIENT confirmed themselves: stated on an
-- outbound AI sales call (recorded by update_outbound_lead once the CRM intake confirms the address belongs to the
-- dialled contact) or submitted by the person on an inbound form (/contact, /quote, /api/leads). An address whose only
-- source is research data (Overture / OSM / Foursquare harvest, crm-import) has no row here and is never mailed
-- sales_info. One row per address, source and reference (the sales call for call_confirmed, the lead for inbound_form).
-- Existing sales_lead_profiles.verified_email values are deliberately NOT backfilled: they lack the call/time evidence,
-- so those prospects are asked to confirm their address again on their next call.
CREATE TABLE sales_email_consents (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,                 -- lower-cased
  source TEXT NOT NULL CHECK (source IN ('call_confirmed','inbound_form')),
  ref TEXT NOT NULL,                   -- call_confirmed: sales_calls.id; inbound_form: leads.id
  lead_id TEXT,
  contact_id TEXT,
  sales_call_id TEXT,                  -- call_confirmed: Crestmont's sales call
  provider_call_id TEXT,               -- call_confirmed: Retell call id
  channel TEXT,                        -- inbound_form: web_form | quote_form | api_lead
  evidence TEXT NOT NULL,              -- how it was confirmed, in plain words
  confirmed_at TEXT NOT NULL,
  UNIQUE (email, source, ref)
);
CREATE INDEX idx_sales_email_consents_email ON sales_email_consents(email);

-- Extra RFC 5322 headers for a stored message (JSON object), so a retry re-sends the List-Unsubscribe /
-- List-Unsubscribe-Post headers of a sales_info email exactly as first queued. NULL for every other message.
ALTER TABLE email_messages ADD COLUMN headers_json TEXT;
