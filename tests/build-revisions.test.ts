// AI Build preview — per-revision website snapshots (migration 0072, src/services/build-revisions.ts).
//
// These bytes are written by an AI builder, so the point of most of these tests is what the platform REFUSES. The
// Founder needs to see the generated website; nothing about that should let generated code reach a staff session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { revisionPath, previewHeaders, resolveRequested, rewriteForPrefix, REWRITTEN } from "../src/services/build-revisions.ts";
import { createTestApp, createStaff, createCustomer, MemoryStorage } from "./support/app.ts";
import { FakePayments } from "./support/security-world.ts";
import { newId, nowIso } from "../src/lib/db.ts";

test("[AIB-PREVIEW] a path is accepted only if it is a plain, relative, known-type website path", () => {
  for (const p of ["index.html", "about.html", "assets/site.css", "assets/img/hero.png", "a/b/c/d.js", "favicon.ico", "robots.txt", "sitemap.xml", ".crestmont/screenshots/home-desktop.png"]) {
    assert.ok(revisionPath(p), `should accept ${p}`);
  }
  assert.equal(revisionPath("index.html")!.kind, "page");
  assert.equal(revisionPath("assets/site.css")!.kind, "asset");
  assert.equal(revisionPath(".crestmont/screenshots/home-mobile.png")!.kind, "screenshot", "a cycle's captures belong to the revision");
  assert.equal(revisionPath("index.html")!.contentType, "text/html; charset=utf-8");
});

test("[AIB-PREVIEW] traversal, absolute paths and drive letters are refused, never repaired", () => {
  for (const p of [
    "../secret.html", "a/../../b.html", "./index.html", "a//b.html",
    "/etc/passwd", "/index.html",
    "C:/Windows/win.ini", "c:\\windows\\win.ini", "\\\\server\\share\\x.html",
    "a/./b.html", "..", ".", "",
  ]) {
    assert.equal(revisionPath(p), null, `must refuse ${JSON.stringify(p)}`);
  }
  // Refusing rather than sanitizing is deliberate: a rewritten path hides the builder's mistake and is how a
  // traversal survives one layer of cleaning.
  assert.equal(revisionPath("..%2F..%2Fx.html"), null, "a percent-encoded traversal is not a valid stored path either");
});

test("[AIB-PREVIEW] only known frontend types are stored, and no dotfile other than the screenshots", () => {
  for (const p of ["worker.js.map", "index.html"]) assert.ok(revisionPath(p), `should accept ${p}`);
  for (const p of [
    "server.ts", "worker.py", "run.sh", "app.exe", "data.db", "archive.tgz", "Makefile", "index",
    ".env", ".env.local", ".git/config", ".npmrc", ".dev.vars", ".crestmont/acceptance.json",
  ]) {
    assert.equal(revisionPath(p), null, `must refuse ${p}`);
  }
  assert.equal(revisionPath("a file.html"), null, "a space is refused rather than encoded");
  assert.equal(revisionPath("x.html?a=1"), null, "a query string is not part of a stored path");
  assert.equal(revisionPath("x.html#frag"), null);
  assert.equal(revisionPath("a\u0000b.html"), null, "no control bytes");
  assert.equal(revisionPath("a".repeat(400) + ".html"), null, "bounded length");
  assert.equal(revisionPath(42 as unknown as string), null, "a non-string is not a path");
});

test("[AIB-PREVIEW] a served preview is sandboxed: generated code gets an opaque origin and no way out", () => {
  const h = previewHeaders("text/html; charset=utf-8");
  const csp = h["content-security-policy"];
  // The sandbox directive is what makes this safe to serve from the staff origin at all: the document cannot read
  // the session cookie or script the page that framed it, whether embedded or opened in its own tab.
  assert.match(csp, /(^|;\s*)sandbox allow-scripts allow-forms allow-popups/, "sandboxed, with scripts allowed so the real frontend runs");
  assert.doesNotMatch(csp, /allow-same-origin/, "allow-same-origin would hand generated code the staff origin");
  assert.match(csp, /connect-src 'none'/, "generated code cannot call the platform API");
  assert.match(csp, /form-action 'none'/, "and cannot post anywhere: its own backend is not deployed here");
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(h["x-content-type-options"], "nosniff");
  assert.equal(h["referrer-policy"], "no-referrer");
  assert.match(h["cache-control"], /private/, "a snapshot needs a session to read, so never a shared cache");
  assert.equal(h["content-type"], "text/html; charset=utf-8");
});

// The full-stack starter publishes root-relative, extensionless URLs (`/about`, `/assets/site.css`), which its
// deployed Worker maps onto files. A preview served under a path prefix has to do the same, or the CSS 404s and the
// Founder is shown an unstyled page while being told it is the real website.
test("[AIB-PREVIEW] an extensionless root-relative request resolves to the stored file", () => {
  const stored = new Set(["index.html", "about.html", "services.html", "assets/site.css", "docs/index.html"]);
  const has = (p: string) => stored.has(p);
  assert.equal(resolveRequested("", has), "index.html", "the site root");
  assert.equal(resolveRequested("/", has), "index.html");
  assert.equal(resolveRequested("about", has), "about.html", "what `/about` means on the deployed site");
  assert.equal(resolveRequested("about.html", has), "about.html", "and the file itself still works");
  assert.equal(resolveRequested("assets/site.css", has), "assets/site.css");
  assert.equal(resolveRequested("docs", has), "docs/index.html", "a directory index");
  assert.equal(resolveRequested("missing", has), null, "a page the builder never produced is still a 404");
  assert.equal(resolveRequested("../../etc/passwd", has), null, "resolution never widens the path allowlist");
  assert.equal(resolveRequested("/etc/passwd", has), null);
});

test("[AIB-PREVIEW] root-relative URLs are pointed at the preview prefix, and nothing else is touched", () => {
  const P = "/staff/builds/bld_1/rev/1-0";
  const html = [
    '<link rel="stylesheet" href="/assets/site.css">',
    '<a href="/about">About</a>',
    '<img src="/assets/img/hero.png" srcset="/assets/img/hero.png 1x, /assets/img/hero@2x.png 2x">',
    '<a href="https://example.test/x">external</a>',
    '<a href="//cdn.example.test/y">protocol relative</a>',
    '<a href="#main">skip</a>',
    '<a href="mailto:owner@junk.test">mail</a>',
    '<a href="tel:+15175550142">call</a>',
    '<a href="services.html">already relative</a>',
    '<img src="data:image/png;base64,AAAA">',
    '<div style="background:url(/assets/bg.png)"></div>',
  ].join("\n");
  const out = rewriteForPrefix("text/html; charset=utf-8", html, P);
  assert.ok(out.includes(`href="${P}/assets/site.css"`), "the stylesheet now loads");
  assert.ok(out.includes(`href="${P}/about"`), "and in-page links stay inside the preview");
  assert.ok(out.includes(`srcset="${P}/assets/img/hero.png 1x, ${P}/assets/img/hero@2x.png 2x"`));
  assert.ok(out.includes(`url(${P}/assets/bg.png)`));
  // Everything that is not a single-slash path is left exactly as the builder wrote it.
  assert.match(out, /href="https:\/\/example\.test\/x"/);
  assert.match(out, /href="\/\/cdn\.example\.test\/y"/);
  assert.match(out, /href="#main"/);
  assert.match(out, /href="mailto:owner@junk\.test"/);
  assert.match(out, /href="tel:\+15175550142"/);
  assert.match(out, /href="services\.html"/);
  assert.match(out, /src="data:image\/png;base64,AAAA"/);
  // Idempotent: a second pass must not stack prefixes.
  assert.equal(rewriteForPrefix("text/html; charset=utf-8", out, P), out, "rewriting twice changes nothing");
});

test("[AIB-PREVIEW] CSS url() is rewritten; other types are served byte-for-byte", () => {
  const P = "/staff/builds/bld_1/rev/1-0";
  assert.equal(rewriteForPrefix("text/css; charset=utf-8", "body{background:url('/assets/bg.png')}", P), `body{background:url('${P}/assets/bg.png')}`);
  assert.equal(rewriteForPrefix("text/css; charset=utf-8", "body{background:url(https://x.test/a.png)}", P), "body{background:url(https://x.test/a.png)}");
  assert.ok(REWRITTEN("text/html; charset=utf-8"));
  assert.ok(REWRITTEN("text/css; charset=utf-8"));
  for (const ct of ["image/png", "text/javascript; charset=utf-8", "application/json; charset=utf-8", "font/woff2", "image/svg+xml"]) {
    assert.equal(REWRITTEN(ct), false, `${ct} is served exactly as stored`);
    assert.equal(rewriteForPrefix(ct, "/assets/x", P), "/assets/x", "and is not rewritten even if asked");
  }
});

// The page must show the real stored artifacts, not a shell. In particular a revision the ratchet rolled back has
// to remain visible with its reason, because that is the one a "latest preview wins" design would have destroyed.
test("[AIB-PREVIEW] the inspect page shows the stored revisions, the best one, and the rolled-back one with its reason", async () => {
  const t = await createTestApp({ BUILD_RUNNER_SECRET: "s", overrides: { storage: new MemoryStorage(), payments: new FakePayments() } });
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test");
  const oc = await t.client().login(owner.email, undefined, owner.secret);
  const cu = await createCustomer(t.db, "jitt@matrix.example", "Junk in the Trunk");
  const org = { id: cu.organizationId };
  const pid = newId("prj");
  await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at)
    VALUES (?,?,?,'scope_review',2,'upfront',?,?)`)
    .bind(pid, org.id, "Junk in the Trunk", nowIso(), nowIso()).run();
  const job = newId("bld");
  await t.db.prepare(`INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, state_reason, strategy, package_id, trigger, attempts, created_at, updated_at)
    VALUES (?,?,?,'first_build',0,?,'ready_for_review','built','standard','business','sweep',1,?,?)`)
    .bind(job, pid, org.id, `${pid}:first`, nowIso(), nowIso()).run();

  const put = async (cycle: number, phase: string, score: number, best: boolean, reverted: boolean, reason: string | null, body: string) => {
    const rev = newId("brev");
    // The revision row first: the file rows reference it.
    await t.db.prepare(`INSERT INTO build_revisions (id, job_id, project_id, cycle, attempt, phase, score, decision, is_best, reverted, reverted_reason, file_count, total_bytes, created_at)
      VALUES (?,?,?,?,1,?,?,?,?,?,?,3,100,?)`)
      .bind(rev, job, pid, cycle, phase, score, "FIX_DEFECTS", best ? 1 : 0, reverted ? 1 : 0, reason, nowIso()).run();
    for (const [path, content, ct, kind] of [
      ["index.html", body, "text/html; charset=utf-8", "page"],
      ["assets/site.css", "h1{color:navy}", "text/css; charset=utf-8", "asset"],
      [".crestmont/screenshots/home-desktop.png", "PNG", "image/png", "screenshot"],
    ] as const) {
      const key = `builds/${job}/rev/1-${cycle}/${path}`;
      await t.env.overrides!.storage!.put(key, new TextEncoder().encode(content), ct);
      await t.db.prepare(`INSERT INTO build_revision_files (revision_id, path, kind, content_type, size_bytes, sha256, storage_key) VALUES (?,?,?,?,?,?,?)`)
        .bind(rev, path, kind, ct, content.length, "0".repeat(64), key).run();
    }
  };
  await put(0, "build", 7.5, true, false, null, '<!doctype html><title>JITT</title><link rel="stylesheet" href="/assets/site.css"><h1>Original</h1>');
  await put(1, "repair", 6.9, false, true, "the repair lowered the quality score from 7.5 to 6.9", '<!doctype html><title>JITT</title><h1>Worse</h1>');

  const page = await (await oc.get(`/staff/builds/${job}/inspect`)).text();
  assert.match(page, /Initial generated website/, "the baseline revision is listed");
  assert.match(page, /Repair after review cycle 1/, "and so is the repair");
  assert.match(page, /Best verified/, "the ratchet's best revision is marked");
  assert.match(page, /Rolled back/, "and the rolled-back one is still here");
  assert.match(page, /the repair lowered the quality score from 7\.5 to 6\.9/, "with the runner's own reason");
  assert.match(page, new RegExp(`/staff/builds/${job}/rev/1-0/index\.html`), "the preview frame points at the stored revision");
  assert.match(page, /screenshots\/home-desktop\.png/, "the reviewer's screenshot is shown");
  assert.match(page, /assets\/site\.css/, "and the file list names what the revision contains");
  assert.match(page, /7\.5\/10/, "the best score is reported");

  // The default shown revision is the best one, not merely the newest: a worse repair must not take over the view.
  assert.match(page, /Website preview — Initial generated website/, "the best revision is what the Founder sees first");

  // Comparison puts the two side by side and says which way the score moved.
  const cmp = await (await oc.get(`/staff/builds/${job}/inspect?rev=1-1&cmp=1-0`)).text();
  assert.match(cmp, new RegExp(`/staff/builds/${job}/rev/1-1/index\.html`));
  assert.match(cmp, new RegExp(`/staff/builds/${job}/rev/1-0/index\.html`));
  assert.match(cmp, /-0\.6 worse/, "the direction of the change is stated plainly");

  // And the embedded frontend really is served, with its stylesheet pointed at the preview path.
  const served = await oc.get(`/staff/builds/${job}/rev/1-0/index.html`);
  assert.equal(served.status, 200);
  const htmlBody = await served.text();
  assert.match(htmlBody, new RegExp(`href="/staff/builds/${job}/rev/1-0/assets/site\.css"`), "the stylesheet loads inside the preview");
  assert.match(served.headers.get("content-security-policy") ?? "", /sandbox allow-scripts/, "served sandboxed");
  const css = await oc.get(`/staff/builds/${job}/rev/1-0/assets/site.css`);
  assert.equal(css.status, 200);
  assert.equal(await css.text(), "h1{color:navy}", "the asset is the bytes the builder wrote");
  // `/about` style extensionless routing resolves the way the deployed site does.
  assert.equal((await oc.get(`/staff/builds/${job}/rev/1-0/`)).status, 200, "the revision root serves index.html");
});
