-- Restore Glassly Auto Glass (pf_glassly_auto_glass) to the portfolio (Founder, 2026-11-12).
--
-- Why it was missing: production's portfolio rows come only from migration 0005, which seeded three projects. Glassly is
-- defined in src/content/portfolio-projects.ts and reaches a database only through scripts/portfolio-setup.ts, which
-- runs on every staging deploy but never on production. Nothing deleted, unpublished or archived it.
--
-- This inserts the original entry exactly as defined there (Founder authorization of 2026-10-27, verified link, the
-- bundled screenshots) and publishes it. It never duplicates: nothing happens when a row with this id or slug exists
-- (staging already has it). Position: 2, its original place, moving later entries down one; but if the Owner has ever
-- saved an explicit order (a portfolio.reordered audit entry), that order is kept and Glassly goes last.
UPDATE portfolio_projects SET position = position + 1
 WHERE position >= 2 AND NOT EXISTS (SELECT 1 FROM portfolio_projects WHERE id = 'pf_glassly_auto_glass' OR slug = 'glassly-auto-glass') AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE action = 'portfolio.reordered');
INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at)
SELECT NULL, 'system', 'portfolio.restored', 'portfolio_project', 'pf_glassly_auto_glass', '{"source":"migration-0104","reason":"never seeded in production"}', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE NOT EXISTS (SELECT 1 FROM portfolio_projects WHERE id = 'pf_glassly_auto_glass' OR slug = 'glassly-auto-glass');
INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, technology_summary,
  position, published, updated_at, created_at, relationship_documented_at, relationship_evidence, link_verified_at, published_at,
  demo_url, demo_status, poster_desktop_asset, poster_mobile_asset, poster_tablet_asset,
  portfolio_consent_at, portfolio_consent_by, portfolio_consent_method, portfolio_consent_evidence)
SELECT 'pf_glassly_auto_glass', 'glassly-auto-glass', 'Glassly Auto Glass', 'Auto glass', 'https://glasslyautoglass.com', 'Founder-owned business — website designed and developed in-house by the Crestmont team', 'Single-page website for OEM auto glass replacement with a scroll-driven hero sequence and an instant-quote form.
The quote engine decodes the vehicle''s VIN, checks configuration and pricing confidence, and either returns a locked price or routes the request to a specialist for a manual quote.', '["Scroll-driven hero sequence for desktop and mobile","VIN decoding through NHTSA''s public decoder","Instant or manual quote outcome with confidence checks","Server-side validation of every submitted field"]', 'Static front end with a Node.js serverless quote API.',
  CASE WHEN EXISTS (SELECT 1 FROM audit_logs WHERE action = 'portfolio.reordered') THEN (SELECT COALESCE(MAX(position), 0) + 1 FROM portfolio_projects) ELSE 2 END,
  1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '2026-10-27T00:00:00.000Z', 'Founder Noah Schmidt confirmed in writing on 2026-10-27 that he owns this business and website, authorized its name, logo, public website imagery and interactive demonstration to appear in Crestmont''s portfolio, and confirmed that the Crestmont team may claim full development credit (instruction recorded in docs/frontend/PORTFOLIO.md).', '2026-10-27T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL, 'none', '/assets/portfolio/glassly-auto-glass-desktop.webp', '/assets/portfolio/glassly-auto-glass-mobile.webp', '/assets/portfolio/glassly-auto-glass-tablet.webp',
  '2026-10-27T00:00:00.000Z', 'Noah Schmidt, Founder and business owner', 'written', 'Founder Noah Schmidt confirmed in writing on 2026-10-27 that he owns this business and website, authorized its name, logo, public website imagery and interactive demonstration to appear in Crestmont''s portfolio, and confirmed that the Crestmont team may claim full development credit (instruction recorded in docs/frontend/PORTFOLIO.md).'
 WHERE NOT EXISTS (SELECT 1 FROM portfolio_projects WHERE id = 'pf_glassly_auto_glass' OR slug = 'glassly-auto-glass');
