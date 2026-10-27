// Applies verified Stripe events (PAY-003). Webhooks are the only source of payment truth:
// browser redirects never mark anything paid. Every handler is idempotent.
import type { AppContext } from "../app/context.ts";
import { nowIso, newId } from "../lib/db.ts";
import { isStaleEvent, markEventResult, type StripeEvent } from "../domain/stripe-webhook.ts";
import { markInvoicePaid, provisionProject } from "./commerce.ts";
import { audit } from "./security.ts";
import { sendMail } from "./mailer.ts";
import { MAINTENANCE_PLANS } from "../domain/catalog.ts";
import { syncProjectBuildSafe } from "./builds.ts";

type Obj = Record<string, unknown>;
const s = (o: Obj, k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
const n = (o: Obj, k: string) => (typeof o[k] === "number" ? (o[k] as number) : null);
const meta = (o: Obj) => ((o.metadata ?? {}) as Record<string, string>);

export async function processStripeEvent(ctx: Pick<AppContext, "db" | "email" | "baseUrl">, evt: StripeEvent): Promise<void> {
  const db = ctx.db;
  try {
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
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const m = meta(o);
        const org = m.organization_id ?? (await db.prepare(`SELECT id FROM organizations WHERE stripe_customer_id = ?`).bind(s(o, "customer")).first<{ id: string }>())?.id;
        if (!org) throw new Error("Subscription for unknown customer");
        const status = evt.type === "customer.subscription.deleted" ? "canceled" : (s(o, "status") ?? "incomplete");
        const end = n(o, "current_period_end");
        const change = await upsertSubscription(db, evt.data.object.id, org, m.product_id ?? null, status, end ? new Date(end * 1000).toISOString() : null);
        // EMAIL-002 subscription_update: customer administrators hear about real status changes of an existing plan.
        if (change.previous && change.previous !== change.status) {
          const plan = change.productId ? (MAINTENANCE_PLANS as Record<string, { name: string }>)[change.productId]?.name ?? change.productId : "maintenance";
          const admins = (await db.prepare(`SELECT u.email FROM memberships mb JOIN users u ON u.id = mb.user_id WHERE mb.organization_id = ? AND mb.role_id = 'customer_admin' AND u.disabled_at IS NULL`).bind(org).all<{ email: string }>()).results;
          for (const a of admins) await sendMail(ctx, { template: "subscription_update", to: a.email, idempotencyKey: `sub:${evt.id}:${a.email}`, data: { planName: plan, status: change.status, url: `${ctx.baseUrl}/portal/billing` } });
        }
        break;
      }
      case "invoice.payment_failed": {
        const sub = s(o, "subscription");
        if (sub) await db.prepare(`UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE stripe_subscription_id = ?`).bind(nowIso(), sub).run();
        const to = s(o, "customer_email");
        if (to) await sendMail(ctx, { template: "failed_payment", to, idempotencyKey: `failed:${evt.id}`, data: { url: `${ctx.baseUrl}/portal/billing` } });
        await audit(db, { actorKind: "webhook", action: "payment.failed", subjectType: "subscription", subjectId: sub, details: { event: evt.id } });
        break;
      }
      case "invoice.paid": {
        const sub = s(o, "subscription");
        if (sub) await db.prepare(`UPDATE subscriptions SET status = 'active', updated_at = ? WHERE stripe_subscription_id = ? AND status = 'past_due'`).bind(nowIso(), sub).run();
        // PAY-006: a Stripe Invoice created for a milestone invoice (src/services/stripe-invoices.ts).
        const local = meta(o).crestmont_invoice_id;
        if (local) {
          const inv = await db.prepare(`SELECT id, stripe_invoice_id FROM invoices WHERE id = ?`).bind(local).first<{ id: string; stripe_invoice_id: string | null }>();
          if (!inv) throw new Error(`Stripe invoice ${o.id} references unknown invoice ${local}`);
          if (inv.stripe_invoice_id && inv.stripe_invoice_id !== o.id) throw new Error(`Stripe invoice ${o.id} does not match ${inv.stripe_invoice_id} recorded for ${local}`);
          await db.prepare(`UPDATE invoices SET stripe_invoice_id = COALESCE(stripe_invoice_id, ?), stripe_invoice_status = 'paid', stripe_invoice_synced_at = ? WHERE id = ?`).bind(o.id, nowIso(), local).run();
          await applyInvoicePayment(ctx, evt, local, { amountCents: n(o, "amount_paid") ?? -1, paymentIntentId: s(o, "payment_intent"), chargeId: s(o, "charge") }, s(o, "customer_email"));
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
          await db.prepare(`UPDATE payments SET status = ? WHERE stripe_payment_intent_id = ?`).bind(refunded >= total ? "refunded" : "partially_refunded", pi).run();
          // Refunds approved in the platform but issued from the Stripe dashboard are completed here too.
          const latestRefund = ((o.refunds as Obj | undefined)?.data as Obj[] | undefined)?.[0];
          await db.prepare(`UPDATE refunds SET status = 'issued', issued_at = COALESCE(issued_at, ?), stripe_refund_id = COALESCE(stripe_refund_id, ?)
                            WHERE status IN ('approved','failed') AND payment_id IN (SELECT id FROM payments WHERE stripe_payment_intent_id = ?)`)
            .bind(nowIso(), latestRefund ? s(latestRefund, "id") : null, pi).run();
          await audit(db, { actorKind: "webhook", action: "payment.refunded", subjectType: "payment", subjectId: pi, details: { event: evt.id, refunded } });
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
        await db.prepare(`INSERT INTO disputes (id, organization_id, payment_id, stripe_dispute_id, amount_cents, reason, status, evidence_due_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
                          ON CONFLICT(stripe_dispute_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, amount_cents = excluded.amount_cents,
                            reason = COALESCE(excluded.reason, disputes.reason), evidence_due_by = COALESCE(excluded.evidence_due_by, disputes.evidence_due_by),
                            organization_id = COALESCE(disputes.organization_id, excluded.organization_id), payment_id = COALESCE(disputes.payment_id, excluded.payment_id)`)
          .bind(newId("dsp"), pay?.organization_id ?? null, pay?.id ?? null, evt.data.object.id, n(o, "amount") ?? 0, s(o, "reason"), s(o, "status") ?? "unknown", due ? new Date(due * 1000).toISOString() : null, nowIso(), nowIso()).run();
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
 * Records a confirmed payment for a local invoice and runs the follow-ups (project provisioning, change
 * order, lead conversion, receipt email). Shared by Checkout (checkout.session.completed) and Stripe
 * Invoices (invoice.paid, PAY-006). Idempotent through markInvoicePaid.
 */
async function applyInvoicePayment(ctx: Pick<AppContext, "db" | "email" | "baseUrl">, evt: StripeEvent, invoiceId: string,
  payment: { amountCents: number; paymentIntentId: string | null; chargeId: string | null }, to: string | null): Promise<void> {
  const db = ctx.db;
  const res = await markInvoicePaid(db, invoiceId, payment);
  if (res.alreadyPaid) return;
  const inv = res.invoice;
  let projectId = inv.project_id;
  if (!projectId && inv.order_id && (inv.milestone_kind === "full" || inv.milestone_kind === "deposit_50")) projectId = await provisionProject(db, inv.order_id);
  // AI Builds: re-evaluate the first build now that a verified payment exists (fast: rows only; the sweep recovers failures).
  await syncProjectBuildSafe(db, projectId, "payment");
  if (inv.milestone_kind === "change_order" && inv.project_id) {
    await db.prepare(`UPDATE change_orders SET status = 'paid' WHERE invoice_id = ? AND status = 'approved'`).bind(inv.id).run();
  }
  if (inv.order_id) {
    const lead = await db.prepare(`SELECT lead_id FROM orders WHERE id = ?`).bind(inv.order_id).first<{ lead_id: string | null }>();
    if (lead?.lead_id) {
      await db.batch([
        db.prepare(`UPDATE leads SET stage = 'converted', updated_at = ? WHERE id = ? AND stage IN ('accepted','awaiting_payment')`).bind(nowIso(), lead.lead_id),
        db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'system',?,?)`).bind(newId("act"), lead.lead_id, `Payment confirmed by Stripe webhook (${evt.id}); lead converted`, nowIso()),
      ]);
    }
  }
  if (to) await sendMail(ctx, { template: "receipt", to, idempotencyKey: `receipt:${inv.id}`,
    data: { amountCents: inv.amount_cents, next: projectId ? "onboarding" : "billing", url: `${ctx.baseUrl}/portal${projectId ? `/projects/${projectId}/onboarding` : "/billing"}` } });
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
export async function retryFailedStripeEvents(ctx: Pick<AppContext, "db" | "email" | "baseUrl">): Promise<number> {
  const rows = (await ctx.db.prepare(`SELECT id, payload FROM stripe_events WHERE status IN ('failed','received') AND attempts < 5 ORDER BY stripe_created LIMIT 50`).all<{ id: string; payload: string }>()).results;
  for (const r of rows) await processStripeEvent(ctx, JSON.parse(r.payload) as StripeEvent);
  return rows.length;
}
