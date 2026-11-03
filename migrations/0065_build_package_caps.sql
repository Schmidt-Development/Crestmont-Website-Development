-- Package-aware concurrency caps for AI website builds (Founder directive: adaptive order scheduling).
--
-- These are MAXIMUMS, not reservations and not additive: a package may occupy at most this many of the global
-- concurrent-build slots at once, and the global ceiling in build_settings.max_concurrent still binds. With a global
-- ceiling of 4, "business 3" means at most 3 of those 4 slots may hold Business builds, never that 3 are held for
-- them. Heavier packages get smaller caps so one package's backlog cannot occupy the whole node.
--
-- A package with no row here is capped by the global ceiling alone, so a new package keeps working without a
-- migration and the caps stay a deliberate, auditable choice rather than a hidden default.
CREATE TABLE build_package_caps (
  package_id     TEXT PRIMARY KEY,
  max_concurrent INTEGER NOT NULL CHECK (max_concurrent >= 0 AND max_concurrent <= 50),
  reason         TEXT,
  updated_by     TEXT REFERENCES users(id),
  updated_at     TEXT NOT NULL
);

INSERT INTO build_package_caps (package_id, max_concurrent, reason, updated_at) VALUES
  ('starter',  4, 'Lightest build: may use every slot the global ceiling allows', datetime('now')),
  ('business', 3, 'Full-stack starter with the quality engine: leaves a slot for a lighter build', datetime('now')),
  ('premium',  2, 'Heaviest build and the longest review cycles', datetime('now')),
  ('custom',   2, 'Scoped per customer; treated as heavy until measured', datetime('now'));
