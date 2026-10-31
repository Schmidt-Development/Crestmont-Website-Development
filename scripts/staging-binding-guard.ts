// Staging Worker binding preservation guard. Used by .github/workflows/deploy-staging.yml around `wrangler deploy`.
//
// Why: `wrangler deploy` defaults to --keep-vars=false, which deletes every plain-text variable that was added in the
// Cloudflare dashboard and is not declared in wrangler.toml ("Wrangler will override them the next time you deploy").
// That is how the Founder's STRIPE_PUBLISHABLE_KEY disappeared from staging on 2026-10-31. Secrets are never deleted
// by a deployment. The staging deploy now passes --keep-vars, and this guard proves nothing was lost:
//
//   node --no-warnings scripts/staging-binding-guard.ts snapshot --out guard/before.json
//       Reads the staging Worker's bindings from the Cloudflare API. Refuses (exit 1) when it cannot read them, or when
//       wrangler.toml would overwrite a Founder-managed variable. Reports which Founder-managed names are present.
//   node --no-warnings scripts/staging-binding-guard.ts verify --before guard/before.json
//       Reads the bindings again after the deploy. Fails (exit 1) when any variable or secret present before is gone,
//       or when a dashboard-managed variable's value changed. Variables declared in wrangler.toml may change (that is
//       what a deploy is for).
//
// Values are NEVER printed or stored: plain-text values are reduced to a SHA-256 hash; secret values are not returned
// by Cloudflare at all. env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Founder-managed configuration: never declared in wrangler.toml, never written or deleted by any workflow. A name
 *  stays here even when the code does not read it (STRIPE_PUBLISHABLE_KEY). */
export const FOUNDER_MANAGED = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PUBLISHABLE_KEY"] as const;

export interface BindingSummary { name: string; type: string; hash?: string }
export interface Snapshot { script: string; takenAt: string; bindings: BindingSummary[] }
type Obj = Record<string, unknown>;

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

/** wrangler.toml [env.<name>] vars (inline table of string values). */
export function tomlEnvVars(toml: string, env: string): Record<string, string> {
  const s = toml.indexOf(`[env.${env}]`);
  if (s < 0) throw new Error(`[env.${env}] not found in wrangler.toml`);
  const e = toml.indexOf("\n[env.", s + 1);
  const block = toml.slice(s, e > 0 ? e : undefined).split("\n").filter((l) => !l.trimStart().startsWith("#"));
  const line = block.find((l) => /^\s*vars\s*=\s*\{/.test(l));
  if (!line) return {};
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/([A-Z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) out[m[1]] = m[2];
  return out;
}
export function tomlScriptName(toml: string, env: string): string {
  const s = toml.indexOf(`[env.${env}]`);
  const m = /^\s*name\s*=\s*"([^"]+)"/m.exec(toml.slice(s, toml.indexOf("\n[env.", s + 1) > 0 ? toml.indexOf("\n[env.", s + 1) : undefined));
  if (!m) throw new Error(`[env.${env}] has no name`);
  return m[1];
}

/** Binding summaries from any Cloudflare API result that carries a `bindings` array. null = no bindings array found. */
export function summarize(result: unknown): BindingSummary[] | null {
  const find = (v: unknown): Obj[] | null => {
    if (!v || typeof v !== "object") return null;
    if (Array.isArray((v as Obj).bindings)) return (v as Obj).bindings as Obj[];
    for (const x of Object.values(v as Obj)) { const r = find(x); if (r) return r; }
    return null;
  };
  const raw = find(result);
  if (!raw) return null;
  return raw.filter((b) => typeof b?.name === "string").map((b) => {
    const type = String(b.type ?? "unknown");
    const value = type === "plain_text" ? (typeof b.text === "string" ? b.text : null) : type === "json" ? JSON.stringify(b.json ?? null) : null;
    return { name: b.name as string, type, ...(value !== null ? { hash: sha(value) } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Refusals before a deploy: wrangler.toml must never declare a Founder-managed variable (it would overwrite it). */
export function preflightProblems(declared: Record<string, string>): string[] {
  return FOUNDER_MANAGED.filter((n) => n in declared).map((n) => `wrangler.toml declares Founder-managed ${n}; a deploy would overwrite the Founder's value. Remove it from wrangler.toml.`);
}

/** What a deploy lost or changed. `declared` = vars in wrangler.toml (repository-managed, allowed to change). */
export function verifyProblems(before: BindingSummary[], after: BindingSummary[], declared: Record<string, string>): string[] {
  const now = new Map(after.map((b) => [b.name, b]));
  const out: string[] = [];
  for (const b of before) {
    const a = now.get(b.name);
    if (!a) { out.push(`${b.name} (${b.type}) was removed by the deploy`); continue; }
    if (b.name in declared) continue;
    if (b.hash && a.hash !== b.hash) out.push(`dashboard-managed ${b.name} changed value during the deploy`);
    if (a.type !== b.type) out.push(`${b.name} changed type ${b.type} → ${a.type}`);
  }
  return out;
}

export function founderReport(bindings: BindingSummary[]): { present: string[]; absent: string[] } {
  const names = new Set(bindings.map((b) => b.name));
  return { present: FOUNDER_MANAGED.filter((n) => names.has(n)), absent: FOUNDER_MANAGED.filter((n) => !names.has(n)) };
}

async function cf(path: string): Promise<unknown> {
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await r.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: { message?: string }[] };
  if (!r.ok || body.success === false) throw new Error(`Cloudflare API ${path.replace(/\/[0-9a-f-]{36}/g, "/<id>")}: HTTP ${r.status} ${body.errors?.map((e) => e.message).join("; ") ?? ""}`.trim());
  return body.result;
}

/** The serving bindings: the script's settings, else the version currently serving traffic. Fails closed. */
export async function liveBindings(script: string, get: (path: string) => Promise<unknown> = cf): Promise<BindingSummary[]> {
  const base = `/workers/scripts/${encodeURIComponent(script)}`;
  const fromSettings = summarize(await get(`${base}/settings`).catch(() => null));
  if (fromSettings) return fromSettings;
  const deps = (await get(`${base}/deployments`)) as Obj;
  const list = (Array.isArray(deps?.deployments) ? deps.deployments : Array.isArray(deps) ? deps : []) as Obj[];
  const versions = (list[0]?.versions ?? []) as Obj[];
  const serving = versions.find((v) => Number(v.percentage) === 100) ?? versions[0];
  const id = serving?.version_id ?? serving?.id;
  if (typeof id !== "string") throw new Error("could not identify the serving version");
  const fromVersion = summarize(await get(`${base}/versions/${id}`));
  if (!fromVersion) throw new Error("the Cloudflare API returned no bindings for the serving version");
  return fromVersion;
}

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const toml = readFileSync("wrangler.toml", "utf8");
  const declared = tomlEnvVars(toml, "staging");
  const script = tomlScriptName(toml, "staging");
  try {
    if (mode === "snapshot") {
      const problems = preflightProblems(declared);
      if (problems.length) { for (const p of problems) console.log(`::error title=Binding preservation::${p}`); process.exit(1); }
      const bindings = await liveBindings(script);
      const out = arg("--out") ?? "guard/before.json";
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({ script, takenAt: new Date().toISOString(), bindings } satisfies Snapshot, null, 2));
      const f = founderReport(bindings);
      console.log(`Staging bindings before deploy: ${bindings.length} (${bindings.filter((b) => b.type === "secret_text").length} secrets). Names only: ${bindings.map((b) => b.name).join(", ")}`);
      console.log(`Founder-managed present: ${f.present.join(", ") || "none"}`);
      for (const n of f.absent) console.log(`::warning title=Founder-managed variable absent::${n} is not set on the staging Worker. Restore it in the Cloudflare dashboard (the deploy preserves it from now on; it is never recreated by automation).`);
    } else if (mode === "verify") {
      const before = JSON.parse(readFileSync(arg("--before") ?? "guard/before.json", "utf8")) as Snapshot;
      const after = await liveBindings(script);
      const problems = verifyProblems(before.bindings, after, declared);
      if (problems.length) {
        for (const p of problems) console.log(`::error title=Binding preservation::${p}`);
        console.log("::error title=Binding preservation::The deploy removed or changed Founder/dashboard configuration. Restore it in the Cloudflare dashboard and fix the deploy before deploying again.");
        process.exit(1);
      }
      console.log(`Binding preservation verified: all ${before.bindings.length} bindings present before the deploy are still present; no dashboard-managed value changed.`);
    } else throw new Error("usage: snapshot --out <file> | verify --before <file>");
  } catch (e) {
    console.log(`::error title=Binding preservation::${String((e as Error).message ?? e).split("\n")[0].slice(0, 300)} — preservation cannot be established, so the deploy is refused.`);
    process.exit(1);
  }
}
