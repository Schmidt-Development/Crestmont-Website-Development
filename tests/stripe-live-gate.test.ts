// scripts/stripe-live-gate.ts: production opens live payments only when the running Worker's read-only Stripe probe
// verifies the live key, a charge-enabled account and a complete webhook endpoint; the committed flags are read from the
// production block of wrangler.toml only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { productionFlags, stripeLiveProblem } from "../scripts/stripe-live-gate.ts";

test("live payments gate: only a verified live account that can take charges passes", () => {
  const ok = { stripe: { status: "verified", detail: "GET /v1/balance succeeded in live mode; the webhook endpoint is enabled at API version 2025-09-30.clover with every handled event. Account acct_1 (Crestmont): charges enabled, payouts enabled, details submitted." } };
  assert.equal(stripeLiveProblem(ok), null);
  assert.match(stripeLiveProblem({ stripe: { status: "degraded", detail: "no webhook endpoint is registered" } })!, /degraded/);
  assert.match(stripeLiveProblem({ stripe: { ...ok.stripe, detail: ok.stripe.detail.replace("charges enabled", "charges NOT enabled") } })!, /cannot take charges/);
  assert.match(stripeLiveProblem({ stripe: { ...ok.stripe, detail: ok.stripe.detail.replace("live mode", "test mode") } })!, /live mode/);
  assert.match(stripeLiveProblem({})!, /no Stripe result/);
});

test("live payments gate: the flags come from [env.production] only", () => {
  const toml = `[env.staging]\nvars = { PUBLIC_LAUNCH = "open", PAYMENTS_LIVE_AUTHORIZED = "yes" }\n[env.production]\nname = "p"\nvars = { ENVIRONMENT = "production" }\n`;
  assert.deepEqual(productionFlags(toml), { live: false, open: false });
  assert.deepEqual(productionFlags(toml.replace('vars = { ENVIRONMENT = "production" }', 'vars = { ENVIRONMENT = "production", PUBLIC_LAUNCH = "open", PAYMENTS_LIVE_AUTHORIZED = "yes" }')), { live: true, open: true });
  const committed = productionFlags(readFileSync("wrangler.toml", "utf8"));
  assert.equal(typeof committed.live, "boolean");
});
