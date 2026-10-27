// Restore drill (TEST-004, BACKUP-RECOVERY §3.3): restores a SQL export into a FRESH database and
// verifies it — integrity_check, foreign_key_check, the append-only audit triggers, and (when the
// source database is available) row counts per table and schema object parity with the source.
//
//   node --no-warnings scripts/restore-verify.ts --export backups/dev.sql [--source .dev/crestmont.db]
//        [--target /tmp/restore.db] [--record .dev/crestmont.db --by <staff user id>] [--backup-id <bkp_…>]
//
// --record writes the drill to restore_tests (environment "development") in the given database, with
// the observed duration. Drills never target production: --target must be a new file or :memory:.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

export interface VerifyReport {
  ok: boolean; tables: number; rows: number;
  counts: Record<string, number>;
  mismatches: { table: string; source: number | null; restored: number | null }[];
  schemaMissing: string[];
  integrity: string; foreignKeyViolations: number;
  auditAppendOnly: boolean; durationMs: number; exportSha256: string;
  problems: string[];
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

function tableCounts(db: DatabaseSync): Record<string, number> {
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  return Object.fromEntries(names.map((n) => [n, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${q(n)}`).get() as { n: number }).n)]));
}

function schemaObjects(db: DatabaseSync): Set<string> {
  return new Set((db.prepare(`SELECT type || ':' || name AS k FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`).all() as { k: string }[]).map((r) => r.k));
}

/** Restores `sql` into `target` (a fresh database) and verifies it. `source` enables parity checks. */
export function restoreAndVerify(sql: string, target: DatabaseSync, source?: DatabaseSync): VerifyReport {
  const started = Date.now();
  const problems: string[] = [];
  const existing = (target.prepare(`SELECT COUNT(*) AS n FROM sqlite_master`).get() as { n: number }).n;
  if (existing > 0) throw new Error("Restore target is not empty. Drills always restore into a fresh database.");
  target.exec("PRAGMA foreign_keys = OFF;"); // matches D1 import: constraints are checked after load
  target.exec("BEGIN");
  try { target.exec(sql); target.exec("COMMIT"); } catch (e) { target.exec("ROLLBACK"); throw new Error(`Restore failed: ${(e as Error).message}`); }
  target.exec("PRAGMA foreign_keys = ON;");

  const integrity = (target.prepare(`PRAGMA integrity_check`).all() as { integrity_check: string }[]).map((r) => r.integrity_check).join("; ");
  if (integrity !== "ok") problems.push(`integrity_check: ${integrity}`);
  const fk = target.prepare(`PRAGMA foreign_key_check`).all() as unknown[];
  if (fk.length) problems.push(`${fk.length} foreign key violation(s)`);

  const counts = tableCounts(target);
  const mismatches: VerifyReport["mismatches"] = [];
  const schemaMissing: string[] = [];
  if (source) {
    const src = tableCounts(source);
    for (const t of new Set([...Object.keys(src), ...Object.keys(counts)])) {
      if (src[t] !== counts[t]) mismatches.push({ table: t, source: src[t] ?? null, restored: counts[t] ?? null });
    }
    const have = schemaObjects(target);
    for (const k of schemaObjects(source)) if (!have.has(k)) schemaMissing.push(k);
    if (mismatches.length) problems.push(`${mismatches.length} table row-count mismatch(es)`);
    if (schemaMissing.length) problems.push(`missing schema objects: ${schemaMissing.join(", ")}`);
  }

  // The audit log must still be append-only after a restore (SEC-005). Probe inside a savepoint.
  let auditAppendOnly = false;
  if (counts.audit_logs !== undefined) {
    target.exec("SAVEPOINT probe");
    try {
      target.exec(`INSERT INTO audit_logs (actor_kind, action, subject_type, created_at) VALUES ('system','restore.probe','restore','1970-01-01T00:00:00Z')`);
      try { target.exec(`UPDATE audit_logs SET action = 'tampered' WHERE action = 'restore.probe'`); } catch { auditAppendOnly = true; }
      if (auditAppendOnly) { try { target.exec(`DELETE FROM audit_logs WHERE action = 'restore.probe'`); auditAppendOnly = false; } catch { /* still append-only */ } }
    } finally { target.exec("ROLLBACK TO probe"); target.exec("RELEASE probe"); }
    if (!auditAppendOnly) problems.push("audit_logs append-only triggers are missing after restore");
  }

  const rows = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    ok: problems.length === 0, tables: Object.keys(counts).length, rows, counts, mismatches, schemaMissing, integrity, foreignKeyViolations: fk.length,
    auditAppendOnly, durationMs: Date.now() - started, exportSha256: createHash("sha256").update(sql, "utf8").digest("hex"), problems,
  };
}

/** Records the drill in restore_tests. Environment is always "development" from this script. */
export function recordDrill(db: DatabaseSync, r: VerifyReport, opts: { performedBy: string; exportPath: string; target: string; backupRecordId?: string | null }): string {
  const id = `rst_${randomBytes(12).toString("hex")}`;
  const at = new Date().toISOString();
  const evidence = `scripts/restore-verify.ts: ${r.ok ? "PASSED" : "FAILED"} — ${r.tables} tables, ${r.rows} rows restored from ${opts.exportPath} (sha256 ${r.exportSha256}); `
    + `integrity_check=${r.integrity}; foreign_key_check violations=${r.foreignKeyViolations}; row-count mismatches=${r.mismatches.length}; `
    + `audit_logs append-only=${r.auditAppendOnly ? "yes" : "NO"}; duration ${r.durationMs} ms.${r.problems.length ? ` Problems: ${r.problems.join("; ")}` : ""}`;
  db.prepare(`INSERT INTO restore_tests (id, backup_record_id, what, target, environment, performed_at, performed_by, verified_by, result, duration_minutes, data_loss_minutes, evidence, created_at)
              VALUES (?,?,?,?, 'development', ?, ?, NULL, ?, ?, NULL, ?, ?)`)
    .run(id, opts.backupRecordId ?? null, `Logical SQL export restore drill (${opts.exportPath})`, opts.target, at, opts.performedBy, r.ok ? "passed" : "failed",
      Math.max(1, Math.ceil(r.durationMs / 60_000)), evidence.slice(0, 4000), at);
  try {
    db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, created_at) VALUES (?, 'system', 'backup.restore_test_recorded', 'restore_test', ?, ?, ?)`)
      .run(opts.performedBy, id, JSON.stringify({ result: r.ok ? "passed" : "failed", script: "restore-verify" }), at);
  } catch { /* audit table absent in a bare database */ }
  return id;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const exportPath = get("--export");
  if (!exportPath) { console.error("Usage: --export <file.sql> [--source db] [--target db|:memory:] [--record db --by <user id>] [--backup-id id]"); process.exit(2); }
  const targetPath = get("--target") ?? ":memory:";
  if (targetPath !== ":memory:" && existsSync(targetPath)) { console.error(`Refusing to restore into existing file ${targetPath}; drills use a fresh database.`); process.exit(2); }
  const source = get("--source") ? new DatabaseSync(get("--source")!, { readOnly: true }) : undefined;
  const target = new DatabaseSync(targetPath);
  const report = restoreAndVerify(readFileSync(exportPath, "utf8"), target, source);
  console.log(JSON.stringify({ ...report, counts: undefined }, null, 2));
  const recordPath = get("--record");
  if (recordPath) {
    const by = get("--by");
    if (!by) { console.error("--record requires --by <staff user id> (performed_by)"); process.exit(2); }
    const rec = new DatabaseSync(recordPath);
    console.log(`Recorded restore drill ${recordDrill(rec, report, { performedBy: by, exportPath, target: targetPath, backupRecordId: get("--backup-id") ?? null })}`);
    rec.close();
  }
  process.exit(report.ok ? 0 : 1);
}
