// Migration 0104 (Founder, 2026-11-12): Glassly Auto Glass is restored to the portfolio from its original definition,
// published at its original position 2, never duplicated, and an order the Owner saved is kept (Glassly then goes last).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestApp } from "./support/app.ts";
import type { SqliteDb } from "../dev/sqlite-d1.ts";

const SQL = readFileSync(new URL("../migrations/0104_restore_glassly_portfolio.sql", import.meta.url), "utf8");
type App = Awaited<ReturnType<typeof createTestApp>>;
const rows = async (t: App) => (await t.db.prepare(`SELECT id, slug, position, published, archived_at FROM portfolio_projects ORDER BY position, name`).all<{ id: string; slug: string; position: number; published: number; archived_at: string | null }>()).results;

test("[PORT-004] Glassly Auto Glass is restored once, published at position 2, and shown publicly with its live link", async () => {
  const t = await createTestApp();
  const r = await rows(t);
  const g = r.filter((x) => x.slug === "glassly-auto-glass");
  assert.equal(g.length, 1, "exactly one Glassly entry");
  assert.equal(g[0].id, "pf_glassly_auto_glass");
  assert.equal(g[0].position, 2);
  assert.equal(g[0].published, 1);
  assert.equal(g[0].archived_at, null);
  assert.deepEqual(r.map((x) => x.position), r.map((_, i) => i + 1), "positions stay 1..n");
  const h = await (await t.client().get("/portfolio")).text();
  assert.match(h, /href="\/portfolio\/glassly-auto-glass"/);
  const page = await (await t.client().get("/portfolio/glassly-auto-glass")).text();
  assert.match(page, /https:\/\/glasslyautoglass\.com/);
  // Running it again (staging already has the row) changes nothing.
  (t.db as SqliteDb).raw.exec(SQL);
  assert.deepEqual(await rows(t), r);
  t.close();
});

test("[PORT-004] when the Owner has saved an explicit order, the restored Glassly entry goes last and the order is kept", async () => {
  const t = await createTestApp();
  const raw = (t.db as SqliteDb).raw;
  raw.exec(`DELETE FROM portfolio_projects WHERE id = 'pf_glassly_auto_glass'`); // (audit_logs is append-only; the restore audit row may stay)
  raw.exec(`UPDATE portfolio_projects SET position = (SELECT COUNT(*) FROM portfolio_projects p2 WHERE p2.name <= portfolio_projects.name)`);
  raw.exec(`INSERT INTO audit_logs (actor_kind, action, subject_type, subject_id, details_json, created_at) VALUES ('user', 'portfolio.reordered', 'portfolio_project', NULL, '{}', '2026-11-11T00:00:00Z')`);
  const before = (await rows(t)).map((x) => [x.id, x.position]);
  raw.exec(SQL);
  const after = await rows(t);
  assert.deepEqual(after.slice(0, -1).map((x) => [x.id, x.position]), before, "the Owner's order is untouched");
  assert.equal(after.at(-1)!.id, "pf_glassly_auto_glass");
  assert.equal(after.at(-1)!.position, before.length + 1);
  t.close();
});
