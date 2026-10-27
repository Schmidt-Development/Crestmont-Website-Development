-- Crestmont core schema (Cloudflare D1 / SQLite dialect).
-- Money is stored as integer cents. Timestamps are ISO-8601 UTC text.
PRAGMA foreign_keys = ON;

-- ───────────── Identity & access ─────────────
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('customer','internal')),
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  email_verified_at TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0,1)),
  disabled_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY CHECK (id IN ('owner','administrator','sales','developer','project_manager','support','customer_admin','customer_member'))
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, organization_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  mfa_verified INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);

-- ───────────── Catalog ─────────────
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('package','addon','maintenance','custom')),
  name TEXT NOT NULL,
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  billing TEXT NOT NULL CHECK (billing IN ('one_time','monthly','quoted')),
  revision_rounds INTEGER,
  page_limit INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  approved_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- ───────────── CRM ─────────────
CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT,
  industry TEXT,
  organization_id TEXT REFERENCES organizations(id),
  created_at TEXT NOT NULL
);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id),
  name TEXT NOT NULL,
  email TEXT COLLATE NOCASE,
  phone TEXT,
  user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_contacts_email ON contacts(email);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  source TEXT NOT NULL CHECK (source IN ('web_form','quote_form','ai_receptionist','referral','manual','checkout')),
  stage TEXT NOT NULL CHECK (stage IN ('new','qualified','quote_required','quote_sent','negotiation','accepted','awaiting_payment','converted','lost','rejected','archived')),
  owner_user_id TEXT REFERENCES users(id),
  interest TEXT,
  message TEXT,
  qualification_notes TEXT,
  lost_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_leads_stage ON leads(stage);
CREATE INDEX idx_leads_owner ON leads(owner_user_id);

CREATE TABLE crm_activities (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('note','call','email','stage_change','task','system')),
  body TEXT NOT NULL,
  due_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_crm_activities_lead ON crm_activities(lead_id);

-- ───────────── Sales ─────────────
CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  status TEXT NOT NULL CHECK (status IN ('draft','sent','accepted','rejected','expired','superseded')),
  current_version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE quote_versions (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  line_items_json TEXT NOT NULL,
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  payment_schedule TEXT NOT NULL CHECK (payment_schedule IN ('upfront','milestone_50_25_25')),
  scope_text TEXT NOT NULL,
  valid_until TEXT,
  accepted_at TEXT,
  accepted_by_contact_id TEXT REFERENCES contacts(id),
  created_at TEXT NOT NULL,
  UNIQUE (quote_id, version)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  quote_version_id TEXT REFERENCES quote_versions(id),
  product_id TEXT REFERENCES products(id),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending_payment','paid','partially_paid','refunded','cancelled')),
  stripe_checkout_session_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  order_id TEXT REFERENCES orders(id),
  project_id TEXT REFERENCES projects(id),
  milestone_kind TEXT CHECK (milestone_kind IN ('full','deposit_50','design_25','prelaunch_25','change_order','subscription')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('draft','open','paid','void','uncollectible')),
  stripe_invoice_id TEXT UNIQUE,
  due_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL
);
-- One milestone invoice of each kind per project (duplicate billing prevention).
CREATE UNIQUE INDEX uq_invoice_project_milestone ON invoices(project_id, milestone_kind)
  WHERE project_id IS NOT NULL AND milestone_kind IN ('deposit_50','design_25','prelaunch_25','full');

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  invoice_id TEXT REFERENCES invoices(id),
  order_id TEXT REFERENCES orders(id),
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER,
  stripe_payment_intent_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','refunded','partially_refunded','disputed')),
  created_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  stripe_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','canceled','incomplete','unpaid')),
  current_period_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  evidence TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested','under_review','recommended','approved','denied','issued','failed')),
  requested_by TEXT NOT NULL REFERENCES users(id),
  reviewed_by TEXT REFERENCES users(id),
  review_notes TEXT,
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  mandatory_obligation INTEGER NOT NULL DEFAULT 0,
  stripe_refund_id TEXT UNIQUE,
  customer_notified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,               -- Stripe event id (evt_...) => idempotency key
  type TEXT NOT NULL,
  object_id TEXT,
  stripe_created INTEGER NOT NULL,   -- event.created (seconds) for out-of-order handling
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received','processed','ignored','failed','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

-- ───────────── Projects ─────────────
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  order_id TEXT REFERENCES orders(id),
  product_id TEXT REFERENCES products(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('purchased','awaiting_onboarding','scope_review','design','development','internal_qa','customer_review','revisions','final_approval','deployment','completed','maintenance','paused','cancelled')),
  paused_from_status TEXT,
  revision_allowance INTEGER NOT NULL CHECK (revision_allowance >= 0),
  payment_schedule TEXT NOT NULL CHECK (payment_schedule IN ('upfront','milestone_50_25_25')),
  last_customer_activity_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_projects_org ON projects(organization_id);

CREATE TABLE project_scopes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  scope_text TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT REFERENCES users(id),
  UNIQUE (project_id, version)
);

CREATE TABLE onboarding_responses (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  answers_json TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','in_progress','done','blocked')),
  due_at TEXT,
  completed_at TEXT
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('todo','in_progress','review','done','blocked')),
  estimate_minutes INTEGER,
  due_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('task','lead','ticket','project')),
  subject_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  assigned_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_assignments_user ON assignments(user_id, ended_at);

CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  minutes INTEGER NOT NULL CHECK (minutes > 0),
  hourly_cost_cents INTEGER,       -- NULL = unknown cost, never coerced to 0
  worked_on TEXT NOT NULL
);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round INTEGER NOT NULL CHECK (round >= 1),
  request_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted','in_progress','delivered','approved')),
  billable_change_order_id TEXT REFERENCES change_orders(id),
  submitted_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, round)
);

CREATE TABLE change_orders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_text TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','paid','completed')),
  approved_by_contact_id TEXT REFERENCES contacts(id),
  invoice_id TEXT REFERENCES invoices(id),
  task_id TEXT REFERENCES tasks(id),
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('scope','design','revision','engineering_complete','internal_qa','security_accessibility','customer_launch','payment_verified','deployment_authorized','final_acceptance')),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_by TEXT NOT NULL REFERENCES users(id),
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_approvals_project ON approvals(project_id, kind);

CREATE TABLE project_costs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  category TEXT NOT NULL CHECK (category IN ('labor','hosting','ai_usage','third_party_api','software_license','payment_fee','other')),
  amount_cents INTEGER,            -- NULL = unknown
  description TEXT NOT NULL,
  incurred_on TEXT NOT NULL
);

CREATE TABLE customer_deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  url TEXT NOT NULL,
  commit_sha TEXT,
  deployed_by TEXT NOT NULL REFERENCES users(id),
  deployed_at TEXT NOT NULL
);

-- ───────────── Collaboration ─────────────
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT REFERENCES projects(id),
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL,
  scan_status TEXT NOT NULL CHECK (scan_status IN ('pending','clean','infected','failed')),
  folder TEXT,
  replaced_by TEXT REFERENCES files(id),
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  deleted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT REFERENCES projects(id),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  attachment_file_id TEXT REFERENCES files(id),
  created_at TEXT NOT NULL
);
CREATE TABLE message_reads (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  read_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

-- ───────────── Support ─────────────
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT REFERENCES projects(id),
  subject TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('technical','billing','content_change','account','refund','other')),
  priority TEXT NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL CHECK (status IN ('open','pending_staff','pending_customer','escalated','resolved','closed')),
  opened_by TEXT NOT NULL REFERENCES users(id),
  first_response_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tickets_org ON tickets(organization_id, status);

CREATE TABLE ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id),
  body TEXT NOT NULL,
  internal INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0,1)),
  ai_draft_job_id TEXT REFERENCES ai_jobs(id),
  approved_by TEXT REFERENCES users(id),
  attachment_file_id TEXT REFERENCES files(id),
  created_at TEXT NOT NULL
);

-- ───────────── Communications ─────────────
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at);

CREATE TABLE email_deliveries (
  id TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  to_email TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','bounced','failed','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ───────────── AI & voice ─────────────
CREATE TABLE ai_jobs (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','awaiting_approval','approved','rejected')),
  input_ref TEXT NOT NULL,
  output_ref TEXT,
  cost_microusd INTEGER,           -- NULL = unknown
  error TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_call_id TEXT NOT NULL,
  from_number TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  outcome TEXT CHECK (outcome IN ('lead_captured','callback_requested','support_routed','escalated','info_only','abandoned','error')),
  lead_id TEXT REFERENCES leads(id),
  recording_consent INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  cost_microusd INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (provider, provider_call_id)
);

-- ───────────── CMS & portfolio ─────────────
CREATE TABLE portfolio_projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  industry TEXT NOT NULL,
  live_url TEXT NOT NULL,
  relationship TEXT NOT NULL,      -- documented relationship to Crestmont
  description TEXT NOT NULL,
  verified_features_json TEXT NOT NULL,
  technology_summary TEXT,
  desktop_screenshot_file_id TEXT REFERENCES files(id),
  mobile_screenshot_file_id TEXT REFERENCES files(id),
  screenshot_captured_at TEXT,
  link_verified_at TEXT,
  position INTEGER NOT NULL,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE testimonials (
  id TEXT PRIMARY KEY,
  portfolio_project_id TEXT REFERENCES portfolio_projects(id),
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  verification_evidence TEXT NOT NULL,
  verified_by TEXT NOT NULL REFERENCES users(id),
  published INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE cms_entries (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  published_revision_id TEXT
);
CREATE TABLE cms_revisions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES cms_entries(id) ON DELETE CASCADE,
  body_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','pending_founder_approval','published','archived')),
  requires_founder_approval INTEGER NOT NULL DEFAULT 0,
  author_user_id TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- ───────────── Legal ─────────────
CREATE TABLE agreements (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  attorney_reviewed INTEGER NOT NULL DEFAULT 0,
  effective_at TEXT,
  UNIQUE (kind, version)
);
CREATE TABLE agreement_acceptances (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL REFERENCES agreements(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  ip TEXT,
  accepted_at TEXT NOT NULL
);

-- ───────────── Privacy ─────────────
CREATE TABLE privacy_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('export','deletion')),
  status TEXT NOT NULL CHECK (status IN ('received','in_progress','completed','denied')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

-- ───────────── Audit (append-only) ─────────────
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','system','ai','webhook')),
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  organization_id TEXT,
  details_json TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_subject ON audit_logs(subject_type, subject_id);
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
  BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
  BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

INSERT INTO roles (id) VALUES ('owner'),('administrator'),('sales'),('developer'),('project_manager'),('support'),('customer_admin'),('customer_member');
