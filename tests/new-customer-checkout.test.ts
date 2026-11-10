// A new customer who chooses a package keeps it through sign-up (Founder, 2026-11-10): /checkout/<package> asks them to
// sign in; "Create an account", the confirmation email and the sign-in after it all carry the package's checkout path,
// so the customer lands on that package's intake instead of the portal. Only same-site paths are carried.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, lastEmail, TEST_PASSWORD } from "./support/app.ts";

test("[AUTH-001] [PAY-001] a new customer keeps the chosen package through registration, email confirmation and sign-in, and arrives at its intake", async () => {
  const t = await createTestApp();
  const c = t.client();
  const entry = await c.get("/checkout/business");
  assert.equal(entry.status, 303);
  const login = entry.headers.get("location")!;
  assert.equal(login, "/login?next=%2Fcheckout%2Fbusiness");
  const lp = await (await c.get(login)).text();
  assert.ok(lp.includes(`href="/register?next=%2Fcheckout%2Fbusiness"`), "Create an account keeps the package");
  const rp = await (await c.get("/register?next=%2Fcheckout%2Fbusiness")).text();
  assert.ok(rp.includes(`action="/register?next=%2Fcheckout%2Fbusiness"`));
  assert.ok(rp.includes(`href="/login?next=%2Fcheckout%2Fbusiness"`), "Sign in keeps it too");

  const email = "new.customer@crestmont-signup-fixture.com";
  const reg = await c.post("/register?next=%2Fcheckout%2Fbusiness", { name: "New Customer", organization: "New Customer Bakery", email, password: TEST_PASSWORD, terms: "1" });
  assert.equal(reg.status, 200);
  const rh = await reg.text();
  assert.match(rh, /you will continue with your package after signing in/);
  assert.ok(rh.includes(`href="/login?next=%2Fcheckout%2Fbusiness"`));
  const mail = (await lastEmail(t.db, email))!;
  assert.equal(mail.template, "verification");
  const link = /(\/verify-email\?token=[A-Za-z0-9_-]+&next=%2Fcheckout%2Fbusiness)/.exec(mail.text_body)?.[1];
  assert.ok(link, `the confirmation link carries the package: ${mail.text_body}`);
  const verified = await c.get(link!);
  assert.equal(verified.status, 303);
  assert.equal(verified.headers.get("location"), "/login?next=%2Fcheckout%2Fbusiness");
  const signedIn = await c.post("/login?next=%2Fcheckout%2Fbusiness", { email, password: TEST_PASSWORD });
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get("location"), "/checkout/business");
  const checkout = await c.get("/checkout/business");
  assert.equal(checkout.status, 303);
  assert.equal(checkout.headers.get("location"), "/checkout/business/intake", "the chosen package's intake");
  const intake = await (await c.get("/checkout/business/intake")).text();
  assert.match(intake, /Business website package/);
});

test("[AUTH-001] [SEC-001] only same-site paths are carried through sign-up (no open redirect)", async () => {
  const t = await createTestApp();
  const c = t.client();
  for (const bad of ["https://evil.example.net/x", "//evil.example.net", "/\\evil.example.net"]) {
    const rp = await (await c.get(`/register?next=${encodeURIComponent(bad)}`)).text();
    assert.ok(rp.includes(`action="/register"`), `${bad}: not carried`);
    assert.doesNotMatch(rp, /evil\.example\.net/);
  }
  const email = "careful.customer@crestmont-signup-fixture.com";
  await c.post(`/register?next=${encodeURIComponent("https://evil.example.net/x")}`, { name: "Careful Customer", organization: "Careful Co", email, password: TEST_PASSWORD, terms: "1" });
  assert.doesNotMatch((await lastEmail(t.db, email))!.text_body, /evil|next=/);
});
