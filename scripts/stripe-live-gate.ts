// Production release gates for customer access and live payments (Founder authorization, 2026-11-12).
//
//   node scripts/stripe-live-gate.ts flags [wrangler.toml]   prints live=yes|no and open=yes|no (committed production vars)
//   node scripts/stripe-live-gate.ts check <probe.json>      exit 0 only when the live Stripe setup is verified
//
// `check` reads the JSON of POST /api/ops/integration-probe (src/services/integrations.ts, read-only calls with the
// Worker's own key) and requires: Stripe status "verified" (key works in live mode, webhook endpoint for
// PRODUCTION_URL/api/webhooks/stripe enabled at a supported API version with every handled event) AND the account can
// take charges. It prints the provider's own summary (account id and flags, no secret) and the reason when it refuses.
import { readFileSync } from "node:fs";
import { productionVars } from "../src/readiness/phased-release.ts";

export function productionFlags(toml: string): { live: boolean; open: boolean } {
  const start = toml.indexOf("[env.production]");
  if (start < 0) return { live: false, open: false };
  const next = toml.indexOf("\n[env.", start + 1);
  const vars = productionVars(toml.slice(start, next > 0 ? next : undefined));
  return { live: vars.PAYMENTS_LIVE_AUTHORIZED === "yes", open: vars.PUBLIC_LAUNCH === "open" };
}

export function stripeLiveProblem(probe: unknown): string | null {
  const s = (probe as Record<string, { status?: string; detail?: string }> | null)?.stripe;
  if (!s) return "the probe returned no Stripe result";
  if (s.status !== "verified") return `Stripe is ${s.status ?? "unknown"}: ${s.detail ?? ""}`.trim();
  if (!/live mode/.test(s.detail ?? "")) return `Stripe was not verified in live mode: ${s.detail}`;
  if (!/charges enabled/.test(s.detail ?? "")) return `the live Stripe account cannot take charges yet: ${s.detail}`;
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, file] = process.argv.slice(2);
  if (mode === "flags") {
    const f = productionFlags(readFileSync(file ?? "wrangler.toml", "utf8"));
    console.log(`live=${f.live ? "yes" : "no"}\nopen=${f.open ? "yes" : "no"}`);
  } else if (mode === "check") {
    const probe = JSON.parse(readFileSync(file, "utf8"));
    const problem = stripeLiveProblem(probe);
    console.log(`- Stripe: ${probe?.stripe?.status ?? "?"} — ${probe?.stripe?.detail ?? ""}`);
    if (problem) { console.log(`::error title=Live Stripe not verified::${problem} Live payments were not opened; nothing was deployed.`); process.exit(1); }
    console.log("- Live Stripe verified: live key, charges enabled, webhook endpoint complete.");
  } else { console.error("usage: flags [wrangler.toml] | check <probe.json>"); process.exit(2); }
}
