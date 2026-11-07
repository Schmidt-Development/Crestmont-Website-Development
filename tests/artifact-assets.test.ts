// Acquiring an uploaded design's external dependencies: what may be fetched, what the bytes have to be, and the
// one set every later step reads.
//
// The design measurement runs with `--network none`, so a font CDN and an image host were absent from every
// measured baseline: the fallback face and the empty image box became the approved design. The fix fetches them
// once, on the platform, and pins them into the artifact. That makes this file the place where "load the
// customer's web font" is kept from becoming "fetch whatever URL an uploaded file happens to contain".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import * as DL from "../src/services/design-locked.ts";
import * as AA from "../src/services/artifact-assets.ts";
import { sha256Hex } from "../src/lib/crypto.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(7)]);
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, ...new Array(64).fill(3)]);
const CSS = new TextEncoder().encode("@font-face{font-family:Rowe;src:url(https://fonts.gstatic.com/a.woff2)}");

/** A fetch that answers from a script, records what it was asked, and never touches the network. */
function fakeFetch(script: Record<string, { status?: number; type?: string; body?: Uint8Array; location?: string }>) {
  const asked: string[] = [];
  const impl = (async (url: string | URL) => {
    const u = String(url);
    asked.push(u);
    const r = script[u];
    if (!r) return new Response("no", { status: 404 });
    if (r.location) return new Response(null, { status: r.status ?? 302, headers: { location: r.location } });
    const body = r.body ?? new Uint8Array();
    return new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, {
      status: r.status ?? 200,
      headers: { "content-type": r.type ?? "application/octet-stream", "content-length": String(body.length) },
    });
  }) as unknown as typeof fetch;
  return { impl, asked };
}

async function artifactFor(t: Awaited<ReturnType<typeof createTestApp>>, staffId: string, name: string) {
  const made = await DL.createTestProject(t.db, { name, actorId: staffId });
  const artifact = await DL.recordArtifact(t.db, {
    projectId: made.projectId, organizationId: made.organizationId, source: "upload",
    sha256: "a".repeat(64), sizeBytes: 2048, uploadedBy: staffId, scanStatus: "clean",
  });
  return { made, artifact };
}

test("[AST-01] only an https URL on a public name is fetched", () => {
  // The SSRF boundary, as one function, because this is the function that decides whether a feature for loading
  // web fonts can be turned into a way of reading something that is not a web font.
  for (const bad of [
    "http://fonts.example.com/a.woff2",            // not https
    "https://user:pw@fonts.example.com/a.woff2",   // credentials
    "https://fonts.example.com:8443/a.woff2",      // a port that is not 443
    "https://127.0.0.1/a.png",
    "https://10.1.2.3/a.png",
    "https://192.168.0.5/a.png",
    "https://169.254.169.254/latest/meta-data/",   // the cloud metadata address
    "https://[::1]/a.png",
    "https://localhost/a.png",
    "https://metadata.google.internal/x",
    "https://build.internal/a.png",
    "file:///etc/passwd",
    "not a url at all",
  ]) {
    const r = AA.checkUrl(bad);
    assert.equal(r.ok, false, `${bad} must be refused`);
    assert.ok("why" in r && r.why.length > 0, `${bad} must say why`);
  }

  for (const good of [
    "https://fonts.googleapis.com/css2?family=Fraunces",
    "https://fonts.gstatic.com/s/a/b.woff2",
    "https://images.example.com/hero.jpg?v=2",
    "https://cdn.example.co.uk:443/logo.png",
  ]) {
    assert.ok(AA.checkUrl(good).ok, `${good} must be allowed`);
  }
});

test("[AST-02] an image and a font are pinned, and the bytes are stored by content hash", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const { artifact } = await artifactFor(t, staff.id, "Assets pinned");
    const f = fakeFetch({
      "https://images.example.com/hero.png": { type: "image/png", body: PNG },
      "https://fonts.example.com/body.woff2": { type: "font/woff2", body: WOFF2 },
    });

    const r = await AA.resolveAssets(t.db, t.storage, {
      artifactId: artifact.id, fetchImpl: f.impl,
      requests: [
        { url: "https://images.example.com/hero.png", kind: "image", referencedBy: "index.html" },
        { url: "https://fonts.example.com/body.woff2", kind: "font", referencedBy: "index.html" },
      ],
    });

    assert.equal(r.refusedVisual, 0, JSON.stringify(r.assets.map((a) => a.why)));
    assert.deepEqual(r.assets.map((a) => a.status), ["pinned", "pinned"]);
    const img = r.assets.find((a) => a.kind === "image")!;
    assert.equal(img.sha256, await sha256Hex(PNG), "identified by its content, so the same bytes are stored once");
    assert.equal(img.bytes, PNG.length);
    assert.ok(img.body, "the bytes come back so the runner can write the file without a second round trip");
    assert.match(AA.localPathFor(img), /^_crestmont-assets\/[0-9a-f]{32}\.png$/);

    // Stored where a build months later can read the same bytes.
    const stored = await t.storage.get(img.r2Key!);
    assert.ok(stored, "the asset is in object storage");

    const rows = await AA.listAssets(t.db, artifact.id);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((x) => x.local_path && x.r2_key && x.sha256), JSON.stringify(rows));
  } finally { t.close(); }
});

test("[AST-03] a Content-Type is a claim by a stranger, and the bytes have to agree with it", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const { artifact } = await artifactFor(t, staff.id, "Assets lying");
    const f = fakeFetch({
      // Served as a PNG, actually a script. This is the case that would otherwise write executable text into an
      // artifact under a .png name.
      "https://evil.example.com/hero.png": { type: "image/png", body: new TextEncoder().encode("<script>alert(1)</script>") },
      // An honest type that is simply not allowed in an artifact.
      "https://evil.example.com/app.wasm": { type: "application/wasm", body: PNG },
      // A font that is not a font.
      "https://evil.example.com/body.woff2": { type: "font/woff2", body: PNG },
      // An image served where a stylesheet was expected.
      "https://evil.example.com/sheet.css": { type: "image/png", body: PNG },
    });

    const r = await AA.resolveAssets(t.db, t.storage, {
      artifactId: artifact.id, fetchImpl: f.impl,
      requests: [
        { url: "https://evil.example.com/hero.png", kind: "image" },
        { url: "https://evil.example.com/app.wasm", kind: "image" },
        { url: "https://evil.example.com/body.woff2", kind: "font" },
        { url: "https://evil.example.com/sheet.css", kind: "stylesheet" },
      ],
    });

    assert.deepEqual(r.assets.map((a) => a.status), ["refused", "refused", "refused", "refused"], JSON.stringify(r.assets));
    assert.match(r.assets[0].why!, /its own first bytes say otherwise/);
    assert.match(r.assets[1].why!, /not one that may be written into an artifact/);
    assert.match(r.assets[2].why!, /first bytes/);
    assert.match(r.assets[3].why!, /stylesheet was expected|a stylesheet was expected|expected/i);
    assert.equal(r.refusedVisual, 4, "and every one of them is a visual dependency that is now missing");
  } finally { t.close(); }
});

test("[AST-04] a redirect is followed, and each hop is checked by the same rules", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const { artifact } = await artifactFor(t, staff.id, "Assets redirect");
    const f = fakeFetch({
      "https://cdn.example.com/a.png": { location: "https://img.example.com/real.png" },
      "https://img.example.com/real.png": { type: "image/png", body: PNG },
      // The attack this check exists for: a public URL that redirects inward.
      "https://cdn.example.com/inward.png": { location: "https://169.254.169.254/latest/meta-data/" },
      // And a redirect that downgrades to plain http.
      "https://cdn.example.com/down.png": { location: "http://img.example.com/real.png" },
    });

    const r = await AA.resolveAssets(t.db, t.storage, {
      artifactId: artifact.id, fetchImpl: f.impl,
      requests: [
        { url: "https://cdn.example.com/a.png", kind: "image" },
        { url: "https://cdn.example.com/inward.png", kind: "image" },
        { url: "https://cdn.example.com/down.png", kind: "image" },
      ],
    });

    assert.equal(r.assets.find((a) => a.url.endsWith("/a.png"))!.status, "pinned", "an ordinary CDN redirect is followed");
    const inward = r.assets.find((a) => a.url.endsWith("/inward.png"))!;
    assert.equal(inward.status, "refused");
    assert.match(inward.why!, /a redirect led to a URL that cannot be fetched/);
    assert.ok(!f.asked.includes("https://169.254.169.254/latest/meta-data/"), "and the inward address was never requested");
    assert.match(r.assets.find((a) => a.url.endsWith("/down.png"))!.why!, /only https is fetched/);
  } finally { t.close(); }
});

test("[AST-05] an asset nobody may read is refused with a reason, not silently skipped", async () => {
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const { artifact } = await artifactFor(t, staff.id, "Assets unavailable");
    const f = fakeFetch({
      "https://images.example.com/gone.png": { status: 404, type: "image/png" },
      "https://images.example.com/private.png": { status: 403, type: "image/png" },
      "https://images.example.com/huge.png": { type: "image/png", body: new Uint8Array(AA.ASSET_LIMITS.bytesPerAsset + 1024) },
    });

    const r = await AA.resolveAssets(t.db, t.storage, {
      artifactId: artifact.id, fetchImpl: f.impl,
      requests: [
        { url: "https://images.example.com/gone.png", kind: "image" },
        { url: "https://images.example.com/private.png", kind: "image" },
        { url: "https://images.example.com/huge.png", kind: "image" },
        // A script is never fetched at all, whoever serves it.
        { url: "https://cdn.example.com/analytics.js", kind: "other" },
      ],
    });

    assert.match(r.assets.find((a) => a.url.endsWith("gone.png"))!.why!, /answered 404/);
    assert.match(r.assets.find((a) => a.url.endsWith("private.png"))!.why!, /not publicly readable/);
    assert.match(r.assets.find((a) => a.url.endsWith("huge.png"))!.why!, /limit/);
    assert.match(r.assets.find((a) => a.url.endsWith("analytics.js"))!.why!, /only images, fonts and stylesheets are pinned/);
    assert.ok(!f.asked.some((u) => u.endsWith("analytics.js")), "a script is not requested on an owner's behalf");

    // Every refusal is recorded, because a missing visual dependency is what makes a baseline incomplete.
    const missing = await AA.missingVisualAssets(t.db, artifact.id);
    assert.equal(missing.length, 3, JSON.stringify(missing.map((m) => m.url)));
    assert.ok(missing.every((m) => m.why && m.why.length > 0));
  } finally { t.close(); }
});

test("[AST-06] re-resolving an artifact returns the stored set and fetches nothing", async () => {
  // The consistency requirement. The measurement, the approved baseline, Model B's build and the final visual
  // check must all render the same files. The artifact in R2 is the archive as uploaded, so a build re-extracts
  // the original external references -- and if it fetched them again it would be measuring whatever those hosts
  // serve today against a baseline measured from what they served at import.
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const { artifact } = await artifactFor(t, staff.id, "Assets consistent");
    const first = fakeFetch({ "https://images.example.com/hero.png": { type: "image/png", body: PNG } });
    const once = await AA.resolveAssets(t.db, t.storage, {
      artifactId: artifact.id, fetchImpl: first.impl,
      requests: [{ url: "https://images.example.com/hero.png", kind: "image" }],
    });
    assert.equal(once.assets[0].status, "pinned");
    assert.equal(first.asked.length, 1);

    // The host now serves something completely different. The second resolution must not notice.
    const later = fakeFetch({ "https://images.example.com/hero.png": { type: "image/png", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(99)]) } });
    const again = await AA.resolveAssets(t.db, t.storage, {
      artifactId: artifact.id, fetchImpl: later.impl,
      requests: [{ url: "https://images.example.com/hero.png", kind: "image" }],
    });
    assert.equal(later.asked.length, 0, "a resolved artifact is never fetched again");
    assert.equal(again.assets[0].sha256, once.assets[0].sha256, "the same bytes, by hash");
    assert.equal(again.assets[0].body, once.assets[0].body, "and the same bytes are handed back");
  } finally { t.close(); }
});

test("[AST-07] a design missing a visual dependency cannot be approved", async () => {
  // The requirement this whole path exists for: rather than silently substituting a fallback, the baseline is
  // refused and the owner is told which dependency and what it does to the design.
  const t = await createTestApp();
  try {
    const staff = await createStaff(t.db, "owner");
    const { made, artifact } = await artifactFor(t, staff.id, "Assets block approval");
    await DL.recordVerdict(t.db, artifact.id, { status: "imported", framework: "static" });
    const baseline = await DL.recordBaseline(t.db, artifact.id, {
      fingerprint: "b".repeat(64),
      signatures: [{ page: "index", viewport: "desktop" }],
      screenshots: [{ page: "index", viewport: "desktop", sha: "c".repeat(64) }],
    });

    const f = fakeFetch({ "https://fonts.example.com/body.woff2": { status: 404, type: "font/woff2" } });
    await AA.resolveAssets(t.db, t.storage, {
      artifactId: artifact.id, fetchImpl: f.impl,
      requests: [{ url: "https://fonts.example.com/body.woff2", kind: "font", referencedBy: "index.html" }],
    });

    await assert.rejects(
      () => DL.approveBaseline(t.db, baseline.id, { approvedBy: staff.id, note: "looks right to me" }),
      (e: Error) => {
        assert.match(e.message, /could not be acquired/);
        assert.match(e.message, /fonts\.example\.com/, e.message);
        assert.match(e.message, /Package them inside the archive/, e.message);
        return true;
      },
    );
    assert.equal((await DL.getBaseline(t.db, baseline.id))!.status, "draft", "and it is still a draft");
    assert.equal(await DL.approvedBaseline(t.db, made.projectId), null, "nothing is approved");

    // Resolved -- the owner packaged the font -- and the same approval goes through.
    await t.db.prepare(`UPDATE frontend_artifact_assets SET status = 'pinned', sha256 = ?, r2_key = ?, local_path = ? WHERE artifact_id = ?`)
      .bind("d".repeat(64), "frontend-assets/x/y", "_crestmont-assets/d.woff2", artifact.id).run();
    const approved = await DL.approveBaseline(t.db, baseline.id, { approvedBy: staff.id, note: "fonts packaged" });
    assert.equal(approved.status, "approved");
  } finally { t.close(); }
});
