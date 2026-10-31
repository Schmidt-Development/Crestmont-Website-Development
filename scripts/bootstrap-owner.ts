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
//
// STAGING ONLY — the Founder's own Owner account next to the demo Owner (--staging-additional-owner):
//   node --no-warnings scripts/bootstrap-owner.ts --staging-additional-owner --print-sql \
//        --email <founder work address> --url <staging APP_URL from wrangler.toml> > founder-owner.sql
//   npx wrangler d1 execute crestmont-staging --remote --env staging --file founder-owner.sql
// Staging always has the demo Owner (owner@crestmont-preview.test, re-derived on every deploy), so the normal bootstrap
// does nothing there. This mode issues an Owner invitation even though the demo Owner exists, and changes nothing else:
// the demo accounts, their passwords, 2FA keys and sessions are not touched. The SQL only takes effect when ALL hold:
//   - the database is staging D1: every statement reads the _staging_access table, which only the staging deploy
//     creates (scripts/staging-access.ts). Production and local databases fail with "no such table" and change nothing;
//   - no Owner outside the demo domain exists yet (the Founder's Owner account is created once);
//   - the address is not already staff and is not a verified customer account (CREST-GAP-001: staff use a separate
//     address; a customer account is never promoted);
// and --url must be the staging APP_URL. The demo domain itself is refused.
import { readFileSync } from "node:fs";
import { randomToken, hashToken } from "../src/lib/auth-crypto.ts";

const DEMO_DOMAIN = "crestmont-preview.test";
const args = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = get("--email")?.trim().toLowerCase();
const USAGE = "Usage: --email <founder email> [--db path | --print-sql --url https://<deployed host>] [--url base] [--staging-additional-owner]";
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { console.error(USAGE); process.exit(2); }
const urlArg = get("--url");
if (args.includes("--print-sql") && (!urlArg || !/^https?:\/\/[^\s/]+/.test(urlArg))) {
  console.error(`--print-sql needs --url: the base URL of the environment whose database will run this SQL (e.g. https://crestmontwebsitedevelopment.com), so the invitation link is correct.\n${USAGE}`);
  process.exit(2);
}
const baseUrl = (urlArg ?? "http://localhost:8787").replace(/\/+$/, "");
const stagingAdditional = args.includes("--staging-additional-owner");

/** The staging Worker's APP_URL, read from wrangler.toml ([env.staging] vars). */
function stagingAppUrl(): string | null {
  try {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const s = toml.indexOf("\n[env.staging]");
    if (s < 0) return null;
    const e = toml.indexOf("\n[env.", s + 1);
    return /APP_URL\s*=\s*"([^"]+)"/.exec(toml.slice(s, e > 0 ? e : undefined))?.[1]?.replace(/\/+$/, "") ?? null;
  } catch { return null; }
}

if (stagingAdditional) {
  if (!args.includes("--print-sql")) { console.error(`--staging-additional-owner only prints SQL for staging D1: add --print-sql and --url.\n${USAGE}`); process.exit(2); }
  const staging = stagingAppUrl();
  if (!staging || baseUrl !== staging) { console.error(`--staging-additional-owner needs --url to be the staging APP_URL from wrangler.toml (${staging ?? "not found"}). Nothing was printed.`); process.exit(2); }
  if (email.endsWith(`@${DEMO_DOMAIN}`)) { console.error(`The demo domain (${DEMO_DOMAIN}) is managed by the staging deploy; use the Founder's own address. Nothing was printed.`); process.exit(2); }
}

const token = randomToken();
const tokenHash = await hashToken(token);
const now = new Date().toISOString();
const expires = new Date(Date.now() + 72 * 3600e3).toISOString();
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

let sql: string;
if (stagingAdditional) {
  // Reading _staging_access makes every statement fail closed outside staging D1 (the table exists only there).
  const onStaging = `EXISTS (SELECT 1 FROM _staging_access WHERE key = 'salt')`;
  sql = [
    `INSERT OR IGNORE INTO organizations (id, name, kind, created_at) SELECT 'org_crestmont', 'Crestmont Website Development', 'internal', ${q(now)} WHERE ${onStaging};`,
    `INSERT OR IGNORE INTO users (id, email, display_name, password_hash, disabled_at, created_at) SELECT 'usr_system', 'system@crestmont.invalid', 'Crestmont system', NULL, ${q(now)}, ${q(now)} WHERE ${onStaging};`,
    // Re-issuing revokes an earlier, still-pending Owner invitation (a lost or leaked link stops working).
    `UPDATE invitations SET expires_at = ${q(now)} WHERE role_id = 'owner' AND accepted_at IS NULL AND expires_at > ${q(now)} AND ${onStaging};`,
    `INSERT INTO invitations (id, email, organization_id, role_id, token_hash, invited_by, expires_at)
   SELECT 'inv_owner_staging_${token.slice(0, 8)}', ${q(email)}, 'org_crestmont', 'owner', ${q(tokenHash)}, 'usr_system', ${q(expires)}
   WHERE ${onStaging}
     AND NOT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id = 'owner' AND u.email NOT LIKE '%@${DEMO_DOMAIN}')
     AND NOT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ${q(email)} AND m.organization_id = 'org_crestmont')
     AND NOT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id
                      WHERE u.email = ${q(email)} AND u.email_verified_at IS NOT NULL AND o.kind != 'internal');`,
  ].join("\n");
} else {
  sql = [
    `INSERT OR IGNORE INTO organizations (id, name, kind, created_at) VALUES ('org_crestmont', 'Crestmont Website Development', 'internal', ${q(now)});`,
    // Inviter of record: a disabled system identity with no password (it can never sign in).
    `INSERT OR IGNORE INTO users (id, email, display_name, password_hash, disabled_at, created_at) VALUES ('usr_system', 'system@crestmont.invalid', 'Crestmont system', NULL, ${q(now)}, ${q(now)});`,
    // Re-issuing revokes any earlier, still-pending Owner invitation.
    `UPDATE invitations SET expires_at = ${q(now)} WHERE role_id = 'owner' AND accepted_at IS NULL AND expires_at > ${q(now)};`,
    `INSERT INTO invitations (id, email, organization_id, role_id, token_hash, invited_by, expires_at)
   SELECT 'inv_owner_bootstrap_${token.slice(0, 8)}', ${q(email)}, 'org_crestmont', 'owner', ${q(tokenHash)}, 'usr_system', ${q(expires)}
   WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE role_id = 'owner');`,
  ].join("\n");
}

if (args.includes("--print-sql")) {
  console.log(sql);
  console.error(`\nOwner invitation (valid 72h, shown once): ${baseUrl}/invite?token=${token}`);
  if (stagingAdditional) console.error(`Check it was created: SELECT id, email, expires_at FROM invitations WHERE id = 'inv_owner_staging_${token.slice(0, 8)}';  (no row = a guard refused it; nothing changed)`);
} else {
  const { openDb } = await import("../dev/sqlite-d1.ts");
  const db = openDb(get("--db") ?? ".dev/crestmont.db");
  const owner = db.raw.prepare(`SELECT COUNT(*) n FROM memberships WHERE role_id = 'owner'`).get() as { n: number };
  if (owner.n > 0) { console.error("An Owner already exists. Refusing to create another Owner invitation."); process.exit(1); }
  db.raw.exec(sql);
  console.log(`Owner invitation created for ${email} (valid 72h, shown once):\n${baseUrl}/invite?token=${token}`);
}
