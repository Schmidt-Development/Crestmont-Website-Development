// Real-browser verification of a native embed (Owner, 2026-11-18: "Do not assume deployment success means embedding
// success"). A fresh, isolated Chromium (Cloudflare Browser Run in production; a local Chromium in development and CI)
// opens Crestmont's own verification page — the live website in the same sandboxed iframe the portfolio uses, served
// from this Crestmont origin — and checks, inside the framed page itself:
//   frame      the browser actually loaded the live origin in the frame (not refused, not an error page);
//   content    real page content is visible (text, images, media) — not blank, not stuck loading;
//   javascript the page runs: animation frames keep coming; uncaught errors are reported;
//   canvas     every large canvas (2D or WebGL — e.g. a 3D globe) actually draws pixels; whether it animates is recorded;
//   scroll     a real wheel gesture scrolls the site (or the page fits its frame);
//   click      a real click reaches the site;
//   mobile     the page renders content at a 390 px phone width without breaking out sideways.
// Nothing is typed, submitted or bought; no cookies are kept (a throwaway browser context). One verification lasts
// well under a minute and is only run on onboarding transitions or an explicit staff re-check (orchestrator.ts caps
// how many run per day), so it stays inside the Browser Run allowance already used by the portfolio.
import { Cdp, type SocketLike } from "../remote-browser/cdp.ts";

export interface BrowserHandle { cdp: Cdp; close(): void | Promise<void> }
export type OpenBrowser = () => Promise<BrowserHandle>;
type Fixture = { status: number; headers: Record<string, string>; body: string } | null;
/** Development and tests only: answers the verification browser's requests for TEST DATA sites (never in production). */
export type FixtureResponder = (url: string) => Fixture | Promise<Fixture>;
export interface Check { name: string; ok: boolean; detail: string }
export interface VerifyResult { ok: boolean; checks: Check[]; summary: string; at: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What runs inside the framed live page: one JSON report (no side effects beyond a click counter it removes). */
const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && document.readyState !== "complete"; i++) await sleep(250);
  await sleep(1500);
  const text = (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim().length;
  const media = [...document.querySelectorAll("img, video, canvas, svg, picture")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 16 && r.height > 16 && r.bottom > 0 && r.top < innerHeight; }).length;
  const frames = await new Promise((res) => { let n = 0; const t = performance.now(); const g = () => { n++; if (performance.now() - t < 1000) requestAnimationFrame(g); else res(n); }; requestAnimationFrame(g); });
  const anims = document.getAnimations ? document.getAnimations().filter((a) => a.playState === "running").length : 0;
  const big = [...document.querySelectorAll("canvas")].filter((c) => { const r = c.getBoundingClientRect(); return r.width >= 96 && r.height >= 96 && c.width > 0 && c.height > 0; }).slice(0, 3);
  const sample = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(big.map((c) => {
    try {
      const s = document.createElement("canvas"); s.width = 32; s.height = 32; const x = s.getContext("2d");
      x.drawImage(c, 0, 0, 32, 32); const d = x.getImageData(0, 0, 32, 32).data;
      const counts = new Map(); for (let i = 0; i < d.length; i += 4) { const k = d[i + 3] < 8 ? "t" : ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); counts.set(k, (counts.get(k) || 0) + 1); }
      let mode = null, max = 0; for (const [k, v] of counts) if (v > max) { max = v; mode = k; }
      let sig = 0; for (let i = 0; i < d.length; i += 4) sig = (sig * 31 + (d[i] >> 3) * 1031 + (d[i + 1] >> 3) * 37 + (d[i + 2] >> 3)) % 1000000007;
      return { drawn: Math.round((1 - max / 1024) * 1000) / 1000, transparent: mode === "t", sig };
    } catch (e) { return { error: String(e && e.message || e).slice(0, 80) }; }
  })))));
  const s1 = await sample(); await sleep(450); const s2 = await sample(); await sleep(450); const s3 = await sample();
  const canvases = big.map((c, i) => { const r = c.getBoundingClientRect(); const a = s1[i], b = s2[i], z = s3[i]; return { w: Math.round(r.width), h: Math.round(r.height), drawn: Math.max(a.drawn || 0, b.drawn || 0, z.drawn || 0), animated: !!(a.sig && (a.sig !== b.sig || b.sig !== z.sig)), error: a.error || null }; });
  let webgl = false; try { const t = document.createElement("canvas"); webgl = !!(t.getContext("webgl2") || t.getContext("webgl")); } catch { webgl = false; }
  const ov = (e) => getComputedStyle(e).overflowY, hv = ov(document.documentElement);
  const hidden = /hidden|clip/.test(hv) || (hv === "visible" && document.body && /hidden|clip/.test(ov(document.body)));
  let room = hidden ? 0 : document.documentElement.scrollHeight - innerHeight;
  for (const e of document.querySelectorAll("body *")) if (/(auto|scroll|overlay)/.test(getComputedStyle(e).overflowY)) room = Math.max(room, e.scrollHeight - e.clientHeight);
  let spot = null;
  for (const e of document.querySelectorAll("h1, h2, h3, p, li")) {
    const r = e.getBoundingClientRect();
    if (r.width < 40 || r.height < 10 || r.top < 0 || r.bottom > innerHeight) continue;
    const x = r.left + Math.min(16, r.width / 2), y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
    if (hit && !hit.closest("a, button, input, select, textarea, label, summary, [role=button], [onclick], [tabindex]")) { spot = { x: Math.round(x), y: Math.round(y) }; break; }
  }
  window.__crestmontClicks = 0; addEventListener("click", () => { window.__crestmontClicks++; }, { capture: true });
  return JSON.stringify({ title: document.title.slice(0, 120), text, media, frames, anims, canvases, webgl, room: Math.round(room), spot, width: innerWidth, overflowX: document.documentElement.scrollWidth - innerWidth });
})()`;

const SCROLLED = `(() => Math.round(scrollY) + [...document.querySelectorAll("body *")].reduce((a, e) => a + e.scrollTop, 0))()`;
const MOBILE = `(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 60 && document.readyState !== "complete"; i++) await sleep(250); await sleep(1200);
  return JSON.stringify({ text: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim().length, width: innerWidth, overflowX: document.documentElement.scrollWidth - innerWidth }); })()`;

class Page {
  private readonly cdp: Cdp; readonly session: string; readonly liveOrigin: string;
  frameSession: string | null = null; frameUrl = ""; errors = 0; private readonly fixture?: FixtureResponder;
  constructor(cdp: Cdp, session: string, liveOrigin: string, fixture?: FixtureResponder) {
    this.cdp = cdp; this.session = session; this.liveOrigin = liveOrigin; this.fixture = fixture;
    cdp.on("Target.attachedToTarget", (p, sid) => {
      const info = p.targetInfo as { type: string; url: string }, child = String(p.sessionId);
      if (sid !== this.session && sid !== this.frameSession) return;
      void (async () => {
        if (this.fixture) await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, child).catch(() => undefined);
        await cdp.send("Runtime.enable", {}, child).catch(() => undefined);
        await cdp.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => undefined);
        if (info.type === "iframe") { this.frameSession = child; this.frameUrl = info.url; }
      })();
    });
    cdp.on("Target.targetInfoChanged", (p) => { const i = p.targetInfo as { type: string; url: string }; if (i.type === "iframe" && this.frameSession && i.url) this.frameUrl = i.url; });
    cdp.on("Runtime.exceptionThrown", (_p, sid) => { if (sid && sid === this.frameSession) this.errors++; });
    if (fixture) cdp.on("Fetch.requestPaused", (p, sid) => void (async () => {
      const id = String(p.requestId);
      const fx = await Promise.resolve(fixture(String((p.request as { url: string }).url))).catch(() => null);
      if (fx) await cdp.send("Fetch.fulfillRequest", { requestId: id, responseCode: fx.status, responseHeaders: Object.entries(fx.headers).map(([name, value]) => ({ name, value })), body: btoa(unescape(encodeURIComponent(fx.body))) }, sid).catch(() => undefined);
      else await cdp.send("Fetch.continueRequest", { requestId: id }, sid).catch(() => undefined);
    })());
  }
  send(m: string, p: Record<string, unknown> = {}, sid = this.session) { return this.cdp.send(m, p, sid); }
  async evalIn(sid: string, expr: string): Promise<unknown> {
    const r = await this.cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluation failed");
    return r.result?.value;
  }
  /** Waits until the live origin is attached as the frame's own target (site isolation); then for it to finish. */
  async waitFrame(ms: number): Promise<boolean> {
    // The frame's target attaches before its document has a URL; ask the frame itself where it is.
    for (let t = 0; t < ms; t += 250) {
      if (this.frameSession) {
        const href = await this.cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, this.frameSession).then((r) => String((r as { result?: { value?: unknown } }).result?.value ?? "")).catch(() => "");
        if (href) this.frameUrl = href;
        if (this.frameUrl.startsWith(this.liveOrigin)) return true;
      }
      await sleep(250);
    }
    return false;
  }
}

/** Verifies the live website at `liveOrigin` inside Crestmont's verification page `pageUrl`. */
export async function verifyNative(open: OpenBrowser, pageUrl: string, liveOrigin: string, opts: { fixture?: FixtureResponder; timeoutMs?: number } = {}): Promise<VerifyResult> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const at = new Date().toISOString();
  let handle: BrowserHandle | null = null;
  const deadline = Date.now() + (opts.timeoutMs ?? 75_000);
  try {
    handle = await open();
    const cdp = handle.cdp;
    const ctx = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true }) as { browserContextId: string };
    const tgt = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId: ctx.browserContextId }) as { targetId: string };
    const att = await cdp.send("Target.attachToTarget", { targetId: tgt.targetId, flatten: true }) as { sessionId: string };
    const page = new Page(cdp, att.sessionId, liveOrigin, opts.fixture);
    await Promise.all([page.send("Page.enable"), page.send("Runtime.enable"), page.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })]);
    if (opts.fixture) await page.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url: pageUrl });

    const framed = await page.waitFrame(Math.min(25_000, deadline - Date.now()));
    add("frame", framed, framed ? `The browser loaded ${liveOrigin} inside Crestmont's frame` : `The browser did not load ${liveOrigin} inside Crestmont's frame (${page.frameUrl ? `frame shows ${page.frameUrl.slice(0, 80)}` : "no frame document"}) — the site still refuses framing, or it did not answer`);
    if (!framed) return finish(checks, at);
    const sid = page.frameSession!;
    const r = JSON.parse(String(await page.evalIn(sid, PROBE))) as { title: string; text: number; media: number; frames: number; anims: number; canvases: { w: number; h: number; drawn: number; animated: boolean; error: string | null }[]; webgl: boolean; room: number; spot: { x: number; y: number } | null; width: number; overflowX: number };
    const visible = r.text >= 40 || r.media >= 2;
    add("content", visible, visible ? `Real content is visible: ${r.text} characters of text, ${r.media} images/media in view${r.title ? `, title "${r.title}"` : ""}` : `The framed page is blank or stuck loading (${r.text} characters, ${r.media} media)${page.errors ? `; ${page.errors} JavaScript error(s)` : ""}`);
    add("javascript", r.frames >= 5, `${r.frames} animation frames in 1 s, ${r.anims} running CSS/Web animation(s)${page.errors ? `, ${page.errors} uncaught JavaScript error(s)` : ", no uncaught errors"}`);
    if (r.canvases.length) {
      const blank = r.canvases.filter((c) => c.drawn < 0.02 || c.error);
      // A browser without WebGL cannot judge a WebGL scene: say so instead of blaming the site.
      if (blank.length && !r.webgl) add("canvas", true, `not verifiable here: this verification browser has no WebGL, and ${blank.length} canvas(es) stayed empty — check the site in a WebGL-capable browser`);
      else add("canvas", blank.length === 0, r.canvases.map((c) => `${c.w}×${c.h} canvas ${c.error ? `unreadable (${c.error})` : c.drawn < 0.02 ? "drew nothing (WebGL/2D failed to render)" : `drew ${Math.round(c.drawn * 100)}% of its area${c.animated ? ", animating" : ", still"}`}`).join("; "));
    }
    // Real gestures on the page (the frame fills the verification page, so page coordinates are frame coordinates).
    if (r.room > 4) {
      const before = Number(await page.evalIn(sid, SCROLLED));
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 450 });
      for (let k = 0; k < 3; k++) { await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 700, y: 450, deltaX: 0, deltaY: 400 }); await sleep(150); }
      await sleep(700);
      const after = Number(await page.evalIn(sid, SCROLLED));
      add("scroll", after > before, after > before ? `A wheel gesture scrolled the site (${before} → ${after} px of ${r.room})` : `A wheel gesture did not scroll the site (${before} → ${after} px, ${r.room} px to scroll)`);
      await page.evalIn(sid, "scrollTo(0, 0); for (const e of document.querySelectorAll('body *')) if (e.scrollTop) e.scrollTop = 0; true");
      await sleep(300);
    } else add("scroll", true, "The page fits its frame at 1440×900 — nothing to scroll");
    if (r.spot) {
      for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: r.spot.x, y: r.spot.y, button: "left", clickCount: 1 });
      await sleep(300);
      const n = Number(await page.evalIn(sid, "window.__crestmontClicks || 0"));
      add("click", n > 0, n > 0 ? "A real click reached the site" : "A real click on the page's text did not reach the site");
    } else add("click", false, "No visible text to click on — the page shows nothing a visitor could interact with");
    // Phone width (a fresh load at 390 px, as a visitor's phone would show the portfolio's mobile view).
    if (Date.now() < deadline - 15_000) {
      await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      page.frameSession = null; page.frameUrl = "";
      await page.send("Page.navigate", { url: pageUrl });
      if (await page.waitFrame(Math.min(20_000, deadline - Date.now()))) {
        const m = JSON.parse(String(await page.evalIn(page.frameSession!, MOBILE))) as { text: number; width: number; overflowX: number };
        add("mobile", m.text >= 40 && m.overflowX <= 24, `At ${m.width} px: ${m.text} characters of content${m.overflowX > 0 ? `, ${m.overflowX} px wider than the screen` : ", no sideways overflow"}`);
      } else add("mobile", false, "At 390 px the frame did not load");
    }
    return finish(checks, at);
  } catch (e) {
    add("browser", false, `The verification browser failed: ${(e as Error).message}`.slice(0, 200));
    return finish(checks, at);
  } finally {
    try { await handle?.close(); } catch { /* closed */ }
  }
}

function finish(checks: Check[], at: string): VerifyResult {
  const failed = checks.filter((c) => !c.ok);
  return { ok: checks.length > 0 && !failed.length, checks, at, summary: failed.length ? failed.map((c) => `${c.name}: ${c.detail}`).join(" · ") : `Verified in a real browser: ${checks.map((c) => c.name).join(", ")}` };
}

/** Opens Browser Run through the Worker's BROWSER binding. */
export function browserRunOpener(binding: unknown): OpenBrowser {
  return async () => {
    const { acquireBrowserRun } = await import("../remote-browser/acquire.ts");
    const got = await acquireBrowserRun(binding as Parameters<typeof acquireBrowserRun>[0]);
    if (!got.socket) throw new Error(`Browser Run is not available (${got.how})`);
    const cdp = new Cdp(got.socket as SocketLike, 30_000);
    return { cdp, close: async () => { await cdp.send("Browser.close").catch(() => undefined); cdp.close(); } };
  };
}
