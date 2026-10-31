// Operations closeout (2026-10-29): HSTS per environment (CREST-GAP-029), env_metrics sampling (066), bootstrap-owner
// --url (067), unique migration prefixes (027), migration 0045 (064, 104), file-storage signal (055), Turnstile test-key
// feed (019), Founder-bound release authorization (020), Workers Logs (015). All records are TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { handle } from "../src/app/app.ts";
import { hstsValue, DEFAULT_HSTS } from "../src/app/http.ts";
import { metricWeight, BOT_UA } from "../src/services/env-metrics.ts";
import { founderProblem, turnstileFeed } from "../src/services/readiness-admin.ts";
import { signEvidence, ingestEvidence } from "../src/readiness/ingest.ts";
import { signedGetCanonical } from "../src/routes/ops.ts";
import { nowIso } from "../src/lib/db.ts";
import type { Env } from "../src/app/context.ts";

const SECRET = "ops-closeout-ingest-secret";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CFG = "c".repeat(64);
const toml = readFileSync("wrangler.toml", "utf8");
const envBlock = (name: string) => { const s = toml.indexOf(`\n[env.${name}]`); const e = toml.indexOf("\n[env.", s + 1); return toml.slice(s, e > 0 ? e : undefined); };

// ───────────── CREST-GAP-029: HSTS ─────────────

test("[SEC-002] HSTS is configurable: production's first release sends max-age=300 without includeSubDomains; staging and development keep the 2-year header", async () => {
  assert.equal(hstsValue({}), DEFAULT_HSTS);
  assert.equal(DEFAULT_HSTS, "max-age=63072000; includeSubDomains");
  assert.equal(hstsValue({ HSTS_MAX_AGE: "300" }), "max-age=300");
  assert.equal(hstsValue({ HSTS_MAX_AGE: "86400", HSTS_INCLUDE_SUBDOMAINS: "on" }), "max-age=86400; includeSubDomains");
  assert.equal(hstsValue({ HSTS_MAX_AGE: "two years" }), "max-age=300", "an unusable value never falls back to two years");
  assert.match(envBlock("production"), /vars = \{[^}]*HSTS_MAX_AGE = "300"/);
  assert.doesNotMatch(envBlock("production").replace(/#.*$/gm, ""), /HSTS_INCLUDE_SUBDOMAINS/);
  assert.doesNotMatch(envBlock("staging").replace(/#.*$/gm, ""), /HSTS_/, "staging keeps the current header");
  const prod = await createTestApp({ ENVIRONMENT: "production", HSTS_MAX_AGE: "300" });
  for (const path of ["/", "/api/health", "/login", "/does-not-exist"]) {
    const res = await handle(new Request(`https://crestmont.test${path}`), prod.env);
    assert.equal(res.headers.get("strict-transport-security"), "max-age=300", path);
  }
  const staging = await createTestApp({ ENVIRONMENT: "staging" });
  const s = await handle(new Request("https://crestmont.test/"), staging.env);
  assert.equal(s.headers.get("strict-transport-security"), "max-age=63072000; includeSubDomains");
  assert.equal(s.headers.get("x-robots-tag"), "noindex, nofollow", "staging still tells crawlers not to index");
});

// ───────────── CREST-GAP-066: env_metrics ─────────────

test("[READY-006] env_metrics skips /assets/* and bots, writes every error, and samples the rest with an unbiased weight (ENV_METRICS_SAMPLE, default 0.1)", async () => {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15";
  const w = (o: Partial<Parameters<typeof metricWeight>[0]>) => metricWeight({ pathname: "/", userAgent: ua, status: 200, unhandled: false, ...o });
  assert.equal(w({ pathname: "/assets/site.css" }), 0);
  for (const bot of ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Mozilla/5.0 (compatible; bingbot/2.0)", "AdsBot-Google", "curl/8.5.0", "facebookexternalhit/1.1", "GPTBot/1.0", "python-requests/2.31"]) {
    assert.ok(BOT_UA.test(bot), bot);
    assert.equal(w({ userAgent: bot, status: 500 }), 0, `${bot}: never written, not even its errors`);
  }
  assert.ok(!BOT_UA.test("Mozilla/5.0 (Linux; Android 13; Cubot X30) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"), "a phone model containing 'bot' is a person");
  assert.equal(w({ status: 503, random: () => 0.99 }), 1, "5xx always written, weight 1");
  assert.equal(w({ unhandled: true, random: () => 0.99 }), 1);
  assert.equal(w({ random: () => 0.05 }), 10, "default sample 0.1 → kept requests count for 10");
  assert.equal(w({ random: () => 0.5 }), 0, "…and the other 90% are not written");
  assert.equal(w({ sample: "1", random: () => 0.99 }), 1);
  assert.equal(w({ sample: "0" }), 0);
  assert.equal(w({ sample: "0.25", random: () => 0.1 }), 4);
  assert.equal(w({ sample: "nonsense", random: () => 0.05 }), 10, "unusable value → default");

  // End to end: 1,000 human page views at the default rate cost ~100 writes, not 1,000; errors and bots as specified.
  const app = await createTestApp({ ENVIRONMENT: "staging" });
  for (let i = 0; i < 20; i++) await handle(new Request("http://crestmont.test/assets/missing.css"), app.env);
  for (let i = 0; i < 20; i++) await handle(new Request("http://crestmont.test/", { headers: { "user-agent": "Googlebot/2.1" } }), app.env);
  const n = async () => (await app.db.prepare(`SELECT COALESCE(SUM(requests),0) r FROM env_metrics`).first<{ r: number }>())!.r;
  assert.equal(await n(), 0, "assets and crawlers write nothing");
  const rowsBefore = async () => (await app.db.prepare(`SELECT COUNT(*) c FROM env_metrics`).first<{ c: number }>())!.c;
  assert.equal(await rowsBefore(), 0);
  const sampled = await createTestApp({ ENVIRONMENT: "staging", ENV_METRICS_SAMPLE: "0.5" });
  let writes = 0;
  const counting = Object.create(sampled.db) as Env["DB"];
  counting.prepare = ((sql: string) => { if (sql.includes("INSERT INTO env_metrics")) writes++; return sampled.db.prepare(sql); }) as Env["DB"]["prepare"];
  const env: Env = { ...sampled.env, DB: counting };
  for (let i = 0; i < 200; i++) await handle(new Request("http://crestmont.test/api/health", { headers: { "user-agent": ua } }), env);
  assert.ok(writes > 50 && writes < 150, `about half of 200 requests written (${writes})`);
  const total = (await sampled.db.prepare(`SELECT SUM(requests) r, SUM(le_100 + le_300 + le_1000 + le_3000 + gt_3000) h FROM env_metrics`).first<{ r: number; h: number }>())!;
  assert.equal(total.r, writes * 2, "each written request counts for 1/sample");
  assert.equal(total.h, total.r, "the latency histogram is weighted the same way");
});

// ───────────── CREST-GAP-067: bootstrap-owner ─────────────

test("[AUTH-003] bootstrap-owner --print-sql refuses to run without --url (exit 2, no SQL, no link)", () => {
  const run = (...a: string[]) => spawnSync(process.execPath, ["--no-warnings", "scripts/bootstrap-owner.ts", "--email", "founder@crestmont.test", ...a], { encoding: "utf8" });
  const bare = run("--print-sql");
  assert.equal(bare.status, 2);
  assert.equal(bare.stdout, "", "no SQL printed");
  assert.doesNotMatch(bare.stderr, /invite\?token=/, "no invitation is created");
  assert.match(bare.stderr, /--print-sql needs --url/);
  assert.equal(run("--print-sql", "--url").status, 2, "--url without a value");
  assert.equal(run("--print-sql", "--url", "crestmont.test").status, 2, "--url must be an absolute http(s) URL");
  const ok = run("--print-sql", "--url", "https://crestmontwebsitedevelopment.com/");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /https:\/\/crestmontwebsitedevelopment\.com\/invite\?token=[0-9a-f]+/, "the printed link uses the given host");
  assert.doesNotMatch(ok.stderr, /localhost/);
});

// ───────────── CREST-GAP-027: migration numbering ─────────────

test("[DATA-001] every migration has a unique 4-digit prefix (two migrations numbered 0040 on open PRs must be renumbered before merge)", () => {
  const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
  const bad = files.filter((f) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(f));
  assert.deepEqual(bad, [], "file names are NNNN_snake_case.sql");
  const seen = new Map<string, string[]>();
  for (const f of files) seen.set(f.slice(0, 4), [...(seen.get(f.slice(0, 4)) ?? []), f]);
  const dupes = [...seen.values()].filter((v) => v.length > 1);
  assert.deepEqual(dupes, [], `duplicate migration prefixes: ${JSON.stringify(dupes)}`);
  assert.ok(files.includes("0045_ops_closeout.sql"));
});

// ───────────── Migration 0045: CREST-GAP-064 and -104 ─────────────

test("[READY-010] [DATA-001] migration 0045 resolves BLK-003, BLK-012, BLK-013 with evidence and indexes the Stripe retry scan", async () => {
  const { db } = await createTestApp();
  const rows = (await db.prepare(`SELECT id, status, resolution_evidence, resolved_at FROM blockers WHERE id IN ('BLK-003','BLK-012','BLK-013') ORDER BY id`).all<{ id: string; status: string; resolution_evidence: string | null; resolved_at: string | null }>()).results;
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [["BLK-003", "resolved"], ["BLK-012", "resolved"], ["BLK-013", "resolved"]]);
  for (const r of rows) { assert.ok((r.resolution_evidence ?? "").length > 80, `${r.id} has evidence`); assert.ok(r.resolved_at); }
  assert.match(rows[0].resolution_evidence!, /c667f1a9-0802-4c52-a0e1-b512219a6eea/);
  assert.match(rows[2].resolution_evidence!, /PR #1/);
  // Only rows still open are touched: a register edited by staff keeps its own evidence.
  const sql = readFileSync("migrations/0045_ops_closeout.sql", "utf8");
  assert.equal((sql.match(/WHERE id = 'BLK-0(03|12|13)' AND status = 'open'/g) ?? []).length, 3);
  assert.doesNotMatch(sql, /BLK-008/, "BLK-008 needs the Founder's own resolution");
  const plan = (await db.prepare(`EXPLAIN QUERY PLAN SELECT id, payload FROM stripe_events WHERE status IN ('failed','received') AND attempts < 5 ORDER BY stripe_created LIMIT 50`).all<{ detail: string }>()).results;
  assert.ok(plan.some((p) => /idx_stripe_events_status_attempts/.test(p.detail)), JSON.stringify(plan));
});

// ───────────── CREST-GAP-055: file storage signal ─────────────

test("[FILE-001] the running Worker reports whether its FILES (R2) binding exists: /api/health fileStorage bound | not_configured", async () => {
  const bound = await createTestApp();
  assert.equal(((await (await bound.client().get("/api/health")).json()) as { fileStorage: string }).fileStorage, "bound");
  const none = await createTestApp({ overrides: { storage: null } });
  const j = (await (await none.client().get("/api/health")).json()) as { status: string; fileStorage: string };
  assert.deepEqual([j.status, j.fileStorage], ["ok", "not_configured"], "health stays ok; the signal is explicit");
});

// ───────────── CREST-GAP-019: Turnstile test keys ─────────────

test("[SEC-002] the turnstile:staging feed is failing with a public reason while staging uses Cloudflare's always-pass test keys (advisory: health stays 200)", async () => {
  const stagingVars = /\[env\.staging\][\s\S]*?vars = \{[^}]*TURNSTILE_SITE_KEY = "([^"]+)", TURNSTILE_SECRET = "([^"]+)"/.exec(toml)!;
  const now = new Date();
  const f = turnstileFeed({ ENVIRONMENT: "staging", TURNSTILE_SITE_KEY: stagingVars[1], TURNSTILE_SECRET: stagingVars[2] }, now)!;
  assert.equal(f.source, "turnstile:staging");
  assert.equal(f.status, "failing", "the committed staging keys are Cloudflare's test keys");
  assert.equal(f.advisory, true);
  assert.equal(turnstileFeed({ ENVIRONMENT: "production", TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET: "real-secret" }, now)!.advisory, false, "test keys on production are a real failure");
  assert.equal(turnstileFeed({ ENVIRONMENT: "staging", TURNSTILE_SITE_KEY: "0x4AAAAAAABkMYinukE8nzYS", TURNSTILE_SECRET: "0x4AAAAAAABkMYinukE8nzYS_real" }, now)!.status, "healthy");
  assert.equal(turnstileFeed({ ENVIRONMENT: "development" }, now), null);

  const app = await createTestApp({ ENVIRONMENT: "staging", TURNSTILE_SITE_KEY: stagingVars[1], TURNSTILE_SECRET: stagingVars[2] });
  await app.db.prepare(`INSERT INTO ingestion_status (source, last_success_at, last_attempt_at) VALUES ('ci', ?, ?)`).bind(nowIso(), nowIso()).run();
  const res = await app.client().get("/api/readiness/health");
  const body = (await res.json()) as { feeds: { source: string; status: string; reason?: string; detail?: string }[] };
  const feed = body.feeds.find((x) => x.source === "turnstile:staging")!;
  assert.equal(feed.status, "failing");
  assert.match(feed.reason ?? "", /always-pass TEST keys/, "anonymous callers see why");
  assert.doesNotMatch(JSON.stringify(feed), /1x0000000000000000000000000000000AA/, "key values are never shown");
  assert.notEqual(res.status, 503, "advisory: the staging health monitor is not turned red by a known provider-side gap");
});

// ───────────── CREST-GAP-020: release authorization bound to the Founder ─────────────

async function founderSetup(ownerEmail: string, extra: Partial<Env> = {}) {
  const app = await createTestApp({ EVIDENCE_INGEST_SECRET: SECRET, ...extra });
  const owner = await createStaff(app.db, "owner", ownerEmail, "Olivia Owner");
  const o = await app.client().login(owner.email, TEST_PASSWORD, owner.secret);
  await ingestEvidence(app.db, JSON.stringify({ runId: "ci-founder-1", source: "ci", environment: "development", commitSha: COMMIT.slice(0, 7), startedAt: nowIso(), finishedAt: nowIso(), results: [{ requirementId: "DATA-001", testName: "t", outcome: "passed" }] }));
  assert.equal((await o.post("/staff/readiness/releases", { commit_sha: COMMIT, config_sha256: CFG, notes: "Release candidate notes", rollback_plan: "wrangler rollback to the previous version" })).status, 303);
  const panel = await (await o.get("/staff/readiness/approve")).text();
  const ev = /name="evidence_set" value="([0-9a-f]{64})"/.exec(panel)![1];
  const approve = () => o.post("/staff/readiness/approve", { decision: "approved", confirm_commit: COMMIT, evidence_set: ev });
  const authorized = async () => {
    const url = new URL(`/api/readiness/release-authorization?commit=${COMMIT}`, "http://crestmont.test");
    const res = await app.client().request("GET", url.pathname + url.search, { headers: { "x-crestmont-signature": await signEvidence(SECRET, signedGetCanonical(url)) } });
    return (await res.json()) as { authorized: boolean; reason: string };
  };
  return { ...app, owner, approve, authorized };
}

test("[READY-008] [LAUNCH-002] a demo Owner account (@crestmont-preview.test) can never record or carry a production launch approval", async () => {
  assert.equal(founderProblem("owner@crestmont-preview.test", undefined), "approver is not the Founder");
  assert.equal(founderProblem("OWNER@Crestmont-Preview.Test", "owner@crestmont-preview.test"), "approver is not the Founder", "not even when FOUNDER_EMAIL names it");
  const t = await founderSetup("owner@crestmont-preview.test");
  const res = await t.approve();
  assert.equal(res.status, 403);
  assert.match(await res.text(), /approver is not the Founder/);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM release_approvals WHERE kind = 'production_launch'`).first<{ n: number }>())!.n, 0, "nothing recorded");
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'release.founder_decision_refused'`).first(), "the refusal is audited");
  // An approval row that reached the database some other way (e.g. before this check existed) still does not authorize.
  const rc = (await t.db.prepare(`SELECT id, config_sha256 FROM releases LIMIT 1`).first<{ id: string; config_sha256: string }>())!;
  await t.db.prepare(`INSERT INTO release_approvals (id, release_id, kind, approver_user_id, commit_sha, config_sha256, evidence_set_sha256, decision, created_at) VALUES ('rap_demo', ?, 'production_launch', ?, ?, ?, NULL, 'approved', ?)`)
    .bind(rc.id, t.owner.id, COMMIT, rc.config_sha256, nowIso()).run();
  const a = await t.authorized();
  assert.equal(a.authorized, false);
  assert.match(a.reason, /approver is not the Founder/);
});

test("[READY-008] [LAUNCH-002] with FOUNDER_EMAIL set, only that account's approval is recorded and authorizes the release", async () => {
  const other = await founderSetup("co-owner@crestmont.test", { FOUNDER_EMAIL: "noah@crestmontwebsitedevelopment.com" });
  const refused = await other.approve();
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /approver is not the Founder/);
  assert.equal((await other.authorized()).authorized, false);

  const founder = await founderSetup("Noah@CrestmontWebsiteDevelopment.com", { FOUNDER_EMAIL: "noah@crestmontwebsitedevelopment.com" });
  assert.equal((await founder.approve()).status, 303, "case-insensitive match on the Founder's address");
  const ok = await founder.authorized();
  assert.equal(ok.authorized, true, ok.reason);
  // Without FOUNDER_EMAIL a non-demo Owner keeps working (development and the existing staging flow).
  const unset = await founderSetup("owner@crestmont.test");
  assert.equal((await unset.approve()).status, 303);
  assert.equal((await unset.authorized()).authorized, true);
});

// ───────────── CREST-GAP-015: Workers Logs ─────────────

test("[INFRA-006] Workers Logs (observability) are enabled for staging and production in wrangler.toml", () => {
  for (const env of ["staging", "production"]) assert.match(envBlock(env), /^observability = \{ enabled = true \}/m, env);
  assert.doesNotMatch(toml.replace(/#.*$/gm, ""), /PREVIEW_GATE/, "the staging preview gate stays off");
});
