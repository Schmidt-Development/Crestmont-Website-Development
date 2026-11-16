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
import { decideRequest, blockPageHtml, GUARD_SCRIPT } from "./policy.ts";

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
const unb64 = (s: string) => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const KEY_CODES: Record<string, number> = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
const MAX_FRAME_BYTES = 900_000; // Workers WebSocket messages are limited to 1 MiB

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
  blocked = 0;

  private readonly cdp: Cdp;
  private readonly client: SocketLike;
  private readonly o: SessionOptions;
  constructor(cdp: Cdp, client: SocketLike, o: SessionOptions) {
    this.cdp = cdp; this.client = client; this.o = o;
    this.device = o.device; this.height = clampH(o.height);
    this.startedAt = this.lastInput = this.now();
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
      const v = await c.send("Browser.getVersion").catch(() => ({} as Record<string, unknown>));
      this.desktopUA = String(v.userAgent ?? "");
      this.context = String((await c.send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId ?? "");
      await c.send("Browser.setDownloadBehavior", { behavior: "deny", ...(this.context ? { browserContextId: this.context } : {}) }).catch(() => undefined);
      this.target = String((await c.send("Target.createTarget", { url: "about:blank", ...(this.context ? { browserContextId: this.context } : {}) })).targetId);
      this.page = String((await c.send("Target.attachToTarget", { targetId: this.target, flatten: true })).sessionId);
      // New windows opened by the site (window.open is also disabled in-page) are closed at once.
      await c.send("Target.setDiscoverTargets", { discover: true });
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
      c.on("Page.javascriptDialogOpening", (_p, sid) => { if (sid === s) void c.send("Page.handleJavaScriptDialog", { accept: false }, s).catch(() => undefined); });
      c.on("Inspector.targetCrashed", (_p, sid) => { if (sid === s) void this.end("crashed"); });
      await c.send("Page.enable", {}, s);
      await c.send("Page.addScriptToEvaluateOnNewDocument", { source: GUARD_SCRIPT }, s);
      await c.send("Page.setInterceptFileChooserDialog", { enabled: true }, s).catch(() => undefined);
      await c.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, s);
      await this.emulate();
      await c.send("Page.navigate", { url: this.o.url }, s);
      await this.screencast();
      this.notify({ t: "ready", w: this.width, h: this.height, device: this.device });
      this.timers.push(setInterval(() => this.tick(), 5_000));
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

  private async emulate() {
    const mobile = this.device !== "desktop", s = this.page;
    await this.cdp.send("Emulation.setDeviceMetricsOverride", { width: this.width, height: this.height, deviceScaleFactor: 1, mobile, screenWidth: this.width, screenHeight: this.height }, s);
    await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 }, s).catch(() => undefined);
    // Phones and tablets get a mobile user agent so responsive sites serve their mobile layout (as browser device
    // emulation does). The browser stays identifiable as headless Chrome: no bot checks are evaded.
    if (this.desktopUA) {
      const ua = mobile ? this.desktopUA.replace(/\([^)]*\)/, "(Linux; Android 14; K)").replace(/ Safari\//, " Mobile Safari/") : this.desktopUA;
      await this.cdp.send("Emulation.setUserAgentOverride", { userAgent: ua, platform: mobile ? "Android" : "Linux" }, s).catch(() => undefined);
    }
  }
  private async screencast() {
    await this.cdp.send("Page.stopScreencast", {}, this.page).catch(() => undefined);
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: this.width, maxHeight: this.height, everyNthFrame: 1 }, this.page);
  }

  private onFrame(p: Record<string, unknown>) {
    void this.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, this.page).catch(() => undefined);
    if (this.ended || typeof p.data !== "string") return;
    const bytes = unb64(p.data);
    if (bytes.length > MAX_FRAME_BYTES) return;
    try { this.client.send(bytes); } catch { /* client gone */ }
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
    if (m.t !== "ping") this.lastInput = t; // a ping keeps nothing alive: only real input counts against the idle timer
    const s = this.page, W = this.width, H = this.height;
    const x = Math.min(W, Math.max(0, Number(m.x) || 0)), y = Math.min(H, Math.max(0, Number(m.y) || 0));
    const send = (method: string, params: Record<string, unknown>) => this.cdp.send(method, params, s).catch(() => undefined);
    switch (m.t) {
      case "mouse": {
        const type = ({ down: "mousePressed", up: "mouseReleased", move: "mouseMoved" } as Record<string, string>)[String(m.a)];
        if (!type) return;
        const button = ["left", "right", "middle"].includes(String(m.b)) ? String(m.b) : type === "mouseMoved" ? "none" : "left";
        await send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: type === "mouseMoved" ? 0 : Math.min(3, Math.max(1, Number(m.n) || 1)) });
        return;
      }
      case "wheel": {
        const clamp = (v: unknown) => Math.min(5000, Math.max(-5000, Number(v) || 0));
        await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: clamp(m.dx), deltaY: clamp(m.dy) });
        return;
      }
      case "touch": {
        const type = ({ start: "touchStart", move: "touchMove", end: "touchEnd", cancel: "touchCancel" } as Record<string, string>)[String(m.a)];
        if (!type) return;
        const pts = Array.isArray(m.p) ? (m.p as Record<string, unknown>[]).slice(0, 5).map((q, i) => ({ x: Math.min(W, Math.max(0, Number(q.x) || 0)), y: Math.min(H, Math.max(0, Number(q.y) || 0)), id: Number.isInteger(q.id) ? Number(q.id) % 100 : i })) : [];
        await send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : pts });
        return;
      }
      case "key": {
        const key = String(m.key ?? "").slice(0, 24), code = String(m.code ?? "").slice(0, 24);
        if (!key) return;
        const down = m.a === "down", printable = key.length === 1;
        const vk = KEY_CODES[key] ?? (printable ? key.toUpperCase().charCodeAt(0) : 0);
        const mods = Math.min(15, Math.max(0, Number(m.mod) || 0));
        await send("Input.dispatchKeyEvent", { type: down ? (printable && !(mods & 2) && !(mods & 4) ? "keyDown" : "rawKeyDown") : "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: mods, ...(down && printable && !(mods & 6) ? { text: key } : {}) });
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
