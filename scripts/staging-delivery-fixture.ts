// Website Delivery E2E fixture — a synthetic finished build with a real stored website snapshot, for STAGING only.
//
// WHY IT EXISTS. The AI-build delivery E2E (tests/e2e/staging-website-delivery.e2e.ts) needs a finished build with a
// stored snapshot to hand to a customer. Staging has none, so [WDE-02] failed and three checks behind it could not be
// determined. That test is about DELIVERY -- assign, open through the signed capability, refuse everyone else -- not
// about whether the AI builder can build, so it should not depend on the builder having run.
//
// WHAT IT IS. One small hand-written static website (tests/e2e/fixtures/delivery-site: two pages, CSS, JavaScript,
// SVG images, interactive controls), stored as ONE immutable revision snapshot of ONE synthetic build:
//
//   organization  org_e2e00000000000000000de11  internal, "Crestmont internal — Website Delivery E2E fixture (synthetic)"
//   project       prj_e2e00000000000000000de11  in that organization, no order (the shape createTestProject gives a
//                                               builder project; a customer project is what the build is delivered TO)
//   build job     bld_e2e00000000000000000de11  state 'approved', attempt 1
//   revision      brev_e2e…de11_v<N>           attempt 1, cycle N = FIXTURE_VERSION, phase 'final', score NULL
//   files         build_revision_files rows + R2 objects at builds/<job>/rev/1-<N>/<path>, as storeRevision writes
//
// IT IS NOT AI OUTPUT, and nothing here may be read as evidence that Model A or Model B generated a website. The
// build's state_reason, its event, its revision decision ('E2E_FIXTURE'), its organization and project names, and
// a banner on every page of the website itself all say so. Its score is NULL ("not measured"), it is not marked
// as the best revision, it has no quality scorecard, no automated-acceptance verdict and no preview Worker.
//
// WHY 'approved' AND NOT 'ready_for_review'. sweepBuilds (src/services/builds.ts) re-checks the eligibility of
// every project that has a build in ready_for_review (among other states) and CANCELS the build when the project is
// ineligible. An internal project with no order is ineligible unless it has an approved design baseline, so a
// ready_for_review fixture would be cancelled within a minute of the cron -- the likely reason staging has no
// finished build at all. 'approved' is a finished state the sweep leaves alone, and it is deliverable
// (website-delivery.ts FINISHED). No order, invoice or payment is fabricated to make the project look bought, and
// no design approval is invented: the build simply says it is a fixture. [WDF-03] pins this.
//
// HOW ROWS ARE MADE VALID. The same way scripts/seed-staging.ts does it: the SQL is applied to a fresh in-memory
// database built from the real migrations (foreign keys and CHECKs enforced), every path goes through the
// service's own revisionPath() allowlist and content-type map, every file is hashed as storeRevision hashes it,
// and the result is then checked with the application itself -- website-delivery eligibility, and the real
// /build-preview route serving every file with a real signed capability -- before anything touches staging.
//
// IDEMPOTENT. Fixed ids and INSERT OR IGNORE: a rerun creates nothing new. R2 objects are written first (same
// bytes, same keys), then the SQL. The only UPDATE re-asserts the fixture build's own state if something moved it;
// it names the fixture job's id and touches no other row. If the website files change, FIXTURE_VERSION must be
// bumped so the new files become a NEW immutable revision rather than overwriting an old one; [WDF-01] enforces it.
//
// STAGING ONLY. `--apply` requires `--environment staging`, writes only to the hard-coded `crestmont-staging` D1
// database (through scripts/staging-access.ts wranglerOps, which hard-codes it with --env staging) and the
// `crestmont-files-staging` bucket, and refuses a URL that is not the staging Worker. There is no production path.
//
//   node --no-warnings scripts/staging-delivery-fixture.ts --check
//       build + verify locally only (no network)
//   node --no-warnings scripts/staging-delivery-fixture.ts --apply --environment staging --url "$STAGING_URL"
//       env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ACCESS_ROOT_KEY (derives the preview-file key), WRANGLER
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { revisionPath, previewToken } from "../src/services/build-revisions.ts";

export const FIXTURE_DIR = join(import.meta.dirname, "../tests/e2e/fixtures/delivery-site");
/** Bump when any file in FIXTURE_DIR changes: the new files become revision cycle N, never an overwrite. */
export const FIXTURE_VERSION = 0;
/** sha256 over the fixture's files (path + content). [WDF-01] fails when the files change and the version does not. */
export const FIXTURE_CONTENT_SHA = "bb9df61c3e3e1eeb88d61c438bcdc84114bb87ed39c5aab5c6f3d472316c3a11";

export const FIXTURE = {
  orgId: "org_e2e00000000000000000de11",
  orgName: "Crestmont internal — Website Delivery E2E fixture (synthetic)",
  projectId: "prj_e2e00000000000000000de11",
  projectName: "[E2E fixture] Synthetic website delivery build — not AI output",
  jobId: "bld_e2e00000000000000000de11",
  revisionId: `brev_e2e00000000000000000de11_v${FIXTURE_VERSION}`,
  attempt: 1,
  cycle: FIXTURE_VERSION,
  stateReason: "Synthetic E2E delivery fixture: a hand-written static website stored as a snapshot to test website delivery. It was NOT generated by the AI Website Builder (Model A / Model B) and is not evidence that the builder works.",
  marker: "Synthetic E2E delivery fixture — not generated by the AI Website Builder.",
} as const;

export const STAGING = { database: "crestmont-staging", bucket: "crestmont-files-staging" } as const;

export interface FixtureFile { path: string; kind: string; contentType: string; bytes: Uint8Array; sha256: string; storageKey: string }

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
export const storageKeyFor = (path: string) => `builds/${FIXTURE.jobId}/rev/${FIXTURE.attempt}-${FIXTURE.cycle}/${path}`;

/** The website's files, each validated by the service's own path allowlist and content-type map. */
export function loadFixtureFiles(dir = FIXTURE_DIR): FixtureFile[] {
  const out: FixtureFile[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const rel = relative(dir, full).split("\\").join("/");
      if (rel === "README.md") continue; // documentation, not part of the website
      const v = revisionPath(rel);
      if (!v) throw new Error(`fixture file refused by revisionPath(): ${rel}`);
      const bytes = new Uint8Array(readFileSync(full));
      out.push({ path: v.path, kind: v.kind, contentType: v.contentType, bytes, sha256: sha256(bytes), storageKey: storageKeyFor(v.path) });
    }
  };
  walk(dir);
  if (!out.some((f) => f.path === "index.html")) throw new Error("the fixture website has no index.html");
  return out;
}

export function contentSha(files: FixtureFile[]): string {
  return sha256(files.map((f) => `${f.path}\0${f.sha256}`).join("\n"));
}

const q = (s: string | null) => (s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`);

/**
 * The fixture's rows as idempotent SQL, in foreign-key order. `at` is the creation time written on first insert
 * only (INSERT OR IGNORE keeps the original on reruns).
 */
export function fixtureSql(files: FixtureFile[], at: string): string {
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  const F = FIXTURE;
  const lines = [
    `-- Website Delivery E2E fixture v${FIXTURE_VERSION} (synthetic; staging only). Generated by scripts/staging-delivery-fixture.ts.`,
    `INSERT OR IGNORE INTO organizations (id, name, kind, created_at) VALUES (${q(F.orgId)}, ${q(F.orgName)}, 'internal', ${q(at)});`,
    `INSERT OR IGNORE INTO projects (id, organization_id, order_id, product_id, name, status, revision_allowance, payment_schedule, created_at, updated_at)
  VALUES (${q(F.projectId)}, ${q(F.orgId)}, NULL, NULL, ${q(F.projectName)}, 'design', 0, 'upfront', ${q(at)}, ${q(at)});`,
    `INSERT OR IGNORE INTO build_jobs (id, project_id, organization_id, order_id, kind, revision, dedupe_key, state, state_reason, strategy, package_id, trigger, attempts, finished_at, created_at, updated_at)
  VALUES (${q(F.jobId)}, ${q(F.projectId)}, ${q(F.orgId)}, NULL, 'first_build', 0, ${q(`e2e-delivery-fixture:${F.jobId}`)}, 'approved', ${q(F.stateReason)}, 'standard', NULL, 'backfill', ${F.attempt}, ${q(at)}, ${q(at)}, ${q(at)});`,
    // Re-assert the fixture's own finished state if anything moved it. Names the fixture job only.
    `UPDATE build_jobs SET state = 'approved', state_reason = ${q(F.stateReason)}, updated_at = ${q(at)} WHERE id = ${q(F.jobId)} AND (state <> 'approved' OR state_reason IS NOT ${q(F.stateReason)});`,
    `INSERT OR IGNORE INTO build_revisions (id, job_id, project_id, cycle, attempt, phase, commit_sha, score, decision, is_best, reverted, file_count, total_bytes, created_at)
  VALUES (${q(F.revisionId)}, ${q(F.jobId)}, ${q(F.projectId)}, ${F.cycle}, ${F.attempt}, 'final', NULL, NULL, 'E2E_FIXTURE', 0, 0, ${files.length}, ${total}, ${q(at)});`,
    ...files.map((f) => `INSERT OR IGNORE INTO build_revision_files (revision_id, path, kind, content_type, size_bytes, sha256, storage_key)
  VALUES (${q(F.revisionId)}, ${q(f.path)}, ${q(f.kind)}, ${q(f.contentType)}, ${f.bytes.length}, ${q(f.sha256)}, ${q(f.storageKey)});`),
    `INSERT INTO build_events (job_id, at, kind, message, actor_kind, data_json)
  SELECT ${q(F.jobId)}, ${q(at)}, 'action', ${q(`E2E delivery fixture v${FIXTURE_VERSION} stored: ${files.length} file(s). ${F.marker}`)}, 'system', ${q(JSON.stringify({ fixture: true, version: FIXTURE_VERSION, files: files.length, bytes: total }))}
  WHERE NOT EXISTS (SELECT 1 FROM build_events WHERE job_id = ${q(F.jobId)} AND kind = 'action' AND message LIKE ${q(`E2E delivery fixture v${FIXTURE_VERSION} %`)});`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * Prove the fixture with the application itself, on a fresh database built from the real migrations: the SQL
 * applies (twice, idempotently), website delivery says the build may be delivered, and the real /build-preview
 * route serves every file -- with the right type, and the stored bytes -- through a real signed capability.
 */
export async function verifyLocally(files: FixtureFile[]): Promise<string[]> {
  const { createTestApp } = await import("../tests/support/app.ts");
  const WD = await import("../src/services/website-delivery.ts");
  const problems: string[] = [];
  const secret = "local-fixture-verification-secret";
  const t = await createTestApp({ BUILD_PREVIEW_FILE_SECRET: secret } as never);
  try {
    const raw = (t.db as unknown as { raw: { exec(sql: string): void } }).raw;
    const sql = fixtureSql(files, new Date().toISOString());
    raw.exec(sql);
    raw.exec(sql); // idempotent: the second application must change nothing and fail on nothing
    const count = async (table: string, where: string) => (await t.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n;
    if (await count("build_jobs", `id = '${FIXTURE.jobId}'`) !== 1) problems.push("expected exactly one fixture build job");
    if (await count("build_revisions", `job_id = '${FIXTURE.jobId}'`) !== 1) problems.push("expected exactly one fixture revision");
    if (await count("build_revision_files", `revision_id = '${FIXTURE.revisionId}'`) !== files.length) problems.push("expected one file row per fixture file");
    if (await count("build_events", `job_id = '${FIXTURE.jobId}'`) !== 1) problems.push("a rerun duplicated the fixture event");

    const elig = await WD.eligibility(t.db, FIXTURE.jobId);
    if (!elig.ok) problems.push(`website delivery refuses the fixture: ${elig.reasons.join("; ")}`);
    if (elig.revision?.attempt !== FIXTURE.attempt || elig.revision?.cycle !== FIXTURE.cycle) problems.push(`eligibility names revision ${JSON.stringify(elig.revision)}`);

    for (const f of files) await t.storage.put(f.storageKey, f.bytes, f.contentType);
    const token = await previewToken({ BUILD_PREVIEW_FILE_SECRET: secret }, FIXTURE.jobId, FIXTURE.attempt, FIXTURE.cycle);
    if (!token) problems.push("no preview token could be minted");
    const c = t.client();
    for (const f of files) {
      const res = await c.get(`/build-preview/${FIXTURE.jobId}/${FIXTURE.attempt}-${FIXTURE.cycle}/${token}/${f.path}`);
      if (res.status !== 200) { problems.push(`${f.path}: HTTP ${res.status}`); continue; }
      if (res.headers.get("content-type") !== f.contentType) problems.push(`${f.path}: served as ${res.headers.get("content-type")}`);
      const body = new Uint8Array(await res.arrayBuffer());
      if (f.kind === "page") { if (!new TextDecoder().decode(body).includes(FIXTURE.marker)) problems.push(`${f.path}: the synthetic-fixture banner is missing`); }
      else if (sha256(body) !== f.sha256) problems.push(`${f.path}: served bytes differ from the stored bytes`);
    }
    const bad = await c.get(`/build-preview/${FIXTURE.jobId}/${FIXTURE.attempt}-${FIXTURE.cycle}/${token!.slice(0, -2)}00/index.html`);
    if (bad.status !== 403) problems.push(`a tampered capability answered ${bad.status}, not 403`);
  } finally { t.close(); }
  return problems;
}

/** A fixture applied to staging, read back through the deployed Worker with a real capability. */
export async function verifyLive(base: string, previewSecret: string, files: FixtureFile[]): Promise<string[]> {
  const problems: string[] = [];
  const token = await previewToken({ BUILD_PREVIEW_FILE_SECRET: previewSecret }, FIXTURE.jobId, FIXTURE.attempt, FIXTURE.cycle);
  if (!token) return ["no preview token could be minted"];
  for (const f of files) {
    const res = await fetch(`${base}/build-preview/${FIXTURE.jobId}/${FIXTURE.attempt}-${FIXTURE.cycle}/${token}/${f.path}`, { redirect: "manual" });
    if (res.status !== 200) { problems.push(`${f.path}: HTTP ${res.status} from the deployed Worker`); continue; }
    const body = new Uint8Array(await res.arrayBuffer());
    if (f.kind === "page") { if (!new TextDecoder().decode(body).includes(FIXTURE.marker)) problems.push(`${f.path}: the synthetic-fixture banner is missing`); }
    else if (sha256(body) !== f.sha256) problems.push(`${f.path}: the deployed Worker served different bytes`);
  }
  return problems;
}

export interface R2Put { (bucket: string, key: string, file: string, contentType: string): void }

function wranglerR2Put(): R2Put {
  const [cmd, ...base] = (process.env.WRANGLER ?? "npx --yes wrangler@4.149.0").split(" ").filter(Boolean);
  return (bucket, key, file, contentType) => {
    if (bucket !== STAGING.bucket) throw new Error(`refusing to write to bucket ${bucket}`);
    execFileSync(cmd, [...base, "r2", "object", "put", `${bucket}/${key}`, "--file", file, "--content-type", contentType, "--remote"],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  };
}

export function assertStagingTarget(o: { environment?: string; url?: string }): void {
  if (o.environment !== "staging") throw new Error("refusing: this fixture is applied to staging only (--environment staging)");
  if (!o.url || !/^https:\/\/crestmont-platform-staging\.[a-z0-9-]+\.workers\.dev$/.test(o.url.replace(/\/$/, ""))) {
    throw new Error(`refusing: ${o.url ?? "(no --url)"} is not the staging Worker`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const files = loadFixtureFiles();
  console.log(`Website Delivery E2E fixture v${FIXTURE_VERSION}: ${files.length} files, content ${contentSha(files).slice(0, 12)}…`);
  const local = await verifyLocally(files);
  if (local.length) { for (const p of local) console.log(`::error title=Delivery fixture::${p}`); process.exit(1); }
  console.log("Verified locally with the application: SQL applies idempotently, the build is deliverable, every file is served through a signed capability, a tampered one is refused.");
  if (args.includes("--apply")) {
    const url = arg("--url")?.replace(/\/$/, "");
    assertStagingTarget({ environment: arg("--environment"), url });
    const root = process.env.ACCESS_ROOT_KEY;
    if (!root) throw new Error("ACCESS_ROOT_KEY is required (it derives the staging preview-file key for the live check)");
    const { wranglerOps } = await import("./staging-access.ts");
    const { deriveStagingKey } = await import("./staging-secrets.ts");
    // Objects first: the database never names a file that is not there yet.
    const put = wranglerR2Put();
    for (const f of files) put(STAGING.bucket, f.storageKey, join(FIXTURE_DIR, f.path), f.contentType);
    console.log(`Stored ${files.length} object(s) in R2 ${STAGING.bucket} under builds/${FIXTURE.jobId}/rev/${FIXTURE.attempt}-${FIXTURE.cycle}/`);
    const dir = mkdtempSync(join(tmpdir(), "delivery-fixture-"));
    const sqlPath = join(dir, "fixture.sql");
    writeFileSync(sqlPath, fixtureSql(files, new Date().toISOString()));
    const ops = wranglerOps(); // hard-coded: crestmont-staging --remote --env staging
    await ops.execFile(sqlPath);
    const rows = await ops.query<{ state: string; files: number }>(`SELECT j.state, (SELECT COUNT(*) FROM build_revision_files WHERE revision_id = '${FIXTURE.revisionId}') AS files FROM build_jobs j WHERE j.id = '${FIXTURE.jobId}'`);
    if (rows[0]?.state !== "approved" || Number(rows[0]?.files) !== files.length) {
      console.log(`::error title=Delivery fixture::staging D1 holds ${JSON.stringify(rows)} for the fixture`); process.exit(1);
    }
    const live = await verifyLive(url!, deriveStagingKey(root, "previewFile"), files);
    if (live.length) { for (const p of live) console.log(`::error title=Delivery fixture::${p}`); process.exit(1); }
    console.log(`Fixture ready on staging: build ${FIXTURE.jobId}, revision ${FIXTURE.attempt}-${FIXTURE.cycle} (${FIXTURE.revisionId}); every file served by the deployed Worker.`);
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `job=${FIXTURE.jobId}\nrevision=${FIXTURE.attempt}-${FIXTURE.cycle}\n`, { flag: "a" });
  }
}
