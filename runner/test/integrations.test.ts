// Founder V4 §8 trusted integration layer, SIMULATED: a fake fetch stands in for the provider's API. Proves that the
// agent only asks, the Owner approves, the runner runs catalogued test-environment operations with credentials the
// agent never sees, refuses live credentials, and passes on only a sanitized result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runIntegrationOperations, readRequests, sanitizeEvidence } from "../src/integrations/broker.ts";
import { OPERATIONS, findOperation } from "../src/integrations/catalog.ts";
import { confine, PathDenied } from "../src/providers/local-tools.ts";
import { tmp } from "./helpers.ts";

// Fixture keys are assembled at runtime so they never look like real credentials in the repository.
const fakeKey = (mode: "test" | "live") => ["sk", mode, "FIXTURE" + "x".repeat(24)].join("_");
const TEST_KEY = fakeKey("test");

function setup(requests: unknown, decisions: { id: string; kind: string; operation: string | null; status: string }[] | null, secret: string | null = TEST_KEY) {
  const jobDir = tmp("aib-int-job-");
  const repo = path.join(jobDir, "repo");
  mkdirSync(path.join(repo, ".crestmont"), { recursive: true });
  writeFileSync(path.join(repo, ".crestmont", "integration-operations.json"), JSON.stringify(requests));
  const secretsRoot = tmp("aib-int-secrets-");
  if (secret) { mkdirSync(path.join(secretsRoot, "prj_1"), { recursive: true }); writeFileSync(path.join(secretsRoot, "prj_1", "STRIPE_TEST_SECRET_KEY"), secret + "\n"); }
  const requested: unknown[] = [], reported: unknown[] = [], fetched: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    fetched.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(url.includes("/v1/balance") ? { object: "balance", livemode: false, available: [] } : { data: [{ url: "https://site.example/api/stripe/webhook", livemode: false }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const deps = { repo, jobDir, projectId: "prj_1", secretsRoot, approvals: async () => decisions, requestApproval: async (r: unknown) => { requested.push(r); return { id: "apv", status: "pending" }; }, report: async (i: unknown[]) => { reported.push(...i); }, fetchImpl };
  return { deps, repo, jobDir, requested, reported, fetched };
}

test("[AIB-018] the agent only asks: catalogued operations need the Owner's approval; unknown operations are never run; rejected ones stay unrun", async () => {
  assert.ok(OPERATIONS.length >= 2 && OPERATIONS.every((o) => /^[a-z0-9_]+\.[a-z0-9_]+$/.test(o.id) && o.hosts.length && o.secrets.length));
  const s = setup([{ operation: "stripe.verify_test_key", summary: "Check the checkout works in test mode" }, { operation: "stripe.create_live_product", summary: "x" }, { operation: "rm -rf /", summary: "x" }], []);
  assert.deepEqual(readRequests(s.repo).map((r) => r.operation), ["stripe.verify_test_key", "stripe.create_live_product"], "malformed ids are ignored");
  const out = await runIntegrationOperations(s.deps);
  assert.deepEqual(out.map((o) => [o.operation, o.status]), [["stripe.verify_test_key", "awaiting_approval"], ["stripe.create_live_product", "not_supported"]]);
  assert.equal(s.requested.length, 1);
  assert.deepEqual({ ...(s.requested[0] as Record<string, unknown>), detail: "" }, { kind: "integration_operation", operation: "stripe.verify_test_key", summary: "Run stripe.verify_test_key for this website (test environment)", detail: "" });
  assert.equal(s.fetched.length, 0, "nothing runs before approval");
  const rejected = setup([{ operation: "stripe.verify_test_key", summary: "" }], [{ id: "a1", kind: "integration_operation", operation: "stripe.verify_test_key", status: "rejected" }]);
  assert.equal((await runIntegrationOperations(rejected.deps))[0].status, "rejected");
  assert.equal(rejected.fetched.length, 0);
});

test("[AIB-018] approved: the runner reads the credential itself, refuses live keys, runs once, and passes on only a sanitized result", async () => {
  const approved = [{ id: "a1", kind: "integration_operation", operation: "stripe.verify_test_key", status: "approved" }];
  const s = setup([{ operation: "stripe.verify_test_key", summary: "check" }], approved);
  const out = await runIntegrationOperations(s.deps);
  assert.equal(out[0].status, "passed", out[0].evidence);
  assert.deepEqual(s.fetched, [{ url: "https://api.stripe.com/v1/balance", auth: `Bearer ${TEST_KEY}` }]);
  assert.deepEqual(s.reported, [{ key: "stripe", sandboxStatus: "passed", sandboxEvidence: "stripe.verify_test_key: Stripe API answered 200 in test mode (livemode=false)" }]);
  const results = readFileSync(path.join(s.repo, ".crestmont", "integration-results.json"), "utf8");
  assert.ok(!results.includes(TEST_KEY), "the agent never sees the key");
  assert.equal((await runIntegrationOperations(s.deps))[0].status, "passed");
  assert.equal(s.fetched.length, 1, "not run again");
  // A live key is refused before any request.
  const live = setup([{ operation: "stripe.verify_test_key", summary: "" }], approved, fakeKey("live"));
  const lo = await runIntegrationOperations(live.deps);
  assert.equal(lo[0].status, "refused");
  assert.match(lo[0].evidence, /only a Stripe TEST-mode key/);
  assert.equal(live.fetched.length, 0);
  // Approved but no credential placed yet: a Founder action, recorded; nothing runs.
  const none = setup([{ operation: "stripe.verify_test_key", summary: "" }], approved, null);
  assert.equal((await runIntegrationOperations(none.deps))[0].status, "missing_credentials");
  // Evidence redaction.
  assert.equal(sanitizeEvidence(`key ${TEST_KEY} whsec_test_abc123 ${"x".repeat(40)}`, { K: TEST_KEY }), "key [redacted] [redacted] [redacted]");
  assert.ok(findOperation("stripe.list_test_webhooks"));
});

test("[AIB-018] the agent cannot reach the secrets: its file tools are confined to the repository", () => {
  const s = setup([], []);
  assert.throws(() => confine(s.repo, "../integration-operations-done.json", "r"), PathDenied);
  assert.throws(() => confine(s.repo, "/run/secrets/integrations/prj_1/STRIPE_TEST_SECRET_KEY", "r"), PathDenied);
  assert.ok(!existsSync(path.join(s.repo, "STRIPE_TEST_SECRET_KEY")));
});
