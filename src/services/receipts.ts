// Printable payment receipts (PAY-005, receipt document part; redesigned in Phase 8).
// A receipt exists for every recorded payment except failed and simulated ones. Its customer-facing number is
// "Receipt 001" (receipts.seq, allocated when the payment is recorded — migration 0100 — or lazily on first view).
// The legacy reference (CWD-R-000001), the internal payment id and every Stripe id are loaded for staff only; the
// customer-facing renderers never print them.
// Business identity comes only from business_settings and the confirmed operating entity; nothing is invented.
import type { Db } from "../lib/db.ts";
import { legalNameFrom } from "../domain/business-identity.ts";
import { HttpError } from "../app/http.ts";
import { parseTaxDetail } from "./tax.ts";
import type { TaxResult } from "../domain/tax.ts";
import { ensureInvoiceNumber, ensureReceipt, formatDocNumber, invoiceLabel, longDate, receiptLabel, RECEIPT_PREFIX } from "./document-numbers.ts";

export { RECEIPT_PREFIX };

export const MILESTONE_LABEL: Record<string, string> = { full: "Payment in full", deposit_50: "50% deposit", design_25: "25% design milestone", prelaunch_25: "25% pre-launch", change_order: "Change order", subscription: "Subscription" };

export interface ReceiptData {
  /** "001" — the customer-facing receipt number. */
  receiptNumber: string;
  /** "Receipt 001". */
  receiptLabel: string;
  receiptSeq: number;
  payment: { id: string; amount_cents: number; status: string; created_at: string; provider: string; stripe_payment_intent_id: string | null; stripe_charge_id: string | null };
  invoice: { id: string; invoice_number: number | null; label: string; description: string | null; milestone_kind: string | null; amount_cents: number; status: string; created_at: string; paid_at: string | null; stripe_checkout_session_id: string | null; stripe_invoice_id: string | null } | null;
  order: { id: string; kind: string; total_cents: number; product_name: string | null; product_kind: string | null } | null;
  organization: { id: string; name: string };
  /** What was bought, in plain words ("Business website package — Payment in full"). */
  service: string;
  /** How the customer paid, from what the records establish (no card details are stored). */
  paymentMethod: string | null;
  refunds: { amount_cents: number; at: string }[];
  refundedCents: number;
  /** The latest dispute on the payment, if any. */
  dispute: { status: string; amount_cents: number; created_at: string } | null;
  /** Customer-facing status ("Paid", "Refunded", "Partially refunded", "Disputed"). */
  statusLabel: string;
  /** Explains a refund or dispute while keeping the fact that the payment was made. */
  statusNote: string | null;
  /** LEGAL-005: the paid invoice's tax snapshot; null when it was issued without tax configuration. */
  tax: TaxResult | null;
  /** Staff/audit only: the pre-Phase-8 receipt reference (CWD-R-000001). */
  legacyReference: string;
}

/** Assigns the receipt for a payment if it has none yet (idempotent) and returns its customer-facing number ("001"). */
export async function ensureReceiptNumber(db: Db, paymentId: string): Promise<string> {
  const r = await ensureReceipt(db, paymentId);
  if (!r) throw new HttpError(404, "Receipt not found.");
  return formatDocNumber(r.seq);
}

/** "Business website package", "Custom website development", "Professional maintenance". */
export function productService(p: { product_name: string | null; product_kind: string | null } | null): string | null {
  if (!p?.product_name) return null;
  if (p.product_kind === "package") return `${p.product_name} website package`;
  if (p.product_kind === "custom") return "Custom website development";
  return p.product_name;
}

/** The service line: the product (when known) and what this invoice bills. */
export function serviceDescription(invoice: { description: string | null; milestone_kind: string | null } | null, order: { product_name: string | null; product_kind: string | null } | null): string {
  const billed = invoice ? invoice.description ?? MILESTONE_LABEL[invoice.milestone_kind ?? ""] ?? "Website development services" : null;
  const product = productService(order);
  if (product && billed && !billed.toLowerCase().includes(product.toLowerCase())) return `${product} — ${billed}`;
  return billed ?? product ?? "Website development services";
}

const PAYMENT_STATUS: Record<string, string> = { succeeded: "Paid", partially_refunded: "Partially refunded", refunded: "Refunded", disputed: "Disputed", failed: "Failed" };
const DISPUTE_CLOSED_NOTE: Record<string, string> = { won: "closed; the payment stands", lost: "closed; the disputed amount was returned through the card issuer", warning_closed: "closed", closed: "closed" };

export function paymentStatusLabel(status: string): string {
  return PAYMENT_STATUS[status] ?? status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Loads a receipt. `organizationId` scopes customer access; staff pass null (route already checked finance.read). */
export async function loadReceipt(db: Db, paymentId: string, organizationId: string | null): Promise<ReceiptData> {
  const p = await db.prepare(`SELECT id, organization_id, invoice_id, order_id, amount_cents, status, created_at, provider, stripe_payment_intent_id, stripe_charge_id FROM payments WHERE id = ? AND provider <> 'simulated'${organizationId ? " AND organization_id = ?" : ""}`)
    .bind(...(organizationId ? [paymentId, organizationId] : [paymentId]))
    .first<ReceiptData["payment"] & { organization_id: string; invoice_id: string | null; order_id: string | null }>();
  if (!p) throw new HttpError(404, "Receipt not found.");
  if (p.status === "failed") throw new HttpError(404, "This payment failed, so there is no receipt for it.");
  const rc = await ensureReceipt(db, p.id);
  if (!rc) throw new HttpError(404, "Receipt not found.");
  if (p.invoice_id) await ensureInvoiceNumber(db, p.invoice_id);
  const inv = p.invoice_id ? await db.prepare(`SELECT id, invoice_number, description, milestone_kind, amount_cents, status, created_at, paid_at, stripe_checkout_session_id, stripe_invoice_id, order_id, tax_detail_json FROM invoices WHERE id = ? AND organization_id = ?`)
    .bind(p.invoice_id, p.organization_id).first<Omit<NonNullable<ReceiptData["invoice"]>, "label"> & { order_id: string | null; tax_detail_json?: string | null }>() : null;
  const tax = parseTaxDetail(inv?.tax_detail_json);
  const orderId = p.order_id ?? inv?.order_id ?? null;
  const order = orderId ? await db.prepare(`SELECT o.id, o.kind, o.total_cents, pr.name AS product_name, pr.kind AS product_kind FROM orders o LEFT JOIN products pr ON pr.id = o.product_id WHERE o.id = ? AND o.organization_id = ?`)
    .bind(orderId, p.organization_id).first<NonNullable<ReceiptData["order"]>>() : null;
  const organization = (await db.prepare(`SELECT id, name FROM organizations WHERE id = ?`).bind(p.organization_id).first<{ id: string; name: string }>())!;
  const refunds = (await db.prepare(`SELECT amount_cents, COALESCE(issued_at, decided_at, created_at) AS at FROM refunds WHERE payment_id = ? AND status = 'issued' ORDER BY at`).bind(p.id)
    .all<{ amount_cents: number; at: string }>()).results;
  const refundedCents = refunds.reduce((s, r) => s + r.amount_cents, 0);
  const dispute = await db.prepare(`SELECT status, amount_cents, created_at FROM disputes WHERE payment_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(p.id)
    .first<{ status: string; amount_cents: number; created_at: string }>();
  const invoice: ReceiptData["invoice"] = inv ? { id: inv.id, invoice_number: inv.invoice_number, label: invoiceLabel(inv.invoice_number), description: inv.description, milestone_kind: inv.milestone_kind, amount_cents: inv.amount_cents, status: inv.status,
    created_at: inv.created_at, paid_at: inv.paid_at, stripe_checkout_session_id: inv.stripe_checkout_session_id, stripe_invoice_id: inv.stripe_invoice_id } : null;

  let statusLabel = paymentStatusLabel(p.status);
  if (p.status !== "refunded" && p.status !== "partially_refunded" && refundedCents > 0) statusLabel = refundedCents >= p.amount_cents ? "Refunded" : "Partially refunded";
  const day = longDate(p.created_at);
  let statusNote: string | null = null;
  if (statusLabel === "Refunded") statusNote = `This payment was received on ${day}. It was later refunded in full.`;
  else if (statusLabel === "Partially refunded") statusNote = `This payment was received on ${day}. Part of it was later refunded; the amount refunded is shown below.`;
  else if (statusLabel === "Disputed") statusNote = `This payment was received on ${day}. It is currently the subject of a payment dispute with the card issuer.`;
  else if (dispute && DISPUTE_CLOSED_NOTE[dispute.status]) statusNote = `This payment was received on ${day}. A payment dispute about it was ${DISPUTE_CLOSED_NOTE[dispute.status]}.`;

  const paymentMethod = p.provider === "stripe" ? (inv?.stripe_invoice_id ? "Online payment through a Stripe-hosted invoice" : "Online payment through Stripe secure checkout") : null;
  return {
    receiptNumber: formatDocNumber(rc.seq), receiptLabel: receiptLabel(rc.seq), receiptSeq: rc.seq, legacyReference: rc.legacyNumber,
    payment: { id: p.id, amount_cents: p.amount_cents, status: p.status, created_at: p.created_at, provider: p.provider, stripe_payment_intent_id: p.stripe_payment_intent_id, stripe_charge_id: p.stripe_charge_id },
    invoice, order, organization, service: serviceDescription(invoice, order), paymentMethod, refunds, refundedCents, dispute: dispute ?? null, statusLabel, statusNote, tax,
  };
}

export interface BusinessIdentity { tradingName: string; legalName: string | null; address: string | null; billingEmail: string }

export function businessIdentity(settings: Record<string, string>): BusinessIdentity {
  return {
    tradingName: "Crestmont Website Development",
    legalName: legalNameFrom(settings),
    address: settings["business.address"]?.trim() || null,
    billingEmail: "billing@crestmontwebsitedevelopment.com",
  };
}
