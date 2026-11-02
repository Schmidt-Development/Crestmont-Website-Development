// FD-26 / FD-27 (Founder decisions, 2026-11): mandatory minimum hosting & maintenance plan per website package, one
// business project per plan, and no recurring charge at package purchase. All records are TEST DATA; Stripe is never
// called (a recording fake adapter stands in for Checkout).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";
import {
  MAINTENANCE_PLANS, MINIMUM_PLAN_FOR_PACKAGE, BUSINESS_PROJECTS_PER_PLAN, MAINTENANCE_BILLING_START, PricingError,
  eligiblePlansFor, assertPlanMeetsMinimum, type PackageId,
} from "../src/domain/catalog.ts";
import { createPackageOrder } from "../src/services/commerce.ts";

/** FIXTURE: records Checkout requests; never contacts Stripe. */
class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); const id = `cs_test_commit_${this.checkouts.length}`; return { id, url: `https://checkout.stripe.com/c/pay/${id}` }; }
  async createBillingPortal(customerId: string) { return { url: `https://billing.stripe.com/p/session/test_${customerId}` }; }
  async createRefund(pi: string, amount: number) { return { id: `re_test_${pi}_${amount}`, status: "succeeded" }; }
}

const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const count = async (db: Env["DB"], sql: string, ...b: unknown[]) => (await one<{ n: number }>(db, sql, ...b)).n;

async function buyer(email: string) {
  const fake = new FakePayments();
  const t = await createTestApp({ overrides: { payments: fake } });
  const cu = await createCustomer(t.db, email);
  const c = t.client(); await c.login(cu.email);
  return { t, fake, cu, c };
}

test("[CAT-005] FD-26: each package has the Founder's minimum plan; upgrades allowed, downgrades and unknown plans refused", () => {
  assert.deepEqual({ ...MINIMUM_PLAN_FOR_PACKAGE }, { starter: "essential", business: "professional", premium: "executive" });
  assert.deepEqual(eligiblePlansFor("starter"), ["essential", "professional", "executive"]);
  assert.deepEqual(eligiblePlansFor("business"), ["professional", "executive"]);
  assert.deepEqual(eligiblePlansFor("premium"), ["executive"]);
  assert.equal(assertPlanMeetsMinimum("starter", "executive"), "executive", "upgrade allowed");
  assert.equal(assertPlanMeetsMinimum("business", "professional"), "professional");
  for (const [pkg, plan] of [["business", "essential"], ["premium", "professional"], ["premium", "essential"]] as [PackageId, string][]) {
    assert.throws(() => assertPlanMeetsMinimum(pkg, plan), PricingError, `${pkg} + ${plan} must be refused`);
  }
  for (const bad of ["", "platinum", "ESSENTIAL", "__proto__"]) assert.throws(() => assertPlanMeetsMinimum("starter", bad), PricingError);
  assert.equal(MAINTENANCE_BILLING_START, "at_approved_launch");
});

test("[CAT-005] FD-26 / clarification 3: every plan covers exactly one business project; no plan offers two sites", () => {
  assert.equal(BUSINESS_PROJECTS_PER_PLAN, 1);
  for (const plan of Object.values(MAINTENANCE_PLANS)) {
    const text = Object.values(plan.proposedEntitlements).join(" ");
    assert.match(plan.proposedEntitlements.hosting!, /1 business project/, `${plan.name} hosting names one business project`);
    assert.doesNotMatch(text, /\b(2|two|multiple)\s+(sites|websites|businesses|projects)\b/i, `${plan.name} must not promise more than one business`);
  }
});

test("[SALES-004] [CAT-005] checkout page offers only plans at or above the minimum and says nothing is billed for the plan today", async () => {
  const { c } = await buyer("planpage@fixture.example");
  const business = await (await c.get("/checkout/business")).text();
  assert.match(business, /data-testid="checkout-maintenance-plan"/);
  assert.match(business, /name="maintenance_plan" value="professional"/);
  assert.match(business, /name="maintenance_plan" value="executive"/);
  assert.doesNotMatch(business, /name="maintenance_plan" value="essential"/, "Business cannot pick Essential");
  assert.match(business, /requires the Professional plan or higher/);
  assert.match(business, /not charged for the plan today/);
  assert.match(business, /one business project/i);
  const starter = await (await c.get("/checkout/starter")).text();
  assert.match(starter, /name="maintenance_plan" value="essential"/);
});

test("[SALES-004] [CAT-004] FD-26: checkout without a plan, or below the minimum, creates no order and no Stripe session", async () => {
  const { t, fake, c } = await buyer("noplan@fixture.example");
  const missing = await c.post("/checkout/business", { terms: "1" });
  assert.equal(missing.status, 422);
  assert.match(await missing.text(), /Choose a hosting and maintenance plan/);
  const downgrade = await c.post("/checkout/business", { terms: "1", maintenance_plan: "essential" });
  assert.equal(downgrade.status, 422);
  assert.match(await downgrade.text(), /requires the Professional plan or higher/);
  const forged = await c.post("/checkout/premium", { terms: "1", maintenance_plan: "essential_plus" });
  assert.equal(forged.status, 422);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM orders`), 0);
  assert.equal(fake.checkouts.length, 0);
});

test("[SALES-004] [CAT-004] FD-26 / FD-27: an upgraded choice is recorded on the order; the package is a one-time payment and no subscription starts", async () => {
  const { t, fake, c } = await buyer("upgrade@fixture.example");
  const res = await c.post("/checkout/starter", { terms: "1", maintenance_plan: "executive" });
  assert.equal(res.status, 303);
  const co = fake.checkouts.at(-1)!;
  assert.equal(co.mode, "payment", "the package checkout is a one-time payment, never a subscription");
  assert.equal(co.metadata.maintenance_plan_id, "executive");
  const order = await one<{ maintenance_plan_id: string; maintenance_plan_source: string; total_cents: number }>(t.db,
    `SELECT maintenance_plan_id, maintenance_plan_source, total_cents FROM orders WHERE id = ?`, co.metadata.order_id);
  assert.deepEqual({ ...order }, { maintenance_plan_id: "executive", maintenance_plan_source: "customer_selected", total_cents: 99_900 },
    "the plan does not change what is charged today");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM subscriptions`), 0, "no subscription exists before launch");
  const lines = co.lines.reduce((s, l) => s + l.amountCents, 0);
  assert.equal(lines, 99_900, "nothing for the plan is added to the package payment");
});

test("[SALES-004] FD-26: changing the plan before paying voids the open invoice and issues one for the new choice", async () => {
  const { t, fake, c } = await buyer("switch@fixture.example");
  assert.equal((await c.post("/checkout/business", { terms: "1", maintenance_plan: "professional" })).status, 303);
  const first = fake.checkouts.at(-1)!.metadata;
  assert.equal((await c.post("/checkout/business", { terms: "1", maintenance_plan: "professional" })).status, 303);
  assert.equal(fake.checkouts.at(-1)!.metadata.invoice_id, first.invoice_id, "same plan reuses the open invoice");
  assert.equal((await c.post("/checkout/business", { terms: "1", maintenance_plan: "executive" })).status, 303);
  const second = fake.checkouts.at(-1)!.metadata;
  assert.notEqual(second.invoice_id, first.invoice_id);
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM invoices WHERE id = ?`, first.invoice_id)).status, "void");
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM orders WHERE id = ?`, first.order_id)).status, "cancelled");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM invoices WHERE status = 'open'`), 1, "only one payable invoice");
  assert.equal((await one<{ maintenance_plan_id: string }>(t.db, `SELECT maintenance_plan_id FROM orders WHERE id = ?`, second.order_id)).maintenance_plan_id, "executive");
});

test("[CAT-005] FD-26: internal order creation without a customer choice records the minimum, labelled as a default", async () => {
  const t = await createTestApp();
  const cu = await createCustomer(t.db, "internal@fixture.example");
  for (const pkg of ["starter", "business", "premium"] as PackageId[]) {
    const o = await createPackageOrder(t.db, cu.organizationId, pkg, cu.id);
    const row = await one<{ maintenance_plan_id: string; maintenance_plan_source: string }>(t.db, `SELECT maintenance_plan_id, maintenance_plan_source FROM orders WHERE id = ?`, o.orderId);
    assert.deepEqual({ ...row }, { maintenance_plan_id: MINIMUM_PLAN_FOR_PACKAGE[pkg], maintenance_plan_source: "minimum_default" });
  }
  await assert.rejects(createPackageOrder(t.db, cu.organizationId, "premium", cu.id, new Date(), { maintenancePlanId: "essential" }), /requires the Executive plan/);
});
