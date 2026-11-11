-- Portfolio management (Founder, 2026-11-11): archive without deleting, and a tablet screenshot next to desktop and mobile.
-- Existing rows are unchanged: archived_at NULL = active, tablet_screenshot_file_id NULL = no uploaded tablet image.
ALTER TABLE portfolio_projects ADD COLUMN archived_at TEXT;
ALTER TABLE portfolio_projects ADD COLUMN tablet_screenshot_file_id TEXT REFERENCES files(id);
