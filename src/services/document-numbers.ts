// Phase 8.3: customer-facing document numbers ("Invoice 001", "Receipt 001"). Migration 0100 allocates them in
// the same statement that issues an invoice or records a payment (triggers), and backfilled every historical
// document once in created_at order. The functions here are the idempotent fallback for a document that somehow
// reached a render without a number, and the one place that formats a number for display.
//
// Concurrency: D1 has no interactive transactions, so each allocation is ONE batch (one transaction) of two
// guarded statements: bump the counter only if this document still has no number, then copy the counter into the
// document only if it still has no number. Two concurrent calls for the same document therefore produce one
// number and no gap; calls for different documents each get the next counter value. The counter never goes
// down, so a number is never reused, and a UNIQUE index refuses duplicates.
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";

/** Prefix of the legacy internal receipt reference (receipts.receipt_number), kept for staff and audit. */
export const RECEIPT_PREFIX = "CWD-R-";

/** Zero-padded to at least three digits: 1 → "001", 1000 → "1000". */
export function formatDocNumber(n: number): string {
  return String(n).padStart(3, "0");
}

/** "Invoice 001"; an unissued draft has no number yet. */
export function invoiceLabel(n: number | null | undefined): string {
  return n ? `Invoice ${formatDocNumber(n)}` : "Draft invoice (not yet issued)";
}

export function receiptLabel(n: number): string {
  return `Receipt ${formatDocNumber(n)}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "November 8, 2026": the UTC calendar date of a stored ISO timestamp, as printed on customer documents. */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "-";
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** Assigns an issued invoice its number if it has none (idempotent). Drafts are never numbered. Returns the number or null for a draft/missing invoice. */
export async function ensureInvoiceNumber(db: Db, invoiceId: string): Promise<number | null> {
  const row = await db.prepare(`SELECT invoice_number, status FROM invoices WHERE id = ?`).bind(invoiceId).first<{ invoice_number: number | null; status: string }>();
  if (!row || row.status === "draft") return null;
  if (row.invoice_number) return row.invoice_number;
  await db.batch([
    db.prepare(`UPDATE document_counters SET last_value = last_value + 1, updated_at = ? WHERE kind = 'invoice'
        AND EXISTS (SELECT 1 FROM invoices WHERE id = ? AND invoice_number IS NULL AND status <> 'draft')`).bind(nowIso(), invoiceId),
    db.prepare(`UPDATE invoices SET invoice_number = (SELECT last_value FROM document_counters WHERE kind = 'invoice')
        WHERE id = ? AND invoice_number IS NULL AND status <> 'draft'`).bind(invoiceId),
  ]);
  const after = await db.prepare(`SELECT invoice_number FROM invoices WHERE id = ?`).bind(invoiceId).first<{ invoice_number: number | null }>();
  return after?.invoice_number ?? null;
}

/**
 * Assigns a payment its receipt if it has none (idempotent) and returns the receipt's sequence number (receipts.seq)
 * plus the legacy reference kept for staff ("CWD-R-000001"). Null when the payment does not exist.
 */
export async function ensureReceipt(db: Db, paymentId: string): Promise<{ seq: number; legacyNumber: string } | null> {
  const existing = await db.prepare(`SELECT seq, receipt_number FROM receipts WHERE payment_id = ?`).bind(paymentId).first<{ seq: number; receipt_number: string }>();
  if (existing && !existing.receipt_number.startsWith("pending:")) return { seq: existing.seq, legacyNumber: existing.receipt_number };
  await db.batch([
    db.prepare(`INSERT INTO receipts (payment_id, receipt_number, organization_id, created_at)
        SELECT id, 'pending:' || id, organization_id, ? FROM payments WHERE id = ? AND NOT EXISTS (SELECT 1 FROM receipts WHERE payment_id = ?)`).bind(nowIso(), paymentId, paymentId),
    db.prepare(`UPDATE receipts SET receipt_number = ? || printf('%06d', seq) WHERE payment_id = ? AND receipt_number = 'pending:' || payment_id`).bind(RECEIPT_PREFIX, paymentId),
  ]);
  const row = await db.prepare(`SELECT seq, receipt_number FROM receipts WHERE payment_id = ?`).bind(paymentId).first<{ seq: number; receipt_number: string }>();
  return row ? { seq: row.seq, legacyNumber: row.receipt_number } : null;
}
