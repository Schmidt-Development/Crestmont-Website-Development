// The Website Delivery E2E fixture (scripts/staging-delivery-fixture.ts): a synthetic finished build with a real
// stored snapshot, so the AI-build delivery E2E tests DELIVERY without depending on the AI builder having run.
//
// These prove the fixture is valid by the application's own rules, stays valid under the build sweep, is
// idempotent, is honest about what it is, and can only ever be applied to staging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestApp, createStaff, createCustomer } from "./support/app.ts";
import * as FX from "../scripts/staging-delivery-fixture.ts";
import * as WD from "../src/services/website-delivery.ts";
import { sweepBuilds } from "../src/services/builds.ts";
import { newId, nowIso } from "../src/lib/db.ts";

const raw = (db: unknown) => (db as { raw: { exec(sql: string): void } }).raw;

test("[WDF-01] the fixture website is a real static site, every file accepted by the snapshot allowlist, and versioned", () => {
  const files = FX.loadFixtureFiles();
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["about.html", "assets/app.js", "assets/favicon.svg", "assets/hero.svg", "assets/logo.svg", "assets/site.css", "index.html"]);
  // Pages, a stylesheet, a script and images: what "a functional website with local assets" means.
  assert.ok(files.some((f) => f.contentType.startsWith("text/css")));
  assert.ok(files.some((f) => f.contentType.startsWith("text/javascript")));
  assert.ok(files.some((f) => f.contentType === "image/svg+xml"));
  // Every page says, on screen, that it is a synthetic fixture and not AI output.
  for (const f of files.filter((x) => x.kind === "page")) assert.match(new TextDecoder().decode(f.bytes), new RegExp(FX.FIXTURE.marker));
  // Changing the website without bumping FIXTURE_VERSION would overwrite an immutable snapshot's objects in R2.
  assert.equal(FX.contentSha(files), FX.FIXTURE_CONTENT_SHA,
    "the fixture website changed: bump FIXTURE_VERSION (a new immutable revision) and update FIXTURE_CONTENT_SHA");
  // Ids keep the shapes the routes and the E2E match on.
  assert.match(FX.FIXTURE.jobId, /^bld_[0-9a-f]{24}$/);
  assert.match(FX.FIXTURE.projectId, /^prj_[0-9a-f]{24}$/);
  for (const f of files) assert.equal(f.storageKey, `builds/${FX.FIXTURE.jobId}/rev/1-${FX.FIXTURE_VERSION}/${f.path}`);
});

test("[WDF-02] the fixture is valid by the application's own rules, idempotent, and delivers end to end", async () => {
  const files = FX.loadFixtureFiles();
  // The script's own self-check: SQL applied twice on real migrations, eligibility, every file served through a
  // real signed capability with the right type and the stored bytes, a tampered capability refused.
  assert.deepEqual(await FX.verifyLocally(files), []);

  // And the whole handover through the real pages, as the staging E2E performs it.
  const t = await createTestApp({ BUILD_PREVIEW_FILE_SECRET: "wdf-secret" } as never);
  try {
    const owner = await createStaff(t.db, "owner");
    const cust = await createCustomer(t.db);
    const projectId = newId("prj");
    await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (?,?,?,'development',2,'upfront',?,?)`)
      .bind(projectId, cust.organizationId, "Customer project", nowIso(), nowIso()).run();
    const sql = FX.fixtureSql(files, nowIso());
    raw(t.db).exec(sql);
    raw(t.db).exec(sql);
    for (const f of files) await t.storage.put(f.storageKey, f.bytes, f.contentType);

    const staff = await t.client().login(owner.email);
    const page = await (await staff.get(`/staff/builds/${FX.FIXTURE.jobId}/deliver`)).text();
    assert.match(page, /finished and has a stored website/, "the deliver page offers the fixture as deliverable");
    const res = await staff.post(`/staff/builds/${FX.FIXTURE.jobId}/deliver`, { projectId, visible: "yes" });
    assert.equal(res.status, 303);
    const d = await WD.activeForProject(t.db, projectId);
    assert.equal(d?.job_id, FX.FIXTURE.jobId);
    assert.equal(d?.source, "ai_build");
    assert.equal(d?.source_project_id, FX.FIXTURE.projectId);

    const portal = await (await (await t.client().login(cust.email)).get(`/portal/projects/${projectId}`)).text();
    const href = new RegExp(`href="(/build-preview/${FX.FIXTURE.jobId}/1-${FX.FIXTURE_VERSION}/[^"]+/)"`).exec(portal)?.[1];
    assert.ok(href, "the customer's portal links the stored snapshot");
    const site = await t.client().get(href!); // no session: the capability is the whole authorization
    assert.equal(site.status, 200);
    assert.match(await site.text(), new RegExp(FX.FIXTURE.marker));
  } finally { t.close(); }
});

test("[WDF-03] the build sweep leaves the fixture finished (a ready_for_review copy would be cancelled)", async () => {
  const t = await createTestApp();
  try {
    raw(t.db).exec(FX.fixtureSql(FX.loadFixtureFiles(), nowIso()));
    // The reason the fixture is 'approved': an internal project with no order is ineligible, and the sweep cancels
    // a ready_for_review build of an ineligible project. Shown on a copy, never on the fixture itself.
    const copy = "bld_e2e0000000000000000c0de1";
    await t.db.prepare(`INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, strategy, trigger, created_at, updated_at)
      VALUES (?, ?, ?, 'revision', 1, 'wdf-copy', 'ready_for_review', 'standard', 'backfill', ?, ?)`).bind(copy, FX.FIXTURE.projectId, FX.FIXTURE.orgId, nowIso(), nowIso()).run();
    await sweepBuilds(t.db);
    const state = async (id: string) => (await t.db.prepare(`SELECT state FROM build_jobs WHERE id = ?`).bind(id).first<{ state: string }>())!.state;
    assert.equal(await state(copy), "canceled", "the sweep cancels a ready_for_review build of an ineligible project");
    assert.equal(await state(FX.FIXTURE.jobId), "approved", "and leaves the approved fixture alone");
    assert.ok((await WD.eligibility(t.db, FX.FIXTURE.jobId)).ok, "which therefore stays deliverable");
  } finally { t.close(); }
});

test("[WDF-04] the fixture never claims to be AI output", async () => {
  const t = await createTestApp();
  try {
    // Staging already has Crestmont's own internal organisation (created long before the fixture), as here.
    await createStaff(t.db, "owner");
    raw(t.db).exec(FX.fixtureSql(FX.loadFixtureFiles(), new Date(Date.now() + 1000).toISOString()));
    const job = (await t.db.prepare(`SELECT * FROM build_jobs WHERE id = ?`).bind(FX.FIXTURE.jobId).first<Record<string, unknown>>())!;
    assert.match(String(job.state_reason), /NOT generated by the AI Website Builder/);
    assert.equal(job.ai_acceptance, null, "no automated-acceptance verdict");
    assert.equal(job.internal_approved_by, null);
    assert.equal(job.approved_by, null, "no person is recorded as having approved it");
    assert.equal(job.preview_url, null);
    const rev = (await t.db.prepare(`SELECT * FROM build_revisions WHERE job_id = ?`).bind(FX.FIXTURE.jobId).first<Record<string, unknown>>())!;
    assert.equal(rev.score, null, "no quality score is claimed");
    assert.equal(rev.is_best, 0);
    assert.equal(rev.decision, "E2E_FIXTURE");
    assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM build_quality WHERE job_id = ?`).bind(FX.FIXTURE.jobId).first<{ n: number }>())!.n, 0, "no scorecard");
    const org = (await t.db.prepare(`SELECT kind, name FROM organizations WHERE id = ?`).bind(FX.FIXTURE.orgId).first<{ kind: string; name: string }>())!;
    assert.equal(org.kind, "internal", "not a customer: no customer record is fabricated");
    assert.match(org.name, /E2E fixture \(synthetic\)/);
    assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM orders`).first<{ n: number }>())!.n, 0, "no order, invoice or payment is fabricated");
    // It does not become Crestmont's primary internal organisation (code that picks "the" internal org takes the oldest).
    const first = await t.db.prepare(`SELECT id FROM organizations WHERE kind = 'internal' ORDER BY created_at LIMIT 1`).first<{ id: string }>();
    assert.notEqual(first?.id, FX.FIXTURE.orgId);
  } finally { t.close(); }
});

test("[WDF-05] the fixture can only be applied to staging", () => {
  assert.throws(() => FX.assertStagingTarget({ environment: "production", url: "https://crestmont-platform-staging.partners-df4.workers.dev" }), /staging only/);
  assert.throws(() => FX.assertStagingTarget({ url: "https://crestmont-platform-staging.partners-df4.workers.dev" }), /staging only/);
  assert.throws(() => FX.assertStagingTarget({ environment: "staging", url: "https://crestmontwebsitedevelopment.com" }), /not the staging Worker/);
  assert.throws(() => FX.assertStagingTarget({ environment: "staging", url: "https://crestmont-platform.partners-df4.workers.dev" }), /not the staging Worker/);
  assert.doesNotThrow(() => FX.assertStagingTarget({ environment: "staging", url: "https://crestmont-platform-staging.partners-df4.workers.dev/" }));
  assert.deepEqual(FX.STAGING, { database: "crestmont-staging", bucket: "crestmont-files-staging" });
  // The D1 side goes through wranglerOps, which hard-codes the staging database and --env staging.
  const src = readFileSync(join(import.meta.dirname, "../scripts/staging-access.ts"), "utf8");
  assert.match(src, /const d1 = \["d1", "execute", "crestmont-staging", "--remote", "--env", "staging"\]/);
  // No production workflow runs it.
  for (const wf of ["deploy-production.yml", "provision-production.yml", "release.yml"]) {
    assert.doesNotMatch(readFileSync(join(import.meta.dirname, `../.github/workflows/${wf}`), "utf8"), /staging-delivery-fixture/, wf);
  }
});
