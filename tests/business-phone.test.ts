// Crestmont's phone number (Founder, 2026-11-10): read only from Business settings, shown as a tel: link in the header,
// mobile menu, footer, contact page, AI Receptionist page, portal support, emails and receipts. Nothing when unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import { nowIso } from "../src/lib/db.ts";
import { publicPhoneFrom } from "../src/domain/business-identity.ts";
import { renderTemplate, identityFrom, TEMPLATES } from "../src/services/mailer.ts";

const FIXTURE = "517-555-0142"; // 555-01xx: reserved fictional range (TEST DATA)

test("[WEB-005] publicPhoneFrom: Business settings only, E.164 tel and readable display; invalid or empty values show nothing", () => {
  assert.deepEqual(publicPhoneFrom({ "voice.phone_number": FIXTURE }), { display: "(517) 555-0142", tel: "+15175550142" });
  assert.deepEqual(publicPhoneFrom({ "voice.phone_number": "+1 (517) 555-0142" }), { display: "(517) 555-0142", tel: "+15175550142" });
  assert.deepEqual(publicPhoneFrom({ "contact.phone": "(616) 555-0100", "voice.phone_number": FIXTURE })?.tel, "+16165550100", "the public business line wins when both are recorded");
  assert.deepEqual(publicPhoneFrom({ "contact.phone": "+44 20 7946 0958" }), { display: "+44 20 7946 0958", tel: "+442079460958" });
  for (const bad of [{}, { "voice.phone_number": "" }, { "voice.phone_number": "call us" }, { "voice.phone_number": "12345" }]) assert.equal(publicPhoneFrom(bad), null);
});

test("[WEB-005] the recorded number appears as a tel: link on the public site, the AI Receptionist page, portal support, emails and receipts", async () => {
  const none = await createTestApp();
  assert.doesNotMatch(await (await none.client().get("/")).text(), /href="tel:/, "no number recorded: none shown");
  const t = await createTestApp();
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('voice.phone_number', ?, ?)`).bind(FIXTURE, nowIso()).run();
  for (const path of ["/", "/pricing", "/contact", "/services/ai-receptionist", "/legal/privacy"]) {
    const h = await (await t.client().get(path)).text();
    assert.ok(h.includes(`class="nav__phone" href="tel:+15175550142"`), `${path}: header / mobile menu`);
    assert.ok(h.includes(`class="footer-phone" href="tel:+15175550142"`), `${path}: footer`);
  }
  assert.match(await (await t.client().get("/contact")).text(), /data-testid="contact-phone"[^>]*>[\s\S]*?\(517\) 555-0142[\s\S]*?Answered by our AI receptionist/);
  assert.match(await (await t.client().get("/services/ai-receptionist")).text(), /data-testid="rc-call"[\s\S]*?href="tel:\+15175550142">\(517\) 555-0142/);
  const cu = await createCustomer(t.db, "phone.customer@crestmont-phone-fixture.com");
  const c = await t.client().login(cu.email, TEST_PASSWORD, cu.secret);
  assert.match(await (await c.get("/portal/support")).text(), /data-testid="portal-phone">Prefer to talk\? Call <a href="tel:\+15175550142">\(517\) 555-0142/);
  const mail = renderTemplate("support_reply", TEMPLATES.support_reply.samples[0] as never, identityFrom({ "voice.phone_number": FIXTURE }));
  assert.match(mail.text, /Phone: \(517\) 555-0142/, "the email footer carries the number");
  assert.match(mail.html, /Phone: \(517\) 555-0142/);
});
