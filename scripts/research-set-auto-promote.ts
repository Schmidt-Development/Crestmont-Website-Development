// Turn automatic research → CRM promotion ON or OFF on staging, through the Owner's own route.
//
// Why a script rather than a database write: `auto_promote` decides whether a scheduled job creates CRM leads on its
// own. Flipping it with `wrangler d1 execute` would skip the permission check, the validation and the audit record,
// and would leave no trace of who decided it. So this signs in as the staging Owner (credentials DERIVED read-only
// from the Cloudflare token and the salt already in staging D1 — nothing is rotated and no credential is printed) and
// posts the real Owner settings form, exactly as a person clicking the checkbox in /staff/research would.
//
// What it deliberately does NOT do:
//  - it never resumes research. The pause flag and the Owner's pause reason are read first and sent back unchanged,
//    so turning promotion on cannot restart website checking as a side effect.
//  - it never promotes anything itself. It sets the switch and reports what the next scheduled run will face.
//  - it never touches production: it addresses the staging Worker and staging D1 only.
//
// CLI:
//   node --no-warnings scripts/research-set-auto-promote.ts --enable on|off [--max-per-run 200]
//   env: E2E_BASE_URL (the staging Worker URL), ACCESS_ROOT_KEY (= the Cloudflare API token),
//        CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (for wrangler), WRANGLER (optional)
import { totpCode } from "../src/lib/auth-crypto.ts";
import { currentAccess, wranglerOps } from "./staging-access.ts";
import { censusQueries } from "../src/services/research-promote.ts";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = (process.env.E2E_BASE_URL ?? "").replace(/\/$/, "");
const ROOT = process.env.ACCESS_ROOT_KEY ?? "";
const want = (arg("enable") ?? "").toLowerCase();
const maxPerRun = arg("max-per-run", "200")!;

function fail(msg: string): never { console.log(`::error title=Automatic CRM promotion::${msg}`); process.exit(1); }
if (!BASE) fail("E2E_BASE_URL is required (the staging Worker URL)");
if (!ROOT) fail("ACCESS_ROOT_KEY is required (the Cloudflare API token secret)");
if (want !== "on" && want !== "off") fail(`--enable must be "on" or "off", not ${JSON.stringify(arg("enable") ?? "")}`);
if (!/^\d{1,4}$/.test(maxPerRun) || Number(maxPerRun) < 1 || Number(maxPerRun) > 2000) fail(`--max-per-run must be 1-2000, not ${JSON.stringify(maxPerRun)}`);
// The Worker URL must be the staging one. A typo that pointed this at production would enable automatic lead
// creation in the live CRM, so the host is checked rather than trusted.
const host = new URL(BASE).hostname;
if (!/^crestmont-platform-staging\./.test(host)) fail(`refusing to act on '${host}': this script only addresses crestmont-platform-staging.*`);

const d1 = wranglerOps();
const q = <T = Record<string, unknown>>(sql: string) => d1.query<T>(sql);
const one = async (sql: string) => Number((await q<{ n: number }>(sql))[0]?.n ?? 0);

class Session {
  private cookies = new Map<string, string>();
  private absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";"); const i = pair.indexOf("="); const k = pair.slice(0, i).trim();
      if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) this.cookies.delete(k);
      else this.cookies.set(k, decodeURIComponent(pair.slice(i + 1)));
    }
  }
  async req(method: string, path: string, form?: Record<string, string>) {
    const csrf = () => this.cookies.get("__Host-cm_csrf") ?? this.cookies.get("cm_csrf");
    if (form && !csrf()) await this.req("GET", "/login");
    const headers: Record<string, string> = { origin: BASE };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    let body: string | undefined;
    if (form) { body = new URLSearchParams({ _csrf: csrf() ?? "", ...form }).toString(); headers["content-type"] = "application/x-www-form-urlencoded"; }
    const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
    this.absorb(res);
    return res;
  }
  async login(email: string, password: string, totp: string) {
    const r = await this.req("POST", "/login", { email, password });
    if (r.status !== 303) fail(`sign-in returned ${r.status}`);
    if (!(r.headers.get("location") ?? "").includes("/mfa")) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Wait for a fresh 30-second TOTP step: a code already half-spent is the usual cause of a flaky sign-in.
      await new Promise((ok) => setTimeout(ok, 30_000 - (Date.now() % 30_000) + 1_500));
      const m = await this.req("POST", "/mfa", { code: await totpCode(totp) });
      if (m.status === 303 && new URL(m.headers.get("location") ?? "", BASE).pathname !== "/mfa") return;
      if (m.status === 429 || m.status === 503) fail("two-factor sign-in is rate limited; try again in a few minutes");
    }
    fail("two-factor sign-in failed");
  }
}

const settings = (await q<{ paused: number; pause_reason: string | null; qualify_threshold: number; max_batch: number; auto_promote: number; auto_promote_max_per_run: number }>(
  `SELECT paused, pause_reason, qualify_threshold, max_batch, auto_promote, auto_promote_max_per_run FROM research_settings WHERE id = 1`).catch(() => []))[0];
if (!settings) fail("research_settings row 1 is missing, or migration 0073 has not been applied to this environment");
if (settings.auto_promote === null || settings.auto_promote === undefined) fail("research_settings.auto_promote is absent: migration 0073 has not been applied to this environment");

const access = await currentAccess(d1, ROOT);
if (!access) fail("no staging Owner demo account with two-factor could be derived; run the staging deploy's access step first");

const os = new Session();
await os.login(access.owner.email, access.owner.password, access.owner.totp);

// The pause flag and the Owner's own reason are sent back exactly as they were: turning promotion on must not
// resume research, and re-pausing without the reason would quietly rewrite what the Owner wrote.
const form: Record<string, string> = {
  ...(settings.paused ? { paused: "1", reason: (settings.pause_reason ?? "").trim().length >= 3 ? String(settings.pause_reason) : "Paused by the Owner" } : {}),
  threshold: String(settings.qualify_threshold),
  max_batch: String(settings.max_batch),
  auto_promote_max_per_run: maxPerRun,
  ...(want === "on" ? { auto_promote: "1" } : {}),
};
const res = await os.req("POST", "/staff/research/settings", form);
if (res.status !== 303) fail(`the Owner settings route returned ${res.status}`);

// Confirm from the authoritative rows, allowing for D1 read-replica lag.
const until = Date.now() + 60_000;
let after = settings;
for (;;) {
  after = (await q<typeof settings>(`SELECT paused, pause_reason, qualify_threshold, max_batch, auto_promote, auto_promote_max_per_run FROM research_settings WHERE id = 1`))[0];
  if (Number(after.auto_promote) === (want === "on" ? 1 : 0) && Number(after.auto_promote_max_per_run) === Number(maxPerRun)) break;
  if (Date.now() > until) fail(`auto_promote reads ${after.auto_promote} (cap ${after.auto_promote_max_per_run}) after 60s; the change did not stick`);
  await new Promise((ok) => setTimeout(ok, 3_000));
}
if (Number(after.paused) !== Number(settings.paused)) fail(`the pause flag changed from ${settings.paused} to ${after.paused}; this script must never resume or pause research`);
if ((after.pause_reason ?? "") !== (settings.pause_reason ?? "")) fail("the Owner's pause reason was rewritten");
if (Number(after.qualify_threshold) !== Number(settings.qualify_threshold) || Number(after.max_batch) !== Number(settings.max_batch)) fail("a research threshold changed");

const census: Record<string, number> = {};
for (const [k, sql] of Object.entries(censusQueries(Number(after.qualify_threshold)))) census[k] = await one(sql);
const crmLeads = await one(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent'`);
const runs = await q<Record<string, unknown>>(`SELECT trigger, COUNT(*) AS n, SUM(promoted) AS promoted FROM research_promotion_runs GROUP BY trigger ORDER BY trigger`).catch(() => []);

const lines = [
  `### Automatic CRM promotion: ${want === "on" ? "**ON**" : "**OFF**"}`,
  "",
  `- host: ${host}`,
  `- auto_promote: ${after.auto_promote} (was ${settings.auto_promote}); cap per run: ${after.auto_promote_max_per_run} (was ${settings.auto_promote_max_per_run})`,
  `- research_settings.paused: ${after.paused} (unchanged) — turning promotion on does not resume research`,
  `- qualify_threshold ${after.qualify_threshold}, max_batch ${after.max_batch} (unchanged)`,
  `- eligible for promotion right now: **${census.eligibleNow}** of ${census.totalOnRecord} on record (${census.needsPerson} need a person, ${census.alreadyPromoted} already promoted)`,
  `- CRM leads with origin research_agent: ${crmLeads}`,
  `- promotion runs so far: ${runs.length ? runs.map((r) => `${String(r.trigger)} ${String(r.n)} run(s), ${String(r.promoted)} promoted`).join("; ") : "none"}`,
  want === "on"
    ? `- the 15-minute scheduled job will now promote at most ${after.auto_promote_max_per_run} prospects per run (up to ${Number(after.auto_promote_max_per_run) * 96} a day) through the CRM intake engine, each one subject to customer matching, do-not-call, email suppression and duplicate review. No lead is released for automated calling.`
    : `- the 15-minute scheduled job will record a run and promote nothing while this is off.`,
];
const text = lines.join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
