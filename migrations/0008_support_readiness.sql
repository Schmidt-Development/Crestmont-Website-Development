-- Support operating system + Launch Readiness Command Center UI (area D).
-- Ticket SLA flags, release/deployment provenance, GitHub source snapshots, and the real
-- discovery blocker register (identical ids/states to seeds/blockers.sql) for fresh databases.

-- ───────────── Support (SUP-002, SUP-003) ─────────────
ALTER TABLE tickets ADD COLUMN sla_breached_at TEXT;      -- set once by the escalation sweep (idempotent)
ALTER TABLE tickets ADD COLUMN escalated_at TEXT;
ALTER TABLE tickets ADD COLUMN reopened_at TEXT;
CREATE INDEX idx_tickets_status_created ON tickets(status, created_at);
CREATE INDEX idx_ticket_messages_ticket ON ticket_messages(ticket_id, created_at);

-- ───────────── Readiness provenance (READY-008..011) ─────────────
ALTER TABLE releases ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE deployments ADD COLUMN ci_run_id TEXT;
ALTER TABLE deployments ADD COLUMN verification_status TEXT CHECK (verification_status IS NULL OR verification_status IN ('not_verified','passed','failed'));
ALTER TABLE deployments ADD COLUMN incident_blocker_id TEXT REFERENCES blockers(id);
ALTER TABLE deployments ADD COLUMN notes TEXT;
ALTER TABLE security_findings ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE security_findings ADD COLUMN resolved_by TEXT REFERENCES users(id);
ALTER TABLE security_findings ADD COLUMN detail TEXT;
ALTER TABLE blockers ADD COLUMN resolved_by TEXT REFERENCES users(id);
ALTER TABLE blockers ADD COLUMN updated_at TEXT;
ALTER TABLE readiness_snapshots ADD COLUMN taken_by TEXT REFERENCES users(id);

-- ───────────── GitHub data source (READY-005) ─────────────
-- One row per sync attempt. A failed attempt keeps its error; the UI never presents an older
-- successful payload as current.
CREATE TABLE github_sync (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0,1)),
  payload_json TEXT,
  error TEXT,
  requested_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_github_sync_fetched ON github_sync(fetched_at);

-- ───────────── Discovery blocker register (READY-010) ─────────────
-- Same rows and final states as seeds/blockers.sql. INSERT OR IGNORE keeps databases that
-- already applied the seed unchanged.
INSERT OR IGNORE INTO blockers (id, category, description, severity, subsystem, owner, required_action, dependency, status, created_at, resolved_at, resolution_evidence) VALUES
('BLK-001','external_account','Original Crestmont gold-shield logo file is not in the workspace','high','Brand','Founder','Upload the original logo file (SVG preferred, else highest-resolution PNG)',NULL,'resolved','2026-10-26T22:00:00Z','2026-10-26T22:22:00Z','Founder supplied logo (232x213 PNG); stored byte-identical as public/assets/brand/crestmont-logo-original.png (sha256 ebf3f92b8e1a3081...)'),
('BLK-002','external_account','No dedicated Crestmont repository exists and this session cannot create GitHub repositories (gh token invalid)','critical','Infrastructure','Founder','Create private repo (e.g. noahschmidt10/crestmont-platform) and grant Claude push access','GitHub','resolved','2026-10-26T22:00:00Z','2026-10-26T22:21:00Z','Private repo noahschmidt10/Crestmont-Website-Development created by Founder; foundation 8bec22d pushed and verified'),
('BLK-003','external_account','No Cloudflare account access for D1, R2, Workers, Turnstile, DNS','critical','Infrastructure','Founder','Provide a scoped Cloudflare API token for a dedicated Crestmont account','Cloudflare','open','2026-10-26T22:00:00Z',NULL,NULL),
('BLK-004','external_account','No dedicated Crestmont Stripe account (test mode) configured','high','Payments','Founder','Create Crestmont Stripe account; share test-mode keys only','Stripe','open','2026-10-26T22:00:00Z',NULL,NULL),
('BLK-005','external_account','Resend account and mailbox routing for support@/sales@/billing@/legal@ not configured','high','Email','Founder','Create Resend account; choose mailbox provider; grant DNS access','Resend, DNS','open','2026-10-26T22:00:00Z',NULL,NULL),
('BLK-006','legal','Legal entity, registered mailing address and tax configuration not established','critical','Identity','Founder','Form entity, obtain address, engage attorney for agreement review',NULL,'open','2026-10-26T22:00:00Z',NULL,NULL),
('BLK-007','engineering','Genuine portfolio screenshots not yet captured: workspace egress denies the portfolio domains and the linked computer did not respond','high','Portfolio','Engineering','Capture via the Founder''s connected browser, or allow the domains in Settings > Capabilities',NULL,'open','2026-10-26T22:00:00Z',NULL,NULL),
('BLK-008','legal','Portfolio relationship undocumented: BLM site names Noahs Consulting LLC as operator; LCR sites name Akelle Richmond as owner','medium','Portfolio','Founder','Document Crestmont''s role in each project before publishing case studies',NULL,'open','2026-10-26T22:00:00Z',NULL,NULL),
('BLK-009','founder_approval','AI receptionist provider not selected; no number may be purchased before recommendation is approved','medium','AI Receptionist','Founder','Review provider recommendation (Retell vs Twilio-based) and approve cost',NULL,'open','2026-10-26T22:00:00Z',NULL,NULL),
('BLK-010','founder_approval','Maintenance plan entitlements are proposals pending Founder approval','medium','Catalog','Founder','Approve or amend proposed entitlements in src/domain/catalog.ts',NULL,'open','2026-10-26T22:00:00Z',NULL,NULL),
('BLK-011','external_account','Official domain status unverified: automated fetch disallowed and egress denied','high','Identity','Founder','Confirm registrar and DNS ownership; grant DNS access',NULL,'open','2026-10-26T22:00:00Z',NULL,NULL),
('BLK-012','engineering','Package registries unreachable from this workspace; frontend toolchain cannot be installed here','medium','Infrastructure','Engineering','Build UI in CI/GitHub Codespace once repo exists, or allow registry egress',NULL,'open','2026-10-26T22:00:00Z',NULL,NULL),
('BLK-013','external_account','GitHub Actions jobs are refused before starting: account payments failed or spending limit must be increased','high','Infrastructure','Founder','Fix billing / raise the Actions spending limit in GitHub Settings > Billing and plans','GitHub billing','open','2026-10-26T22:23:00Z',NULL,NULL),
('BLK-014','external_account','Original logo is a 232x213 raster; no vector master. Sharp use is limited to small sizes (crest <= 42 px tall on retina, lockup <= 116 px wide)','low','Brand','Founder','Provide the original vector (SVG/AI/EPS/PDF) or a >= 1000 px PNG for hero, print, social and app-icon uses',NULL,'open','2026-10-26T22:25:00Z',NULL,NULL);

-- Requirement links for the discovery register. blocker_requirements references requirements,
-- which are synced from requirements/inventory.ts after migrations run, so the links are kept
-- here and applied once by src/services/readiness-admin.ts#applySeedBlockerLinks when the
-- requirement rows exist. applied_at makes the application one-time: a link a person later
-- removes is not re-created.
CREATE TABLE blocker_seed_links (
  blocker_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  applied_at TEXT,
  PRIMARY KEY (blocker_id, requirement_id)
);
INSERT OR IGNORE INTO blocker_seed_links (blocker_id, requirement_id) VALUES
('BLK-001','BRAND-001'),
('BLK-002','INFRA-003'),('BLK-002','INFRA-005'),('BLK-002','READY-005'),
('BLK-003','INFRA-002'),('BLK-003','INFRA-006'),('BLK-003','FILE-001'),
('BLK-004','PAY-001'),('BLK-004','PAY-004'),
('BLK-005','EMAIL-001'),('BLK-005','IDENT-003'),
('BLK-006','IDENT-001'),('BLK-006','IDENT-002'),('BLK-006','PAY-010'),('BLK-006','LEGAL-004'),('BLK-006','LEGAL-005'),
('BLK-007','PORT-001'),('BLK-007','PORT-002'),('BLK-007','PORT-003'),
('BLK-008','PORT-005'),
('BLK-009','VOICE-001'),('BLK-009','VOICE-002'),
('BLK-010','CAT-006'),
('BLK-011','IDENT-004'),
('BLK-013','INFRA-004'),('BLK-013','READY-005');
