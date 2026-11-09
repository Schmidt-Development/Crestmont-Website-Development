// The production smoke test (scripts/production-smoke.ts) run against the in-memory production app: every check
// passes on a correctly configured production Worker before the public launch, it writes nothing, and it notices when
// customer access is open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";
import { handle } from "../src/app/app.ts";
import { httpSmoke } from "../scripts/production-smoke.ts";

const PROD = { ENVIRONMENT: "production" as const, APP_URL: "https://crestmont.test" };

test("[LAUNCH-003] production smoke: every anonymous check passes on pre-launch production and nothing is recorded", async () => {
  const t = await createTestApp(PROD);
  const results = await httpSmoke("https://crestmont.test", (r) => handle(r, t.env));
  const failed = results.filter((r) => r.outcome === "failed");
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
  assert.ok(results.length >= 30, `${results.length} checks`);
  for (const area of ["health", "public", "prelaunch", "access", "integrations", "payments", "ai", "security"]) assert.ok(results.some((r) => r.area === area), area);
  for (const table of ["leads", "users", "stripe_events"]) {
    const n = (await t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    assert.equal(n, 0, `${table} untouched`);
  }
});

test("[LAUNCH-003] production smoke fails when customer access is open before the launch authorization", async () => {
  const t = await createTestApp({ ...PROD, PUBLIC_LAUNCH: "open" } as never);
  const results = await httpSmoke("https://crestmont.test", (r) => handle(r, t.env));
  assert.ok(results.some((r) => r.area === "prelaunch" && r.outcome === "failed"));
});
