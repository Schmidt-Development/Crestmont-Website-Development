-- The external assets an uploaded frontend depends on, resolved once and pinned.
--
-- WHY. The design measurement runs in a container with `--network none`, which is right -- an approved design has
-- to be reproducible, and a measurement that reaches the internet is a measurement of whatever the internet said
-- that minute. But the consequence was silent and wrong: a site whose typography comes from a font CDN and whose
-- photographs come from an image host was measured with none of them. The fallback font and the empty image boxes
-- became the approved baseline, and the owner approved a design they had never seen.
--
-- Turning the network on in the measurement container would fix the appearance and destroy the reproducibility,
-- and it cannot be done anyway: Node 1 reaches the internet through an allow-list proxy that permits the npm
-- registry, the control plane and the model server, and explicitly DENIES the domain Google Fonts is served from.
--
-- So the assets are resolved ONCE, at ingestion, by the platform -- which already has `fetch` and R2, runs where
-- there is no private network to be tricked into reaching, and can apply one set of rules in one place. Each
-- asset is validated, stored by content hash, and written into the artifact as a local file. Every later step --
-- the measurement, the approved baseline, Model B's build, the final visual verification -- reads the same pinned
-- bytes from here. Nothing downstream ever fetches anything.
--
-- A row is kept for every asset the artifact referenced, INCLUDING the ones that could not be acquired: a missing
-- visual dependency is the reason a baseline is materially incomplete, and the owner is shown it rather than
-- having a fallback approved on their behalf.

CREATE TABLE frontend_artifact_assets (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES frontend_artifacts(id) ON DELETE CASCADE,

  -- The absolute URL exactly as the artifact referenced it. The identity of the dependency.
  url TEXT NOT NULL,
  -- What it is for, which decides whether its absence is a visual defect: image, font, stylesheet, other.
  kind TEXT NOT NULL CHECK (kind IN ('image', 'font', 'stylesheet', 'other')),
  -- 'pinned': acquired, validated and written into the artifact. 'refused': not acquired, and `why` says so.
  status TEXT NOT NULL CHECK (status IN ('pinned', 'refused')),
  why TEXT,

  sha256 TEXT,
  bytes INTEGER,
  content_type TEXT,
  -- Where the bytes live, so a build months later writes the same ones rather than fetching again.
  r2_key TEXT,
  -- The path inside the artifact the reference was rewritten to.
  local_path TEXT,
  -- The artifact file that referenced it, for the report the owner reads.
  referenced_by TEXT,

  created_at TEXT NOT NULL,

  -- One row per dependency per artifact: the same URL referenced from three stylesheets is one asset.
  UNIQUE (artifact_id, url),
  CHECK (status <> 'pinned' OR (sha256 IS NOT NULL AND r2_key IS NOT NULL AND local_path IS NOT NULL))
);

CREATE INDEX frontend_artifact_assets_artifact ON frontend_artifact_assets (artifact_id, status);
