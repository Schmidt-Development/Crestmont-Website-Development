-- Phase 8.3: human-readable, sequential document numbers ("Invoice 001", "Receipt 001").
--
-- Two independent sequences:
--   * Invoices: invoices.invoice_number, allocated from the 'invoice' row of document_counters.
--   * Receipts: receipts.seq (0011), an AUTOINCREMENT key that already numbers one receipt per payment.
--     "Receipt 001" is receipts.seq formatted; the legacy receipts.receipt_number ("CWD-R-000001") is
--     kept unchanged as an internal reference, so a receipt issued before this migration keeps its number.
--
-- Internal primary keys (inv_…, pay_…) and every Stripe identifier stay exactly where they were; the number is
-- an extra column, never a replacement key.
--
-- Allocation is atomic without interactive transactions. D1 runs each statement, and each trigger body with it,
-- as one implicit transaction, so the triggers below allocate a number in the same statement that issues the
-- invoice or records the payment. The counter only ever increases (no MAX()+1), so a number is never reused, and
-- the UNIQUE index refuses a duplicate outright. The idempotent lazy fallback in src/services/document-numbers.ts
-- uses the same two guarded statements in one D1 batch (also a single transaction).
--
-- Nothing in a deployment resets the sequences: the counter lives in the database, migrations run once, and the
-- backfill below only fills rows whose number is NULL.

CREATE TABLE document_counters (
  kind TEXT PRIMARY KEY,
  last_value INTEGER NOT NULL CHECK (last_value >= 0),
  updated_at TEXT NOT NULL
);

ALTER TABLE invoices ADD COLUMN invoice_number INTEGER;

-- Backfill: every issued (non-draft) invoice, numbered once in created_at order (rowid breaks ties).
UPDATE invoices SET invoice_number = (
    SELECT COUNT(*) FROM invoices i2
    WHERE i2.status <> 'draft' AND (i2.created_at < invoices.created_at OR (i2.created_at = invoices.created_at AND i2.rowid <= invoices.rowid)))
  WHERE status <> 'draft' AND invoice_number IS NULL;

INSERT INTO document_counters (kind, last_value, updated_at)
  SELECT 'invoice', COALESCE(MAX(invoice_number), 0), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM invoices;

CREATE UNIQUE INDEX uq_invoices_invoice_number ON invoices(invoice_number) WHERE invoice_number IS NOT NULL;

-- Backfill receipts: payments that have a receipt keep their existing seq; recorded payments without one get the
-- next numbers in created_at order. Failed and simulated payments never get a receipt (src/services/receipts.ts).
INSERT INTO receipts (payment_id, receipt_number, organization_id, created_at)
  SELECT p.id, 'pending:' || p.id, p.organization_id, p.created_at FROM payments p
  WHERE p.status <> 'failed' AND p.provider <> 'simulated' AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.payment_id = p.id)
  ORDER BY p.created_at, p.rowid;
UPDATE receipts SET receipt_number = 'CWD-R-' || printf('%06d', seq) WHERE receipt_number = 'pending:' || payment_id;

-- Invoices are numbered when issued: inserted as, or moved to, any status other than draft.
CREATE TRIGGER invoices_number_ai AFTER INSERT ON invoices WHEN NEW.status <> 'draft' AND NEW.invoice_number IS NULL BEGIN
  UPDATE document_counters SET last_value = last_value + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE kind = 'invoice';
  UPDATE invoices SET invoice_number = (SELECT last_value FROM document_counters WHERE kind = 'invoice') WHERE id = NEW.id AND invoice_number IS NULL;
END;
CREATE TRIGGER invoices_number_au AFTER UPDATE OF status ON invoices WHEN NEW.status <> 'draft' AND NEW.invoice_number IS NULL BEGIN
  UPDATE document_counters SET last_value = last_value + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE kind = 'invoice';
  UPDATE invoices SET invoice_number = (SELECT last_value FROM document_counters WHERE kind = 'invoice') WHERE id = NEW.id AND invoice_number IS NULL;
END;
-- An issued number is permanent.
CREATE TRIGGER invoices_number_locked BEFORE UPDATE OF invoice_number ON invoices WHEN OLD.invoice_number IS NOT NULL AND NEW.invoice_number IS NOT OLD.invoice_number BEGIN
  SELECT RAISE(ABORT, 'invoice_number is permanent once issued');
END;

-- Receipts are numbered when a payment is recorded (any status but failed; never for simulated payments).
-- NOT EXISTS (rather than OR IGNORE / upsert) keeps the outer statement's conflict policy from ever replacing a receipt.
CREATE TRIGGER payments_receipt_ai AFTER INSERT ON payments WHEN NEW.status <> 'failed' AND NEW.provider <> 'simulated' BEGIN
  INSERT INTO receipts (payment_id, receipt_number, organization_id, created_at)
    SELECT NEW.id, 'pending:' || NEW.id, NEW.organization_id, NEW.created_at WHERE NOT EXISTS (SELECT 1 FROM receipts WHERE payment_id = NEW.id);
  UPDATE receipts SET receipt_number = 'CWD-R-' || printf('%06d', seq) WHERE payment_id = NEW.id AND receipt_number = 'pending:' || NEW.id;
END;
CREATE TRIGGER payments_receipt_au AFTER UPDATE OF status ON payments WHEN NEW.status <> 'failed' AND NEW.provider <> 'simulated' BEGIN
  INSERT INTO receipts (payment_id, receipt_number, organization_id, created_at)
    SELECT NEW.id, 'pending:' || NEW.id, NEW.organization_id, NEW.created_at WHERE NOT EXISTS (SELECT 1 FROM receipts WHERE payment_id = NEW.id);
  UPDATE receipts SET receipt_number = 'CWD-R-' || printf('%06d', seq) WHERE payment_id = NEW.id AND receipt_number = 'pending:' || NEW.id;
END;
-- A receipt's number is permanent.
CREATE TRIGGER receipts_number_locked BEFORE UPDATE OF seq, payment_id ON receipts BEGIN
  SELECT RAISE(ABORT, 'receipt numbers are permanent');
END;
