#!/usr/bin/env node
// Did Model B's integration actually work?
//
//   node ci/verify-model-b.mjs --start "node server.js" --port 3100
//
// Model B reported its work as "fully implemented and verified". Nothing had run at that point, so this script
// runs it: a real server process, a real browser filling the real form, and the data read back through the
// server's own read path afterwards. Reading it back through the server rather than from a file is deliberate —
// it makes no assumption about how the model chose to store anything, and a response alone is not persistence.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const startCmd = arg("--start", "node server.js");
const port = Number(arg("--port", "3100"));
const origin = `http://127.0.0.1:${port}`;

const { chromium } = createRequire("/opt/crestmont/")("playwright");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function startServer() {
  const [cmd, ...rest] = startCmd.split(" ");
  const p = spawn(cmd, rest, { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (b) => { out += String(b); });
  p.stderr.on("data", (b) => { out += String(b); });
  p.on("exit", (c) => { if (c !== 0 && c !== null) console.log(`server exited ${c}: ${out.slice(0, 600)}`); });
  return { proc: p, output: () => out };
}

async function waitForServer(ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${origin}/quote.html`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * Everything the server will tell us it has stored, through whichever list endpoint it exposes.
 *
 * The envelope is NOT assumed. The first version looked for `rows` or `requests` and reported a correct
 * integration as having failed to persist, because the model had wrapped its array in `data`. Naming the
 * envelope is the verifier inventing a contract nobody agreed; any array-valued property counts.
 */
async function stored() {
  for (const path of ["/api/quote-requests", "/api/quote-request", "/api/quotes", "/api/quote_requests", "/api/requests"]) {
    try {
      const r = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const body = await r.json();
      if (Array.isArray(body)) return { path, rows: body };
      if (body && typeof body === "object") {
        const found = Object.values(body).find((v) => Array.isArray(v));
        if (found) return { path, rows: found };
      }
    } catch { /* try the next */ }
  }
  return null;
}

const GOOD = {
  "#q-name": "Dana Whitfield",
  "#q-phone": "(517) 555-0199",
  "#q-email": "dana@summithaul.test",
  "#q-postcode": "48823",
  "#q-details": "Two sofas, a dryer and about ten boxes in the garage.",
};

async function fill(page, values) {
  for (const [sel, val] of Object.entries(values)) await page.fill(sel, val);
}

async function main() {
  const server = startServer();
  const up = await waitForServer();
  if (!up) {
    console.log(`the server did not come up on ${origin}\n${server.output().slice(0, 1200)}`);
    server.proc.kill();
    process.exit(1);
  }
  check("the integrated application starts and serves the site", true, origin);

  const browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
  try {
    const before = await stored();
    check("the server exposes a way to read back what it stored", before !== null, before ? `${before.path} → ${before.rows.length} row(s)` : "no list endpoint responded");
    const baseline = before?.rows.length ?? 0;

    // ── a real submission, through the real form ──────────────────────────────────────────────────────────
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const statuses = [];
    page.on("response", (r) => { if (r.url().includes("/api/")) statuses.push(`${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`); });
    await page.goto(`${origin}/quote.html`, { waitUntil: "load" });
    await fill(page, GOOD);
    await page.selectOption("#q-load", { index: 2 });
    await page.click("#quote-request button[type=submit]");

    let confirmed = true;
    try { await page.waitForSelector(".form-status-ok", { timeout: 12_000 }); }
    catch { confirmed = false; }
    const shown = confirmed ? (await page.textContent(".form-status-ok"))?.trim() : (await page.textContent(".form-status-bad").catch(() => null))?.trim();
    check("submitting the form shows the visitor a confirmation", confirmed, shown ? JSON.stringify(shown.slice(0, 90)) : "no status appeared at all");
    check("the request reached the backend", statuses.length > 0, statuses.join("; ") || "no /api/ request was made");

    const after = await stored();
    const grew = (after?.rows.length ?? 0) === baseline + 1;
    check("the submission was really persisted", grew, after ? `${baseline} → ${after.rows.length} row(s)` : "could not read the store back");
    if (grew) {
      const row = after.rows[after.rows.length - 1];
      const keeps = String(row.name ?? "").includes("Dana") && String(row.postcode ?? row.zip ?? "") === "48823";
      check("the stored record carries what the visitor typed", keeps, JSON.stringify(row).slice(0, 180));
    }
    await page.close();

    // ── an invalid submission ─────────────────────────────────────────────────────────────────────────────
    const beforeBad = (await stored())?.rows.length ?? 0;
    const p2 = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const codes = [];
    p2.on("response", (r) => { if (r.url().includes("/api/")) codes.push(r.status()); });
    await p2.goto(`${origin}/quote.html`, { waitUntil: "load" });
    await fill(p2, { ...GOOD, "#q-postcode": "4882", "#q-email": "dana@@summithaul" });
    await p2.selectOption("#q-load", { index: 2 });
    await p2.click("#quote-request button[type=submit]");
    await p2.waitForTimeout(2500);

    check("an invalid submission is refused with 422", codes.includes(422), `statuses ${codes.join(",") || "(none)"}`);
    const afterBad = (await stored())?.rows.length ?? 0;
    check("and nothing is stored for it", afterBad === beforeBad, `${beforeBad} → ${afterBad}`);
    const okShown = await p2.$(".form-status-ok");
    check("the form does not claim success on a refusal", okShown === null, okShown ? "it showed a confirmation anyway" : "no confirmation shown");
    await p2.close();

    // ── a direct request, bypassing the browser entirely ──────────────────────────────────────────────────
    //
    // The browser's own `required` attributes are absent from a direct POST, which is how a real abusive
    // request arrives. Server-side validation has to stand on its own.
    const direct = await fetch(`${origin}/api/quote-request`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }),
    }).catch(() => null);
    check("a direct request with missing fields is refused server-side", direct !== null && direct.status >= 400 && direct.status < 500,
      direct ? `HTTP ${direct.status}` : "the request failed outright");
  } finally {
    await browser.close().catch(() => {});
    server.proc.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(2); });
