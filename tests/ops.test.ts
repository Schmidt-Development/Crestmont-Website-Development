// Operations: deployment recorder, release authorization, environment probe, retention, backup/restore,
// Founder report, deployment workflows. All records created here are TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createTestApp, createStaff, createCustomer, lastEmail, linkFrom, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { signEvidence, ingestEvidence } from "../src/readiness/ingest.ts";
import { buildReport, loadReadinessInput } from "../src/readiness/report.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { nowIso, newId } from "../src/lib/db.ts";
import { buildFounderReport, signedGetCanonical } from "../src/routes/ops.ts";
import { probeEnvironments, validEnvUrl } from "../src/services/deployments.ts";
import { runRetention } from "../src/services/retention.ts";
import { runJobs, SCHEDULE } from "../src/app/scheduled.ts";
import { exportSql } from "../scripts/backup-export.ts";
import { restoreAndVerify, recordDrill } from "../scripts/restore-verify.ts";
import type { PaymentsAdapter, CheckoutRequest } from "../src/adapters/payments.ts";
import type { Env } from "../src/app/context.ts";

const SECRET = "ops-test-ingest-secret";
const WHSEC = "whsec_ops_test";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const CFG = "c".repeat(64);
/** node:sqlite returns null-prototype rows; copy to a plain object for deep equality. */
const plain = (r: object | null) => ({ ...(r ?? {}) });

class FakePayments implements PaymentsAdapter {
  readonly configured = true;
  readonly mode = "test" as const;
  checkouts: CheckoutRequest[] = [];
  async createCheckout(req: CheckoutRequest) { this.checkouts.push(req); const id = `cs_test_ops_${this.checkouts.length}`; return { id, url: `https://checkout.stripe.com/c/pay/${id}` }; }
  async createBillingPortal() { return { url: "https://billing.stripe.com/p/session/test" }; }
  async createRefund(pi: string, amount: number) { return { id: `re_test_${pi}_${amount}`, status: "succeeded" }; }
}

async function setup(extra: Partial<Env> = {}) {
  const fake = new FakePayments();
  const app = await createTestApp({ EVIDENCE_INGEST_SECRET: SECRET, STRIPE_WEBHOOK_SECRET: WHSEC, overrides: { payments: fake }, ...extra });
  const owner = await createStaff(app.db, "owner", "owner@crestmont.test", "Olivia Owner");
  const admin = await createStaff(app.db, "administrator", "admin@crestmont.test", "Adam Admin");
  const o = await app.client().login(owner.email, TEST_PASSWORD, owner.secret);
  const ad = await app.client().login(admin.email, TEST_PASSWORD, admin.secret);
  return { ...app, fake, owner, admin, o, ad };
}

const signedPost = async (c: TestClient, path: string, doc: unknown, secret = SECRET) => {
  const body = JSON.stringify(doc);
  return c.request("POST", path, { body, headers: { "content-type": "application/json", "x-crestmont-signature": await signEvidence(secret, body) } });
};
const signedGet = async (c: TestClient, path: string, secret = SECRET) => {
  const url = new URL(path, "http://crestmont.test");
  return c.request("GET", path, { headers: { "x-crestmont-signature": await signEvidence(secret, signedGetCanonical(url)) } });
};
const deployment = (over: Record<string, unknown> = {}) => ({ deploymentId: `gh-${Math.floor(Math.random() * 1e9)}-1-staging`, environment: "staging", commitSha: COMMIT, status: "succeeded", initiatedBy: "github-actions:test", url: "https://staging.crestmont.example", ...over });

/** Owner creates a release candidate and approves it through the real Founder panel. */
async function approve(o: TestClient, commit = COMMIT) {
  assert.equal((await o.post("/staff/readiness/releases", { commit_sha: commit, config_sha256: CFG, notes: "Release candidate notes", rollback_plan: "wrangler rollback to the previous version" })).status, 303);
  const panel = await (await o.get("/staff/readiness/approve")).text();
  const ev = /name="evidence_set" value="([0-9a-f]{64})"/.exec(panel)![1];
  assert.equal((await o.post("/staff/readiness/approve", { decision: "approved", confirm_commit: commit, evidence_set: ev })).status, 303);
}

// ───────────── Signature checks fail closed ─────────────

test("[READY-009] deployment and release-candidate endpoints fail closed without a valid signature", async () => {
  const t = await setup();
  const c = t.client();
  const doc = deployment();
  const body = JSON.stringify(doc);
  const post = (sig?: string) => c.request("POST", "/api/readiness/deployments", { body, headers: { "content-type": "application/json", ...(sig ? { "x-crestmont-signature": sig } : {}) } });
  assert.equal((await post()).status, 401, "missing signature");
  assert.equal((await post("t=1,v1=" + "0".repeat(64))).status, 401, "stale/forged signature");
  assert.equal((await post(await signEvidence("wrong-secret", body))).status, 401, "wrong secret");
  // Signature over a different body is rejected.
  assert.equal((await post(await signEvidence(SECRET, body + " "))).status, 401);
  // A cookie-authenticated Owner session is not a substitute for the signature.
  assert.equal((await t.o.request("POST", "/api/readiness/deployments", { body, headers: { "content-type": "application/json" } })).status, 401);
  assert.equal((await signedPost(c, "/api/readiness/release-candidates", { tag: "v1.0.0", commitSha: COMMIT, configSha256: CFG, notes: "Some release notes", rollbackPlan: "rollback plan text" }, "nope")).status, 401);
  // Not configured → refused, never accepted.
  const bare = await createTestApp({});
  assert.equal((await signedPost(bare.client(), "/api/readiness/deployments", doc)).status, 401);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM deployments`).first<{ n: number }>())!.n, 0);
});

test("[LAUNCH-002] release-authorization requires a signature or staff session and grants nothing", async () => {
  const t = await setup();
  const anon = t.client();
  assert.equal((await anon.get(`/api/readiness/release-authorization?commit=${COMMIT}`)).status, 401);
  // A signature for a different query is rejected (the canonical string binds the query).
  const url = new URL(`/api/readiness/release-authorization?commit=${OTHER}`, "http://crestmont.test");
  const sig = await signEvidence(SECRET, signedGetCanonical(url));
  assert.equal((await anon.request("GET", `/api/readiness/release-authorization?commit=${COMMIT}`, { headers: { "x-crestmont-signature": sig } })).status, 401);
  const cust = await createCustomer(t.db);
  const cc = await t.client().login(cust.email);
  assert.equal((await cc.get(`/api/readiness/release-authorization?commit=${COMMIT}`)).status, 401, "customers are not staff");
  const before = await t.db.prepare(`SELECT (SELECT COUNT(*) FROM release_approvals) a, (SELECT COUNT(*) FROM releases) r`).first<{ a: number; r: number }>();
  const res = await signedGet(anon, `/api/readiness/release-authorization?commit=${COMMIT}`);
  assert.equal(res.status, 200);
  const j = await res.json() as { authorized: boolean; reason: string };
  assert.equal(j.authorized, false);
  assert.match(j.reason, /no release candidate/i);
  const after = await t.db.prepare(`SELECT (SELECT COUNT(*) FROM release_approvals) a, (SELECT COUNT(*) FROM releases) r`).first<{ a: number; r: number }>();
  assert.deepEqual(after, before, "read-only");
  assert.equal((await signedGet(anon, `/api/readiness/release-authorization?commit=xyz`)).status, 422);
});

// ───────────── Release authorization ─────────────

test("[LAUNCH-002] release-authorization is true only for the exact approved commit and false after invalidation", async () => {
  const t = await setup();
  const c = t.client();
  await ingestEvidence(t.db, JSON.stringify({ runId: "ci-ops-1", source: "ci", environment: "development", commitSha: COMMIT.slice(0, 7), startedAt: nowIso(), finishedAt: nowIso(), results: [{ requirementId: "DATA-001", testName: "t", outcome: "passed" }] }));
  await approve(t.o);
  const ask = async (commit: string, config?: string) => (await (await signedGet(c, `/api/readiness/release-authorization?commit=${commit}${config ? `&config=${config}` : ""}`)).json()) as { authorized: boolean; reason: string };
  const ok = await ask(COMMIT);
  assert.equal(ok.authorized, true, ok.reason);
  assert.equal((await ask(COMMIT, CFG)).authorized, true);
  assert.equal((await ask(COMMIT, "d".repeat(64))).authorized, false, "different deployment configuration");
  assert.equal((await ask(OTHER)).authorized, false, "different commit");
  assert.equal((await ask(COMMIT.slice(0, 12))).authorized, false, "abbreviated SHA is not an exact match");
  // Staff session (read-only) sees the same answer.
  assert.equal(((await (await t.ad.get(`/api/readiness/release-authorization?commit=${COMMIT}`)).json()) as { authorized: boolean }).authorized, true);
  // New evidence changes the evidence set → no longer authorized.
  await ingestEvidence(t.db, JSON.stringify({ runId: "ci-ops-2", source: "ci", environment: "development", commitSha: COMMIT.slice(0, 7), startedAt: nowIso(), finishedAt: nowIso(), results: [{ requirementId: "CRM-003", testName: "t", outcome: "passed" }] }));
  const drift = await ask(COMMIT);
  assert.equal(drift.authorized, false);
  assert.match(drift.reason, /Evidence set changed/);
  // Re-approve, then a new release candidate explicitly invalidates the approval.
  const panel = await (await t.o.get("/staff/readiness/approve")).text();
  const ev = /name="evidence_set" value="([0-9a-f]{64})"/.exec(panel)![1];
  await t.o.post("/staff/readiness/approve", { decision: "approved", confirm_commit: COMMIT, evidence_set: ev });
  assert.equal((await ask(COMMIT)).authorized, true);
  await t.o.post("/staff/readiness/releases", { commit_sha: OTHER, config_sha256: CFG, notes: "Second candidate notes", rollback_plan: "Same rollback plan" });
  assert.equal((await ask(COMMIT)).authorized, false);
  assert.equal((await ask(OTHER)).authorized, false, "the new candidate has no approval yet");
  // A rejection is never authorization.
  const p2 = await (await t.o.get("/staff/readiness/approve")).text();
  await t.o.post("/staff/readiness/approve", { decision: "rejected", confirm_commit: OTHER, evidence_set: /name="evidence_set" value="([0-9a-f]{64})"/.exec(p2)![1] });
  assert.equal((await ask(OTHER)).authorized, false);
});

test("[INFRA-005] release candidates from tags are idempotent and supersede approvals only for a new build", async () => {
  const t = await setup();
  const c = t.client();
  await approve(t.o);
  const doc = { tag: "v1.0.0", commitSha: COMMIT, configSha256: CFG, notes: "Tagged release notes", rollbackPlan: "wrangler rollback --env production" };
  const r1 = await (await signedPost(c, "/api/readiness/release-candidates", doc)).json() as { status: string; releaseId: string };
  assert.equal(r1.status, "unchanged", "same commit + config as the approved candidate: approval survives");
  assert.equal(((await (await signedGet(c, `/api/readiness/release-authorization?commit=${COMMIT}`)).json()) as { authorized: boolean }).authorized, true);
  const r2 = await (await signedPost(c, "/api/readiness/release-candidates", { ...doc, tag: "v1.0.1", commitSha: OTHER })).json() as { status: string; releaseId: string };
  assert.equal(r2.status, "created");
  const rel = await t.db.prepare(`SELECT commit_sha, notes, created_by FROM releases WHERE id = ?`).bind(r2.releaseId).first<{ commit_sha: string; notes: string; created_by: string | null }>();
  assert.equal(rel!.commit_sha, OTHER);
  assert.match(rel!.notes, /^Tag v1\.0\.1/);
  assert.equal(rel!.created_by, null, "automation, not a person");
  assert.ok((await t.db.prepare(`SELECT invalidated_at FROM release_approvals WHERE kind='production_launch'`).first<{ invalidated_at: string | null }>())!.invalidated_at);
  assert.equal((await signedPost(c, "/api/readiness/release-candidates", { ...doc, commitSha: COMMIT.slice(0, 12) })).status, 422, "full SHA required");
});

// ───────────── Deployment recording ─────────────

test("[READY-009] signed deployments are recorded, updated through allowed transitions, and shown on the timeline and env view", async () => {
  const t = await setup();
  const c = t.client();
  const d1 = deployment({ deploymentId: "gh-100-1-staging", status: "started" });
  const r1 = await (await signedPost(c, "/api/readiness/deployments", d1)).json() as { status: string; releaseCheck: string };
  assert.deepEqual([r1.status, r1.releaseCheck], ["recorded", "not_applicable"]);
  const r2 = await (await signedPost(c, "/api/readiness/deployments", { ...d1, status: "succeeded", verificationStatus: "passed" })).json() as { status: string };
  assert.equal(r2.status, "updated");
  const row = await t.db.prepare(`SELECT status, verification_status, commit_sha, url FROM deployments WHERE id = 'gh-100-1-staging'`).first<{ status: string; verification_status: string; commit_sha: string; url: string }>();
  assert.deepEqual(plain(row), { status: "succeeded", verification_status: "passed", commit_sha: COMMIT, url: "https://staging.crestmont.example" });
  // Illegal transition and id reuse for another commit are refused.
  assert.equal((await signedPost(c, "/api/readiness/deployments", { ...d1, status: "started" })).status, 409);
  assert.equal((await signedPost(c, "/api/readiness/deployments", { ...d1, commitSha: OTHER })).status, 409);
  // Validation: non-https URL, unknown release.
  assert.equal((await signedPost(c, "/api/readiness/deployments", deployment({ url: "http://insecure.example" }))).status, 422);
  assert.equal((await signedPost(c, "/api/readiness/deployments", deployment({ releaseId: "rel_missing" }))).status, 422);
  assert.ok((await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'deployment.recorded' AND subject_id = 'gh-100-1-staging'`).first()));
  const timeline = await (await t.o.get("/staff/readiness/releases")).text();
  assert.match(timeline, /data-kind="deployment"/);
  assert.match(timeline, /gh-100-1-staging/);
  const env = await (await t.o.get("/staff/readiness/env/staging")).text();
  assert.match(env, new RegExp(COMMIT));
  const ops = await (await t.ad.get("/staff/ops")).text();
  assert.match(ops, /gh-100-1-staging/);
});

test("[TEST-004] a rollback record links to its target deployment; invalid targets are refused", async () => {
  const t = await setup();
  const c = t.client();
  await signedPost(c, "/api/readiness/deployments", deployment({ deploymentId: "dep-a", commitSha: OTHER }));
  const b = await (await signedPost(c, "/api/readiness/deployments", deployment({ deploymentId: "dep-b" }))).json() as { rollbackTargetDeploymentId: string };
  assert.equal(b.rollbackTargetDeploymentId, "dep-a", "defaults to the previous successful deployment in the same environment");
  await signedPost(c, "/api/readiness/deployments", deployment({ deploymentId: "dep-b", status: "rolled_back", verificationStatus: "failed", rollbackTargetDeploymentId: "dep-a" }));
  const row = await t.db.prepare(`SELECT d.status, d.rollback_target_deployment_id, t.commit_sha AS target_commit FROM deployments d JOIN deployments t ON t.id = d.rollback_target_deployment_id WHERE d.id = 'dep-b'`).first<{ status: string; rollback_target_deployment_id: string; target_commit: string }>();
  assert.deepEqual(plain(row), { status: "rolled_back", rollback_target_deployment_id: "dep-a", target_commit: OTHER });
  // A rolled-back deployment is final.
  assert.equal((await signedPost(c, "/api/readiness/deployments", deployment({ deploymentId: "dep-b", status: "succeeded" }))).status, 409);
  // Targets must exist, be in the same environment and have succeeded.
  assert.equal((await signedPost(c, "/api/readiness/deployments", deployment({ deploymentId: "dep-c", rollbackTargetDeploymentId: "nope" }))).status, 422);
  assert.equal((await signedPost(c, "/api/readiness/deployments", deployment({ deploymentId: "dep-d", environment: "production", rollbackTargetDeploymentId: "dep-a" }))).status, 422);
  assert.equal((await signedPost(c, "/api/readiness/deployments", deployment({ deploymentId: "dep-e", rollbackTargetDeploymentId: "dep-b" }))).status, 422, "rolled-back deployment is not a valid target");
  assert.match(await (await t.o.get("/staff/readiness/releases")).text(), /rollback target dep-a/);
});

test("[LAUNCH-002] a production deployment that differs from the approved release candidate is flagged and opens an incident", async () => {
  const t = await setup();
  const c = t.client();
  await approve(t.o);
  // Matching commit.
  const ok = await (await signedPost(c, "/api/readiness/deployments", deployment({ deploymentId: "prod-1", environment: "production", url: "https://crestmont.example" }))).json() as { releaseCheck: string; incidentBlockerId: string | null };
  assert.deepEqual([ok.releaseCheck, ok.incidentBlockerId], ["matches_approved_release", null]);
  // Different commit → mismatch, critical production incident linked to LAUNCH-002.
  const bad = await (await signedPost(c, "/api/readiness/deployments", deployment({ deploymentId: "prod-2", environment: "production", commitSha: OTHER, url: "https://crestmont.example" }))).json() as { releaseCheck: string; incidentBlockerId: string };
  assert.equal(bad.releaseCheck, "mismatch");
  const blk = await t.db.prepare(`SELECT category, severity, status FROM blockers WHERE id = ?`).bind(bad.incidentBlockerId).first<{ category: string; severity: string; status: string }>();
  assert.deepEqual(plain(blk), { category: "production_incident", severity: "critical", status: "open" });
  assert.ok(await t.db.prepare(`SELECT 1 FROM blocker_requirements WHERE blocker_id = ? AND requirement_id = 'LAUNCH-002'`).bind(bad.incidentBlockerId).first());
  // Production needs a full SHA.
  assert.equal((await signedPost(c, "/api/readiness/deployments", deployment({ deploymentId: "prod-3", environment: "production", commitSha: "abc1234" }))).status, 422);
  // The existing production view shows the incident and the ops page shows the indicator.
  const prodView = await (await t.o.get("/staff/readiness/env/production")).text();
  assert.match(prodView, new RegExp(bad.incidentBlockerId));
  const ops = await (await t.o.get("/staff/ops")).text();
  assert.match(ops, /Production does not match the Founder-approved release candidate/);
  assert.match(ops, /Does not match approved release/);
  assert.match(ops, /Matches approved release/);
  // Gate H reports the incident blocker.
  const report = await buildReport(await loadReadinessInput(t.db));
  assert.ok(report.gates.find((g) => g.id === "H")!.blockers.includes(bad.incidentBlockerId));
  // Without any approval, a production deployment is a mismatch too.
  const t2 = await setup();
  const none = await (await signedPost(t2.client(), "/api/readiness/deployments", deployment({ deploymentId: "prod-x", environment: "production" }))).json() as { releaseCheck: string };
  assert.equal(none.releaseCheck, "mismatch");
});

// ───────────── Environment probe ─────────────

function fakeFetch(opts: { resolve?: boolean; healthEnv?: string; healthStatus?: number; tlsFail?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.startsWith("https://cloudflare-dns.com/")) return new Response(JSON.stringify(opts.resolve === false ? { Status: 3 } : { Status: 0, Answer: [{ data: "104.21.0.1" }] }), { headers: { "content-type": "application/dns-json" } });
    if (opts.tlsFail) throw new TypeError("fetch failed: certificate has expired");
    return new Response(JSON.stringify({ status: "ok", environment: opts.healthEnv ?? "production" }), { status: opts.healthStatus ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("[READY-006] environment probe records dns/monitoring health only for configured URLs and production evidence only when it ran", async () => {
  const t = await setup();
  const ctx = (settings: Record<string, string>) => ({ db: t.db, settings, now: () => new Date() });
  // Nothing configured → nothing written.
  const none = await probeEnvironments(ctx({}), fakeFetch());
  assert.ok(none.every((o) => !o.ran));
  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM integration_health WHERE environment IN ('staging','production')`).first<{ n: number }>())!.n, 0);
  // SSRF guard on configured URLs.
  for (const bad of ["http://x.example", "https://127.0.0.1", "https://localhost", "https://a.internal", "https://u:p@x.example", "https://x.example:8443"]) assert.equal(validEnvUrl(bad), null, bad);
  assert.equal(validEnvUrl("https://staging.crestmont.example/path"), "https://staging.crestmont.example");
  // Production URL configured but no recorded deployment: health rows written, but no evidence (no deployed commit to attribute).
  const s = { "env.production.url": "https://crestmont.example" };
  const r1 = await probeEnvironments(ctx(s), fakeFetch());
  assert.equal(r1.find((o) => o.environment === "production")!.ran, true);
  assert.equal(r1.find((o) => o.environment === "production")!.evidenceRunId, null);
  const dns = await t.db.prepare(`SELECT status, detail FROM integration_health WHERE integration='dns' AND environment='production'`).first<{ status: string; detail: string }>();
  assert.equal(dns!.status, "configured_unverified", "resolution + TLS never claims verified DNS control");
  assert.match(dns!.detail, /TLS valid/);
  // With a production deployment: evidence for the deployed commit, once per change.
  await signedPost(t.client(), "/api/readiness/deployments", deployment({ deploymentId: "prod-p", environment: "production" }));
  const r2 = await probeEnvironments(ctx(s), fakeFetch());
  const runId = r2.find((o) => o.environment === "production")!.evidenceRunId!;
  assert.ok(runId);
  const run = await t.db.prepare(`SELECT source, environment, commit_sha FROM evidence_runs WHERE id = ?`).bind(runId).first<{ source: string; environment: string; commit_sha: string }>();
  assert.deepEqual(plain(run), { source: "production_check", environment: "production", commit_sha: COMMIT });
  const again = await probeEnvironments(ctx(s), fakeFetch());
  assert.equal(again.find((o) => o.environment === "production")!.evidenceRunId, null, "unchanged outcome → no evidence churn");
  // Health served by the wrong environment / TLS failure → failing, and new failed evidence.
  await new Promise((r) => setTimeout(r, 1100));
  const wrong = await probeEnvironments(ctx(s), fakeFetch({ healthEnv: "staging" }));
  assert.ok(wrong.find((o) => o.environment === "production")!.evidenceRunId);
  assert.equal((await t.db.prepare(`SELECT status FROM integration_health WHERE integration='monitoring' AND environment='production'`).first<{ status: string }>())!.status, "failing");
  await new Promise((r) => setTimeout(r, 1100));
  await probeEnvironments(ctx(s), fakeFetch({ tlsFail: true }));
  const tls = await t.db.prepare(`SELECT status, detail FROM integration_health WHERE integration='dns' AND environment='production'`).first<{ status: string; detail: string }>();
  assert.equal(tls!.status, "failing");
  assert.match(tls!.detail, /TLS not confirmed/);
  // Staff can set URLs (validated) and trigger the probe; the scheduled job skips cleanly when unset.
  assert.equal((await t.ad.post("/staff/ops/environments", { staging_url: "http://insecure.example", production_url: "https://crestmont.example" })).status, 422);
  assert.equal((await t.ad.post("/staff/ops/environments", { staging_url: "https://staging.crestmont.example", production_url: "https://crestmont.example" })).status, 303);
  assert.equal((await t.db.prepare(`SELECT value FROM business_settings WHERE key = 'env.staging.url'`).first<{ value: string }>())!.value, "https://staging.crestmont.example");
  const bare = await createTestApp();
  const jr = await runJobs(bare.env, ["env_probe"]);
  assert.equal(jr.env_probe.ok, true);
  assert.match(jr.env_probe.detail, /skipped/);
});

test("[LAUNCH-003] the scheduled schedule contains the probe and retention jobs and every cron is declared in wrangler.toml for each environment", () => {
  const jobs = Object.values(SCHEDULE).flat();
  assert.ok(jobs.includes("env_probe"));
  assert.ok(jobs.includes("retention"));
  const toml = readFileSync("wrangler.toml", "utf8");
  for (const block of ["[env.staging]", "[env.production]"]) {
    const start = toml.indexOf(block);
    assert.ok(start > 0, block);
    const next = toml.indexOf("\n[env.", start + 1);
    const section = toml.slice(start, next > 0 ? next : undefined);
    for (const cron of Object.keys(SCHEDULE)) assert.ok(section.includes(`"${cron}"`), `${block} declares ${cron}`);
    assert.match(section, /database_name = "crestmont-(staging|production)"/);
  }
  assert.doesNotMatch(toml, /(sk_live_|sk_test_|whsec_[A-Za-z0-9]{8}|re_[A-Za-z0-9]{20})/, "no secrets in wrangler.toml");
});

// ───────────── Retention ─────────────

test("[SEC-006] retention always purges only expired operational data and applies other periods only when staff set them", async () => {
  const t = await setup();
  const db = t.db;
  const old = new Date(Date.now() - 400 * 86400e3).toISOString();
  const recent = new Date(Date.now() - 5 * 86400e3).toISOString();
  const future = new Date(Date.now() + 5 * 86400e3).toISOString();
  const uid = t.owner.id;
  const rawExec = (sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).run();
  // Sessions: old expired, old revoked, recently revoked (kept), live (kept).
  for (const [id, exp, rev] of [["s_old_exp", old, null], ["s_old_rev", future, old], ["s_recent_rev", future, recent], ["s_live", future, null]] as const) {
    await rawExec(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?)`, id, uid, `h_${id}`, old, exp, rev);
  }
  await rawExec(`INSERT INTO rate_limits (key, window_start, count) VALUES ('old', ?, 3), ('now', ?, 1)`, Math.floor(Date.parse(old) / 1000), Math.floor(Date.now() / 1000));
  await rawExec(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at, used_at, created_at) VALUES ('t_old', ?, 'password_reset', ?, NULL, ?), ('t_live', ?, 'password_reset', ?, NULL, ?)`, uid, old, old, uid, future, recent);
  // Personal data with configurable periods.
  await rawExec(`INSERT INTO security_events (kind, email, ip, created_at) VALUES ('login_failed','x@example.com','1.2.3.4',?), ('login_failed','y@example.com','1.2.3.5',?)`, old, recent);
  await rawExec(`INSERT INTO email_deliveries (id, template, to_email, idempotency_key, status, created_at, updated_at) VALUES ('ed_old','invoice','a@example.com','k1','sent',?,?), ('ed_new','invoice','b@example.com','k2','sent',?,?)`, old, old, recent, recent);
  await rawExec(`INSERT INTO email_messages (delivery_id, provider, subject, html_body, text_body) VALUES ('ed_old','dev-outbox','s','<p>h</p>','t'), ('ed_new','dev-outbox','s','<p>h</p>','t')`);
  await rawExec(`INSERT INTO app_errors (path, message, created_at) VALUES ('/x','old',?), ('/y','new',?)`, old, recent);
  await rawExec(`INSERT INTO calls (id, provider, provider_call_id, direction, recording_consent, transcript, recording_url, started_at, ended_at) VALUES ('call_old','retell','c1','inbound',1,'hello','https://rec.example/1',?,?)`, old, old);
  const cust = await createCustomer(db);
  await t.storage.put("files/old.pdf", new Uint8Array([1, 2, 3]), "application/pdf");
  await rawExec(`INSERT INTO files (id, organization_id, r2_key, filename, content_type, size_bytes, sha256, scan_status, uploaded_by, deleted_at, created_at) VALUES ('f_old', ?, 'files/old.pdf', 'old.pdf', 'application/pdf', 3, 'x', 'clean', ?, ?, ?)`, cust.organizationId, uid, old, old);
  // Financial + agreements + audit must never be touched.
  await rawExec(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES ('ord_ret', ?, 'starter', 99900, 'paid', 'package', ?)`, cust.organizationId, old);
  await rawExec(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, created_at) VALUES ('inv_ret', ?, 'ord_ret', 'full', 99900, 'paid', ?)`, cust.organizationId, old);
  const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
  const auditBefore = await count(`SELECT COUNT(*) n FROM audit_logs`);
  const agreementsBefore = await count(`SELECT COUNT(*) n FROM agreements`);

  // Run 1: defaults (personal-data categories OFF).
  const r1 = await runRetention({ db, storage: t.storage });
  const by = (rs: typeof r1, c: string) => rs.find((r) => r.category === c)!;
  assert.equal(by(r1, "sessions").affected, 2);
  assert.deepEqual((await db.prepare(`SELECT id FROM sessions WHERE id IN ('s_old_exp','s_old_rev','s_recent_rev','s_live') ORDER BY id`).all<{ id: string }>()).results.map((r) => r.id), ["s_live", "s_recent_rev"]);
  assert.equal(by(r1, "rate_limits").affected, 1);
  assert.equal(by(r1, "auth_tokens").affected, 1);
  for (const c of ["security_events", "email_bodies", "app_errors", "voice_transcripts", "deleted_files"]) assert.equal(by(r1, c).mode, "skipped", c);
  assert.equal(await count(`SELECT COUNT(*) n FROM security_events`), 2);
  assert.equal(await count(`SELECT COUNT(*) n FROM email_messages`), 2);
  assert.equal(await count(`SELECT COUNT(*) n FROM app_errors`), 2);
  assert.equal((await db.prepare(`SELECT transcript FROM calls WHERE id='call_old'`).first<{ transcript: string }>())!.transcript, "hello");
  assert.ok(t.storage.objects.has("files/old.pdf"));

  // Only the Owner may set periods; an administrator is refused. Invalid values are rejected.
  assert.equal((await t.ad.post("/staff/ops/retention", { "retention.security_events_days": "365" })).status, 403);
  assert.equal((await t.o.post("/staff/ops/retention", { "retention.app_errors_days": "1" })).status, 422);
  assert.equal((await t.o.post("/staff/ops/retention", {
    "retention.security_events_days": "365", "retention.email_bodies_days": "365", "retention.app_errors_days": "90", "retention.voice_transcripts_days": "90", "retention.deleted_files_days": "30",
  })).status, 303);
  assert.ok(await db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'retention.periods_updated'`).first());

  const r2 = await runRetention({ db, storage: t.storage });
  assert.equal(by(r2, "security_events").affected, 1);
  assert.equal(await count(`SELECT COUNT(*) n FROM security_events`), 1);
  assert.equal(by(r2, "email_bodies").affected, 1);
  assert.equal(await count(`SELECT COUNT(*) n FROM email_deliveries`), 2, "delivery log kept; only bodies removed");
  assert.deepEqual((await db.prepare(`SELECT delivery_id FROM email_messages`).all<{ delivery_id: string }>()).results.map((r) => r.delivery_id), ["ed_new"]);
  assert.equal(await count(`SELECT COUNT(*) n FROM app_errors`), 1);
  const call = await db.prepare(`SELECT transcript, recording_url, recording_consent FROM calls WHERE id='call_old'`).first<{ transcript: string | null; recording_url: string | null; recording_consent: number }>();
  assert.deepEqual(plain(call), { transcript: null, recording_url: null, recording_consent: 1 });
  assert.equal(t.storage.objects.has("files/old.pdf"), false, "bytes destroyed");
  assert.ok((await db.prepare(`SELECT purged_at FROM files WHERE id='f_old'`).first<{ purged_at: string }>())!.purged_at, "metadata kept and marked purged");
  // Never touched.
  assert.equal(await count(`SELECT COUNT(*) n FROM invoices WHERE id='inv_ret'`), 1);
  assert.equal(await count(`SELECT COUNT(*) n FROM orders WHERE id='ord_ret'`), 1);
  assert.ok(await count(`SELECT COUNT(*) n FROM audit_logs`) >= auditBefore, "audit log never shrinks");
  assert.equal(await count(`SELECT COUNT(*) n FROM agreements`), agreementsBefore);
  // Run log exists and the page renders it.
  assert.ok(await count(`SELECT COUNT(*) n FROM retention_runs`) >= 16);
  assert.match(await (await t.o.get("/staff/ops/retention")).text(), /pending Founder and attorney approval/);
  // Scheduled job wrapper.
  const jr = await runJobs(t.env, ["retention"]);
  assert.equal(jr.retention.ok, true, jr.retention.detail);
});

// ───────────── Backup / restore ─────────────

test("[TEST-004] backup export restores into a fresh database with identical row counts, schema, integrity and append-only audit triggers", async () => {
  const t = await setup();
  // Populate through real routes: registration, checkout, Stripe webhook (payment → project), readiness.
  const visitor = t.client();
  assert.equal((await visitor.post("/register", { name: "Jordan Lee", organization: "Lee Bakery", email: "jordan@leebakery.example", password: TEST_PASSWORD, terms: "1" })).status, 200);
  assert.equal((await visitor.get(linkFrom((await lastEmail(t.db, "jordan@leebakery.example"))!.text_body, "/verify-email"))).status, 303);
  const cust = await t.client().login("jordan@leebakery.example");
  await cust.enrolMfa(); // FD-30: a customer administrator enrols two-factor authentication before checkout
  const co = await cust.post("/checkout/business", { maintenance_plan: "professional", terms: "1" });
  assert.equal(co.status, 303);
  const checkout = t.fake.checkouts[0];
  const evt = { id: `evt_${newId("x")}`, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cs_test_ops_1", mode: "payment", payment_status: "paid", amount_total: checkout.lines[0].amountCents, payment_intent: "pi_test_ops_1", metadata: checkout.metadata } } };
  const body = JSON.stringify(evt);
  const ts = Math.floor(Date.now() / 1000);
  assert.equal((await t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}`, "content-type": "application/json" } })).status, 200);
  await approve(t.o);
  await signedPost(t.client(), "/api/readiness/deployments", deployment({ deploymentId: "dep-backup" }));
  const n = async (sql: string) => (await t.db.prepare(sql).first<{ n: number }>())!.n;
  assert.ok(await n(`SELECT COUNT(*) n FROM projects`) >= 1, "project provisioned by the webhook");
  assert.ok(await n(`SELECT COUNT(*) n FROM invoices WHERE status = 'paid'`) >= 1);
  assert.ok(await n(`SELECT COUNT(*) n FROM audit_logs`) >= 5);

  const sql = exportSql(t.db.raw);
  assert.match(sql, /^PRAGMA defer_foreign_keys=TRUE;/);
  assert.match(sql, /CREATE TRIGGER audit_logs_no_update/);
  assert.ok(sql.indexOf("CREATE TRIGGER audit_logs_no_update") > sql.lastIndexOf('INSERT INTO "audit_logs"'), "triggers are re-created after the data");

  const target = new DatabaseSync(":memory:");
  const report = restoreAndVerify(sql, target, t.db.raw);
  assert.equal(report.ok, true, report.problems.join("; "));
  assert.equal(report.integrity, "ok");
  assert.equal(report.foreignKeyViolations, 0);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.schemaMissing, []);
  assert.equal(report.auditAppendOnly, true);
  // Field-level fidelity on business records.
  const pick = (db: DatabaseSync, q: string) => JSON.stringify(db.prepare(q).all());
  for (const q of [`SELECT * FROM users ORDER BY id`, `SELECT * FROM invoices ORDER BY id`, `SELECT * FROM projects ORDER BY id`, `SELECT * FROM audit_logs ORDER BY id`, `SELECT * FROM d1_migrations ORDER BY id`, `SELECT * FROM release_approvals ORDER BY id`]) {
    assert.equal(pick(target, q), pick(t.db.raw, q), q);
  }
  assert.throws(() => target.exec(`DELETE FROM audit_logs`), /append-only/);
  // AUTOINCREMENT continues after the highest restored id (no id reuse in the audit log).
  target.exec(`INSERT INTO audit_logs (actor_kind, action, subject_type, created_at) VALUES ('system','post.restore','test','2026-01-01T00:00:00Z')`);
  const maxSrc = (t.db.raw.prepare(`SELECT MAX(id) m FROM audit_logs`).get() as { m: number }).m;
  assert.ok((target.prepare(`SELECT MAX(id) m FROM audit_logs`).get() as { m: number }).m > maxSrc);
  // Restoring into a non-empty database is refused.
  assert.throws(() => restoreAndVerify(sql, target), /not empty/);
  // A tampered export (missing triggers) is detected.
  const stripped = sql.replace(/CREATE TRIGGER audit_logs_no_(update|delete)[\s\S]*?END;\n/g, "");
  assert.ok(stripped.length < sql.length && !stripped.includes("CREATE TRIGGER audit_logs"));
  const bad = restoreAndVerify(stripped, new DatabaseSync(":memory:"), t.db.raw);
  assert.equal(bad.ok, false);
  assert.equal(bad.auditAppendOnly, false);
  // The drill is recorded in restore_tests (development) and shown at /staff/backups.
  const id = recordDrill(t.db.raw, report, { performedBy: t.owner.id, exportPath: "memory://ops-test-export.sql", target: ":memory:" });
  const drill = await t.db.prepare(`SELECT environment, result, evidence FROM restore_tests WHERE id = ?`).bind(id).first<{ environment: string; result: string; evidence: string }>();
  assert.equal(drill!.environment, "development");
  assert.equal(drill!.result, "passed");
  assert.match(drill!.evidence, /integrity_check=ok/);
  assert.match(await (await t.o.get("/staff/backups")).text(), /Logical SQL export restore drill \(memory:\/\/ops-test-export\.sql\)/);
});

// ───────────── Founder report ─────────────

test("[DOC-003] the Founder status report is generated from readiness records and its numbers equal buildReport", async () => {
  const t = await setup();
  await ingestEvidence(t.db, JSON.stringify({ runId: "ci-fr-1", source: "ci", environment: "development", commitSha: COMMIT.slice(0, 7), startedAt: nowIso(), finishedAt: nowIso(),
    results: [{ requirementId: "DATA-001", testName: "a", outcome: "passed" }, { requirementId: "CRM-001", testName: "b", outcome: "failed" }] }));
  const fr = await buildFounderReport({ db: t.db, now: () => new Date() });
  const report = await buildReport(await loadReadinessInput(t.db));
  assert.deepEqual(fr.scores.counts, report.scores.counts);
  assert.equal(fr.evidenceSetSha256, report.evidenceSetSha256);
  assert.deepEqual(fr.gates.map((g) => [g.id, g.status]), report.gates.map((g) => [g.id, g.status]));
  const sum = (k: "total" | "implemented" | "blocked" | "stagingVerified" | "productionVerified" | "failing") => fr.subsystems.reduce((a, s) => a + s[k], 0);
  assert.equal(sum("total"), report.scores.denominator.total);
  assert.equal(sum("implemented"), report.scores.counts.implemented.count);
  assert.equal(sum("blocked"), report.scores.counts.blocked.count);
  assert.equal(sum("stagingVerified"), report.scores.counts.verifiedInStaging.count);
  assert.equal(sum("productionVerified"), report.scores.counts.productionVerified.count);
  assert.equal(sum("failing"), report.scores.counts.failing.count);
  const md = fr.markdown;
  assert.match(md, new RegExp(`\\| Implemented \\| ${report.scores.counts.implemented.count} \\| ${report.scores.denominator.total} \\|`));
  assert.match(md, /\| Subsystem \| Implemented \| Tested \| Staging verified \| Production verified \| Blocked \| Evidence \| Remaining action \|/);
  assert.match(md, /not production-ready/);
  assert.match(md, /ci-fr-1/);
  // Rendered page (readiness.read) and Markdown download; customers are refused.
  const page = await t.ad.get("/staff/readiness/founder-report");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, new RegExp(`${report.scores.counts.implemented.count} / ${report.scores.denominator.total}`));
  const dl = await t.ad.get("/staff/readiness/founder-report.md");
  assert.match(dl.headers.get("content-type")!, /text\/markdown/);
  assert.match(await dl.text(), /final status report/);
  const cust = await createCustomer(t.db);
  assert.equal((await (await t.client().login(cust.email)).get("/staff/readiness/founder-report")).status, 403);
});

// ───────────── Workflows ─────────────

test("[INFRA-005] deployment workflows are gated: staging skips without Cloudflare secrets, production is manual, approval-gated and rolls back", () => {
  const staging = readFileSync(".github/workflows/deploy-staging.yml", "utf8");
  const prod = readFileSync(".github/workflows/deploy-production.yml", "utf8");
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  for (const [name, y] of [["staging", staging], ["production", prod], ["release", release]] as const) {
    assert.doesNotMatch(y, /\t/, `${name}: YAML must not contain tabs`);
    assert.match(y, /^name: /m);
    assert.match(y, /^on:\n/m);
    assert.match(y, /^jobs:\n/m);
    assert.match(y, /^permissions:\n {2}contents: (read|write)/m, `${name}: least-privilege permissions`);
  }
  // Staging
  assert.match(staging, /push:\n\s+branches: \[main\]/);
  assert.match(staging, /workflow_dispatch:/);
  assert.match(staging, /secrets\.CLOUDFLARE_API_TOKEN != ''/);
  assert.match(staging, /secrets\.CLOUDFLARE_ACCOUNT_ID != ''/);
  assert.match(staging, /::notice title=Staging deploy skipped::/);
  assert.match(staging, /if: needs\.preflight\.outputs\.configured == 'true'/);
  assert.match(staging, /environment: staging/);
  assert.match(staging, /npx tsc -p tsconfig\.json/);
  assert.match(staging, /npm test/);
  assert.match(staging, /d1 migrations apply crestmont-staging --remote --env staging/);
  assert.match(staging, /deploy --env staging/);
  // Preview: self-provisioned, gated, password masked and delivered only as a private artifact, seeded on first run.
  assert.match(staging, /d1 create crestmont-staging/);
  // Access credentials: derived + re-applied every run, verified end to end before any artifact is issued.
  assert.match(staging, /ACCESS_ROOT_KEY: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(staging, /scripts\/staging-access\.ts/);
  assert.match(staging, /scripts\/verify-staging-access\.ts/);
  // The access notes are sealed only after the live sequence verified; the access upload depends on that step's
  // output, and the only other upload is the sealed pre-rotation forensic snapshot.
  assert.match(staging, /- name: Seal the access notes\n\s+id: protect\n\s+if: always\(\) && steps\.verify\.outcome == 'success'/, "access artifact only after the live sequence verified");
  // Any upload-artifact version or SHA pin (CREST-GAP-063: Dependabot bumps must not break this check).
  const uploadsWithIf = [...staging.matchAll(/upload-artifact@[^\s]+(?: #[^\n]*)?\n\s+if: ([^\n]+)/g)];
  assert.ok(uploadsWithIf.length >= 2, "the sealed forensic and access uploads are found");
  for (const m of uploadsWithIf) assert.match(m[1], /steps\.protect\.outputs\.upload == 'sealed'|steps\.gate\.outputs\.pending == 'true'/, "access artifact only after the live sequence verified");
  assert.match(staging, /rm -f access\/private\.json access\/access\.json/);
  assert.doesNotMatch(staging, /upload-artifact[\s\S]*?path: (backups|access\/(private|access))/, "no other artifact carries credentials");
  assert.match(staging, /public homepage returned HTTP \$code with no cookies/, "staging smoke proves the public site loads without credentials");
  assert.match(staging, /opened without a session/, "staging smoke proves protected areas refuse anonymous visitors");
  assert.match(staging, /scripts\/seed-staging\.ts/);
  assert.match(staging, /name: staging-access-sealed/);
  assert.doesNotMatch(staging, /name: staging-preview-access/, "the name of the exposed plaintext artifacts is retired");
  assert.doesNotMatch(staging, /echo "\$pw"\s*$/m, "preview password is never echoed to the log");
  assert.match(staging, /scripts\/post-evidence\.ts/);
  assert.match(staging, /scripts\/post-deployment\.ts/);
  assert.doesNotMatch(staging, /--env production/, "staging workflow never touches production");
  // Production
  const onBlock = prod.slice(prod.indexOf("\non:"), prod.indexOf("\npermissions:"));
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /\n {2}(push|schedule|pull_request|workflow_run|release):/, "production is never triggered automatically");
  assert.match(prod, /commit:\n\s+description: .*\n\s+required: true/);
  assert.match(prod, /environment:\n\s+name: production/);
  assert.match(prod, /scripts\/release-authorization\.ts --commit "\$TARGET_COMMIT"/);
  assert.ok(prod.indexOf("release-authorization.ts") < prod.indexOf("deploy --env production"), "authorization checked before deploying");
  assert.equal((prod.match(/scripts\/release-authorization\.ts/g) ?? []).length >= 2, true, "re-checked right before changing production");
  assert.match(prod, /merge-base --is-ancestor "\$TARGET_COMMIT" origin\/main/);
  assert.match(prod, /scripts\/production-checks\.ts .*--environment production/);
  assert.match(prod, /post-evidence\.ts evidence\/production-check\.json/);
  assert.match(prod, /rollback --env production/);
  assert.match(prod, /d1 export crestmont-production/);
  // Release
  assert.match(release, /tags: \["v\*"\]/);
  assert.match(release, /gh release create/);
  assert.match(release, /scripts\/release-candidate\.ts/);
  assert.doesNotMatch(release, /wrangler (deploy|d1|rollback)|npx[^\n]*wrangler|deploy --env/, "tagging never deploys");
  // Scripts used by the workflows exist and the authorization script refuses without configuration.
  for (const s of ["post-deployment", "release-authorization", "release-candidate", "production-checks", "post-evidence", "backup-export", "restore-verify", "founder-report"]) {
    assert.ok(readFileSync(`scripts/${s}.ts`, "utf8").length > 100, s);
  }
});
