// Proving the quote form actually works — the acceptance criteria from the integration manifest, run.
//
//   node server/verify-backend.mjs [--root dist]
//
// Every assertion here is made against real things: a real HTTP server, a real browser filling the real form,
// and a real SQLite database queried afterwards. Nothing is stubbed, and no step is satisfied by a 200 response
// alone — a response is not persistence, so the row is read back every time.
//
// The three criteria:
//   1. a submitted request is stored as a row in quote_requests;
//   2. a request missing a required field is refused with 422 and NOTHING is stored;
//   3. a storage failure shows an error in the form rather than a false confirmation.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { rmSync, mkdirSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const root = arg("--root", "dist");
const DB = path.resolve(".data/verify.db");

const require_ = createRequire("/opt/crestmont/");
const { chromium } = require_("playwright");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function startServer(extra = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["server/serve.mjs", "--root", root, "--db", DB, "--port", "0", ...extra], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const onData = (b) => {
      out += String(b);
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ proc: p, origin: `http://127.0.0.1:${m[1]}` });
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", (b) => { out += String(b); });
    p.on("exit", (c) => reject(new Error(`the server exited with ${c}: ${out.slice(0, 500)}`)));
    setTimeout(() => reject(new Error(`the server did not start: ${out.slice(0, 500)}`)), 15_000);
  });
}

const rows = () => {
  const db = new DatabaseSync(DB);
  try { return db.prepare("SELECT * FROM quote_requests ORDER BY created_at").all(); }
  catch { return []; }
  finally { db.close(); }
};

async function fill(page, values) {
  for (const [sel, val] of Object.entries(values)) {
    if (sel === "#q-load") await page.selectOption(sel, val);
    else await page.fill(sel, val);
  }
}

const GOOD = {
  "#q-name": "Dana Whitfield",
  "#q-phone": "(517) 555-0199",
  "#q-email": "dana@summithaul.test",
  "#q-postcode": "48823",
  "#q-details": "Two sofas, a dryer and about ten boxes in the garage.",
};

async function main() {
  rmSync(DB, { force: true });
  mkdirSync(path.dirname(DB), { recursive: true });

  const browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });

  // ── 1. a real submission is really stored ───────────────────────────────────────────────────────────────────
  let server = await startServer();
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await page.goto(`${server.origin}/quote.html`, { waitUntil: "load" });
    await fill(page, GOOD);
    await page.selectOption("#q-load", "Half truck — $210");
    await page.click("#quote-request button[type=submit]");
    await page.waitForSelector(".form-status-ok", { timeout: 10_000 });

    const shown = (await page.textContent(".form-status-ok"))?.trim() ?? "";
    const stored = rows();
    check("a submitted request is stored as a row in quote_requests",
      stored.length === 1 && stored[0].name === "Dana Whitfield" && stored[0].postcode === "48823" && stored[0].load_size === "Half truck — $210",
      stored.length ? `id ${stored[0].id}, status ${stored[0].status}, ${stored[0].email}` : "no row was written");
    check("the visitor is shown the confirmation the server sent", /quote today|have your request/i.test(shown), JSON.stringify(shown.slice(0, 80)));
    check("the stored row carries the details the visitor typed", stored[0]?.details?.startsWith("Two sofas"), String(stored[0]?.details).slice(0, 40));
    await page.close();
  } finally { server.proc.kill(); }

  // ── 2. an invalid submission is refused, and nothing is stored ──────────────────────────────────────────────
  const beforeInvalid = rows().length;
  server = await startServer();
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const statuses = [];
    page.on("response", (r) => { if (r.url().endsWith("/api/quote-requests")) statuses.push(r.status()); });
    await page.goto(`${server.origin}/quote.html`, { waitUntil: "load" });
    // A plausible-looking submission with a bad ZIP and a bad email: the browser's own `required` is bypassed by
    // noValidate, which is exactly how a direct POST would arrive.
    await fill(page, { ...GOOD, "#q-postcode": "4882", "#q-email": "dana@@summithaul" });
    await page.selectOption("#q-load", "Half truck — $210");
    await page.click("#quote-request button[type=submit]");
    await page.waitForSelector(".form-status-bad", { timeout: 10_000 });

    const after = rows().length;
    check("an invalid request is refused with 422", statuses.includes(422), `statuses ${statuses.join(",") || "(none)"}`);
    check("and nothing is stored", after === beforeInvalid, `${beforeInvalid} row(s) before, ${after} after`);

    const zipMsg = await page.textContent("#q-postcode ~ .hint, .field:has(#q-postcode) .hint").catch(() => null);
    check("the field that was wrong is named", /ZIP/i.test(String(zipMsg ?? "")), JSON.stringify(String(zipMsg ?? "").slice(0, 60)));
    await page.close();
  } finally { server.proc.kill(); }

  // ── 3. a storage failure is told to the visitor, not hidden ─────────────────────────────────────────────────
  const beforeFailure = rows().length;
  server = await startServer(["--fail-inserts"]);
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const statuses = [];
    page.on("response", (r) => { if (r.url().endsWith("/api/quote-requests")) statuses.push(r.status()); });
    await page.goto(`${server.origin}/quote.html`, { waitUntil: "load" });
    await fill(page, GOOD);
    await page.selectOption("#q-load", "Full truck — $480");
    await page.click("#quote-request button[type=submit]");
    await page.waitForSelector(".form-status-bad", { timeout: 10_000 });

    const msg = (await page.textContent(".form-status-bad"))?.trim() ?? "";
    const ok = await page.$(".form-status-ok");
    check("a storage failure answers 503", statuses.includes(503), `statuses ${statuses.join(",") || "(none)"}`);
    check("the visitor is told it was not saved, and given the phone number", /could not save/i.test(msg) && /555-0123/.test(msg), JSON.stringify(msg.slice(0, 90)));
    check("and the form does NOT say thank you", ok === null, ok ? "a confirmation was shown anyway" : "no confirmation shown");
    check("nothing was stored", rows().length === beforeFailure, `${rows().length} row(s)`);
    await page.close();
  } finally { server.proc.kill(); }

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`final database contents: ${JSON.stringify(rows().map((r) => ({ id: r.id, name: r.name, load: r.load_size, status: r.status })), null, 1)}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(2); });
