// Crestmont file scanner (SEC-003, F-02): a standalone process for Node 1, next to its own ClamAV daemon.
//
// It holds exactly one platform credential, FILE_SCANNER_SECRET, which can list files awaiting a scan, read the
// bytes of those files only, report verdicts and send heartbeats. It cannot claim builds, read other files, or do
// anything the AI Builder, Research Agent, Retell agents or Self-Improvement Engine do, and it shares no code,
// container, network, volume or secret with them (tests/scanner-isolation.test.ts).
//
//   node --no-warnings src/main.ts              run continuously
//   node --no-warnings src/main.ts --once       one heartbeat and queue passes until it is empty; exit 0, or 1 on error
//   node --no-warnings src/main.ts --preflight  configuration, clamd and the platform credential; scans nothing
//
// Environment: PLATFORM_URL (https origin), FILE_SCANNER_SECRET, SCANNER_ID (default node1-clamav), CLAMD_HOST
// (clamd), CLAMD_PORT (3310), POLL_SECONDS (60), HEARTBEAT_SECONDS (300), BATCH (10), MAX_BYTES (26214400),
// REQUEST_TIMEOUT_MS (60000), CLAMD_TIMEOUT_MS (120000), HEALTH_PORT (8790; 0 = off; listens on 127.0.0.1 only).
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { platform } from "./platform.ts";
import { Scanner, type ScannerConfig } from "./scanner.ts";

export interface Settings extends ScannerConfig { url: string; secret: string; pollMs: number; heartbeatMs: number; requestTimeoutMs: number; healthPort: number }

export function settings(env: Record<string, string | undefined>): Settings {
  const n = (k: string, d: number, min: number, max: number) => {
    const v = env[k] === undefined || env[k] === "" ? d : Number(env[k]);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${k} must be an integer from ${min} to ${max}`);
    return v;
  };
  const url = (env.PLATFORM_URL ?? "").replace(/\/$/, "");
  // https only, except a loopback address for local tests.
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("PLATFORM_URL must be an https origin without a path");
  const secret = env.FILE_SCANNER_SECRET ?? "";
  if (secret.length < 32) throw new Error("FILE_SCANNER_SECRET must be set (at least 32 characters)");
  const scannerId = env.SCANNER_ID || "node1-clamav";
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(scannerId)) throw new Error("SCANNER_ID must be 1-40 characters of a-z, 0-9 and '-'");
  return {
    url, secret, scannerId, batch: n("BATCH", 10, 1, 100), maxBytes: n("MAX_BYTES", 26_214_400, 1, 100 * 1024 * 1024),
    pollMs: n("POLL_SECONDS", 60, 5, 3600) * 1000, heartbeatMs: n("HEARTBEAT_SECONDS", 300, 30, 1500) * 1000,
    requestTimeoutMs: n("REQUEST_TIMEOUT_MS", 60_000, 1000, 600_000), healthPort: n("HEALTH_PORT", 8790, 0, 65535),
    clamd: { host: env.CLAMD_HOST || "clamd", port: n("CLAMD_PORT", 3310, 1, 65535), timeoutMs: n("CLAMD_TIMEOUT_MS", 120_000, 1000, 600_000) },
  };
}

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  let s: Settings;
  try { s = settings(env); } catch (e) { console.error(`configuration: ${(e as Error).message}`); return 2; }
  const api = platform({ url: s.url, secret: s.secret, timeoutMs: s.requestTimeoutMs });
  const scanner = new Scanner(s, api);

  if (argv.includes("--preflight")) {
    await scanner.heartbeat();
    const h = scanner.health(Infinity);
    log(`preflight: clamd ${h.daemonOk ? `ok (${h.engine}; signatures ${h.signaturesAt ?? "date unreadable"})` : "NOT answering"}; platform ${scanner.lastError?.startsWith("heartbeat:") ? `refused: ${scanner.lastError}` : "accepted the signed heartbeat"}`);
    return h.daemonOk && !scanner.lastError?.startsWith("heartbeat:") ? 0 : 1;
  }

  if (argv.includes("--once")) {
    await scanner.heartbeat();
    let total = 0;
    for (let pass = 0; pass < 100; pass++) {
      const r = await scanner.cycle();
      log(`cycle: ${r.scanned} scanned (${r.clean} clean, ${r.infected} infected, ${r.failed} failed), ${r.deferred} deferred${r.error ? `; error: ${r.error}` : ""}`);
      if (r.error) { await scanner.heartbeat(); return 1; }
      total += r.scanned;
      if (r.scanned === 0) break;
    }
    await scanner.heartbeat();
    log(`done: ${total} verdicts reported`);
    return 0;
  }

  let stopping = false;
  const server = s.healthPort ? createServer((req, res) => {
    const h = scanner.health(Math.max(3 * s.pollMs, 5 * 60_000));
    res.writeHead(req.url === "/healthz" ? (h.ok ? 200 : 503) : 404, { "content-type": "application/json" });
    res.end(req.url === "/healthz" ? JSON.stringify(h) : "{}");
  }).listen(s.healthPort, "127.0.0.1") : null;
  const stop = () => { stopping = true; server?.close(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);

  log(`scanner ${s.scannerId} → ${s.url}, clamd ${s.clamd.host}:${s.clamd.port}, poll ${s.pollMs / 1000}s`);
  let nextBeat = 0;
  while (!stopping) {
    if (Date.now() >= nextBeat) { await scanner.heartbeat(); nextBeat = Date.now() + s.heartbeatMs; }
    const r = await scanner.cycle();
    if (r.scanned || r.error) log(`cycle: ${r.scanned} scanned (${r.clean} clean, ${r.infected} infected, ${r.failed} failed), ${r.deferred} deferred${r.error ? `; error: ${r.error}` : ""}`);
    // A full batch means more work is waiting: go again at once. Otherwise wait for the poll interval.
    const wait = !r.error && r.scanned >= s.batch ? 0 : s.pollMs;
    for (let t = 0; t < wait && !stopping; t += 1000) await new Promise((res) => setTimeout(res, 1000));
  }
  log("stopped");
  return 0;
}

// Real paths on both sides: started through a symlink (an install copy, a mounted folder), a plain comparison is
// false and the process would exit 0 having done nothing at all.
const entry = (() => { try { return realpathSync(process.argv[1] ?? ""); } catch { return ""; } })();
if (entry === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2), process.env);
