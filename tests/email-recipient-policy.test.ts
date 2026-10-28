// Staging/production email isolation (EMAIL-001, INFRA-002): staging holds test data, so with a real Resend key
// it mails only allow-listed recipients; no environment ever mails reserved test addresses (which only bounce
// and damage the verified sending domain's reputation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./support/sqlite-d1.ts";
import { ResendEmail, recipientPolicy, DEFAULT_STAGING_ALLOWLIST } from "../src/adapters/email.ts";

const msg = (to: string, key = `k-${to}`) => ({ to, subject: "Subject", html: "<p>x</p>", text: "x", template: "verification", idempotencyKey: key });

test("[EMAIL-001] [INFRA-002] recipient policy: staging mails only the allowlist; nobody mails reserved test addresses", () => {
  const staging = recipientPolicy({ ENVIRONMENT: "staging" });
  assert.equal(DEFAULT_STAGING_ALLOWLIST, "@crestmontwebsitedevelopment.com");
  assert.equal(staging("founder@crestmontwebsitedevelopment.com"), null);
  assert.equal(staging("Founder@CrestmontWebsiteDevelopment.com "), null, "case and whitespace insensitive");
  assert.match(staging("customer@gmail.com") ?? "", /EMAIL_RECIPIENT_ALLOWLIST/);
  assert.match(staging("owner@crestmont-preview.test") ?? "", /reserved/, "seeded demo accounts are never mailed");
  assert.match(staging("x@crestmontwebsitedevelopment.com.evil.example") ?? "", /reserved|ALLOWLIST/, "suffix tricks do not pass");
  assert.match(staging("x@notcrestmontwebsitedevelopment.co") ?? "", /ALLOWLIST/);

  const custom = recipientPolicy({ ENVIRONMENT: "staging", EMAIL_RECIPIENT_ALLOWLIST: "tester@gmail.com, @qa.crestmontwebsitedevelopment.com" });
  assert.equal(custom("tester@gmail.com"), null);
  assert.equal(custom("a@qa.crestmontwebsitedevelopment.com"), null);
  assert.match(custom("other@gmail.com") ?? "", /ALLOWLIST/);
  assert.match(custom("founder@crestmontwebsitedevelopment.com") ?? "", /ALLOWLIST/, "an explicit list replaces the default");

  const prod = recipientPolicy({ ENVIRONMENT: "production", EMAIL_RECIPIENT_ALLOWLIST: "only@x.com" });
  assert.equal(prod("customer@gmail.com"), null, "production mails real customers (the allowlist is staging-only)");
  for (const r of ["a@b.test", "a@b.invalid", "a@example.com", "a@mail.example.org", "a@b.localhost", "a@b.example"]) assert.match(prod(r) ?? "", /reserved/, r);
});

test("[EMAIL-001] [INFRA-002] staging Resend adapter: blocked recipients are recorded in the outbox and never reach the Resend API, sends and retries alike", async () => {
  const db = createTestDb();
  const calls: string[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)).to[0]);
    return new Response(JSON.stringify({ id: `re_${calls.length}` }), { status: 200 });
  }) as unknown as typeof fetch;
  const mail = new ResendEmail(db, "re_test_key", "Crestmont <support@crestmontwebsitedevelopment.com>", fakeFetch, recipientPolicy({ ENVIRONMENT: "staging" }));

  const blocked = await mail.send(msg("someone@gmail.com"));
  assert.deepEqual({ status: blocked.status, provider: blocked.provider }, { status: "queued", provider: "dev-outbox" });
  const row = await db.prepare(`SELECT d.status, d.last_error, m.provider FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.id = ?`).bind(blocked.deliveryId)
    .first<{ status: string; last_error: string; provider: string }>();
  assert.equal(row?.provider, "dev-outbox");
  assert.equal(row?.status, "queued");
  assert.match(row?.last_error ?? "", /EMAIL_RECIPIENT_ALLOWLIST/);
  assert.equal((await mail.send(msg("demo-owner@crestmont-preview.test"))).provider, "dev-outbox");
  assert.deepEqual(calls, [], "the Resend API was never called for blocked recipients");

  const ok = await mail.send(msg("founder@crestmontwebsitedevelopment.com"));
  assert.deepEqual({ status: ok.status, provider: ok.provider }, { status: "sent", provider: "resend" });
  assert.deepEqual(calls, ["founder@crestmontwebsitedevelopment.com"]);
  const sent = await db.prepare(`SELECT provider_message_id FROM email_deliveries WHERE id = ?`).bind(ok.deliveryId).first<{ provider_message_id: string }>();
  assert.equal(sent?.provider_message_id, "re_1", "the Resend id is stored, so delivery webhooks can match the row");

  // A staff retry of a blocked recipient is refused too.
  const retry = await mail.attempt(blocked.deliveryId, msg("someone@gmail.com"));
  assert.equal(retry.status, "failed");
  assert.equal(calls.length, 1);

  // Duplicate idempotency keys stay duplicates in the outbox path.
  assert.equal((await mail.send(msg("someone@gmail.com"))).status, "duplicate");
});

test("[EMAIL-003] [INFRA-002] Resend webhooks are per account: each environment's receiver ignores the other's events and stores no foreign recipient", async () => {
  const { createTestApp } = await import("./support/app.ts");
  const { signSvix } = await import("../src/services/email-events.ts");
  const WHSEC = `whsec_${btoa("staging-and-production-are-separate!")}`;
  const event = (tags: unknown, to = "customer@gmail.com", id = "re_x") => JSON.stringify({ type: "email.bounced", created_at: new Date().toISOString(),
    data: { email_id: id, to: [to], bounce: { type: "Permanent", subType: "General", message: "no such user" }, ...(tags === undefined ? {} : { tags }) } });
  const post = async (env: Awaited<ReturnType<typeof createTestApp>>, svixId: string, raw: string) => {
    const res = await env.client().request("POST", "/api/webhooks/resend", { body: raw, headers: { "content-type": "application/json", ...(await signSvix(WHSEC, svixId, raw)) } });
    return { status: res.status, json: (await res.json()) as { outcome: string; duplicate: boolean } };
  };
  const count = async (db: { prepare: (q: string) => { first: <T>() => Promise<T | null> } }, q: string) => ((await db.prepare(q).first<{ n: number }>())?.n ?? 0);

  const staging = await createTestApp({ ENVIRONMENT: "staging", PREVIEW_GATE: "required", RESEND_WEBHOOK_SECRET: WHSEC });
  for (const [i, tags] of [[1, { environment: "production" }], [2, undefined], [3, [{ name: "environment", value: "production" }]]] as const) {
    const r = await post(staging, `msg_s${i}`, event(tags));
    assert.equal(r.status, 200, "acknowledged so Resend does not retry");
    assert.equal(r.json.outcome, "ignored");
  }
  assert.equal(await count(staging.db, `SELECT COUNT(*) n FROM email_suppressions`), 0, "no production customer suppressed in staging");
  assert.equal(await count(staging.db, `SELECT COUNT(*) n FROM email_webhook_events WHERE recipient IS NOT NULL OR provider_message_id IS NOT NULL`), 0, "no foreign recipient or message id stored");
  assert.equal((await post(staging, "msg_s1", event({ environment: "production" }))).json.duplicate, true, "replays stay idempotent");
  assert.equal((await post(staging, "msg_s4", event({ environment: "staging" }, "tester@crestmontwebsitedevelopment.com"))).json.outcome, "applied");
  assert.equal(await count(staging.db, `SELECT COUNT(*) n FROM email_suppressions`), 1, "staging's own bounce is applied");

  const production = await createTestApp({ ENVIRONMENT: "production", RESEND_WEBHOOK_SECRET: WHSEC });
  assert.equal((await post(production, "msg_p1", event({ environment: "staging" }, "tester@crestmontwebsitedevelopment.com"))).json.outcome, "ignored");
  assert.equal(await count(production.db, `SELECT COUNT(*) n FROM email_suppressions`), 0);
  assert.equal((await post(production, "msg_p2", event({ environment: "production" }))).json.outcome, "applied");
  assert.equal((await post(production, "msg_p3", event(undefined, "dashboard-send@gmail.com"))).json.outcome, "applied", "untagged (e.g. dashboard) mail still protects production");
  assert.equal(await count(production.db, `SELECT COUNT(*) n FROM email_suppressions`), 2);
});

test("[EMAIL-003] sends are tagged with their environment so webhooks can be routed", async () => {
  const db = createTestDb();
  const bodies: Record<string, unknown>[] = [];
  const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: "re_t" }), { status: 200 }); }) as unknown as typeof fetch;
  await new ResendEmail(db, "re_test_key", "Crestmont <support@crestmontwebsitedevelopment.com>", f, recipientPolicy({ ENVIRONMENT: "production" }), "production").send(msg("customer@gmail.com"));
  assert.deepEqual(bodies[0].tags, [{ name: "environment", value: "production" }]);
});
