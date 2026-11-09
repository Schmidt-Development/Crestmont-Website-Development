// Founder's F6 authorization (2026-11-09): production may be deployed and smoke-tested, but customer access stays
// closed until the public launch is authorized separately (src/app/prelaunch.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { customerAccessOpen, isCustomerEntry } from "../src/app/prelaunch.ts";

test("[LAUNCH-003] production before the public launch: the website and staff sign-in work; sign-up, enquiries, the assistant and checkout are closed", async () => {
  const t = await createTestApp({ ENVIRONMENT: "production", APP_URL: "https://crestmontwebsitedevelopment.com" });
  const c = t.client();
  for (const p of ["/", "/pricing", "/contact", "/quote", "/login", "/api/health"]) assert.equal((await c.get(p)).status, 200, `${p} stays visible`);
  for (const p of ["/register", "/checkout/starter"]) {
    const r = await c.get(p);
    assert.equal(r.status, 503, p);
    assert.match(await r.text(), /We are opening soon/);
    assert.equal(r.headers.get("retry-after"), "86400");
  }
  for (const p of ["/register", "/quote", "/contact"]) assert.equal((await c.post(p, { name: "Visitor", email: "v@example.com" })).status, 503, `POST ${p}`);
  const api = await c.post("/api/leads", {});
  assert.equal(api.status, 503);
  assert.equal(((await api.json()) as { error: string }).error, "not_open_yet");
  assert.equal((await c.post("/api/assistant", {})).status, 503);
  // Nothing was recorded by the refused entry points.
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM leads`).first<{ n: number }>())!.n, 0);
  // The Owner signs in and reaches the staff area as usual.
  const owner = await createStaff(t.db, "owner");
  const oc = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);
  assert.equal((await oc.get("/staff")).status, 200);
});

test("[LAUNCH-003] the public launch is one committed setting; staging and development are never restricted", async () => {
  assert.equal(customerAccessOpen({ ENVIRONMENT: "production" }), false);
  assert.equal(customerAccessOpen({ ENVIRONMENT: "production", PUBLIC_LAUNCH: "yes" }), false, "only the exact value opens");
  assert.equal(customerAccessOpen({ ENVIRONMENT: "production", PUBLIC_LAUNCH: "open" }), true);
  assert.equal(customerAccessOpen({ ENVIRONMENT: "staging" }), true);
  assert.equal(customerAccessOpen({ ENVIRONMENT: "development" }), true);
  assert.equal(isCustomerEntry("GET", "/q/abc"), false, "staff-sent proposal links stay usable");
  assert.equal(isCustomerEntry("GET", "/quote"), false, "the quote page is visible; only its submission is closed");
  const open = await createTestApp({ ENVIRONMENT: "production", APP_URL: "https://crestmontwebsitedevelopment.com", PUBLIC_LAUNCH: "open" } as never);
  assert.equal((await open.client().get("/register")).status, 200);
  const staging = await createTestApp({ ENVIRONMENT: "staging" });
  assert.equal((await staging.client().get("/register")).status, 200);
  // The committed production configuration does not open early.
  const toml = readFileSync("wrangler.toml", "utf8");
  const start = toml.indexOf("[env.production]");
  const next = toml.indexOf("\n[env.", start + 1);
  const prod = toml.slice(start, next > 0 ? next : undefined);
  assert.ok(start >= 0 && prod.includes('ENVIRONMENT = "production"'));
  assert.doesNotMatch(prod, /PUBLIC_LAUNCH\s*=\s*"open"/, "opening customer access needs the Founder's separate authorization");
});
