// Minimal RFC 6455 WebSocket server side for the development server (no dependencies). It is used only by
// dev/server.ts to serve the portfolio remote-browser socket locally and in CI; production uses Cloudflare's WebSocketPair.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { SocketLike } from "../src/services/remote-browser/cdp.ts";

type Ev = { data?: unknown; code?: number; reason?: string };

/** Completes the handshake and returns a SocketLike for the connection, or null (the socket is closed). */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): SocketLike | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") { socket.destroy(); return null; }
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const listeners: Record<string, ((e: Ev) => void)[]> = { message: [], close: [], error: [] };
  const emit = (t: string, e: Ev) => { for (const f of listeners[t] ?? []) { try { f(e); } catch { /* listener error */ } } };
  let buf = Buffer.alloc(0), closed = false, parts: Buffer[] = [], partOp = 0;
  const frame = (op: number, payload: Buffer) => {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    return Buffer.concat([head, payload]);
  };
  const shut = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    try { const p = Buffer.alloc(2 + Buffer.byteLength(reason)); p.writeUInt16BE(code, 0); p.write(reason, 2); socket.end(frame(8, p)); } catch { /* gone */ }
    emit("close", { code, reason });
  };
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0]! & 0x80) !== 0, op = buf[0]! & 0x0f, masked = (buf[1]! & 0x80) !== 0;
      let len = buf[1]! & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 4 * 1024 * 1024) { shut(1009, "too big"); socket.destroy(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = buf.subarray(off, off + 4); payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4]!)); }
      buf = buf.subarray(need);
      if (op === 8) { shut(payload.length >= 2 ? payload.readUInt16BE(0) : 1000); return; }
      if (op === 9) { try { socket.write(frame(10, payload)); } catch { /* gone */ } continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) { parts = [payload]; partOp = op; }
      else if (op === 0) parts.push(payload);
      if (fin && parts.length) {
        const all = Buffer.concat(parts); parts = [];
        emit("message", { data: partOp === 1 ? all.toString("utf8") : new Uint8Array(all) });
      }
    }
  });
  socket.on("close", () => { if (!closed) { closed = true; emit("close", { code: 1006 }); } });
  socket.on("error", () => emit("error", {}));
  return {
    send(data) {
      if (closed) throw new Error("closed");
      socket.write(typeof data === "string" ? frame(1, Buffer.from(data, "utf8")) : frame(2, Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)));
    },
    close(code, reason) { shut(code ?? 1000, reason ?? ""); },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
  };
}
