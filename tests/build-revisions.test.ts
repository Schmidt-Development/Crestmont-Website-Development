// AI Build preview — per-revision website snapshots (migration 0072, src/services/build-revisions.ts).
//
// These bytes are written by an AI builder, so the point of most of these tests is what the platform REFUSES. The
// Founder needs to see the generated website; nothing about that should let generated code reach a staff session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { revisionPath, previewHeaders } from "../src/services/build-revisions.ts";

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
