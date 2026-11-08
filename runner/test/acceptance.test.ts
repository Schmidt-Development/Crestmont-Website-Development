// The independent functional acceptance gate: what it derives from the contract, and what it refuses to call a pass.
//
// The gate it replaces ran `verify-backend.mjs` — a file Model B writes. The model authored both the
// implementation and the test that judged it, so a verifier exiting 0 without asserting anything produced "all
// acceptance checks passed". These tests cover the part that is genuinely independent: checks derived from the
// integration manifest, which is written before the work and belongs to the project rather than to the model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DRIVER, DRIVER_SOURCE, PLAN, acceptancePlan, coverageChecks, readAcceptanceOutput, startCommand, summarise, writeAcceptanceDriver,
} from "../src/frontend/acceptance.ts";
import type { IntegrationManifest, ManifestContract } from "../src/frontend/integration-manifest.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "acc-"));

const manifest = (over: Partial<IntegrationManifest & ManifestContract> = {}): IntegrationManifest & ManifestContract => ({
  schema: "crestmont.integration-manifest/1",
  artifactSha: "a".repeat(64),
  designFingerprint: "d".repeat(64),
  operations: [],
  apis: [
    { method: "POST", path: "/api/register", auth: "public", success: 201, invalid: 422 },
    { method: "GET", path: "/api/appointments", auth: "customer", success: 200, unauthenticated: 401 },
    { method: "POST", path: "/api/appointments/:id/cancel", auth: "customer", success: 200, invalid: 422, unauthenticated: 401 },
  ],
  projectConfig: { allowedNewScripts: ["start", "api", "migrate"] },
  ...over,
} as IntegrationManifest & ManifestContract);

test("[ACC-01] undetermined is never a pass, and a driver that said nothing is not a pass either", () => {
  // The whole point. A check that could not be evaluated tells us nothing about whether the work is good, and
  // the directive's rule is that nothing may be claimed to have passed unless it actually ran and passed.
  // The counts are part of the verdict now: the repair loop measures progress by them, and "ok or not" cannot
  // say whether a cycle fixed three of four failing checks.
  assert.deepEqual(summarise([]), {
    ran: false, ok: false,
    detail: "the independent acceptance driver produced no result, so nothing was verified",
    passed: 0, failed: 0, undetermined: 0, environment: 0,
  });

  const withUndetermined = summarise([
    { id: "app:starts", ok: true, detail: "started" },
    { id: "GET /api/x :: authenticated success", ok: false, undetermined: true, detail: "needs a credential" },
  ]);
  assert.equal(withUndetermined.ran, true);
  assert.equal(withUndetermined.ok, false, "one undetermined check is enough to withhold a pass");
  assert.match(withUndetermined.detail, /could not be evaluated/);
  assert.deepEqual(
    { passed: withUndetermined.passed, failed: withUndetermined.failed, undetermined: withUndetermined.undetermined },
    { passed: 1, failed: 0, undetermined: 1 },
    "and the counts say which, so a later cycle can be compared with this one",
  );

  // A build-machine problem is also never a pass -- nothing was verified -- but it is counted apart from the
  // implementation's failures, because the repair loop must not charge the model for a port it does not own.
  const environment = summarise([
    { id: "app:starts", ok: false, undetermined: true, environment: true, detail: "the port was taken while it was starting" },
  ]);
  assert.equal(environment.ok, false, "nothing was verified, so nothing passed");
  assert.deepEqual(
    { failed: environment.failed, undetermined: environment.undetermined, environment: environment.environment },
    { failed: 0, undetermined: 0, environment: 1 },
    "the machine's failure is the machine's, and is not charged to the implementation",
  );
  assert.match(environment.detail, /could not be attempted on this build machine/);

  const failing = summarise([
    { id: "app:starts", ok: true, detail: "started" },
    { id: "GET /api/x :: refuses anonymous", ok: false, detail: "declared 401, answered 200" },
  ]);
  assert.equal(failing.ok, false);
  assert.match(failing.detail, /declared 401, answered 200/, "the measurement is in the verdict, not just a count");
  assert.deepEqual({ passed: failing.passed, failed: failing.failed, undetermined: failing.undetermined }, { passed: 1, failed: 1, undetermined: 0 });

  const passing = summarise([
    { id: "app:starts", ok: true, detail: "started" },
    { id: "GET /api/x :: refuses anonymous", ok: true, detail: "401 as declared" },
  ]);
  assert.deepEqual(passing, { ran: true, ok: true, detail: "2 contract check(s) passed against the running application", passed: 2, failed: 0, undetermined: 0, environment: 0 });
});

test("[ACC-02] the plan is derived from the contract and the project's own scripts, never invented", () => {
  const repo = tmp();
  // No package.json at all: nothing to start, and that is reported rather than guessed.
  assert.equal(startCommand(repo, manifest()), null);

  // A server file the integration added, with no script for it.
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { build: "vite build" } }));
  writeFileSync(path.join(repo, "server.js"), "// server");
  assert.deepEqual(startCommand(repo, manifest()), ["node", "--no-warnings", "server.js"]);

  // A script the contract allowed takes precedence over guessing at files.
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { build: "vite build", start: "node server.js" } }));
  assert.deepEqual(startCommand(repo, manifest()), ["npm", "run", "start"]);

  // A script the contract did NOT allow is not used: the integration was told which scripts it may add.
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { serve: "node other.js" } }));
  const strict = manifest({ projectConfig: { allowedNewScripts: ["start"] } });
  assert.deepEqual(startCommand(repo, strict), ["node", "--no-warnings", "server.js"], "falls back to the server file, not to an unapproved script");

  const plan = acceptancePlan(repo, manifest());
  assert.equal(plan.endpoints.length, 3);
  assert.deepEqual(plan.endpoints[1], { method: "GET", path: "/api/appointments", auth: "customer", success: 200, invalid: undefined, unauthenticated: 401, requestExample: undefined });
  assert.ok(plan.port > 0);
});

test("[ACC-03] the driver is the runner's own file, rewritten every cycle so the model cannot edit it", () => {
  const repo = tmp();
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { start: "node server.js" } }));

  // A model that wrote its own file at the driver's path has it overwritten.
  mkdirSync(path.join(repo, path.dirname(DRIVER)), { recursive: true });
  writeFileSync(path.join(repo, DRIVER), "process.exit(0); // nothing asserted");

  const written = writeAcceptanceDriver(repo, acceptancePlan(repo, manifest()));
  assert.equal(written.driver, DRIVER);
  assert.ok(existsSync(path.join(repo, PLAN)));
  const onDisk = readFileSync(path.join(repo, DRIVER), "utf8");
  assert.equal(onDisk, DRIVER_SOURCE, "the runner's driver, not whatever was there before");
  assert.doesNotMatch(onDisk, /nothing asserted/);

  // The plan is data the driver reads, so what is exercised is auditable beside the result.
  const plan = JSON.parse(readFileSync(path.join(repo, PLAN), "utf8")) as { endpoints: unknown[] };
  assert.equal(plan.endpoints.length, 3);
});

test("[ACC-04] the driver reports its results as data, and partial output is not misread as success", () => {
  assert.deepEqual(readAcceptanceOutput(""), []);
  assert.deepEqual(readAcceptanceOutput("starting\nnothing structured here\n"), []);

  // Application noise before the result line is normal; the last JSON line is the result.
  const out = 'listening on 8099\n{"results":[{"id":"app:starts","ok":true,"detail":"started"}]}\n';
  assert.deepEqual(readAcceptanceOutput(out), [{ id: "app:starts", ok: true, detail: "started" }]);

  // Malformed JSON is not a pass.
  assert.deepEqual(readAcceptanceOutput('{"results":[{'), []);
  assert.equal(summarise(readAcceptanceOutput('{"results":[{')).ok, false);
});

test("[ACC-05] the driver source itself only ever reports what it measured", () => {
  // Read rather than run: running it needs an application. What matters here is that it cannot report a pass it
  // did not establish — it exits non-zero when any check failed, and it never invents a path parameter's value.
  assert.match(DRIVER_SOURCE, /process\.exit\(results\.some\(\(r\) => !r\.ok\) \? 1 : 0\)/);
  assert.match(DRIVER_SOURCE, /crestmont-acceptance-nonexistent/, "a declared :id is probed with a value that must not exist");
  assert.match(DRIVER_SOURCE, /add\("app:starts", false,[\s\S]{0,200}could not be started/, "an application that will not start is a reported failure");
  assert.doesNotMatch(DRIVER_SOURCE, /verify-backend/, "the independent driver does not consult anything the model wrote");

  // It obtains its OWN credentials rather than carrying any, and the contract never holds a secret.
  assert.match(DRIVER_SOURCE, /const unique = "acc-" \+ Date\.now\(\)/, "credentials are generated per run");
  assert.match(DRIVER_SOURCE, /replaceAll\("\{\{email\}\}"/, "the contract states a body shape, not a credential");
  assert.match(DRIVER_SOURCE, /the contract requires authentication but declares no register\/login endpoint/,
    "a contract that requires authentication and does not say how is undetermined, not skipped");
  // But a site with nothing to sign in to is not an unknown. It used to be reported as one, and because
  // undetermined is never a pass, a brochure site with one public form could never pass the functional gate.
  assert.match(DRIVER_SOURCE, /if \(!plan\.authExpected\)/, "applicability is read from the contract");
  assert.match(DRIVER_SOURCE, /add\("auth:not-applicable", true/,
    "no authenticated surface means there is nothing to authenticate, not something unverified");

  // The properties that matter most, each asserted to be measured rather than assumed.
  assert.match(DRIVER_SOURCE, /auth:cookie-flags/, "HttpOnly and SameSite are checked on the real cookie");
  assert.match(DRIVER_SOURCE, /auth:same-answer-for-unknown-email/, "an unknown address must not be distinguishable from a wrong password");
  assert.match(DRIVER_SOURCE, /refuses a customer session/, "a staff endpoint must refuse a customer session");
  assert.match(DRIVER_SOURCE, /a customer can read staff data/, "and the failure says what it means");
  assert.match(DRIVER_SOURCE, /persistence:session-survives-restart/, "a session held only in memory is not a session");
  assert.match(DRIVER_SOURCE, /status === 403/, "an empty list is not a refusal");
});

const probedOp = {
  id: "staff-schedule", element: "table.schedule", kind: "data-read" as const,
  behaviour: "staff see every appointment", expectChange: "content" as const,
  acceptance: [
    "a staff session receives every appointment",
    "a customer session is refused with 403 rather than receiving an empty list",
    "an unauthenticated request is refused with 401",
  ],
  acceptanceProbes: [
    { criterion: 1, as: "customer" as const, method: "GET", path: "/api/appointments", expect: 403 },
    { criterion: 2, as: "anonymous" as const, method: "GET", path: "/api/appointments", expect: 401 },
  ],
};

test("[ACC-06] a criterion the contract made executable is run and reported, and is no longer counted as unverified", () => {
  // Before this, every written criterion was reported UNDETERMINED whatever the driver had done -- including the
  // seven of Northgate's 28 that it had just established. A criterion something DID establish and that is still
  // reported unverified is not caution, it is a wrong answer.
  const m = manifest({ operations: [probedOp] as never });
  const plan = acceptancePlan(tmp(), m);

  assert.equal(plan.probes.length, 2, "both probes reach the plan the driver reads");
  assert.deepEqual(plan.probes.map((p) => p.id),
    ["staff-schedule :: acceptance[1]", "staff-schedule :: acceptance[2]"],
    "under exactly the ids coverageChecks would have used, so one criterion never appears twice");
  assert.equal(plan.probes[0].text, probedOp.acceptance[1], "the criterion travels with its probe");
  assert.equal(plan.probes[0].as, "customer");
  assert.equal(plan.probes[1].expect, 401);

  // And the coverage pass must now leave those two alone, reporting only the one with no probe.
  const left = coverageChecks(m as never);
  assert.deepEqual(left.map((c) => c.id), ["staff-schedule :: acceptance[0]"]);
  assert.ok(left[0].undetermined, "a criterion with no probe is still undetermined, which still fails the gate");
});

test("[ACC-07] the driver executes probes from the session the contract named, and never infers a result", () => {
  // The driver source is the thing that runs, so the behaviour has to be visible in it rather than inferred.
  assert.match(DRIVER_SOURCE, /for \(const pr of plan\.probes \|\| \[\]\)/, "it iterates the contract's probes");
  assert.match(DRIVER_SOURCE, /pr\.as === "customer" \? session : pr\.as === "other-customer" \? otherSession : ""/,
    "each probe runs from the session it declared");
  assert.match(DRIVER_SOURCE, /no " \+ pr\.as \+ " session was obtained/, "and is undetermined when that session is missing");
  // Judged against what the contract declared and nothing the driver decided for itself: the status, and -- for
  // a criterion about what the page shows -- the text the contract said must or must not appear.
  assert.match(DRIVER_SOURCE, /res\.status !== pr\.expect/, "the declared status is still the first thing judged");
  assert.match(DRIVER_SOURCE, /for \(const want of pr\.expectBodyContains \|\| \[\]\)/,
    "and a criterion about what the page shows is executed against the response, not left unverified");
  assert.match(DRIVER_SOURCE, /the response does not contain/, "a content failure says what was missing");
  assert.ok(!/probes[\s\S]*ok: true/.test(DRIVER_SOURCE), "no probe result is assumed");
});

// ── The port the application is started on ────────────────────────────────────────────────────────────────────
//
// These two execute the real driver against a real server, because the defect they pin could not be seen in the
// driver's text. Staging reported `app:starts` FAILED with "the application did not answer on port 8099" and an
// EADDRINUSE from node:net, on a build whose application was fine: the job container is long-lived across repair
// cycles, so a server leaked by an earlier cycle (the driver is killed by the command timeout before it can stop
// the group it spawned) still held the one hardcoded port. Model B was then handed that as its own defect.
test("[ACC-08] a port already in use is the environment's problem, not the application's", async () => {
  const { createServer } = await import("node:net");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const repo = mkdtempSync(path.join(tmpdir(), "acc-port-"));

  // An application that does the one thing every application must: listen on the PORT it was given.
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "a", scripts: { serve: "node server.mjs" } }));
  writeFileSync(path.join(repo, "server.mjs"), [
    'import { createServer } from "node:http";',
    'createServer((_q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end("<!doctype html>ok"); })',
    '  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("listening on " + process.env.PORT));',
  ].join("\n"));

  const plan = acceptancePlan(repo, manifest({ projectConfig: { allowedNewScripts: ["serve"] } } as never));
  assert.deepEqual(plan.start, ["npm", "run", "serve"], "the project's own script is what gets started");

  // Hold the port the plan asked for, exactly as a leaked server from an earlier cycle would.
  const squatter = createServer(() => {});
  await new Promise<void>((r) => squatter.listen(plan.port, "127.0.0.1", () => r()));
  try {
    writeAcceptanceDriver(repo, plan);
    const { stdout } = await promisify(execFile)(process.execPath, ["--no-warnings", DRIVER], { cwd: repo, timeout: 90_000 })
      .catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
    const starts = readAcceptanceOutput(stdout).find((c) => c.id === "app:starts");
    assert.ok(starts, `the driver reported no app:starts: ${stdout.slice(0, 400)}`);
    assert.equal(starts.ok, true, `a healthy application was failed because the port was taken: ${starts.detail}`);
  } finally {
    await new Promise<void>((r) => squatter.close(() => r()));
  }
});

test("[ACC-09] an application that ignores PORT is told exactly that", () => {
  // The same symptom text ("did not answer on port N") was also produced by an application that started
  // perfectly and listened somewhere else -- staging logged {"port":32897} while the driver probed 8099. That is
  // a real defect in the application, and a repairable one, but only if the report says which defect it is.
  assert.match(DRIVER_SOURCE, /instead of the PORT it was given/,
    "an application listening on the wrong port must be told that, not 'did not answer'");
  assert.match(DRIVER_SOURCE, /EADDRINUSE/,
    "and a port held by something else must be named as an environment problem, not the application's");
});

test("[ACC-10] a criterion about what the page shows is executed, not left undetermined", async () => {
  // The criterion that blocked bld_278d69e4e40bf1 after everything else passed: "The index page still renders the
  // form#quote with its Name input and Send button unchanged after a submission." Nothing about it is ambiguous
  // and nothing about it was checkable, because a probe could only assert a status code. One undetermined
  // criterion is never a pass, so the functional gate could not close on a site that worked.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const repo = mkdtempSync(path.join(tmpdir(), "acc-body-"));

  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "a", scripts: { serve: "node server.mjs" } }));
  writeFileSync(path.join(repo, "server.mjs"), [
    'import { createServer } from "node:http";',
    'createServer((q, s) => {',
    '  s.writeHead(200, { "content-type": "text/html" });',
    // The form is still there after a submission, and no stack trace is leaked. Both are probed below.
    '  s.end(q.url === "/api/quote" ? "<p>Thank you</p><form id=quote><input name=name><button>Send</button></form>" : "<form id=quote><input name=name><button>Send</button></form>");',
    '}).listen(Number(process.env.PORT), "127.0.0.1");',
  ].join("\n"));

  const op = {
    id: "store-quote-name", page: "index", element: "form#quote", kind: "form-submit",
    behaviour: "Store a quote request.", expectChange: "content",
    acceptance: ["the request is stored", "the page still renders form#quote with its Name input and Send button"],
    acceptanceProbes: [{
      criterion: 1, as: "anonymous", method: "POST", path: "/api/quote", expect: 200,
      expectBodyContains: ['<form id=quote', 'name=name', "<button>Send</button>"],
      expectBodyAbsent: ["Traceback", "at Object.<anonymous>"],
    }],
  };
  const plan = acceptancePlan(repo, manifest({
    operations: [op], apis: [{ method: "POST", path: "/api/quote", auth: "public", success: 200 }],
    projectConfig: { allowedNewScripts: ["serve"] },
  } as never));
  assert.equal(plan.probes.length, 1, "the contract made the criterion executable");
  assert.deepEqual(plan.probes[0].expectBodyContains, ['<form id=quote', 'name=name', "<button>Send</button>"],
    "and the plan carries what must be shown, not just the status");

  writeAcceptanceDriver(repo, plan);
  const { stdout } = await promisify(execFile)(process.execPath, ["--no-warnings", DRIVER], { cwd: repo, timeout: 90_000 })
    .catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
  const checks = readAcceptanceOutput(stdout);
  const probed = checks.find((c) => c.id === "store-quote-name :: acceptance[1]");
  assert.ok(probed, `the criterion was not reported at all: ${stdout.slice(0, 500)}`);
  assert.equal(probed.ok, true, `the criterion was established and should have passed: ${probed.detail}`);
  assert.equal(probed.undetermined ?? false, false, "it was executed, so it is not an unknown");

  // And it is not reported a second time as unverified by the coverage list.
  assert.equal(coverageChecks({ operations: [op] } as never).length, 1,
    "only the criterion with no probe is still counted as unverified");
});

test("[ACC-11] a content probe that is not satisfied fails, and says what was missing", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const repo = mkdtempSync(path.join(tmpdir(), "acc-body-bad-"));
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "a", scripts: { serve: "node server.mjs" } }));
  // Answers 200 and loses the form: exactly the regression the criterion exists to catch.
  writeFileSync(path.join(repo, "server.mjs"), [
    'import { createServer } from "node:http";',
    'createServer((_q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end("<p>Thank you</p>"); })',
    '  .listen(Number(process.env.PORT), "127.0.0.1");',
  ].join("\n"));

  const plan = acceptancePlan(repo, manifest({
    operations: [{
      id: "store-quote-name", page: "index", element: "form#quote", kind: "form-submit",
      behaviour: "Store a quote request.", expectChange: "content",
      acceptance: ["the page still renders form#quote"],
      acceptanceProbes: [{ criterion: 0, as: "anonymous", method: "POST", path: "/api/quote", expect: 200, expectBodyContains: ['<form id=quote'] }],
    }],
    apis: [{ method: "POST", path: "/api/quote", auth: "public", success: 200 }],
    projectConfig: { allowedNewScripts: ["serve"] },
  } as never));
  writeAcceptanceDriver(repo, plan);
  const { stdout } = await promisify(execFile)(process.execPath, ["--no-warnings", DRIVER], { cwd: repo, timeout: 90_000 })
    .catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
  const probed = readAcceptanceOutput(stdout).find((c) => c.id === "store-quote-name :: acceptance[0]");
  assert.ok(probed, stdout.slice(0, 400));
  assert.equal(probed.ok, false, "a 200 that lost the form is not a pass");
  assert.match(probed.detail, /does not contain/, probed.detail);
  assert.match(probed.detail, /form id=quote/, "and names what was missing");
});
