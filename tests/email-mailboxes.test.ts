// Owner, 2026-11-13 (locked): four departmental mailboxes — support@, sales@, billing@, legal@ — are kept in their own
// contexts and never consolidated. Customer email is sent from support@ under the business name; Reply-To routes the
// answer to the right department; agreements, policies and receipts keep billing@ and legal@; the public site keeps
// sales@, billing@ and legal@ on the contact and legal pages; no personal address appears on public pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAILBOXES, DEFAULT_EMAIL_FROM, replyToFor, ResendEmail } from "../src/adapters/email.ts";
import { EMAIL_TEMPLATES } from "../src/services/mailer.ts";
import { factsFromSettings } from "../src/services/agreements.ts";
import { createTestApp } from "./support/app.ts";

test("[EMAIL-003] four departmental mailboxes; From is the business name on support@; Reply-To by department", async () => {
  assert.deepEqual(MAILBOXES, { support: "support@crestmontwebsitedevelopment.com", sales: "sales@crestmontwebsitedevelopment.com", billing: "billing@crestmontwebsitedevelopment.com", legal: "legal@crestmontwebsitedevelopment.com" });
  assert.equal(DEFAULT_EMAIL_FROM, "Crestmont Website Development <support@crestmontwebsitedevelopment.com>");
  for (const t of ["receipt", "invoice", "failed_payment", "subscription_update", "refund_request", "refund_decision"]) assert.equal(replyToFor(t), MAILBOXES.billing, t);
  for (const t of ["quote_sent", "proposal_accepted", "sales_info"]) assert.equal(replyToFor(t), MAILBOXES.sales, t);
  for (const t of ["account_setup", "purchase", "support_reply", "password_reset", "onboarding"]) assert.equal(replyToFor(t), MAILBOXES.support, t);
  for (const t of EMAIL_TEMPLATES) assert.ok(Object.values(MAILBOXES).includes(replyToFor(t) as never), t);
  const toml = readFileSync("wrangler.toml", "utf8");
  assert.equal((toml.match(/EMAIL_FROM = "Crestmont Website Development <support@crestmontwebsitedevelopment\.com>"/g) ?? []).length, 2, "staging and production send under the business name");
  const facts = factsFromSettings({});
  assert.equal(facts.billingEmail, MAILBOXES.billing);
  assert.equal(facts.legalEmail, MAILBOXES.legal);
  assert.equal(facts.supportEmail, MAILBOXES.support);
  // The Resend request carries the department's Reply-To.
  const t = await createTestApp();
  const bodies: Record<string, unknown>[] = [];
  const mail = new ResendEmail(t.db, "re_test_x", DEFAULT_EMAIL_FROM, (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: "re_1" })); }) as never);
  await mail.send({ template: "receipt", to: "a@harbor-fixture.dev", subject: "s", html: "h", text: "t", idempotencyKey: "k1" });
  await mail.send({ template: "quote_sent", to: "a@harbor-fixture.dev", subject: "s", html: "h", text: "t", idempotencyKey: "k2" });
  assert.deepEqual(bodies.map((b) => [b.from, b.reply_to]), [[DEFAULT_EMAIL_FROM, MAILBOXES.billing], [DEFAULT_EMAIL_FROM, MAILBOXES.sales]]);
});

test("[EMAIL-003] public pages show the departmental addresses and never a personal Gmail address", async () => {
  const t = await createTestApp();
  const c = t.client();
  const pages: Record<string, string> = {};
  for (const path of ["/", "/pricing", "/contact", "/legal/privacy", "/legal/terms"]) pages[path] = await (await c.get(path)).text();
  const all = Object.values(pages).join("\n");
  assert.ok(!/@gmail\.com/i.test(all), "no Gmail address on a public page");
  assert.match(all, /support@crestmontwebsitedevelopment\.com/);
  assert.match(all, /legal@crestmontwebsitedevelopment\.com/);
});

test("[EMAIL-003] the mailbox check sends one labelled message to each of the four departmental mailboxes", async () => {
  const { sendMailboxChecks } = await import("../src/services/email-certification.ts");
  const sent: { to: string; subject: string; idempotencyKey: string }[] = [];
  const ctx = { email: { kind: "resend", send: async (m: { to: string; subject: string; idempotencyKey: string }) => { sent.push(m); return { deliveryId: `d${sent.length}`, status: "sent", provider: "resend" }; } } } as never;
  const out = await sendMailboxChecks(ctx, "mbx-test-1", async () => {});
  assert.deepEqual(sent.map((m) => m.to), Object.values(MAILBOXES));
  assert.ok(sent.every((m) => m.subject.startsWith("[Mailbox check]")));
  assert.equal(new Set(sent.map((m) => m.idempotencyKey)).size, 4);
  assert.deepEqual(out.sent.map((s) => s.template), ["mailbox:support", "mailbox:sales", "mailbox:billing", "mailbox:legal"]);
});

test("[EMAIL-003] migration 0106: a personal Gmail public contact email becomes support@ on /contact and the footer", async () => {
  const t = await createTestApp();
  const at = new Date().toISOString();
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('contact.email', 'someone.personal@gmail.com', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(at).run();
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('security.contact_email', 'someone.personal@gmail.com', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(at).run();
  assert.match(await (await t.client().get("/contact")).text(), /@gmail\.com/, "fixture: the bad value shows before the migration");
  t.db.raw.exec(readFileSync("migrations/0106_public_support_email.sql", "utf8"));
  const page = await (await t.client().get("/contact")).text();
  assert.doesNotMatch(page, /@gmail\.com/);
  assert.match(page, /support@crestmontwebsitedevelopment\.com/);
  assert.equal((await t.db.prepare(`SELECT value FROM business_settings WHERE key = 'security.contact_email'`).first<{ value: string }>())!.value, MAILBOXES.support);
});
