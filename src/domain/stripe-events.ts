// The Stripe events the webhook handler processes (src/services/payments.ts). The webhook endpoint registered in
// the Stripe Dashboard must enable at least these; the integration probe checks it (CREST-GAP-017), and
// tests/stripe-webhook-probe.test.ts keeps this list identical to the handler's `case` labels.
export const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed", "checkout.session.async_payment_succeeded",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "invoice.paid", "invoice.payment_failed", "invoice.finalized", "invoice.voided", "invoice.marked_uncollectible",
  "charge.refunded", "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed",
] as const;
