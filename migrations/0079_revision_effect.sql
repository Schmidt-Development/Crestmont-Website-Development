-- Did the repair change the website? Recorded per revision. (V5 §9 "no-op protection".)
--
-- WHY. bld_10e2c6007686faee0ab64d45 stored nine revisions, nine "repair" cycles, and across all nine there was
-- EXACTLY ONE rendered change: index-desktop.png hashed 41df475aa1 for revisions 1-6 and 12e7cbc1ed for 7-9, with
-- revisions 2-6 sharing one commit. The dashboard listed nine repairs and the Founder reasonably read that as nine
-- attempts at the design. Eight of them changed nothing a visitor could see. Nothing in the orchestrator compared a
-- repair's result with the state before it, so the loop had no way to know, and the revision list had no way to say.
--
-- The runner now hashes the rendering source and every screenshot at the end of each cycle and compares the two
-- states (runner/src/orchestrator/repair-effect.ts). The verdict is stored here so the revision list can tell the
-- truth about each entry rather than presenting a no-op as a repair.
--
-- ADDITIVE ONLY, and deliberately NULL for history: the nine revisions above were never measured this way, so
-- labelling them now would be a backfilled fiction. NULL means "not measured", which is exactly what is true of
-- every revision stored before this migration.

-- 'effective'   - the cycle changed the rendering source or the rendered pixels
-- 'ineffective' - it changed neither, or it reproduced a rendering an earlier cycle already produced
-- 'unknown'     - nothing comparable existed yet (the first measured state), or there was no render evidence
ALTER TABLE build_revisions ADD COLUMN effect TEXT
  CHECK (effect IS NULL OR effect IN ('effective', 'ineffective', 'unknown'));
-- The measured reason, in the runner's own words: which hashes matched, which pages changed, which earlier cycle a
-- repeat reproduces. Shown to the Founder as-is, so it is sanitized and length-capped on the way in.
ALTER TABLE build_revisions ADD COLUMN effect_reason TEXT;

-- The revision list and the build detail page both filter "which cycles actually changed the website".
CREATE INDEX IF NOT EXISTS idx_build_revisions_effect ON build_revisions (job_id, effect);
