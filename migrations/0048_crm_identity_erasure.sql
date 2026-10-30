-- CRM identity privacy erasure (PR #50 follow-up). ADDITIVE ONLY: one new table, no existing row touched.
-- Rollback: docs/crm-identity/rollback-0048.sql (drops this table; nothing else depends on it at the schema level).
--
-- When a person's CRM data is erased (account deletion, receptionist caller erasure, or the Owner's CRM identity
-- erasure), the raw phone numbers and email addresses are removed everywhere (src/services/identity-erasure.ts).
-- To stop the research engine or a CRM API import from silently re-creating them from public listings, an erasure can
-- leave a TOMBSTONE: a salted SHA-256 of the normalized identifier, with no name, no record id and no raw value.
-- Automated imports of a tombstoned identifier are refused (outcome SUPPRESSED, reason erased_at_request). A person
-- who contacts Crestmont again themselves (form, call) is not blocked.
-- Note: phone numbers have a small keyspace, so a hash is minimization, not anonymity (documented in the runbook).
CREATE TABLE crm_erasure_tombstones (
  key_hash TEXT PRIMARY KEY,                 -- hex sha256('crestmont-crm-erasure:v1|' || kind || ':' || normalized value)
  kind TEXT NOT NULL CHECK (kind IN ('phone','email')),
  reason TEXT NOT NULL CHECK (reason IN ('erasure_request')),
  created_at TEXT NOT NULL
);
