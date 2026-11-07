// Comparing a gated page with the approved design means signing in first.
//
// The design lock compares the approved rendering with the one the finished build produces, and both captures used
// to be taken against a static copy of the built site -- so for a page behind authentication the comparison was
// between a page that shows its content and one that cannot. Measured on Northgate: an anonymous capture of the
// staff page lost the three approved summary cards and the only two accent colours on it, and the gate called that
// drift on a page whose code had not been restyled.
//
// Nothing here relaxes a check. These cover what is declared, what is generated, what the instrument does with it,
// and what happens when a build declares the states and then does not implement the seed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { visualAppSpec, writeVisualSpec, VISUAL_SEED, VISUAL_SPEC } from "../src/frontend/visual.ts";
import { checkConformance } from "../src/frontend/conformance.ts";
import type { IntegrationManifest, ManifestContract } from "../src/frontend/integration-manifest.ts";

const INSTRUMENT = readFileSync(path.join(import.meta.dirname, "../sandbox/frontend-import.mjs"), "utf8");

const repoWith = (files: Record<string, string>) => {
  const dir = mkdtempSync(path.join(tmpdir(), "vis-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
};

const PKG = { name: "x", version: "1.0.0", scripts: { build: "vite build", start: "node dist/server.js" } };

const contract = (over: Partial<IntegrationManifest & ManifestContract> = {}): IntegrationManifest & ManifestContract => ({
  schema: "crestmont.integration-manifest/1",
  artifactSha: "a".repeat(64),
  designFingerprint: "d".repeat(64),
  operations: [],
  apis: [
    { method: "POST", path: "/api/register", auth: "public", success: 201, invalid: 422 },
    { method: "POST", path: "/api/login", auth: "public", success: 200, invalid: 401 },
  ],
  projectConfig: { allowedNewScripts: ["start"] },
  visualStates: [{ page: "staff", session: "staff", mask: [".card p"] }],
  ...over,
} as IntegrationManifest & ManifestContract);

test("[VIS-01] the spec names the role, generates the credential, and asks for exactly the accounts it needs", () => {
  const repo = repoWith({ "package.json": JSON.stringify(PKG) });
  const built = visualAppSpec(repo, contract());
  assert.ok(!("refused" in built), JSON.stringify(built));
  if ("refused" in built) return;

  assert.deepEqual(built.spec.start, ["npm", "run", "start"], "started the way the project itself starts");
  assert.equal(built.spec.login.path, "/api/login", "signed in through the endpoint the contract declared");
  assert.deepEqual(built.spec.states.map((s) => s.page), ["staff"]);
  assert.deepEqual(built.spec.states[0].mask, [".card p"], "the declared mask travels to the instrument");

  // The contract never carries a credential; the runner makes one.
  const cred = built.spec.credentials.staff;
  assert.match(cred.email, /@crestmont\.test$/);
  assert.ok(cred.password.length >= 16, "a real password, not a placeholder");
  assert.ok(!JSON.stringify(contract()).includes(cred.password), "and it is nowhere in the contract");

  assert.deepEqual(built.seed.accounts.map((a) => a.role), ["staff"], "exactly the roles the states need");
  assert.equal(built.seed.accounts[0].email, cred.email, "the seed and the sign-in agree");

  // Two runs must not reuse a credential.
  const again = visualAppSpec(repo, contract());
  assert.ok(!("refused" in again) && again.spec.credentials.staff.password !== cred.password, "fresh each run");
});

test("[VIS-02] it declines with a reason rather than measuring the wrong thing", () => {
  const repo = repoWith({ "package.json": JSON.stringify(PKG) });

  const none = visualAppSpec(repo, contract({ visualStates: [] }));
  assert.deepEqual(none, { refused: "no-states" }, "a site with no gated pages keeps the static measurement");

  const noStart = visualAppSpec(
    repoWith({ "package.json": JSON.stringify({ ...PKG, scripts: { build: "vite build" } }) }),
    contract(),
  );
  assert.deepEqual(noStart, { refused: "no-start-command" }, "nothing to start");

  const noLogin = visualAppSpec(repo, contract({ apis: [{ method: "GET", path: "/api/me", auth: "customer", success: 200 }] } as never));
  assert.deepEqual(noLogin, { refused: "no-login-endpoint" }, "nowhere to sign in");
});

test("[VIS-03] the instrument measures the application, signs in first, and masks only after the signature", () => {
  assert.match(INSTRUMENT, /argv\[i\] === "--app"/, "the runner can ask for application mode");
  assert.match(INSTRUMENT, /app = await startApp\(spec, process\.cwd\(\)\)/, "and it starts the application");
  assert.match(INSTRUMENT, /server = await serve\(o\.root\)/, "while the baseline keeps the static server");
  assert.match(INSTRUMENT, /context\.request\.post\(origin \+ spec\.login\.path/, "signing in on the browsing context");

  // Order matters more than anything else here: masking before MEASURE would change the very signature the lock
  // compares -- palette and skeleton are read from the live page.
  const measured = INSTRUMENT.indexOf("const m = await p.evaluate(MEASURE)");
  const masked = INSTRUMENT.indexOf("await p.evaluate(MASK, want.mask)");
  const shot = INSTRUMENT.indexOf("await p.screenshot({ path: shot, fullPage: true })");
  assert.ok(measured > 0 && masked > measured, "the signature is measured before anything is masked");
  assert.ok(shot > masked, "and the screenshot is taken after");

  assert.match(INSTRUMENT, /state: "access-denied"/, "the anonymous rendering is kept as its own state");
});

test("[VIS-04] declaring the states and not implementing the seed is a violation, and an ungated seed is worse", () => {
  const BASE_PKG = { ...PKG };
  const gated = [
    'const seed = process.env.CRESTMONT_SEED;',
    'if (seed) { for (const a of JSON.parse(readFileSync(seed, "utf8")).accounts) createAccount(a); }',
    'db.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, role TEXT)");',
  ].join("\n");

  const ok = checkConformance({
    repo: repoWith({ "server.js": gated, "package.json": JSON.stringify(BASE_PKG) }),
    manifest: contract(), baselinePackage: BASE_PKG,
  });
  assert.ok(!ok.findings.some((f) => f.code === "seed-not-implemented"), "a gated seed is what was asked for");
  assert.ok(!ok.findings.some((f) => f.code === "seed-not-gated"), ok.findings.map((f) => f.code).join(","));

  const missing = checkConformance({
    repo: repoWith({ "server.js": "const x = 1;", "package.json": JSON.stringify(BASE_PKG) }),
    manifest: contract(), baselinePackage: BASE_PKG,
  });
  const f1 = missing.findings.find((f) => f.code === "seed-not-implemented");
  assert.ok(f1, missing.findings.map((f) => f.code).join(","));
  assert.match(f1.detail, /the design cannot be compared/, "and says what it costs");

  const ungatedSource = [
    'const seed = process.env.CRESTMONT_SEED;',
    'for (const a of JSON.parse(readFileSync(seed)).accounts) createAccount(a);',
  ].join("\n");
  const ungated = checkConformance({
    repo: repoWith({ "server.js": ungatedSource, "package.json": JSON.stringify(BASE_PKG) }),
    manifest: contract(), baselinePackage: BASE_PKG,
  });
  const f2 = ungated.findings.find((f) => f.code === "seed-not-gated");
  assert.ok(f2, ungated.findings.map((f) => f.code).join(","));
  assert.match(f2.detail, /accounts with known passwords/, "and why it is a hole, not a detail");
});

test("[VIS-05] the spec and the seed are written where the instrument and the application will look", () => {
  const repo = repoWith({ "package.json": JSON.stringify(PKG) });
  const w = writeVisualSpec(repo, contract());
  assert.ok("path" in w && w.path === VISUAL_SPEC, JSON.stringify(w));
  const spec = JSON.parse(readFileSync(path.join(repo, VISUAL_SPEC), "utf8"));
  const seed = JSON.parse(readFileSync(path.join(repo, VISUAL_SEED), "utf8"));
  assert.equal(spec.seedFile, VISUAL_SEED, "the spec points the application at the seed");
  assert.equal(seed.accounts[0].password, spec.credentials.staff.password, "and they hold the same credential");
});
