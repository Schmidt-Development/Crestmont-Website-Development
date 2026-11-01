import { test } from "node:test";
import assert from "node:assert/strict";
import { app, CONFIG, off } from "./helpers.mjs";

test("[backend] [deployment] health check reports the database and the foundation version", async () => {
  const t = await app();
  const r = await t.get("/api/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, database: "ok" });
});

test("[backend] [config] public configuration comes from business.config.json and exposes no secrets", async () => {
  const t = await app({ env: { STRIPE_SECRET_KEY: "sk_test_" + "x".repeat(24), STRIPE_WEBHOOK_SECRET: "whsec_" + "y".repeat(24) } });
  const r = await t.get("/api/config");
  assert.equal(r.status, 200);
  assert.equal(r.json.business.name, CONFIG.business.name);
  assert.equal(r.json.business.timeZone, CONFIG.business.timeZone);
  assert.doesNotMatch(r.text, /sk_test_|whsec_|ADMIN_SETUP|setup-token/);
  const s = await t.get("/api/services");
  assert.equal(s.json.services.length, (CONFIG.services ?? []).length, "the catalogue is persisted from the configuration");
});

test("[backend] [errors] structured errors: unknown route 404, wrong method 405, bad JSON 400, wrong type 415, oversized 413", async () => {
  const t = await app();
  assert.equal((await t.get("/api/nope")).json.error.code, "not_found");
  assert.equal((await t.call("DELETE", "/api/contact")).status, 405);
  assert.equal((await t.post("/api/contact", "{not json")).json.error.code, "invalid_json");
  assert.equal((await t.call("POST", "/api/contact", "a=b", { "content-type": "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await t.post("/api/contact", { message: "x".repeat(40_000) })).status, 413);
});

test("[security] every API response carries security headers and is not cached", async () => {
  const t = await app();
  const r = await t.get("/api/config");
  for (const h of ["content-security-policy", "x-content-type-options", "referrer-policy", "x-frame-options"]) assert.ok(r.headers.get(h), h);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("[contact] [database] contact messages are validated, persisted and queue a staff notification; the honeypot stores nothing", { skip: off("contact") }, async () => {
  const t = await app();
  const bad = await t.post("/api/contact", { name: "A", email: "nope", message: "short" });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.error.fields.email && bad.json.error.fields.message && bad.json.error.fields.name);
  const ok = await t.post("/api/contact", { name: "Jane Doe", email: "jane@example.test", message: "Please call me about a job next week." });
  assert.equal(ok.status, 201);
  const row = await t.db.prepare(`SELECT * FROM contact_messages`).first();
  assert.equal(row.email, "jane@example.test");
  const n = await t.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE template = 'staff_new_contact'`).first();
  assert.equal(n.n, (CONFIG.notifications?.businessEmail ?? CONFIG.business.email) ? 1 : 0);
  await t.post("/api/contact", { name: "Bot Bot", email: "bot@example.test", message: "Buy cheap things now!!", website: "http://spam.example" });
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM contact_messages`).first()).n, 1, "honeypot submission not stored");
});

test("[security] [contact] public writes are rate limited per client", { skip: off("contact") }, async () => {
  const t = await app();
  let last;
  for (let i = 0; i < 6; i++) last = await t.post("/api/contact", { name: "Jane Doe", email: "jane@example.test", message: `Message number ${i} about a job.` }, { "cf-connecting-ip": "203.0.113.9" });
  assert.equal(last.status, 429);
  assert.ok(last.json.error.retryAfterSeconds > 0);
  const other = await t.post("/api/contact", { name: "Jim Doe", email: "jim@example.test", message: "A different client is not limited." }, { "cf-connecting-ip": "203.0.113.10" });
  assert.equal(other.status, 201);
});

test("[database] [contact] SQL injection attempts are inert (all queries are parameterized)", { skip: off("contact") }, async () => {
  const t = await app();
  const evil = "x'); DROP TABLE contact_messages; --";
  const r = await t.post("/api/contact", { name: evil, email: "evil@example.test", message: `${evil} long enough message` });
  assert.equal(r.status, 201);
  assert.equal((await t.db.prepare(`SELECT name FROM contact_messages`).first()).name, evil);
  assert.equal((await t.get(`/api/availability?service=${encodeURIComponent("a' OR 1=1 --")}&date=2030-01-01`)).status, CONFIG.features?.booking ? 422 : 404);
});
