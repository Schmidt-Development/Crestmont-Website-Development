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
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  overrides: { storage },
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", env.APP_URL);
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

server.listen(port, () => console.log(`Crestmont development server: http://localhost:${port}  (db: ${dbPath})`));
