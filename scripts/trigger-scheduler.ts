// External scheduler client (READY-012, INFRA-006): signs and posts the job-set trigger to POST /api/scheduled/run.
// Used by .github/workflows/staging-health-monitor.yml because staging's Cloudflare account has no free Cron Trigger
// slots. The key is DERIVED from the Cloudflare API token secret (same pattern as scripts/staging-access.ts), so no
// extra secret has to be created; scripts/deploy installs the same derived value as SCHEDULER_TRIGGER_SECRET.
//   node --no-warnings scripts/trigger-scheduler.ts derive            → prints the key (masked by the workflow)
//   node --no-warnings scripts/trigger-scheduler.ts run --url <base> [--daily]
//   env: ACCESS_ROOT_KEY (the Cloudflare API token secret)
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

export const SCHEDULER_KEY_LABEL = "crestmont-staging-scheduler:v1";
export const deriveSchedulerKey = (root: string) => createHmac("sha256", root).update(SCHEDULER_KEY_LABEL).digest("hex");
export const sign = (key: string, body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
export const FREQUENT = "*/15 * * * *", DAILY = "17 11 * * *";

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const root = process.env.ACCESS_ROOT_KEY;
  if (!root) throw new Error("ACCESS_ROOT_KEY is required");
  const key = deriveSchedulerKey(root);
  if (mode === "derive") { process.stdout.write(key); return; }
  if (mode === "retell-audit") return retellAudit(key, rest);
  if (mode !== "run") throw new Error("usage: derive | run --url <base> [--daily] | retell-audit --url <base>");
  const base = rest[rest.indexOf("--url") + 1]?.replace(/\/$/, "");
  if (!base || !/^https:\/\//.test(base)) throw new Error("--url https://… is required");
  const crons = [FREQUENT, ...(rest.includes("--daily") ? [DAILY] : [])];
  let failed = false;
  for (const cron of crons) {
    const body = JSON.stringify({ cron });
    const r = await fetch(`${base}/api/scheduled/run`, { method: "POST", headers: { "content-type": "application/json", "x-crestmont-scheduler-signature": sign(key, body) }, body });
    const text = (await r.text()).slice(0, 300);
    console.log(`${cron}: HTTP ${r.status} ${text}`);
    if (!r.ok && r.status !== 429) failed = true; // 429 = already ran in the last 5 minutes
  }
  if (failed) { console.log("::error title=External scheduler::a job-set trigger failed"); process.exitCode = 1; }
}

/**
 * Asks the Worker to audit the receptionist's live Retell configuration with its own inbound key and prints the findings
 * as annotations (ids, URLs, settings and booleans only). Never fails the job: missing dashboard settings are the
 * Founder's to fix and must not block deploys; an HTTP failure is a warning.
 */
async function retellAudit(key: string, rest: string[]) {
  const base = rest[rest.indexOf("--url") + 1]?.replace(/\/$/, "");
  if (!base || !/^https:\/\//.test(base)) throw new Error("--url https://… is required");
  const body = JSON.stringify({ audit: "retell-inbound" });
  const r = await fetch(`${base}/api/voice/retell-audit`, { method: "POST", headers: { "content-type": "application/json", "x-crestmont-scheduler-signature": sign(key, body) }, body });
  const text = await r.text();
  if (!r.ok) { console.log(`::warning title=Retell inbound audit::HTTP ${r.status} ${text.replace(/[\r\n]+/g, " ").slice(0, 200)}`); return; }
  const a = JSON.parse(text) as { status: string; agentId: string | null; llmId: string | null; agents: { id: string; name: string | null }[]; findings: { check: string; ok: boolean; detail: string }[] };
  const clean = (x: string) => x.replace(/[\r\n]+/g, " ").replace(/::/g, ": ").slice(0, 300);
  const failed = a.findings.filter((f) => !f.ok);
  console.log(`::notice title=Retell inbound audit::${a.status.toUpperCase()} — ${a.findings.length - failed.length}/${a.findings.length} checks pass · agent ${a.agentId ?? "?"} · llm ${a.llmId ?? "?"} · agents in workspace: ${a.agents.map((x) => `${x.id}${x.name ? ` (${clean(x.name)})` : ""}`).join(", ") || "none"}`);
  // GitHub keeps at most 10 notices and 10 warnings per step, so the findings are grouped into one annotation each
  // (the first deploy with one annotation per check lost 10 of 30 findings). Annotation messages hold up to 64 KB.
  const list = (fs: typeof a.findings) => fs.map((f) => `${clean(f.check)}: ${clean(f.detail)}`).join(" | ");
  if (failed.length) console.log(`::warning title=Retell inbound audit TODO (${failed.length})::${list(failed)}`);
  const passed = a.findings.filter((f) => f.ok);
  if (passed.length) console.log(`::notice title=Retell inbound audit OK (${passed.length})::${list(passed)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main().catch((e) => { console.log(`::error title=External scheduler::${(e as Error).message}`); process.exitCode = 1; });
