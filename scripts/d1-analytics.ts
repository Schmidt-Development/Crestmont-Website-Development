// Which queries consumed the staging D1 budget in a time window: Cloudflare's own per-query analytics, read-only.
//
// Why this exists. Staging deploy #160 (2026-11-05) failed its late sweeps on bursts of 500s. app_errors recorded
//   "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window"
// for /services/booking-scheduling — a trivial public page that runs ONE indexed lookup (loadContent). That fits a
// shared budget being exhausted by something else far better than an expensive page, but one row cannot say WHAT.
// Every other instrument we have looks at the Worker; this one asks D1 itself which statements did the reading.
//
// Coverage is stated, never implied (the lesson of four instruments that failed quietly on their first run):
//   · cannot_read   — the token may not read analytics, or the API failed: says NOTHING about the cause;
//   · schema_error  — Cloudflare refused the query shape: printed verbatim, says nothing about the cause;
//   · empty         — analytics answered but holds nothing for the window (it can lag by minutes): not "D1 was idle";
//   · ok            — totals per minute and the top statements by duration and by rows read.
// Statements are printed with every string and number literal masked, then through redact(): the repository and its
// workflow logs are public (F-18/F-19), and an E2E's INSERT can carry literal values.
//
// Usage: CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node --no-warnings scripts/d1-analytics.ts \
//          --database crestmont-staging --from 2026-11-05T21:30:00Z --to 2026-11-05T22:10:00Z [--top 15]
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { redact } from "../src/services/monitoring.ts";

type Fetch = typeof fetch;
const API = "https://api.cloudflare.com/client/v4";

export interface QueryGroup { query: string; count: number; durationMs: number; rowsRead: number; rowsWritten: number }
export interface Minute { minute: string; readQueries: number; writeQueries: number; rowsRead: number; rowsWritten: number }
export type Result =
  | { state: "cannot_read" | "schema_error"; detail: string }
  | { state: "empty"; detail: string }
  | { state: "ok"; minutes: Minute[] | null; minutesNote: string | null; byDuration: QueryGroup[]; byRowsRead: QueryGroup[] };

/** SQL with every literal masked, so a statement can be shown without the values it carried. */
export function maskSql(sql: string): string {
  return redact(sql
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/x'[0-9a-f]*'/gi, "x'?'")
    .replace(/(?<![\w$.?])-?\d+(?:\.\d+)?(?![\w$])/g, "?")
    .replace(/\s+/g, " ")
    .trim()).slice(0, 400);
}

async function gql(f: Fetch, token: string, query: string, variables: Record<string, unknown>) {
  const res = await f(`${API}/graphql`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const text = await res.text();
  let body: { data?: any; errors?: { message?: string }[] | null } = {};
  try { body = JSON.parse(text); } catch { /* reported below */ }
  return { status: res.status, body, text };
}

const authLike = (m: string) => /not authori[sz]ed|unauthori[sz]ed|permission|forbidden|authentication|access denied/i.test(m);

const QUERIES = `query($a: String!, $db: String!, $from: Time!, $to: Time!, $n: Int!) { viewer { accounts(filter: { accountTag: $a }) {
  byDuration: d1QueriesAdaptiveGroups(limit: $n, filter: { databaseId: $db, datetime_geq: $from, datetime_leq: $to }, orderBy: [sum_queryDurationMs_DESC]) {
    count sum { queryDurationMs rowsRead rowsWritten } dimensions { query } }
  byRowsRead: d1QueriesAdaptiveGroups(limit: $n, filter: { databaseId: $db, datetime_geq: $from, datetime_leq: $to }, orderBy: [sum_rowsRead_DESC]) {
    count sum { queryDurationMs rowsRead rowsWritten } dimensions { query } } } } }`;

const MINUTES = `query($a: String!, $db: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
  d1AnalyticsAdaptiveGroups(limit: 1000, filter: { databaseId: $db, datetimeMinute_geq: $from, datetimeMinute_leq: $to }, orderBy: [datetimeMinute_ASC]) {
    sum { readQueries writeQueries rowsRead rowsWritten } dimensions { datetimeMinute } } } } }`;

const groups = (xs: any[] | undefined): QueryGroup[] => (xs ?? []).map((g) => ({
  query: maskSql(String(g?.dimensions?.query ?? "")), count: Number(g?.count ?? 0),
  durationMs: Math.round(Number(g?.sum?.queryDurationMs ?? 0)), rowsRead: Number(g?.sum?.rowsRead ?? 0), rowsWritten: Number(g?.sum?.rowsWritten ?? 0),
}));

export async function analyse(opts: { token: string; account: string; database: string; from: string; to: string; top?: number; fetch?: Fetch }): Promise<Result> {
  const f = opts.fetch ?? fetch;
  // The database id: the staging id is resolved at deploy time, not committed, so look it up by name.
  let dbId = /^[0-9a-f-]{36}$/i.test(opts.database) ? opts.database : "";
  if (!dbId) {
    try {
      const r = await f(`${API}/accounts/${opts.account}/d1/database?name=${encodeURIComponent(opts.database)}`, { headers: { authorization: `Bearer ${opts.token}` } });
      const j = await r.json().catch(() => ({})) as { result?: { name?: string; uuid?: string }[] };
      dbId = j.result?.find((d) => d.name === opts.database)?.uuid ?? "";
      if (!dbId) return { state: "cannot_read", detail: `could not resolve database "${opts.database}" (HTTP ${r.status})` };
    } catch (e) { return { state: "cannot_read", detail: `database lookup failed: ${(e as Error).message}` }; }
  }
  const vars = { a: opts.account, db: dbId, from: opts.from, to: opts.to, n: opts.top ?? 15 };
  let q;
  try { q = await gql(f, opts.token, QUERIES, vars); } catch (e) { return { state: "cannot_read", detail: `analytics API unreachable: ${(e as Error).message}` }; }
  const errs = (q.body.errors ?? []).map((e) => e?.message ?? "").filter(Boolean);
  if (q.status === 401 || q.status === 403 || errs.some(authLike)) return { state: "cannot_read", detail: `HTTP ${q.status}: ${redact(errs.join("; ") || q.text.slice(0, 300))} — the token probably lacks Account Analytics: Read` };
  if (errs.length || !q.body.data) return { state: "schema_error", detail: `HTTP ${q.status}: ${redact(errs.join("; ") || q.text.slice(0, 300))}` };
  const acct = q.body.data?.viewer?.accounts?.[0];
  const byDuration = groups(acct?.byDuration), byRowsRead = groups(acct?.byRowsRead);
  if (!byDuration.length && !byRowsRead.length) return { state: "empty", detail: `analytics answered but recorded no statements for ${opts.from} → ${opts.to}; it can lag by several minutes. This is NOT evidence that D1 was idle.` };
  // The per-minute timeline is a second, optional view: its failure is reported, never allowed to hide the statements.
  let minutes: Minute[] | null = null, minutesNote: string | null = null;
  try {
    const m = await gql(f, opts.token, MINUTES, vars);
    const me = (m.body.errors ?? []).map((e) => e?.message ?? "").filter(Boolean);
    if (me.length || !m.body.data) minutesNote = `per-minute view unavailable: ${redact(me.join("; ") || `HTTP ${m.status}`)}`;
    else minutes = (m.body.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? []).map((g: any) => ({
      minute: String(g?.dimensions?.datetimeMinute ?? ""), readQueries: Number(g?.sum?.readQueries ?? 0), writeQueries: Number(g?.sum?.writeQueries ?? 0),
      rowsRead: Number(g?.sum?.rowsRead ?? 0), rowsWritten: Number(g?.sum?.rowsWritten ?? 0),
    }));
  } catch (e) { minutesNote = `per-minute view unavailable: ${(e as Error).message}`; }
  return { state: "ok", minutes, minutesNote, byDuration, byRowsRead };
}

export function render(r: Result, from: string, to: string): string {
  const head = `D1 analytics ${from} → ${to}`;
  if (r.state !== "ok") return `${head}\nCOVERAGE: ${r.state}. ${r.detail}${r.state === "empty" ? "" : "\nThis says nothing about what consumed the budget."}`;
  const table = (gs: QueryGroup[]) => gs.map((g) => `  ${String(g.durationMs).padStart(8)} ms  ${String(g.rowsRead).padStart(10)} read  ${String(g.rowsWritten).padStart(7)} written  ${String(g.count).padStart(6)}×  ${g.query}`).join("\n");
  const out = [head, "COVERAGE: ok (Cloudflare's per-statement analytics for this database and window)"];
  if (r.minutes) out.push("Per minute (read q / write q / rows read / rows written):", ...r.minutes.map((m) => `  ${m.minute}  ${m.readQueries} / ${m.writeQueries} / ${m.rowsRead} / ${m.rowsWritten}`));
  else if (r.minutesNote) out.push(r.minutesNote);
  out.push("Top statements by total duration:", table(r.byDuration), "Top statements by rows read:", table(r.byRowsRead));
  return out.join("\n");
}

const entry = (() => { try { return realpathSync(process.argv[1] ?? ""); } catch { return ""; } })();
if (entry === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "", account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const to = arg("to") ?? new Date().toISOString(), from = arg("from") ?? new Date(Date.parse(to) - 3_600_000).toISOString();
  for (const t of [from, to]) if (Number.isNaN(Date.parse(t))) { console.error(`not a time: ${t}`); process.exit(2); }
  if (!token || !account) { console.log(render({ state: "cannot_read", detail: "CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID not set" }, from, to)); process.exit(0); }
  const r = await analyse({ token, account, database: arg("database") ?? "crestmont-staging", from: new Date(from).toISOString(), to: new Date(to).toISOString(), top: Number(arg("top") ?? 15) });
  console.log(render(r, from, to));
  if (process.env.GITHUB_STEP_SUMMARY) { const { appendFileSync } = await import("node:fs"); appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + render(r, from, to) + "\n```\n"); }
}
