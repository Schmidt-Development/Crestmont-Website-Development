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
  if (mode !== "run") throw new Error("usage: derive | run --url <base> [--daily]");
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

if (process.argv[1] === fileURLToPath(import.meta.url)) await main().catch((e) => { console.log(`::error title=External scheduler::${(e as Error).message}`); process.exitCode = 1; });
