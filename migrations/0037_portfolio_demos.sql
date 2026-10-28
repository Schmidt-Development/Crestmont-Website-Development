-- Interactive portfolio explorer (PORT-006/PORT-007 extension). Additive and nullable: existing rows and every
-- existing query keep working. Production URL = live_url, category = industry, order = position and publication
-- = published/published_at already exist (0001/0005); this adds the isolated demo and its verification, plus
-- bundled poster images that survive preview database rebuilds (R2 is not available on every environment).
ALTER TABLE portfolio_projects ADD COLUMN demo_url TEXT;
-- none = no interactive demo; ready = verified and embeddable; unavailable = temporarily down (poster + live link shown)
ALTER TABLE portfolio_projects ADD COLUMN demo_status TEXT NOT NULL DEFAULT 'none' CHECK (demo_status IN ('none','ready','unavailable'));
ALTER TABLE portfolio_projects ADD COLUMN demo_verified_at TEXT;
ALTER TABLE portfolio_projects ADD COLUMN demo_verified_by TEXT REFERENCES users(id);
-- Source repository revision the demo was built from (e.g. "better-lansing-mechanics@59ccaf4").
ALTER TABLE portfolio_projects ADD COLUMN demo_revision TEXT;
-- Genuine screenshots bundled with the site under /assets/portfolio/ (alternative to uploaded R2 screenshots).
ALTER TABLE portfolio_projects ADD COLUMN poster_desktop_asset TEXT CHECK (poster_desktop_asset IS NULL OR poster_desktop_asset GLOB '/assets/portfolio/[a-z0-9]*.webp');
ALTER TABLE portfolio_projects ADD COLUMN poster_mobile_asset TEXT CHECK (poster_mobile_asset IS NULL OR poster_mobile_asset GLOB '/assets/portfolio/[a-z0-9]*.webp');
ALTER TABLE portfolio_projects ADD COLUMN poster_tablet_asset TEXT CHECK (poster_tablet_asset IS NULL OR poster_tablet_asset GLOB '/assets/portfolio/[a-z0-9]*.webp');
