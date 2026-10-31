// Verified sales attribution (SALESOPT-002). A sale exists only when the platform holds a payment row written by the
// signature-verified, idempotent Stripe webhook pipeline (src/services/payments.ts → commerce.markInvoicePaid). What
// the agent said on the call, the call summary and the model's analysis never create a sale.
//
// Rules, in order:
//  - The payment's order must belong to a lead (orders.lead_id) that had at least one CONNECTED, non-test sales call
//    that ended before the payment and within the attribution window (default 14 days, delayed purchases included).
//  - Multi-touch: every qualifying call gets credit 1/n; the latest one is the last touch, which is what headline
//    conversion and revenue use (one sale = one conversion, never double-counted).
//  - rule = checkout_link when that call generated a checkout link, otherwise last_touch.
//  - Duplicate Stripe events cannot double count: payments are unique per payment intent, and attributions are
//    unique per (payment, call). Refunds, disputes and cancellations update the attribution status, and revenue
//    counts only status 'paid'.
import type { Db } from "../../lib/db.ts";
import { newId, nowIso } from "../../lib/db.ts";

export const DEFAULT_WINDOW_DAYS = 14;

interface PaymentRow { id: string; organization_id: string; amount_cents: number; status: string; created_at: string; order_id: string | null; lead_id: string | null; order_status: string | null }

const statusOf = (p: PaymentRow): "paid" | "refunded" | "partially_refunded" | "disputed" | "cancelled" =>
  p.order_status === "cancelled" ? "cancelled" : p.status === "succeeded" ? "paid" : p.status === "refunded" ? "refunded" : p.status === "partially_refunded" ? "partially_refunded" : p.status === "disputed" ? "disputed" : "cancelled";

export async function reconcileAttributions(db: Db, now = new Date(), windowDays = DEFAULT_WINDOW_DAYS): Promise<{ payments: number; created: number; updated: number }> {
  const since = new Date(now.getTime() - 180 * 86_400_000).toISOString();
  const pays = (await db.prepare(`SELECT p.id, p.organization_id, p.amount_cents, p.status, p.created_at, o.id AS order_id, o.lead_id, o.status AS order_status
      FROM payments p JOIN orders o ON o.id = COALESCE(p.order_id, (SELECT order_id FROM invoices WHERE id = p.invoice_id))
      WHERE p.stripe_payment_intent_id IS NOT NULL AND p.status IN ('succeeded','refunded','partially_refunded','disputed') AND o.lead_id IS NOT NULL
        AND (p.created_at >= ? OR p.id IN (SELECT payment_id FROM so_attributions))
      ORDER BY p.created_at LIMIT 5000`).bind(since).all<PaymentRow>()).results;
  let created = 0, updated = 0;
  for (const p of pays) {
    const from = new Date(Date.parse(p.created_at) - windowDays * 86_400_000).toISOString();
    const touches = (await db.prepare(`SELECT f.call_id, f.version_id, f.experiment_id, f.arm, f.checkout_link_generated, f.ended_at FROM so_call_facts f
        WHERE f.lead_id = ? AND f.connected = 1 AND f.is_test = 0 AND f.ended_at IS NOT NULL AND f.ended_at <= ? AND f.ended_at >= ? ORDER BY f.ended_at, f.call_id`)
      .bind(p.lead_id, p.created_at, from).all<{ call_id: string; version_id: string | null; experiment_id: string | null; arm: string | null; checkout_link_generated: number; ended_at: string }>()).results;
    // Rows for calls that are no longer touches (e.g. a corrected end time) are removed, so one payment never
    // has two last touches.
    const keep = touches.map((x) => x.call_id);
    const removed = await db.prepare(`DELETE FROM so_attributions WHERE payment_id = ?${keep.length ? ` AND call_id NOT IN (${keep.map(() => "?").join(",")})` : ""}`).bind(p.id, ...keep).run();
    updated += removed.meta.changes;
    if (!touches.length) continue;
    const repeat = !!(await db.prepare(`SELECT 1 AS x FROM payments WHERE organization_id = ? AND status = 'succeeded' AND created_at < ? AND id <> ? LIMIT 1`).bind(p.organization_id, p.created_at, p.id).first());
    const status = statusOf(p);
    const credit = 1 / touches.length;
    const at = nowIso();
    for (let i = 0; i < touches.length; i++) {
      const t = touches[i];
      const last = i === touches.length - 1 ? 1 : 0;
      const existed = !!(await db.prepare(`SELECT 1 AS x FROM so_attributions WHERE payment_id = ? AND call_id = ?`).bind(p.id, t.call_id).first());
      const res = await db.prepare(`INSERT INTO so_attributions (id, payment_id, call_id, version_id, experiment_id, arm, lead_id, order_id, amount_cents, rule, credit, is_last_touch, status, repeat_customer, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(payment_id, call_id) DO UPDATE SET status = excluded.status, credit = excluded.credit, is_last_touch = excluded.is_last_touch, updated_at = excluded.updated_at
          WHERE so_attributions.status <> excluded.status OR so_attributions.credit <> excluded.credit OR so_attributions.is_last_touch <> excluded.is_last_touch`)
        .bind(newId("soa"), p.id, t.call_id, t.version_id, t.experiment_id, t.arm, p.lead_id, p.order_id, p.amount_cents, t.checkout_link_generated ? "checkout_link" : "last_touch",
          credit, last, status, repeat ? 1 : 0, at, at).run();
      if (res.meta.changes === 1) { if (existed) updated++; else created++; }
    }
  }
  return { payments: pays.length, created, updated };
}
