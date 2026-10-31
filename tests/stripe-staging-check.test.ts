// Read-only Stripe staging check (scripts/stripe-staging-check.ts). FIXTURE D1 rows and FIXTURE fetches only; the real
// webhook route is exercised in-process to prove unsigned and forged events are refused and never stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readOnly, report, signatureChecks, PROBE_EVENT_ID } from "../scripts/stripe-staging-check.ts";
import { createTestApp } from "./support/app.ts";

test("[PAY-003] the staging check only ever runs single SELECT statements", async () => {
  const q = readOnly(async () => []);
  for (const bad of ["DELETE FROM stripe_events", "UPDATE payments SET status = 'x'", "SELECT 1; DROP TABLE payments", "INSERT INTO x VALUES (1)"]) assert.throws(() => q(bad), /single SELECT/, bad);
  assert.deepEqual(await q("SELECT 1"), []);
  const wf = readFileSync(".github/workflows/stripe-staging-check.yml", "utf8");
  assert.match(wf, /environment: staging/);
  assert.match(wf, /permissions:\n  contents: read/);
  assert.doesNotMatch(wf, /secret put|secret delete|wrangler deploy|STRIPE_/, "no secret, deploy or Stripe value");
});

test("[PAY-003] the live signature check: the real webhook refuses unsigned and forged events and stores neither", async () => {
  const t = await createTestApp({ STRIPE_WEBHOOK_SECRET: "whsec_staging_check_fixture" });
  // Route requests to the in-process app as if it were the deployed Worker.
  const f = (async (u: string | URL, init?: RequestInit) => t.client().request("POST", new URL(String(u)).pathname, { body: String(init?.body), headers: init?.headers as Record<string, string> })) as unknown as typeof fetch;
  assert.deepEqual(await signatureChecks("http://crestmont.test", f), { unsigned: 401, forged: 401 });
  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM stripe_events WHERE id = ?`).bind(PROBE_EVENT_ID).first<{ n: number }>())!.n, 0);
});

test("[PAY-003] the report states plainly when no Stripe event has ever reached staging, and fails only on a security regression", async () => {
  const rows: Record<string, Record<string, unknown>[]> = {
    integration_health: [{ status: "degraded", detail: "GET /v1/balance succeeded in test mode for Stripe account acct_fixture, but no webhook endpoint is registered for https://staging.example/api/webhooks/stripe.", checked_at: "2026-10-31T20:00:00Z" }],
    "FROM stripe_events GROUP": [], "FROM payments": [], "WHERE id =": [{ n: 0 }],
  };
  const query = async (sql: string) => rows[Object.keys(rows).find((k) => sql.includes(k))!] ?? [];
  const refusing = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
  const r = await report("https://staging.example", query, refusing, async () => ({ present: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PUBLISHABLE_KEY"], absent: [] }));
  assert.equal(r.ok, true);
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
