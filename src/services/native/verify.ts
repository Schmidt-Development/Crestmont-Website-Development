// Real-browser verification of a native embed (Owner, 2026-11-18 / 2026-11-19 "UNIVERSAL NATIVE PORTFOLIO ENGINE").
// A fresh, isolated Chromium (Cloudflare Browser Run in production; a local Chromium in development and CI) loads the
// live website TWICE under the same conditions — once directly, as its own visitors see it, and once inside Crestmont's
// verification page (the same sandboxed iframe the portfolio uses) — and compares them:
//   frame       the browser loaded the live origin inside Crestmont's frame (not refused, not an error page);
//   content     real content is visible in the frame (compared with the direct visit);
//   javascript  the page runs (animation frames); script errors are counted in both modes;
//   canvas      every canvas is CLASSIFIED before it is judged: hidden, offscreen, decorative (background layers,
//               aria-hidden, behind content, pointer-events none, faint or small), transparent-by-design, deferred
//               (initialised later), offscreen-rendered, or ESSENTIAL (a visible scene a visitor is meant to see).
//               Only an essential canvas that does not render can fail — and only as an embedding failure when it
//               renders on the direct visit; a scene that fails in both modes is the website's own defect, and a
//               browser that cannot create WebGL (no GPU, context lost) is reported as a limitation, never as a pass
//               or a failure of the website;
//   scroll      a real wheel gesture scrolls the site (or the page fits its frame);
//   click       a real click reaches the site;
//   mobile      the page renders content at a 390 px phone width without breaking out sideways;
//   performance load (TTFB, FCP, LCP), layout stability (CLS), main-thread blocking (long tasks → TBT), idle and
//               scrolling smoothness (frames per second), interaction latency (a real click's event duration — the
//               lab stand-in for INP; field INP needs real-user data), script errors and failed requests — direct vs
//               embedded, with the test environment's context (renderer, software/GPU). A slow website is reported
//               as the website's; only a material embedded-vs-direct difference is attributed to Crestmont's frame.
// Instrumentation is injected at document start in the throwaway verification browser only (canvas context and
// draw-call counters, performance observers, error listeners); nothing is typed, submitted or bought, and no cookies
// are kept. One verification lasts about a minute and only runs on onboarding transitions, a regression, a weekly
// refresh or an explicit staff re-check, capped per day (orchestrator.ts).
import { Cdp, type SocketLike } from "../remote-browser/cdp.ts";
import { SENSITIVE_ROUTE } from "./standard.ts";

/** The verifier's own version. A verification made by an older verifier is stale: the entry is verified again (first)
 *  and does not count as verified until then — so a fix to the verifier reaches every existing entry, not only new ones.
 *  Bump whenever what the verifier checks changes. */
export const VERIFIER_VERSION = "2026-11-20.2";

/** A value as a JavaScript literal that is safe to place inside generated code: JSON, plus the characters that could
 *  end a script or a line in some contexts (<, >, /, U+2028, U+2029) escaped. */
const jsLiteral = (v: unknown) => JSON.stringify(v).replace(/[<>\/\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export interface BrowserHandle { cdp: Cdp; close(): void | Promise<void> }
export type OpenBrowser = () => Promise<BrowserHandle>;
type Fixture = { status: number; headers: Record<string, string>; body: string } | null;
/** Development and tests only: answers the verification browser's requests for TEST DATA sites (never in production). */
export type FixtureResponder = (url: string) => Fixture | Promise<Fixture>;
export interface Check { name: string; ok: boolean; detail: string }
export type FindingKind = "embed" | "site" | "environment";
export interface Finding { code: string; kind: FindingKind; blocking: boolean; detail: string }
export interface ModePerf { ttfb: number | null; fcp: number | null; lcp: number | null; cls: number; tbt: number; longestTask: number; idleFps: number; scrollFps: number | null; interaction: number | null; errors: number; failedRequests: number }
export interface PerfReport { direct: ModePerf | null; embedded: ModePerf | null; mobile: Pick<ModePerf, "lcp" | "cls" | "tbt" | "idleFps"> | null; environment: string; budgets: string; verdict: string }
/** Visual evidence: a screenshot of what the visitor saw, stored by the caller (the verifier itself stores nothing). */
export interface Shot { label: "direct" | "embedded" | "direct-mobile" | "embedded-mobile"; key: string }
export type ShotSink = (label: Shot["label"], jpeg: Uint8Array) => Promise<string | null>;
export interface VerifyResult { ok: boolean; checks: Check[]; summary: string; at: string; findings?: Finding[]; perf?: PerfReport; shots?: Shot[]; verifier?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Injected at document start (the live site, both modes): counters and observers; never changes what the site draws. */
const HOOK = `(() => { if (window.__cmv) return; const S = window.__cmv = { errors: [], resErr: 0, ctxFail: 0, lost: 0, fcp: null, lcp: null, cls: 0, tasks: [], events: 0 };
  addEventListener("error", (e) => { if (e.target && e.target !== window && e.target.tagName) S.resErr++; else S.errors.push(String(e.message || "error").slice(0, 160)); }, true);
  addEventListener("unhandledrejection", (e) => S.errors.push("unhandled rejection: " + String((e.reason && e.reason.message) || e.reason).slice(0, 140)));
  try { const gc = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (type, o) { const c = gc.call(this, type, o); if (c) { if (!this.__cmvType) this.__cmvType = String(type); if (/webgl/.test(type) && !this.__cmvL) { this.__cmvL = 1; this.addEventListener("webglcontextlost", () => S.lost++); } } else if (/webgl/.test(String(type)) && !this.__cmvType) S.ctxFail++; return c; };
    const tc = HTMLCanvasElement.prototype.transferControlToOffscreen; if (tc) HTMLCanvasElement.prototype.transferControlToOffscreen = function () { this.__cmvType = "offscreen"; return tc.call(this); };
    const wrap = (P, names) => { if (!P) return; for (const n of names) { const f = P[n]; if (typeof f !== "function") continue; P[n] = function () { const c = this.canvas; if (c) c.__cmvDraws = (c.__cmvDraws || 0) + 1; return f.apply(this, arguments); }; } };
    const GL = ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "clear"];
    wrap(window.WebGLRenderingContext && WebGLRenderingContext.prototype, GL); wrap(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype, GL);
    wrap(window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype, ["fill", "stroke", "fillRect", "strokeRect", "drawImage", "fillText", "strokeText", "putImageData"]); } catch {}
  const po = (type, f, o) => { try { new PerformanceObserver((l) => l.getEntries().forEach(f)).observe(Object.assign({ type, buffered: true }, o || {})); } catch {} };
  po("paint", (e) => { if (e.name === "first-contentful-paint") S.fcp = e.startTime; });
  po("largest-contentful-paint", (e) => { S.lcp = e.startTime; });
  po("layout-shift", (e) => { if (!e.hadRecentInput) S.cls += e.value; });
  po("longtask", (e) => S.tasks.push(Math.round(e.duration)));
  po("event", (e) => { if (/click|pointerdown|pointerup|mousedown|mouseup/.test(e.name)) S.events = Math.max(S.events, Math.round(e.duration)); }, { durationThreshold: 16 });
})()`;

/** Canvas inventory and classification (runs in the live page, either mode). */
const CANVASES = `(() => { const vw = innerWidth, vh = innerHeight, A = vw * vh;
  const op = (e) => { let o = 1; for (let n = e, k = 0; n && n.nodeType === 1 && k < 12; n = n.parentElement, k++) { const s = getComputedStyle(n); if (s.display === "none" || s.visibility === "hidden") return 0; o *= Number(s.opacity || 1); } return o; };
  return [...document.querySelectorAll("canvas")].slice(0, 8).map((c, i) => { const r = c.getBoundingClientRect(), s = getComputedStyle(c);
    const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const area = (r.width * r.height) / A, inView = (ix * iy) / A, alpha = op(c);
    let behind = false; if (inView > 0) { const x = Math.max(1, Math.min(vw - 1, r.left + r.width / 2)), y = Math.max(1, Math.min(vh - 1, r.top + r.height / 2)); const h = document.elementFromPoint(x, y); behind = !!h && h !== c && !c.contains(h); }
    const hidden = alpha === 0 || r.width < 2 || r.height < 2 || c.width === 0 || c.height === 0;
    const decorative = c.getAttribute("aria-hidden") === "true" || c.getAttribute("role") === "presentation" || (s.pointerEvents === "none" && (area >= 0.6 || behind)) || alpha < 0.35 || area < 0.04 || (area >= 0.6 && behind);
    return { i, w: Math.round(r.width), h: Math.round(r.height), area: Math.round(area * 1000) / 1000, inView: Math.round(inView * 1000) / 1000, hidden, decorative, behind, type: c.__cmvType || null, draws: c.__cmvDraws || 0 }; });
})()`;
const SAMPLE = `(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res([...document.querySelectorAll("canvas")].slice(0, 8).map((c) => {
  try { if (c.__cmvType === "offscreen") return { offscreen: true };
    const s = document.createElement("canvas"); s.width = 32; s.height = 32; const x = s.getContext("2d"); x.drawImage(c, 0, 0, 32, 32); const d = x.getImageData(0, 0, 32, 32).data;
    const counts = new Map(); let opaque = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3] >= 8) opaque++; const k = d[i + 3] < 8 ? "t" : ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); counts.set(k, (counts.get(k) || 0) + 1); }
    let mode = null, max = 0; for (const [k, v] of counts) if (v > max) { max = v; mode = k; }
    let sig = 0; for (let i = 0; i < d.length; i += 4) sig = (sig * 31 + (d[i] >> 3) * 1031 + (d[i + 1] >> 3) * 37 + (d[i + 2] >> 3) + (d[i + 3] >> 5)) % 1000000007;
    return { drawn: Math.round((1 - max / 1024) * 1000) / 1000, opaque: Math.round(opaque / 10.24) / 100, transparent: mode === "t", sig };
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 80) }; } }))))))()`;
const PAGE = `(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && document.readyState !== "complete"; i++) await sleep(250);
  await sleep(1500);
  // Visible text, including open shadow roots (custom elements / web components render their text there).
  const deep = (root) => { let t = root === document ? (document.body ? document.body.innerText : "") : [...root.children].map((c) => c.innerText || c.textContent || "").join(" "); for (const e of root.querySelectorAll("*")) if (e.shadowRoot) t += " " + deep(e.shadowRoot); return t; };
  const text = deep(document).replace(/\\s+/g, " ").trim().length;
  const media = [...document.querySelectorAll("img, video, canvas, svg, picture")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 16 && r.height > 16 && r.bottom > 0 && r.top < innerHeight; }).length;
  const fps = await new Promise((res) => { let n = 0; const t = performance.now(); const g = () => { n++; if (performance.now() - t < 1000) requestAnimationFrame(g); else res(n); }; requestAnimationFrame(g); });
  // Liveness, separate from smoothness: a slow page (heavy scripts, a software renderer) still renders frames; a frozen
  // one does not. Below 5 fps, watch 3 more seconds.
  const frames3 = fps >= 5 ? fps * 3 : await new Promise((res) => { let n = 0; const t = performance.now(); const g = () => { n++; if (performance.now() - t < 3000) requestAnimationFrame(g); else res(n); }; requestAnimationFrame(g); });
  const anims = document.getAnimations ? document.getAnimations().filter((a) => a.playState === "running").length : 0;
  let webgl = false, renderer = ""; try { const t = document.createElement("canvas"); const g = t.getContext("webgl2") || t.getContext("webgl"); webgl = !!g; if (g) { const x = g.getExtension("WEBGL_debug_renderer_info"); renderer = String(x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)).slice(0, 120); } } catch {}
  const ov = (e) => getComputedStyle(e).overflowY, hv = ov(document.documentElement);
  const hidden = /hidden|clip/.test(hv) || (hv === "visible" && document.body && /hidden|clip/.test(ov(document.body)));
  let room = hidden ? 0 : document.documentElement.scrollHeight - innerHeight;
  for (const e of document.querySelectorAll("body *")) if (/(auto|scroll|overlay)/.test(getComputedStyle(e).overflowY)) room = Math.max(room, e.scrollHeight - e.clientHeight);
  // A safe click target, independent of tag choice (div-only pages, custom elements): first any visible text, else any
  // visible non-interactive element — never a control, a link, a form field or something that looks clickable.
  const INTERACTIVE = "a, button, input, select, textarea, label, summary, option, video, audio, iframe, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [onclick], [contenteditable=''], [contenteditable=true], [tabindex]:not([tabindex='-1'])";
  const safe = (hit) => !!hit && hit !== document.documentElement && hit !== document.body && !hit.closest(INTERACTIVE) && getComputedStyle(hit).cursor !== "pointer";
  let spot = null;
  const tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue && n.nodeValue.trim().length >= 3 ? 1 : 3) });
  for (let n, k = 0; !spot && (n = tw.nextNode()) && k < 5000; k++) {
    const rg = document.createRange(); rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) {
      if (r.width < 8 || r.height < 6 || r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) continue;
      const x = r.left + Math.min(6, r.width / 2), y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
      if (safe(hit)) { spot = { x: Math.round(x), y: Math.round(y), how: "text" }; break; }
    }
  }
  for (let gy = 0.25; !spot && gy <= 0.85; gy += 0.15) for (let gx = 0.1; !spot && gx <= 0.9; gx += 0.2) {
    const x = innerWidth * gx, y = innerHeight * gy, hit = document.elementFromPoint(x, y);
    if (safe(hit)) spot = { x: Math.round(x), y: Math.round(y), how: "element" };
  }
  window.__crestmontClicks = 0; addEventListener("click", () => { window.__crestmontClicks++; }, { capture: true });
  const S = window.__cmv || { errors: [], resErr: 0, ctxFail: 0, lost: 0, fcp: null, lcp: null, cls: 0, tasks: [], events: 0 };
  const nav = performance.getEntriesByType("navigation")[0];
  const failed = performance.getEntriesByType("resource").filter((r) => r.responseStatus >= 400).length + S.resErr;
  return JSON.stringify({ title: document.title.slice(0, 120), text, media, fps, frames3, anims, webgl, renderer, room: Math.round(room), spot, width: innerWidth, overflowX: document.documentElement.scrollWidth - innerWidth,
    perf: { ttfb: nav ? Math.round(nav.responseStart) : null, fcp: S.fcp === null ? null : Math.round(S.fcp), lcp: S.lcp === null ? null : Math.round(S.lcp), cls: Math.round(S.cls * 1000) / 1000,
      tbt: S.tasks.reduce((a, d) => a + Math.max(0, d - 50), 0), longestTask: S.tasks.reduce((a, d) => Math.max(a, d), 0), errors: S.errors.length, errorSample: S.errors.slice(0, 3), failedRequests: failed, ctxFail: S.ctxFail, lost: S.lost } });
})()`;
const SCROLLED = `(() => Math.round(scrollY) + [...document.querySelectorAll("body *")].reduce((a, e) => a + e.scrollTop, 0))()`;
const SCROLL_FPS_START = `(() => { window.__cmvScroll = new Promise((res) => { let n = 0; const t = performance.now(); const g = () => { n++; if (performance.now() - t < 1000) requestAnimationFrame(g); else res(n); }; requestAnimationFrame(g); }); return true; })()`;
const MOBILE = `(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 60 && document.readyState !== "complete"; i++) await sleep(250); await sleep(1200);
  const S = window.__cmv || { lcp: null, cls: 0, tasks: [] };
  const fps = await new Promise((res) => { let n = 0; const t = performance.now(); const g = () => { n++; if (performance.now() - t < 1000) requestAnimationFrame(g); else res(n); }; requestAnimationFrame(g); });
  const big = [...document.querySelectorAll("canvas")].filter((c) => { const r = c.getBoundingClientRect(), st = getComputedStyle(c); return r.width * r.height >= innerWidth * innerHeight * 0.04 && st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) > 0.05; }).length;
  const deep = (root) => { let t = root === document ? (document.body ? document.body.innerText : "") : [...root.children].map((c) => c.innerText || c.textContent || "").join(" "); for (const e of root.querySelectorAll("*")) if (e.shadowRoot) t += " " + deep(e.shadowRoot); return t; };
  return JSON.stringify({ text: deep(document).replace(/\\s+/g, " ").trim().length, width: innerWidth, overflowX: document.documentElement.scrollWidth - innerWidth, canvases: big,
    perf: { lcp: S.lcp === null ? null : Math.round(S.lcp), cls: Math.round(S.cls * 1000) / 1000, tbt: S.tasks.reduce((a, d) => a + Math.max(0, d - 50), 0), idleFps: fps } }); })()`;

interface CanvasInfo { i: number; w: number; h: number; area: number; inView: number; hidden: boolean; decorative: boolean; behind: boolean; type: string | null; draws: number }
interface Sample { drawn?: number; opaque?: number; transparent?: boolean; sig?: number; error?: string; offscreen?: boolean }
interface Probe { title: string; text: number; media: number; fps: number; frames3: number; anims: number; webgl: boolean; renderer: string; room: number; spot: { x: number; y: number; how?: string } | null; width: number; overflowX: number;
  perf: { ttfb: number | null; fcp: number | null; lcp: number | null; cls: number; tbt: number; longestTask: number; errors: number; errorSample: string[]; failedRequests: number; ctxFail: number; lost: number } }
type CanvasClass = "hidden" | "offscreen" | "decorative" | "rendered" | "deferred" | "empty" | "unreadable" | "offscreen-rendered";
interface Judged { info: CanvasInfo; cls: CanvasClass; essential: boolean; drawn: number; animated: boolean; detail: string }

class Page {
  private readonly cdp: Cdp; readonly session: string; readonly liveOrigin: string;
  frameSession: string | null = null; frameUrl = ""; errors = 0; framed = false; private readonly fixture?: FixtureResponder;
  constructor(cdp: Cdp, session: string, liveOrigin: string, fixture?: FixtureResponder) {
    this.cdp = cdp; this.session = session; this.liveOrigin = liveOrigin; this.fixture = fixture;
    cdp.on("Target.attachedToTarget", (p, sid) => {
      const info = p.targetInfo as { type: string; url: string }, child = String(p.sessionId);
      if (sid !== this.session && sid !== this.frameSession) return;
      void (async () => {
        if (this.fixture) await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, child).catch(() => undefined);
        await cdp.send("Runtime.enable", {}, child).catch(() => undefined);
        // Instrument the framed live site from its first script (only the frame Crestmont verifies).
        if (info.type === "iframe" && this.framed && sid === this.session) {
          await cdp.send("Page.enable", {}, child).catch(() => undefined);
          await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK }, child).catch(() => undefined);
        }
        await cdp.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => undefined);
        if (info.type === "iframe" && this.framed && sid === this.session) { this.frameSession = child; this.frameUrl = info.url; }
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
  async waitTop(ms: number): Promise<boolean> {
    for (let t = 0; t < ms; t += 250) {
      const v = await this.evalIn(this.session, "location.origin + '|' + document.readyState").catch(() => "") as string;
      if (v.startsWith(this.liveOrigin + "|") && /interactive|complete/.test(v)) return true;
      await sleep(250);
    }
    return false;
  }
}

/** One live page (either mode): canvases classified, pixels sampled three times, a deferred re-check, perf, gestures. */
async function measure(page: Page, sid: string, x: number, y: number, gestures = true): Promise<{ probe: Probe; canvases: Judged[]; perf: ModePerf; scrolled: { before: number; after: number } | null; clicked: boolean | null }> {
  const probe = JSON.parse(String(await page.evalIn(sid, PAGE))) as Probe;
  let info = JSON.parse(JSON.stringify(await page.evalIn(sid, CANVASES))) as CanvasInfo[];
  const samples = async () => (await page.evalIn(sid, SAMPLE)) as Sample[];
  const s1 = await samples(); await sleep(450); const s2 = await samples(); await sleep(450); let s3 = await samples();
  const drawnOf = (k: number, ss: Sample[][]) => Math.max(...ss.map((s) => s[k]?.drawn ?? 0));
  // A visible canvas that has not drawn yet may be deferred (a scene initialised after load, or on interaction-free
  // timers): look again once, a few seconds later, before judging it.
  if (info.some((c, k) => !c.hidden && c.inView > 0 && drawnOf(k, [s1, s2, s3]) < 0.01)) {
    await sleep(3000);
    info = JSON.parse(JSON.stringify(await page.evalIn(sid, CANVASES))) as CanvasInfo[];
    s3 = await samples();
  }
  const canvases: Judged[] = info.map((c, k) => {
    const a = s1[k] ?? {}, b = s2[k] ?? {}, z = s3[k] ?? {};
    const drawn = Math.max(a.drawn ?? 0, b.drawn ?? 0, z.drawn ?? 0), opaque = Math.max(a.opaque ?? 0, b.opaque ?? 0, z.opaque ?? 0);
    const animated = !!(a.sig && b.sig && z.sig && (a.sig !== b.sig || b.sig !== z.sig));
    const essential = !c.hidden && !c.decorative && c.inView >= 0.04;
    const size = `${c.w}×${c.h}${c.type ? ` ${c.type}` : ""} canvas`;
    let cls: CanvasClass, detail: string;
    if (c.hidden) { cls = "hidden"; detail = `${size} hidden or inactive (not judged)`; }
    else if (c.inView === 0) { cls = "offscreen"; detail = `${size} below the first screen (not judged)`; }
    else if (a.offscreen || c.type === "offscreen") { cls = "offscreen-rendered"; detail = `${size} rendered off the main thread (OffscreenCanvas; judged by the page's content)`; }
    else if (a.error && !drawn) { cls = "unreadable"; detail = `${size} unreadable (${a.error})`; }
    else if (drawn >= 0.01 || (c.draws > 0 && opaque > 0)) { cls = "rendered"; detail = `${size} drew ${Math.round(drawn * 100)}% of its area${animated ? ", animating" : ", still"}`; }
    else if (c.decorative) { cls = "decorative"; detail = `${size} is a decorative layer (${c.behind ? "behind the content" : c.area < 0.04 ? "small" : "background"}) and draws nothing visible — harmless`; }
    else if (!c.type && !c.draws) { cls = "empty"; detail = `${size} drew nothing — it was never initialised`; }
    else { cls = "empty"; detail = `${size} drew nothing${c.draws ? ` (${c.draws} draw calls produced no visible pixels)` : ""}`; }
    return { info: c, cls, essential, drawn, animated, detail };
  });
  // Scrolling: smoothness while a real wheel gesture scrolls the page (frames per second during the gesture).
  let scrolled: { before: number; after: number } | null = null, scrollFps: number | null = null;
  if (gestures && probe.room > 4) {
    const before = Number(await page.evalIn(sid, SCROLLED));
    await page.evalIn(sid, SCROLL_FPS_START);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (let k = 0; k < 3; k++) { await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: 400 }); await sleep(150); }
    scrollFps = Number(await page.evalIn(sid, "window.__cmvScroll")) || null;
    await sleep(500);
    scrolled = { before, after: Number(await page.evalIn(sid, SCROLLED)) };
    await page.evalIn(sid, "scrollTo(0, 0); for (const e of document.querySelectorAll('body *')) if (e.scrollTop) e.scrollTop = 0; true");
    await sleep(300);
  }
  let clicked: boolean | null = null;
  if (gestures && probe.spot) {
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: probe.spot.x, y: probe.spot.y, button: "left", clickCount: 1 });
    await sleep(400);
    clicked = Number(await page.evalIn(sid, "window.__crestmontClicks || 0")) > 0;
  }
  const interaction = Number(await page.evalIn(sid, "(window.__cmv && window.__cmv.events) || 0")) || null;
  const pf = probe.perf;
  return { probe, canvases, scrolled, clicked, perf: { ttfb: pf.ttfb, fcp: pf.fcp, lcp: pf.lcp, cls: pf.cls, tbt: pf.tbt, longestTask: pf.longestTask, idleFps: probe.fps, scrollFps, interaction, errors: pf.errors, failedRequests: pf.failedRequests } };
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;
const ms = (v: number | null) => (v === null ? "—" : `${v} ms`);
const BUDGETS = "lab budgets (desktop, unthrottled): LCP ≤ 2,500 ms, CLS ≤ 0.1, TBT ≤ 200 ms, click latency ≤ 200 ms (lab stand-in for INP; INP ≤ 200 ms at the 75th percentile needs real-user data), ≥ 30 fps while scrolling";

/** Verifies the live website at `liveOrigin` inside Crestmont's verification page `pageUrl`, against a direct visit. */
export async function verifyNative(open: OpenBrowser, pageUrl: string, liveOrigin: string, opts: { fixture?: FixtureResponder; timeoutMs?: number; liveUrl?: string; shot?: ShotSink } = {}): Promise<VerifyResult> {
  const checks: Check[] = [], findings: Finding[] = [], shots: Shot[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const find = (code: string, kind: FindingKind, blocking: boolean, detail: string) => findings.push({ code, kind, blocking, detail });
  const at = new Date().toISOString();
  let handle: BrowserHandle | null = null, perf: PerfReport | undefined;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
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

    // ── 1. The direct visit: the website as its own visitors see it, in this same browser (the baseline) ──
    let direct: Awaited<ReturnType<typeof measure>> | null = null, warm: Awaited<ReturnType<typeof measure>> | null = null;
    const snap = async (label: Shot["label"]) => {
      if (!opts.shot) return;
      try {
        const r = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }) as { data?: string };
        if (!r.data) return;
        const key = await opts.shot(label, Uint8Array.from(atob(r.data), (ch) => ch.charCodeAt(0)));
        if (key) shots.push({ label, key });
      } catch { /* evidence is best-effort; the checks decide */ }
    };
    const liveUrl = opts.liveUrl ?? `${liveOrigin}/`;
    const hook = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK }) as { identifier: string };
    await page.send("Page.navigate", { url: liveUrl });
    if (await page.waitTop(Math.min(25_000, deadline - Date.now()))) { direct = await measure(page, page.session, 700, 450).catch(() => null); await snap("direct"); }
    // A second direct load with the browser cache warm — the state the frame's load (and every returning visitor) is
    // in. Loading-order defects that only appear with cached files (e.g. a module preloaded before the import map
    // that resolves it) show up here, so a visual lost in the frame is attributed to the site, not the frame.
    if (direct && direct.canvases.some((c) => c.essential && c.cls === "rendered") && Date.now() < deadline - 40_000) {
      await page.send("Page.navigate", { url: liveUrl });
      if (await page.waitTop(Math.min(20_000, deadline - Date.now()))) warm = await measure(page, page.session, 700, 450, false).catch(() => null);
    }
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: hook.identifier }).catch(() => undefined);

    // ── 2. Inside Crestmont's frame ──
    page.framed = true;
    await page.send("Page.navigate", { url: pageUrl });
    const framed = await page.waitFrame(Math.min(25_000, deadline - Date.now()));
    add("frame", framed, framed ? `The browser loaded ${liveOrigin} inside Crestmont's frame` : `The browser did not load ${liveOrigin} inside Crestmont's frame (${page.frameUrl ? `frame shows ${page.frameUrl.slice(0, 80)}` : "no frame document"}) — the site still refuses framing, or it did not answer`);
    if (!framed) { find("frame_not_loaded", "embed", true, checks[0].detail); return finish(checks, at, findings, undefined, shots); }
    const sid = page.frameSession!;
    const emb = await measure(page, sid, 700, 450);
    await snap("embedded");
    const r = emb.probe;
    const environment = `${r.renderer ? `WebGL renderer ${r.renderer}${SOFTWARE.test(r.renderer) ? " (software — no GPU)" : ""}` : r.webgl ? "WebGL available" : "no WebGL in this browser"}; viewport 1440×900, DPR 1, unthrottled CPU and network`;

    // Content (framed), compared with the direct visit.
    const visible = r.text >= 40 || r.media >= 2, directVisible = !!direct && (direct.probe.text >= 40 || direct.probe.media >= 2);
    add("content", visible, visible ? `Real content is visible: ${r.text} characters of text, ${r.media} images/media in view${r.title ? `, title "${r.title}"` : ""}` : `The framed page is blank or stuck loading (${r.text} characters, ${r.media} media)${page.errors ? `; ${page.errors} JavaScript error(s)` : ""}${direct ? (directVisible ? " — only inside Crestmont's frame: the direct visit shows content" : " — also when visited directly") : ""}`);
    if (!visible) find(directVisible ? "blank_in_frame" : "hydration_failure", directVisible ? "embed" : "site", true, checks.at(-1)!.detail);
    // Liveness: the page keeps producing frames (a frozen or crashed page produces none). Smoothness is performance:
    // a low frame rate is reported and attributed (the site on its own, the frame, or a GPU-less browser), never a reject.
    const live = r.fps >= 5 || r.frames3 >= 3;
    add("javascript", live, live ? `${r.fps} animation frames in 1 s${r.fps < 5 ? ` (${r.frames3} in a 3 s window — slow but running)` : ""}, ${r.anims} running CSS/Web animation(s)${page.errors ? `, ${page.errors} uncaught JavaScript error(s)` : ", no uncaught errors"}` : `The page stopped producing frames (${r.frames3} in 3 s) — its main thread is frozen`);
    if (!live) find(direct && direct.probe.fps < 5 && direct.probe.frames3 < 3 ? "hydration_failure" : "iframe_render_failure", direct && direct.probe.fps < 5 && direct.probe.frames3 < 3 ? "site" : "embed", true, checks.at(-1)!.detail);
    else if (r.fps < 5) {
      const soft = SOFTWARE.test(r.renderer) || !r.webgl;
      if (direct && direct.probe.fps < 10) find("site_slow", "site", false, `${r.fps} fps inside Crestmont, ${direct.probe.fps} fps on the direct visit — the website's own pace${soft ? " (software rendering, no GPU: lab numbers are pessimistic)" : ""}`);
      else if (direct) find("iframe_overhead", "embed", false, `${r.fps} fps inside Crestmont vs ${direct.probe.fps} fps on the direct visit`);
      if (soft) find("gpu_limited", "environment", false, `frame rate measured with ${r.renderer || "no WebGL"} (no GPU)`);
    }
    if (r.perf.errors && direct?.probe.perf.errors) find(r.perf.errorSample.some((e) => /module specifier|import/i.test(e)) ? "js_module_error" : "site_script_error", "site", false, `${r.perf.errors} script error(s) in the framed page and ${direct.probe.perf.errors} on the direct visit — the website's own: ${r.perf.errorSample.join(" | ").slice(0, 300)}`);
    else if (r.perf.errors && direct && !direct.probe.perf.errors) find("iframe_script_error", "embed", false, `${r.perf.errors} script error(s) only inside Crestmont's frame: ${r.perf.errorSample.join(" | ").slice(0, 300)}`);

    // Canvas: classified, essential ones judged, compared with the direct visit, GPU limits reported honestly.
    if (emb.canvases.length) {
      const gpuLimited = !r.webgl || r.perf.ctxFail > 0 || r.perf.lost > 0;
      const broken = emb.canvases.filter((c) => c.essential && (c.cls === "empty" || c.cls === "unreadable"));
      const lines: string[] = [];
      let ok = true;
      for (const c of broken) {
        const d = direct?.canvases.find((x) => x.info.i === c.info.i) ?? null;
        const dRendered = !!d && d.cls === "rendered" && !(warm && warm.canvases.find((x) => x.info.i === c.info.i)?.cls !== "rendered");
        if (gpuLimited && (c.info.type?.includes("webgl") || r.perf.ctxFail > 0)) { lines.push(`${c.detail} — not verifiable here: this verification browser could not run WebGL${r.renderer ? ` (${r.renderer})` : ""}; check it in a GPU-capable browser`); find("gpu_limited", "environment", false, `${c.detail}; ${environment}`); continue; }
        ok = false;
        if (dRendered) { lines.push(`essential ${c.detail} — only inside Crestmont's frame (the direct visit drew ${Math.round(d!.drawn * 100)}%)`); find("iframe_render_failure", "embed", true, `essential ${c.detail} only inside the frame; direct: ${d!.detail}`); }
        else { lines.push(`essential ${c.detail} (WebGL/2D failed to render) — also when visited directly${d ? "" : " (direct visit not measured)"}`); find("site_render_defect", "site", true, `essential ${c.detail} — also when visited directly: the website's own scene does not render${r.perf.errorSample.length ? `; errors: ${r.perf.errorSample.join(" | ").slice(0, 200)}` : ""}`); }
      }
      for (const c of emb.canvases) if (!broken.includes(c)) lines.push(c.detail);
      add("canvas", ok, lines.join("; "));
    }
    // Essential-visual parity: an essential canvas that rendered on the direct visit must render inside the frame. A
    // missing scene is never verified, whatever the frame rate — attributed to the site when the warm direct visit
    // loses it too, to the frame when only the frame does.
    if (direct && !checks.some((c) => c.name === "canvas" && !c.ok)) {
      const big = (c: Judged) => c.info.w * c.info.h;
      const want = direct.canvases.filter((c) => c.essential && c.cls === "rendered");
      const gpuLimited = !r.webgl || r.perf.ctxFail > 0 || r.perf.lost > 0;
      const shown = (m: Awaited<ReturnType<typeof measure>>) => (c: Judged) => m.canvases.some((x) => !x.info.hidden && (x.cls === "rendered" || x.cls === "offscreen-rendered") && big(x) >= big(c) * 0.25);
      const missing = want.filter((c) => !shown(emb)(c));
      if (missing.length && !(gpuLimited && missing.every((c) => c.info.type?.includes("webgl")))) {
        const what = missing.map((c) => `${c.info.w}×${c.info.h}${c.info.type ? ` ${c.info.type}` : ""} canvas (direct visit drew ${Math.round(c.drawn * 100)}%)`).join(", ");
        const warmLost = !!warm && missing.some((c) => !shown(warm!)(c));
        const errs = r.perf.errorSample.length ? `; errors: ${r.perf.errorSample.join(" | ").slice(0, 240)}` : "";
        const detail = warmLost
          ? `essential visual missing: ${what} — it renders on a first visit but not when the website loads with cached files (a second direct visit loses it too), so returning visitors and Crestmont's frame miss it; the website's own loading defect${errs}`
          : `essential visual missing inside Crestmont's frame: ${what}${warm ? " — a second direct visit with cached files still shows it" : ""}${errs}`;
        add("visuals", false, detail);
        find(warmLost ? "site_render_defect" : "iframe_render_failure", warmLost ? "site" : "embed", true, detail);
      } else if (want.length) add("visuals", true, `${want.length} essential visual(s) from the direct visit also render inside Crestmont's frame`);
    }
    if (emb.scrolled) {
      const moved = emb.scrolled.after > emb.scrolled.before;
      add("scroll", moved, moved ? `A wheel gesture scrolled the site (${emb.scrolled.before} → ${emb.scrolled.after} px of ${r.room})` : `A wheel gesture did not scroll the site (${emb.scrolled.before} → ${emb.scrolled.after} px, ${r.room} px to scroll)`);
      if (!moved) find(direct?.scrolled && direct.scrolled.after > direct.scrolled.before ? "scroll_blocked" : "site_scroll", direct?.scrolled && direct.scrolled.after > direct.scrolled.before ? "embed" : "site", true, checks.at(-1)!.detail);
    } else add("scroll", true, "The page fits its frame at 1440×900 — nothing to scroll");
    if (emb.clicked === null) add("click", false, "No safe spot to click — every visible point is a control, a link or a form field, or the page shows nothing");
    else { add("click", emb.clicked, emb.clicked ? "A real click reached the site" : "A real click on the page's text did not reach the site"); if (!emb.clicked) find("interaction_blocked", "embed", true, checks.at(-1)!.detail); }

    // Performance: direct vs embedded, attributed honestly.
    const d = direct?.perf ?? null, e = emb.perf;
    const verdicts: string[] = [];
    if (d) {
      const siteSlow = (d.lcp ?? 0) > 4000 || d.tbt > 600 || (d.scrollFps !== null && d.scrollFps < 20);
      if (siteSlow) { verdicts.push("the website itself is slow (also when visited directly)"); find("site_slow", "site", false, `direct: LCP ${ms(d.lcp)}, TBT ${d.tbt} ms, scrolling ${d.scrollFps ?? "—"} fps`); }
      const lcpWorse = d.lcp !== null && e.lcp !== null && e.lcp > d.lcp * 1.5 && e.lcp - d.lcp > 1000;
      const tbtWorse = e.tbt - d.tbt > 300;
      const fpsWorse = d.scrollFps !== null && e.scrollFps !== null && d.scrollFps >= 20 && e.scrollFps < d.scrollFps * 0.7;
      if (lcpWorse || tbtWorse || fpsWorse) { verdicts.push("slower inside Crestmont than on its own"); find("iframe_overhead", "embed", false, `embedded vs direct: LCP ${ms(e.lcp)} vs ${ms(d.lcp)}, TBT ${e.tbt} vs ${d.tbt} ms, scrolling ${e.scrollFps ?? "—"} vs ${d.scrollFps ?? "—"} fps`); }
      if (!verdicts.length) verdicts.push("embedded performance matches the direct visit");
    } else verdicts.push("direct visit not measured (the site did not load directly in this browser)");
    if (SOFTWARE.test(r.renderer) || !r.webgl) verdicts.push("frame rates measured with software rendering (no GPU) — compare ratios, not absolute values");
    perf = { direct: d, embedded: e, mobile: null, environment, budgets: BUDGETS, verdict: verdicts.join("; ") };
    add("performance", true, `embedded: LCP ${ms(e.lcp)}, CLS ${e.cls}, TBT ${e.tbt} ms, ${e.idleFps} fps idle${e.scrollFps !== null ? `, ${e.scrollFps} fps scrolling` : ""}, click ${ms(e.interaction)}; direct: ${d ? `LCP ${ms(d.lcp)}, CLS ${d.cls}, TBT ${d.tbt} ms, ${d.idleFps} fps idle${d.scrollFps !== null ? `, ${d.scrollFps} fps scrolling` : ""}` : "not measured"} — ${perf.verdict}`);

    // Protected links: a visible sign-in/booking/checkout link inside the frame must not load that page IN the frame
    // (it refuses framing, so the visitor would see a broken frame). The link is clicked as a visitor would, through
    // the site's own handlers, but its default action is observed and then cancelled: nothing navigates, no tab opens,
    // nothing is submitted. A link that opens a new tab (target=_blank, or a handler that calls window.open) passes; one
    // whose default would load the page in the frame (or replace Crestmont's page: _top/_parent) fails.
    const protectedLink = JSON.parse(String(await page.evalIn(sid, `(() => { const re = new RegExp(${jsLiteral(SENSITIVE_ROUTE.source)}, "i");
      for (const a of document.querySelectorAll("a[href]")) { let u; try { u = new URL(a.href, location.href); } catch { continue; }
        if (u.origin !== location.origin || !re.test(u.pathname) || u.pathname === location.pathname) continue;
        const r = a.getBoundingClientRect(); if (!a.getClientRects().length || r.width < 2 || r.height < 2 || getComputedStyle(a).visibility === "hidden") continue;
        const target = (a.getAttribute("target") || "").toLowerCase(); let opened = false, frameNav = false, leaves = false;
        const wo = window.open; window.open = function () { opened = true; return null; };
        const last = (e) => { if (!(e.target instanceof Element) || e.target.closest("a") !== a) return; if (!e.defaultPrevented) { if (target === "_top" || target === "_parent") leaves = true; else if (target !== "_blank") frameNav = true; } e.preventDefault(); };
        window.addEventListener("click", last, false);
        try { a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, button: 0 })); } finally { window.removeEventListener("click", last, false); window.open = wo; }
        return JSON.stringify({ path: u.pathname, target, opened, frameNav, leaves }); }
      return "null"; })()`).catch(() => "null"))) as { path: string; target: string; opened: boolean; frameNav: boolean; leaves: boolean } | null;
    if (protectedLink) {
      const bad = (protectedLink.frameNav && !protectedLink.opened) || protectedLink.leaves;
      add("protected links", !bad, bad
        ? protectedLink.leaves
          ? `The site's ${protectedLink.path} link targets ${protectedLink.target}: clicked inside Crestmont's frame it would replace Crestmont's page. The website should open it in a new tab (target="_blank" rel="noopener").`
          : `Clicking the site's ${protectedLink.path} link inside Crestmont's frame loads ${protectedLink.path} in the frame, which refuses framing — visitors would see a broken frame. The website should open it in a new tab (target="_blank" rel="noopener").`
        : `The ${protectedLink.path} link opens outside the frame (${protectedLink.opened ? "the site opens a new window" : "target=_blank"})`);
      if (bad) find("protected_link_in_frame", "site", true, checks.at(-1)!.detail);
    } else add("protected links", true, "No visible sign-in, booking or checkout link");

    // Phone width (a fresh load at 390 px, as a visitor's phone would show the portfolio's mobile view).
    if (Date.now() < deadline - 15_000) {
      await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      page.frameSession = null; page.frameUrl = "";
      await page.send("Page.navigate", { url: pageUrl });
      if (await page.waitFrame(Math.min(20_000, deadline - Date.now()))) {
        const m = JSON.parse(String(await page.evalIn(page.frameSession!, MOBILE))) as { text: number; width: number; overflowX: number; canvases: number; perf: { lcp: number | null; cls: number; tbt: number; idleFps: number } };
        await snap("embedded-mobile");
        add("mobile", m.text >= 40 && m.overflowX <= 24, `At ${m.width} px: ${m.text} characters of content${m.overflowX > 0 ? `, ${m.overflowX} px wider than the screen` : ", no sideways overflow"}; LCP ${ms(m.perf.lcp)}, CLS ${m.perf.cls}, TBT ${m.perf.tbt} ms, ${m.perf.idleFps} fps`);
        if (m.overflowX > 24) find("mobile_overflow", "site", true, checks.at(-1)!.detail);
        // A desktop scene that vanishes on the phone: compare with the site on its own at the same width before judging.
        if (!m.canvases && emb.canvases.some((c) => c.essential && c.cls === "rendered") && Date.now() < deadline - 10_000) {
          await page.send("Page.navigate", { url: liveUrl });
          const dm = await page.waitTop(Math.min(15_000, deadline - Date.now())) ? JSON.parse(String(await page.evalIn(page.session, MOBILE))) as { canvases: number } : null;
          if (dm) await snap("direct-mobile");
          if (dm?.canvases) { add("mobile-visuals", false, `At 390 px the essential canvas shown on desktop is missing inside Crestmont's frame (the site on its own shows ${dm.canvases})`); find("iframe_render_failure", "embed", true, checks.at(-1)!.detail); }
          else if (dm) add("mobile-visuals", true, "At 390 px the website on its own shows no canvas either — not attributable to Crestmont's frame (its mobile layout, or a defect the desktop checks report)");
        }
        perf.mobile = m.perf;
      } else { add("mobile", false, "At 390 px the frame did not load"); find("frame_not_loaded", "embed", true, "At 390 px the frame did not load"); }
    }
    return finish(checks, at, findings, perf, shots);
  } catch (e) {
    add("browser", false, `The verification browser failed: ${(e as Error).message}`.slice(0, 200));
    return finish(checks, at, findings, perf, shots);
  } finally {
    try { await handle?.close(); } catch { /* closed */ }
  }
}

function finish(checks: Check[], at: string, findings: Finding[] = [], perf?: PerfReport, shots: Shot[] = []): VerifyResult {
  const failed = checks.filter((c) => !c.ok);
  return { ok: checks.length > 0 && !failed.length, checks, at, findings, perf, verifier: VERIFIER_VERSION, ...(shots.length ? { shots } : {}), summary: failed.length ? failed.map((c) => `${c.name}: ${c.detail}`).join(" · ") : `Verified in a real browser: ${checks.map((c) => c.name).join(", ")}` };
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
