// scripts/net-retry.ts: deploy #158 failed on one connect timeout before reaching the Worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isConnectFailure, withConnectRetry, describeNetError } from "../scripts/net-retry.ts";

/** The exact shape deploy #158 logged (undici TypeError → AggregateError of per-address connect timeouts). */
const connectTimeout = () => {
  const per = (ip: string) => Object.assign(new Error(`connect ETIMEDOUT ${ip}:443`), { code: "ETIMEDOUT", syscall: "connect", address: ip, port: 443 });
  return new TypeError("fetch failed", { cause: Object.assign(new AggregateError([per("104.21.86.58"), per("172.67.215.91")], ""), { code: "ETIMEDOUT" }) });
};

test("[INFRA-006] a connection that was never established is retried, then the response is returned", async () => {
  let calls = 0;
  const f = withConnectRetry((async () => { if (++calls < 3) throw connectTimeout(); return new Response("ok"); }) as typeof fetch, [0, 0, 0], () => {});
  assert.equal(await (await f("https://staging.example/")).text(), "ok");
  assert.equal(calls, 3);
});

test("[INFRA-006] nothing that might have reached the server is retried: a reset, an HTTP 500, a persisting outage", async () => {
  let calls = 0;
  const reset = withConnectRetry((async () => { calls++; throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }); }) as typeof fetch, [0, 0], () => {});
  await assert.rejects(reset("https://x/", { method: "POST" }), /socket hang up/);
  assert.equal(calls, 1, "a POST that may have been received is never repeated");
  calls = 0;
  const http500 = withConnectRetry((async () => { calls++; return new Response("boom", { status: 500 }); }) as typeof fetch, [0, 0], () => {});
  assert.equal((await http500("https://x/")).status, 500);
  assert.equal(calls, 1, "an HTTP status is the server's answer, not a network fault");
  calls = 0;
  const down = withConnectRetry((async () => { calls++; throw connectTimeout(); }) as typeof fetch, [0, 0], () => {});
  await assert.rejects(down("https://x/"), /fetch failed \(connect ETIMEDOUT 104\.21\.86\.58:443\)/, "the network reason is named, not only 'fetch failed'");
  assert.equal(calls, 3, "bounded");
});

test("[INFRA-006] the classifier matches Node's real errors: a refused connection is a connect failure", async () => {
  const { createServer } = await import("node:net");
  const srv = createServer(); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port; await new Promise<void>((r) => srv.close(() => r()));
  let err: unknown;
  try { await fetch(`http://127.0.0.1:${port}/`); } catch (e) { err = e; }
  assert.ok(err, "a closed port refuses");
  assert.equal(isConnectFailure(err), true, describeNetError(err));
  assert.equal(isConnectFailure(new Error("Unexpected token < in JSON")), false);
});
