-- Security & legal readiness session (2026-10-28). Numbered 0040 to stay clear of 0037/0038 used by
-- concurrent branches. Three parts:
--   1. file_scans: append-only log of malware-scanner verdicts (provider-independent; src/services/malware-scan.ts).
--   2. legal_holds: suspend retention purges and privacy anonymisation for data under a dispute,
--      investigation or legal hold (src/services/legal-holds.ts).
--   3. security_findings register: record the outcome of findings already fixed in code with tests, and
--      add the findings from this session's review (docs/security/SECURITY-READINESS-2026-10-28.md).

-- ── 1. Scanner verdicts ──
CREATE TABLE file_scans (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('clean','infected','failed')),
  engine TEXT NOT NULL,              -- scanner name + version as reported, e.g. "clamav 1.4.1 / db 27431"
  scanned_sha256 TEXT NOT NULL,      -- digest of the bytes the scanner saw; must equal files.sha256
  signature TEXT,                    -- detection name for 'infected'
  detail TEXT,                       -- short error for 'failed' (no file content)
  recorded_by TEXT REFERENCES users(id),
  scanned_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_file_scans_file ON file_scans(file_id, recorded_at);
CREATE TRIGGER file_scans_no_update BEFORE UPDATE ON file_scans BEGIN SELECT RAISE(ABORT, 'file_scans is append-only'); END;
CREATE TRIGGER file_scans_no_delete BEFORE DELETE ON file_scans BEGIN SELECT RAISE(ABORT, 'file_scans is append-only'); END;

-- ── 2. Legal holds ──
CREATE TABLE legal_holds (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','organization','user')),
  subject_id TEXT,                   -- organizations.id or users.id; NULL for global
  reason TEXT NOT NULL,
  matter_reference TEXT,             -- attorney matter / dispute / incident id
  placed_by TEXT REFERENCES users(id),
  placed_at TEXT NOT NULL,
  released_at TEXT,
  released_by TEXT REFERENCES users(id),
  release_note TEXT,
  CHECK ((scope = 'global' AND subject_id IS NULL) OR (scope <> 'global' AND subject_id IS NOT NULL))
);
CREATE INDEX idx_legal_holds_active ON legal_holds(scope, subject_id) WHERE released_at IS NULL;
-- A hold's facts never change; only its release may be recorded, once.
CREATE TRIGGER legal_holds_immutable BEFORE UPDATE OF id, scope, subject_id, reason, matter_reference, placed_by, placed_at ON legal_holds
BEGIN SELECT RAISE(ABORT, 'legal hold facts are immutable'); END;
CREATE TRIGGER legal_holds_release_once BEFORE UPDATE OF released_at ON legal_holds WHEN OLD.released_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'legal hold already released'); END;
CREATE TRIGGER legal_holds_no_delete BEFORE DELETE ON legal_holds BEGIN SELECT RAISE(ABORT, 'legal holds cannot be deleted'); END;

-- ── 3. Findings register ──
-- These five were fixed in code with tests (see docs/security/ASVS-REVIEW.md) but the register still said 'open'.
UPDATE security_findings SET status = 'resolved', resolved_at = '2026-10-28T07:00:00Z',
  resolution_evidence = 'k-anonymity HIBP range check on register/reset/invite/change (src/services/auth.ts assertPasswordNotBreached); tests/asvs-hardening.test.ts [SEC-007] F-06'
  WHERE id = 'F-06' AND status = 'open';
UPDATE security_findings SET status = 'resolved', resolved_at = '2026-10-28T07:00:00Z',
  resolution_evidence = 'buildContext never loads a cookie session for non-GET /api/* (src/app/app.ts); tests/asvs-hardening.test.ts [SEC-007] F-08'
  WHERE id = 'F-08' AND status = 'open';
UPDATE security_findings SET status = 'resolved', resolved_at = '2026-10-28T07:00:00Z',
  resolution_evidence = 'central egress allowlist installed at Worker start (src/lib/egress.ts, src/worker.ts); tests/asvs-hardening.test.ts [SEC-002] F-11'
  WHERE id = 'F-11' AND status = 'open';
UPDATE security_findings SET status = 'resolved', resolved_at = '2026-10-28T07:00:00Z',
  resolution_evidence = 'recordAppError redacts emails, phone and card-like numbers (src/services/monitoring.ts); tests/asvs-hardening.test.ts [SEC-007] F-13'
  WHERE id = 'F-13' AND status = 'open';
UPDATE security_findings SET status = 'resolved', resolved_at = '2026-10-28T07:00:00Z',
  resolution_evidence = 'per-user limits on authenticated form submissions (src/app/app.ts limitActions); tests/live-and-limits.test.ts [SEC-007] F-15'
  WHERE id = 'F-15' AND status = 'open';

INSERT OR IGNORE INTO security_findings (id, title, severity, release_blocking, source, status, resolution_evidence, opened_at, resolved_at) VALUES
('F-18','Staging Owner password, 2FA key and preview password uploaded as a plaintext workflow artifact of a PUBLIC repository (deploy-staging.yml staging-preview-access)','critical',1,'Security readiness review 2026-10-28','open',NULL,'2026-10-28T07:00:00Z',NULL),
('F-19','Pre-deploy production D1 export uploaded as a workflow artifact of a PUBLIC repository (deploy-production.yml; production not yet deployed, so no customer data exposed so far)','critical',1,'Security readiness review 2026-10-28','open',NULL,'2026-10-28T07:00:00Z',NULL),
('F-20','Lockout confirmed a correct password: a locked account answered "locked" only to the right password','medium',0,'Security readiness review 2026-10-28','resolved','Lockout decided before the password result and uniform for unknown emails (src/services/auth.ts login); tests/security-readiness.test.ts [AUTH-005]','2026-10-28T07:00:00Z','2026-10-28T07:00:00Z'),
('F-21','Files with scan_status infected/failed were still downloadable through GET /files/:id (share links already refused them)','medium',0,'Security readiness review 2026-10-28','resolved','serveFile refuses quarantined files with an audited file.download_blocked (src/services/files.ts); tests/security-readiness.test.ts [SEC-003]','2026-10-28T07:00:00Z','2026-10-28T07:00:00Z'),
('F-22','Outstanding password-reset links stayed valid after a password reset or change','low',0,'Security readiness review 2026-10-28','resolved','invalidateResetTokens on reset and change (src/services/auth.ts); tests/security-readiness.test.ts [AUTH-002]','2026-10-28T07:00:00Z','2026-10-28T07:00:00Z'),
('F-23','deploy-production.yml interpolates the free-text inputs.tag directly into run: scripts that hold the production Cloudflare token (script injection by anyone able to dispatch)','medium',1,'Security readiness review 2026-10-28','open',NULL,'2026-10-28T07:00:00Z',NULL),
('F-24','Deploy workflows expose CLOUDFLARE_API_TOKEN to every job step, including npm installs of unpinned packages; wrangler@4 and actions are pinned to mutable tags','medium',0,'Security readiness review 2026-10-28','open',NULL,'2026-10-28T07:00:00Z',NULL),
('F-25','No legal-hold mechanism: retention purges and privacy anonymisation could destroy data needed for a dispute or investigation','medium',0,'Security readiness review 2026-10-28','resolved','legal_holds table + enforcement in runRetention and processDeletion (src/services/legal-holds.ts); tests/security-readiness.test.ts [SEC-006]','2026-10-28T07:00:00Z','2026-10-28T07:00:00Z'),
('F-26','Self-service privacy export included staff internal notes (messages.internal = 1) about the customer''s projects','high',1,'Security readiness review 2026-10-28','resolved','buildExport filters m.internal = 0 (src/services/privacy.ts); tests/security-readiness.test.ts [SEC-006]','2026-10-28T07:00:00Z','2026-10-28T07:00:00Z'),
('F-27','Attachments on staff internal notes were stored as customer-organization files, visible and downloadable in the customer portal','medium',0,'Security readiness review 2026-10-28','resolved','postMessage refuses attachments on internal notes (src/services/messages.ts); tests/security-readiness.test.ts [PORTAL-005]','2026-10-28T07:00:00Z','2026-10-28T07:00:00Z'),
('F-28','Irreversible or Founder-protected actions (privacy anonymisation, retention periods, pricing decisions, tax settings, invitation revoke, customer team changes) did not require step-up MFA','medium',0,'Security readiness review 2026-10-28','resolved','Added to STEP_UP_ROUTES (src/app/step-up.ts); tests/security-readiness.test.ts [AUTH-008]','2026-10-28T07:00:00Z','2026-10-28T07:00:00Z');
-- F-10 note: the CI dependency audit step ran `npm audit ... || true` with no lockfile, so it never checked anything.
-- Fixed in .github/workflows/ci.yml on this branch; F-10 stays open until a passing audit run is recorded on GitHub Actions.
