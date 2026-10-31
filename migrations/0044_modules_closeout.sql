-- Closeout fixes for the Owner, staff and customer modules (CREST-GAP-041, 072, 073, 081). Additive only:
-- new tables, new nullable columns kept current by triggers, and indexes. Existing queries keep working.

-- ── CREST-GAP-041: staff offboarding queue ──
-- When a staff account is disabled, each piece of their open work (task / project assignments, project-manager
-- roles, owned leads, ticket assignments) is recorded here. 'pending' items await reassignment (the work itself is
-- flagged "owner disabled"); 'reassigned' items moved to resolved_to_user_id; 'ended' items were unassigned;
-- 'restored' items went back to the person when the account was re-enabled.
CREATE TABLE offboarding_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('task','project','project_manager','lead','ticket')),
  subject_id TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reassigned','ended','restored')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  resolved_by TEXT REFERENCES users(id),
  resolved_to_user_id TEXT REFERENCES users(id),
  resolved_at TEXT
);
CREATE INDEX idx_offboarding_user ON offboarding_items(user_id, status);
CREATE INDEX idx_offboarding_pending ON offboarding_items(status, created_at);
-- At most one pending item per person and piece of work.
CREATE UNIQUE INDEX idx_offboarding_unique_pending ON offboarding_items(user_id, subject_type, subject_id) WHERE status = 'pending';

-- ── CREST-GAP-072: dismissible notices (e.g. the two-factor reminder for customer administrators) ──
CREATE TABLE user_notice_dismissals (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notice TEXT NOT NULL CHECK (notice IN ('customer_admin_mfa')),
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, notice)
);

-- ── CREST-GAP-073: customer email change with re-verification ──
-- The new address takes effect only when the emailed link is confirmed. Only the SHA-256 of the token is stored.
CREATE TABLE email_change_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_email TEXT NOT NULL,
  new_email TEXT NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX idx_email_change_user ON email_change_requests(user_id, created_at);

-- ── CREST-GAP-081: indexed normalized keys for CRM duplicate detection ──
-- email_norm  = lower(trim(email))
-- phone_norm  = digits of the phone number (common separators removed, US country code dropped), NULL when
--               fewer than 7 digits or when anything other than digits and separators remains
-- name_company_norm = lower(trim(contact name)) || '|' || lower(trim(company name)), whitespace runs collapsed
ALTER TABLE contacts ADD COLUMN email_norm TEXT;
ALTER TABLE contacts ADD COLUMN phone_norm TEXT;
ALTER TABLE contacts ADD COLUMN name_company_norm TEXT;
CREATE INDEX idx_contacts_email_norm ON contacts(email_norm) WHERE email_norm IS NOT NULL;
CREATE INDEX idx_contacts_phone_norm ON contacts(phone_norm) WHERE phone_norm IS NOT NULL;
CREATE INDEX idx_contacts_name_company_norm ON contacts(name_company_norm) WHERE name_company_norm IS NOT NULL;
CREATE INDEX idx_leads_contact ON leads(contact_id);

-- The normalization, written once as views over the raw values so the triggers and the backfill agree.
CREATE VIEW contact_norm_v AS
SELECT c.id,
  NULLIF(lower(trim(c.email)), '') AS email_norm,
  (SELECT CASE WHEN d IS NULL OR d = '' OR d GLOB '*[^0-9]*' THEN NULL
               WHEN length(d) = 11 AND substr(d, 1, 1) = '1' THEN substr(d, 2)
               WHEN length(d) >= 7 THEN d ELSE NULL END
     FROM (SELECT replace(replace(replace(replace(replace(replace(replace(replace(trim(c.phone), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), '/', ''), char(9), '') AS d)) AS phone_norm,
  CASE WHEN NULLIF(trim(c.name), '') IS NULL OR co.name IS NULL OR NULLIF(trim(co.name), '') IS NULL THEN NULL
       ELSE replace(replace(replace(replace(lower(trim(replace(replace(c.name, char(9), ' '), char(10), ' '))), '    ', ' '), '   ', ' '), '  ', ' '), '  ', ' ')
         || '|' || replace(replace(replace(replace(lower(trim(replace(replace(co.name, char(9), ' '), char(10), ' '))), '    ', ' '), '   ', ' '), '  ', ' '), '  ', ' ') END AS name_company_norm
FROM contacts c LEFT JOIN companies co ON co.id = c.company_id;

CREATE TRIGGER contacts_norm_ai AFTER INSERT ON contacts BEGIN
  UPDATE contacts SET email_norm = (SELECT email_norm FROM contact_norm_v WHERE id = NEW.id), phone_norm = (SELECT phone_norm FROM contact_norm_v WHERE id = NEW.id),
    name_company_norm = (SELECT name_company_norm FROM contact_norm_v WHERE id = NEW.id) WHERE id = NEW.id;
END;
CREATE TRIGGER contacts_norm_au AFTER UPDATE OF email, phone, name, company_id ON contacts BEGIN
  UPDATE contacts SET email_norm = (SELECT email_norm FROM contact_norm_v WHERE id = NEW.id), phone_norm = (SELECT phone_norm FROM contact_norm_v WHERE id = NEW.id),
    name_company_norm = (SELECT name_company_norm FROM contact_norm_v WHERE id = NEW.id) WHERE id = NEW.id;
END;
CREATE TRIGGER companies_norm_au AFTER UPDATE OF name ON companies BEGIN
  UPDATE contacts SET name_company_norm = (SELECT v.name_company_norm FROM contact_norm_v v WHERE v.id = contacts.id) WHERE company_id = NEW.id;
END;

-- Backfill existing contacts.
UPDATE contacts SET email_norm = (SELECT email_norm FROM contact_norm_v v WHERE v.id = contacts.id), phone_norm = (SELECT phone_norm FROM contact_norm_v v WHERE v.id = contacts.id),
  name_company_norm = (SELECT name_company_norm FROM contact_norm_v v WHERE v.id = contacts.id);
