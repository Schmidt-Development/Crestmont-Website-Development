import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer } from "./support/app.ts";
import { ingestEvidence } from "../src/readiness/ingest.ts";
import { sha256Hex } from "../src/lib/crypto.ts";
import { syncGithub } from "../src/services/github.ts";
import { REQUIREMENTS } from "../requirements/inventory.ts";
import type { Env } from "../src/app/context.ts";

const COMMIT = "abc1234def5678abc1234def5678abc1234def56";
const CFG = "a".repeat(64);
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const evidence = (runId: string, results: { requirementId: string; outcome: "passed" | "failed" }[], finishedAt = iso(60_000), over: Record<string, unknown> = {}) => JSON.stringify({
  runId, source: "ci", environment: "development", commitSha: COMMIT.slice(0, 7), branch: "main", runUrl: "https://github.com/example/repo/actions/runs/1",
  startedAt: finishedAt, finishedAt, results: results.map((r) => ({ ...r, testName: `t ${r.requirementId}` })), ...over,
});

async function setup(extra: Partial<Env> = {}) {
  const app = await createTestApp(extra);
  const owner = await createStaff(app.db, "owner", "owner@crestmont.test", "Olivia Owner");
  const admin = await createStaff(app.db, "administrator", "admin@crestmont.test", "Adam Admin");
  const o = await app.client().login(owner.email, undefined, owner.secret);
  const ad = await app.client().login(admin.email, undefined, admin.secret);
  return { ...app, owner, admin, o, ad };
}

test("[READY-010] fresh databases carry the real discovery blocker register with identical ids and states", async () => {
  const { db, o } = await setup();
  const rows = (await db.prepare(`SELECT id, status FROM blockers ORDER BY id`).all<{ id: string; status: string }>()).results;
  assert.deepEqual(rows.map((r) => r.id), Array.from({ length: 14 }, (_, i) => `BLK-${String(i + 1).padStart(3, "0")}`));
  assert.deepEqual(rows.filter((r) => r.status === "resolved").map((r) => r.id), ["BLK-001", "BLK-002"]);
  const page = await (await o.get("/staff/readiness/blockers")).text();
  for (const c of ["engineering", "external_account", "security", "legal", "founder_approval", "production_incident"]) assert.match(page, new RegExp(`data-category="${c}"`));
  assert.match(page, /BLK-013/);
  // Requirement links are applied once requirement rows exist.
  assert.ok(await db.prepare(`SELECT 1 FROM blocker_requirements WHERE blocker_id = 'BLK-013' AND requirement_id = 'READY-005'`).first());
});

test("[READY-010] blockers can be created and edited, and resolving requires resolution evidence", async () => {
  const { db, o, client } = await setup();
  const created = await o.post("/staff/readiness/blockers/new", { category: "security", severity: "high", description: "Session cookie lacks a dedicated domain", subsystem: "Authentication", owner: "Engineering", required_action: "Scope cookie to app domain", dependency: "", requirement_ids: "AUTH-004 SEC-002" });
  assert.equal(created.status, 303);
  const id = created.headers.get("location")!.split("/").pop()!;
  assert.equal(id, "BLK-015");
  assert.ok(await db.prepare(`SELECT 1 FROM blocker_requirements WHERE blocker_id = ? AND requirement_id = 'SEC-002'`).bind(id).first());
  const bad = await o.post("/staff/readiness/blockers/new", { category: "security", severity: "high", description: "Unknown requirement link", subsystem: "x1", owner: "Engineering", required_action: "Fix it now", requirement_ids: "NOPE-999" });
  assert.equal(bad.status, 422);
  const noEvidence = await o.post(`/staff/readiness/blockers/${id}/resolve`, { evidence: "" });
  assert.equal(noEvidence.status, 422);
  assert.match(await noEvidence.text(), /Resolution evidence is required/);
  assert.equal((await db.prepare(`SELECT status FROM blockers WHERE id = ?`).bind(id).first<{ status: string }>())!.status, "open");
  assert.equal((await o.post(`/staff/readiness/blockers/${id}/resolve`, { evidence: "Fixed in commit 1a2b3c4; verified by AUTH-004 test run ci-55" })).status, 303);
  const row = await db.prepare(`SELECT status, resolution_evidence, resolved_by FROM blockers WHERE id = ?`).bind(id).first<{ status: string; resolution_evidence: string; resolved_by: string }>();
  assert.equal(row?.status, "resolved");
  assert.match(row!.resolution_evidence, /1a2b3c4/);
  assert.ok(await db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'blocker.resolved' AND subject_id = ?`).bind(id).first());
  // A developer can read the register but not change it.
  const dev = await createStaff(db, "developer");
  const d = await client().login(dev.email, undefined, dev.secret);
  assert.equal((await d.get("/staff/readiness/blockers")).status, 200);
  assert.equal((await d.post(`/staff/readiness/blockers/${id}/reopen`, { reason: "nope nope" })).status, 403);
});

test("[READY-001] readiness pages render evidence ingested via ingestEvidence; matrix filters and detail pages work", async () => {
  const { db, o } = await setup();
  await ingestEvidence(db, evidence("ci-100-1", [{ requirementId: "DATA-001", outcome: "passed" }, { requirementId: "CRM-003", outcome: "failed" }]));
  const overview = await (await o.get("/staff/readiness")).text();
  assert.match(overview, /Engineering completion/);
  assert.match(overview, /Business \/ legal readiness/);
  assert.match(overview, /No combined readiness score is computed/);
  assert.match(overview, new RegExp(`Inventory denominator: ${REQUIREMENTS.length} requirements`));
  for (const g of "ABCDEFGH") assert.match(overview, new RegExp(`data-gate="${g}"`));
  assert.match(overview, /Not production-ready/);
  const matrix = await (await o.get("/staff/readiness/requirements?state=test_failed")).text();
  assert.match(matrix, /CRM-003/);
  assert.doesNotMatch(matrix, />DATA-001</);
  const byEnv = await (await o.get("/staff/readiness/requirements?env=development&verification=passed")).text();
  assert.match(byEnv, />DATA-001</);
  assert.match(byEnv, /ci-100-1/);
  assert.match(await (await o.get("/staff/readiness/requirements?q=src%2Fdomain%2Fcrm")).text(), />CRM-003</, "search covers implementation location");
  const detail = await (await o.get("/staff/readiness/requirements/CRM-003")).text();
  assert.match(detail, /t CRM-003/);
  assert.match(detail, /src\/domain\/crm\.ts/);
  const run = await (await o.get("/staff/readiness/runs/ci-100-1")).text();
  assert.match(run, /CRM-003/);
  const eng = await (await o.get("/staff/readiness/engineering")).text();
  assert.match(eng, /GitHub source not configured/);
  assert.match(eng, /t CRM-003/, "failed tests list");
  const dev = await (await o.get("/staff/readiness/env/development")).text();
  assert.match(dev, /ci-100-1/);
  const staging = await (await o.get("/staff/readiness/env/staging")).text();
  assert.match(staging, /No staging deployment exists/);
  assert.match(await (await o.get("/staff/readiness/env/production")).text(), /No production deployment exists/);
  assert.equal((await o.get("/staff/readiness/env/qa")).status, 404);
});

test("[READY-001] a customer cannot reach any readiness page", async () => {
  const { db, client } = await setup();
  const cust = await createCustomer(db);
  const c = await client().login(cust.email);
  for (const p of ["/staff/readiness", "/staff/readiness/requirements", "/staff/readiness/engineering", "/staff/readiness/blockers", "/staff/readiness/report", "/staff/owner"]) assert.equal((await c.get(p)).status, 403, p);
});

test("[READY-012] stale and failing evidence feeds are shown loudly and /api/readiness/health returns 503", async () => {
  const { db, o, client } = await setup();
  let health = await (await client().get("/api/readiness/health")).json() as { status: string; feeds: { source: string; status: string }[] };
  assert.equal(health.status, "degraded");
  assert.equal(health.feeds.find((f) => f.source === "ci")!.status, "unavailable");
  assert.equal((await client().get("/api/readiness/health")).status, 503);
  await ingestEvidence(db, evidence("ci-fresh", [{ requirementId: "DATA-001", outcome: "passed" }]));
  const ok = await client().get("/api/readiness/health");
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { feeds: { source: string; status: string }[] }).feeds.find((f) => f.source === "ci")!.status, "healthy");
  // Stale: last success is older than 72 h.
  await db.prepare(`UPDATE ingestion_status SET last_success_at = ?, last_attempt_at = ? WHERE source = 'ci'`).bind(iso(100 * 3_600_000), iso(100 * 3_600_000)).run();
  assert.equal((await client().get("/api/readiness/health")).status, 503);
  const page = await (await o.get("/staff/readiness")).text();
  assert.match(page, /Evidence ingestion is not healthy/);
  assert.match(page, /badge--warn">Stale/);
  // Failing: a later attempt errored.
  await assert.rejects(ingestEvidence(db, "{not json"));
  await db.prepare(`UPDATE ingestion_status SET last_error = 'boom', last_attempt_at = ? WHERE source = 'ci'`).bind(iso(0)).run();
  health = await (await o.get("/api/readiness/health")).json() as typeof health & { reason: string };
  assert.equal(health.feeds.find((f) => f.source === "ci")!.status, "failing");
  assert.match((health as unknown as { reason: string }).reason, /boom/, "staff see the reason");
});

test("[READY-008] administrator cannot open or record Founder approval (AIOPS-003 boundary)", async () => {
  const { db, ad, o } = await setup();
  assert.equal((await o.post("/staff/readiness/releases", { commit_sha: COMMIT, config_sha256: CFG, notes: "First candidate notes", rollback_plan: "Redeploy previous worker version" })).status, 303);
  assert.equal((await ad.get("/staff/readiness/approve")).status, 403);
  const res = await ad.post("/staff/readiness/approve", { decision: "approved", confirm_commit: COMMIT, evidence_set: "x", notes: "" });
  assert.equal(res.status, 403);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM release_approvals`).first<{ n: number }>())!.n, 0);
});

test("[AIOPS-003] automation and AI actors can never record a launch approval", async () => {
  const { db, owner } = await setup();
  const { recordFounderDecision, createReleaseCandidate } = await import("../src/services/readiness-admin.ts");
  await createReleaseCandidate(db, owner.id, { commit_sha: COMMIT, config_sha256: CFG, notes: "Candidate notes", rollback_plan: "Rollback plan text" });
  const ctx = { db, now: () => new Date(), ip: null };
  for (const kind of ["ai", "system", "webhook"] as const) {
    await assert.rejects(recordFounderDecision(ctx, { kind, userId: owner.id, roles: [{ role: "owner", organizationId: "org_crestmont" }], mfaVerified: true }, owner.id,
      { decision: "approved", notes: "", confirmCommit: COMMIT, expectedEvidenceSet: "x" }), /Only the Owner/);
  }
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM release_approvals`).first<{ n: number }>())!.n, 0);
});

test("[READY-008] owner approval binds to commit, config and evidence and is invalidated by a new candidate or new evidence", async () => {
  const { db, o } = await setup();
  await ingestEvidence(db, evidence("ci-a", [{ requirementId: "DATA-001", outcome: "passed" }]));
  assert.equal((await o.post("/staff/readiness/releases", { commit_sha: COMMIT, config_sha256: CFG, notes: "First candidate notes", rollback_plan: "Redeploy previous worker version" })).status, 303);
  const panel = await (await o.get("/staff/readiness/approve")).text();
  assert.match(panel, new RegExp(COMMIT));
  assert.match(panel, /Redeploy previous worker version/);
  const evSet = /name="evidence_set" value="([0-9a-f]{64})"/.exec(panel)![1];
  // Wrong commit confirmation is refused.
  assert.equal((await o.post("/staff/readiness/approve", { decision: "approved", confirm_commit: "deadbeef", evidence_set: evSet })).status, 422);
  // Stale evidence set (changed during review) is refused.
  assert.equal((await o.post("/staff/readiness/approve", { decision: "approved", confirm_commit: COMMIT, evidence_set: "0".repeat(64) })).status, 409);
  assert.equal((await o.post("/staff/readiness/approve", { decision: "approved", confirm_commit: COMMIT, evidence_set: evSet, notes: "Approved" })).status, 303);
  const a = await db.prepare(`SELECT * FROM release_approvals WHERE kind = 'production_launch'`).first<{ commit_sha: string; config_sha256: string; evidence_set_sha256: string; invalidated_at: string | null }>();
  assert.deepEqual([a?.commit_sha, a?.config_sha256, a?.evidence_set_sha256], [COMMIT, CFG, evSet]);
  assert.match(await (await o.get("/staff/readiness/approve")).text(), /badge--ok">Valid/);
  // New evidence changes the evidence set → approval no longer valid (computed).
  await ingestEvidence(db, evidence("ci-b", [{ requirementId: "CRM-003", outcome: "passed" }], iso(1000)));
  assert.match(await (await o.get("/staff/readiness/approve")).text(), /Evidence set changed after approval/);
  // A newer release candidate invalidates it explicitly.
  assert.equal((await o.post("/staff/readiness/releases", { commit_sha: "1234567", config_sha256: "b".repeat(64), notes: "Second candidate", rollback_plan: "Same rollback plan" })).status, 303);
  const inv = await db.prepare(`SELECT invalidated_at, invalidated_reason FROM release_approvals WHERE kind = 'production_launch'`).first<{ invalidated_at: string | null; invalidated_reason: string }>();
  assert.ok(inv?.invalidated_at);
  assert.match(inv!.invalidated_reason, /Superseded by release candidate/);
  const timeline = await (await o.get("/staff/readiness/releases")).text();
  assert.match(timeline, /data-kind="invalidation"/);
  assert.match(timeline, /data-kind="approval"/);
  assert.match(timeline, /data-kind="release"/);
  const overview = await (await o.get("/staff/readiness")).text();
  assert.match(overview, /Approval was invalidated|commit changed/);
});

test("[READY-011] evidence packet hash matches its content; CSV and printable report derive from the same report; snapshots compare", async () => {
  const { db, o } = await setup();
  await ingestEvidence(db, evidence("ci-p", [{ requirementId: "DATA-001", outcome: "passed" }]));
  const res = await o.get("/staff/readiness/packet.json");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
  const text = await res.text();
  const parsed = JSON.parse(text) as { sha256: string; packet: { report: { evidenceSetSha256: string; requirements: unknown[] }; evidenceRuns: { id: string }[]; blockers: unknown[]; approvals: unknown[]; releases: unknown[] } };
  const packetJson = text.slice(text.indexOf(`"packet":`) + 9, -1);
  assert.equal(await sha256Hex(packetJson), parsed.sha256);
  assert.equal(res.headers.get("x-evidence-packet-sha256"), parsed.sha256);
  assert.equal(parsed.packet.report.requirements.length, REQUIREMENTS.length);
  assert.deepEqual(parsed.packet.evidenceRuns.map((r) => r.id), ["ci-p"]);
  assert.equal(parsed.packet.blockers.length, 14);
  const csv = await (await o.get("/staff/readiness/export.csv")).text();
  assert.equal(csv.trim().split("\n").length, REQUIREMENTS.length + 1);
  const report = await (await o.get("/staff/readiness/report")).text();
  assert.match(report, /Save as PDF/);
  assert.match(report, new RegExp(parsed.packet.report.evidenceSetSha256));
  assert.match(await (await o.get("/staff/readiness/report?subsystem=Data")).text(), /filtered: 2 of/);
  // Snapshots
  assert.equal((await o.post("/staff/readiness/snapshots")).status, 303);
  const snap = await db.prepare(`SELECT id, summary_json FROM readiness_snapshots`).first<{ id: string; summary_json: string }>();
  assert.equal(JSON.parse(snap!.summary_json).evidenceSetSha256, parsed.packet.report.evidenceSetSha256);
  await ingestEvidence(db, evidence("ci-q", [{ requirementId: "CRM-003", outcome: "passed" }], iso(1000)));
  const cmp = await (await o.get(`/staff/readiness/snapshots/${snap!.id}`)).text();
  assert.match(cmp, /Snapshot vs current/);
  assert.match(cmp, />Changed</);
});

test("[READY-005] GitHub sync with a fake fetch stores the snapshot; refused-for-billing runs show as failed with GitHub's reason", async () => {
  const { db, o, env } = await setup({ GITHUB_TOKEN: "ghp_test", GITHUB_REPO: "example/crestmont" });
  const calls: string[] = [];
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer ghp_test");
    if (u.endsWith("/repos/example/crestmont")) return reply({ default_branch: "main", html_url: "https://github.com/example/crestmont", private: true });
    if (u.includes("/commits?")) return reply([{ sha: COMMIT, html_url: "https://github.com/example/crestmont/commit/x", commit: { message: "Add readiness UI\n\nbody", author: { name: "N", date: "2026-10-26T20:00:00Z" } }, author: { login: "noah" } }]);
    if (u.includes("/pulls?")) return reply([{ number: 7, title: "Support system", draft: false, html_url: "https://github.com/example/crestmont/pull/7", created_at: "2026-10-26T19:00:00Z", user: { login: "noah" }, head: { ref: "support" } }]);
    if (u.includes("/actions/runs?")) return reply({ workflow_runs: [
      { id: 11, name: "CI", head_branch: "main", head_sha: COMMIT, event: "push", status: "completed", conclusion: "failure", html_url: "https://github.com/example/crestmont/actions/runs/11", created_at: "2026-10-26T20:01:00Z" },
      { id: 10, name: "CI", head_branch: "main", head_sha: "1111111", event: "push", status: "completed", conclusion: "success", html_url: "https://github.com/example/crestmont/actions/runs/10", created_at: "2026-10-25T20:01:00Z" },
    ] });
    if (u.includes("/actions/runs/11/jobs")) return reply({ jobs: [{ id: 501, steps: [], started_at: null, conclusion: "failure" }] });
    if (u.includes("/check-runs/501/annotations")) return reply([{ message: "The job was not started because recent account payments have failed or your spending limit needs to be increased.", annotation_level: "failure" }]);
    if (u.includes("/tags?")) return reply([{ name: "v0.1.0", commit: { sha: "1111111" } }]);
    if (u.includes("/code-scanning/alerts")) return reply({ message: "Advanced Security must be enabled" }, 403);
    return reply({ message: "unexpected" }, 404);
  }) as typeof fetch;
  const r = await syncGithub({ db, env, now: () => new Date() }, null, fake);
  assert.equal(r.status, "ok");
  assert.ok(calls.every((c) => c.startsWith("https://api.github.com/repos/example/crestmont")));
  const row = await db.prepare(`SELECT ok, payload_json FROM github_sync`).first<{ ok: number; payload_json: string }>();
  assert.equal(row?.ok, 1);
  const snap = JSON.parse(row!.payload_json);
  assert.equal(snap.runs[0].outcome, "not_started");
  assert.match(snap.runs[0].reason, /spending limit/);
  assert.equal(snap.latestSuccess.id, 10);
  assert.equal(snap.codeScanning.available, false);
  assert.equal((await db.prepare(`SELECT last_error FROM ingestion_status WHERE source = 'github'`).first<{ last_error: string | null }>())?.last_error, null);
  const page = await (await o.get("/staff/readiness/engineering")).text();
  assert.match(page, /Failed — not started/);
  assert.match(page, /spending limit needs to be increased/);
  assert.match(page, /Support system/);
  assert.match(page, /v0\.1\.0/);
  assert.match(page, /Advanced Security must be enabled/);

  // Failure path: error is recorded, old data is labelled stale, health reports failing.
  const failing = (async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })) as typeof fetch;
  const f = await syncGithub({ db, env, now: () => new Date() }, null, failing);
  assert.equal(f.status, "failed");
  assert.match((f as { error: string }).error, /Bad credentials/);
  const st = await db.prepare(`SELECT last_error, last_success_at FROM ingestion_status WHERE source = 'github'`).first<{ last_error: string; last_success_at: string }>();
  assert.match(st!.last_error, /Bad credentials/);
  assert.ok(st!.last_success_at, "previous success kept for reference");
  assert.equal((await db.prepare(`SELECT status FROM integration_health WHERE integration = 'github'`).first<{ status: string }>())!.status, "failing");
  const after = await (await o.get("/staff/readiness/engineering")).text();
  assert.match(after, /Last GitHub sync failed/);
  assert.match(after, /Stale data/);
  const health = await o.get("/api/readiness/health");
  assert.equal(health.status, 503);
});

test("[READY-005] GitHub sync is not configured without a token, never fakes data, and requires operational permission", async () => {
  const { db, o, client } = await setup();
  const res = await o.post("/staff/readiness/github/sync");
  assert.equal(res.status, 303);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM github_sync`).first<{ n: number }>())!.n, 0);
  assert.equal((await db.prepare(`SELECT status FROM integration_health WHERE integration = 'github'`).first<{ status: string }>())!.status, "not_configured");
  const sup = await createStaff(db, "support");
  const s = await client().login(sup.email, undefined, sup.secret);
  assert.equal((await s.post("/staff/readiness/github/sync")).status, 403);
});

test("[READY-007] security findings register: critical findings block Gate C; accepting risk is Owner-only", async () => {
  const { db, o, ad } = await setup();
  // The register starts with the ASVS self-review findings (migration 0010); count relative to that baseline.
  const baseline = (await db.prepare(`SELECT COUNT(*) n FROM security_findings WHERE status = 'open' AND release_blocking = 1`).first<{ n: number }>())!.n;
  assert.ok(baseline >= 1, "review findings are in the register");
  assert.equal((await ad.post("/staff/readiness/security", { title: "Reflected XSS in search", severity: "critical", source: "Manual review", detail: "" })).status, 303);
  const f = await db.prepare(`SELECT id, release_blocking FROM security_findings WHERE title = 'Reflected XSS in search'`).first<{ id: string; release_blocking: number }>();
  assert.equal(f?.release_blocking, 1);
  const overview = await (await o.get("/staff/readiness")).text();
  assert.match(overview, new RegExp(`${baseline + 1} blocking findings open`));
  assert.equal((await ad.post(`/staff/readiness/security/${f!.id}/resolve`, { outcome: "accepted_risk", evidence: "We accept this risk for launch" })).status, 403);
  assert.equal((await ad.post(`/staff/readiness/security/${f!.id}/resolve`, { outcome: "resolved", evidence: "" })).status, 422);
  assert.equal((await ad.post(`/staff/readiness/security/${f!.id}/resolve`, { outcome: "resolved", evidence: "Escaped output in commit 9f8e7d6, retested" })).status, 303);
  assert.equal((await db.prepare(`SELECT status FROM security_findings WHERE id = ?`).bind(f!.id).first<{ status: string }>())!.status, "resolved");
});

test("[OWN-002] executive overview shows real figures with empty-state wording and links every number to detail", async () => {
  const { db, o, client } = await setup();
  const empty = await (await o.get("/staff/owner")).text();
  assert.match(empty, /No succeeded payments have been recorded/);
  assert.match(empty, /No active maintenance subscriptions/);
  assert.match(empty, /No integration health has been recorded/);
  assert.match(empty, /Not production-ready/);
  // Real records drive the figures.
  const cust = await createCustomer(db, "exec@example.com", "Exec Co");
  await db.prepare(`INSERT INTO payments (id, organization_id, amount_cents, status, created_at) VALUES ('pay_1', ?, 99900, 'succeeded', ?)`).bind(cust.organizationId, iso(0)).run();
  await db.prepare(`INSERT INTO payments (id, organization_id, amount_cents, status, created_at) VALUES ('pay_2', ?, 5000, 'failed', ?)`).bind(cust.organizationId, iso(0)).run();
  await db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, status, created_at, updated_at) VALUES ('sub_1', ?, 'professional', 'active', 'x', 'x')`).bind(cust.organizationId).run();
  await db.prepare(`INSERT INTO subscriptions (id, organization_id, product_id, status, created_at, updated_at) VALUES ('sub_2', ?, 'essential', 'past_due', 'x', 'x')`).bind(cust.organizationId).run();
  await db.prepare(`INSERT INTO tickets (id, organization_id, subject, category, priority, status, opened_by, created_at, updated_at) VALUES ('tkt_1', ?, 'Help', 'technical', 'normal', 'open', ?, ?, ?)`).bind(cust.organizationId, cust.id, iso(0), iso(0)).run();
  const page = await (await o.get("/staff/owner")).text();
  const tile = (label: string) => new RegExp(`data-metric="${label.replace(/[()]/g, "\\$&")}"[^>]*>[\\s\\S]*?kpi__value">([^<]+)<`).exec(page)?.[1];
  assert.equal(tile("Revenue (all time)"), "$999");
  assert.equal(tile("Recurring revenue (monthly)"), "$199");
  assert.equal(tile("Active customers"), "1");
  assert.equal(tile("Support workload"), "1");
  assert.equal(tile("Payment failures"), "2");
  for (const href of ["/staff/finance", "/staff/finance/subscriptions", "/staff/customers", "/staff/crm?view=list", "/staff/projects", "/staff/support", "/staff/tasks", "/staff/readiness"]) assert.ok(page.includes(`href="${href}`), href);
  // Finance permission is required.
  const sup = await createStaff(db, "support");
  const s = await client().login(sup.email, undefined, sup.secret);
  assert.equal((await s.get("/staff/owner")).status, 403);
});
