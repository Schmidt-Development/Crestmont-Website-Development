// Controlled REAL-DATA research run (Phase 5): Overture places inside a small bounding box, the businesses' real
// websites (robots.txt honoured, polite per-host pacing), real Common Crawl index evidence, and ingestion into the real
// platform pipeline (src/app/app.ts with real migrations on in-memory SQLite: NOT staging). Two CRM controls are seeded
// from the sample to prove duplicate and do-not-call protection on real records; they are labelled TEST DATA.
//
// Output (the repository is PUBLIC, so only aggregates are printed):
//   <out>/summary.json   aggregate counts and timings (safe to publish)
//   <out>/details.json   per-business evidence and outcome   (sealed by the workflow; never printed)
//   <out>/review.md      manual-review sheet for the Founder   (sealed by the workflow; never printed)
//
//   node --no-warnings research-worker/live/live-sample.ts --request research-worker/live/request.json --out live-out
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { createTestApp, createStaff } from "../../tests/support/app.ts";
import { handle } from "../../src/app/app.ts";
import { addDnc } from "../../src/services/voice-outbound.ts";
import * as R from "../../src/services/research.ts";
import { State } from "../src/state.ts";
import { loadConfig } from "../src/config.ts";
import { Http } from "../src/http.ts";
import { Platform } from "../src/crm-client.ts";
import { DuckDbCli } from "../src/duckdb.ts";
import { OvertureSource, validBbox, type Bbox } from "../src/sources/overture.ts";
import { CommonCrawl } from "../src/sources/commoncrawl.ts";
import { ResearchWorker } from "../src/orchestrator.ts";
import { silentLogger, createLogger } from "../src/log.ts";
import { snapshot } from "../src/resources.ts";
import type { SqliteDb } from "../../dev/sqlite-d1.ts";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const req = JSON.parse(readFileSync(arg("request", "research-worker/live/request.json")!, "utf8")) as { bbox: Bbox; limit: number; brokenRecheckMinutes: number; concurrency?: number };
const CONCURRENCY = Math.min(64, Math.max(1, Math.floor(req.concurrency ?? 16)));
if (!validBbox(req.bbox) || (req.bbox.xmax - req.bbox.xmin) * (req.bbox.ymax - req.bbox.ymin) > 0.05) throw new Error("bbox invalid or too large for a controlled run");
const LIMIT = Math.min(1500, Math.max(1, Math.floor(req.limit)));
const OUT = arg("out", "live-out")!;
mkdirSync(OUT, { recursive: true });
const log = createLogger({ level: "warn", sink: (l) => process.stderr.write(`${l.length > 300 ? l.slice(0, 300) + "…" : l}\n`) });
const UA = "CrestmontResearchBot/0.1 (+https://crestmontwebsitedevelopment.com; support@crestmontwebsitedevelopment.com)";
const started = Date.now();
const r0 = await snapshot(process.cwd());

// ── 1. Discover: Overture (real release, real schema probe) ──
const duck = new DuckDbCli(process.env.DUCKDB_PATH ?? "duckdb", "4GB");
const overture = new OvertureSource(duck, { base: "s3://overturemaps-us-west-2/release", release: process.env.OVERTURE_RELEASE || null, dataDir: OUT, log });
const tq = Date.now();
const found = await overture.sample(req.bbox, join(OUT, "overture-sample.jsonl.private"));
const overtureMs = Date.now() - tq;
const withPhone = found.candidates.filter((c) => c.phones.length);
const chosen = [...withPhone].sort((a, b) => a.businessKey.localeCompare(b.businessKey)).slice(0, LIMIT);

// ── 2. Platform (real pipeline, in-memory D1 stand-in) and CRM controls from the real sample ──
// Ephemeral secret for the in-process platform only; still drawn from the CSPRNG.
const SECRET = randomBytes(32).toString("hex");
const app = await createTestApp({ RESEARCH_RUNNER_SECRET: SECRET });
const raw = (app.db as SqliteDb).raw;
raw.prepare(`UPDATE research_settings SET paused = 0, max_batch = 100 WHERE id = 1`).run();
// Controls come from businesses with no website field (they are evaluated and sent as "no website found"), so the
// duplicate and do-not-call checks are exercised at ingest on real records.
const noSite = chosen.filter((c) => !c.websites.length);
const crmControl = noSite[0], dncControl = noSite[1];
if (crmControl) raw.prepare(`INSERT INTO contacts (id, name, phone, created_at) VALUES ('ct_live_control', 'TEST DATA: CRM duplicate control', ?, ?)`).run(crmControl.phones[0], new Date().toISOString());
if (dncControl) await addDnc(app.db, dncControl.phones[0], "staff", "TEST DATA: do-not-call control for the live sample");
const fetchImpl = (async (url: string | URL, init?: RequestInit) => handle(new Request(url, init), app.env)) as typeof fetch;

// ── 3. Common Crawl (real index; throttled, one or two queries) ──
let cc: CommonCrawl | null = null, crawl = "unavailable";
try {
  const j = await (await fetch("https://index.commoncrawl.org/collinfo.json", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) })).json() as { id: string }[];
  crawl = j.map((x) => x.id).find((x) => /^CC-MAIN-\d{4}-\d{2}$/.test(x)) ?? "unavailable";
  if (crawl !== "unavailable") cc = new CommonCrawl(duck, new State(":memory:"), log, { crawl, maxDomainsPerQuery: 200, minQueryIntervalMs: 5_000, dailyQueryBudget: 2,
    fetchText: async (url) => { const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(120_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8"); } });
} catch (e) { log.warn("common crawl unavailable", { error: (e as Error).message }); }

// ── 4. Verify + audit with the real worker ──
const cfg = loadConfig({ CRESTMONT_URL: "https://crestmont.test", RESEARCH_RUNNER_SECRET: SECRET, COMMON_CRAWL: "off", PLAYWRIGHT: "off", HTTP_CONCURRENCY: String(CONCURRENCY) });
const http = new Http({ userAgent: UA, robotsToken: "CrestmontResearchBot", timeoutMs: 15_000, perHostIntervalMs: 5_000, concurrency: CONCURRENCY, maxBytes: 3_000_000 });
const state = new State(join(OUT, "state.sqlite.private"));
const worker = new ResearchWorker({ cfg: { ...cfg, http: { ...cfg.http, brokenAttempts: 2, brokenRecheckAfterMs: Math.max(1, req.brokenRecheckMinutes) * 60_000 } },
  state, http, platform: new Platform(cfg.platformUrl, SECRET, fetchImpl), sources: [], cc, browser: null, model: null, log: silentLogger });
// Common Crawl: one throttled bulk lookup for every candidate domain first, so verification reads from the cache.
if (cc) {
  const { candidateDomains } = await import("../src/pipeline.ts");
  const domains = [...new Set(chosen.flatMap((c) => candidateDomains(c, state).domains.map((d) => d.domain)))];
  await cc.lookup(domains, Date.now());
}
await worker.heartbeat();
for (const c of chosen) state.upsertCandidate(c, c.address.state ?? "MI", new Date(), 30);
const perBusinessMs: number[] = [];
const orig = worker.processOne.bind(worker);
worker.processOne = async (row) => { const t = Date.now(); await orig(row); perBusinessMs.push(Date.now() - t); };
const ac = new AbortController();
const loop = worker.workLoop(ac.signal);
const deadline = Date.now() + 50 * 60_000;
while (state.backlog() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2000));
ac.abort(); await loop;
const verifyMs = Date.now() - started - overtureMs;

// ── 5. Deliver, promote, re-send (duplicate arrival) ──
for (let i = 0; i < 20 && state.outboxDepth() + (state.stages().ready ?? 0) > 0; i++) await worker.deliverOnce();
const owner = await createStaff(app.db, "owner", "owner-live@crestmont.test");
const actor = { kind: "user" as const, userId: owner.id, roles: [{ role: "owner" as const, organizationId: "org_crestmont" }], mfaVerified: true };
// Only 'qualified' records are promoted unattended. 'review' records (shared phone, same website or same name and street
// as another record) are held for a person to decide which record is the business, as the product does; counted below.
const promotable = raw.prepare(`SELECT id FROM research_prospects WHERE status = 'qualified'`).all() as { id: string }[];
const heldForReview = (raw.prepare(`SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'review'`).get() as { n: number }).n;
const promoteOutcomes: Record<string, number> = {};
for (const p of promotable) {
  try { await R.promote(app.db, actor, p.id); promoteOutcomes.created = (promoteOutcomes.created ?? 0) + 1; }
  catch (e) { const k = (e as Error).message.slice(0, 60); promoteOutcomes[k] = (promoteOutcomes[k] ?? 0) + 1; }
}
const leadsAfterPromote = (raw.prepare(`SELECT COUNT(*) AS n FROM leads`).get() as { n: number }).n;
// The same results arrive again in a new batch: nothing new may be created.
const results = (state.db.prepare(`SELECT result FROM candidates WHERE result IS NOT NULL AND stage = 'sent'`).all() as { result: string }[]).map((r) => JSON.parse(r.result));
const resend = results.length ? await new Platform(cfg.platformUrl, SECRET, fetchImpl).batch(cfg.runnerId, `rb_live_resend_${Date.now()}`, JSON.stringify(results.slice(0, 100))) : null;
for (const p of raw.prepare(`SELECT id FROM research_prospects WHERE status IN ('qualified','promoted')`).all() as { id: string }[]) { try { await R.promote(app.db, actor, p.id); } catch { /* blocked as expected */ } }
const leadsAfterResend = (raw.prepare(`SELECT COUNT(*) AS n FROM leads`).get() as { n: number }).n;

// ── 6. Measure ──
const q = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
const status = worker.status();
const sorted = [...perBusinessMs].sort((a, b) => a - b);
const pct = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
const checks = (state.db.prepare(`SELECT result FROM candidates WHERE result IS NOT NULL`).all() as { result: string }[]).map((r) => JSON.parse(r.result).website?.checks ?? []).flat() as { result: string }[];
const failures = state.db.prepare(`SELECT last_error FROM candidates WHERE stage = 'failed'`).all() as { last_error: string }[];
const elapsedMs = Date.now() - started;
const processed = sorted.length;
const summary = {
  kind: "REAL DATA, controlled sample (Overture + live websites + Common Crawl); CRM = real platform pipeline on in-memory SQLite, NOT staging",
  overtureRelease: found.release, commonCrawl: crawl, bboxAreaDeg2: Number(((req.bbox.xmax - req.bbox.xmin) * (req.bbox.ymax - req.bbox.ymin)).toFixed(5)),
  discovered: { placesInBbox: found.rows, candidates: found.candidates.length, withPhone: withPhone.length, phoneAvailability: found.candidates.length ? Number((withPhone.length / found.candidates.length).toFixed(3)) : null },
  concurrency: CONCURRENCY,
  brands: { inBboxWithBrandName: found.candidates.filter((c) => c.brand).length, inBboxWithBrandWikidata: found.candidates.filter((c) => c.brandWikidata).length },
  sampled: chosen.length, brandManagedLocations: chosen.filter((c) => c.brandWikidata).length, attemptsTimed: processed, unfinished: state.backlog(), failed: failures.length,
  failureKinds: failures.reduce<Record<string, number>>((m, f) => { const k = (f.last_error ?? "").split(":")[0].slice(0, 40); m[k] = (m[k] ?? 0) + 1; return m; }, {}),
  classes: status.classCounts,
  websitesChecked: status.websitesChecked, robotsBlockedChecks: checks.filter((c) => /robots\.txt disallows/.test(c.result)).length,
  commonCrawlChecks: checks.filter((c) => /captures?|not captured/.test(c.result)).length,
  sentToPlatform: q(`SELECT COUNT(*) AS n FROM research_prospects`), qualified: q(`SELECT COUNT(*) AS n FROM research_prospects WHERE qualified = 1`),
  statuses: Object.fromEntries((raw.prepare(`SELECT status, COUNT(*) AS n FROM research_prospects GROUP BY status`).all() as { status: string; n: number }[]).map((r) => [r.status, r.n])),
  controls: { crmDuplicate: crmControl ? (raw.prepare(`SELECT status FROM research_prospects WHERE business_key = ?`).get(crmControl.businessKey) as { status: string } | undefined)?.status ?? "not sent" : "none",
    doNotCall: dncControl ? (raw.prepare(`SELECT status FROM research_prospects WHERE business_key = ?`).get(dncControl.businessKey) as { status: string } | undefined)?.status ?? "not sent" : "none" },
  duplicatesPrevented: q(`SELECT COALESCE(SUM(duplicates_prevented), 0) AS n FROM research_batches`),
  crm: { promotionAttempts: promotable.length, heldForReview, outcomes: promoteOutcomes, leadsAfterPromote, resend: resend ? { accepted: resend.accepted, created: resend.created, updated: resend.updated, unchanged: resend.unchanged } : null, leadsAfterResend, duplicateLeadsCreated: leadsAfterResend - leadsAfterPromote },
  callableEligible: q(`SELECT COUNT(*) AS n FROM research_prospects WHERE eligibility = 'eligible'`),
  timing: { totalMs: elapsedMs, overtureQueryMs: overtureMs, verifyPhaseMs: verifyMs, perBusinessMs: { avg: processed ? Math.round(sorted.reduce((a, b) => a + b, 0) / processed) : null, p50: pct(0.5), p90: pct(0.9), max: sorted.at(-1) ?? null } },
  httpRequests: http.requests,
  throughput: { businessesPerHourMeasured: processed && verifyMs > 0 ? Math.round(processed / (verifyMs / 3600e3)) : null,
    note: "A small sample from one GitHub-hosted runner, including a forced re-check wait for possibly broken sites. Not a 24-hour measurement and not Node 1." },
  resources: { before: r0, after: await snapshot(process.cwd()) },
  externalFees: "$0",
  diagnostics: diagnostics(),
};

/** Aggregate-only quality diagnostics (codes and categories, never names, domains or numbers). */
function diagnostics() {
  const rows = (state.db.prepare(`SELECT result FROM candidates WHERE result IS NOT NULL`).all() as { result: string }[]).map((r) => JSON.parse(r.result) as { website: { classification: string; identitySignals?: string[]; checks?: { stage: string; result: string }[] }; findings?: { code: string; severity: string; confidence: number }[] });
  const inc = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const findingCodes: Record<string, number> = {}, issuesDrivers: Record<string, number> = {}, unverified: Record<string, number> = {}, stageC: Record<string, number> = {}, stageD: Record<string, number> = {};
  for (const r of rows) {
    for (const f of r.findings ?? []) inc(findingCodes, `${f.code}:${f.severity}`);
    if (r.website.classification === "VERIFIED_WEBSITE_ISSUES") for (const f of r.findings ?? []) if (f.confidence >= 0.6 && f.severity !== "low") inc(issuesDrivers, f.code);
    if (r.website.classification === "WEBSITE_UNVERIFIED") for (const s of r.website.identitySignals ?? []) inc(unverified,
      /restricts automated/.test(s) ? "restricted_robots_or_401_403_429" : /loads but does not match/.test(s) ? "listed_site_loads_identity_not_confirmed" : /HTTP (\d)\d\d/.test(s) ? `http_${/HTTP (\d)/.exec(s)![1]}xx` : /does not load/.test(s) ? "unlisted_candidate_not_loading" : /non-public/.test(s) ? "non_public_address" : /restricts automated/.test(s) ? "restricted_robots_or_401_403_429" : /parked|placeholder/.test(s) ? "parked_unlisted" : "other");
    for (const c of r.website.checks ?? []) {
      if (c.stage === "C") inc(stageC, /^HTTP (\d)/.test(c.result) ? `http_${/^HTTP (\d)/.exec(c.result)![1]}xx` : c.result.split(":")[0].slice(0, 30));
      if (c.stage === "D" && /^not confirmed/.test(c.result)) inc(stageD, /different phone/.test(c.result) ? "different_phone_on_page" : /no matching signals/.test(c.result) ? "no_matching_signals" : /name on page/.test(c.result) ? "name_only_no_phone_or_street" : "weak_signals");
      if (c.stage === "D" && /^official/.test(c.result)) inc(stageD, "official");
    }
  }
  return { findingCodes, issuesDrivers, unverifiedReasons: unverified, stageCResults: stageC, stageDResults: stageD };
}
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));

// ── 7. Private detail for the Founder's manual review (sealed by the workflow; never printed) ──
const prospects = raw.prepare(`SELECT business_key, name, address_line, city, state, phone_e164, website_url, website_class, website_json, findings_json, score, qualified, qualification_json, status, status_detail, crm_lead_id FROM research_prospects`).all() as Record<string, string | number | null>[];
const byKey = new Map(prospects.map((p) => [p.business_key as string, p]));
const details = (state.db.prepare(`SELECT business_key, stage, last_error, result FROM candidates ORDER BY business_key`).all() as { business_key: string; stage: string; last_error: string | null; result: string | null }[]).map((c) => {
  const cand = chosen.find((x) => x.businessKey === c.business_key)!;
  const res = c.result ? JSON.parse(c.result) : null;
  return { businessKey: c.business_key, name: cand.name, address: cand.address, phone: cand.phones[0] ?? null, listedWebsites: cand.websites, stage: c.stage, error: c.last_error,
    classification: res?.website?.classification ?? "(no result)", sentToPlatform: c.stage === "sent", websiteUrl: res?.website?.url ?? null, identitySignals: res?.website?.identitySignals ?? [], checks: res?.website?.checks ?? [],
    findings: res?.findings ?? [], platform: byKey.get(c.business_key) ?? null };
});
writeFileSync(join(OUT, "details.json"), JSON.stringify(details, null, 2));
const esc = (s: unknown) => String(s ?? "").replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 160);
writeFileSync(join(OUT, "review.md"), [
  `# Live research sample: manual review sheet (PRIVATE)`, ``,
  `Overture ${found.release}, ${chosen.length} businesses. For each row, open the listed website and the business's public listing, then fill in the verdict:`,
  `correct / false positive (we claim a problem that is not there) / false negative (we missed a real problem or website) / identity wrong.`, ``,
  `| # | Business | City | Phone | Our classification | Website | Key evidence | Score / status | Verdict |`, `|---|---|---|---|---|---|---|---|---|`,
  ...details.map((d, i) => `| ${i + 1} | ${esc(d.name)} | ${esc(d.address.city)} | ${esc(d.phone)} | ${esc(d.classification)} | ${esc(d.websiteUrl ?? d.listedWebsites[0] ?? "")} | ${esc((d.findings as { title: string }[]).slice(0, 3).map((f) => f.title).join("; ") || (d.checks as { result: string }[]).at(-1)?.result)} | ${esc(d.platform ? `${d.platform.score} / ${d.platform.status}` : d.stage)} |  |`),
].join("\n"));
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
