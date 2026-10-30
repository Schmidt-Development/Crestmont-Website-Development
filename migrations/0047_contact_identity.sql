-- CRM duplicate protection and canonical contact identity (CRM-002, CRM-005, CRM-007, VOICE-005, EMAIL-003).
-- ADDITIVE ONLY: new tables, views, triggers, indexes and nullable columns. No existing row is deleted or merged.
-- Rollback procedure: docs/crm-identity/RUNBOOK.md §6 (docs/crm-identity/rollback-0047.sql).
--
-- Model
--   contact_identities        one row per canonical phone number (E.164) or email address (trim + lowercase only:
--                             no Gmail dot stripping, no plus-address removal). UNIQUE(kind, value_norm) is the
--                             database-level guarantee that an identifier has exactly one canonical identity.
--   contact_identity_links    which contacts use an identity (many-to-many: a shared receptionist line or inbox maps to
--                             one identity linked to several businesses). Original formatting, source, confidence and
--                             verification are kept per link. Removed links keep their history (removed_at).
--   phone_outreach_ledger     one row per dialled/dialable number: attempts, outcome, and the single active lease.
--                             The primary key on phone_e164 plus a conditional UPDATE make reservation atomic.
--   email_outreach_enrollments  UNIQUE(identity, campaign): one enrollment per address per campaign.
--   crm_intake_decisions      every create/link/merge/flag decision with machine-readable outcome, evidence and the
--                             idempotency key (UNIQUE) of the request that produced it.
--   crm_identity_reviews      the founder/staff review queue (possible duplicates, field conflicts, customer matches).
--   crm_field_changes         field-level audit trail for automatic and reviewed merges.
--   crm_import_batches        research-agent / CRM API batches (UNIQUE idempotency key).
--
-- Every write to contacts.email / contacts.phone (all current paths: web forms, receptionist, checkout, manual entry,
-- contact edits, lead merges; and any future path) registers identities through the triggers below, so no write path
-- can bypass identity registration.

-- ───────────── Normalization (single definition shared by triggers and backfill) ─────────────
-- email_key: lower(trim(email)) when it looks like an address, else NULL.
-- phone_key: E.164. "+<digits>" is kept as dialled (8–15 digits, no leading 0); 10 digits → +1 (NANP);
--            11 digits starting with 1 → +<digits>; anything else (letters, extensions, short numbers) → NULL.
--            Mirrors toE164() in src/services/voice-settings.ts and phoneKey() in src/services/contact-identity.ts.
CREATE VIEW contact_identity_norm_v AS
SELECT c.id,
  CASE WHEN c.email IS NOT NULL AND instr(trim(c.email), '@') > 1 AND instr(trim(c.email), ' ') = 0 AND instr(c.email, char(9)) = 0
    AND instr(substr(trim(c.email), instr(trim(c.email), '@') + 2), '.') > 0 THEN lower(trim(c.email)) END AS email_key,
  (SELECT CASE
      WHEN d IS NULL OR d = '' OR d GLOB '*[^0-9]*' THEN NULL
      WHEN substr(trim(c.phone), 1, 1) = '+' THEN CASE WHEN length(d) BETWEEN 8 AND 15 AND substr(d, 1, 1) <> '0' THEN '+' || d END
      WHEN length(d) = 10 THEN '+1' || d
      WHEN length(d) = 11 AND substr(d, 1, 1) = '1' THEN '+' || d
      ELSE NULL END
   FROM (SELECT replace(replace(replace(replace(replace(replace(replace(trim(c.phone), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), char(9), '') AS d)) AS phone_key
FROM contacts c;

-- ───────────── Canonical identities ─────────────
CREATE TABLE contact_identities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('phone','email')),
  value_norm TEXT NOT NULL,
  display_value TEXT NOT NULL,                 -- first formatting seen (links keep every original value)
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','invalid')),
  verified_at TEXT,
  last_verified_at TEXT,
  verified_by TEXT REFERENCES users(id),
  verified_source TEXT,                        -- e.g. 'account_email_verified', 'staff_confirmed', 'inbound_call'
  shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0,1)), -- linked to more than one business (receptionist, franchise HQ)
  first_source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, value_norm)
);
CREATE INDEX idx_contact_identities_shared ON contact_identities(kind, shared);

CREATE TABLE contact_identity_links (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES contact_identities(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  original_value TEXT NOT NULL,                -- as entered, for display
  role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','additional')), -- primary = contacts.email/phone column
  label TEXT CHECK (label IS NULL OR label IN ('main','mobile','office','direct','shared_line','shared_inbox','other')),
  source TEXT NOT NULL,                        -- web_form, quote_form, api_lead, ai_receptionist, manual, referral, checkout, research_agent, crm_api, contact_edit, merge, backfill, contact_write
  source_ref TEXT,                             -- e.g. intake decision id or research record id (never PII)
  confidence INTEGER NOT NULL DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (identity_id, contact_id)
);
CREATE INDEX idx_identity_links_contact ON contact_identity_links(contact_id, removed_at);
CREATE INDEX idx_identity_links_identity ON contact_identity_links(identity_id, removed_at);

-- Recomputes the shared flag of the identities a contact uses: shared = active links to more than one business
-- (company; a contact without a company counts as its own business).
CREATE VIEW contact_identity_business_count_v AS
SELECT l.identity_id, COUNT(DISTINCT COALESCE(c.company_id, 'contact:' || c.id)) AS businesses, COUNT(*) AS contacts
FROM contact_identity_links l JOIN contacts c ON c.id = l.contact_id
WHERE l.removed_at IS NULL GROUP BY l.identity_id;

-- ───────────── Triggers: every contacts write registers identities ─────────────
CREATE TRIGGER contacts_identity_ai AFTER INSERT ON contacts BEGIN
  INSERT INTO contact_identities (id, kind, value_norm, display_value, first_source, created_at, updated_at)
    SELECT 'cid_' || lower(hex(randomblob(12))), 'email', v.email_key, trim(NEW.email), 'contact_write', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM contact_identity_norm_v v WHERE v.id = NEW.id AND v.email_key IS NOT NULL
    ON CONFLICT(kind, value_norm) DO NOTHING;
  INSERT INTO contact_identities (id, kind, value_norm, display_value, first_source, created_at, updated_at)
    SELECT 'cid_' || lower(hex(randomblob(12))), 'phone', v.phone_key, trim(NEW.phone), 'contact_write', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM contact_identity_norm_v v WHERE v.id = NEW.id AND v.phone_key IS NOT NULL
    ON CONFLICT(kind, value_norm) DO NOTHING;
  INSERT INTO contact_identity_links (id, identity_id, contact_id, original_value, role, source, created_at, last_seen_at)
    SELECT 'cil_' || lower(hex(randomblob(12))), ci.id, NEW.id, CASE ci.kind WHEN 'email' THEN trim(NEW.email) ELSE trim(NEW.phone) END, 'primary', 'contact_write',
      strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM contact_identity_norm_v v JOIN contact_identities ci ON (ci.kind = 'email' AND ci.value_norm = v.email_key) OR (ci.kind = 'phone' AND ci.value_norm = v.phone_key)
    WHERE v.id = NEW.id
    ON CONFLICT(identity_id, contact_id) DO UPDATE SET removed_at = NULL, role = 'primary',
      original_value = CASE WHEN contact_identity_links.removed_at IS NOT NULL OR lower(contact_identity_links.original_value) <> lower(excluded.original_value) THEN excluded.original_value ELSE contact_identity_links.original_value END,
      last_seen_at = excluded.last_seen_at; -- (a trailing "END;" here would end the trigger early for scripts/restore-drill.ts)
  UPDATE contact_identities SET shared = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE shared = 0 AND id IN (SELECT b.identity_id FROM contact_identity_business_count_v b JOIN contact_identity_links l ON l.identity_id = b.identity_id WHERE l.contact_id = NEW.id AND b.businesses > 1);
END;

CREATE TRIGGER contacts_identity_au AFTER UPDATE OF email, phone, company_id ON contacts BEGIN
  -- Primary links whose value is no longer on the contact are closed (history kept).
  UPDATE contact_identity_links SET removed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE contact_id = NEW.id AND role = 'primary' AND removed_at IS NULL
      AND identity_id NOT IN (SELECT ci.id FROM contact_identity_norm_v v JOIN contact_identities ci ON (ci.kind = 'email' AND ci.value_norm = v.email_key) OR (ci.kind = 'phone' AND ci.value_norm = v.phone_key) WHERE v.id = NEW.id);
  INSERT INTO contact_identities (id, kind, value_norm, display_value, first_source, created_at, updated_at)
    SELECT 'cid_' || lower(hex(randomblob(12))), 'email', v.email_key, trim(NEW.email), 'contact_edit', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM contact_identity_norm_v v WHERE v.id = NEW.id AND v.email_key IS NOT NULL
    ON CONFLICT(kind, value_norm) DO NOTHING;
  INSERT INTO contact_identities (id, kind, value_norm, display_value, first_source, created_at, updated_at)
    SELECT 'cid_' || lower(hex(randomblob(12))), 'phone', v.phone_key, trim(NEW.phone), 'contact_edit', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM contact_identity_norm_v v WHERE v.id = NEW.id AND v.phone_key IS NOT NULL
    ON CONFLICT(kind, value_norm) DO NOTHING;
  INSERT INTO contact_identity_links (id, identity_id, contact_id, original_value, role, source, created_at, last_seen_at)
    SELECT 'cil_' || lower(hex(randomblob(12))), ci.id, NEW.id, CASE ci.kind WHEN 'email' THEN trim(NEW.email) ELSE trim(NEW.phone) END, 'primary', 'contact_edit',
      strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM contact_identity_norm_v v JOIN contact_identities ci ON (ci.kind = 'email' AND ci.value_norm = v.email_key) OR (ci.kind = 'phone' AND ci.value_norm = v.phone_key)
    WHERE v.id = NEW.id
    ON CONFLICT(identity_id, contact_id) DO UPDATE SET removed_at = NULL, role = 'primary',
      original_value = CASE WHEN contact_identity_links.removed_at IS NOT NULL OR lower(contact_identity_links.original_value) <> lower(excluded.original_value) THEN excluded.original_value ELSE contact_identity_links.original_value END,
      last_seen_at = excluded.last_seen_at; -- (a trailing "END;" here would end the trigger early for scripts/restore-drill.ts)
  UPDATE contact_identities SET shared = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE shared = 0 AND id IN (SELECT b.identity_id FROM contact_identity_business_count_v b JOIN contact_identity_links l ON l.identity_id = b.identity_id WHERE l.contact_id = NEW.id AND b.businesses > 1);
END;

-- Privacy erasure (src/services/privacy.ts, src/services/voice-ops.ts) blanks a contact to 'Deleted contact' with no email
-- or phone. Its identity links, field history and review items go with it; identities left with no link are removed
-- unless the outreach ledger still needs the number (opt-outs must be remembered, as voice_dnc already is).
CREATE TRIGGER contacts_identity_erased AFTER UPDATE OF name ON contacts
WHEN NEW.name = 'Deleted contact' AND NEW.email IS NULL AND NEW.phone IS NULL BEGIN
  DELETE FROM contact_identity_links WHERE contact_id = NEW.id;
  DELETE FROM crm_field_changes WHERE contact_id = NEW.id;
  DELETE FROM crm_identity_reviews WHERE contact_id = NEW.id;
  DELETE FROM contact_identities WHERE NOT EXISTS (SELECT 1 FROM contact_identity_links l WHERE l.identity_id = contact_identities.id)
    AND NOT EXISTS (SELECT 1 FROM phone_outreach_ledger p WHERE p.identity_id = contact_identities.id)
    AND NOT EXISTS (SELECT 1 FROM email_outreach_enrollments e WHERE e.identity_id = contact_identities.id);
END;

-- ───────────── Outbound dial deduplication ledger ─────────────
-- Suppression is NOT copied here: voice_dnc stays the single source of truth and is re-checked at reservation time.
-- A reservation is a lease. It is taken by one conditional UPDATE (free, or lease expired) and released only by
-- completion/cancellation code or recovered by expiry, so a crashed worker cannot hold a number for ever.
CREATE TABLE phone_outreach_ledger (
  phone_e164 TEXT PRIMARY KEY,
  identity_id TEXT REFERENCES contact_identities(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at TEXT,
  last_outcome TEXT,
  retry_after TEXT,                            -- earliest next attempt allowed by the retry policy
  reservation_id TEXT,                         -- NULL = free
  reserved_for_type TEXT CHECK (reserved_for_type IS NULL OR reserved_for_type IN ('voice_outbound_request')),
  reserved_for_id TEXT,
  reserved_purpose TEXT,                       -- the authorized purpose/campaign the lease was taken for
  reserved_at TEXT,
  lease_expires_at TEXT,
  call_state TEXT NOT NULL DEFAULT 'idle' CHECK (call_state IN ('idle','reserved','dialing')),
  active_call_id TEXT,                         -- Retell call id while dialing
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((reservation_id IS NULL AND call_state = 'idle') OR (reservation_id IS NOT NULL AND lease_expires_at IS NOT NULL AND call_state IN ('reserved','dialing')))
);
CREATE INDEX idx_phone_ledger_lease ON phone_outreach_ledger(lease_expires_at) WHERE reservation_id IS NOT NULL;
CREATE INDEX idx_phone_ledger_identity ON phone_outreach_ledger(identity_id);

CREATE TABLE phone_outreach_events (
  id TEXT PRIMARY KEY,
  phone_e164 TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('reserved','denied','dialing','attempt','outcome','released','expired')),
  reservation_id TEXT,
  ref_type TEXT,
  ref_id TEXT,
  purpose TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_phone_events_phone ON phone_outreach_events(phone_e164, created_at);

-- One open outbound request per number: requests are deduplicated at creation by a single guarded INSERT
-- (src/services/voice-outbound.ts); this index makes that lookup cheap.
CREATE INDEX idx_voice_outbound_open_phone ON voice_outbound_requests(phone_e164, status);

-- ───────────── Email campaign enrollment deduplication ─────────────
CREATE TABLE email_outreach_enrollments (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES contact_identities(id),
  campaign_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enrolled','completed','cancelled')),
  lead_id TEXT REFERENCES leads(id),
  enrolled_by TEXT REFERENCES users(id),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (identity_id, campaign_key)
);

-- ───────────── Intake decisions, idempotency and provenance ─────────────
CREATE TABLE crm_import_batches (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,                        -- e.g. 'research-agent'
  api_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,                  -- SHA-256 of the canonical request body
  received INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','completed','partial')),
  counts_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE crm_intake_decisions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('manual','web_form','quote_form','api_lead','ai_receptionist','checkout','research_agent','crm_api','contact_edit')),
  idempotency_key TEXT UNIQUE,                 -- NULL for channels without one
  request_hash TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('CREATED','EXISTING_CONTACT_LINKED','EXISTING_BUSINESS_UPDATED','VERIFIED_DATA_MERGED','POSSIBLE_DUPLICATE_REVIEW','SUPPRESSED','REJECTED_INVALID','NO_CHANGE')),
  lead_id TEXT REFERENCES leads(id),
  contact_id TEXT REFERENCES contacts(id),
  batch_id TEXT REFERENCES crm_import_batches(id),
  actor_user_id TEXT REFERENCES users(id),
  evidence_json TEXT NOT NULL,                 -- identity ids, match reasons, rule ids: never raw contact values
  created_at TEXT NOT NULL
);
CREATE INDEX idx_intake_decisions_outcome ON crm_intake_decisions(outcome, created_at);
CREATE INDEX idx_intake_decisions_lead ON crm_intake_decisions(lead_id);
CREATE INDEX idx_intake_decisions_batch ON crm_intake_decisions(batch_id);

CREATE TABLE crm_identity_reviews (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('possible_duplicate','field_conflict','customer_match','historical_duplicate')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','applied','rejected','created_new','linked')),
  contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,  -- the existing record the item is about
  lead_id TEXT REFERENCES leads(id),
  decision_id TEXT REFERENCES crm_intake_decisions(id),
  field TEXT CHECK (field IS NULL OR field IN ('name','email','phone','company_name','website')),
  current_value TEXT,
  proposed_value TEXT,
  proposed_source TEXT,
  proposed_confidence INTEGER,
  candidate_json TEXT,                         -- a held candidate (possible_duplicate) so a person can create or link it
  reason TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_by TEXT REFERENCES users(id),
  resolved_at TEXT,
  resolution_note TEXT
);
CREATE UNIQUE INDEX idx_identity_reviews_open ON crm_identity_reviews(dedupe_key) WHERE status = 'open';
CREATE INDEX idx_identity_reviews_status ON crm_identity_reviews(status, created_at);
CREATE INDEX idx_identity_reviews_contact ON crm_identity_reviews(contact_id);

CREATE TABLE crm_field_changes (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
  company_id TEXT REFERENCES companies(id),
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source TEXT NOT NULL,
  rule TEXT NOT NULL,                          -- which merge rule allowed it (e.g. 'fill_blank', 'review_applied')
  decision_id TEXT REFERENCES crm_intake_decisions(id),
  review_id TEXT REFERENCES crm_identity_reviews(id),
  actor_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_field_changes_contact ON crm_field_changes(contact_id, created_at);

-- Strong business identity: website domain (lowercase host, leading www. removed) and an optional location, so a
-- multi-location business or a franchise is several companies that share a domain but not a location.
ALTER TABLE companies ADD COLUMN domain_norm TEXT;
ALTER TABLE companies ADD COLUMN location TEXT;        -- display, e.g. "Ann Arbor, MI 48104"
ALTER TABLE companies ADD COLUMN location_norm TEXT;   -- lower(city)|UPPER(region)|zip5, maintained by the application
CREATE INDEX idx_companies_domain ON companies(domain_norm) WHERE domain_norm IS NOT NULL;
CREATE VIEW company_domain_v AS
SELECT co.id, (SELECT CASE WHEN h IS NULL OR h = '' OR instr(h, '.') = 0 THEN NULL WHEN substr(h, 1, 4) = 'www.' THEN substr(h, 5) ELSE h END
  FROM (SELECT CASE WHEN instr(rest, ':') > 0 THEN substr(rest, 1, instr(rest, ':') - 1) ELSE rest END AS h
    FROM (SELECT CASE WHEN instr(s, '/') > 0 THEN substr(s, 1, instr(s, '/') - 1) ELSE s END AS rest
      FROM (SELECT CASE WHEN instr(lower(trim(co.website)), '://') > 0 THEN substr(lower(trim(co.website)), instr(lower(trim(co.website)), '://') + 3) ELSE lower(trim(co.website)) END AS s)))) AS domain_norm
FROM companies co;
CREATE TRIGGER companies_domain_ai AFTER INSERT ON companies WHEN NEW.website IS NOT NULL BEGIN
  UPDATE companies SET domain_norm = (SELECT domain_norm FROM company_domain_v WHERE id = NEW.id) WHERE id = NEW.id;
END;
CREATE TRIGGER companies_domain_au AFTER UPDATE OF website ON companies BEGIN
  UPDATE companies SET domain_norm = (SELECT domain_norm FROM company_domain_v WHERE id = NEW.id) WHERE id = NEW.id;
END;
UPDATE companies SET domain_norm = (SELECT domain_norm FROM company_domain_v v WHERE v.id = companies.id) WHERE website IS NOT NULL;

-- Lead provenance for automated channels (leads.source keeps its existing CHECK; rebuilding that table is avoided).
ALTER TABLE leads ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('research_agent','crm_api'));
-- Provenance pointer only (no FOREIGN KEY: crm_intake_decisions.lead_id already references leads, and a cycle would break
-- row-by-row restores such as the staging seed).
ALTER TABLE leads ADD COLUMN intake_decision_id TEXT;
CREATE INDEX idx_leads_intake_decision ON leads(intake_decision_id) WHERE intake_decision_id IS NOT NULL;

-- Optimistic race guard. A batch that must only commit if nobody linked the same identifier meanwhile starts with
-- INSERT INTO crm_write_guard (ok) SELECT 0 WHERE <someone did>; the CHECK fails and the whole batch rolls back.
-- The table therefore never holds a row.
CREATE TABLE crm_write_guard (ok INTEGER NOT NULL, CONSTRAINT crm_identity_race CHECK (ok = 1));

-- ───────────── Backfill (additive: registers identities for existing contacts; merges nothing) ─────────────
INSERT INTO contact_identities (id, kind, value_norm, display_value, first_source, created_at, updated_at)
  SELECT 'cid_' || lower(hex(randomblob(12))), 'email', v.email_key, MIN(trim(c.email)), 'backfill', MIN(c.created_at), strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM contact_identity_norm_v v JOIN contacts c ON c.id = v.id WHERE v.email_key IS NOT NULL GROUP BY v.email_key
  ON CONFLICT(kind, value_norm) DO NOTHING;
INSERT INTO contact_identities (id, kind, value_norm, display_value, first_source, created_at, updated_at)
  SELECT 'cid_' || lower(hex(randomblob(12))), 'phone', v.phone_key, MIN(trim(c.phone)), 'backfill', MIN(c.created_at), strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM contact_identity_norm_v v JOIN contacts c ON c.id = v.id WHERE v.phone_key IS NOT NULL GROUP BY v.phone_key
  ON CONFLICT(kind, value_norm) DO NOTHING;
INSERT INTO contact_identity_links (id, identity_id, contact_id, original_value, role, source, confidence, verified, created_at, last_seen_at)
  SELECT 'cil_' || lower(hex(randomblob(12))), ci.id, c.id, CASE ci.kind WHEN 'email' THEN trim(c.email) ELSE trim(c.phone) END, 'primary', 'backfill', 50,
    CASE WHEN ci.kind = 'email' AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id AND u.email_verified_at IS NOT NULL AND lower(u.email) = ci.value_norm) THEN 1 ELSE 0 END,
    c.created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM contacts c JOIN contact_identity_norm_v v ON v.id = c.id
  JOIN contact_identities ci ON (ci.kind = 'email' AND ci.value_norm = v.email_key) OR (ci.kind = 'phone' AND ci.value_norm = v.phone_key)
  WHERE true
  ON CONFLICT(identity_id, contact_id) DO NOTHING;
UPDATE contact_identities SET shared = 1 WHERE id IN (SELECT identity_id FROM contact_identity_business_count_v WHERE businesses > 1);
-- Account emails a customer has verified are verified identities.
UPDATE contact_identities SET verification_status = 'verified', verified_source = 'account_email_verified',
    verified_at = (SELECT MIN(u.email_verified_at) FROM users u WHERE lower(u.email) = contact_identities.value_norm AND u.email_verified_at IS NOT NULL),
    last_verified_at = (SELECT MAX(u.email_verified_at) FROM users u WHERE lower(u.email) = contact_identities.value_norm AND u.email_verified_at IS NOT NULL)
  WHERE kind = 'email' AND EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = contact_identities.value_norm AND u.email_verified_at IS NOT NULL);
-- Outbound call history becomes ledger history (no reservations are created).
INSERT INTO phone_outreach_ledger (phone_e164, identity_id, attempts, last_attempt_at, created_at, updated_at)
  SELECT k.to_number, (SELECT id FROM contact_identities WHERE kind = 'phone' AND value_norm = k.to_number), k.n, k.last_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM (SELECT to_number, COUNT(*) AS n, MAX(started_at) AS last_at FROM calls WHERE direction = 'outbound' AND to_number LIKE '+%' GROUP BY to_number) k
  WHERE true
  ON CONFLICT(phone_e164) DO NOTHING;
