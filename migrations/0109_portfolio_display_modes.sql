-- Automatic interactive display modes (Owner, 2026-11-16: "PERMANENT AUTOMATIC INTERACTIVE PORTFOLIO SYSTEM").
-- Each project records the display method Crestmont selected for it when its live site was checked:
--   embed        Mode A — the site permits framing by this origin: the real site in the explorer's iframe;
--   remote       Mode B — framing is refused (CSP frame-ancestors / X-Frame-Options) but the site is a reachable public
--                page: Crestmont's remote browser renders it in an isolated Chromium session and relays the visitor's
--                input — no change to the destination site;
--   unavailable  Mode C — neither is possible (unreachable, error, bot challenge, remote browser not configured): an
--                honest notice, the live link, and any genuine screenshot labelled as one.
ALTER TABLE portfolio_projects ADD COLUMN display_mode TEXT NOT NULL DEFAULT 'unchecked' CHECK (display_mode IN ('unchecked', 'embed', 'remote', 'unavailable'));
ALTER TABLE portfolio_projects ADD COLUMN display_reason TEXT;

-- Remote-browser sessions (one row per visitor session; no personal data: the IP is kept only as a salted hash for rate
-- limiting). Used for the concurrency limit, the daily browser-minutes budget, cleanup of abandoned sessions and audit.
CREATE TABLE remote_browser_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES portfolio_projects(id),
  token_hash TEXT NOT NULL,
  client_key TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('public', 'staff', 'preview')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  seconds INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX remote_browser_sessions_active ON remote_browser_sessions (ended_at, last_seen_at);
CREATE INDEX remote_browser_sessions_day ON remote_browser_sessions (created_at);

-- Short-lived, read-only preview links for projects that are not published yet (release acceptance tests, review).
CREATE TABLE portfolio_preview_tokens (
  token_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES portfolio_projects(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  purpose TEXT NOT NULL
);
