-- Real blockers recorded during Phase 1 discovery (2026-10-26). Apply after requirements sync.
INSERT INTO blockers (id, category, description, severity, subsystem, owner, required_action, dependency, status, created_at) VALUES
('BLK-001','external_account','Original Crestmont gold-shield logo file is not in the workspace','high','Brand','Founder','Upload the original logo file (SVG preferred, else highest-resolution PNG)',NULL,'open','2026-10-26T22:00:00Z'),
('BLK-002','external_account','No dedicated Crestmont repository exists and this session cannot create GitHub repositories (gh token invalid)','critical','Infrastructure','Founder','Create private repo (e.g. noahschmidt10/crestmont-platform) and grant Claude push access','GitHub','open','2026-10-26T22:00:00Z'),
('BLK-003','external_account','No Cloudflare account access for D1, R2, Workers, Turnstile, DNS','critical','Infrastructure','Founder','Provide a scoped Cloudflare API token for a dedicated Crestmont account','Cloudflare','open','2026-10-26T22:00:00Z'),
('BLK-004','external_account','No dedicated Crestmont Stripe account (test mode) configured','high','Payments','Founder','Create Crestmont Stripe account; share test-mode keys only','Stripe','open','2026-10-26T22:00:00Z'),
('BLK-005','external_account','Resend account and mailbox routing for support@/sales@/billing@/legal@ not configured','high','Email','Founder','Create Resend account; choose mailbox provider; grant DNS access','Resend, DNS','open','2026-10-26T22:00:00Z'),
('BLK-006','legal','Legal entity, registered mailing address and tax configuration not established','critical','Identity','Founder','Form entity, obtain address, engage attorney for agreement review',NULL,'open','2026-10-26T22:00:00Z'),
('BLK-007','engineering','Genuine portfolio screenshots not yet captured: workspace egress denies the portfolio domains and the linked computer did not respond','high','Portfolio','Engineering','Capture via the Founder''s connected browser, or allow the domains in Settings > Capabilities',NULL,'open','2026-10-26T22:00:00Z'),
('BLK-008','legal','Portfolio relationship undocumented: BLM site names Noahs Consulting LLC as operator; LCR sites name Akelle Richmond as owner','medium','Portfolio','Founder','Document Crestmont''s role in each project before publishing case studies',NULL,'open','2026-10-26T22:00:00Z'),
('BLK-009','founder_approval','AI receptionist provider not selected; no number may be purchased before recommendation is approved','medium','AI Receptionist','Founder','Review provider recommendation (Retell vs Twilio-based) and approve cost',NULL,'open','2026-10-26T22:00:00Z'),
('BLK-010','founder_approval','Maintenance plan entitlements are proposals pending Founder approval','medium','Catalog','Founder','Approve or amend proposed entitlements in src/domain/catalog.ts',NULL,'open','2026-10-26T22:00:00Z'),
('BLK-011','external_account','Official domain status unverified: automated fetch disallowed and egress denied','high','Identity','Founder','Confirm registrar and DNS ownership; grant DNS access',NULL,'open','2026-10-26T22:00:00Z'),
('BLK-012','engineering','Package registries unreachable from this workspace; frontend toolchain cannot be installed here','medium','Infrastructure','Engineering','Build UI in CI/GitHub Codespace once repo exists, or allow registry egress',NULL,'open','2026-10-26T22:00:00Z');

INSERT INTO blocker_requirements (blocker_id, requirement_id) VALUES
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
('BLK-011','IDENT-004');
