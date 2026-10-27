import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import { ACTIONS_PER_ROUTE } from "../src/app/app.ts";

const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

test("[PORTAL-005] live unread counts: customers see their own organization only, staff see customer messages; polling never extends an idle session", async () => {
  const t = await createTestApp();
  const a = await createCustomer(t.db, "live-a@example.com", "Live A");
  const b = await createCustomer(t.db, "live-b@example.com", "Live B");
  const owner = await createStaff(t.db, "owner");
  const ca = await t.client().login(a.email, TEST_PASSWORD);
  const cb = await t.client().login(b.email, TEST_PASSWORD);
  const so = await t.client().login(owner.email, undefined, owner.secret);
  const counts = async (c: typeof ca) => { const r = await c.get("/live/unread"); assert.equal(r.status, 200); assert.match(r.headers.get("cache-control") ?? "", /no-store/); return r.json() as Promise<{ messages: number; notifications: number }>; };

  assert.deepEqual(await counts(ca), { messages: 0, notifications: 0 });
  // Staff writes in A's general conversation; A's count rises, B's does not.
  await t.db.prepare(`INSERT INTO messages (id, organization_id, project_id, author_user_id, body, internal, created_at) VALUES ('msg_live1', ?, NULL, ?, 'Hello A', 0, ?)`).bind(a.organizationId, owner.id, at(0)).run();
  await t.db.prepare(`INSERT INTO notifications (id, user_id, kind, body, created_at) VALUES ('ntf_live1', ?, 'message', 'New message', ?)`).bind(a.id, at(0)).run();
  assert.deepEqual(await counts(ca), { messages: 1, notifications: 1 });
  assert.deepEqual(await counts(cb), { messages: 0, notifications: 0 }, "tenant isolation");
  // Internal staff notes are never counted for customers.
  await t.db.prepare(`INSERT INTO messages (id, organization_id, project_id, author_user_id, body, internal, created_at) VALUES ('msg_live2', ?, NULL, ?, 'internal', 1, ?)`).bind(a.organizationId, owner.id, at(0)).run();
  assert.equal((await counts(ca)).messages, 1);
  // A customer writes; the Owner (customers.read) sees one unread general message.
  await t.db.prepare(`INSERT INTO messages (id, organization_id, project_id, author_user_id, body, internal, created_at) VALUES ('msg_live3', ?, NULL, ?, 'Question', 0, ?)`).bind(b.organizationId, b.id, at(0)).run();
  assert.equal((await counts(so)).messages, 1);

  // Anonymous: no data.
  const anon = await t.client().get("/live/unread");
  assert.notEqual(anon.status, 200);

  // Passive: a poll does not refresh last_seen_at, a page view does.
  const sid = (await t.db.prepare(`SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`).bind(a.id).first<{ id: string }>())!.id;
  const tenMin = at(10 * 60e3);
  await t.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(tenMin, sid).run();
  await counts(ca);
  assert.equal((await t.db.prepare(`SELECT last_seen_at FROM sessions WHERE id = ?`).bind(sid).first<{ last_seen_at: string }>())!.last_seen_at, tenMin, "polling is not activity");
  await ca.get("/portal");
  assert.notEqual((await t.db.prepare(`SELECT last_seen_at FROM sessions WHERE id = ?`).bind(sid).first<{ last_seen_at: string }>())!.last_seen_at, tenMin, "a page view is activity");
  // An idle session (beyond the customer idle limit) is not revived by polling.
  await t.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(at(25 * 3600e3), sid).run();
  assert.notEqual((await ca.get("/live/unread")).status, 200);

  // The app shell carries the live region only for signed-in users.
  assert.match(await (await so.get("/staff")).text(), /data-live-root/);
});

test("[SEC-007] F-15 anti-automation: per-user limit on repeated authenticated form submissions (429 + security event), off in development by default", async () => {
  const t = await createTestApp({ ACTION_RATE_LIMIT: "on" });
  const c = await createCustomer(t.db, "burst@example.com");
  const cl = await t.client().login(c.email, TEST_PASSWORD);
  for (let i = 0; i < ACTIONS_PER_ROUTE; i++) assert.notEqual((await cl.post("/portal/notifications/read")).status, 429, `submission ${i + 1}`);
  const over = await cl.post("/portal/notifications/read");
  assert.equal(over.status, 429);
  assert.match(await over.text(), /Too many actions/);
  assert.ok(await t.db.prepare(`SELECT 1 FROM security_events WHERE kind = 'rate_limited' AND user_id = ?`).bind(c.id).first());
  // Other users are unaffected.
  const d = await createCustomer(t.db, "calm@example.com");
  assert.notEqual((await (await t.client().login(d.email, TEST_PASSWORD)).post("/portal/notifications/read")).status, 429);

  const dev = await createTestApp();
  const e = await createCustomer(dev.db, "dev@example.com");
  const de = await dev.client().login(e.email, TEST_PASSWORD);
  for (let i = 0; i <= ACTIONS_PER_ROUTE; i++) assert.notEqual((await de.post("/portal/notifications/read")).status, 429);
});
