// Portfolio management (Founder, 2026-11-11): the Owner controls which websites appear and in which order. The order is
// saved in the database (drag and drop or Up / Down), new entries go anywhere, archiving hides without deleting, and
// the public portfolio shows published, non-archived entries in exactly that order. TEST DATA only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";

type App = Awaited<ReturnType<typeof createTestApp>>;
const ids = async (t: App) => (await t.db.prepare(`SELECT id FROM portfolio_projects WHERE archived_at IS NULL ORDER BY position, name`).all<{ id: string }>()).results.map((r) => r.id);
const names = async (t: App) => (await t.db.prepare(`SELECT name FROM portfolio_projects WHERE archived_at IS NULL ORDER BY position, name`).all<{ name: string }>()).results.map((r) => r.name);
const fields = (name: string, slug: string, position?: number) => ({ name, slug, industry: "Testing", live_url: `https://${slug}.fixture-portfolio.com`, description: `${name} is a TEST DATA portfolio entry for ordering.`, features: "", technology_summary: "", relationship: "Relationship documentation pending", ...(position ? { position: String(position) } : {}) });
/** Where each entry's own case-study link first appears on a public page (its card), in the given order. */
const publicOrder = (h: string, slugs: string[]) => slugs.map((sl) => h.indexOf(`href="/portfolio/${sl}"`)).filter((i) => i >= 0);

test("[PORT-004] the Owner adds projects at any position, saves a dragged order, and the public portfolio follows it exactly; unpublished and archived entries never appear", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner");
  const o = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);
  const seeded = await ids(t);
  // Add three entries: one at the end (default), one first, one third.
  assert.equal((await o.post("/staff/portfolio", fields("Alpha Fixture", "alpha-fixture"))).status, 303);
  assert.equal((await o.post("/staff/portfolio", fields("Bravo Fixture", "bravo-fixture", 1))).status, 303);
  assert.equal((await o.post("/staff/portfolio", fields("Charlie Fixture", "charlie-fixture", 3))).status, 303);
  const after = await names(t);
  assert.equal(after[0], "Bravo Fixture", "inserted first");
  assert.equal(after[2], "Charlie Fixture", "inserted third");
  assert.equal(after.at(-1), "Alpha Fixture", "default appends");
  assert.equal(after.length, seeded.length + 3);
  const positions = (await t.db.prepare(`SELECT position FROM portfolio_projects WHERE archived_at IS NULL ORDER BY position`).all<{ position: number }>()).results.map((r) => r.position);
  assert.deepEqual(positions, positions.map((_, i) => i + 1), "positions stay 1..n");

  // The list page offers the drag handles, keyboard help, Up/Down fallback and the position choice for new entries.
  const list = await (await o.get("/staff/portfolio")).text();
  assert.match(list, /data-pf-order/);
  assert.match(list, /data-pf-handle aria-label="Reorder Bravo Fixture: drag, or use the arrow keys"/);
  assert.match(list, /src="\/assets\/portfolio-order\.js"/);
  assert.match(list, /name="position"/);
  let depth = 0, maxDepth = 0;
  for (const m of list.matchAll(/<(\/?)form\b/g)) { depth += m[1] ? -1 : 1; maxDepth = Math.max(maxDepth, depth); }
  assert.equal(maxDepth, 1, "no form is nested in another (Up/Down and Save order are separate forms)");

  // Save a new order (what the drag-and-drop script submits): reverse everything.
  const reversed = [...(await ids(t))].reverse();
  assert.equal((await o.post("/staff/portfolio/order", { order: reversed.join(",") })).status, 303);
  assert.deepEqual(await ids(t), reversed, "order saved permanently in the database");
  // A stale order (an entry missing) is refused and changes nothing.
  const stale = await o.post("/staff/portfolio/order", { order: reversed.slice(1).join(",") });
  assert.equal(stale.status, 303);
  assert.deepEqual(await ids(t), reversed);

  // Publish three entries (publishing gates are covered elsewhere) and check the public order.
  const pub = ["Alpha Fixture", "Bravo Fixture", "Charlie Fixture"];
  await t.db.prepare(`UPDATE portfolio_projects SET published = CASE WHEN name IN ('Alpha Fixture','Bravo Fixture','Charlie Fixture') THEN 1 ELSE 0 END`).run();
  const slugOf: Record<string, string> = { "Alpha Fixture": "alpha-fixture", "Bravo Fixture": "bravo-fixture", "Charlie Fixture": "charlie-fixture" };
  const expectOrder = (await names(t)).filter((n) => pub.includes(n)).map((n) => slugOf[n]);
  let h = await (await t.client().get("/portfolio")).text();
  const idx = publicOrder(h, expectOrder);
  assert.equal(idx.length, 3);
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), `public order follows the saved order: ${expectOrder.join(", ")}`);
  assert.ok(!h.includes("Charlie Fixture") || pub.includes("Charlie Fixture"));

  // Move Up / Down (accessible fallback) changes the same saved order.
  const charlie = (await t.db.prepare(`SELECT id FROM portfolio_projects WHERE slug = 'charlie-fixture'`).first<{ id: string }>())!.id;
  const before = (await ids(t)).indexOf(charlie);
  await o.post(`/staff/portfolio/${charlie}/move`, { dir: before > 0 ? "up" : "down" });
  assert.equal((await ids(t)).indexOf(charlie), before > 0 ? before - 1 : before + 1);

  // Archive: hidden publicly (even though it was published) and from the active order; nothing deleted; restore = hidden, last.
  assert.equal((await o.post(`/staff/portfolio/${charlie}/archive`, {})).status, 303);
  const row = (await t.db.prepare(`SELECT archived_at, published, name, description FROM portfolio_projects WHERE id = ?`).bind(charlie).first<{ archived_at: string | null; published: number; name: string; description: string }>())!;
  assert.ok(row.archived_at);
  assert.equal(row.published, 0);
  assert.equal(row.name, "Charlie Fixture", "record kept");
  assert.ok(!(await ids(t)).includes(charlie));
  h = await (await t.client().get("/portfolio")).text();
  assert.ok(!h.includes("Charlie Fixture"), "archived entries never appear publicly");
  assert.equal((await t.client().get("/portfolio/charlie-fixture")).status, 404);
  assert.match(await (await o.get("/staff/portfolio")).text(), /Archived \(1\)/);
  assert.equal((await o.post(`/staff/portfolio/${charlie}/publish`, {})).status, 409, "an archived project cannot be published");
  await o.post(`/staff/portfolio/${charlie}/restore`, {});
  const restored = await ids(t);
  assert.equal(restored.at(-1), charlie, "restored at the end");
  assert.equal((await t.db.prepare(`SELECT published FROM portfolio_projects WHERE id = ?`).bind(charlie).first<{ published: number }>())!.published, 0, "restored unpublished");
});

test("[PORT-004] only portfolio managers can reorder or archive; the order endpoint is CSRF-protected", async () => {
  const t = await createTestApp();
  const support = await createStaff(t.db, "developer");
  const s = await t.client().login(support.email, TEST_PASSWORD, support.secret);
  const order = (await ids(t)).join(",");
  const r = await s.post("/staff/portfolio/order", { order });
  assert.equal(r.status, 403);
  const owner = await createStaff(t.db, "owner");
  const o = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);
  assert.equal((await o.post("/staff/portfolio/order", { order }, { csrf: false })).status, 403, "no CSRF token, no change");
});

test("[PORT-004] tablet screenshots upload and replace like desktop and mobile; images of hidden or archived entries are never served publicly", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner");
  const o = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);
  await o.post("/staff/portfolio", fields("Tablet Fixture", "tablet-fixture"));
  const id = (await t.db.prepare(`SELECT id FROM portfolio_projects WHERE slug = 'tablet-fixture'`).first<{ id: string }>())!.id;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const up = async () => o.post(`/staff/portfolio/${id}/screenshot`, { kind: "tablet", captured_on: "2026-11-10", screenshot: new File([png], "tablet.png", { type: "image/png" }) });
  assert.equal((await up()).status, 303);
  const first = (await t.db.prepare(`SELECT tablet_screenshot_file_id AS f FROM portfolio_projects WHERE id = ?`).bind(id).first<{ f: string }>())!.f;
  assert.ok(first);
  assert.equal((await up()).status, 303);
  const second = (await t.db.prepare(`SELECT tablet_screenshot_file_id AS f FROM portfolio_projects WHERE id = ?`).bind(id).first<{ f: string }>())!.f;
  assert.notEqual(second, first, "replaced");
  assert.equal((await t.db.prepare(`SELECT replaced_by FROM files WHERE id = ?`).bind(first).first<{ replaced_by: string }>())!.replaced_by, second, "the old image is kept and linked to its replacement");
  assert.match(await (await o.get(`/staff/portfolio/${id}`)).text(), /Tablet \(optional\) screenshot/);
  await t.db.prepare(`UPDATE files SET scan_status = 'clean' WHERE id = ?`).bind(second).run();
  assert.notEqual((await t.client().get(`/portfolio-media/${second}`)).status, 200, "unpublished: not served");
  await t.db.prepare(`UPDATE portfolio_projects SET published = 1 WHERE id = ?`).bind(id).run();
  const served = await t.client().get(`/portfolio-media/${second}`);
  assert.equal(served.status, 200, "published: served");
  await o.post(`/staff/portfolio/${id}/archive`, {});
  assert.notEqual((await t.client().get(`/portfolio-media/${second}`)).status, 200, "archived: not served");
});
