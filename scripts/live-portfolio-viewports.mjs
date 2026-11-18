// Read-only visitor sweep of the published portfolio at five widths (Owner, 2026-11-18 acceptance fix): 1440 and 1280 px
// desktop, 820 px tablet, 390 and 320 px phones. For every published project, as a first-time visitor (no cookies, no
// sign-in, nothing submitted): the arrows reach it; the REAL production domain is framed natively (or through the remote
// viewer — reported as such), never a demo or *.workers.dev copy; the frame holds actual page content; the site scrolls
// inside the frame while Crestmont's page stays still; animation frames keep running inside it; the title and
// description stay readable; the explorer's buttons and links are not covered by the assistant widget (or anything
// else); and the page never overflows horizontally. Navigation, protected routes, reload and device modes are verified
// by scripts/live-portfolio-check.mjs at desktop and phone; this adds the widths in between.
// One JPEG per project and width goes to <out-dir> as evidence.
//   PLAYWRIGHT_MODULE=… node scripts/live-portfolio-viewports.mjs <https-origin> [expected-count] [out-dir]
import { mkdirSync } from "node:fs";
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = pw.chromium ? pw : pw.default;
const base = (process.argv[2] ?? "").replace(/\/$/, "");
const expected = Number(process.argv[3] ?? 6);
const out = process.argv[4] ?? "portfolio-viewports";
if (!/^https?:\/\/[A-Za-z0-9.:-]+$/.test(base)) { console.error("usage: live-portfolio-viewports.mjs <origin> [count] [out-dir]"); process.exit(2); }
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) failed++; };
const WIDTHS = [
  ["1440 desktop", { width: 1440, height: 900 }, false],
  ["1280 desktop", { width: 1280, height: 800 }, false],
  ["820 tablet", { width: 820, height: 1180 }, true],
  ["390 phone", { width: 390, height: 844 }, true],
  ["320 phone", { width: 320, height: 640 }, true],
];
const b = await chromium.launch();
for (const [label, viewport, touch] of WIDTHS) {
  const ctx = await b.newContext({ viewport, isMobile: touch && viewport.width < 800, hasTouch: touch, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  try {
    // One retry on a navigation timeout, recorded (never hidden): a repeat fails the width.
    const t0 = Date.now();
    try { await p.goto(`${base}/portfolio`, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
    catch (e) { console.log(`NOTE ${label}: /portfolio did not load within 30 s (${String(e.message).split("\n")[0].slice(0, 80)}) — retrying once`); await p.goto(`${base}/portfolio`, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
    console.log(`NOTE ${label}: /portfolio DOMContentLoaded after ${Date.now() - t0} ms`);
    await p.locator(".pfx").first().scrollIntoViewIfNeeded();
    const n = await p.locator(".pfx__slide").count();
    ok(n >= expected, `${label}: ${n} published projects (at least ${expected})`);
    const overflow = () => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    let prevName = "";
    for (let i = 0; i < n; i++) {
      if (i) { await p.locator("[data-pfx-next]").first().click(); await sleep(700); }
      for (let k = 0; k < 75; k++) { if (await p.evaluate(() => { const s = document.querySelector(".pfx__slide:not([inert])"); return s.classList.contains("is-ready") || s.dataset.unavailable === "true"; })) break; await sleep(400); }
      const s = await p.evaluate(() => {
        const sl = document.querySelector(".pfx__slide:not([inert])");
        const url = sl.dataset.kind === "remote" ? (sl.dataset.remoteHost ? `https://${sl.dataset.remoteHost}/` : "") : sl.dataset.frameUrl || "";
        const w = (sel) => sl.querySelector(sel)?.getBoundingClientRect().width ?? 0;
        const desc = sl.querySelector(".pfx__desc"), title = sl.querySelector(".pfx__meta h2, .pfx__meta h3, .pfx__name, .pfx__meta [data-pfx-title]");
        return { name: sl.dataset.name, kind: sl.dataset.kind, url, live: sl.dataset.liveUrl || "", ready: sl.classList.contains("is-ready"),
          meta: w(".pfx__meta"), desc: w(".pfx__desc"), descFont: desc ? parseFloat(getComputedStyle(desc).fontSize) : 0,
          descClipped: desc ? desc.scrollHeight > desc.clientHeight + 2 && getComputedStyle(desc).overflow !== "visible" : true,
          titleText: (title?.textContent || sl.dataset.name || "").trim(), current: document.querySelector("[data-pfx-go][aria-current='true']")?.dataset.pfxGo };
      });
      const tag = `${label} · project ${i + 1} (${s.name})`;
      ok(s.name && s.name !== prevName && Number(s.current) === i, `${tag}: the arrow switched to it (indicator ${s.current})`);
      prevName = s.name;
      const host = (() => { try { return new URL(s.url).host; } catch { return ""; } })();
      const liveHost = (() => { try { return new URL(s.live).host; } catch { return ""; } })();
      ok((s.kind === "live" || s.kind === "remote") && host && host === liveHost && !host.endsWith(".workers.dev"), `${tag}: real production domain ${host || "—"} (${s.kind === "live" ? "native frame" : s.kind})`);
      ok(s.ready, `${tag}: the live website is shown (not the screenshot)`);
      const stacked = viewport.width <= 1000;
      ok(s.meta > 0 && s.desc >= s.meta * (stacked ? 0.85 : 0.5) && s.descFont >= 13 && !s.descClipped && s.titleText.length > 0, `${tag}: title and description readable — description ${Math.round(s.desc)} of ${Math.round(s.meta)} px, ${s.descFont}px text, not clipped`);
      if (s.kind === "live" && s.ready) {
        const origin = new URL(s.url).origin, fr = p.frames().find((f) => f.url().startsWith(origin));
        if (!fr) { ok(false, `${tag}: the live frame was not found`); continue; }
        const content = await fr.evaluate(() => ({ text: (document.body?.innerText || "").replace(/\s+/g, " ").trim().length, title: document.title, imgs: document.images.length })).catch(() => null);
        ok(!!content && content.text > 200, `${tag}: actual page content in the frame (${content ? `${content.text} characters of text, ${content.imgs} images, title "${content.title.slice(0, 60)}"` : "unreadable"})`);
        const iframe = p.locator(".pfx__slide:not([inert]) iframe.pfx__frame");
        await iframe.evaluate((el) => el.scrollIntoView({ block: "center" })); await sleep(300);
        const box = await iframe.boundingBox();
        const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + box.height / 2);
        const outerY = () => p.evaluate(() => Math.round(scrollY));
        const innerY = () => fr.evaluate(() => Math.round(scrollY) + [...document.querySelectorAll("*")].reduce((a, e) => a + e.scrollTop, 0));
        const y0 = await outerY(), i0 = await innerY();
        if (touch) {
          const cdp = await ctx.newCDPSession(p), d = Math.round(box.height * 0.35);
          for (let r = 0; r < 2; r++) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy + d / 2 }] });
            for (let k = 1; k <= 10; k++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx, y: Math.round(cy + d / 2 - (k * d) / 10) }] }); await sleep(16); }
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(250);
          }
          await cdp.detach();
        } else { await p.mouse.move(cx, cy); await p.mouse.wheel(0, 500); }
        await sleep(700);
        const i1 = await innerY(), y1 = await outerY();
        // A page that fits its frame has nothing to scroll: record which, from the page itself.
        const room = await fr.evaluate(() => { const ov = (e) => getComputedStyle(e).overflowY, hv = ov(document.documentElement); const hidden = /hidden|clip/.test(hv) || (hv === "visible" && /hidden|clip/.test(ov(document.body))); const doc = hidden ? 0 : document.documentElement.scrollHeight - innerHeight; let el = 0; for (const e of document.querySelectorAll("body *")) if (/(auto|scroll|overlay)/.test(getComputedStyle(e).overflowY)) el = Math.max(el, e.scrollHeight - e.clientHeight); return { doc: Math.round(doc), el: Math.round(el), h: innerHeight }; }).catch(() => ({ doc: 1, el: 0, h: 0 }));
        if (room.doc <= 0 && room.el <= 2) ok(y1 === y0, `${tag}: the page fits its ${room.h}px frame — nothing to scroll; Crestmont stays still (${y0} → ${y1}px)`);
        else ok(i1 > i0 && y1 === y0, `${tag}: ${touch ? "swipe" : "wheel"} scrolls the site inside the frame (${i0} → ${i1}px; room: page ${room.doc}px, container ${room.el}px) while Crestmont stays still (${y0} → ${y1}px)`);
        // Measured idle (the scroll above has settled), over 2 s — the same conditions as the direct visit below.
        await sleep(1000);
        const sample = () => fr.evaluate(() => new Promise((res) => { let n = 0; const t = performance.now(); const g = () => { n++; if (performance.now() - t < 2000) requestAnimationFrame(g); else res({ fps: Math.round(n / ((performance.now() - t) / 1000)), running: document.getAnimations ? document.getAnimations().filter((a) => a.playState === "running").length : -1 }); }; requestAnimationFrame(g); })).catch(() => null);
        let anim = await sample();
        // "Normal" means: the frame does not slow the site down. Below 30 fps, the same site is measured loaded directly
        // (same browser, same width, no Crestmont): a heavy page on a GPU-less runner is slow either way, and only a
        // frame clearly slower than the direct visit (< 80 %) would be a portfolio defect.
        let direct = null;
        if (anim && anim.fps < 30) {
          const d = await ctx.newPage();
          try { await d.goto(s.url, { waitUntil: "load", timeout: 30_000 }); await sleep(1500); direct = await d.evaluate(() => new Promise((res) => { let n = 0; const t = performance.now(); const g = () => { n++; if (performance.now() - t < 2000) requestAnimationFrame(g); else res(Math.round(n / ((performance.now() - t) / 1000))); }; requestAnimationFrame(g); })); } catch { direct = null; }
          await d.close();
          // A second framed sample with the direct page closed (a shared runner's load varies): the better one counts.
          const again = await sample();
          if (again && (!anim || again.fps > anim.fps)) anim = again;
        }
        ok(!!anim && (anim.fps >= 30 || (direct != null && anim.fps >= direct * 0.8)), `${tag}: animations run normally inside the frame (${anim ? `${anim.fps} fps; ${anim.running} CSS/Web animation(s) running${direct != null ? `; the same site loaded directly: ${direct} fps` : ""}` : "not measurable"})`);
        await fr.evaluate(() => scrollTo({ top: 0, behavior: "instant" })).catch(() => {});
      }
      // Controls are reachable: each visible explorer control is the topmost element at its own centre.
      const covered = [];
      for (const sel of ["[data-pfx-prev]", "[data-pfx-next]", "[data-pfx-reset]", ".pfx__slide:not([inert]) .pfx__links a", "[data-pfx-mode]"]) {
        const loc = p.locator(sel), m = await loc.count();
        for (let k = 0; k < m; k++) {
          const el = loc.nth(k);
          if (!(await el.isVisible().catch(() => false))) continue;
          await el.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" })); await sleep(120);
          const hit = await el.evaluate((e) => { const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !t ? "nothing" : e.contains(t) || t.contains(e) ? "" : (t.closest("[data-cb]") ? "assistant widget" : `${t.tagName.toLowerCase()}${t.className ? "." + String(t.className).split(" ")[0] : ""}`); });
          if (hit) covered.push(`${sel}#${k} under ${hit}`);
        }
      }
      ok(covered.length === 0, `${tag}: explorer buttons and links are not covered (assistant widget or other)${covered.length ? ` — ${covered.join(", ")}` : ""}`);
      const ov = await overflow();
      ok(ov <= 1, `${tag}: no horizontal overflow (${ov}px)`);
      await p.locator(".pfx").first().evaluate((e) => e.scrollIntoView({ block: "start", behavior: "instant" })); await sleep(200);
      await p.screenshot({ path: `${out}/${label.replace(/\s+/g, "-")}-${i + 1}.jpg`, type: "jpeg", quality: 70 });
    }
  } catch (e) { ok(false, `${label}: ${String(e.message).split("\n")[0].slice(0, 200)}`); }
  await ctx.close();
}
await b.close();
console.log(failed ? `${failed} viewport check(s) failed` : `portfolio verified at 1440 / 1280 / 820 / 390 / 320 px on ${base}`);
process.exit(failed ? 1 : 0);
