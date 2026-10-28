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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, base32Encode } from "../src/lib/auth-crypto.ts";
import { putSecretIfChanged } from "./staging-secrets.ts";
import { sealWithKey, openWithKey, importMfaKey } from "../src/lib/totp-secrets.ts";

export const DEMO_DOMAIN = "crestmont-preview.test";
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/l/I, no markdown-active characters

export interface D1Ops {
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  execFile(path: string): Promise<void>;
  putSecret(name: string, value: string): Promise<void>;
}

export interface DemoAccount { role: string; email: string; password: string; totp: string | null; note: string }
/** What a rotation revoked beyond passwords and 2FA keys (counts only; for logs and evidence). */
export interface Revoked { sessions: number; authTokens: number; recoveryCodes: number; invitations: number }
export interface AccessResult { rotated: boolean; previewPassword: string; previewSource: "derived" | "founder"; accounts: DemoAccount[]; revoked?: Revoked; totpStorage: TotpStorage }
/** How demo 2FA secrets written by this run are stored: "encrypted" (deploy key proven to match the Worker's),
 *  "plaintext-unverified" (a deploy key was given but nothing encrypted exists yet to prove it matches), "plaintext" (no deploy key). */
export type TotpStorage = "encrypted" | "plaintext-unverified" | "plaintext";

const enc = new TextEncoder();
async function hmac(key: string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

/** Uniform characters from ALPHABET via rejection sampling over HMAC blocks; grouped in fives for reading aloud. */
async function derivePassword(key: string, salt: string, label: string, chars = 20): Promise<string> {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = "";
  for (let block = 0; out.length < chars; block++) {
    for (const b of await hmac(key, `crestmont-staging-access:v1:${salt}:${label}:${block}`)) {
      if (b < limit && out.length < chars) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out.match(/.{1,5}/g)!.join("-");
}

async function deriveTotp(key: string, salt: string, email: string): Promise<string> {
  return base32Encode((await hmac(key, `crestmont-staging-access:v1:${salt}:totp:${email}`)).slice(0, 20));
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ROLE_ORDER = ["owner", "administrator", "sales", "developer", "project_manager", "support"];
const NOTES: Record<string, string> = {
  owner: "All 32 Owner modules", administrator: "Staff (administrator)", sales: "Staff (sales)", developer: "Staff (developer)",
  project_manager: "Staff (project manager)", support: "Staff (support)",
};

/** Marker of the inputs a demo account's TOTP secret is derived from (root key, salt, email; see deriveTotp). It changes
 *  exactly when the derived secret would change, so a deploy can tell whether the stored secret (which may now be
 *  encrypted at rest) is still the one it would issue, without reading, decrypting or hashing the secret itself. */
async function totpDerivationMarker(rootKey: string, salt: string, userId: string, email: string): Promise<string> {
  return [...await hmac(rootKey, `crestmont-staging-access:v2:totp-inputs:${userId}:${email}:${salt}`)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Decides whether this run may write demo 2FA secrets encrypted with the deploy's copy of MFA_ENCRYPTION_KEY
 *  (GitHub secret STAGING_MFA_ENCRYPTION_KEY). Writing with a key that differs from the Worker's would make those
 *  accounts' 2FA unreadable, so the key is used only once it is PROVEN to be the Worker's: it must decrypt secrets
 *  the Worker itself already encrypted (AES-GCM authenticates, so a different key cannot succeed). Nothing is
 *  revealed: no value is printed or compared outside this process. A malformed key, or one that fails to open the
 *  stored ciphertext, stops the run before anything is written. */
export async function deployKeyStorage(ops: D1Ops, mfaKey: string | undefined): Promise<TotpStorage> {
  if (!mfaKey) return "plaintext";
  try { await importMfaKey(mfaKey); } catch { throw new Error("STAGING_MFA_ENCRYPTION_KEY is malformed (must be base64 of exactly 32 bytes); nothing was written"); }
  const rows = await ops.query<{ id: string; totp_secret: string }>(`SELECT id, totp_secret FROM users WHERE totp_secret LIKE 'v1:%' ORDER BY id LIMIT 3`);
  if (!rows.length) return "plaintext-unverified";
  for (const r of rows) {
    try { await openWithKey(mfaKey, r.id, r.totp_secret); } catch {
      throw new Error("STAGING_MFA_ENCRYPTION_KEY does not match the staging Worker's MFA_ENCRYPTION_KEY (it cannot open the two-factor secrets the Worker encrypted); nothing was written. Set it to the same value or remove it.");
    }
  }
  return "encrypted";
}

export async function applyAccess(ops: D1Ops, o: { rootKey: string; epoch: string; rotate: boolean; fixedPreviewPassword?: string; mfaKey?: string }): Promise<AccessResult> {
  if (!o.rootKey || o.rootKey.length < 16) throw new Error("ACCESS_ROOT_KEY is missing or too short");
  await ops.query(`CREATE TABLE IF NOT EXISTS _staging_access (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const meta = Object.fromEntries((await ops.query<{ key: string; value: string }>(`SELECT key, value FROM _staging_access`)).map((r) => [r.key, r.value]));
  const rotated = o.rotate || !meta.salt || meta.epoch !== o.epoch;
  const saltBytes = new Uint8Array(32);
  crypto.getRandomValues(saltBytes);
  const salt = rotated ? [...saltBytes].map((b) => b.toString(16).padStart(2, "0")).join("") : meta.salt;

  const totpStorage = await deployKeyStorage(ops, o.mfaKey);
  const sealKey = totpStorage === "encrypted" ? o.mfaKey : undefined;
  const users = await ops.query<{ id: string; email: string; mfa_enabled: number; has_totp: number; roles: string | null }>(
    `SELECT u.id, u.email, u.mfa_enabled, (u.totp_secret IS NOT NULL) AS has_totp, (SELECT group_concat(m.role_id) FROM memberships m WHERE m.user_id = u.id) AS roles
       FROM users u WHERE u.email LIKE '%@${DEMO_DOMAIN}' AND u.password_hash IS NOT NULL ORDER BY u.email`);
  const accounts: DemoAccount[] = [];
  const sql: string[] = [];
  for (const u of users) {
    const role = (u.roles ?? "").split(",").sort((a, b) => (ROLE_ORDER.indexOf(a) + 1 || 99) - (ROLE_ORDER.indexOf(b) + 1 || 99))[0] || "customer_admin";
    const password = await derivePassword(o.rootKey, salt, `password:${u.email}`);
    const totp = u.mfa_enabled ? await deriveTotp(o.rootKey, salt, u.email) : null;
    accounts.push({ role, email: u.email, password, totp, note: NOTES[role] ?? "Customer portal (sample organization)" });
    // The TOTP secret is written only when it changes (first issue or a rotation). Re-writing it on every deploy would
    // replace a secret that the Worker has since encrypted at rest (MFA_ENCRYPTION_KEY) with plaintext again.
    let totpSql = "totp_secret";
    if (totp) {
      const fp = await totpDerivationMarker(o.rootKey, salt, u.id, u.email);
      if (rotated || !u.has_totp || meta[`totp_fp:${u.id}`] !== fp) {
        // With the key available to the deploy, the secret is written already encrypted; otherwise in plaintext, and the
        // Worker encrypts it at that account's next successful sign-in.
        totpSql = q(sealKey ? await sealWithKey(sealKey, u.id, totp) : totp);
        sql.push(`INSERT OR REPLACE INTO _staging_access (key, value) VALUES (${q(`totp_fp:${u.id}`)}, ${q(fp)});`);
      }
    }
    sql.push(`UPDATE users SET password_hash = ${q(await hashPassword(password))}, totp_secret = ${totpSql}, totp_last_step = NULL, failed_logins = 0, locked_until = NULL WHERE id = ${q(u.id)};`);
  }
  let revoked: Revoked | undefined;
  if (rotated) {
    // Previously issued credentials stop working everywhere: sessions, one-time tokens and MFA recovery codes of demo
    // users, and invitations they issued that nobody has accepted yet (an invitation link is a credential too).
    // Accounts outside the demo domain are never touched. Counts are taken first so the rotation is auditable.
    const now = new Date().toISOString();
    const demo = `(SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}')`;
    const count = async (from: string) => Number((await ops.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${from}`))[0]?.n ?? 0);
    revoked = {
      sessions: await count(`sessions WHERE user_id IN ${demo}`),
      authTokens: await count(`auth_tokens WHERE user_id IN ${demo}`),
      recoveryCodes: await count(`mfa_recovery_codes WHERE user_id IN ${demo}`),
      invitations: await count(`invitations WHERE accepted_at IS NULL AND expires_at > ${q(now)} AND invited_by IN ${demo}`),
    };
    sql.push(`DELETE FROM sessions WHERE user_id IN ${demo};`);
    sql.push(`DELETE FROM auth_tokens WHERE user_id IN ${demo};`);
    sql.push(`DELETE FROM mfa_recovery_codes WHERE user_id IN ${demo};`);
    sql.push(`UPDATE invitations SET expires_at = ${q(now)} WHERE accepted_at IS NULL AND expires_at > ${q(now)} AND invited_by IN ${demo};`);
    sql.push(`INSERT OR REPLACE INTO _staging_access (key, value) VALUES ('salt', ${q(salt)}), ('epoch', ${q(o.epoch)}), ('rotated_at', ${q(now)});`);
    sql.push(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, organization_id, details_json, ip, created_at)
      VALUES (NULL, 'system', 'staging.access_rotated', 'staging_access', ${q(o.epoch)}, NULL, ${q(JSON.stringify({ epoch: o.epoch, demoAccounts: users.length, revoked }))}, NULL, ${q(now)});`);
  }
  if (!accounts.some((a) => a.role === "owner")) throw new Error("No Owner demo account found in staging D1 (seed first)");
  const dir = mkdtempSync(join(tmpdir(), "staging-access-"));
  chmodSync(dir, 0o700);
  try {
    const file = join(dir, "apply.sql");
    writeFileSync(file, sql.join("\n") + "\n", { mode: 0o600 });
    await ops.execFile(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const founder = !!o.fixedPreviewPassword;
  const previewPassword = founder ? o.fixedPreviewPassword! : await derivePassword(o.rootKey, salt, "preview");
  // The live secret always equals what this run reports; it is re-put only when the value changed, because any secret
  // change blocks Worker rollbacks to earlier versions (Cloudflare error 10220).
  if (o.rootKey) await putSecretIfChanged(ops, o.rootKey, "STAGING_ACCESS_PASSWORD", previewPassword);
  else await ops.putSecret("STAGING_ACCESS_PASSWORD", previewPassword);
  accounts.sort((a, b) => (ROLE_ORDER.indexOf(a.role) + 1 || 99) - (ROLE_ORDER.indexOf(b.role) + 1 || 99) || a.email.localeCompare(b.email));
  return { rotated, previewPassword, previewSource: founder ? "founder" : "derived", accounts, revoked, totpStorage };
}

/** Whether the next applyAccess() call will rotate (read-only). */
export async function rotationPending(ops: D1Ops, o: { epoch: string; rotate: boolean }): Promise<boolean> {
  if (o.rotate) return true;
  const rows = await ops.query<{ key: string; value: string }>(`SELECT key, value FROM _staging_access WHERE key IN ('salt', 'epoch')`).catch(() => []);
  const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return !meta.salt || meta.epoch !== o.epoch;
}

/**
 * READ-ONLY: the credentials that are live right now (before a rotation), derived exactly as applyAccess() derived
 * them. Used only by scripts/staging-rotation-check.ts to prove that these stop working after the rotation; the values
 * never leave the runner. The preview password may be Founder-fixed, so both candidates are returned for the caller
 * to test against the live gate.
 */
export async function currentAccess(ops: D1Ops, rootKey: string, fixedPreviewPassword?: string): Promise<{ previewCandidates: string[]; owner: { email: string; password: string; totp: string } } | null> {
  const rows = await ops.query<{ key: string; value: string }>(`SELECT key, value FROM _staging_access WHERE key = 'salt'`).catch(() => []);
  const salt = rows[0]?.value;
  if (!salt) return null;
  const owner = (await ops.query<{ email: string; mfa_enabled: number }>(
    `SELECT u.email, u.mfa_enabled FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE m.role_id = 'owner' AND u.email LIKE '%@${DEMO_DOMAIN}' AND u.password_hash IS NOT NULL ORDER BY u.email LIMIT 1`))[0];
  if (!owner?.mfa_enabled) return null;
  const derived = await derivePassword(rootKey, salt, "preview");
  return {
    previewCandidates: [...new Set([fixedPreviewPassword, derived].filter((v): v is string => !!v))],
    owner: { email: owner.email, password: await derivePassword(rootKey, salt, `password:${owner.email}`), totp: await deriveTotp(rootKey, salt, owner.email) },
  };
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
${r.rotated ? "These credentials were rotated in this run; all earlier preview passwords, demo passwords, 2FA keys, recovery codes, demo sessions and pending demo invitations no longer work." : "Credentials unchanged since the last rotation."}

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

After a rotation the Owner has no recovery codes. Once signed in, open Account → Recovery codes, enter a current
2FA code and save the new codes in your password manager (they are shown once).

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
      mfaKey: process.env.MFA_ENCRYPTION_KEY || undefined, // optional: the SAME value as the staging Worker secret
    });
    for (const v of [r.previewPassword, ...r.accounts.flatMap((a) => [a.password, a.totp ?? ""])].filter(Boolean)) console.log(`::add-mask::${v}`);
    mkdirSync(out, { recursive: true });
    const owner = r.accounts.find((a) => a.role === "owner")!;
    writeFileSync(join(out, "private.json"), JSON.stringify({ url, previewPassword: r.previewPassword, owner: { email: owner.email, password: owner.password, totp: owner.totp }, rotated: r.rotated, previewSource: r.previewSource }), { mode: 0o600 });
    writeFileSync(join(out, "demo-accounts.md"), accountsTable(r.accounts) + "\n", { mode: 0o600 });
    writeFileSync(join(out, "access.json"), JSON.stringify(r), { mode: 0o600 });
    console.log(`Staging access applied: ${r.accounts.length} demo accounts, ${r.rotated ? "rotated" : "unchanged"}, preview password ${r.previewSource}.`);
    console.log(r.totpStorage === "encrypted" ? "Demo 2FA secrets written by this run: encrypted (STAGING_MFA_ENCRYPTION_KEY proven to match the Worker key)."
      : r.totpStorage === "plaintext-unverified" ? "Demo 2FA secrets written by this run: plaintext — STAGING_MFA_ENCRYPTION_KEY is set but no encrypted secret exists yet to prove it matches the Worker key; the Worker encrypts each at its next sign-in."
      : "Demo 2FA secrets written by this run: plaintext (no STAGING_MFA_ENCRYPTION_KEY); the Worker encrypts each at its next sign-in.");
    if (r.revoked) console.log(`Revoked with the rotation: ${r.revoked.sessions} demo sessions, ${r.revoked.authTokens} one-time tokens, ${r.revoked.recoveryCodes} recovery codes, ${r.revoked.invitations} pending invitations issued by demo accounts.`);
  } catch (e) {
    // wrangler errors can echo arguments; print only the first line of our own message.
    console.error(`::error::Staging access could not be applied: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    process.exit(1);
  }
}
