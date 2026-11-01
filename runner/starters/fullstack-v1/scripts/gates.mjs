#!/usr/bin/env node
// Acceptance gates for a website built on the full-stack starter (protected file: the runner restores it before
// every acceptance run). Writes .crestmont/quality/gates.json and exits non-zero when a required gate fails.
//
//   A requirements   configuration valid; every feature the customer asked for that the package includes is
//                    enabled AND its tests ran and passed (a skipped test never counts); requested features outside
//                    the package are recorded as scope changes, never silently built or dropped
//   B frontend       pages, navigation, working forms (no placeholders), accessibility basics, contrast, SEO
//   C backend        API behaviour tests (validation, errors, business logic)
//   D database       migrations apply to a fresh database; persistence, integrity and isolation tests
//   E integrations   offline tests of each enabled integration + provider-side verification status. Without an
//                    approved test-mode verification the gate is "pending_external" (never "pass")
//   F security       authentication, authorization, CSRF, rate limits, webhook signatures, headers, CSP-safe pages
//   G performance    page weight and local API latency budgets (measured here; staging numbers come later)
//   J deployment     Worker/D1 configuration, migrations, health check, rollback notes, no secrets in config
// Gates H (browser E2E) and I (independent review) are run by the Crestmont runner, not by this script.
//
// Integrity: this process never loads the website's own modules (src/). Tests and the performance server run in
// separate process groups that are killed afterwards; the configuration is judged by a protected validator. The last
// line of output is "CRESTMONT-GATES-SHA256 <hex>" of the gates.json written, which the runner checks.
//
// Usage: node scripts/gates.mjs --package business [--brief BRIEF.json] [--json]

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFrontend } from "./lib/frontend.mjs";
import { migratedDb } from "./lib/d1.mjs";
import { validateConfig } from "./lib/config-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const pkgId = arg("package", "business");
// The package capability matrix (protected copy of the runner's starter manifest; restored before every run).
const matrix = JSON.parse(readFileSync(path.join(ROOT, "scripts", "packages.json"), "utf8"));
const pkg = matrix.packages[pkgId];
const out = { schema: "crestmont.quality-gates/1", package: pkgId, generatedAt: new Date().toISOString(), gates: {}, features: {}, requested: [], scopeChanges: [], missingInformation: [], tests: null };
const gate = (id, name) => (out.gates[id] = { id, name, status: "pass", findings: [], evidence: [] });
const fail = (g, msg) => { g.status = "fail"; g.findings.push(msg); };

if (!pkg) { console.error(`unknown package ${pkgId}`); process.exit(2); }

// ── configuration ──
let config = null;
try { config = JSON.parse(readFileSync(path.join(ROOT, "business.config.json"), "utf8")); } catch (e) { config = null; }
const cfgCheck = config ? validateConfig(config) : { problems: ["business.config.json is missing or not JSON"], missing: [] };
out.missingInformation = cfgCheck.missing;
const features = Object.fromEntries(Object.entries(config?.features ?? {}).filter(([, v]) => v === true));
out.features = features;

// ── the customer's request (BRIEF.json snapshot written by the runner) ──
const briefFile = arg("brief", path.join(ROOT, "BRIEF.json"));
let brief = null;
try { brief = JSON.parse(readFileSync(briefFile, "utf8")); } catch { brief = null; }
const cd = brief?.customerData ?? brief?.content?.customerData ?? null;
const requested = new Set();
for (const f of cd?.features ?? []) {
  const k = typeof f === "string" ? f : f?.key;
  if (k === "contact_form") requested.add("contact");
  else if (k === "booking") requested.add("booking");
  else if (k === "ecommerce") requested.add("payments");
  else if (k) requested.add(`site:${k}`);
}
for (const i of cd?.integrations ?? []) if (/stripe|payment/i.test(String(i))) requested.add("payments");
for (const k of ["contact", "admin", "notifications"]) if (pkg.capabilities.includes(k)) requested.add(k);
out.requested = [...requested];

// ── tests ──
// Child processes run in their own process group, which is killed when they finish (nothing they start outlives
// them). No inherited test-runner context (a parent `node --test` would capture the results) and no NODE_OPTIONS.
const childEnv = { ...process.env, NODE_OPTIONS: "" };
delete childEnv.NODE_TEST_CONTEXT;
function runChild(argv, timeoutMs) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, argv, { cwd: ROOT, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => { if (stdout.length < 20_000_000) stdout += d; });
    c.stderr.on("data", (d) => { if (stderr.length < 2_000_000) stderr += d; });
    const killGroup = () => { try { process.kill(-c.pid, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(killGroup, timeoutMs);
    c.on("close", (code) => { clearTimeout(timer); killGroup(); resolve({ status: code, stdout, stderr }); });
    c.on("error", () => { clearTimeout(timer); resolve({ status: -1, stdout, stderr }); });
  });
}
function parseTap(text) {
  const list = [];
  for (const line of text.split("\n")) {
    const m = /^(\s*)(not ok|ok) \d+ - (.*?)(?:\s+#\s+(SKIP|TODO)\b.*)?$/.exec(line);
    if (!m || m[1].length > 0) continue; // top-level tests only
    const title = m[3];
    // A file-level result (node reports a whole file under its path) is not a test: an "ok" for a file that exited
    // early proves nothing; a "not ok" for a file that failed to load is a failure.
    if (/\.test\.m?js$/.test(title)) { if (m[2] === "not ok") list.push({ title: `${title} (failed to run)`, status: "failed", tags: [] }); continue; }
    list.push({ title, status: m[4] ? "skipped" : m[2] === "ok" ? "passed" : "failed", tags: [...title.matchAll(/\[([a-z0-9:_-]+)\]/g)].map((x) => x[1]) });
  }
  return list;
}
const testFiles = [];
const walk = (d) => { for (const e of readdirSync(d)) { const p = path.join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.test\.m?js$/.test(e)) testFiles.push(p); } };
if (existsSync(path.join(ROOT, "tests"))) walk(path.join(ROOT, "tests"));
// The protected foundation suites run one file at a time: each must load and report at least one passing test, so a
// website cannot make a protected file crash on import and replace its coverage with its own trivial tests.
const FOUNDATION = ["core", "booking", "payments", "admin"].map((n) => path.join(ROOT, "tests", "foundation", `${n}.test.mjs`));
const tests = [];
const integrity = [];
for (const f of FOUNDATION) {
  const r = await runChild(["--no-warnings", "--test", "--test-reporter=tap", f], 600_000);
  const got = parseTap(r.stdout ?? "");
  tests.push(...got);
  const rel = path.relative(ROOT, f);
  // Every test the protected file declares must report a result (passed, failed or skipped): a website cannot make
  // part of a protected suite silently not run (for example by exiting the process early).
  const declared = (readFileSync(f, "utf8").match(/^test\(/gm) ?? []).length;
  if (!got.some((t) => t.status === "passed")) integrity.push(`protected suite ${rel} did not run (no passing test; exit ${r.status})`);
  else if (got.length !== declared) integrity.push(`protected suite ${rel} reported ${got.length} of its ${declared} tests (it did not run completely)`);
  else if (r.status !== 0 && !got.some((t) => t.status === "failed")) integrity.push(`protected suite ${rel} exited ${r.status} without reporting a failed test`);
}
const siteFiles = testFiles.filter((f) => !FOUNDATION.includes(f) && !f.endsWith(`${path.sep}helpers.mjs`));
if (siteFiles.length) {
  const r = await runChild(["--no-warnings", "--test", "--test-reporter=tap", ...siteFiles], 600_000);
  const got = parseTap(r.stdout ?? "");
  tests.push(...got);
  if (r.status !== 0 && !got.some((t) => t.status === "failed")) integrity.push(`site tests exited ${r.status} without reporting a failed test (crashed or failed to load)`);
}
out.tests = { passed: tests.filter((t) => t.status === "passed").length, failed: tests.filter((t) => t.status === "failed").length, skipped: tests.filter((t) => t.status === "skipped").length, files: FOUNDATION.length + siteFiles.length };
const byTag = (tag) => tests.filter((t) => t.tags.includes(tag));
// A test may be skipped only because a feature it exercises is NOT enabled for this website. A skipped test whose
// feature tags are all enabled (or that has no feature tag) is a required test that did not run: it fails the gate.
const FEATURE_TAG = { contact: "contact", quotes: "quotes", booking: "booking", payments: "payments", notifications: "notifications", admin: "admin", "customer-accounts": "customer_accounts", "service-area": "service_area" };
// Configuration-derived "features": a postal-code service area exists only when the business configured one.
const derived = { ...features, service_area: Array.isArray(config?.serviceArea?.postalCodes) && config.serviceArea.postalCodes.length > 0 };
const skipJustified = (t) => t.tags.some((tag) => FEATURE_TAG[tag] && !derived[FEATURE_TAG[tag]]);
/** A tag is satisfied only when at least one test with it PASSED and none failed or was skipped without reason. */
function require(g, tag, why) {
  const ts = byTag(tag);
  const passed = ts.filter((t) => t.status === "passed").length;
  const failed = ts.filter((t) => t.status === "failed");
  const skipped = ts.filter((t) => t.status === "skipped" && !skipJustified(t));
  if (!ts.length || !passed) fail(g, `${why}: no passing test tagged [${tag}]`);
  for (const t of failed) fail(g, `FAILED: ${t.title}`);
  for (const t of skipped) fail(g, `SKIPPED (a required test never counts as passed): ${t.title}`);
  if (passed && !failed.length && !skipped.length) g.evidence.push(`[${tag}] ${passed} test(s) passed`);
}

// Any failed test, any skipped test without a feature reason, and any suite that did not run fails gate C, whatever
// its tags (a file that fails to load is reported untagged, under its path).
const globalProblems = [
  ...integrity,
  ...tests.filter((t) => t.status === "failed").map((t) => `FAILED: ${t.title}`),
  ...tests.filter((t) => t.status === "skipped" && !skipJustified(t)).map((t) => `SKIPPED without a disabled-feature reason (never counts as passed): ${t.title}`),
];

// ── A requirements ──
const A = gate("A", "requirements");
for (const p of cfgCheck.problems) fail(A, `business.config.json: ${p}`);
for (const m of cfgCheck.missing) fail(A, `missing customer information: ${m} (request it from the customer; never invent it)`);
for (const r of requested) {
  if (r.startsWith("site:")) { require(A, `feature:${r.slice(5)}`, `the customer asked for "${r.slice(5)}"; it needs a site implementation with an acceptance test`); continue; }
  if (!pkg.capabilities.includes(r)) { out.scopeChanges.push({ feature: r, reason: `not included in the ${pkgId} package: needs a change order or custom quote before it is built` }); continue; }
  if (!features[r]) fail(A, `the customer asked for ${r} (included in the ${pkgId} package) but business.config.json does not enable it`);
}
for (const f of Object.keys(features)) {
  if (!pkg.capabilities.includes(f)) fail(A, `feature ${f} is enabled but not included in the ${pkgId} package (scope change: needs authorization)`);
  else if (f !== "admin") require(A, f === "customer_accounts" ? "customer-accounts" : f, `feature ${f} is enabled`);
}
if (features.admin) require(A, "admin", "the administration dashboard is enabled");

// ── B frontend ──
const B = gate("B", "frontend");
const fe = runFrontend({ root: ROOT, features, maxPages: pkg.maxPages, seo: pkg.seo });
out.frontend = { pages: fe.pages, errors: fe.errors, warnings: fe.warnings };
for (const e of fe.errors) {
  const target = e.area === "requirements" ? A : e.area === "security" ? null : B;
  if (target) fail(target, `${e.file}: ${e.message}`);
}
if (!fe.errors.some((e) => e.area !== "security")) B.evidence.push(`${fe.pages.length} page(s): HTML, links, forms, accessibility basics, contrast, SEO checked`);

// ── C backend ──
const C = gate("C", "backend");
for (const p of new Set(globalProblems)) fail(C, p);
require(C, "backend", "API behaviour");
require(C, "errors", "structured error handling");
for (const f of ["contact", "quotes", "booking"]) if (features[f]) require(C, f, `${f} API`);

// ── D database ──
const D = gate("D", "database");
try {
  const { db, applied } = migratedDb(ROOT);
  const fk = db.db.prepare("PRAGMA foreign_key_check").all();
  if (fk.length) fail(D, `foreign key violations after migrations: ${fk.length}`);
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ["bookings", "services", "payments", "notifications", "audit_log", "admin_users", "sessions"]) if (!tables.includes(t)) fail(D, `table ${t} is missing after migrations`);
  const names = applied.map((f) => Number(f.slice(0, 4)));
  if (names.some((n, i) => n !== i + 1)) fail(D, `migration files must be numbered 0001, 0002, … without gaps (${applied.join(", ")})`);
  D.evidence.push(`${applied.length} migration(s) applied to a fresh database; foreign keys enforced`);
  db.close();
} catch (e) { fail(D, `migrations do not apply to a fresh database: ${String(e.message).slice(0, 200)}`); }
require(D, "database", "persistence");
if (features.booking) require(D, "concurrency", "double-booking prevention");

// ── E integrations ──
const E = gate("E", "integrations");
// Provider verifications are read ONLY from the file the Crestmont runner writes right before this run, from its own
// broker record (the builder's .crestmont/integration-results.json is informational and never trusted here).
let results = [];
try { const v = JSON.parse(readFileSync(path.join(ROOT, ".crestmont", "quality", "verifications.json"), "utf8")); results = v?.schema === "crestmont.verifications/1" && Array.isArray(v.operations) ? v.operations : []; } catch { results = []; }
const verified = (op) => results.some((r) => r.operation === op && r.status === "passed");
out.integrations = [];
if (features.payments) {
  require(E, "payments", "payments (offline, signed fake webhooks)");
  require(E, "webhooks", "webhook verification");
  const v = verified("stripe.verify_test_key");
  out.integrations.push({ key: "stripe", offline: "tested", providerVerification: v ? "verified_test_mode" : "pending", paidBy: "customer" });
  if (!v && E.status === "pass") { E.status = "pending_external"; E.findings.push("Stripe: the customer's test-mode key has not been verified by the runner's approved operation (stripe.verify_test_key)"); }
}
if (features.notifications) {
  require(E, "notifications", "transactional email outbox");
  const v = verified("resend.verify_sending_domain");
  out.integrations.push({ key: "resend", offline: "tested", providerVerification: v ? "verified_domain" : "pending", paidBy: "customer" });
  if (!v && E.status === "pass") { E.status = "pending_external"; E.findings.push("Email: the customer's own Resend account has no verified sending domain yet (approved operation resend.verify_sending_domain)"); }
}
if (!features.payments && !features.notifications) E.status = "not_applicable";

// ── F security ──
const F = gate("F", "security");
require(F, "security", "security controls");
if (features.admin || features.customer_accounts) { require(F, "auth", "authentication"); require(F, "csrf", "CSRF protection"); }
if (features.admin) require(F, "authorization", "role-based authorization");
if (features.payments) require(F, "webhooks", "webhook signatures");
for (const e of fe.errors.filter((x) => x.area === "security")) fail(F, `${e.file}: ${e.message}`);

// ── G performance ──
const G = gate("G", "performance");
const pub = path.join(ROOT, "public");
const weight = (p) => { let n = 0; const html = readFileSync(p, "utf8"); n += Buffer.byteLength(html); for (const m of html.matchAll(/(?:href|src)=["'](\/assets\/[^"']+\.(?:css|js))["']/g)) { const f = path.join(pub, m[1]); if (existsSync(f)) n += statSync(f).size; } return n; };
for (const p of fe.pages) { const w = weight(path.join(ROOT, p)); if (w > 250_000) fail(G, `${p}: ${Math.round(w / 1024)} KB of HTML/CSS/JS (budget 250 KB)`); }
for (const e of fe.errors.filter((x) => x.area === "performance")) fail(G, `${e.file}: ${e.message}`);
// Latency is measured from THIS process over HTTP against the Worker running in a separate process group.
{
  let server = null;
  try {
    server = spawn(process.execPath, ["--no-warnings", path.join(ROOT, "scripts", "lib", "serve.mjs")], { cwd: ROOT, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const port = await new Promise((resolve, reject) => {
      let buf = "";
      const t = setTimeout(() => reject(new Error("the website did not start within 20 s")), 20_000);
      server.stdout.on("data", (d) => { buf += d; const m = /\{"port":(\d+)\}/.exec(buf); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      server.on("exit", (code) => { clearTimeout(t); reject(new Error(`the website exited (${code}) before serving`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const times = [];
    for (let i = 0; i < 40; i++) {
      const s0 = performance.now();
      const a = await fetch(`${base}/api/services`), b = await fetch(`${base}/api/config`);
      await a.arrayBuffer(); await b.arrayBuffer();
      if (!a.ok || !b.ok) throw new Error(`API answered ${a.status}/${b.status}`);
      times.push(performance.now() - s0);
    }
    times.sort((x, y) => x - y);
    const p95 = times[Math.floor(times.length * 0.95)];
    out.performance = { localApiP95Ms: Math.round(p95 * 10) / 10, note: "measured offline over local HTTP against the local database; staging latency is measured by the runner's browser checks" };
    if (p95 > 100) fail(G, `local API p95 ${p95.toFixed(1)} ms exceeds the 100 ms budget`);
    else G.evidence.push(`local API p95 ${p95.toFixed(1)} ms; page weight within budget`);
  } catch (e) { fail(G, `performance measurement failed: ${String(e.message).slice(0, 200)}`); }
  finally { if (server?.pid) { try { process.kill(-server.pid, "SIGKILL"); } catch { /* gone */ } } }
}

// ── J deployment readiness ──
const J = gate("J", "deployment");
try {
  const raw = readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const w = JSON.parse(raw);
  if (w.main !== "src/worker.js") fail(J, "wrangler.jsonc main must be src/worker.js");
  if (w.assets?.directory !== "./public") fail(J, "wrangler.jsonc assets.directory must be ./public");
  if (!(w.d1_databases ?? []).some((d) => d.binding === "DB" && d.migrations_dir === "migrations")) fail(J, "wrangler.jsonc needs the D1 binding DB with migrations_dir \"migrations\"");
  if (w.routes || w.route || w.custom_domains) fail(J, "routes / custom domains are set by Crestmont delivery, never in the repository");
  for (const [k, v] of Object.entries(w.vars ?? {})) if (/SECRET|TOKEN|KEY|PASSWORD/i.test(k) || /^(sk|rk|whsec|re)_/.test(String(v))) fail(J, `wrangler.jsonc vars.${k} looks like a secret (use wrangler secret put on the customer's account)`);
} catch (e) { fail(J, `wrangler.jsonc is not valid: ${String(e.message).slice(0, 120)}`); }
if (!existsSync(path.join(ROOT, "DEPLOY.md")) || !/rollback/i.test(readFileSync(path.join(ROOT, "DEPLOY.md"), "utf8"))) fail(J, "DEPLOY.md with the deployment and rollback procedure is missing");
require(J, "deployment", "health check");

// ── result ──
const required = ["A", "B", "C", "D", "F", "G", "J"];
const failed = Object.values(out.gates).filter((g) => g.status === "fail");
out.summary = { failed: failed.map((g) => g.id), pendingExternal: Object.values(out.gates).filter((g) => g.status === "pending_external").map((g) => g.id), passed: Object.values(out.gates).filter((g) => g.status === "pass").map((g) => g.id) };
mkdirSync(path.join(ROOT, ".crestmont", "quality"), { recursive: true });
const serialized = JSON.stringify(out, null, 2) + "\n";
writeFileSync(path.join(ROOT, ".crestmont", "quality", "gates.json"), serialized);
if (args.includes("--json")) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
else {
  for (const g of Object.values(out.gates)) {
    process.stdout.write(`${g.status.toUpperCase().padEnd(16)} ${g.id} ${g.name}\n`);
    for (const f of g.findings.slice(0, 25)) process.stdout.write(`    - ${f}\n`);
  }
  if (out.scopeChanges.length) process.stdout.write(`\nScope changes (not built; need authorization): ${out.scopeChanges.map((s) => s.feature).join(", ")}\n`);
  process.stdout.write(`\nTests: ${out.tests.passed} passed, ${out.tests.failed} failed, ${out.tests.skipped} skipped. Gates failed: ${out.summary.failed.join(", ") || "none"}; pending external verification: ${out.summary.pendingExternal.join(", ") || "none"}.\n`);
}
process.stdout.write(`CRESTMONT-GATES-SHA256 ${createHash("sha256").update(serialized).digest("hex")}\n`);
process.exit(failed.some((g) => required.includes(g.id) || g.id === "E") ? 1 : 0);
