// Summit Haul Co. — the built site and its API on one origin, the way a real host serves them.
//
//   node server/serve.mjs [--root dist] [--db .data/summit.db] [--port 0] [--fail-inserts]
//
// `--fail-inserts` makes every insert throw. It exists so the error path can be DEMONSTRATED rather than
// asserted: the browser must show the failure message, and the form must not say thank you.

import { createServer } from "node:http";
import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { handleApi, openDb } from "./api.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const root = path.resolve(arg("--root", "dist"));
const dbFile = arg("--db", ".data/summit.db");
const port = Number(arg("--port", "0"));
const failInserts = argv.includes("--fail-inserts");

if (dbFile !== ":memory:") mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true });
const real = openDb(dbFile);

// A database that refuses to write, for exercising the failure path end to end.
const db = failInserts
  ? { prepare: () => ({ run: () => { throw new Error("disk I/O error (simulated)"); } }) }
  : real;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json",
};

const server = createServer(async (req, res) => {
  try {
    if (await handleApi(req, res, db)) return;

    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(root, "." + rel);
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(403); res.end("forbidden"); return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch (err) {
    console.error(`request failed: ${String(err && err.stack).slice(0, 400)}`);
    if (!res.headersSent) { res.writeHead(500, { "content-type": "text/plain" }); res.end("server error"); }
  }
});

server.listen(port, "127.0.0.1", () => {
  const p = server.address().port;
  console.log(`summit-haul serving ${root} on http://127.0.0.1:${p} (db ${dbFile}${failInserts ? ", INSERTS FAILING" : ""})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); process.exit(0); });
