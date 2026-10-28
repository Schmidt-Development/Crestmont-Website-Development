// Post-deploy verification (LAUNCH-003, Gate H). Probes a deployed environment and writes an evidence
// document (source "production_check" for production, "staging_e2e" for staging) for the DEPLOYED
// commit, ready for scripts/post-evidence.ts. Exit code 1 when a CRITICAL check failed — the deploy
// workflow then rolls back. Every result is real: a check that could not run is recorded as failed.
// It also samples response times of fixed public pages (READY-006) and ships p50/p95/max per page as
// `timings` in the same evidence document (stored in env_latency, shown on the environment view).
// Options: --samples N (default 5), --p95-budget-ms MS (default 2000; non-critical READY-006 check).
//
//   node --no-warnings scripts/production-checks.ts --base https://crestmontwebsitedevelopment.com \
//     --environment production --commit $GITHUB_SHA --out evidence/production-check.json [--run-id gh-…]
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { summarizeSamples, type PageTiming } from "../src/services/env-metrics.ts";

const args = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const base = get("--base")?.replace(/\/+$/, "");
const environment = get("--environment") ?? "production";
const commit = get("--commit")?.toLowerCase();
const out = get("--out") ?? `evidence/${environment}-check.json`;
if (!base || !/^https:\/\//.test(base)) { console.error("--base https://<host> is required"); process.exit(2); }
if (!commit || !/^[0-9a-f]{40}$/.test(commit)) { console.error("--commit <40-hex deployed SHA> is required"); process.exit(2); }
if (!["staging", "production"].includes(environment)) { console.error("--environment staging|production"); process.exit(2); }

interface Check { requirementId: string; testName: string; critical: boolean; run: () => Promise<string | null> } // null = pass, string = failure reason

async function get200(path: string, expect: (r: Response, body: string) => string | null): Promise<string | null> {
  // Staging sits behind the preview gate: CHECK_COOKIE carries a preview pass (never used for production).
  const headers: Record<string, string> = { "user-agent": "crestmont-post-deploy-check" };
  if (process.env.CHECK_COOKIE && environment === "staging") headers.cookie = process.env.CHECK_COOKIE;
  const r = await fetch(base + path, { redirect: "manual", headers, signal: AbortSignal.timeout(15_000) });
  const body = await r.text();
  return expect(r, body);
}
const page = (path: string, mustContain: RegExp) => () => get200(path, (r, b) =>
  r.status !== 200 ? `${path}: HTTP ${r.status}` : !/text\/html/.test(r.headers.get("content-type") ?? "") ? `${path}: not HTML` : !mustContain.test(b) ? `${path}: expected content missing` : null);

const checks: Check[] = [
  { requirementId: "LAUNCH-003", testName: `${environment} /api/health reports ok for ${environment}`, critical: true,
    run: () => get200("/api/health", (r, b) => { try { const j = JSON.parse(b); return r.status === 200 && j.status === "ok" && j.environment === environment ? null : `HTTP ${r.status} ${b.slice(0, 200)}`; } catch { return `HTTP ${r.status}: not JSON`; } }) },
  { requirementId: "LAUNCH-003", testName: `${environment} homepage renders`, critical: true, run: page("/", /Crestmont/i) },
  { requirementId: "LAUNCH-003", testName: `${environment} pricing page renders`, critical: true, run: page("/pricing", /\$/) },
  { requirementId: "LAUNCH-003", testName: `${environment} contact page renders a form`, critical: true, run: page("/contact", /<form/i) },
  { requirementId: "LAUNCH-003", testName: `${environment} login page renders a password form`, critical: true, run: page("/login", /name="password"/) },
  { requirementId: "LAUNCH-003", testName: `${environment} security headers present (CSP, frame-ancestors)`, critical: true,
    run: () => get200("/", (r) => (/frame-ancestors 'none'/.test(r.headers.get("content-security-policy") ?? "") ? null : "content-security-policy missing or weak")) },
  { requirementId: "LAUNCH-003", testName: `${environment} staff area requires sign-in`, critical: true,
    run: () => get200("/staff", (r) => (r.status === 303 && (r.headers.get("location") ?? "").startsWith("/login") ? null : `expected 303 to /login, got ${r.status}`)) },
  // Readiness self-monitoring: the endpoint must answer; a 503 (degraded feeds) is recorded honestly as
  // a failed READY-012 check but does not trigger a rollback of a healthy service.
  { requirementId: "READY-012", testName: `${environment} readiness evidence feeds healthy (/api/readiness/health)`, critical: false,
    run: () => get200("/api/readiness/health", (r, b) => { try { const j = JSON.parse(b); return r.status === 200 && j.status === "ok" ? null : `HTTP ${r.status}: ${j.status ?? "unknown"}`; } catch { return `HTTP ${r.status}: not JSON`; } }) },
];

const startedAt = new Date().toISOString();
const results: { requirementId: string; testName: string; outcome: "passed" | "failed"; durationMs: number; message?: string }[] = [];
let criticalFailed = 0;
for (const c of checks) {
  const t = Date.now();
  let failure: string | null;
  try { failure = await c.run(); } catch (e) { failure = `request failed: ${(e as Error).message}`; }
  results.push({ requirementId: c.requirementId, testName: c.testName, outcome: failure ? "failed" : "passed", durationMs: Date.now() - t, ...(failure ? { message: failure.slice(0, 1000) } : {}) });
  if (failure && c.critical) criticalFailed++;
  console.log(`${failure ? "✖" : "✔"} ${c.testName}${failure ? ` — ${failure}` : ""}`);
}
// ── READY-006: response-time sampling (performance evidence for the environment view) ──
// Sequential GETs of fixed public pages, timed to the end of the body, measured from this runner (so
// network time is included). Only successful (HTTP 200) samples count towards p50/p95; failures are
// counted separately. A page with no successful sample has no percentiles (shown as Unknown).
const SAMPLES = Math.max(1, Math.min(50, Number(get("--samples") ?? 5) || 5));
const BUDGET_MS = Math.max(1, Number(get("--p95-budget-ms") ?? 2000) || 2000);
const TIMED_PAGES = ["/", "/pricing", "/contact", "/login", "/api/health"];
const timings: PageTiming[] = [];
for (const p of TIMED_PAGES) {
  const ok: number[] = [];
  let failed = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const t = performance.now();
    try { if ((await get200(p, (r) => (r.status === 200 ? null : `HTTP ${r.status}`))) === null) ok.push(performance.now() - t); else failed++; }
    catch { failed++; }
  }
  timings.push(summarizeSamples(p, ok, failed));
}
const slow = timings.filter((t) => t.p95Ms === undefined || t.p95Ms > BUDGET_MS);
results.push({ requirementId: "READY-006", testName: `${environment} response-time sampling: p95 ≤ ${BUDGET_MS} ms on every checked page (${SAMPLES} samples each, from the CI runner)`,
  outcome: slow.length ? "failed" : "passed", durationMs: 0,
  ...(slow.length ? { message: slow.map((t) => `${t.page}: ${t.p95Ms === undefined ? "no successful sample" : `p95 ${t.p95Ms} ms`}`).join("; ").slice(0, 1000) } : {}) });
for (const t of timings) console.log(`  ${t.page}: p50 ${t.p50Ms ?? "Unknown"} ms · p95 ${t.p95Ms ?? "Unknown"} ms · ${t.failed}/${t.samples} failed`);

const runId = (get("--run-id") ?? `local-${commit.slice(0, 12)}-${Date.now()}`) + `-${environment}-check`;
const doc = {
  runId, source: environment === "production" ? "production_check" : "staging_e2e", environment, commitSha: commit,
  branch: process.env.GITHUB_REF_NAME || undefined,
  ...(process.env.GITHUB_RUN_ID ? { runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` } : {}),
  startedAt, finishedAt: new Date().toISOString(), results, timings,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2));
console.log(`\n${results.filter((r) => r.outcome === "passed").length}/${results.length} checks passed; evidence written to ${out}`);
process.exit(criticalFailed ? 1 : 0);
