-- BLK-006 gated twelve requirements at once. It was created as "Legal entity, registered mailing address and
-- tax configuration not established", and over time it accumulated every outstanding fact that happened to
-- involve the Founder: the mailing address, the retention schedule, commissioning an independent penetration
-- test, the staffed support hours and the production launch authorization.
--
-- That is a false-completion hazard, not a tidy shortcut. The acceptance registry says a requirement names
-- "whichever actually holds it up", and the derivation completes a requirement the moment its named gate
-- clears. So the day an attorney finishes reviewing the agreements, BLK-006 resolves and SEC-007 reports an
-- independent penetration test as complete — on the strength of a decision that says nothing about it. The
-- same mis-attribution had already completed SUP-004 and AIOPS-002 off the AI receptionist provider decision
-- (BLK-009), which is why BLK-015 exists.
--
-- Each fact that is genuinely separable gets its own blocker here, so resolving one says only what it says.
-- No requirement changes state as a result: every one of these gates is open before and after.

INSERT OR IGNORE INTO blockers (id, category, description, severity, subsystem, owner, required_action, dependency, status, created_at) VALUES
('BLK-016','legal','No registered business mailing address is published. Crestmont trades online and the Founder has not authorised a residential address as a public business address, so REGISTERED_ADDRESS in src/domain/business-identity.ts is deliberately null and the disclosures page prints no address. This is separate from the legal entity, which is settled.','medium','Identity','Founder','Supply a registered non-residential business address and record it in Business settings, or confirm in writing that none will be published. Needed only where a provider or a law genuinely requires one.',NULL,'open','2026-11-05T00:00:00Z'),
('BLK-017','security','No independent security review or penetration test of staging has been commissioned. The platform''s own security suite and an engineering review from inside this repository are not independent (F-16), so SEC-007 cannot be established here however many tests pass.','high','Security','Founder','Commission an independent qualified reviewer and close any release-blocking findings they report, or record that none is available at no additional cost and keep this blocker open. An automated scan or a review by the engineering agent does not satisfy it.',NULL,'open','2026-11-05T00:00:00Z'),
('BLK-018','legal','The data-retention schedule has not been approved. The platform already applies its current conservative retention behaviour and the retention job runs, but the periods themselves — audit IP addresses and anonymized-account security email records among them — are not an approved schedule until the Founder and counsel approve them.','medium','Privacy','Founder','Approve the retention periods with counsel and apply them in Settings. Records required for security, financial, dispute or compliance purposes are preserved regardless of the period chosen.',NULL,'open','2026-11-05T00:00:00Z'),
('BLK-019','founder_approval','Staffed support hours and the first-response target have not been set, so the public support policy page cannot state them.','low','Support','Founder','Set the staffed hours and the first-response target in Settings.',NULL,'open','2026-11-05T00:00:00Z'),
('BLK-020','founder_approval','The Founder has not recorded the production launch authorization. Production launch is withheld until the readiness gates pass; this blocker exists so that no unrelated decision can complete LAUNCH-001 on its behalf.','critical','Launch','Founder','Record the production launch authorization once the readiness gates pass. Nothing in the codebase can supply it, and no test can stand in for it.',NULL,'open','2026-11-05T00:00:00Z');

-- Narrow BLK-006 to what it is actually about now: professional review and the Owner's own business record.
-- The entity itself was confirmed on 2026-11-04 (migration 0077).
UPDATE blockers SET
  description = 'Attorney review of the legal suite and the accountant''s tax determination are outstanding, and the operating entity is not yet recorded in Business settings. The entity itself is settled: Talent Revenue Systems LLC, confirmed by the Founder on 2026-11-04 and recorded in src/domain/business-identity.ts, with Crestmont Website Development as the trading brand. The mailing address is BLK-016, the retention schedule BLK-018, the independent security review BLK-017, the staffed support hours BLK-019 and the launch authorization BLK-020.',
  required_action = 'Engage an attorney to review the agreements and policies (LEGAL-004) and an accountant for the tax position (LEGAL-005), and record the operating entity in Business settings so production checkout can open.',
  updated_at = '2026-11-05T00:00:00Z'
  WHERE id = 'BLK-006' AND status = 'open';

-- Move the six links off BLK-006, in both the seed table and the live table it was applied into.
DELETE FROM blocker_requirements WHERE blocker_id = 'BLK-006'
  AND requirement_id IN ('IDENT-002','IDENT-005','SEC-006','SEC-007','SUP-005','LAUNCH-001');
DELETE FROM blocker_seed_links WHERE blocker_id = 'BLK-006'
  AND requirement_id IN ('IDENT-002','IDENT-005','SEC-006','SEC-007','SUP-005','LAUNCH-001');

INSERT OR IGNORE INTO blocker_seed_links (blocker_id, requirement_id) VALUES
('BLK-016','IDENT-002'),('BLK-016','IDENT-005'),
('BLK-017','SEC-007'),
('BLK-018','SEC-006'),
('BLK-019','SUP-005'),
('BLK-020','LAUNCH-001');
