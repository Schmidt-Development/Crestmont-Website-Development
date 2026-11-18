-- Automatic native readiness for portfolio entries (Owner, 2026-11-18: "PERMANENT AUTOMATIC NATIVE LIVE WEBSITE
-- PORTFOLIO SYSTEM"). Every entry added from now on must reach the REAL production website in a native frame; it is
-- never silently replaced by the remote browser, a demo or a screenshot. Crestmont prepares an owned website itself
-- through the hosting/repository connections the Owner authorized (src/services/native/), and only a real browser
-- verification marks it native.
--
-- native_required  1 for every entry created after this migration (the column default); existing entries keep their
--                  current behaviour (0) — the six published sites are already native and nothing about them changes.
-- native_state     checking | preparing | authorization_required | unavailable | native_verified | legacy
-- native_reason    the exact, actionable reason shown to staff
-- native_provider  how the site is served, as discovered through an authorized connection (e.g. cloudflare-zone,
--                  vercel, cloudflare-pages); NULL until discovered
-- native_target    minimal provider identifiers (JSON: account/zone/project/repository ids) — no secrets
-- native_change    the configuration change Crestmont made or proposed (JSON: kind, ref, url) — for idempotency and audit
-- native_verified_at / native_verification  the last real-browser verification (JSON summary of each check)
ALTER TABLE portfolio_projects ADD COLUMN native_required INTEGER NOT NULL DEFAULT 1;
UPDATE portfolio_projects SET native_required = 0;
ALTER TABLE portfolio_projects ADD COLUMN native_state TEXT NOT NULL DEFAULT 'checking' CHECK (native_state IN ('checking', 'preparing', 'authorization_required', 'unavailable', 'native_verified', 'legacy'));
UPDATE portfolio_projects SET native_state = 'legacy';
ALTER TABLE portfolio_projects ADD COLUMN native_reason TEXT;
ALTER TABLE portfolio_projects ADD COLUMN native_provider TEXT;
ALTER TABLE portfolio_projects ADD COLUMN native_target TEXT;
ALTER TABLE portfolio_projects ADD COLUMN native_change TEXT;
ALTER TABLE portfolio_projects ADD COLUMN native_updated_at TEXT;
ALTER TABLE portfolio_projects ADD COLUMN native_verified_at TEXT;
ALTER TABLE portfolio_projects ADD COLUMN native_verification TEXT;
