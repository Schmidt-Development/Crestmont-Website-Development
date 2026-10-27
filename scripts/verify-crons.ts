// Verifies (and if needed re-registers) the Worker's Cron Triggers after a STAGING deploy (READY-012, INFRA-006).
// Found 2026-10-27: no scheduled job had ever recorded a run on staging, so the cron triggers were not firing.
// This compares the schedules Cloudflare has registered for the script with [env.<env>].triggers in wrangler.toml and,
// when they differ, sets them through the documented Workers API (PUT …/workers/scripts/<name>/schedules).
//   node --no-warnings scripts/verify-crons.ts --env staging [--dry-run]
//   env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
// Staging only: it refuses any other environment, so production triggers are never changed by automation.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Crons declared for one environment in wrangler.toml (inline `triggers = { crons = [...] }` form). */
export function declaredCrons(toml: string, env: string): string[] {
  const start = toml.indexOf(`[env.${env}]`);
  if (start < 0) throw new Error(`[env.${env}] not found in wrangler.toml`);
  const rest = toml.slice(start + 1);
  const end = rest.search(/^\[(?!\[)(?!env\.\w+\.)/m); // next top-level table
  const section = end < 0 ? rest : rest.slice(0, end);
  const m = /^triggers\s*=\s*\{\s*crons\s*=\s*\[([^\]]*)\]/m.exec(section);
  if (!m) throw new Error(`no triggers for [env.${env}]`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

export function sameSchedules(registered: string[], declared: string[]): boolean {
  const a = [...registered].sort(), b = [...declared].sort();
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/** Cloudflare answers {result:{schedules:[{cron}]}} (documented) — parsed defensively. */
export function registeredCrons(body: unknown): string[] {
  const r = (body as { result?: { schedules?: { cron?: unknown }[] } })?.result;
  return (r?.schedules ?? []).map((s) => s.cron).filter((c): c is string => typeof c === "string");
}

async function main() {
  const args = process.argv.slice(2);
  const env = args[args.indexOf("--env") + 1];
  const dry = args.includes("--dry-run");
  if (env !== "staging") throw new Error("verify-crons only manages staging; production triggers change only through an approved production deploy");
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  const toml = readFileSync("wrangler.toml", "utf8");
  const declared = declaredCrons(toml, env);
  const name = /^name\s*=\s*"([^"]+)"/m.exec(toml.slice(toml.indexOf(`[env.${env}]`)))?.[1];
  if (name !== "crestmont-platform-staging") throw new Error(`unexpected staging script name ${name}`);
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/schedules`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const get = async () => { const r = await fetch(url, { headers }); const j = await r.json().catch(() => null); if (!r.ok) throw new Error(`GET schedules: HTTP ${r.status} ${JSON.stringify((j as { errors?: unknown })?.errors ?? "")}`); return registeredCrons(j); };
  const before = await get();
  console.log(`Declared: ${declared.join(", ")} | Registered: ${before.join(", ") || "(none)"}`);
  if (sameSchedules(before, declared)) { console.log("Cron triggers are registered as declared."); return; }
  if (dry) { console.log("::warning::cron triggers differ (dry run, not changed)"); process.exitCode = 1; return; }
  const put = await fetch(url, { method: "PUT", headers, body: JSON.stringify(declared.map((cron) => ({ cron }))) });
  if (!put.ok) throw new Error(`PUT schedules: HTTP ${put.status} ${await put.text().catch(() => "")}`.slice(0, 500));
  const after = await get();
  if (!sameSchedules(after, declared)) throw new Error(`schedules still differ after update: ${after.join(", ")}`);
  console.log(`::notice title=Cron triggers repaired::registered ${after.join(", ")} (were: ${before.join(", ") || "none"})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main().catch((e) => { console.log(`::error title=Cron triggers::${(e as Error).message}`); process.exitCode = 1; });
