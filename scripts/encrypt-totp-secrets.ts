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

interface Ops { rows(): Promise<TotpRow[]>; apply(sql: string[]): Promise<void> }

export async function run(ops: Ops, rawKey: string, write: boolean, log: (s: string) => void): Promise<Plan> {
  if (!rawKey) throw new Error("Set MFA_ENCRYPTION_KEY in the environment (the same value as the Worker secret).");
  const plan = await planReencryption(await ops.rows(), rawKey);
  log(`TOTP secrets: ${plan.plaintext} stored in plaintext, ${plan.alreadyEncrypted} already encrypted (all decrypt with this key).`);
  if (!plan.sql.length) { log("Nothing to do."); return plan; }
  if (!write) { log(`Dry run: re-run with --yes to encrypt ${plan.plaintext} value(s).`); return plan; }
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
    async apply(sql) {
      const { openDb } = await import("../dev/sqlite-d1.ts");
      const raw = openDb(path).raw;
      raw.exec("BEGIN");
      try { raw.exec(sql.join("\n")); raw.exec("COMMIT"); } catch (e) { raw.exec("ROLLBACK"); throw e; }
    },
  };
}

function remoteOps(database: string, env: string): Ops {
  const [cmd, ...base] = (process.env.WRANGLER ?? "npx --yes wrangler@4.149.0").split(" ").filter(Boolean);
  const d1 = ["d1", "execute", database, "--remote", "--env", env];
  const exec = (args: string[]) => execFileSync(cmd, [...base, ...d1, ...args], { stdio: ["pipe", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
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
    await run(remote ? remoteOps(database!, env!) : localOps(db!), process.env.MFA_ENCRYPTION_KEY ?? "", args.includes("--yes"), (s) => console.log(s));
  } catch (e) {
    console.error(`Refused: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 300)}`);
    process.exit(1);
  }
}
