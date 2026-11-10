// Server-generated invoice and receipt PDFs (PAY-005; redesigned in Phase 8). Every figure in a document is read
// from persisted rows (invoices, orders, quote_versions, change_orders, payments, refunds, disputes, receipts):
// nothing is recomputed from the catalog. Access is tenant-scoped by the caller: customers pass their
// organization id (any other organization's record is a 404); staff routes pass null after finance.read.
//
// Phase 8.2: these documents are customer-facing. They carry the human-readable numbers ("Invoice 001",
// "Receipt 001") and never print an internal id (inv_…, pay_…, ord_…) or a Stripe id (pi_…, ch_…, cs_…, in_…).
// Those stay in the database, in the staff pages' "Technical details" and in the audit log.
import type { Db } from "../lib/db.ts";
import { HttpError } from "../app/http.ts";
import { PdfDocument, PdfFlow, wrapText, type Rgb } from "../lib/pdf.ts";
import { businessIdentity, loadReceipt, paymentStatusLabel, productService, MILESTONE_LABEL, type ReceiptData } from "./receipts.ts";
import { ensureInvoiceNumber, ensureReceipt, formatDocNumber, invoiceLabel, longDate, receiptLabel } from "./document-numbers.ts";
import { parseTaxDetail, taxStatement, taxLabel } from "./tax.ts";
import type { TaxResult } from "../domain/tax.ts";

export { MILESTONE_LABEL };

// Black, gold and white. The gold is a deeper print tone of the brand gold so it stays legible on white paper.
const GOLD: Rgb = [0.659, 0.545, 0.322]; // #a88b52 (--gold-3)
const GOLD_WASH: Rgb = [0.984, 0.969, 0.929]; // pale gold panel
const INK: Rgb = [0.067, 0.067, 0.067];
const BODY: Rgb = [0.18, 0.18, 0.18];
const MUTED: Rgb = [0.42, 0.42, 0.42];
const HAIRLINE: Rgb = [0.86, 0.86, 0.86];

/** USD from integer cents, always two decimals with thousands separators ("$1,250.00"). */
export function usd(cents: number): string {
  const neg = cents < 0, abs = Math.abs(cents);
  const d = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${d}.${String(abs % 100).padStart(2, "0")}`;
}

export { longDate };

export interface InvoiceLine { description: string; amountCents: number }
export interface InvoiceDocData {
  invoice: { id: string; organization_id: string; order_id: string | null; project_id: string | null; milestone_kind: string | null; amount_cents: number; status: string; description: string | null; created_at: string; due_at: string | null; paid_at: string | null; stripe_invoice_id: string | null; stripe_invoice_number: string | null; stripe_checkout_session_id: string | null; invoice_number: number | null };
  /** "Invoice 001" (or the draft wording for an unissued draft). */
  label: string;
  organization: { id: string; name: string };
  /** The organization's billing contact (first customer administrator), when there is one. */
  contact: { name: string | null; email: string } | null;
  project: { id: string; name: string } | null;
  order: { id: string; kind: string; total_cents: number; product_id: string | null; product_name: string | null; product_kind: string | null } | null;
  /** The line(s) this invoice bills. */
  lines: InvoiceLine[];
  /** For orders billed in installments: the order's quoted lines and every invoice of the order. */
  orderLines: InvoiceLine[];
  schedule: { id: string; milestone_kind: string | null; amount_cents: number; status: string; invoice_number: number | null }[];
  payments: { id: string; amount_cents: number; status: string; created_at: string; stripe_payment_intent_id: string | null; receipt_number: string; receipt_label: string; refunded_cents: number }[];
  paidCents: number; refundedCents: number; balanceCents: number;
  /** Customer-facing status ("Paid", "Payment due", "Overdue", "Paid — refunded", …). */
  statusLabel: string;
  statusNote: string | null;
  /** LEGAL-005 tax snapshot fixed when the invoice was issued; null = issued without tax configuration. */
  tax: TaxResult | null;
}

function invoiceStatus(inv: { status: string; due_at: string | null }, paid: number, refunded: number, disputed: boolean, balance: number, now: Date): { label: string; note: string | null } {
  switch (inv.status) {
    case "draft": return { label: "Draft", note: "This invoice is a draft and has not been issued." };
    case "void": return { label: "Void", note: "This invoice was voided. No payment is due." };
    case "uncollectible": return { label: "Uncollectible", note: null };
    case "open":
      if (balance <= 0) return { label: "Paid", note: null };
      return inv.due_at && inv.due_at < now.toISOString() ? { label: "Overdue", note: null } : { label: paid > 0 ? "Partially paid" : "Payment due", note: null };
    default:
      if (disputed) return { label: "Paid — payment disputed", note: "Payment for this invoice was received and is currently the subject of a payment dispute." };
      if (refunded > 0 && refunded >= paid) return { label: "Paid — refunded", note: "Payment for this invoice was received and later refunded in full." };
      if (refunded > 0) return { label: "Paid — partially refunded", note: "Payment for this invoice was received and later partially refunded." };
      return { label: "Paid", note: null };
  }
}

export async function loadInvoiceDoc(db: Db, invoiceId: string, organizationId: string | null, now: Date = new Date()): Promise<InvoiceDocData> {
  const sel = `SELECT id, organization_id, order_id, project_id, milestone_kind, amount_cents, status, description, created_at, due_at, paid_at, stripe_invoice_id, stripe_invoice_number, stripe_checkout_session_id, invoice_number, tax_detail_json
      FROM invoices WHERE id = ?${organizationId ? " AND organization_id = ?" : ""}`;
  const args = organizationId ? [invoiceId, organizationId] : [invoiceId];
  let invoice = await db.prepare(sel).bind(...args).first<InvoiceDocData["invoice"] & { tax_detail_json?: string | null }>();
  // Customers never see drafts (same rule as the billing page).
  if (!invoice || (organizationId && invoice.status === "draft")) throw new HttpError(404, "Invoice not found.");
  if (invoice.status !== "draft" && !invoice.invoice_number) {
    await ensureInvoiceNumber(db, invoice.id);
    invoice = (await db.prepare(sel).bind(...args).first<InvoiceDocData["invoice"] & { tax_detail_json?: string | null }>())!;
  }
  const tax = parseTaxDetail(invoice.tax_detail_json);
  delete invoice.tax_detail_json;
  const org = invoice.organization_id;
  const organization = (await db.prepare(`SELECT id, name FROM organizations WHERE id = ?`).bind(org).first<{ id: string; name: string }>())!;
  const contact = await db.prepare(`SELECT u.display_name AS name, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.role_id = 'customer_admin' AND u.disabled_at IS NULL ORDER BY m.created_at LIMIT 1`)
    .bind(org).first<{ name: string | null; email: string }>();
  const project = invoice.project_id ? await db.prepare(`SELECT id, name FROM projects WHERE id = ? AND organization_id = ?`).bind(invoice.project_id, org).first<{ id: string; name: string }>() : null;
  const order = invoice.order_id ? await db.prepare(`SELECT o.id, o.kind, o.total_cents, o.product_id, pr.name AS product_name, pr.kind AS product_kind FROM orders o LEFT JOIN products pr ON pr.id = o.product_id WHERE o.id = ? AND o.organization_id = ?`)
    .bind(invoice.order_id, org).first<NonNullable<InvoiceDocData["order"]>>() : null;

  const label = invoice.description ?? MILESTONE_LABEL[invoice.milestone_kind ?? ""] ?? "Website development services";
  const lines: InvoiceLine[] = [];
  const lineAmount = tax ? tax.subtotalCents : invoice.amount_cents;
  if (invoice.milestone_kind === "change_order") {
    const co = await db.prepare(`SELECT scope_text, price_cents FROM change_orders WHERE invoice_id = ?`).bind(invoice.id).first<{ scope_text: string; price_cents: number }>();
    lines.push({ description: co ? `Change order: ${co.scope_text}` : label, amountCents: lineAmount });
  } else {
    const product = productService(order);
    lines.push({ description: product && !label.toLowerCase().includes(product.toLowerCase()) ? `${product} — ${label}` : label, amountCents: lineAmount });
  }

  let orderLines: InvoiceLine[] = [];
  let schedule: InvoiceDocData["schedule"] = [];
  if (order) {
    const qv = await db.prepare(`SELECT qv.line_items_json FROM orders o JOIN quote_versions qv ON qv.id = o.quote_version_id WHERE o.id = ?`).bind(order.id).first<{ line_items_json: string }>();
    if (qv) {
      try {
        const parsed = JSON.parse(qv.line_items_json) as { lines?: { description: string; amountCents: number }[] };
        orderLines = (parsed.lines ?? []).filter((l) => typeof l.description === "string" && Number.isInteger(l.amountCents)).map((l) => ({ description: l.description, amountCents: l.amountCents }));
      } catch { orderLines = []; }
    }
    schedule = (await db.prepare(`SELECT id, milestone_kind, amount_cents, status, invoice_number FROM invoices WHERE order_id = ? AND organization_id = ? AND status <> 'draft' ORDER BY created_at, rowid`).bind(order.id, org)
      .all<InvoiceDocData["schedule"][number]>()).results;
  }

  const pays = (await db.prepare(`SELECT p.id, p.amount_cents, p.status, p.created_at, p.stripe_payment_intent_id,
        (SELECT COALESCE(SUM(r.amount_cents),0) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'issued') AS refunded_cents
      FROM payments p WHERE p.invoice_id = ? AND p.organization_id = ? AND p.status <> 'failed' AND p.provider <> 'simulated' ORDER BY p.created_at`).bind(invoice.id, org)
    .all<Omit<InvoiceDocData["payments"][number], "receipt_number" | "receipt_label">>()).results;
  const payments: InvoiceDocData["payments"] = [];
  for (const p of pays) {
    const rc = await ensureReceipt(db, p.id);
    if (!rc) continue;
    payments.push({ ...p, receipt_number: formatDocNumber(rc.seq), receipt_label: receiptLabel(rc.seq) });
  }
  const paidCents = payments.reduce((s, p) => s + p.amount_cents, 0);
  const refundedCents = payments.reduce((s, p) => s + p.refunded_cents, 0);
  const balanceCents = invoice.status === "void" || invoice.status === "uncollectible" ? 0 : Math.max(0, invoice.amount_cents - paidCents);
  const st = invoiceStatus(invoice, paidCents, refundedCents, payments.some((p) => p.status === "disputed"), balanceCents, now);
  return { invoice, label: invoiceLabel(invoice.invoice_number), organization, contact: contact ?? null, project, order, lines, orderLines, schedule, payments, paidCents, refundedCents, balanceCents, statusLabel: st.label, statusNote: st.note, tax };
}

// ───────────── Shared document chrome ─────────────

/** Small tracked uppercase section label in gold. */
function sectionLabel(flow: PdfFlow, text: string, x = flow.margin) {
  flow.page.text(x, flow.y, text.toUpperCase(), { size: 7.5, bold: true, color: GOLD, charSpace: 1.2 });
}

function letterhead(flow: PdfFlow, settings: Record<string, string>, title: string, number: string) {
  const p = flow.page, w = flow.doc.width, h = flow.doc.height, m = flow.margin;
  const id = businessIdentity(settings);
  // A black band with a gold hairline across the top edge: the only heavy element on the page.
  p.rect(0, h - 8, w, 8, INK);
  p.rect(0, h - 9.2, w, 1.2, GOLD);
  let y = flow.y - 4;
  p.text(m, y - 18, "CRESTMONT", { size: 21, bold: true, color: INK, charSpace: 2.2 });
  p.text(m + 1, y - 31, "WEBSITE DEVELOPMENT", { size: 7.5, bold: true, color: GOLD, charSpace: 2.4 });
  const left: string[] = [];
  if (id.legalName) left.push(`Operated by ${id.legalName}`);
  if (id.address) left.push(...wrapText(id.address, 250, 8));
  left.push(id.billingEmail);
  let ly = y - 46;
  for (const l of left) { p.text(m, ly, l, { size: 8, color: MUTED }); ly -= 11; }
  p.text(w - m, y - 20, title.toUpperCase(), { size: 22, bold: true, color: INK, align: "right", charSpace: 3 });
  p.text(w - m, y - 36, number, { size: 11, bold: true, color: GOLD, align: "right" });
  y = Math.min(ly + 2, y - 50);
  flow.y = y - 8;
  p.line(m, flow.y, w - m, flow.y, { width: 0.75, color: GOLD });
  flow.y -= 22;
}

/** Header on the second and later pages. */
function continuation(flow: PdfFlow, number: string) {
  const p = flow.page, w = flow.doc.width, h = flow.doc.height, m = flow.margin;
  p.rect(0, h - 8, w, 8, INK);
  p.rect(0, h - 9.2, w, 1.2, GOLD);
  p.text(m, flow.y - 12, "CRESTMONT", { size: 11, bold: true, color: INK, charSpace: 1.4 });
  p.text(w - m, flow.y - 12, `${number} (continued)`, { size: 9, bold: true, color: GOLD, align: "right" });
  flow.y -= 20;
  p.line(m, flow.y, w - m, flow.y, { width: 0.5, color: GOLD });
  flow.y -= 16;
}

function footer(doc: PdfDocument, settings: Record<string, string>, number: string) {
  const id = businessIdentity(settings);
  const left = [id.tradingName, id.legalName, id.billingEmail].filter(Boolean).join("  ·  ");
  doc.pages.forEach((p, i) => {
    p.line(54, 50, doc.width - 54, 50, { width: 0.5, color: GOLD });
    p.text(54, 37, left, { size: 7.5, color: MUTED });
    p.text(doc.width - 54, 37, `${number}  ·  Page ${i + 1} of ${doc.pages.length}`, { size: 7.5, color: MUTED, align: "right" });
  });
}

/**
 * Two-column header block: the customer on the left (wrapped to its column), the document facts on the right
 * (label left, value right-aligned). Returns after both columns, whichever is taller.
 */
function partiesBlock(flow: PdfFlow, partyLabel: string, partyLines: { text: string; bold?: boolean; size?: number }[], facts: [string, string][]) {
  const m = flow.margin, cw = flow.contentWidth, leftW = 250, rightX = m + cw - 220, rightW = 220;
  const top = flow.y;
  sectionLabel(flow, partyLabel);
  let ly = top - 16;
  for (const pl of partyLines) {
    const size = pl.size ?? 9;
    for (const l of wrapText(pl.text, leftW, size, pl.bold)) {
      flow.page.text(m, ly, l, { size, bold: pl.bold, color: pl.bold ? INK : BODY });
      ly -= size * 1.4;
    }
  }
  let ry = top;
  for (const [k, v] of facts) {
    const lines = wrapText(v, rightW - 95, 9, true);
    flow.page.text(rightX, ry, k, { size: 8.5, color: MUTED });
    lines.forEach((l, i) => flow.page.text(rightX + rightW, ry - i * 12, l, { size: 9, bold: true, color: INK, align: "right" }));
    ry -= 12 * lines.length + 6;
    flow.page.line(rightX, ry + 12, rightX + rightW, ry + 12, { width: 0.3, color: HAIRLINE });
  }
  flow.y = Math.min(ly, ry) - 10;
}

/** A pale-gold notice panel (refund, dispute, void), wrapped to the content width. */
function notice(flow: PdfFlow, text: string) {
  const lines = wrapText(text, flow.contentWidth - 24, 9);
  const h = lines.length * 12.5 + 14;
  flow.ensure(h + 6);
  flow.page.rect(flow.margin, flow.y - h, flow.contentWidth, h, GOLD_WASH);
  flow.page.rect(flow.margin, flow.y - h, 2.5, h, GOLD);
  lines.forEach((l, i) => flow.page.text(flow.margin + 14, flow.y - 16 - i * 12.5, l, { size: 9, color: INK }));
  flow.y -= h + 16;
}

const tableStyle = { size: 9.5, headerSize: 7.5, headerCharSpace: 0.9, headerFill: null, headerText: MUTED, headerRule: INK, headerAccent: GOLD, rule: HAIRLINE, color: BODY, rowLeading: 1.55 } as const;

/** Right-aligned totals block. Rows marked `strong` are bold; the `highlight` row sits in a pale-gold panel. */
function totals(flow: PdfFlow, rows: { label: string; value: string; strong?: boolean; highlight?: boolean; ruleAbove?: boolean }[]) {
  const w = 240, x0 = flow.margin + flow.contentWidth - w, right = flow.margin + flow.contentWidth - 4;
  const height = rows.reduce((s, r) => s + (r.highlight ? 26 : 16) + (r.ruleAbove ? 4 : 0), 0) + 6;
  flow.ensure(height); // the block is never split across pages
  flow.y -= 4;
  for (const r of rows) {
    if (r.ruleAbove) { flow.page.line(x0, flow.y - 2, flow.margin + flow.contentWidth, flow.y - 2, { width: 0.75, color: INK }); flow.y -= 4; }
    if (r.highlight) {
      flow.page.rect(x0, flow.y - 24, w, 24, GOLD_WASH);
      flow.page.rect(x0, flow.y - 24, 2.5, 24, GOLD);
      flow.page.text(x0 + 12, flow.y - 16, r.label, { size: 10.5, bold: true, color: INK });
      flow.page.text(right, flow.y - 16.5, r.value, { size: 12, bold: true, color: INK, align: "right" });
      flow.y -= 26;
    } else {
      flow.y -= 16;
      flow.page.text(x0 + 12, flow.y + 4, r.label, { size: r.strong ? 10 : 9.5, bold: r.strong, color: r.strong ? INK : BODY });
      flow.page.text(right, flow.y + 4, r.value, { size: r.strong ? 10 : 9.5, bold: r.strong, color: INK, align: "right" });
    }
  }
  flow.y -= 6;
}

function heading(flow: PdfFlow, text: string) {
  flow.ensure(46);
  flow.gap(20);
  sectionLabel(flow, text);
  flow.gap(8);
}

function note(flow: PdfFlow, text: string, size = 8) {
  flow.paragraph(text, { size, color: MUTED, leading: size * 1.5 });
}

// ───────────── Invoice ─────────────

export interface InvoicePdfOptions { /** Secure payment link for an open invoice (portal or Stripe-hosted invoice). */ payUrl?: string | null }

export function invoicePdf(d: InvoiceDocData, settings: Record<string, string>, generatedAt: Date, opts: InvoicePdfOptions = {}): Uint8Array<ArrayBuffer> {
  const number = d.label;
  const doc = new PdfDocument({ title: `${number} - Crestmont Website Development`, author: "Crestmont Website Development", subject: `${number} for ${d.organization.name}`, creationDate: generatedAt });
  let first = true;
  const flow = new PdfFlow(doc, { onNewPage: (_p, f) => { if (!first) continuation(f, number); } });
  letterhead(flow, settings, "Invoice", number);
  first = false;

  const party: { text: string; bold?: boolean; size?: number }[] = [{ text: d.organization.name, bold: true, size: 12 }];
  if (d.contact) party.push({ text: d.contact.name ? `Attn: ${d.contact.name}` : d.contact.email }, ...(d.contact.name ? [{ text: d.contact.email }] : []));
  if (d.project) party.push({ text: `Project: ${d.project.name}` });
  const due = d.invoice.due_at ? longDate(d.invoice.due_at) : d.invoice.status === "open" ? "Due on receipt" : "On receipt";
  partiesBlock(flow, "Billed to", party, [
    ["Invoice number", d.invoice.invoice_number ? formatDocNumber(d.invoice.invoice_number) : "Not yet issued"],
    ["Invoice date", longDate(d.invoice.created_at)],
    ["Due date", due],
    ...(d.invoice.paid_at ? [["Paid on", longDate(d.invoice.paid_at)] as [string, string]] : []),
    ["Status", d.statusLabel],
  ]);
  if (d.statusNote) notice(flow, d.statusNote);
  else flow.gap(4);

  const cw = flow.contentWidth;
  if (d.tax) {
    // LEGAL-005: tax per line (taxable amount, tax, line total), then the subtotal and each jurisdiction's tax.
    const t = d.tax;
    flow.table([{ header: "DESCRIPTION", width: cw - 270 }, { header: "AMOUNT", width: 90, align: "right" }, { header: "SALES TAX", width: 90, align: "right" }, { header: "LINE TOTAL", width: 90, align: "right" }],
      d.lines.map((l, i) => { const tl = t.lines[i]; return [l.description, usd(l.amountCents), tl?.taxable ? usd(tl.taxCents) : "Not taxable", usd(l.amountCents + (tl?.taxCents ?? 0))]; }), tableStyle);
  } else {
    flow.table([{ header: "DESCRIPTION", width: cw - 120 }, { header: "AMOUNT (USD)", width: 120, align: "right" }], d.lines.map((l) => [l.description, usd(l.amountCents)]), tableStyle);
  }
  flow.gap(6);
  const rows: Parameters<typeof totals>[1] = [{ label: "Subtotal", value: usd(d.tax ? d.tax.subtotalCents : d.lines.reduce((s, l) => s + l.amountCents, 0)) }];
  if (d.tax) rows.push(...d.tax.byJurisdiction.map((j) => ({ label: taxLabel(j), value: usd(j.taxCents) })));
  else rows.push({ label: "Tax", value: "No tax applied" });
  rows.push({ label: "Total", value: usd(d.invoice.amount_cents), strong: true, ruleAbove: true }, { label: "Amount paid", value: usd(d.paidCents) });
  if (d.refundedCents) rows.push({ label: "Refunded", value: usd(-d.refundedCents) });
  rows.push({ label: "Balance due", value: usd(d.balanceCents), highlight: true });
  totals(flow, rows);

  if (d.invoice.status === "open" && d.balanceCents > 0) {
    heading(flow, "How to pay");
    flow.paragraph(opts.payUrl ? `Pay securely online through our payment processor, Stripe. Sign in and choose Pay next to ${number}:` : "Pay securely online from the Billing page of your Crestmont customer portal.", { size: 9.5, color: BODY });
    if (opts.payUrl) flow.paragraph(opts.payUrl, { size: 9.5, bold: true, color: INK });
    note(flow, "Your payment is confirmed once Stripe notifies us; a receipt is then emailed to you.");
  }

  if (d.payments.length) {
    heading(flow, "Payments received");
    flow.table([{ header: "DATE", width: 110 }, { header: "RECEIPT", width: 90 }, { header: "STATUS", width: cw - 320 }, { header: "AMOUNT (USD)", width: 120, align: "right" }],
      d.payments.map((p) => [longDate(p.created_at), p.receipt_label, `${paymentStatusLabel(p.status)}${p.refunded_cents ? `, ${usd(p.refunded_cents)} refunded` : ""}`, usd(p.amount_cents)]), tableStyle);
  }

  if (d.orderLines.length || d.schedule.length > 1) {
    heading(flow, "Project breakdown");
    if (d.orderLines.length) {
      flow.table([{ header: "QUOTED ITEM", width: cw - 120 }, { header: "AMOUNT (USD)", width: 120, align: "right" }],
        [...d.orderLines.map((l) => [l.description, usd(l.amountCents)]), ...(d.order ? [["Project total", usd(d.order.total_cents)]] : [])], tableStyle);
      flow.gap(12);
    }
    if (d.schedule.length) {
      flow.table([{ header: "PAYMENT SCHEDULE", width: cw - 330 }, { header: "INVOICE", width: 110 }, { header: "STATUS", width: 100 }, { header: "AMOUNT (USD)", width: 120, align: "right" }],
        d.schedule.map((s) => [`${MILESTONE_LABEL[s.milestone_kind ?? ""] ?? "Invoice"}${s.id === d.invoice.id ? " (this invoice)" : ""}`, s.invoice_number ? invoiceLabel(s.invoice_number) : "-", s.status === "open" ? "Payment due" : s.status.charAt(0).toUpperCase() + s.status.slice(1), usd(s.amount_cents)]), tableStyle);
    }
  }

  heading(flow, "Notes");
  if (d.tax) note(flow, taxStatement(d.tax));
  else note(flow, "No tax has been applied to this invoice.");
  note(flow, `Questions about this invoice? Contact ${businessIdentity(settings).billingEmail}${businessIdentity(settings).phone ? ` or call ${businessIdentity(settings).phone}` : ""} and quote ${number}.`);
  if (d.invoice.status === "paid") flow.paragraph("Thank you for your business.", { size: 9.5, bold: true, color: INK });
  footer(doc, settings, number);
  return doc.toBytes();
}

// ───────────── Receipt ─────────────

export async function loadReceiptDoc(db: Db, paymentId: string, organizationId: string | null): Promise<ReceiptData> {
  return loadReceipt(db, paymentId, organizationId);
}

export function receiptPdf(r: ReceiptData, settings: Record<string, string>, generatedAt: Date): Uint8Array<ArrayBuffer> {
  const number = r.receiptLabel;
  const doc = new PdfDocument({ title: `${number} - Crestmont Website Development`, author: "Crestmont Website Development", subject: `Payment receipt for ${r.organization.name}`, creationDate: generatedAt });
  let first = true;
  const flow = new PdfFlow(doc, { onNewPage: (_p, f) => { if (!first) continuation(f, number); } });
  letterhead(flow, settings, "Receipt", number);
  first = false;

  partiesBlock(flow, "Received from", [{ text: r.organization.name, bold: true, size: 12 }], [
    ["Receipt number", r.receiptNumber],
    ["Payment date", longDate(r.payment.created_at)],
    ["Invoice", r.invoice ? r.invoice.label : "No invoice linked"],
    ["Status", r.statusLabel],
  ]);
  if (r.statusNote) notice(flow, r.statusNote);
  else flow.gap(4);

  // The amount paid, prominently. It never changes after a refund or dispute: the payment happened.
  const m = flow.margin, cw = flow.contentWidth;
  flow.ensure(64);
  flow.page.rect(m, flow.y - 58, cw, 58, GOLD_WASH);
  flow.page.rect(m, flow.y - 58, 2.5, 58, GOLD);
  flow.page.text(m + 16, flow.y - 18, "AMOUNT PAID", { size: 7.5, bold: true, color: GOLD, charSpace: 1.2 });
  flow.page.text(m + 16, flow.y - 44, `${usd(r.payment.amount_cents)} USD`, { size: 22, bold: true, color: INK });
  flow.page.text(m + cw - 16, flow.y - 18, "PAID ON", { size: 7.5, bold: true, color: GOLD, charSpace: 1.2, align: "right" });
  flow.page.text(m + cw - 16, flow.y - 40, longDate(r.payment.created_at), { size: 11, bold: true, color: INK, align: "right" });
  flow.y -= 58 + 22;

  const rows: string[][] = [[r.service, usd(r.payment.amount_cents)]];
  if (r.tax) for (const j of r.tax.byJurisdiction) rows.push([`Includes ${taxLabel(j)}`, usd(j.taxCents)]);
  flow.table([{ header: "SERVICE", width: cw - 120 }, { header: "AMOUNT (USD)", width: 120, align: "right" }], rows, tableStyle);
  flow.gap(6);
  const tot: Parameters<typeof totals>[1] = [{ label: "Total paid", value: usd(r.payment.amount_cents), strong: true }];
  for (const rf of r.refunds) tot.push({ label: `Refunded ${longDate(rf.at)}`, value: usd(-rf.amount_cents) });
  if (r.refundedCents) tot.push({ label: "Net amount after refunds", value: usd(r.payment.amount_cents - r.refundedCents), highlight: true });
  totals(flow, tot);

  heading(flow, "Payment details");
  flow.pairs([
    ["Payment method", r.paymentMethod ?? "Recorded by Crestmont"],
    ["Payment status", r.statusLabel],
    ...(r.dispute ? [["Dispute", `${usd(r.dispute.amount_cents)} disputed on ${longDate(r.dispute.created_at)} (${r.dispute.status.replace(/_/g, " ")})`] as [string, string]] : []),
    ["Associated invoice", r.invoice ? `${r.invoice.label} (invoice total ${usd(r.invoice.amount_cents)}, issued ${longDate(r.invoice.created_at)})` : "No invoice linked"],
  ], { labelWidth: 140, size: 9.5 });

  heading(flow, "Notes");
  note(flow, "This receipt confirms a payment received by Crestmont Website Development, as confirmed by our payment processor, Stripe.");
  if (r.tax) note(flow, taxStatement(r.tax));
  note(flow, `Questions about this payment? Contact ${businessIdentity(settings).billingEmail}${businessIdentity(settings).phone ? ` or call ${businessIdentity(settings).phone}` : ""} and quote ${number}.`);
  flow.paragraph("Thank you for your business.", { size: 9.5, bold: true, color: INK });
  footer(doc, settings, number);
  return doc.toBytes();
}
