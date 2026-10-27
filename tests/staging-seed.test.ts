import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../dev/sqlite-d1.ts";
import { TestClient } from "./support/app.ts";
import { syncRequirements } from "../src/readiness/ingest.ts";
import { staffNav, portalNav } from "../src/routes/nav.ts";
import type { Env } from "../src/app/context.ts";

test("[INFRA-002] staging seed applies cleanly on a migrated database and demo accounts reach every portal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-"));
  try {
    execFileSync(process.execPath, ["--no-warnings", "scripts/seed-staging.ts", "--out", join(dir, "seed.sql"), "--credentials", join(dir, "creds.md")], { stdio: "pipe" });
    const sql = readFileSync(join(dir, "seed.sql"), "utf8");
    const creds = readFileSync(join(dir, "creds.md"), "utf8");
    // Staging D1 = migrations applied, then the seed file. Applying twice must be harmless (INSERT OR IGNORE).
    const db = openDb(":memory:");
    await syncRequirements(db);
    db.raw.exec(sql);
    db.raw.exec(sql);
    assert.equal((db.raw.prepare("PRAGMA foreign_key_check").all() as unknown[]).length, 0, "no dangling foreign keys");
    assert.equal((db.raw.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    const rowsFor = (re: RegExp) => [...creds.matchAll(re)].map((m) => m.slice(1));
    const accounts = rowsFor(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm);
    assert.equal(accounts.length, 8);
    for (const [, em] of accounts) assert.match(em, /@crestmont-preview\.test$/, "demo emails use the reserved .test TLD");
    const env: Env = { DB: db, ENVIRONMENT: "development", APP_URL: "http://crestmont.test" };
    // Owner: every staff module renders with sample data.
    const [, ownerEmail, ownerPw, ownerTotp] = accounts.find((a) => a[0] === "owner")!;
    const o = await new TestClient(env).login(ownerEmail, ownerPw, ownerTotp);
    for (const i of staffNav({} as never).flatMap((g) => g.items)) assert.equal((await o.get(i.href)).status, 200, i.href);
    assert.match(await (await o.get("/staff/crm")).text(), /Sample — Northside Bakery|Morgan Sample/);
    assert.match(await (await o.get("/staff/projects")).text(), /Sample — Harbor Dental Studio/);
    // Customer: portal modules render and show their own sample project only.
    const [, custEmail, custPw] = accounts.find((a) => a[1].startsWith("customer.harbor"))!;
    const c = await new TestClient(env).login(custEmail, custPw);
    for (const i of portalNav({} as never).flatMap((g) => g.items)) assert.equal((await c.get(i.href)).status, 200, i.href);
    const projects = await (await c.get("/portal/projects")).text();
    assert.match(projects, /Harbor Dental/);
    assert.doesNotMatch(projects, /Ridgeline/, "tenant isolation holds in seeded data");
    // Developer sees assigned sample task.
    const [, devEmail, devPw, devTotp] = accounts.find((a) => a[0] === "developer")!;
    const d = await new TestClient(env).login(devEmail, devPw, devTotp);
    assert.match(await (await d.get("/staff/tasks")).text(), /Sample: homepage hero/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
