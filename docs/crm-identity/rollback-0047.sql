-- Rollback for migrations/0047_contact_identity.sql. If 0048 is applied, run rollback-0048.sql FIRST.
-- NOT in migrations/ on purpose: it is never applied automatically.
-- Runbook: docs/crm-identity/RUNBOOK.md §6. Take a D1 Time Travel bookmark and export first:
--   npx wrangler@4.149.0 d1 time-travel info crestmont-<env> --env <env>
--   npx wrangler@4.149.0 d1 export crestmont-<env> --remote --env <env> --output pre-rollback-0047.sql
-- What it removes: identity, ledger, review and decision tables (their history is lost: export first), the triggers and
-- views added by 0047, and the nullable columns it added. It does NOT touch contacts, companies, leads, calls or any
-- other pre-existing row. Before rolling back the database, deploy the code from before this release (the code
-- reads these tables). Apply with:
--   npx wrangler@4.149.0 d1 execute crestmont-<env> --remote --env <env> --file docs/crm-identity/rollback-0047.sql
DROP TRIGGER IF EXISTS contacts_identity_ai;
DROP TRIGGER IF EXISTS contacts_identity_au;
DROP TRIGGER IF EXISTS contacts_identity_erased;
DROP TRIGGER IF EXISTS companies_domain_ai;
DROP TRIGGER IF EXISTS companies_domain_au;
DROP VIEW IF EXISTS contact_identity_norm_v;
DROP VIEW IF EXISTS contact_identity_business_count_v;
DROP VIEW IF EXISTS company_domain_v;
DROP INDEX IF EXISTS idx_voice_outbound_open_phone;
DROP INDEX IF EXISTS idx_companies_domain;
DROP INDEX IF EXISTS idx_leads_intake_decision;
DROP TABLE IF EXISTS crm_write_guard;
DROP TABLE IF EXISTS crm_field_changes;
DROP TABLE IF EXISTS crm_identity_reviews;
DROP TABLE IF EXISTS email_outreach_enrollments;
DROP TABLE IF EXISTS phone_outreach_events;
DROP TABLE IF EXISTS phone_outreach_ledger;
DROP TABLE IF EXISTS crm_intake_decisions;
DROP TABLE IF EXISTS crm_import_batches;
DROP TABLE IF EXISTS contact_identity_links;
DROP TABLE IF EXISTS contact_identities;
ALTER TABLE leads DROP COLUMN intake_decision_id;
ALTER TABLE leads DROP COLUMN origin;
ALTER TABLE companies DROP COLUMN location_norm;
ALTER TABLE companies DROP COLUMN location;
ALTER TABLE companies DROP COLUMN domain_norm;
DELETE FROM d1_migrations WHERE name = '0047_contact_identity.sql';
