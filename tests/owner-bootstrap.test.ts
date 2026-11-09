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
