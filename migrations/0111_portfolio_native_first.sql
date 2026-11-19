-- One native-first standard for every portfolio entry (Owner, 2026-11-19: "UNIVERSAL NATIVE PORTFOLIO ENGINE").
-- Entries created before 0110 kept a separate "legacy" path whose refused sites were streamed through Crestmont's
-- remote browser (display_mode 'remote', Mode B). From now on every entry follows the same automatic native readiness
-- (src/services/native/): Crestmont prepares an owned website through its authorized connections, verifies the REAL
-- website in a real browser, and an entry that cannot be embedded shows an honest unavailable notice with the live link —
-- never a remote stream.
--
-- Nothing else about an entry changes: content, position, images, relationship documentation, the owner's consent and
-- the published flag are untouched (no entry is unpublished, none is created or deleted). An entry whose live website
-- already permits this origin keeps being shown natively while its verification runs (native_migrated_at marks these
-- converted entries; src/services/portfolio.ts previewState). The scheduled portfolio_native job checks and verifies
-- them, at most a bounded number per run.
--
-- native_migrated_at  when this migration converted the entry (NULL for entries created native-first)
-- native_diagnosis    the last diagnosis (JSON: codes, plain-English owner message, developer detail) — no secrets
-- native_perf         the last measured direct-vs-embedded performance (JSON, src/services/native/verify.ts)
ALTER TABLE portfolio_projects ADD COLUMN native_migrated_at TEXT;
ALTER TABLE portfolio_projects ADD COLUMN native_diagnosis TEXT;
ALTER TABLE portfolio_projects ADD COLUMN native_perf TEXT;

UPDATE portfolio_projects
   SET native_migrated_at = '2026-11-19T12:00:00.000Z',
       native_required = 1,
       native_state = 'checking',
       native_reason = 'Converted to the native-first standard: Crestmont is checking the live website and will prepare and verify it automatically.',
       native_updated_at = '2026-11-19T12:00:00.000Z',
       display_mode = CASE WHEN display_mode = 'remote' THEN 'unavailable' ELSE display_mode END,
       display_reason = CASE WHEN display_mode = 'remote' THEN 'Remote streaming is no longer used for portfolio websites; Crestmont is preparing the live website for native display.' ELSE display_reason END
 WHERE native_required = 0;

INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at)
SELECT NULL, 'system', 'portfolio.native_first_migration', 'portfolio_project', id,
       json_object('published', published, 'embed_status', embed_status, 'from', 'legacy', 'to', 'checking'), NULL, '2026-11-19T12:00:00.000Z'
  FROM portfolio_projects WHERE native_migrated_at = '2026-11-19T12:00:00.000Z';
