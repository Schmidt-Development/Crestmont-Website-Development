// Bounded evidence load for the readiness report (READY-012/READY-013).
//
// The report used to read EVERY test_evidence row joined to its run — about 1,250 rows per staging deploy and growing
// without bound. Staging deploy #156 (2026-11-05) loaded the five readiness pages back to back during access
// verification and D1 answered the next fourteen Owner modules with
//   "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window".
// The same report backs /api/readiness/release-authorization, which the production deploy depends on, so it also put
// the release gate itself on a curve towards failure.
//
// Every verdict in src/readiness/derive.ts and src/readiness/engine.ts depends on a small subset of the history:
//   (a) all rows of runs at the commits that are judged: the integration head (newest CI on main), the newest CI run on
//       any branch (gate B) and the latest succeeded staging and production deployments (deployed-commit verdicts,
//       gate H);
//   (b) per requirement and environment, every non-skipped row at the latest non-skipped run time (latestPerEnv);
//   (c) per requirement, the rows at its newest evidence time (lastEvidenceAt, staleness) and at its newest PASSING CI
//       time (everPassed, lastPassedCommit);
//   (d) per requirement and source, one failed and one passed row if any exist (the whole-history verdict that
//       missingSources uses when no commit is proven).
// The keys come from evidence_rollup, which a trigger keeps current as rows arrive (migration 0091), and one indexed
// filtered pass returns the rows. Neither reads the whole history: before 0091 both did, on every cache miss in every
// isolate, and that was the largest D1 consumer when certification run 42345838991 overloaded staging (2026-11-07).
// Equivalence with the full load is proven on randomized histories by tests/readiness-evidence-load.test.ts.
import { underlyingDb, type Db } from "../lib/db.ts";
import type { EvidenceRow } from "./engine.ts";

const COLS = `te.requirement_id, te.outcome, te.test_name, te.run_id, er.environment, er.source, er.commit_sha, er.branch, er.finished_at`;

/** The previous unbounded load. Kept for the equivalence test and nothing else. */
export async function allEvidence(db: Db): Promise<EvidenceRow[]> {
  return (await db.prepare(`SELECT ${COLS} FROM test_evidence te JOIN evidence_runs er ON er.id = te.run_id ORDER BY te.id`).all<EvidenceRow>()).results;
}

interface Agg { r: string; env: string; src: string; any_at: string; ns_at: string | null; pass_at: string | null; f_id: number | null; p_id: number | null }

/**
 * Per-isolate cache of the bounded load. The aggregate and the filtered pass each scan test_evidence, so their cost
 * still grows with history even though their output does not (measured by the staging session: 30 ms at 10 runs,
 * 931 ms at 300). Five readiness pages in a row did five scans inside D1's 10-second budget. Evidence is append-only —
 * ingest inserts with ON CONFLICT DO NOTHING and nothing updates or deletes a row — so the newest row id is a complete
 * version of the history; the latest succeeded deployments are the only other input. Keyed on the real binding, not
 * the per-request retry wrapper, and per database, so separate databases (tests) never share an entry.
 */
const cache = new WeakMap<object, { key: string; rows: EvidenceRow[] }>();

export async function relevantEvidence(db: Db, defaultBranch = "main"): Promise<EvidenceRow[]> {
  const top = await db.prepare(`SELECT MAX(id) AS id FROM test_evidence`).first<{ id: number | null }>();
  const dep = (await db.prepare(`SELECT environment, commit_sha, deployed_at, id FROM deployments WHERE status = 'succeeded' AND environment IN ('staging','production') ORDER BY environment, deployed_at DESC, id DESC`)
    .all<{ environment: string; commit_sha: string }>().catch(() => ({ results: [] as { environment: string; commit_sha: string }[] }))).results;
  const latest = [...new Map(dep.map((d) => [d.environment, d.commit_sha] as const).reverse()).entries()].sort();
  const key = JSON.stringify([top?.id ?? 0, latest, defaultBranch]);
  const slot = underlyingDb(db) as unknown as object;
  const hit = cache.get(slot);
  if (hit && hit.key === key) return hit.rows;
  const rows = await loadRelevant(db, defaultBranch);
  cache.set(slot, { key, rows });
  return rows;
}

async function loadRelevant(db: Db, defaultBranch: string): Promise<EvidenceRow[]> {
  // Commits that are judged. A run counts only if it has rows, exactly as when these were read from the rows. When
  // several runs tie on the newest finished_at, the derivation's choice among them depends on iteration order, so the
  // commits of ALL tied runs are included: whichever it picks, its rows are present.
  const hasRows = `EXISTS (SELECT 1 FROM test_evidence te WHERE te.run_id = er.id)`;
  const newest = async (where: string, ...b: unknown[]) => (await db.prepare(`SELECT DISTINCT er.commit_sha FROM evidence_runs er WHERE ${where} AND ${hasRows}
      AND er.finished_at = (SELECT MAX(er.finished_at) FROM evidence_runs er WHERE ${where} AND ${hasRows})`).bind(...b, ...b).all<{ commit_sha: string }>()).results.map((x) => x.commit_sha);
  const headMain = await newest(`er.source = 'ci' AND er.branch = ?`, defaultBranch);
  const newestCi = await newest(`er.source = 'ci'`);
  const deployed = (await db.prepare(`SELECT d.environment, d.commit_sha FROM deployments d WHERE d.status = 'succeeded' AND d.environment IN ('staging','production')
      AND NOT EXISTS (SELECT 1 FROM deployments x WHERE x.environment = d.environment AND x.status = 'succeeded' AND (x.deployed_at > d.deployed_at OR (x.deployed_at = d.deployed_at AND x.id > d.id)))`)
    .all<{ environment: string; commit_sha: string }>().catch(() => ({ results: [] as { environment: string; commit_sha: string }[] }))).results;
  const commits = [...new Set([...headMain, ...newestCi, ...deployed.map((d) => d.commit_sha)].filter((c): c is string => !!c))];

  // Per requirement × environment × source, the times and representative rows the verdicts use. Kept current at insert
  // time by the test_evidence_rollup trigger (migration 0091), so this reads a few hundred rows instead of aggregating
  // the whole history: that aggregate was the largest D1 consumer when certification run 42345838991 overloaded staging.
  const agg = (await db.prepare(`SELECT requirement_id AS r, environment AS env, source AS src, any_at, ns_at, pass_at, f_id, p_id FROM evidence_rollup`).all<Agg>()).results;

  const ids = new Set<number>();
  const k = (...p: string[]) => p.join("\u0001");
  const maxBy = (m: Map<string, string>, key: string, v: string | null) => { if (v !== null && (!m.has(key) || v > m.get(key)!)) m.set(key, v); };
  const nsEnv = new Map<string, string>(), anyReq = new Map<string, string>(), ciPass = new Map<string, string>();
  const failRep = new Map<string, number>(), passRep = new Map<string, number>();
  for (const a of agg) {
    maxBy(nsEnv, k(a.r, a.env), a.ns_at);
    maxBy(anyReq, a.r, a.any_at);
    if (a.src === "ci") maxBy(ciPass, a.r, a.pass_at);
    if (a.f_id !== null) failRep.set(k(a.r, a.src), Math.min(failRep.get(k(a.r, a.src)) ?? Infinity, a.f_id));
    if (a.p_id !== null) passRep.set(k(a.r, a.src), Math.min(passRep.get(k(a.r, a.src)) ?? Infinity, a.p_id));
  }
  // (b) latest non-skipped run time per requirement and environment: rows matched by (requirement, environment, time).
  const nsKeys = [...nsEnv].map(([key, at]) => [...key.split("\u0001"), at]);
  // (c) newest evidence and newest passing CI per requirement: rows matched by (requirement, any environment, time).
  const timeKeys = new Map<string, [string, string]>();
  for (const [r, at] of anyReq) timeKeys.set(k(r, at), [r, at]);
  for (const [r, at] of ciPass) timeKeys.set(k(r, at), [r, at]);
  // (d) whole-history verdict per requirement and source.
  for (const v of failRep.values()) ids.add(v);
  for (const v of passRep.values()) ids.add(v);

  // The same four conditions as one OR over the history, but each answered through an index (runs by commit, by
  // environment and time, by time; rows by run and requirement; rows by id), so the cost follows the output. CROSS JOIN
  // fixes SQLite's join order (runs first, then rows by run): left to choose, the planner reaches test_evidence through
  // idx_test_evidence_req instead, which visits a requirement's whole history for every key.
  const rows = (await db.prepare(`SELECT ${COLS} FROM test_evidence te JOIN evidence_runs er ON er.id = te.run_id
      WHERE te.id IN (
        SELECT te.id FROM evidence_runs er CROSS JOIN test_evidence te ON te.run_id = er.id WHERE er.commit_sha IN (SELECT value FROM json_each(?1))
        UNION SELECT value FROM json_each(?2)
        UNION SELECT te.id FROM json_each(?3) k
          CROSS JOIN evidence_runs er ON er.environment = json_extract(k.value, '$[1]') AND er.finished_at = json_extract(k.value, '$[2]')
          CROSS JOIN test_evidence te ON te.run_id = er.id AND te.requirement_id = json_extract(k.value, '$[0]')
          WHERE te.outcome <> 'skipped'
        UNION SELECT te.id FROM json_each(?4) k
          CROSS JOIN evidence_runs er ON er.finished_at = json_extract(k.value, '$[1]')
          CROSS JOIN test_evidence te ON te.run_id = er.id AND te.requirement_id = json_extract(k.value, '$[0]'))
      ORDER BY te.id`)
    .bind(JSON.stringify(commits), JSON.stringify([...ids]), JSON.stringify(nsKeys), JSON.stringify([...timeKeys.values()])).all<EvidenceRow>()).results;
  return rows;
}
