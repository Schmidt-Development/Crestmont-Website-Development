-- Who wrote the integration contract, recorded on the contract itself.
--
-- 0093 said the author is deliberately a person, because a model that wrote the contract would be marking its own
-- exam. The Founder's decision of 2026-11-07 keeps that principle and moves where it bites: the contract is drafted
-- by MODEL A from the measured frontend, and the implementation is Model B's. The author is not the implementer, so
-- nothing grades its own work -- and the draft is not trusted on its own say-so either. It is accepted only by the
-- platform's deterministic validator, which runs here, outside the runner that authored it, and which a draft
-- cannot weaken or skip: schema, artifact checksum, design fingerprint, operation coverage against the measured
-- interaction inventory, technical feasibility, and consistency with the measurement. A refused draft is corrected
-- and resubmitted, bounded; it never relaxes the gate.
--
-- `authored_by` is therefore evidence, not decoration: a contract's provenance decides how much weight a later
-- verification report carries, and a person reading the project page needs to see at a glance whether a human or
-- Model A wrote the thing the build was judged against.
--
-- `review_flags_json` holds the requirements the draft could NOT establish from the frontend -- the Founder's
-- instruction is that a genuinely ambiguous business requirement is FLAGGED, specifically, rather than invented.
-- Those are the manifest's own `missing` entries, pulled out so the screen can list them without parsing the
-- manifest, and so a build's record can say what was left open rather than implying everything was settled.

ALTER TABLE design_locked_contracts ADD COLUMN authored_by TEXT NOT NULL DEFAULT 'staff';
-- The model tag that drafted it (e.g. "qwen2.5-coder:32b"), or NULL when a person wrote it. A tag, never a prompt.
ALTER TABLE design_locked_contracts ADD COLUMN author_model TEXT;
ALTER TABLE design_locked_contracts ADD COLUMN review_flags_json TEXT NOT NULL DEFAULT '[]';
