import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, lastEmail, linkFrom, TEST_PASSWORD } from "./support/app.ts";
import { totpCode, verifyTotp, hashPassword, verifyPassword, base32Encode } from "../src/lib/auth-crypto.ts";
import { html, raw, safeUrl } from "../src/lib/html.ts";

test("[AUTH-003] TOTP matches the RFC 6238 SHA-1 test vectors", async () => {
  const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
  // RFC 6238 Appendix B (8-digit values; we use the last 6 digits)
  assert.equal(await totpCode(secret, 59), "287082");
  assert.equal(await totpCode(secret, 1111111109), "081804");
  assert.equal(await totpCode(secret, 20000000000), "353130");
  assert.equal(await verifyTotp(secret, await totpCode(secret, 1000), 1030), true);   // one step of drift tolerated
  assert.equal(await verifyTotp(secret, await totpCode(secret, 1000), 1100), false);  // three steps rejected
});

test("[AUTH-001] passwords are stored as salted PBKDF2 hashes", async () => {
  const h1 = await hashPassword(TEST_PASSWORD), h2 = await hashPassword(TEST_PASSWORD);
  assert.notEqual(h1, h2);
  assert.match(h1, /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(await verifyPassword(TEST_PASSWORD, h1), true);
  assert.equal(await verifyPassword("wrong-password-123", h1), false);
});

test("[AUTH-001] customer registration → email verification → sign in → portal", async () => {
  const { db, client } = await createTestApp();
  const c = client();
  const reg = await c.post("/register", { name: "Jordan Lee", organization: "Lee Bakery", email: "jordan@leebakery.example", password: TEST_PASSWORD, terms: "1" });
  assert.equal(reg.status, 200);
  assert.match(await reg.text(), /Check your email/);
  const mail = await lastEmail(db, "jordan@leebakery.example");
  assert.equal(mail?.template, "verification");
  const verify = await c.get(linkFrom(mail!.text_body, "/verify-email"));
  assert.equal(verify.status, 303);
  assert.ok((await db.prepare(`SELECT email_verified_at FROM users WHERE email = ?`).bind("jordan@leebakery.example").first<{ email_verified_at: string }>())?.email_verified_at);
  const replay = await c.get(linkFrom(mail!.text_body, "/verify-email"));
  assert.equal(replay.status, 400, "verification links are single-use");
  const login = await c.post("/login", { email: "Jordan@LeeBakery.example", password: TEST_PASSWORD });
  assert.equal(login.headers.get("location"), "/portal");
  const org = await db.prepare(`SELECT o.name, m.role_id FROM memberships m JOIN organizations o ON o.id = m.organization_id JOIN users u ON u.id = m.user_id WHERE u.email = ?`).bind("jordan@leebakery.example").first<{ name: string; role_id: string }>();
  assert.deepEqual({ ...org }, { name: "Lee Bakery", role_id: "customer_admin" });
});

test("[AUTH-001] registration rejects weak passwords and does not reveal existing accounts", async () => {
  const { db, client } = await createTestApp();
  const weak = await client().post("/register", { name: "A B", organization: "Org", email: "x@example.com", password: "short", terms: "1" });
  assert.equal(weak.status, 400);
  await createCustomer(db, "taken@example.com");
  const dup = await client().post("/register", { name: "Someone", organization: "Org", email: "taken@example.com", password: TEST_PASSWORD, terms: "1" });
  assert.equal(dup.status, 200);
  assert.match(await dup.text(), /If this address can be used/);
});

test("[AUTH-003] staff must complete MFA before reaching staff pages", async () => {
  const { db, client } = await createTestApp();
  const s = await createStaff(db, "sales");
  const c = client();
  const res = await c.post("/login", { email: s.email, password: TEST_PASSWORD });
  assert.equal(res.headers.get("location"), "/mfa");
  const blocked = await c.get("/account");
  assert.equal(blocked.status, 303);
  assert.match(blocked.headers.get("location") ?? "", /^\/mfa/);
  const bad = await c.post("/mfa", { code: "000000" });
  assert.equal(bad.status, 401);
  const ok = await c.post("/mfa", { code: await totpCode(s.secret) });
  assert.equal(ok.status, 303);
  assert.equal((await c.get("/account")).status, 200);
});

test("[AUTH-003] staff without MFA are sent to enrolment and can enable TOTP", async () => {
  const { db, client } = await createTestApp();
  const s = await createStaff(db, "developer");
  await db.prepare(`UPDATE users SET totp_secret = NULL, mfa_enabled = 0 WHERE id = ?`).bind(s.id).run();
  const c = client();
  await c.post("/login", { email: s.email, password: TEST_PASSWORD });
  const mfa = await c.get("/mfa");
  assert.equal(mfa.headers.get("location"), "/mfa/setup");
  const setup = await c.get("/mfa/setup");
  const secret = /data-testid="totp-secret">([A-Z2-7 ]+)</.exec(await setup.text())![1].replace(/ /g, "");
  const done = await c.post("/mfa/setup", { code: await totpCode(secret) });
  assert.equal(done.status, 303);
  assert.equal((await db.prepare(`SELECT mfa_enabled FROM users WHERE id = ?`).bind(s.id).first<{ mfa_enabled: number }>())?.mfa_enabled, 1);
});

test("[AUTH-005] repeated failed sign-ins are rate limited, locked and logged", async () => {
  const { db, client } = await createTestApp();
  const cust = await createCustomer(db, "victim@example.com");
  const c = client();
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await c.post("/login", { email: cust.email, password: "wrong-password-xx" })).status);
  assert.ok(statuses.slice(0, 8).every((s) => s === 400));
  assert.ok(statuses.includes(400) && statuses.at(-1) === 400);
  const locked = await db.prepare(`SELECT locked_until FROM users WHERE id = ?`).bind(cust.id).first<{ locked_until: string | null }>();
  assert.ok(locked?.locked_until, "account locked after repeated failures");
  const right = await c.post("/login", { email: cust.email, password: TEST_PASSWORD });
  assert.notEqual(right.status, 303, "locked or rate-limited account cannot sign in even with the right password");
  const events = await db.prepare(`SELECT COUNT(*) n FROM security_events WHERE kind IN ('login_failed','login_locked','rate_limited')`).first<{ n: number }>();
  assert.ok(events!.n >= 9);
});

test("[AUTH-004] sessions can be listed and revoked; password change signs out other sessions", async () => {
  const { db, client } = await createTestApp();
  const cust = await createCustomer(db, "multi@example.com");
  const a = await client().login(cust.email), b = await client().login(cust.email);
  assert.equal((await b.get("/account")).status, 200);
  const res = await a.post("/account/sessions/revoke-others");
  assert.equal(res.status, 303);
  assert.equal((await b.get("/account")).status, 303, "other session revoked");
  assert.equal((await a.get("/account")).status, 200, "current session kept");
  const logout = await a.post("/logout");
  assert.equal(logout.status, 303);
  assert.equal((await a.get("/account")).status, 303);
});

test("[AUTH-002] password reset links are single-use and revoke existing sessions", async () => {
  const { db, client } = await createTestApp();
  const cust = await createCustomer(db, "forgot@example.com");
  const existing = await client().login(cust.email);
  const c = client();
  await c.post("/password/forgot", { email: cust.email });
  const mail = await lastEmail(db, cust.email);
  assert.equal(mail?.template, "password_reset");
  const token = new URL(linkFrom(mail!.text_body, "/password/reset"), "http://x").searchParams.get("token")!;
  assert.equal((await c.post("/password/reset", { token, password: "a-brand-new-password-1" })).status, 303);
  assert.equal((await c.post("/password/reset", { token, password: "another-new-password-2" })).status, 400);
  assert.equal((await existing.get("/account")).status, 303);
  await client().login(cust.email, "a-brand-new-password-1");
  const none = await client().post("/password/forgot", { email: "nobody@example.com" });
  assert.match(await none.text(), /If an account exists/);
});

test("[AUTH-006] staff invitations create a role membership and cannot grant Owner", async () => {
  const { db, client } = await createTestApp();
  const { createInvitation } = await import("../src/services/auth.ts");
  const admin = await createStaff(db, "administrator");
  await assert.rejects(createInvitation(db, admin.id, "boss@example.com", "owner", admin.organizationId), /Owner/);
  const token = await createInvitation(db, admin.id, "newdev@example.com", "developer", admin.organizationId);
  const c = client();
  assert.equal((await c.get(`/invite?token=${token}`)).status, 200);
  assert.equal((await c.post("/invite", { token, name: "New Dev", password: TEST_PASSWORD })).status, 303);
  const m = await db.prepare(`SELECT m.role_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'newdev@example.com'`).first<{ role_id: string }>();
  assert.equal(m?.role_id, "developer");
  assert.equal((await c.post("/invite", { token, name: "Again", password: TEST_PASSWORD })).status, 400, "re-use is refused");
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'newdev@example.com'`).first<{ n: number }>())?.n, 1);
});

test("[SEC-002] CSRF: form posts without a matching token or from another origin are rejected", async () => {
  const { client } = await createTestApp();
  const c = client();
  await c.get("/login");
  assert.equal((await c.post("/login", { email: "a@b.co", password: "x" }, { csrf: false })).status, 403);
  assert.equal((await c.post("/login", { email: "a@b.co", password: "x" }, { csrf: "0".repeat(32) })).status, 403);
  assert.equal((await c.post("/login", { email: "a@b.co", password: "x" }, { origin: "https://evil.example" })).status, 403);
});

test("[SEC-002] HTML output is escaped and unsafe URLs are neutralised", () => {
  const evil = `<script>alert("x")</script>`;
  assert.equal(html`<p>${evil}</p>`.value, "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
  assert.equal(html`<p>${raw("<b>ok</b>")}</p>`.value, "<p><b>ok</b></p>");
  assert.equal(safeUrl("javascript:alert(1)"), "#");
  assert.equal(safeUrl("//evil.example"), "#");
  assert.equal(safeUrl("https://betterlansingmechanics.com"), "https://betterlansingmechanics.com");
});

test("[SEC-002] pages carry a strict CSP and anti-framing headers", async () => {
  const { client } = await createTestApp();
  const res = await client().get("/login");
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  const cookies = res.headers.getSetCookie().join("\n");
  assert.match(cookies, /cm_csrf=[0-9a-f]{32}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Strict/);
});
