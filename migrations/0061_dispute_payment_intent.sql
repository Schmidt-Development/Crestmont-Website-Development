-- A dispute can arrive before the payment it disputes (Stripe does not order webhook events). Staging 2026-11-01:
-- charge.dispute.created was processed 40 ms after checkout.session.completed but before the payment row existed, so the
-- dispute was stored with no customer or payment and never linked. Keeping the PaymentIntent lets the payment, once
-- recorded, claim it (src/services/payments.ts linkDisputesForPayment).
ALTER TABLE disputes ADD COLUMN stripe_payment_intent_id TEXT;
CREATE INDEX idx_disputes_unlinked_pi ON disputes(stripe_payment_intent_id) WHERE payment_id IS NULL;
