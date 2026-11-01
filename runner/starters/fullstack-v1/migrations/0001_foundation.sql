-- Crestmont full-stack starter v1: foundation schema (Cloudflare D1 / SQLite).
-- One database per customer website (its own D1 binding): no other business's data lives here.
-- Forward-only, versioned migrations: add 0002_*.sql for changes; never edit an applied file.
PRAGMA foreign_keys = ON;

CREATE TABLE schema_info (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO schema_info (key, value) VALUES ('foundation', 'fullstack-v1');

-- Settings the administrator can change (hours, blackout dates, notification addresses). Defaults: business.config.json.
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  price_note TEXT,
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 1440),
  bookable INTEGER NOT NULL DEFAULT 0 CHECK (bookable IN (0, 1)),
  payable INTEGER NOT NULL DEFAULT 0 CHECK (payable IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 100),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE TABLE resource_services (
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (resource_id, service_id)
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  service_id TEXT NOT NULL REFERENCES services(id),
  resource_id TEXT NOT NULL REFERENCES resources(id),
  customer_id TEXT REFERENCES customers(id),
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  address TEXT,
  postal_code TEXT,
  notes TEXT,
  start_at TEXT NOT NULL,             -- UTC ISO instant
  end_at TEXT NOT NULL,               -- UTC ISO instant (start + duration)
  block_start_at TEXT NOT NULL,       -- start - buffer (what the resource is blocked for)
  block_end_at TEXT NOT NULL,         -- end + buffer
  time_zone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'completed', 'no_show')),
  manage_token_hash TEXT NOT NULL,
  payment_required INTEGER NOT NULL DEFAULT 0 CHECK (payment_required IN (0, 1)),
  hold_expires_at TEXT,               -- pending_payment bookings release their slot after this
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_at > start_at),
  CHECK (block_end_at >= end_at AND block_start_at <= start_at)
);
CREATE INDEX idx_bookings_resource_time ON bookings(resource_id, block_start_at, block_end_at);
CREATE INDEX idx_bookings_status ON bookings(status, start_at);

CREATE TABLE booking_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,                -- 'customer' | 'admin:<user id>' | 'system' | 'stripe'
  note TEXT,
  at TEXT NOT NULL
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  service_id TEXT REFERENCES services(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  postal_code TEXT,
  city TEXT,
  details TEXT NOT NULL,
  preferred_date TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'quoted', 'won', 'lost')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE contact_messages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'answered', 'archived')),
  created_at TEXT NOT NULL
);

-- Payments through the CUSTOMER's own Stripe account. A row is "paid" only from a verified webhook (or a
-- reconciliation read from Stripe), never from a browser redirect. No card data is ever stored.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT REFERENCES bookings(id),
  provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe')),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  checkout_session_id TEXT UNIQUE,
  payment_intent_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'expired', 'failed', 'refunded', 'partially_refunded')),
  refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_payments_booking ON payments(booking_id);

CREATE TABLE webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE admin_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('admin', 'customer')),
  subject_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  detail_json TEXT,
  at TEXT NOT NULL
);

-- Transactional email outbox: written in the same request as the business change, delivered by the scheduled
-- handler through the CUSTOMER's own mail provider. Without a configured provider messages stay 'queued' (visible to
-- the administrator as "email not configured"); they are never reported as sent.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  to_address TEXT NOT NULL,
  template TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  provider_message_id TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX idx_notifications_status ON notifications(status, created_at);
