// CREST-GAP-003 acceptance: anonymous attackers cannot lock the Owner out; the lock never extends; alerts are recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, lastEmail, linkFrom, TEST_PASSWORD, type TestClient } from "./support/app.ts";

async function postFrom(c: TestClient, ip: string, path: string, fields: Record<string, string>) {
  if (!c.cookies.has("cm_csrf")) await c.get("/login");
  const body = new URLSearchParams({ _csrf: c.cookies.get("cm_csrf")!, ...fields }).toString();
  return c.request("POST", path, { body, headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://crestmont.test", "cf-connecting-ip": ip } });
}

test("[AUTH-005] [SEC-001] 50 wrong passwords from 5 IPs cannot keep the Owner out of their remembered browser (CREST-GAP-003)", async () => {
  const { db, client } = await createTestApp({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET: "secret" });
  const owner = await createStaff(db, "owner");
  const own = client();
  await own.login(owner.email, TEST_PASSWORD, owner.secret);
  assert.ok(own.cookies.get("cm_device"), "device remembered after password + MFA");
  await own.post("/logout");

  for (let i = 0; i < 50; i++) {
    const res = await postFrom(client(), `203.0.113.${i % 5}`, "/login", { email: owner.email, password: `guess-${i}-wrong-pass` });
    assert.notEqual(res.status, 303);
  }
  const user = await db.prepare(`SELECT locked_until FROM users WHERE id = ?`).bind(owner.id).first<{ locked_until: string | null }>();
  assert.equal(user!.locked_until, null, "no lock is ever set");
  const back = await own.post("/login", { email: owner.email, password: TEST_PASSWORD });
  assert.equal(back.status, 303);
  assert.match(back.headers.get("location") ?? "", /^\/mfa/, "the Owner proceeds to MFA from the remembered browser");
  const started = await db.prepare(`SELECT COUNT(*) n FROM security_events WHERE kind = 'login_challenge_started' AND user_id = ?`).bind(owner.id).first<{ n: number }>();
  assert.equal(started!.n, 1, "the challenge start is recorded once per window");
});

test("[AUTH-005] a remembered browser's own wrong guesses are limited per browser, and a password reset forgets remembered browsers (CREST-GAP-003)", async () => {
  const turnstile: typeof fetch = async (_u, init) => new Response(JSON.stringify({ success: init?.body instanceof FormData && init.body.get("response") === "pass" }));
  const { db, client } = await createTestApp({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET: "secret", PASSWORD_BREACH_CHECK: "off", overrides: { fetch: turnstile } });
  const owner = await createStaff(db, "owner");
  const own = client();
  await own.login(owner.email, TEST_PASSWORD, owner.secret);
  await own.post("/logout");
  const bodies: string[] = [];
  for (let i = 0; i < 11; i++) bodies.push(await (await own.post("/login", { email: owner.email, password: `typo-${i}-wrong-pass` })).text());
  assert.match(bodies.at(-1)!, /Too many sign-in attempts from this browser/, "a known browser is throttled after 10 wrong guesses");
  assert.ok(bodies.slice(0, 10).every((b) => /Email or password is incorrect/.test(b)), "never challenged or locked by its own typos before that");
  // A real password reset revokes every remembered browser.
  await client().post("/password/forgot", { email: owner.email, "cf-turnstile-response": "pass" });
  const link = linkFrom((await lastEmail(db, owner.email))!.text_body, "/password/reset");
  const token = new URL(link, "http://x").searchParams.get("token")!;
  assert.equal((await client().post("/password/reset", { token, password: "fresh-crimson-lantern-harbor-73" })).status, 303);
  const rows = await db.prepare(`SELECT COUNT(*) n FROM known_devices WHERE user_id = ? AND revoked_at IS NULL`).bind(owner.id).first<{ n: number }>();
  assert.equal(rows!.n, 0, "no remembered browser survives the reset");
});
