-- CRM identity privacy erasure (PR #50 follow-up). ADDITIVE ONLY: one new table, no existing row touched.
-- Rollback: docs/crm-identity/rollback-0049.sql (drops this table; nothing else depends on it at the schema level).
--
-- When a person's CRM data is erased (account deletion, receptionist caller erasure, or the Owner's CRM identity
-- erasure), the raw phone numbers and email addresses are removed everywhere (src/services/identity-erasure.ts).
-- To stop the research engine or a CRM API import from silently re-creating them from public listings, an erasure can
-- leave a TOMBSTONE: HMAC-SHA256 of the normalized identifier keyed with the Worker secret CRM_ERASURE_HMAC_KEY, with
-- no name, no record id and no raw value. The key is never stored in D1 or the source, so a database copy alone does
-- not allow testing guesses (a fixed salt would: phone numbers have a small keyspace).
-- Automated imports of a tombstoned identifier are refused (outcome SUPPRESSED, reason erased_at_request). A person
-- who contacts Crestmont again themselves (form, call) is not blocked.
CREATE TABLE crm_erasure_tombstones (
  key_hash TEXT PRIMARY KEY,                 -- hex HMAC-SHA256(CRM_ERASURE_HMAC_KEY, 'crestmont-crm-erasure:v2|' || kind || ':' || value)
  kind TEXT NOT NULL CHECK (kind IN ('phone','email')),
  reason TEXT NOT NULL CHECK (reason IN ('erasure_request')),
  key_id TEXT,                               -- public id of the key that wrote it (rotation bookkeeping)
  created_at TEXT NOT NULL
);
