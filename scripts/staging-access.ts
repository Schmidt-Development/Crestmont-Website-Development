// Staging preview access: one source of truth for the preview password and the demo-account credentials.
//
// Why: the preview password used to be generated only when the Worker secret looked missing (or on request),
// so a later run could overwrite the secret while an earlier access artifact still held the old value, and a
// run that kept the secret could not say what it was. Demo credentials had the same drift (a reseed issued new
// passwords that INSERT OR IGNORE never applied). Now every run DERIVES all access credentials from
//   HMAC-SHA256(root key = the CLOUDFLARE_API_TOKEN secret, salt stored in staging D1)
// and re-applies them (Worker secret + demo users in D1), so the live site and the access artifact always
// agree. Rotation = a new random salt (on request, or when ACCESS_EPOCH changes), which also revokes every
// demo-account session and pending token. The salt alone is useless without the root key; the root key never
// leaves GitHub's secret store. Production is never touched (this only addresses the staging Worker and D1).
//
// CLI (used by .github/workflows/deploy-staging.yml):
//   node --no-warnings scripts/staging-access.ts --url <preview url> --out <dir>
//   env: ACCESS_ROOT_KEY (required), ACCESS_EPOCH, ROTATE=true|false, FIXED_PREVIEW_PASSWORD (optional),
//        WRANGLER (default "npx --yes wrangler@4")
// Writes <dir>/README.md (the private artifact), <dir>/demo-accounts.md and <dir>/private.json (for the
// verifier and the browser journey; not uploaded). Prints no credential except as ::add-mask:: commands.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, base32Encode } from "../src/lib/auth-crypto.ts";
import { putSecretIfChanged } from "./staging-secrets.ts";

export const DEMO_DOMAIN = "crestmont-preview.test";
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/l/I, no markdown-active characters

export interface D1Ops {
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  execFile(path: string): Promise<void>;
  putSecret(name: string, value: string): Promise<void>;
}

export interface DemoAccount { role: string; email: string; password: string; totp: string | null; note: string }
export interface AccessResult { rotated: boolean; previewPassword: string; previewSource: "derived" | "founder"; accounts: DemoAccount[]; fixedPreviewRetired?: boolean }

/** Keyed fingerprint of a preview password (stored to recognise retired values without storing them). */
export async function previewFingerprint(rootKey: string, password: string): Promise<string> {
  return [...await hmac(rootKey, `crestmont-staging-access:v1:preview-fp:${password}`)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const enc = new TextEncoder();
async function hmac(key: string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

/** Uniform characters from ALPHABET via rejection sampling over HMAC blocks; grouped in fives for reading aloud. */
export async function derivePassword(key: string, salt: string, label: string, chars = 20): Promise<string> {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = "";
  for (let block = 0; out.length < chars; block++) {
    for (const b of await hmac(key, `crestmont-staging-access:v1:${salt}:${label}:${block}`)) {
      if (b < limit && out.length < chars) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out.match(/.{1,5}/g)!.join("-");
}

export async function deriveTotp(key: string, salt: string, email: string): Promise<string> {
  return base32Encode((await hmac(key, `crestmont-staging-access:v1:${salt}:totp:${email}`)).slice(0, 20));
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ROLE_ORDER = ["owner", "administrator", "sales", "developer", "project_manager", "support"];
const NOTES: Record<string, string> = {
  owner: "All 32 Owner modules", administrator: "Staff (administrator)", sales: "Staff (sales)", developer: "Staff (developer)",
  project_manager: "Staff (project manager)", support: "Staff (support)",
};

export async function applyAccess(ops: D1Ops, o: { rootKey: string; epoch: string; rotate: boolean; fixedPreviewPassword?: string }): Promise<AccessResult> {
  if (!o.rootKey || o.rootKey.length < 16) throw new Error("ACCESS_ROOT_KEY is missing or too short");
  await ops.query(`CREATE TABLE IF NOT EXISTS _staging_access (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const meta = Object.fromEntries((await ops.query<{ key: string; value: string }>(`SELECT key, value FROM _staging_access`)).map((r) => [r.key, r.value]));
  const rotated = o.rotate || !meta.salt || meta.epoch !== o.epoch;
  const saltBytes = new Uint8Array(32);
  crypto.getRandomValues(saltBytes);
  const salt = rotated ? [...saltBytes].map((b) => b.toString(16).padStart(2, "0")).join("") : meta.salt;

  const users = await ops.query<{ id: string; email: string; mfa_enabled: number; roles: string | null }>(
    `SELECT u.id, u.email, u.mfa_enabled, (SELECT group_concat(m.role_id) FROM memberships m WHERE m.user_id = u.id) AS roles
       FROM users u WHERE u.email LIKE '%@${DEMO_DOMAIN}' AND u.password_hash IS NOT NULL ORDER BY u.email`);
  const accounts: DemoAccount[] = [];
  const sql: string[] = [];
  for (const u of users) {
    const role = (u.roles ?? "").split(",").sort((a, b) => (ROLE_ORDER.indexOf(a) + 1 || 99) - (ROLE_ORDER.indexOf(b) + 1 || 99))[0] || "customer_admin";
    const password = await derivePassword(o.rootKey, salt, `password:${u.email}`);
    const totp = u.mfa_enabled ? await deriveTotp(o.rootKey, salt, u.email) : null;
    accounts.push({ role, email: u.email, password, totp, note: NOTES[role] ?? "Customer portal (sample organization)" });
    sql.push(`UPDATE users SET password_hash = ${q(await hashPassword(password))}, totp_secret = ${totp ? q(totp) : "totp_secret"}, totp_last_step = NULL, failed_logins = 0, locked_until = NULL WHERE id = ${q(u.id)};`);
  }
  if (rotated) {
    // Previously issued credentials stop working everywhere: sessions and one-time tokens of demo users.
    sql.push(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}');`);
    sql.push(`DELETE FROM auth_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}');`);
    // Security remediation 2026-10-28 (F-18): anyone holding leaked demo credentials could have generated recovery
    // codes, started a new authenticator enrolment, or invited accounts of their own. None of that may survive.
    sql.push(`DELETE FROM mfa_recovery_codes WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}');`);
    sql.push(`UPDATE users SET totp_pending_secret = NULL WHERE email LIKE '%@${DEMO_DOMAIN}';`);
    sql.push(`UPDATE invitations SET expires_at = ${q(new Date().toISOString())} WHERE accepted_at IS NULL AND invited_by IN (SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}');`);
    sql.push(`INSERT OR REPLACE INTO _staging_access (key, value) VALUES ('salt', ${q(salt)}), ('epoch', ${q(o.epoch)}), ('rotated_at', ${q(new Date().toISOString())});`);
  }
  if (!accounts.some((a) => a.role === "owner")) throw new Error("No Owner demo account found in staging D1 (seed first)");
  await runSql(ops, sql);
  const sql2: string[] = [];
  // Rotation retires the preview password that was live before it (derived from the old salt, or the Founder's fixed
  // value). A retired value is never put back, so a Founder-held STAGING_PREVIEW_PASSWORD that was exposed is ignored
  // (with a warning) until the Founder sets a new one; the derived password is used meanwhile.
  const retired = new Set(Object.keys(meta).filter((k) => k.startsWith("retired_preview:")).map((k) => k.slice("retired_preview:".length)));
  if (rotated && meta.salt) { // only a rotation that replaces live credentials retires them (not the very first issue)
    const before = [o.fixedPreviewPassword, meta.salt ? await derivePassword(o.rootKey, meta.salt, "preview") : undefined].filter((v): v is string => !!v);
    for (const v of before) {
      const fp = await previewFingerprint(o.rootKey, v);
      retired.add(fp);
      sql2.push(`INSERT OR REPLACE INTO _staging_access (key, value) VALUES (${q(`retired_preview:${fp}`)}, ${q(new Date().toISOString())});`);
    }
  }
  const fixedRetired = !!o.fixedPreviewPassword && retired.has(await previewFingerprint(o.rootKey, o.fixedPreviewPassword));
  const founder = !!o.fixedPreviewPassword && !fixedRetired;
  const previewPassword = founder ? o.fixedPreviewPassword! : await derivePassword(o.rootKey, salt, "preview");
  if (retired.has(await previewFingerprint(o.rootKey, previewPassword))) throw new Error("Refusing to re-issue a retired preview password");
  if (sql2.length) await runSql(ops, sql2);
  // The live secret always equals what this run reports; it is re-put only when the value changed, because any secret
  // change blocks Worker rollbacks to earlier versions (Cloudflare error 10220).
  if (o.rootKey) await putSecretIfChanged(ops, o.rootKey, "STAGING_ACCESS_PASSWORD", previewPassword);
  else await ops.putSecret("STAGING_ACCESS_PASSWORD", previewPassword);
  accounts.sort((a, b) => (ROLE_ORDER.indexOf(a.role) + 1 || 99) - (ROLE_ORDER.indexOf(b.role) + 1 || 99) || a.email.localeCompare(b.email));
  return { rotated, previewPassword, previewSource: founder ? "founder" : "derived", accounts, fixedPreviewRetired: fixedRetired };
}

async function runSql(ops: D1Ops, sql: string[]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "staging-access-"));
  chmodSync(dir, 0o700);
  try {
    const file = join(dir, "apply.sql");
    writeFileSync(file, sql.join("\n") + "\n", { mode: 0o600 });
    await ops.execFile(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function accountsTable(accounts: DemoAccount[]): string {
  return ["| Role | Email | Password | 2FA setup key | Use |", "|---|---|---|---|---|",
    ...accounts.map((a) => `| ${a.role} | ${a.email} | \`${a.password}\` | ${a.totp ? `\`${a.totp}\`` : "—"} | ${a.note} |`)].join("\n");
}

export function accessReadme(url: string, r: AccessResult, verifiedAt: string | null): string {
  const owner = r.accounts.find((a) => a.role === "owner")!;
  return `# Crestmont staging preview — private access

Keep this file private. It is issued only through this GitHub Actions artifact.
${verifiedAt ? `Verified by the deploy run at ${verifiedAt}: preview password → Owner sign-in → 2FA → all 32 Owner modules.` : "NOT VERIFIED — do not rely on these values."}
${r.rotated ? "These credentials were rotated in this run; all earlier preview passwords, demo passwords, 2FA keys and demo sessions no longer work." : "Credentials unchanged since the last rotation."}

## 1. Staging website

${url}

## 2. Preview password

\`${r.previewPassword}\`${r.previewSource === "founder" ? "  (your STAGING_PREVIEW_PASSWORD repository secret)" : ""}

## 3. Owner sign-in

- Email: \`${owner.email}\`
- Password: \`${owner.password}\`
- 2FA authenticator setup key: \`${owner.totp}\`
  (in Google Authenticator, 1Password, Authy or similar: add account → "enter a setup key" → time-based, 6 digits, 30 seconds)

## Steps

1. Open the website and enter the preview password.
2. Sign in with the Owner email and password.
3. Enter the 6-digit code from your authenticator app.
4. The Owner command center opens with all 32 modules in the left navigation.

Passwords use dashes between groups of five characters; type the dashes. Each 2FA code works once.

## All demo accounts (sample data only)

${accountsTable(r.accounts)}

Rotate everything: Actions → Deploy staging → Run workflow → tick "rotate_credentials".
`;
}

// ── CLI ──
export function wranglerOps(): D1Ops {
  const [cmd, ...base] = (process.env.WRANGLER ?? "npx --yes wrangler@4").split(" ").filter(Boolean);
  const run = (args: string[], input?: string) =>
    execFileSync(cmd, [...base, ...args], { input, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const d1 = ["d1", "execute", "crestmont-staging", "--remote", "--env", "staging"];
  return {
    async query(sql) {
      const out = run([...d1, "--json", "--command", sql]);
      const parsed = JSON.parse(out.slice(out.indexOf("[")));
      return (parsed[0]?.results ?? []) as never;
    },
    async execFile(path) { run([...d1, "--file", path, "--yes"]); },
    async putSecret(name, value) { run(["secret", "put", name, "--env", "staging"], value); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const url = arg("--url"), out = arg("--out") ?? "access";
  if (!url) throw new Error("--url is required");
  try {
    const r = await applyAccess(wranglerOps(), {
      rootKey: process.env.ACCESS_ROOT_KEY ?? "", epoch: process.env.ACCESS_EPOCH ?? "1",
      rotate: process.env.ROTATE === "true", fixedPreviewPassword: process.env.FIXED_PREVIEW_PASSWORD || undefined,
    });
    for (const v of [r.previewPassword, ...r.accounts.flatMap((a) => [a.password, a.totp ?? ""])].filter(Boolean)) console.log(`::add-mask::${v}`);
    mkdirSync(out, { recursive: true });
    const owner = r.accounts.find((a) => a.role === "owner")!;
    writeFileSync(join(out, "private.json"), JSON.stringify({ url, previewPassword: r.previewPassword, owner: { email: owner.email, password: owner.password, totp: owner.totp }, rotated: r.rotated, previewSource: r.previewSource }), { mode: 0o600 });
    writeFileSync(join(out, "demo-accounts.md"), accountsTable(r.accounts) + "\n", { mode: 0o600 });
    writeFileSync(join(out, "access.json"), JSON.stringify(r), { mode: 0o600 });
    console.log(`Staging access applied: ${r.accounts.length} demo accounts, ${r.rotated ? "rotated" : "unchanged"}, preview password ${r.previewSource}.`);
    if (r.fixedPreviewRetired) console.log("::warning title=STAGING_PREVIEW_PASSWORD retired::The repository secret STAGING_PREVIEW_PASSWORD holds a preview password that was retired by a credential rotation (it may have been exposed). It is ignored; the derived preview password is in use. Set a NEW value for the secret, or delete it.");
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `rotated=${r.rotated}\n`);
  } catch (e) {
    // wrangler errors can echo arguments; print only the first line of our own message.
    console.error(`::error::Staging access could not be applied: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    process.exit(1);
  }
}
