// scripts/worker-faults.ts reads a `wrangler tail` capture and reports what the WORKER said about a 500.
//
// It exists because of a specific blind spot. app_errors is written by recordAppError, which writes to D1 —
// so when D1 is the fault, the error log cannot record it, and the deploy's error-log step correctly reports
// "no application errors" for pages that plainly failed. Staging deploy #159 was that shape: four
// consecutive Owner modules at 500 and an empty error log. The Worker's own console output does not depend
// on D1, so it still answers in exactly the case that blinds the other instrument.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFaults, requestPath, isLostErrorRecord } from "../scripts/worker-faults.ts";

const tail = (...lines: unknown[]) => lines.map((l) => typeof l === "string" ? l : JSON.stringify(l)).join("\n");

test("[INFRA-006] an unhandled exception is reported with its path", () => {
  const faults = parseFaults(tail({
    outcome: "ok", event: { request: { url: "https://staging.example.dev/staff/readiness", method: "GET" } },
    logs: [{ level: "error", message: [JSON.stringify({ level: "error", path: "/staff/readiness", message: "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window" })] }],
  }));
  assert.equal(faults.length, 1);
  assert.equal(faults[0].path, "/staff/readiness");
  assert.match(faults[0].message, /D1 DB is overloaded/);
});

test("[INFRA-006] a lost error record is identified as D1 refusing writes, not as healthy pages", () => {
  // This is the line recordAppError now logs when its own INSERT fails. Recognising it is the whole point:
  // an empty app_errors then means the log could not be written, not that nothing went wrong.
  const faults = parseFaults(tail({
    event: { request: { url: "https://staging.example.dev/staff/profitability" } },
    logs: [{ level: "error", message: [JSON.stringify({ level: "error", message: "app_errors write failed; the error below was not recorded", reason: "D1_ERROR: D1 DB is overloaded", path: "/staff/profitability", original: "boom" })] }],
  }));
  assert.equal(faults.length, 1);
  assert.equal(isLostErrorRecord(faults[0]), true);
  assert.equal(isLostErrorRecord({ level: "error", path: null, message: "something else", count: 1 }), false);
});

test("[SEC-007] every captured line is redacted: a workflow log of a public repository is public", () => {
  // app.ts logs the raw message and stack. F-18/F-19 were credentials published in a workflow artifact of
  // this public repository, so nothing from the Worker may be printed verbatim.
  const faults = parseFaults(tail({
    event: { request: { url: "https://staging.example.dev/api/webhooks/stripe" } },
    logs: [{ level: "error", message: ["refused key sk_test_abcdef0123456789 and re_abcdefghijklmnop for sk-ant-aaaaaaaaaaaa"] }],
  }));
  assert.equal(faults.length, 1);
  for (const secret of ["sk_test_abcdef0123456789", "re_abcdefghijklmnop", "sk-ant-aaaaaaaaaaaa"]) {
    assert.ok(!faults[0].message.includes(secret), `${secret} must not survive`);
  }
  assert.match(faults[0].message, /sk_test_\[redacted\]/);
});

test("[INFRA-006] identical faults are counted, not repeated", () => {
  const one = {
    event: { request: { url: "https://staging.example.dev/staff/sales" } },
    logs: [{ level: "error", message: ["the same fault"] }],
  };
  const faults = parseFaults(tail(one, one, one));
  assert.equal(faults.length, 1);
  assert.equal(faults[0].count, 3, "three occurrences of one fault, not three faults");
});

test("[INFRA-006] exceptions and non-ok outcomes are captured even with no log line", () => {
  const byEx = parseFaults(tail({
    event: { request: { url: "https://staging.example.dev/x" } },
    exceptions: [{ name: "Error", message: "Network connection lost" }], outcome: "exception",
  }));
  assert.equal(byEx.length, 1, "the exception is reported once, not also as an outcome");
  assert.match(byEx[0].message, /Network connection lost/);

  const byOutcome = parseFaults(tail({ event: { request: { url: "https://staging.example.dev/y" } }, outcome: "exceededCpu" }));
  assert.equal(byOutcome.length, 1);
  assert.match(byOutcome[0].message, /exceededCpu/);

  // A successful request contributes nothing.
  assert.deepEqual(parseFaults(tail({ outcome: "ok", logs: [{ level: "log", message: ["fine"] }] })), []);
});

test("[INFRA-006] a line that is not JSON is kept, and wrangler's own banner is not", () => {
  // A crash can print something that is not a log line, and that is exactly when this is worth reading.
  const faults = parseFaults(tail(
    "⛅️ wrangler 4.149.0",
    "Connected to crestmont-platform-staging, waiting for logs...",
    "Error: something printed outside the log format",
  ));
  assert.equal(faults.length, 1);
  assert.match(faults[0].message, /printed outside the log format/);
});

test("[INFRA-006] requestPath keeps the path and drops the origin", () => {
  assert.equal(requestPath("https://staging.example.dev/staff/readiness/env/staging"), "/staff/readiness/env/staging");
  assert.equal(requestPath("https://staging.example.dev/a?b=c"), "/a?");
  assert.equal(requestPath(undefined), null);
  assert.equal(requestPath("not a url"), null);
});

// ───────────── Coverage: what the capture is entitled to claim ─────────────
//
// The first real run of this instrument reported "the Worker logged nothing at error level" for failures it
// had not been listening for. Deploy #160: capture started 21:30:01 with a 25-minute bound, so it died at
// 21:55:01; the sweep that produced the 500s ran 21:56:33 to 22:08:20. Meanwhile app_errors DID hold a row
// for one of those 500s — D1 overload at loadContent — so the two instruments contradicted each other, and
// mine was the one that was wrong. An instrument that cannot state its own coverage will eventually report
// silence it never listened for.

test("[INFRA-006] coversUntil is false once the capture has stopped before the moment in question", async () => {
  const { coversUntil } = await import("../scripts/worker-faults.ts");
  const sweepStarted = new Date("2026-11-05T21:56:33Z");

  // Deploy #160 exactly: started, bounded, dead before the failing step began.
  assert.equal(coversUntil({ startedAt: "2026-11-05T21:30:01Z", endedAt: "2026-11-05T21:55:01Z", alive: false, lines: 12 }, sweepStarted), false);
  // Still running when the report was taken: it does cover it.
  assert.equal(coversUntil({ startedAt: "2026-11-05T21:30:01Z", endedAt: null, alive: true, lines: 900 }, sweepStarted), true);
  // Stopped, but not until after the moment.
  assert.equal(coversUntil({ startedAt: "2026-11-05T21:30:01Z", endedAt: "2026-11-05T22:09:00Z", alive: false, lines: 900 }, sweepStarted), true);
  // Never started: covers nothing.
  assert.equal(coversUntil({ startedAt: null, endedAt: null, alive: false, lines: 0 }, sweepStarted), false);
});

test("[INFRA-006] a capture that never connected says so, and claims nothing either way", () => {
  // wrangler failing to connect produces a file with no JSON and no banner. Reporting that as "the Worker
  // was quiet" would be worse than reporting nothing.
  const faults = parseFaults("some unrelated noise\n");
  assert.equal(faults.length, 1, "the noise is kept rather than dropped");
  assert.match(faults[0].message, /unrelated noise/);
});

test("[INFRA-006] wrangler tail --format json is pretty-printed: whole events are parsed, not one fault per line", async () => {
  const { parseFaults, splitCapture } = await import("../scripts/worker-faults.ts");
  // Shaped like deploy #164's capture: multi-line events, a "{" inside a string, and a banner line between events.
  const ev = (url: string, logs: unknown[], outcome = "ok") => JSON.stringify({ outcome, event: { request: { url, method: "GET", cf: { tlsClientRandom: "abc=", clientTcpRtt: 8 } } }, logs, exceptions: [] }, null, 2);
  const capture = [
    "Successfully created tail, expires at 2026-11-06T06:31:55Z",
    ev("https://x.workers.dev/staff/owner", []),
    ev("https://x.workers.dev/staff/sales", [
      { level: "error", message: ['{"level":"error","message":"app_errors write failed; the error below was not recorded","reason":"D1_ERROR: D1 DB is overloaded"}'] },
      { level: "error", message: ['{"level":"error","path":"/staff/sales","message":"D1_ERROR: D1 DB is overloaded { brace in a string"}'] },
    ], "exception"),
    ev("https://x.workers.dev/api/health?tailprobe=p1", [{ level: "log", message: ["fine"] }]),
  ].join("\n");
  const pieces = splitCapture(capture);
  assert.equal(pieces.filter((p) => p.kind === "json").length, 3);
  const faults = parseFaults(capture);
  assert.ok(faults.every((f) => f.path === "/staff/sales"), JSON.stringify(faults.map((f) => [f.level, f.path, f.message.slice(0, 60)])));
  assert.equal(faults.filter((f) => f.level === "error").length, 2);
  assert.ok(faults.some((f) => /D1 DB is overloaded \{ brace/.test(f.message)));
  assert.ok(!faults.some((f) => /tlsClientRandom|clientTcpRtt/.test(f.message)), "no event fields leak out as faults");
  // A truncated last event (the capture killed mid-write) is kept as raw text, not lost.
  assert.equal(splitCapture('{"a":1}\n{"outcome":"exc').at(-1)!.kind, "text");
});
