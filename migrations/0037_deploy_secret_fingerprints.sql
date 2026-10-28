-- Staging deploy bookkeeping (TEST-004 / INFRA-005). Cloudflare refuses to roll a Worker back to a version when a secret
-- has changed since that version was active (API error 10220). The deploy used to re-put secrets on every run (and
-- rotate EVIDENCE_INGEST_SECRET), which blocked every rollback. Deploys now put a secret only when its value changed,
-- detected by a keyed fingerprint: HMAC-SHA256(Cloudflare token secret, name + value). No secret values are stored.
CREATE TABLE deploy_secret_fingerprints (
  name TEXT PRIMARY KEY CHECK (name GLOB '[A-Z_]*'),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  updated_at TEXT NOT NULL
);
