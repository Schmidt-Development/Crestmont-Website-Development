// Seeds the local dev database (dev/server.ts) with TEST DATA portfolio entries whose live sites are the scroll
// fixtures in scripts/fixtures/scroll/ (served by scripts/scroll-isolation-check.mjs through request routing). Each
// entry is published and marked as permitting framing, exactly as the live check records a real site — as an existing
// (already native, published) entry like the six real ones; new-entry onboarding is tested in tests/portfolio-native*.
//   node scripts/scroll-isolation-seed.mjs .dev/crestmont.db plain-long,lenis-smooth,…
import { DatabaseSync } from "node:sqlite";
const [dbPath, list] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
const now = new Date().toISOString();
let pos = db.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM portfolio_projects").get().p;
for (const slug of (list ?? "").split(",").filter(Boolean)) {
  const url = `https://${slug}.fixture-portfolio.com/`;
  db.prepare("DELETE FROM portfolio_projects WHERE slug = ?").run(slug);
  db.prepare(`INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, position, published, updated_at, created_at, embed_status, embed_url, embed_checked_at, embed_detail, native_required, native_state)
    VALUES (?, ?, ?, 'Testing', ?, 'TEST DATA', 'TEST DATA fixture site for the scroll-isolation regression check.', '[]', ?, 1, ?, ?, 'allowed', ?, ?, 'fixture', 0, 'legacy')`)
    .run(`pf_fx_${slug.replace(/-/g, "_")}`, slug, slug.replace(/-/g, " "), url, ++pos, now, now, url, now);
}
console.log(`seeded ${list}`);
