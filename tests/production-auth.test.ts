// Production-mode authentication journeys (AUTH-001..006, AUTH-008, INFRA-002). The same flows already have
// development-mode tests in tests/auth.test.ts; these run the real request pipeline with ENVIRONMENT=production
// — including a misconfigured preview gate — to prove the production Worker behaves as the Founder approved:
// public pages open to everyone, individual accounts for customers, employees and the Owner, MFA for staff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createTestApp, createStaff, createCustomer, lastEmail, linkFrom, TEST_PASSWORD } from "./support/app.ts";
import { totpCode } from "../src/lib/auth-crypto.ts";

// Production enables the breached-password check; answer it locally (no breach) instead of calling the API.
// Turnstile siteverify is answered locally too: only the token "human-token" passes (TEST DATA).
const noBreach: typeof fetch = async (input, init) => {
  if (String(input).includes("turnstile/v0/siteverify")) return Response.json({ success: (init?.body as FormData).get("response") === "human-token" });
  return new Response("0000000000000000000000000000000000A:0\n", { status: 200 });
};
const HUMAN = { "cf-turnstile-response": "human-token" };
const TEST_MFA_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

async function productionApp() {
  // PREVIEW_GATE and STAGING_ACCESS_PASSWORD are set on purpose: production must ignore them.
  return createTestApp({ ENVIRONMENT: "production", APP_URL: "http://crestmont.test", PREVIEW_GATE: "required", STAGING_ACCESS_PASSWORD: "staging-preview-pw",
    TURNSTILE_SECRET: "test-turnstile-secret", MFA_ENCRYPTION_KEY: TEST_MFA_KEY, overrides: { fetch: noBreach } });
}

const PUBLIC_PAGES = ["/", "/services", "/pricing", "/pricing/compare", "/portfolio", "/process", "/about", "/faq", "/hosting-maintenance", "/contact", "/quote", "/legal", "/legal/privacy", "/login", "/register", "/password/forgot"];

test("[INFRA-002] production: every public page opens without a preview password, banner or noindex; private areas still require sign-in", async () => {
  const { client } = await productionApp();
  const c = client();
  for (const p of PUBLIC_PAGES) {
    const r = await c.get(p);
    assert.equal(r.status, 200, `${p} is public`);
    const body = await r.text();
    assert.doesNotMatch(body, /__preview-access|Preview password/i, `${p} shows no preview gate`);
    assert.doesNotMatch(body, /Staging environment|Development environment/, `${p} has no environment banner`);
    if (!["/login", "/register", "/password/forgot"].includes(p)) assert.doesNotMatch(body, /name="robots" content="noindex/, `${p} is indexable`);
  }
  for (const p of ["/portal", "/staff", "/account", "/staff/readiness/approve"]) {
    const r = await c.get(p);
    assert.equal(r.status, 303, `${p} redirects`);
    assert.match(r.headers.get("location") ?? "", /^\/login/, `${p} requires sign-in`);
  }
});

test("[AUTH-001] [AUTH-008] production: a customer signs up, confirms the email, signs in and sees only their own organization", async () => {
  const { db, client } = await productionApp();
  const other = await createCustomer(db, "other@example.com", "Other Org");
  const c = client();
  const reg = await c.post("/register", { name: "Riley Shaw", organization: "Shaw Studio", email: "riley@shaw.example", password: TEST_PASSWORD, terms: "1", ...HUMAN });
  assert.equal(reg.status, 200);
  const mail = await lastEmail(db, "riley@shaw.example");
  assert.equal(mail?.template, "verification");
  assert.equal((await c.get(linkFrom(mail!.text_body, "/verify-email"))).status, 303);
  const login = await c.post("/login", { email: "riley@shaw.example", password: TEST_PASSWORD });
  assert.equal(login.headers.get("location"), "/portal");
  const portal = await c.get("/portal");
  assert.equal(portal.status, 200);
  const html = await portal.text();
  assert.match(html, /Shaw Studio/);
  assert.doesNotMatch(html, /Other Org/);
  const smuggled = await c.get(`/portal?org=${other.organizationId}`);
  assert.doesNotMatch(await smuggled.text(), /Other Org/, "cannot switch into another organization");
  const staff = await c.get("/staff");
  assert.notEqual(staff.status, 200, "customers never reach the staff area");
  const hash = await db.prepare(`SELECT password_hash FROM users WHERE email = ?`).bind("riley@shaw.example").first<{ password_hash: string }>();
  assert.ok(hash && !hash.password_hash.includes(TEST_PASSWORD), "no plaintext password stored");
});

test("[AUTH-006] [AUTH-003] production: an employee accepts an individual invitation, must enrol MFA, and gets only their role", async () => {
  const { db, client } = await productionApp();
  const { createInvitation } = await import("../src/services/auth.ts");
  const admin = await createStaff(db, "administrator");
  const token = await createInvitation(db, admin.id, "sam@crestmont.test", "sales", admin.organizationId);
  const c = client();
  assert.equal((await c.post("/invite", { token, name: "Sam Sales", password: TEST_PASSWORD })).status, 303);
  const login = await c.post("/login", { email: "sam@crestmont.test", password: TEST_PASSWORD });
  assert.equal(login.headers.get("location"), "/mfa");
  assert.match((await c.get("/staff")).headers.get("location") ?? "", /^\/mfa/, "no staff page before MFA");
  assert.equal((await c.get("/mfa")).headers.get("location"), "/mfa/setup");
  const setup = await (await c.get("/mfa/setup")).text();
  const secret = /data-testid="totp-secret">([A-Z2-7 ]+)</.exec(setup)![1].replace(/ /g, "");
  assert.equal((await c.post("/mfa/setup", { code: await totpCode(secret) })).status, 200, "enrolled; recovery codes shown once");
  assert.equal((await c.get("/staff")).status, 200);
  const approve = await c.get("/staff/readiness/approve");
  assert.notEqual(approve.status, 200, "only the Owner may open the release approval page");
});

test("[AUTH-003] production: the Owner is bootstrapped by a one-time invitation (no default password), signs in with email + password and must pass MFA", async () => {
  const { db, client } = await productionApp();
  const r = spawnSync(process.execPath, ["--no-warnings", "scripts/bootstrap-owner.ts", "--email", "founder@crestmont.test", "--print-sql", "--url", "http://crestmont.test"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const stmt of r.stdout.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await db.prepare(stmt).run();
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM users WHERE password_hash IS NOT NULL`).first<{ n: number }>())?.n, 0, "no account has a default password");
  const invite = /\/invite\?token=([0-9a-f]+)/.exec(r.stderr)?.[1];
  assert.ok(invite, "the invitation link is printed once, to the operator only");

  const c = client();
  assert.equal((await c.post("/invite", { token: invite!, name: "The Founder", password: TEST_PASSWORD })).status, 303);
  assert.equal((await c.post("/invite", { token: invite!, name: "Someone else", password: TEST_PASSWORD })).status, 400, "the Owner invitation is single-use");
  assert.equal((await c.post("/login", { email: "founder@crestmont.test", password: TEST_PASSWORD })).headers.get("location"), "/mfa");
  assert.match((await c.get("/staff/readiness/approve")).headers.get("location") ?? "", /^\/mfa/, "release approval requires MFA");
  assert.equal((await c.get("/mfa")).headers.get("location"), "/mfa/setup", "the Owner must enrol an authenticator");
  const setup = await (await c.get("/mfa/setup")).text();
  const secret = /data-testid="totp-secret">([A-Z2-7 ]+)</.exec(setup)![1].replace(/ /g, "");
  assert.equal((await c.post("/mfa/setup", { code: "000000" })).status, 400);
  assert.equal((await c.post("/mfa/setup", { code: await totpCode(secret) })).status, 200, "enrolled; recovery codes shown once");
  assert.equal((await c.get("/staff/readiness/approve")).status, 200);
  const role = await db.prepare(`SELECT m.role_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'founder@crestmont.test'`).first<{ role_id: string }>();
  assert.equal(role?.role_id, "owner");

  // A new session must pass MFA again.
  const d = client();
  assert.equal((await d.post("/login", { email: "founder@crestmont.test", password: TEST_PASSWORD })).headers.get("location"), "/mfa");
  assert.equal((await d.post("/mfa", { code: "000000" })).status, 401);
  const account = await c.get("/account");
  assert.equal(account.status, 200);
  assert.ok(!(await account.text()).includes(secret), "an enrolled MFA secret is never shown again");
  assert.match((await d.get("/mfa/setup")).headers.get("location") ?? "", /^\/mfa(\?next=%2Fmfa%2Fsetup)?$/, "an unverified session cannot replace the authenticator");
});

test("[AUTH-002] [AUTH-004] production: password reset is single-use, signs out every session, and does not reveal whether an account exists", async () => {
  const { db, client } = await productionApp();
  // Password-only account (an administrator who has not enrolled yet; FD-30 still lets them sign in and browse).
  const cust = await createCustomer(db, "reset@example.com", undefined, { mfa: false });
  const a = client();
  assert.equal((await a.post("/login", { email: cust.email, password: TEST_PASSWORD })).headers.get("location"), "/portal");
  const b = client();
  const unknown = await (await b.post("/password/forgot", { email: "nobody@example.com", ...HUMAN })).text();
  const known = await (await b.post("/password/forgot", { email: cust.email, ...HUMAN })).text();
  assert.equal(unknown.replace(/nobody@example\.com/g, ""), known.replace(/reset@example\.com/g, ""), "same response for unknown accounts");
  const mail = await lastEmail(db, cust.email);
  assert.equal(mail?.template, "password_reset");
  const link = linkFrom(mail!.text_body, "/password/reset");
  const token = new URL(link, "http://crestmont.test").searchParams.get("token")!;
  const NEW = "a-brand-new-long-passphrase-42";
  assert.equal((await b.post("/password/reset", { token, password: NEW })).status, 303);
  assert.equal((await b.post("/password/reset", { token, password: NEW + "x" })).status, 400, "reset links are single-use");
  assert.match((await a.get("/portal")).headers.get("location") ?? "", /^\/login/, "the old session was signed out");
  const old = await b.post("/login", { email: cust.email, password: TEST_PASSWORD });
  assert.equal(old.status, 400, "old password no longer works (form re-shown with an error)");
  assert.match(await old.text(), /Email or password is incorrect/);
  assert.equal((await b.post("/login", { email: cust.email, password: NEW })).headers.get("location"), "/portal");
});

test("[AUTH-005] production: repeated failures never lock an account; a remembered browser keeps signing in; strangers are challenged (CREST-GAP-003)", async () => {
  const { db, client } = await productionApp();
  // Password-only account (not enrolled in MFA yet), so a password sign-in is a completed sign-in.
  const cust = await createCustomer(db, "lock@example.com", undefined, { mfa: false });
  // The account holder signs in once from their own browser: it becomes a known device.
  const owner = client();
  assert.equal((await owner.post("/login", { email: cust.email, password: TEST_PASSWORD })).status, 303);
  assert.ok(owner.cookies.get("cm_device"), "a remembered-device cookie is set after a completed sign-in");
  await owner.post("/logout");
  // An anonymous attacker hammers the address from another browser.
  const attacker = client();
  for (let i = 0; i < 5; i++) assert.equal((await attacker.post("/login", { email: cust.email, password: "wrong-password-attempt" })).status, 400);
  for (let i = 0; i < 20; i++) assert.notEqual((await attacker.post("/login", { email: cust.email, password: "wrong-password-attempt" })).status, 303);
  const strangerRight = await attacker.post("/login", { email: cust.email, password: TEST_PASSWORD });
  assert.notEqual(strangerRight.status, 303, "an unknown browser without the challenge gets no session");
  assert.equal(strangerRight.headers.getSetCookie().some((x) => x.startsWith("cm_session=") && !/max-age=0/i.test(x)), false);
  // The real holder's remembered browser is unaffected.
  assert.equal((await owner.post("/login", { email: cust.email, password: TEST_PASSWORD })).status, 303, "known device signs in despite the attack");
  assert.equal((await db.prepare(`SELECT locked_until FROM users WHERE id = ?`).bind(cust.id).first<{ locked_until: string | null }>())?.locked_until, null);
  const ev = await db.prepare(`SELECT COUNT(*) n FROM security_events WHERE kind IN ('login_failed','login_challenge_required','rate_limited')`).first<{ n: number }>();
  assert.ok((ev?.n ?? 0) >= 20);
});
