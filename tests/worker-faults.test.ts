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
