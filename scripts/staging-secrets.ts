// Change-aware Worker secrets for the STAGING deploy (TEST-004 / INFRA-005).
// Cloudflare blocks a rollback to a version when any secret changed since it was active (error 10220): re-putting or
// rotating secrets on every deploy made every rollback fail. This puts a secret only when its value changed, tracked
// by a keyed fingerprint in staging D1 (migrations/0037). Values that only machines use are derived from the Cloudflare
// token secret, so they are stable across deploys and no extra GitHub secret is needed.
//   node --no-warnings scripts/staging-secrets.ts derive <label>        → prints a derived 64-hex key (mask it!)
//   printf '%s' "$v" | node --no-warnings scripts/staging-secrets.ts put <NAME>   → "updated" | "unchanged"
//   env: ACCESS_ROOT_KEY (the Cloudflare API token secret), WRANGLER
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wranglerOps, type D1Ops } from "./staging-access.ts";

export const DERIVED_LABELS = { evidence: "crestmont-staging-evidence:v1", scheduler: "crestmont-staging-scheduler:v1" } as const;
export const deriveStagingKey = (root: string, label: keyof typeof DERIVED_LABELS) => createHmac("sha256", root).update(DERIVED_LABELS[label]).digest("hex");
export const secretFingerprint = (root: string, name: string, value: string) => createHmac("sha256", root).update(`crestmont-secret-fp:v1:${name}:${value}`).digest("hex");

export async function putSecretIfChanged(ops: D1Ops, root: string, name: string, value: string, now = new Date()): Promise<"updated" | "unchanged"> {
  if (!/^[A-Z_]{3,64}$/.test(name)) throw new Error(`invalid secret name ${name}`);
  if (!root) throw new Error("ACCESS_ROOT_KEY is required");
  if (!value) throw new Error(`refusing to put an empty value for ${name}`);
  const fp = secretFingerprint(root, name, value);
  const rows = await ops.query<{ fingerprint: string }>(`SELECT fingerprint FROM deploy_secret_fingerprints WHERE name = '${name}'`);
  if (rows[0]?.fingerprint === fp) return "unchanged";
  await ops.putSecret(name, value);
  await ops.query(`INSERT INTO deploy_secret_fingerprints (name, fingerprint, updated_at) VALUES ('${name}', '${fp}', '${now.toISOString()}')
                   ON CONFLICT(name) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`);
  return "updated";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, arg] = process.argv.slice(2);
  const root = process.env.ACCESS_ROOT_KEY ?? "";
  try {
    if (mode === "derive") {
      if (!root) throw new Error("ACCESS_ROOT_KEY is required");
      if (!(arg in DERIVED_LABELS)) throw new Error(`unknown label ${arg}`);
      process.stdout.write(deriveStagingKey(root, arg as keyof typeof DERIVED_LABELS));
    } else if (mode === "put") {
      const value = readFileSync(0, "utf8");
      console.log(`${arg}: ${await putSecretIfChanged(wranglerOps(), root, arg, value)}`);
    } else throw new Error("usage: derive <label> | put <NAME>");
  } catch (e) {
    console.error(`::error::${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    process.exit(1);
  }
}
