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
  // Only the image's own Playwright (/opt/crestmont/node_modules, found from this script's location or NODE_PATH).
  // Never the project's node_modules: that is agent-controlled and could fake the browser results.
  let chromium;
  try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch {
    console.error("browser-check: the playwright package is not available (build image problem)"); process.exit(2);
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
        // The form-submission check below posts to the form's own action. This server serves the static files only,
        // so that request CANNOT succeed here -- the Worker is not running. Its 404 is expected and must not be
        // reported as a defect, or every correct form would fail. Set while that submission is in flight.
        let formAction = null;
        const isFormPost = (u) => !!formAction && typeof u === "string" && u.split("?")[0] === formAction;
        // The same reasoning covers EVERY backend call, not just the form post: this server serves the static files
        // only, so a page that fetches /api/... on load gets a 404 here no matter how correct it is. A real Business
        // build was failed on exactly this -- admin/index.html, booking/confirmation.html and booking/manage.html were
        // each marked FAIL for "HTTP 404: /api/admin/me" and "/api/bookings/", all three of which the Worker's route
        // table does serve. Those false failures became visual_design/frontend defects, which spent the run's last
        // turns on a repair of working code. Whether an endpoint exists is decided with certainty by the runner's
        // contract check against the route table; a server with no backend cannot decide it, so it does not try.
        const isBackendCall = (u) => typeof u === "string" && u.startsWith(origin) && u.slice(origin.length).split("?")[0].startsWith("/api/");
        p.on("pageerror", (e) => errors.push(`page error: ${String(e.message).slice(0, 300)}`));
        p.on("console", (m) => {
          if (m.type() !== "error" || /net::ERR_/.test(m.text())) return;
          // The browser's own "Failed to load resource ... 404" for a backend call it could not reach here. Its
          // location is that request's URL, so the same rule applies: a note, not a defect.
          if (isBackendCall(m.location()?.url ?? "")) { warnings.push(`backend call not available in this check (no Worker is running): ${m.text().slice(0, 200)}`); return; }
          errors.push(`console error: ${m.text().slice(0, 300)}`);
        });
        p.on("requestfailed", (r) => {
          const msg = `${r.url().slice(0, 200)} (${r.failure()?.errorText ?? "failed"})`;
          if (isBackendCall(r.url())) warnings.push(`backend call not available in this check (no Worker is running): ${msg}`);
          else if (r.url().startsWith(origin)) errors.push(`request failed: ${msg}`); else warnings.push(`off-origin request not available offline: ${msg}`);
        });
        p.on("response", (r) => {
          if (isFormPost(r.url())) return;
          if (isBackendCall(r.url())) { if (r.status() >= 400) warnings.push(`backend call not available in this check (no Worker is running): ${r.url().replace(origin, "")} -> HTTP ${r.status()}`); return; }
          if (r.url().startsWith(origin) && r.status() >= 400 && !(page === "404.html" && r.url() === `${origin}/404.html`)) errors.push(`HTTP ${r.status()}: ${r.url().replace(origin, "")}`);
        });
        try {
          await p.goto(`${origin}/${page}`, { waitUntil: "load", timeout: o.timeoutMs });
          const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 1) errors.push(`horizontal overflow: page is ${overflow}px wider than the ${vp.name} viewport`);
          // Desktop navigation (failure mode C18). Run 1 rendered the hamburger toggle at desktop width with no
          // visible nav links at all, so a desktop visitor could not move around the site. Nothing caught it: the
          // page rendered, every link resolved and the screenshot looked plausible.
          if (vp.name === "desktop") {
            const nav = await p.evaluate(() => {
              const vis = (e) => { if (!e) return false; const s = getComputedStyle(e), r = e.getBoundingClientRect();
                return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) !== 0 && r.width > 0 && r.height > 0; };
              const root = document.querySelector("header nav, nav, [role=navigation]");
              const links = root ? [...root.querySelectorAll("a[href]")].filter(vis) : [];
              const toggles = [...document.querySelectorAll("button,[role=button]")]
                .filter((e) => vis(e) && /menu|nav|hamburger|toggle/i.test(`${e.className} ${e.id} ${e.getAttribute("aria-label") ?? ""} ${e.getAttribute("aria-controls") ?? ""}`));
              // A page carrying the site chrome is a public page of the site and must offer its navigation. A private
              // app shell (an admin screen) has neither header nor footer and is not held to the public-nav rule --
              // requiring it there failed a correct admin screen, while a site header with no nav inside it stays a
              // real defect, which is how 404.html and the two booking pages were caught.
              const chrome = !!document.querySelector("header, footer, .site-header, .site-footer");
              // An element that clearly IS navigation but is not marked up as one: naming it turns "no nav landmark"
              // into a fix the builder can make, instead of a verdict it can only guess at.
              const likely = [...document.querySelectorAll("[class*=nav], [class*=menu], [class*=tabs]")]
                .find((e) => vis(e) && e.querySelectorAll("a[href],button").length >= 2);
              return { hasNav: !!root, visibleLinks: links.length, toggleVisible: toggles.length > 0, chrome, navLike: likely ? (likely.getAttribute("class") || likely.tagName.toLowerCase()) : null };
            });
            if (!nav.chrome && !nav.hasNav) warnings.push("navigation: no nav landmark, and no site header or footer either: treated as a private app screen, not a public page");
            else if (!nav.hasNav) errors.push(`navigation: the page carries the site header or footer but has no nav landmark${nav.navLike ? `, though it has a "${nav.navLike}" element that looks like navigation: wrap it in <nav aria-label="..."> (or add role="navigation") so it is reachable` : ": a visitor who lands here cannot move around the site"}`);
            else if (nav.visibleLinks < 2) errors.push(`navigation: only ${nav.visibleLinks} navigation link(s) are visible at ${vp.width}px, so a desktop visitor cannot move around the site${nav.toggleVisible ? "; the mobile menu toggle is showing instead of the desktop navigation" : ""}`);
            else if (nav.toggleVisible) errors.push(`navigation: the mobile menu toggle is visible at ${vp.width}px alongside the desktop navigation; it should be hidden above the mobile breakpoint`);
          }

          // The screenshot comes FIRST, before anything is focused. A well-built site puts a "skip to content" link
          // first in the tab order and reveals it on focus, so pressing Tab before the screenshot put that link over
          // the header in every image the reviewer judged -- the instrument changing what it measured. The reviewer
          // then marked the site down for it (observed on bld_d6090c28f8e6923c75223307, cycles 2 and 4).
          const shot = path.join(o.out, `${page.replace(/[\\/]/g, "_").replace(/\.html$/, "")}-${vp.name}.png`);
          await p.screenshot({ path: shot, fullPage: true });

          await p.keyboard.press("Tab");
          const focused = await p.evaluate(() => document.activeElement && document.activeElement !== document.body ? document.activeElement.tagName : null);
          if (!focused) errors.push("keyboard: the first Tab did not focus anything");

          // A form that cannot be submitted is a dead conversion path, and nothing else here would notice: the page
          // renders, every link works, the screenshot looks right. So fill it in and press the button. Any exception
          // the site's own submit handler throws is caught by the pageerror listener above.
          if (vp.name === "desktop") {
            formAction = await p.evaluate(() => {
              const f = [...document.querySelectorAll("form")].find((x) => x.querySelectorAll("input:not([type=hidden]),select,textarea").length >= 3);
              return f ? new URL(f.getAttribute("action") || location.href, location.href).href.split("?")[0] : null;
            });
            const outcome = await submitFirstForm(p, o.timeoutMs);
            if (outcome && outcome.problem) errors.push(`form: ${outcome.problem}`);
          }
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

/**
 * Fill the page's first real form with plausible values and submit it.
 *
 * Returns null when the page has no form worth testing, otherwise `{ problem }` where `problem` is null if the form
 * did SOMETHING a visitor could act on. The static server here cannot accept a submission, so a failed or rejected
 * request is a pass: what is being caught is a form that answers a click with nothing at all -- the handler threw, or
 * there is no handler -- which looks perfect in a screenshot and loses every enquiry.
 *
 * Honeypots are left empty on purpose: filling one makes a correct anti-spam backend reject the submission, and the
 * check would then be measuring its own input rather than the form.
 */
async function submitFirstForm(p, timeoutMs) {
  const has = await p.evaluate(() => {
    const f = [...document.querySelectorAll("form")].find((x) => x.querySelectorAll("input:not([type=hidden]),select,textarea").length >= 3);
    return !!f;
  });
  if (!has) return null;

  let requested = false;
  const onRequest = (r) => { if (r.method() !== "GET") requested = true; };
  p.on("request", onRequest);
  const before = await p.evaluate(() => document.body.innerText.length);

  const filled = await p.evaluate(() => {
    const f = [...document.querySelectorAll("form")].find((x) => x.querySelectorAll("input:not([type=hidden]),select,textarea").length >= 3);
    const honeypot = (e) => {
      if (e.tabIndex === -1) return true;
      const n = `${e.name} ${e.id}`.toLowerCase();
      if (/honey|company_website|website_url|leave.?this|bot.?field/.test(n)) return true;
      const st = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return st.display === "none" || st.visibility === "hidden" || r.width === 0 || r.height === 0 || r.left < -500 || r.top < -500;
    };
    const names = [];
    for (const e of f.querySelectorAll("input,select,textarea")) {
      if (e.type === "hidden" || honeypot(e)) continue;
      if (e.tagName === "SELECT") { const opt = [...e.options].find((x) => x.value && !x.disabled); if (opt) e.value = opt.value; }
      else if (e.type === "checkbox" || e.type === "radio") { if (!e.checked) e.checked = true; }
      else {
        const n = `${e.name} ${e.id} ${e.getAttribute("placeholder") ?? ""} ${e.type}`.toLowerCase();
        e.value = /mail/.test(n) ? "checks@example.test"
          : /phone|tel/.test(n) ? "+1 555 0100"
          : /zip|postal/.test(n) ? "48823"
          : /date/.test(n) ? "2030-01-15"
          : /name/.test(n) ? "Automated Check"
          : "Automated browser check: a sofa, a refrigerator and several boxes.";
      }
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
      names.push(e.name || e.id);
    }
    const btn = f.querySelector('[type=submit], button:not([type=button])');
    if (!btn) return { names, clicked: false };
    btn.click();
    return { names, clicked: true };
  });
  if (!filled.clicked) { p.off("request", onRequest); return { problem: "the form has no submit button, so it cannot be sent" }; }

  await p.waitForTimeout(Math.min(2500, Math.max(800, Math.floor(timeoutMs / 8))));
  p.off("request", onRequest);

  const after = await p.evaluate(() => {
    const f = [...document.querySelectorAll("form")].find((x) => x.querySelectorAll("input:not([type=hidden]),select,textarea").length >= 3);
    const invalid = f ? [...f.querySelectorAll("input,select,textarea")].filter((e) => e.willValidate && !e.checkValidity()).length : 0;
    const flagged = f ? f.querySelectorAll("[aria-invalid=true]").length : 0;
    return { text: document.body.innerText, length: document.body.innerText.length, invalid, flagged, navigated: false };
  });
  const said = after.length !== before || /thank|received|sending|error|required|please|invalid|try again|sorry/i.test(after.text);
  if (requested || said || after.invalid > 0 || after.flagged > 0) return { problem: null };
  return { problem: `submitting the form (fields: ${filled.names.filter(Boolean).join(", ") || "unnamed"}) did nothing at all: no request was attempted, no validation message appeared and the page did not change. The submit handler is broken or missing, so a visitor's enquiry is silently lost.` };
}

main().catch((e) => { console.error(`browser-check: ${e?.stack ?? e}`); process.exit(2); });
