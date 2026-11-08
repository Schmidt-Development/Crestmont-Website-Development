-- Two read indexes for the D1 overload found in staging deploy 42523964359 (2026-11-08). Indexes only: no table,
-- column, row or trigger changes, and nothing the Research Agent writes or reads changes meaning.
--
-- 1. /staff/research. Its summary (research.ts dashboard()) and eligibility census (research-promote.ts censusSql())
--    each scan every research_prospects row: on staging ~48,500 rows carrying large JSON columns (website_json,
--    sources_json, findings_json), about 490 ms and 460 ms of D1 time per page load (D1 analytics run 42528453491:
--    23.5 s and 15.1 s over 15 minutes, 3.9 M rows read). Every column those counts and the two GROUP BYs read is in
--    this covering index, so SQLite scans the slim index instead of the wide rows (local, same shape: 119 ms -> 39 ms
--    per page; plans pinned by tests/d1-read-indexes.test.ts).
CREATE INDEX IF NOT EXISTS idx_research_prospects_summary
  ON research_prospects(status, website_class, qualified, eligibility, score, promote_attempts, first_seen_at, updated_at);

-- 2. Audit logs "record type or id" filter: (subject_type = ? OR subject_id = ?). subject_id had no index of its own
--    (idx_audit_subject leads with subject_type), so the filter walked all ~122,000 audit rows newest-first; while
--    nothing matched yet it read the whole table on every request. The staging refund journey polls exactly that
--    filter every 5 s while it waits for Stripe's webhook: 8 polls read 976,344 rows in that window, and the D1
--    window they exhausted is the one the webhook needed to record the refund.
CREATE INDEX IF NOT EXISTS idx_audit_subject_id ON audit_logs(subject_id);
