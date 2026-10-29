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

test("[INFRA-002] staging re-seed (reseed_demo_accounts) adds sample data alongside the existing demo accounts instead of failing on foreign keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reseed-"));
  try {
    const gen = (n: number) => {
      execFileSync(process.execPath, ["--no-warnings", "scripts/seed-staging.ts", "--out", join(dir, `seed${n}.sql`), "--credentials", join(dir, `creds${n}.md`)], { stdio: "pipe" });
      return { sql: readFileSync(join(dir, `seed${n}.sql`), "utf8"), creds: readFileSync(join(dir, `creds${n}.md`), "utf8") };
    };
    const first = gen(1), second = gen(2);   // two runs: same demo emails, different random ids
    const db = openDb(":memory:");
    await syncRequirements(db);
    db.raw.exec("PRAGMA foreign_keys = ON");
    // D1 applies a --file as one unit; a foreign-key failure anywhere rejected the whole re-seed before this fix.
    const apply = (sql: string) => { db.raw.exec("BEGIN"); try { db.raw.exec(sql); db.raw.exec("COMMIT"); } catch (e) { db.raw.exec("ROLLBACK"); throw e; } };
    apply(first.sql);
    const count = (t: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = { users: count("users"), projects: count("projects"), leads: count("leads") };
    apply(second.sql);
    assert.equal(count("users"), before.users, "demo accounts are not duplicated");
    assert.equal(count("projects"), before.projects * 2, "the re-seed adds its sample projects alongside");
    assert.equal(count("leads"), before.leads * 2);
    assert.equal((db.raw.prepare("PRAGMA foreign_key_check").all() as unknown[]).length, 0, "nothing references a user that does not exist");
    // The existing accounts keep their credentials: the first run's owner password and 2FA still sign in.
    const [, ownerEmail, ownerPw, ownerTotp] = [...first.creds.matchAll(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm)].map((m) => m.slice(1)).find((a) => a[0] === "owner")!;
    const env: Env = { DB: db, ENVIRONMENT: "development", APP_URL: "http://crestmont.test" };
    const o = await new TestClient(env).login(ownerEmail, ownerPw, ownerTotp);
    assert.equal((await o.get("/staff/projects")).status, 200);
    // Re-seeded sample rows are attached to the existing owner/sales accounts, not to the discarded ids.
    const owners = db.raw.prepare(`SELECT DISTINCT owner_user_id AS u FROM leads`).all() as { u: string }[];
    assert.equal(owners.length, 1, "both runs' leads belong to the one existing sales account");
    assert.ok(second.sql.includes(`(SELECT id FROM users WHERE email = 'sales@crestmont-preview.test')`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
