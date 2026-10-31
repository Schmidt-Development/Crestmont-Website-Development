// Deploy #61 recovery (staging certification): the faults the staging journeys exposed once failing journeys started
// failing the deploy (CREST-GAP-030).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import { isJourneyAddress } from "../src/routes/platform.ts";

const KEY = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

async function storedEmail(db: Parameters<typeof createStaff>[0], to: string, text: string) {
  const id = newId("eml");
  await db.prepare(`INSERT INTO email_deliveries (id, template, to_email, idempotency_key, status, attempts, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)`)
    .bind(id, "quote_sent", to, `k-${id}`, "queued", nowIso(), nowIso()).run();
  await db.prepare(`INSERT INTO email_messages (delivery_id, provider, subject, html_body, text_body) VALUES (?,?,?,?,?)`)
    .bind(id, "dev-outbox", "Your Crestmont proposal", `<a href="https://x.test/q/${"a1".repeat(32)}">Review</a>`, text).run();
  return id;
}

test("[SEC-003] staff never see live proposal/verification tokens in stored mail, except, on staging only, mail to the staging journeys' synthetic domain (deploy #61 journey 4)", async () => {
  const token = "b2".repeat(32);
  const body = `Review proposal: https://staging.example/q/${token}\nConfirm: https://staging.example/verify-email?token=${token}`;
  for (const env of ["staging", "production", "development"] as const) {
    const app = await createTestApp({ ENVIRONMENT: env, MFA_ENCRYPTION_KEY: KEY(), PASSWORD_BREACH_CHECK: "off" });
    const owner = await createStaff(app.db, "owner");
    const o: TestClient = await app.client().login(owner.email, TEST_PASSWORD, owner.secret);
    const real = await storedEmail(app.db, "pat@acme-plumbing.com", body);
    const synthetic = await storedEmail(app.db, "morgan.e2e-1@staging-journeys.example", body);
    const realPage = await (await o.get(`/staff/email/${real}`)).text();
    assert.doesNotMatch(realPage, new RegExp(token), `${env}: a real customer's tokens are redacted`);
    assert.match(realPage, /\/q\/\[redacted\]/);
    const synthPage = await (await o.get(`/staff/email/${synthetic}`)).text();
    if (env !== "staging") assert.doesNotMatch(synthPage, new RegExp(token), `${env} always redacts`);
    else assert.match(synthPage, new RegExp(`/q/${token}`), "staging shows the link to a reserved test address so the journeys can follow it");
    const html = await (await o.get(`/staff/email/${real}/html`)).text();
    assert.doesNotMatch(html, /a1a1a1a1a1a1a1a1/, `${env}: the HTML download of a real customer's mail is redacted too`);
  }
  assert.ok(isJourneyAddress("Morgan.E2E-1@Staging-Journeys.Example"));
  for (const a of ["owner@crestmont-preview.test", "c@example.com", "x@staging-journeys.example.com", "x@evilstaging-journeys.example.net", "pat@acme-plumbing.com"]) assert.ok(!isJourneyAddress(a), a);
});

async function postFrom(c: TestClient, ip: string, fields: Record<string, string>) {
  if (!c.cookies.has("cm_csrf")) await c.get("/login");
  const body = new URLSearchParams({ _csrf: c.cookies.get("cm_csrf")!, ...fields }).toString();
  return c.request("POST", "/login", { body, headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://crestmont.test", "cf-connecting-ip": ip } });
}

test("[AUTH-005] the per-IP sign-in limit counts failures only: many correct sign-ins from one address (an office, the deploy runner) are never refused, guessing still is (CREST-GAP-003)", async () => {
  const { db, client } = await createTestApp({ ENVIRONMENT: "staging", MFA_ENCRYPTION_KEY: KEY(), PASSWORD_BREACH_CHECK: "off" });
  const cust = await createCustomer(db, "pat@acme-plumbing.com");
  for (let i = 0; i < 40; i++) {
    const r = await postFrom(client(), "198.51.100.7", { email: cust.email, password: TEST_PASSWORD });
    assert.equal(r.status, 303, `correct sign-in #${i + 1} from one IP succeeds`);
  }
  const seen: number[] = [];
  for (let i = 0; i < 31; i++) seen.push((await postFrom(client(), "198.51.100.9", { email: `nobody${i}@acme-plumbing.com`, password: "wrong-guess-pass-1" })).status);
  const last = await postFrom(client(), "198.51.100.9", { email: cust.email, password: TEST_PASSWORD });
  assert.match(await last.text(), /Too many sign-in attempts/, "30 failures from one IP across many addresses still stop that IP");
  assert.notEqual(last.status, 303);
  assert.ok(seen.slice(0, 30).every((s) => s !== 303));
});
