// A working implementation that does not match the approved contract must not pass.
//
// This is the defect the first autonomous run exposed, written down so it cannot come back. Model B built a
// quote form that behaved perfectly — real server, real validation, real 422, a real record, and the truth told
// to the visitor when a write failed. Ten behavioural checks passed. It stored its rows in a JSON file while
// the manifest named a `quote_requests` table, and nothing noticed, because behaviour was all anything checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkConformance, declaredTables, describeConformance, fileStoreIn, repairBrief } from "../src/frontend/conformance.ts";
import type { IntegrationManifest, ManifestContract } from "../src/frontend/integration-manifest.ts";

/** A repo on disk, written from a map of path → contents. */
function repoWith(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(tmpdir(), "conf-"));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(d, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return d;
}

const BASE_PKG = { name: "approved-frontend", scripts: { dev: "vite", build: "vite build" }, dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.11" } };

const contract = (over: Partial<IntegrationManifest & ManifestContract> = {}): IntegrationManifest & ManifestContract => ({
  schema: "crestmont.integration-manifest/1", artifactSha: "a".repeat(64), designFingerprint: "d".repeat(64),
  operations: [{
    id: "quote-submit", page: "quote", element: "form#quote-request", kind: "form-submit",
    behaviour: "Persist a quote request.", expectChange: "content", acceptance: ["a request is stored"],
    dataModel: [{ table: "quote_requests", fields: ["name", "email"] }],
  }],
  dataModels: [{ table: "quote_requests", fields: ["name", "phone", "email", "postcode", "load_size", "created_at"] }],
  persistence: { enforcement: "required", technology: "sqlite", durable: true },
  projectConfig: { scripts: { dev: "preserve" }, allowedDependencies: ["express"], allowedNewScripts: ["start"] },
  ...over,
});

/** What the first autonomous run actually produced: correct behaviour, a JSON file underneath. */
const FILE_STORE_SERVER = `
import express from "express";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_FILE = join(import.meta.dirname, ".data", "quote-requests.json");

function readStore() { return existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, "utf8")) : []; }
function writeStore(rows) { writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2), "utf8"); }

const app = express();
app.post("/api/quote-request", (req, res) => {
  const errors = validate(req.body);
  if (errors.length) return res.status(422).json({ ok: false, errors });
  const store = readStore();
  const row = { id: crypto.randomUUID(), ...req.body, created_at: new Date().toISOString() };
  store.push(row);
  writeStore(store);
  res.status(201).json({ ok: true, id: row.id });
});
app.listen(3000);
`;

/** The same behaviour, built the way the contract asked. */
const SQLITE_SERVER = `
import express from "express";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("./data/site.db");
db.exec(\`CREATE TABLE IF NOT EXISTS quote_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  postcode TEXT NOT NULL,
  load_size TEXT NOT NULL,
  created_at TEXT NOT NULL
)\`);

const app = express();
app.post("/api/quote-request", (req, res) => {
  const errors = validate(req.body);
  if (errors.length) return res.status(422).json({ ok: false, errors });
  db.prepare("INSERT INTO quote_requests (id, name, phone, email, postcode, load_size, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), req.body.name, req.body.phone, req.body.email, req.body.postcode, req.body.load_size, new Date().toISOString());
  res.status(201).json({ ok: true });
});
app.listen(3000);
`;

const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);
const violations = (r: { findings: { severity: string; code: string }[] }) => r.findings.filter((f) => f.severity === "violation").map((f) => f.code);

test("[CONF-01] a file store substituted for the required database is caught", () => {
  const repo = repoWith({
    "server.js": FILE_STORE_SERVER,
    "package.json": JSON.stringify({ ...BASE_PKG, scripts: { ...BASE_PKG.scripts, dev: "node server.js" }, devDependencies: { ...BASE_PKG.devDependencies, express: "4.21.2" } }),
  });

  const r = checkConformance({ repo, manifest: contract(), baselinePackage: BASE_PKG });

  assert.equal(r.ok, false, "behaviour was never in question; conformance is");
  assert.ok(violations(r).includes("wrong-persistence-technology"), violations(r).join(","));
  assert.ok(violations(r).includes("file-substituted-for-database"), violations(r).join(","));
  assert.ok(violations(r).includes("table-not-defined"));
  assert.ok(violations(r).includes("script-replaced"), "the approved `dev` script was replaced");

  const sub = r.findings.find((f) => f.code === "file-substituted-for-database")!;
  assert.equal(sub.file, "server.js", "the finding names the file to change");
  assert.match(sub.detail, /JSON\.stringify/, "and says how it recognised the file store");
  assert.match(sub.detail, /loses writes the first time two people submit at once/, "and why it matters, not just that it differs");

  // express was allowed by this contract, so adding it is not even a warning.
  assert.ok(!codes(r).includes("dependency-added"), "an allowed dependency is not a finding");
});

test("[CONF-02] the same behaviour, built to the contract, passes", () => {
  const repo = repoWith({
    "server.js": SQLITE_SERVER,
    "package.json": JSON.stringify({ ...BASE_PKG, scripts: { ...BASE_PKG.scripts, start: "node server.js" }, devDependencies: { ...BASE_PKG.devDependencies, express: "4.21.2" } }),
  });

  const r = checkConformance({ repo, manifest: contract(), baselinePackage: BASE_PKG });
  assert.equal(r.ok, true, describeConformance(r));
  assert.deepEqual(violations(r), []);
  assert.ok(r.checked.some((c) => c.includes("sqlite")), r.checked.join("; "));
  assert.match(describeConformance(r), /conforms to the contract/);

  // Adding `start` was allowed; `dev` was left alone.
  assert.ok(!codes(r).includes("script-added"));
  assert.ok(!codes(r).includes("script-replaced"));
});

test("[CONF-03] `any` means any: a contract that does not insist is not enforced", () => {
  const repo = repoWith({
    "server.js": FILE_STORE_SERVER,
    "package.json": JSON.stringify({ ...BASE_PKG, scripts: { ...BASE_PKG.scripts, start: "node server.js" } }),
  });

  const r = checkConformance({
    repo,
    manifest: contract({ persistence: { enforcement: "any", technology: "sqlite" }, dataModels: [] }),
    baselinePackage: BASE_PKG,
  });

  assert.equal(r.ok, true, describeConformance(r));
  assert.ok(!codes(r).includes("file-substituted-for-database"), "the contract allowed the model to choose");
  assert.ok(r.checked.some((c) => c.includes("any")), "and the report says the choice was left open");
});

test("[CONF-04] a missing table, and a table missing the fields the contract named", () => {
  const partial = SQLITE_SERVER.replace(/postcode TEXT NOT NULL,\n  load_size TEXT NOT NULL,\n/, "");
  const r = checkConformance({
    repo: repoWith({ "server.js": partial, "package.json": JSON.stringify(BASE_PKG) }),
    manifest: contract(), baselinePackage: BASE_PKG,
  });

  assert.equal(r.ok, false);
  const f = r.findings.find((x) => x.code === "fields-missing")!;
  assert.ok(f, violations(r).join(","));
  assert.match(f.detail, /postcode/);
  assert.match(f.detail, /load_size/);
  assert.match(f.repair, /Add .*postcode.*load_size.* to `quote_requests`/);

  // A table nobody defined at all reads differently from one that is merely incomplete.
  const none = checkConformance({
    repo: repoWith({ "server.js": "const x = 1;", "package.json": JSON.stringify(BASE_PKG) }),
    manifest: contract({ persistence: { enforcement: "any", technology: "sqlite" } }), baselinePackage: BASE_PKG,
  });
  assert.match(none.findings.find((x) => x.code === "table-not-defined")!.detail, /nothing in the source defines or mentions it/);

  // Column parsing: the real thing, not a toy.
  const tables = declaredTables([{ path: "s.js", text: SQLITE_SERVER }]);
  assert.deepEqual([...tables.keys()], ["quote_requests"]);
  assert.ok(tables.get("quote_requests")!.columns.has("load_size"));
  assert.ok(!tables.get("quote_requests")!.columns.has("primary"), "constraints are not columns");
});

test("[CONF-05] the approved project's scripts and dependency versions are protected", () => {
  const pkg = {
    ...BASE_PKG,
    scripts: { dev: "node server.js", build: "vite build", deploy: "wrangler deploy" },
    devDependencies: { vite: "5.4.0", lodash: "4.17.21" },
  };
  const r = checkConformance({
    repo: repoWith({ "server.js": SQLITE_SERVER, "package.json": JSON.stringify(pkg) }),
    manifest: contract(), baselinePackage: BASE_PKG,
  });

  const replaced = r.findings.find((f) => f.code === "script-replaced")!;
  assert.ok(replaced, violations(r).join(","));
  assert.match(replaced.detail, /was `vite` in the approved project and is now `node server\.js`/);
  assert.match(replaced.repair, /ADD a new script/, "the repair says what to do instead, not just what is wrong");

  // A version change to an approved dependency is a violation: it can change how the site renders.
  const bumped = r.findings.find((f) => f.code === "dependency-version-changed")!;
  assert.ok(bumped, violations(r).join(","));
  assert.match(bumped.detail, /vite.*5\.4\.11.*5\.4\.0/);

  // An unlisted script and an unlisted dependency are warnings — surfaced, not blocking.
  assert.ok(codes(r).includes("script-added"), codes(r).join(","));
  assert.ok(codes(r).includes("dependency-added"));
  assert.equal(r.findings.find((f) => f.code === "dependency-added")!.severity, "warning");
});

test("[CONF-06] endpoints, statuses and protection are checked against what really happened", () => {
  const m = contract({
    persistence: { enforcement: "any", technology: "sqlite" }, dataModels: [],
    apis: [
      { method: "POST", path: "/api/quote-request", success: 201, invalid: 422 },
      { method: "GET", path: "/api/admin/requests", auth: "staff", unauthenticated: 401 },
    ],
    auth: { required: true, roles: ["staff"] },
  });
  const repo = repoWith({ "server.js": SQLITE_SERVER, "package.json": JSON.stringify(BASE_PKG) });

  const r = checkConformance({
    repo, manifest: m, baselinePackage: BASE_PKG,
    runtime: { calls: [{ method: "POST", path: "/api/quote-request", status: 200 }] },
  });

  assert.ok(violations(r).includes("wrong-success-status"), violations(r).join(","));
  assert.match(r.findings.find((f) => f.code === "wrong-success-status")!.detail, /must answer 201.*actually seen were 200/);
  assert.ok(violations(r).includes("endpoint-missing"), "the admin endpoint is neither in the source nor was it called");
  assert.ok(violations(r).includes("no-authentication"), "the contract requires authentication and nothing authenticates");

  // An endpoint that was never exercised is reported as unproven, not as broken.
  const unproven = r.findings.find((f) => f.code === "invalid-status-unproven");
  assert.ok(unproven);
  assert.equal(unproven!.severity, "warning");
  assert.equal(unproven!.basis, "runtime");
});

test("[CONF-07] a third-party service the contract never approved is a violation", () => {
  const m = contract({
    persistence: { enforcement: "any", technology: "sqlite" }, dataModels: [],
    externalIntegrations: [
      { name: "Stripe", origin: "https://api.stripe.com", approved: true, mode: "test" },
      { name: "SomeAnalytics", origin: "https://cdn.analytics.example", approved: false },
    ],
  });
  const repo = repoWith({
    "server.js": SQLITE_SERVER + '\nfetch("https://cdn.analytics.example/track");\n',
    "package.json": JSON.stringify(BASE_PKG),
  });

  const r = checkConformance({
    repo, manifest: m, baselinePackage: BASE_PKG,
    runtime: { origins: ["https://api.stripe.com", "https://telemetry.vendor.example"] },
  });

  // Asserted by counting the findings rather than by searching their text for a hostname. A substring test
  // against a host is the shape of the sanitisation bug CodeQL warns about (js/incomplete-url-substring-
  // sanitization), and it is the weaker assertion anyway: this one says exactly one origin was reported.
  const unapproved = r.findings.filter((f) => f.code === "unapproved-origin");
  assert.equal(unapproved.length, 1, `only the origin no approved integration names: ${unapproved.map((f) => f.detail).join(" | ")}`);
  assert.match(unapproved[0].detail, /telemetry\.vendor\.example/);
  assert.ok(violations(r).includes("unapproved-integration-used"), "and calling the one marked not-approved is caught in the source");
});

test("[CONF-08] a secret in the source is a violation; one nobody reads is a warning", () => {
  const m = contract({
    persistence: { enforcement: "any", technology: "sqlite" }, dataModels: [],
    secrets: [
      { name: "RESEND_API_KEY", purpose: "quote confirmations", provided: true },
      { name: "SESSION_SECRET", purpose: "signing sessions", provided: true },
    ],
  });
  const repo = repoWith({
    "server.js": 'const SESSION_SECRET = "s3cr3t-value-committed-here";\nconst x = 1;',
    "package.json": JSON.stringify(BASE_PKG),
  });

  const r = checkConformance({ repo, manifest: m, baselinePackage: BASE_PKG });
  assert.ok(violations(r).includes("secret-hardcoded"), violations(r).join(","));
  assert.ok(codes(r).includes("secret-unused"), "RESEND_API_KEY is declared available and nothing reads it");
  assert.equal(r.findings.find((f) => f.code === "secret-unused")!.severity, "warning");
});

test("[CONF-09] the repair brief tells Model B what to change and what to leave alone", () => {
  const repo = repoWith({
    "server.js": FILE_STORE_SERVER,
    "package.json": JSON.stringify({ ...BASE_PKG, scripts: { ...BASE_PKG.scripts, dev: "node server.js" } }),
  });
  const r = checkConformance({ repo, manifest: contract(), baselinePackage: BASE_PKG });
  const brief = repairBrief(r, { attempt: 1, maxAttempts: 3 });

  assert.match(brief, /Repair 1 of 3/);
  assert.match(brief, /This is not a request to redesign anything/);
  assert.match(brief, /the behaviour you built is correct/, "it does not tell the model its working code was wrong");
  assert.match(brief, /\*\*Do this:\*\*/, "every violation carries an instruction");
  assert.match(brief, /Store the data in sqlite/);
  assert.match(brief, /Restore `dev` to `vite`/);
  assert.match(brief, /change any visual design, markup structure, class name or style/, "the design lock is restated");
  assert.match(brief, /delete working code and start again/);

  // Warnings get their own non-blocking section when there are any, and no section when there are none.
  assert.ok(!/Also worth fixing/.test(brief), "nothing in this case was merely a warning");
  const withWarning = repairBrief(
    checkConformance({ repo, manifest: contract({ projectConfig: { scripts: { dev: "preserve" }, allowedDependencies: [] } }), baselinePackage: { ...BASE_PKG, devDependencies: {} } }),
    { attempt: 2, maxAttempts: 3 },
  );
  assert.match(withWarning, /Also worth fixing, but not blocking/);
  assert.match(withWarning, /Repair 2 of 3/);
});

test("[CONF-10] the detector reads a file store however the path was written", () => {
  // The first version of this check looked for `writeFileSync(… .json` and found nothing, because the real
  // implementation had put the path in a constant. Behaviour that is recognised only when it is written one
  // particular way is not recognised at all.
  assert.ok(fileStoreIn('writeFileSync(DATA_FILE, JSON.stringify(rows));\nconst DATA_FILE = "./x/records.json";'));
  assert.ok(fileStoreIn('writeFileSync("./data/records.json", body);'));
  assert.ok(fileStoreIn("await fs.promises.writeFile(p, JSON.stringify(rows));"));
  assert.equal(fileStoreIn("const db = new DatabaseSync(f); db.prepare(sql).run(a);"), null, "a database is not a file store");
  assert.equal(fileStoreIn("const x = JSON.stringify({a:1});"), null, "serialising without writing is not persistence");
});

test("[CONF-11] a dependency the sandbox cannot build is a violation, not a detail", () => {
  // Found the hard way. Told to move from a JSON file to sqlite, a model reached for `better-sqlite3` — a
  // native addon that compiles its binary in an install script. The sandbox installs with --ignore-scripts
  // deliberately, so the binary is never built. Every source check passed, the design held, and the
  // application would not start: "Could not locate the bindings file".
  const repo = repoWith({
    "server.js": SQLITE_SERVER.replace('from "node:sqlite"', 'from "better-sqlite3"'),
    "package.json": JSON.stringify({ ...BASE_PKG, devDependencies: { ...BASE_PKG.devDependencies, "better-sqlite3": "11.6.0" } }),
  });

  const r = checkConformance({ repo, manifest: contract({ persistence: { enforcement: "any", technology: "sqlite" }, dataModels: [] }), baselinePackage: BASE_PKG });

  const native = r.findings.find((f) => f.code === "native-dependency")!;
  assert.ok(native, violations(r).join(","));
  assert.equal(native.severity, "violation", "it does not merely warn: the application cannot start");
  assert.match(native.detail, /--ignore-scripts/);
  assert.match(native.detail, /Could not locate the bindings file/, "it names the error the operator would otherwise have to diagnose");
  assert.match(native.repair, /node:sqlite/, "and points at the thing that needs no build");

  // A dependency the approved project already had is not the integration's doing.
  const inherited = checkConformance({
    repo, manifest: contract({ persistence: { enforcement: "any", technology: "sqlite" }, dataModels: [] }),
    baselinePackage: { ...BASE_PKG, devDependencies: { ...BASE_PKG.devDependencies, "better-sqlite3": "11.6.0" } },
  });
  assert.ok(!violations(inherited).includes("native-dependency"), "it was already there when the design was approved");

  // The built-in module is fine.
  const builtin = checkConformance({
    repo: repoWith({ "server.js": SQLITE_SERVER, "package.json": JSON.stringify(BASE_PKG) }),
    manifest: contract({ persistence: { enforcement: "any", technology: "sqlite" }, dataModels: [] }), baselinePackage: BASE_PKG,
  });
  assert.ok(!violations(builtin).includes("native-dependency"));
});
