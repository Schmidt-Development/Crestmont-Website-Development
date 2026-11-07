// What the brief actually tells Model B about storage.
//
// The contract has always carried `persistence` -- the technology, whether it is required, whether rows must be
// durable, and the evidence a reader will look for. The brief never passed any of it on, so the model chose: the
// first Northgate run wrote a JSON file (which genuinely persists, and survived the restart check), and the second
// reached for a native sqlite driver the sandbox has no network or compiler to build. Both were reasonable guesses
// at something the contract had already decided, and both cost a full build cycle to discover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { integrationPrompt } from "../src/frontend/integrate.ts";
import type { IntegrationManifest, ManifestContract } from "../src/frontend/integration-manifest.ts";
import type { DesignBaseline } from "../src/frontend/design-lock.ts";
import type { ImportReport } from "../src/frontend/import.ts";

const baseline = {
  artifactSha: "a".repeat(64), sourceFingerprint: "s".repeat(64), fingerprint: "f".repeat(64),
  approvedBy: "the Founder", capturedAt: "2026-11-07T00:00:00.000Z",
  signatures: [{ page: "index", viewport: "desktop", skeleton: [], palette: [], fonts: [], typeScale: [], landmarks: [], docHeight: 1 }],
  renders: [],
} as unknown as DesignBaseline;

const report = { routes: [], signatures: [], renders: [], states: [], interactions: [], problems: [], externalOrigins: [] } as unknown as ImportReport;

const brief = (persistence: unknown) => integrationPrompt({
  manifest: {
    schema: "crestmont.integration-manifest/1", artifactSha: "a".repeat(64), designFingerprint: "d".repeat(64),
    operations: [], persistence,
  } as unknown as IntegrationManifest & ManifestContract,
  baseline, report, outputRoot: "dist", framework: "vite",
});

test("[PROMPT-01] a required technology is stated as a requirement, with the one that works in this sandbox", () => {
  const s = brief({ enforcement: "required", technology: "sqlite", durable: true, evidence: ["a database file on disk"] });
  assert.match(s, /## How it must store things/);
  assert.match(s, /\*\*sqlite\*\*, and that is a requirement, not a preference/);
  assert.match(s, /A JSON file, an in-memory array or a different database is a failed build/,
    "the substitution the first run made is named, not left to be inferred");
  assert.match(s, /node:sqlite/, "and the implementation that works here");
  assert.match(s, /no network and no compiler/, "with the reason a native driver is not an option");
  assert.match(s, /better-sqlite3/, "naming the one the second run reached for");
  assert.match(s, /survive the application restarting/, "durability, which is checked by restarting it");
  assert.match(s, /a database file on disk/, "and the evidence a reader will look for");
});

test("[PROMPT-02] `any` is passed on as judgement, not as a requirement it is not", () => {
  const s = brief({ enforcement: "any", technology: "sqlite", durable: true });
  assert.match(s, /Any mechanism that genuinely persists is acceptable here/);
  assert.ok(!/is a requirement, not a preference/.test(s), "it must not overstate what the contract says");
  assert.match(s, /an in-memory array is not persistence/, "while still ruling out the one thing that is not storage");
});

test("[PROMPT-03] a contract with no persistence section says nothing about storage rather than inventing a rule", () => {
  const s = brief(undefined);
  assert.ok(!/## How it must store things/.test(s), "no section at all");
  assert.ok(!/node:sqlite/.test(s), "and no technology the contract never named");
});

test("[PROMPT-04] the brief says the application has to start, and which script the driver will run", () => {
  // The second Northgate run wrote server/db.ts and server/server.ts, added no script, and the functional gate
  // reported "the project has no start script and no server file, so the application could not be started": 19
  // criteria unevaluated because nobody could run the thing. The contract already permits the script.
  const s = integrationPrompt({
    manifest: {
      schema: "crestmont.integration-manifest/1", artifactSha: "a".repeat(64), designFingerprint: "d".repeat(64),
      operations: [], projectConfig: { allowedNewScripts: ["start", "api", "migrate"] },
    } as unknown as IntegrationManifest & ManifestContract,
    baseline, report, outputRoot: "dist", framework: "vite",
  });
  assert.match(s, /## It has to start/);
  assert.match(s, /npm run start/, "naming the script the driver will actually run");
  assert.match(s, /not written by you and not editable by you/, "and that the driver is not the model's own");
  assert.match(s, /the build fails on that alone/, "and the consequence, so it is not read as advice");
  assert.match(s, /PORT/, "and the port it must listen on");
  assert.match(s, /npm run build.*and then.*npm run start/s, "and the order the two are run in");
  assert.match(s, /everything .start. needs must exist by the end of .build./, "so a compile step nothing runs is not enough");
  assert.match(s, /MODULE_NOT_FOUND/, "with the failure it actually caused, not a warning in the abstract");
});

test("[PROMPT-05] a contract that permits no start script is not told to add one", () => {
  const s = integrationPrompt({
    manifest: {
      schema: "crestmont.integration-manifest/1", artifactSha: "a".repeat(64), designFingerprint: "d".repeat(64),
      operations: [], projectConfig: { allowedNewScripts: ["migrate"] },
    } as unknown as IntegrationManifest & ManifestContract,
    baseline, report, outputRoot: "dist", framework: "vite",
  });
  assert.ok(!/## It has to start/.test(s), "the brief does not ask for something the contract forbids");
});
