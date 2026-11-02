-- FD-13 (Founder decision, 2026-11): a website is shown as portfolio work only after the website owner's explicit,
-- recorded opt-in. Silence, a signed contract alone or a launch is never consent. Publishing requires these fields
-- (src/services/portfolio.ts publishBlockers); withdrawing consent unpublishes the entry.
--   portfolio_consent_at        when the owner opted in
--   portfolio_consent_by        who gave it (name and role at the business)
--   portfolio_consent_method    how it was given: written (email/letter/signed form) or portal (recorded in the portal)
--   portfolio_consent_evidence  where the record is kept
--   portfolio_consent_recorded_by  the staff member who recorded it
--   portfolio_consent_withdrawn_at  set when the owner withdraws consent

ALTER TABLE portfolio_projects ADD COLUMN portfolio_consent_at TEXT;
ALTER TABLE portfolio_projects ADD COLUMN portfolio_consent_by TEXT;
ALTER TABLE portfolio_projects ADD COLUMN portfolio_consent_method TEXT CHECK (portfolio_consent_method IS NULL OR portfolio_consent_method IN ('written', 'portal'));
ALTER TABLE portfolio_projects ADD COLUMN portfolio_consent_evidence TEXT;
ALTER TABLE portfolio_projects ADD COLUMN portfolio_consent_recorded_by TEXT REFERENCES users(id);
ALTER TABLE portfolio_projects ADD COLUMN portfolio_consent_withdrawn_at TEXT;

-- Backfill: entries whose documented relationship is the Founder's own business carry his written authorization of
-- 2026-10-27 (src/content/portfolio-projects.ts FOUNDER_AUTHORIZATION). That authorization is an explicit opt-in by the
-- business owner, so it is recorded as consent. Every other entry stays without consent and cannot be published.
UPDATE portfolio_projects
   SET portfolio_consent_at = relationship_documented_at,
       portfolio_consent_by = 'Noah Schmidt, Founder and business owner',
       portfolio_consent_method = 'written',
       portfolio_consent_evidence = relationship_evidence
 WHERE relationship_documented_at IS NOT NULL
   AND relationship LIKE 'Founder-owned business%'
   AND relationship_evidence LIKE 'Founder Noah Schmidt confirmed in writing on 2026-10-27%';
