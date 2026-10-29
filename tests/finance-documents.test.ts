// Finance documents (PDF), Stripe Invoices for milestones, ledger reconciliation, AI cost attribution and
// Owner finance list tooling. All records are TEST DATA. Stripe is never called: every Stripe request goes
// to a local fake fetch that asserts the documented request shapes and returns realistic fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";
import { PdfDocument, PdfFlow, pdfString, wrapText, textWidth } from "../src/lib/pdf.ts";
import { runStripeLedgerReconciliation, runStripeReconciliation } from "../src/services/stripe-reconcile.ts";
import { runCostImport } from "../src/services/cost-import.ts";
import { projectProfitability } from "../src/services/finance.ts";
import { staffNav, OWNER_MODULE_LABELS } from "../src/routes/nav.ts";
import { runJobs, SCHEDULE } from "../src/app/scheduled.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";

const one = async <T>(db: Env["DB"], sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const count = async (db: Env["DB"], sql: string, ...b: unknown[]) => (await one<{ n: number }>(db, sql, ...b)).n;
const iso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString();
const nowS = () => Math.floor(Date.now() / 1000);

class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); return { id: `cs_test_${this.checkouts.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_${this.checkouts.length}` }; }
  async createBillingPortal() { return { url: "https://billing.stripe.com/p/session/test" }; }
  async createRefund() { return { id: "re_test", status: "succeeded" }; }
}

async function login(t: { db: Env["DB"]; client: () => TestClient }, role: Parameters<typeof createStaff>[1], email?: string) {
  const s = await createStaff(t.db, role, email);
  const c = t.client(); await c.login(s.email, TEST_PASSWORD, s.secret);
  return { ...s, c };
}
async function customer(t: { db: Env["DB"]; client: () => TestClient }, email: string, org: string) {
  const cu = await createCustomer(t.db, email, org);
  const c = t.client(); await c.login(cu.email);
  return { ...cu, c };
}

// ───────────── PDF structural validation (test-side parser) ─────────────

interface ParsedPdf { text: string[]; objects: number; pages: number; raw: string }
function parsePdf(bytes: Uint8Array): ParsedPdf {
  const raw = Buffer.from(bytes).toString("latin1");
  assert.ok(raw.startsWith("%PDF-1.4\n"), "PDF 1.4 header");
  assert.ok(raw.endsWith("%%EOF\n"), "ends with %%EOF");
  // Everything after the binary-marker comment line is 7-bit ASCII.
  const body = raw.slice(raw.indexOf("\n", 9) + 1);
  assert.ok([...body].every((ch) => ch.charCodeAt(0) < 128), "ASCII body");
  const sx = /startxref\n(\d+)\n%%EOF\n$/.exec(raw);
  assert.ok(sx, "startxref");
  const xref = Number(sx![1]);
  assert.equal(raw.slice(xref, xref + 5), "xref\n", "startxref points at the xref table");
  const hdr = /^xref\n0 (\d+)\n/.exec(raw.slice(xref))!;
  const size = Number(hdr[1]);
  const entriesAt = xref + hdr[0].length;
  assert.equal(raw.slice(entriesAt, entriesAt + 20), "0000000000 65535 f \n");
  for (let n = 1; n < size; n++) {
    const e = raw.slice(entriesAt + n * 20, entriesAt + (n + 1) * 20);
    assert.match(e, /^\d{10} 00000 n \n$/, `xref entry ${n} is 20 bytes`);
    const off = Number(e.slice(0, 10));
    assert.ok(raw.startsWith(`${n} 0 obj\n`, off), `xref offset of object ${n} (${off}) points at "${n} 0 obj"`);
  }
  const trailer = /trailer\n<< \/Size (\d+) \/Root 1 0 R \/Info 5 0 R >>\nstartxref/.exec(raw);
  assert.ok(trailer, "trailer");
  assert.equal(Number(trailer![1]), size, "trailer /Size matches xref");
  // Every stream's /Length is exact.
  const streamRe = /<< \/Length (\d+) >>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw))) {
    const start = m.index + m[0].length, len = Number(m[1]);
    assert.ok(raw.startsWith("endstream", start + len), "stream /Length is exact");
  }
  const pagesM = /\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(raw)!;
  // Decode every shown string: \ddd octal, \( \) \\ escapes; WinAnsi high bytes → Unicode for the few we emit.
  const back: Record<number, string> = { 0x96: "–", 0x97: "—", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x85: "…", 0x80: "€" };
  const text = [...raw.matchAll(/\(((?:\\[0-7]{3}|\\.|[^\\)])*)\) Tj/g)].map((x) => x[1].replace(/\\([0-7]{3})|\\(.)/g, (_s, o, c) => {
    if (!o) return c;
    const b = parseInt(o, 8);
    return back[b] ?? String.fromCharCode(b);
  }));
  return { text, objects: size - 1, pages: Number(pagesM[1]), raw };
}

test("[PAY-005] zero-dependency PDF writer: valid PDF 1.4 structure, exact xref offsets, escaped strings, multi-page tables", () => {
  assert.equal(pdfString("a (b) c\\d"), "(a \\(b\\) c\\\\d)");
  assert.equal(pdfString("Café — 5 €"), "(Caf\\351 \\227 5 \\200)");
  assert.equal(pdfString("bad\u0001中"), "(bad?)", "control characters dropped, unsupported glyphs become ?");
  assert.equal(textWidth("Hello", 10), (722 + 556 + 222 + 222 + 556) / 100);
  assert.ok(wrapText("one two three four five six seven", 60, 10).length > 1);
  const doc = new PdfDocument({ title: "Test (doc) \\ ünïcode", creationDate: new Date("2026-10-27T12:00:00Z") });
  const flow = new PdfFlow(doc);
  flow.paragraph("Heading with (parens) and a backslash \\ and “quotes”", { bold: true, size: 14 });
  flow.table([{ header: "Item", width: 300 }, { header: "Amount", width: 100, align: "right" }], Array.from({ length: 80 }, (_, i) => [`Line item ${i + 1} — description that is long enough to wrap onto a second line in the table cell`, `$${i + 1}.00`]));
  flow.page.line(54, 100, 300, 100);
  const p = parsePdf(doc.toBytes());
  assert.ok(p.pages >= 3, `table paginates (${p.pages} pages)`);
  assert.equal(p.objects, 5 + p.pages * 2, "catalog, pages, 2 fonts, info + page/content per page");
  assert.ok(p.text.includes("Heading with (parens) and a backslash \\ and “quotes”"));
  const cell = p.text.find((x) => x.startsWith("Line item 80 —"));
  assert.ok(cell && cell.length < "Line item 80 — description that is long enough to wrap onto a second line in the table cell".length, "long cell text wraps onto several lines");
  assert.equal(p.text.filter((x) => x === "Amount").length, p.pages, "table header repeated on each page");
  assert.match(p.raw, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/);
  assert.match(p.raw, /\/Title \(Test \\\(doc\\\) \\\\ \\374n\\357code\)/);
});

// ───────────── PAY-005: invoice + receipt PDFs from persisted records ─────────────

async function seedMilestoneOrder(db: Env["DB"], orgId: string, createdBy: string, o: { prefix: string; projectId?: string } ) {
  const at = iso(-3600), p = o.prefix;
  const contact = `ct_${p}`, lead = `ld_${p}`, quote = `qt_${p}`, qv = `qv_${p}`, ord = `ord_${p}`, prj = o.projectId ?? `prj_${p}`;
  const lines = { lines: [{ description: "Custom web application (TEST DATA)", amountCents: 800_000 }, { description: "Booking integration (TEST DATA)", amountCents: 200_000 }], installments: [] };
  await db.batch([
    db.prepare(`INSERT INTO contacts (id, name, email, created_at) VALUES (?,?,?,?)`).bind(contact, "Test Contact", `${p}@contact.example`, at),
    db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES (?,?, 'quote_form', 'converted', ?, ?)`).bind(lead, contact, at, at),
    db.prepare(`INSERT INTO quotes (id, lead_id, status, current_version, created_by, created_at) VALUES (?,?, 'accepted', 1, ?, ?)`).bind(quote, lead, createdBy, at),
    db.prepare(`INSERT INTO quote_versions (id, quote_id, version, line_items_json, total_cents, payment_schedule, scope_text, created_at) VALUES (?,?,1,?,1000000,'milestone_50_25_25','Scope (TEST DATA)',?)`).bind(qv, quote, JSON.stringify(lines), at),
    db.prepare(`INSERT INTO orders (id, organization_id, quote_version_id, product_id, total_cents, status, kind, lead_id, created_at) VALUES (?,?,?, 'custom', 1000000, 'partially_paid', 'quote', ?, ?)`).bind(ord, orgId, qv, lead, at),
    db.prepare(`INSERT INTO projects (id, organization_id, order_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?,?,?, 'design', 3, 'milestone_50_25_25', ?, ?)`).bind(prj, orgId, ord, `Custom app ${p} (TEST)`, at, at),
    db.prepare(`INSERT INTO invoices (id, organization_id, order_id, project_id, milestone_kind, amount_cents, status, description, created_at, paid_at) VALUES (?,?,?,?, 'deposit_50', 500000, 'paid', '50% deposit', ?, ?)`).bind(`inv_${p}_dep`, orgId, ord, prj, at, at),
    db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, order_id, amount_cents, fee_cents, stripe_payment_intent_id, status, created_at) VALUES (?,?,?,?, 500000, 14530, ?, 'succeeded', ?)`).bind(`pay_${p}_dep`, orgId, `inv_${p}_dep`, ord, `pi_test_${p}_dep`, at),
    db.prepare(`INSERT INTO invoices (id, organization_id, order_id, project_id, milestone_kind, amount_cents, status, description, created_at) VALUES (?,?,?,?, 'design_25', 250000, 'open', '25% on approved design', ?)`).bind(`inv_${p}_d25`, orgId, ord, prj, at),
    db.prepare(`INSERT INTO invoices (id, organization_id, order_id, project_id, milestone_kind, amount_cents, status, description, created_at) VALUES (?,?,?,?, 'prelaunch_25', 250000, 'open', '25% before launch', ?)`).bind(`inv_${p}_p25`, orgId, ord, prj, iso(-1800)),
  ]);
  return { lead, quote, ord, prj, dep: `inv_${p}_dep`, d25: `inv_${p}_d25`, p25: `inv_${p}_p25`, pay: `pay_${p}_dep` };
}

test("[PAY-005] invoice and receipt PDFs: amounts and line items from persisted records, owner customer and finance staff only, audited, linked from staff invoice rows", async () => {
  const t = await createTestApp();
  const owner = await login(t, "owner");
  const a = await customer(t, "pdf-a@alpha.example", "Alpha (PDF) LLC");
  const b = await customer(t, "pdf-b@beta.example", "Beta LLC");
  const s = await seedMilestoneOrder(t.db, a.organizationId, owner.id, { prefix: "pdf" });

  // Customer A downloads the paid deposit invoice.
  const res = await a.c.get(`/portal/billing/invoices/${s.dep}/pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), `attachment; filename="crestmont-invoice-${s.dep}.pdf"`);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const inv = parsePdf(new Uint8Array(await res.arrayBuffer()));
  for (const want of ["INVOICE", "Alpha (PDF) LLC", "50% deposit", "$5,000.00", "Custom web application (TEST DATA)", "$8,000.00", "Booking integration (TEST DATA)", "$2,000.00", "Order total", "$10,000.00",
    "25% design milestone", "25% pre-launch", "50% deposit (this invoice)", "Balance due", "$0.00", "Payments received", "pi_test_pdf_dep"]) {
    assert.ok(inv.text.some((x) => x.includes(want)), `invoice PDF shows "${want}"`);
  }
  const rcptNo = inv.text.find((x) => /^CWD-R-\d{6}$/.test(x));
  assert.ok(rcptNo, "payment row carries the stable receipt number");
  // Open milestone invoice: balance due equals the persisted amount.
  const open = parsePdf(new Uint8Array(await (await a.c.get(`/portal/billing/invoices/${s.d25}/pdf`)).arrayBuffer()));
  assert.ok(open.text.includes("25% on approved design") && open.text.includes("$2,500.00"));
  const bal = open.text.indexOf("Balance due");
  assert.equal(open.text[bal + 1], "$2,500.00");
  // Changing the persisted amount changes the document (nothing is recomputed from the catalog).
  await t.db.prepare(`UPDATE invoices SET amount_cents = 249999 WHERE id = ?`).bind(s.d25).run();
  assert.ok(parsePdf(new Uint8Array(await (await a.c.get(`/portal/billing/invoices/${s.d25}/pdf`)).arrayBuffer())).text.includes("$2,499.99"));

  // Receipt PDF (customer) with the same receipt number as the HTML receipt.
  const r = await a.c.get(`/portal/billing/receipts/${s.pay}/pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-disposition"), `attachment; filename="crestmont-receipt-${rcptNo}.pdf"`);
  const rp = parsePdf(new Uint8Array(await r.arrayBuffer()));
  for (const want of ["RECEIPT", rcptNo!, "Alpha (PDF) LLC", "$5,000.00", "pi_test_pdf_dep", `50% deposit (invoice ${s.dep})`]) assert.ok(rp.text.some((x) => x.includes(want)), `receipt PDF shows "${want}"`);
  assert.match(await (await a.c.get(`/portal/billing/receipts/${s.pay}`)).text(), new RegExp(rcptNo!));

  // Tenant isolation: org B gets 404 for A's documents; staff without finance.read get 403; anonymous is sent to login.
  assert.equal((await b.c.get(`/portal/billing/invoices/${s.dep}/pdf`)).status, 404);
  assert.equal((await b.c.get(`/portal/billing/receipts/${s.pay}/pdf`)).status, 404);
  assert.equal((await b.c.get(`/staff/finance/invoices/${s.dep}/pdf`)).status, 403);
  const support = await login(t, "support");
  assert.equal((await support.c.get(`/staff/finance/invoices/${s.dep}/pdf`)).status, 403);
  assert.equal((await support.c.get(`/staff/finance/receipts/${s.pay}/pdf`)).status, 403);
  assert.notEqual((await t.client().get(`/portal/billing/invoices/${s.dep}/pdf`)).status, 200);
  // Drafts are never shown to customers.
  await t.db.prepare(`INSERT INTO invoices (id, organization_id, milestone_kind, amount_cents, status, created_at) VALUES ('inv_pdf_draft', ?, 'change_order', 100, 'draft', ?)`).bind(a.organizationId, iso()).run();
  assert.equal((await a.c.get(`/portal/billing/invoices/inv_pdf_draft/pdf`)).status, 404);

  // Staff: invoice + receipt PDFs, and the staff invoice list links receipts from each row.
  assert.equal((await owner.c.get(`/staff/finance/invoices/${s.dep}/pdf`)).status, 200);
  assert.equal((await owner.c.get(`/staff/finance/receipts/${s.pay}/pdf`)).status, 200);
  const list = await (await owner.c.get("/staff/finance/invoices")).text();
  assert.match(list, new RegExp(`href="/staff/finance/receipts/${s.pay}" data-receipt`));
  assert.match(list, new RegExp(`href="/staff/finance/invoices/${s.dep}/pdf"`));
  assert.match(await (await owner.c.get(`/staff/finance/invoices/${s.dep}`)).text(), new RegExp(rcptNo!));
  // Portal billing and invoice page link the PDFs.
  const billing = await (await a.c.get("/portal/billing")).text();
  assert.match(billing, new RegExp(`/portal/billing/invoices/${s.dep}/pdf`));
  assert.match(billing, new RegExp(`/portal/billing/receipts/${s.pay}/pdf`));

  // Every successful download is audited with actor, organization and document number.
  const audits = (await t.db.prepare(`SELECT action, actor_user_id, organization_id, details_json FROM audit_logs WHERE action LIKE '%.pdf_downloaded' ORDER BY id`).all<{ action: string; actor_user_id: string; organization_id: string; details_json: string }>()).results;
  assert.equal(audits.length, 6);
  assert.ok(audits.every((x) => x.organization_id === a.organizationId));
  assert.deepEqual(new Set(audits.map((x) => x.actor_user_id)), new Set([a.id, owner.id]));
  assert.equal(JSON.parse(audits.find((x) => x.action === "receipt.pdf_downloaded")!.details_json).number, rcptNo);
});

// ───────────── PAY-006: Stripe Invoice creation (contract test against a fake Stripe) ─────────────

interface Call { method: string; path: string; query: URLSearchParams; form: URLSearchParams; idem: string | null; auth: string | null }
interface FakeInv { id: string; object: "invoice"; customer: string; status: string; total: number; amount_due: number; amount_paid: number; currency: string; number: string | null; hosted_invoice_url: string | null; metadata: Record<string, string>; created: number; livemode: false; collection_method: string; subscription: null }

function fakeStripe() {
  const calls: Call[] = [];
  const invoices: FakeInv[] = [];
  const items: { id: string; invoice: string; amount: number }[] = [];
  const customers: string[] = [];
  const idem = new Map<string, { status: number; body: unknown }>();
  const state = { failFinalize: 0, failItem: 0 };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(u));
    assert.equal(url.origin, "https://api.stripe.com");
    const headers = new Headers(init?.headers);
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, form: new URLSearchParams(String(init?.body ?? "")), idem: headers.get("idempotency-key"), auth: headers.get("authorization") };
    calls.push(call);
    if (call.method === "POST") {
      assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
      assert.ok(call.idem, `POST ${call.path} carries an Idempotency-Key`);
      const replay = idem.get(call.idem!);
      if (replay) return json(replay.status, replay.body); // Stripe replays the first response for a reused key
    }
    const done = (status: number, body: unknown) => { if (call.method === "POST" && status < 500) idem.set(call.idem!, { status, body }); return json(status, body); };
    const p = url.pathname;
    if (call.method === "POST" && p === "/v1/customers") {
      const id = `cus_test_${customers.length + 1}`; customers.push(id);
      return done(200, { id, object: "customer", name: call.form.get("name"), email: call.form.get("email"), metadata: { organization_id: call.form.get("metadata[organization_id]") }, livemode: false });
    }
    if (call.method === "GET" && p === "/v1/invoices") {
      const c = call.query.get("customer");
      return done(200, { object: "list", data: invoices.filter((i) => !c || i.customer === c), has_more: false, url: "/v1/invoices" });
    }
    if (call.method === "POST" && p === "/v1/invoices") {
      const meta: Record<string, string> = {};
      for (const [k, v] of call.form) { const m = /^metadata\[(.+)\]$/.exec(k); if (m) meta[m[1]] = v; }
      const inv: FakeInv = { id: `in_test_${invoices.length + 1}`, object: "invoice", customer: call.form.get("customer")!, status: "draft", total: 0, amount_due: 0, amount_paid: 0, currency: call.form.get("currency")!, number: null, hosted_invoice_url: null, metadata: meta, created: nowS(), livemode: false, collection_method: call.form.get("collection_method")!, subscription: null };
      invoices.push(inv);
      return done(200, inv);
    }
    if (call.method === "POST" && p === "/v1/invoiceitems") {
      if (state.failItem > 0) { state.failItem--; return json(500, { error: { type: "api_error", message: "An unknown error occurred" } }); }
      const inv = invoices.find((i) => i.id === call.form.get("invoice"))!;
      const amount = Number(call.form.get("amount"));
      inv.total += amount; inv.amount_due += amount;
      const it = { id: `ii_test_${items.length + 1}`, invoice: inv.id, amount };
      items.push(it);
      return done(200, { ...it, object: "invoiceitem", currency: "usd", livemode: false });
    }
    const fin = /^\/v1\/invoices\/(in_[A-Za-z0-9_]+)\/finalize$/.exec(p);
    if (call.method === "POST" && fin) {
      if (state.failFinalize > 0) { state.failFinalize--; return json(500, { error: { type: "api_error", message: "An unknown error occurred" } }); }
      const inv = invoices.find((i) => i.id === fin[1])!;
      inv.status = "open"; inv.number = `CRST-${String(invoices.indexOf(inv) + 1).padStart(4, "0")}`; inv.hosted_invoice_url = `https://invoice.stripe.com/i/acct_test/${inv.id}`;
      return done(200, inv);
    }
    const get = /^\/v1\/invoices\/(in_[A-Za-z0-9_]+)$/.exec(p);
    if (call.method === "GET" && get) { const inv = invoices.find((i) => i.id === get[1]); return inv ? json(200, inv) : json(404, { error: { message: "No such invoice" } }); }
    return json(404, { error: { message: `unexpected ${call.method} ${p}` } });
  }) as typeof fetch;
  return { fetchImpl, calls, invoices, items, customers, state };
}

const sig = async (secret: string, body: string) => { const ts = nowS(); return `t=${ts},v1=${await hmacSha256Hex(secret, `${ts}.${body}`)}`; };

test("[PAY-006] milestone invoices become Stripe Invoices (customer → invoice → item → finalize, never sent), idempotent, resumable, no duplicate billing", async () => {
  const stripe = fakeStripe();
  const WH = "whsec_test_pay006";
  const fake = new FakePayments();
  const t = await createTestApp({ STRIPE_SECRET_KEY: "sk_test_pay006", STRIPE_WEBHOOK_SECRET: WH, overrides: { fetch: stripe.fetchImpl, payments: fake } });
  const owner = await login(t, "owner");
  const a = await customer(t, "billing@milestone.example", "Milestone Co");
  const s = await seedMilestoneOrder(t.db, a.organizationId, owner.id, { prefix: "m6" });

  // Staff invoice page offers the action; non-milestone invoices are refused.
  assert.match(await (await owner.c.get(`/staff/finance/invoices/${s.d25}`)).text(), /Create Stripe invoice for \$2,500/);
  const res = await owner.c.post(`/staff/finance/invoices/${s.d25}/stripe-invoice`);
  assert.equal(res.status, 303);
  assert.deepEqual(stripe.calls.map((c) => `${c.method} ${c.path}`), [
    "POST /v1/customers", "GET /v1/invoices", "POST /v1/invoices", "POST /v1/invoiceitems", `GET /v1/invoices/in_test_1`, "POST /v1/invoices/in_test_1/finalize"]);
  assert.ok(stripe.calls.every((c) => c.auth === "Bearer sk_test_pay006"));
  assert.ok(!stripe.calls.some((c) => c.path.endsWith("/send")), "invoices are never sent by Stripe");
  const [cus, , create, item, , finalize] = stripe.calls;
  assert.deepEqual(Object.fromEntries(cus.form), { name: "Milestone Co", "metadata[organization_id]": a.organizationId, email: "billing@milestone.example" });
  assert.equal(cus.idem, `crestmont:customer:${a.organizationId}`);
  assert.equal(stripe.calls[1].query.get("customer"), "cus_test_1");
  assert.deepEqual(Object.fromEntries(create.form), { customer: "cus_test_1", collection_method: "send_invoice", days_until_due: "14", auto_advance: "false", pending_invoice_items_behavior: "exclude", currency: "usd",
    description: "25% on approved design", "metadata[crestmont_invoice_id]": s.d25, "metadata[organization_id]": a.organizationId, "metadata[project_id]": s.prj, "metadata[order_id]": s.ord, "metadata[milestone_kind]": "design_25" });
  assert.equal(create.idem, `crestmont:invoice:${s.d25}:create`);
  assert.deepEqual(Object.fromEntries(item.form), { customer: "cus_test_1", invoice: "in_test_1", amount: "250000", currency: "usd", description: "25% on approved design", "metadata[crestmont_invoice_id]": s.d25 });
  assert.equal(item.idem, `crestmont:invoice:${s.d25}:item`);
  assert.deepEqual(Object.fromEntries(finalize.form), { auto_advance: "false" });
  assert.equal(finalize.idem, `crestmont:invoice:${s.d25}:finalize`);
  const row = await one<{ stripe_invoice_id: string; stripe_invoice_status: string; stripe_invoice_number: string; stripe_hosted_invoice_url: string; status: string }>(t.db, `SELECT stripe_invoice_id, stripe_invoice_status, stripe_invoice_number, stripe_hosted_invoice_url, status FROM invoices WHERE id = ?`, s.d25);
  assert.deepEqual({ ...row }, { stripe_invoice_id: "in_test_1", stripe_invoice_status: "open", stripe_invoice_number: "CRST-0001", stripe_hosted_invoice_url: "https://invoice.stripe.com/i/acct_test/in_test_1", status: "open" }, "local invoice stays open until the webhook");
  assert.equal((await one<{ stripe_customer_id: string }>(t.db, `SELECT stripe_customer_id FROM organizations WHERE id = ?`, a.organizationId)).stripe_customer_id, "cus_test_1");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'invoice.stripe_invoice_created' AND subject_id = ? AND actor_user_id = ?`, s.d25, owner.id), 1);
  // CREST-GAP-039: the billing administrator receives the Stripe-hosted invoice link by email (once).
  const linkMail = await t.db.prepare(`SELECT d.template, m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.to_email = 'billing@milestone.example' AND d.idempotency_key LIKE 'stripe-invoice-link:%'`).all<{ template: string; text_body: string }>();
  assert.equal(linkMail.results.length, 1);
  assert.equal(linkMail.results[0].template, "invoice");
  assert.match(linkMail.results[0].text_body, /https:\/\/invoice\.stripe\.com\/i\/acct_test\/in_test_1/);

  // Retry of a finalized invoice: no Stripe call at all.
  const before = stripe.calls.length;
  assert.equal((await owner.c.post(`/staff/finance/invoices/${s.d25}/stripe-invoice`)).status, 303);
  assert.equal(stripe.calls.length, before);

  // Second milestone: finalize fails → 502, draft id stored, error recorded and audited.
  stripe.state.failFinalize = 1;
  const failed = await owner.c.post(`/staff/finance/invoices/${s.p25}/stripe-invoice`);
  assert.equal(failed.status, 502);
  assert.match(await failed.text(), /Retrying is safe/);
  const draft = await one<{ stripe_invoice_id: string; stripe_invoice_status: string; stripe_invoice_error: string }>(t.db, `SELECT stripe_invoice_id, stripe_invoice_status, stripe_invoice_error FROM invoices WHERE id = ?`, s.p25);
  assert.equal(draft.stripe_invoice_id, "in_test_2");
  assert.equal(draft.stripe_invoice_status, "draft");
  assert.match(draft.stripe_invoice_error, /Stripe 500/);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'invoice.stripe_invoice_failed'`), 1);
  // Simulate a crash before the draft id was stored locally: the retry finds the tagged draft instead of creating another.
  await t.db.prepare(`UPDATE invoices SET stripe_invoice_id = NULL, stripe_invoice_status = NULL WHERE id = ?`).bind(s.p25).run();
  const mark = stripe.calls.length;
  assert.equal((await owner.c.post(`/staff/finance/invoices/${s.p25}/stripe-invoice`)).status, 303);
  assert.deepEqual(stripe.calls.slice(mark).map((c) => `${c.method} ${c.path}`), ["GET /v1/invoices", "POST /v1/invoices/in_test_2/finalize"], "resumes: no new invoice, no second item");
  assert.equal(stripe.invoices.length, 2, "one Stripe invoice per milestone");
  assert.deepEqual(stripe.items.map((i) => [i.invoice, i.amount]), [["in_test_1", 250_000], ["in_test_2", 250_000]], "one item per invoice, exact amounts");
  assert.equal(stripe.customers.length, 1, "customer created once");

  // Refusals: paid / non-milestone invoices; an invoice with a Checkout session would be payable twice.
  assert.equal((await owner.c.post(`/staff/finance/invoices/${s.dep}/stripe-invoice`)).status, 409);
  await t.db.prepare(`INSERT INTO invoices (id, organization_id, project_id, milestone_kind, amount_cents, status, description, created_at) VALUES ('inv_m6_co', ?, ?, 'change_order', 40000, 'open', 'Change order', ?)`).bind(a.organizationId, s.prj, iso()).run();
  assert.match(await (await owner.c.post(`/staff/finance/invoices/inv_m6_co/stripe-invoice`)).text(), /Only 50\/25\/25 milestone invoices/);
  const sales = await login(t, "sales");
  assert.equal((await sales.c.post(`/staff/finance/invoices/${s.d25}/stripe-invoice`)).status, 403);

  // Portal: the open Stripe invoice is paid through its hosted link only; Checkout is refused (no double billing).
  const page = await (await a.c.get(`/portal/billing/invoices/${s.d25}`)).text();
  assert.match(page, /href="https:\/\/invoice\.stripe\.com\/i\/acct_test\/in_test_1"/);
  assert.equal((await a.c.post(`/portal/billing/invoices/${s.d25}/pay`)).status, 409);
  assert.equal(fake.checkouts.length, 0);

  // invoice.paid webhook (Stripe Invoice) marks the local invoice paid once and records the payment.
  const evt = { id: "evt_inv_paid_1", type: "invoice.paid", created: nowS(), data: { object: { id: "in_test_1", object: "invoice", status: "paid", amount_paid: 250_000, customer: "cus_test_1", customer_email: "billing@milestone.example", payment_intent: "pi_test_inv_1", subscription: null, metadata: { crestmont_invoice_id: s.d25 } } } };
  for (const e of [evt, evt, { ...evt, id: "evt_inv_paid_2" }]) {
    const body = JSON.stringify(e);
    assert.equal((await t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": await sig(WH, body) } })).status, 200);
  }
  const paid = await one<{ status: string; stripe_invoice_status: string }>(t.db, `SELECT status, stripe_invoice_status FROM invoices WHERE id = ?`, s.d25);
  assert.deepEqual({ ...paid }, { status: "paid", stripe_invoice_status: "paid" });
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM payments WHERE invoice_id = ? AND stripe_payment_intent_id = 'pi_test_inv_1'`, s.d25), 1);
  // A mismatched Stripe invoice id for the same local invoice is not applied.
  const bad = { id: "evt_inv_paid_bad", type: "invoice.paid", created: nowS(), data: { object: { id: "in_test_999", amount_paid: 250_000, payment_intent: "pi_test_bad", metadata: { crestmont_invoice_id: s.p25 } } } };
  const badBody = JSON.stringify(bad);
  await t.client().request("POST", "/api/webhooks/stripe", { body: badBody, headers: { "stripe-signature": await sig(WH, badBody) } });
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM invoices WHERE id = ?`, s.p25)).status, "open");
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM stripe_events WHERE id = 'evt_inv_paid_bad'`)).status, "failed");
});

test("[PAY-006] Stripe invoices are safely disabled without STRIPE_SECRET_KEY or with a live key: nothing is sent", async () => {
  let fetched = 0;
  const counting = (async () => { fetched++; return new Response("{}"); }) as typeof fetch;
  const t = await createTestApp({ overrides: { fetch: counting } });
  const owner = await login(t, "owner");
  const a = await createCustomer(t.db, "noconf@example.com", "No Stripe Co");
  const s = await seedMilestoneOrder(t.db, a.organizationId, owner.id, { prefix: "nc" });
  const page = await (await owner.c.get(`/staff/finance/invoices/${s.d25}`)).text();
  assert.match(page, /Stripe is not configured/);
  assert.doesNotMatch(page, /Create Stripe invoice/);
  const res = await owner.c.post(`/staff/finance/invoices/${s.d25}/stripe-invoice`);
  assert.equal(res.status, 409);
  assert.match(await res.text(), /Nothing was sent to Stripe/);
  const live = await createTestApp({ STRIPE_SECRET_KEY: "sk_live_never", overrides: { fetch: counting, payments: new FakePayments() } });
  const lo = await login(live, "owner");
  const lc = await createCustomer(live.db, "live@example.com", "Live Co");
  const ls = await seedMilestoneOrder(live.db, lc.organizationId, lo.id, { prefix: "lv" });
  assert.match(await (await lo.c.post(`/staff/finance/invoices/${ls.d25}/stripe-invoice`)).text(), /live payments are not authorised/);
  assert.equal(fetched, 0);
  assert.equal((await one<{ stripe_invoice_id: string | null }>(t.db, `SELECT stripe_invoice_id FROM invoices WHERE id = ?`, s.d25)).stripe_invoice_id, null);
});

// ───────────── PAY-009: Stripe Invoices, balance transactions and payouts ─────────────

test("[PAY-009] ledger reconciliation compares Stripe invoices, balance transactions and payouts (GET only) and records typed discrepancies", async () => {
  const calls: string[] = [];
  const old = nowS() - 7200;
  const fx = {
    invoices: [
      { id: "in_ok", object: "invoice", status: "paid", total: 250_000, amount_due: 0, amount_paid: 250_000, currency: "usd", number: "CRST-1", customer: "cus_t", created: old, metadata: { crestmont_invoice_id: "inv_l_ok" }, subscription: null, livemode: false, status_transitions: { paid_at: old } },
      { id: "in_remote_paid", object: "invoice", status: "paid", total: 100_000, amount_due: 0, amount_paid: 100_000, currency: "usd", number: "CRST-2", customer: "cus_t", created: old, metadata: { crestmont_invoice_id: "inv_l_open" }, subscription: null, livemode: false, status_transitions: { paid_at: old } },
      { id: "in_ghost", object: "invoice", status: "open", total: 7_700, amount_due: 7_700, amount_paid: 0, currency: "usd", number: "CRST-3", customer: "cus_t", created: old, metadata: {}, subscription: null, livemode: false },
      { id: "in_amt", object: "invoice", status: "open", total: 60_000, amount_due: 60_000, amount_paid: 0, currency: "usd", number: "CRST-4", customer: "cus_t", created: old, metadata: { crestmont_invoice_id: "inv_l_amt" }, subscription: null, livemode: false },
      { id: "in_sub", object: "invoice", status: "paid", total: 9_900, amount_due: 0, amount_paid: 9_900, currency: "usd", number: "CRST-5", customer: "cus_t", created: old, metadata: {}, subscription: "sub_test_x", livemode: false },
    ] as Record<string, unknown>[],
    bts: [
      { id: "txn_a", object: "balance_transaction", amount: 250_000, fee: 1_200, net: 248_800, currency: "usd", type: "charge", created: old, source: { id: "ch_a", object: "charge", payment_intent: "pi_l_a" } },
      { id: "txn_ghost", object: "balance_transaction", amount: 4_000, fee: 146, net: 3_854, currency: "usd", type: "charge", created: old, source: { id: "ch_ghost", object: "charge", payment_intent: "pi_l_ghost" } },
      { id: "txn_ref", object: "balance_transaction", amount: -5_000, fee: 0, net: -5_000, currency: "usd", type: "refund", created: old, source: { id: "re_unknown", object: "refund", charge: "ch_a" } },
      { id: "txn_recent", object: "balance_transaction", amount: 1_000, fee: 59, net: 941, currency: "usd", type: "charge", created: nowS() - 60, source: { id: "ch_r", object: "charge", payment_intent: "pi_l_recent" } },
    ] as Record<string, unknown>[],
    payouts: [
      { id: "po_1", object: "payout", amount: 248_800, currency: "usd", status: "paid", arrival_date: old + 86400, created: old, livemode: false },
      { id: "po_fail", object: "payout", amount: 1_000, currency: "usd", status: "failed", arrival_date: null, created: old, failure_message: "The bank account has been closed.", livemode: false },
    ] as Record<string, unknown>[],
    payoutTxns: { po_1: [{ id: "txn_a", amount: 250_000, fee: 1_200, net: 248_800, currency: "usd", type: "charge", created: old, source: { id: "ch_a", object: "charge", payment_intent: "pi_l_a" } }, { id: "txn_po1", amount: -248_800, fee: 0, net: -248_800, currency: "usd", type: "payout", created: old, source: "po_1" }] } as Record<string, unknown[]>,
  };
  const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(u));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
    if (url.pathname === "/v1/invoices") { assert.ok(url.searchParams.get("created[gte]")); return list(fx.invoices); }
    if (url.pathname === "/v1/balance_transactions") {
      assert.equal(url.searchParams.get("expand[]"), "data.source");
      const po = url.searchParams.get("payout");
      return list(po ? fx.payoutTxns[po] ?? [] : fx.bts);
    }
    if (url.pathname === "/v1/payouts") return list(fx.payouts);
    if (url.pathname === "/v1/checkout/sessions") return list([]);
    return new Response(JSON.stringify({ error: { message: "unexpected" } }), { status: 404 });
  }) as typeof fetch;
  const t = await createTestApp({ STRIPE_SECRET_KEY: "sk_test_ledger", overrides: { fetch: fetchImpl } });
  const owner = await login(t, "owner");
  const cu = await createCustomer(t.db, "ledger@example.com", "Ledger Co");
  const at = new Date((old - 60) * 1000).toISOString();
  await t.db.batch([
    t.db.prepare(`INSERT INTO invoices (id, organization_id, milestone_kind, amount_cents, status, created_at, paid_at, stripe_invoice_id, stripe_invoice_status, stripe_invoice_synced_at) VALUES ('inv_l_ok', ?, 'design_25', 250000, 'paid', ?, ?, 'in_ok', 'paid', ?)`).bind(cu.organizationId, at, at, at),
    t.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, amount_cents, fee_cents, stripe_payment_intent_id, status, created_at) VALUES ('pay_l_a', ?, 'inv_l_ok', 250000, 1000, 'pi_l_a', 'succeeded', ?)`).bind(cu.organizationId, at),
    t.db.prepare(`INSERT INTO invoices (id, organization_id, milestone_kind, amount_cents, status, created_at, stripe_invoice_id, stripe_invoice_status, stripe_invoice_synced_at) VALUES ('inv_l_open', ?, 'prelaunch_25', 100000, 'open', ?, 'in_remote_paid', 'open', ?)`).bind(cu.organizationId, at, at),
    t.db.prepare(`INSERT INTO invoices (id, organization_id, milestone_kind, amount_cents, status, created_at, stripe_invoice_id, stripe_invoice_status, stripe_invoice_synced_at) VALUES ('inv_l_amt', ?, 'design_25', 50000, 'open', ?, 'in_amt', 'open', ?)`).bind(cu.organizationId, at, at),
    t.db.prepare(`INSERT INTO invoices (id, organization_id, milestone_kind, amount_cents, status, created_at, stripe_invoice_id, stripe_invoice_status, stripe_invoice_synced_at) VALUES ('inv_l_missing', ?, 'deposit_50', 30000, 'open', ?, 'in_missing', 'open', ?)`).bind(cu.organizationId, at, iso()),
  ]);
  const r1 = await runStripeLedgerReconciliation(t.db, t.env);
  assert.equal(r1.status, "ok");
  assert.ok(calls.every((c) => c.startsWith("GET ")), "read-only");
  assert.deepEqual([...new Set(calls)].sort(), ["GET /v1/balance_transactions", "GET /v1/invoices", "GET /v1/payouts"]);
  const findings = (await t.db.prepare(`SELECT kind, stripe_object_id, scope, stripe_amount_cents, local_amount_cents FROM reconciliation_findings WHERE status = 'open' ORDER BY kind, stripe_object_id`).all<{ kind: string; stripe_object_id: string; scope: string; stripe_amount_cents: number | null; local_amount_cents: number | null }>()).results.map((x) => ({ ...x }));
  assert.deepEqual(findings.map((f) => [f.kind, f.stripe_object_id]), [
    ["balance_txn_missing_locally", "txn_ghost"],
    ["fee_mismatch", "txn_a"],
    ["local_stripe_invoice_not_found", "in_missing"],
    ["payout_amount_mismatch", "po_1"],
    ["payout_failed", "po_fail"],
    ["refund_missing_locally", "re_unknown"],
    ["stripe_invoice_amount_mismatch", "in_amt"],
    ["stripe_invoice_missing_locally", "in_ghost"],
    ["stripe_invoice_status_mismatch", "in_remote_paid"],
  ]);
  assert.ok(findings.every((f) => f.scope === "ledger"));
  assert.deepEqual(findings.find((f) => f.kind === "fee_mismatch")!, { kind: "fee_mismatch", stripe_object_id: "txn_a", scope: "ledger", stripe_amount_cents: 1200, local_amount_cents: 1000 });
  assert.deepEqual(findings.find((f) => f.kind === "payout_amount_mismatch")!, { kind: "payout_amount_mismatch", stripe_object_id: "po_1", scope: "ledger", stripe_amount_cents: 248_800, local_amount_cents: 249_000 });
  // Payout mirror: Stripe-side net matches, local expectation (payment − recorded fee) does not.
  const po = await one<{ state: string; stripe_net_cents: number; local_expected_cents: number; matched_count: number; txn_count: number }>(t.db, `SELECT state, stripe_net_cents, local_expected_cents, matched_count, txn_count FROM stripe_payouts WHERE id = 'po_1'`);
  assert.deepEqual({ ...po }, { state: "mismatch", stripe_net_cents: 248_800, local_expected_cents: 249_000, matched_count: 1, txn_count: 1 });
  assert.equal((await one<{ state: string }>(t.db, `SELECT state FROM stripe_payouts WHERE id = 'po_fail'`)).state, "failed");
  // Nothing was marked paid; the remotely paid invoice stays open until its webhook.
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM invoices WHERE id = 'inv_l_open'`)).status, "open");
  // Idempotent re-run; the checkout-scope job neither clears ledger findings nor flags Stripe-invoice payments.
  assert.equal((await runStripeLedgerReconciliation(t.db, t.env)).opened, 0);
  await runStripeReconciliation(t.db, t.env);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM reconciliation_findings WHERE scope = 'ledger' AND status = 'open'`), 9);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM reconciliation_findings WHERE scope = 'checkout'`), 0, "payment collected via Stripe invoice is not 'paid locally, not in Checkout'");
  // When the local fee is corrected, that discrepancy clears automatically on the next run.
  await t.db.prepare(`UPDATE payments SET fee_cents = 1200 WHERE id = 'pay_l_a'`).run();
  const r3 = await runStripeLedgerReconciliation(t.db, t.env);
  assert.equal(r3.cleared, 2, "fee mismatch and payout mismatch cleared");
  assert.equal((await one<{ state: string }>(t.db, `SELECT state FROM stripe_payouts WHERE id = 'po_1'`)).state, "matched");

  // Resolution workflow (finance.read): typed outcome + note, audited; re-open with reason, audited.
  const f = await one<{ id: string }>(t.db, `SELECT id FROM reconciliation_findings WHERE kind = 'stripe_invoice_missing_locally'`);
  assert.equal((await owner.c.post(`/staff/finance/reconciliation/${f.id}/resolve`, { note: "Voided the stray test invoice in Stripe.", resolution: "made_up" })).status, 422);
  assert.equal((await owner.c.post(`/staff/finance/reconciliation/${f.id}/resolve`, { note: "Voided the stray test invoice in Stripe.", resolution: "corrected_in_stripe" })).status, 303);
  const resolved = await one<{ status: string; resolution: string }>(t.db, `SELECT status, resolution FROM reconciliation_findings WHERE id = ?`, f.id);
  assert.deepEqual({ ...resolved }, { status: "resolved", resolution: "corrected_in_stripe" });
  assert.equal(JSON.parse((await one<{ details_json: string }>(t.db, `SELECT details_json FROM audit_logs WHERE action = 'reconciliation.finding_resolved' AND subject_id = ?`, f.id)).details_json).resolution, "corrected_in_stripe");
  assert.equal((await owner.c.post(`/staff/finance/reconciliation/${f.id}/reopen`, { note: "no" })).status, 422);
  assert.equal((await owner.c.post(`/staff/finance/reconciliation/${f.id}/reopen`, { note: "Stripe still shows the invoice open." })).status, 303);
  assert.deepEqual({ ...(await one<{ status: string; reopened_count: number }>(t.db, `SELECT status, reopened_count FROM reconciliation_findings WHERE id = ?`, f.id)) }, { status: "open", reopened_count: 1 });
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'reconciliation.finding_reopened' AND subject_id = ?`, f.id), 1);

  // Review page: filters, payouts view and CSV export.
  const page = await (await owner.c.get("/staff/finance/reconciliation?scope=ledger&kind=payout_failed")).text();
  assert.match(page, /po_fail/);
  assert.doesNotMatch(page, /in_ghost/);
  assert.match(await (await owner.c.get("/staff/finance/reconciliation?q=in_ghost")).text(), /in_ghost/);
  const payouts = await (await owner.c.get("/staff/finance/reconciliation?view=payouts")).text();
  assert.match(payouts, /po_1/);
  assert.match(payouts, /Matched/);
  const csv = await owner.c.get("/staff/finance/reconciliation?scope=ledger&format=csv");
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  const csvText = await csv.text();
  assert.match(csvText, /^finding_id,scope,kind,/);
  assert.match(csvText, /payout_failed/);
  assert.equal((await (await login(t, "support")).c.get("/staff/finance/reconciliation")).status, 403);
});

test("[PAY-009] ledger reconciliation is skipped without a test key, is scheduled daily and the page is in the Owner's Finance navigation", async () => {
  const t = await createTestApp();
  const res = await runJobs(t.env, ["stripe_ledger_reconcile"]);
  assert.equal(res.stripe_ledger_reconcile.ok, true);
  assert.equal(res.stripe_ledger_reconcile.detail, "skipped: payments not configured");
  assert.match((await runStripeLedgerReconciliation(t.db, { ...t.env, STRIPE_SECRET_KEY: "sk_live_x" })).detail, /not authorised/);
  assert.ok(SCHEDULE["17 11 * * *"].includes("stripe_ledger_reconcile"));
  const finance = staffNav({} as never).find((g) => g.label === "Finance")!;
  assert.ok(finance.items.some((i) => i.href === "/staff/finance/reconciliation" && i.label === "Reconciliation" && i.perm === "finance.read"));
  assert.equal(OWNER_MODULE_LABELS.length, 32);
});

// ───────────── PAY-008: dispute lifecycle ─────────────

test("[PAY-008] dispute updates keep evidence details, a won dispute restores the payment, and every change is audited", async () => {
  const WH = "whsec_test_disp";
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: WH });
  const cu = await createCustomer(t.db, "disp@example.com", "Dispute Co");
  const at = iso(-3600);
  await t.db.batch([
    t.db.prepare(`INSERT INTO invoices (id, organization_id, milestone_kind, amount_cents, status, created_at, paid_at) VALUES ('inv_dp', ?, 'full', 99900, 'paid', ?, ?)`).bind(cu.organizationId, at, at),
    t.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES ('pay_dp', ?, 'inv_dp', 99900, 'pi_test_dp', 'succeeded', ?)`).bind(cu.organizationId, at),
  ]);
  const send = async (id: string, type: string, created: number, o: Record<string, unknown>) => {
    const body = JSON.stringify({ id, type, created, data: { object: { id: "dp_test_1", object: "dispute", amount: 99_900, payment_intent: "pi_test_dp", ...o } } });
    return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": await sig(WH, body) } });
  };
  const due = nowS() + 5 * 86400;
  await send("evt_dp_1", "charge.dispute.created", nowS() - 30, { status: "needs_response", reason: "fraudulent", evidence_details: { due_by: due } });
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM payments WHERE id = 'pay_dp'`)).status, "disputed");
  await send("evt_dp_2", "charge.dispute.updated", nowS() - 20, { status: "under_review", reason: null, evidence_details: {} });
  const d = await one<{ status: string; reason: string; evidence_due_by: string }>(t.db, `SELECT status, reason, evidence_due_by FROM disputes WHERE stripe_dispute_id = 'dp_test_1'`);
  assert.equal(d.status, "under_review");
  assert.equal(d.reason, "fraudulent", "reason kept when an update omits it");
  assert.equal(d.evidence_due_by, new Date(due * 1000).toISOString(), "deadline kept");
  await send("evt_dp_3", "charge.dispute.closed", nowS() - 10, { status: "won" });
  assert.equal((await one<{ status: string }>(t.db, `SELECT status FROM payments WHERE id = 'pay_dp'`)).status, "succeeded", "won dispute restores the payment");
  assert.deepEqual((await t.db.prepare(`SELECT action FROM audit_logs WHERE subject_type = 'dispute' ORDER BY id`).all<{ action: string }>()).results.map((x) => x.action), ["dispute.opened", "dispute.updated", "dispute.closed"]);
});

// ───────────── FIN-002: AI cost attribution through leads/quotes ─────────────

test("[FIN-002] AI costs on a lead or quote are attributed to the project it converts into (also retroactively); ambiguous or unconverted stays company-wide; unknown stays unknown", async () => {
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner");
  const cu = await createCustomer(t.db, "ai-attr@example.com", "AI Attr Co");
  const at = iso(-600);
  const seedLead = async (id: string) => {
    await t.db.prepare(`INSERT INTO contacts (id, name, created_at) VALUES (?, 'C', ?)`).bind(`ct_${id}`, at).run();
    await t.db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES (?, ?, 'web_form', 'qualified', ?, ?)`).bind(id, `ct_${id}`, at, at).run();
  };
  const convert = async (lead: string, prj: string) => {
    await t.db.prepare(`INSERT INTO orders (id, organization_id, total_cents, status, kind, lead_id, created_at) VALUES (?, ?, 99900, 'paid', 'package', ?, ?)`).bind(`ord_${prj}`, cu.organizationId, lead, at).run();
    await t.db.prepare(`INSERT INTO projects (id, organization_id, order_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?,?,?, 'design', 2, 'upfront', ?, ?)`).bind(prj, cu.organizationId, `ord_${prj}`, `TEST ${prj}`, at, at).run();
    await t.db.prepare(`INSERT INTO invoices (id, organization_id, order_id, project_id, milestone_kind, amount_cents, status, created_at, paid_at) VALUES (?,?,?,?, 'full', 99900, 'paid', ?, ?)`).bind(`inv_${prj}`, cu.organizationId, `ord_${prj}`, prj, at, at).run();
  };
  const job = async (id: string, ref: string, cost: number | null) => t.db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, cost_microusd, created_at, updated_at) VALUES (?, 'lead_qualification', 'anthropic', 'claude-sonnet-5-5', 'approved', ?, ?, ?, ?)`).bind(id, ref, cost, at, at).run();
  await seedLead("ld_conv"); await seedLead("ld_late"); await seedLead("ld_two"); await seedLead("ld_never");
  await convert("ld_conv", "prj_conv");
  await t.db.prepare(`INSERT INTO quotes (id, lead_id, status, created_by, created_at) VALUES ('qt_conv', 'ld_conv', 'accepted', ?, ?)`).bind(owner.id, at).run();
  await convert("ld_two", "prj_two_a"); await convert("ld_two", "prj_two_b");
  await job("ai_conv", "lead:ld_conv", 120_000);        // 12 cents → prj_conv
  await job("ai_quote", "quote:qt_conv", 30_000);       // 3 cents → prj_conv via the quote's lead
  await job("ai_late", "lead:ld_late", 50_000);         // not converted yet → unattributed, moved later
  await job("ai_late_unknown", "lead:ld_late", null);   // unknown cost, moved later, stays unknown
  await job("ai_two", "lead:ld_two", 70_000);           // two projects → ambiguous → unattributed
  await job("ai_never", "lead:ld_never", 10_000);       // never converts
  const r1 = await runCostImport(t.db, t.env);
  assert.equal(r1.aiImported, 6);
  assert.equal(r1.aiUnattributed, 4);
  const projectOf = async (job: string) => (await one<{ project_id: string | null }>(t.db, `SELECT project_id FROM cost_imports WHERE source = 'ai_job' AND source_id = ?`, job)).project_id;
  assert.equal(await projectOf("ai_conv"), "prj_conv");
  assert.equal(await projectOf("ai_quote"), "prj_conv");
  assert.equal(await projectOf("ai_late"), null);
  let p = (await projectProfitability(t.db, "prj_conv"))[0];
  assert.equal(p.knownByCategory.ai_usage, 15);
  assert.equal(p.profitCents, 99_900 - 15, "AI cost is part of project profitability");

  // ld_late converts; the next run moves its AI costs onto the project without changing amounts.
  await convert("ld_late", "prj_late");
  const r2 = await runCostImport(t.db, t.env);
  assert.equal(r2.aiImported, 0, "no re-import");
  assert.equal(r2.aiReattributed, 2);
  assert.equal(await projectOf("ai_late"), "prj_late");
  const moved = (await t.db.prepare(`SELECT amount_cents, description FROM project_costs WHERE project_id = 'prj_late' ORDER BY amount_cents`).all<{ amount_cents: number | null; description: string }>()).results;
  assert.deepEqual(moved.map((m) => m.amount_cents), [null, 5]);
  assert.match(moved[1].description, /attributed via lead:ld_late/);
  p = (await projectProfitability(t.db, "prj_late"))[0];
  assert.equal(p.profitCents, null, "unknown AI cost keeps profit incomplete, never $0");
  assert.equal(p.knownByCategory.ai_usage, 5);
  assert.equal(await projectOf("ai_two"), null, "ambiguous lead stays unattributed");
  assert.equal(await projectOf("ai_never"), null);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'finance.cost_reattributed'`), 2);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM project_costs WHERE category = 'ai_usage'`), 6, "no duplicate cost rows");
  assert.equal((await runCostImport(t.db, t.env)).aiReattributed, 0, "idempotent");
});

// ───────────── Owner finance modules: search, filters, pagination and CSV from persisted rows ─────────────

test("[FIN-004] Owner finance lists (invoices, subscriptions, refunds, disputes, profitability) have search, filters and CSV export of exactly the filtered records", async () => {
  const t = await createTestApp();
  const owner = await login(t, "owner");
  const a = await createCustomer(t.db, "own-a@example.com", "Alder Bakery");
  const b = await createCustomer(t.db, "own-b@example.com", "Birch Dental");
  const at = iso(-60);
  await t.db.batch([
    t.db.prepare(`INSERT INTO invoices (id, organization_id, milestone_kind, amount_cents, status, description, created_at) VALUES ('inv_o_a', ?, 'full', 123400, 'open', 'Alder website', ?)`).bind(a.organizationId, at),
    t.db.prepare(`INSERT INTO invoices (id, organization_id, milestone_kind, amount_cents, status, description, created_at, paid_at) VALUES ('inv_o_b', ?, 'change_order', 5600, 'paid', 'Birch change', ?, ?)`).bind(b.organizationId, at, at),
    t.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES ('pay_o_b', ?, 'inv_o_b', 5600, 'pi_test_o_b', 'succeeded', ?)`).bind(b.organizationId, at),
    t.db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, status, stripe_subscription_id, created_at, updated_at) VALUES ('sub_o_a', ?, 'essential', 'active', 'sub_test_alder', ?, ?)`).bind(a.organizationId, at, at),
    t.db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, status, stripe_subscription_id, created_at, updated_at) VALUES ('sub_o_b', ?, 'professional', 'past_due', 'sub_test_birch', ?, ?)`).bind(b.organizationId, at, at),
    t.db.prepare(`INSERT INTO refunds (id, organization_id, payment_id, amount_cents, reason, status, requested_by, created_at) VALUES ('rf_o_b', ?, 'pay_o_b', 5600, 'Duplicate change order charge', 'requested', ?, ?)`).bind(b.organizationId, b.id, at),
    t.db.prepare(`INSERT INTO disputes (id, organization_id, payment_id, stripe_dispute_id, amount_cents, reason, status, created_at, updated_at) VALUES ('dsp_o_b', ?, 'pay_o_b', 'dp_test_birch', 5600, 'fraudulent', 'needs_response', ?, ?)`).bind(b.organizationId, at, at),
    t.db.prepare(`INSERT INTO disputes (id, organization_id, stripe_dispute_id, amount_cents, reason, status, created_at, updated_at) VALUES ('dsp_o_old', ?, 'dp_test_old', 100, 'duplicate', 'won', ?, ?)`).bind(a.organizationId, at, at),
    t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES ('prj_o_a', ?, 'Alder site', 'design', 2, 'upfront', ?, ?)`).bind(a.organizationId, at, at),
    t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES ('prj_o_b', ?, 'Birch portal', 'development', 2, 'upfront', ?, ?)`).bind(b.organizationId, at, at),
    t.db.prepare(`INSERT INTO project_costs (id, project_id, category, amount_cents, description, incurred_on) VALUES ('cost_o_b', 'prj_o_b', 'hosting', NULL, 'Hosting (unknown)', '2026-10-01')`),
  ]);
  const csvRows = async (path: string) => {
    const r = await owner.c.get(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("content-type"), "text/csv; charset=utf-8", path);
    assert.match(r.headers.get("content-disposition")!, /^attachment; filename="crestmont-/);
    return (await r.text()).trim().split("\r\n");
  };
  // Invoices: search + type filter; CSV mirrors the filter.
  const inv = await (await owner.c.get("/staff/finance/invoices?q=Birch")).text();
  assert.match(inv, /Birch change/);
  assert.doesNotMatch(inv, /Alder website/);
  assert.match(inv, /data-csv/);
  assert.doesNotMatch(await (await owner.c.get("/staff/finance/invoices?kind=full")).text(), /Birch change/);
  const ic = await csvRows("/staff/finance/invoices?q=Birch&format=csv");
  assert.equal(ic.length, 2);
  assert.match(ic[1], /^inv_o_b,.*,Birch Dental,change_order,Birch change,5600,56\.00,paid,5600,/);
  // Subscriptions
  assert.doesNotMatch(await (await owner.c.get("/staff/finance/subscriptions?q=alder")).text(), /Birch Dental/);
  const sc = await csvRows("/staff/finance/subscriptions?status=past_due&format=csv");
  assert.equal(sc.length, 2);
  assert.match(sc[1], /^sub_o_b,Birch Dental,professional,past_due,/);
  // Refunds (support-visible queue)
  assert.match(await (await owner.c.get("/staff/refunds?q=Duplicate")).text(), /Birch Dental/);
  assert.doesNotMatch(await (await owner.c.get("/staff/refunds?q=nomatch")).text(), /Birch Dental/);
  const rc = await csvRows("/staff/refunds?format=csv");
  assert.equal(rc.length, 2);
  assert.match(rc[1], /^rf_o_b,/);
  // Disputes: state filter, KPIs from rows, CSV
  const dp = await (await owner.c.get("/staff/disputes?state=open")).text();
  assert.match(dp, /dp_test_birch/);
  assert.doesNotMatch(dp, /dp_test_old/);
  assert.match(dp, /Open disputes<\/div><div class="kpi__value">1</);
  const dc = await csvRows("/staff/disputes?state=closed&format=csv");
  assert.equal(dc.length, 2);
  assert.match(dc[1], /dp_test_old/);
  // Profitability: filter by completeness; Unknown never $0; CSV with per-category columns.
  const pf = await (await owner.c.get("/staff/finance/profitability?profit=incomplete")).text();
  assert.match(pf, /Birch portal/);
  assert.match(pf, /href="\/staff\/projects\/prj_o_b"/);
  assert.doesNotMatch(pf, /href="\/staff\/projects\/prj_o_a"/);
  const pc = await csvRows("/staff/finance/profitability?q=birch&format=csv");
  assert.equal(pc.length, 2);
  assert.match(pc[0], /ai_usage_cents/);
  assert.match(pc[1], /incomplete_unknown_costs$/);
  // Exports are audited; staff without finance.read cannot export.
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM audit_logs WHERE action = 'finance.exported' AND actor_user_id = ?`, owner.id), 5);
  const sales = await login(t, "sales");
  assert.equal((await sales.c.get("/staff/finance/invoices?format=csv")).status, 403);
  assert.equal((await sales.c.get("/staff/disputes?format=csv")).status, 403);
});
