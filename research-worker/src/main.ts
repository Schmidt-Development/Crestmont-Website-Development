// Entry point. `node src/main.ts` runs continuously; `--preflight` checks every dependency and the platform
// connection, prints a report and exits (0 = ready). Started on Windows by the scheduled task that
// windows/Install-ResearchWorker.ps1 creates (at startup, restart on failure).
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadConfig } from "./config.ts";
import { createLogger, registerSecret, errMsg } from "./log.ts";
import { State } from "./state.ts";
import { Http } from "./http.ts";
import { Platform } from "./crm-client.ts";
import { DuckDbCli, csvColumn } from "./duckdb.ts";
import { OvertureSource } from "./sources/overture.ts";
import { FoursquareSource } from "./sources/foursquare.ts";
import { OsmSource } from "./sources/osm.ts";
import { CommonCrawl } from "./sources/commoncrawl.ts";
import { Browser } from "./browser.ts";
import { LocalModel } from "./model.ts";
import { ResearchWorker, VERSION } from "./orchestrator.ts";
import type { SourceAdapter } from "./sources/types.ts";

const log = createLogger({ level: (process.env.LOG_LEVEL as "info") ?? "info" });

async function latestCrawl(): Promise<string> {
  const r = await fetch("https://index.commoncrawl.org/collinfo.json", { signal: AbortSignal.timeout(20_000) });
  const j = await r.json() as { id: string }[];
  const id = j.map((x) => x.id).find((x) => /^CC-MAIN-\d{4}-\d{2}$/.test(x));
  if (!id) throw new Error("no crawl id in collinfo.json");
  return id;
}

async function main() {
  const preflight = process.argv.includes("--preflight");
  const cfg = loadConfig();
  registerSecret(cfg.secret);
  const state = new State(join(cfg.dataDir, "state.sqlite"));
  const duck = new DuckDbCli(cfg.duckdbPath);
  const http = new Http({ userAgent: cfg.http.userAgent, robotsToken: "CrestmontResearchBot", timeoutMs: cfg.http.timeoutMs, perHostIntervalMs: cfg.http.perHostIntervalMs, concurrency: cfg.http.concurrency, maxBytes: cfg.http.maxBytes });
  const platform = new Platform(cfg.platformUrl, cfg.secret);
  const report: Record<string, string> = {};

  try { report.duckdb = csvColumn(await duck.exec("SELECT version();", { timeoutMs: 20_000 }))[0] ?? "?"; } catch (e) { report.duckdb = `MISSING: ${errMsg(e)}`; }
  const sources: SourceAdapter[] = [];
  if (cfg.overture.enabled) sources.push(new OvertureSource(duck, { base: cfg.overture.s3Base, release: cfg.overture.release, dataDir: cfg.dataDir, log }));
  if (cfg.foursquare.enabled) {
    if (cfg.foursquare.parquetGlob) sources.push(new FoursquareSource(duck, { parquetGlob: cfg.foursquare.parquetGlob, dataDir: cfg.dataDir }));
    else report.foursquare = "enabled but FOURSQUARE_PARQUET_GLOB is not set (download needs the Founder's Foursquare access)";
  }
  if (cfg.osm.enabled) {
    if (cfg.osm.pbfDir) sources.push(new OsmSource({ osmiumPath: cfg.osm.osmiumPath, pbfDir: cfg.osm.pbfDir, dataDir: cfg.dataDir }));
    else report.osm = "enabled but OSM_PBF_DIR is not set";
  }
  report.sources = sources.map((s) => s.id).join(", ") || "none";

  let cc: CommonCrawl | null = null;
  if (cfg.commonCrawl.enabled) {
    try {
      const crawl = cfg.commonCrawl.crawlId ?? await latestCrawl();
      cc = new CommonCrawl(duck, state, log, { crawl, maxDomainsPerQuery: cfg.commonCrawl.maxDomainsPerQuery, minQueryIntervalMs: cfg.commonCrawl.minQueryIntervalMs, dailyQueryBudget: cfg.commonCrawl.dailyQueryBudget,
        fetchText: async (url) => { const r = await fetch(url, { headers: { "user-agent": cfg.http.userAgent }, signal: AbortSignal.timeout(120_000) }); if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`); return gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8"); } });
      report.commonCrawl = crawl;
    } catch (e) { report.commonCrawl = `unavailable (${errMsg(e)}); verification continues without it`; }
  } else report.commonCrawl = "off";

  let model: LocalModel | null = null;
  if (cfg.model.name) {
    model = new LocalModel({ baseUrl: cfg.model.baseUrl, name: cfg.model.name, timeoutMs: cfg.model.timeoutMs, numCtx: cfg.model.numCtx, concurrency: cfg.model.concurrency });
    const problem = await model.preflight();
    report.model = problem ? `OFF: ${problem}` : `${cfg.model.name} via ${cfg.model.baseUrl}`;
    if (problem) model = null;
  } else report.model = "off (set RESEARCH_MODEL to an Ollama model you have pulled; drafts are optional)";

  const browser = cfg.browser.enabled ? await Browser.open(cfg.http.userAgent) : null;
  report.browser = browser ? "Playwright Chromium" : cfg.browser.enabled ? "not installed (HTML-only audits): npm i -g playwright && npx playwright install chromium" : "off";
  report.lighthouse = cfg.lighthouse.path ?? "off";

  try {
    const c = await platform.heartbeat(cfg.runnerId, VERSION, { preflight: true });
    report.platform = `connected to ${cfg.platformUrl}; ${c.paused ? `PAUSED (${c.pauseReason ?? ""})` : "running"}; enabled sources: ${c.enabledSources.join(", ")}`;
  } catch (e) { report.platform = `FAILED: ${errMsg(e)}`; }

  log.info("preflight", report);
  if (preflight) {
    await browser?.close(); state.close();
    const fatal = /MISSING|FAILED/.test(`${report.duckdb} ${report.platform}`);
    process.exit(fatal ? 1 : 0);
  }

  const worker = new ResearchWorker({ cfg, state, http, platform, sources, cc, browser, model, log });
  const ac = new AbortController();
  const stop = (sig: string) => { if (!ac.signal.aborted) { log.info("shutting down", { signal: sig }); ac.abort(); } };
  for (const s of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(s, () => stop(s));
  await worker.run(ac.signal);
  await browser?.close();
  state.close();
  log.info("stopped");
}

main().catch((e) => { log.error("fatal", { error: errMsg(e) }); process.exit(1); });
