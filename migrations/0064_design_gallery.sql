-- ONE unified premium design gallery (Founder directive, 2026-11-02).
--
-- There is exactly one authoritative gallery. Every package -- Starter, Business and Premium -- draws from it and is
-- held to the same visual-quality standard; packages differ in scope and deliverables, not in whether the website is
-- allowed to look premium. A per-package gallery would be quality discrimination (failure mode J24), so the schema
-- deliberately provides no place to record one.
--
-- The Owner Dashboard writes these rows and the AI reads them. There is no second gallery on Node 1: a build records
-- the reference ids it used and the gallery version it saw (design_reference_uses), so what the AI looked at is
-- auditable after the fact and a removed or disabled reference cannot quietly keep being used (J01-J08, J20).

CREATE TABLE design_references (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  -- Where it came from. source_url may be null for an owner's own upload.
  source_url TEXT,
  source_name TEXT,
  industry TEXT NOT NULL,
  -- Comma-free JSON array of style tags, e.g. ["editorial","minimalist"].
  style_tags_json TEXT NOT NULL DEFAULT '[]',
  -- PENDING_REVIEW until a person approves it: automatic collection never self-approves (J16).
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'DISABLED', 'REJECTED')),
  -- Separate from status on purpose: an owner may approve a reference for people to look at but keep it out of AI
  -- retrieval (licence doubt, too distinctive to learn from without copying it).
  ai_eligible INTEGER NOT NULL DEFAULT 1 CHECK (ai_eligible IN (0, 1)),
  -- Storage keys in the existing object store; no image bytes live in D1.
  desktop_key TEXT,
  mobile_key TEXT,
  tablet_key TEXT,
  -- What a reviewer or the AI should notice. Free text, written by the owner or an authorised capture.
  typography_notes TEXT,
  layout_notes TEXT,
  color_notes TEXT,
  animation_notes TEXT,
  responsive_notes TEXT,
  quality_notes TEXT,
  -- Rights and provenance: who may use this and on what terms. An entry with no rights basis must not be AI-eligible.
  rights_basis TEXT NOT NULL DEFAULT 'unverified' CHECK (rights_basis IN ('owner_supplied', 'licensed', 'public_permitted', 'own_work', 'unverified')),
  rights_note TEXT,
  captured_at TEXT,
  -- sha256 of the desktop image, so a duplicate upload is detectable (J15) and a swap is visible.
  checksum TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Soft delete: removal must stop selection immediately while keeping audit history (5.3).
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_design_refs_status ON design_references(status, ai_eligible, deleted_at);
CREATE INDEX idx_design_refs_industry ON design_references(industry, status);
-- One row per distinct image: a second upload of the same bytes is a duplicate, not a new reference.
CREATE UNIQUE INDEX uq_design_refs_checksum ON design_references(checksum) WHERE checksum IS NOT NULL AND deleted_at IS NULL;

-- Every change to a reference, so "who disabled this and when" is answerable (5.3, 5.8, J08).
CREATE TABLE design_reference_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_id TEXT NOT NULL REFERENCES design_references(id),
  at TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'approved', 'rejected', 'disabled', 'enabled', 'edited', 'removed', 'restored')),
  actor_user_id TEXT REFERENCES users(id),
  note TEXT,
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX idx_design_ref_events ON design_reference_events(reference_id, id);

-- What a build actually looked at. Written when the AI selects references, so a later question -- "which references
-- shaped this website, and was that version of the gallery the approved one?" -- has an answer (4.6, J08, J20).
CREATE TABLE design_reference_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES build_jobs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  reference_id TEXT NOT NULL REFERENCES design_references(id),
  -- The gallery generation the selection was made against, so a stale cache is detectable (J06, J07).
  gallery_version INTEGER NOT NULL,
  selected_at TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX idx_design_ref_uses_job ON design_reference_uses(job_id);
CREATE INDEX idx_design_ref_uses_ref ON design_reference_uses(reference_id);

-- A single integer the whole gallery shares. Any insert, edit, approval, disable or removal bumps it, so a cached
-- copy can tell in one comparison whether it is stale (J06, J07).
CREATE TABLE design_gallery_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
INSERT INTO design_gallery_state (id, version, updated_at) VALUES (1, 1, '2026-11-02T00:00:00.000Z');
