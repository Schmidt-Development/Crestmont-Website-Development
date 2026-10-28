// Helpers for .github/workflows/provision-production.yml (INFRA-002, INFRA-005). That workflow creates the
// production infrastructure ONLY — the D1 database, the Worker (as an empty draft holding its secrets) and the
// check that the R2 bucket exists. It never uploads application code, never attaches a domain, never applies
// migrations and never touches staging or the frontend preview. The application is deployed later, only by
// deploy-production.yml after Founder approval.
//
//   node --no-warnings scripts/provision-production.ts guard [wrangler.toml]
//   node --no-warnings scripts/provision-production.ts d1-uuid <d1-list.json> <database name>
//   node --no-warnings scripts/provision-production.ts turnstile          (reads PROD_TURNSTILE_SITE_KEY / PROD_TURNSTILE_SECRET)
//   node --no-warnings scripts/provision-production.ts mfa-key            (reads PROD_MFA_ENCRYPTION_KEY)
//   node --no-warnings scripts/provision-production.ts secret-names <secret-list.json>
import { readFileSync } from "node:fs";

export const PRODUCTION = { worker: "crestmont-platform-production", database: "crestmont-production", bucket: "crestmont-files-production" } as const;

/** The `[env.production]` block of wrangler.toml, from its header to the next `[env.` header or the end. */
export function productionBlock(toml: string): string {
  const s = toml.indexOf("\n[env.production]");
  if (s < 0) throw new Error("wrangler.toml has no [env.production] block");
  const e = toml.indexOf("\n[env.", s + 1);
  return toml.slice(s, e > 0 ? e : undefined);
}

export type ProductionTargets = { worker: string; database: string; databaseId: string; bucket: string; workersDev: boolean };

/** Reads the production targets and refuses anything that could reach staging, the frontend preview or another Worker. */
export function guardProduction(toml: string): ProductionTargets {
  const b = productionBlock(toml).replace(/#.*$/gm, ""); // ignore comments
  const worker = /\nname = "([^"]+)"/.exec(b)?.[1] ?? "";
  const database = /database_name = "([^"]+)"/.exec(b)?.[1] ?? "";
  const databaseId = /database_id = "([^"]*)"/.exec(b)?.[1] ?? "";
  const bucket = /bucket_name = "([^"]+)"/.exec(b)?.[1] ?? "";
  const workersDev = /\nworkers_dev = true/.test(b);
  const problems: string[] = [];
  if (worker !== PRODUCTION.worker) problems.push(`worker name is "${worker}", expected "${PRODUCTION.worker}"`);
  if (database !== PRODUCTION.database) problems.push(`database is "${database}", expected "${PRODUCTION.database}"`);
  if (bucket !== PRODUCTION.bucket) problems.push(`bucket is "${bucket}", expected "${PRODUCTION.bucket}"`);
  if (workersDev) problems.push("workers_dev must not be true for production");
  if (/staging|frontend-preview|preview\.test/.test(`${worker} ${database} ${bucket}`)) problems.push("refusing a staging or preview target");
  if (databaseId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(databaseId)) problems.push(`database_id "${databaseId}" is not a D1 UUID`);
  if (problems.length) throw new Error(`Production guard failed: ${problems.join("; ")}`);
  return { worker, database, databaseId, bucket, workersDev };
}

/** The JSON array in Wrangler output, skipping banners and bracketed log prefixes such as "[ERROR]". */
export function jsonArray<T>(output: string): T[] | null {
  const m = /\[\s*(\{|\])/.exec(output);
  if (!m) return null;
  return JSON.parse(output.slice(m.index)) as T[];
}

/** UUID of the D1 database with exactly this name from `wrangler d1 list --json` output (Wrangler may print a banner first). */
export function d1Uuid(listOutput: string, name: string): string | null {
  const rows = jsonArray<{ name?: string; uuid?: string }>(listOutput);
  if (!rows) return null;
  const hits = rows.filter((r) => r.name === name);
  if (hits.length > 1) throw new Error(`More than one D1 database is named ${name}`);
  return hits[0]?.uuid ?? null;
}

// Cloudflare's documented Turnstile test keys (always pass / always fail / force challenge). Never valid in production.
const TEST_SITE_KEY = /^[123]x0{20}[A-F]{2}$/;
const TEST_SECRET = /^[123]x0{31}[A-F]{2}$/;

export function turnstileProblems(siteKey: string | undefined, secret: string | undefined, staging: { siteKey?: string; secret?: string } = {}): string[] {
  const p: string[] = [];
  const k = (siteKey ?? "").trim(), s = (secret ?? "").trim();
  if (!k) p.push("PRODUCTION_TURNSTILE_SITE_KEY is not set on the production environment");
  if (!s) p.push("PRODUCTION_TURNSTILE_SECRET is not set on the production environment");
  if (k && TEST_SITE_KEY.test(k)) p.push("PRODUCTION_TURNSTILE_SITE_KEY is a Cloudflare test key");
  if (s && TEST_SECRET.test(s)) p.push("PRODUCTION_TURNSTILE_SECRET is a Cloudflare test key");
  if (k && staging.siteKey && k === staging.siteKey) p.push("PRODUCTION_TURNSTILE_SITE_KEY equals the staging site key");
  if (s && staging.secret && s === staging.secret) p.push("PRODUCTION_TURNSTILE_SECRET equals the staging secret");
  if (k && k === s) p.push("the Turnstile site key and secret are the same value");
  return p;
}

/** MFA_ENCRYPTION_KEY must be base64 of exactly 32 random bytes (src/lib/totp-secrets.ts). Never echoes the value. */
export function mfaKeyProblems(raw: string | undefined): string[] {
  const v = (raw ?? "").trim();
  if (!v) return ["PRODUCTION_MFA_ENCRYPTION_KEY is not set on the production environment"];
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return ["PRODUCTION_MFA_ENCRYPTION_KEY is not valid base64"];
  const n = Buffer.from(v, "base64").length;
  if (n !== 32) return [`PRODUCTION_MFA_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${n})`];
  if (new Set(Buffer.from(v, "base64")).size < 8) return ["PRODUCTION_MFA_ENCRYPTION_KEY does not look random"];
  return [];
}

/** Secret names from `wrangler secret list --format json` (an absent Worker yields an empty list). */
export function secretNames(listOutput: string): string[] {
  return (jsonArray<{ name?: string }>(listOutput) ?? []).map((r) => r.name ?? "").filter(Boolean);
}

/** Staging's public Turnstile values in wrangler.toml, so production can be checked against them. */
export function stagingTurnstile(toml: string): { siteKey?: string; secret?: string } {
  const s = toml.indexOf("\n[env.staging]");
  if (s < 0) return {};
  const e = toml.indexOf("\n[env.", s + 1);
  const b = toml.slice(s, e > 0 ? e : undefined);
  return { siteKey: /TURNSTILE_SITE_KEY = "([^"]+)"/.exec(b)?.[1], secret: /TURNSTILE_SECRET = "([^"]+)"/.exec(b)?.[1] };
}

const isMain = process.argv[1]?.endsWith("scripts/provision-production.ts");
if (isMain) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === "guard") {
      const t = guardProduction(readFileSync(a ?? "wrangler.toml", "utf8"));
      console.log(`Guard ok: worker ${t.worker}, D1 ${t.database} (${t.databaseId || "id not yet committed"}), R2 ${t.bucket}, workers_dev off.`);
    } else if (cmd === "d1-uuid") {
      process.stdout.write(d1Uuid(readFileSync(a, "utf8"), b) ?? "");
    } else if (cmd === "turnstile") {
      const problems = turnstileProblems(process.env.PROD_TURNSTILE_SITE_KEY, process.env.PROD_TURNSTILE_SECRET, stagingTurnstile(readFileSync("wrangler.toml", "utf8")));
      if (problems.length) { for (const p of problems) console.log(`::error title=Turnstile::${p}`); process.exit(1); }
      console.log("Turnstile production keys present and distinct from test and staging keys.");
    } else if (cmd === "mfa-key") {
      const problems = mfaKeyProblems(process.env.PROD_MFA_ENCRYPTION_KEY);
      if (problems.length) { for (const p of problems) console.log(`::error title=MFA key::${p}`); process.exit(1); }
      console.log("PRODUCTION_MFA_ENCRYPTION_KEY is well formed.");
    } else if (cmd === "secret-names") {
      process.stdout.write(secretNames(readFileSync(a, "utf8")).join("\n"));
    } else {
      console.error("Usage: provision-production.ts guard | d1-uuid <file> <name> | turnstile | mfa-key | secret-names <file>");
      process.exit(2);
    }
  } catch (e) {
    console.log(`::error::${(e as Error).message}`);
    process.exit(1);
  }
}
