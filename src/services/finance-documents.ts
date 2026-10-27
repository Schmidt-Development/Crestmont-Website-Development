// Server-generated invoice and receipt PDFs (PAY-005). Every figure in a document is read from
// persisted rows (invoices, orders, quote_versions, change_orders, payments, refunds, receipts):
// nothing is recomputed from the catalog. Access is tenant-scoped by the caller: customers pass their
// organization id (any other organization's record is a 404); staff routes pass null after finance.read.
import type { Db } from "../lib/db.ts";
import { HttpError } from "../app/http.ts";
import { PdfDocument, PdfFlow, type Rgb } from "../lib/pdf.ts";
import { businessIdentity, ensureReceiptNumber, loadReceipt, type ReceiptData } from "./receipts.ts";

const GOLD: Rgb = [0.788, 0.647, 0.298];
const INK: Rgb = [0.07, 0.07, 0.07];
const MUTED: Rgb = [0.38, 0.38, 0.38];

export const MILESTONE_LABEL: Record<string, string> = { full: "Payment in full", deposit_50: "50% deposit", design_25: "25% design milestone", prelaunch_25: "25% pre-launch", change_order: "Change order", subscription: "Subscription" };

/** USD from integer cents, always two decimals with thousands separators ("$1,250.00"). */
export function usd(cents: number): string {
  const neg = cents < 0, abs = Math.abs(cents);
  const d = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${d}.${String(abs % 100).padStart(2, "0")}`;
}
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "-");
const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export interface InvoiceLine { description: string; amountCents: number }
export interface InvoiceDocData {
  invoice: { id: string; organization_id: string; order_id: string | null; project_id: string | null; milestone_kind: string | null; amount_cents: number; status: string; description: string | null; created_at: string; due_at: string | null; paid_at: string | null; stripe_invoice_id: string | null; stripe_invoice_number: string | null; stripe_checkout_session_id: string | null };
  organization: { id: string; name: string };
  project: { id: string; name: string } | null;
  order: { id: string; kind: string; total_cents: number; product_id: string | null } | null;
  /** The line(s) this invoice bills. */
  lines: InvoiceLine[];
  /** For orders billed in installments: the order's quoted lines and every invoice of the order. */
  orderLines: InvoiceLine[];
  schedule: { id: string; milestone_kind: string | null; amount_cents: number; status: string }[];
  payments: { id: string; amount_cents: number; status: string; created_at: string; stripe_payment_intent_id: string | null; receipt_number: string; refunded_cents: number }[];
  paidCents: number; refundedCents: number; balanceCents: number;
}

export async function loadInvoiceDoc(db: Db, invoiceId: string, organizationId: string | null): Promise<InvoiceDocData> {
  const invoice = await db.prepare(`SELECT id, organization_id, order_id, project_id, milestone_kind, amount_cents, status, description, created_at, due_at, paid_at, stripe_invoice_id, stripe_invoice_number, stripe_checkout_session_id
      FROM invoices WHERE id = ?${organizationId ? " AND organization_id = ?" : ""}`).bind(...(organizationId ? [invoiceId, organizationId] : [invoiceId])).first<InvoiceDocData["invoice"]>();
  // Customers never see drafts (same rule as the billing page).
  if (!invoice || (organizationId && invoice.status === "draft")) throw new HttpError(404, "Invoice not found.");
  const org = invoice.organization_id;
  const organization = (await db.prepare(`SELECT id, name FROM organizations WHERE id = ?`).bind(org).first<{ id: string; name: string }>())!;
  const project = invoice.project_id ? await db.prepare(`SELECT id, name FROM projects WHERE id = ? AND organization_id = ?`).bind(invoice.project_id, org).first<{ id: string; name: string }>() : null;
  const order = invoice.order_id ? await db.prepare(`SELECT id, kind, total_cents, product_id FROM orders WHERE id = ? AND organization_id = ?`).bind(invoice.order_id, org).first<NonNullable<InvoiceDocData["order"]>>() : null;

  const label = invoice.description ?? MILESTONE_LABEL[invoice.milestone_kind ?? ""] ?? "Invoice";
  const lines: InvoiceLine[] = [];
  if (invoice.milestone_kind === "change_order") {
    const co = await db.prepare(`SELECT scope_text, price_cents FROM change_orders WHERE invoice_id = ?`).bind(invoice.id).first<{ scope_text: string; price_cents: number }>();
    lines.push({ description: co ? `Change order: ${co.scope_text}` : label, amountCents: invoice.amount_cents });
  } else {
    lines.push({ description: label, amountCents: invoice.amount_cents });
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
    schedule = (await db.prepare(`SELECT id, milestone_kind, amount_cents, status FROM invoices WHERE order_id = ? AND organization_id = ? AND status <> 'draft' ORDER BY created_at, rowid`).bind(order.id, org)
      .all<InvoiceDocData["schedule"][number]>()).results;
  }

  const pays = (await db.prepare(`SELECT p.id, p.amount_cents, p.status, p.created_at, p.stripe_payment_intent_id,
        (SELECT COALESCE(SUM(r.amount_cents),0) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'issued') AS refunded_cents
      FROM payments p WHERE p.invoice_id = ? AND p.organization_id = ? AND p.status <> 'failed' ORDER BY p.created_at`).bind(invoice.id, org)
    .all<Omit<InvoiceDocData["payments"][number], "receipt_number">>()).results;
  const payments: InvoiceDocData["payments"] = [];
  for (const p of pays) payments.push({ ...p, receipt_number: await ensureReceiptNumber(db, p.id) });
  const paidCents = payments.reduce((s, p) => s + p.amount_cents, 0);
  const refundedCents = payments.reduce((s, p) => s + p.refunded_cents, 0);
  const balanceCents = invoice.status === "void" || invoice.status === "uncollectible" ? 0 : Math.max(0, invoice.amount_cents - paidCents);
  return { invoice, organization, project, order, lines, orderLines, schedule, payments, paidCents, refundedCents, balanceCents };
}

function letterhead(flow: PdfFlow, settings: Record<string, string>, kindLabel: string, number: string) {
  const p = flow.page, w = flow.doc.width, m = flow.margin;
  const id = businessIdentity(settings);
  p.rect(0, flow.doc.height - 10, w, 10, GOLD);
  p.text(m, flow.y - 16, id.tradingName, { size: 15, bold: true, color: INK });
  p.text(m, flow.y - 31, id.legalName ?? "Legal business name pending (entity not yet established)", { size: 8.5, color: MUTED });
  p.text(m, flow.y - 43, id.address ?? "Registered address pending", { size: 8.5, color: MUTED });
  p.text(m, flow.y - 55, id.billingEmail, { size: 8.5, color: MUTED });
  p.text(w - m, flow.y - 16, kindLabel.toUpperCase(), { size: 15, bold: true, color: GOLD, align: "right" });
  p.text(w - m, flow.y - 31, number, { size: 10, bold: true, align: "right" });
  flow.y -= 66;
  p.line(m, flow.y, w - m, flow.y, { width: 1.2, color: GOLD });
  flow.y -= 8;
}

function footer(doc: PdfDocument, note: string) {
  doc.pages.forEach((p, i) => {
    p.line(54, 46, doc.width - 54, 46, { width: 0.4, color: [0.75, 0.75, 0.75] });
    p.text(54, 34, note, { size: 7.5, color: MUTED });
    p.text(doc.width - 54, 34, `Page ${i + 1} of ${doc.pages.length}`, { size: 7.5, color: MUTED, align: "right" });
  });
}

export function invoicePdf(d: InvoiceDocData, settings: Record<string, string>, generatedAt: Date): Uint8Array<ArrayBuffer> {
  const number = d.invoice.stripe_invoice_number ? `${d.invoice.id} (Stripe ${d.invoice.stripe_invoice_number})` : d.invoice.id;
  const doc = new PdfDocument({ title: `Invoice ${d.invoice.id}`, author: "Crestmont Website Development", subject: `Invoice for ${d.organization.name}`, creationDate: generatedAt });
  let first = true;
  const flow = new PdfFlow(doc, { onNewPage: (_p, f) => { if (!first) { f.page.text(f.margin, f.y - 10, `Invoice ${d.invoice.id} (continued)`, { size: 9, bold: true }); f.y -= 22; } } });
  letterhead(flow, settings, "Invoice", number);
  first = false;
  flow.pairs([
    ["Billed to", d.organization.name],
    ["Invoice", d.invoice.id],
    ["Issued", day(d.invoice.created_at)],
    ["Due", d.invoice.due_at ? day(d.invoice.due_at) : d.invoice.status === "open" ? "On receipt" : "-"],
    ["Status", titleCase(d.invoice.status)],
    ["Type", MILESTONE_LABEL[d.invoice.milestone_kind ?? ""] ?? "-"],
    ["Project", d.project?.name ?? (d.invoice.project_id ? d.invoice.project_id : "Created after the first payment")],
    ["Order", d.order ? `${d.order.id} (${titleCase(d.order.kind)}, order total ${usd(d.order.total_cents)})` : "-"],
    ...(d.invoice.stripe_invoice_id ? [["Stripe invoice", d.invoice.stripe_invoice_id] as [string, string]] : []),
  ]);
  flow.gap(14);
  flow.table([{ header: "Description", width: flow.contentWidth - 110 }, { header: "Amount (USD)", width: 110, align: "right" }],
    d.lines.map((l) => [l.description, usd(l.amountCents)]));
  flow.gap(6);
  const totals: [string, string][] = [["Invoice total", usd(d.invoice.amount_cents)], ["Paid", usd(d.paidCents)]];
  if (d.refundedCents) totals.push(["Refunded", usd(d.refundedCents)]);
  totals.push(["Balance due", usd(d.balanceCents)]);
  for (const [k, v] of totals) {
    flow.ensure(15); flow.y -= 15;
    const bold = k === "Balance due" || k === "Invoice total";
    flow.page.text(flow.margin + flow.contentWidth - 120, flow.y, k, { size: 9.5, bold, align: "right" });
    flow.page.text(flow.margin + flow.contentWidth - 4, flow.y, v, { size: 9.5, bold, align: "right" });
  }
  if (d.orderLines.length || d.schedule.length > 1) {
    flow.gap(18);
    flow.paragraph("Order breakdown", { size: 11, bold: true });
    flow.gap(4);
    if (d.orderLines.length) {
      flow.table([{ header: "Quoted item", width: flow.contentWidth - 110 }, { header: "Amount (USD)", width: 110, align: "right" }],
        [...d.orderLines.map((l) => [l.description, usd(l.amountCents)]), ...(d.order ? [["Order total", usd(d.order.total_cents)]] : [])]);
      flow.gap(10);
    }
    if (d.schedule.length) {
      flow.table([{ header: "Payment schedule", width: flow.contentWidth - 210 }, { header: "Status", width: 100 }, { header: "Amount (USD)", width: 110, align: "right" }],
        d.schedule.map((s) => [`${MILESTONE_LABEL[s.milestone_kind ?? ""] ?? "Invoice"}${s.id === d.invoice.id ? " (this invoice)" : ""}`, titleCase(s.status), usd(s.amount_cents)]));
    }
  }
  if (d.payments.length) {
    flow.gap(18);
    flow.paragraph("Payments received", { size: 11, bold: true });
    flow.gap(4);
    flow.table([{ header: "Date", width: 80 }, { header: "Receipt", width: 110 }, { header: "Reference", width: flow.contentWidth - 300 }, { header: "Amount (USD)", width: 110, align: "right" }],
      d.payments.map((p) => [day(p.created_at), p.receipt_number, p.stripe_payment_intent_id ?? p.id, usd(p.amount_cents)]));
  }
  flow.gap(18);
  flow.paragraph(d.invoice.status === "open"
    ? "Pay online from the Billing page of your Crestmont customer portal. Payment is confirmed only when our payment processor (Stripe) notifies us."
    : "Thank you for your business.", { size: 9, color: MUTED });
  flow.paragraph("This document summarizes Crestmont's records for this invoice. It is not a tax invoice; tax configuration is not yet finalized.", { size: 8, color: MUTED });
  footer(doc, `Invoice ${d.invoice.id} - generated ${generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`);
  return doc.toBytes();
}

export async function loadReceiptDoc(db: Db, paymentId: string, organizationId: string | null): Promise<ReceiptData> {
  return loadReceipt(db, paymentId, organizationId);
}

export function receiptPdf(r: ReceiptData, settings: Record<string, string>, generatedAt: Date): Uint8Array<ArrayBuffer> {
  const doc = new PdfDocument({ title: `Receipt ${r.receiptNumber}`, author: "Crestmont Website Development", subject: `Payment receipt for ${r.organization.name}`, creationDate: generatedAt });
  const flow = new PdfFlow(doc);
  letterhead(flow, settings, "Receipt", r.receiptNumber);
  flow.pairs([
    ["Receipt number", r.receiptNumber],
    ["Received from", r.organization.name],
    ["Payment date", `${r.payment.created_at.slice(0, 16).replace("T", " ")} UTC`],
    ["Payment status", titleCase(r.payment.status)],
    ["Stripe payment reference", r.payment.stripe_payment_intent_id ?? "Not recorded"],
    ["Stripe charge", r.payment.stripe_charge_id ?? "Not recorded"],
    ["Internal payment ID", r.payment.id],
  ]);
  flow.gap(14);
  const desc = r.invoice ? `${r.invoice.description ?? MILESTONE_LABEL[r.invoice.milestone_kind ?? ""] ?? "Invoice"} (invoice ${r.invoice.id})` : "Payment (no invoice linked)";
  const rows: string[][] = [[desc, usd(r.payment.amount_cents)]];
  if (r.refundedCents) rows.push(["Refunded", `-${usd(r.refundedCents)}`]);
  flow.table([{ header: "Payment for", width: flow.contentWidth - 110 }, { header: "Amount (USD)", width: 110, align: "right" }], rows);
  flow.ensure(16); flow.y -= 16;
  flow.page.text(flow.margin + flow.contentWidth - 120, flow.y, "Amount paid", { size: 10, bold: true, align: "right" });
  flow.page.text(flow.margin + flow.contentWidth - 4, flow.y, usd(r.payment.amount_cents), { size: 10, bold: true, align: "right" });
  if (r.refundedCents) {
    flow.y -= 15;
    flow.page.text(flow.margin + flow.contentWidth - 120, flow.y, "Net after refunds", { size: 9.5, align: "right" });
    flow.page.text(flow.margin + flow.contentWidth - 4, flow.y, usd(r.payment.amount_cents - r.refundedCents), { size: 9.5, align: "right" });
  }
  flow.gap(16);
  if (r.invoice || r.order) {
    flow.pairs([
      ...(r.invoice ? [["Invoice amount", usd(r.invoice.amount_cents)], ["Invoice issued", day(r.invoice.created_at)], ["Checkout session", r.invoice.stripe_checkout_session_id ?? "Not recorded"]] as [string, string][] : []),
      ...(r.order ? [["Order", `${r.order.id} (${titleCase(r.order.kind)}, total ${usd(r.order.total_cents)})`]] as [string, string][] : []),
    ]);
    flow.gap(12);
  }
  flow.paragraph("This receipt confirms a payment recorded from a Stripe payment confirmation. It is not a tax invoice; tax configuration is not yet finalized.", { size: 8, color: MUTED });
  footer(doc, `Receipt ${r.receiptNumber} - generated ${generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`);
  return doc.toBytes();
}
