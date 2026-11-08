// The standalone file scanner (scanner/) against the real request pipeline and migrations: queue → bytes →
// SHA-256 check → clamd → signed verdict → quarantine on the platform, plus heartbeat and health.
//
// clamd is a stand-in speaking the real z-protocol over TCP (detects the EICAR test string like ClamAV does), unless
// CLAMD_TEST_PORT names a real clamd on 127.0.0.1 — then the same lifecycle runs against real ClamAV.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { createTestApp, createCustomer, createStaff } from "./support/app.ts";
import { handle } from "../src/app/app.ts";
import { storeUpload } from "../src/services/files.ts";
import { malwareScanFeed } from "../src/services/readiness-admin.ts";
import { scanHealth } from "../src/services/malware-scan.ts";
import { sha256Hex } from "../src/lib/crypto.ts";
import { platform, sign } from "../scanner/src/platform.ts";
import { Scanner } from "../scanner/src/scanner.ts";
import { parseStreamReply, parseVersion } from "../scanner/src/clamd.ts";
import { settings } from "../scanner/src/main.ts";

const SECRET = "scanner-test-secret-0123456789abcdef0123";
// Assembled at run time so the repository never holds the EICAR string verbatim.
export const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");
const VERSION = "ClamAV 1.5.1/27812/Wed Nov  5 08:26:19 2026"; // a fixed sample, for the parser and for heartbeats sent directly
/** clamd's VERSION reply for signatures published at `at` (its ctime-style date, printed in UTC as the container runs). */
function clamdVersion(at: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (n: number) => String(n).padStart(2, "0");
  return `ClamAV 1.5.1/27812/${days[at.getUTCDay()]} ${months[at.getUTCMonth()]} ${String(at.getUTCDate()).padStart(2, " ")} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} ${at.getUTCFullYear()}`;
}
// The stand-in daemon reports signatures published an hour ago. A fixed date here made the lifecycle test fail by
// itself 72 hours after that date (the platform rightly calls older signatures stale), i.e. a time bomb in the test.
const LIVE_VERSION = clamdVersion(new Date(Date.now() - 3_600_000));

/** A stand-in clamd: PING, VERSION, INSTREAM. `mode` changes its behaviour per test. */
async function fakeClamd(mode: { down?: boolean; reply?: (bytes: Buffer) => string } = {}) {
  const server: Server = createServer((sock) => {
    let buf = Buffer.alloc(0), cmd: string | null = null;
    const chunks: Buffer[] = [];
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (cmd === null) {
        const nul = buf.indexOf(0); if (nul < 0) return;
        cmd = buf.subarray(1, nul).toString(); buf = buf.subarray(nul + 1);
        if (cmd === "PING") return void sock.end("PONG\0");
        if (cmd === "VERSION") return void sock.end(`${LIVE_VERSION}\0`);
      }
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (n === 0) {
          const all = Buffer.concat(chunks);
          return void sock.end(`stream: ${mode.reply ? mode.reply(all) : all.toString("latin1").startsWith(EICAR) ? "Win.Test.EICAR_HDB-1 FOUND" : "OK"}\0`);
        }
        if (buf.length < 4 + n) return;
        chunks.push(buf.subarray(4, 4 + n)); buf = buf.subarray(4 + n);
      }
    });
  });
  if (mode.down) return { port: 1, close: async () => {} };
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function world(clamdPort?: number) {
  const t = await createTestApp({ FILE_SCANNER_SECRET: SECRET } as never);
  const cust = await createCustomer(t.db, "scanner-world@example.com");
  const staff = await createStaff(t.db, "administrator", "scanner-admin@crestmont.test");
  const up = (name: string, body: string, type: string) => storeUpload({ db: t.db, storage: t.storage } as never,
    { organizationId: cust.organizationId, projectId: null, file: new File([new TextEncoder().encode(body)], name, { type }), uploadedBy: staff.id });
  const fetchApp = (async (url: string, init?: RequestInit) => handle(new Request(url, init), t.env)) as unknown as typeof fetch;
  const api = platform({ url: "http://crestmont.test", secret: SECRET, timeoutMs: 10_000, fetch: fetchApp, retryDelaysMs: [0, 0] });
  const scanner = (port: number) => new Scanner({ scannerId: "test-clamav", batch: 10, maxBytes: 26_214_400, clamd: { host: "127.0.0.1", port, timeoutMs: 5_000 } }, api);
  return { t, cust, staff, up, api, scanner, clamdPort, fetchApp };
}

const statusOf = async (t: Awaited<ReturnType<typeof createTestApp>>, id: string) =>
  (await t.db.prepare(`SELECT scan_status FROM files WHERE id = ?`).bind(id).first<{ scan_status: string }>())!.scan_status;

test("[SEC-003] scanner lifecycle: a harmless file is clean, the EICAR test file is quarantined and its share link revoked", async () => {
  const real = process.env.CLAMD_TEST_PORT ? Number(process.env.CLAMD_TEST_PORT) : null;
  const clamd = real ? { port: real, close: async () => {} } : await fakeClamd();
  const w = await world();
  try {
    const harmless = await w.up("brief.txt", "A harmless project brief.\n", "text/plain");
    const pdf = await w.up("scope.pdf", "%PDF-1.4\n% harmless\n", "application/pdf");
    const eicar = await w.up("eicar.txt", EICAR, "text/plain");
    // A share link made before the scan (unscanned acknowledged), exactly as staff can today.
    const token = "ab".repeat(32);
    await w.t.db.prepare(`INSERT INTO share_links (id, token_hash, file_id, organization_id, created_by, created_at, expires_at, unscanned_acknowledged) VALUES ('shr_eicar', ?, ?, ?, ?, ?, '2099-01-01T00:00:00Z', 1)`)
      .bind(await sha256Hex(token), eicar.id, w.cust.organizationId, w.staff.id, new Date().toISOString()).run();
    assert.equal((await w.t.client().get(`/share/${token}`)).status, 200, "the link works before the verdict");
    const s = w.scanner(clamd.port);
    await s.heartbeat();
    const r = await s.cycle();
    assert.equal(r.error, null);
    assert.deepEqual([r.clean, r.infected, r.failed], [2, 1, 0]);
    assert.equal(await statusOf(w.t, harmless.id), "clean");
    assert.equal(await statusOf(w.t, pdf.id), "clean");
    assert.equal(await statusOf(w.t, eicar.id), "infected");
    const scan = await w.t.db.prepare(`SELECT verdict, signature, engine, scanned_sha256 FROM file_scans WHERE file_id = ?`).bind(eicar.id).first<{ verdict: string; signature: string; engine: string; scanned_sha256: string }>();
    assert.equal(scan!.verdict, "infected");
    assert.match(scan!.signature, /eicar/i);
    assert.equal(scan!.scanned_sha256, eicar.sha256);
    const share = await w.t.db.prepare(`SELECT revoked_at FROM share_links WHERE file_id = ?`).bind(eicar.id).first<{ revoked_at: string | null }>();
    assert.ok(share!.revoked_at, "the infected file's share link is revoked");
    const outsider = await w.t.client().get(`/share/${token}`);
    assert.ok(outsider.status >= 400 || !/Download file/.test(await outsider.text()), "an outsider can no longer download it");
    // Infected is terminal and the queue is empty: a second pass reports nothing and lifts nothing.
    assert.equal((await s.cycle()).scanned, 0);
    assert.equal(await statusOf(w.t, eicar.id), "infected");
    // The bytes of a scanned file are no longer served to the scanner credential.
    const again = await w.fetchApp("http://crestmont.test/api/scan/file", { method: "POST", body: JSON.stringify({ fileId: eicar.id }), headers: { "x-crestmont-scanner-signature": sign(SECRET, JSON.stringify({ fileId: eicar.id })) } });
    assert.equal(again.status, 409);
    // Heartbeat → the platform's feed. With the stand-in's dated signatures it is healthy; real clamd with a local-only
    // signature file prints no date, and the feed says so rather than calling it current.
    await s.heartbeat();
    const feed = await malwareScanFeed({ db: w.t.db, now: () => new Date() });
    if (real) assert.ok(["healthy", "stale"].includes(feed.status), feed.detail);
    else assert.equal(feed.status, "healthy", feed.detail);
    assert.equal((await scanHealth(w.t.db)).heartbeat?.scannerId, "test-clamav");
  } finally { await clamd.close(); await w.t.close(); }
});

test("[SEC-003] scanner: an unexaminable file is failed (quarantined), never clean; a clamd error is failed too", async () => {
  const clamd = await fakeClamd({ reply: (b) => b.toString().includes("zip-bomb") ? "Heuristics.Limits.Exceeded.MaxFileSize FOUND" : b.toString().includes("broken") ? "Can't parse ERROR" : "OK" });
  const w = await world();
  try {
    const big = await w.up("bomb.txt", "zip-bomb stand-in", "text/plain");
    const broken = await w.up("broken.txt", "broken stand-in", "text/plain");
    const r = await w.scanner(clamd.port).cycle();
    assert.deepEqual([r.clean, r.infected, r.failed], [0, 0, 2]);
    assert.equal(await statusOf(w.t, big.id), "failed");
    assert.equal(await statusOf(w.t, broken.id), "failed");
    const d = await w.t.db.prepare(`SELECT detail FROM file_scans WHERE file_id = ?`).bind(big.id).first<{ detail: string }>();
    assert.match(d!.detail, /not fully examined/);
  } finally { await clamd.close(); await w.t.close(); }
});

test("[SEC-003] scanner: clamd down → no verdict, the heartbeat says the daemon is down and the feed is failing", async () => {
  const w = await world();
  try {
    const f = await w.up("waiting.txt", "waits for a scanner", "text/plain");
    const s = w.scanner(1); // nothing listens on port 1
    const r = await s.cycle();
    assert.ok(r.error && /unreachable|did not answer/.test(r.error), r.error ?? "");
    assert.equal(await statusOf(w.t, f.id), "pending", "not the file's fault: it waits, still quarantined from share links");
    await s.heartbeat();
    const feed = await malwareScanFeed({ db: w.t.db, now: () => new Date() });
    assert.equal(feed.status, "failing");
    assert.match(feed.detail, /ClamAV daemon is not answering/);
    assert.equal(s.health(60_000).ok, false);
  } finally { await w.t.close(); }
});

test("[SEC-003] scanner: platform 5xx is retried with a fresh nonce; 4xx is not retried; bytes with the wrong hash get no verdict", async () => {
  const clamd = await fakeClamd();
  const w = await world();
  try {
    const f = await w.up("retry.txt", "retried", "text/plain");
    let calls = 0, failNext = 2;
    const flaky = (async (url: string, init?: RequestInit) => {
      calls++;
      if (String(url).endsWith("/api/scan/queue") && failNext-- > 0) return new Response("upstream", { status: 503 });
      return w.fetchApp(url, init);
    }) as unknown as typeof fetch;
    const api = platform({ url: "http://crestmont.test", secret: SECRET, timeoutMs: 5_000, fetch: flaky, retryDelaysMs: [0, 0] });
    const s = new Scanner({ scannerId: "retry", batch: 5, maxBytes: 1e6, clamd: { host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000 } }, api);
    assert.equal((await s.cycle()).clean, 1);
    assert.equal(await statusOf(w.t, f.id), "clean");
    // A wrong secret is a 401 and is not retried.
    let n = 0;
    const counting = (async (url: string, init?: RequestInit) => { n++; return w.fetchApp(url, init); }) as unknown as typeof fetch;
    const bad = platform({ url: "http://crestmont.test", secret: "x".repeat(40), timeoutMs: 5_000, fetch: counting, retryDelaysMs: [0, 0] });
    await assert.rejects(bad.queue(5), (e: Error & { status?: number }) => e.status === 401);
    assert.equal(n, 1);
    // Corrupted bytes in transit: no verdict, the file stays pending.
    const g = await w.up("tampered.txt", "original bytes", "text/plain");
    const tamper = (async (url: string, init?: RequestInit) => {
      const res = await w.fetchApp(url, init);
      if (!String(url).endsWith("/api/scan/file")) return res;
      const j = await res.json() as { base64: string };
      return new Response(JSON.stringify({ ...j, base64: Buffer.from("other bytes").toString("base64") }), { status: 200 });
    }) as unknown as typeof fetch;
    const s2 = new Scanner({ scannerId: "tamper", batch: 5, maxBytes: 1e6, clamd: { host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000 } },
      platform({ url: "http://crestmont.test", secret: SECRET, timeoutMs: 5_000, fetch: tamper, retryDelaysMs: [] }));
    const r2 = await s2.cycle();
    assert.equal(r2.scanned, 0);
    assert.equal(await statusOf(w.t, g.id), "pending");
    assert.ok(calls > 0);
  } finally { await clamd.close(); await w.t.close(); }
});

test("[SEC-003] scanner: a file that keeps failing backs off and does not starve the files behind it", async () => {
  let fail = true;
  const clamd = await fakeClamd({ reply: (b) => (b.toString().includes("first") && fail ? "Can't parse ERROR" : "OK") });
  const w = await world();
  try {
    const first = await w.up("first.txt", "first file", "text/plain");
    const s = new Scanner({ scannerId: "backoff", batch: 1, maxBytes: 1e6, clamd: { host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000 } }, w.api);
    assert.equal((await s.cycle()).failed, 1);
    const second = await w.up("second.txt", "second file", "text/plain");
    const r = await s.cycle();     // batch of 1: the failed first file is in backoff, so the second gets the slot
    assert.equal(r.clean, 1);
    assert.equal(await statusOf(w.t, second.id), "clean");
    assert.equal(await statusOf(w.t, first.id), "failed");
    fail = false;
  } finally { await clamd.close(); await w.t.close(); }
});

test("[SEC-003] scanner parsing and configuration", () => {
  assert.deepEqual(parseStreamReply("stream: OK"), { kind: "clean" });
  assert.deepEqual(parseStreamReply("stream: Win.Test.EICAR_HDB-1 FOUND"), { kind: "found", signature: "Win.Test.EICAR_HDB-1" });
  assert.deepEqual(parseStreamReply("INSTREAM size limit exceeded. ERROR"), { kind: "error", message: "INSTREAM size limit exceeded." });
  assert.equal(parseVersion(VERSION).signaturesAt, "2026-11-05T08:26:19.000Z");
  assert.equal(parseVersion(clamdVersion(new Date("2026-03-01T09:05:07Z"))).signaturesAt, "2026-03-01T09:05:07.000Z", "the stand-in's format is what clamd prints");
  assert.equal(parseVersion("ClamAV 1.5.4").signaturesAt, null);
  assert.throws(() => settings({ PLATFORM_URL: "http://example.com", FILE_SCANNER_SECRET: SECRET }), /https origin/);
  assert.throws(() => settings({ PLATFORM_URL: "https://example.com", FILE_SCANNER_SECRET: "short" }), /at least 32/);
  assert.throws(() => settings({ PLATFORM_URL: "https://example.com/path", FILE_SCANNER_SECRET: SECRET }), /https origin/);
  const s = settings({ PLATFORM_URL: "https://staging.example.com", FILE_SCANNER_SECRET: SECRET });
  assert.deepEqual([s.clamd.host, s.clamd.port, s.batch, s.maxBytes], ["clamd", 3310, 10, 26_214_400]);
});

test("[SEC-003] heartbeat: signatures older than 72 h and a silent scanner are reported, not called healthy", async () => {
  const w = await world();
  try {
    await w.api.heartbeat({ scannerId: "old-sigs", engine: "ClamAV 1.5.1/27000/Mon Oct  1 00:00:00 2026", signaturesAt: "2026-10-01T00:00:00Z", daemonOk: true, detail: null, scannedTotal: 0, failedTotal: 0 });
    let feed = await malwareScanFeed({ db: w.t.db, now: () => new Date() });
    assert.equal(feed.status, "stale"); assert.match(feed.detail, /freshclam/);
    feed = await malwareScanFeed({ db: w.t.db, now: () => new Date(Date.now() + 2 * 3_600_000) });
    assert.equal(feed.status, "stale"); assert.match(feed.detail, /has not reported since/);
    await assert.rejects(w.api.heartbeat({ scannerId: "Bad Id", engine: null, signaturesAt: null, daemonOk: true, detail: null, scannedTotal: 0, failedTotal: 0 }), /scannerId/);
    await assert.rejects(w.api.heartbeat({ scannerId: "future", engine: null, signaturesAt: "2099-01-01T00:00:00Z", daemonOk: true, detail: null, scannedTotal: 0, failedTotal: 0 }), /future/);
  } finally { await w.t.close(); }
});

test("[SEC-003] the portal says scanning is automatic only while a scanner is reporting", async () => {
  const w = await world();
  try {
    const { scannerActive } = await import("../src/services/malware-scan.ts");
    assert.equal(await scannerActive(w.t.db), false);
    await w.api.heartbeat({ scannerId: "portal-copy", engine: VERSION, signaturesAt: "2026-11-05T08:26:19Z", daemonOk: true, detail: null, scannedTotal: 0, failedTotal: 0 });
    assert.equal(await scannerActive(w.t.db), true);
    assert.equal(await scannerActive(w.t.db, new Date(Date.now() + 3_600_000)), false, "silent for an hour: back to 'not configured'");
    await w.api.heartbeat({ scannerId: "portal-copy", engine: VERSION, signaturesAt: "2026-11-05T08:26:19Z", daemonOk: false, detail: "down", scannedTotal: 0, failedTotal: 0 });
    assert.equal(await scannerActive(w.t.db), false, "a scanner whose daemon is down is not scanning");
  } finally { await w.t.close(); }
});
