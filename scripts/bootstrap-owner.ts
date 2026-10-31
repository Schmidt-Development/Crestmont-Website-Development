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
// ── STAGING ONLY: the Founder's own Owner account next to the demo Owner (--staging-additional-owner) ──
//   node --no-warnings scripts/bootstrap-owner.ts --staging-additional-owner --email <founder work address> \
//        --url <staging APP_URL from wrangler.toml> --out-sql <file> --out-link <file>
// Both output files must lie OUTSIDE this repository checkout and must not exist yet. Nothing secret is printed:
// the console shows only the invitation id and the two paths. Refused in CI (CI / GITHUB_ACTIONS / TF_BUILD set).
//   --out-sql   UTF-8 SQL for `wrangler d1 execute crestmont-staging --remote --env staging --file <file>`. Holds only
//               the token's SHA-256 hash; the invitation id is random and independent of the token.
//   --out-link  the invitation link (72 h, single use). It is the credential: open it, then delete the file.
// Staging always has the demo Owner (owner@crestmont-preview.test, re-derived on every deploy), so the normal bootstrap
// does nothing there. This mode issues one Owner invitation even though the demo Owner exists and changes nothing else
// (demo accounts, passwords, 2FA keys, sessions untouched). Every statement carries the same eligibility guard:
//   - staging D1 only: the guard reads _staging_access, which only the staging deploy creates (scripts/staging-access.ts);
//     any other database fails with "no such table" and changes nothing;
//   - no Owner outside the demo domain exists yet (the Founder's Owner account is created once);
//   - the address is not already staff and is not a verified customer account (CREST-GAP-001).
// Ordering makes the file all-or-nothing even if statements run one by one: the earlier pending Owner invitations are
// expired only if THIS file's invitation row exists, so an ineligible run changes no row at all. Re-applying the same
// file is a no-op.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomToken, hashToken } from "../src/lib/auth-crypto.ts";

const DEMO_DOMAIN = "crestmont-preview.test";
const args = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = get("--email")?.trim().toLowerCase();
const USAGE = "Usage: --email <founder email> [--db path | --print-sql --url https://<deployed host>] [--url base]\n" +
  "       --staging-additional-owner --email <address> --url <staging APP_URL> --out-sql <file> --out-link <file>";
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { console.error(USAGE); process.exit(2); }
const urlArg = get("--url");
if (args.includes("--print-sql") && (!urlArg || !/^https?:\/\/[^\s/]+/.test(urlArg))) {
  console.error(`--print-sql needs --url: the base URL of the environment whose database will run this SQL (e.g. https://crestmontwebsitedevelopment.com), so the invitation link is correct.\n${USAGE}`);
  process.exit(2);
}
const baseUrl = (urlArg ?? "http://localhost:8787").replace(/\/+$/, "");
const stagingAdditional = args.includes("--staging-additional-owner");
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

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

/** True when `p` resolves inside this repository checkout (where it could be committed or picked up by tooling). */
export function insideRepo(p: string, root = REPO_ROOT): boolean {
  const norm = (x: string) => process.platform === "win32" ? x.toLowerCase() : x;
  const rel = relative(norm(resolve(root)), norm(resolve(p)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function refuse(msg: string): never { console.error(`${msg} Nothing was written.`); process.exit(2); }

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const token = randomToken();
const tokenHash = await hashToken(token);
const now = new Date().toISOString();
const expires = new Date(Date.now() + 72 * 3600e3).toISOString();

if (stagingAdditional) {
  if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.TF_BUILD) refuse("--staging-additional-owner runs only on the Founder's own computer, never in CI (its output is a credential).");
  if (args.includes("--print-sql") || args.includes("--db")) refuse("--staging-additional-owner writes to --out-sql and --out-link only; drop --print-sql / --db.");
  const staging = stagingAppUrl();
  if (!staging || baseUrl !== staging) refuse(`--staging-additional-owner needs --url to be the staging APP_URL from wrangler.toml (${staging ?? "not found"}).`);
  if (email.endsWith(`@${DEMO_DOMAIN}`)) refuse(`The demo domain (${DEMO_DOMAIN}) is managed by the staging deploy; use the Founder's own address.`);
  const outSql = get("--out-sql"), outLink = get("--out-link");
  if (!outSql || !outLink || outSql.startsWith("--") || outLink.startsWith("--")) refuse(`--out-sql <file> and --out-link <file> are required.\n${USAGE}`);
  if (resolve(outSql) === resolve(outLink)) refuse("--out-sql and --out-link must be different files.");
  for (const p of [outSql, outLink]) if (insideRepo(p)) refuse(`${p} is inside the repository checkout (${REPO_ROOT}); write it outside, e.g. a private folder in your user profile.`);

  const invId = `inv_owner_staging_${randomToken().slice(0, 16)}`; // independent of the invitation token
  const eligible = [
    `EXISTS (SELECT 1 FROM _staging_access WHERE key = 'salt')`,
    `NOT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id = 'owner' AND u.email NOT LIKE '%@${DEMO_DOMAIN}')`,
    `NOT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ${q(email)} AND m.organization_id = 'org_crestmont')`,
    `NOT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id WHERE u.email = ${q(email)} AND u.email_verified_at IS NOT NULL AND o.kind != 'internal')`,
  ].join("\n     AND ");
  const sql = [
    `INSERT OR IGNORE INTO organizations (id, name, kind, created_at)
   SELECT 'org_crestmont', 'Crestmont Website Development', 'internal', ${q(now)}
   WHERE ${eligible};`,
    `INSERT OR IGNORE INTO users (id, email, display_name, password_hash, disabled_at, created_at)
   SELECT 'usr_system', 'system@crestmont.invalid', 'Crestmont system', NULL, ${q(now)}, ${q(now)}
   WHERE ${eligible};`,
    `INSERT OR IGNORE INTO invitations (id, email, organization_id, role_id, token_hash, invited_by, expires_at)
   SELECT ${q(invId)}, ${q(email)}, 'org_crestmont', 'owner', ${q(tokenHash)}, 'usr_system', ${q(expires)}
   WHERE ${eligible};`,
    // Only after (and only if) this file's invitation exists: earlier pending Owner invitations stop working.
    `UPDATE invitations SET expires_at = ${q(now)}
   WHERE role_id = 'owner' AND accepted_at IS NULL AND expires_at > ${q(now)} AND id <> ${q(invId)}
     AND EXISTS (SELECT 1 FROM _staging_access WHERE key = 'salt')
     AND EXISTS (SELECT 1 FROM invitations WHERE id = ${q(invId)} AND token_hash = ${q(tokenHash)} AND accepted_at IS NULL);`,
  ].join("\n") + "\n";
  try {
    // "wx": never overwrite; 0600 where the OS honours it. UTF-8 without BOM (PowerShell's ">" would write UTF-16).
    writeFileSync(outSql, sql, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { writeFileSync(outLink, `${baseUrl}/invite?token=${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
    catch (e) { (await import("node:fs")).rmSync(outSql, { force: true }); throw e; }
  } catch (e) {
    refuse(`Could not create the output files (${(e as NodeJS.ErrnoException).code ?? "error"}; they must not exist yet).`);
  }
  console.log(`Staging Owner invitation prepared for ${email} (valid 72h once applied).`);
  console.log(`Invitation id: ${invId}`);
  console.log(`SQL (token hash only): ${resolve(outSql)}`);
  console.log(`Link (the credential; open it, then delete the file): ${resolve(outLink)}`);
  process.exit(0);
}

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
