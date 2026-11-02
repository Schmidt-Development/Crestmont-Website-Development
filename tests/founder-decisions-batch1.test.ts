// Founder decisions (2026-11), batch 1: FD-11 Net 7 invoices, FD-41 security.txt, FD-45 no uncertified capabilities in
// sales copy. (FD-03 Founder-only refund denial is covered in tests/domain.test.ts and tests/finance.test.ts.)
// All records are TEST DATA; nothing contacts an external service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import { DAYS_UNTIL_DUE } from "../src/services/stripe-invoices.ts";
import { APPROVED_SERVICES } from "../src/domain/catalog.ts";
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
