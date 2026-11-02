// Applies verified Stripe events (PAY-003). Webhooks are the only source of payment truth:
// browser redirects never mark anything paid. Every handler is idempotent.
import type { AppContext } from "../app/context.ts";
import { completeActivationForSubscription, recordPaymentFailure, recordPaymentRecovered } from "./maintenance-lifecycle.ts";
import { nowIso, newId } from "../lib/db.ts";
import { isStaleEvent, markEventResult, type StripeEvent } from "../domain/stripe-webhook.ts";
import { markInvoicePaid, provisionProjectOnce } from "./commerce.ts";
import { notify } from "./notifications.ts";
import { paymentsMode, expectedLivemode, type PaymentsEnv } from "../domain/payments-mode.ts";
import { audit } from "./security.ts";
import { sendMail } from "./mailer.ts";
import { MAINTENANCE_PLANS } from "../domain/catalog.ts";
import { syncProjectBuildSafe } from "./builds.ts";
import { invoiceSubscription, invoicePaymentIntent, invoiceCharge, invoiceLacksPaymentLink, subscriptionPeriodEnd, chargeLatestRefund, chargeLacksRefundList, type ChargeRefund } from "../domain/stripe-shapes.ts";
import { notifyRefundIssued, DISPUTE_CLOSED } from "./refunds.ts";
import { StripeReadOnly } from "../adapters/payments.ts";

/** Resolves an invoice's payment link through the API at the pinned version (where Invoice.payment_intent exists),
 *  for webhook payloads rendered in a newer version that omits it. */
export type StripeInvoiceLookup = (invoiceId: string) => Promise<{ paymentIntentId: string | null; chargeId: string | null }>;
export function stripeInvoiceLookup(env: PaymentsEnv, fetchImpl: typeof fetch = fetch): StripeInvoiceLookup | undefined {
  const pm = paymentsMode(env); // CREST-GAP-007/008: the key must match the environment's expected mode
  if (pm.mode === "none") return undefined;
  let reader: StripeReadOnly;
  try { reader = new StripeReadOnly(pm.key, fetchImpl, pm.mode); } catch { return undefined; }
  return async (id) => {
    if (!/^in_[A-Za-z0-9]+$/.test(id)) throw new Error("Invalid Stripe invoice id");
    const inv = await reader.get<Record<string, unknown>>(`invoices/${id}`);
    return { paymentIntentId: invoicePaymentIntent(inv), chargeId: invoiceCharge(inv) };
  };
}
/** Newest refund of a charge through the API at the pinned version, for charge payloads (2022-11-15+) that omit
 *  Charge.refunds. GET /v1/refunds lists newest first; Stripe recommends this over expanding Charge.refunds. */
export type StripeRefundLookup = (chargeId: string) => Promise<ChargeRefund | null>;
export function stripeRefundLookup(env: PaymentsEnv, fetchImpl: typeof fetch = fetch): StripeRefundLookup | undefined {
  const pm = paymentsMode(env); // CREST-GAP-007/008: the key must match the environment's expected mode
  if (pm.mode === "none") return undefined;
  let reader: StripeReadOnly;
  try { reader = new StripeReadOnly(pm.key, fetchImpl, pm.mode); } catch { return undefined; }
  return async (chargeId) => {
    if (!/^(ch|py)_[A-Za-z0-9]+$/.test(chargeId)) throw new Error("Invalid Stripe charge id");
    const list = await reader.get<{ data?: Record<string, unknown>[] }>("refunds", [["charge", chargeId], ["limit", "1"]]);
    const first = Array.isArray(list.data) ? list.data[0] : undefined;
    if (!first || typeof first.id !== "string") return null;
    reader.assertMode(first as { livemode?: boolean });
    return { id: first.id, amount: typeof first.amount === "number" ? first.amount : null };
  };
}

/**
 * `expectedLivemode`: the livemode every event must carry in this environment (src/domain/payments-mode.ts); null
 * refuses every event (production before the Founder authorises live payments). Omitted = false (test mode): live
 * mode is never assumed.
 */
type EventCtx = Pick<AppContext, "db" | "email" | "baseUrl"> & { stripeLookup?: StripeInvoiceLookup; stripeRefundLookup?: StripeRefundLookup; expectedLivemode?: boolean | null };

/** Builds the webhook-processing context for an environment (used by the webhook route and the scheduled retry). */
export function stripeEventCtx(ctx: Pick<AppContext, "db" | "email" | "baseUrl">, env: PaymentsEnv & { overrides?: { fetch?: typeof fetch } }): EventCtx {
  const f = env.overrides?.fetch ?? fetch;
  return { db: ctx.db, email: ctx.email, baseUrl: ctx.baseUrl, stripeLookup: stripeInvoiceLookup(env, f), stripeRefundLookup: stripeRefundLookup(env, f), expectedLivemode: expectedLivemode(env) };
}

type Obj = Record<string, unknown>;
const s = (o: Obj, k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
const n = (o: Obj, k: string) => (typeof o[k] === "number" ? (o[k] as number) : null);
const meta = (o: Obj) => ((o.metadata ?? {}) as Record<string, string>);

export async function processStripeEvent(ctx: EventCtx, evt: StripeEvent): Promise<void> {
  const db = ctx.db;
  try {
    // CREST-GAP-007/008: an event whose livemode differs from this environment's expected mode is never applied
    // (production refuses test-card events; staging refuses live ones; production refuses all until live is authorised).
    const expected = ctx.expectedLivemode === undefined ? false : ctx.expectedLivemode;
    const live = evt.livemode === true;
    if (expected === null || live !== expected) {
      await markEventResult(db, evt.id, { ok: true, ignored: true });
      await db.prepare(`UPDATE stripe_events SET last_error = ? WHERE id = ?`).bind(expected === null
        ? "Refused: payments are not authorised in this environment (no Stripe event is applied)."
        : `Refused: livemode=${live} event, but this environment expects livemode=${expected}.`, evt.id).run();
      await audit(db, { actorKind: "webhook", action: "stripe.event_mode_refused", subjectType: "stripe_event", subjectId: evt.id, details: { type: evt.type, livemode: live, expected } });
      return;
    }
    if (await isStaleEvent(db, evt)) { await markEventResult(db, evt.id, { ok: true, ignored: true }); return; }
    const o = evt.data.object as Obj;
    switch (evt.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const m = meta(o);
        if (s(o, "payment_status") !== "paid" && s(o, "mode") !== "subscription") break; // async methods settle later
        if (m.organization_id && s(o, "customer")) {
          await db.prepare(`UPDATE organizations SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?`).bind(s(o, "customer"), m.organization_id).run();
        }
        if (s(o, "mode") === "subscription") {
          if (m.organization_id && m.product_id && s(o, "subscription")) await upsertSubscription(db, s(o, "subscription")!, m.organization_id, m.product_id, "active", null);
          break;
        }
        if (!m.invoice_id) throw new Error("checkout session missing invoice_id metadata");
        const to = s(o, "customer_email") ?? ((o.customer_details as Obj | undefined)?.email as string | undefined) ?? null;
        await applyInvoicePayment(ctx, evt, m.invoice_id, { amountCents: n(o, "amount_total") ?? -1, paymentIntentId: s(o, "payment_intent"), chargeId: null }, to);
        break;
      }
      case "checkout.session.async_payment_failed": {
        // CREST-GAP-083: a delayed payment method (e.g. bank debit) failed after checkout; nothing was paid.
        const m = meta(o);
        const to = s(o, "customer_email") ?? ((o.customer_details as Obj | undefined)?.email as string | undefined) ?? null;
        if (to) await sendMail(ctx, { template: "failed_payment", to, idempotencyKey: `async-failed:${o.id}`, data: { kind: "checkout", url: `${ctx.baseUrl}/portal/billing${m.invoice_id ? `/invoices/${m.invoice_id}` : ""}` } });
        await audit(db, { actorKind: "webhook", action: "payment.async_failed", subjectType: "invoice", subjectId: m.invoice_id ?? null, organizationId: m.organization_id ?? null, details: { event: evt.id, session: o.id } });
        break;
      }
      case "checkout.session.expired": {
        // CREST-GAP-036/083: an abandoned package checkout voids its invoice (and cancels the order) so it does not count
        // as outstanding; other invoices stay open and only lose the expired session link. Only the latest recorded
        // session voids: an older session expiring never touches an invoice with a newer checkout in flight.
        const m = meta(o);
        if (m.invoice_id) {
          if (m.kind === "package") {
            const r = await db.prepare(`UPDATE invoices SET status = 'void' WHERE id = ? AND status = 'open' AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id = ?)`).bind(m.invoice_id, o.id).run();
            if (r.meta.changes === 1) {
              await db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = (SELECT order_id FROM invoices WHERE id = ?) AND status = 'pending_payment'`).bind(m.invoice_id).run();
              await audit(db, { actorKind: "webhook", action: "invoice.voided_checkout_expired", subjectType: "invoice", subjectId: m.invoice_id, organizationId: m.organization_id ?? null, details: { event: evt.id, session: o.id } });
            }
          } else {
            await db.prepare(`UPDATE invoices SET stripe_checkout_session_id = NULL WHERE id = ? AND status = 'open' AND stripe_checkout_session_id = ?`).bind(m.invoice_id, o.id).run();
          }
        }
        break;
      }
      case "payment_intent.payment_failed": {
        // CREST-GAP-083: a declined attempt. The customer sees the decline in Checkout and can retry, so this is recorded
        // for staff (no email per attempt); async failures email through checkout.session.async_payment_failed.
        const m = meta(o);
        const err = (o.last_payment_error ?? {}) as Obj;
        await audit(db, { actorKind: "webhook", action: "payment.intent_failed", subjectType: "invoice", subjectId: m.invoice_id ?? null, organizationId: m.organization_id ?? null,
          details: { event: evt.id, paymentIntent: o.id, code: s(err, "code"), declineCode: s(err, "decline_code") } });
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const m = meta(o);
        const org = m.organization_id ?? (await db.prepare(`SELECT id FROM organizations WHERE stripe_customer_id = ?`).bind(s(o, "customer")).first<{ id: string }>())?.id;
        if (!org) throw new Error("Subscription for unknown customer");
        const status = evt.type === "customer.subscription.deleted" ? "canceled" : (s(o, "status") ?? "incomplete");
        const end = subscriptionPeriodEnd(o);
        const change = await upsertSubscription(db, evt.data.object.id, org, m.product_id ?? null, status, end ? new Date(end * 1000).toISOString() : null);
        // FD-27: an active maintenance subscription completes the launch activation for its plan (or a higher one).
        const subRow = await db.prepare(`SELECT id FROM subscriptions WHERE stripe_subscription_id = ?`).bind(evt.data.object.id).first<{ id: string }>();
        if (subRow) await completeActivationForSubscription(db, org, subRow.id, change.productId, change.status);
        // EMAIL-002 subscription_update: customer administrators hear about real status changes of an existing plan.
        if (change.previous && change.previous !== change.status) {
          const plan = change.productId ? (MAINTENANCE_PLANS as Record<string, { name: string }>)[change.productId]?.name ?? change.productId : "maintenance";
          const admins = (await db.prepare(`SELECT u.email FROM memberships mb JOIN users u ON u.id = mb.user_id WHERE mb.organization_id = ? AND mb.role_id = 'customer_admin' AND u.disabled_at IS NULL`).bind(org).all<{ email: string }>()).results;
          for (const a of admins) await sendMail(ctx, { template: "subscription_update", to: a.email, idempotencyKey: `sub:${evt.id}:${a.email}`, data: { planName: plan, status: change.status, url: `${ctx.baseUrl}/portal/billing` } });
        }
        break;
      }
      case "invoice.payment_failed": {
        const sub = invoiceSubscription(o);
        if (sub) await db.prepare(`UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE stripe_subscription_id = ?`).bind(nowIso(), sub).run();
        // Clarification 1: the first unresolved failure starts the seven-day clock before hosting may be suspended.
        const clock = sub ? await recordPaymentFailure(db, sub, new Date(evt.created ? evt.created * 1000 : Date.now())) : null;
        const to = s(o, "customer_email");
        if (to) await sendMail(ctx, { template: "failed_payment", to, idempotencyKey: `failed:${evt.id}`, data: { kind: "plan", url: `${ctx.baseUrl}/portal/billing`, ...(clock ? { suspendAfter: clock.eligibleAt.slice(0, 10) } : {}) } });
        await audit(db, { actorKind: "webhook", action: "payment.failed", subjectType: "subscription", subjectId: sub, details: { event: evt.id } });
        break;
      }
      case "invoice.paid": {
        const sub = invoiceSubscription(o);
        if (sub) await db.prepare(`UPDATE subscriptions SET status = 'active', updated_at = ? WHERE stripe_subscription_id = ? AND status = 'past_due'`).bind(nowIso(), sub).run();
        // Clarification 1–2: payment clears the failure episode and restores suspended hosting (nothing was deleted).
        if (sub) await recordPaymentRecovered(ctx, sub);
        // PAY-006: a Stripe Invoice created for a milestone invoice (src/services/stripe-invoices.ts).
        const local = meta(o).crestmont_invoice_id;
        if (local) {
          const inv = await db.prepare(`SELECT id, stripe_invoice_id FROM invoices WHERE id = ?`).bind(local).first<{ id: string; stripe_invoice_id: string | null }>();
          if (!inv) throw new Error(`Stripe invoice ${o.id} references unknown invoice ${local}`);
          if (inv.stripe_invoice_id && inv.stripe_invoice_id !== o.id) throw new Error(`Stripe invoice ${o.id} does not match ${inv.stripe_invoice_id} recorded for ${local}`);
          await db.prepare(`UPDATE invoices SET stripe_invoice_id = COALESCE(stripe_invoice_id, ?), stripe_invoice_status = 'paid', stripe_invoice_synced_at = ? WHERE id = ?`).bind(o.id, nowIso(), local).run();
          let link = { paymentIntentId: invoicePaymentIntent(o), chargeId: invoiceCharge(o) };
          if (!link.paymentIntentId && invoiceLacksPaymentLink(o)) {
            // Newer-version payload: resolve the PaymentIntent through the pinned API version. Without it, refunds and
            // disputes could not be matched to this payment, so the event fails and is retried by reconciliation.
            if (!ctx.stripeLookup) throw new Error(`invoice ${o.id} payload has no payment link and Stripe is not configured to look it up`);
            link = await ctx.stripeLookup(String(o.id));
            if (!link.paymentIntentId) throw new Error(`Stripe invoice ${o.id} has no PaymentIntent yet`);
          }
          await applyInvoicePayment(ctx, evt, local, { amountCents: n(o, "amount_paid") ?? -1, ...link }, s(o, "customer_email"));
        }
        break;
      }
      case "invoice.finalized":
      case "invoice.voided":
      case "invoice.marked_uncollectible": {
        // Mirror Stripe's status for review; the local invoice status is not changed by these events.
        const local = meta(o).crestmont_invoice_id;
        if (!local) { await markEventResult(db, evt.id, { ok: true, ignored: true }); return; }
        await db.prepare(`UPDATE invoices SET stripe_invoice_status = ?, stripe_invoice_number = COALESCE(?, stripe_invoice_number), stripe_hosted_invoice_url = COALESCE(?, stripe_hosted_invoice_url), stripe_invoice_synced_at = ?
                          WHERE id = ? AND (stripe_invoice_id IS NULL OR stripe_invoice_id = ?) AND COALESCE(stripe_invoice_status, '') <> 'paid'`)
          .bind(s(o, "status") ?? evt.type.slice("invoice.".length), s(o, "number"), s(o, "hosted_invoice_url"), nowIso(), local, o.id).run();
        if (evt.type !== "invoice.finalized") await audit(db, { actorKind: "webhook", action: `invoice.stripe_${evt.type.slice("invoice.".length)}`, subjectType: "invoice", subjectId: local, details: { event: evt.id, stripeInvoice: o.id } });
        break;
      }
      case "charge.refunded": {
        const pi = s(o, "payment_intent");
        const refunded = n(o, "amount_refunded") ?? 0;
        const total = n(o, "amount") ?? 0;
        if (pi) {
          // Which Stripe refund this event is about. Charge payloads at 2022-11-15+ (every supported endpoint version) omit
          // Charge.refunds, so it is looked up at the pinned version BEFORE anything is written: without it the event cannot
          // be matched to the platform's refund request (the old code then emailed every platform refund a second time),
          // so it fails and is retried by reconciliation, exactly like invoice.paid's payment-link lookup.
          let latest = chargeLatestRefund(o);
          if (!latest && chargeLacksRefundList(o)) {
            if (!ctx.stripeRefundLookup) throw new Error(`charge ${o.id} payload has no refund list and Stripe is not configured to look it up`);
            latest = await ctx.stripeRefundLookup(String(o.id));
          }
          const refundId = latest?.id ?? null;
          await db.prepare(`UPDATE payments SET status = ? WHERE stripe_payment_intent_id = ?`).bind(refunded >= total ? "refunded" : "partially_refunded", pi).run();
          // Platform refund requests this Stripe refund belongs to: the one the issue step already recorded, or else one
          // approved request (or failed issue) completed by it — issued from the Stripe Dashboard, or by the issue step
          // whose Stripe call has not returned yet. stripe_refund_id is UNIQUE, so exactly one request is claimed.
          const owned = refundId ? await db.prepare(`SELECT id FROM refunds WHERE stripe_refund_id = ?`).bind(refundId).first<{ id: string }>() : null;
          let platformRefundId = owned?.id ?? null;
          if (!owned) {
            const claim = await db.prepare(`SELECT r.id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.stripe_payment_intent_id = ? AND r.status IN ('approved','failed') AND r.stripe_refund_id IS NULL
                                            ORDER BY CASE WHEN r.amount_cents = ? THEN 0 ELSE 1 END, r.created_at LIMIT 1`).bind(pi, latest?.amount ?? -1).first<{ id: string }>();
            if (claim) {
              const r = await db.prepare(`UPDATE refunds SET status = 'issued', issued_at = COALESCE(issued_at, ?), stripe_refund_id = COALESCE(stripe_refund_id, ?) WHERE id = ? AND status IN ('approved','failed')`)
                .bind(nowIso(), refundId, claim.id).run();
              if (r.meta.changes === 1) platformRefundId = claim.id;
            }
          }
          await audit(db, { actorKind: "webhook", action: "payment.refunded", subjectType: "payment", subjectId: pi, details: { event: evt.id, refunded, refund: refundId, refundRequest: platformRefundId } });
          if (platformRefundId) {
            // CREST-GAP-039: same idempotency key as the issue step (refund:<request>:issued), so the customer is emailed
            // once whichever of the two runs first.
            await notifyRefundIssued(ctx, platformRefundId, refundId ?? s(o, "id") ?? "Stripe refund");
          } else {
            // A refund made only in the Stripe Dashboard: emailed here, once per Stripe refund.
            const pay = await db.prepare(`SELECT organization_id FROM payments WHERE stripe_payment_intent_id = ?`).bind(pi).first<{ organization_id: string }>();
            const billing = (o.billing_details ?? {}) as Obj;
            const to = s(o, "receipt_email") ?? s(billing, "email") ?? (pay ? await orgBillingEmail(db, pay.organization_id) : null);
            const amount = latest?.amount ?? refunded;
            if (to && amount > 0) await sendMail(ctx, { template: "refund_decision", to, idempotencyKey: `refund:stripe:${refundId ?? evt.id}`, data: { event: "issued", amountCents: amount, reference: refundId ?? s(o, "id") ?? "Stripe refund", url: `${ctx.baseUrl}/portal/billing` } });
          }
          await syncBuildsForPaymentIntent(db, pi);
        }
        break;
      }
      case "charge.dispute.created":
      case "charge.dispute.updated":
      case "charge.dispute.closed": {
        const pi = s(o, "payment_intent");
        const pay = pi ? await db.prepare(`SELECT id, organization_id FROM payments WHERE stripe_payment_intent_id = ?`).bind(pi).first<{ id: string; organization_id: string }>() : null;
        const due = n((o.evidence_details ?? {}) as Obj, "due_by");
        // The PaymentIntent is kept so a dispute that arrives before its payment (events are unordered) is linked when the
        // payment is recorded (linkDisputesForPayment).
        await db.prepare(`INSERT INTO disputes (id, organization_id, payment_id, stripe_dispute_id, amount_cents, reason, status, evidence_due_by, created_at, updated_at, stripe_payment_intent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                          ON CONFLICT(stripe_dispute_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, amount_cents = excluded.amount_cents,
                            reason = COALESCE(excluded.reason, disputes.reason), evidence_due_by = COALESCE(excluded.evidence_due_by, disputes.evidence_due_by),
                            organization_id = COALESCE(disputes.organization_id, excluded.organization_id), payment_id = COALESCE(disputes.payment_id, excluded.payment_id),
                            stripe_payment_intent_id = COALESCE(disputes.stripe_payment_intent_id, excluded.stripe_payment_intent_id)`)
          .bind(newId("dsp"), pay?.organization_id ?? null, pay?.id ?? null, evt.data.object.id, n(o, "amount") ?? 0, s(o, "reason"), s(o, "status") ?? "unknown", due ? new Date(due * 1000).toISOString() : null, nowIso(), nowIso(), pi).run();
        if (pay) {
          // A dispute closed in the merchant's favour ("won") returns the payment to its pre-dispute state.
          if (evt.type === "charge.dispute.closed" && s(o, "status") === "won") {
            const refunded = await db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS c FROM refunds WHERE payment_id = ? AND status = 'issued'`).bind(pay.id).first<{ c: number }>();
            const amt = await db.prepare(`SELECT amount_cents FROM payments WHERE id = ?`).bind(pay.id).first<{ amount_cents: number }>();
            const restored = !refunded?.c ? "succeeded" : refunded.c >= (amt?.amount_cents ?? 0) ? "refunded" : "partially_refunded";
            await db.prepare(`UPDATE payments SET status = ? WHERE id = ? AND status = 'disputed'`).bind(restored, pay.id).run();
          } else {
            await db.prepare(`UPDATE payments SET status = 'disputed' WHERE id = ?`).bind(pay.id).run();
          }
        }
        if (pi) await syncBuildsForPaymentIntent(db, pi);
        if (evt.type !== "charge.dispute.created") {
          await audit(db, { actorKind: "webhook", action: evt.type === "charge.dispute.closed" ? "dispute.closed" : "dispute.updated", subjectType: "dispute", subjectId: evt.data.object.id, organizationId: pay?.organization_id ?? null, details: { event: evt.id, status: s(o, "status") } });
        }
        if (evt.type === "charge.dispute.created") {
          // Disputes have hard evidence deadlines: alert the Owner and support staff immediately.
          const staff = (await db.prepare(`SELECT DISTINCT user_id FROM memberships WHERE role_id IN ('owner','support')`).all<{ user_id: string }>()).results;
          const body = `Payment dispute opened for $${((n(o, "amount") ?? 0) / 100).toFixed(2)}${due ? ` — evidence due ${new Date(due * 1000).toISOString().slice(0, 10)}` : ""}. Review it in Disputes.`;
          for (const u of staff) {
            await db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,'dispute_opened','dispute',?,?,?)`)
              .bind(newId("ntf"), u.user_id, evt.data.object.id, body, nowIso()).run();
          }
          // CREST-GAP-039: the Owner(s) also get an email, once per dispute.
          const owners = (await db.prepare(`SELECT DISTINCT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id = 'owner' AND u.disabled_at IS NULL`).all<{ email: string }>()).results;
          for (const ow of owners) {
            await sendMail(ctx, { template: "dispute_opened", to: ow.email, idempotencyKey: `dispute:${evt.data.object.id}:${ow.email}`,
              data: { amountCents: n(o, "amount") ?? 0, evidenceDueBy: due ? new Date(due * 1000).toISOString().slice(0, 10) : null, url: `${ctx.baseUrl}/staff/disputes` } });
          }
          await audit(db, { actorKind: "webhook", action: "dispute.opened", subjectType: "dispute", subjectId: evt.data.object.id, organizationId: pay?.organization_id ?? null, details: { event: evt.id, amount: n(o, "amount") } });
        }
        break;
      }
      default:
        await markEventResult(db, evt.id, { ok: true, ignored: true });
        return;
    }
    await markEventResult(db, evt.id, { ok: true });
  } catch (e) {
    await markEventResult(db, evt.id, { ok: false, error: (e as Error).message });
    // Respond 200 anyway: the event is stored and retried by the reconciliation job (dead-letter after 5).
  }
}

/**
 * Records a confirmed payment for a local invoice and runs the follow-ups (project provisioning, build eligibility,
 * change order, lead conversion, staff notification, receipt email). Shared by Checkout (checkout.session.completed),
 * Stripe Invoices (invoice.paid, PAY-006) and the test-only payment simulation (payment-simulation.ts, migration 0059).
 *
 * CREST-GAP-006: the follow-ups run on EVERY delivery, including when the invoice is already paid, and each one is
 * idempotent (one project per order by unique index, conditional lead conversion, keyed receipt). So a retry after a
 * failure part-way through completes the work instead of returning early, and repeats never duplicate anything.
 */
async function applyInvoicePayment(ctx: Pick<AppContext, "db" | "email" | "baseUrl">, evt: StripeEvent, invoiceId: string,
  payment: { amountCents: number; paymentIntentId: string | null; chargeId: string | null }, to: string | null): Promise<void> {
  await confirmInvoicePayment(ctx, { provider: "stripe", eventId: evt.id }, invoiceId, payment, to);
}

/** Where a confirmed payment came from: a verified Stripe webhook, or the test-only payment simulation (0059). */
export type PaymentSource = { provider: "stripe"; eventId: string } | { provider: "simulated"; eventId: string; transactionId: string };

/** The provider-neutral payment-confirmation handler: marks the invoice paid (idempotent), then the shared follow-ups. */
export async function confirmInvoicePayment(ctx: Pick<AppContext, "db" | "email" | "baseUrl">, source: PaymentSource, invoiceId: string,
  payment: { amountCents: number; paymentIntentId: string | null; chargeId: string | null }, to: string | null): Promise<{ alreadyPaid: boolean; projectId: string | null }> {
  const simulated = source.provider === "simulated";
  const res = await markInvoicePaid(ctx.db, invoiceId, { ...payment, provider: source.provider, simulatedTransactionId: simulated ? source.transactionId : null });
  if (!simulated && payment.paymentIntentId) await linkDisputesForPayment(ctx.db, payment.paymentIntentId);
  // A simulated delivery never sends a receipt, even onto an invoice that a real payment already settled.
  const out = await completePaidInvoice(ctx, res.invoice.id, simulated ? null : to, simulated ? `the test-only payment simulation (${source.eventId}; no real transaction)` : `Stripe webhook (${source.eventId})`, { noReceipt: simulated });
  return { alreadyPaid: res.alreadyPaid, projectId: out.projectId };
}

/**
 * Links disputes recorded before their payment existed (Stripe sends events in no guaranteed order: on staging a
 * charge.dispute.created was processed 40 ms after checkout.session.completed, before the payment row was written).
 * The dispute gets its customer and payment, and an open dispute marks the payment disputed, exactly as if the events
 * had arrived in order. Idempotent.
 */
export async function linkDisputesForPayment(db: AppContext["db"], paymentIntentId: string): Promise<number> {
  const pay = await db.prepare(`SELECT id, organization_id FROM payments WHERE stripe_payment_intent_id = ?`).bind(paymentIntentId).first<{ id: string; organization_id: string }>();
  if (!pay) return 0;
  const linked = await db.prepare(`UPDATE disputes SET payment_id = ?, organization_id = COALESCE(organization_id, ?), updated_at = ? WHERE stripe_payment_intent_id = ? AND payment_id IS NULL`)
    .bind(pay.id, pay.organization_id, nowIso(), paymentIntentId).run();
  if (!linked.meta.changes) return 0;
  const open = await db.prepare(`SELECT COUNT(*) AS n FROM disputes WHERE payment_id = ? AND status NOT IN (${DISPUTE_CLOSED.map((x) => `'${x}'`).join(",")})`).bind(pay.id).first<{ n: number }>();
  if (open?.n) await db.prepare(`UPDATE payments SET status = 'disputed' WHERE id = ?`).bind(pay.id).run();
  await audit(db, { actorKind: "webhook", action: "dispute.linked_late", subjectType: "payment", subjectId: pay.id, organizationId: pay.organization_id, details: { paymentIntent: paymentIntentId, disputes: linked.meta.changes } });
  return linked.meta.changes;
}

/** Idempotent follow-ups for a paid invoice. Safe to run any number of times (webhook retries and the repair sweep). */
export async function completePaidInvoice(ctx: Pick<AppContext, "db" | "email" | "baseUrl">, invoiceId: string, to: string | null, source: string, opts: { noReceipt?: boolean } = {}): Promise<{ projectId: string | null; provisioned: boolean }> {
  const db = ctx.db;
  const inv = await db.prepare(`SELECT * FROM invoices WHERE id = ?`).bind(invoiceId).first<{ id: string; organization_id: string; order_id: string | null; project_id: string | null; milestone_kind: string | null; amount_cents: number; status: string }>();
  if (!inv || inv.status !== "paid") throw new Error(`Invoice ${invoiceId} is not paid`);
  // Read from the payment record (not a parameter) so the repair sweep treats a simulated invoice the same way.
  const simulated = !!(await db.prepare(`SELECT 1 FROM payments WHERE invoice_id = ? AND provider = 'simulated'`).bind(inv.id).first());
  let projectId = inv.project_id;
  let provisioned = false;
  if (!projectId && inv.order_id && (inv.milestone_kind === "full" || inv.milestone_kind === "deposit_50")) {
    const p = await provisionProjectOnce(db, inv.order_id);
    projectId = p.projectId; provisioned = p.created;
  }
  // AI Builds: re-evaluate the first build now that a verified payment exists (fast: rows only; the sweep recovers failures).
  await syncProjectBuildSafe(db, projectId, "payment");
  if (inv.milestone_kind === "change_order" && inv.project_id) {
    await db.prepare(`UPDATE change_orders SET status = 'paid' WHERE invoice_id = ? AND status = 'approved'`).bind(inv.id).run();
  }
  if (inv.order_id) {
    const lead = await db.prepare(`SELECT lead_id FROM orders WHERE id = ?`).bind(inv.order_id).first<{ lead_id: string | null }>();
    if (lead?.lead_id) {
      const conv = await db.prepare(`UPDATE leads SET stage = 'converted', updated_at = ? WHERE id = ? AND stage IN ('accepted','awaiting_payment')`).bind(nowIso(), lead.lead_id).run();
      if (conv.meta.changes === 1) {
        await db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'system',?,?)`).bind(newId("act"), lead.lead_id, simulated ? `SIMULATED payment confirmed by ${source}; lead converted` : `Payment confirmed by ${source}; lead converted`, nowIso()).run();
      }
    }
  }
  // CREST-GAP-037: owners and project managers hear about a newly provisioned project exactly once.
  if (provisioned && projectId) {
    const p = await db.prepare(`SELECT p.name, o.name AS org_name FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.id = ?`).bind(projectId).first<{ name: string; org_name: string }>();
    const staff = (await db.prepare(`SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id IN ('owner','project_manager') AND u.disabled_at IS NULL`).all<{ user_id: string }>()).results;
    for (const u of staff) await notify(db, u.user_id, { kind: "project_provisioned", subjectType: "project", subjectId: projectId, body: `Payment confirmed: ${p?.name ?? "a new project"} (${p?.org_name ?? "customer"}) was provisioned and awaits onboarding. Assign a project manager.` });
  }
  // A simulated payment is not a real transaction: no receipt is sent.
  const recipient = simulated || opts.noReceipt ? null : to ?? await orgBillingEmail(db, inv.organization_id);
  if (recipient) await sendMail(ctx, { template: "receipt", to: recipient, idempotencyKey: `receipt:${inv.id}`,
    data: { amountCents: inv.amount_cents, next: projectId ? "onboarding" : "billing", url: `${ctx.baseUrl}/portal${projectId ? `/projects/${projectId}/onboarding` : "/billing"}` } });
  return { projectId, provisioned };
}

async function orgBillingEmail(db: AppContext["db"], organizationId: string): Promise<string | null> {
  return (await db.prepare(`SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.role_id = 'customer_admin' AND u.disabled_at IS NULL ORDER BY m.created_at LIMIT 1`)
    .bind(organizationId).first<{ email: string }>())?.email ?? null;
}

/**
 * CREST-GAP-006 repair sweep (scheduled): paid full/deposit invoices whose order has no project (provisioning failed and
 * the event was dead-lettered, or any other gap) get the same idempotent follow-ups. Never marks anything paid.
 */
export async function repairPaidInvoicesWithoutProject(ctx: Pick<AppContext, "db" | "email" | "baseUrl">): Promise<{ checked: number; repaired: number; failed: number }> {
  const rows = (await ctx.db.prepare(`SELECT i.id FROM invoices i WHERE i.status = 'paid' AND i.order_id IS NOT NULL AND i.milestone_kind IN ('full','deposit_50')
      AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.order_id = i.order_id) ORDER BY i.paid_at LIMIT 50`).all<{ id: string }>()).results;
  let repaired = 0, failed = 0;
  for (const r of rows) {
    try {
      const out = await completePaidInvoice(ctx, r.id, null, "the paid-invoice repair sweep");
      if (out.projectId) repaired++;
      await audit(ctx.db, { actorKind: "system", action: "invoice.followups_repaired", subjectType: "invoice", subjectId: r.id, details: { projectId: out.projectId } });
    } catch (e) {
      failed++;
      console.error(JSON.stringify({ level: "error", msg: "paid invoice repair failed", invoiceId: r.id, error: (e as Error).message }));
    }
  }
  return { checked: rows.length, repaired, failed };
}

async function syncBuildsForPaymentIntent(db: AppContext["db"], pi: string) {
  const rows = (await db.prepare(`SELECT DISTINCT i.project_id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.stripe_payment_intent_id = ? AND i.project_id IS NOT NULL`).bind(pi).all<{ project_id: string }>()).results;
  for (const r of rows) await syncProjectBuildSafe(db, r.project_id, "sweep");
}

async function upsertSubscription(db: AppContext["db"], stripeId: string, orgId: string, productId: string | null, status: string, periodEnd: string | null): Promise<{ previous: string | null; status: string; productId: string | null }> {
  const allowed = ["trialing", "active", "past_due", "canceled", "incomplete", "unpaid"];
  const st = allowed.includes(status) ? status : status === "incomplete_expired" ? "canceled" : "incomplete";
  const existing = await db.prepare(`SELECT id, status, product_id FROM subscriptions WHERE stripe_subscription_id = ?`).bind(stripeId).first<{ id: string; status: string; product_id: string }>();
  if (existing) {
    await db.prepare(`UPDATE subscriptions SET status = ?, current_period_end = COALESCE(?, current_period_end), updated_at = ? WHERE id = ?`).bind(st, periodEnd, nowIso(), existing.id).run();
    return { previous: existing.status, status: st, productId: existing.product_id };
  }
  if (!productId) throw new Error("New subscription is missing product_id metadata");
  await db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, stripe_subscription_id, status, current_period_end, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(newId("sub"), orgId, productId, stripeId, st, periodEnd, nowIso(), nowIso()).run();
  return { previous: null, status: st, productId };
}

/** Reconciliation: retry failed events (PAY-009). Called by the scheduled worker. */
export async function retryFailedStripeEvents(ctx: EventCtx): Promise<number> {
  const rows = (await ctx.db.prepare(`SELECT id, payload FROM stripe_events WHERE status IN ('failed','received') AND attempts < 5 ORDER BY stripe_created LIMIT 50`).all<{ id: string; payload: string }>()).results;
  for (const r of rows) await processStripeEvent(ctx, JSON.parse(r.payload) as StripeEvent);
  return rows.length;
}
