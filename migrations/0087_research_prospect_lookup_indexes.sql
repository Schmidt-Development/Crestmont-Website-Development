-- Two full scans of research_prospects, measured by Cloudflare's per-statement analytics over staging deploy #164
-- (2026-11-06 00:30–01:09 UTC, scripts/d1-analytics.ts), where one Owner page answered "D1 DB is overloaded":
--
--   SELECT COUNT(*) FROM research_prospects WHERE eligibility = ?           84 calls  3.89 M rows read  15.8 s
--   SELECT name_norm, address_line, business_key FROM research_prospects
--     WHERE name_norm IN (…)                                                20 calls  0.93 M rows read   4.6 s
--
-- ~46,000 rows per call: the whole table, every time, because neither column was indexed. ADDITIVE ONLY: two indexes,
-- no data or behaviour change; the Research Agent's queries and results are unchanged, they just stop scanning.
CREATE INDEX IF NOT EXISTS idx_research_prospects_eligibility ON research_prospects(eligibility);
CREATE INDEX IF NOT EXISTS idx_research_prospects_name_norm ON research_prospects(name_norm) WHERE name_norm IS NOT NULL;
