import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareCounts, countSql, drillEvidence, rowsOf } from "../scripts/restore-drill.ts";
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
  assert.match(wf, /count crestmont-staging "--remote --env staging" source \|\| fail "count source rows"/);
  assert.match(wf, /compare "\$\(cat drill\/source\.list\)" "\$\(cat drill\/restored\.list\)"/);
});
