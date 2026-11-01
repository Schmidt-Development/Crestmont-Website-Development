// Read-only Stripe staging check (scripts/stripe-staging-check.ts). FIXTURE D1 rows and FIXTURE fetches only; the real
// webhook route is exercised in-process to prove unsigned and forged events are refused and never stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readOnly, report, signatureChecks, callWorkerCheck, PROBE_EVENT_ID } from "../scripts/stripe-staging-check.ts";
import { sign } from "../scripts/trigger-scheduler.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { createTestApp } from "./support/app.ts";

test("[PAY-003] the staging check only ever runs single SELECT statements", async () => {
  const q = readOnly(async () => []);
  for (const bad of ["DELETE FROM stripe_events", "UPDATE payments SET status = 'x'", "SELECT 1; DROP TABLE payments", "INSERT INTO x VALUES (1)"]) assert.throws(() => q(bad), /single SELECT/, bad);
  assert.deepEqual(await q("SELECT 1"), []);
  const wf = readFileSync(".github/workflows/stripe-staging-check.yml", "utf8");
  assert.match(wf, /environment: staging/);
  assert.match(wf, /permissions:\n  contents: read/);
  assert.doesNotMatch(wf, /secret put|secret delete|wrangler deploy|STRIPE_(SECRET|WEBHOOK|PUBLISHABLE)/, "no secret, deploy or Stripe credential");
  assert.match(wf, /workflow_run:\n    workflows: \["Deploy staging"\]/, "runs after every staging deploy");
});

test("[PAY-003] the live signature check: the real webhook refuses unsigned and forged events and stores neither", async () => {
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: "whsec_staging_check_fixture" });
  // Route requests to the in-process app as if it were the deployed Worker.
  const f = (async (u: string | URL, init?: RequestInit) => t.client().request("POST", new URL(String(u)).pathname, { body: String(init?.body), headers: init?.headers as Record<string, string> })) as unknown as typeof fetch;
  assert.deepEqual(await signatureChecks("http://crestmont.test", f), { unsigned: 401, forged: 401 });
  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM stripe_events WHERE id = ?`).bind(PROBE_EVENT_ID).first<{ n: number }>())!.n, 0);
});

test("[PAY-003] the report states plainly when no Stripe event has ever reached staging, refuses to pass on a stored probe, and fails on a security regression", async () => {
  const rows: Record<string, Record<string, unknown>[]> = {
    integration_health: [{ status: "degraded", detail: "GET /v1/balance succeeded in test mode for Stripe account acct_fixture, but no webhook endpoint is registered for https://staging.example/api/webhooks/stripe.", checked_at: "2026-10-31T20:00:00Z" }],
    "FROM stripe_events GROUP": [], "FROM payments": [], "WHERE id =": [{ n: 0 }],
  };
  const query = async (sql: string) => rows[Object.keys(rows).find((k) => sql.includes(k))!] ?? [];
  const refusing = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
  const r = await report("https://staging.example", query, refusing, async () => ({ present: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PUBLISHABLE_KEY"], absent: [] }));
  assert.equal(r.ok, false, "a stored (possibly stale) probe never completes the check");
  assert.match(r.lines.join("\n"), /STORED, possibly stale, recorded 2026-10-31T20:00:00Z/);
  assert.match(r.lines.join("\n"), /Founder-managed bindings present: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PUBLISHABLE_KEY/);
  assert.match(r.lines.join("\n"), /acct_fixture, but no webhook endpoint is registered/);
  assert.match(r.lines.join("\n"), /Stripe events received on staging: NONE/);
  assert.match(r.lines.join("\n"), /REFUSED as required/);
  const accepting = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  assert.equal((await report("https://staging.example", query, accepting)).ok, false, "accepting an unsigned event fails the check");
});

test("[PAY-003] the report names the staging Worker host and probes each registered webhook host's public health endpoint", async () => {
  const query = async (sql: string) => sql.includes("integration_health")
    ? [{ status: "degraded", checked_at: "2026-10-31T21:01:17Z", detail: "… but no webhook endpoint is registered for https://app.right.workers.dev/api/webhooks/stripe. Webhook endpoints in this account: https://app.wrong.workers.dev/api/webhooks/stripe (enabled, 2026-10-28.endive, 17 events)." }]
    : sql.includes("WHERE id =") ? [{ n: 0 }] : [];
  const seen: string[] = [];
  const f = (async (u: string | URL, init?: RequestInit) => {
    const url = String(u); seen.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("app.wrong")) throw new TypeError("fetch failed", { cause: "ENOTFOUND app.wrong.workers.dev" });
    return new Response(url.endsWith("/api/health") ? '{"ok":true}' : "{}", { status: url.endsWith("/api/health") ? 200 : 401 });
  }) as unknown as typeof fetch;
  const r = await report("https://app.right.workers.dev", query, f, undefined, async () => "https://app.right.workers.dev");
  const text = r.lines.join("\n");
  assert.match(text, /Staging Worker host \(Cloudflare account workers\.dev subdomain\): https:\/\/app\.right\.workers\.dev; this check used https:\/\/app\.right\.workers\.dev/);
  assert.match(text, /Registered webhook host https:\/\/app\.right\.workers\.dev: GET \/api\/health → HTTP 200 .*\(this is the staging URL\)/);
  assert.match(text, /Registered webhook host https:\/\/app\.wrong\.workers\.dev: GET \/api\/health → unreachable \(ENOTFOUND/);
  assert.ok(seen.filter((x) => x.includes("/api/health")).every((x) => x.startsWith("GET ")), "health probes are GETs");
});

// ── Fresh probe + genuine test-mode delivery, end to end in-process (FIXTURE Stripe that delivers a SIGNED event) ──
const SCHED = "sched-fixture-key", WHSEC = "whsec_fresh_check_fixture";
async function stripeWorld(o: { endpointUrl?: string; deliverWithSecret?: string | null } = {}) {
  const calls: string[] = [];
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const deliver = async (session: string) => {
    if (o.deliverWithSecret === null) return; // Stripe has no destination for this URL: nothing is sent
    const body = JSON.stringify({ id: `evt_fixture_${session}`, object: "event", api_version: "2026-10-28.endive", type: "checkout.session.expired", created: Math.floor(Date.now() / 1000), livemode: false,
      data: { object: { id: session, object: "checkout.session", status: "expired", mode: "payment", metadata: { crestmont_staging_check: "1" } } } });
    const ts = Math.floor(Date.now() / 1000);
    await t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(o.deliverWithSecret ?? WHSEC, `${ts}.${body}`)}` } });
  };
  const stripe = (async (u: string | URL, init?: RequestInit) => {
    const url = new URL(String(u)); const method = init?.method ?? "GET"; calls.push(`${method} ${url.pathname}`);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === "/v1/balance") return json({ object: "balance", livemode: false });
    if (url.pathname === "/v1/account") return json({ id: "acct_fixture", object: "account" });
    if (url.pathname === "/v1/webhook_endpoints") return json({ data: [{ url: o.endpointUrl ?? "http://crestmont.test/api/webhooks/stripe", status: "enabled", api_version: "2026-10-28.endive", enabled_events: ["*"] }] });
    if (url.pathname === "/v2/core/event_destinations") return json({ data: [] });
    if (url.pathname === "/v1/checkout/sessions" && method === "POST") return json({ id: "cs_test_freshcheck1", url: "https://checkout.stripe.com/c/pay/cs_test_freshcheck1", livemode: false });
    if (url.pathname === "/v1/checkout/sessions/cs_test_freshcheck1/expire") { await deliver("cs_test_freshcheck1"); return json({ id: "cs_test_freshcheck1", status: "expired", livemode: false }); }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  t = await createTestApp({ SCHEDULER_TRIGGER_SECRET: SCHED, STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_SECRET_KEY: "sk_test_fresh_fixture", overrides: { fetch: stripe } });
  // The workflow's network: requests to the staging host go to the in-process Worker.
  const net = (async (u: string | URL, init?: RequestInit) => {
    const url = new URL(String(u));
    if (url.pathname === "/api/health") return new Response('{"status":"ok"}', { status: 200 });
    return t.client().request((init?.method ?? "GET") as "POST", url.pathname, { body: init?.body ? String(init.body) : undefined, headers: init?.headers as Record<string, string> });
  }) as unknown as typeof fetch;
  const query = async (sql: string) => (await t.db.prepare(sql).all<Record<string, unknown>>()).results;
  return { t, calls, net, query };
}

test("[PAY-003] fresh check: each run queries Stripe now, and a genuine signed test-mode event is delivered, verified and stored", async () => {
  const w = await stripeWorld();
  const before = await w.query("SELECT (SELECT COUNT(*) FROM invoices) i, (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM payments) p");
  const r = await report("http://crestmont.test", w.query, w.net, undefined, undefined, () => callWorkerCheck("http://crestmont.test", SCHED, true, w.net), 5_000, 50);
  const text = r.lines.join("\n");
  assert.equal(r.ok, true, text);
  assert.match(text, /Stripe probe \(FRESH, queried by the staging Worker at \d{4}-\d\d-\d\dT[^)]+\): verified/);
  assert.match(text, /Test-mode event requested: Checkout Session cs_test_freshcheck1 created and expired/);
  assert.match(text, /LIVE DELIVERY: checkout\.session\.expired evt_fixture_cs_test_freshcheck1 received .* signature verified with the configured signing secret, status processed/);
  assert.ok(w.calls.includes("GET /v1/webhook_endpoints") && w.calls.includes("POST /v1/checkout/sessions") && w.calls.includes("POST /v1/checkout/sessions/cs_test_freshcheck1/expire"), w.calls.join(", "));
  assert.deepEqual(await w.query("SELECT (SELECT COUNT(*) FROM invoices) i, (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM payments) p"), before, "the check event changes no invoice, order or payment");
  // A second run queries Stripe again (never a stored row).
  const probes = () => w.calls.filter((c) => c === "GET /v1/webhook_endpoints").length;
  const n = probes();
  await callWorkerCheck("http://crestmont.test", SCHED, false, w.net);
  assert.equal(probes(), n + 1);
});

test("[PAY-003] fresh check: a delivery refused for its signature, or never sent, fails the check with the reason", async () => {
  const wrongSecret = await stripeWorld({ deliverWithSecret: "whsec_some_other_endpoint" });
  const a = await report("http://crestmont.test", wrongSecret.query, wrongSecret.net, undefined, undefined, () => callWorkerCheck("http://crestmont.test", SCHED, true, wrongSecret.net), 300, 50);
  assert.equal(a.ok, false);
  assert.match(a.lines.join("\n"), /LIVE DELIVERY: NOT received within 0\.3s .*signature mismatch/);
  const wrongUrl = await stripeWorld({ endpointUrl: "https://elsewhere.example/api/webhooks/stripe", deliverWithSecret: null });
  const b = await report("http://crestmont.test", wrongUrl.query, wrongUrl.net, undefined, undefined, () => callWorkerCheck("http://crestmont.test", SCHED, true, wrongUrl.net), 300, 50);
  assert.equal(b.ok, false);
  assert.match(b.lines.join("\n"), /FRESH.*degraded — .*no webhook endpoint is registered for http:\/\/crestmont\.test\/api\/webhooks\/stripe/);
});

test("[PAY-003] the Worker check endpoint: signed with the scheduler key only, never on production, test mode only", async () => {
  const w = await stripeWorld();
  const c = w.t.client();
  const body = JSON.stringify({ check: "stripe", deliver: false });
  assert.equal((await c.request("POST", "/api/payments/stripe-staging-check", { body })).status, 401, "unsigned");
  assert.equal((await c.request("POST", "/api/payments/stripe-staging-check", { body, headers: { "x-crestmont-scheduler-signature": sign("wrong", body) } })).status, 401, "wrong key");
  const other = JSON.stringify({ audit: "retell-inbound" });
  assert.equal((await c.request("POST", "/api/payments/stripe-staging-check", { body: other, headers: { "x-crestmont-scheduler-signature": sign(SCHED, other) } })).status, 422, "another signed purpose is refused");
  const prod = await createTestApp({ ENVIRONMENT: "production", SCHEDULER_TRIGGER_SECRET: SCHED, STRIPE_SECRET_KEY: "sk_live_fixture", PAYMENTS_LIVE_AUTHORIZED: "yes", APP_URL: "https://crestmontwebsitedevelopment.com" });
  assert.equal((await prod.client().request("POST", "/api/payments/stripe-staging-check", { body, headers: { "x-crestmont-scheduler-signature": sign(SCHED, body) } })).status, 404, "never on production");
  const nokey = await createTestApp({ SCHEDULER_TRIGGER_SECRET: SCHED });
  assert.equal((await nokey.client().request("POST", "/api/payments/stripe-staging-check", { body, headers: { "x-crestmont-scheduler-signature": sign(SCHED, body) } })).status, 409, "test mode only");
  const ok = await c.request("POST", "/api/payments/stripe-staging-check", { body, headers: { "x-crestmont-scheduler-signature": sign(SCHED, body) } });
  assert.equal(ok.status, 200);
  const j = await ok.json() as { probe: { status: string; detail: string }; delivery: unknown };
  assert.equal(j.probe.status, "verified");
  assert.equal(j.delivery, null, "no Stripe write without deliver");
  assert.doesNotMatch(JSON.stringify(j), /sk_test_|whsec_/, "no key or secret in the response");
  assert.ok(!w.calls.some((x) => x.startsWith("POST ")), "deliver:false makes no Stripe write");
});
