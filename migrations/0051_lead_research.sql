-- Lead research, numbered 0051: 0047 is sales optimization, 0048-0049 CRM contact identity (#50), 0050 runner diagnostics (#64). Independent additive tables. (Proposed RESEARCH-001..006; tests tagged with existing CRM/DATA/SEC/OWN ids until the inventory is extended.)
-- The Windows research worker (research-worker/) does the bulk work locally (DuckDB over open datasets, website
-- verification, audits, local model). This database receives only candidate prospects with their evidence, through
-- the HMAC-signed API in src/routes/research.ts. The CRM (leads/contacts/companies) stays the system of record:
-- a prospect becomes a CRM lead only through an audited promotion, never as a parallel sales database.
-- Nothing here dials anyone. Outbound eligibility is computed fail-closed (src/domain/research.ts#outboundEligibility).

-- One row. Research starts PAUSED: the Owner resumes it in /staff/research after reviewing the source licences.
CREATE TABLE research_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 1 CHECK (paused IN (0,1)),
  pause_reason TEXT,
  qualify_threshold INTEGER NOT NULL DEFAULT 60 CHECK (qualify_threshold BETWEEN 0 AND 100),
  max_batch INTEGER NOT NULL DEFAULT 200 CHECK (max_batch BETWEEN 1 AND 500),
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
INSERT INTO research_settings (id, paused, pause_reason, updated_at) VALUES (1, 1, 'Not started: review data-source licences, then resume', '2026-10-30T00:00:00.000Z');

-- Data-source register: licence and permitted use as verified (docs/research/DATA-SOURCES.md). A disabled source is
-- refused at ingest, so a worker that still has it configured cannot push its records.
CREATE TABLE research_sources (
  source TEXT PRIMARY KEY CHECK (source IN ('overture','foursquare_os','osm_geofabrik','common_crawl','open_data')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  role TEXT NOT NULL,                 -- what the source is used for
  license TEXT NOT NULL,
  attribution TEXT NOT NULL,
  use_terms TEXT NOT NULL,            -- conditions that limit how its data may be used here
  disabled_reason TEXT,
  terms_url TEXT NOT NULL,
  verified_at TEXT NOT NULL
);
INSERT INTO research_sources VALUES
 ('overture', 1, 'Primary business records (name, category, address, phone, website fields)', 'CDLA-Permissive-2.0 / Apache-2.0 (Foursquare-sourced rows) / CC0-1.0 (AllThePlaces rows), per row',
  'Overture Maps Foundation, overturemaps.org; Foursquare rows: keep the Foursquare NOTICE', 'Commercial use permitted; per-row licence kept in provenance; licence copy and attribution travel with any redistribution', NULL,
  'https://docs.overturemaps.org/attribution/', '2026-10-30T00:00:00.000Z'),
 ('foursquare_os', 0, 'Secondary business records', 'Apache-2.0',
  'Foursquare Labs, Inc. (NOTICE.txt preserved)', 'Releases since Oct 2025 require a Foursquare Places-portal account and token, or a gated Hugging Face agreement that lets Foursquare use the company name and logo in its marketing',
  'Needs the Founder to register and accept the access terms (gated access); Foursquare-sourced rows already arrive inside Overture under Apache-2.0',
  'https://opensource.foursquare.com/places-notice-txt/', '2026-10-30T00:00:00.000Z'),
 ('osm_geofabrik', 0, 'Additional business records (US state extracts)', 'ODbL-1.0',
  '© OpenStreetMap contributors', 'Internal use only: combining OSM with other data makes a Derivative Database; any Public Use (sharing outside Crestmont) triggers share-alike',
  'Off until the Founder confirms OSM-derived records stay internal (CRM use only, never exported or shared)',
  'https://osmfoundation.org/wiki/Licence_and_Legal_FAQ', '2026-10-30T00:00:00.000Z'),
 ('common_crawl', 1, 'Website-discovery evidence only (does a candidate domain exist / respond in the crawl)', 'Common Crawl Terms of Use',
  'Common Crawl Foundation', 'No republishing of crawl content, no reselling access; columnar index only (the CDX API is rate-limited); respect crawled sites'' terms',
  NULL, 'https://commoncrawl.org/terms-of-use', '2026-10-30T00:00:00.000Z'),
 ('open_data', 0, 'Optional business-identity enrichment (Data.gov, state portals)', 'Varies per dataset',
  'Per dataset', 'Each dataset''s licence must be reviewed and recorded before use', 'No dataset reviewed yet',
  'https://catalog.data.gov/', '2026-10-30T00:00:00.000Z');

-- Workers that have checked in (one row per runner id); status_json is the worker's own last report.
CREATE TABLE research_runners (
  runner_id TEXT PRIMARY KEY,
  version TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status_json TEXT NOT NULL DEFAULT '{}'
);

-- Worker-reported daily counters (kept separate from what the platform received and computed).
CREATE TABLE research_runner_days (
  day TEXT NOT NULL,                  -- UTC date
  runner_id TEXT NOT NULL,
  evaluated INTEGER NOT NULL DEFAULT 0 CHECK (evaluated >= 0),
  websites_checked INTEGER NOT NULL DEFAULT 0 CHECK (websites_checked >= 0),
  failed_jobs INTEGER NOT NULL DEFAULT 0 CHECK (failed_jobs >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, runner_id)
);

-- Every batch the worker sent. batch_id makes retries idempotent: a repeated batch returns its stored result.
CREATE TABLE research_batches (
  batch_id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  crm_matches INTEGER NOT NULL DEFAULT 0,
  duplicates_prevented INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL
);
CREATE INDEX idx_research_batches_received ON research_batches(received_at);

-- Candidate prospects with their evidence. business_key = the worker's canonical identity (source:id); distinct
-- businesses are never merged because they share a phone number or email: they are flagged (shared_phone) instead.
CREATE TABLE research_prospects (
  id TEXT PRIMARY KEY,
  business_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  category TEXT,
  address_line TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  lat REAL,
  lon REAL,
  phone_e164 TEXT,                    -- first valid number; all numbers in phones_json
  phone_norm TEXT,                    -- same key as contacts.phone_norm
  phones_json TEXT NOT NULL DEFAULT '[]',
  email TEXT,
  emails_json TEXT NOT NULL DEFAULT '[]',
  domain TEXT,
  domains_json TEXT NOT NULL DEFAULT '[]',
  time_zone TEXT,                     -- NULL when the state spans zones (never guessed)
  sources_json TEXT NOT NULL,         -- provenance: source, source id, licence, release, retrieved_at
  website_class TEXT NOT NULL CHECK (website_class IN ('VERIFIED_OFFICIAL_WEBSITE','VERIFIED_WEBSITE_BROKEN','VERIFIED_WEBSITE_ISSUES','NO_OFFICIAL_WEBSITE_FOUND','WEBSITE_UNVERIFIED','BUSINESS_IDENTITY_UNCERTAIN')),
  website_url TEXT,
  website_json TEXT NOT NULL,         -- confidence, identity signals, checks by stage
  findings_json TEXT NOT NULL DEFAULT '[]',
  findings_count INTEGER NOT NULL DEFAULT 0,
  max_severity TEXT CHECK (max_severity IS NULL OR max_severity IN ('low','medium','high','critical')),
  identity_confidence REAL NOT NULL CHECK (identity_confidence BETWEEN 0 AND 1),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  qualified INTEGER NOT NULL CHECK (qualified IN (0,1)),
  qualification_json TEXT NOT NULL DEFAULT '[]',
  recommended_package TEXT CHECK (recommended_package IS NULL OR recommended_package IN ('starter','business','custom')),
  summary TEXT,                       -- local-model draft, accepted only when it adds no facts
  brief TEXT,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('qualified','not_qualified','review','promoted','existing_crm','suppressed','dismissed')),
  status_detail TEXT,
  crm_lead_id TEXT REFERENCES leads(id),
  crm_contact_id TEXT REFERENCES contacts(id),
  shared_phone INTEGER NOT NULL DEFAULT 0 CHECK (shared_phone IN (0,1)),
  eligibility TEXT NOT NULL DEFAULT 'blocked' CHECK (eligibility IN ('blocked','eligible')),
  eligibility_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT
);
CREATE INDEX idx_research_prospects_status ON research_prospects(status, score DESC);
CREATE INDEX idx_research_prospects_phone ON research_prospects(phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX idx_research_prospects_email ON research_prospects(email) WHERE email IS NOT NULL;
CREATE INDEX idx_research_prospects_domain ON research_prospects(domain) WHERE domain IS NOT NULL;
CREATE INDEX idx_research_prospects_class ON research_prospects(website_class);
CREATE INDEX idx_research_prospects_first_seen ON research_prospects(first_seen_at);
CREATE INDEX idx_research_prospects_updated ON research_prospects(updated_at);
CREATE INDEX idx_research_prospects_lead ON research_prospects(crm_lead_id) WHERE crm_lead_id IS NOT NULL;
