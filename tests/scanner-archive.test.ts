// scanner/src/archive.ts — reading what a ZIP declares it expands to, and deciding when that is beyond what the
// daemon will examine.
//
// This reader exists because real ClamAV answers "OK" for an archive whose member exceeds its MaxFileSize: it skips
// the member and does not say so (tests/scanner-clamav.test.ts measures that against the live daemon). So these
// tests cover the reader itself, including the malformed input it has to survive — a scanner that throws on a bad
// archive is a scanner that stops scanning, and the file it choked on is the one that mattered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { archiveSizes, beyondDaemonLimits, looksLikeZip, DEFAULT_DAEMON_LIMITS } from "../scanner/src/archive.ts";
import { makeZip } from "../runner/test/fixtures/zip-writer.ts";
import { readFileSync } from "node:fs";

const LIMITS = { maxFileSizeBytes: 1_000_000, maxScanSizeBytes: 4_000_000 };

test("[SEC-003] archive: declared sizes are read from the central directory, not from the local headers", () => {
  const zip = makeZip([
    { path: "small.txt", body: "x".repeat(100) },
    { path: "big.bin", body: Buffer.alloc(50_000, 0x41) },
  ]);
  const a = archiveSizes(zip)!;
  assert.equal(a.entries, 2);
  assert.equal(a.largestUncompressed, 50_000);
  assert.equal(a.totalUncompressed, 50_100);
  assert.equal(a.indeterminate, false);

  // A local header that lies about its size must not change the answer: the central directory is authoritative,
  // which is the same rule runner/src/frontend/zip.ts follows when it extracts.
  const lying = makeZip([{ path: "big.bin", body: Buffer.alloc(50_000, 0x41), lieLocalSize: 10 }]);
  assert.equal(archiveSizes(lying)!.largestUncompressed, 50_000);
});

test("[SEC-003] archive: a member beyond MaxFileSize is unexaminable, and the reason names the measurement", () => {
  const bomb = makeZip([{ path: "payload.bin", body: Buffer.alloc(2_000_000, 0x41) }]);
  assert.ok(bomb.length < 10_000, "a bomb is small on the wire: that is the whole problem");

  const why = beyondDaemonLimits(bomb, LIMITS);
  assert.match(why ?? "", /archive member declares 2000000 bytes uncompressed/);
  assert.match(why ?? "", /MaxFileSize of 1000000/);
  assert.match(why ?? "", /skips such a member without reporting it/, "says why clamd's OK cannot be trusted here");

  // Many members, each under MaxFileSize, together beyond MaxScanSize.
  const spread = makeZip(Array.from({ length: 6 }, (_, i) => ({ path: `p${i}.bin`, body: Buffer.alloc(900_000, 0x41) })));
  assert.match(beyondDaemonLimits(spread, LIMITS) ?? "", /declares 5400000 bytes uncompressed across 6 entries.*MaxScanSize of 4000000/);

  // Comfortably inside both: the daemon's verdict can be taken at face value.
  assert.equal(beyondDaemonLimits(makeZip([{ path: "a.txt", body: "hello" }]), LIMITS), null);
});

test("[SEC-003] archive: a real frontend artifact is well within the limits", () => {
  // The actual approved fixture, zipped as it is uploaded. If a legitimate artifact tripped this check the gate
  // would be useless, so this is the false-positive guard.
  const files = ["package.json", "index.html", "src/pages/home.tsx", "src/styles.css", "vite.config.ts"]
    .map((p) => ({ path: p, body: readFileSync(`runner/test/fixtures/summit-haul-frontend/${p}`) }));
  const zip = makeZip(files);
  const a = archiveSizes(zip)!;
  assert.equal(a.entries, files.length);
  assert.equal(beyondDaemonLimits(zip, DEFAULT_DAEMON_LIMITS), null, "a genuine frontend artifact is examinable");
  assert.ok(a.totalUncompressed < 1024 * 1024, `a frontend's sources are small (${a.totalUncompressed} bytes)`);
});

test("[SEC-003] archive: malformed and non-ZIP input is survived, and unknown expansion is never treated as small", () => {
  // Not a ZIP at all: no opinion, and the daemon decides as before.
  for (const b of [Buffer.alloc(0), Buffer.from("not a zip"), Buffer.from("%PDF-1.4\n"), Buffer.alloc(3)]) {
    assert.equal(looksLikeZip(b) && archiveSizes(b) !== null, false);
    assert.equal(beyondDaemonLimits(b, LIMITS), null, "a non-archive is left to clamd");
  }

  // A ZIP header with nothing behind it, and a central directory truncated mid-entry: no crash, no false "small".
  const zip = makeZip([{ path: "a.txt", body: "x".repeat(5000) }]);
  for (const cut of [4, 30, zip.length - 40, zip.length - 10, zip.length - 1]) {
    const truncated = zip.subarray(0, cut);
    assert.doesNotThrow(() => archiveSizes(truncated), `truncated at ${cut}`);
    assert.doesNotThrow(() => beyondDaemonLimits(truncated, LIMITS), `truncated at ${cut}`);
  }

  // Byte-level corruption anywhere in the archive must never throw: fuzzing the one parser that runs before clamd.
  for (let i = 0; i < zip.length; i += 7) {
    const flipped = Buffer.from(zip);
    flipped[i] ^= 0xff;
    assert.doesNotThrow(() => beyondDaemonLimits(flipped, LIMITS), `byte ${i} flipped`);
  }
});

test("[SEC-003] archive: a size the reader cannot resolve is reported as unexaminable, not as zero", () => {
  // A ZIP64 marker with no ZIP64 extra field to resolve it. Guessing "small" here would be the one unsafe guess, so
  // it must come back as unexaminable instead.
  const zip = makeZip([{ path: "a.bin", body: Buffer.alloc(2048, 7) }]);
  const copy = Buffer.from(zip);
  // Find the central-directory entry and saturate its uncompressed-size field.
  const at = copy.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(at > 0, "central directory entry located");
  copy.writeUInt32LE(0xffffffff, at + 24);

  const a = archiveSizes(copy)!;
  assert.equal(a.indeterminate, true, "the reader says it could not resolve the size");
  assert.match(beyondDaemonLimits(copy, LIMITS) ?? "", /declared sizes could not be read/);
});

test("[SEC-003] archive: the scanner's default limits match what the compose file configures on the daemon", () => {
  // The scanner can only know the daemon's blind spot if the two agree. A change to one and not the other either
  // lets bombs through or rejects legitimate artifacts, and neither shows up at run time.
  const compose = readFileSync("scanner/docker-compose.yml", "utf8");
  const mb = (name: string) => {
    const m = new RegExp(`CLAMD_CONF_${name}: (\\d+)M`).exec(compose);
    assert.ok(m, `CLAMD_CONF_${name} is set in the compose file`);
    return Number(m[1]) * 1024 * 1024;
  };
  assert.equal(DEFAULT_DAEMON_LIMITS.maxFileSizeBytes, mb("MaxFileSize"));
  assert.equal(DEFAULT_DAEMON_LIMITS.maxScanSizeBytes, mb("MaxScanSize"));

  // And the values handed to the scanner service agree with the daemon's, in bytes.
  for (const [env, conf] of [["CLAMD_MAX_FILE_SIZE", "MaxFileSize"], ["CLAMD_MAX_SCAN_SIZE", "MaxScanSize"]] as const) {
    const m = new RegExp(`${env}: "(\\d+)"`).exec(compose);
    assert.ok(m, `${env} is passed to the scanner service`);
    assert.equal(Number(m[1]), mb(conf), `${env} must equal CLAMD_CONF_${conf}`);
  }
});
