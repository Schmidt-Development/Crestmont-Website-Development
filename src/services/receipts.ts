// Printable payment receipts (PAY-005, receipt document part).
// A receipt exists for every recorded payment except failed ones. Receipt numbers are assigned once
// per payment from an AUTOINCREMENT sequence (CWD-R-000001 …): stable across views and unique.
// Business identity comes only from business_settings; nothing is invented when it is unset.
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { HttpError } from "../app/http.ts";

export const RECEIPT_PREFIX = "CWD-R-";

export interface ReceiptData {
  receiptNumber: string;
  payment: { id: string; amount_cents: number; status: string; created_at: string; stripe_payment_intent_id: string | null; stripe_charge_id: string | null };
  invoice: { id: string; description: string | null; milestone_kind: string | null; amount_cents: number; status: string; created_at: string; paid_at: string | null; stripe_checkout_session_id: string | null } | null;
  order: { id: string; kind: string; total_cents: number } | null;
  organization: { id: string; name: string };
  refundedCents: number;
}

/** Assigns the receipt number for a payment if it does not have one yet (idempotent). */
export async function ensureReceiptNumber(db: Db, paymentId: string): Promise<string> {
  const existing = await db.prepare(`SELECT receipt_number FROM receipts WHERE payment_id = ?`).bind(paymentId).first<{ receipt_number: string }>();
  if (existing) return existing.receipt_number;
  await db.batch([
    db.prepare(`INSERT INTO receipts (payment_id, receipt_number, organization_id, created_at) SELECT id, 'pending:' || id, organization_id, ? FROM payments WHERE id = ? ON CONFLICT(payment_id) DO NOTHING`).bind(nowIso(), paymentId),
    db.prepare(`UPDATE receipts SET receipt_number = ? || printf('%06d', seq) WHERE payment_id = ? AND receipt_number = 'pending:' || payment_id`).bind(RECEIPT_PREFIX, paymentId),
  ]);
  const row = await db.prepare(`SELECT receipt_number FROM receipts WHERE payment_id = ?`).bind(paymentId).first<{ receipt_number: string }>();
  if (!row) throw new HttpError(404, "Receipt not found.");
  return row.receipt_number;
}

/** Loads a receipt. `organizationId` scopes customer access; staff pass null (route already checked finance.read). */
export async function loadReceipt(db: Db, paymentId: string, organizationId: string | null): Promise<ReceiptData> {
  const p = await db.prepare(`SELECT id, organization_id, invoice_id, order_id, amount_cents, status, created_at, stripe_payment_intent_id, stripe_charge_id FROM payments WHERE id = ?${organizationId ? " AND organization_id = ?" : ""}`)
    .bind(...(organizationId ? [paymentId, organizationId] : [paymentId]))
    .first<ReceiptData["payment"] & { organization_id: string; invoice_id: string | null; order_id: string | null }>();
  if (!p) throw new HttpError(404, "Receipt not found.");
  if (p.status === "failed") throw new HttpError(404, "This payment failed, so there is no receipt for it.");
  const receiptNumber = await ensureReceiptNumber(db, p.id);
  const invoice = p.invoice_id ? await db.prepare(`SELECT id, description, milestone_kind, amount_cents, status, created_at, paid_at, stripe_checkout_session_id FROM invoices WHERE id = ? AND organization_id = ?`).bind(p.invoice_id, p.organization_id).first<NonNullable<ReceiptData["invoice"]>>() : null;
  const order = p.order_id ? await db.prepare(`SELECT id, kind, total_cents FROM orders WHERE id = ? AND organization_id = ?`).bind(p.order_id, p.organization_id).first<NonNullable<ReceiptData["order"]>>() : null;
  const organization = (await db.prepare(`SELECT id, name FROM organizations WHERE id = ?`).bind(p.organization_id).first<{ id: string; name: string }>())!;
  const refunded = await db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS n FROM refunds WHERE payment_id = ? AND status = 'issued'`).bind(p.id).first<{ n: number }>();
  return { receiptNumber, payment: { id: p.id, amount_cents: p.amount_cents, status: p.status, created_at: p.created_at, stripe_payment_intent_id: p.stripe_payment_intent_id, stripe_charge_id: p.stripe_charge_id }, invoice, order, organization, refundedCents: refunded?.n ?? 0 };
}

export interface BusinessIdentity { tradingName: string; legalName: string | null; address: string | null; billingEmail: string }

export function businessIdentity(settings: Record<string, string>): BusinessIdentity {
  return {
    tradingName: "Crestmont Website Development",
    legalName: settings["business.legal_name"]?.trim() || null,
    address: settings["business.address"]?.trim() || null,
    billingEmail: "billing@crestmontwebsitedevelopment.com",
  };
}
