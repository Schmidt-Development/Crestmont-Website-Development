// Research 24-hour performance report. Reads the measurement window's rows from the real staging D1 (read-only,
// `wrangler d1 execute --remote`), aggregates them with src/services/research-report.ts and writes a durable report.
//
//   node --no-warnings scripts/research-24h-report.ts [--start <ISO>] [--hours 24] [--target 25000] [--out evidence]
//
// --start defaults to the first worker sample in the last 48 hours, so the window is the run itself rather than an
// arbitrary clock boundary. Nothing is written to the database and no prospect is promoted: this only reads and
// reports. Needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, like the other staging scripts.
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { wranglerOps } from "./staging-access.ts";
import { buildReport, formatReport, type BatchRow, type ProspectCounts, type SampleRow } from "../src/services/research-report.ts";
import { censusQueries, MAX_PROMOTE_ATTEMPTS } from "../src/services/research-promote.ts";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const d1 = wranglerOps();
const q = <T = Record<string, unknown>>(sql: string) => d1.query<T>(sql);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (x: unknown) => (x === null || x === undefined || x === "" ? null : Number(x));
const int = (x: unknown) => Number(x ?? 0) || 0;

const HOURS = Number(arg("hours", "24"));
const TARGET = Number(arg("target", "25000"));
const OUT = arg("out", "evidence")!;
if (!Number.isFinite(HOURS) || HOURS <= 0 || HOURS > 24 * 14) throw new Error("--hours must be 1..336");
if (!Number.isInteger(TARGET) || TARGET < 1) throw new Error("--target must be a positive whole number");

const now = new Date();
let start = arg("start");
if (!start) {
  const since = new Date(now.getTime() - 48 * 3600e3).toISOString();
  const first = (await q<{ at: string }>(`SELECT MIN(at) AS at FROM research_runner_samples WHERE at >= ${lit(since)}`))[0]?.at;
  start = first ?? new Date(now.getTime() - HOURS * 3600e3).toISOString();
}
const startIso = new Date(start).toISOString();
const endIso = new Date(Date.parse(startIso) + HOURS * 3600e3).toISOString();
const S = lit(startIso), E = lit(endIso);

const samples = (await q<Record<string, unknown>>(`SELECT bucket, runner_id, at, day, evaluated, websites_checked, failed_jobs, sent,
    records_per_hour, queue_depth, outbox_depth, paused, auth_failed, cpu_pct, ram_used_gb, ram_total_gb, rss_mb, disk_free_gb,
    gpu_util_pct, gpu_mem_used_mb, gpu_name, drafts_pending, drafts_done, drafts_dropped, drafts_deferrals
  FROM research_runner_samples WHERE at >= ${S} AND at <= ${E} ORDER BY bucket`)).map((r): SampleRow => ({
  bucket: String(r.bucket), runner_id: String(r.runner_id), at: String(r.at), day: String(r.day),
  evaluated: int(r.evaluated), websites_checked: int(r.websites_checked), failed_jobs: int(r.failed_jobs), sent: int(r.sent),
  records_per_hour: int(r.records_per_hour), queue_depth: int(r.queue_depth), outbox_depth: int(r.outbox_depth),
  paused: int(r.paused), auth_failed: int(r.auth_failed),
  cpu_pct: num(r.cpu_pct), ram_used_gb: num(r.ram_used_gb), ram_total_gb: num(r.ram_total_gb), rss_mb: num(r.rss_mb),
  disk_free_gb: num(r.disk_free_gb), gpu_util_pct: num(r.gpu_util_pct), gpu_mem_used_mb: num(r.gpu_mem_used_mb),
  gpu_name: r.gpu_name === null || r.gpu_name === undefined ? null : String(r.gpu_name),
  drafts_pending: num(r.drafts_pending), drafts_done: num(r.drafts_done), drafts_dropped: num(r.drafts_dropped), drafts_deferrals: num(r.drafts_deferrals),
}));

const batches = (await q<Record<string, unknown>>(`SELECT received_at, record_count, created, updated, unchanged, rejected, crm_matches, duplicates_prevented
  FROM research_batches WHERE received_at >= ${S} AND received_at <= ${E} ORDER BY received_at`)).map((r): BatchRow => ({
  received_at: String(r.received_at), record_count: int(r.record_count), created: int(r.created), updated: int(r.updated),
  unchanged: int(r.unchanged), rejected: int(r.rejected), crm_matches: int(r.crm_matches), duplicates_prevented: int(r.duplicates_prevented),
}));

const one = async (sql: string) => int((await q<{ n: number }>(sql))[0]?.n);
const byClass = Object.fromEntries((await q<{ k: string; n: number }>(
  `SELECT website_class AS k, COUNT(*) AS n FROM research_prospects WHERE first_seen_at >= ${S} AND first_seen_at <= ${E} GROUP BY website_class`
)).map((r) => [String(r.k), int(r.n)]));

const prospects: ProspectCounts = {
  qualifiedInWindow: await one(`SELECT COUNT(*) AS n FROM research_prospects WHERE qualified = 1 AND first_seen_at >= ${S} AND first_seen_at <= ${E}`),
  awaitingDecision: await one(`SELECT COUNT(*) AS n FROM research_prospects WHERE status IN ('qualified','review')`),
  reviewInWindow: await one(`SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'review' AND first_seen_at >= ${S} AND first_seen_at <= ${E}`),
  suppressedInWindow: await one(`SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'suppressed' AND first_seen_at >= ${S} AND first_seen_at <= ${E}`),
  existingCrmInWindow: await one(`SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'existing_crm' AND first_seen_at >= ${S} AND first_seen_at <= ${E}`),
  notQualifiedInWindow: await one(`SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'not_qualified' AND first_seen_at >= ${S} AND first_seen_at <= ${E}`),
  // Must stay 0: the outbound gate is fail-closed by design. Reported, never acted on.
  eligibleForCalling: await one(`SELECT COUNT(*) AS n FROM research_prospects WHERE eligibility = 'eligible'`),
  byClassInWindow: byClass,
};
const promoted = await one(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'research.prospect_promoted' AND created_at >= ${S} AND created_at <= ${E}`);
const promotionBlocked = await one(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'research.promotion_blocked' AND created_at >= ${S} AND created_at <= ${E}`);

// ── Research Agent state and the eligibility census, read from the authoritative staging rows ──
// This is the part that answers "is research actually paused" and "where does every record stand". It is read-only:
// nothing here writes, promotes or resumes anything.
const settings = (await q<Record<string, unknown>>(`SELECT paused, pause_reason, qualify_threshold, max_batch,
    COALESCE(auto_promote, -1) AS auto_promote, COALESCE(auto_promote_max_per_run, -1) AS auto_promote_max_per_run, updated_at
  FROM research_settings WHERE id = 1`))[0] ?? {};
const runners = await q<Record<string, unknown>>(`SELECT runner_id, version, last_seen_at, status_json FROM research_runners ORDER BY last_seen_at DESC LIMIT 10`);
const lastBatch = (await q<{ at: string | null; n: number }>(`SELECT MAX(received_at) AS at, COUNT(*) AS n FROM research_batches`))[0];
const recentBatches = await one(`SELECT COUNT(*) AS n FROM research_batches WHERE received_at >= ${lit(new Date(now.getTime() - 3600e3).toISOString())}`);
const threshold = Number(settings.qualify_threshold ?? 60);
const census: Record<string, number> = {};
for (const [key, sql] of Object.entries(censusQueries(threshold))) census[key] = await one(sql);
const crmResearchLeads = await one(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent'`);
const promotionRuns = await q<Record<string, unknown>>(`SELECT id, trigger, started_at, examined, promoted, existing_crm, review, suppressed, rejected, failed, remaining, stopped_reason
  FROM research_promotion_runs ORDER BY started_at DESC LIMIT 10`).catch(() => []);
// The research-qualified "today" figure, counted two ways: distinct businesses first seen today, and rows touched
// today. The difference is the heart of the "3,729 qualified today but 42 in the CRM" question.
const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
const qualifiedFirstSeenToday = await one(`SELECT COUNT(*) AS n FROM research_prospects WHERE qualified = 1 AND first_seen_at >= ${lit(dayStart)}`);
const qualifiedUpdatedToday = await one(`SELECT COUNT(*) AS n FROM research_prospects WHERE qualified = 1 AND updated_at >= ${lit(dayStart)}`);
const receivedToday = await one(`SELECT COALESCE(SUM(record_count),0) AS n FROM research_batches WHERE received_at >= ${lit(dayStart)}`);
const distinctBusinessesEverReceived = await one(`SELECT COUNT(DISTINCT business_key) AS n FROM research_prospects`);

const censusSum = ["alreadyPromoted", "existingCrm", "needsPerson", "suppressed", "dismissed", "notQualified"].reduce((a, k) => a + (census[k] ?? 0), 0)
  + (census.eligibleNow ?? 0) + (census.belowThreshold ?? 0) + (census.outOfAttempts ?? 0);

const state: string[] = [];
state.push(`## Research Agent state (authoritative staging rows)`);
state.push(`- research_settings.paused: **${settings.paused === 1 || settings.paused === "1" ? "PAUSED" : "NOT PAUSED"}** (raw ${String(settings.paused)})${settings.pause_reason ? ` — ${String(settings.pause_reason)}` : ""}`);
state.push(`- auto_promote: ${Number(settings.auto_promote) === -1 ? "column absent (migration 0073 not applied yet)" : Number(settings.auto_promote) === 1 ? "**ON**" : "OFF"}; max per run ${String(settings.auto_promote_max_per_run)}`);
state.push(`- qualify_threshold ${String(settings.qualify_threshold)}, max_batch ${String(settings.max_batch)}, settings last changed ${String(settings.updated_at)}`);
state.push(`- batches ever received: ${Number(lastBatch?.n ?? 0)}; last at ${lastBatch?.at ?? "never"}; **in the last hour: ${recentBatches}** (non-zero means research is still ingesting)`);
for (const r of runners) {
  let st: Record<string, unknown> = {};
  try { st = JSON.parse(String(r.status_json ?? "{}")) as Record<string, unknown>; } catch { st = {}; }
  const ageMin = r.last_seen_at ? Math.round((now.getTime() - Date.parse(String(r.last_seen_at))) / 60e3) : null;
  const plat = (st.platform && typeof st.platform === "object" ? st.platform : {}) as Record<string, unknown>;
  state.push(`- runner \`${String(r.runner_id)}\` v${String(r.version ?? "?")}: last check-in ${String(r.last_seen_at)} (${ageMin} min ago); worker reports paused=${String(st.paused)}, queue=${String(st.queueDepth)}, outbox=${String(st.outbox)}, records/hour=${String(st.recordsPerHour)}, model=${String(st.model)}, authFailed=${String(plat.authFailed)}`);
}
state.push("");
state.push(`## Eligibility census (every record accounted for)`);
for (const [k, v] of Object.entries(census)) state.push(`- ${k}: ${v}`);
state.push(`- CRM leads with origin research_agent: **${crmResearchLeads}**`);
state.push(`- distinct business_key on record: ${distinctBusinessesEverReceived}`);
state.push(`- accounted for by a status/reason: ${censusSum} of ${census.totalOnRecord} on record${censusSum === census.totalOnRecord ? " (reconciles)" : " (DOES NOT RECONCILE — investigate)"}`);
state.push(`- research-qualified today, distinct businesses FIRST SEEN today: ${qualifiedFirstSeenToday}`);
state.push(`- research-qualified rows TOUCHED today (re-evaluations included): ${qualifiedUpdatedToday}`);
state.push(`- records received in batches today (not distinct businesses): ${receivedToday}`);
state.push(`- promotion attempt cap per prospect: ${MAX_PROMOTE_ATTEMPTS}`);
if (promotionRuns.length) {
  state.push("");
  state.push(`## Promotion runs (most recent first)`);
  for (const r of promotionRuns) state.push(`- ${String(r.started_at)} ${String(r.trigger)}: examined ${String(r.examined)}, promoted ${String(r.promoted)}, existing ${String(r.existing_crm)}, review ${String(r.review)}, suppressed ${String(r.suppressed)}, rejected ${String(r.rejected)}, failed ${String(r.failed)}, remaining ${String(r.remaining)} (${String(r.stopped_reason)})`);
} else state.push(`\n## Promotion runs\n- none recorded (table empty or migration 0073 not applied yet)`);

const report = buildReport({ windowStart: startIso, windowEnd: endIso, now: now.toISOString(), target: TARGET, samples, batches, prospects, promoted, promotionBlocked });
const text = `${state.join("\n")}\n\n${formatReport(report)}`;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "research-24h-report.json"), JSON.stringify({ report, settings, census, crmResearchLeads, qualifiedFirstSeenToday, qualifiedUpdatedToday, receivedToday, recentBatches, runners, promotionRuns }, null, 2));
writeFileSync(join(OUT, "research-24h-report.md"), `${text}\n`);
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
// Exit 0 whichever way the run went: this is a measurement, and "the target was missed" is a valid result, not a
// script failure. Only an unreadable database should fail the command (an exception above).
