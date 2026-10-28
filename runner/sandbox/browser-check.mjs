#!/usr/bin/env node
// Browser validation of a static site, run by the build runner INSIDE the per-job sandbox container (network none).
//   node /opt/crestmont/browser-check.mjs --root public [--out .crestmont/screenshots] [--json]
// Serves --root on 127.0.0.1 (loopback works without a network), opens every .html page in headless Chromium at a
// desktop (1366x900) and a mobile (390x844) viewport and fails (exit 1) on:
//   - uncaught page errors and console errors,
//   - same-origin requests that fail or answer >= 400 (missing CSS/JS/images),
//   - horizontal overflow (page wider than the viewport),
//   - a page whose first Tab does not move focus (keyboard access).
// Off-origin requests cannot succeed without a network; they are reported as warnings.
// Screenshots: <out>/<page>-<viewport>.png. Requires the `playwright` package and its Chromium (sandbox image).

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

function args(argv) {
  const o = { root: "public", out: ".crestmont/screenshots", json: false, timeoutMs: 20000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") o.root = argv[++i];
    else if (argv[i] === "--out") o.out = argv[++i];
    else if (argv[i] === "--json") o.json = true;
    else if (argv[i] === "--timeout-ms") o.timeoutMs = Number(argv[++i]) || o.timeoutMs;
  }
  return o;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain", ".xml": "application/xml" };

function pages(root, dir = root, depth = 0) {
  const out = [];
  for (const e of readdirSync(dir).sort()) {
    const p = path.join(dir, e);
    const st = statSync(p);
    if (st.isDirectory() && depth < 3 && e !== "node_modules" && !e.startsWith(".")) out.push(...pages(root, p, depth + 1));
    else if (st.isFile() && e.endsWith(".html")) out.push(path.relative(root, p).split(path.sep).join("/"));
  }
  return out;
}

function serve(root) {
  const base = path.resolve(root);
  const server = createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(base, "." + rel);
    if (!file.startsWith(base + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      // Mirror the Worker's static assets: unknown paths get 404.html with status 404.
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      const nf = path.join(base, "404.html");
      res.end(existsSync(nf) ? readFileSync(nf) : "not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const o = args(process.argv.slice(2));
  if (!existsSync(o.root)) { console.error(`browser-check: ${o.root} does not exist`); process.exit(2); }
  const require = createRequire(path.join(process.cwd(), "noop.js"));
  let chromium;
  try { ({ chromium } = require("playwright")); } catch {
    try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch { console.error("browser-check: the playwright package is not available (build image problem)"); process.exit(2); }
  }
  const list = pages(o.root);
  if (!list.length) { console.error(`browser-check: no .html pages under ${o.root}`); process.exit(1); }
  mkdirSync(o.out, { recursive: true });
  const server = await serve(o.root);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
  const viewports = [{ name: "desktop", width: 1366, height: 900 }, { name: "mobile", width: 390, height: 844 }];
  const results = [];
  try {
    for (const vp of viewports) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      for (const page of list) {
        const p = await context.newPage();
        const errors = [];
        const warnings = [];
        p.on("pageerror", (e) => errors.push(`page error: ${String(e.message).slice(0, 300)}`));
        p.on("console", (m) => { if (m.type() === "error" && !/net::ERR_/.test(m.text())) errors.push(`console error: ${m.text().slice(0, 300)}`); });
        p.on("requestfailed", (r) => {
          const msg = `${r.url().slice(0, 200)} (${r.failure()?.errorText ?? "failed"})`;
          if (r.url().startsWith(origin)) errors.push(`request failed: ${msg}`); else warnings.push(`off-origin request not available offline: ${msg}`);
        });
        p.on("response", (r) => {
          if (r.url().startsWith(origin) && r.status() >= 400 && !(page === "404.html" && r.url() === `${origin}/404.html`)) errors.push(`HTTP ${r.status()}: ${r.url().replace(origin, "")}`);
        });
        try {
          await p.goto(`${origin}/${page}`, { waitUntil: "load", timeout: o.timeoutMs });
          const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 1) errors.push(`horizontal overflow: page is ${overflow}px wider than the ${vp.name} viewport`);
          await p.keyboard.press("Tab");
          const focused = await p.evaluate(() => document.activeElement && document.activeElement !== document.body ? document.activeElement.tagName : null);
          if (!focused) errors.push("keyboard: the first Tab did not focus anything");
          const shot = path.join(o.out, `${page.replace(/[\\/]/g, "_").replace(/\.html$/, "")}-${vp.name}.png`);
          await p.screenshot({ path: shot, fullPage: true });
          results.push({ page, viewport: vp.name, ok: errors.length === 0, errors, warnings, screenshot: shot });
        } catch (e) {
          results.push({ page, viewport: vp.name, ok: false, errors: [...errors, `load failed: ${String(e.message).slice(0, 300)}`], warnings, screenshot: null });
        }
        await p.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  if (o.json) console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  else {
    for (const r of results) {
      console.log(`${r.ok ? "PASS" : "FAIL"} ${r.page} @ ${r.viewport}${r.screenshot ? ` -> ${r.screenshot}` : ""}`);
      for (const e of r.errors) console.log(`  ERROR ${e}`);
      for (const w of r.warnings.slice(0, 5)) console.log(`  WARN  ${w}`);
    }
    console.log(`browser-check: ${results.length - failed.length}/${results.length} page views passed (${list.length} pages x ${viewports.length} viewports)`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(`browser-check: ${e?.stack ?? e}`); process.exit(2); });
