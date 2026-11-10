// Email delivery certification (Founder, 2026-11-09): every template, rendered from its reviewed sample, goes through the
// environment's real adapter to Resend's own test inboxes; never to a person.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";
import { signEvidence } from "../src/readiness/ingest.ts";
import { sendCertificationBatch, certParts, CERT_PART_SIZE } from "../src/services/email-certification.ts";
import { EMAIL_TEMPLATES } from "../src/services/mailer.ts";
import { recipientPolicy, RESEND_TEST_INBOX, type EmailMessage } from "../src/adapters/email.ts";

test("[EMAIL-001] delivery certification sends every template once to a Resend test inbox, plus one bounce probe, with a marked subject", async () => {
  const sent: EmailMessage[] = [];
  const ctx = { settings: {}, baseUrl: "https://crestmont.test", email: { kind: "resend", send: async (m: EmailMessage) => { sent.push(m); return { deliveryId: `em_${sent.length}`, status: "sent", provider: "resend" }; } } };
  const first = await sendCertificationBatch(ctx as never, "cert-abc123", 0, async () => {});
  assert.equal(first.parts, certParts());
  assert.ok(first.sent.length <= CERT_PART_SIZE, "at most CERT_PART_SIZE messages per request (Workers subrequest limit)");
  const out = [...first.sent];
  for (let p = 1; p < first.parts; p++) out.push(...(await sendCertificationBatch(ctx as never, "cert-abc123", p, async () => {})).sent);
  assert.equal(out.length, EMAIL_TEMPLATES.length + 1);
  assert.deepEqual(new Set(out.filter((o) => o.probe === "delivered").map((o) => o.template)), new Set(EMAIL_TEMPLATES), "every template exactly once");
  assert.equal(out.filter((o) => o.probe === "bounced").length, 1);
  for (const m of sent) {
    assert.match(m.to, RESEND_TEST_INBOX, `${m.template}: only Resend's test inboxes`);
    assert.match(m.subject, /^\[Delivery check\] /);
    assert.ok(m.html.length > 200 && m.text.length > 20, `${m.template}: rendered`);
  }
  assert.equal(new Set(sent.map((m) => m.idempotencyKey)).size, sent.length, "unique idempotency keys");
  await assert.rejects(sendCertificationBatch(ctx as never, "BAD id!", 0, async () => {}));
  await assert.rejects(sendCertificationBatch(ctx as never, "cert-abc123", certParts(), async () => {}));
  // A message that cannot be sent is reported with its error instead of failing the whole request.
  const failing = { ...ctx, email: { kind: "resend", send: async () => { throw new Error("Too many subrequests."); } } };
  const f = await sendCertificationBatch(failing as never, "cert-fail", 0, async () => {});
  assert.ok(f.sent.every((x) => x.status === "error" && x.error === "Too many subrequests."));
});

test("[EMAIL-001] Resend's test inboxes may be mailed in every environment; other addresses keep the staging allowlist and the reserved-name rule", () => {
  for (const env of ["staging", "production"]) {
    const allowed = recipientPolicy({ ENVIRONMENT: env });
    for (const to of ["delivered@resend.dev", "delivered+cert-1-receipt@resend.dev", "bounced+cert-1@resend.dev", "complained@resend.dev"]) assert.equal(allowed(to), null, `${env} ${to}`);
    assert.match(allowed("someone@resend.dev.evil.com.test") ?? "", /reserved/);
  }
  const staging = recipientPolicy({ ENVIRONMENT: "staging" });
  assert.match(staging("customer@gmail.com") ?? "", /EMAIL_RECIPIENT_ALLOWLIST/, "real outside addresses stay blocked on staging");
  assert.match(staging("random@resend.dev") ?? "", /EMAIL_RECIPIENT_ALLOWLIST/, "only Resend's named test inboxes, not any resend.dev address");
});

test("[EMAIL-001] the certification endpoint is signed, validates the run id and refuses where no Resend adapter exists", async () => {
  const SECRET = "email-cert-secret";
  const t = await createTestApp({ ENVIRONMENT: "staging", EVIDENCE_INGEST_SECRET: SECRET } as never);
  const call = async (body: string, sig?: string) => t.client().request("POST", "/api/ops/email-certification", { body, headers: { "content-type": "application/json", ...(sig ? { "x-crestmont-signature": sig } : {}) } });
  const good = JSON.stringify({ runId: "cert-test-1" });
  assert.equal((await call(good)).status, 401);
  assert.equal((await call(JSON.stringify({ runId: "Bad Id" }), await signEvidence(SECRET, JSON.stringify({ runId: "Bad Id" })))).status, 422);
  const r = await call(good, await signEvidence(SECRET, good));
  assert.equal(r.status, 409, "no RESEND_API_KEY here: nothing is pretended to be delivered");
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM email_deliveries`).first<{ n: number }>())!.n, 0);
});
