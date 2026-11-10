// www → apex (Founder, 2026-11-10): www.crestmontwebsitedevelopment.com is a second custom domain of the production Worker;
// every request is redirected permanently to the same path and query on the apex. No loop: the apex is served normally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestApp } from "./support/app.ts";
import { handle } from "../src/app/app.ts";

const APEX = "https://crestmontwebsitedevelopment.com";

test("[INFRA-002] www requests redirect permanently to the apex with path and query kept; the apex itself is served (no loop)", async () => {
  const t = await createTestApp({ ENVIRONMENT: "production", APP_URL: APEX } as never);
  const go = (url: string, method = "GET") => handle(new Request(url, { method, redirect: "manual" }), t.env);
  for (const path of ["/", "/pricing", "/checkout/business", "/contact", "/legal/privacy?x=1&y=two", "/services/ai-receptionist#calls"]) {
    const r = await go(`https://www.crestmontwebsitedevelopment.com${path}`);
    assert.equal(r.status, 301, path);
    assert.equal(r.headers.get("location"), `${APEX}${path.replace(/#.*$/, "")}`, `${path}: same path and query on the apex`);
  }
  assert.equal((await go("https://www.crestmontwebsitedevelopment.com/contact", "POST")).status, 308, "non-GET keeps its method");
  assert.equal((await go("http://www.crestmontwebsitedevelopment.com/about")).headers.get("location"), `${APEX}/about`, "plain HTTP www goes straight to the HTTPS apex");
  const apex = await go(`${APEX}/pricing`);
  assert.equal(apex.status, 200, "the apex is served, not redirected (no loop)");
  assert.equal((await go("https://www.example.com/")).status !== 301, true, "only www of APP_URL's host is redirected");
});

test("[INFRA-002] the production configuration attaches both the apex and www as custom domains of the production Worker", () => {
  const toml = readFileSync("wrangler.toml", "utf8");
  const prod = toml.slice(toml.indexOf("[env.production]"));
  assert.match(prod, /routes = \[\{ pattern = "crestmontwebsitedevelopment\.com", custom_domain = true \}, \{ pattern = "www\.crestmontwebsitedevelopment\.com", custom_domain = true \}\]/);
  const staging = toml.slice(toml.indexOf("[env.staging]"), toml.indexOf("[env.production]"));
  assert.doesNotMatch(staging, /^routes = \[/m, "staging stays on workers.dev");
});
