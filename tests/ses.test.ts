// Amazon SES as the second email provider (src/adapters/ses.ts, src/adapters/email.ts) and its SNS event webhook
// (POST /api/webhooks/ses, src/routes/hooks.ts → src/services/email-events.ts handleSesEvent).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { createTestDb } from "./support/sqlite-d1.ts";
import { createTestApp } from "./support/app.ts";
import { createEmailAdapter, OutboxEmail, ResendEmail, SesEmail, SesMisconfiguredEmail } from "../src/adapters/email.ts";
import { emailProvider, sesConfig, sesError, signSigV4, PermanentSendError, snsCanonicalString, spkiFromCertificate, pemToDer, type SesConfig } from "../src/adapters/ses.ts";
import { retryQueuedEmails } from "../src/services/email-retry.ts";
import { sendMail } from "../src/services/mailer.ts";
import { emailProviderPresence, secretPresence } from "../src/services/integrations.ts";
import type { Env } from "../src/app/context.ts";

const CFG: SesConfig = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real", region: "us-east-2", configurationSet: "crestmontwebsitedevelopment" };
const SES_VARS = { SES_ACCESS_KEY_ID: CFG.accessKeyId, SES_SECRET_ACCESS_KEY: CFG.secretAccessKey, SES_REGION: CFG.region, SES_CONFIGURATION_SET: CFG.configurationSet };
const TOPIC = "arn:aws:sns:us-east-2:675006621465:enterprise-ses-events";
const msg = (to: string, template = "verification", key = `k-${to}-${Math.random()}`) => ({ to, subject: "Subject", html: "<p>x</p>", text: "x", template, idempotencyKey: key });

type Call = { url: string; init: RequestInit };
function sesFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init: RequestInit = {}) => { const c = { url: String(url), init }; calls.push(c); return respond(c); }) as typeof fetch;
  return { f, calls };
}
const okSes = (id = "0100018f-ses-message-id") => new Response(JSON.stringify({ MessageId: id }), { status: 200, headers: { "content-type": "application/json" } });
const sesFail = (status: number, type: string, message: string) => new Response(JSON.stringify({ message }), { status, headers: { "content-type": "application/json", "x-amzn-errortype": `${type}:http://internal.amazon.com/coral/com.amazon.ses/` } });

// ───────────── provider selection ─────────────

test("[EMAIL-001] provider selection: Resend by default; SES only when EMAIL_PROVIDER=ses and every SES variable is set", async () => {
  const db = createTestDb();
  const base = { DB: db, ENVIRONMENT: "production", RESEND_API_KEY: "re_test_not_real" };
  for (const v of [undefined, "", "  ", "resend", "RESEND", "mailgun", "sesx"]) {
    assert.equal(emailProvider({ EMAIL_PROVIDER: v }), "resend", `EMAIL_PROVIDER=${JSON.stringify(v)}`);
    const a = createEmailAdapter({ ...base, ...SES_VARS, EMAIL_PROVIDER: v });
    assert.ok(a instanceof ResendEmail && !(a instanceof SesEmail), "never falls over to SES implicitly");
    assert.equal(a.kind, "resend");
  }
  assert.equal(emailProvider({ EMAIL_PROVIDER: " SES " }), "ses");
  const ses = createEmailAdapter({ ...base, ...SES_VARS, EMAIL_PROVIDER: "ses" });
  assert.ok(ses instanceof SesEmail);
  assert.equal(ses.kind, "ses");
  assert.ok(createEmailAdapter({ ...base, ...SES_VARS, EMAIL_PROVIDER: "ses", ENVIRONMENT: "development" }) instanceof OutboxEmail, "development always uses the outbox");
  assert.ok(createEmailAdapter({ DB: db, ENVIRONMENT: "production" }) instanceof OutboxEmail, "unchanged: no Resend key = outbox");
  assert.deepEqual(sesConfig({ ...SES_VARS, SES_REGION: "" }), { ok: false, missing: ["SES_REGION"] });
});

test("[EMAIL-001] EMAIL_PROVIDER=ses with SES variables missing is a configuration error: nothing is sent (not via Resend either)", async () => {
  const db = createTestDb();
  const a = createEmailAdapter({ DB: db, ENVIRONMENT: "production", RESEND_API_KEY: "re_test_not_real", EMAIL_PROVIDER: "ses", SES_REGION: "us-east-2" });
  assert.ok(a instanceof SesMisconfiguredEmail);
  assert.deepEqual((a as SesMisconfiguredEmail).missing, ["SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_CONFIGURATION_SET"]);
  const realFetch = globalThis.fetch, realError = console.error;
  let fetched = 0; const logged: string[] = [];
  globalThis.fetch = (async () => { fetched++; return new Response("{}"); }) as typeof fetch;
  console.error = (m: string) => { logged.push(String(m)); };
  try {
    const r = await a.send(msg("customer@gmail.com"));
    assert.equal(r.status, "queued");
    assert.equal(r.provider, "dev-outbox");
    const row = await db.prepare(`SELECT d.status, d.last_error, m.provider FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.id = ?`).bind(r.deliveryId).first<{ status: string; last_error: string; provider: string }>();
    assert.equal(row!.provider, "dev-outbox");
    assert.match(row!.last_error, /^Not sent: EMAIL_PROVIDER is "ses" but SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, SES_CONFIGURATION_SET are not set/);
    assert.equal(fetched, 0, "no provider was called");
    assert.match(logged.join("\n"), /configuration error/);
  } finally { globalThis.fetch = realFetch; console.error = realError; }
});

test("[EMAIL-001] health: SES secrets and settings are reported as set/MISSING, never by value", () => {
  const env = { DB: createTestDb(), ENVIRONMENT: "production", SES_ACCESS_KEY_ID: "AKIASECRETVALUE", SES_REGION: "us-east-2" } as unknown as Env;
  const p = secretPresence(env);
  assert.equal(p.find((x) => x.name === "SES_ACCESS_KEY_ID")!.present, true);
  assert.equal(p.find((x) => x.name === "SES_SECRET_ACCESS_KEY")!.present, false);
  const ep = emailProviderPresence(env);
  assert.equal(ep.provider, "resend");
  assert.deepEqual(ep.vars.map((v) => [v.name, v.present]), [["SES_ACCESS_KEY_ID", true], ["SES_SECRET_ACCESS_KEY", false], ["SES_REGION", true], ["SES_CONFIGURATION_SET", false], ["SES_FROM", false], ["SES_SNS_TOPIC_ARN", false]]);
  assert.doesNotMatch(JSON.stringify([p, ep]), /AKIASECRETVALUE/);
});

// ───────────── sending ─────────────

test("[EMAIL-001] SigV4 signer matches the reference implementation (aws4fetch 1.0.20 vector)", async () => {
  const h = await signSigV4({
    method: "POST", url: "https://email.us-east-2.amazonaws.com/v2/email/outbound-emails?b=2&a=x y", headers: {},
    body: JSON.stringify({ FromEmailAddress: "a@b.c", x: "é !'()*" }), accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-2", service: "ses", now: new Date("2026-11-13T12:34:56Z"),
  });
  assert.equal(h.authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261113/us-east-2/ses/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=90e7a47f396611e8dc1d4f7bcb7909fcc7fccd35d5ca2e4e9aa8ecec82afa923");
});

test("[EMAIL-001] SES request shape: v2 outbound-emails, SigV4-signed, Simple content, configuration set, business/category tags", async () => {
  const db = createTestDb();
  const { f, calls } = sesFetch(() => okSes("ses-msg-1"));
  const ses = new SesEmail(db, CFG, "Crestmont Website Development <support@crestmontwebsitedevelopment.com>", f, () => null, "production");
  const r = await ses.send({ ...msg("customer@gmail.com", "invoice"), subject: "Your invoice", html: "<p>Hi</p>", text: "Hi" });
  assert.deepEqual([r.status, r.provider], ["sent", "ses"]);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, "https://email.us-east-2.amazonaws.com/v2/email/outbound-emails");
  assert.equal(c.init.method, "POST");
  const h = c.init.headers as Record<string, string>;
  assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.match(h["x-amz-date"], /^\d{8}T\d{6}Z$/);
  assert.equal(h["x-amz-content-sha256"], createHash("sha256").update(String(c.init.body)).digest("hex"));
  assert.equal(h["content-type"], "application/json");
  assert.doesNotMatch(JSON.stringify(h), /test-secret-not-real/, "the secret key is never sent");
  const body = JSON.parse(String(c.init.body));
  assert.deepEqual(body, {
    FromEmailAddress: "Crestmont Website Development <support@crestmontwebsitedevelopment.com>",
    Destination: { ToAddresses: ["customer@gmail.com"] },
    ReplyToAddresses: ["billing@crestmontwebsitedevelopment.com"],
    Content: { Simple: { Subject: { Data: "Your invoice", Charset: "UTF-8" }, Body: { Html: { Data: "<p>Hi</p>", Charset: "UTF-8" }, Text: { Data: "Hi", Charset: "UTF-8" } } } },
    ConfigurationSetName: "crestmontwebsitedevelopment",
    EmailTags: [{ Name: "business", Value: "crestmont" }, { Name: "category", Value: "invoice" }, { Name: "environment", Value: "production" }],
  });
  const row = await db.prepare(`SELECT d.status, d.provider_message_id, d.attempts, m.provider FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.id = ?`).bind(r.deliveryId).first<{ status: string; provider_message_id: string; attempts: number; provider: string }>();
  assert.deepEqual({ ...row }, { status: "sent", provider_message_id: "ses-msg-1", attempts: 1, provider: "ses" }, "the SES MessageId is stored where Resend's id is");
  // SES_FROM overrides EMAIL_FROM; tag values are restricted to [A-Za-z0-9_-].
  const a = createEmailAdapter({ DB: db, ENVIRONMENT: "production", EMAIL_FROM: "A <a@crestmontwebsitedevelopment.com>", SES_FROM: "B <b@crestmontwebsitedevelopment.com>", EMAIL_PROVIDER: "ses", ...SES_VARS }) as SesEmail;
  assert.equal((a as unknown as { from: string }).from, "B <b@crestmontwebsitedevelopment.com>");
  const { f: f2, calls: c2 } = sesFetch(() => okSes());
  await new SesEmail(db, CFG, "x@crestmontwebsitedevelopment.com", f2).send(msg("c2@gmail.com", "odd.template name!"));
  assert.deepEqual(JSON.parse(String(c2[0].init.body)).EmailTags, [{ Name: "business", Value: "crestmont" }, { Name: "category", Value: "odd_template_name_" }]);
});

test("[EMAIL-001] SES error mapping: 4xx rejections fail permanently; 429, 5xx and network errors stay queued for retry", async () => {
  assert.ok(sesError(400, "MessageRejected", "x") instanceof PermanentSendError);
  assert.ok(sesError(400, "MailFromDomainNotVerifiedException", "x") instanceof PermanentSendError);
  assert.ok(sesError(400, "AccountSuspendedException", "x") instanceof PermanentSendError);
  assert.ok(!(sesError(429, "TooManyRequestsException", "x") instanceof PermanentSendError));
  assert.ok(!(sesError(400, "LimitExceededException", "x") instanceof PermanentSendError));
  assert.ok(!(sesError(503, "", "x") instanceof PermanentSendError));
  const cases: [string, () => Response | never, string, RegExp][] = [
    ["rejected", () => sesFail(400, "MessageRejected", "Email address is not verified. The following identities failed the check in region US-EAST-2: customer@gmail.com"), "failed", /SES 400 MessageRejected: Email address is not verified/],
    ["domain", () => sesFail(400, "MailFromDomainNotVerifiedException", "MAIL FROM domain not verified"), "failed", /MailFromDomainNotVerified/],
    ["suspended", () => sesFail(400, "AccountSuspendedException", "Account suspended"), "failed", /AccountSuspended/],
    ["throttled", () => sesFail(429, "TooManyRequestsException", "Rate exceeded"), "queued", /SES 429/],
    ["server", () => sesFail(500, "InternalFailure", "oops"), "queued", /SES 500/],
    ["network", () => { throw new TypeError("fetch failed"); }, "queued", /fetch failed/],
  ];
  const db = createTestDb();
  for (const [name, respond, status, err] of cases) {
    const { f } = sesFetch(respond);
    const r = await new SesEmail(db, CFG, "x@crestmontwebsitedevelopment.com", f).send(msg(`${name}@gmail.com`));
    assert.equal(r.status, "failed", name);
    const row = await db.prepare(`SELECT status, attempts, last_error FROM email_deliveries WHERE id = ?`).bind(r.deliveryId).first<{ status: string; attempts: number; last_error: string }>();
    assert.equal(row!.status, status, name);
    assert.equal(row!.attempts, 1, name);
    assert.match(row!.last_error, err, name);
  }
});

test("[EMAIL-001] [EMAIL-003] SES keeps the platform's guards: staging allowlist, suppressions, idempotency, and the retry job", async () => {
  const db = createTestDb();
  const { f, calls } = sesFetch(() => okSes());
  const staging = createEmailAdapter({ DB: db, ENVIRONMENT: "staging", EMAIL_PROVIDER: "ses", ...SES_VARS }) as SesEmail;
  (staging as unknown as { fetchImpl: typeof fetch }).fetchImpl = f;
  const held = await staging.send(msg("customer@gmail.com"));
  assert.equal(held.provider, "dev-outbox", "EMAIL_RECIPIENT_ALLOWLIST still applies on staging");
  assert.equal((await staging.send(msg("tester@crestmontwebsitedevelopment.com"))).status, "sent");
  assert.equal(calls.length, 1);
  const m = msg("dup@gmail.com", "verification", "same-key");
  const ses = new SesEmail(db, CFG, "x@crestmontwebsitedevelopment.com", f);
  assert.equal((await ses.send(m)).status, "sent");
  assert.equal((await ses.send(m)).status, "duplicate", "the delivery row's idempotency key prevents a second SES send");
  await db.prepare(`INSERT INTO email_suppressions (id, email, reason, detail, source_event_id, created_at) VALUES ('sup_x','blocked@gmail.com','hard_bounce',NULL,NULL,?)`).bind(new Date().toISOString()).run();
  assert.equal((await ses.send(msg("blocked@gmail.com"))).status, "suppressed");
  assert.equal(calls.length, 2);

  // Retry: a transient SES failure stays queued and is retried by the scheduled job through SES (never through Resend).
  let fail = true;
  const { f: flaky, calls: fc } = sesFetch(() => (fail ? sesFail(503, "ServiceUnavailable", "busy") : okSes("retried-id")));
  const s2 = new SesEmail(db, CFG, "x@crestmontwebsitedevelopment.com", flaky);
  const r = await s2.send(msg("retry@gmail.com"));
  await db.prepare(`UPDATE email_deliveries SET updated_at = ? WHERE id = ?`).bind(new Date(Date.now() - 6 * 60_000).toISOString(), r.deliveryId).run();
  fail = false;
  const out = await retryQueuedEmails({ db, email: s2, now: () => new Date() });
  assert.equal(out.sent, 1);
  assert.match(out.detail, /SES deliveries retried/);
  assert.equal(fc.length, 2);
  assert.equal((await db.prepare(`SELECT provider_message_id FROM email_deliveries WHERE id = ?`).bind(r.deliveryId).first<{ provider_message_id: string }>())!.provider_message_id, "retried-id");
  const resend = new ResendEmail(db, "re_test_not_real", "x@crestmontwebsitedevelopment.com", (async () => { throw new Error("Resend must not retry SES rows"); }) as typeof fetch);
  await db.prepare(`UPDATE email_deliveries SET status='queued', updated_at = ? WHERE id = ?`).bind(new Date(Date.now() - 6 * 60_000).toISOString(), r.deliveryId).run();
  assert.equal((await retryQueuedEmails({ db, email: resend, now: () => new Date() })).retried, 0);
});

// ───────────── SNS webhook ─────────────

// A self-made RSA key pair and X.509 certificate (DER built here) standing in for the SNS signing certificate.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...p: Buffer[]) => der(0x30, ...p);
const oid = (hex: string) => der(0x06, Buffer.from(hex, "hex"));
const name = (cn: string) => seq(der(0x31, seq(oid("550403"), der(0x0c, Buffer.from(cn)))));
function selfSignedPem(pub: KeyObject, priv: KeyObject): string {
  const alg = seq(oid("2a864886f70d01010b"), der(0x05)); // sha256WithRSAEncryption
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), alg, name("sns.amazonaws.com"),
    seq(der(0x17, Buffer.from("260101000000Z")), der(0x17, Buffer.from("361231235959Z"))), name("sns.amazonaws.com"), pub.export({ type: "spki", format: "der" }));
  const cert = seq(tbs, alg, der(0x03, Buffer.from([0]), nodeSign("sha256", tbs, priv)));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").replace(/.{64}/g, "$&\n")}\n-----END CERTIFICATE-----\n`;
}
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { publicKey: otherPub, privateKey: otherPriv } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = selfSignedPem(publicKey, privateKey);
let certSeq = 0;

function snsMessage(fields: Record<string, string>, opts: { version?: "1" | "2"; key?: KeyObject; certUrl?: string } = {}) {
  const m: Record<string, string> = { Timestamp: "2026-11-13T12:00:00.000Z", TopicArn: TOPIC, ...fields, SignatureVersion: opts.version ?? "1",
    SigningCertURL: opts.certUrl ?? `https://sns.us-east-2.amazonaws.com/SimpleNotificationService-test${certSeq}.pem` };
  m.Signature = nodeSign(m.SignatureVersion === "1" ? "sha1" : "sha256", Buffer.from(snsCanonicalString(m)), opts.key ?? privateKey).toString("base64");
  return m;
}
const sesEvent = (eventType: string, messageId: string, extra: Record<string, unknown> = {}, tags: Record<string, string[]> = {}) => ({
  eventType,
  mail: { timestamp: "2026-11-13T11:59:00.000Z", messageId, source: "support@crestmontwebsitedevelopment.com", destination: ["customer@gmail.com"],
    tags: { "ses:configuration-set": ["crestmontwebsitedevelopment"], business: ["crestmont"], environment: ["production"], ...tags } },
  ...extra,
});
const notification = (id: string, event: unknown, opts?: Parameters<typeof snsMessage>[1]) => snsMessage({ Type: "Notification", MessageId: id, Message: JSON.stringify(event) }, opts);

async function sesApp(extra: Partial<Env> = {}) {
  certSeq++; // a new certificate URL per app, so the in-memory certificate cache never carries over between tests
  const app = await createTestApp({ ENVIRONMENT: "production", SES_SNS_TOPIC_ARN: TOPIC, SES_CONFIGURATION_SET: "crestmontwebsitedevelopment", ...extra });
  const fetched: string[] = [];
  app.env.overrides!.fetch = (async (url: string | URL | Request) => {
    const u = String(url); fetched.push(u);
    if (u.endsWith(".pem")) return new Response(PEM, { status: 200 });
    if (u.includes("Action=ConfirmSubscription")) return new Response("<ConfirmSubscriptionResponse/>", { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const post = async (m: Record<string, unknown> | string, type = typeof m === "string" ? "Notification" : String(m.Type), headers: Record<string, string> = {}) => {
    const res = await app.client().request("POST", "/api/webhooks/ses", { body: typeof m === "string" ? m : JSON.stringify(m), headers: { "content-type": "text/plain; charset=UTF-8", ...(type ? { "x-amz-sns-message-type": type } : {}), ...headers } });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const delivery = async (to = "customer@gmail.com", id = `ses-${Math.random().toString(16).slice(2)}`) => {
    const r = await new SesEmail(app.db, CFG, "support@crestmontwebsitedevelopment.com", sesFetch(() => okSes(id)).f, () => null, "production").send(msg(to));
    return { deliveryId: r.deliveryId, messageId: id };
  };
  const status = async (deliveryId: string) => (await app.db.prepare(`SELECT status, last_error FROM email_deliveries WHERE id = ?`).bind(deliveryId).first<{ status: string; last_error: string | null }>())!;
  const suppression = async (email: string) => app.db.prepare(`SELECT reason FROM email_suppressions WHERE email = ? AND removed_at IS NULL`).bind(email).first<{ reason: string }>();
  return { app, post, fetched, delivery, status, suppression };
}

test("[EMAIL-003] SNS signature: valid SignatureVersion 1 and 2 are accepted; the certificate is fetched once and cached", async () => {
  const w = await sesApp();
  const d = await w.delivery();
  const v1 = await w.post(notification("sns-v1", sesEvent("Send", d.messageId)));
  assert.equal(v1.status, 200, JSON.stringify(v1.json));
  assert.equal(v1.json.outcome, "applied");
  const v2 = await w.post(notification("sns-v2", sesEvent("Delivery", d.messageId), { version: "2" }));
  assert.equal(v2.status, 200, JSON.stringify(v2.json));
  assert.equal((await w.status(d.deliveryId)).status, "delivered");
  assert.equal(w.fetched.filter((u) => u.endsWith(".pem")).length, 1, "certificate cached in memory");
  // The DER walk finds the same public key that signed the certificate.
  assert.deepEqual(Buffer.from(spkiFromCertificate(pemToDer(PEM))), publicKey.export({ type: "spki", format: "der" }));
});

test("[EMAIL-003] SNS webhook rejects (403): tampered body, wrong key, wrong topic, bad certificate host, missing header, unconfigured", async () => {
  const w = await sesApp();
  const d = await w.delivery();
  const good = notification("sns-t1", sesEvent("Delivery", d.messageId));
  assert.equal((await w.post({ ...good, Message: good.Message.replace("Delivery", "Bounce") })).status, 403, "tampered Message");
  assert.equal((await w.post({ ...good, MessageId: "sns-other" })).status, 403, "tampered MessageId");
  assert.equal((await w.post(notification("sns-t2", sesEvent("Delivery", d.messageId), { key: otherPriv }))).status, 403, "signed by another key");
  assert.equal((await w.post(notification("sns-t3", sesEvent("Delivery", d.messageId), { version: "3" as "2" }))).status, 403, "unknown SignatureVersion");
  const wrongTopic = snsMessage({ Type: "Notification", MessageId: "sns-t4", Message: JSON.stringify(sesEvent("Delivery", d.messageId)), TopicArn: "arn:aws:sns:us-east-2:111111111111:ses-events" });
  const r4 = await w.post(wrongTopic);
  assert.equal(r4.status, 403, "validly signed, but another topic");
  assert.match(String(r4.json.error), /TopicArn/);
  const before = w.fetched.length;
  for (const certUrl of ["https://evil.example.com/cert.pem", "http://sns.us-east-2.amazonaws.com/cert.pem", "https://sns.us-east-2.amazonaws.com.evil.com/cert.pem", "https://sns.us-east-2.amazonaws.com/cert.txt", "https://sns.us-east-2.amazonaws.com:8443/cert.pem"]) {
    assert.equal((await w.post(notification("sns-t5", sesEvent("Delivery", d.messageId), { certUrl }))).status, 403, certUrl);
  }
  assert.equal(w.fetched.length, before, "a certificate is never fetched from a non-SNS URL");
  assert.equal((await w.post(good, "")).status, 403, "no x-amz-sns-message-type header");
  assert.equal((await w.post(good, "SubscriptionConfirmation")).status, 403, "header does not match the message type");
  assert.equal((await w.post("not json")).status, 403);
  assert.equal((await w.status(d.deliveryId)).status, "sent", "nothing was applied");
  const unconfigured = await sesApp({ SES_SNS_TOPIC_ARN: undefined });
  assert.equal((await unconfigured.post(notification("sns-t6", sesEvent("Delivery", d.messageId)))).status, 403, "fails closed without SES_SNS_TOPIC_ARN");
  // Validly signed by a real-looking flow, then delivered: accepted.
  assert.equal((await w.post(good)).status, 200);
});

test("[EMAIL-003] SNS subscription confirmation: SubscribeURL visited only after signature + topic checks and only on an SNS host", async () => {
  const w = await sesApp();
  const sub = (id: string, url: string, topic = TOPIC) => snsMessage({ Type: "SubscriptionConfirmation", MessageId: id, Token: "tok", TopicArn: topic, Message: "You have chosen to subscribe", SubscribeURL: url });
  const url = `https://sns.us-east-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=tok`;
  const r = await w.post(sub("sub-1", url));
  assert.equal(r.status, 200);
  assert.equal(r.json.confirmed, true);
  assert.ok(w.fetched.includes(url));
  const n = w.fetched.length;
  assert.equal((await w.post(sub("sub-2", "https://attacker.example.com/?Action=ConfirmSubscription"))).status, 403, "SubscribeURL host must be sns.<region>.amazonaws.com");
  assert.equal((await w.post(sub("sub-3", url, "arn:aws:sns:us-east-2:111111111111:other"))).status, 403, "wrong topic");
  assert.equal((await w.post({ ...sub("sub-4", url), Token: "forged" })).status, 403, "tampered");
  assert.equal(w.fetched.length, n, "SubscribeURL never visited for a rejected message");
  const audit = await w.app.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'email.ses_subscription_confirmed'`).first<{ n: number }>();
  assert.equal(audit!.n, 1);
  assert.equal((await w.post(snsMessage({ Type: "UnsubscribeConfirmation", MessageId: "unsub-1", Token: "tok", Message: "x", SubscribeURL: url }))).status, 200);
});

test("[EMAIL-003] SNS events: deduped on MessageId; other configuration sets and environments are dropped; unknown types ignored", async () => {
  const w = await sesApp();
  const d = await w.delivery();
  const n = notification("sns-dup", sesEvent("Delivery", d.messageId));
  assert.deepEqual([(await w.post(n)).json.duplicate, (await w.post(n)).json.duplicate], [false, true]);
  const rows = await w.app.db.prepare(`SELECT svix_id, type, outcome, delivery_id FROM email_webhook_events WHERE svix_id = 'sns:sns-dup'`).all<{ svix_id: string; type: string; outcome: string; delivery_id: string }>();
  assert.deepEqual(rows.results.map((x) => ({ ...x })), [{ svix_id: "sns:sns-dup", type: "ses.Delivery", outcome: "applied", delivery_id: d.deliveryId }]);

  const other = await w.post(notification("sns-other-biz", sesEvent("Bounce", d.messageId, { bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "customer@gmail.com" }] } }, { "ses:configuration-set": ["premiuminvoices"] })));
  assert.equal(other.status, 200);
  assert.equal(other.json.outcome, "ignored");
  assert.equal(await w.suppression("customer@gmail.com"), null, "another business's bounce changes nothing here");
  assert.equal((await w.app.db.prepare(`SELECT COUNT(*) AS n FROM email_webhook_events WHERE svix_id = 'sns:sns-other-biz'`).first<{ n: number }>())!.n, 0, "and is not stored");

  const staging = await w.post(notification("sns-staging", sesEvent("Bounce", d.messageId, { bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "customer@gmail.com" }] } }, { environment: ["staging"] })));
  assert.equal(staging.json.outcome, "ignored", "the other environment's event is acknowledged and ignored");
  assert.equal(await w.suppression("customer@gmail.com"), null);

  assert.equal((await w.post(notification("sns-open", sesEvent("Open", d.messageId)))).json.outcome, "ignored");
  assert.equal((await w.post(notification("sns-junk", "not an ses event" as unknown as object))).json.outcome, "ignored");
  assert.equal((await w.status(d.deliveryId)).status, "delivered");
});

test("[EMAIL-003] SES bounce/complaint/reject map to the Resend delivery-status model and feed the same suppression list", async () => {
  const w = await sesApp();
  const hard = await w.delivery("hard@gmail.com");
  const r = await w.post(notification("sns-b1", sesEvent("Bounce", hard.messageId, { bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "hard@gmail.com", diagnosticCode: "smtp; 550 5.1.1 user unknown" }] } })));
  assert.deepEqual(r.json.suppressed, ["hard@gmail.com"]);
  assert.equal((await w.status(hard.deliveryId)).status, "bounced");
  assert.match((await w.status(hard.deliveryId)).last_error ?? "", /Bounce Permanent\/General: smtp; 550 5\.1\.1/);
  assert.equal((await w.suppression("hard@gmail.com"))!.reason, "hard_bounce");
  // The suppression now blocks sending, exactly as for a Resend bounce.
  assert.equal((await new SesEmail(w.app.db, CFG, "x@crestmontwebsitedevelopment.com", sesFetch(() => okSes()).f).send(msg("hard@gmail.com"))).status, "suppressed");

  const soft = await w.delivery("soft@gmail.com");
  await w.post(notification("sns-b2", sesEvent("Bounce", soft.messageId, { bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", bouncedRecipients: [{ emailAddress: "soft@gmail.com" }] } })));
  assert.equal((await w.status(soft.deliveryId)).status, "failed");
  assert.equal(await w.suppression("soft@gmail.com"), null, "a transient bounce does not suppress");

  const spam = await w.delivery("spam@gmail.com");
  await w.post(notification("sns-c1", sesEvent("Delivery", spam.messageId)));
  const c = await w.post(notification("sns-c2", sesEvent("Complaint", spam.messageId, { complaint: { complainedRecipients: [{ emailAddress: "spam@gmail.com" }], complaintFeedbackType: "abuse" } })));
  assert.deepEqual(c.json.suppressed, ["spam@gmail.com"]);
  assert.equal((await w.suppression("spam@gmail.com"))!.reason, "complaint");
  assert.equal((await w.status(spam.deliveryId)).status, "delivered", "a complaint keeps the delivered status (as for Resend)");

  const rej = await w.delivery("rej@gmail.com");
  await w.post(notification("sns-r1", sesEvent("Reject", rej.messageId, { reject: { reason: "Bad content" } })));
  assert.deepEqual({ ...(await w.status(rej.deliveryId)) }, { status: "failed", last_error: "SES rejected the message: Bad content" });
  const rf = await w.delivery("render@gmail.com");
  await w.post(notification("sns-r2", sesEvent("RenderingFailure", rf.messageId, { failure: { errorMessage: "x" } })));
  assert.equal((await w.status(rf.deliveryId)).status, "failed");
  const late = await w.delivery("late@gmail.com");
  await w.post(notification("sns-d1", sesEvent("DeliveryDelay", late.messageId, { deliveryDelay: { delayType: "MailboxFull" } })));
  assert.deepEqual({ ...(await w.status(late.deliveryId)) }, { status: "sent", last_error: "Delivery delayed by the recipient's mail server (temporary: MailboxFull); SES keeps retrying." });
  // Never downgrades: a late Send after Delivery leaves it delivered.
  await w.post(notification("sns-d2", sesEvent("Delivery", late.messageId)));
  await w.post(notification("sns-d3", sesEvent("Send", late.messageId)));
  assert.equal((await w.status(late.deliveryId)).status, "delivered");
  // An unmatched bounce (mail not in this database) still suppresses the bounced address.
  await w.post(notification("sns-b3", sesEvent("Bounce", "unknown-id", { bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "Stranger@Gmail.com" }] } })));
  assert.equal((await w.suppression("stranger@gmail.com"))!.reason, "hard_bounce");
});

test("[EMAIL-003] SNS webhook answers 5xx only on a storage error (so SNS retries)", async () => {
  const w = await sesApp();
  const realError = console.error;
  console.error = () => {};
  try {
    await w.app.db.prepare(`DROP TABLE email_webhook_events`).run();
    const r = await w.post(notification("sns-store", sesEvent("Delivery", "any-id")));
    assert.equal(r.status, 500);
  } finally { console.error = realError; }
});

// ───────────── List-Unsubscribe headers and sales opt-outs (both providers) ─────────────

const UNSUB = { "List-Unsubscribe": "<https://crestmontwebsitedevelopment.com/api/sales/unsubscribe/abc>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };

test("[EMAIL-003] List-Unsubscribe / List-Unsubscribe-Post reach the provider: SES Content.Simple.Headers, Resend headers; kept for retries; no headers otherwise", async () => {
  const db = createTestDb();
  const { f, calls } = sesFetch(() => okSes());
  const ses = new SesEmail(db, CFG, "x@crestmontwebsitedevelopment.com", f, () => null, "production");
  assert.equal((await ses.send({ ...msg("prospect@gmail.com", "sales_info"), headers: UNSUB })).status, "sent");
  const simple = JSON.parse(String(calls[0].init.body)).Content.Simple;
  assert.deepEqual(simple.Headers, [{ Name: "List-Unsubscribe", Value: UNSUB["List-Unsubscribe"] }, { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" }]);
  await ses.send(msg("customer@gmail.com", "invoice"));
  assert.equal(JSON.parse(String(calls[1].init.body)).Content.Simple.Headers, undefined, "transactional mail carries no list headers");

  const sent: Record<string, unknown>[] = [];
  const resend = new ResendEmail(db, "re_test_not_real", "x@crestmontwebsitedevelopment.com",
    (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: "re_1" }), { status: 200 }); }) as unknown as typeof fetch);
  assert.equal((await resend.send({ ...msg("prospect2@gmail.com", "sales_info"), headers: { ...UNSUB, "Bad\r\nName": "x", "X-Inject": "a\r\nBcc: evil@example.org" } })).status, "sent");
  assert.deepEqual(sent[0].headers, { ...UNSUB, "X-Inject": "a Bcc: evil@example.org" }, "header names are validated and values kept on one line");
  await resend.send(msg("customer2@gmail.com", "invoice"));
  assert.equal(sent[1].headers, undefined);

  // A transient SES failure is retried by the scheduled job with the same headers.
  let fail = true;
  const { f: flaky, calls: fc } = sesFetch(() => (fail ? sesFail(503, "ServiceUnavailable", "busy") : okSes("retried")));
  const s2 = new SesEmail(db, CFG, "x@crestmontwebsitedevelopment.com", flaky);
  const r = await s2.send({ ...msg("retry-unsub@gmail.com", "sales_info"), headers: UNSUB });
  await db.prepare(`UPDATE email_deliveries SET updated_at = ? WHERE id = ?`).bind(new Date(Date.now() - 6 * 60_000).toISOString(), r.deliveryId).run();
  fail = false;
  assert.equal((await retryQueuedEmails({ db, email: s2, now: () => new Date() })).sent, 1);
  assert.deepEqual(JSON.parse(String(fc[1].init.body)).Content.Simple.Headers, JSON.parse(String(fc[0].init.body)).Content.Simple.Headers);
});

test("[EMAIL-003] quote_sent and sales_info are not sent to a sales opt-out or a suppressed address (both providers); other templates ignore sales opt-outs", async () => {
  const db = createTestDb();
  const at = new Date().toISOString();
  await db.prepare(`INSERT INTO sales_email_optouts (email, source, created_at) VALUES ('optout@gmail.com', 'unsubscribe_link', ?)`).bind(at).run();
  await db.prepare(`INSERT INTO email_suppressions (id, email, reason, detail, source_event_id, created_at) VALUES ('sup_q','bounced@gmail.com','hard_bounce',NULL,NULL,?)`).bind(at).run();
  const { f, calls } = sesFetch(() => okSes());
  const sentResend: string[] = [];
  const adapters = [
    new SesEmail(db, CFG, "x@crestmontwebsitedevelopment.com", f),
    new ResendEmail(db, "re_test_not_real", "x@crestmontwebsitedevelopment.com", (async (_u: string, init: RequestInit) => { sentResend.push(String(init.body)); return new Response(JSON.stringify({ id: "re_q" }), { status: 200 }); }) as unknown as typeof fetch),
  ];
  for (const a of adapters) {
    for (const template of ["quote_sent", "sales_info"]) {
      for (const to of ["optout@gmail.com", "bounced@gmail.com"]) {
        const r = await a.send(msg(to, template));
        assert.equal(r.status, "suppressed", `${a.kind} ${template} ${to}`);
        const row = (await db.prepare(`SELECT status, last_error FROM email_deliveries WHERE id = ?`).bind(r.deliveryId).first<{ status: string; last_error: string }>())!;
        assert.equal(row.status, "suppressed");
        assert.match(row.last_error, to.startsWith("optout") ? /opted out of sales email/ : /hard bounce/);
      }
    }
    assert.equal((await a.send(msg("optout@gmail.com", "receipt"))).status, "sent", "a sales opt-out does not stop account/billing mail");
  }
  assert.equal(calls.length + sentResend.length, 2, "only the two receipts reached a provider");

  // The staff proposal path (quotes.ts → sendMail) gets the same answer.
  const r = await sendMail({ email: new OutboxEmail(db), db }, { template: "quote_sent", to: "optout@gmail.com", idempotencyKey: "quote-optout",
    data: { contactName: "Opted Out", totalCents: 99900, validUntil: null, proposalUrl: "https://crestmontwebsitedevelopment.com/q/x" } });
  assert.equal(r.status, "suppressed");
});
