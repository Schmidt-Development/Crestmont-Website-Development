-- Retell inbound receptionist: the eight named custom functions (docs/voice/RETELL-INBOUND-FUNCTION-REGISTER.md).
-- Numbered 0055 so it cannot collide with open PRs #66/#67, which renumber their migrations to 0051–0054.
--
-- voice_checkout_links: one row per secure checkout link the receptionist emailed (create_checkout_session).
-- The receptionist never creates a Stripe session itself: the link opens the existing /checkout/<package> flow, where
-- the caller signs in, verifies their email and accepts the agreements before billing.ts creates the Stripe Checkout
-- session. The reference is only ever emailed (never spoken), so check_payment_status needs reference + email.
CREATE TABLE voice_checkout_links (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(id),
  reference TEXT NOT NULL UNIQUE,
  package_id TEXT NOT NULL CHECK (package_id IN ('starter','business','premium')),
  email TEXT NOT NULL,
  lead_id TEXT REFERENCES leads(id),
  is_test INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (call_id, package_id, email)
);
CREATE INDEX idx_voice_checkout_links_email ON voice_checkout_links(email);

-- support_request_ref: the opaque reference create_support_ticket / route_support speaks back. It is the same shape
-- whether the caller matched an account (a ticket) or not (a CRM callback task), so it never reveals account existence.
ALTER TABLE tickets ADD COLUMN voice_request_ref TEXT;
CREATE UNIQUE INDEX idx_tickets_voice_request_ref ON tickets(voice_request_ref) WHERE voice_request_ref IS NOT NULL;
