// Environment error-rate and latency evidence (READY-006, §43).
//
// Two real sources feed the environment views:
//  1. First-party request metrics: src/app/app.ts calls recordRequestMetric() once per request (in
//     waitUntil on Cloudflare, so the response is not delayed). Each call is ONE UPSERT into the hourly
//     bucket row of (environment, hour, area). No PII: no path, id, IP, user or query is stored.
//  2. External response times: scripts/production-checks.ts samples fixed public pages after each deploy
//     and ships p50/p95/max with its evidence document; ingestEvidence() stores them in env_latency.
// When neither source has data the views say "Unknown" — never 0.
import type { Db } from "../lib/db.ts";

export type MetricArea = "api" | "staff" | "portal" | "live" | "site";
export const DURATION_BUCKETS = [100, 300, 1000, 3000] as const; // upper bounds (ms); the last bucket is > 3000

/** Coarse area of a request path. Deliberately lossy: never a full path, never an id. */
export function metricArea(pathname: string): MetricArea {
  const first = pathname.split("/")[1] ?? "";
  return first === "api" || first === "staff" || first === "portal" || first === "live" ? first : "site";
}

export const hourBucket = (d: Date) => d.toISOString().slice(0, 13);

/** `weight`: how many requests this row stands for (1/sample rate for a sampled request; 1 for errors). Default 1. */
export interface RequestMetric { environment: string; pathname: string; status: number; durationMs: number; unhandled: boolean; at: Date; weight?: number }

/** Crawlers, link previews, uptime probes and scripted clients (CREST-GAP-066). Not user traffic; never written. */
export const BOT_UA = /bot[\/;-]|\bbot\b|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|preview|headless|lighthouse|pingdom|uptime|monitor|curl\/|wget\/|python-requests|python-urllib|go-http-client|okhttp|httpclient|axios\/|node-fetch|libwww|scrapy|ahrefs|semrush|mj12|dotbot|petalbot|yandex|baiduspider|duckduckgo|applebot|gptbot|claudebot|ccbot|bytespider/i;
export const DEFAULT_METRICS_SAMPLE = 0.1;

/**
 * How many requests one env_metrics write should count for, or 0 for no write (CREST-GAP-066: on public staging every
 * crawler hit used to cost a D1 write). Asset paths and known bot user agents are never written. Every 5xx / unhandled
 * error is written with weight 1 (errors stay exact). Other requests are kept with probability ENV_METRICS_SAMPLE
 * (default 0.1) and weight 1/sample, so request totals and the error rate remain unbiased estimates.
 */
export function metricWeight(r: { pathname: string; userAgent: string | null; status: number; unhandled: boolean; sample?: string; random?: () => number }): number {
  if (r.pathname.startsWith("/assets/") || r.pathname === "/favicon.ico") return 0;
  if (r.userAgent && BOT_UA.test(r.userAgent)) return 0;
  if (r.status >= 500 || r.unhandled) return 1;
  const parsed = r.sample === undefined || r.sample.trim() === "" ? DEFAULT_METRICS_SAMPLE : Number(r.sample);
  const p = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : DEFAULT_METRICS_SAMPLE;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return (r.random ?? Math.random)() < p ? Math.round(1 / p) : 0;
}

/** One UPSERT per request. Never throws: metrics must never turn a response into an error. */
export async function recordRequestMetric(db: Db, m: RequestMetric): Promise<void> {
  if (m.environment !== "development" && m.environment !== "staging" && m.environment !== "production") return;
  const ms = Math.max(0, Math.round(Number.isFinite(m.durationMs) ? m.durationMs : 0));
  const w = Math.max(1, Math.round(m.weight ?? 1));
  const b = [ms <= 100, ms > 100 && ms <= 300, ms > 300 && ms <= 1000, ms > 1000 && ms <= 3000, ms > 3000].map((x) => (x ? w : 0));
  const err = m.status >= 500 ? w : 0, unh = m.unhandled ? w : 0;
  try {
    await db.prepare(`INSERT INTO env_metrics (environment, hour, area, requests, errors_5xx, unhandled, duration_ms_sum, duration_ms_max, le_100, le_300, le_1000, le_3000, gt_3000)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(environment, hour, area) DO UPDATE SET requests = requests + excluded.requests, errors_5xx = errors_5xx + excluded.errors_5xx, unhandled = unhandled + excluded.unhandled,
        duration_ms_sum = duration_ms_sum + excluded.duration_ms_sum, duration_ms_max = MAX(duration_ms_max, excluded.duration_ms_max),
        le_100 = le_100 + excluded.le_100, le_300 = le_300 + excluded.le_300, le_1000 = le_1000 + excluded.le_1000, le_3000 = le_3000 + excluded.le_3000, gt_3000 = gt_3000 + excluded.gt_3000`)
      .bind(m.environment, hourBucket(m.at), metricArea(m.pathname), w, err, unh, ms * w, ms, ...b).run();
  } catch { /* metrics table unavailable (legacy database); the request itself is unaffected */ }
}

export interface ErrorRateSummary {
  since: string; hours: number;
  requests: number; errors5xx: number; unhandled: number;
  /** errors5xx / requests, as a fraction. */
  errorRate: number;
  avgMs: number; maxMs: number;
  /** Upper bound of the histogram bucket containing the percentile (null = above 3000 ms). */
  p50UpperMs: number | null; p95UpperMs: number | null;
  byArea: { area: MetricArea; requests: number; errors5xx: number; unhandled: number }[];
}

/** Last `hours` hours of first-party metrics for an environment, or null when nothing was recorded (= Unknown). */
export async function errorRateSummary(db: Db, environment: string, now: Date, hours = 24): Promise<ErrorRateSummary | null> {
  const sinceHour = hourBucket(new Date(now.getTime() - (hours - 1) * 3_600_000));
  type Row = { area: MetricArea; requests: number; errors_5xx: number; unhandled: number; duration_ms_sum: number; duration_ms_max: number; le_100: number; le_300: number; le_1000: number; le_3000: number; gt_3000: number };
  let rows: Row[];
  try {
    rows = (await db.prepare(`SELECT area, SUM(requests) requests, SUM(errors_5xx) errors_5xx, SUM(unhandled) unhandled, SUM(duration_ms_sum) duration_ms_sum, MAX(duration_ms_max) duration_ms_max,
        SUM(le_100) le_100, SUM(le_300) le_300, SUM(le_1000) le_1000, SUM(le_3000) le_3000, SUM(gt_3000) gt_3000
      FROM env_metrics WHERE environment = ? AND hour >= ? GROUP BY area ORDER BY area`).bind(environment, sinceHour).all<Row>()).results;
  } catch { return null; }
  const requests = rows.reduce((s, r) => s + r.requests, 0);
  if (!requests) return null;
  const sum = (k: keyof Row) => rows.reduce((s, r) => s + (r[k] as number), 0);
  const buckets = [sum("le_100"), sum("le_300"), sum("le_1000"), sum("le_3000"), sum("gt_3000")];
  const pct = (p: number): number | null => {
    const rank = Math.ceil(p * requests);
    let acc = 0;
    for (let i = 0; i < buckets.length; i++) { acc += buckets[i]; if (acc >= rank) return i < DURATION_BUCKETS.length ? DURATION_BUCKETS[i] : null; }
    return null;
  };
  const errors5xx = sum("errors_5xx");
  return {
    since: `${sinceHour}:00:00Z`, hours, requests, errors5xx, unhandled: sum("unhandled"), errorRate: errors5xx / requests,
    avgMs: Math.round(sum("duration_ms_sum") / requests), maxMs: rows.reduce((m, r) => Math.max(m, r.duration_ms_max), 0),
    p50UpperMs: pct(0.5), p95UpperMs: pct(0.95),
    byArea: rows.map((r) => ({ area: r.area, requests: r.requests, errors5xx: r.errors_5xx, unhandled: r.unhandled })),
  };
}

// ───────────── External response-time samples ─────────────

export interface PageTiming { page: string; samples: number; failed: number; p50Ms?: number; p95Ms?: number; maxMs?: number }

/** Nearest-rank percentile of a non-empty sample list. */
export function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Summary of one page's timing samples (durations of successful requests only; failures are counted). */
export function summarizeSamples(page: string, okDurationsMs: number[], failed: number): PageTiming {
  const s = [...okDurationsMs].map((x) => Math.max(0, Math.round(x))).sort((a, b) => a - b);
  const base = { page, samples: s.length + failed, failed };
  return s.length ? { ...base, p50Ms: nearestRank(s, 0.5), p95Ms: nearestRank(s, 0.95), maxMs: s[s.length - 1] } : base;
}

export interface LatencyRun { runId: string; measuredAt: string; commitSha: string; pages: { page: string; samples: number; failed: number; p50: number | null; p95: number | null; max: number | null }[] }

/** Latest ingested external timing run for an environment, or null (= Unknown). */
export async function latestLatency(db: Db, environment: string): Promise<LatencyRun | null> {
  try {
    const run = await db.prepare(`SELECT l.run_id, l.measured_at, r.commit_sha FROM env_latency l JOIN evidence_runs r ON r.id = l.run_id
      WHERE l.environment = ? ORDER BY l.measured_at DESC, l.run_id DESC LIMIT 1`).bind(environment).first<{ run_id: string; measured_at: string; commit_sha: string }>();
    if (!run) return null;
    const pages = (await db.prepare(`SELECT page, samples, failed_samples, p50_ms, p95_ms, max_ms FROM env_latency WHERE run_id = ? ORDER BY page`).bind(run.run_id)
      .all<{ page: string; samples: number; failed_samples: number; p50_ms: number | null; p95_ms: number | null; max_ms: number | null }>()).results;
    return { runId: run.run_id, measuredAt: run.measured_at, commitSha: run.commit_sha, pages: pages.map((p) => ({ page: p.page, samples: p.samples, failed: p.failed_samples, p50: p.p50_ms, p95: p.p95_ms, max: p.max_ms })) };
  } catch { return null; }
}
