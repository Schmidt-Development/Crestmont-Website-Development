-- Rollback for migrations/0048_crm_identity_erasure.sql. NOT in migrations/ on purpose: never applied automatically.
-- Runbook: docs/crm-identity/RUNBOOK.md §6. Deploy the code from before 0048 first (it reads this table).
-- Effect: erasure tombstones are lost, so identifiers erased with "block re-import" become importable again by the
-- research engine. The erasures themselves are NOT undone (erased data stays erased). Apply with:
--   npx wrangler@4.149.0 d1 execute crestmont-<env> --remote --env <env> --file docs/crm-identity/rollback-0048.sql
DROP TABLE IF EXISTS crm_erasure_tombstones;
DELETE FROM d1_migrations WHERE name = '0048_crm_identity_erasure.sql';
