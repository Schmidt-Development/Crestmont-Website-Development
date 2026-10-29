// Re-encrypts TOTP secrets that are still stored in plaintext (docs/AUTH-PRODUCTION.md gap 3). Operator-run, after
// MFA_ENCRYPTION_KEY has been set on the Worker and the code that understands "v1:" values has been deployed
// (rollout order: docs/DEPLOYMENT.md §4 and docs/RUNBOOK.md §4). Safe to run repeatedly: rows already in "v1:" form
// are only checked (they must decrypt with the given key, otherwise the run aborts before writing anything).
//
//   Local DB:     MFA_ENCRYPTION_KEY=… node --no-warnings scripts/encrypt-totp-secrets.ts --db .dev/crestmont.db [--yes]
//   Remote D1:    MFA_ENCRYPTION_KEY=… node --no-warnings scripts/encrypt-totp-secrets.ts --remote --database crestmont-staging --env staging [--yes]
//
// The key is read from the MFA_ENCRYPTION_KEY environment variable (the same value as the Worker secret) and is
// never printed. Without --yes the run is a dry run that only reports counts. Output never contains a secret,
// a ciphertext or the key: only counts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importMfaKey, isEncryptedTotpSecret, openWithKey, sealWithKey } from "../src/lib/totp-secrets.ts";

export interface TotpRow { id: string; totp_secret: string | null; totp_pending_secret: string | null }
export interface Plan { sql: string[]; plaintext: number; alreadyEncrypted: number }

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const SELECT_ROWS = `SELECT id, totp_secret, totp_pending_secret FROM users WHERE totp_secret IS NOT NULL OR totp_pending_secret IS NOT NULL`;

/** Builds the UPDATE statements. Throws (writing nothing) if any existing ciphertext does not open with `rawKey`. */
export async function planReencryption(rows: TotpRow[], rawKey: string): Promise<Plan> {
  await importMfaKey(rawKey); // validates length/format without echoing the value
  const sql: string[] = [];
  let plaintext = 0, alreadyEncrypted = 0, mismatched = 0;
  for (const r of rows) {
    for (const col of ["totp_secret", "totp_pending_secret"] as const) {
      const v = r[col];
      if (!v) continue;
      if (isEncryptedTotpSecret(v)) {
        alreadyEncrypted++;
        try { await openWithKey(rawKey, r.id, v); } catch { mismatched++; }
        continue;
      }
      plaintext++;
      // Guarded so a row that was re-encrypted by a sign-in meanwhile is left alone.
      sql.push(`UPDATE users SET ${col} = ${q(await sealWithKey(rawKey, r.id, v))} WHERE id = ${q(r.id)} AND ${col} IS NOT NULL AND ${col} NOT LIKE 'v1:%';`);
    }
  }
  if (mismatched) throw new Error(`${mismatched} stored secret(s) do not decrypt with this MFA_ENCRYPTION_KEY: wrong key for this environment. Nothing was written.`);
  return { sql, plaintext, alreadyEncrypted };
}

interface Ops {
  rows(): Promise<TotpRow[]>; apply(sql: string[]): Promise<void>; deploymentEnvironments?(): Promise<string[]>;
  /** Records a recovery point immediately before writing and returns how to restore it (D1 Time Travel bookmark, or a
   *  file copy for a local database). Required for --yes: without a recovery point nothing is written. */
  recoveryPoint?(): Promise<string>;
  /** Remote targets: --yes needs at least one secret the Worker itself already encrypted, which proves the given key IS
   *  the Worker's (AES-GCM is authenticated). Without that proof a mistyped key would encrypt every row unreadably. */
  requireKeyProof?: boolean;
}

// ── Database identity safeguards (remote D1) ──
/** The D1 database_name wrangler.toml binds for `[env.<env>]`. */
export function declaredDatabase(toml: string, env: string): string | null {
  const start = toml.indexOf(`[env.${env}]`);
  if (start < 0) return null;
  const rest = toml.slice(start + 1);
  const end = rest.search(/^\[(?!\[)(?!env\.\w+\.)/m);
  const section = end < 0 ? rest : rest.slice(0, end);
  return /database_name\s*=\s*"([^"]+)"/.exec(section)?.[1] ?? null;
}

export const PRODUCTION_CONFIRM_ENV = "CRESTMONT_CONFIRM_PRODUCTION_MFA_MIGRATION";

/** Refuses unless the target is unambiguously the intended environment's database:
 *  1. --database equals the database wrangler.toml binds for --env;
 *  2. the database's own deployment records name exactly that environment (a staging D1 records staging deploys);
 *  3. production additionally needs --confirm-production <database> AND CRESTMONT_CONFIRM_PRODUCTION_MFA_MIGRATION=<database>. */
export async function assertTargetIdentity(o: { env: string; database: string; toml: string; confirmProduction?: string; confirmEnv?: string; recordedEnvironments: () => Promise<string[]> }): Promise<void> {
  if (o.env !== "staging" && o.env !== "production") throw new Error(`--env must be staging or production`);
  const declared = declaredDatabase(o.toml, o.env);
  if (!declared) throw new Error(`wrangler.toml declares no D1 database for [env.${o.env}]`);
  if (o.database !== declared) throw new Error(`--database ${o.database} is not the ${o.env} database (wrangler.toml binds ${declared} for [env.${o.env}])`);
  if (o.env === "production" && (o.confirmProduction !== declared || o.confirmEnv !== declared)) {
    throw new Error(`production needs --confirm-production ${declared} and ${PRODUCTION_CONFIRM_ENV}=${declared} (both exactly)`);
  }
  const envs = [...new Set(await o.recordedEnvironments())];
  if (envs.length === 0) throw new Error(`${o.database} has no recorded deployments, so its identity cannot be confirmed`);
  if (envs.length !== 1 || envs[0] !== o.env) throw new Error(`${o.database} records deployments for ${envs.join(", ")}, not only ${o.env}`);
}

export async function run(ops: Ops, rawKey: string, write: boolean, log: (s: string) => void): Promise<Plan> {
  if (!rawKey) throw new Error("Set MFA_ENCRYPTION_KEY in the environment (the same value as the Worker secret).");
  const plan = await planReencryption(await ops.rows(), rawKey);
  log(`TOTP secrets: ${plan.plaintext} stored in plaintext, ${plan.alreadyEncrypted} already encrypted (all decrypt with this key).`);
  if (!plan.sql.length) { log("Nothing to do."); return plan; }
  const unproven = ops.requireKeyProof && plan.alreadyEncrypted === 0;
  if (!write) {
    if (unproven) log("Note: no secret encrypted by the Worker exists yet, so this key cannot be proven to be the Worker's; --yes will refuse until one does (sign in once with any two-factor account on this environment).");
    log(`Dry run: re-run with --yes to encrypt ${plan.plaintext} value(s).`);
    return plan;
  }
  if (unproven) throw new Error("no secret encrypted by the Worker exists yet to prove this is the Worker's MFA_ENCRYPTION_KEY; sign in once with any two-factor account on this environment (the Worker encrypts its secret), then re-run. Nothing was written");
  if (!ops.recoveryPoint) throw new Error("no recovery point can be recorded for this target; nothing was written");
  let restore: string;
  try { restore = await ops.recoveryPoint(); } catch (e) { throw new Error(`could not record a recovery point (${String((e as Error).message ?? e).split("\n")[0].slice(0, 160)}); nothing was written`); }
  log(`Recovery point recorded. To undo this run: ${restore}`);
  await ops.apply(plan.sql);
  log(`Encrypted ${plan.plaintext} value(s).`);
  return plan;
}

function localOps(path: string): Ops {
  return {
    async rows() {
      const { openDb } = await import("../dev/sqlite-d1.ts");
      return openDb(path).raw.prepare(SELECT_ROWS).all() as unknown as TotpRow[];
    },
    async recoveryPoint() {
      const { copyFileSync } = await import("node:fs");
      const copy = `${path}.pre-totp-encrypt-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
      copyFileSync(path, copy);
      return `replace ${path} with ${copy}`;
    },
    async apply(sql) {
      const { openDb } = await import("../dev/sqlite-d1.ts");
      const raw = openDb(path).raw;
      raw.exec("BEGIN");
      try { raw.exec(sql.join("\n")); raw.exec("COMMIT"); } catch (e) { raw.exec("ROLLBACK"); throw e; }
    },
  };
}

function remoteOps(database: string, env: string): Ops & { deploymentEnvironments(): Promise<string[]> } {
  const [cmd, ...base] = (process.env.WRANGLER ?? "npx --yes wrangler@4.149.0").split(" ").filter(Boolean);
  const d1 = ["d1", "execute", database, "--remote", "--env", env];
  const exec = (args: string[]) => execFileSync(cmd, [...base, ...d1, ...args], { stdio: ["pipe", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    requireKeyProof: true,
    async recoveryPoint() {
      // D1 Time Travel: a point-in-time bookmark of the database as it is now (no data is copied anywhere).
      const out = execFileSync(cmd, [...base, "d1", "time-travel", "info", database, "--env", env, "--json"], { stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" });
      const bookmark = (JSON.parse(out.slice(out.indexOf("{"))) as { bookmark?: string }).bookmark;
      if (!bookmark || !/^[0-9a-f-]{8,}$/i.test(bookmark)) throw new Error("D1 Time Travel returned no bookmark");
      return `npx wrangler@4.149.0 d1 time-travel restore ${database} --env ${env} --bookmark ${bookmark}`;
    },
    async deploymentEnvironments() {
      const out = exec(["--json", "--command", "SELECT DISTINCT environment FROM deployments WHERE status = 'succeeded'"]);
      return ((JSON.parse(out.slice(out.indexOf("[")))[0]?.results ?? []) as { environment: string }[]).map((r) => r.environment);
    },
    async rows() {
      const out = exec(["--json", "--command", SELECT_ROWS]);
      return (JSON.parse(out.slice(out.indexOf("[")))[0]?.results ?? []) as TotpRow[];
    },
    async apply(sql) {
      const dir = mkdtempSync(join(tmpdir(), "totp-encrypt-"));
      chmodSync(dir, 0o700);
      try {
        const file = join(dir, "encrypt.sql");
        writeFileSync(file, sql.join("\n") + "\n", { mode: 0o600 });
        exec(["--file", file, "--yes"]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const db = get("--db"), database = get("--database"), env = get("--env");
  const remote = args.includes("--remote");
  if (remote ? !(database && (env === "staging" || env === "production")) : !db) {
    console.error("Usage: MFA_ENCRYPTION_KEY=… encrypt-totp-secrets.ts (--db <path> | --remote --database <d1 name> --env staging|production) [--yes]");
    process.exit(2);
  }
  try {
    let ops: Ops;
    if (remote) {
      const r = remoteOps(database!, env!);
      const { readFileSync } = await import("node:fs");
      await assertTargetIdentity({ env: env!, database: database!, toml: readFileSync("wrangler.toml", "utf8"), confirmProduction: get("--confirm-production"),
        confirmEnv: process.env[PRODUCTION_CONFIRM_ENV], recordedEnvironments: () => r.deploymentEnvironments() });
      console.log(`Target confirmed: ${database} is the ${env} database (wrangler.toml binding and its own deployment records agree).`);
      ops = r;
    } else ops = localOps(db!);
    await run(ops, process.env.MFA_ENCRYPTION_KEY ?? "", args.includes("--yes"), (s) => console.log(s));
  } catch (e) {
    console.error(`Refused: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 300)}`);
    process.exit(1);
  }
}
