// The readiness evidence cache (src/readiness/evidence-load.ts) keys on MAX(test_evidence.id) plus the
// latest succeeded deployments, and treats that as a complete version of the history. It is — but only
// because evidence is append-only, and that premise is load-bearing and was pinned by nothing.
//
// If anything ever deletes or rewrites an evidence row, MAX(id) does not move: the column is AUTOINCREMENT,
// so ids are never reused and the maximum never falls. A cached readiness report would then keep serving
// rows that no longer exist, and the dashboard would be confidently wrong — which is the failure this whole
// workstream exists to prevent. evidence_runs matters as much as test_evidence: it is the join's other half,
// and ON DELETE CASCADE means deleting a run silently takes its rows with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (/\.(ts|mjs|sql)$/.test(name)) out.push({ path: p, text: readFileSync(p, "utf8") });
    }
  };
  for (const d of ["src", "scripts", "migrations", "dev"]) walk(d);
  return out;
}

test("[READY-013] readiness evidence is append-only: nothing updates or deletes it", () => {
  // Comments are stripped so prose about deletion does not trip this, and so the SQL that CREATEs the
  // tables (with their own ON DELETE CASCADE clause) is not mistaken for a statement that deletes.
  const strip = (s: string) => s.replace(/^\s*(\/\/|--).*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const offenders: string[] = [];
  for (const { path, text } of sources()) {
    const sql = strip(text);
    for (const m of sql.matchAll(/\b(DELETE\s+FROM|UPDATE)\s+(test_evidence|evidence_runs)\b/gi)) {
      const line = sql.slice(0, m.index).split("\n").length;
      offenders.push(`${path}:${line}: ${m[0].replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(offenders, [],
    "the readiness evidence cache keys on MAX(test_evidence.id), which cannot detect a deletion or a rewrite: "
    + "either make the cache key cover it, or do not change these rows");
});

test("[READY-013] test_evidence.id is AUTOINCREMENT, so the cache key can never go backwards", () => {
  // A plain INTEGER PRIMARY KEY is the rowid, and SQLite may REUSE a freed rowid. Then an insert after a
  // deletion could leave MAX(id) unchanged while the contents differ, and the cache would not notice.
  // AUTOINCREMENT is what makes the maximum monotonic.
  const schema = readFileSync("migrations/0002_readiness.sql", "utf8");
  const table = schema.slice(schema.indexOf("CREATE TABLE test_evidence"));
  const body = table.slice(0, table.indexOf(");") + 1);
  assert.match(body, /id INTEGER PRIMARY KEY AUTOINCREMENT/, "the cache key depends on this");
});

test("[READY-013] the retention job leaves readiness evidence alone", () => {
  // Retention is the one place designed to remove rows in bulk. Its two tiers must not reach these tables,
  // whatever period anyone configures later.
  const retention = readFileSync("src/services/retention.ts", "utf8");
  const categories = [...retention.matchAll(/category:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(categories.length >= 10, `found ${categories.length} retention categories`);
  for (const c of categories) {
    assert.ok(!/evidence|readiness|requirement/.test(c), `retention category "${c}" looks like it touches readiness evidence`);
  }
  const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(strip(retention), /\b(test_evidence|evidence_runs)\b/,
    "retention must not name the evidence tables; readiness evidence is on its never-deleted list");
});
