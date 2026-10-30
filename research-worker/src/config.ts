// Worker configuration from environment variables (set by windows/Install-ResearchWorker.ps1 from a protected
// settings file; the HMAC secret comes from a DPAPI-protected file, never the command line). Everything has a safe
// default except the platform URL and secret; validation refuses unsafe values (e.g. a non-loopback Ollama URL).
import { join } from "node:path";

export interface Config {
  platformUrl: string;           // https://<staging host> — staging first; production only after Founder approval
  secret: string;                // RESEARCH_RUNNER_SECRET (same value as the Worker secret)
  runnerId: string;
  dataDir: string;               // state DB, dataset snapshots, logs
  duckdbPath: string;            // DuckDB CLI executable (free, single binary)
  states: string[];              // US state codes to research, in order ([] = all)
  overture: { enabled: boolean; release: string | null; s3Base: string };
  foursquare: { enabled: boolean; parquetGlob: string | null };
  osm: { enabled: boolean; osmiumPath: string; pbfDir: string | null };
  commonCrawl: { enabled: boolean; crawlId: string | null; maxDomainsPerQuery: number; minQueryIntervalMs: number; dailyQueryBudget: number };
  http: { userAgent: string; timeoutMs: number; perHostIntervalMs: number; concurrency: number; maxBytes: number; brokenRecheckAfterMs: number; brokenAttempts: number };
  browser: { enabled: boolean };
  lighthouse: { path: string | null };
  model: { baseUrl: string; name: string | null; concurrency: number; timeoutMs: number; numCtx: number };
  pipeline: { backlogLimit: number; leaseMs: number; maxAttempts: number; batchFlushMs: number; heartbeatMs: number; reverifyAfterDays: number };
  healthPort: number;
}

const int = (v: string | undefined, d: number, min: number, max: number): number => {
  const n = v === undefined || v === "" ? d : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`expected an integer ${min}..${max}, got ${v}`);
  return n;
};
const on = (v: string | undefined, d: boolean) => (v === undefined || v === "" ? d : /^(1|on|yes|true)$/i.test(v));

/** Ollama must be reached on this machine only (never exposed, never a remote inference host). */
export function assertLoopback(url: string): void {
  const u = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname) || u.protocol !== "http:") {
    throw new Error(`OLLAMA_URL must be http on this machine (127.0.0.1/localhost), got ${u.host}: the local model is never reached over the network`);
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const errors: string[] = [];
  const platformUrl = (env.CRESTMONT_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(platformUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(platformUrl)) errors.push("CRESTMONT_URL must be the https origin of the Crestmont platform (staging first)");
  const secret = env.RESEARCH_RUNNER_SECRET ?? "";
  if (secret.length < 32) errors.push("RESEARCH_RUNNER_SECRET must be set (at least 32 characters, same value as the Worker secret)");
  const runnerId = env.RESEARCH_RUNNER_ID ?? "workstation-1";
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(runnerId)) errors.push("RESEARCH_RUNNER_ID must be 1-64 characters of [A-Za-z0-9._:-]");
  const dataDir = env.RESEARCH_DATA_DIR ?? join(process.cwd(), "data");
  const states = (env.RESEARCH_STATES ?? "").split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (states.some((s) => !/^[A-Z]{2}$/.test(s))) errors.push("RESEARCH_STATES must be comma-separated two-letter state codes");
  const modelUrl = env.OLLAMA_URL ?? "http://127.0.0.1:11434";
  try { assertLoopback(modelUrl); } catch (e) { errors.push((e as Error).message); }
  const release = env.OVERTURE_RELEASE ?? null;
  if (release && !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release)) errors.push("OVERTURE_RELEASE looks like 2026-10-21.0");
  const crawlId = env.COMMON_CRAWL_ID ?? null;
  if (crawlId && !/^CC-MAIN-\d{4}-\d{2}$/.test(crawlId)) errors.push("COMMON_CRAWL_ID looks like CC-MAIN-2026-40");
  let cfg: Config | null = null;
  try {
    cfg = {
      platformUrl, secret, runnerId, dataDir, states,
      duckdbPath: env.DUCKDB_PATH ?? "duckdb",
      overture: { enabled: on(env.OVERTURE, true), release, s3Base: env.OVERTURE_S3_BASE ?? "s3://overturemaps-us-west-2/release" },
      foursquare: { enabled: on(env.FOURSQUARE_OS, false), parquetGlob: env.FOURSQUARE_PARQUET_GLOB ?? null },
      osm: { enabled: on(env.OSM, false), osmiumPath: env.OSMIUM_PATH ?? "osmium", pbfDir: env.OSM_PBF_DIR ?? null },
      commonCrawl: {
        enabled: on(env.COMMON_CRAWL, true), crawlId,
        maxDomainsPerQuery: int(env.CC_DOMAINS_PER_QUERY, 50, 1, 500),
        minQueryIntervalMs: int(env.CC_QUERY_INTERVAL_MS, 60_000, 5_000, 3_600_000),
        dailyQueryBudget: int(env.CC_DAILY_QUERIES, 200, 0, 10_000),
      },
      http: {
        userAgent: env.RESEARCH_USER_AGENT ?? "CrestmontResearchBot/0.1 (+https://crestmontwebsitedevelopment.com; support@crestmontwebsitedevelopment.com)",
        timeoutMs: int(env.HTTP_TIMEOUT_MS, 15_000, 2_000, 120_000),
        perHostIntervalMs: int(env.HTTP_PER_HOST_INTERVAL_MS, 5_000, 1_000, 600_000),
        concurrency: int(env.HTTP_CONCURRENCY, 24, 1, 256),
        maxBytes: int(env.HTTP_MAX_BYTES, 3_000_000, 100_000, 20_000_000),
        brokenRecheckAfterMs: int(env.BROKEN_RECHECK_AFTER_MS, 6 * 3600_000, 60_000, 7 * 86400_000),
        brokenAttempts: int(env.BROKEN_ATTEMPTS, 2, 1, 5),
      },
      browser: { enabled: on(env.PLAYWRIGHT, false) },
      lighthouse: { path: env.LIGHTHOUSE_PATH ?? null },
      model: {
        baseUrl: modelUrl.replace(/\/+$/, ""), name: env.RESEARCH_MODEL ?? null,
        concurrency: int(env.MODEL_CONCURRENCY, 2, 1, 16), timeoutMs: int(env.MODEL_TIMEOUT_MS, 90_000, 5_000, 600_000), numCtx: int(env.MODEL_NUM_CTX, 8192, 2048, 131072),
      },
      pipeline: {
        backlogLimit: int(env.BACKLOG_LIMIT, 50_000, 100, 5_000_000), leaseMs: int(env.LEASE_MS, 10 * 60_000, 30_000, 3600_000),
        maxAttempts: int(env.MAX_ATTEMPTS, 4, 1, 20), batchFlushMs: int(env.BATCH_FLUSH_MS, 120_000, 5_000, 3600_000),
        heartbeatMs: int(env.HEARTBEAT_MS, 60_000, 10_000, 600_000), reverifyAfterDays: int(env.REVERIFY_AFTER_DAYS, 30, 1, 365),
      },
      healthPort: int(env.HEALTH_PORT, 8789, 1024, 65535),
    };
  } catch (e) { errors.push((e as Error).message); }
  if (errors.length) throw new Error(`Invalid research worker configuration:\n - ${errors.join("\n - ")}`);
  return cfg!;
}
