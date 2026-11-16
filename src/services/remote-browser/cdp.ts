// Minimal Chrome DevTools Protocol client over a WebSocket (Cloudflare Browser Run, or a local Chromium in development
// and CI). Flattened sessions: page commands carry the target's sessionId. No dependencies.

/** The subset of WebSocket used here (Workers' WebSocket, Node's global WebSocket, dev/ws-server.ts). */
export interface SocketLike {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", fn: (ev: { data?: unknown; code?: number; reason?: string }) => void): void;
}

type Handler = (params: Record<string, unknown>, sessionId?: string) => void;
export class CdpError extends Error {}

export class Cdp {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly closeHandlers: (() => void)[] = [];
  closed = false;

  private readonly ws: SocketLike;
  private readonly timeoutMs: number;
  constructor(ws: SocketLike, timeoutMs = 20_000) {
    this.ws = ws; this.timeoutMs = timeoutMs;
    ws.addEventListener("message", (ev) => this.receive(ev.data));
    ws.addEventListener("close", () => this.shutdown());
    ws.addEventListener("error", () => this.shutdown());
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new CdpError(`${method}: connection closed`));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CdpError(`${method}: timed out`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(new CdpError(`${method}: ${(e as Error).message}`)); }
    });
  }

  on(method: string, fn: Handler) { (this.handlers.get(method) ?? this.handlers.set(method, new Set()).get(method)!).add(fn); }
  onClose(fn: () => void) { this.closeHandlers.push(fn); }

  close() { try { this.ws.close(1000, "done"); } catch { /* already closed */ } this.shutdown(); }

  private receive(data: unknown) {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data as Uint8Array);
    else return;
    let m: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string }; sessionId?: string };
    try { m = JSON.parse(text); } catch { return; }
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new CdpError(m.error.message ?? "CDP error")); else p.resolve(m.result ?? {});
    } else if (m.method) {
      for (const fn of this.handlers.get(m.method) ?? []) { try { fn(m.params ?? {}, m.sessionId); } catch { /* a handler never breaks the loop */ } }
    }
  }

  private shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new CdpError("connection closed")); }
    this.pending.clear();
    for (const fn of this.closeHandlers) { try { fn(); } catch { /* ignore */ } }
  }
}

/**
 * Browser Run's binding-only DevTools socket (/v1/connectDevtools) frames each CDP message as binary chunks of at most
 * 1 MiB, the first prefixed with the message's total byte length (uint32, little-endian), and expects the same when
 * sending. This adapter turns such a socket into a plain text-message socket for Cdp. (The standard /v1/devtools/browser
 * endpoint carries plain JSON and needs no adapter.)
 */
export function chunkedSocket(ws: SocketLike): SocketLike {
  const MAX = 1_048_576;
  const listeners: Record<string, ((ev: { data?: unknown; code?: number; reason?: string }) => void)[]> = { message: [], close: [], error: [] };
  let parts: Uint8Array[] = [], expected = -1, have = 0;
  ws.addEventListener("message", (ev) => {
    const d = ev.data;
    if (typeof d === "string") return; // keep-alive text ("pong"), not CDP
    const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array((d as Uint8Array).buffer, (d as Uint8Array).byteOffset, (d as Uint8Array).byteLength) : null;
    if (!bytes) return;
    if (expected < 0) { expected = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true); parts = [bytes.subarray(4)]; have = bytes.length - 4; }
    else { parts.push(bytes); have += bytes.length; }
    if (have < expected) return;
    const all = new Uint8Array(have); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    expected = -1; parts = []; have = 0;
    const text = new TextDecoder().decode(all);
    for (const fn of listeners.message!) fn({ data: text });
  });
  ws.addEventListener("close", (ev) => { for (const fn of listeners.close!) fn(ev); });
  ws.addEventListener("error", (ev) => { for (const fn of listeners.error!) fn(ev); });
  return {
    send(data) {
      const body = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      const first = new Uint8Array(Math.min(MAX, body.length + 4));
      new DataView(first.buffer).setUint32(0, body.length, true);
      first.set(body.subarray(0, first.length - 4), 4);
      ws.send(first);
      for (let i = first.length - 4; i < body.length; i += MAX) ws.send(body.subarray(i, i + MAX));
    },
    close: (code, reason) => ws.close(code, reason),
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
  };
}
