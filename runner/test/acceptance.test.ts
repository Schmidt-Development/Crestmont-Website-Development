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
  DRIVER, DRIVER_SOURCE, PLAN, acceptancePlan, readAcceptanceOutput, startCommand, summarise, writeAcceptanceDriver,
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
  assert.deepEqual(summarise([]), {
    ran: false, ok: false,
    detail: "the independent acceptance driver produced no result, so nothing was verified",
  });

  const withUndetermined = summarise([
    { id: "app:starts", ok: true, detail: "started" },
    { id: "GET /api/x :: authenticated success", ok: false, undetermined: true, detail: "needs a credential" },
  ]);
  assert.equal(withUndetermined.ran, true);
  assert.equal(withUndetermined.ok, false, "one undetermined check is enough to withhold a pass");
  assert.match(withUndetermined.detail, /could not be evaluated/);

  const failing = summarise([
    { id: "app:starts", ok: true, detail: "started" },
    { id: "GET /api/x :: refuses anonymous", ok: false, detail: "declared 401, answered 200" },
  ]);
  assert.equal(failing.ok, false);
  assert.match(failing.detail, /declared 401, answered 200/, "the measurement is in the verdict, not just a count");

  const passing = summarise([
    { id: "app:starts", ok: true, detail: "started" },
    { id: "GET /api/x :: refuses anonymous", ok: true, detail: "401 as declared" },
  ]);
  assert.deepEqual(passing, { ran: true, ok: true, detail: "2 contract check(s) passed against the running application" });
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
  assert.match(DRIVER_SOURCE, /the contract declares no register\/login endpoint with a requestExample/, "no example means undetermined, not skipped");

  // The properties that matter most, each asserted to be measured rather than assumed.
  assert.match(DRIVER_SOURCE, /auth:cookie-flags/, "HttpOnly and SameSite are checked on the real cookie");
  assert.match(DRIVER_SOURCE, /auth:same-answer-for-unknown-email/, "an unknown address must not be distinguishable from a wrong password");
  assert.match(DRIVER_SOURCE, /refuses a customer session/, "a staff endpoint must refuse a customer session");
  assert.match(DRIVER_SOURCE, /a customer can read staff data/, "and the failure says what it means");
  assert.match(DRIVER_SOURCE, /persistence:session-survives-restart/, "a session held only in memory is not a session");
  assert.match(DRIVER_SOURCE, /status === 403/, "an empty list is not a refusal");
});
