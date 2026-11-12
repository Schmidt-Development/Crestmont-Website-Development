// Owner checkout preview (Founder, 2026-11-09): before the public launch, production closes /checkout/* to everyone. The
// Owner reviews the real Starter, Business and Premium purchase pages at /staff/checkout-preview: the same intake, price,
// scope, maintenance plan and agreements, rendered by the /checkout code. Read-only: nothing is stored, nothing is paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD } from "./support/app.ts";

const PROD = { ENVIRONMENT: "production" as const, APP_URL: "https://crestmont.test" };
const PKGS = [["starter", "Starter", "$999", "essential"], ["business", "Business", "$2,499", "professional"], ["premium", "Premium", "$4,999", "executive"]] as const;
const counts = async (t: Awaited<ReturnType<typeof createTestApp>>) => {
  const out: Record<string, number> = {};
  for (const tbl of ["purchase_intakes", "orders", "agreement_acceptances", "invoices", "projects", "files"]) out[tbl] = (await t.db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).first<{ n: number }>())!.n;
  return out;
};

test("[LAUNCH-003] [PAY-001] Owner checkout preview on pre-launch production: real intake, price, scope, plan and agreements for each package; nothing stored; customers still closed out", async () => {
  const t = await createTestApp(PROD);
  const owner = await createStaff(t.db, "owner");
  const o = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);
  const before = await counts(t);

  const index = await o.get("/staff/checkout-preview");
  assert.equal(index.status, 200);
  const ih = await index.text();
  for (const [id, , price] of PKGS) { assert.ok(ih.includes(`/staff/checkout-preview/${id}/intake`), id); assert.ok(ih.includes(price), `${id} price ${price}`); }
  assert.match(ih, /href="\/quote\?package=custom"/, "Custom is quoted, not bought");
  assert.match(ih, /Online payment in this environment: closed/);

  for (const [id, name, price, plan] of PKGS) {
    const intake = await o.get(`/staff/checkout-preview/${id}/intake`);
    assert.equal(intake.status, 200, `${id} intake`);
    const h = await intake.text();
    assert.match(h, /Owner preview/);
    assert.match(h, /Tell us about your website/);
    assert.ok(h.includes(`${name} website package`));
    for (const f of ["business_name", "industry", "goals", "pages", "content_source", "domain_status", "hosting"]) assert.ok(h.includes(`name="${f}"`), `${id} intake asks ${f}`);
    assert.equal(h.includes(`name="advanced_features"`), id === "premium", "the Premium-only question appears only for Premium");
    assert.match(h, new RegExp(`<form method="get" action="/staff/checkout-preview/${id}/review"`), "the preview form only moves to the preview review");
    assert.doesNotMatch(h, /action="\/checkout\//, "never posts to the real checkout");

    const review = await o.get(`/staff/checkout-preview/${id}/review?business_name=Preview+Cafe&industry=Coffee+shops&pages=Home%2C+Menu`);
    assert.equal(review.status, 200, `${id} review`);
    const r = await review.text();
    assert.match(r, new RegExp(`data-testid="checkout-price">\\${price}`), `${id}: exact server-side price`);
    assert.match(r, /data-testid="checkout-scope"><li>/, `${id}: scope listed`);
    assert.match(r, /Fixed price, paid 100% upfront/);
    assert.match(r, /Coffee shops/, "the intake answers are shown in the order summary");
    assert.match(r, new RegExp(`name="maintenance_plan" value="${plan}"[^>]*><span[^>]*>[^<]*<small[^>]*>\\(minimum\\)`), `${id}: minimum plan ${plan}`);
    assert.match(r, /I agree to the Development Agreement, Terms of Service, Refund Policy and Data Processing Addendum\./);
    for (const l of ["/legal/development-agreement", "/legal/terms", "/legal/refunds", "/legal/data-processing"]) assert.ok(r.includes(`href="${l}"`), l);
    assert.match(r, new RegExp(`<button class="btn btn--primary" type="button" disabled aria-disabled="true">Pay \\${price}</button>`), `${id}: payment disabled in preview`);
    assert.doesNotMatch(r, /action="\/checkout\//);
    if (id === "premium") assert.match(r, /starting price/);
  }
  assert.deepEqual(await counts(t), before, "the preview stores nothing: no intake, order, agreement acceptance, invoice, project or file");

  // Customers stay closed out of the real checkout, and the Owner is too: the preview is the only way in.
  for (const c of [t.client(), o]) assert.equal((await c.get("/checkout/business")).status, 503);
  assert.equal((await t.client().get("/quote?package=custom")).status, 200, "Custom keeps the quote form");
});

test("[LAUNCH-003] the checkout preview is the Owner's only: anonymous visitors sign in, customers and other staff are refused", async () => {
  const t = await createTestApp(PROD);
  const anon = await t.client().get("/staff/checkout-preview/business/review");
  assert.equal(anon.status, 303);
  assert.match(anon.headers.get("location") ?? "", /^\/login/);
  const cu = await createCustomer(t.db, "preview-customer@example.com");
  const c = await t.client().login(cu.email, TEST_PASSWORD, cu.secret);
  assert.equal((await c.get("/staff/checkout-preview")).status, 403);
  for (const role of ["administrator", "sales", "project_manager", "support"] as const) {
    const s = await createStaff(t.db, role);
    const sc = await t.client().login(s.email, TEST_PASSWORD, s.secret);
    for (const p of ["/staff/checkout-preview", "/staff/checkout-preview/starter/intake", "/staff/checkout-preview/starter/review"]) assert.equal((await sc.get(p)).status, 403, `${role} ${p}`);
  }
  const owner = await createStaff(t.db, "owner");
  const o = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);
  assert.equal((await o.get("/staff/checkout-preview/custom/review")).status, 404, "only the standard packages are previewed");
});
