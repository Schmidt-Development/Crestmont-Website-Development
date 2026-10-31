// Creates the one-time Owner invitation. There are no default accounts or passwords anywhere in
// the platform: the Founder accepts this invitation, chooses a password and enrols MFA.
//
//   Local DB:   node --no-warnings scripts/bootstrap-owner.ts --email founder@example.com --db .dev/crestmont.db
//   D1 (remote): node --no-warnings scripts/bootstrap-owner.ts --email founder@example.com --print-sql --url https://<host> > owner.sql
//                wrangler d1 execute crestmont-staging --remote --file owner.sql
//
// --print-sql REQUIRES --url (CREST-GAP-067): the SQL is for a deployed database, and a defaulted localhost link would
// hand the Founder a dead invitation for production. Without it the script exits 2 and prints nothing.
// Refuses to run if an Owner already exists (local mode). Prints the invitation URL once; only its
// SHA-256 hash is stored.
import { randomToken, hashToken } from "../src/lib/auth-crypto.ts";

const args = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = get("--email")?.trim().toLowerCase();
const USAGE = "Usage: --email <founder email> [--db path | --print-sql --url https://<deployed host>] [--url base]";
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { console.error(USAGE); process.exit(2); }
const urlArg = get("--url");
if (args.includes("--print-sql") && (!urlArg || !/^https?:\/\/[^\s/]+/.test(urlArg))) {
  console.error(`--print-sql needs --url: the base URL of the environment whose database will run this SQL (e.g. https://crestmontwebsitedevelopment.com), so the invitation link is correct.\n${USAGE}`);
  process.exit(2);
}
const baseUrl = (urlArg ?? "http://localhost:8787").replace(/\/+$/, "");

const token = randomToken();
const tokenHash = await hashToken(token);
const now = new Date().toISOString();
const expires = new Date(Date.now() + 72 * 3600e3).toISOString();
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const sql = [
  `INSERT OR IGNORE INTO organizations (id, name, kind, created_at) VALUES ('org_crestmont', 'Crestmont Website Development', 'internal', ${q(now)});`,
  // Inviter of record: a disabled system identity with no password (it can never sign in).
  `INSERT OR IGNORE INTO users (id, email, display_name, password_hash, disabled_at, created_at) VALUES ('usr_system', 'system@crestmont.invalid', 'Crestmont system', NULL, ${q(now)}, ${q(now)});`,
  // Re-issuing revokes any earlier, still-pending Owner invitation.
  `UPDATE invitations SET expires_at = ${q(now)} WHERE role_id = 'owner' AND accepted_at IS NULL AND expires_at > ${q(now)};`,
  `INSERT INTO invitations (id, email, organization_id, role_id, token_hash, invited_by, expires_at)
   SELECT 'inv_owner_bootstrap_${token.slice(0, 8)}', ${q(email)}, 'org_crestmont', 'owner', ${q(tokenHash)}, 'usr_system', ${q(expires)}
   WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE role_id = 'owner');`,
].join("\n");

if (args.includes("--print-sql")) {
  console.log(sql);
  console.error(`\nOwner invitation (valid 72h, shown once): ${baseUrl}/invite?token=${token}`);
} else {
  const { openDb } = await import("../dev/sqlite-d1.ts");
  const db = openDb(get("--db") ?? ".dev/crestmont.db");
  const owner = db.raw.prepare(`SELECT COUNT(*) n FROM memberships WHERE role_id = 'owner'`).get() as { n: number };
  if (owner.n > 0) { console.error("An Owner already exists. Refusing to create another Owner invitation."); process.exit(1); }
  db.raw.exec(sql);
  console.log(`Owner invitation created for ${email} (valid 72h, shown once):\n${baseUrl}/invite?token=${token}`);
}
