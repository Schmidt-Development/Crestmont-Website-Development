// AI Build preview — collecting a revision's rendered frontend from the workspace.
//
// The paths this produces become the preview's own URLs, so a page's `href="assets/site.css"` has to resolve the
// same way it does on the real site. On Windows that means the separator must be normalized here: a snapshot full
// of "assets\site.css" would be refused by the platform's path allowlist, and every asset would 404.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { collectSnapshot } from "../src/orchestrator/snapshot.ts";
import { tmp } from "./helpers.ts";

function site(): string {
  const repo = tmp("aib-snap-");
  const w = (rel: string, body: string | Buffer) => {
    const p = path.join(repo, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  w("public/index.html", "<!doctype html><title>Junk in the Trunk</title>");
  w("public/services.html", "<!doctype html><title>Services</title>");
  w("public/assets/site.css", "h1{color:navy}");
  w("public/assets/img/hero.png", Buffer.from("89504e470d0a1a0a", "hex"));
  w("public/robots.txt", "User-agent: *");
  w(".crestmont/screenshots/home-desktop.png", Buffer.from("89504e470d0a1a0a", "hex"));
  w(".crestmont/screenshots/home-mobile.png", Buffer.from("89504e470d0a1a0a", "hex"));
  // Not part of the rendered site, and some of it must never leave the workspace.
  w("src/worker.js", "export default {}");
  w("migrations/0001_init.sql", "CREATE TABLE t (id TEXT);");
  w("public/node_modules/pkg/index.js", "module.exports = 1");
  w(".crestmont/acceptance.json", '[{"id":"ac-01","status":"passed"}]');
  w(".env", "SECRET=should-never-be-collected");
  w("public/.env", "SECRET=should-never-be-collected");
  return repo;
}

test("[AIB-SNAPSHOT] the rendered site and the cycle's screenshots are collected, with forward-slash paths", () => {
  const snap = collectSnapshot(site());
  const paths = snap.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    ".crestmont/screenshots/home-desktop.png",
    ".crestmont/screenshots/home-mobile.png",
    "assets/img/hero.png",
    "assets/site.css",
    "index.html",
    "robots.txt",
    "services.html",
  ]);
  assert.ok(!paths.some((p) => p.includes("\\")), "a backslash here would be refused by the platform and 404 every asset");
  assert.ok(snap.bytes > 0);
  // Paths are relative to public/, so the preview serves them at the same URLs the real site uses.
  assert.ok(!paths.some((p) => p.startsWith("public/")), "the site root is public/, so it is not part of the URL");
});

test("[AIB-SNAPSHOT] the backend, migrations, dependencies and secrets are not collected", () => {
  const snap = collectSnapshot(site());
  const paths = snap.files.map((f) => f.path);
  for (const unwanted of ["src/worker.js", "worker.js", "migrations/0001_init.sql", "node_modules/pkg/index.js", ".crestmont/acceptance.json", ".env"]) {
    assert.ok(!paths.some((p) => p.endsWith(unwanted)), `must not collect ${unwanted}`);
  }
  // A preview is a view of the frontend, not a deployment: nothing executable server-side is even read.
  assert.ok(!paths.some((p) => p.includes("node_modules")), "dependencies are never part of a snapshot");
});

test("[AIB-SNAPSHOT] content is carried verbatim, so what the Founder sees is what the builder wrote", () => {
  const snap = collectSnapshot(site());
  const index = snap.files.find((f) => f.path === "index.html")!;
  assert.equal(Buffer.from(index.base64, "base64").toString("utf8"), "<!doctype html><title>Junk in the Trunk</title>");
  const png = snap.files.find((f) => f.path === "assets/img/hero.png")!;
  assert.equal(Buffer.from(png.base64, "base64").toString("hex"), "89504e470d0a1a0a", "binary survives the round-trip");
});

test("[AIB-SNAPSHOT] a workspace with no site yet yields nothing rather than failing", () => {
  const snap = collectSnapshot(tmp("aib-empty-"));
  assert.deepEqual(snap.files, [], "an early cycle may have no public/ at all");
  assert.equal(snap.bytes, 0);
});

test("[AIB-SNAPSHOT] an oversized file is left out and reported, not silently dropped", () => {
  const repo = tmp("aib-big-");
  mkdirSync(path.join(repo, "public"), { recursive: true });
  writeFileSync(path.join(repo, "public", "index.html"), "<!doctype html><title>ok</title>");
  writeFileSync(path.join(repo, "public", "huge.png"), Buffer.alloc(2_000_001, 1));
  const snap = collectSnapshot(repo);
  assert.deepEqual(snap.files.map((f) => f.path), ["index.html"]);
  assert.deepEqual(snap.skipped, ["huge.png"], "the Founder is told what was left out");
});
