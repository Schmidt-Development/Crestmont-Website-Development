import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, enrolTotp, TEST_PASSWORD } from "./support/app.ts";
import { handle } from "../src/app/app.ts";

const req = (env: object, path: string, init: RequestInit = {}) => handle(new Request("https://staging.example" + path, init), env as never);

test("[INFRA-002] emergency re-lock (PREVIEW_GATE=required): every page needs the preview pass; machine endpoints stay reachable", async () => {
  const { env } = await createTestApp({ ENVIRONMENT: "staging", PREVIEW_GATE: "required", STAGING_ACCESS_PASSWORD: "correct preview words" });
  for (const p of ["/", "/pricing", "/login", "/portal", "/staff"]) {
    const r = await req(env, p);
    assert.equal(r.status, 401, p);
    assert.match(await r.text(), /Staging preview/);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  }
  assert.equal((await req(env, "/api/health")).status, 200);
  assert.equal((await req(env, "/api/leads", { method: "POST", body: "{}" })).status, 401, "cookie-less API calls are gated too");
  assert.equal((await req(env, "/api/webhooks/stripe", { method: "POST", body: "{}" })).status, 401, "webhook reaches its own signature check (401 from Stripe verification)");
  const wrong = await req(env, "/__preview-access", { method: "POST", body: new URLSearchParams({ password: "nope", next: "/pricing" }) });
  assert.equal(wrong.status, 401);
  const ok = await req(env, "/__preview-access", { method: "POST", body: new URLSearchParams({ password: "correct preview words", next: "/pricing" }) });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/pricing");
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  assert.match(ok.headers.get("set-cookie")!, /HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await req(env, "/pricing", { headers: { cookie } })).status, 200);
  assert.equal((await req(env, "/pricing", { headers: { cookie: "cm_preview=1700000000." + "0".repeat(64) } })).status, 401, "forged pass refused");
  const offsite = await req(env, "/__preview-access", { method: "POST", body: new URLSearchParams({ password: "correct preview words", next: "//evil.example" }) });
  assert.equal(offsite.headers.get("location"), "/", "no open redirect");
});

test("[INFRA-002] the preview gate never replaces application authorization and is ignored in production", async () => {
  const { db, env } = await createTestApp({ ENVIRONMENT: "staging", PREVIEW_GATE: "required", STAGING_ACCESS_PASSWORD: "pw-for-preview" });
  const ok = await req(env, "/__preview-access", { method: "POST", body: new URLSearchParams({ password: "pw-for-preview", next: "/" }) });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  const staff = await req(env, "/staff", { headers: { cookie } });
  assert.equal(staff.status, 303, "staff area still requires sign-in");
  assert.match(staff.headers.get("location")!, /^\/login/);
  await createStaff(db, "owner");
  const prod = await createTestApp({ ENVIRONMENT: "production", PREVIEW_GATE: "required", STAGING_ACCESS_PASSWORD: "pw" });
  assert.equal((await req(prod.env, "/pricing")).status, 200, "gate is off in production");
  void TEST_PASSWORD;
});

test("[INFRA-002] repeated wrong preview passwords are rate limited", async () => {
  const { env } = await createTestApp({ ENVIRONMENT: "staging", PREVIEW_GATE: "required", STAGING_ACCESS_PASSWORD: "pw-rate" });
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await req(env, "/__preview-access", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" }, body: new URLSearchParams({ password: "x" + i }) })).status;
  assert.equal(last, 429);
});

test("[INFRA-002] staging config is public (Founder decision 2026-10-28); production never sets the gate; re-lock fails closed", async () => {
  const toml = (await import("node:fs")).readFileSync("wrangler.toml", "utf8");
  const block = (name: string) => { const s = toml.indexOf(`[env.${name}]`); const e = toml.indexOf("\n[env.", s + 1); return toml.slice(s, e > 0 ? e : undefined); };
  assert.doesNotMatch(block("staging").replace(/^#.*$/gm, ""), /PREVIEW_GATE/, "staging no longer requires the preview gate");
  assert.doesNotMatch(block("production").replace(/^#.*$/gm, ""), /PREVIEW_GATE|STAGING_ACCESS_PASSWORD/, "production never sets it");
  // Emergency re-lock without a password still fails closed.
  const { env } = await createTestApp({ ENVIRONMENT: "staging", PREVIEW_GATE: "required" });
  for (const p of ["/", "/login", "/staff"]) assert.equal((await req(env, p)).status, 503, p);
  assert.equal((await req(env, "/api/health")).status, 200, "health check still reachable for deploy smoke tests");
});

test("[INFRA-002] public staging: a fresh visitor with no cookies sees the website; accounts, MFA and internal areas stay protected; nothing is indexable", async () => {
  // Deployed staging configuration. A leftover STAGING_ACCESS_PASSWORD secret alone must not re-enable the gate.
  const { db, env, client } = await createTestApp({ ENVIRONMENT: "staging", STAGING_ACCESS_PASSWORD: "leftover-old-preview-secret" });
  for (const p of ["/", "/services", "/pricing", "/pricing/compare", "/portfolio", "/process", "/about", "/contact", "/faq", "/login", "/legal"]) {
    const r = await req(env, p);
    const body = await r.text();
    assert.equal(r.status, 200, p);
    assert.doesNotMatch(body, /__preview-access|Preview password/, `${p}: no preview password prompt`);
    assert.match(body, /<meta name="robots" content="noindex, nofollow">/, `${p}: noindex meta`);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow", `${p}: noindex header`);
    assert.match(body, /Staging environment — test data only/, `${p}: clearly labelled as staging`);
  }
  const robots = await req(env, "/robots.txt");
  assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
  assert.equal(robots.headers.get("x-robots-tag"), "noindex, nofollow");
  // Protected areas refuse anonymous visitors.
  for (const p of ["/staff", "/staff/owner", "/portal", "/account", "/staff/crm", "/staff/readiness"]) {
    const r = await req(env, p);
    assert.notEqual(r.status, 200, `${p} must not open anonymously`);
    if (r.status === 303) assert.match(r.headers.get("location")!, /^\/login/, p);
  }
  // Signed machine APIs and webhooks still demand their own signatures.
  assert.equal((await req(env, "/api/readiness/evidence", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await req(env, "/api/webhooks/stripe", { method: "POST", body: "{}" })).status, 401);
  // The old preview endpoint is gone (nothing to brute-force).
  assert.equal((await req(env, "/__preview-access", { method: "POST", body: new URLSearchParams({ password: "leftover-old-preview-secret" }) })).headers.get("set-cookie")?.includes("cm_preview") ?? false, false);
  // Owner and staff: the password alone never reaches the staff area (mandatory MFA); a wrong password is refused.
  await createStaff(db, "owner", "owner@crestmont.test");
  const c = client();
  assert.notEqual((await c.post("/login", { email: "owner@crestmont.test", password: "wrong-password-123" })).headers.get("location"), "/mfa", "wrong password refused");
  const login = await c.post("/login", { email: "owner@crestmont.test", password: TEST_PASSWORD });
  assert.equal(login.headers.get("location"), "/mfa", "Owner password leads to the 2FA step");
  assert.match((await c.get("/staff")).headers.get("location") ?? "", /^\/mfa/, "no staff page before MFA");
  assert.match((await c.get("/staff/readiness/approve")).headers.get("location") ?? "", /^\/mfa/, "release approval requires MFA");
  // Customer accounts still need their own credentials; the portal refuses an anonymous client.
  assert.notEqual((await client().get("/portal")).status, 200);
});

test("[INFRA-002] production responses are unchanged: no X-Robots-Tag, canonical link, crawlable robots.txt", async () => {
  const { env } = await createTestApp({ ENVIRONMENT: "production" });
  const r = await req(env, "/pricing");
  assert.equal(r.headers.get("x-robots-tag"), null);
  assert.match(await r.text(), /<link rel="canonical"/);
  assert.match(await (await req(env, "/robots.txt")).text(), /Allow: \/\n/);
});

test("[SEC-003] public staging: forms are rate-limited even with always-pass Turnstile; an unverified self-registered account cannot upload or share files", async () => {
  // Staging's Turnstile test keys always pass: simulate exactly that.
  const app = await createTestApp({ ENVIRONMENT: "staging", TURNSTILE_SECRET: "1x0000000000000000000000000000000AA", TURNSTILE_SITE_KEY: "1x00000000000000000000AA" });
  app.env.overrides = { ...app.env.overrides, fetch: (async () => new Response(JSON.stringify({ success: true }))) as never };
  // JSON lead API: same per-IP budget as the browser forms (10/hour).
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await req(app.env, "/api/leads", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" }, body: JSON.stringify({ name: "Spam " + i, email: `s${i}@example.com`, interest: "other", source: "web_form", message: "hello there, this is a message", turnstileToken: "x" }) })).status);
  // Valid, bot-verified submissions (CREST-GAP-082: invalid ones are rejected without consuming the budget).
  assert.ok(statuses.slice(0, 10).every((s) => s === 201), statuses.join());
  assert.equal(statuses[10], 429, "11th lead from one IP within the hour is refused");

  // A stranger self-registers (staging sends email only to its allowlist, so they can never verify).
  const c = app.client();
  const reg = await c.post("/register", { name: "Stranger", organization: "Stranger Co", email: "stranger@example.org", password: TEST_PASSWORD, terms: "1", "cf-turnstile-response": "x" });
  assert.equal(reg.status, 200);
  assert.equal((await c.post("/login", { email: "stranger@example.org", password: TEST_PASSWORD, "cf-turnstile-response": "x" })).headers.get("location"), "/portal");
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
  // FD-30: a self-registered customer administrator is first sent to two-factor enrolment; nothing is stored.
  const pre = await c.post("/portal/files", { file: new File([PDF], "x.pdf") });
  assert.match(pre.headers.get("location") ?? "", /^\/mfa\/setup\?next=/);
  // With two-factor authentication in place, the email-verification gate still applies.
  const stranger = (await app.db.prepare(`SELECT id FROM users WHERE email = ?`).bind("stranger@example.org").first<{ id: string }>())!;
  await enrolTotp(app.db, stranger.id);
  await c.login("stranger@example.org");
  const up = await c.post("/portal/files", { file: new File([PDF], "x.pdf") });
  assert.equal(up.status, 403, "unverified account cannot upload on staging");
  assert.match(await up.text(), /Verify your email address/);
  const n = await app.db.prepare(`SELECT COUNT(*) AS n FROM files`).first<{ n: number }>();
  assert.equal(n?.n, 0, "nothing was stored");
  // Once verified (an invited or demo customer), uploads work as before.
  await app.db.prepare(`UPDATE users SET email_verified_at = ? WHERE email = ?`).bind(new Date().toISOString(), "stranger@example.org").run();
  const ok = await c.post("/portal/files", { file: new File([PDF], "x.pdf") });
  assert.equal(ok.status, 303, "verified customer can upload");
});
