// Remote-browser performance guarantees (portfolio performance upgrade, 2026-11-16). Measured on production before this
// change: Chromium's screencast was acknowledged on arrival, so it rendered as fast as it could (0.85–1.4 MB/s while a
// site merely animated) and every frame was pushed whatever the visitor's link could carry — on a 5 Mbit/s connection a
// scroll took 0.9–2.4 s to show. These tests pin the flow control that fixes it, with a simulated Chromium and a
// simulated viewer, so a later change cannot silently bring the backlog back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameFlow, InputQueue, holdEarlyMessages, decodeBase64, frameHeader, MAX_IN_FLIGHT, INTERACTIVE_INTERVAL_MS, IDLE_INTERVAL_MS, HEADER_BYTES } from "../src/services/remote-browser/stream.ts";

/** A virtual clock with timers. */
function clock() {
  let t = 0; const timers: { at: number; fn: () => void; id: number }[] = []; let next = 1;
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const id = next++; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimer: (id: unknown) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
    advance(ms: number) { const end = t + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const x = timers[0]; if (!x || x.at > end) break; timers.shift(); t = x.at; x.fn(); } t = end; },
  };
}

/** Chromium's screencast: renders a frame whenever its unacknowledged count allows (an always-animating page). A frame
 *  takes renderMs to capture (one at a time) and transferMs more to reach the Durable Object; acknowledgements take
 *  transferMs back. */
function chrome(c: ReturnType<typeof clock>, limit = 3, renderMs = 10, transferMs = 0, frameBytes = 1000) {
  const st = { inFlight: 0, produced: 0, flow: null as FrameFlow | null, busy: false };
  const tryRender = () => {
    if (st.busy || st.inFlight >= limit || !st.flow) return;
    st.busy = true; st.inFlight++;
    c.setTimer(() => { st.busy = false; st.produced++; c.setTimer(() => st.flow!.frame(new Uint8Array(frameBytes), 7), Math.max(1, transferMs)); tryRender(); }, renderMs);
  };
  return { st, tryRender, ack: () => { c.setTimer(() => { st.inFlight = Math.max(0, st.inFlight - 1); tryRender(); }, Math.max(1, transferMs)); } };
}

/** A viewer on a link that delivers each frame after `delayMs` (one way) — through a queue at `bytesPerMs` when given —
 *  and acknowledges it after drawing (the acknowledgement takes `delayMs` back). */
function setup(opts: { limit?: number; delayMs?: number; v2?: boolean; renderMs?: number; transferMs?: number; frameBytes?: number; bytesPerMs?: number | ((t: number) => number); jitterMs?: number } = {}) {
  const c = clock(); const ch = chrome(c, opts.limit ?? 3, opts.renderMs ?? 10, opts.transferMs ?? 0, opts.frameBytes ?? 1000);
  const delivered: { at: number; n: number; sentAt: number }[] = [];
  let linkFreeAt = 0;
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const oneWay = () => (opts.delayMs ?? 20) + (opts.jitterMs ? (rnd() - 0.5) * 2 * opts.jitterMs : 0);
  let flow!: FrameFlow;
  flow = new FrameFlow({
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    ackChrome: () => ch.ack(),
    send: (bytes) => {
      const n = bytes[0] === 0x43 && bytes[1] === 0x4d ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true) : 0;
      const sentAt = c.now();
      // The link serialises frames at its speed (a queue forms when frames are sent faster than it carries them).
      const rate = typeof opts.bytesPerMs === "function" ? opts.bytesPerMs(sentAt) : opts.bytesPerMs;
      linkFreeAt = Math.max(sentAt, linkFreeAt) + (rate ? bytes.length / rate : 0);
      const arrive = linkFreeAt + oneWay();
      c.setTimer(() => { delivered.push({ at: c.now(), n, sentAt }); if (n) c.setTimer(() => flow.ack(n, c.now()), Math.max(1, oneWay())); }, Math.max(1, arrive - sentAt));
    },
  });
  if (opts.v2 !== false) flow.enableV2();
  ch.st.flow = flow; ch.tryRender();
  return { c, ch, flow, delivered };
}

test("[PORT-006] stream: one picture rendered per picture delivered when Chromium is fast — never ahead of the viewer", () => {
  const { c, ch, flow } = setup({ renderMs: 5 });
  c.advance(5000);
  const s = flow.stats();
  assert.ok(s.sent > 100, `frames flow (${s.sent})`);
  assert.ok(ch.st.produced <= s.sent * 1.1 + 4, `rendered ${ch.st.produced} for ${s.sent} sent (was 3:1 before)`);
});

test("[PORT-006] stream: a slow Chromium (a full desktop page) keeps its full frame rate — it prepares one frame ahead", () => {
  // Measured on production: ~75 ms to render a 1440 px frame, plus transfer to the Durable Object.
  const { c, ch, flow } = setup({ renderMs: 75, transferMs: 60 });
  c.advance(10_000);
  const s = flow.stats();
  assert.ok(s.sent >= 100, `≥ 10 fps delivered (${s.sent / 10} fps; one-at-a-time gives ~1000/(75+2·60) ≈ 5 fps)`);
  assert.equal(s.lookAhead, true, `look-ahead engaged (produce ${s.produceMs} ms > interval)`);
  assert.ok(ch.st.produced <= s.sent * 2 + 4, `at most one extra render per frame (${ch.st.produced} for ${s.sent})`);
});

test("[PORT-006] stream: idle 30 fps, interacting 60 fps — an animating site does not flood the link", () => {
  const { c, flow } = setup({ renderMs: 5 });
  c.advance(4000);
  const idle = flow.stats().sent;
  assert.ok(idle >= 110 && idle <= 124, `idle: ${idle} frames in 4 s (cap ${Math.round(1000 / IDLE_INTERVAL_MS)} fps)`);
  for (let i = 0; i < 40; i++) { flow.input(c.now()); c.advance(50); } // 2 s of input
  const busy = flow.stats().sent - idle;
  assert.ok(busy >= 100 && busy <= 126, `interacting: ${busy} frames in 2 s (cap ${Math.round(1000 / INTERACTIVE_INTERVAL_MS)} fps)`);
});

test("[PORT-006] stream: input unblocks Chromium at once (the answer to a click is rendered immediately)", () => {
  const { c, ch, flow } = setup({ renderMs: 5, delayMs: 20 });
  c.advance(2000);
  const before = ch.st.produced;
  // A still moment: Chromium at its limit with nothing pending, then input.
  flow.input(c.now());
  c.advance(INTERACTIVE_INTERVAL_MS + 10); // one interactive interval + render + acknowledgement
  assert.ok(ch.st.produced > before, `a frame was rendered within ${INTERACTIVE_INTERVAL_MS + 10} ms of the input`);
});

test("[PORT-006] stream: a slow, distant viewer gets fresh frames — never a backlog (in flight bounded)", () => {
  const { c, flow, delivered } = setup({ delayMs: 200 }); // 0.4 s round trip
  let maxInFlight = 0;
  for (let i = 0; i < 600; i++) { c.advance(10); maxInFlight = Math.max(maxInFlight, flow.inFlight); }
  assert.ok(maxInFlight <= MAX_IN_FLIGHT, `in flight ≤ ${MAX_IN_FLIGHT} (saw ${maxInFlight})`);
  // Input now: the next picture must arrive within one round trip + one interval, not after a queue of stale ones.
  const t0 = c.now(); flow.input(t0);
  c.advance(2000);
  const after = delivered.filter((d) => d.at > t0);
  assert.ok(after.length && after[0]!.at - t0 <= 400 + IDLE_INTERVAL_MS, `first frame after input in ${after[0]!.at - t0} ms`);
  assert.ok(flow.stats().dropped > 0, "stale frames were dropped, not queued");
});

test("[PORT-006] stream: large desktop frames on a real link — more than two in flight when there is no queue (production: 46 KB, ~170 ms)", () => {
  // Browser Run desktop page: ~60 ms to render a 46 KB frame; the visitor's link: 1 MB/s, 40 ms each way.
  const { c, flow, delivered } = setup({ renderMs: 60, transferMs: 30, frameBytes: 46_000, bytesPerMs: 1000, delayMs: 40 });
  c.advance(10_000);
  const fps = delivered.filter((d) => d.at > 2000).length / 8;
  const lat = delivered.filter((d) => d.at > 2000).map((d) => d.at - d.sentAt).sort((a, b) => a - b);
  assert.ok(fps >= 12, `≥ 12 fps (${fps.toFixed(1)}; a fixed two in flight gave ~11 on production)`);
  assert.ok(lat[Math.floor(lat.length * 0.95)]! <= 250, `95th percentile frame delay ${lat[Math.floor(lat.length * 0.95)]} ms (≤ 250: no queue)`);
});

test("[PORT-006] stream: a 5 Mbit/s link carries what it can and no backlog builds (the production failure before the upgrade)", () => {
  // 625 KB/s, 30 ms each way, 30 KB frames from an always-animating page.
  const { c, flow, delivered } = setup({ renderMs: 15, frameBytes: 30_000, bytesPerMs: 625, delayMs: 30 });
  c.advance(10_000);
  const late = delivered.filter((d) => d.at > 3000);
  const lat = late.map((d) => d.at - d.sentAt).sort((a, b) => a - b);
  const fps = late.length / 7;
  assert.ok(fps >= 12, `the link is used: ${fps.toFixed(1)} fps of 30 KB (≈ ${Math.round(fps * 30)} of 625 KB/s)`);
  assert.ok(lat[Math.floor(lat.length * 0.95)]! <= 300, `95th percentile frame delay ${lat[Math.floor(lat.length * 0.95)]} ms (≤ 300; before the upgrade it grew without bound)`);
  assert.ok(flow.inflightCap <= MAX_IN_FLIGHT);
});

/** Frames per second and median / 95th-percentile frame delay (sent → arrived) of the frames that arrived in [from, to). */
function window(delivered: { at: number; sentAt: number }[], from: number, to: number) {
  const l = delivered.filter((d) => d.at >= from && d.at < to).map((d) => d.at - d.sentAt).sort((a, b) => a - b);
  return { fps: l.length / ((to - from) / 1000), p50: l[l.length >> 1] ?? Infinity, p95: l[Math.floor(l.length * 0.95)] ?? Infinity };
}

test("[PORT-006] stream: when the link slows down mid-session, the backlog drains and never creeps back", () => {
  // 5 Mbit/s → 2 Mbit/s after 5 s, 30 KB frames, 30 ms each way. On the slower link one frame takes 120 ms to send, so
  // the queue-free frame delay is ~150 ms. Before this fix a round trip measured with frames queued became the
  // reference after 10 s, the bound climbed back to 4 and frame delays settled at ~450 ms.
  const { c, flow, delivered } = setup({ renderMs: 60, transferMs: 30, frameBytes: 30_000, bytesPerMs: (t) => (t < 5000 ? 625 : 250), delayMs: 30 });
  c.advance(30_000);
  for (const [from, to] of [[12_000, 18_000], [18_000, 24_000], [24_000, 30_000]] as const) {
    const w = window(delivered, from, to);
    assert.ok(w.p50 <= 250, `${from / 1000}–${to / 1000} s: median frame delay ${Math.round(w.p50)} ms (≤ 250: at most one frame queued)`);
    assert.ok(w.p95 <= 400, `${from / 1000}–${to / 1000} s: 95th percentile ${Math.round(w.p95)} ms (≤ 400)`);
    assert.ok(w.fps >= 6, `${from / 1000}–${to / 1000} s: ${w.fps.toFixed(1)} fps (the slower link stays in use)`);
  }
  assert.ok(flow.inflightCap <= 3, `in-flight bound ${flow.inflightCap} on the slow link`);
});

test("[PORT-006] stream: a fast but jittery phone link keeps its frame rate (jitter is not mistaken for a queue)", () => {
  // 2 MB/s, 15 KB phone frames, 40 ms ± 35 ms each way, Chromium renders a phone frame in 15 ms.
  const { c, delivered } = setup({ renderMs: 15, transferMs: 30, frameBytes: 15_000, bytesPerMs: 2000, delayMs: 40, jitterMs: 35 });
  c.advance(20_000);
  const w = window(delivered, 5000, 20_000);
  assert.ok(w.fps >= 20, `${w.fps.toFixed(1)} fps (≥ 20)`);
  assert.ok(w.p95 <= 150, `95th percentile frame delay ${Math.round(w.p95)} ms (≤ 150: jitter only, no queue)`);
});

test("[PORT-006] stream: a frame whose acknowledgement never comes does not freeze the stream", () => {
  const c = clock(); const ch = chrome(c);
  const flow = new FrameFlow({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, ackChrome: () => ch.ack(), send: () => undefined }); // viewer never acks
  flow.enableV2(); ch.st.flow = flow; ch.tryRender();
  c.advance(10_000);
  assert.ok(flow.stats().sent >= 6, `stall guard keeps it alive (${flow.stats().sent} sent)`);
});

test("[PORT-006] stream: a browser that stops at two in flight is detected and never stalls", () => {
  const { c, flow } = setup({ limit: 2 });
  c.advance(6000);
  assert.equal(flow.limit, 2, "the lower limit was learned");
  assert.ok(flow.stats().sent > 60, `frames keep flowing (${flow.stats().sent} in 6 s)`);
});

test("[PORT-006] stream: an older viewer (no hello) keeps the original behaviour", () => {
  const { c, flow, delivered } = setup({ v2: false });
  c.advance(1000);
  assert.equal(flow.v2, false);
  assert.ok(delivered.length > 50, "every frame forwarded at once (as before)");
  assert.ok(delivered.every((d) => d.n === 0), "no v2 header");
});

test("[PORT-006] frame header and base64 decoding", () => {
  const h = frameHeader(258, 1);
  assert.equal(h.length, HEADER_BYTES);
  assert.deepEqual([...h], [0x43, 0x4d, 1, 0, 2, 1, 0, 0]);
  assert.deepEqual([...decodeBase64("/9j/4A==")], [0xff, 0xd8, 0xff, 0xe0], "JPEG magic");
});

test("[PORT-006] input: moves and wheel steps merge, clicks keep their order, one dispatch at a time", async () => {
  const done: string[] = [];
  let release: (() => void) | null = null;
  const q = new InputQueue(async (it) => { done.push(`${it.params.type}:${it.params.deltaY ?? it.params.x ?? ""}`); await new Promise<void>((r) => { release = r; }); }, () => 0);
  q.push({ kind: "move", method: "m", params: { type: "move", x: 1 } }); // dispatched at once
  q.push({ kind: "wheel", method: "m", params: { type: "wheel", deltaX: 0, deltaY: 100 } });
  q.push({ kind: "wheel", method: "m", params: { type: "wheel", deltaX: 0, deltaY: 50 } });
  q.push({ kind: "move", method: "m", params: { type: "move", x: 2 } });
  q.push({ kind: "move", method: "m", params: { type: "move", x: 3 } });
  q.push({ kind: "other", method: "m", params: { type: "press", x: 3 } });
  for (let i = 0; i < 6 && release; i++) { const r: () => void = release; release = null; r(); await new Promise((x) => setTimeout(x, 0)); }
  assert.deepEqual(done, ["move:1", "wheel:150", "move:3", "press:3"], "wheel deltas added, latest pointer position, order kept");
  assert.equal(q.merged, 2);
});

test("[PORT-006] early visitor messages (the hello) are kept until the session listens", () => {
  const listeners: ((e: { data?: unknown }) => void)[] = [];
  const ws = { addEventListener: (_t: string, fn: (e: { data?: unknown }) => void) => { listeners.push(fn); }, send: () => undefined };
  const held = holdEarlyMessages(ws as never) as typeof ws;
  for (const fn of listeners) fn({ data: '{"t":"hello","v":2}' });
  const got: unknown[] = [];
  held.addEventListener("message", (e) => got.push(e.data));
  for (const fn of listeners) fn({ data: '{"t":"ack","n":1}' });
  assert.deepEqual(got, ['{"t":"hello","v":2}', '{"t":"ack","n":1}']);
});
