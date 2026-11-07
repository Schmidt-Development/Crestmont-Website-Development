-- The integration contract: what the backend work will do, recorded before it starts.
--
-- A design-locked build is verified against three gates, and the first of them -- contract conformance -- needs a
-- contract. The runner has required one since the design-locked path was written (`runDesignLockedJob` stops at
-- `manifest` without it) and it read that contract from `build_pipeline.spec_json`, which holds something else
-- entirely: a master specification (prose, tasks, acceptance criteria) produced by the architect for the retired
-- frontend-generation path. Nothing anywhere wrote an integration manifest, and there was no way for a person to
-- supply one, so every Founder-submitted artifact reached a queued build and stopped thirteen seconds later with
-- "this project has no integration manifest". The only manifests in existence were test fixtures.
--
-- So the contract gets a home of its own, beside the design it is written against rather than inside a column that
-- means something else. One row per version; a new version supersedes the last without destroying it, because what
-- a build was verified against is evidence.
--
-- It is tied to BOTH the artifact and the design fingerprint on purpose. A contract names pages, interactive
-- elements and operations that exist in one measured design; against a different design those names may mean
-- nothing, and a contract that no longer matches must stop a build rather than be stretched to fit.
--
-- Who writes it is deliberately a person. The contract is the thing an implementation is judged against, so a
-- model that authored it would be marking its own exam -- the same reason approval is a person's.

CREATE TABLE design_locked_contracts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  -- The measured design this contract was written against. Both, not either: the artifact says which bytes, the
  -- fingerprint says which rendering of them.
  artifact_id TEXT NOT NULL REFERENCES frontend_artifacts(id),
  baseline_id TEXT NOT NULL REFERENCES design_baselines(id),
  design_fingerprint TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  version INTEGER NOT NULL,
  -- The manifest exactly as recorded, after validation. Stored whole: the runner re-validates it against the
  -- measurement, and a build's evidence should be able to quote the contract it was held to.
  manifest_json TEXT NOT NULL,
  -- Counts pulled out for the screen, so listing contracts does not mean parsing every manifest.
  operations INTEGER NOT NULL DEFAULT 0,
  visual_states INTEGER NOT NULL DEFAULT 0,
  recorded_by TEXT REFERENCES users(id),
  note TEXT,
  -- Set when a later version supersedes this one. Never deleted.
  superseded_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX design_locked_contracts_version ON design_locked_contracts (project_id, version);
-- The lookup the claim makes on every poll: the current contract for a project.
CREATE INDEX design_locked_contracts_active ON design_locked_contracts (project_id, superseded_at);
