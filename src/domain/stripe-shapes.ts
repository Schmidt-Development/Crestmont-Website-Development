// Version-tolerant readers for Stripe webhook payloads (PAY-003/PAY-006). Webhook events are rendered in the WEBHOOK
// ENDPOINT's API version, which may differ from the pinned request version (src/adapters/payments.ts): the endpoint is
// created in the Stripe Dashboard and defaults to the account's latest version. 2025-03-31.basil moved:
//   Invoice.subscription          → Invoice.parent.subscription_details.subscription
//   Invoice.payment_intent/charge → removed (Invoice.payments, an includable list, links InvoicePayments)
//   Subscription.current_period_end → SubscriptionItem.current_period_end
// https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects
// https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices
// https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const idOf = (v: unknown): string | null => (typeof v === "string" ? v : typeof obj(v)?.id === "string" ? (obj(v)!.id as string) : null);

export function invoiceSubscription(inv: Obj): string | null {
  return idOf(inv.subscription) ?? idOf(obj(obj(inv.parent)?.subscription_details)?.subscription);
}

/** Paid PaymentIntent of an invoice: the pre-basil field, or the first paid payment_intent entry of an included
 *  Invoice.payments list. null when the payload carries neither (look it up with the pinned API version instead). */
export function invoicePaymentIntent(inv: Obj): string | null {
  const direct = idOf(inv.payment_intent);
  if (direct) return direct;
  const data = obj(inv.payments)?.data;
  if (!Array.isArray(data)) return null;
  const entries = data.map(obj).filter(Boolean) as Obj[];
  const pick = entries.find((p) => p.status === "paid") ?? entries[0];
  const pay = obj(pick?.payment);
  return pay && (pay.type === undefined || pay.type === "payment_intent") ? idOf(pay.payment_intent) : null;
}

export function invoiceCharge(inv: Obj): string | null {
  const direct = idOf(inv.charge);
  if (direct) return direct;
  const data = obj(inv.payments)?.data;
  if (!Array.isArray(data)) return null;
  for (const p of data) { const c = idOf(obj(obj(p)?.payment)?.charge); if (c) return c; }
  return null;
}

/** True when this invoice payload is in a post-basil shape that simply omits the payment link (vs. an older payload
 *  that has the field but no payment yet). */
export function invoiceLacksPaymentLink(inv: Obj): boolean {
  return !("payment_intent" in inv) && invoicePaymentIntent(inv) === null;
}

export function subscriptionPeriodEnd(sub: Obj): number | null {
  if (typeof sub.current_period_end === "number") return sub.current_period_end;
  const items = obj(sub.items)?.data;
  if (!Array.isArray(items)) return null;
  const ends = items.map((i) => obj(i)?.current_period_end).filter((x): x is number => typeof x === "number");
  return ends.length ? Math.max(...ends) : null;
}

// Charge.refunds is not included in Charge objects (API responses or webhook payloads) at 2022-11-15 or newer, which
// covers both supported webhook endpoint versions (2025-02-24.acacia, 2026-10-28.endive). Only older payloads carry it.
// https://docs.stripe.com/changelog/2022-11-15/deprecates-charges-auto-expand
export interface ChargeRefund { id: string; amount: number | null }

/** Newest refund listed on a charge payload (Stripe lists newest first), or null when the payload lists none. */
export function chargeLatestRefund(ch: Obj): ChargeRefund | null {
  const data = obj(ch.refunds)?.data;
  if (!Array.isArray(data)) return null;
  const first = obj(data[0]);
  const id = first ? idOf(first) : null;
  return id ? { id, amount: typeof first!.amount === "number" ? first!.amount : null } : null;
}

/** True when the charge payload has no refund list at all (2022-11-15+ shape), as opposed to an empty list. */
export function chargeLacksRefundList(ch: Obj): boolean {
  return !Array.isArray(obj(ch.refunds)?.data);
}
