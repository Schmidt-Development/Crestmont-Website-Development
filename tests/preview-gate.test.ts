import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { handle } from "../src/app/app.ts";

const req = (env: object, path: string, init: RequestInit = {}) => handle(new Request("https://staging.example" + path, init), env as never);

test("[INFRA-002] staging preview gate: every page needs the preview pass; machine endpoints stay reachable", async () => {
  const { env } = await createTestApp({ ENVIRONMENT: "staging", STAGING_ACCESS_PASSWORD: "correct preview words" });
  for (const p of ["/", "/pricing", "/login", "/portal", "/staff"]) {
    const r = await req(env, p);
    assert.equal(r.status, 401, p);
    assert.match(await r.text(), /Staging preview/);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  }
  assert.equal((await req(env, "/api/health")).status, 200);
  assert.equal((await req(env, "/api/leads", { method: "POST", body: "{}" })).status, 401, "cookie-less API calls are gated too");
  assert.equal((await req(env, "/api/webhooks/stripe", { method: "POST", body: "{}" })).status, 401, "webhook reaches its own signature check (401 from Stripe verification)");
  const wrong = await req(env, "/__preview-access", { method: "POST", body: new URLSearchParams({ password: "nope", next: "/pricing" }) });
  assert.equal(wrong.status, 401);
  const ok = await req(env, "/__preview-access", { method: "POST", body: new URLSearchParams({ password: "correct preview words", next: "/pricing" }) });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/pricing");
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  assert.match(ok.headers.get("set-cookie")!, /HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await req(env, "/pricing", { headers: { cookie } })).status, 200);
  assert.equal((await req(env, "/pricing", { headers: { cookie: "cm_preview=1700000000." + "0".repeat(64) } })).status, 401, "forged pass refused");
  const offsite = await req(env, "/__preview-access", { method: "POST", body: new URLSearchParams({ password: "correct preview words", next: "//evil.example" }) });
  assert.equal(offsite.headers.get("location"), "/", "no open redirect");
});

test("[INFRA-002] the preview gate never replaces application authorization and is ignored in production", async () => {
  const { db, env } = await createTestApp({ ENVIRONMENT: "staging", STAGING_ACCESS_PASSWORD: "pw-for-preview" });
  const ok = await req(env, "/__preview-access", { method: "POST", body: new URLSearchParams({ password: "pw-for-preview", next: "/" }) });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  const staff = await req(env, "/staff", { headers: { cookie } });
  assert.equal(staff.status, 303, "staff area still requires sign-in");
  assert.match(staff.headers.get("location")!, /^\/login/);
  await createStaff(db, "owner");
  const prod = await createTestApp({ ENVIRONMENT: "production", STAGING_ACCESS_PASSWORD: "pw" });
  assert.equal((await req(prod.env, "/pricing")).status, 200, "gate is off in production");
  void TEST_PASSWORD;
});

test("[INFRA-002] repeated wrong preview passwords are rate limited", async () => {
  const { env } = await createTestApp({ ENVIRONMENT: "staging", STAGING_ACCESS_PASSWORD: "pw-rate" });
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await req(env, "/__preview-access", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" }, body: new URLSearchParams({ password: "x" + i }) })).status;
  assert.equal(last, 429);
});

test("[INFRA-002] the deployed staging Worker (PREVIEW_GATE=required) fails closed without a preview password", async () => {
  const toml = (await import("node:fs")).readFileSync("wrangler.toml", "utf8");
  assert.match(toml, /\[env\.staging\][\s\S]*PREVIEW_GATE = "required"[\s\S]*\[env\.production\]/, "staging config requires the gate");
  assert.doesNotMatch(toml.slice(toml.indexOf("[env.production]")), /PREVIEW_GATE/, "production never sets it");
  const { env } = await createTestApp({ ENVIRONMENT: "staging", PREVIEW_GATE: "required" });
  for (const p of ["/", "/login", "/staff"]) assert.equal((await req(env, p)).status, 503, p);
  assert.equal((await req(env, "/api/health")).status, 200, "health check still reachable for deploy smoke tests");
});
