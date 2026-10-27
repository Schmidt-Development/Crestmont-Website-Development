// MOCK tests: fake control plane / fake fetch. No real control plane or Anthropic API is contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ControlPlaneClient, signBody, verifySignature, LeaseLostError, ControlPlaneError, SIGNATURE_HEADER, truncateBytes } from "../src/control-plane.ts";
import { startFakeControlPlane, makeJob, SECRET } from "./helpers.ts";

test("[AIB-RUNNER] signature header is t=<unix>,v1=<hex HMAC-SHA256(secret, \"<t>.<raw body>\")>", () => {
  const body = JSON.stringify({ runnerId: "r1", version: "1.0.0", capabilities: ["agent-sdk"] });
  const header = signBody(SECRET, body, 1_760_000_000);
  const expected = createHmac("sha256", SECRET).update(`1760000000.${body}`).digest("hex");
  assert.equal(header, `t=1760000000,v1=${expected}`);
  assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(SIGNATURE_HEADER, "x-crestmont-runner-signature");
  assert.ok(verifySignature(SECRET, body, header, 1_760_000_000 + 600));
  assert.ok(!verifySignature(SECRET, body, header, 1_760_000_000 + 601), "outside ±600 s tolerance");
  assert.ok(!verifySignature(SECRET, body + " ", header, 1_760_000_000), "body tampering");
  assert.ok(!verifySignature("other-secret", body, header, 1_760_000_000));
});

test("[AIB-RUNNER] client signs every request; the fake control plane rejects a wrong secret without retrying", async () => {
  const cp = await startFakeControlPlane({ jobs: [makeJob()] });
  try {
    const good = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: "r1" });
    const r = await good.claim(["agent-sdk", "git"]);
    assert.ok(r.job, "claimed");
    assert.deepEqual(cp.calls[0].body, { runnerId: "r1", version: "1.0.0", capabilities: ["agent-sdk", "git"] });
    let fetches = 0;
    const counting: typeof fetch = (input, init) => { fetches++; return fetch(input, init); };
    const bad = new ControlPlaneClient({ baseUrl: cp.url, secret: "wrong-secret-0000000000", runnerId: "r1", fetchImpl: counting, sleep: async () => {} });
    await assert.rejects(bad.claim([]), (e: unknown) => e instanceof ControlPlaneError && e.status === 401);
    assert.equal(fetches, 1, "4xx is never retried");
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] network errors, 5xx and 429 are retried with backoff; other 4xx are not", async () => {
  const sleeps: number[] = [];
  let n = 0;
  const flaky: typeof fetch = async () => {
    n++;
    if (n <= 2) throw new TypeError("fetch failed: ECONNRESET");
    if (n === 3) return new Response("busy", { status: 503 });
    if (n === 4) return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
    return new Response(JSON.stringify({ job: null, reason: "none_queued" }), { status: 200 });
  };
  const c = new ControlPlaneClient({ baseUrl: "https://cp.test", secret: SECRET, runnerId: "r", fetchImpl: flaky, sleep: async (ms) => { sleeps.push(ms); }, retry: { attempts: 6, baseMs: 100 } });
  const r = await c.claim([]);
  assert.deepEqual(r, { job: null, reason: "none_queued" });
  assert.equal(n, 5);
  assert.equal(sleeps.length, 4);
  assert.equal(sleeps[3], 2000, "Retry-After honored for 429");

  let m = 0;
  const fourHundred: typeof fetch = async () => { m++; return new Response(JSON.stringify({ error: "bad" }), { status: 400 }); };
  const c2 = new ControlPlaneClient({ baseUrl: "https://cp.test", secret: SECRET, runnerId: "r", fetchImpl: fourHundred, sleep: async () => {} });
  await assert.rejects(c2.claim([]), ControlPlaneError);
  assert.equal(m, 1);

  let k = 0;
  const down: typeof fetch = async () => { k++; throw new TypeError("fetch failed"); };
  const c3 = new ControlPlaneClient({ baseUrl: "https://cp.test", secret: SECRET, runnerId: "r", fetchImpl: down, sleep: async () => {}, retry: { attempts: 3 } });
  await assert.rejects(c3.claim([]), /fetch failed/);
  assert.equal(k, 3, "gives up after the configured attempts");
});

test("[AIB-RUNNER] 409 lease_lost becomes LeaseLostError and is not retried", async () => {
  let n = 0;
  const f: typeof fetch = async () => { n++; return new Response(JSON.stringify({ error: "lease_lost" }), { status: 409 }); };
  const c = new ControlPlaneClient({ baseUrl: "https://cp.test", secret: SECRET, runnerId: "r", fetchImpl: f, sleep: async () => {} });
  await assert.rejects(c.heartbeat({ id: "bld_1", leaseToken: "x" }, { stage: "building", runCostUsd: 1, turns: 2 }), LeaseLostError);
  assert.equal(n, 1);
});

test("[AIB-RUNNER] heartbeat/complete payloads follow the protocol field names and limits", async () => {
  const bodies: Record<string, unknown>[] = [];
  const f: typeof fetch = async (_u, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ continue: true, leaseExpiresAt: "x" }), { status: 200 }); };
  const c = new ControlPlaneClient({ baseUrl: "https://cp.test/", secret: SECRET, runnerId: "r", fetchImpl: f });
  await c.heartbeat({ id: "bld_1", leaseToken: "t" }, { stage: "verifying", runCostUsd: 1.234567, turns: 7, sessionId: "s1", activity: [{ kind: "tool", message: "x".repeat(900) }] });
  assert.deepEqual(Object.keys(bodies[0]).sort(), ["activity", "jobId", "leaseToken", "runCostUsd", "sessionId", "stage", "turns"]);
  assert.equal(bodies[0].runCostUsd, 1.2346);
  assert.equal((bodies[0].activity as { message: string }[])[0].message.length, 500);
  await c.complete({ id: "bld_1", leaseToken: "t" }, {
    outcome: "ready_for_review", runCostUsd: 2, turns: 3, sessionId: "s", sourceRepo: "r", sourceBranch: "b", sourceCommit: "c",
    previewUrl: null, report: "é".repeat(40_000), error: "e".repeat(5000),
  });
  assert.ok(Buffer.byteLength(String(bodies[1].report)) <= 50 * 1024);
  assert.equal(String(bodies[1].error).length, 2000);
  assert.ok(truncateBytes("short", 10) === "short");
});
