// Local development server: runs the Worker's fetch handler on Node with a file-backed SQLite DB,
// local private file storage and the dev email outbox. Environment is always "development".
// Usage: node --no-warnings dev/server.ts [--port 8787] [--db .dev/crestmont.db]
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, normalize } from "node:path";
import { openDb } from "./sqlite-d1.ts";
import { LocalDiskStorage } from "./local-storage.ts";
import { handle, staticContentType } from "../src/app/app.ts";
import type { Env } from "../src/app/context.ts";
import { syncRequirements } from "../src/readiness/ingest.ts";
import { applySeedBlockerLinks } from "../src/services/readiness-admin.ts";
import { acceptWebSocket } from "./ws-server.ts";
import { launchLocalBrowser } from "./local-browser.ts";
import { Cdp } from "../src/services/remote-browser/cdp.ts";
import { RemoteSession } from "../src/services/remote-browser/session.ts";
import { finish, heartbeat, remoteBrowserConfig } from "../src/services/remote-browser/admission.ts";
import { prepareConnection } from "../src/services/remote-browser/connect.ts";
import { LIVE_PATH } from "../src/routes/remote-browser.ts";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const port = Number(arg("--port", process.env.PORT ?? "8787"));
const dbPath = arg("--db", process.env.CRESTMONT_DB ?? ".dev/crestmont.db");
if (dbPath !== ":memory:") mkdirSync(resolve(dbPath, ".."), { recursive: true });

const db = openDb(dbPath);
await syncRequirements(db);
await applySeedBlockerLinks(db);
const storage = new LocalDiskStorage(process.env.CRESTMONT_FILES ?? ".dev/files");
const PUBLIC = resolve(import.meta.dirname, "../public");

const env: Env = {
  DB: db,
  ENVIRONMENT: "development",
  APP_URL: process.env.APP_URL ?? `http://localhost:${port}`,
  EVIDENCE_INGEST_SECRET: process.env.EVIDENCE_INGEST_SECRET,
  CRM_IMPORT_SECRET: process.env.CRM_IMPORT_SECRET,
  FILE_SCANNER_SECRET: process.env.FILE_SCANNER_SECRET,
  CRM_ERASURE_HMAC_KEY: process.env.CRM_ERASURE_HMAC_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  VOICE_WEBHOOK_SECRET: process.env.VOICE_WEBHOOK_SECRET,
  // Retell workspace keys for local rehearsal of the outbound staging E2E (scripts/outbound-staging-e2e.ts). Never dials.
  RETELL_INBOUND_API_KEY: process.env.RETELL_INBOUND_API_KEY,
  RETELL_OUTBOUND_API_KEY: process.env.RETELL_OUTBOUND_API_KEY,
  // Worker-signed staging E2E rehearsal (POST /api/sales-outbound/test-dispatch) and the Retell audit route.
  SCHEDULER_TRIGGER_SECRET: process.env.SCHEDULER_TRIGGER_SECRET,
  // Emergency re-lock rehearsal only: the gate runs when PREVIEW_GATE=required (never in production).
  PREVIEW_GATE: process.env.PREVIEW_GATE,
  STAGING_ACCESS_PASSWORD: process.env.STAGING_ACCESS_PASSWORD,
  PORTFOLIO_DEMO_ORIGINS: process.env.PORTFOLIO_DEMO_ORIGINS,
  // Optional: renders the Turnstile widget like staging (development accepts any token when no secret is set).
  TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY,
  // Signs build-preview capabilities, so a stored snapshot (e.g. the delivery E2E fixture) can be opened locally.
  BUILD_PREVIEW_FILE_SECRET: process.env.BUILD_PREVIEW_FILE_SECRET,
  // Portfolio remote browser (Mode B) locally: REMOTE_BROWSER=on plus REMOTE_BROWSER_CHROMIUM=<path to a Chromium>
  // starts one local headless Chromium per session in place of Cloudflare Browser Run (dev/local-browser.ts).
  REMOTE_BROWSER: process.env.REMOTE_BROWSER,
  REMOTE_BROWSER_MAX_CONCURRENT: process.env.REMOTE_BROWSER_MAX_CONCURRENT,
  REMOTE_BROWSER_DAILY_MINUTES: process.env.REMOTE_BROWSER_DAILY_MINUTES,
  REMOTE_BROWSER_MAX_SESSION_SECONDS: process.env.REMOTE_BROWSER_MAX_SESSION_SECONDS,
  REMOTE_BROWSER_IDLE_SECONDS: process.env.REMOTE_BROWSER_IDLE_SECONDS,
  REMOTE_BROWSER_RATE_PER_10MIN: process.env.REMOTE_BROWSER_RATE_PER_10MIN,
  REMOTE_BROWSER_LOCAL: process.env.REMOTE_BROWSER_CHROMIUM || undefined,
  overrides: { storage },
};

// REMOTE_BROWSER_FIXTURES=1 (CI only): the TEST DATA fixture sites in scripts/fixtures/remote/ answer both the live-site
// check and the remote browser locally; /__dev/remote-fixtures/* expose what the fixture pages reported.
type Fixtures = typeof import("../scripts/fixtures/remote/sites.mjs");
const fixtures: Fixtures | null = process.env.REMOTE_BROWSER_FIXTURES === "1" ? await import("../scripts/fixtures/remote/sites.mjs") : null;
const localBrowsers = new Set<() => void>();
if (fixtures) {
  const real = fetch;
  env.overrides!.portfolioFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const fx = fixtures.fixtureResponse(String(input instanceof Request ? input.url : input), new URL(env.APP_URL!).origin);
    if (!fx) return real(input, init);
    if ("error" in fx) throw new TypeError("fetch failed (fixture: the site does not answer)");
    return new Response(fx.status === 204 ? null : fx.body, { status: fx.status, headers: fx.headers });
  }) as typeof fetch;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", env.APP_URL);
    if (fixtures && url.pathname.startsWith("/__dev/remote-fixtures/")) {
      const what = url.pathname.slice("/__dev/remote-fixtures/".length);
      if (what === "state") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(fixtures.fixtureState(url.searchParams.get("name") ?? ""))); return; }
      if (what === "reset" && req.method === "POST") { fixtures.resetFixtureState(); res.writeHead(204).end(); return; }
      // Failure injection: every local remote browser dies at once (a crashed Browser Run instance).
      if (what === "kill-browsers" && req.method === "POST") { const n = localBrowsers.size; for (const k of [...localBrowsers]) k(); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ killed: n })); return; }
      if (what === "browsers") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ running: localBrowsers.size })); return; }
    }
    if (url.pathname.startsWith("/assets/")) {
      const p = normalize(join(PUBLIC, decodeURIComponent(url.pathname)));
      if (!p.startsWith(PUBLIC) || !existsSync(p)) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "content-type": staticContentType(p), "cache-control": "no-cache", "x-content-type-options": "nosniff" }).end(readFileSync(p));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v); else if (Array.isArray(v)) headers.set(k, v.join(", "));
    headers.set("x-forwarded-for", req.socket.remoteAddress ?? "127.0.0.1");
    const request = new Request(url, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
    const response = await handle(request, env);
    const out: Record<string, string | string[]> = {};
    response.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(response.status, out);
    res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (e) {
    console.error(e);
    res.writeHead(500).end("Server error");
  }
});

// The remote-browser WebSocket: the same token check as production (src/routes/remote-browser.ts liveSocket), then a
// local Chromium instead of a Durable Object + Browser Run.
server.on("upgrade", async (req, socket) => {
  const url = new URL(req.url ?? "/", env.APP_URL);
  const m = LIVE_PATH.exec(url.pathname);
  const cfg = remoteBrowserConfig(env);
  const deny = (code: number) => { socket.end(`HTTP/1.1 ${code} ${code === 403 ? "Forbidden" : "Unavailable"}\r\nConnection: close\r\n\r\n`); };
  if (!m || !cfg.enabled || !env.REMOTE_BROWSER_LOCAL) return deny(503);
  if (req.headers.origin !== new URL(env.APP_URL!).origin) return deny(403);
  const info = await prepareConnection(db, m[1]!, url.searchParams.get("token") ?? "", url.searchParams, Date.now(), cfg).catch(() => null);
  if (!info) return deny(403);
  const visitor = acceptWebSocket(req, socket);
  if (!visitor) return;
  let close = () => undefined as void;
  try {
    const b = await launchLocalBrowser(String(env.REMOTE_BROWSER_LOCAL));
    close = b.close;
    localBrowsers.add(close);
    const cdp = new Cdp(b.ws);
    const session = new RemoteSession(cdp, visitor, {
      ...info,
      fixture: fixtures ? (u) => { const fx = fixtures.fixtureResponse(u, new URL(env.APP_URL!).origin); if (fx && "record" in fx) fx.record?.(); return fx && !("error" in fx) ? fx : null; } : undefined,
      heartbeat: () => heartbeat(db, info.id, Date.now()),
      closeBrowser: () => { localBrowsers.delete(close); close(); },
      onEnd: (reason) => finish(db, info.id, Date.now(), reason),
    });
    await session.start();
  } catch (e) {
    localBrowsers.delete(close); close();
    try { visitor.send(JSON.stringify({ t: "error", message: "The remote browser is not available right now." })); visitor.close(1011, "unavailable"); } catch { /* gone */ }
    await finish(db, info.id, Date.now(), `error: ${(e as Error).message}`.slice(0, 60)).catch(() => undefined);
  }
});

server.listen(port, () => console.log(`Crestmont development server: http://localhost:${port}  (db: ${dbPath})`));
