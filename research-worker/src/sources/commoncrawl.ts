// Common Crawl as website-DISCOVERY EVIDENCE only: "was this candidate domain captured in crawl X, and with which HTTP
// status?" Terms of use: no republishing of crawl content, no reselling access. The CDX API is heavily rate-limited, so
// this uses the columnar (Parquet) URL index over HTTPS (data.commoncrawl.org, no account), batches many domains per
// query, waits between queries, caps queries per day, and caches every answer per domain and crawl. It never fetches
// page content (WARC) and never guesses a domain from a business name.
import type { SqlRunner } from "../duckdb.ts";
import { lit, csvColumn } from "../duckdb.ts";
import type { State } from "../state.ts";
import type { Logger } from "../log.ts";

const BASE = "https://data.commoncrawl.org";
export interface CcEvidence { domain: string; crawl: string; captures: number; lastStatus: number | null; lastFetch: string | null }

/** SURT host prefix used to prune the index by its sort key: "example.com" → "com,example)". */
export const surt = (domain: string) => `${domain.split(".").reverse().join(",")})`;

export function indexQuery(crawl: string, files: string[], domains: string[]): string {
  // Range predicates on url_surtkey let DuckDB skip row groups via Parquet min/max statistics.
  const ranges = domains.map((d) => `(url_surtkey >= ${lit(surt(d))} AND url_surtkey < ${lit(surt(d) + "￿")})`).join(" OR ");
  return `SELECT url_host_registered_domain || '|' || COUNT(*) || '|' || coalesce(CAST(arg_max(fetch_status, fetch_time) AS VARCHAR), '') || '|' || coalesce(CAST(max(fetch_time) AS VARCHAR), '')
    FROM read_parquet([${files.map(lit).join(",")}]) WHERE (${ranges}) AND url_host_registered_domain IN (${domains.map(lit).join(",")}) GROUP BY url_host_registered_domain;`;
}

export class CommonCrawl {
  private lastQueryAt = 0;
  private queriesToday = 0;
  private day = "";
  private files: string[] | null = null;
  private readonly db: SqlRunner;
  private readonly state: State;
  private readonly log: Logger;
  private readonly opts: { crawl: string; maxDomainsPerQuery: number; minQueryIntervalMs: number; dailyQueryBudget: number; fetchText: (url: string) => Promise<string> };
  constructor(db: SqlRunner, state: State, log: Logger, opts: CommonCrawl["opts"]) { this.db = db; this.state = state; this.log = log; this.opts = opts; }

  /** The crawl's columnar index file list (cc-index-table.paths.gz is fetched once per crawl, gunzipped by the caller). */
  private async indexFiles(): Promise<string[]> {
    if (this.files) return this.files;
    const list = await this.opts.fetchText(`${BASE}/crawl-data/${this.opts.crawl}/cc-index-table.paths.gz`);
    this.files = list.split(/\r?\n/).filter((p) => /subset=warc\/.+\.parquet$/.test(p)).map((p) => `${BASE}/${p}`);
    if (!this.files.length) throw new Error(`No columnar index files listed for ${this.opts.crawl}`);
    return this.files;
  }

  /** Cached answers immediately; uncached domains are looked up in one throttled batch when the budget allows. */
  async lookup(domains: string[], now = Date.now()): Promise<Map<string, CcEvidence>> {
    const out = new Map<string, CcEvidence>();
    const todo: string[] = [];
    for (const d of [...new Set(domains)]) {
      const c = this.state.ccGet(d, this.opts.crawl);
      if (c) out.set(d, { domain: d, crawl: this.opts.crawl, captures: c.captures, lastStatus: c.last_status, lastFetch: c.last_fetch });
      else todo.push(d);
    }
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.queriesToday = 0; }
    if (!todo.length || this.queriesToday >= this.opts.dailyQueryBudget || now - this.lastQueryAt < this.opts.minQueryIntervalMs) return out;
    const batch = todo.slice(0, this.opts.maxDomainsPerQuery);
    this.lastQueryAt = now; this.queriesToday++;
    try {
      const rows = csvColumn(await this.db.exec(`INSTALL httpfs; LOAD httpfs; SET enable_http_metadata_cache = true; SET http_retries = 3; SET http_retry_wait_ms = 2000; SET http_retry_backoff = 4;\n${indexQuery(this.opts.crawl, await this.indexFiles(), batch)}`, { timeoutMs: 1800_000 }));
      const found = new Map(rows.map((r) => { const [d, n, s, t] = r.split("|"); return [d, { captures: Number(n), status: s ? Number(s) : null, fetch: t || null }] as const; }));
      for (const d of batch) {
        const f = found.get(d);
        this.state.ccPut(d, this.opts.crawl, f?.captures ?? 0, f?.status ?? null, f?.fetch ?? null);
        out.set(d, { domain: d, crawl: this.opts.crawl, captures: f?.captures ?? 0, lastStatus: f?.status ?? null, lastFetch: f?.fetch ?? null });
      }
    } catch (e) {
      // 503 "Slow Down" or blocked: back off for the rest of the interval window x10; the pipeline proceeds without CC evidence.
      this.lastQueryAt = now + this.opts.minQueryIntervalMs * 10;
      this.log.warn("common crawl lookup failed; continuing without it", { error: (e as Error).message.slice(0, 300) });
    }
    return out;
  }
}
