-- Live website embedding (Owner, 2026-11-15): the portfolio shows each client's real, working website inside the
-- explorer whenever that website permits Crestmont to frame it. The Worker checks the live site's own response
-- headers (Content-Security-Policy frame-ancestors / X-Frame-Options) for this environment's origin and records the
-- answer here; only an "allowed" answer that is recent is ever framed (src/services/embed-check.ts).
--   embed_status      unchecked | allowed | blocked | error
--   embed_url         the final https address the check loaded (after redirects) — the address that is framed
--   embed_checked_at  when the check ran; embed_detail: the header evidence in plain words
--   publish_when_ready  one-time request to publish as soon as every publishing requirement is met (cleared after)
ALTER TABLE portfolio_projects ADD COLUMN embed_status TEXT NOT NULL DEFAULT 'unchecked' CHECK (embed_status IN ('unchecked', 'allowed', 'blocked', 'error'));
ALTER TABLE portfolio_projects ADD COLUMN embed_url TEXT;
ALTER TABLE portfolio_projects ADD COLUMN embed_checked_at TEXT;
ALTER TABLE portfolio_projects ADD COLUMN embed_detail TEXT;
ALTER TABLE portfolio_projects ADD COLUMN publish_when_ready INTEGER NOT NULL DEFAULT 0;
