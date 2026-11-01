// Staging-only Stripe check run INSIDE the Worker, which holds the Stripe key (the GitHub workflow never sees it).
// Called by scripts/stripe-staging-check.ts through POST /api/payments/stripe-staging-check (scheduler-key signed).
//   - probe: a FRESH read-only Stripe query (balance, account, webhook endpoints, event destinations) via the
//     integration probe, so every run reflects the destination as configured right now, never a stored row.
//   - deliver: a genuine Stripe TEST-mode event. Creates a $1 Checkout Session tagged crestmont_staging_check and expires
//     it at once; Stripe then sends a signed checkout.session.expired to the configured destination. The handler applies
//     nothing for a session without an invoice, so the only effect on staging is the stored, verified event.
// Refused on production and unless payments run in Stripe test mode. No value of any key or secret is returned.
import type { Env } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { paymentsMode } from "../domain/payments-mode.ts";
import { StripePayments } from "../adapters/payments.ts";
import { verifyIntegration, ProbeUnavailable } from "./integrations.ts";

export class StripeCheckRefused extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

export interface StripeStagingCheck {
  checkedAt: string;
  probe: { status: string; detail: string };
  delivery: { sessionId: string; expired: boolean } | null;
}

export async function runStripeStagingCheck(d: { db: Db; env: Env; baseUrl: string; fetch: typeof fetch }, opts: { deliver: boolean }): Promise<StripeStagingCheck> {
  if (d.env.ENVIRONMENT === "production") throw new StripeCheckRefused(404, "Not available on production");
  const pm = paymentsMode(d.env);
  if (pm.mode !== "test" || !pm.key) throw new StripeCheckRefused(409, `Stripe test mode is not configured here (${pm.reason ?? pm.mode})`);
  const checkedAt = new Date().toISOString();
  let probe: { status: string; detail: string };
  try { probe = await verifyIntegration({ db: d.db, env: d.env, storage: null, fetchImpl: d.fetch }, "stripe", null); }
  catch (e) { probe = { status: "unavailable", detail: e instanceof ProbeUnavailable ? e.message : `Probe error: ${(e as Error).message.slice(0, 200)}` }; }
  let delivery: StripeStagingCheck["delivery"] = null;
  if (opts.deliver) {
    const stripe = new StripePayments(pm.key, d.fetch, "test");
    const base = d.baseUrl.replace(/\/$/, "");
    const s = await stripe.createCheckout({
      mode: "payment", lines: [{ name: "Crestmont staging webhook check (TEST MODE, never paid)", amountCents: 100 }],
      customerEmail: "stripe-check@crestmontwebsitedevelopment.com", successUrl: `${base}/`, cancelUrl: `${base}/`,
      metadata: { crestmont_staging_check: "1" }, idempotencyKey: `staging-check:${checkedAt}`,
    });
    const x = await stripe.expireCheckout(s.id);
    delivery = { sessionId: s.id, expired: x.status === "expired" };
  }
  return { checkedAt, probe, delivery };
}
