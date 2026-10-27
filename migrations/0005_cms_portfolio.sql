-- Area A: public website, CMS and portfolio (WEB-*, CMS-*, PORT-004..007).
-- cms_entries / cms_revisions / portfolio_projects / testimonials are defined in 0001_core.sql.

-- Relationship documentation and publish bookkeeping for portfolio projects (§13, PORT-005).
ALTER TABLE portfolio_projects ADD COLUMN relationship_documented_at TEXT;
ALTER TABLE portfolio_projects ADD COLUMN relationship_documented_by TEXT REFERENCES users(id);
ALTER TABLE portfolio_projects ADD COLUMN relationship_evidence TEXT;
ALTER TABLE portfolio_projects ADD COLUMN link_verified_by TEXT REFERENCES users(id);
ALTER TABLE portfolio_projects ADD COLUMN published_at TEXT;
ALTER TABLE portfolio_projects ADD COLUMN created_at TEXT;

ALTER TABLE testimonials ADD COLUMN created_at TEXT;

ALTER TABLE cms_revisions ADD COLUMN published_at TEXT;
ALTER TABLE cms_revisions ADD COLUMN note TEXT;
CREATE INDEX idx_cms_revisions_entry ON cms_revisions(entry_id, created_at);
CREATE INDEX idx_portfolio_position ON portfolio_projects(published, position);

-- Optional structured details captured by the public quote form (WEB-005). The same details are
-- also written into the lead message so the CRM shows them without a join.
CREATE TABLE lead_request_details (
  lead_id TEXT PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  service_slug TEXT,
  budget_range TEXT,
  timeline TEXT,
  created_at TEXT NOT NULL
);

-- The three Founder-authorized portfolio projects (§13). Seeded UNPUBLISHED:
--  * genuine screenshots do not exist yet (BLK-007) → screenshot ids NULL;
--  * the relationship to Crestmont is not yet documented (BLK-008);
--  * descriptions contain only facts verified by page-text inspection on 2026-10-26
--    (docs/BUILD_LEDGER.md). Owner-reported business figures are deliberately omitted.
INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json,
  technology_summary, desktop_screenshot_file_id, mobile_screenshot_file_id, screenshot_captured_at, link_verified_at, position, published, updated_at, created_at)
VALUES
 ('pf_better_lansing_mechanics', 'better-lansing-mechanics', 'Better Lansing Mechanics', 'Automotive repair (Lansing, Michigan)',
  'https://betterlansingmechanics.com',
  'Founder-authorized portfolio project — relationship documentation pending (BLK-008)',
  'Website for an auto repair shop in Lansing, Michigan. The site presents a catalogue of repair services, offers a Spanish-language version, includes a customer login and portal, a callback request form, and before-and-after image sliders. The site itself states that online appointments, the phone/AI receptionist and SMS features are not yet active.',
  '["Services catalogue","Spanish-language version","Customer login and portal","Callback request form","Before-and-after image sliders","Site states online appointments, phone/AI receptionist and SMS are not yet active"]',
  NULL, NULL, NULL, NULL, NULL, 1, 0, '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z'),
 ('pf_lansing_car_rentals', 'lansing-car-rentals', 'Lansing Car Rentals', 'Car rental (Lansing, Michigan)',
  'https://lansingcarrentals.com',
  'Founder-authorized portfolio project — relationship documentation pending (BLK-008)',
  'Single-page website for a car rental business. Bookings are made through links to the Turo platform, and the site includes a partner application page.',
  '["Single-page website","Booking via links to Turo","Partner application page"]',
  NULL, NULL, NULL, NULL, NULL, 2, 0, '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z'),
 ('pf_lcr_mentorship', 'lansing-car-rentals-mentorship', 'Lansing Car Rentals Mentorship', 'Mentorship / consulting',
  'https://mentorship.lansingcarrentals.com',
  'Founder-authorized portfolio project — relationship documentation pending (BLK-008)',
  'Single-page booking site for a paid 30-minute mentorship call, with payment through Stripe-hosted checkout and a published no-refund policy.',
  '["Single-page booking for a paid 30-minute call","Stripe-hosted checkout","Published no-refund policy"]',
  NULL, NULL, NULL, NULL, NULL, 3, 0, '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z');
