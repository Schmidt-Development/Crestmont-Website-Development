// Phase 14.3: the Resend investigation's three findings, fixed and pinned. TEST DATA; Resend is a fake fetch.
//  1. A send-only Resend key (least privilege) is refused on GET /domains with 401 restricted_api_key although it sends
//     normally: the health check must judge it by real provider acceptance and delivery, not report a failure.
//  2. Staging's recipient allowlist must let the internal operations mailbox through, or every internal notification
//     is held and never sent.
//  3. The Email page must tell held, waiting, accepted, delivered, bounced, failed and suppressed apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import { verifyIntegration } from "../src/services/integrations.ts";
import { recipientPolicy, ResendEmail } from "../src/adapters/email.ts";
import type { Env } from "../src/app/context.ts";

const restricted = (async () => new Response(JSON.stringify({ statusCode: 401, message: "This API key is restricted to only send emails", name: "restricted_api_key" }), { status: 401 })) as unknown as typeof fetch;
const invalid = (async () => new Response(JSON.stringify({ statusCode: 401, message: "API key is invalid", name: "validation_error" }), { status: 401 })) as unknown as typeof fetch;

async function delivery(db: Env["DB"], status: string, provider = "resend", lastError: string | null = null) {
  const id = newId("em"), at = nowIso();
  await db.prepare(`INSERT INTO email_deliveries (id, template, to_email, idempotency_key, status, attempts, last_error, created_at, updated_at) VALUES (?, 'internal_alert', 'crestmontwebsitedevelopment@gmail.com', ?, ?, 1, ?, ?, ?)`).bind(id, id, status, lastError, at, at).run();
  await db.prepare(`INSERT INTO email_messages (delivery_id, provider, subject, html_body, text_body) VALUES (?,?, 's', 'h', 't')`).bind(id, provider).run();
}

test("[EMAIL-001] a send-only Resend key is not reported as failing: it is judged by what Resend actually accepted and delivered", async () => {
  const t = await createTestApp({ ENVIRONMENT: "staging", RESEND_API_KEY: "re_test_send_only" });
  const d = (f: typeof fetch) => ({ db: t.db, env: t.env, storage: null, fetchImpl: f });

  let r = await verifyIntegration(d(restricted), "resend", null);
  assert.equal(r.status, "configured_unverified", "nothing sent yet: unproven, not failing");
  assert.match(r.detail, /Send-only API key .*expected.*No email has been accepted/);

  await delivery(t.db, "sent");
  r = await verifyIntegration(d(restricted), "resend", null);
  assert.equal(r.status, "configured_unverified", "accepted is not delivered");
  assert.match(r.detail, /accepted 1 email.*no delivery has been confirmed/);

  await delivery(t.db, "delivered");
  r = await verifyIntegration(d(restricted), "resend", null);
  assert.equal(r.status, "verified", "verified only with a provider-confirmed delivery");
  assert.match(r.detail, /confirmed delivery of 1/);

  // Held (staging policy) and development outbox messages are never evidence.
  const t2 = await createTestApp({ ENVIRONMENT: "staging", RESEND_API_KEY: "re_test_send_only" });
  await delivery(t2.db, "delivered", "dev-outbox");
  assert.equal((await verifyIntegration({ db: t2.db, env: t2.env, storage: null, fetchImpl: restricted }, "resend", null)).status, "configured_unverified");

  // A genuinely bad key is failing, with what to do.
  r = await verifyIntegration(d(invalid), "resend", null);
  assert.equal(r.status, "failing");
  assert.match(r.detail, /Resend refused the API key \(HTTP 401: API key is invalid\).*update RESEND_API_KEY/);
});

test("[EMAIL-001] staging may mail the internal operations mailbox; every other non-allowlisted address is still held", async () => {
  const staging = recipientPolicy({ ENVIRONMENT: "staging" });
  assert.equal(staging("crestmontwebsitedevelopment@gmail.com"), null);
  assert.equal(staging("CrestmontWebsiteDevelopment@Gmail.com "), null);
  assert.match(staging("customer@gmail.com") ?? "", /EMAIL_RECIPIENT_ALLOWLIST/, "real customers are still never mailed from staging");
  assert.equal(recipientPolicy({ ENVIRONMENT: "staging", INTERNAL_NOTIFY_EMAIL: "ops-test@crestmontwebsitedevelopment.com", EMAIL_RECIPIENT_ALLOWLIST: "only@x.io" })("ops-test@crestmontwebsitedevelopment.com"), null);

  // Through the real adapter: the internal alert goes to Resend; a customer address is held.
  const t = await createTestApp({});
  const posted: string[] = [];
  const f = (async (_u: string, init?: RequestInit) => { posted.push(JSON.parse(String(init?.body)).to[0]); return new Response(JSON.stringify({ id: "re_msg_1" }), { status: 200 }); }) as unknown as typeof fetch;
  const mail = new ResendEmail(t.db, "re_test_key", "Crestmont <support@crestmontwebsitedevelopment.com>", f, staging, "staging");
  const msg = (to: string, k: string) => ({ to, subject: "s", html: "h", text: "t", template: "internal_alert", idempotencyKey: k });
  assert.equal((await mail.send(msg("crestmontwebsitedevelopment@gmail.com", "k1"))).status, "sent");
  assert.equal((await mail.send(msg("customer@gmail.com", "k2"))).provider, "dev-outbox");
  assert.deepEqual(posted, ["crestmontwebsitedevelopment@gmail.com"]);
});

test("[EMAIL-001] the Email page separates held, waiting, accepted, delivered, bounced, failed and suppressed — queued is never shown as delivered", async () => {
  const t = await createTestApp({});
  const owner = await createStaff(t.db, "owner");
  await delivery(t.db, "queued", "dev-outbox", "Not sent: staging only mails addresses on EMAIL_RECIPIENT_ALLOWLIST (staging holds test data).");
  await delivery(t.db, "queued", "dev-outbox", "Not sent: staging only mails addresses on EMAIL_RECIPIENT_ALLOWLIST (staging holds test data).");
  await delivery(t.db, "queued");
  await delivery(t.db, "sent");
  await delivery(t.db, "delivered");
  await delivery(t.db, "bounced");
  await delivery(t.db, "failed");
  await delivery(t.db, "suppressed");
  const c = t.client(); await c.login(owner.email, TEST_PASSWORD, owner.secret);
  const page = await (await c.get("/staff/email")).text();
  const v = (name: string) => Number(new RegExp(`<div class="kpi__label">${name}</div><div class="kpi__value">(\\d+)</div>`).exec(page)?.[1] ?? NaN);
  assert.deepEqual([v("Held \\(not sent\\)"), v("Waiting to send"), v("Accepted by Resend"), v("Delivered"), v("Bounced"), v("Failed"), v("Suppressed")], [2, 1, 1, 1, 1, 1, 1]);
  assert.match(page, />Held: not sent</);
  assert.match(page, />Accepted by Resend</);
});
