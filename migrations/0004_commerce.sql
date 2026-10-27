-- Commerce links and catalog seed (server-side source of truth mirrors src/domain/catalog.ts).
ALTER TABLE organizations ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'package' CHECK (kind IN ('package','quote','change_order','subscription'));
ALTER TABLE orders ADD COLUMN lead_id TEXT REFERENCES leads(id);
ALTER TABLE invoices ADD COLUMN stripe_checkout_session_id TEXT;
ALTER TABLE invoices ADD COLUMN description TEXT;
ALTER TABLE payments ADD COLUMN stripe_charge_id TEXT;
ALTER TABLE projects ADD COLUMN project_manager_id TEXT REFERENCES users(id);
ALTER TABLE projects ADD COLUMN live_url TEXT;
ALTER TABLE projects ADD COLUMN target_launch_at TEXT;

CREATE TABLE disputes (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id),
  payment_id TEXT REFERENCES payments(id),
  stripe_dispute_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,
  evidence_due_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE handoffs (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  website_url TEXT,
  access_instructions TEXT,
  ownership_notes TEXT,
  training_notes TEXT,
  documentation_file_id TEXT REFERENCES files(id),
  published_at TEXT,
  accepted_at TEXT,
  accepted_by TEXT REFERENCES users(id)
);

CREATE UNIQUE INDEX uq_subscription_org_product_active ON subscriptions(organization_id, product_id) WHERE status IN ('active','trialing','past_due');

INSERT INTO products (id, kind, name, price_cents, billing, revision_rounds, page_limit, active, version, updated_at) VALUES
 ('starter','package','Starter',99900,'one_time',2,5,1,1,'2026-10-26T00:00:00Z'),
 ('business','package','Business',249900,'one_time',3,12,1,1,'2026-10-26T00:00:00Z'),
 ('premium','package','Premium',499900,'one_time',4,25,1,1,'2026-10-26T00:00:00Z'),
 ('custom','custom','Custom development',NULL,'quoted',NULL,NULL,1,1,'2026-10-26T00:00:00Z'),
 ('essential','maintenance','Essential maintenance',9900,'monthly',NULL,NULL,1,1,'2026-10-26T00:00:00Z'),
 ('professional','maintenance','Professional maintenance',19900,'monthly',NULL,NULL,1,1,'2026-10-26T00:00:00Z'),
 ('executive','maintenance','Executive maintenance',29900,'monthly',NULL,NULL,1,1,'2026-10-26T00:00:00Z');
