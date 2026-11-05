// Stripe Invoice creation for 50/25/25 milestone invoices (PAY-006).
//
// Flow (https://docs.stripe.com/invoicing/integration):
//   1. Stripe Customer for the organization (POST /v1/customers, once; stored on organizations.stripe_customer_id)
//   2. Draft invoice (POST /v1/invoices, collection_method=send_invoice, auto_advance=false,
//      pending_invoice_items_behavior=exclude, metadata.crestmont_invoice_id)
//   3. One invoice item for exactly the local invoice amount (POST /v1/invoiceitems with invoice=…)
//   4. Verify the draft total (GET /v1/invoices/:id), then finalize (POST /v1/invoices/:id/finalize,
//      auto_advance=false). The invoice is never "sent" by Stripe: the customer pays through the
//      hosted invoice link shown in the portal.
//
// No duplicate billing on retry:
//   - every POST has an idempotency key derived from the local invoice id;
//   - the Stripe invoice id is stored as soon as the draft exists, and a retry resumes from it;
//   - before creating a draft, the customer's Stripe invoices are searched for one already tagged
//     with this local invoice id (covers a crash between Stripe's response and the local write);
//   - an item is added only while the draft total is 0, and finalize only runs when total == amount;
//   - an invoice that already has a Checkout session is refused (it would be payable twice).
// The local invoice is still marked paid only by the verified invoice.paid webhook.
import type { Env } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { HttpError } from "../app/http.ts";
import { StripeInvoicing, LivePaymentsNotAuthorized, type StripeInvoice } from "../adapters/payments.ts";
import { audit } from "./security.ts";
import { checkoutLinesFor } from "./tax.ts";
import { paymentsMode } from "../domain/payments-mode.ts";

export const STRIPE_INVOICE_KINDS = ["deposit_50", "design_25", "prelaunch_25"] as const;
/** FD-11 (Founder decision, 2026-11): invoices are due Net 7. Upfront package payments and custom 50/25/25 milestone
 *  schedules are unchanged; this is the payment term on each Stripe invoice that is sent. No late fees or interest (FD-12). */
export const DAYS_UNTIL_DUE = 7;
export const STRIPE_NOT_CONFIGURED = "Stripe is not configured (no STRIPE_SECRET_KEY), so Stripe invoices cannot be created. Nothing was sent to Stripe.";

export type StripeInvoicer = { ok: true; client: StripeInvoicing } | { ok: false; reason: string };

export function stripeInvoicer(env: Env): StripeInvoicer {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, reason: STRIPE_NOT_CONFIGURED };
  const pm = paymentsMode(env); // CREST-GAP-007/008
  if (pm.mode === "none") return { ok: false, reason: `The Stripe key is refused here; live payments are not authorised (PAY-010). ${pm.reason} Nothing was sent to Stripe.` };
  try {
    return { ok: true, client: new StripeInvoicing(pm.key, env.overrides?.fetch ?? fetch, pm.mode) };
  } catch (e) {
    if (e instanceof LivePaymentsNotAuthorized) return { ok: false, reason: "A non-test Stripe key is set; live payments are not authorised (PAY-010). Nothing was sent to Stripe." };
    throw e;
  }
}

interface LocalInvoice {
  id: string; organization_id: string; org_name: string; stripe_customer_id: string | null; order_id: string | null; project_id: string | null;
  milestone_kind: string | null; amount_cents: number; subtotal_cents: number | null; tax_detail_json: string | null; status: string; description: string | null; stripe_invoice_id: string | null;
  stripe_invoice_status: string | null; stripe_checkout_session_id: string | null;
}

/** Why an invoice cannot get a Stripe invoice, or null when it can (also used to show/hide the action). */
export function stripeInvoiceBlocker(inv: Pick<LocalInvoice, "milestone_kind" | "status" | "amount_cents" | "stripe_checkout_session_id" | "stripe_invoice_status">): string | null {
  if (!(STRIPE_INVOICE_KINDS as readonly string[]).includes(inv.milestone_kind ?? "")) return "Only 50/25/25 milestone invoices are billed as Stripe invoices; other invoices are paid through Checkout.";
  if (inv.status !== "open") return "Only open invoices can be billed in Stripe.";
  if (inv.amount_cents <= 0) return "This invoice has no amount due.";
  if (inv.stripe_checkout_session_id) return "The customer already started a Stripe Checkout payment for this invoice. A Stripe invoice would make it payable twice.";
  if (inv.stripe_invoice_status === "open" || inv.stripe_invoice_status === "paid") return null; // already done; calling again is a no-op
  return null;
}

export interface StripeInvoiceResult { outcome: "created" | "resumed" | "already_finalized"; stripeInvoiceId: string; status: string; hostedUrl: string | null; number: string | null }

async function persist(db: Db, id: string, s: StripeInvoice) {
  await db.prepare(`UPDATE invoices SET stripe_invoice_id = ?, stripe_invoice_status = ?, stripe_invoice_number = ?, stripe_hosted_invoice_url = ?, stripe_invoice_error = NULL, stripe_invoice_synced_at = ? WHERE id = ?`)
    .bind(s.id, s.status, s.number ?? null, s.hosted_invoice_url ?? null, nowIso(), id).run();
}

export async function createStripeMilestoneInvoice(db: Db, env: Env, actorUserId: string, invoiceId: string): Promise<StripeInvoiceResult> {
  const inv = await db.prepare(`SELECT i.id, i.organization_id, o.name AS org_name, o.stripe_customer_id, i.order_id, i.project_id, i.milestone_kind, i.amount_cents, i.subtotal_cents, i.tax_detail_json, i.status, i.description,
        i.stripe_invoice_id, i.stripe_invoice_status, i.stripe_checkout_session_id
      FROM invoices i JOIN organizations o ON o.id = i.organization_id WHERE i.id = ?`).bind(invoiceId).first<LocalInvoice>();
  if (!inv) throw new HttpError(404, "Invoice not found.");
  if (inv.stripe_invoice_id && (inv.stripe_invoice_status === "open" || inv.stripe_invoice_status === "paid")) {
    const row = await db.prepare(`SELECT stripe_hosted_invoice_url, stripe_invoice_number FROM invoices WHERE id = ?`).bind(inv.id).first<{ stripe_hosted_invoice_url: string | null; stripe_invoice_number: string | null }>();
    return { outcome: "already_finalized", stripeInvoiceId: inv.stripe_invoice_id, status: inv.stripe_invoice_status, hostedUrl: row?.stripe_hosted_invoice_url ?? null, number: row?.stripe_invoice_number ?? null };
  }
  const blocker = stripeInvoiceBlocker(inv);
  if (blocker) throw new HttpError(409, blocker);
  const invoicer = stripeInvoicer(env);
  if (!invoicer.ok) throw new HttpError(409, invoicer.reason);
  const stripe = invoicer.client;
  const description = inv.description ?? inv.milestone_kind!;
  const resumed = !!inv.stripe_invoice_id;
  try {
    // 1. Customer
    let customer = inv.stripe_customer_id;
    if (!customer) {
      const billing = await db.prepare(`SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.role_id = 'customer_admin' AND u.disabled_at IS NULL ORDER BY m.created_at LIMIT 1`)
        .bind(inv.organization_id).first<{ email: string }>();
      const c = await stripe.createCustomer({ name: inv.org_name, email: billing?.email ?? null, organizationId: inv.organization_id });
      await db.prepare(`UPDATE organizations SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?`).bind(c.id, inv.organization_id).run();
      customer = (await db.prepare(`SELECT stripe_customer_id FROM organizations WHERE id = ?`).bind(inv.organization_id).first<{ stripe_customer_id: string }>())!.stripe_customer_id;
    }
    // 2. Draft invoice: resume the stored one, else adopt one already tagged with this invoice, else create.
    let si: StripeInvoice | null = null;
    if (inv.stripe_invoice_id) si = await stripe.retrieveInvoice(inv.stripe_invoice_id);
    if (!si) {
      const existing = (await stripe.listCustomerInvoices(customer)).data.find((x) => x.metadata?.crestmont_invoice_id === inv.id && x.status !== "void");
      si = existing ?? await stripe.createInvoice({ customer, description, daysUntilDue: DAYS_UNTIL_DUE, localInvoiceId: inv.id,
        metadata: { crestmont_invoice_id: inv.id, organization_id: inv.organization_id, project_id: inv.project_id ?? "", order_id: inv.order_id ?? "", milestone_kind: inv.milestone_kind ?? "" } });
    }
    if (si.metadata?.crestmont_invoice_id && si.metadata.crestmont_invoice_id !== inv.id) throw new Error(`Stripe invoice ${si.id} belongs to local invoice ${si.metadata.crestmont_invoice_id}`);
    if (si.status === "void" || si.status === "uncollectible") throw new Error(`Stripe invoice ${si.id} is ${si.status}; void it locally or create a new invoice after review`);
    await persist(db, inv.id, si);
    // 3–4. Item, verify, finalize — only while still a draft.
    if (si.status === "draft") {
      if (si.total === 0) {
        // LEGAL-005: the taxable amount first (same idempotency key as before), then one item per jurisdiction's tax.
        for (const l of checkoutLinesFor({ ...inv, description }, description)) {
          await stripe.addInvoiceItem({ customer, invoice: si.id, amountCents: l.amountCents, description: l.name, localInvoiceId: inv.id, taxJurisdictionId: l.taxJurisdictionId });
        }
        si = await stripe.retrieveInvoice(si.id);
      }
      if (si.total !== inv.amount_cents || si.currency !== "usd") {
        throw new Error(`Stripe draft ${si.id} totals ${si.total} ${si.currency}; the invoice is ${inv.amount_cents} usd. Not finalized — review it in Stripe`);
      }
      si = await stripe.finalizeInvoice(si.id, inv.id);
    }
    if (si.amount_due + si.amount_paid !== inv.amount_cents) throw new Error(`Finalized Stripe invoice ${si.id} is for ${si.amount_due + si.amount_paid} cents; expected ${inv.amount_cents}`);
    await persist(db, inv.id, si);
    await audit(db, { actorUserId, action: "invoice.stripe_invoice_created", subjectType: "invoice", subjectId: inv.id, organizationId: inv.organization_id,
      details: { stripeInvoiceId: si.id, status: si.status, number: si.number, amountCents: inv.amount_cents, resumed } });
    return { outcome: resumed ? "resumed" : "created", stripeInvoiceId: si.id, status: si.status ?? "unknown", hostedUrl: si.hosted_invoice_url ?? null, number: si.number ?? null };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = (e as Error).message.slice(0, 500);
    await db.prepare(`UPDATE invoices SET stripe_invoice_error = ?, stripe_invoice_synced_at = ? WHERE id = ?`).bind(msg, nowIso(), inv.id).run();
    await audit(db, { actorUserId, action: "invoice.stripe_invoice_failed", subjectType: "invoice", subjectId: inv.id, organizationId: inv.organization_id, details: { error: msg } });
    throw new HttpError(502, `Stripe invoice was not completed: ${msg}. Retrying is safe; it resumes without billing twice.`);
  }
}
