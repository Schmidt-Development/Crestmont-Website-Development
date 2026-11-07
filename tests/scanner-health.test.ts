// The scanner's own health report, which is what a person reads to decide whether scanning is working.
//
// [SCAN-H1] existed because /healthz answered 200 with ok:true while still quoting
// "queue: /api/scan/queue -> HTTP 401: Signature mismatch" from before the staging credential was synchronised.
// lastError was only ever assigned, never cleared, so a recovered scanner kept describing a fault that was over --
// and a stale error in a health field is read as the current state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { Scanner } from "../scanner/src/scanner.ts";

/** A clamd that answers PING and VERSION, so a cycle can reach the queue. Nothing is ever streamed to it here. */
function fakeClamd(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv: Server = createServer((sock) => {
    sock.on("data", (b) => {
      const cmd = b.toString("utf8").replace(/^z/, "").replace(/\0+$/, "");
      if (cmd === "PING") sock.write("PONG\0");
      else if (cmd === "VERSION") sock.write("ClamAV 1.5.1/28175/Fri Nov  6 06:24:43 2026\0");
      else sock.write("UNKNOWN COMMAND\0");
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    resolve({ port, close: () => new Promise<void>((r) => srv.close(() => r())) });
  }));
}

const EMPTY = { files: [] as { fileId: string; sha256: string; sizeBytes: number; scanStatus: string }[], maxBytes: 26_214_400 };

test("[SCAN-H1] a successful cycle clears the error from a failed one, so health describes now and not the past", async () => {
  const clamd = await fakeClamd();
  try {
    let refuse = true;
    const api = {
      queue: async () => { if (refuse) throw new Error("queue: /api/scan/queue → HTTP 401: Signature mismatch"); return EMPTY; },
      file: async () => { throw new Error("not reached"); },
      result: async () => ({ ok: true as const }),
      heartbeat: async () => ({ ok: true as const, seenAt: new Date().toISOString() }),
    };
    const scanner = new Scanner(
      { scannerId: "test", batch: 10, maxBytes: 26_214_400, clamd: { host: "127.0.0.1", port: clamd.port, timeoutMs: 2000 } },
      api as unknown as Parameters<typeof Scanner.prototype.constructor>[1],
    );

    const bad = await scanner.cycle();
    assert.match(bad.error ?? "", /401/, "the refusal is reported");
    assert.match(scanner.health(300_000).lastError ?? "", /401/, "and recorded");
    assert.equal(scanner.health(300_000).lastCycleOk, false);

    refuse = false;
    const good = await scanner.cycle();
    assert.equal(good.error, null, "the second cycle succeeds");
    const h = scanner.health(300_000);
    assert.equal(h.lastCycleOk, true);
    assert.equal(h.lastError, null, "the error from before the fix is gone, not carried forward");
    assert.equal(h.ok, true);
  } finally { await clamd.close(); }
});
