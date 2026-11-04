// Does a stored build revision actually RENDER in a browser?
//
// Revision 1-3 of bld_50e28bbd1cd033ad9ddfad02 scored 9.4/10 and opened in Edge as raw HTML -- Times New Roman,
// blue underlined links, bullet-point navigation, no layout. Every check in the pipeline was green, because they
// all asked whether the route returned 200 and whether the stored bytes were intact. Both were true. The browser
// still could not fetch the stylesheet: the sandboxing CSP gives the preview an opaque origin, a browser withholds
// a SameSite=Lax session cookie from requests such a document makes, and the stylesheet was redirected to /login.
//
// So this step asserts what the Founder sees: COMPUTED styles on a real page, loaded from the real deployment,
// plus the network result of every subresource it asked for. A page that renders unstyled fails here, whatever its
// status codes say.
//
// Usage: node scripts/preview-render-check.mjs <baseUrl> <outDir> [jobId]
// Env:   PREVIEW_FILE_SECRET (the value of the Worker's BUILD_PREVIEW_FILE_SECRET), PLAYWRIGHT_MODULE,
//        and the wrangler env used by readRevision() to find a revision to open.
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [BASE_RAW, OUT_RAW, JOB_ARG] = process.argv.slice(2);
const BASE = (BASE_RAW ?? "").replace(/\/$/, "");
const OUT = OUT_RAW ?? "evidence/preview-render";
const SECRET = process.env.PREVIEW_FILE_SECRET ?? "";
const WRANGLER = process.env.WRANGLER ?? "npx --yes wrangler@4.149.0";
if (!BASE) { console.error("usage: preview-render-check.mjs <baseUrl> <outDir> [jobId]"); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const fail = [];
const note = [];
const problem = (m) => { fail.push(m); console.log(`::error title=Preview render::${m}`); };

/** Mint the same capability the preview page mints (src/services/build-revisions.ts). */
function previewToken(jobId, attempt, cycle, ttl = 3600) {
  const key = createHmac("sha256", SECRET).update("crestmont-build-preview-file-key:v1").digest("hex");
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const mac = createHmac("sha256", key).update(`${jobId}|${attempt}|${cycle}|${exp}`).digest("hex").slice(0, 48);
  return `${exp}-${mac}`;
}

function d1(sql) {
  const [cmd, ...rest] = WRANGLER.split(" ");
  const out = execFileSync(cmd, [...rest, "d1", "execute", "crestmont-staging", "--env", "staging", "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, shell: process.platform === "win32" });
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

/** The revision to open: the one asked for, else the newest build that stored a best revision. */
function pickRevision() {
  const where = JOB_ARG ? `r.job_id = '${JOB_ARG.replace(/[^A-Za-z0-9_]/g, "")}'` : "1=1";
  const rows = d1(`SELECT r.job_id, r.attempt, r.cycle, r.score, r.is_best,
      (SELECT COUNT(*) FROM build_revision_files f WHERE f.revision_id = r.id AND f.kind = 'page') AS pages,
      (SELECT COUNT(*) FROM build_revision_files f WHERE f.revision_id = r.id AND f.content_type LIKE 'text/css%') AS sheets
    FROM build_revisions r WHERE ${where} ORDER BY r.is_best DESC, r.created_at DESC LIMIT 1`);
  return rows[0] ?? null;
}

const rev = pickRevision();
if (!rev) { console.log("No stored build revision on this environment; nothing to render-check."); process.exit(0); }
if (!SECRET) { problem("PREVIEW_FILE_SECRET is not set, so no preview capability can be minted and the render cannot be checked"); process.exit(1); }
if (!rev.sheets) note.push(`revision ${rev.attempt}-${rev.cycle} stores no stylesheet at all, so "unstyled" would be correct for it`);

const token = previewToken(rev.job_id, rev.attempt, rev.cycle);
const url = `${BASE}/build-preview/${rev.job_id}/${rev.attempt}-${rev.cycle}/${token}/index.html`;

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch();
const results = {};

for (const [name, width, height] of [["desktop", 1440, 900], ["tablet", 820, 1180], ["mobile", 390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const requests = [];
  page.on("requestfinished", async (r) => {
    const res = await r.response();
    requests.push({ url: r.url(), type: r.resourceType(), status: res?.status() ?? null, mime: (await res?.headerValue("content-type")) ?? null });
  });
  page.on("requestfailed", (r) => requests.push({ url: r.url(), type: r.resourceType(), failed: r.failure()?.errorText ?? "failed" }));

  const response = await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(800);

  const probe = await page.evaluate(() => {
    const cs = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
    let applied = 0;
    for (const s of document.styleSheets) { try { applied += s.cssRules.length; } catch { applied += 1; } } // cross-origin sheet: counts as present
    return {
      origin: String(window.origin), sheetCount: document.styleSheets.length, ruleCount: applied,
      links: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href),
      bodyFont: cs("body", "fontFamily"), bodyBg: cs("body", "backgroundColor"),
      h1Font: cs("h1", "fontFamily"), h1Size: cs("h1", "fontSize"),
      headerBg: cs("header, .site-header", "backgroundColor"),
      navListStyle: cs("nav ul, .site-nav ul", "listStyleType"),
      navDisplay: cs("nav ul, .site-nav ul", "display"),
      linkColor: cs("nav a, .site-nav a", "color"),
      bodyWidth: document.body.scrollWidth, docWidth: document.documentElement.clientWidth,
      images: document.images.length,
    };
  });
  results[name] = { url, status: response?.status() ?? null, probe, requests };

  // ── The assertions that the unstyled screenshot fails ──
  const blocked = requests.filter((r) => r.failed || (r.status && r.status >= 300));
  for (const b of blocked) problem(`${name}: ${b.type} ${new URL(b.url).pathname} → ${b.failed ?? `HTTP ${b.status}`} (a preview subresource must load, not redirect)`);

  if (rev.sheets > 0) {
    if (!probe.sheetCount) problem(`${name}: the page applied no stylesheet at all — this is the unstyled failure`);
    if (/Times New Roman/i.test(probe.bodyFont ?? "")) problem(`${name}: body font is ${probe.bodyFont} — the browser's default, so no CSS was applied`);
    if (probe.navListStyle === "disc") problem(`${name}: navigation is rendering as a bullet list (list-style ${probe.navListStyle}) — unstyled`);
    if (probe.linkColor === "rgb(0, 0, 238)") problem(`${name}: links are the browser default blue — unstyled`);
    if (probe.headerBg === "rgba(0, 0, 0, 0)" && probe.bodyBg === "rgba(0, 0, 0, 0)") {
      problem(`${name}: neither the header nor the body has a background colour — unstyled`);
    }
  }
  // Horizontal overflow is a layout defect a screenshot hides at the fold.
  if (probe.bodyWidth > probe.docWidth + 2) note.push(`${name}: the page scrolls horizontally (${probe.bodyWidth}px of content in ${probe.docWidth}px)`);

  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  await ctx.close();
}

// In-page navigation: a preview whose own links 404 is not a working preview.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "load", timeout: 60_000 });
const firstNav = await page.evaluate(() => {
  const a = [...document.querySelectorAll("a[href]")].find((x) => /\/build-preview\//.test(x.href) && !/#/.test(x.getAttribute("href") ?? ""));
  return a ? a.href : null;
});
if (firstNav) {
  const r = await page.goto(firstNav, { waitUntil: "load", timeout: 60_000 });
  if (!r || r.status() !== 200) problem(`in-page navigation to ${new URL(firstNav).pathname} returned ${r?.status() ?? "no response"}`);
  else results.navigation = { url: firstNav, status: 200 };
} else note.push("the home page has no in-preview link to follow");
await ctx.close();
await browser.close();

writeFileSync(path.join(OUT, "preview-render.json"), JSON.stringify({
  base: BASE, revision: `${rev.attempt}-${rev.cycle}`, jobId: rev.job_id, score: rev.score, results, notes: note, failures: fail,
}, null, 2));

for (const n of note) console.log(`::notice title=Preview render::${n}`);
const d = results.desktop?.probe ?? {};
console.log(`Preview render ${rev.job_id} ${rev.attempt}-${rev.cycle} (score ${rev.score ?? "—"}): origin ${d.origin}, `
  + `${d.sheetCount} stylesheet(s), body font ${d.bodyFont}, header ${d.headerBg}, ${d.images} image(s).`);
if (fail.length) { console.log(`${fail.length} render failure(s).`); process.exit(1); }
console.log("Preview renders with its stylesheet applied at desktop, tablet and mobile.");
