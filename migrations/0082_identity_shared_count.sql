-- The second-largest cause of the staging D1 overload: a trigger that recomputed a whole-table aggregate.
--
-- Cloudflare's per-statement analytics for deploy #160 (2026-11-05, 21:30-22:10 UTC) put the contacts INSERT
-- second by rows read: 110 calls, 5.4 MILLION rows, about 49,000 per insert and ~455 ms each, the largest of
-- all by total duration. The insert itself is cheap; its triggers were not. Both contacts_identity_ai and
-- contacts_identity_au ended with a statement that read contact_identity_business_count_v, a GROUP BY over
-- all of contact_identity_links joined to contacts, so every contact write computed business counts for
-- EVERY identity in the database.
--
-- The triggers are recreated here with that one statement counting only the identities linked to the row
-- being written. Nothing else in either trigger changes, and the predicate is identical -- the equivalence
-- is proven on randomized data by tests/contact-identity-shared-predicate.test.ts rather than argued.
--
-- The view is kept: src/services/contact-identity.ts:775 still reads it, and so does 0048's own backfill.
--
-- Found by the production-preparation session's D1 analytics tool. Migration 0080 fixed the first cause
-- (businessIdQuery's full scan of contacts); this is the second.

DROP TRIGGER contacts_identity_ai;
DROP TRIGGER contacts_identity_au;

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
  -- Count businesses ONLY for the identities this contact is linked to, instead of materializing
  -- contact_identity_business_count_v. That view is a GROUP BY over every link joined to every contact, so
  -- SQLite computed business counts for the WHOLE table on every contact write: 110 calls and 5.4 million
  -- rows read in staging deploy #160's window, about 455 ms per insert, second only to businessIdQuery in
  -- exhausting D1's 10-second budget. The correlated form is driven by idx_identity_links_identity.
  --
  -- The predicate is unchanged, including the deliberate ABSENCE of a removed_at filter on the NEW.id side:
  -- the original joined contact_identity_links without one there, and the view's own WHERE applies only to
  -- the counting side, which l2 reproduces. An identity whose links are all removed has no view row in the
  -- original and counts 0 here, so it is excluded either way.
  UPDATE contact_identities SET shared = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE shared = 0
      AND id IN (SELECT l.identity_id FROM contact_identity_links l WHERE l.contact_id = NEW.id)
      AND (SELECT COUNT(DISTINCT COALESCE(c.company_id, 'contact:' || c.id)) FROM contact_identity_links l2
             JOIN contacts c ON c.id = l2.contact_id WHERE l2.identity_id = contact_identities.id AND l2.removed_at IS NULL) > 1;
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
  -- Count businesses ONLY for the identities this contact is linked to, instead of materializing
  -- contact_identity_business_count_v. That view is a GROUP BY over every link joined to every contact, so
  -- SQLite computed business counts for the WHOLE table on every contact write: 110 calls and 5.4 million
  -- rows read in staging deploy #160's window, about 455 ms per insert, second only to businessIdQuery in
  -- exhausting D1's 10-second budget. The correlated form is driven by idx_identity_links_identity.
  --
  -- The predicate is unchanged, including the deliberate ABSENCE of a removed_at filter on the NEW.id side:
  -- the original joined contact_identity_links without one there, and the view's own WHERE applies only to
  -- the counting side, which l2 reproduces. An identity whose links are all removed has no view row in the
  -- original and counts 0 here, so it is excluded either way.
  UPDATE contact_identities SET shared = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE shared = 0
      AND id IN (SELECT l.identity_id FROM contact_identity_links l WHERE l.contact_id = NEW.id)
      AND (SELECT COUNT(DISTINCT COALESCE(c.company_id, 'contact:' || c.id)) FROM contact_identity_links l2
             JOIN contacts c ON c.id = l2.contact_id WHERE l2.identity_id = contact_identities.id AND l2.removed_at IS NULL) > 1;
END;
