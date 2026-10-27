-- LEGAL-005 tax configuration. Records ONLY what the Founder enters: whether the business is registered to
-- collect sales tax, the jurisdictions with registration ids and rates, which products are taxable, and
-- whether Stripe Tax is planned (a flag; the platform does not enable Stripe Tax). Nothing is pre-filled:
-- with no row (or registered = 0, or no applied jurisdiction) tax is "not configured" and no tax is added.

CREATE TABLE tax_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  registered INTEGER NOT NULL DEFAULT 0 CHECK (registered IN (0, 1)),
  stripe_tax_planned INTEGER NOT NULL DEFAULT 0 CHECK (stripe_tax_planned IN (0, 1)),
  notes TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- Rates are stored in parts per million of the taxable amount (7.25% = 72500) so every rate the Founder
-- can type with up to four decimals is exact. `applied` = this rate is charged on taxable sales.
CREATE TABLE tax_jurisdictions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  rate_ppm INTEGER NOT NULL CHECK (rate_ppm >= 0 AND rate_ppm <= 1000000),
  applied INTEGER NOT NULL DEFAULT 1 CHECK (applied IN (0, 1)),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- Product keys marked taxable by the Founder (package ids, maintenance plan ids, 'custom', 'change_order').
CREATE TABLE tax_taxable_products (
  product_key TEXT PRIMARY KEY,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- Tax snapshot on each invoice, fixed when the invoice is issued. subtotal_cents NULL = issued without a tax
-- calculation (tax not configured): amount_cents is then the whole amount and documents say "not a tax invoice".
-- When set, amount_cents = subtotal_cents + tax_cents (the amount due, which Stripe charges).
ALTER TABLE invoices ADD COLUMN subtotal_cents INTEGER;
ALTER TABLE invoices ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN tax_detail_json TEXT;
