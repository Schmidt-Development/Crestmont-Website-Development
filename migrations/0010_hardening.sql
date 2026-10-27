-- Security hardening from docs/security/ASVS-REVIEW.md.
-- F-04: reject TOTP replay — remember the last accepted 30-second time-step per user.
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
-- F-07: idle timeout — sessions track last activity.
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;

-- Record the review's findings in the authoritative register so they gate Release (Gate C).
INSERT OR IGNORE INTO security_findings (id, title, severity, release_blocking, source, status, resolution_evidence, opened_at, resolved_at) VALUES
('F-01','No staging/production environment, secrets store, WAF or Access policy (BLK-003)','high',1,'ASVS self-review 2026-10-26','open',NULL,'2026-10-26T23:00:00Z',NULL),
('F-02','No malware scanning for uploaded files','high',1,'ASVS self-review 2026-10-26','open',NULL,'2026-10-26T23:00:00Z',NULL),
('F-03','No external alerting for errors or failed feeds','medium',1,'ASVS self-review 2026-10-26','open',NULL,'2026-10-26T23:00:00Z',NULL),
('F-04','TOTP code replayable within its 30-second window','medium',1,'ASVS self-review 2026-10-26','resolved','users.totp_last_step; completeMfa/confirmTotpEnrollment reject steps <= last accepted; test [AUTH-003] replay','2026-10-26T23:00:00Z','2026-10-26T23:30:00Z'),
('F-05','PBKDF2-SHA256 at 100k iterations (Workers maximum) is below OWASP 600k guidance','medium',0,'ASVS self-review 2026-10-26','accepted_risk','Platform constraint; revisit with ADR 0002 decision','2026-10-26T23:00:00Z',NULL),
('F-06','No breached-password check (ASVS 2.1.7)','medium',0,'ASVS self-review 2026-10-26','open',NULL,'2026-10-26T23:00:00Z',NULL),
('F-07','Sessions have no idle timeout','medium',1,'ASVS self-review 2026-10-26','resolved','sessions.last_seen_at; staff 2h / customer 24h idle limits in loadSession; test [AUTH-004] idle','2026-10-26T23:00:00Z','2026-10-26T23:30:00Z'),
('F-08','/api/* routes are CSRF-exempt; must never accept cookie-authenticated writes','medium',0,'ASVS self-review 2026-10-26','open',NULL,'2026-10-26T23:00:00Z',NULL),
('F-09','Retention period for audit IPs and security-event emails of anonymised users undefined','medium',0,'ASVS self-review 2026-10-26','open',NULL,'2026-10-26T23:00:00Z',NULL),
('F-10','Dependency scanning configured but never run (CI blocked by billing, BLK-013)','medium',1,'ASVS self-review 2026-10-26','open',NULL,'2026-10-26T23:00:00Z',NULL),
('F-11','No central outbound egress allowlist (SSRF hardening)','low',0,'ASVS self-review 2026-10-26','open',NULL,'2026-10-26T23:00:00Z',NULL),
('F-12','Inline style attributes blocked by CSP (functional rendering defect)','low',0,'ASVS self-review 2026-10-26','resolved','CSP style-src-attr unsafe-inline for attributes only; scripts and style elements remain self-only; e2e [BRAND-003] verifies meters render','2026-10-26T23:00:00Z','2026-10-26T23:30:00Z'),
('F-13','Free-form error messages may contain personal data despite redaction','low',0,'ASVS self-review 2026-10-26','open',NULL,'2026-10-26T23:00:00Z',NULL),
('F-14','TLS termination / minimum TLS version not provisioned (Cloudflare)','low',0,'ASVS self-review 2026-10-26','open',NULL,'2026-10-26T23:00:00Z',NULL),
('F-15','No anti-automation on authenticated business actions beyond auth rate limits','low',0,'ASVS self-review 2026-10-26','open',NULL,'2026-10-26T23:00:00Z',NULL),
('F-16','No independent review or penetration test','high',1,'ASVS self-review 2026-10-26','open',NULL,'2026-10-26T23:00:00Z',NULL),
('F-17','Voice caller matching uses email + phone only (ticket creation only, never disclosure)','medium',0,'ASVS self-review 2026-10-26','accepted_risk','Documented constraint in src/services/voice.ts','2026-10-26T23:00:00Z',NULL);
