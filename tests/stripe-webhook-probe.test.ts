// CREST-GAP-017: the list of events the Stripe webhook endpoint must send stays identical to what the handler processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STRIPE_WEBHOOK_EVENTS } from "../src/domain/stripe-events.ts";
import { webhookEndpointProblem } from "../src/services/integrations.ts";

test("[PAY-003] required Stripe webhook events equal the handler's event cases", () => {
  const src = readFileSync("src/services/payments.ts", "utf8");
  const handled = [...src.matchAll(/case "([a-z_]+\.[a-z_.]+)":/g)].map((m) => m[1]).filter((e) => !e.startsWith("email."));
  assert.deepEqual([...new Set(handled)].sort(), [...STRIPE_WEBHOOK_EVENTS].sort());
});

test("[PAY-003] webhook endpoint check accepts a correct endpoint and '*' and refuses a disabled one", () => {
  const base = { url: "https://crestmontwebsitedevelopment.com/api/webhooks/stripe", status: "enabled", api_version: "2025-02-24.acacia" };
  assert.equal(webhookEndpointProblem([{ ...base, enabled_events: [...STRIPE_WEBHOOK_EVENTS] }], "https://crestmontwebsitedevelopment.com"), null);
  assert.equal(webhookEndpointProblem([{ ...base, enabled_events: ["*"] }], "https://crestmontwebsitedevelopment.com/"), null);
  assert.match(webhookEndpointProblem([{ ...base, status: "disabled", enabled_events: ["*"] }], "https://crestmontwebsitedevelopment.com")!, /is disabled/);
});
