// Server-side Turnstile verification (src/routes/api.ts#verifyTurnstile): every outcome but an explicit success refuses,
// and a siteverify outage refuses cleanly instead of failing the request with a 500.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";
import { verifyTurnstile } from "../src/routes/api.ts";
import type { AppContext, Env } from "../src/app/context.ts";

const SECRET = "0x4AAAAAAAturnstile-fixture-secret";
const ctxWith = (env: Partial<Env>, fetchImpl?: typeof fetch) => ({ env: { ENVIRONMENT: "production", TURNSTILE_SECRET: SECRET, ...env, overrides: fetchImpl ? { fetch: fetchImpl } : undefined }, ip: "203.0.113.9" }) as unknown as AppContext;
const answer = (body: unknown, status = 200) => (async (_u: unknown, init?: RequestInit) => {
  const f = init?.body as FormData;
  assert.equal(f.get("secret"), SECRET, "the secret is sent to Cloudflare only in the form body");
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

test("[AUTH-005] Turnstile: success passes; expired, reused, invalid and missing tokens are refused", async () => {
  assert.equal(await verifyTurnstile(ctxWith({}, answer({ success: true })), "tok-ok"), true);
  assert.equal(await verifyTurnstile(ctxWith({}, answer({ success: false, "error-codes": ["timeout-or-duplicate"] })), "tok-expired"), false, "expired or already used");
  assert.equal(await verifyTurnstile(ctxWith({}, answer({ success: false, "error-codes": ["invalid-input-response"] })), "tok-forged"), false, "invalid");
  assert.equal(await verifyTurnstile(ctxWith({}, answer({ success: true })), ""), false, "missing token: Cloudflare is not even asked");
  assert.equal(await verifyTurnstile(ctxWith({}, answer({ success: true })), undefined), false);
  assert.equal(await verifyTurnstile(ctxWith({}, answer({ success: "true" })), "tok"), false, "only a boolean true counts");
});

test("[AUTH-005] Turnstile fails closed: no secret outside development, a siteverify outage, or a malformed answer", async () => {
  assert.equal(await verifyTurnstile(ctxWith({ TURNSTILE_SECRET: undefined }), "tok"), false, "production without a secret");
  assert.equal(await verifyTurnstile(ctxWith({ ENVIRONMENT: "staging", TURNSTILE_SECRET: undefined }), "tok"), false);
  assert.equal(await verifyTurnstile(ctxWith({ ENVIRONMENT: "development", TURNSTILE_SECRET: undefined }), "tok"), true, "development only");
  const down = (async () => { throw new TypeError("fetch failed: connect ECONNREFUSED"); }) as unknown as typeof fetch;
  assert.equal(await verifyTurnstile(ctxWith({}, down), "tok"), false, "outage: refused, not thrown");
  assert.equal(await verifyTurnstile(ctxWith({}, answer("<html>502 Bad Gateway</html>", 502)), "tok"), false, "non-JSON answer: refused, not thrown");
});

test("[AUTH-005] a siteverify outage refuses registration with a normal response, not a 500, and creates no account", async () => {
  const t = await createTestApp({ ENVIRONMENT: "staging", TURNSTILE_SECRET: SECRET, TURNSTILE_SITE_KEY: "0x4AAAAAAAsitekey" } as Partial<Env>);
  t.env.overrides = { ...t.env.overrides, fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch };
  const res = await t.client().post("/register", { name: "Rae Lin", organization: "Lin Co", email: "rae@lin.example", password: "gold-shield-harbor-river", terms: "1", "cf-turnstile-response": "tok" });
  assert.ok(res.status < 500, `refused cleanly (${res.status})`);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'rae@lin.example'`).first<{ n: number }>())!.n, 0);
  t.close();
});
