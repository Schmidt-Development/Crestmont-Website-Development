-- Founder requirement (2026-11): customers describe the website they want BEFORE they pay. The purchase journey is
-- select package → website intake → review scope and pricing → accept agreements → Stripe payment → fulfilment.
-- A purchase intake holds the same answers as onboarding_responses (src/services/onboarding.ts ONBOARDING_SECTIONS,
-- validated by validateOnboarding) for a purchase that has no project yet:
--  * a standard package: keyed by organization + product_id (one open intake per organization and package);
--  * an accepted quote: keyed by organization + quote_version_id (one intake per accepted quote version).
-- order_id is stamped when checkout creates (or reuses) the order. When the paid order provisions its project,
-- provisionProjectOnce copies the completed intake into onboarding_responses and sets project_id in the same batch;
-- a later purchase of the same package then starts a fresh intake. Additive only: existing project-scoped
-- onboarding (onboarding_responses) is unchanged and still serves projects whose order had no purchase intake.
CREATE TABLE purchase_intakes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  product_id TEXT,
  quote_version_id TEXT REFERENCES quote_versions(id),
  order_id TEXT REFERENCES orders(id),
  project_id TEXT REFERENCES projects(id),
  answers_json TEXT NOT NULL DEFAULT '{}',
  completed_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((product_id IS NULL) <> (quote_version_id IS NULL))
);
CREATE UNIQUE INDEX uq_purchase_intakes_open_product ON purchase_intakes (organization_id, product_id) WHERE product_id IS NOT NULL AND project_id IS NULL;
CREATE UNIQUE INDEX uq_purchase_intakes_quote_version ON purchase_intakes (organization_id, quote_version_id) WHERE quote_version_id IS NOT NULL;
CREATE UNIQUE INDEX uq_purchase_intakes_project ON purchase_intakes (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_purchase_intakes_order ON purchase_intakes (order_id) WHERE order_id IS NOT NULL;
