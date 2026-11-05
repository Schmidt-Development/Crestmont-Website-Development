// Founder decisions (2026-11), batch 1: FD-11 Net 7 invoices, FD-41 security.txt, FD-45 no uncertified capabilities in
// sales copy. (FD-03 Founder-only refund denial is covered in tests/domain.test.ts and tests/finance.test.ts.)
// All records are TEST DATA; nothing contacts an external service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import { DAYS_UNTIL_DUE } from "../src/services/stripe-invoices.ts";
import { APPROVED_SERVICES, AI_RECEPTIONIST_OFFER } from "../src/domain/catalog.ts";
import { RECEPTIONIST_SCENARIOS } from "../src/ui/receptionist.ts";
import { assistantSystemPrompt } from "../src/services/assistant.ts";
import { SERVICES } from "../src/content/services.ts";

test("[PAY-005] FD-11: Stripe invoices are sent Net 7", () => {
  assert.equal(DAYS_UNTIL_DUE, 7);
});

test("[SEC-007] FD-41: security.txt is not served until the Owner sets a monitored mailbox; then it is RFC 9116 shaped", async () => {
  const t = await createTestApp();
  const anon = t.client();
  assert.equal((await anon.get("/.well-known/security.txt")).status, 404, "no invented contact");

  const owner = await createStaff(t.db, "owner");
  const o = await t.client().login(owner.email, undefined, owner.secret);
  const bad = await o.post("/staff/settings", { "security.contact_email": "not-an-email", staffed_hours: "Monday–Friday, 9am–5pm Eastern (TEST DATA)", first_response_target_hours: "8" });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /Enter a valid security reporting email/);
  assert.equal((await anon.get("/.well-known/security.txt")).status, 404);

  const ok = await o.post("/staff/settings", { "security.contact_email": "security@fixture.example", staffed_hours: "Monday–Friday, 9am–5pm Eastern (TEST DATA)", first_response_target_hours: "8" });
  assert.equal(ok.status, 303);
  const res = await anon.get("/.well-known/security.txt");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /^text\/plain/);
  const body = await res.text();
  assert.match(body, /^Contact: mailto:security@fixture\.example$/m);
  const exp = /^Expires: (\S+)$/m.exec(body)?.[1];
  assert.ok(exp, "Expires is required by RFC 9116");
  const days = (Date.parse(exp!) - Date.now()) / 86_400_000;
  assert.ok(days > 30 && days < 365, `Expires within a year (${days.toFixed(0)} days)`);
  assert.match(body, /^Canonical: https?:\/\/\S+\/\.well-known\/security\.txt$/m);
});

test("[CAT-001] FD-45: sales copy and the receptionist's service list do not offer outbound AI calling for clients", () => {
  for (const s of APPROVED_SERVICES) assert.doesNotMatch(s, /outbound/i, `approved service "${s}"`);
  const rc = SERVICES.find((s) => s.slug === "ai-receptionist")!;
  const copy = [rc.name, rc.summary, rc.intro, ...rc.includes, ...rc.approved].join(" ");
  assert.doesNotMatch(copy, /outbound/i);
  assert.ok(rc.boundaries.some((b) => /outbound calling for clients is not offered/i.test(b)), "the boundary says outbound is not offered");
});

test("[CAT-001] FD-45: the public FAQ answers that outbound calling is not offered", async () => {
  const t = await createTestApp();
  const pages = await Promise.all(["/services/ai-receptionist", "/ai-receptionist"].map(async (p) => {
    const r = await t.client().get(p);
    return r.status === 200 ? await r.text() : "";
  }));
  const page = pages.find((p) => /Can it make outbound calls\?/.test(p));
  assert.ok(page, "the FAQ is published on the receptionist page");
  assert.match(page!, /Not at the moment/);
  assert.doesNotMatch(page!, /designed and quoted individually|only when scoped|outbound calling we configure/i);
  assert.match(page!, /Outbound — not offered today/);
});

test("[CAT-001] FD-45: the client AI Receptionist is 'Coming soon' — visible, but no quote, purchase or activation path", async () => {
  assert.equal(AI_RECEPTIONIST_OFFER.status, "coming_soon", "flip to available only after a certified real E2E call");
  const t = await createTestApp();
  const page = await (await t.client().get("/services/ai-receptionist")).text();
  assert.match(page, /Coming soon · Custom AI voice agents/);
  assert.match(page, /data-testid="rc-coming-soon"/);
  assert.match(page, /Can I buy it now\?/);
  assert.doesNotMatch(page, /href="\/quote\?service=ai-receptionist"/, "no quote link on the service page");
  assert.match(page, /Ask about availability/);
  const home = await (await t.client().get("/")).text();
  assert.match(home, /Coming soon · AI Receptionist/);
  assert.doesNotMatch(home, /href="\/quote\?service=ai-receptionist"/, "no quote link on the homepage");

  // The quote form neither pre-selects it nor accepts it.
  const q = await (await t.client().get("/quote?service=ai-receptionist")).text();
  assert.doesNotMatch(q, /<option value="ai-receptionist" selected/);
  assert.match(q, /not yet available to request or buy/);
  const res = await t.client().post("/quote", { name: "Pat Example", email: "pat@fixture.example", interest: "custom", service: "ai-receptionist", message: "I want an AI receptionist for my shop (TEST DATA)." });
  assert.equal(res.status, 422);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM leads`).first<{ n: number }>())!.n, 0, "no lead or quote request is created for it");
});

test("[CAT-001] FD-45: the demo has no outbound scenario or direction toggle, and the AI agents do not offer the service", async () => {
  assert.ok(RECEPTIONIST_SCENARIOS.length >= 1);
  assert.ok(RECEPTIONIST_SCENARIOS.every((s) => s.mode === "inbound"), "inbound scenarios only");
  const t = await createTestApp();
  const page = await (await t.client().get("/services/ai-receptionist")).text();
  assert.doesNotMatch(page, /data-mode-btn="outbound"/);
  assert.doesNotMatch(page, /Appointment confirmation/);
  const prompt = assistantSystemPrompt({ email: "hello@fixture.example", pricesCents: {}, process: [], faqs: [] });
  assert.match(prompt, /AI Receptionist \(\/services\/ai-receptionist\) \[Coming soon\./);
  assert.match(prompt, /Do not offer a quote for it/);
});
