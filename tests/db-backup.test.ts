// Criterion 5 (2026-11-13): the Worker's daily database dump restores into an empty database with every table's rows,
// values (quotes, NULLs, blobs, unicode) and indexes intact; the manifest matches; the ops endpoint needs a challenge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createTestApp, createCustomer, MemoryStorage } from "./support/app.ts";
import { dumpDatabase, runDatabaseBackup, sqlLiteral, BACKUP_PREFIX, type BackupManifest } from "../src/services/db-backup.ts";
import { sha256Hex } from "../src/lib/crypto.ts";

test("[INFRA-006] the automated backup is a complete, restorable dump whose manifest matches the restored row counts", async () => {
  const t = await createTestApp();
  await createCustomer(t.db, "o'brien@fixture.example", "O'Brien \"Quotes\" & Sons — café ☕\nline two");
  t.db.raw.exec(`CREATE TABLE zz_blob_fixture (id INTEGER PRIMARY KEY, b BLOB, n REAL, s TEXT)`);
  t.db.raw.prepare(`INSERT INTO zz_blob_fixture (b, n, s) VALUES (?, ?, ?)`).run(new Uint8Array([0, 1, 255, 39]), 1.5, null);
  for (let i = 0; i < 1203; i++) t.db.raw.prepare(`INSERT INTO zz_blob_fixture (b, n, s) VALUES (NULL, ?, ?)`).run(i, `row ${i}`);
  const storage = new MemoryStorage();
  const m = await runDatabaseBackup({ db: t.db, storage, now: () => new Date("2026-11-13T11:17:00Z") });
  assert.equal(m.key, `${BACKUP_PREFIX}2026-11-13.sql`);
  const dump = storage.objects.get(m.key)!.data;
  assert.equal(m.sha256, await sha256Hex(dump));
  assert.equal(m.bytes, dump.length);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(storage.objects.get(`${BACKUP_PREFIX}latest.json`)!.data)) as BackupManifest, m);
  assert.equal(m.tables.zz_blob_fixture, 1204, "paged past 500-row pages");

  const restored = new DatabaseSync(":memory:");
  restored.exec(new TextDecoder().decode(dump));
  const src = t.db.raw;
  const tables = (src.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((r) => r.name);
  assert.ok(tables.length > 50);
  for (const name of tables) {
    const q = `SELECT COUNT(*) AS n FROM "${name}"`;
    assert.equal((restored.prepare(q).get() as { n: number }).n, (src.prepare(q).get() as { n: number }).n, name);
    assert.equal(m.tables[name], (src.prepare(q).get() as { n: number }).n, `manifest ${name}`);
  }
  const org = restored.prepare(`SELECT name FROM organizations WHERE name LIKE 'O''Brien%'`).get() as { name: string };
  assert.equal(org.name, "O'Brien \"Quotes\" & Sons — café ☕\nline two");
  const blob = restored.prepare(`SELECT b, n, s FROM zz_blob_fixture WHERE id = 1`).get() as { b: Uint8Array; n: number; s: null };
  assert.deepEqual([...blob.b], [0, 1, 255, 39]); assert.equal(blob.n, 1.5); assert.equal(blob.s, null);
  const idx = (db: DatabaseSync) => (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(idx(restored), idx(src));
});

test("[INFRA-006] value literals and the challenge-only ops endpoint", async () => {
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral(new Uint8Array([10, 171]).buffer), "X'0aab'");
  assert.equal(sqlLiteral(42), "42");
  const t = await createTestApp();
  const r = await t.client().request("POST", "/api/ops/database-backup", { body: JSON.stringify({ challenge: "0".repeat(64) }), headers: { "content-type": "application/json" } });
  assert.equal(r.status, 401);
  const unsigned = await t.client().request("POST", "/api/ops/database-backup", { body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(unsigned.status, 401);
  assert.ok((await dumpDatabase(t.db)).sql.startsWith("PRAGMA defer_foreign_keys=TRUE;"));
});
