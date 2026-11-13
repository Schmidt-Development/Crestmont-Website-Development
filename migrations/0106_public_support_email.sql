-- Owner, 2026-11-13: the public GENERAL & SUPPORT address is support@crestmontwebsitedevelopment.com. Production's
-- Business settings held a personal Gmail address as the public contact email (shown on /contact and in the footer).
-- Only that public setting changes; sales@, billing@ and legal@ stay in their own contexts, and private Owner
-- notification destinations (internal mailbox, staff accounts) are not touched. A personal Gmail address used as the
-- security.txt contact is replaced by support@ as well; any other value there is kept.
INSERT INTO business_settings (key, value, updated_by, updated_at)
VALUES ('contact.email', 'support@crestmontwebsitedevelopment.com', NULL, '2026-11-13T06:00:00.000Z')
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = NULL, updated_at = excluded.updated_at;
UPDATE business_settings SET value = 'support@crestmontwebsitedevelopment.com', updated_by = NULL, updated_at = '2026-11-13T06:00:00.000Z'
WHERE key = 'security.contact_email' AND lower(value) LIKE '%@gmail.com';
