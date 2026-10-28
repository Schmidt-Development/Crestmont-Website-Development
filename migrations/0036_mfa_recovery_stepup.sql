-- AUTH-002 / AUTH-003 production hardening (docs/AUTH-PRODUCTION.md gaps 1–3).
--
-- 1. Step-up MFA: when this session last completed a TOTP (or recovery-code) verification. Sensitive actions
--    require it to be recent (src/app/step-up.ts). Existing sessions have NULL and are asked to step up once.
ALTER TABLE sessions ADD COLUMN mfa_verified_at TEXT;

-- 2. MFA recovery codes: 10 single-use codes per user, shown once. `lookup` is the first four (random,
--    non-secret) characters of the code, used only to find the row; `code_hash` is the password-hash
--    (PBKDF2, src/lib/auth-crypto.ts#hashPassword) of the whole normalised code. Regenerating replaces the set.
CREATE TABLE mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  lookup TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_mfa_recovery_codes_user ON mfa_recovery_codes(user_id, lookup);

-- 3. TOTP secrets at rest: users.totp_secret / totp_pending_secret now hold "v1:<iv>:<ciphertext>" (AES-GCM
--    under the MFA_ENCRYPTION_KEY Worker secret). No schema change is needed; plaintext rows keep working and
--    are re-encrypted on the next successful verification or by scripts/encrypt-totp-secrets.ts.
