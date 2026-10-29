// Contact redesign: same intake contract (fields, names, values, validation, CRM lead, thank-you redirect), plus a
// one-time submission token so a double submit never creates a second lead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";

test("[WEB-004] [WEB-005] contact page keeps the intake contract: same fields, topics, CSRF, honeypot, Turnstile slot", async () => {
  const { client } = await createTestApp();
  const h = await (await client().get("/contact?topic=maintenance")).text();
  for (const n of ["name", "email", "phone", "company", "message", "_csrf", "fax_number", "submission"]) assert.match(h, new RegExp(`name="${n}"`), n);
  const topics = [...h.matchAll(/<input type="radio" name="interest" value="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(topics, ["starter", "business", "premium", "custom", "maintenance", "other"]);
  assert.match(h, /value="maintenance" checked/, "topic preselected from the link");
  assert.match(h, /href="mailto:[^"]+@crestmontwebsitedevelopment\.com"/, "official email addresses are linked");
  assert.match(h, /data-cx-form/);
});

test("[WEB-004] a double submit creates one lead; a token survives a validation error", async () => {
  const { db, client } = await createTestApp();
  const c = client();
  const token = `${Math.floor(Date.now() / 1000)}-a1b2c3d4e5f6a7b8c9d0e1f2`;
  const count = async () => (await db.prepare(`SELECT COUNT(*) AS n FROM leads`).first<{ n: number }>())!.n;
  const bad = await c.post("/contact", { name: "Riley Park", email: "riley@example.com", interest: "other", message: "short", submission: token });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), new RegExp(`name="submission" value="${token}"`), "the re-rendered form keeps the same token");
  const body = { name: "Riley Park", email: "riley@example.com", interest: "other", message: "Do you host sites built elsewhere?", submission: token };
  const [a, b] = await Promise.all([c.post("/contact", body), c.post("/contact", body)]);
  assert.deepEqual([a.status, b.status], [303, 303]);
  assert.equal(a.headers.get("location"), "/contact/thanks"); assert.equal(b.headers.get("location"), "/contact/thanks");
  assert.equal(await count(), 1, "exactly one lead");
  assert.equal((await c.post("/contact", body)).status, 303);
  assert.equal(await count(), 1, "a later replay still creates nothing");
  // Without a token the form behaves exactly as before (one lead per submit).
  await c.post("/contact", { ...body, submission: "" });
  assert.equal(await count(), 2);
  // Cross-site posts are still refused.
  assert.equal((await c.post("/contact", body, { csrf: false })).status, 403);
});

test("[WEB-004] the thank-you page states only what happened: confirmation only after a saved submission (CREST-GAP-097)", async () => {
  const { client } = await createTestApp();
  const c = client();
  const sent = await c.post("/contact", { name: "Riley Park", email: "riley@example.com", interest: "other", message: "Do you host sites built elsewhere?" });
  assert.equal(sent.headers.get("location"), "/contact/thanks");
  const h = await (await c.get("/contact/thanks")).text();
  assert.match(h, /Message received/);
  assert.match(h, /Reply by email/);
  assert.doesNotMatch(h, /within \d+ (hours|minutes)|guarantee/i, "no invented response-time promises");
  // The success flash is one-time: a reload, a bookmark or a direct visit confirms nothing.
  for (const [path, fresh] of [["/contact/thanks", false], ["/contact/thanks", true], ["/quote/thanks", true]] as const) {
    const d = await (await (fresh ? client() : c).get(path)).text();
    assert.doesNotMatch(d, /Message received|Quote request received|Received<\/div>|is now in our CRM|Recorded/, `${path}: neutral text without the flash`);
    assert.match(d, /confirms a (message|quote request) right after it is sent/);
    assert.match(d, /<meta name="robots" content="noindex, nofollow">/);
  }
});

test("[WEB-004] submission tokens: a duplicate reports success only for a saved lead; tokens don't reset at midnight; stale tokens are replaced", async () => {
  const { db, client } = await createTestApp();
  const c = client();
  const issued = Math.floor(Date.now() / 1000) - 3600; // issued an hour ago: the claim must not depend on today's UTC bucket
  const token = `${issued}-0123456789abcdef01234567`;
  const body = { name: "Riley Park", email: "riley@example.com", interest: "other", message: "Do you host sites built elsewhere?", submission: token };
  // A claim with no saved lead (first request still in flight, or it failed after claiming): a duplicate is not told "received".
  await db.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)`).bind("leadsub:0123456789abcdef01234567", issued).run();
  const dup = await c.post("/contact", body);
  assert.equal(dup.status, 409);
  assert.match(await dup.text(), /already being sent/);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM leads`).first<{ n: number }>())!.n, 0);
  // Once the lead is saved, a duplicate reports success and still creates nothing.
  await db.prepare(`DELETE FROM rate_limits WHERE key LIKE 'leadsub:%'`).run();
  assert.equal((await c.post("/contact", body)).status, 303);
  assert.equal((await c.post("/contact", body)).headers.get("location"), "/contact/thanks");
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM leads`).first<{ n: number }>())!.n, 1);
  // An expired token is not honoured: the form re-renders with a fresh one.
  const stale = `${issued - 3 * 86_400}-0123456789abcdef01234567`;
  const h = await (await c.post("/contact", { ...body, message: "short", submission: stale })).text();
  const fresh = /name="submission" value="([^"]+)"/.exec(h)![1];
  assert.notEqual(fresh, stale); assert.match(fresh, /^\d{10}-[a-f0-9]{24}$/);
});
