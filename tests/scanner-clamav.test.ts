// Scanner certification against REAL ClamAV (SEC-003, F-02).
//
// WHY THIS FILE EXISTS SEPARATELY FROM tests/scanner.test.ts. That suite proves the scanner's logic — the state
// machine, the SHA-256 refusal, the backoff, the verdict mapping — against a stand-in clamd that speaks the real
// z-protocol. A stand-in can prove the MAPPING of `Heuristics.Limits.Exceeded` to `failed`, but it cannot prove that
// real ClamAV actually emits that verdict for a real decompression bomb, or that it unpacks a ZIP to find a signature
// inside it. Those are properties of the daemon and its configuration, not of our code, and they are exactly the
// properties the quarantine rule depends on.
//
// So these tests run only against a real daemon and are skipped otherwise:
//
//   docker run -d --name clamd -p 127.0.0.1:3310:3310 \
//     -e CLAMD_CONF_StreamMaxLength=30M -e CLAMD_CONF_MaxFileSize=30M -e CLAMD_CONF_MaxScanSize=120M \
//     -e CLAMD_CONF_AlertExceedsMax=yes -e CLAMD_CONF_AlertEncryptedArchive=yes \
//     clamav/clamav:1.5.1@sha256:b32e587feae9f156d660704beeec4ee69c79fcf5af092bdc0f2f93892a29b553
//   CLAMD_TEST_PORT=3310 node --no-warnings --test tests/scanner-clamav.test.ts
//
// .github/workflows/scanner-clamav-certification.yml does the same with a service container.
//
// The limits asserted here are the ones scanner/docker-compose.yml sets on the daemon. If that file's limits change,
// these tests are where the change is noticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff } from "./support/app.ts";
import { handle } from "../src/app/app.ts";
import { storeUpload } from "../src/services/files.ts";
import { platform, sign } from "../scanner/src/platform.ts";
import { Scanner } from "../scanner/src/scanner.ts";
import { makeZip } from "../runner/test/fixtures/zip-writer.ts";

const PORT = process.env.CLAMD_TEST_PORT ? Number(process.env.CLAMD_TEST_PORT) : 0;
const SECRET = "scanner-clamav-secret-0123456789abcdef01";

// Assembled at run time so the repository never holds the EICAR string verbatim (tests/secret-scan.test.ts).
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");

async function world() {
  const t = await createTestApp({ FILE_SCANNER_SECRET: SECRET } as never);
  const cust = await createCustomer(t.db, "clamav-world@example.com");
  const staff = await createStaff(t.db, "administrator", "clamav-admin@crestmont.test");
  const fetchApp = (async (url: string, init?: RequestInit) => handle(new Request(url, init), t.env)) as unknown as typeof fetch;
  const api = platform({ url: "http://crestmont.test", secret: SECRET, timeoutMs: 30_000, fetch: fetchApp, retryDelaysMs: [0, 0] });
  return {
    t, cust, staff, api, fetchApp,
    /** Stores real bytes through the real upload path, so the scanner sees a genuine queued file. */
    up: (name: string, body: Uint8Array | string, type: string) => storeUpload({ db: t.db, storage: t.storage } as never, {
      organizationId: cust.organizationId, projectId: null,
      // Copied into a plain ArrayBuffer: a Buffer's is ArrayBufferLike, which File's part type does not accept.
      file: new File([typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body)], name, { type }),
      uploadedBy: staff.id,
    }),
    scanner: (maxBytes = 26_214_400) => new Scanner(
      { scannerId: "clamav-cert", batch: 20, maxBytes, clamd: { host: "127.0.0.1", port: PORT, timeoutMs: 180_000 } }, api),
    status: async (id: string) => (await t.db.prepare(`SELECT scan_status FROM files WHERE id = ?`).bind(id).first<{ scan_status: string }>())!.scan_status,
    scan: async (id: string) => await t.db.prepare(`SELECT verdict, signature, detail, engine FROM file_scans WHERE file_id = ?`).bind(id)
      .first<{ verdict: string; signature: string | null; detail: string | null; engine: string }>(),
  };
}

/** A ZIP holding one highly compressible file of `mb` megabytes: tiny on the wire, large when expanded. */
const bombZip = (mb: number) => makeZip([{ path: "payload.bin", body: Buffer.alloc(mb * 1024 * 1024, 0x41) }]);

test("[SEC-003] real ClamAV: the signature inside an archive is found, so an infected artifact cannot reach the builder", { skip: PORT ? false : "set CLAMD_TEST_PORT to a real clamd" }, async () => {
  const w = await world();
  try {
    // The shape that matters: a frontend artifact is a ZIP, so a signature hidden INSIDE one must be found. If ClamAV
    // scanned only the container bytes, every infected upload would pass as clean and the design-locked builder would
    // happily extract and build it.
    const plain = await w.up("eicar.txt", EICAR, "text/plain");
    const inZip = await w.up("artifact.zip", makeZip([{ path: "src/app.tsx", body: "export const App = () => null;\n" }, { path: "assets/readme.txt", body: EICAR }]), "application/zip");
    const nested = await w.up("nested.zip", makeZip([{ path: "inner.zip", body: makeZip([{ path: "deep/payload.txt", body: EICAR }]), method: 0 }]), "application/zip");

    const r = await w.scanner().cycle();
    assert.equal(r.error, null, "the daemon answered");

    for (const [name, f] of [["bare", plain], ["inside a ZIP", inZip], ["two archives deep", nested]] as const) {
      assert.equal(await w.status(f.id), "infected", `${name}: must be quarantined as infected`);
      const s = await w.scan(f.id);
      assert.equal(s!.verdict, "infected", name);
      assert.match(s!.signature ?? "", /eicar/i, `${name}: ClamAV named the signature it found`);
      assert.match(s!.engine, /^ClamAV \d/, `${name}: the real engine string is recorded, not ours`);
    }
  } finally { await w.t.close(); }
});

test("[SEC-003] real ClamAV: bytes it could not fully examine are failed and stay quarantined — never clean", { skip: PORT ? false : "set CLAMD_TEST_PORT to a real clamd" }, async () => {
  const w = await world();
  try {
    // 40 MB expanded, against the daemon's MaxFileSize of 30M with AlertExceedsMax=yes. The archive itself is ~40 KB,
    // so it passes the platform's 25 MiB upload limit easily: the danger is entirely in the expansion.
    const bomb = await w.up("bomb.zip", bombZip(40), "application/zip");
    // Password-protected: ClamAV cannot look inside, and AlertEncryptedArchive=yes makes it say so.
    const locked = await w.up("locked.zip", makeZip([{ path: "secret.txt", body: "not readable", encrypted: true }]), "application/zip");

    const r = await w.scanner().cycle();
    assert.equal(r.error, null);

    for (const [name, f] of [["a decompression bomb", bomb], ["an encrypted archive", locked]] as const) {
      const status = await w.status(f.id);
      const s = await w.scan(f.id);
      // The one thing that must never happen: bytes ClamAV did not fully examine being called clean.
      assert.notEqual(status, "clean", `${name}: unexaminable bytes must never be clean`);
      assert.equal(status, "failed", `${name}: expected quarantined-as-failed, got ${status} (${s?.signature ?? s?.detail ?? "no detail"})`);
      assert.equal(s!.verdict, "failed", name);
      // Recorded as unexamined, not as malware: an archive we cannot open is not evidence of infection.
      assert.match(s!.detail ?? "", /not fully examined|Heuristics\.(Limits|Encrypted)/i, `${name}: says why it could not be examined`);
    }

    // And `failed` is not terminal the way `infected` is: the file stays out of reach but may be scanned again.
    assert.notEqual(await w.status(bomb.id), "clean");
  } finally { await w.t.close(); }
});

test("[SEC-003] real ClamAV: a genuine frontend artifact is confirmed clean by the daemon, and only then", { skip: PORT ? false : "set CLAMD_TEST_PORT to a real clamd" }, async () => {
  const w = await world();
  try {
    // A real, representative frontend artifact: the shape the design-locked builder actually accepts.
    const artifact = makeZip([
      { path: "package.json", body: JSON.stringify({ name: "fixture-frontend", private: true, type: "module", dependencies: { react: "18.3.1" } }, null, 2) },
      { path: "index.html", body: "<!doctype html><html><head><title>Fixture</title></head><body><div id=\"root\"></div></body></html>" },
      { path: "src/main.tsx", body: "import { createRoot } from \"react-dom/client\";\ncreateRoot(document.getElementById(\"root\")!).render(null);\n" },
      { path: "src/styles.css", body: ":root { --ink: #11182a; }\nbody { color: var(--ink); font-family: system-ui; }\n" },
      { path: "public/logo.svg", body: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 8 8\"><rect width=\"8\" height=\"8\"/></svg>" },
    ]);
    const good = await w.up("frontend.zip", artifact, "application/zip");

    assert.equal(await w.status(good.id), "pending", "it starts quarantined, before any scan");
    const r = await w.scanner().cycle();
    assert.equal(r.error, null);
    assert.equal(r.clean, 1, "exactly one clean verdict");
    assert.equal(await w.status(good.id), "clean");

    const s = await w.scan(good.id);
    assert.equal(s!.verdict, "clean");
    assert.match(s!.engine, /^ClamAV \d/, "an operational, identified engine gave the verdict");
    assert.equal(s!.signature, null);
  } finally { await w.t.close(); }
});

test("[SEC-003] real ClamAV: a file over the scanner's own ceiling is failed without being streamed to the daemon", { skip: PORT ? false : "set CLAMD_TEST_PORT to a real clamd" }, async () => {
  const w = await world();
  try {
    const big = await w.up("big.zip", bombZip(2), "application/zip");
    // A ceiling below the file: the scanner must refuse it itself rather than hand the daemon something it configured
    // itself not to accept. Bounded memory is the point — the bytes are never even fetched.
    const r = await w.scanner(1024).cycle();
    assert.equal(r.error, null);
    assert.equal(r.failed, 1);
    assert.equal(await w.status(big.id), "failed");
    assert.match((await w.scan(big.id))!.detail ?? "", /larger than the scanner's limit/);
  } finally { await w.t.close(); }
});

test("[SEC-003] the scan endpoints refuse an expired signature and a replayed verdict, with real ClamAV behind them", { skip: PORT ? false : "set CLAMD_TEST_PORT to a real clamd" }, async () => {
  const w = await world();
  try {
    const f = await w.up("brief.txt", "A harmless brief.\n", "text/plain");
    const post = (path: string, body: string, header: string | null) =>
      w.fetchApp(`http://crestmont.test${path}`, { method: "POST", body, headers: header ? { "content-type": "application/json", "x-crestmont-scanner-signature": header } : { "content-type": "application/json" } });

    const body = JSON.stringify({ fileId: f.id });
    // Outside the ±600 s tolerance: an intercepted request cannot be replayed tomorrow.
    const old = sign(SECRET, body, Math.floor(Date.now() / 1000) - 4000);
    assert.equal((await post("/api/scan/file", body, old)).status, 401, "an expired signature is refused");
    const future = sign(SECRET, body, Math.floor(Date.now() / 1000) + 4000);
    assert.equal((await post("/api/scan/file", body, future)).status, 401, "a future-dated signature is refused");
    assert.equal((await post("/api/scan/file", body, null)).status, 401, "no signature is refused");
    assert.equal((await post("/api/scan/file", body, sign("the-wrong-secret-0123456789abcdef0123", body))).status, 401, "another secret is refused");
    assert.equal(await w.status(f.id), "pending", "none of that produced a verdict");

    // A real verdict from the real daemon.
    const r = await w.scanner().cycle();
    assert.equal(r.error, null);
    assert.equal(await w.status(f.id), "clean");

    // A captured request replayed VERBATIM is refused: the nonce has already been claimed. This is the replay that
    // matters, because forging a fresh one needs the secret.
    const dup = JSON.stringify({ limit: 5, _nonce: "a".repeat(32) });
    assert.equal((await post("/api/scan/queue", dup, sign(SECRET, dup))).status, 200, "the first delivery is served");
    assert.equal((await post("/api/scan/queue", dup, sign(SECRET, dup))).status, 409, "the same request delivered twice is refused");

    // The bytes are no longer available to the scanner credential once the file has been scanned.
    assert.equal((await post("/api/scan/file", body, sign(SECRET, body))).status, 409);

    // And the property that protects the builder: `infected` is terminal. Even an authentic, correctly signed `clean`
    // from the operational scanner cannot lift a quarantine, so a later re-scan can never release known malware.
    const bad = await w.up("eicar-terminal.txt", EICAR, "text/plain");
    assert.equal((await w.scanner().cycle()).error, null);
    assert.equal(await w.status(bad.id), "infected");
    const lift = JSON.stringify({ fileId: bad.id, verdict: "clean", engine: "ClamAV 1.5.1", scannedSha256: bad.sha256, scannedAt: new Date().toISOString() });
    const lifted = await post("/api/scan/result", lift, sign(SECRET, lift));
    assert.equal(lifted.status, 200, "the verdict is accepted and recorded");
    assert.equal((await lifted.json() as { current: string }).current, "infected", "but the file stays infected");
    assert.equal(await w.status(bad.id), "infected", "a clean verdict cannot release a quarantined file");
  } finally { await w.t.close(); }
});
