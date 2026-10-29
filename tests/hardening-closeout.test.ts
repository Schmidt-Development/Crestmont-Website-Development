// Defence-in-depth fixes from the 2026-10-29 audit: runner replay protection (CREST-GAP-087) and malformed Referer
// handling in the CSRF check (CREST-GAP-101).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, TEST_PASSWORD } from "./support/app.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import type { Env } from "../src/app/context.ts";

const SECRET = "test-runner-secret";

async function signedClaim(env: Partial<Env>, body: Record<string, unknown>, reuse?: { raw: string; sig: string }) {
  const t = await createTestApp({ BUILD_RUNNER_SECRET: SECRET, ...env });
  const send = async (raw: string, sig: string) => t.client().request("POST", "/api/builds/runner/claim", { body: raw, headers: { "content-type": "application/json", "x-crestmont-runner-signature": sig } });
  const raw = reuse?.raw ?? JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const sig = reuse?.sig ?? `t=${ts},v1=${await hmacSha256Hex(SECRET, `${ts}.${raw}`)}`;
  return { t, send, raw, sig };
}

test("[AIOPS-002] [SEC-007] a captured signed runner request with a nonce cannot be replayed (CREST-GAP-087)", async () => {
  const { send, raw, sig } = await signedClaim({}, { runnerId: "r1", _nonce: "a".repeat(32) });
  assert.equal((await send(raw, sig)).status, 200);
  const replay = await send(raw, sig);
  assert.equal(replay.status, 409, "the identical signed request is refused the second time");
});

test("[AIOPS-002] [SEC-007] RUNNER_REQUIRE_NONCE=yes refuses signed runner requests without a nonce (CREST-GAP-087)", async () => {
  const strict = await signedClaim({ RUNNER_REQUIRE_NONCE: "yes" }, { runnerId: "r1" });
  assert.equal((await strict.send(strict.raw, strict.sig)).status, 400);
  const lenient = await signedClaim({}, { runnerId: "r1" });
  assert.equal((await lenient.send(lenient.raw, lenient.sig)).status, 200, "older runners without a nonce still work until enforcement is switched on");
});

test("[SEC-002] a malformed Referer on a form post is refused with 403, not a server error (CREST-GAP-101)", async () => {
  const { db, client } = await createTestApp();
  const cust = await createCustomer(db, "referer@example.com");
  const c = client();
  await c.get("/login");
  const body = new URLSearchParams({ _csrf: c.cookies.get("cm_csrf")!, email: cust.email, password: TEST_PASSWORD }).toString();
  const res = await c.request("POST", "/login", { body, headers: { "content-type": "application/x-www-form-urlencoded", referer: "http://[::bad" } });
  assert.equal(res.status, 403);
});
