// Frame flow control for the remote browser (portfolio performance upgrade, 2026-11-16). Measured on production:
// Chromium's screencast was acknowledged the moment each frame arrived, so it produced frames as fast as it could
// (0.85–1.4 MB/s while a site merely animated) and every frame was pushed to the visitor whatever their connection
// could carry. On an ordinary link the frames queued up and every scroll or click waited behind seconds of stale
// pictures. This controller makes the stream demand-driven:
//   • a bounded number of frames is on its way to the visitor; the viewer confirms each picture it has drawn
//     ({t:"ack", n}), so a slow link or a slow device slows the stream instead of building a backlog. The bound adapts
//     (1–6 frames): it grows while round trips stay near the shortest seen (no queue) and drops as soon as they grow
//     (a queue forming) — a fixed two capped large desktop frames at ~11 fps on a link with 170 ms round trips;
//   • while frames cannot be sent, only the NEWEST waits (older ones are dropped, never queued) and Chromium is not
//     acknowledged, so it stops capturing and encoding pictures nobody will see. Chromium counts unacknowledged
//     screencast frames per screencast (the sessionId names the screencast, not the frame) and keeps producing while
//     at most two are outstanding (three in flight, content/browser/devtools/protocol/page_handler.cc). The controller
//     keeps Chromium at its limit and acknowledges ONE frame per frame sent, so in steady state it renders one picture
//     for each picture delivered (measured before this change: three rendered for every one sent). If a browser
//     version stops earlier, a frame that follows a guard acknowledgement at once reveals the lower limit, which is
//     then used;
//   • a frame-rate cap: 60 fps while the visitor is interacting, 30 fps otherwise (slow links are protected by the flow
//     control above, not by the cap; production showed 15 fps made animations visibly choppier on fast links);
//   • look-ahead: where Chromium takes longer to deliver a frame than the frame interval (measured per session: a full
//     desktop page on Browser Run), it may prepare the next picture while the current one travels, instead of waiting
//     for it — production measurement showed strict one-at-a-time halved the desktop frame rate;
//   • input boost: visitor input unblocks Chromium at once, so the picture answering a click or scroll is rendered
//     immediately rather than after the next scheduled frame;
//   • stall guard: a frame whose acknowledgement never comes (lost, tab frozen) is written off after STALL_MS.
// A viewer that never says {t:"hello", v:2} (an older cached portfolio.js) keeps the original behaviour.

export const MAX_IN_FLIGHT = 6;
export const START_IN_FLIGHT = 2;
export const INTERACTIVE_INTERVAL_MS = 16; // ≈60 fps
export const IDLE_INTERVAL_MS = 33;        // ≈30 fps
export const INTERACTIVE_WINDOW_MS = 1500; // "interacting" = input within this window
export const STALL_MS = 2000;
/** v2 binary frame header: "CM", flags, reserved, then the frame number (uint32 little-endian). */
export const HEADER_BYTES = 8;

export interface FlowHooks {
  now(): number;
  /** Deliver one frame to the visitor (already decoded JPEG bytes, with the v2 header when v2). */
  send(bytes: Uint8Array): void;
  /** Acknowledge Chromium's screencast frame(s), letting it produce the next one. */
  ackChrome(sessionId: number): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface FlowStats { produced: number; sent: number; dropped: number; inFlight: number; inflightCap: number; minRttMs: number | null; chromeLimit: number; produceMs: number | null; lookAhead: boolean; rttMedMs: number | null; bytesSent: number; intervalMs: number; v2: boolean }

export function frameHeader(seq: number, flags = 0): Uint8Array {
  const h = new Uint8Array(HEADER_BYTES);
  h[0] = 0x43; h[1] = 0x4d; h[2] = flags & 0xff;
  new DataView(h.buffer).setUint32(4, seq >>> 0, true);
  return h;
}

export class FrameFlow {
  v2 = false;
  private seq = 0;
  private acked = 0;
  private pending: Uint8Array | null = null;
  /** Frames Chromium considers unacknowledged, its limit, and the screencast to acknowledge. */
  private inChrome = 0;
  private chromeId = 0;
  limit = 3;
  private guard: unknown = null;
  private guardAck: { at: number; level: number } | null = null;
  /** Time from acknowledging a blocked Chromium to its next frame (render + transfer), smoothed. */
  produceMs: number | null = null;
  private blockedAckAt: number | null = null;
  private lastSentAt = -Infinity;
  private lastInputAt = -Infinity;
  private timer: unknown = null;
  private sentAt = new Map<number, number>();
  private rtts: number[] = [];
  /** Adaptive in-flight bound and the shortest recent round trip (the link without a queue). */
  inflightCap = START_IN_FLIGHT;
  private minRtt: number | null = null;
  private minRttAt = 0;
  private learn = { level: 0, count: 0 };
  produced = 0; sent = 0; dropped = 0; bytesSent = 0;
  private readonly h: FlowHooks;
  constructor(hooks: FlowHooks) { this.h = hooks; }

  get inFlight() { return this.seq - this.acked; }
  intervalMs(now = this.h.now()) { return now - this.lastInputAt < INTERACTIVE_WINDOW_MS ? INTERACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS; }
  /** Visitor input: the stream switches to the interactive rate at once. */
  input(now = this.h.now()) {
    this.lastInputAt = now;
    if (!this.v2) return;
    // Input boost: let Chromium render the answer to this input now (it may be blocked at its limit while idle).
    if (!this.pending && this.inChrome >= this.limit) this.ackOnce();
    this.pump();
  }
  enableV2() { this.v2 = true; }

  /** A frame from Chromium (JPEG bytes) with its screencast session id. */
  frame(bytes: Uint8Array, chromeId: number) {
    this.produced++;
    this.chromeId = chromeId;
    if (!this.v2) { this.h.ackChrome(chromeId); this.sent++; this.bytesSent += bytes.length; this.h.send(bytes); return; }
    // A frame right after a guard acknowledgement: Chromium had been blocked at that level — that is its limit.
    // (Only when nothing else explains the frame: no input just before, and it came almost at once.)
    // Never below 2 and only after three confirmations: production showed slow, irregular desktop frames on Browser Run
    // can coincide with a guard acknowledgement (a false "limit 1" halved the frame rate).
    if (this.guardAck && this.h.now() - this.guardAck.at < 60 && this.guardAck.at - this.lastInputAt > 600 && this.guardAck.level >= 2 && this.guardAck.level < this.limit) {
      this.learn = this.learn.level === this.guardAck.level ? { level: this.learn.level, count: this.learn.count + 1 } : { level: this.guardAck.level, count: 1 };
      if (this.learn.count >= 3) this.limit = this.learn.level;
    }
    this.guardAck = null;
    if (this.blockedAckAt !== null) { const d = this.h.now() - this.blockedAckAt; this.produceMs = this.produceMs === null ? d : this.produceMs * 0.7 + d * 0.3; this.blockedAckAt = null; }
    this.inChrome++;
    this.armGuard();
    // Newest wins: an unsent older frame is dropped (it is never acknowledged on its own).
    if (this.pending) this.dropped++;
    this.pending = bytes;
    this.pump();
  }
  /** A new screencast (device or size change) starts with nothing in flight. */
  restarted() { this.inChrome = 0; this.guardAck = null; }
  private ackOnce() {
    if (this.inChrome <= 0) return;
    if (this.inChrome >= this.limit) this.blockedAckAt = this.h.now();
    this.inChrome--; this.h.ackChrome(this.chromeId);
  }
  /** Chromium may prepare one frame ahead when it is slower than the frame interval. */
  private get lookAhead() { return this.produceMs !== null && this.produceMs > this.intervalMs(); }
  /** If nothing arrives for a while with acknowledgements withheld, give one: a still page does not answer (nothing
   *  changed); a blocked browser answers at once with a frame, which teaches the limit (see frame()). */
  private armGuard() {
    if (this.guard !== null) this.h.clearTimer(this.guard);
    this.guard = this.h.setTimer(() => {
      this.guard = null;
      if (this.v2 && this.inChrome > 0 && !this.pending) { this.guardAck = { at: this.h.now(), level: this.inChrome }; this.ackOnce(); }
    }, 300);
  }

  /** The viewer has drawn (or skipped past) every frame up to n. */
  ack(n: number, now = this.h.now()) {
    if (!Number.isInteger(n) || n <= this.acked || n > this.seq) return;
    const at = this.sentAt.get(n);
    if (at !== undefined) {
      const rtt = now - at;
      this.rtts.push(rtt); if (this.rtts.length > 60) this.rtts.shift();
      // The link without a queue: the shortest round trip in the last 10 s.
      if (this.minRtt === null || rtt <= this.minRtt || now - this.minRttAt > 10_000) { this.minRtt = rtt; this.minRttAt = now; }
      if (rtt <= this.minRtt * 1.5 + 30) this.inflightCap = Math.min(MAX_IN_FLIGHT, this.inflightCap + 0.25);
      else if (rtt > this.minRtt * 2 + 80) this.inflightCap = Math.max(1, this.inflightCap - 1);
    }
    for (const k of this.sentAt.keys()) if (k <= n) this.sentAt.delete(k);
    this.acked = n;
    this.pump();
  }

  private pump() {
    if (!this.pending) return;
    const now = this.h.now();
    if (this.inFlight >= Math.floor(this.inflightCap)) {
      if (now - this.lastSentAt > STALL_MS) { this.acked = this.seq; this.sentAt.clear(); } // written off
      else { this.arm(STALL_MS - (now - this.lastSentAt) + 1); return; }
    }
    const wait = this.intervalMs(now) - (now - this.lastSentAt);
    if (wait > 0) { this.arm(wait); return; }
    const bytes = this.pending;
    this.pending = null;
    const n = ++this.seq;
    const out = new Uint8Array(HEADER_BYTES + bytes.length);
    out.set(frameHeader(n), 0); out.set(bytes, HEADER_BYTES);
    this.lastSentAt = now; this.sentAt.set(n, now);
    this.sent++; this.bytesSent += bytes.length;
    this.h.send(out);
    // Only now may Chromium capture the next picture: never more than one (two with look-ahead) beyond what is delivered.
    if (this.inChrome >= this.limit) this.ackOnce();
    if (this.lookAhead && this.inChrome >= this.limit - 1) this.ackOnce();
  }
  private arm(ms: number) {
    if (this.timer !== null) return;
    this.timer = this.h.setTimer(() => { this.timer = null; this.pump(); }, Math.max(1, Math.ceil(ms)));
  }
  stop() { if (this.timer !== null) this.h.clearTimer(this.timer); if (this.guard !== null) this.h.clearTimer(this.guard); this.timer = null; this.guard = null; this.pending = null; }

  stats(): FlowStats {
    const s = [...this.rtts].sort((a, b) => a - b);
    return { produced: this.produced, sent: this.sent, dropped: this.dropped, inFlight: this.inFlight, inflightCap: Math.floor(this.inflightCap), minRttMs: this.minRtt === null ? null : Math.round(this.minRtt), chromeLimit: this.limit, produceMs: this.produceMs === null ? null : Math.round(this.produceMs), lookAhead: this.lookAhead, rttMedMs: s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]!) : null, bytesSent: this.bytesSent, intervalMs: this.intervalMs(), v2: this.v2 };
  }
}

/** Visitor input, kept in order but with consecutive moves merged (the newest pointer/touch position wins, wheel
 *  deltas add up), and dispatched one at a time: a busy page never accumulates a queue of stale input. */
export type InputItem = { kind: "move" | "wheel" | "touchmove" | "other"; params: Record<string, unknown>; method: string };
export class InputQueue {
  private q: InputItem[] = [];
  private busy = false;
  merged = 0; dispatched = 0; private times: number[] = [];
  private readonly run: (it: InputItem) => Promise<unknown>;
  private readonly now: () => number;
  constructor(run: (it: InputItem) => Promise<unknown>, now: () => number) { this.run = run; this.now = now; }
  push(it: InputItem) {
    const last = this.q[this.q.length - 1];
    if (last && last.kind === it.kind && it.kind !== "other") {
      if (it.kind === "wheel") {
        const clamp = (v: number) => Math.min(5000, Math.max(-5000, v));
        last.params = { ...it.params, deltaX: clamp(Number(last.params.deltaX) + Number(it.params.deltaX)), deltaY: clamp(Number(last.params.deltaY) + Number(it.params.deltaY)) };
      } else last.params = it.params;
      this.merged++;
      return;
    }
    if (this.q.length >= 64) return; // a flood is dropped rather than queued (the client is rate-limited anyway)
    this.q.push(it);
    void this.drain();
  }
  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.q.length) {
        const it = this.q.shift()!;
        const t = this.now();
        await this.run(it).catch(() => undefined);
        this.dispatched++; this.times.push(this.now() - t); if (this.times.length > 60) this.times.shift();
      }
    } finally { this.busy = false; }
  }
  get pendingCount() { return this.q.length; }
  dispatchMedMs() { const s = [...this.times].sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]!) : null; }
}

/** Base64 → bytes, natively where the runtime offers it (Workers with nodejs_compat and Node have Buffer). */
export function decodeBase64(s: string): Uint8Array {
  const B = (globalThis as unknown as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (B) return B.from(s, "base64");
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Keeps the visitor's messages that arrive before the session is listening (its hello is sent the moment the socket
 *  opens, while the browser is still being acquired) and hands them to the first message listener, in order. */
export function holdEarlyMessages<T extends { addEventListener(type: "message" | "close" | "error", fn: (ev: { data?: unknown }) => void): void }>(ws: T): T {
  const early: { data?: unknown }[] = [];
  let target: ((ev: { data?: unknown }) => void) | null = null;
  ws.addEventListener("message", (ev) => { if (target) target(ev); else if (early.length < 32) early.push(ev); });
  const add = ws.addEventListener.bind(ws);
  return new Proxy(ws, {
    get(o, k) {
      if (k === "addEventListener") return (type: "message" | "close" | "error", fn: (ev: { data?: unknown }) => void) => {
        if (type !== "message") return add(type, fn);
        if (!target) { target = fn; for (const ev of early.splice(0)) fn(ev); return; }
        const prev = target; target = (ev) => { prev(ev); fn(ev); };
      };
      const v = (o as Record<PropertyKey, unknown>)[k];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(o) : v;
    },
  });
}
