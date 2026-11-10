// First production Owner by email (Founder, 2026-11-09): /password/forgot on production said "Check your email" and nothing
// arrived, because production had no account at all. The signed one-time Owner invitation is delivered by the normal
// staff_invitation email; after it is accepted, the password reset sends its email. The public reset page still answers
// the same for unknown addresses (no account enumeration).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, lastEmail, TEST_PASSWORD } from "./support/app.ts";
import { signEvidence } from "../src/readiness/ingest.ts";
import { signedGetCanonical } from "../src/routes/ops.ts";

const SECRET = "owner-bootstrap-ingest-secret";
const FOUNDER = "founder@crestmont-owner-fixture.com";
// Production runs Turnstile and the breached-password check; both are answered locally (TEST DATA), as in
// tests/production-auth.test.ts: only the token "human-token" passes.
const local: typeof fetch = async (input, init) => {
  if (String(input).includes("turnstile/v0/siteverify")) return Response.json({ success: (init?.body as FormData).get("response") === "human-token" });
  return new Response("0000000000000000000000000000000000A:0\n", { status: 200 });
};
const HUMAN = { "cf-turnstile-response": "human-token" };
const PROD = { ENVIRONMENT: "production" as const, APP_URL: "http://crestmont.test", EVIDENCE_INGEST_SECRET: SECRET, TURNSTILE_SECRET: "test-turnstile-secret", overrides: { fetch: local } } as never as Record<string, unknown>;
type App = Awaited<ReturnType<typeof createTestApp>>;
const invite = async (t: App, email: string, secret = SECRET) => {
  const body = JSON.stringify({ email });
  return t.client().request("POST", "/api/ops/owner-invitation", { body, headers: { "content-type": "application/json", "x-crestmont-signature": await signEvidence(secret, body) } });
};
const n = async (t: App, sql: string) => (await t.db.prepare(sql).first<{ n: number }>())!.n;

test("[AUTH-001] [EMAIL-001] the first production Owner is invited by email (signed, one-time); after acceptance the password reset email is sent; unknown addresses still get the same page and no email", async () => {
  const t = await createTestApp(PROD as never);
  assert.equal(await n(t, `SELECT COUNT(*) AS n FROM users`), 0, "production starts with no account");
  // Before any account exists: the reset page says the same thing and nothing is sent (this is what the Founder saw).
  const before = await t.client().post("/password/forgot", { email: FOUNDER, ...HUMAN });
  assert.match(await before.text(), /If an account exists for that address, a reset link has been sent/);
  assert.equal(await n(t, `SELECT COUNT(*) AS n FROM email_deliveries`), 0);

  assert.equal((await invite(t, FOUNDER, "wrong-secret")).status, 401, "unsigned or wrongly signed requests are refused");
  const res = await invite(t, FOUNDER);
  assert.equal(res.status, 200);
  const out = await res.json() as { invitationId: string; expiresAt: string; delivery: { id: string; status: string } };
  assert.doesNotMatch(JSON.stringify(out), /token/i, "the response never carries the invitation token");
  assert.equal(out.delivery.status, "queued"); // the test adapter records; production's ResendEmail answers "sent" once Resend accepts
  const mail = (await lastEmail(t.db, FOUNDER))!;
  assert.equal(mail.template, "staff_invitation");
  assert.match(mail.subject, /invit/i);
  assert.match(mail.text_body, /Owner/);
  const token = /\/invite\?token=([A-Za-z0-9_-]+)/.exec(mail.text_body)![1];

  // Delivery status for the signed ops check: no address, subject or body.
  const url = new URL(`http://crestmont.test/api/ops/email-deliveries/${out.delivery.id}`);
  const st = await t.client().request("GET", url.pathname, { headers: { "x-crestmont-signature": await signEvidence(SECRET, signedGetCanonical(url)) } });
  assert.equal(st.status, 200);
  const sj = await st.text();
  assert.match(sj, /"template":"staff_invitation"/);
  assert.ok(!sj.includes(FOUNDER), "no address in the status");
  assert.equal((await t.client().request("GET", url.pathname)).status, 401);

  // The Founder accepts: the account is created with the Owner role.
  const c = t.client();
  assert.equal((await c.get(`/invite?token=${token}`)).status, 200);
  assert.equal((await c.post("/invite", { token, name: "The Founder", password: TEST_PASSWORD })).status, 303);
  assert.equal(await n(t, `SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id = 'owner' AND u.email = '${FOUNDER}'`), 1);
  // One-time: a second invitation is refused once an Owner exists.
  const again = await invite(t, FOUNDER);
  assert.equal(again.status, 409);
  assert.match(((await again.json()) as { error: string }).error, /An Owner already exists/);

  // Now the reset email is created for the real account, with a working link.
  await t.client().post("/password/forgot", { email: FOUNDER, ...HUMAN });
  const reset = (await lastEmail(t.db, FOUNDER))!;
  assert.equal(reset.template, "password_reset");
  assert.match(reset.text_body, /\/password\/reset\?token=/);
  // An unknown address: the same page, no email.
  const deliveries = await n(t, `SELECT COUNT(*) AS n FROM email_deliveries`);
  assert.match(await (await t.client().post("/password/forgot", { email: "nobody@crestmont-owner-fixture.com", ...HUMAN })).text(), /If an account exists for that address/);
  assert.equal(await n(t, `SELECT COUNT(*) AS n FROM email_deliveries`), deliveries, "no email for an address without an account");
});

test("[AUTH-001] the Owner invitation goes only to the Founder's address: FOUNDER_EMAIL must match when set; demo, reserved and customer addresses are refused", async () => {
  const t = await createTestApp({ ...PROD, FOUNDER_EMAIL: FOUNDER } as never);
  assert.equal((await invite(t, "someone-else@crestmont-owner-fixture.com")).status, 403);
  assert.equal((await invite(t, "owner@crestmont-preview.test")).status, 422);
  assert.equal((await invite(t, "x@example.com")).status, 422);
  assert.equal((await invite(t, "not an address")).status, 422);
  assert.equal(await n(t, `SELECT COUNT(*) AS n FROM invitations`), 0, "a refused request creates nothing");
  // Re-issuing replaces the pending invitation: only the newest link works.
  await invite(t, FOUNDER);
  const first = /\/invite\?token=([A-Za-z0-9_-]+)/.exec((await lastEmail(t.db, FOUNDER))!.text_body)![1];
  await invite(t, FOUNDER);
  const second = /\/invite\?token=([A-Za-z0-9_-]+)/.exec((await lastEmail(t.db, FOUNDER))!.text_body)![1];
  assert.notEqual(first, second);
  assert.equal((await t.client().post("/invite", { token: first, name: "Old link", password: TEST_PASSWORD })).status, 400, "the earlier link stops working");
  assert.equal((await t.client().post("/invite", { token: second, name: "The Founder", password: TEST_PASSWORD })).status, 303);
});

test("[AUTH-001] [SEC-007] run 42738785099 reproduced: a body signed exactly as the workflow signs it, with a key other than the Worker's production-only secret, is refused 'Signature mismatch' and creates nothing", async () => {
  // provision-production.yml generated production's EVIDENCE_INGEST_SECRET as a random production-only value (run
  // 40614532868); the GitHub environment secret is a different value, so the HMAC differs while format and time agree.
  const t = await createTestApp({ ...PROD, EVIDENCE_INGEST_SECRET: "production-only-random-value" } as never);
  const body = JSON.stringify({ email: FOUNDER });
  const r = await t.client().request("POST", "/api/ops/owner-invitation", { body, headers: { "content-type": "application/json", "x-crestmont-signature": await signEvidence("github-environment-value", body) } });
  assert.equal(r.status, 401);
  assert.match(((await r.json()) as { error: string }).error, /^Signature mismatch$/);
  assert.equal(await n(t, `SELECT COUNT(*) AS n FROM invitations`), 0);
});

test("[AUTH-001] [SEC-007] production path: the workflow's one-time database challenge (scripts/ops-challenge.ts output, applied as wrangler would) authorizes exactly one Owner invitation to the stored address", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const t = await createTestApp({ ...PROD, EVIDENCE_INGEST_SECRET: "production-only-random-value" } as never);
  const write = (purpose: string, extra: string[], env: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "ops-challenge-"));
    const r = spawnSync(process.execPath, ["--no-warnings", "scripts/ops-challenge.ts", "--purpose", purpose, ...extra, "--out-sql", join(dir, "c.sql"), "--out-nonce", join(dir, "nonce")], { env: { ...process.env, ...env }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /[a-f0-9]{64}/, "the nonce is never printed");
    const sql = readFileSync(join(dir, "c.sql"), "utf8");
    assert.doesNotMatch(sql, new RegExp(readFileSync(join(dir, "nonce"), "utf8")), "only the hash is stored");
    return { sql, nonce: readFileSync(join(dir, "nonce"), "utf8") };
  };
  const post = (path: string, body: unknown) => t.client().request("POST", path, { body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  const c = write("owner_invitation", ["--payload-email-env", "FOUNDER_EMAIL"], { FOUNDER_EMAIL: FOUNDER });
  await t.db.prepare(c.sql).run(); // what `wrangler d1 execute --file` applies
  assert.equal((await post("/api/ops/owner-invitation", { challenge: "0".repeat(64) })).status, 401, "a guessed nonce is refused");
  assert.equal((await post("/api/ops/email-certification", { challenge: c.nonce })).status, 401, "a challenge is bound to its purpose");
  const ok = await post("/api/ops/owner-invitation", { challenge: c.nonce, email: "attacker@crestmont-owner-fixture.com" });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal((await lastEmail(t.db, FOUNDER))!.template, "staff_invitation", "sent to the address stored with the challenge, not one in the body");
  assert.equal(await lastEmail(t.db, "attacker@crestmont-owner-fixture.com"), null);
  assert.equal((await post("/api/ops/owner-invitation", { challenge: c.nonce })).status, 401, "single use");
  assert.equal(await n(t, `SELECT COUNT(*) AS n FROM business_settings WHERE key LIKE 'ops.challenge.%'`), 0, "consumed");

  // An expired challenge is refused and removed.
  const e = write("email_certification", ["--run-id", "cert-expired"]);
  await t.db.prepare(e.sql.replace(/"expiresAt":"[^"]+"/, `"expiresAt":"${new Date(Date.now() - 1000).toISOString()}"`)).run();
  assert.equal((await post("/api/ops/email-certification", { challenge: e.nonce })).status, 401);
  assert.equal(await n(t, `SELECT COUNT(*) AS n FROM business_settings WHERE key LIKE 'ops.challenge.%'`), 0);
  // A valid certification challenge passes authentication (this test app has no Resend adapter, hence 409).
  const cert = write("email_certification", ["--run-id", "cert-ok-1"]);
  await t.db.prepare(cert.sql).run();
  assert.equal((await post("/api/ops/email-certification", { challenge: cert.nonce })).status, 409);
});
