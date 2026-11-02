import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareCounts, countSql, drillEvidence, exportCounts, rowsOf } from "../scripts/restore-drill.ts";
import { parseEvidence } from "../src/readiness/ingest.ts";

test("[TEST-004] staging restore drill: counts every table, detects missing/extra tables and row drift, and emits valid signed-evidence documents", () => {
  const tables = rowsOf(`[{"results":[{"name":"users"},{"name":"projects"},{"name":"sqlite_sequence"},{"name":"d1_migrations"},{"name":"_cf_KV"},{"name":"bad name;"}],"success":true}]`).map((r) => String(r.name));
  assert.equal(countSql(tables), `SELECT (SELECT COUNT(*) FROM "projects") AS "projects", (SELECT COUNT(*) FROM "users") AS "users"`);
  const src = [{ t: "users", n: 8 }, { t: "projects", n: 2 }];
  const ok = compareCounts(src, [{ t: "projects", n: 2 }, { t: "users", n: 8 }]);
  assert.deepEqual(ok, { passed: true, tables: 2, rows: 10, problems: [] });
  const bad = compareCounts(src, [{ t: "users", n: 7 }, { t: "extra", n: 1 }]);
  assert.equal(bad.passed, false);
  assert.deepEqual(bad.problems, ["users: 8 rows before, 7 after", "projects: missing after restore", "extra: unexpected table after restore"]);
  assert.equal(compareCounts([], []).passed, false, "an empty export never passes");
  const doc = parseEvidence(drillEvidence(bad, { commit: "a".repeat(40), runId: "gh-1-1-restore-drill", startedAt: new Date().toISOString() }));
  assert.equal(doc.environment, "staging");
  assert.deepEqual(doc.results.map((r) => [r.requirementId, r.outcome]), [["TEST-004", "failed"], ["INFRA-006", "failed"]]);
  // The workflow only reads staging (export) and writes to a scratch database it deletes.
  const wf = readFileSync(".github/workflows/staging-restore-drill.yml", "utf8");
  assert.match(wf, /d1 export crestmont-staging --remote --env staging/);
  assert.doesNotMatch(wf, /d1 execute crestmont-staging[^\n]*--file/, "never imports into staging");
  assert.doesNotMatch(wf, /--env production|crestmont-production/);
  assert.match(wf, /d1 delete "\$SCRATCH"/);
  assert.match(wf, /rm -rf drill/);
});

test("[TEST-004] [INFRA-006] restore drill counts tables without compound SELECTs (D1 error 7500 on staging), in batches, and compares across batch outputs", async () => {
  const { countQueries, rowsOfAll } = await import("../scripts/restore-drill.ts");
  const tables = Array.from({ length: 40 }, (_, i) => `t${String(i).padStart(2, "0")}`).concat(["sqlite_sequence", "_cf_KV", "d1_migrations"]);
  const qs = countQueries(tables, 15);
  assert.equal(qs.length, 3);
  assert.ok(qs.every((q) => !/UNION/i.test(q)), "no compound SELECT");
  assert.equal(qs.join(" ").match(/SELECT COUNT\(\*\)/g)!.length, 40, "every user table counted once, internal tables skipped");
  const oneRow = (ts: string[]) => JSON.stringify([{ results: [Object.fromEntries(ts.map((t) => [t, 2]))], success: true }]);
  assert.deepEqual(rowsOfAll([oneRow(["a", "b"]), oneRow(["c"])]), [{ t: "a", n: 2 }, { t: "b", n: 2 }, { t: "c", n: 2 }]);
  const wf = (await import("node:fs")).readFileSync(".github/workflows/staging-restore-drill.yml", "utf8");
  assert.match(wf, /count "\$SCRATCH" "--remote" restored \|\| fail "count restored rows"/, "the restored side is counted in batches");
  assert.match(wf, /export-counts drill\/staging\.sql > drill\/source-0\.json \|\| fail "count exported rows"/, "the source side is the export itself");
  assert.match(wf, /compare "\$\(cat drill\/source\.list\)" "\$\(cat drill\/restored\.list\)"/);
});

test("[TEST-004] restore drill sanitizes the D1 export before importing it (transactions, reserved _cf_ tables, sqlite_sequence) and keeps everything else", async () => {
  const { sanitizeExport } = await import("../scripts/restore-drill.ts");
  const dump = ["PRAGMA defer_foreign_keys=TRUE;", "BEGIN TRANSACTION;", 'CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;', 'INSERT INTO "_cf_KV" VALUES(\'a\',X\'00\');',
    "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);", 'INSERT INTO "users" VALUES(\'u1\',\'a@b.example\');', 'DELETE FROM sqlite_sequence;', 'INSERT INTO "sqlite_sequence" VALUES(\'audit_logs\',5);', "COMMIT;"].join("\n");
  const r = sanitizeExport(dump + "\nANALYZE sqlite_schema;\nINSERT INTO sqlite_stat1 VALUES('users','sqlite_autoindex_users_1','1 1');");
  assert.deepEqual(r.removed, { transaction: 2, "_cf_ tables": 2, "sqlite internal": 4 });
  assert.equal(r.sql, ["PRAGMA defer_foreign_keys=TRUE;", "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);", 'INSERT INTO "users" VALUES(\'u1\',\'a@b.example\');', ""].join("\n"));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(r.sql);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 1, "the sanitized dump restores");
});

test("[TEST-004] [SEC-003] a failed drill's reason (shown on the public health feed) never carries row data or tokens", async () => {
  const { redactReason, drillEvidence } = await import("../scripts/restore-drill.ts");
  const raw = `import export into scratch: ✘ [ERROR] UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT (code 7500) near INSERT INTO "users" VALUES('usr_1','dana.customer@harbor-dental.example','Dana O''Neil',X'00ff'); account 0123456789abcdef0123456789abcdef`;
  const r = redactReason(raw);
  for (const leaked of ["dana.customer", "harbor-dental", "Dana O", "00ff", "0123456789abcdef"]) assert.ok(!r.includes(leaked), `leaked ${leaked}: ${r}`);
  assert.match(r, /UNIQUE constraint failed: users\.email: SQLITE_CONSTRAINT \(code 7500\)/, "the diagnosis survives");
  assert.match(redactReason("no such table: main.deploy_secret_fingerprints"), /deploy_secret_fingerprints/, "long table names are not mistaken for tokens");
  // The CLI's fail mode applies it before the evidence is written.
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "drill-"));
  try {
    execFileSync(process.execPath, ["--no-warnings", "scripts/restore-drill.ts", "fail", "--reason", raw, "--out", join(dir, "e.json")]);
    const ev = readFileSync(join(dir, "e.json"), "utf8");
    assert.ok(!ev.includes("dana.customer") && !ev.includes("Dana O"));
    assert.equal(JSON.parse(ev).results[0].outcome, "failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.ok(drillEvidence);
});

test("[TEST-004] restore drill parses the export into statements: ';' and newlines inside data, quoted names, comments and trigger bodies", async () => {
  const { splitStatements, sanitizeExport } = await import("../scripts/restore-drill.ts");
  const sql = [
    "-- header comment; not a statement",
    `INSERT INTO "notes" VALUES('a;b','line1`, `COMMIT;`, `END;', 'it''s');`,
    "CREATE TRIGGER t BEFORE UPDATE ON notes\nBEGIN\n  SELECT RAISE(ABORT, 'no; updates');\nEND;",
    'CREATE TABLE "odd ""name""" (x TEXT);',
  ].join("\n");
  const s = splitStatements(sql);
  assert.equal(s.length, 3);
  assert.match(s[0], /^INSERT INTO "notes" VALUES\('a;b','line1\nCOMMIT;\nEND;', 'it''s'\);$/, "data that looks like COMMIT;/END; stays inside its row");
  assert.match(s[1], /^CREATE TRIGGER t[\s\S]*END;$/, "a trigger body is one statement");
  const r = sanitizeExport(sql);
  assert.deepEqual(r.removed, {}, "nothing inside a row or a trigger is mistaken for a transaction statement");
});

/** A dump shaped like `wrangler d1 export`: defer_foreign_keys first, tables in creation order each followed by its
 *  rows, then indexes and triggers, then SQLite internals. */
async function d1StyleExport(db: import("node:sqlite").DatabaseSync): Promise<string> {
  const master = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { type: string; name: string; sql: string }[];
  const lit = (v: unknown) => v === null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  const out = ["PRAGMA defer_foreign_keys=TRUE;"];
  for (const m of master.filter((m) => m.type === "table")) {
    out.push(`${m.sql};`);
    for (const row of db.prepare(`SELECT * FROM "${m.name}"`).all()) out.push(`INSERT INTO "${m.name}" VALUES(${Object.values(row).map(lit).join(",")});`);
  }
  for (const m of master.filter((m) => m.type !== "table")) out.push(`${m.sql};`);
  out.push("DELETE FROM sqlite_sequence;", "ANALYZE sqlite_schema;");
  return out.join("\n");
}

test("[TEST-004] [INFRA-006] restore drill re-orders the export so a table created before the table it references restores (staging import failed: D1_RESET_DO)", async () => {
  const { sanitizeExport, splitStatements } = await import("../scripts/restore-drill.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const { readdirSync } = await import("node:fs");
  // The real schema: requirements (0002) references release_approvals (created later in 0002), deployments → releases, …
  const src = new DatabaseSync(":memory:");
  src.exec("PRAGMA foreign_keys=ON");
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) src.exec(readFileSync(`migrations/${f}`, "utf8"));
  // One readiness requirement, as staging's evidence ingester writes; its approval reference is NULL — SQLite still
  // needs the referenced table to exist to insert it.
  src.exec(`INSERT INTO requirements (id, subsystem, section, title, priority, category, requires_founder_approval, inventory_version, updated_at)
    VALUES ('TEST-004','ops','backups','restore drill','P0','engineering',0,'v1','2026-10-28T00:00:00.000Z')`);
  const dump = await d1StyleExport(src);
  const tables = (src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  const counts = (db: InstanceType<typeof DatabaseSync>) => Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n]));
  const replay = (sql: string) => {  // statement by statement, foreign keys enforced, as a fresh D1 database does
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const s of splitStatements(sql)) db.exec(s);
    return db;
  };
  const unsorted = dump.split("\n").filter((l) => !/sqlite_sequence|^ANALYZE/.test(l)).join("\n");
  assert.throws(() => replay(unsorted), /no such table: main\.release_approvals/, "export order alone cannot be restored");

  const r = sanitizeExport(dump);
  const restored = replay(r.sql);
  assert.deepEqual(counts(restored), counts(src), "every table restored with identical row counts");
  assert.equal((restored.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
  const objs = (db: InstanceType<typeof DatabaseSync>) => db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  assert.deepEqual(objs(restored), objs(src), "tables, indexes and append-only triggers all restored");
  assert.throws(() => restored.exec("DELETE FROM agreements"), /cannot be deleted/, "restored triggers still enforce");
  // Every CREATE TABLE precedes every row.
  const st = splitStatements(r.sql);
  const lastCreate = st.map((s) => /^CREATE TABLE/i.test(s)).lastIndexOf(true), firstInsert = st.findIndex((s) => /^INSERT/i.test(s));
  assert.ok(lastCreate < firstInsert);
});

test("[TEST-004] restore drill inserts parent rows before child rows (no reliance on deferred foreign keys across import batches)", async () => {
  const { sanitizeExport, splitStatements } = await import("../scripts/restore-drill.ts");
  const dump = ["PRAGMA defer_foreign_keys=TRUE;",
    "CREATE TABLE invoices (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id));", `INSERT INTO "invoices" VALUES('i1','p1');`,
    'CREATE TABLE "projects" (id TEXT PRIMARY KEY, org TEXT REFERENCES [orgs](id));', `INSERT INTO "projects" VALUES('p1','o1');`,
    "CREATE TABLE orgs (id TEXT PRIMARY KEY, parent TEXT REFERENCES orgs(id));", `INSERT INTO "orgs" VALUES('o0',NULL);`, `INSERT INTO "orgs" VALUES('o1','o0');`,
    "CREATE INDEX idx_inv ON invoices(project_id);"].join("\n");
  const st = splitStatements(sanitizeExport(dump).sql);
  assert.deepEqual(st.filter((s) => /^INSERT/.test(s)).map((s) => s.match(/INTO "(\w+)"/)![1]), ["orgs", "orgs", "projects", "invoices"], "parents first; a table's own rows keep their order");
  assert.equal(st.at(-1), "CREATE INDEX idx_inv ON invoices(project_id);", "indexes after data");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const s of st.filter((s) => !/^PRAGMA/.test(s))) db.exec(s);   // even with no deferral at all
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM invoices").get() as { n: number }).n, 1);
});

test("[TEST-004] [INFRA-006] restore drill compares the restore with the EXPORT's own row counts, so live writes after the export cannot fail an exact restore; a lost row still fails", () => {
  // Wrangler's d1 export: one INSERT per row; reserved and internal tables are not counted (they are not restored).
  const dump = ["PRAGMA defer_foreign_keys=TRUE;", 'CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;', 'INSERT INTO "_cf_KV" VALUES(\'a\',X\'00\');',
    'CREATE TABLE "rate_limits" (k TEXT, at TEXT);', 'INSERT INTO "rate_limits" VALUES(\'a\',\'x;y\');', 'INSERT INTO "rate_limits" VALUES(\'b\',\'it\'\'s\');',
    "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);", "CREATE TABLE empty_t (id TEXT);", 'INSERT INTO "users" VALUES(\'u1\',\'a@b.example\');',
    'INSERT INTO "sqlite_sequence" VALUES(\'x\',1);'].join("\n");
  const source = exportCounts(dump);
  assert.deepEqual(source, [{ t: "empty_t", n: 0 }, { t: "rate_limits", n: 2 }, { t: "users", n: 1 }]);
  const restored = [{ t: "empty_t", n: 0 }, { t: "rate_limits", n: 2 }, { t: "users", n: 1 }];
  // Staging 2026-11-02: the live database gained a rate_limits row after the export (6508 counted live, 6507 exported
  // and restored). Against the live count that exact restore failed; against the export it passes.
  assert.equal(compareCounts([{ t: "empty_t", n: 0 }, { t: "rate_limits", n: 3 }, { t: "users", n: 1 }], restored).passed, false, "the old live-count comparison");
  assert.equal(compareCounts(source, restored).passed, true);
  // A restore that loses a row, or a table, is still a failure.
  assert.deepEqual(compareCounts(source, [{ t: "empty_t", n: 0 }, { t: "rate_limits", n: 1 }, { t: "users", n: 1 }]).problems, ["rate_limits: 2 rows before, 1 after"]);
  assert.deepEqual(compareCounts(source, [{ t: "rate_limits", n: 2 }, { t: "users", n: 1 }]).problems, ["empty_t: missing after restore"]);
  // The workflow takes the source side from the export file, never from a later count of the live database.
  const wf = readFileSync(new URL("../.github/workflows/staging-restore-drill.yml", import.meta.url), "utf8");
  assert.match(wf, /restore-drill\.ts export-counts drill\/staging\.sql > drill\/source-0\.json/);
  assert.doesNotMatch(wf, /count crestmont-staging "--remote --env staging" source/);
});
