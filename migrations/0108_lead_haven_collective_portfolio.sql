-- Lead Haven Collective as a live, interactive portfolio entry (Owner, 2026-11-15, in writing: "FIX LEAD HAVEN
-- COLLECTIVE FIRST … target https://crestmontwebsitedevelopment.com/portfolio/lead-haven-collective … get the live
-- website embedding working correctly for this project, including any necessary authorized configuration changes on
-- the destination website"; recorded in docs/frontend/PORTFOLIO.md). The Owner owns and controls the site and
-- authorized leadhavencollective.com to permit framing by crestmontwebsitedevelopment.com only.
--
-- The existing record is kept: its name, description, features, technology summary and position are NOT changed.
-- Only requirements that are still missing are recorded from that written instruction (relationship, link
-- verification, the owner's display consent), and never over a recorded consent withdrawal. The entry is then marked
-- to publish itself once every publishing requirement is met — which, with no screenshots, means once the Worker's
-- own check confirms that the live site permits framing (publish_when_ready, cleared after it runs once).
-- If no record exists, one is created at the end of the order from the site's own published copy.
INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, technology_summary, position, published, updated_at, created_at)
SELECT 'pf_lead_haven_collective', 'lead-haven-collective', 'Lead Haven Collective', 'B2B lead marketplace', 'https://leadhavencollective.com/',
  'Founder-owned business — website designed and developed in-house by the Crestmont team',
  'Website for a multi-industry B2B lead marketplace. Visitors explore lead categories by industry, review transparent qualification criteria and build a lead package of 1,000 to 150,000 leads with live pricing, around an interactive 3D Earth.
Customers sign in to a private account for their orders and downloads, and privacy requests have their own form.',
  '["Interactive 3D Earth scene on the landing page","Lead package builder with industry search, quantity selection and live pricing","Private customer account for orders and downloads","Privacy request form"]',
  'Cloudflare Worker with D1, R2 and scheduled jobs; the static site is served by the Worker.',
  (SELECT COALESCE(MAX(position), 0) + 1 FROM portfolio_projects WHERE archived_at IS NULL), 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE NOT EXISTS (SELECT 1 FROM portfolio_projects WHERE slug = 'lead-haven-collective');

INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at)
SELECT NULL, 'system', 'portfolio.relationship_documented', 'portfolio_project', id, '{"source":"migration-0108","authorization":"owner-2026-11-15"}', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM portfolio_projects WHERE slug = 'lead-haven-collective' AND archived_at IS NULL AND relationship_documented_at IS NULL;
UPDATE portfolio_projects SET
  relationship = CASE WHEN relationship LIKE '%pending%' OR length(trim(relationship)) < 5 THEN 'Founder-owned business — website designed and developed in-house by the Crestmont team' ELSE relationship END,
  relationship_evidence = 'The Owner of Crestmont Website Development, who owns and controls Lead Haven Collective (leadhavencollective.com and its source repository), instructed in writing on 2026-11-15 that it be shown as a live, interactive portfolio entry at https://crestmontwebsitedevelopment.com/portfolio/lead-haven-collective, and authorized the framing configuration on leadhavencollective.com (instruction recorded in docs/frontend/PORTFOLIO.md).',
  relationship_documented_at = '2026-11-15T00:00:00.000Z', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE slug = 'lead-haven-collective' AND archived_at IS NULL AND relationship_documented_at IS NULL;

INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at)
SELECT NULL, 'system', 'portfolio.link_verified', 'portfolio_project', id, json_object('date', '2026-11-15', 'url', live_url, 'source', 'migration-0108'), NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM portfolio_projects WHERE slug = 'lead-haven-collective' AND archived_at IS NULL AND link_verified_at IS NULL AND live_url LIKE 'https://leadhavencollective.com%';
UPDATE portfolio_projects SET link_verified_at = '2026-11-15T00:00:00.000Z', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE slug = 'lead-haven-collective' AND archived_at IS NULL AND link_verified_at IS NULL AND live_url LIKE 'https://leadhavencollective.com%';

INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at)
SELECT NULL, 'system', 'portfolio.consent_recorded', 'portfolio_project', id, '{"source":"migration-0108","method":"written","givenOn":"2026-11-15"}', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM portfolio_projects WHERE slug = 'lead-haven-collective' AND archived_at IS NULL AND portfolio_consent_at IS NULL AND portfolio_consent_withdrawn_at IS NULL;
UPDATE portfolio_projects SET portfolio_consent_at = '2026-11-15T00:00:00.000Z', portfolio_consent_by = 'Crestmont''s Founder, as owner of Lead Haven Collective', portfolio_consent_method = 'written',
  portfolio_consent_evidence = 'Written instruction of 2026-11-15 to show Lead Haven Collective as a live, interactive entry at https://crestmontwebsitedevelopment.com/portfolio/lead-haven-collective (recorded in docs/frontend/PORTFOLIO.md).',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE slug = 'lead-haven-collective' AND archived_at IS NULL AND portfolio_consent_at IS NULL AND portfolio_consent_withdrawn_at IS NULL;

UPDATE portfolio_projects SET publish_when_ready = 1
 WHERE slug = 'lead-haven-collective' AND archived_at IS NULL AND published = 0 AND portfolio_consent_withdrawn_at IS NULL;
