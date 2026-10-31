// Stand-in for `wrangler d1 execute <db> --remote --env <env> --json --command <sql>` used by read-only tool tests.
// Answers from the SQLite file in FAKE_D1_PATH and FAILS on any statement that is not a single SELECT.
import { DatabaseSync } from "node:sqlite";
const args = process.argv.slice(2);
const sql = args[args.indexOf("--command") + 1] ?? "";
if (!/^\s*SELECT\b/i.test(sql)) { console.error(`fake-wrangler: refused non-SELECT: ${sql.slice(0, 60)}`); process.exit(3); }
const db = new DatabaseSync(process.env.FAKE_D1_PATH, { readOnly: true });
process.stdout.write("wrangler banner\n" + JSON.stringify([{ results: db.prepare(sql).all(), success: true }]));
