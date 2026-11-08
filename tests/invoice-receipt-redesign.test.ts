// Phase 8: redesigned invoices and receipts. Sequential customer-facing numbers ("Invoice 001", "Receipt 001")
// allocated atomically and never renumbered; no internal or Stripe identifiers on customer documents; the required
// invoice and receipt content; refund/dispute status; tax only when configured; PDF download, layout (no clipping,
// page breaks) and the receipt email's link. All records are TEST DATA; Stripe is never called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, createStaff, createCustomer, lastEmail, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { openDb, MIGRATIONS_DIR } from "../dev/sqlite-d1.ts";
import type { Env } from "../src/app/context.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";
import { textWidth } from "../src/lib/pdf.ts";
import { ensureInvoiceNumber, ensureReceipt, formatDocNumber, invoiceLabel, receiptLabel, longDate } from "../src/services/document-numbers.ts";
import { loadInvoiceDoc, invoicePdf, receiptPdf } from "../src/services/finance-documents.ts";
import { loadReceipt } from "../src/services/receipts.ts";
import { createPackageOrder } from "../src/services/commerce.ts";
import { computeTax } from "../src/domain/tax.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";

type Db = Env["DB"];
const one = async <T>(db: Db, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<T>())!;
const all = async <T>(db: Db, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<T>()).results;
const iso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString();
/** Internal and Stripe identifier shapes that must never be printed on a customer document. */
const TECH_ID = /\b(?:pi|ch|cs|pay|inv|ord)_[A-Za-z0-9]/;

// ───────────── PDF text and layout extraction (the writer emits one "BT … Tj ET" per text run) ─────────────

interface Run { page: number; text: string; x: number; y: number; size: number; bold: boolean; cs: number }
const BACK: Record<number, string> = { 0x96: "–", 0x97: "—", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x85: "…", 0x80: "€" };
function decode(s: string) {
  return s.replace(/\\([0-7]{3})|\\(.)/g, (_m, o, c) => (o ? BACK[parseInt(o, 8)] ?? String.fromCharCode(parseInt(o, 8)) : c));
}
function pdfRuns(bytes: Uint8Array): { runs: Run[]; pages: number; raw: string } {
  const raw = Buffer.from(bytes).toString("latin1");
  assert.ok(raw.startsWith("%PDF-1.4\n"), "valid %PDF header");
  assert.ok(raw.endsWith("%%EOF\n"), "ends with %%EOF");
  const streams = [...raw.matchAll(/<< \/Length (\d+) >>\nstream\n/g)].map((m) => raw.slice(m.index! + m[0].length, m.index! + m[0].length + Number(m[1])));
  const runs: Run[] = [];
  streams.forEach((content, page) => {
    // Character spacing (Tc) is graphics state: it carries over to later text runs on the same page until reset.
    let cs = 0;
    for (const m of content.matchAll(/BT \/F(\d) ([\d.]+) Tf (?:([\d.-]+) Tc )?[\d. ]+ rg ([\d.-]+) ([\d.-]+) Td \(((?:\\[0-7]{3}|\\.|[^\\)])*)\) Tj ET/g)) {
      if (m[3] !== undefined) cs = Number(m[3]);
      runs.push({ page, bold: m[1] === "2", size: Number(m[2]), cs, x: Number(m[4]), y: Number(m[5]), text: decode(m[6]) });
    }
  });
  const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(raw)![1]);
  assert.equal(streams.length, pages, "one content stream per page");
  return { runs, pages, raw };
}
const pdfText = (bytes: Uint8Array) => pdfRuns(bytes).runs.map((r) => r.text);

/** No text run extends past the side margins or into the top/bottom edge: nothing is clipped. */
function assertNoClipping(bytes: Uint8Array, label: string) {
  const { runs } = pdfRuns(bytes);
  for (const r of runs) {
    const w = textWidth(r.text, r.size, r.bold, r.cs);
    assert.ok(r.x >= 53.5, `${label}: "${r.text.slice(0, 40)}" starts inside the left margin (x=${r.x})`);
    assert.ok(r.x + w <= 612 - 53.5, `${label}: "${r.text.slice(0, 40)}" ends inside the right margin (x+w=${(r.x + w).toFixed(1)})`);
    assert.ok(r.y >= 30 && r.y <= 792 - 24, `${label}: "${r.text.slice(0, 40)}" is on the page vertically (y=${r.y})`);
  }
}
const visibleHtml = (h: string) => h.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');

// ───────────── fixtures ─────────────

async function customer(t: { db: Db; client: () => TestClient }, email: string, org: string) {
  const cu = await createCustomer(t.db, email, org);
  const c = t.client(); await c.login(cu.email);
  return { ...cu, c };
}
async function staff(t: { db: Db; client: () => TestClient }, role: Parameters<typeof createStaff>[1]) {
  const s = await createStaff(t.db, role);
  const c = t.client(); await c.login(s.email, TEST_PASSWORD, s.secret);
  return { ...s, c };
}
/** A package order with a paid invoice and its Stripe payment, all written the way the webhook writes them. */
async function paidInvoice(db: Db, orgId: string, p: string, amount = 249_900, opts: { taxDetail?: string | null; subtotal?: number | null; at?: string } = {}) {
  const at = opts.at ?? iso(-3600);
  await db.batch([
    db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?,?,'business',?,'paid','package',?)`).bind(`ord_${p}`, orgId, amount, at),
    db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, subtotal_cents, tax_detail_json, status, description, created_at, paid_at, stripe_checkout_session_id) VALUES (?,?,?,'full',?,?,?,'paid','Payment in full',?,?,?)`)
      .bind(`inv_${p}`, orgId, `ord_${p}`, amount, opts.subtotal ?? null, opts.taxDetail ?? null, at, at, `cs_test_${p}`),
    db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, order_id, amount_cents, stripe_payment_intent_id, stripe_charge_id, status, created_at) VALUES (?,?,?,?,?,?,?, 'succeeded', ?)`)
      .bind(`pay_${p}`, orgId, `inv_${p}`, `ord_${p}`, amount, `pi_test_${p}`, `ch_test_${p}`, at),
  ]);
  return { inv: `inv_${p}`, pay: `pay_${p}`, ord: `ord_${p}`, pi: `pi_test_${p}` };
}
const SETTINGS = { "business.legal_name": "Talent Revenue Systems LLC" };

// ───────────── 8.3 numbering ─────────────

test("[PAY-005] Phase 8.3: migration 0100 backfills historical invoices and receipts once, in created_at order; new documents continue each sequence; numbers never change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crestmont-docnum-"));
  const file = join(dir, "db.sqlite");
  try {
    // A database as it stood before migration 0100, with historical records.
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA foreign_keys = ON;");
    raw.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL)`);
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && f < "0100").sort()) {
      raw.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      raw.prepare(`INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)`).run(f, new Date().toISOString());
    }
    raw.exec(`INSERT INTO organizations (id, name, kind, created_at) VALUES ('org_hist', 'Historic Co (TEST)', 'customer', '2026-01-01T00:00:00Z')`);
    // Inserted out of date order on purpose: numbering follows created_at, not insertion.
    const invs: [string, string, string][] = [["inv_h_c", "paid", "2026-03-01T00:00:00Z"], ["inv_h_a", "paid", "2026-01-05T00:00:00Z"], ["inv_h_draft", "draft", "2026-01-06T00:00:00Z"], ["inv_h_b", "open", "2026-02-01T00:00:00Z"], ["inv_h_void", "void", "2026-02-10T00:00:00Z"]];
    for (const [id, status, at] of invs) raw.prepare(`INSERT INTO invoices (id, organization_id, milestone_kind, amount_cents, status, description, created_at) VALUES (?, 'org_hist', 'full', 10000, ?, 'Historic', ?)`).run(id, status, at);
    const pays: [string, string, string, string, string][] = [["pay_h_3", "inv_h_c", "succeeded", "stripe", "2026-03-02T00:00:00Z"], ["pay_h_1", "inv_h_a", "refunded", "stripe", "2026-01-06T00:00:00Z"],
      ["pay_h_failed", "inv_h_b", "failed", "stripe", "2026-02-02T00:00:00Z"], ["pay_h_sim", "inv_h_b", "succeeded", "simulated", "2026-02-03T00:00:00Z"], ["pay_h_2", "inv_h_b", "disputed", "stripe", "2026-02-04T00:00:00Z"]];
    for (const [id, inv, status, provider, at] of pays) raw.prepare(`INSERT INTO payments (id, organization_id, invoice_id, amount_cents, status, provider, created_at) VALUES (?, 'org_hist', ?, 10000, ?, ?, ?)`).run(id, inv, status, provider, at);
    // pay_h_3 was viewed before Phase 8, so it already holds receipt seq 1 (CWD-R-000001): it must keep it.
    raw.exec(`INSERT INTO receipts (payment_id, receipt_number, organization_id, created_at) VALUES ('pay_h_3', 'CWD-R-000001', 'org_hist', '2026-03-03T00:00:00Z')`);
    raw.close();

    const db = openDb(file); // applies 0100 exactly as a deployment would
    const nums = Object.fromEntries((await all<{ id: string; invoice_number: number | null }>(db, `SELECT id, invoice_number FROM invoices`)).map((r) => [r.id, r.invoice_number]));
    assert.deepEqual(nums, { inv_h_a: 1, inv_h_b: 2, inv_h_void: 3, inv_h_c: 4, inv_h_draft: null }, "issued invoices numbered by created_at; drafts unnumbered");
    assert.equal((await one<{ last_value: number }>(db, `SELECT last_value FROM document_counters WHERE kind = 'invoice'`)).last_value, 4);
    const rc = Object.fromEntries((await all<{ payment_id: string; seq: number; receipt_number: string }>(db, `SELECT payment_id, seq, receipt_number FROM receipts`)).map((r) => [r.payment_id, [r.seq, r.receipt_number]]));
    assert.deepEqual(rc, { pay_h_3: [1, "CWD-R-000001"], pay_h_1: [2, "CWD-R-000002"], pay_h_2: [3, "CWD-R-000003"] }, "existing receipt kept; others numbered by payment date; failed and simulated payments get none");

    // New documents continue each sequence from the backfill.
    await db.prepare(`INSERT INTO invoices (id, organization_id, milestone_kind, amount_cents, status, created_at) VALUES ('inv_new1', 'org_hist', 'full', 500, 'open', ?)`).bind(iso()).run();
    await db.prepare(`INSERT INTO invoices (id, organization_id, milestone_kind, amount_cents, status, created_at) VALUES ('inv_new_draft', 'org_hist', 'change_order', 500, 'draft', ?)`).bind(iso()).run();
    assert.equal((await one<{ n: number | null }>(db, `SELECT invoice_number n FROM invoices WHERE id = 'inv_new_draft'`)).n, null, "a draft has no number");
    await db.prepare(`UPDATE invoices SET status = 'open' WHERE id = 'inv_new_draft'`).run(); // issued
    assert.equal(await ensureInvoiceNumber(db, "inv_new1"), 5);
    assert.equal(await ensureInvoiceNumber(db, "inv_new_draft"), 6, "numbered when issued, not when drafted");
    await db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, amount_cents, status, created_at) VALUES ('pay_new', 'org_hist', 'inv_new1', 500, 'succeeded', ?)`).bind(iso()).run();
    assert.deepEqual(await ensureReceipt(db, "pay_new"), { seq: 4, legacyNumber: "CWD-R-000004" }, "a recorded payment gets the next receipt number at once");

    // Rendering, re-rendering and status changes never renumber; an issued number cannot be overwritten.
    const before = await loadInvoiceDoc(db, "inv_h_b", null);
    await db.prepare(`UPDATE invoices SET status = 'paid' WHERE id = 'inv_h_b'`).run();
    await db.prepare(`UPDATE payments SET status = 'succeeded' WHERE id = 'pay_h_2'`).run();
    const after = await loadInvoiceDoc(db, "inv_h_b", null);
    assert.equal(before.label, "Invoice 002");
    assert.equal(after.label, "Invoice 002");
    assert.equal((await loadReceipt(db, "pay_h_2", null)).receiptLabel, "Receipt 003");
    assert.throws(() => (db as ReturnType<typeof openDb>).raw.prepare(`UPDATE invoices SET invoice_number = 99 WHERE id = 'inv_h_a'`).run(), /permanent/);
    assert.throws(() => (db as ReturnType<typeof openDb>).raw.prepare(`UPDATE receipts SET seq = 99 WHERE payment_id = 'pay_h_1'`).run(), /permanent/);
    // Internal keys and Stripe links are untouched by numbering.
    assert.equal((await one<{ n: number }>(db, `SELECT COUNT(*) n FROM invoices WHERE id LIKE 'inv\\_%' ESCAPE '\\'`)).n, 7);
    db.raw.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[PAY-005] Phase 8.3: concurrent allocation: every document gets exactly one number, numbers are unique and contiguous, and repeated calls never consume a number", async () => {
  const t = await createTestApp();
  const cu = await createCustomer(t.db, "conc@docnum.example", "Concurrency Co (TEST)");
  const start = (await one<{ last_value: number }>(t.db, `SELECT last_value FROM document_counters WHERE kind = 'invoice'`)).last_value;
  const N = 40;
  const ids = Array.from({ length: N }, (_, i) => `inv_conc_${i}`);
  for (const id of ids) await t.db.prepare(`INSERT INTO invoices (id, organization_id, milestone_kind, amount_cents, status, created_at) VALUES (?,?, 'change_order', 1000, 'draft', ?)`).bind(id, cu.organizationId, iso()).run();
  // Issue all of them at once while other requests lazily ask for the same numbers (three callers per invoice).
  await Promise.all(ids.flatMap((id) => [
    t.db.prepare(`UPDATE invoices SET status = 'open' WHERE id = ?`).bind(id).run(),
    ensureInvoiceNumber(t.db, id), ensureInvoiceNumber(t.db, id), ensureInvoiceNumber(t.db, id),
  ]));
  const got = (await all<{ invoice_number: number }>(t.db, `SELECT invoice_number FROM invoices WHERE id LIKE 'inv\\_conc\\_%' ESCAPE '\\' ORDER BY invoice_number`)).map((r) => r.invoice_number);
  assert.equal(got.length, N);
  assert.equal(new Set(got).size, N, "no duplicates");
  assert.deepEqual(got, Array.from({ length: N }, (_, i) => start + i + 1), "contiguous: no gaps from double allocation");
  assert.equal((await one<{ last_value: number }>(t.db, `SELECT last_value FROM document_counters WHERE kind = 'invoice'`)).last_value, start + N);
  // Already-numbered documents: many concurrent calls return the same number and consume nothing.
  const again = await Promise.all(ids.slice(0, 10).flatMap((id) => [ensureInvoiceNumber(t.db, id), ensureInvoiceNumber(t.db, id)]));
  assert.deepEqual(again, ids.slice(0, 10).flatMap((_, i) => [start + i + 1, start + i + 1]));
  assert.equal((await one<{ last_value: number }>(t.db, `SELECT last_value FROM document_counters WHERE kind = 'invoice'`)).last_value, start + N);

  // Receipts: payments recorded as failed have none; when they succeed concurrently with lazy lookups, each gets one.
  const rStart = (await one<{ n: number }>(t.db, `SELECT COALESCE(MAX(seq), 0) n FROM receipts`)).n;
  const pids = ids.map((id) => id.replace("inv_", "pay_"));
  for (const [i, pid] of pids.entries()) await t.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, amount_cents, status, created_at) VALUES (?,?,?, 1000, 'failed', ?)`).bind(pid, cu.organizationId, ids[i], iso()).run();
  assert.equal((await one<{ n: number }>(t.db, `SELECT COUNT(*) n FROM receipts WHERE payment_id LIKE 'pay\\_conc\\_%' ESCAPE '\\'`)).n, 0, "failed payments have no receipt");
  await Promise.all(pids.flatMap((pid) => [ensureReceipt(t.db, pid), t.db.prepare(`UPDATE payments SET status = 'succeeded' WHERE id = ?`).bind(pid).run(), ensureReceipt(t.db, pid)]));
  const seqs = (await all<{ seq: number }>(t.db, `SELECT seq FROM receipts WHERE payment_id LIKE 'pay\\_conc\\_%' ESCAPE '\\' ORDER BY seq`)).map((r) => r.seq);
  assert.equal(seqs.length, N, "one receipt per payment");
  assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => rStart + i + 1), "unique and contiguous");
  // Formatting: at least three digits, growing past 999.
  assert.deepEqual([formatDocNumber(1), formatDocNumber(42), formatDocNumber(999), formatDocNumber(1000)], ["001", "042", "999", "1000"]);
  assert.equal(invoiceLabel(7), "Invoice 007");
  assert.equal(receiptLabel(12), "Receipt 012");
});

// ───────────── 8.2 / 8.4 / 8.5 content ─────────────

test("[PAY-005] Phase 8.4/8.5: invoice and receipt show the required customer-facing fields and no internal or Stripe identifiers (HTML and PDF)", async () => {
  const t = await createTestApp();
  const a = await customer(t, "fields@docnum.example", "Fieldstone Bakery LLC (TEST)");
  const s = await paidInvoice(t.db, a.organizationId, "fld");
  await t.db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, description, created_at, due_at) VALUES ('inv_fld_open', ?, ?, 'change_order', 45000, 'open', 'Extra landing page', ?, '2099-01-15T00:00:00Z')`)
    .bind(a.organizationId, s.ord, iso(-60)).run();
  const invNo = (await one<{ n: number }>(t.db, `SELECT invoice_number n FROM invoices WHERE id = ?`, s.inv)).n;
  const openNo = (await one<{ n: number }>(t.db, `SELECT invoice_number n FROM invoices WHERE id = 'inv_fld_open'`)).n;
  const rcSeq = (await one<{ n: number }>(t.db, `SELECT seq n FROM receipts WHERE payment_id = ?`, s.pay)).n;

  // Paid invoice PDF.
  const res = await a.c.get(`/portal/billing/invoices/${s.inv}/pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), `attachment; filename="crestmont-invoice-${formatDocNumber(invNo)}.pdf"`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const inv = pdfText(bytes);
  const joined = inv.join("\n");
  for (const want of ["CRESTMONT", "WEBSITE DEVELOPMENT", "Crestmont Website Development", "Talent Revenue Systems LLC", "INVOICE", invoiceLabel(invNo), "Invoice number", formatDocNumber(invNo), "Invoice date", longDate(iso(-3600)),
    "Due date", "Fieldstone Bakery LLC (TEST)", "Attn: Pat Customer", "Business website package — Payment in full", "Subtotal", "$2,499.00", "Tax", "No tax applied", "Total", "Amount paid", "Balance due", "$0.00", "Status", "Paid",
    "PAYMENTS RECEIVED", receiptLabel(rcSeq), "Thank you for your business."]) assert.ok(inv.some((x) => x.includes(want)), `invoice PDF shows "${want}"`);
  assert.doesNotMatch(joined, TECH_ID, "no internal or Stripe ids on the invoice PDF");
  assert.doesNotMatch(joined, /CWD-R-/, "no legacy receipt reference");
  assert.equal(inv[inv.indexOf("Balance due") + 1], "$0.00");
  assertNoClipping(bytes, "paid invoice");

  // Open invoice: due date, balance, status and the secure payment link (no internal id in the link).
  const open = pdfText(new Uint8Array(await (await a.c.get(`/portal/billing/invoices/inv_fld_open/pdf`)).arrayBuffer()));
  for (const want of [invoiceLabel(openNo), "January 15, 2099", "Payment due", "HOW TO PAY", "http://crestmont.test/portal/billing", "$450.00"]) assert.ok(open.some((x) => x.includes(want)), `open invoice PDF shows "${want}"`);
  assert.equal(open[open.indexOf("Balance due") + 1], "$450.00");
  assert.doesNotMatch(open.join("\n"), TECH_ID);

  // Receipt PDF.
  const rres = await a.c.get(`/portal/billing/receipts/${s.pay}/pdf`);
  assert.equal(rres.status, 200);
  assert.equal(rres.headers.get("content-type"), "application/pdf");
  assert.equal(rres.headers.get("content-disposition"), `attachment; filename="crestmont-receipt-${formatDocNumber(rcSeq)}.pdf"`);
  const rbytes = new Uint8Array(await rres.arrayBuffer());
  const rc = pdfText(rbytes);
  for (const want of ["RECEIPT", receiptLabel(rcSeq), "Receipt number", "RECEIVED FROM", "Fieldstone Bakery LLC (TEST)", "Payment date", longDate(iso(-3600)), "AMOUNT PAID", "$2,499.00 USD", "Business website package — Payment in full",
    "Total paid", "Payment method", "Online payment through Stripe secure checkout", "Payment status", "Paid", "Associated invoice", invoiceLabel(invNo), "Talent Revenue Systems LLC"]) assert.ok(rc.some((x) => x.includes(want)), `receipt PDF shows "${want}"`);
  assert.doesNotMatch(rc.join("\n"), TECH_ID, "no internal or Stripe ids on the receipt PDF");
  assertNoClipping(rbytes, "receipt");

  // HTML: receipt page, invoice page and billing list show the numbers and no ids as visible text.
  const rh = await (await a.c.get(`/portal/billing/receipts/${s.pay}`)).text();
  const rv = visibleHtml(rh);
  for (const want of [receiptLabel(rcSeq), invoiceLabel(invNo), "Received from", "Fieldstone Bakery LLC (TEST)", "Amount paid", "$2,499.00 USD", "Payment method", "Online payment through Stripe secure checkout", "Total paid", "Business website package — Payment in full"])
    assert.ok(rv.includes(want), `receipt page shows "${want}"`);
  assert.doesNotMatch(rv, TECH_ID);
  assert.doesNotMatch(rh, /Technical details/, "customers never get the technical details");
  for (const path of [`/portal/billing/invoices/${s.inv}`, "/portal/billing"]) {
    const v = visibleHtml(await (await a.c.get(path)).text());
    assert.match(v, new RegExp(invoiceLabel(invNo)), `${path} shows the invoice number`);
    assert.doesNotMatch(v, TECH_ID, `${path} shows no internal or Stripe ids`);
  }
  // Staff keep every reference in a collapsed section, and can find the invoice by its number.
  const owner = await staff(t, "owner");
  const sh = await (await owner.c.get(`/staff/finance/receipts/${s.pay}`)).text();
  assert.match(sh, /<details[^>]*data-testid="technical-details"><summary>Technical details/);
  for (const ref of [s.pay, s.pi, `ch_test_fld`, `cs_test_fld`, s.inv, s.ord]) assert.ok(sh.includes(ref), `staff receipt keeps ${ref}`);
  const si = await (await owner.c.get(`/staff/finance/invoices/${s.inv}`)).text();
  assert.match(si, /<details data-testid="technical-details"><summary>Technical details/);
  assert.ok(si.includes(`cs_test_fld`) && si.includes(s.pi) && si.includes(invoiceLabel(invNo)));
  assert.match(await (await owner.c.get(`/staff/finance/invoices?q=${encodeURIComponent(invoiceLabel(invNo))}`)).text(), new RegExp(`href="/staff/finance/invoices/${s.inv}" data-invoice-number`));
  // Staff PDF downloads are the same customer-facing document.
  const staffPdf = await owner.c.get(`/staff/finance/receipts/${s.pay}/pdf`);
  assert.equal(staffPdf.headers.get("content-type"), "application/pdf");
  assert.doesNotMatch(pdfText(new Uint8Array(await staffPdf.arrayBuffer())).join("\n"), TECH_ID);
});

test("[PAY-005] Phase 8.5: a refunded or disputed payment shows that status while the original payment date and amount remain", async () => {
  const t = await createTestApp();
  const a = await customer(t, "refund@docnum.example", "Refundable Co (TEST)");
  const full = await paidInvoice(t.db, a.organizationId, "rff", 100_000, { at: "2026-10-01T15:00:00Z" });
  const part = await paidInvoice(t.db, a.organizationId, "rfp", 100_000, { at: "2026-10-02T15:00:00Z" });
  const disp = await paidInvoice(t.db, a.organizationId, "rfd", 100_000, { at: "2026-10-03T15:00:00Z" });
  const refund = (id: string, pay: string, amount: number) => t.db.prepare(`INSERT INTO refunds (id, organization_id, payment_id, amount_cents, reason, status, requested_by, created_at, issued_at) VALUES (?,?,?,?, 'Test refund (TEST DATA)', 'issued', ?, ?, ?)`)
    .bind(id, a.organizationId, pay, amount, a.id, "2026-10-20T10:00:00Z", "2026-10-21T10:00:00Z").run();
  await refund("rf_full", full.pay, 100_000);
  await t.db.prepare(`UPDATE payments SET status = 'refunded' WHERE id = ?`).bind(full.pay).run();
  await refund("rf_part", part.pay, 25_000);
  await t.db.prepare(`UPDATE payments SET status = 'partially_refunded' WHERE id = ?`).bind(part.pay).run();
  await t.db.prepare(`INSERT INTO disputes (id, organization_id, payment_id, stripe_dispute_id, amount_cents, reason, status, created_at, updated_at) VALUES ('dp_1', ?, ?, 'du_test_1', 100000, 'fraudulent', 'needs_response', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z')`)
    .bind(a.organizationId, disp.pay).run();
  await t.db.prepare(`UPDATE payments SET status = 'disputed' WHERE id = ?`).bind(disp.pay).run();

  const cases: [string, string, string[]][] = [
    [full.pay, "Refunded", ["October 1, 2026", "Refunded October 21, 2026", "-$1,000.00", "Net amount after refunds", "$0.00", "refunded in full"]],
    [part.pay, "Partially refunded", ["October 2, 2026", "Refunded October 21, 2026", "-$250.00", "Net amount after refunds", "$750.00"]],
    [disp.pay, "Disputed", ["October 3, 2026", "payment dispute", "disputed on October 25, 2026"]],
  ];
  for (const [pay, status, extra] of cases) {
    const bytes = new Uint8Array(await (await a.c.get(`/portal/billing/receipts/${pay}/pdf`)).arrayBuffer());
    const text = pdfText(bytes);
    const joined = text.join("\n");
    assert.ok(text.includes(status), `${status}: receipt PDF shows the status`);
    assert.ok(text.includes("$1,000.00 USD"), `${status}: the original amount paid is unchanged`);
    assert.ok(text.some((x) => x.includes("This payment was received on")), `${status}: the payment is still stated as received`);
    for (const w of extra) assert.ok(joined.includes(w), `${status}: receipt PDF shows "${w}"`);
    assertNoClipping(bytes, `${status} receipt`);
    const h = visibleHtml(await (await a.c.get(`/portal/billing/receipts/${pay}`)).text());
    assert.ok(h.includes(status) && h.includes("$1,000.00 USD") && h.includes("This payment was received on"), `${status}: receipt page shows status, amount and the fact of payment`);
  }
  // The invoice tells the same story.
  const full_inv = pdfText(new Uint8Array(await (await a.c.get(`/portal/billing/invoices/${full.inv}/pdf`)).arrayBuffer()));
  assert.ok(full_inv.includes("Paid — refunded") && full_inv.includes("Refunded") && full_inv.includes("-$1,000.00"));
  assert.equal(full_inv[full_inv.indexOf("Amount paid") + 1], "$1,000.00", "the payment still counts as paid on the invoice");
  const disp_inv = pdfText(new Uint8Array(await (await a.c.get(`/portal/billing/invoices/${disp.inv}/pdf`)).arrayBuffer()));
  assert.ok(disp_inv.includes("Paid — payment disputed"));
});

test("[PAY-005] Phase 8.4: tax appears only when it was configured at issue; otherwise the document says no tax was applied and invents nothing", async () => {
  const t = await createTestApp();
  const a = await customer(t, "tax@docnum.example", "Taxless & Taxed Co (TEST)");
  const plain = await paidInvoice(t.db, a.organizationId, "txn", 100_000);
  const detail = computeTax([{ description: "Payment in full", amountCents: 100_000, productKey: "business" }],
    { registered: true, stripeTaxPlanned: false, rates: [{ jurisdictionId: "txj_s", name: "Test State", registrationId: "TS-1", ratePpm: 62_500 }], taxable: new Set(["business"]) });
  const taxed = await paidInvoice(t.db, a.organizationId, "txy", detail.totalCents, { taxDetail: JSON.stringify(detail), subtotal: detail.subtotalCents });

  const p = pdfText(new Uint8Array(await (await a.c.get(`/portal/billing/invoices/${plain.inv}/pdf`)).arrayBuffer()));
  assert.ok(p.includes("No tax applied") && p.some((x) => x.includes("No tax has been applied")));
  assert.ok(!p.some((x) => /Sales tax|registration/i.test(x)), "no tax line, rate or registration is invented");
  assert.equal(p[p.indexOf("Subtotal") + 1], "$1,000.00");
  assert.equal(p[p.indexOf("Total") + 1], "$1,000.00");

  const q = pdfText(new Uint8Array(await (await a.c.get(`/portal/billing/invoices/${taxed.inv}/pdf`)).arrayBuffer()));
  assert.ok(!q.includes("No tax applied"));
  assert.ok(q.includes("Sales tax — Test State (6.25%)"));
  assert.equal(q[q.indexOf("Sales tax — Test State (6.25%)") + 1], "$62.50");
  assert.equal(q[q.indexOf("Subtotal") + 1], "$1,000.00");
  assert.equal(q[q.indexOf("Total") + 1], "$1,062.50");
  assert.ok(q.some((x) => x.includes("Registrations: Test State TS-1")));
  const r = pdfText(new Uint8Array(await (await a.c.get(`/portal/billing/receipts/${taxed.pay}/pdf`)).arrayBuffer()));
  assert.ok(r.includes("Includes Sales tax — Test State (6.25%)"));
  const rp = pdfText(new Uint8Array(await (await a.c.get(`/portal/billing/receipts/${plain.pay}/pdf`)).arrayBuffer()));
  assert.ok(!rp.some((x) => /Sales tax/.test(x)), "an untaxed receipt says nothing about tax");
});

// ───────────── 8.6 layout ─────────────

test("[PAY-005] Phase 8.6: long customer names and many line items wrap and paginate without clipping; headers, footers and totals stay intact", async () => {
  const t = await createTestApp();
  const longName = "The Extraordinarily Long Named Regional Plumbing, Heating, Air Conditioning and Emergency Drain Services Cooperative of Greater Northeastern Testville Incorporated (TEST DATA)";
  const a = await customer(t, "long@docnum.example", longName);
  const at = iso(-7200);
  const lines = Array.from({ length: 70 }, (_, i) => ({ description: `Line item ${i + 1}: custom component with a deliberately long description so that it has to wrap within its table cell (TEST DATA)`, amountCents: 10_000 + i }));
  const total = lines.reduce((s, l) => s + l.amountCents, 0);
  const owner = await createStaff(t.db, "owner");
  await t.db.batch([
    t.db.prepare(`INSERT INTO contacts (id, name, email, created_at) VALUES ('ct_long', 'Long Contact', 'long@contact.example', ?)`).bind(at),
    t.db.prepare(`INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at) VALUES ('ld_long', 'ct_long', 'quote_form', 'converted', ?, ?)`).bind(at, at),
    t.db.prepare(`INSERT INTO quotes (id, lead_id, status, current_version, created_by, created_at) VALUES ('qt_long', 'ld_long', 'accepted', 1, ?, ?)`).bind(owner.id, at),
    t.db.prepare(`INSERT INTO quote_versions (id, quote_id, version, line_items_json, total_cents, payment_schedule, scope_text, created_at) VALUES ('qv_long', 'qt_long', 1, ?, ?, 'milestone_50_25_25', 'Scope (TEST DATA)', ?)`).bind(JSON.stringify({ lines, installments: [] }), total, at),
    t.db.prepare(`INSERT INTO orders (id, organization_id, quote_version_id, product_id, total_cents, status, kind, lead_id, created_at) VALUES ('ord_long', ?, 'qv_long', 'custom', ?, 'partially_paid', 'quote', 'ld_long', ?)`).bind(a.organizationId, total, at),
    t.db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, description, created_at) VALUES ('inv_long', ?, 'ord_long', 'deposit_50', ?, 'open', '50% deposit', ?)`).bind(a.organizationId, Math.round(total / 2), at),
  ]);
  const res = await a.c.get(`/portal/billing/invoices/inv_long/pdf`);
  assert.equal(res.status, 200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { runs, pages } = pdfRuns(bytes);
  assert.ok(pages >= 3, `70 wrapped line items paginate (${pages} pages)`);
  assertNoClipping(bytes, "long invoice");
  // The long name wraps onto several lines inside its column (never one run running off the page).
  const nameRuns = runs.filter((r) => r.page === 0 && r.size === 12 && r.bold && longName.includes(r.text));
  assert.ok(nameRuns.length >= 3, `customer name wraps (${nameRuns.length} lines)`);
  assert.equal(nameRuns.map((r) => r.text).join(" "), longName, "and nothing is lost");
  assert.ok(nameRuns.every((r) => r.x + textWidth(r.text, r.size, true) <= 54 + 250 + 0.5), "inside its column, clear of the invoice facts");
  // Every item is present; each long description wraps; the table header repeats on each page it continues onto.
  for (const i of [1, 35, 70]) assert.ok(runs.some((r) => r.text.startsWith(`Line item ${i}:`)), `item ${i} present`);
  assert.ok(runs.filter((r) => r.text.startsWith("Line item 70:"))[0].text.length < lines[69].description.length, "long cells wrap");
  const itemPages = new Set(runs.filter((r) => r.text.startsWith("Line item")).map((r) => r.page));
  for (const pg of itemPages) assert.ok(runs.some((r) => r.page === pg && r.text === "QUOTED ITEM"), `table header repeated on page ${pg + 1}`);
  // Footer on every page; continuation header from page 2; body text never runs into the footer.
  for (let pg = 0; pg < pages; pg++) {
    assert.ok(runs.some((r) => r.page === pg && r.text.endsWith(`Page ${pg + 1} of ${pages}`)), `footer page number on page ${pg + 1}`);
    if (pg > 0) assert.ok(runs.some((r) => r.page === pg && r.text.endsWith("(continued)")), `continuation header on page ${pg + 1}`);
    const body = runs.filter((r) => r.page === pg && r.y > 45);
    assert.ok(body.every((r) => r.y >= 60), `page ${pg + 1}: body text stays above the footer rule`);
  }
  // The totals block is kept together on one page.
  const tPage = runs.find((r) => r.text === "Subtotal")!.page;
  assert.equal(runs.find((r) => r.text === "Balance due")!.page, tPage, "totals are not split across pages");
  // Rendering the same document twice gives the same number.
  const d1 = await loadInvoiceDoc(t.db, "inv_long", a.organizationId);
  const d2 = await loadInvoiceDoc(t.db, "inv_long", a.organizationId);
  assert.equal(d1.label, d2.label);
  assert.ok(pdfText(invoicePdf(d2, SETTINGS, new Date())).includes(d1.label));
  // A long name on the receipt wraps too.
  await t.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, order_id, amount_cents, stripe_payment_intent_id, status, created_at) VALUES ('pay_long', ?, 'inv_long', 'ord_long', 500, 'pi_test_long', 'succeeded', ?)`).bind(a.organizationId, iso()).run();
  const rb = receiptPdf(await loadReceipt(t.db, "pay_long", a.organizationId), SETTINGS, new Date());
  assertNoClipping(rb, "long receipt");
  assert.ok(pdfRuns(rb).runs.filter((r) => r.size === 12 && r.bold && longName.includes(r.text)).length >= 3);
});

// ───────────── 8.6 delivery ─────────────

const WHSEC = "whsec_test_phase8";
class FakePayments implements PaymentsAdapter {
  readonly configured = true; readonly mode = "test" as const;
  async createCheckout(_req: CheckoutRequest) { return { id: "cs_test_p8", url: "https://checkout.stripe.com/c/pay/cs_test_p8" }; }
  async createBillingPortal() { return { url: "https://billing.stripe.com/p/session/test" }; }
  async createRefund() { return { id: "re_test", status: "succeeded" }; }
}

test("[PAY-005] Phase 8.6: the receipt email from the verified payment names the receipt and invoice numbers and links the receipt and its PDF, which download for the customer", async () => {
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: WHSEC, overrides: { payments: new FakePayments() } });
  const a = await customer(t, "mail@docnum.example", "Mailable Co (TEST)");
  const order = await createPackageOrder(t.db, a.organizationId, "starter", a.id);
  const body = JSON.stringify({ id: "evt_p8_1", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: {
    id: "cs_test_p8", mode: "payment", payment_status: "paid", amount_total: order.amountCents, payment_intent: "pi_test_p8",
    metadata: { organization_id: a.organizationId, invoice_id: order.invoiceId, order_id: order.orderId, kind: "package" } } } });
  const ts = Math.floor(Date.now() / 1000);
  const wh = await t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}`, "content-type": "application/json" } });
  assert.equal(wh.status, 200);
  const pay = await one<{ id: string }>(t.db, `SELECT id FROM payments WHERE invoice_id = ?`, order.invoiceId);
  const rc = await loadReceipt(t.db, pay.id, a.organizationId);
  const invNo = (await one<{ n: number }>(t.db, `SELECT invoice_number n FROM invoices WHERE id = ?`, order.invoiceId)).n;
  const mail = (await lastEmail(t.db, a.email))!;
  assert.equal(mail.template, "receipt");
  assert.match(mail.text_body, new RegExp(`for ${invoiceLabel(invNo)}`));
  assert.match(mail.text_body, new RegExp(`Your receipt, ${rc.receiptLabel}, is ready`));
  const link = `http://crestmont.test/portal/billing/receipts/${pay.id}`;
  assert.ok(mail.text_body.includes(`View ${rc.receiptLabel}: ${link}\n`), "links the receipt page");
  assert.ok(mail.text_body.includes(`Download ${rc.receiptLabel} (PDF): ${link}/pdf`), "links the receipt PDF");
  const html = await one<{ html_body: string }>(t.db, `SELECT m.html_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.to_email = ? AND d.template = 'receipt'`, a.email);
  assert.ok(html.html_body.includes(`href="${link}/pdf"`));
  // The linked documents open for the customer.
  const pdf = await a.c.get(new URL(`${link}/pdf`).pathname);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  const bytes = new Uint8Array(await pdf.arrayBuffer());
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString("latin1"), "%PDF-");
  assert.ok(pdfText(bytes).includes(rc.receiptLabel));
  assert.equal((await a.c.get(new URL(link).pathname)).status, 200);
});
