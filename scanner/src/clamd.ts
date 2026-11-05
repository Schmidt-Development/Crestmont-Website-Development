// Minimal clamd client: PING, VERSION and INSTREAM over TCP (the z-terminated command form).
// No dependencies. Every operation is bounded by a timeout and the stream by the caller's byte limit.
import { connect, type Socket } from "node:net";

export interface ClamdOptions { host: string; port: number; timeoutMs: number }
export type StreamVerdict = { kind: "clean" } | { kind: "found"; signature: string } | { kind: "error"; message: string };

export class ClamdUnavailable extends Error {}

/** Sends one command, optionally streams data, and returns clamd's reply without the trailing NUL. */
function exchange(o: ClamdOptions, command: string, data?: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    let sock: Socket;
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (err: Error | null, v?: string) => {
      if (settled) return; settled = true;
      clearTimeout(timer); sock?.destroy();
      if (err) reject(err); else resolve(v!);
    };
    const timer = setTimeout(() => done(new ClamdUnavailable(`clamd did not answer ${command} within ${o.timeoutMs} ms`)), o.timeoutMs);
    sock = connect({ host: o.host, port: o.port }, () => {
      sock.write(`z${command}\0`);
      if (data) {
        // INSTREAM: <uint32 BE length><bytes> chunks, ended by a zero-length chunk.
        const CHUNK = 64 * 1024;
        for (let i = 0; i < data.length; i += CHUNK) {
          const part = data.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4); len.writeUInt32BE(part.length, 0);
          sock.write(len); sock.write(part);
        }
        sock.write(Buffer.alloc(4));
      }
    });
    sock.on("data", (b) => {
      chunks.push(b);
      const all = Buffer.concat(chunks);
      const nul = all.indexOf(0);
      if (nul >= 0) done(null, all.subarray(0, nul).toString("utf8").trim());
      if (all.length > 64 * 1024) done(new Error("clamd reply too long"));
    });
    sock.on("end", () => done(null, Buffer.concat(chunks).toString("utf8").replace(/\0+$/, "").trim()));
    sock.on("error", (e) => done(new ClamdUnavailable(`clamd unreachable at ${o.host}:${o.port}: ${(e as NodeJS.ErrnoException).code ?? e.message}`)));
  });
}

export async function ping(o: ClamdOptions): Promise<boolean> {
  return (await exchange(o, "PING")) === "PONG";
}

/** "ClamAV 1.4.3/27450/Tue Nov  4 08:26:19 2026" → engine string and the signature database time (UTC). */
export function parseVersion(v: string): { engine: string; signaturesAt: string | null } {
  const engine = v.trim().slice(0, 120);
  const m = /\/\d+\/(?:[A-Z][a-z]{2}) ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(engine);
  if (!m) return { engine, signaturesAt: null };
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(m[1]);
  if (month < 0) return { engine, signaturesAt: null };
  // clamd prints its local time; the container runs in UTC (TZ is not set in the compose file).
  return { engine, signaturesAt: new Date(Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))).toISOString() };
}

export async function version(o: ClamdOptions) { return parseVersion(await exchange(o, "VERSION")); }

/** Parses an INSTREAM reply: "stream: OK", "stream: <name> FOUND", or "<message> ERROR". */
export function parseStreamReply(reply: string): StreamVerdict {
  const r = reply.replace(/^stream:\s*/, "");
  if (r === "OK") return { kind: "clean" };
  const found = /^(.+) FOUND$/.exec(r);
  if (found) return { kind: "found", signature: found[1].trim().slice(0, 200) };
  return { kind: "error", message: (r.replace(/ ERROR$/, "") || "empty reply from clamd").slice(0, 200) };
}

export async function scanBytes(o: ClamdOptions, bytes: Uint8Array): Promise<StreamVerdict> {
  return parseStreamReply(await exchange(o, "INSTREAM", bytes));
}
