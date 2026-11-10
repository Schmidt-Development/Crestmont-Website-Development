// Per-environment Stripe payments mode (CREST-GAP-007, CREST-GAP-008, CREST-GAP-010, PAY-010).
//
// One function decides which Stripe mode an environment may use, from the environment name, the key's
// prefix and an explicit Founder flag. Every Stripe adapter and every webhook livemode guard compares
// against this expected mode; nothing anywhere defaults to live.
//
//   development / staging : test keys only (sk_test_ / rk_test_). Live keys are refused. Events must have livemode false.
//   production            : NO payments until the Founder sets PAYMENTS_LIVE_AUTHORIZED="yes" (exact value). With the flag,
//                           live keys only (sk_live_ / rk_live_); a test key is refused, because test-card "payments"
//                           would otherwise provision real work. Events must have livemode true. Without the flag every
//                           Stripe event is refused.
//
// Production checkout is additionally closed while the legal policies are drafts or the operating entity is unnamed
// (CREST-GAP-010): see commerceBlock().
import { DRAFT_BANNER } from "../content/legal.ts";

export type StripeMode = "test" | "live";
export type PaymentsModeDecision =
  | { mode: StripeMode; key: string; reason: null }
  | { mode: "none"; key: null; reason: string };

export interface PaymentsEnv { ENVIRONMENT: string; STRIPE_SECRET_KEY?: string; PAYMENTS_LIVE_AUTHORIZED?: string }

export const LIVE_FLAG_VALUE = "yes";

export function keyMode(key: string): StripeMode | null {
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  return null;
}

/** The Stripe mode this environment expects, or "none" with the reason payments are unavailable. */
export function paymentsMode(env: PaymentsEnv): PaymentsModeDecision {
  const key = env.STRIPE_SECRET_KEY;
  if (env.ENVIRONMENT === "production") {
    if (env.PAYMENTS_LIVE_AUTHORIZED !== LIVE_FLAG_VALUE) {
      return { mode: "none", key: null, reason: "Live payments are not authorised by the Founder (PAYMENTS_LIVE_AUTHORIZED is not \"yes\"); production never uses Stripe test mode." };
    }
    if (!key) return { mode: "none", key: null, reason: "STRIPE_SECRET_KEY is not set." };
    const m = keyMode(key);
    if (m !== "live") return { mode: "none", key: null, reason: "Production accepts only a live Stripe key (sk_live_/rk_live_); the configured key is not a live key and is refused." };
    return { mode: "live", key, reason: null };
  }
  if (!key) return { mode: "none", key: null, reason: "STRIPE_SECRET_KEY is not set." };
  const m = keyMode(key);
  if (m !== "test") return { mode: "none", key: null, reason: `${env.ENVIRONMENT} accepts only Stripe test-mode keys (sk_test_/rk_test_); live payments are authorised on production only (PAY-010).` };
  return { mode: "test", key, reason: null };
}

/** Kind of the configured Stripe key from its prefix only ("live", "test", "unrecognized", "missing"); never the key. */
export function stripeKeyKind(env: Pick<PaymentsEnv, "STRIPE_SECRET_KEY">): "live" | "test" | "unrecognized" | "missing" {
  return env.STRIPE_SECRET_KEY ? (keyMode(env.STRIPE_SECRET_KEY) ?? "unrecognized") : "missing";
}

/** Everything that keeps production checkout closed, in plain words (empty = open). commerceBlock() reports the first. */
export function commerceBlockers(env: PaymentsEnv & { STRIPE_WEBHOOK_SECRET?: string }, settings: Record<string, string>): string[] {
  if (env.ENVIRONMENT !== "production") return paymentsMode(env).reason ? [paymentsMode(env).reason!] : [];
  const out: string[] = [];
  if (env.PAYMENTS_LIVE_AUTHORIZED !== LIVE_FLAG_VALUE) out.push("PAYMENTS_LIVE_AUTHORIZED is not \"yes\" (Founder authorization of live payments).");
  const kind = stripeKeyKind(env);
  if (kind !== "live") out.push(kind === "missing" ? "STRIPE_SECRET_KEY is not set." : `STRIPE_SECRET_KEY is a ${kind} key; production needs a live key (sk_live_/rk_live_).`);
  if (!env.STRIPE_WEBHOOK_SECRET) out.push("STRIPE_WEBHOOK_SECRET is not set (the live webhook endpoint's signing secret).");
  if (DRAFT_BANNER.trim()) out.push("The policies still carry the \"pending attorney review\" draft banner (src/content/legal.ts DRAFT_BANNER).");
  if (!settings["business.legal_name"]?.trim()) out.push("The operating business entity (legal name) is not recorded in Owner → Business settings.");
  return out;
}

/** The livemode value Stripe events must carry here, or null when every event must be refused. */
export function expectedLivemode(env: PaymentsEnv): boolean | null {
  const d = paymentsMode(env);
  return d.mode === "none" ? (env.ENVIRONMENT === "production" ? null : false) : d.mode === "live";
}

/**
 * CREST-GAP-010: production checkout stays closed while the policies are drafts (the draft banner is present) or the
 * operating entity is not recorded in Business settings. Returns the reason, or null when checkout may open.
 * Staging and development are unchanged (test mode, clearly labelled).
 */
export function commerceBlock(env: PaymentsEnv, settings: Record<string, string>): string | null {
  if (env.ENVIRONMENT !== "production") return null;
  const d = paymentsMode(env);
  if (d.mode !== "live") return d.reason;
  if (DRAFT_BANNER.trim()) return "Our policies are still drafts pending attorney review, so online checkout is not open yet.";
  if (!settings["business.legal_name"]?.trim()) return "The operating business entity is not recorded yet, so online checkout is not open.";
  return null;
}
