// Places, releases or lists legal holds (src/services/legal-holds.ts, finding F-25). Owner decision,
// normally on counsel's advice. Same operator pattern as scripts/bootstrap-owner.ts.
//
//   Local DB:     node --no-warnings scripts/legal-hold.ts place --scope organization --subject org_abc --reason "Chargeback dispute" --matter CB-2026-01 --db .dev/crestmont.db
//   D1 (remote):  node --no-warnings scripts/legal-hold.ts place --scope global --reason "Security incident INC-7" --print-sql > hold.sql
//                 wrangler d1 execute crestmont-staging --remote --file hold.sql
//   Release:      node --no-warnings scripts/legal-hold.ts release --id hold_... --note "Dispute closed, counsel approved" [--db ... | --print-sql]
//   List:         node --no-warnings scripts/legal-hold.ts list --db .dev/crestmont.db
//
// Holds are never deleted; facts are immutable; a release is recorded once (database triggers).
// --by <user id> records the Owner's user id as the actor; omit it and the row records no person.
import { newId } from "../src/lib/db.ts";

const [cmd, ...args] = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const q = (s: string | null | undefined) => (s === null || s === undefined ? "NULL" : `'${s.replace(/'/g, "''")}'`);
const usage = () => { console.error("Usage: legal-hold.ts place --scope global|organization|user [--subject id] --reason text [--matter ref] [--by userId] [--db path | --print-sql]\n       legal-hold.ts release --id hold_... --note text [--by userId] [--db path | --print-sql]\n       legal-hold.ts list [--db path]"); process.exit(2); };
const now = new Date().toISOString();
const by = get("--by") ?? null;

let sql = "";
if (cmd === "place") {
  const scope = get("--scope"), subject = get("--subject") ?? null, reason = (get("--reason") ?? "").trim();
  if (!scope || !["global", "organization", "user"].includes(scope) || reason.length < 5) usage();
  if ((scope === "global") !== (subject === null)) { console.error("global holds take no --subject; organization/user holds need one"); process.exit(2); }
  const id = newId("hold");
  sql = [
    `INSERT INTO legal_holds (id, scope, subject_id, reason, matter_reference, placed_by, placed_at) VALUES (${q(id)}, ${q(scope)}, ${q(subject)}, ${q(reason)}, ${q(get("--matter"))}, ${q(by)}, ${q(now)});`,
    `INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, organization_id, details_json, created_at) VALUES (${q(by)}, ${by ? "'user'" : "'system'"}, 'legal_hold.placed', 'legal_hold', ${q(id)}, ${scope === "organization" ? q(subject) : "NULL"}, ${q(JSON.stringify({ scope, subjectId: subject, via: "scripts/legal-hold.ts" }))}, ${q(now)});`,
  ].join("\n");
  console.error(`Hold id: ${id}`);
} else if (cmd === "release") {
  const id = get("--id"), note = (get("--note") ?? "").trim();
  if (!id || note.length < 5) usage();
  sql = [
    `UPDATE legal_holds SET released_at = ${q(now)}, released_by = ${q(by)}, release_note = ${q(note)} WHERE id = ${q(id!)} AND released_at IS NULL;`,
    `INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, created_at) SELECT ${q(by)}, ${by ? "'user'" : "'system'"}, 'legal_hold.released', 'legal_hold', ${q(id!)}, ${q(JSON.stringify({ via: "scripts/legal-hold.ts" }))}, ${q(now)} WHERE changes() = 1;`,
  ].join("\n");
} else if (cmd !== "list") usage();

if (args.includes("--print-sql")) {
  if (cmd === "list") { console.log("SELECT id, scope, subject_id, reason, matter_reference, placed_at, released_at FROM legal_holds ORDER BY placed_at DESC;"); process.exit(0); }
  console.log(sql);
} else {
  const { openDb } = await import("../dev/sqlite-d1.ts");
  const db = openDb(get("--db") ?? ".dev/crestmont.db");
  if (cmd === "list") {
    console.table(db.raw.prepare(`SELECT id, scope, subject_id, reason, matter_reference, placed_at, released_at FROM legal_holds ORDER BY placed_at DESC`).all());
  } else {
    db.raw.exec("BEGIN");
    db.raw.exec(sql);
    db.raw.exec("COMMIT");
    console.log(cmd === "place" ? "Legal hold placed." : "Legal hold released (if it was active).");
  }
}
