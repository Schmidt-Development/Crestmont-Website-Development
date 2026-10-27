// Readiness evidence sources: first-party error-rate / latency metrics (READY-006) and GitHub snapshots
// pushed by GitHub Actions with the workflow token (READY-005). All GitHub API responses here are
// SIMULATED fixtures (fake fetch); nothing in this file talks to GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createTestApp, createStaff } from "./support/app.ts";
import { ingestEvidence, signEvidence } from "../src/readiness/ingest.ts";
import { recordRequestMetric, summarizeSamples, metricArea, errorRateSummary } from "../src/services/env-metrics.ts";
import { buildPushedSnapshot, syncGithub } from "../src/services/github.ts";
import type { Env } from "../src/app/context.ts";

const SECRET = "test-evidence-secret";
const COMMIT = "abc1234def5678abc1234def5678abc1234def56";

async function setup(extra: Partial<Env> = {}) {
  const app = await createTestApp({ EVIDENCE_INGEST_SECRET: SECRET, ...extra });
  const owner = await createStaff(app.db, "owner", "owner@crestmont.test", "Olivia Owner");
  const o = await app.client().login(owner.email, undefined, owner.secret);
  return { ...app, o };
}

const kpiValue = (page: string, label: string) => new RegExp(`${label.replace(/[()]/g, "\\$&")}</div><div class="kpi__value">([^<]*)<`).exec(page)?.[1];

// ───────────── READY-006: error rate and latency ─────────────

test("[READY-006] every request lands in one hourly env_metrics row per area: 5xx and unhandled exceptions counted, no paths or ids stored", async () => {
  const app = await createTestApp();
  let boom = false;
  // Simulated outage: the health query throws, so /api/health becomes an unhandled exception → 500.
  const flaky = Object.create(app.db) as Env["DB"];
  flaky.prepare = ((sql: string) => { if (boom && sql === "SELECT 1") throw new Error("simulated D1 outage"); return app.db.prepare(sql); }) as Env["DB"]["prepare"];
  // Fixed clock so every request lands in the same hour bucket.
  const env: Env = { ...app.env, DB: flaky, overrides: { ...app.env.overrides, now: () => new Date("2026-10-27T10:15:00Z") } };
  const { handle } = await import("../src/app/app.ts");
  const get = (p: string) => handle(new Request(`http://crestmont.test${p}`), env);
  assert.equal((await get("/")).status, 200);
  assert.equal((await get("/pricing")).status, 200);
  assert.equal((await get("/api/health")).status, 200);
  boom = true;
  assert.equal((await get("/api/health")).status, 500);
  boom = false;
  assert.equal((await get("/staff/crm/leads/lead_secret_id_123?email=someone@example.com")).status, 303);
  assert.equal((await get("/api/does-not-exist")).status, 404);

  const rows = (await app.db.prepare(`SELECT * FROM env_metrics ORDER BY area`).all<Record<string, unknown>>()).results;
  const by = Object.fromEntries(rows.map((r) => [r.area, r]));
  assert.deepEqual(Object.keys(by).sort(), ["api", "site", "staff"]);
  assert.equal(by.site.requests, 2);
  assert.equal(by.api.requests, 3);
  assert.equal(by.api.errors_5xx, 1);
  assert.equal(by.api.unhandled, 1);
  assert.equal(by.staff.errors_5xx, 0);
  for (const r of rows) {
    assert.equal(r.environment, "development");
    assert.equal(r.hour, "2026-10-27T10");
    assert.equal(Number(r.le_100) + Number(r.le_300) + Number(r.le_1000) + Number(r.le_3000) + Number(r.gt_3000), r.requests, "histogram covers every request");
  }
  const dump = JSON.stringify(rows);
  for (const leak of ["lead_secret_id_123", "someone@example.com", "/staff", "pricing"]) assert.ok(!dump.includes(leak), `env_metrics must not contain ${leak}`);
  assert.equal(metricArea("/portal/projects/prj_1"), "portal");
  assert.equal(metricArea("/live/x"), "live");
  assert.equal(metricArea("/totally/unknown"), "site");

  // Disabled → no write; a broken metrics table never breaks the response.
  const off = await createTestApp({ ENV_METRICS: "off" });
  await off.client().get("/");
  assert.equal((await off.db.prepare(`SELECT COUNT(*) n FROM env_metrics`).first<{ n: number }>())!.n, 0);
  await off.db.prepare(`DROP TABLE env_metrics`).run();
  const res = await handle(new Request("http://crestmont.test/"), { ...off.env, ENV_METRICS: "on" });
  assert.equal(res.status, 200);
});

test("[READY-006] environment view shows 24-hour error rate and server latency from recorded metrics; Unknown (never 0) without data or for another environment's Worker", async () => {
  const { db, o } = await setup({ ENV_METRICS: "off" });
  // No metrics yet for this server (recording off) → Unknown, with the reason.
  let page = await (await o.get("/staff/readiness/env/development")).text();
  assert.equal(kpiValue(page, "Error rate (24 h)"), "Unknown");
  assert.equal(kpiValue(page, "Server time p95 (24 h)"), "Unknown");
  assert.equal(kpiValue(page, "Post-deploy p95 (worst page)"), "Unknown");
  assert.match(page, /No request has been recorded for development in the last 24 hours/);
  assert.match(page, /data-env-metrics="unknown"/);
  assert.doesNotMatch(page, /0\.00%/);

  const now = new Date();
  const m = (status: number, durationMs: number, at = now, pathname = "/") => recordRequestMetric(db, { environment: "development", pathname, status, durationMs, unhandled: false, at });
  await m(200, 40); await m(200, 250, now, "/staff"); await m(503, 1500, now, "/api/readiness/health"); await m(200, 80);
  await m(500, 10, new Date(now.getTime() - 30 * 3_600_000)); // outside the 24 h window
  const s = await errorRateSummary(db, "development", now);
  assert.equal(s!.requests, 4);
  assert.equal(s!.errors5xx, 1);
  assert.equal(s!.p50UpperMs, 100);
  assert.equal(s!.p95UpperMs, 3000);
  assert.equal(s!.maxMs, 1500);
  page = await (await o.get("/staff/readiness/env/development")).text();
  assert.equal(kpiValue(page, "Error rate (24 h)"), "25.00%");
  assert.equal(kpiValue(page, "Unhandled exceptions (24 h)"), "0");
  assert.equal(kpiValue(page, "Server time p95 (24 h)"), "≤ 3000 ms");
  assert.match(page, /1 of 4 requests answered 5xx/);
  assert.match(page, /data-env-metrics="recorded"/);

  // Staging viewed from the development server: its Worker records into its own database → Unknown here.
  const staging = await (await o.get("/staff/readiness/env/staging")).text();
  assert.equal(kpiValue(staging, "Error rate (24 h)"), "Unknown");
  assert.match(staging, /This server runs as development/);
  assert.match(staging, /no post-deploy timing evidence has been ingested for staging/);
});

test("[READY-006] post-deploy response-time samples travel with the evidence document, are validated, stored per page and shown (Unknown when a page had no successful sample)", async () => {
  const { db, o } = await setup();
  const a = summarizeSamples("/", [400, 100, 300, 200, 1000], 0);
  assert.deepEqual(a, { page: "/", samples: 5, failed: 0, p50Ms: 300, p95Ms: 1000, maxMs: 1000 });
  const none = summarizeSamples("/login", [], 5);
  assert.deepEqual(none, { page: "/login", samples: 5, failed: 5 });

  const doc = (runId: string, timings: unknown) => JSON.stringify({
    runId, source: "staging_e2e", environment: "staging", commitSha: COMMIT, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    results: [{ requirementId: "READY-006", testName: "staging response-time sampling", outcome: "failed", message: "/login: no successful sample" }], timings,
  });
  await assert.rejects(ingestEvidence(db, doc("bad-1", [{ page: "/", samples: 2, failed: 3 }])), /failed must be ≤ samples/);
  await assert.rejects(ingestEvidence(db, doc("bad-2", [{ page: "/leads?id=1", samples: 1, failed: 0, p50Ms: 1 }])), /invalid format/);
  await assert.rejects(ingestEvidence(db, doc("bad-3", [a, a])), /duplicated/);
  // Through the real signed endpoint.
  const body = doc("gh-1-1-staging-check", [a, none, summarizeSamples("/api/health", [20, 30, 25], 0)]);
  const res = await o.request("POST", "/api/readiness/evidence", { body, headers: { "content-type": "application/json", "x-crestmont-signature": await signEvidence(SECRET, body) } });
  assert.equal(res.status, 200);
  const stored = (await db.prepare(`SELECT page, samples, failed_samples, p50_ms, p95_ms FROM env_latency WHERE run_id = 'gh-1-1-staging-check' ORDER BY page`).all<Record<string, unknown>>()).results;
  assert.deepEqual(stored.map((r) => [r.page, r.p50_ms, r.p95_ms]), [["/", 300, 1000], ["/api/health", 25, 30], ["/login", null, null]]);
  const page = await (await o.get("/staff/readiness/env/staging")).text();
  assert.match(page, /gh-1-1-staging-check/);
  assert.match(page, /<code>\/<\/code><\/td><td class="num">5<\/td><td class="num">0<\/td><td class="num">300 ms<\/td><td class="num">1000 ms<\/td>/);
  assert.match(page, /<code>\/login<\/code><\/td><td class="num">5<\/td><td class="num">5<\/td><td class="num">Unknown<\/td><td class="num">Unknown<\/td>/);
  assert.equal(kpiValue(page, "Post-deploy p95 (worst page)"), "Unknown", "a page without any successful sample makes the worst-page p95 unknown");
  // Evidence without timings still ingests (older producers).
  assert.equal((await ingestEvidence(db, doc("no-timings", undefined))).status, "ingested");
  // The deploy workflow's check script produces timings and a READY-006 result.
  const script = readFileSync("scripts/production-checks.ts", "utf8");
  assert.match(script, /summarizeSamples/);
  assert.match(script, /requirementId: "READY-006"/);
  assert.match(script, /results, timings,/);
});

// ───────────── READY-005: GitHub snapshot pushed by GitHub Actions ─────────────

/** SIMULATED GitHub REST API (fixture data, not a real repository). */
function simulatedGithub(opts: { token: string; codeScanning?: "forbidden" | "ok"; failCore?: boolean } ) {
  const calls: string[] = [];
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${opts.token}`) return reply({ message: "Bad credentials" }, 401);
    if (opts.failCore && u.includes("/pulls?")) return reply({ message: "Resource not accessible by integration" }, 403);
    if (u.endsWith("/repos/example/crestmont")) return reply({ default_branch: "main", html_url: "https://github.com/example/crestmont", private: true });
    if (u.includes("/commits?")) return reply([{ sha: COMMIT, html_url: "https://github.com/example/crestmont/commit/abc", commit: { message: "Simulated commit: add env metrics\n\nbody", author: { name: "Sim", date: "2026-10-27T10:00:00Z" } }, author: { login: "sim-user" } }]);
    if (u.includes("/pulls?")) return reply([{ number: 42, title: "Simulated PR: GitHub push path", draft: true, html_url: "https://github.com/example/crestmont/pull/42", created_at: "2026-10-27T09:00:00Z", user: { login: "sim-user" }, head: { ref: "push-path" } }]);
    if (u.includes("/actions/runs?")) return reply({ workflow_runs: [
      { id: 9001, name: "Deploy staging", head_branch: "main", head_sha: COMMIT, event: "push", status: "in_progress", conclusion: null, html_url: "https://github.com/example/crestmont/actions/runs/9001", created_at: "2026-10-27T10:01:00Z" },
      { id: 9000, name: "CI", head_branch: "main", head_sha: COMMIT, event: "push", status: "completed", conclusion: "success", html_url: "https://github.com/example/crestmont/actions/runs/9000", created_at: "2026-10-27T10:00:30Z" },
    ] });
    if (u.includes("/tags?")) return reply([{ name: "v0.2.0", commit: { sha: COMMIT } }]);
    if (u.includes("/code-scanning/alerts")) return opts.codeScanning === "ok" ? reply([{ number: 1 }, { number: 2 }]) : reply({ message: "Advanced Security must be enabled for this repository to use code scanning." }, 403);
    return reply({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return { fake, calls };
}

const post = async (c: { request: (m: string, p: string, i: { body: string; headers: Record<string, string> }) => Promise<Response> }, body: string, secret: string | null = SECRET) =>
  c.request("POST", "/api/readiness/github-snapshot", { body, headers: { "content-type": "application/json", ...(secret ? { "x-crestmont-signature": await signEvidence(secret, body) } : {}) } });

test("[READY-005] push path: a snapshot built from simulated GitHub API responses with the workflow token is accepted only when signed, stored as source=push, and shown without GITHUB_TOKEN; code scanning 403 is 'unavailable', not zero", async () => {
  const { db, o, client } = await setup();
  const gh = simulatedGithub({ token: "ghs_simulated_workflow_token" });
  const doc = await buildPushedSnapshot({ token: "ghs_simulated_workflow_token", repo: "example/crestmont", snapshotId: "gh-9001-1", runUrl: "https://github.com/example/crestmont/actions/runs/9001" }, gh.fake);
  assert.equal(doc.ok, true);
  assert.ok(gh.calls.every((u) => u.startsWith("https://api.github.com/repos/example/crestmont")), "only the workflow's own repository is read");
  assert.equal(doc.snapshot!.codeScanning.available, false);
  assert.equal(doc.snapshot!.codeScanning.openAlerts, null);
  assert.match(doc.snapshot!.codeScanning.detail, /^Unavailable: GitHub 403/);
  const body = JSON.stringify(doc);
  assert.ok(!body.includes("ghs_simulated_workflow_token"), "the token never enters the snapshot");

  const anon = client();
  assert.equal((await post(anon, body, null)).status, 401, "unsigned");
  assert.equal((await post(anon, body, "wrong-secret")).status, 401, "wrong secret");
  const tampered = await signEvidence(SECRET, body);
  assert.equal((await anon.request("POST", "/api/readiness/github-snapshot", { body: body.replace("Simulated PR", "Forged PR"), headers: { "content-type": "application/json", "x-crestmont-signature": tampered } })).status, 401, "body changed after signing");
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM github_sync`).first<{ n: number }>())!.n, 0);

  const ok = await post(anon, body);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: "ingested", id: "ghp_gh-9001-1", ok: true });
  assert.equal(((await (await post(anon, body)).json()) as { status: string }).status, "duplicate", "re-delivery is idempotent");
  const row = await db.prepare(`SELECT source, ok, run_url, requested_by FROM github_sync`).first<{ source: string; ok: number; run_url: string; requested_by: string | null }>();
  assert.deepEqual({ ...row }, { source: "push", ok: 1, run_url: "https://github.com/example/crestmont/actions/runs/9001", requested_by: null });
  assert.equal((await db.prepare(`SELECT status FROM integration_health WHERE integration = 'github'`).first<{ status: string }>())!.status, "verified");
  assert.ok(await db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'readiness.github_snapshot_pushed' AND subject_id = 'ghp_gh-9001-1'`).first());

  const page = await (await o.get("/staff/readiness/engineering")).text();
  assert.match(page, /GitHub — example\/crestmont/);
  assert.match(page, /data-github-source="push"/);
  assert.match(page, /Server-side pull is not configured/);
  assert.match(page, /Simulated PR: GitHub push path/);
  assert.match(page, /Simulated commit: add env metrics/);
  assert.match(page, /v0\.2\.0/);
  assert.match(page, /Unavailable: GitHub 403/);
  assert.doesNotMatch(page, /Sync GitHub now/, "no pull button without a token");
  const health = await (await o.get("/api/readiness/health")).json() as { feeds: { source: string; status: string; detail: string }[] };
  const feed = health.feeds.find((f) => f.source === "github")!;
  assert.equal(feed.status, "healthy");
  assert.match(feed.detail, /pushed by GitHub Actions/);

  // A manual sync without a token must not overwrite the pushed source's health with "not configured".
  await o.post("/staff/readiness/github/sync");
  assert.equal((await db.prepare(`SELECT status FROM integration_health WHERE integration = 'github'`).first<{ status: string }>())!.status, "verified");

  // When Advanced Security IS available the real count is kept.
  const gh2 = simulatedGithub({ token: "t2", codeScanning: "ok" });
  const doc2 = await buildPushedSnapshot({ token: "t2", repo: "example/crestmont", snapshotId: "gh-9002-1" }, gh2.fake);
  assert.deepEqual({ ...doc2.snapshot!.codeScanning }, { available: true, openAlerts: 2, detail: "2 open alerts" });
});

test("[READY-005] pushed snapshot honesty: failing GitHub calls are stored as failing with stale data flagged; forged counts for unavailable scanning are dropped; wrong repo and malformed payloads are rejected", async () => {
  const { db, o, client } = await setup({ GITHUB_REPO: "example/crestmont" });
  const anon = client();
  const good = await buildPushedSnapshot({ token: "t", repo: "example/crestmont", snapshotId: "gh-1-1" }, simulatedGithub({ token: "t" }).fake);
  assert.equal((await post(anon, JSON.stringify(good))).status, 200);

  // Forged: unavailable code scanning with a count → stored without the count.
  const forged = { ...good, snapshotId: "gh-2-1", snapshot: { ...good.snapshot!, codeScanning: { available: false, openAlerts: 0, detail: "Unavailable: GitHub 404" } } };
  assert.equal((await post(anon, JSON.stringify(forged))).status, 200);
  const stored = JSON.parse((await db.prepare(`SELECT payload_json FROM github_sync WHERE id = 'ghp_gh-2-1'`).first<{ payload_json: string }>())!.payload_json);
  assert.equal(stored.codeScanning.openAlerts, null);

  // Validation: wrong repository, inconsistent docs, hostile values.
  assert.equal((await post(anon, JSON.stringify({ ...good, snapshotId: "gh-3-1", repo: "evil/other", snapshot: { ...good.snapshot!, repo: "evil/other" } }))).status, 422);
  assert.equal((await post(anon, JSON.stringify({ ...good, snapshotId: "gh-4-1", ok: true, snapshot: null }))).status, 422);
  assert.equal((await post(anon, JSON.stringify({ ...good, snapshotId: "gh-5-1", snapshot: { ...good.snapshot!, htmlUrl: "javascript:alert(1)" } }))).status, 422);
  assert.equal((await post(anon, JSON.stringify({ ...good, snapshotId: "gh-6-1", snapshot: { ...good.snapshot!, commits: [{ sha: "' OR 1=1--", message: "x", author: null, date: null, url: null }] } }))).status, 422);
  assert.equal((await post(anon, "{not json")).status, 400);

  // GitHub refuses a core call (simulated 403) → posted as ok:false; the view shows failure and flags older data as stale.
  const failed = await buildPushedSnapshot({ token: "t", repo: "example/crestmont", snapshotId: "gh-7-1" }, simulatedGithub({ token: "t", failCore: true }).fake);
  assert.equal(failed.ok, false);
  assert.match(failed.error!, /GitHub 403 on \/pulls: Resource not accessible by integration/);
  assert.equal((await post(anon, JSON.stringify(failed))).status, 200);
  assert.equal((await db.prepare(`SELECT status FROM integration_health WHERE integration = 'github'`).first<{ status: string }>())!.status, "failing");
  const page = await (await o.get("/staff/readiness/engineering")).text();
  assert.match(page, /Last GitHub sync failed/);
  assert.match(page, /Pushed snapshot failed: GitHub 403/);
  assert.match(page, /Stale data/);
  const health = await (await o.get("/api/readiness/health")).json() as { feeds: { source: string; status: string }[] };
  assert.equal(health.feeds.find((f) => f.source === "github")!.status, "failing");

  // Without any snapshot and without a token, the source is still honestly "not configured".
  const bare = await setup();
  const empty = await (await bare.o.get("/staff/readiness/engineering")).text();
  assert.match(empty, /GitHub source not configured. No snapshot has been pushed by GitHub Actions/);
  await syncGithub({ db: bare.db, env: bare.env, now: () => new Date() }, null);
  assert.equal((await bare.db.prepare(`SELECT status FROM integration_health WHERE integration = 'github'`).first<{ status: string }>())!.status, "not_configured");
});

test("[READY-005] the staging workflow posts the snapshot after evidence with only read permissions, and the script refuses to run without its configuration (never printing secrets)", () => {
  const y = readFileSync(".github/workflows/deploy-staging.yml", "utf8");
  const deployJob = y.slice(y.indexOf("\n  deploy:"));
  const perms = /\n {4}permissions:\n((?: {6}[a-z-]+: [a-z]+\n)+)/.exec(deployJob)?.[1] ?? "";
  assert.deepEqual(perms.trim().split("\n").map((l) => l.trim()).sort(), ["actions: read", "checks: read", "contents: read", "pull-requests: read", "security-events: read"]);
  assert.doesNotMatch(y, /: write\b/, "no write permission anywhere in the staging workflow");
  assert.match(y, /persist-credentials: false/);
  const step = y.indexOf("run: node --no-warnings scripts/post-github-snapshot.ts");
  assert.ok(step > 0, "snapshot step present");
  assert.ok(step > y.indexOf("scripts/post-deployment.ts"), "snapshot is posted after evidence and deployment");
  const stepBlock = y.slice(y.lastIndexOf("- name:", step), step);
  assert.match(stepBlock, /if: always\(\) && steps\.deploy\.outcome == 'success'/);
  assert.match(stepBlock, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);

  const run = (env: Record<string, string>) => spawnSync(process.execPath, ["--no-warnings", "scripts/post-github-snapshot.ts"], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 30_000 });
  const r1 = run({});
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /GITHUB_TOKEN and GITHUB_REPOSITORY must be set/);
  const r2 = run({ GITHUB_TOKEN: "ghs_do_not_print_me", GITHUB_REPOSITORY: "example/crestmont", EVIDENCE_INGEST_SECRET: "secret_do_not_print" });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /READINESS_URL and EVIDENCE_INGEST_SECRET must be set/);
  for (const s of ["ghs_do_not_print_me", "secret_do_not_print"]) assert.ok(!(r2.stdout + r2.stderr).includes(s));
});
