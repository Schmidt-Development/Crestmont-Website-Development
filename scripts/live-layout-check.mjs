// Live layout check of the purchase pages (Founder launch closeout, 2026-11-13, criterion 7: the final mobile fix on
// the LIVE site). A real Chromium at 320, 390, 768, 1280 and 1440 px opens:
//   - each package's guest intake exactly as the live site serves it to a visitor without an account;
//   - each package's review page (plan cards, charges, agreements, Pay) as the purchase probe received it from the live
//     site, rendered at the live origin so the live stylesheets and scripts apply (no session is needed or used).
// Asserts: no horizontal page scroll; no control, label or heading wider than its card; legends inside their cards;
// buttons do not overlap. Read-only: nothing is submitted.
//   PLAYWRIGHT_MODULE=… node scripts/live-layout-check.mjs <https-origin> [<dir with review-<id>.html>]
import { readFileSync, existsSync } from "node:fs";
const pwModule = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = pwModule.chromium ? pwModule : pwModule.default;
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(base)) { console.error("usage: live-layout-check.mjs <https-origin> [review-dir]"); process.exit(2); }
const dir = process.argv[3];
const widths = [{ w: 320, h: 640, m: true }, { w: 390, h: 844, m: true }, { w: 768, h: 1024, m: true }, { w: 1280, h: 800, m: false }, { w: 1440, h: 900, m: false }];
const b = await chromium.launch();
let failed = 0;
for (const id of ["starter", "business", "premium"]) {
  const pages = [["intake", `${base}/checkout/${id}/intake`, null]];
  const f = dir && `${dir}/review-${id}.html`;
  if (f && existsSync(f)) pages.push(["review", `${base}/__layout-check/review-${id}`, readFileSync(f, "utf8")]);
  else console.log(`NOTE ${id}: no saved review page (the purchase probe did not run), intake only`);
  for (const [name, url, html] of pages) {
    const issues = [];
    for (const vp of widths) {
      const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: vp.m, hasTouch: vp.m, deviceScaleFactor: 1 });
      const p = await ctx.newPage();
      if (html) await p.route(url, (r) => r.fulfill({ status: 200, body: html, contentType: "text/html; charset=utf-8" }));
      const errors = []; p.on("pageerror", (e) => errors.push(e.message));
      const res = await p.goto(url, { waitUntil: "load", timeout: 45_000 }).catch((e) => ({ status: () => `error ${e.message.slice(0, 80)}` }));
      if (res.status() !== 200) { issues.push(`${vp.w}px: HTTP ${res.status()}`); await ctx.close(); continue; }
      await p.waitForTimeout(500);
      const found = await p.evaluate(() => {
        const out = [];
        const doc = document.documentElement;
        if (doc.scrollWidth > doc.clientWidth + 1) out.push(`page scrolls horizontally (${doc.scrollWidth} > ${doc.clientWidth})`);
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        for (const card of document.querySelectorAll("main .card, main fieldset")) {
          const cr = card.getBoundingClientRect();
          for (const el of card.querySelectorAll("input:not([type=hidden]), textarea, select, button, label, legend, h2, h3, p, .hint")) {
            if (!vis(el) || el.closest(".cf-turnstile")) continue;
            const r = el.getBoundingClientRect();
            if (r.left < cr.left - 1 || r.right > cr.right + 1) out.push(`${el.tagName.toLowerCase()}${el.getAttribute("name") ? `[name=${el.getAttribute("name")}]` : ""} "${(el.textContent ?? "").trim().slice(0, 30)}" extends outside its card`);
          }
          const legend = card.querySelector(":scope > legend");
          if (legend && vis(legend) && legend.getBoundingClientRect().top < cr.top - 2) out.push(`legend "${legend.textContent.trim().slice(0, 30)}" floats above its card`);
        }
        const btns = [...document.querySelectorAll("main button, main .btn")].filter(vis).map((x) => x.getBoundingClientRect());
        for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) {
          const a = btns[i], c = btns[j];
          if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) out.push("two buttons overlap");
        }
        return out;
      });
      for (const x of [...new Set(found)].slice(0, 8)) issues.push(`${vp.w}px: ${x}`);
      for (const e of errors) issues.push(`${vp.w}px: script error ${e.slice(0, 100)}`);
      await ctx.close();
    }
    console.log(`${issues.length ? "FAIL" : "PASS"} ${id} ${name}: live layout at ${widths.map((v) => v.w).join("/")} px${issues.length ? ` — ${issues.join("; ")}` : ""}`);
    if (issues.length) failed++;
  }
}
await b.close();
process.exit(failed ? 1 : 0);
