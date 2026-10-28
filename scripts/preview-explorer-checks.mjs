// Real-browser checks of the portfolio explorer, shared by scripts/frontend-preview-browser.mjs (hosted preview) and
// local verification. Every check reports through ok(cond, message); nothing here types credentials or stores data.
//
// For every explorer location (home, portfolio, each case study) and every project:
//   • the frame shows the site's full width (no horizontal crop), the arrows sit outside the frame, and the state is
//     reported honestly: "interactive" only after the demo's origin-checked handshake, otherwise the screenshot.
// For every interactive demo (portfolio page, desktop and phone):
//   • wheel and touch scrolling over the demo scroll the demo, to its end, while Crestmont's page stays still — also
//     when the gesture continues past either boundary; scrolling outside the explorer scrolls the page normally;
//   • internal navigation stays inside the demo's own origin; Reset returns it to its start page;
//   • desktop / tablet / mobile controls change the rendered viewport; a forged message cannot relabel the frame.

import { FLOWS } from "./preview-demo-flows.mjs";

const READY_MS = 25_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until the active slide is interactive, explicitly unavailable, or has no demo. */
async function settle(p) {
  const t0 = Date.now();
  for (;;) {
    const s = await p.evaluate(() => {
      const sl = document.querySelector(".pfx__slide:not([inert])");
      if (!sl.dataset.demoUrl) return "no-demo";
      if (sl.classList.contains("is-ready")) return "interactive";
      if (sl.dataset.unavailable === "true") return "unavailable";
      return "loading";
    });
    if (s !== "loading" || Date.now() - t0 > READY_MS + 5000) return s;
    await sleep(400);
  }
}

async function frameGeometry(p) {
  return p.evaluate(() => {
    const root = document.querySelector(".pfx"), sl = root.querySelector(".pfx__slide:not([inert])");
    const scr = sl.querySelector("[data-pfx-screen]").getBoundingClientRect(), st = sl.querySelector("[data-pfx-stage]").getBoundingClientRect();
    const media = [...sl.querySelectorAll("[data-pfx-stage] > iframe, [data-pfx-stage] > img")].filter((e) => getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden" && e.getBoundingClientRect().width > 0);
    const top = sl.classList.contains("is-ready") ? media.find((m) => m.tagName === "IFRAME") : media.find((m) => m.tagName === "IMG");
    const prev = root.querySelector("[data-pfx-prev]")?.getBoundingClientRect(), next = root.querySelector("[data-pfx-next]")?.getBoundingClientRect();
    const m = top?.getBoundingClientRect();
    return {
      name: sl.dataset.name, mode: root.dataset.mode,
      full: !!m && Math.abs(m.left - st.left) <= 1.5 && Math.abs(m.width - st.width) <= 1.5,
      media: top ? `${top.tagName.toLowerCase()} ${Math.round(m.width)}×${Math.round(m.height)} in ${Math.round(st.width)}×${Math.round(st.height)}` : "none",
      // A tall frame left empty below a desktop-shaped screenshot (the "gap" defect).
      gap: !!m && top.tagName === "IMG" && root.dataset.mode === "desktop" && st.bottom - m.bottom > 2,
      arrowsOutside: !prev || !next || (prev.right <= scr.left + 1 && next.left >= scr.right - 1) || (prev.top >= scr.bottom - 1 && next.top >= scr.bottom - 1),
      status: sl.querySelector("[data-pfx-status]")?.textContent.trim() ?? "",
    };
  });
}

/** Frames + states for every project at one location. Returns {name: state}. */
export async function checkLocation(p, base, path, label, ok) {
  await p.goto(base + path, { waitUntil: "domcontentloaded" });
  const ex = p.locator(".pfx").first();
  if (!(await ex.count())) { ok(false, `${label} ${path}: explorer missing`); return {}; }
  await ex.scrollIntoViewIfNeeded(); await sleep(300);
  const n = await p.locator(".pfx__slide").count(), states = {};
  for (let i = 0; i < n; i++) {
    if (i) { await p.locator("[data-pfx-next]").first().click(); await sleep(700); }
    const state = await settle(p), g = await frameGeometry(p);
    states[g.name] = state;
    ok(g.full && !g.gap, `${label} ${path} · ${g.name}: full width, aspect kept (${g.mode}, ${g.media})`);
    ok(g.arrowsOutside, `${label} ${path} · ${g.name}: switching arrows sit outside the frame`);
    ok(state !== "loading", `${label} ${path} · ${g.name}: state reported — ${state}${state === "unavailable" ? ` ("${g.status.slice(0, 90)}")` : ""}`);
  }
  return states;
}

const outerY = (p) => p.evaluate(() => Math.round(scrollY));
const demoFrame = (p, origin) => p.frames().find((f) => f.url().startsWith(origin));

/** Scrolling, navigation, reset and controls for one interactive slide (the active one on the page). */
export async function checkInteractive(p, label, ok, { touch = false } = {}) {
  const info = await p.evaluate(() => { const s = document.querySelector(".pfx__slide:not([inert])"); return { name: s.dataset.name, origin: s.dataset.demoOrigin, url: s.dataset.demoUrl }; });
  const tag = `${label} · ${info.name}`;
  const fr = demoFrame(p, info.origin);
  if (!fr) { ok(false, `${tag}: demo frame not found`); return; }
  const iframe = p.locator(".pfx__slide:not([inert]) iframe.pfx__frame");
  // Bring the whole frame into view, then scroll inside it.
  await iframe.evaluate((el) => el.scrollIntoView({ block: "center" })); await sleep(300);
  const box = await iframe.boundingBox();
  const cx = box.x + box.width / 2, cy = touch ? box.y + box.height / 2 : box.y + Math.min(box.height / 2, 200);
  const y0 = await outerY(p);
  const inner = () => fr.evaluate(() => ({ y: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight) }));
  const cdp = touch ? await p.context().newCDPSession(p) : null;
  const gesture = async (dy, times) => {
    for (let i = 0; i < times; i++) {
      if (cdp) {
        // A real finger swipe (touchstart → touchmoves → touchend); upward swipe scrolls the content down.
        const x = Math.round(cx), y = Math.round(cy), dir = dy > 0 ? -1 : 1, steps = 12, stepPx = Math.min(Math.abs(dy), 360) / steps;
        const sy = dy > 0 ? y + 160 : y - 160;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: sy }] });
        for (let k = 1; k <= steps; k++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: Math.round(sy + dir * k * stepPx) }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
      else { await p.mouse.move(cx, cy); await p.mouse.wheel(0, dy); }
      await sleep(cdp ? 120 : 60);
    }
    await sleep(400);
  };
  const start = await inner();
  let end = start;
  for (let k = 0; k < (touch ? 80 : 30) && end.y < end.max - 2; k++) { await gesture(600, 3); end = await inner(); }
  ok(end.y > start.y && end.y >= end.max - 2, `${tag}: ${touch ? "touch" : "wheel"} scrolling reaches the end of the demo page (${start.y} → ${end.y} of ${end.max}px)`);
  ok((await outerY(p)) === y0, `${tag}: Crestmont's page stays still while the demo scrolls`);
  await gesture(600, 4);
  ok((await outerY(p)) === y0, `${tag}: still stationary when the gesture continues past the demo's bottom`);
  for (let k = 0; k < (touch ? 80 : 30) && (await inner()).y > 0; k++) await gesture(-600, 3);
  await gesture(-600, 4);
  ok((await inner()).y === 0 && (await outerY(p)) === y0, `${tag}: back to the demo's top; still stationary past the top boundary`);
  if (cdp) await cdp.detach();

  // Scrolling outside the explorer scrolls the page normally.
  const head = await p.locator("h1").first().boundingBox();
  await p.mouse.move(20, Math.max(5, Math.min(head ? head.y : 40, 40)));
  const before = await outerY(p); await p.mouse.wheel(0, 300); await sleep(500);
  ok((await outerY(p)) !== before, `${tag}: scrolling outside the explorer scrolls the page`);
  await iframe.evaluate((el) => el.scrollIntoView({ block: "center" })); await sleep(300);

  // Internal navigation stays inside the demo.
  const topUrl = p.url();
  const target = await fr.evaluate(() => {
    const here = location.pathname;
    // A link a visitor can actually tap: same origin, rendered, and topmost at its own centre (not inside a closed menu).
    const a = [...document.querySelectorAll("a[href]")].find((x) => {
      try { const u = new URL(x.href); if (u.origin !== location.origin || u.pathname === here || u.pathname.startsWith("/__demo") || x.target === "_blank") return false; } catch { return false; }
      if (!x.getClientRects().length || getComputedStyle(x).visibility === "hidden") return false;
      x.scrollIntoView({ block: "center", behavior: "instant" }); const r = x.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("a") === x;
    });
    if (!a) return null; a.setAttribute("data-pfx-probe", ""); return new URL(a.href).pathname;
  });
  if (!target) {
    // A one-page site (Glassly): its navigation is in-page anchors — they must move the demo, never Crestmont.
    const anchor = await fr.evaluate(() => { const a = [...document.querySelectorAll("a[href^='#']")].find((x) => x.getAttribute("href").length > 1 && x.getBoundingClientRect().width > 0); if (!a) return null; a.setAttribute("data-pfx-probe", ""); return a.getAttribute("href"); });
    const yBefore = await outerY(p), dBefore = (await inner()).y;
    if (anchor) { await fr.locator("[data-pfx-probe]").first().evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" })); await sleep(300); }
    const d0 = (await inner()).y;
    if (anchor) { await fr.locator("[data-pfx-probe]").first().click().catch(() => {}); await sleep(1200); }
    const dAfter = (await inner()).y, yAfter = await outerY(p);
    ok(!!anchor && dAfter !== d0 && yAfter === yBefore && p.url() === topUrl, `${tag}: one-page site — in-page link ${anchor ?? "(none)"} moves the demo only (demo ${d0} → ${dAfter}px; Crestmont ${yBefore} → ${yAfter}px)`);
  } else {
    await fr.locator("[data-pfx-probe]").first().evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await fr.locator("[data-pfx-probe]").first().click({ noWaitAfter: true }).catch(() => {});
    let moved = false;
    for (let k = 0; k < 40 && !moved; k++) { await sleep(250); const f2 = demoFrame(p, info.origin); moved = !!f2 && new URL(f2.url()).pathname === target; }
    const label2 = await p.locator(".pfx__slide:not([inert]) [data-pfx-url]").textContent().catch(() => "");
    ok(moved && p.url() === topUrl, `${tag}: internal navigation to ${target} stays in the demo (Crestmont URL unchanged; frame shows ${label2?.trim()})`);
  }
  // A forged message from any other origin cannot relabel the frame.
  const lbl = await p.locator(".pfx__slide:not([inert]) [data-pfx-url]").textContent().catch(() => "");
  await p.evaluate(() => window.postMessage({ source: "crestmont-demo", type: "navigate", href: "https://attacker.example/x" }, "*")); await sleep(200);
  ok((await p.locator(".pfx__slide:not([inert]) [data-pfx-url]").textContent().catch(() => "")) === lbl, `${tag}: messages from other origins are ignored`);

  // Reset returns to the start page, re-announced by the demo.
  await p.locator("[data-pfx-reset]").first().click();
  let reset = false;
  for (let k = 0; k < 60 && !reset; k++) { await sleep(300); const f3 = demoFrame(p, info.origin); reset = !!f3 && new URL(f3.url()).pathname === new URL(info.url).pathname && (await p.evaluate(() => document.querySelector(".pfx__slide:not([inert])").classList.contains("is-ready"))); }
  ok(reset, `${tag}: Reset returns the demo to its start page`);

  // Device controls change the rendered viewport (CSS px inside the frame).
  const widths = {};
  for (const m of ["mobile", "tablet", "desktop"]) {
    await p.locator(`[data-pfx-mode="${m}"]`).first().click(); await sleep(500);
    const f4 = demoFrame(p, info.origin); widths[m] = f4 ? await f4.evaluate(() => innerWidth).catch(() => 0) : 0;
  }
  ok(widths.mobile === 390 && widths.tablet === 820 && widths.desktop === 1440, `${tag}: device controls render 390 / 820 / 1440px (${widths.mobile} / ${widths.tablet} / ${widths.desktop})`);
}

/** Runs the active demo's simulated transaction inside the explorer frame, then resets the demo. */
export async function checkFlow(p, label, ok) {
  const info = await p.evaluate(() => { const s = document.querySelector(".pfx__slide:not([inert])"); return { name: s.dataset.name, origin: s.dataset.demoOrigin }; });
  const flow = FLOWS[info.name], fr = demoFrame(p, info.origin);
  if (!flow) { ok(false, `${label} · ${info.name}: no simulated-transaction flow defined`); return; }
  if (!fr) { ok(false, `${label} · ${info.name}: demo frame not found`); return; }
  await p.locator(".pfx__slide:not([inert]) iframe.pfx__frame").evaluate((el) => el.scrollIntoView({ block: "center" })); await sleep(300);
  const topUrl = p.url(), y0 = await outerY(p);
  try {
    const what = await flow(fr);
    const y1 = await outerY(p);
    ok(p.url() === topUrl && new URL(fr.url()).origin === info.origin, `${label} · ${info.name}: simulated transaction completed inside the frame — ${what}`);
    ok(y1 === y0, `${label} · ${info.name}: Crestmont's page stayed still through the whole transaction (${y0} → ${y1}px)`);
  } catch (e) { ok(false, `${label} · ${info.name}: simulated transaction failed — ${String(e.message).split("\n")[0].slice(0, 160)}`); }
  await p.locator("[data-pfx-reset]").first().click(); await sleep(1500);
  await p.evaluate((y) => scrollTo(0, y), y0);
}
