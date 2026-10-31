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

// ── Read-only account / endpoint inventory (2026-10-31: the staging key's account listed no endpoint for staging while
// the Founder had created a destination; the probe now says what the key's account does have). FIXTURE fetches only.
import { eventDestinationProblem, endpointInventory, verifyIntegration } from "../src/services/integrations.ts";
import { createTestApp } from "./support/app.ts";

const TARGET = "http://crestmont.test/api/webhooks/stripe";
const dest = (o: Record<string, unknown> = {}) => ({ id: "ed_fixture", type: "webhook_endpoint", status: "enabled", event_payload: "snapshot", snapshot_api_version: "2026-10-28.endive", enabled_events: ["*"], webhook_endpoint: { url: TARGET }, ...o });

test("[PAY-003] event destinations: snapshot payloads at a supported version with every event; thin payloads are refused", () => {
  assert.equal(eventDestinationProblem([dest()], "http://crestmont.test"), null);
  assert.match(eventDestinationProblem([dest({ event_payload: "thin", snapshot_api_version: null })], "http://crestmont.test")!, /sends thin payloads; the handler needs snapshot payloads/);
  assert.match(eventDestinationProblem([dest({ snapshot_api_version: "2025-09-30.clover" })], "http://crestmont.test")!, /expected 2025-02-24\.acacia or 2026-10-28\.endive/);
  assert.match(eventDestinationProblem([dest({ status: "disabled" })], "http://crestmont.test")!, /is disabled/);
  assert.match(eventDestinationProblem([dest({ webhook_endpoint: { url: "https://elsewhere.example/api/webhooks/stripe" } })], "http://crestmont.test")!, /no event destination is registered for http:\/\/crestmont\.test/);
  assert.match(endpointInventory([], null, 404), /Webhook endpoints in this account: none\. Event destinations: unavailable \(HTTP 404\)\./);
});

test("[PAY-003] the Stripe probe names the key's account and what it has when no endpoint matches; read-only", async () => {
  const run = async (destinations: unknown[]) => {
    const t = await createTestApp({ STRIPE_SECRET_KEY: "sk_test_inventory_fixture" });
    const seen: string[] = [];
    const f = (async (u: string | URL, init?: RequestInit) => {
      const url = String(u); seen.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      const body = url.includes("/v1/balance") ? { object: "balance", livemode: false } : url.includes("/v1/account") ? { id: "acct_fixture123", object: "account" }
        : url.includes("/v1/webhook_endpoints") ? { data: [{ url: "https://old-host.example/api/webhooks/stripe", status: "enabled", api_version: "2025-02-24.acacia", enabled_events: ["*"] }] }
        : url.includes("/v2/core/event_destinations") ? { data: destinations } : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const res = await verifyIntegration({ db: t.db, env: t.env, storage: null, fetchImpl: f }, "stripe", null);
    assert.ok(seen.every((c) => c.startsWith("GET ")), `only reads: ${seen.join(", ")}`);
    return res;
  };
  const thin = await run([dest({ event_payload: "thin", snapshot_api_version: null })]);
  assert.equal(thin.status, "degraded");
  assert.match(thin.detail, /for Stripe account acct_fixture123, but no webhook endpoint is registered for http:\/\/crestmont\.test\/api\/webhooks\/stripe\./);
  assert.match(thin.detail, /Webhook endpoints in this account: https:\/\/old-host\.example\/api\/webhooks\/stripe \(enabled, 2025-02-24\.acacia, all events\)/);
  assert.match(thin.detail, /Event destinations: http:\/\/crestmont\.test\/api\/webhooks\/stripe \(enabled, thin payloads, no snapshot version, 1 events\)/);
  assert.doesNotMatch(thin.detail, /sk_test_/, "never the key");
  const snap = await run([dest()]);
  assert.equal(snap.status, "verified", snap.detail);
  assert.match(snap.detail, /event destination for http:\/\/crestmont\.test\/api\/webhooks\/stripe is enabled with snapshot payloads/);
});
