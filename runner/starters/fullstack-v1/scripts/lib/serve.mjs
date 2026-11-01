// Protected helper for the performance gate: serves the website's Worker (with a local D1) over HTTP on a random
// local port and prints {"port":N}. It runs in a separate process so the website's code never executes inside the
// gate process that judges it; the gate measures latency from outside.
import http from "node:http";
import { app } from "./harness.mjs";

const t = await app();
const server = http.createServer(async (req, res) => {
  try {
    const r = await t.call(req.method ?? "GET", req.url ?? "/");
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "text/plain" });
    res.end(r.text);
  } catch (e) { res.writeHead(500); res.end(String(e?.message ?? e).slice(0, 200)); }
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n"));
