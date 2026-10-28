// Tax configuration (LEGAL-005). Every rate, jurisdiction and registration id below is TEST DATA chosen to
// exercise rounding; none is a statement about Crestmont's actual tax obligations. Stripe is never called:
// checkout goes to a fake adapter, and the real adapter is driven with a local fake fetch (fixtures only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { StripeTestPayments, StripeInvoicing, type PaymentsAdapter, type CheckoutRequest } from "../src/adapters/payments.ts";
import { computeTax, lineTaxCents, parseRatePercent, formatRate, type TaxConfig } from "../src/domain/tax.ts";
import { checkoutLinesFor, loadTaxConfig } from "../src/services/tax.ts";

class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); return { id: `cs_test_${this.checkouts.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_${this.checkouts.length}` }; }
  async createBillingPortal() { return { url: "https://billing.stripe.com/p/session/test" }; }
  async createRefund() { return { id: "re_test", status: "succeeded" }; }
}

type App = { db: Env["DB"]; client: () => TestClient };
async function staff(t: App, role: Parameters<typeof createStaff>[1]) {
  const s = await createStaff(t.db, role);
  return { ...s, c: await t.client().login(s.email, TEST_PASSWORD, s.secret) };
}
async function customer(t: App, email: string) {
  const cu = await createCustomer(t.db, email, "Tax Test Bakery (TEST DATA)");
  return { ...cu, c: await t.client().login(cu.email) };
}
const latestInvoice = (db: Env["DB"], org: string) => db.prepare(`SELECT id, amount_cents, subtotal_cents, tax_cents, tax_detail_json, description FROM invoices WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(org)
  .first<{ id: string; amount_cents: number; subtotal_cents: number | null; tax_cents: number; tax_detail_json: string | null; description: string | null }>();
const pdfText = async (res: Response) => Buffer.from(await res.arrayBuffer()).toString("latin1");

test("[LEGAL-005] rate math: integer cents, per line and jurisdiction, rounded half away from zero", () => {
  assert.equal(lineTaxCents(1000, 72_500), 73, "1000¢ × 7.25% = 72.5¢ → 73¢");
  assert.equal(lineTaxCents(999, 72_500), 72, "72.4275¢ → 72¢");
  assert.equal(lineTaxCents(1, 500_000), 1, "0.5¢ → 1¢");
  assert.equal(lineTaxCents(1, 499_999), 0);
  assert.equal(lineTaxCents(-1, 500_000), -1, "negative lines round away from zero too");
  assert.equal(lineTaxCents(0, 72_500), 0);
  assert.equal(lineTaxCents(9_007_199_254_740, 1_000_000), 9_007_199_254_740, "BigInt arithmetic stays exact for large amounts");
  assert.throws(() => lineTaxCents(10.5, 1000));
  assert.equal(parseRatePercent("7.25"), 72_500);
  assert.equal(parseRatePercent("8.875%"), 88_750);
  assert.equal(parseRatePercent("0"), 0);
  assert.equal(parseRatePercent("100"), 1_000_000);
  for (const bad of ["", "abc", "-1", "100.0001", "7.12345", "1e2", "7,25"]) assert.equal(parseRatePercent(bad), null, bad);
  assert.equal(formatRate(72_500), "7.25%");
  assert.equal(formatRate(60_000), "6%");
  assert.equal(formatRate(1_250), "0.125%");

  const cfg: TaxConfig = { registered: true, stripeTaxPlanned: false, taxable: new Set(["business"]),
    rates: [{ jurisdictionId: "a", name: "Test State", registrationId: "S-1", ratePpm: 62_500 }, { jurisdictionId: "b", name: "Test City", registrationId: "C-1", ratePpm: 11_250 }] };
  const r = computeTax([{ description: "Package", amountCents: 249_900, productKey: "business" }, { description: "Add-on", amountCents: 1_999, productKey: "business" }, { description: "Other", amountCents: 5_000, productKey: "custom" }], cfg);
  // 249900 × 6.25% = 15618.75 → 15619; × 1.125% = 2811.375 → 2811; 1999 × 6.25% = 124.9375 → 125; × 1.125% = 22.48875 → 22
  assert.deepEqual(r.lines.map((l) => l.taxes.map((x) => x.taxCents)), [[15_619, 2_811], [125, 22], []]);
  assert.deepEqual(r.lines.map((l) => l.taxCents), [18_430, 147, 0]);
  assert.equal(r.lines[2].taxable, false);
  assert.deepEqual(r.byJurisdiction.map((j) => j.taxCents), [15_744, 2_833]);
  assert.equal(r.taxCents, 18_577);
  assert.equal(r.subtotalCents, 256_899);
  assert.equal(r.totalCents, r.subtotalCents + r.taxCents, "totals are exactly the sum of printed amounts");
  assert.equal(r.byJurisdiction.reduce((s, j) => s + j.taxCents, 0), r.taxCents);
  // Registered but no applied jurisdiction, or jurisdictions without registration: not configured, no tax.
  assert.equal(computeTax([{ description: "x", amountCents: 1000, productKey: "business" }], { ...cfg, rates: [] }).taxCents, 0);
  assert.equal(computeTax([{ description: "x", amountCents: 1000, productKey: "business" }], { ...cfg, registered: false }).configured, false);
});

test("[LEGAL-005] default (not configured) adds no tax anywhere and documents keep saying they are not tax invoices", async () => {
  const fake = new FakePayments();
  const t = await createTestApp({ overrides: { payments: fake } });
  const cfg = await loadTaxConfig(t.db);
  assert.equal(cfg.registered, false);
  assert.equal(cfg.rates.length, 0);
  const cu = await customer(t, "default@tax.example");
  const page = await (await cu.c.get("/checkout/business")).text();
  assert.doesNotMatch(page, /data-testid="checkout-tax"/);
  assert.equal((await cu.c.post("/checkout/business", { terms: "1" })).status, 303);
  const inv = (await latestInvoice(t.db, cu.organizationId))!;
  assert.equal(inv.subtotal_cents, null);
  assert.equal(inv.tax_cents, 0);
  assert.equal(inv.tax_detail_json, null);
  assert.equal(fake.checkouts.length, 1);
  assert.deepEqual(fake.checkouts[0].lines.map((l) => l.amountCents), [inv.amount_cents], "one line, no tax line");
  assert.equal(fake.checkouts[0].lines[0].taxJurisdictionId, undefined);
  const html = await (await cu.c.get(`/portal/billing/invoices/${inv.id}`)).text();
  assert.match(html, /not a tax invoice; tax configuration is not yet finalized/);
  assert.doesNotMatch(html, /data-testid="tax-breakdown"/);
  const pdf = await pdfText(await cu.c.get(`/portal/billing/invoices/${inv.id}/pdf`));
  assert.doesNotMatch(pdf, /Subtotal|Sales tax/);
  // A Stripe Tax "planned" flag alone, or a registration with no jurisdiction, still adds nothing.
  const owner = await staff(t, "owner");
  assert.equal((await owner.c.post("/staff/settings/tax", { registered: "1", stripe_tax_planned: "1", taxable: ["business"] })).status, 303);
  assert.equal((await cu.c.post("/checkout/business", { terms: "1" })).status, 303);
  const inv2 = (await latestInvoice(t.db, cu.organizationId))!;
  assert.equal(inv2.tax_cents, 0);
  assert.equal(inv2.tax_detail_json, null);
});

test("[LEGAL-005] configured: checkout, invoice, receipt and quote show tax per line; Stripe gets separate tax line items", async () => {
  const fake = new FakePayments();
  const t = await createTestApp({ overrides: { payments: fake } });
  const owner = await staff(t, "owner");
  assert.equal((await owner.c.post("/staff/settings/tax", { registered: "1", taxable: ["business", "change_order"], notes: "TEST DATA" })).status, 303);
  assert.equal((await owner.c.post("/staff/settings/tax/jurisdictions", { name: "Test State", registration_id: "TS-000123", rate: "6.25", applied: "1" })).status, 303);
  assert.equal((await owner.c.post("/staff/settings/tax/jurisdictions", { name: "Test City", registration_id: "TC/77", rate: "1.125", applied: "1" })).status, 303);
  assert.equal((await owner.c.post("/staff/settings/tax/jurisdictions", { name: "Not applied", registration_id: "NA-1", rate: "50" })).status, 303, "recorded but not applied");
  const settings = await (await owner.c.get("/staff/settings/tax")).text();
  assert.match(settings, /Tax is configured/);
  assert.match(settings, /TS-000123/);

  const cu = await customer(t, "taxed@tax.example");
  const page = await (await cu.c.get("/checkout/business")).text();
  assert.match(page, /data-testid="checkout-tax"/);
  assert.match(page, /Sales tax — Test State \(6\.25%\): \$156\.19/);
  assert.match(page, /Total due \$2,683\.30/);
  assert.equal((await cu.c.post("/checkout/business", { terms: "1" })).status, 303);
  const inv = (await latestInvoice(t.db, cu.organizationId))!;
  assert.equal(inv.subtotal_cents, 249_900);
  assert.equal(inv.tax_cents, 15_619 + 2_811);
  assert.equal(inv.amount_cents, 249_900 + 18_430, "amount due includes tax so the Stripe total matches the webhook");
  const order = await t.db.prepare(`SELECT total_cents FROM orders WHERE organization_id = ?`).bind(cu.organizationId).first<{ total_cents: number }>();
  assert.equal(order!.total_cents, 249_900, "order total stays the pre-tax price");
  const lines = fake.checkouts.at(-1)!.lines;
  assert.deepEqual(lines.map((l) => l.amountCents), [249_900, 2_811, 15_619], "jurisdictions in name order");
  assert.equal(lines.reduce((s, l) => s + l.amountCents, 0), inv.amount_cents);
  assert.deepEqual(lines.slice(1).map((l) => l.name), ["Sales tax — Test City (1.125%, registration TC/77)", "Sales tax — Test State (6.25%, registration TS-000123)"]);
  assert.ok(lines.slice(1).every((l) => l.taxJurisdictionId));

  // Real Stripe adapter with a local fake fetch: tax travels as separate line items tagged with the jurisdiction.
  const bodies: URLSearchParams[] = [];
  const fakeFetch = (async (_u: string | URL | Request, init?: RequestInit) => { bodies.push(new URLSearchParams(String(init!.body))); return new Response(JSON.stringify({ id: "cs_test_fixture", url: "https://checkout.stripe.com/c/pay/cs_test_fixture" }), { status: 200 }); }) as typeof fetch;
  await new StripeTestPayments("sk_test_fixture", fakeFetch).createCheckout({ mode: "payment", lines: checkoutLinesFor(inv, "Invoice"), customerEmail: "taxed@tax.example", successUrl: "https://x.test/s", cancelUrl: "https://x.test/c", metadata: { invoice_id: inv.id }, idempotencyKey: "k" });
  const b = bodies[0];
  assert.equal(b.get("line_items[0][price_data][unit_amount]"), "249900");
  assert.equal(b.get("line_items[1][price_data][unit_amount]"), "2811");
  assert.equal(b.get("line_items[2][price_data][unit_amount]"), "15619");
  assert.ok(b.get("line_items[1][price_data][product_data][metadata][crestmont_tax_jurisdiction]"));
  assert.equal(b.get("line_items[0][price_data][product_data][metadata][crestmont_tax_jurisdiction]"), null);

  // Documents: portal invoice page, invoice PDF.
  const html = await (await cu.c.get(`/portal/billing/invoices/${inv.id}`)).text();
  assert.match(html, /data-testid="tax-breakdown"/);
  assert.match(html, /Subtotal/);
  assert.match(html, /\$156\.19/);
  assert.match(html, /\$28\.11/);
  assert.doesNotMatch(html, /not a tax invoice/);
  const pdf = await pdfText(await cu.c.get(`/portal/billing/invoices/${inv.id}/pdf`));
  assert.match(pdf, /Subtotal/);
  assert.match(pdf, /\$156\.19/);
  assert.match(pdf, /\$2,683\.30/);

  // Receipt: the paid invoice's tax is shown.
  const pay = "pay_tax_test";
  await t.db.batch([
    t.db.prepare(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`).bind(new Date().toISOString(), inv.id),
    t.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES (?,?,?,?,?, 'succeeded', ?)`).bind(pay, cu.organizationId, inv.id, inv.amount_cents, "pi_test_tax", new Date().toISOString()),
  ]);
  const receipt = await (await cu.c.get(`/portal/billing/receipts/${pay}`)).text();
  assert.match(receipt, /data-testid="receipt-tax"/);
  assert.match(receipt, /Sales tax — Test City \(1\.125%\): \$28\.11/);
  assert.match(receipt, /Registrations: Test City TC\/77; Test State TS-000123/);
  const rpdf = await pdfText(await cu.c.get(`/portal/billing/receipts/${pay}/pdf`));
  assert.match(rpdf, /\$156\.19/);

  // A product not marked taxable is invoiced without tax, and the snapshot says so.
  assert.equal((await cu.c.post("/checkout/starter", { terms: "1" })).status, 303);
  const starter = (await latestInvoice(t.db, cu.organizationId))!;
  assert.equal(starter.tax_cents, 0);
  assert.equal(starter.amount_cents, starter.subtotal_cents);
  assert.deepEqual(fake.checkouts.at(-1)!.lines.map((l) => l.amountCents), [starter.amount_cents]);

  // Changing a rate affects only invoices issued afterwards; the issued snapshot is unchanged.
  const j = await t.db.prepare(`SELECT id FROM tax_jurisdictions WHERE name = 'Test State'`).first<{ id: string }>();
  assert.equal((await owner.c.post("/staff/settings/tax/jurisdictions", { id: j!.id, name: "Test State", registration_id: "TS-000123", rate: "7", applied: "1" })).status, 303);
  assert.equal((await latestInvoice(t.db, cu.organizationId))!.id, starter.id);
  const again = await t.db.prepare(`SELECT tax_cents FROM invoices WHERE id = ?`).bind(inv.id).first<{ tax_cents: number }>();
  assert.equal(again!.tax_cents, 18_430);

  // Quotes: custom work is not marked taxable here, so mark it and check the per-line estimate on the staff quote page.
  assert.equal((await owner.c.post("/staff/settings/tax", { registered: "1", taxable: ["business", "change_order", "custom"] })).status, 303);
  const lead = await t.client().request("POST", "/api/leads", { body: JSON.stringify({ name: "Quinn Tax", email: "quinn@tax.example", company: "Tax Test Co", interest: "custom", message: "Online ordering please (TEST DATA).", source: "quote_form" }), headers: { "content-type": "application/json" } });
  const leadId = ((await lead.json()) as { leadId: string }).leadId;
  for (const to of ["qualified", "quote_required"]) assert.equal((await owner.c.post(`/staff/crm/leads/${leadId}/stage`, { to })).status, 303);
  const save = await owner.c.post(`/staff/quotes/new?lead=${leadId}`, { package: "custom", line_desc: ["Ordering system", "Loyalty", ""], line_amount: ["6,000", "1,000.10", ""],
    scope: "Custom web application with online ordering and loyalty accounts (TEST DATA).", valid_until: new Date(Date.now() + 20 * 86400e3).toISOString().slice(0, 10) });
  assert.equal(save.status, 303);
  const q = await (await owner.c.get(save.headers.get("location")!)).text();
  assert.match(q, /data-testid="quote-tax"/);
  // 600000 × 7% = 42000; 100010 × 7% = 7000.7 → 7001; 600000 × 1.125% = 6750; 100010 × 1.125% = 1125.1125 → 1125
  // Per line: 6000.00 → 487.50 tax (420.00 + 67.50); 1000.10 → 81.26 (70.01 + 11.25). Per jurisdiction: 78.75 and 490.01.
  for (const want of [/\$487\.50/, /\$81\.26/, /Sales tax — Test City \(1\.125%\) \$78\.75/, /Sales tax — Test State \(7%\) \$490\.01/, /Total with estimated tax \$7,568\.86/]) assert.match(q, want);
});

test("[LEGAL-005] non-Owner staff and customers are refused; nothing changes", async () => {
  const t = await createTestApp();
  const clients: Record<string, TestClient> = {};
  for (const role of ["administrator", "sales", "developer", "project_manager", "support"] as const) {
    const s = await staff(t, role);
    clients[role] = s.c;
    assert.equal((await s.c.get("/staff/settings/tax")).status, 403, `${role} GET`);
    assert.equal((await s.c.post("/staff/settings/tax", { registered: "1", taxable: ["business"] })).status, 403, `${role} POST settings`);
    assert.equal((await s.c.post("/staff/settings/tax/jurisdictions", { name: "Sneaky", registration_id: "X-1", rate: "5", applied: "1" })).status, 403, `${role} POST jurisdiction`);
  }
  const cu = await customer(t, "cust@tax.example");
  assert.equal((await cu.c.get("/staff/settings/tax")).status, 403);
  assert.equal((await t.client().get("/staff/settings/tax")).status, 303, "anonymous is sent to sign in");
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM tax_jurisdictions`).first<{ n: number }>())!.n, 0);
  assert.equal(await t.db.prepare(`SELECT 1 FROM tax_settings`).first(), null);
  assert.equal((await loadTaxConfig(t.db)).registered, false);
  // Administrators see that tax belongs to the Owner, without a link to the page.
  const page = await (await clients.administrator.get("/staff/settings")).text();
  assert.match(page, /Tax configuration is recorded by the Owner/);
  assert.doesNotMatch(page, /href="\/staff\/settings\/tax"/);
});

test("[LEGAL-005] every settings change writes an audit row with before/after; invalid input is rejected", async () => {
  const t = await createTestApp();
  const owner = await staff(t, "owner");
  const bad = await owner.c.post("/staff/settings/tax/jurisdictions", { name: "<b>X</b>", registration_id: "", rate: "7.12345" });
  assert.equal(bad.status, 422);
  const badText = await bad.text();
  assert.match(badText, /plain text/);
  assert.match(badText, /four decimals/);
  assert.equal((await owner.c.post("/staff/settings/tax", { taxable: ["not_a_product"] })).status, 422);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'tax.%'`).first<{ n: number }>())!.n, 0, "rejected input writes nothing");

  assert.equal((await owner.c.post("/staff/settings/tax", { registered: "1", taxable: ["custom"] })).status, 303);
  assert.equal((await owner.c.post("/staff/settings/tax/jurisdictions", { name: "Audit State", registration_id: "AS-1", rate: "4", applied: "1" })).status, 303);
  const j = await t.db.prepare(`SELECT id FROM tax_jurisdictions`).first<{ id: string }>();
  assert.equal((await owner.c.post("/staff/settings/tax/jurisdictions", { id: j!.id, name: "Audit State", registration_id: "AS-1", rate: "4.5" })).status, 303);
  const rows = (await t.db.prepare(`SELECT action, actor_user_id, subject_id, details_json FROM audit_logs WHERE action LIKE 'tax.%' ORDER BY rowid`).all<{ action: string; actor_user_id: string; subject_id: string; details_json: string }>()).results;
  assert.deepEqual(rows.map((r) => r.action), ["tax.settings_updated", "tax.jurisdiction_added", "tax.jurisdiction_updated"]);
  assert.ok(rows.every((r) => r.actor_user_id === owner.id));
  const s = JSON.parse(rows[0].details_json);
  assert.equal(s.before.registered, false);
  assert.equal(s.after.registered, true);
  assert.deepEqual(s.after.taxable, ["custom"]);
  const u = JSON.parse(rows[2].details_json);
  assert.equal(u.before.ratePpm, 40_000);
  assert.equal(u.after.ratePpm, 45_000);
  assert.equal(u.before.applied, true);
  assert.equal(u.after.applied, false);
  assert.equal(rows[2].subject_id, j!.id);
  assert.equal((await owner.c.post("/staff/settings/tax/jurisdictions", { id: "txj_missing", name: "Nope", registration_id: "N-1", rate: "1" })).status, 404);
});

test("[LEGAL-005] Stripe Invoice items: taxable amount keeps its idempotency key; each jurisdiction's tax is a separate tagged item (fixtures only)", async () => {
  const calls: { key: string; body: URLSearchParams }[] = [];
  const fakeFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    calls.push({ key: (init!.headers as Record<string, string>)["idempotency-key"], body: new URLSearchParams(String(init!.body)) });
    return new Response(JSON.stringify({ id: `ii_test_${calls.length}`, amount: 0, invoice: "in_test_fixture" }), { status: 200 });
  }) as typeof fetch;
  const stripe = new StripeInvoicing("sk_test_fixture", fakeFetch);
  const detail = computeTax([{ description: "25% on approved design", amountCents: 125_000, productKey: "custom" }],
    { registered: true, stripeTaxPlanned: false, taxable: new Set(["custom"]), rates: [{ jurisdictionId: "txj_a", name: "Test State", registrationId: "TS-1", ratePpm: 60_000 }] });
  const lines = checkoutLinesFor({ description: "25% on approved design", amount_cents: detail.totalCents, subtotal_cents: detail.subtotalCents, tax_detail_json: JSON.stringify(detail) }, "Invoice");
  for (const l of lines) await stripe.addInvoiceItem({ customer: "cus_test", invoice: "in_test_fixture", amountCents: l.amountCents, description: l.name, localInvoiceId: "inv_local", taxJurisdictionId: l.taxJurisdictionId });
  assert.deepEqual(calls.map((c) => c.key), ["crestmont:invoice:inv_local:item", "crestmont:invoice:inv_local:item:tax:txj_a"]);
  assert.deepEqual(calls.map((c) => c.body.get("amount")), ["125000", "7500"]);
  assert.equal(calls[1].body.get("metadata[crestmont_tax_jurisdiction]"), "txj_a");
  assert.equal(calls[0].body.get("metadata[crestmont_tax_jurisdiction]"), null);
  assert.equal(lines.reduce((s, l) => s + l.amountCents, 0), detail.totalCents, "items sum to the local amount due, so the draft-total check still holds");
});
