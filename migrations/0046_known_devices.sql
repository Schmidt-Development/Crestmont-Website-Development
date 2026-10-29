-- CREST-GAP-003: browsers that completed a sign-in (password, plus MFA when enabled) are remembered, so failed
-- sign-ins by other people never block them. Only a SHA-256 of the random cookie value is stored. Revoked on
-- password reset. Sign-in no longer sets users.locked_until (no account lockout); the column stays for history.
CREATE TABLE known_devices (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_known_devices_user ON known_devices(user_id);
-- Accounts locked under the old policy are released.
UPDATE users SET locked_until = NULL WHERE locked_until IS NOT NULL;
