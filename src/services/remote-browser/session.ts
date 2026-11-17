// One remote-browser session (Mode B): a fresh, isolated Chromium page that renders an authorized public website and
// streams it to one visitor, who controls it with mouse, wheel, touch and keyboard. Shared by production (a Durable
// Object talking to Cloudflare Browser Run) and by development/CI (a local Chromium) — same code, same policy.
//
// Visitor ⇄ Crestmont (WebSocket, this session) ⇄ Chromium (CDP):
//   • Chromium → visitor: JPEG frames of the page (Page.startScreencast) as binary messages, and small JSON notices
//     ({t:"url"}, {t:"loaded"}, {t:"viewport"}, {t:"blocked"}, {t:"ended"}).
//   • visitor → Chromium: JSON input ({t:"mouse"|"wheel"|"touch"|"key"|"text"|"nav"|"device"|"ping"}), validated and
//     bounded here, then dispatched with Input.* / Page.* commands. Nothing the visitor sends is evaluated as code.
// Every request the page makes is paused and decided by policy.ts (public https only, read-only methods, navigations on
// the project's own site, never sign-in/account/admin/billing/checkout). Downloads, file pickers, popups, dialogs and
// password entry are disabled. The session ends on visitor disconnect, inactivity, its time limit, or a browser failure,
// and always closes the browser.
import { Cdp, type SocketLike } from "./cdp.ts";
import { decideRequest, blockPageHtml, GUARD_SCRIPT, interceptPatterns } from "./policy.ts";
import { FrameFlow, InputQueue, decodeBase64, type InputItem } from "./stream.ts";

export type Device = "desktop" | "tablet" | "mobile";
export const DEVICE_WIDTH: Record<Device, number> = { desktop: 1440, tablet: 820, mobile: 390 };
export interface SessionOptions {
  url: string; site: string; device: Device; height: number;
  maxSessionSeconds: number; idleSeconds: number;
  /** Called every ~20 s while the session is alive (database heartbeat). */
  heartbeat?: () => Promise<void>;
  /** Called once when the session has ended (reason, seconds it ran). */
  onEnd?: (reason: string, seconds: number) => Promise<void> | void;
  /** Releases the browser itself (Browser.close / disconnect). */
  closeBrowser?: () => Promise<void> | void;
  /** Development/CI only: answer requests for fixture hosts locally instead of from the network. */
  fixture?: (url: string) => { status: number; headers: Record<string, string>; body: string } | null;
  now?: () => number;
}

const clampH = (h: unknown) => { const n = Math.round(Number(h)); return Number.isFinite(n) ? Math.min(1400, Math.max(320, n)) : 900; };
const b64 = (s: string) => { const bytes = new TextEncoder().encode(s); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };
const KEY_CODES: Record<string, number> = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
const MAX_FRAME_BYTES = 900_000; // Workers WebSocket messages are limited to 1 MiB
/** JPEG quality of the stream: measured on production, frame size (not the visitor's bandwidth) limited the frame
 *  rate of large viewports; 55 keeps text legible at a smaller size than the former 60. */
export const STREAM_QUALITY = 55;

export class RemoteSession {
  private page = "";      // flattened CDP session of the page target
  private target = "";
  private context = "";
  private device: Device;
  private height: number;
  private startedAt: number;
  private lastInput: number;
  private ended = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private msgWindow = { at: 0, n: 0 };
  private desktopUA = "";
  /** The size the visitor's canvas is actually shown at, in device pixels (v2 viewers report it): frames are never
   *  captured larger than that. 0 = unknown (full device width). */
  private viewPx = 0;
  private castWidth = 0;
  private flow: FrameFlow;
  private input: InputQueue;
  blocked = 0;

  private readonly cdp: Cdp;
  private readonly client: SocketLike;
  private readonly o: SessionOptions;
  constructor(cdp: Cdp, client: SocketLike, o: SessionOptions) {
    this.cdp = cdp; this.client = client; this.o = o;
    this.device = o.device; this.height = clampH(o.height);
    this.startedAt = this.lastInput = this.now();
    this.flow = new FrameFlow({
      now: () => this.now(),
      send: (bytes) => { try { this.client.send(bytes); } catch { /* client gone */ } },
      ackChrome: (id) => { void this.cdp.send("Page.screencastFrameAck", { sessionId: id }, this.page).catch(() => undefined); },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    this.input = new InputQueue((it) => this.cdp.send(it.method, it.params, this.page), () => this.now());
  }
  private now() { return this.o.now ? this.o.now() : Date.now(); }
  private notify(m: Record<string, unknown>) { try { this.client.send(JSON.stringify(m)); } catch { /* client gone */ } }
  get width() { return DEVICE_WIDTH[this.device]; }

  async start(): Promise<void> {
    const c = this.cdp;
    c.onClose(() => void this.end("browser-closed"));
    this.client.addEventListener("message", (ev) => { void this.onClient(ev.data); });
    this.client.addEventListener("close", () => void this.end("visitor-left"));
    this.client.addEventListener("error", () => void this.end("visitor-left"));
    try {
      // Independent setup steps run in parallel (each is a round trip to the browser).
      const [v, ctx] = await Promise.all([c.send("Browser.getVersion").catch(() => ({} as Record<string, unknown>)), c.send("Target.createBrowserContext", { disposeOnDetach: true })]);
      this.desktopUA = String(v.userAgent ?? "");
      this.context = String(ctx.browserContextId ?? "");
      const inCtx = this.context ? { browserContextId: this.context } : {};
      const [, , created] = await Promise.all([
        c.send("Browser.setDownloadBehavior", { behavior: "deny", ...inCtx }).catch(() => undefined),
        // New windows opened by the site (window.open is also disabled in-page) are closed at once.
        c.send("Target.setDiscoverTargets", { discover: true }),
        c.send("Target.createTarget", { url: "about:blank", ...inCtx }),
      ]);
      this.target = String(created.targetId);
      this.page = String((await c.send("Target.attachToTarget", { targetId: this.target, flatten: true })).sessionId);
      c.on("Target.targetCreated", (p) => {
        const t = p.targetInfo as { targetId: string; type: string; browserContextId?: string } | undefined;
        if (t && t.type === "page" && t.targetId !== this.target && (!this.context || t.browserContextId === this.context)) void c.send("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
      });
      const s = this.page;
      c.on("Fetch.requestPaused", (p, sid) => { if (sid === s) void this.onRequest(p); });
      c.on("Page.screencastFrame", (p, sid) => { if (sid === s) this.onFrame(p); });
      c.on("Page.frameNavigated", (p, sid) => {
        const f = p.frame as { parentId?: string; url?: string } | undefined;
        if (sid === s && f && !f.parentId) this.notify({ t: "url", href: String(f.url ?? "") });
      });
      c.on("Page.navigatedWithinDocument", (p, sid) => { if (sid === s && p.frameId === this.target) this.notify({ t: "url", href: String(p.url ?? "") }); });
      c.on("Page.loadEventFired", (_p, sid) => { if (sid === s) this.notify({ t: "loaded" }); });
      // The page's first meaningful paint: the viewer may show the picture (portfolio.js holds the slide back until
      // the picture has content — "load" is no such signal: Get Every Invoice Paid fires it before its content appears).
      c.on("Page.lifecycleEvent", (p, sid) => { if (sid === s && p.frameId === this.target && p.name === "firstMeaningfulPaint") this.notify({ t: "painted" }); });
      c.on("Page.javascriptDialogOpening", (_p, sid) => { if (sid === s) void c.send("Page.handleJavaScriptDialog", { accept: false }, s).catch(() => undefined); });
      c.on("Inspector.targetCrashed", (_p, sid) => { if (sid === s) void this.end("crashed"); });
      // Everything the policy needs is in place before the first request (guard script, interception, emulation).
      // Interception pauses only what can navigate, write or reach a forbidden host (policy.ts interceptPatterns);
      // images, styles, fonts and scripts from public https hosts load without a round trip to Crestmont.
      await Promise.all([
        c.send("Page.enable", {}, s),
        c.send("Page.setLifecycleEventsEnabled", { enabled: true }, s).catch(() => undefined),
        c.send("Page.addScriptToEvaluateOnNewDocument", { source: GUARD_SCRIPT }, s),
        c.send("Page.setInterceptFileChooserDialog", { enabled: true }, s).catch(() => undefined),
        this.enableInterception(),
        this.emulate(),
      ]);
      await c.send("Page.navigate", { url: this.o.url }, s);
      await this.screencast();
      this.notify({ t: "ready", w: this.width, h: this.height, device: this.device });
      this.timers.push(setInterval(() => this.tick(), 5_000));
      // Measurements for the viewer (and the performance check), v2 only: what was produced, sent, dropped, and how
      // long frames and input take.
      this.timers.push(setInterval(() => { if (this.flow.v2) this.notify({ t: "stats", ...this.flow.stats(), inputMedMs: this.input.dispatchMedMs(), inputMerged: this.input.merged, castWidth: this.castWidth, quality: STREAM_QUALITY }); }, 2_000));
      if (this.o.heartbeat) this.timers.push(setInterval(() => { void this.o.heartbeat!().catch(() => undefined); }, 20_000));
    } catch (e) {
      this.notify({ t: "error", message: "The website could not be opened in the remote browser." });
      await this.end(`start-failed: ${(e as Error).message}`.slice(0, 60));
    }
  }

  private tick() {
    const t = this.now();
    if (t - this.lastInput > this.o.idleSeconds * 1000) void this.end("idle");
    else if (t - this.startedAt > this.o.maxSessionSeconds * 1000) void this.end("time-limit");
  }

  /** Fetch.enable with the narrowed patterns; a resource type this browser version does not know is dropped and the
   *  call repeated. If it still fails, every request is paused (the original, slower but always valid setting). */
  private async enableInterception() {
    let patterns = interceptPatterns();
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await this.cdp.send("Fetch.enable", { patterns }, this.page); return; } catch (e) {
        const bad = /Unknown resource type in fetch filter: '([A-Za-z]+)'/.exec((e as Error).message)?.[1];
        if (!bad) break;
        patterns = patterns.filter((p) => p.resourceType !== bad);
      }
    }
    await this.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, this.page);
  }
  private async emulate() {
    const mobile = this.device !== "desktop", s = this.page;
    // Phones and tablets get a mobile user agent so responsive sites serve their mobile layout (as browser device
    // emulation does). The browser stays identifiable as headless Chrome: no bot checks are evaded.
    const ua = this.desktopUA && mobile ? this.desktopUA.replace(/\([^)]*\)/, "(Linux; Android 14; K)").replace(/ Safari\//, " Mobile Safari/") : this.desktopUA;
    await Promise.all([
      this.cdp.send("Emulation.setDeviceMetricsOverride", { width: this.width, height: this.height, deviceScaleFactor: 1, mobile, screenWidth: this.width, screenHeight: this.height }, s),
      this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 }, s).catch(() => undefined),
      ua ? this.cdp.send("Emulation.setUserAgentOverride", { userAgent: ua, platform: mobile ? "Android" : "Linux" }, s).catch(() => undefined) : Promise.resolve(),
    ]);
  }
  /** Frames are captured no larger than the visitor's canvas is shown (in device pixels), up to the device width. */
  private castSize() {
    const w = this.viewPx > 0 ? Math.max(320, Math.min(this.width, this.viewPx)) : this.width;
    return { maxWidth: w, maxHeight: Math.round((this.height * w) / this.width) };
  }
  private async screencast() {
    const size = this.castSize();
    this.castWidth = size.maxWidth;
    await this.cdp.send("Page.stopScreencast", {}, this.page).catch(() => undefined);
    this.flow.restarted();
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: STREAM_QUALITY, ...size, everyNthFrame: 1 }, this.page);
  }

  private onFrame(p: Record<string, unknown>) {
    const id = Number(p.sessionId);
    if (this.ended || typeof p.data !== "string") { void this.cdp.send("Page.screencastFrameAck", { sessionId: id }, this.page).catch(() => undefined); return; }
    const bytes = decodeBase64(p.data);
    if (bytes.length > MAX_FRAME_BYTES) { void this.cdp.send("Page.screencastFrameAck", { sessionId: id }, this.page).catch(() => undefined); return; }
    this.flow.frame(bytes, id);
  }

  private async onRequest(p: Record<string, unknown>) {
    const s = this.page, req = p.request as { url: string; method: string };
    const requestId = String(p.requestId);
    try {
      const isNavigation = p.resourceType === "Document" && p.frameId === this.target;
      const d = decideRequest({ url: req.url, method: req.method, resourceType: String(p.resourceType ?? ""), isNavigation }, this.o.site);
      if (d.action === "continue") {
        const fx = this.o.fixture?.(req.url);
        if (fx) {
          await this.cdp.send("Fetch.fulfillRequest", { requestId, responseCode: fx.status, responseHeaders: Object.entries(fx.headers).map(([name, value]) => ({ name, value })), body: b64(fx.body) }, s);
          return;
        }
        await this.cdp.send("Fetch.continueRequest", { requestId }, s);
      } else if (d.action === "fail") {
        this.blocked++;
        await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, s);
      } else {
        this.blocked++;
        this.notify({ t: "blocked", title: d.title });
        await this.cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }, { name: "cache-control", value: "no-store" }], body: b64(blockPageHtml(d.title, d.message)) }, s);
      }
    } catch { /* the request was cancelled or the page went away */ }
  }

  /** Visitor input: validated, bounded and rate-limited before anything reaches the browser. */
  private async onClient(data: unknown) {
    if (this.ended || typeof data !== "string" || data.length > 4096) return;
    const t = this.now();
    if (t - this.msgWindow.at > 1000) this.msgWindow = { at: t, n: 0 };
    if (++this.msgWindow.n > 150) return; // more than 150 messages a second are dropped
    let m: Record<string, unknown>;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== "object") return;
    // Stream control (not input): the v2 viewer's hello, frame acknowledgements and its displayed size.
    if (m.t === "ack") { this.flow.ack(Number(m.n)); return; }
    if (m.t === "hello" || m.t === "view") {
      if (m.t === "hello" && Number(m.v) >= 2) this.flow.enableV2();
      const px = Math.round(Math.min(4000, Math.max(0, Number(m.cw) || 0)) * Math.min(2, Math.max(1, Number(m.dpr) || 1)));
      if (px && Math.abs(px - this.viewPx) > 24) { this.viewPx = px; if (this.castSize().maxWidth !== this.castWidth) await this.screencast().catch(() => undefined); }
      return;
    }
    if (m.t !== "ping") { this.lastInput = t; this.flow.input(t); } // a ping keeps nothing alive: only real input counts
    const s = this.page, W = this.width, H = this.height;
    const x = Math.min(W, Math.max(0, Number(m.x) || 0)), y = Math.min(H, Math.max(0, Number(m.y) || 0));
    const send = (method: string, params: Record<string, unknown>) => this.cdp.send(method, params, s).catch(() => undefined);
    const queue = (kind: InputItem["kind"], method: string, params: Record<string, unknown>) => this.input.push({ kind, method, params });
    switch (m.t) {
      case "mouse": {
        const type = ({ down: "mousePressed", up: "mouseReleased", move: "mouseMoved" } as Record<string, string>)[String(m.a)];
        if (!type) return;
        const button = ["left", "right", "middle"].includes(String(m.b)) ? String(m.b) : type === "mouseMoved" ? "none" : "left";
        queue(type === "mouseMoved" ? "move" : "other", "Input.dispatchMouseEvent", { type, x, y, button, clickCount: type === "mouseMoved" ? 0 : Math.min(3, Math.max(1, Number(m.n) || 1)) });
        return;
      }
      case "wheel": {
        const clamp = (v: unknown) => Math.min(5000, Math.max(-5000, Number(v) || 0));
        queue("wheel", "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: clamp(m.dx), deltaY: clamp(m.dy) });
        return;
      }
      case "touch": {
        const type = ({ start: "touchStart", move: "touchMove", end: "touchEnd", cancel: "touchCancel" } as Record<string, string>)[String(m.a)];
        if (!type) return;
        const pts = Array.isArray(m.p) ? (m.p as Record<string, unknown>[]).slice(0, 5).map((q, i) => ({ x: Math.min(W, Math.max(0, Number(q.x) || 0)), y: Math.min(H, Math.max(0, Number(q.y) || 0)), id: Number.isInteger(q.id) ? Number(q.id) % 100 : i })) : [];
        queue(type === "touchMove" ? "touchmove" : "other", "Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : pts });
        return;
      }
      case "key": {
        const key = String(m.key ?? "").slice(0, 24), code = String(m.code ?? "").slice(0, 24);
        if (!key) return;
        const down = m.a === "down", printable = key.length === 1;
        const vk = KEY_CODES[key] ?? (printable ? key.toUpperCase().charCodeAt(0) : 0);
        const mods = Math.min(15, Math.max(0, Number(m.mod) || 0));
        queue("other", "Input.dispatchKeyEvent", { type: down ? (printable && !(mods & 2) && !(mods & 4) ? "keyDown" : "rawKeyDown") : "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: mods, ...(down && printable && !(mods & 6) ? { text: key } : {}) });
        return;
      }
      case "nav": {
        if (m.a === "reload") await send("Page.reload", {});
        else if (m.a === "home") await send("Page.navigate", { url: this.o.url });
        else if (m.a === "back" || m.a === "forward") {
          const h = await this.cdp.send("Page.getNavigationHistory", {}, s).catch(() => null) as { currentIndex: number; entries: { id: number }[] } | null;
          const e = h && h.entries[h.currentIndex + (m.a === "back" ? -1 : 1)];
          if (e) await send("Page.navigateToHistoryEntry", { entryId: e.id });
        } else if (m.a === "path" && typeof m.path === "string" && /^\/[^\s]{0,300}$/.test(m.path)) {
          // A same-site path (still decided by the request policy, like any navigation).
          await send("Page.navigate", { url: new URL(m.path, this.o.url).toString() });
        }
        return;
      }
      case "device": {
        const d = String(m.d) as Device;
        if (!(d in DEVICE_WIDTH)) return;
        const touchBefore = this.device !== "desktop";
        this.device = d; this.height = clampH(m.h);
        // The viewer sends the canvas's new displayed size with the switch (frames are never larger than shown).
        const px = Math.round(Math.min(4000, Math.max(0, Number(m.cw) || 0)) * Math.min(2, Math.max(1, Number(m.dpr) || 1)));
        if (px) this.viewPx = px;
        await this.emulate().catch(() => undefined);
        // Desktop ↔ phone/tablet also changes the user agent and touch support, which a page only sees when it loads:
        // reload so the site serves the layout it would serve that device (as switching devices in DevTools does).
        if (touchBefore !== (d !== "desktop")) await send("Page.reload", {});
        await this.screencast().catch(() => undefined);
        this.notify({ t: "viewport", w: this.width, h: this.height, device: this.device });
        return;
      }
      default: return; // "ping" and anything unknown only count as activity
    }
  }

  async end(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    for (const t of this.timers) clearInterval(t);
    this.flow.stop();
    const seconds = Math.max(0, Math.round((this.now() - this.startedAt) / 1000));
    this.notify({ t: "ended", reason: reason.replace(/:.*$/, "") });
    try { this.client.close(1000, "session ended"); } catch { /* already closed */ }
    if (!this.cdp.closed) {
      await this.cdp.send("Page.stopScreencast", {}, this.page).catch(() => undefined);
      if (this.context) await this.cdp.send("Target.disposeBrowserContext", { browserContextId: this.context }).catch(() => undefined);
    }
    try { await this.o.closeBrowser?.(); } catch { /* best effort */ }
    try { await this.o.onEnd?.(reason, seconds); } catch { /* best effort */ }
  }
}
