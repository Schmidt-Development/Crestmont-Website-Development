// Real-browser checks of the portfolio explorer, shared by scripts/frontend-browser-check.mjs (hosted preview) and
// local verification. Every check reports through ok(cond, message); nothing here types credentials or stores data.
//
// For every explorer location (home, portfolio, each case study) and every project:
//   • the frame shows the site's full width (no horizontal crop), the arrows sit outside the frame, and the state is
//     reported honestly: "interactive" only after the demo's origin-checked handshake (or, for the REAL live website,
//     once the verified live frame has loaded), otherwise the screenshot.
// For every interactive demo (portfolio page, desktop and phone):
//   • wheel and touch scrolling over the demo scroll the demo, to its end, while Crestmont's page stays still — also
//     when the gesture continues past either boundary; scrolling outside the explorer scrolls the page normally;
//   • internal navigation stays inside the demo's own origin; Reset returns it to its start page;
//   • desktop / tablet / mobile controls change the rendered viewport; a forged message cannot relabel the frame.
// For every NATIVE LIVE website (the real production site in a frame, data-kind="live") the scrolling, reload and device
// checks are the same, and navigation is checked as the real site works (checkLiveSite, 2026-11-18 acceptance fix):
//   • its sensitive pages (sign-in, accounts, owner/admin, booking/applications, checkout, billing, payment, API) still
//     refuse framing, read from their own headers, and a tap on one inside the frame never loads it there nor moves
//     Crestmont — the site's framed-mode handler opens it in a new tab (the real page is never requested; a stub with
//     the same refusing headers answers);
//   • a PUBLIC page that permits framing, when the site links one, loads inside the frame — never a sensitive route;
//     a one-page site's in-page link moves the site only; a site with neither is recorded as such and a real click is
//     shown to reach the site instead;
//   • the label stays the site's own host (a cross-origin page cannot be observed, and Crestmont never requires a live
//     site to send its demo messages); forged messages — from Crestmont's window AND from the live site itself — change
//     nothing.

import { FLOWS } from "./preview-demo-flows.mjs";

const READY_MS = 25_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until the active slide is interactive, explicitly unavailable, or has no demo. */
async function settle(p) {
  const t0 = Date.now();
  for (;;) {
    const s = await p.evaluate(() => {
      const sl = document.querySelector(".pfx__slide:not([inert])");
      if (!sl.dataset.frameUrl && !sl.dataset.demoUrl && !sl.dataset.remoteSlug) return "no-demo";
      // Mode B (remote browser): interactive once the live picture is drawn; refused (busy, budget) is reported as such.
      if (sl.dataset.remoteSlug && sl.dataset.remoteState === "unavailable") return "unavailable";
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
    const media = [...sl.querySelectorAll("[data-pfx-stage] > iframe, [data-pfx-stage] > canvas, [data-pfx-stage] > img")].filter((e) => getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden" && e.getBoundingClientRect().width > 0);
    const top = sl.classList.contains("is-ready") ? media.find((m) => m.tagName === "IFRAME" || m.tagName === "CANVAS") : media.find((m) => m.tagName === "IMG");
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
    // Readable title and description beside the links and mode label (Owner, 2026-11-18: long labels squeezed them).
    const lay = await p.evaluate(() => {
      const s = document.querySelector(".pfx__slide:not([inert])"), w = (sel) => s.querySelector(sel)?.getBoundingClientRect().width ?? 0;
      return { meta: w(".pfx__meta"), desc: w(".pfx__desc"), links: w(".pfx__links"), vw: innerWidth };
    });
    const stacked = lay.vw <= 1000, share = stacked ? 0.85 : 0.5;
    ok(lay.meta > 0 && lay.desc >= lay.meta * share && (stacked || lay.links <= lay.meta * 0.42), `${label} ${path} · ${g.name}: readable layout — description ${Math.round(lay.desc)} of ${Math.round(lay.meta)} px (≥ ${share * 100}%), links ${Math.round(lay.links)} px`);
    // Unavailable: say why, from the runner's side — the demo's own page (not /__demo/info, which answers without the
    // site or its database): HTTP status, time to answer, and whether the page carries the handshake script.
    let why = "";
    if (state === "unavailable") {
      const demoUrl = await p.evaluate(() => { const s = document.querySelector(".pfx__slide:not([inert])"); return s?.dataset.demoUrl || s?.dataset.frameUrl || ""; });
      if (demoUrl) {
        const t0 = Date.now();
        try {
          const r = await p.context().request.get(demoUrl, { timeout: 25_000, maxRedirects: 3 });
          const body = await r.text().catch(() => "");
          why = `; demo page ${r.status()} in ${Date.now() - t0} ms${/\/__demo\/embed\.js/.test(body) ? ", handshake script present" : ", NO handshake script"}`;
        } catch (e) { why = `; demo page did not answer within ${Math.round((Date.now() - t0) / 1000)} s (${String(e.message).split("\n")[0].slice(0, 80)})`; }
      }
    }
    ok(state !== "loading", `${label} ${path} · ${g.name}: state reported — ${state}${state === "unavailable" ? ` ("${g.status.slice(0, 90)}"${why})` : ""}`);
  }
  return states;
}

const outerY = (p) => p.evaluate(() => Math.round(scrollY));
const demoFrame = (p, origin) => p.frames().find((f) => f.url().startsWith(origin));

/** Scrolling, navigation, reset and controls for one interactive slide (the active one on the page). */
// headersOf(url) → {status, headersArray}: how a linked page's own framing headers are read (default: a visitor's GET
// from the runner; the local regression harness answers from its fixtures, which request routing cannot reach).
const visitorGet = (p) => async (url) => {
  const r = await p.context().request.get(url, { timeout: 20_000, maxRedirects: 5, failOnStatusCode: false });
  const out = { status: r.status(), headersArray: r.headersArray() };
  await r.dispose().catch(() => {});
  return out;
};
export async function checkInteractive(p, label, ok, { touch = false, headersOf = null } = {}) {
  const info = await p.evaluate(() => { const s = document.querySelector(".pfx__slide:not([inert])"); return { name: s.dataset.name, origin: s.dataset.frameOrigin || s.dataset.demoOrigin, url: s.dataset.frameUrl || s.dataset.demoUrl, live: s.dataset.kind === "live" }; });
  const tag = `${label} · ${info.name}${info.live ? " (live website)" : ""}`;
  const fr = demoFrame(p, info.origin);
  if (!fr) { ok(false, `${tag}: demo frame not found`); return; }
  const iframe = p.locator(".pfx__slide:not([inert]) iframe.pfx__frame");
  // Bring the whole frame into view, then scroll inside it.
  await iframe.evaluate((el) => el.scrollIntoView({ block: "center" })); await sleep(300);
  const box = await iframe.boundingBox();
  const cx = box.x + box.width / 2, cy = touch ? box.y + box.height / 2 : box.y + Math.min(box.height / 2, 200);
  const y0 = await outerY(p);
  // The demo's page scroll. A native live site may instead scroll inside its own container (an "app shell": the document
  // does not scroll, a full-height element does) — then that container is what a visitor scrolls (live sites only).
  const inner = () => fr.evaluate((live) => {
    const d = { y: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight), where: "page" };
    if (!live) return d;
    // The viewport scrolls unless overflow hides it (html, or body propagated when html is visible) — as browsers decide.
    const ov = (e) => getComputedStyle(e).overflowY, h = ov(document.documentElement);
    const pageScrolls = d.max > 0 && !/hidden|clip/.test(h) && !(h === "visible" && document.body && /hidden|clip/.test(ov(document.body)));
    if (pageScrolls) return d;
    let best = null;
    for (const e of document.querySelectorAll("body *")) {
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(e).overflowY)) continue;
      const m = e.scrollHeight - e.clientHeight;
      if (m > 2 && (!best || m > best.m)) best = { e, m };
    }
    if (!best) return { ...d, max: 0, where: "nothing scrollable" };
    return { y: Math.round(best.e.scrollTop), max: Math.round(best.m), where: `its scroll container <${best.e.tagName.toLowerCase()}${best.e.id ? "#" + best.e.id : ""}>` };
  }, info.live);
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
  // A live page can still be growing after load (late content): if it shows nothing to scroll, try a gesture first and
  // measure again before recording that it fits.
  const first = await inner();
  let start = first;
  if (info.live && first.max <= 0) { await gesture(600, 2); start = await inner(); }
  let end = start;
  for (let k = 0; k < (touch ? 80 : 30) && end.y < end.max - 2; k++) { await gesture(600, 3); end = await inner(); }
  if (info.live && end.max <= 0) ok(true, `${tag}: the live page fits the frame at this size — nothing to scroll (no scrollable container, also after a gesture); gestures below check Crestmont stays still`);
  else ok(end.y > first.y && end.y >= end.max - 2, `${tag}: ${touch ? "touch" : "wheel"} scrolling reaches the end of the ${info.live ? `live site (${end.where})` : "demo page"} (${first.y} → ${end.y} of ${end.max}px)`);
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
  // The page must scroll; how long it took is reported (a heavy framed site can delay Crestmont's own scrolling on a
  // busy machine — a performance observation, not a pass by itself: it must still scroll within 3 s).
  const before = await outerY(p), t0 = Date.now(); await p.mouse.wheel(0, 300);
  let movedOut = false; for (let k = 0; k < 30 && !movedOut; k++) { await sleep(100); movedOut = (await outerY(p)) !== before; }
  const lag = Date.now() - t0;
  ok(movedOut, `${tag}: scrolling outside the explorer scrolls the page${movedOut ? ` (after ${lag} ms${lag > 1000 ? " — slow: the framed site keeps the machine busy" : ""})` : " (not within 3 s)"}`);
  await iframe.evaluate((el) => el.scrollIntoView({ block: "center" })); await sleep(300);

  // A native live website (the real production site in a frame) is checked as what it is — its own navigation, its own
  // security headers, no Crestmont demo protocol (checkLiveSite below). Everything in the else-branch is the isolated
  // demo's contract and is unchanged.
  if (info.live) await checkLiveSite(p, fr, info, tag, ok, inner, headersOf ?? visitorGet(p));
  else {
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
    // A visible in-page link a visitor can tap (not a hidden skip link): bring it into the site's own viewport with
    // window.scrollTo — scrollIntoView would also scroll Crestmont's page and spoil the measurement.
    const anchor = await fr.evaluate(() => {
      for (const a of document.querySelectorAll("a[href^='#']")) {
        if (a.getAttribute("href").length < 2 || !a.getClientRects().length || getComputedStyle(a).visibility === "hidden") continue;
        const dest = document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
        if (!dest || Math.abs(dest.getBoundingClientRect().top - a.getBoundingClientRect().top) < innerHeight / 2) continue; // must actually move the page
        const r0 = a.getBoundingClientRect();
        if (r0.width < 1 || r0.height < 1) continue;
        scrollTo({ top: Math.max(0, r0.top + scrollY - innerHeight / 2), behavior: "instant" });
        const r = a.getBoundingClientRect();
        if (document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("a") !== a) continue;
        a.setAttribute("data-pfx-probe", ""); return a.getAttribute("href");
      }
      return null;
    });
    await sleep(300);
    const yBefore = await outerY(p), dBefore = (await inner()).y;
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
  // Forged messages cannot relabel the frame. First let the demo's own handshake for the page it just navigated to
  // arrive: the frame URL changes before the new page's embed posts "navigate", and that legitimate update landing
  // inside the check's window was reported as a forgery being accepted (hosted desktop BLM, deploy #63).
  const urlText = () => p.locator(".pfx__slide:not([inert]) [data-pfx-url]").textContent().then((t) => (t || "").trim()).catch(() => "");
  const expected = () => { const f = demoFrame(p, info.origin); if (!f) return null; const u = new URL(f.url()); return u.host + (u.pathname === "/" ? "" : u.pathname); };
  let lbl = await urlText(), since = Date.now();
  for (const t0 = Date.now(); Date.now() - t0 < 15_000; await sleep(200)) {
    const now = await urlText();
    if (now !== lbl) { lbl = now; since = Date.now(); }
    if (lbl === expected() && Date.now() - since >= 1000) break;
  }
  const settled = lbl === expected();
  // 1) from Crestmont's own window (not an approved demo origin), also malformed and unknown-type payloads;
  // 2) from a frame of the APPROVED demo origin that is not the explorer's own frame (forged source): its embed posts a
  //    real "navigate" for /__demo/leave (with a valid ?to=, so the page is a 200 — a bare /__demo/leave is the demo's
  //    own 400 "link not available" page, which deploy #64 reported as console errors on /portfolio). None may change the label; neither forged destination may ever appear.
  await p.evaluate((origin) => {
    const forged = { source: "crestmont-demo", type: "navigate", href: "https://attacker.example/x" };
    window.postMessage(forged, "*");
    window.postMessage("crestmont-demo navigate https://attacker.example/x", "*");
    window.postMessage([forged], "*");
    window.postMessage({ ...forged, type: "takeover" }, "*");
    const f = document.createElement("iframe"); f.hidden = true; f.setAttribute("data-pfx-forged", "");
    if (origin) { f.src = origin + "/__demo/leave?to=" + encodeURIComponent("https://example.com/"); document.body.append(f); } // a valid (200) demo page
  }, info.live ? "" : info.origin);
  await sleep(4000);
  await p.evaluate(() => document.querySelector("[data-pfx-forged]")?.remove());
  const after = await urlText();
  ok(settled && after === lbl && !/attacker|__demo\/leave/i.test(after), `${tag}: messages from other origins are ignored (label "${lbl}" → "${after}"${settled ? "" : "; the demo's own label never settled on its page"})`);

  }

  // Reset returns to the start page, re-announced by the demo.
  await p.locator("[data-pfx-reset]").first().click();
  let reset = false;
  for (let k = 0; k < 60 && !reset; k++) { await sleep(300); const f3 = demoFrame(p, info.origin); reset = !!f3 && new URL(f3.url()).pathname === new URL(info.url).pathname && (await p.evaluate(() => document.querySelector(".pfx__slide:not([inert])").classList.contains("is-ready"))); }
  ok(reset, `${tag}: ${info.live ? "Reload returns the live website to its home page" : "Reset returns the demo to its start page"}`);

  // Device controls change the rendered viewport (CSS px inside the frame).
  const widths = {};
  for (const m of ["mobile", "tablet", "desktop"]) {
    await p.locator(`[data-pfx-mode="${m}"]`).first().click(); await sleep(500);
    const f4 = demoFrame(p, info.origin); widths[m] = f4 ? await f4.evaluate(() => innerWidth).catch(() => 0) : 0;
  }
  ok(widths.mobile === 390 && widths.tablet === 820 && widths.desktop === 1440, `${tag}: device controls render 390 / 820 / 1440px (${widths.mobile} / ${widths.tablet} / ${widths.desktop})`);
}

// ── Native live websites ──
// Sensitive routes by the framing standard every Crestmont-built site follows (docs/frontend/PORTFOLIO.md §Real websites
// first): these never load inside a frame, and the check never navigates the frame into one.
export const SENSITIVE_ROUTE = /(^|\/)(log-?in|log-?out|sign-?in|sign-?up|sign-?out|register|auth|oauth|sso|account|accounts|my-account|portal|owner|admin|staff|dashboard|checkout|cart|billing|pay|payment|payments|subscribe|subscription|reset-password|password|token|api|book|booking|bookings|appointment|apply|application|applications|quote|quotes|reserve|reservation|reservations)(\/|$|\.)/i;

/** Whether a response's own headers let `top` (Crestmont's origin) frame it — the browser's rule: an enforced CSP
 *  frame-ancestors (every policy must allow) wins; without one, X-Frame-Options DENY / SAMEORIGIN refuses. */
export function framingVerdict(headersArray, top) {
  const all = (n) => headersArray.filter((h) => h.name.toLowerCase() === n).map((h) => h.value);
  const xfo = all("x-frame-options").join(",").trim().toUpperCase();
  const lists = all("content-security-policy").flatMap((v) => v.split(",")).map((pol) => /(?:^|;)\s*frame-ancestors\s*([^;]*)/i.exec(pol)?.[1].trim()).filter((x) => x !== undefined);
  const permits = (l) => { const src = l.split(/\s+/).filter(Boolean); return !src.includes("'none'") && (src.includes(top) || src.includes("*") || src.includes("https:") || src.includes(top + "/")); };
  const allowed = lists.length ? lists.every(permits) : !/DENY|SAMEORIGIN/.test(xfo);
  return { allowed, xfo: xfo || "none", fa: lists.length ? lists.join(" | ") : "none sent" };
}

/** Navigation, protected routes and message hardening of the active NATIVE LIVE slide (the real production website). */
export async function checkLiveSite(p, fr, info, tag, ok, inner, headersOf) {
  const topUrl = p.url(), top = new URL(topUrl).origin, host = new URL(info.url).host;
  const frameNow = () => demoFrame(p, info.origin);
  // 1) Inventory of what the real page offers (no clicks yet).
  const inv = await fr.evaluate(() => {
    const out = { same: [], external: 0, other: 0, anchors: 0 };
    for (const a of document.querySelectorAll("a[href]")) {
      const raw = a.getAttribute("href") || "";
      if (raw.startsWith("#")) { if (raw.length > 1) out.anchors++; continue; }
      let u; try { u = new URL(a.href); } catch { continue; }
      if (!/^https?:$/.test(u.protocol)) { out.other++; continue; } // tel:, mailto:, …
      if (u.origin !== location.origin) { out.external++; continue; }
      if (u.pathname === location.pathname) continue;
      if (!out.same.includes(u.pathname)) out.same.push(u.pathname);
    }
    return out;
  });
  // 2) Each linked page's own framing headers, read like a visitor's GET (the browser enforces exactly these).
  const pages = [];
  for (const path of inv.same.slice(0, 16)) {
    let v;
    try {
      const r = await headersOf(info.origin + path);
      v = { status: r.status, ...framingVerdict(r.headersArray, top) };
    } catch (e) { v = { status: 0, allowed: false, xfo: "?", fa: `not answered (${String(e.message).split("\n")[0].slice(0, 60)})` }; }
    pages.push({ path, sensitive: SENSITIVE_ROUTE.test(path), ...v });
  }
  const isPublic = (x) => !x.sensitive && x.allowed && x.status >= 200 && x.status < 300;
  const protectedPages = pages.filter((x) => x.sensitive || (x.status >= 200 && x.status < 400 && !x.allowed));
  const fmt = (x) => `${x.path} HTTP ${x.status}, XFO ${x.xfo}, frame-ancestors ${x.fa}`;
  console.log(`NOTE ${tag}: links on the home page — ${inv.same.length} same-site page(s) [${inv.same.join(" ") || "none"}], ${inv.anchors} in-page anchor(s), ${inv.external} external, ${inv.other} tel:/mailto:`);
  for (const x of pages) console.log(`NOTE ${tag}: ${isPublic(x) ? "public, framable" : x.sensitive ? "sensitive" : "not framable / not answered"} — ${fmt(x)}`);

  // 3) Sensitive routes keep refusing framing (a security regression otherwise). Unanswered = not provable → reported.
  for (const x of pages.filter((y) => y.sensitive)) {
    const answered = x.status >= 200 && x.status < 400;
    ok(answered ? !x.allowed : true, `${tag}: sensitive route ${x.path} ${answered ? (x.allowed ? "PERMITS framing by Crestmont — must refuse" : "still refuses framing") : "did not answer the runner (not provable here)"} (${fmt(x)})`);
  }

  // 4) A tap on a protected link inside the frame: never loaded in the frame, Crestmont never moves, and the site opens
  //    it in a new tab. The real page is never requested: a stub with the same refusing headers answers instead.
  const tapProtected = protectedPages.find((x) => x.status >= 200 && x.status < 400);
  if (tapProtected) {
    const href = info.origin + tapProtected.path;
    const handler = (r) => r.fulfill({ status: 200, headers: { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" }, body: "<!doctype html><title>stub</title>protected page (test stub — the real page was not requested)" });
    const match = (u) => { try { const x = new URL(u); return x.origin === info.origin && x.pathname === tapProtected.path; } catch { return false; } };
    await p.context().route(match, handler);
    const popups = [];
    const onPage = (np) => popups.push(np);
    p.context().on("page", onPage);
    const found = await fr.evaluate((path) => {
      const a = [...document.querySelectorAll("a[href]")].find((x) => { try { return new URL(x.href).pathname === path && x.getClientRects().length && getComputedStyle(x).visibility !== "hidden"; } catch { return false; } });
      if (!a) return false; a.setAttribute("data-pfx-protected", ""); return true;
    }, tapProtected.path).catch(() => false);
    if (found) {
      const y0 = await outerY(p);
      await fr.locator("[data-pfx-protected]").first().click({ noWaitAfter: true, timeout: 5000 }).catch(() => fr.evaluate(() => document.querySelector("[data-pfx-protected]")?.click()).catch(() => {}));
      await sleep(2500);
      const f2 = frameNow(), inFrame = f2 ? new URL(f2.url()).pathname : "";
      const popup = popups.map((x) => x.url()).find(match) ?? popups.map((x) => x.url())[0] ?? "";
      const stayed = !!f2 && inFrame !== tapProtected.path;
      ok(stayed && p.url() === topUrl, `${tag}: protected link ${tapProtected.path} never loads inside the frame (${f2 ? `frame still on ${host}${inFrame === "/" ? "" : inFrame}` : "the frame left the site"}; Crestmont URL unchanged${(await outerY(p)) === y0 ? ", page still" : ""}) — ${popup ? `opened in a new tab (${new URL(popup).pathname})` : "no new tab opened"}`);
      for (const x of popups) await x.close().catch(() => {});
      // Reset, then wait until the live site is really back in the frame (a heavy site takes longer than a fixed pause).
      if (!stayed) { await p.locator("[data-pfx-reset]").first().click(); for (let k = 0; k < 60; k++) { await sleep(500); const f3 = frameNow(); if (f3 && await f3.evaluate(() => document.readyState !== "loading" && !!document.body).catch(() => false)) break; } await sleep(500); }
    } else console.log(`NOTE ${tag}: protected link ${tapProtected.path} is linked but not tappable on this layout — its headers are checked above`);
    p.context().off("page", onPage);
    await p.context().unroute(match, handler);
  }

  // 5) Public navigation, where the site offers it.
  let f = frameNow() ?? fr;
  const pub = pages.find(isPublic);
  let target = null;
  if (pub) {
    target = await f.evaluate((path) => {
      const a = [...document.querySelectorAll("a[href]")].find((x) => {
        try { if (new URL(x.href).pathname !== path || x.target === "_blank") return false; } catch { return false; }
        if (!x.getClientRects().length || getComputedStyle(x).visibility === "hidden") return false;
        x.scrollIntoView({ block: "center", behavior: "instant" }); const r = x.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("a") === x;
      });
      if (!a) return null; a.setAttribute("data-pfx-probe", ""); return path;
    }, pub.path).catch(() => null);
  }
  if (target) {
    await f.locator("[data-pfx-probe]").first().click({ noWaitAfter: true }).catch(() => {});
    let moved = false;
    for (let k = 0; k < 40 && !moved; k++) { await sleep(250); const f2 = frameNow(); moved = !!f2 && new URL(f2.url()).pathname === target; }
    ok(moved && p.url() === topUrl, `${tag}: public navigation to ${target} loads inside the frame (Crestmont URL unchanged; that page permits framing by Crestmont)`);
  } else {
    const anchor = await inPageAnchor(f);
    await sleep(300);
    if (anchor) {
      const yBefore = await outerY(p), d0 = (await inner()).y;
      await f.locator("[data-pfx-probe]").first().click().catch(() => {}); await sleep(1200);
      const dAfter = (await inner()).y, yAfter = await outerY(p);
      // Evidence for a Crestmont movement: what the site did after the click (focus moved into a field, which the browser
      // reveals in every scrolling ancestor, or a plain fragment jump).
      const focus = yAfter === yBefore ? null : await f.evaluate(() => { const a = document.activeElement, r = a?.getBoundingClientRect(); return { field: !!a && a.matches("input, select, textarea, [contenteditable='true']"), desc: `<${a?.tagName.toLowerCase()}${a?.id ? "#" + a.id : ""}>`, top: r ? r.top : 0, bottom: r ? r.bottom : 0 }; }).catch(() => null);
      // The one accepted Crestmont movement: the site moved focus into a form field in answer to the visitor's click, and
      // the browser revealed that field in every scrolling ancestor (standard focus behaviour, not a scroll gesture
      // leaking). It must be smaller than the frame and leave the field visible. Anything else fails.
      let revealed = false;
      if (focus?.field) {
        const box = await p.locator(".pfx__slide:not([inert]) iframe.pfx__frame").boundingBox(), vh = p.viewportSize()?.height ?? 0;
        const k = box ? box.width / (await f.evaluate(() => innerWidth)) : 1;
        const fieldTop = box ? box.y + focus.top * k : -1, fieldBottom = box ? box.y + focus.bottom * k : -1;
        revealed = !!box && Math.abs(yAfter - yBefore) < box.height && fieldTop >= 0 && fieldBottom <= vh;
      }
      const why = focus ? `; the site moved focus to ${focus.desc}${revealed ? " and the browser revealed that field — focus behaviour, not a scroll leak" : ""}` : "";
      ok(dAfter !== d0 && (yAfter === yBefore || revealed) && p.url() === topUrl, `${tag}: in-page link ${anchor} moves the live site${yAfter === yBefore ? " only" : ""} (site ${d0} → ${dAfter}px; Crestmont ${yBefore} → ${yAfter}px${why})`);
    } else {
      // Nothing public to navigate to: say so (never invent a link or enter a sensitive route) and show that a visitor's
      // click genuinely reaches the site — a real pointer click on non-interactive content inside the frame.
      console.log(`NOTE ${tag}: no public in-site navigation — ${inv.same.length} same-site link(s), all protected or not framable [${pages.map((x) => x.path).join(" ") || "none"}]; no in-page link that moves the page`);
      const iframe = p.locator(".pfx__slide:not([inert]) iframe.pfx__frame");
      const box = await iframe.boundingBox();
      f = frameNow() ?? f;   // the frame as it is now (it may have been reloaded above)
      // Any visible, non-interactive text — whatever the site's markup (div/span app shells included), as a visitor
      // would click; never a control, a link or a form field.
      const spot = await f.evaluate(() => {
        const INTERACTIVE = "a, button, input, select, textarea, label, summary, [role=button], [role=link], [onclick], [contenteditable=''], [contenteditable=true], [tabindex]:not([tabindex='-1'])";
        const safe = (hit) => !!hit && hit !== document.documentElement && hit !== document.body && !hit.closest(INTERACTIVE) && getComputedStyle(hit).cursor !== "pointer";
        const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue && n.nodeValue.trim().length >= 3 ? 1 : 3) });
        for (let n, k = 0; (n = tw.nextNode()) && k < 5000; k++) {
          const rg = document.createRange(); rg.selectNodeContents(n);
          for (const r of rg.getClientRects()) {
            if (r.width < 8 || r.height < 6 || r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) continue;
            const x = r.left + Math.min(6, r.width / 2), y = r.top + r.height / 2;
            if (safe(document.elementFromPoint(x, y))) { window.__pfxClicks = 0; addEventListener("click", () => window.__pfxClicks++, { capture: true }); return { x, y, w: innerWidth }; }
          }
        }
        return null;
      }).catch(() => null);
      if (spot && box) {
        const k = box.width / spot.w, y0 = await outerY(p);
        await p.mouse.click(box.x + spot.x * k, box.y + spot.y * k);
        let got = 0; for (let w = 0; w < 20 && !got; w++) { await sleep(150); got = await f.evaluate(() => window.__pfxClicks || 0).catch(() => 0); }
        ok(got > 0 && p.url() === topUrl && (await outerY(p)) === y0, `${tag}: no public in-site link to follow (recorded, not invented) — a real click reaches the live site (${got} click event${got === 1 ? "" : "s"} inside the frame; Crestmont unchanged)`);
      } else ok(false, `${tag}: no public in-site link and no visible content to click — the live site shows nothing interactive`);
    }
  }

  // 6) Messages. A native live site never speaks Crestmont's demo protocol and is not required to: the label is its
  //    own host (Crestmont cannot see a cross-origin page's path and never claims one). Forged messages from Crestmont's
  //    window and from the live site itself (it is not an approved demo origin) must change nothing.
  const urlText = () => p.locator(".pfx__slide:not([inert]) [data-pfx-url]").textContent().then((t) => (t || "").trim()).catch(() => "");
  const lbl = await urlText();
  await p.evaluate(() => {
    const forged = { source: "crestmont-demo", type: "navigate", href: "https://attacker.example/x" };
    window.postMessage(forged, "*");
    window.postMessage("crestmont-demo navigate https://attacker.example/x", "*");
    window.postMessage([forged], "*");
    window.postMessage({ ...forged, type: "takeover" }, "*");
  });
  const fl = frameNow();
  if (fl) await fl.evaluate(() => {
    for (const href of [location.origin + "/__forged-by-frame", "https://attacker.example/y"]) parent.postMessage({ source: "crestmont-demo", type: "navigate", href }, "*");
    parent.postMessage({ source: "crestmont-demo", type: "ready", href: location.origin + "/__forged-by-frame" }, "*");
  }).catch(() => {});
  await sleep(2500);
  const after = await urlText();
  ok(lbl === host && after === host && p.url() === topUrl, `${tag}: label stays the live site's host; forged messages from Crestmont's window and from the live site itself are ignored (label "${lbl}" → "${after}"; no demo messages required)`);
}

/** A visible, tappable in-page link whose target is far enough away to move the page; marks it data-pfx-probe. */
function inPageAnchor(fr) {
  return fr.evaluate(() => {
    for (const a of document.querySelectorAll("a[href^='#']")) {
      if (a.getAttribute("href").length < 2 || !a.getClientRects().length || getComputedStyle(a).visibility === "hidden") continue;
      const dest = document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
      if (!dest || Math.abs(dest.getBoundingClientRect().top - a.getBoundingClientRect().top) < innerHeight / 2) continue;
      const r0 = a.getBoundingClientRect();
      if (r0.width < 1 || r0.height < 1) continue;
      scrollTo({ top: Math.max(0, r0.top + scrollY - innerHeight / 2), behavior: "instant" });
      const r = a.getBoundingClientRect();
      if (document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("a") !== a) continue;
      a.setAttribute("data-pfx-probe", ""); return a.getAttribute("href");
    }
    return null;
  }).catch(() => null);
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
