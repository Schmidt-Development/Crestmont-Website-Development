// Independent functional acceptance: checks derived from the CONTRACT, executed against the running application.
//
// WHY THIS EXISTS. The functional gate used to look for `verify-backend.mjs` in the repository and run it. That
// file is written by Model B. So the model authored both the implementation and the test that judged it, and a
// verifier that exits 0 without asserting anything would have produced "all acceptance checks passed". The
// comment above that gate said Model B's opinion is not evidence, which was the right intent and the wrong
// mechanism: executing someone's own test independently does not make the test independent.
//
// What IS independent is the integration manifest. It is written before the work, it belongs to the project
// rather than to the model, and `apis` already states, per endpoint, the status a well-formed request must get,
// the status an invalid one must get, and the status an unauthenticated one must get. Those are executable
// without asking the model for anything.
//
// WHAT THIS CHECKS, and what it deliberately does not. It starts the application, then for every declared
// endpoint: that the route exists at all, that an unauthenticated request is refused with exactly the declared
// status, and that a malformed request is refused with exactly the declared status. It does NOT attempt
// authenticated business flows — those need credentials the contract does not carry, and a check that invents
// them would be testing its own guess. Those criteria stay UNDETERMINED, which is a failure, not a pass.
//
// A model-authored verifier is still run when one exists, but only as additional evidence. It can never be the
// reason the gate passes.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { ApiContract, ApiRequirement, IntegrationManifest, ManifestContract } from "./integration-manifest.ts";

/** Where the runner writes its own driver. Inside the repo because the sandbox only sees the repo. */
export const ACCEPTANCE_DIR = ".crestmont/acceptance";
export const DRIVER = `${ACCEPTANCE_DIR}/contract-acceptance.mjs`;
export const PLAN = `${ACCEPTANCE_DIR}/plan.json`;
export const RESULTS = `${ACCEPTANCE_DIR}/results.json`;

export interface AcceptanceCheck {
  id: string;
  ok: boolean;
  /** True when the check could not be evaluated. Never counts as a pass. */
  undetermined?: boolean;
  /**
   * True when what went wrong is the BUILD MACHINE and not the implementation -- no port could be bound, the
   * port was taken by something else. It never counts as a pass, and it is never charged to the model or put in
   * a repair brief: asking a model to fix a busy port wastes a build, which is exactly what it did.
   */
  environment?: boolean;
  detail: string;
}

export interface AcceptancePlan {
  /** argv that starts the application, as found in the project's own scripts. */
  start: string[] | null;
  port: number;
  endpoints: {
    method: string;
    path: string;
    auth: string;
    success?: number;
    invalid?: number;
    unauthenticated?: number;
    requestExample?: Record<string, unknown>;
  }[];
  /** Acceptance criteria the contract made executable (AcceptanceProbe), carrying the id they are reported under. */
  probes: {
    id: string;
    text: string;
    as: "anonymous" | "customer" | "other-customer";
    method: string;
    path: string;
    body?: Record<string, unknown>;
    expect: number;
    repeat: boolean;
  }[];
}

const isContract = (a: ApiRequirement | ApiContract): a is ApiContract =>
  "success" in a || "invalid" in a || "unauthenticated" in a;

/**
 * How to start the application, read from the project's own package.json.
 *
 * Only scripts the contract allowed the integration to add are considered, in the order a reader would expect.
 * Nothing is invented: a project with no start script cannot be exercised, and that is reported rather than
 * worked around.
 */
export function startCommand(repo: string, manifest: IntegrationManifest & ManifestContract): string[] | null {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch { return null; }

  const allowed = new Set(manifest.projectConfig?.allowedNewScripts ?? ["start", "api", "serve"]);
  for (const name of ["start", "api", "serve"]) {
    if (allowed.has(name) && typeof scripts[name] === "string" && scripts[name].trim()) return ["npm", "run", name];
  }
  // A plain server file the integration added, when it did not add a script for it.
  for (const f of ["server.js", "server.mjs", "server/index.js", "server/index.mjs"]) {
    if (existsSync(path.join(repo, f))) return ["node", "--no-warnings", f];
  }
  return null;
}

/** The plan: what will be exercised, derived only from the contract and the project's own scripts. */
export function acceptancePlan(repo: string, manifest: IntegrationManifest & ManifestContract, port = 8099): AcceptancePlan {
  const endpoints = (manifest.apis ?? []).map((a) => ({
    method: (a.method ?? "GET").toUpperCase(),
    path: a.path,
    auth: a.auth ?? "public",
    ...(isContract(a) ? { success: a.success, invalid: a.invalid, unauthenticated: a.unauthenticated, requestExample: a.requestExample } : {}),
  }));
  // The criteria that carry a probe, flattened with the id `coverageChecks` would have used for them, so an executed
  // result and an undetermined one are the same criterion under the same name and never both appear.
  const probes = (manifest.operations ?? []).flatMap((op) =>
    (op.acceptanceProbes ?? []).map((pr) => ({
      id: `${op.id} :: acceptance[${pr.criterion}]`,
      text: op.acceptance[pr.criterion] ?? "",
      as: pr.as, method: (pr.method ?? "GET").toUpperCase(), path: pr.path,
      body: pr.body, expect: pr.expect, repeat: pr.repeat === true,
    })),
  );
  return { start: startCommand(repo, manifest), port, endpoints, probes };
}

/**
 * The driver, written by the RUNNER into the workspace and executed in the sandbox.
 *
 * It is a single node process: it starts the application, waits for the port, probes each declared endpoint, then
 * stops the application. Written as a string rather than shipped as a file because the sandbox mounts only the
 * job's repository.
 */
export const DRIVER_SOURCE = String.raw`
// Independent contract acceptance. Written by the Crestmont runner, not by the model under test.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";

const plan = JSON.parse(readFileSync(new URL("./plan.json", import.meta.url), "utf8"));
const results = [];
const add = (id, ok, detail, undetermined, environment) => results.push({ id, ok, detail, ...(undetermined ? { undetermined: true } : {}), ...(environment ? { environment: true } : {}) });

if (!plan.start) {
  add("app:starts", false, "the project has no start script and no server file, so the application could not be started", true);
  console.log(JSON.stringify({ results }));
  process.exit(1);
}

// WHICH PORT. The plan names a preferred port; this asks the operating system whether it is actually free
// before using it. It usually is. When it is not, an ephemeral port is used and the move is recorded, because
// the alternative is what staging did: the job container lives for the whole build, so a server leaked by an
// earlier repair cycle still held the one fixed port, a healthy application was reported as "did not answer"
// with somebody else's EADDRINUSE, and that was handed to the model as its own defect to fix. A busy port is a
// fact about this machine. It is never evidence about the website.
const bindable = (p) => new Promise((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(0));
  probe.listen(p, "127.0.0.1", () => { const got = probe.address().port; probe.close(() => resolve(got)); });
});
let port = await bindable(plan.port);
let portNote = "";
if (!port) {
  port = await bindable(0);
  portNote = port ? " (the planned port " + plan.port + " was already in use on this machine, so " + port + " was used instead)" : "";
}
if (!port) {
  add("app:starts", false, "no local port could be bound on this machine, so the application could not be started or probed; this is an environment failure and not a result about the application", true, true);
  console.log(JSON.stringify({ results }));
  process.exit(1);
}
const base = "http://127.0.0.1:" + port;
// Its own process GROUP. npm run start is a wrapper: a signal sent to npm does not reliably reach the server npm
// started, and that server keeps the port. Stopping the group stops what it started, which is what makes the
// restart check below mean anything (and what stops a leftover server breaking the next run with EADDRINUSE).
const SPAWN = {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), NODE_ENV: "test" },
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32",
  detached: process.platform !== "win32",
};
const stopTree = async (proc) => {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore" });
    else process.kill(-proc.pid, "SIGTERM");
  } catch { try { proc.kill("SIGTERM"); } catch { /* already gone */ } }
  for (let i = 0; i < 40 && proc.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250));
  if (proc.exitCode === null) {
    try {
      if (process.platform !== "win32") process.kill(-proc.pid, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch { /* already gone */ }
  }
};
const child = spawn(plan.start[0], plan.start.slice(1), SPAWN);
let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(500);
  if (child.exitCode !== null) break;
  try { await fetch(base + "/", { signal: AbortSignal.timeout(1500) }); up = true; } catch { /* not yet */ }
}

if (!up) {
  // Three different causes used to produce one sentence. Say which: the model can repair the second, and must
  // never be asked to repair the first or the third.
  const tail = log.slice(-400).replace(/\s+/g, " ");
  const elsewhere = [...log.matchAll(/(?:"port"\s*:\s*|port[ =:]+)(\d{2,5})/gi)]
    .map((m) => Number(m[1])).find((p) => p !== port && p > 0);
  if (/EADDRINUSE/.test(log)) {
    add("app:starts", false, "the port the application was given (" + port + ") was taken while it was starting, so it could not be exercised; this is an environment failure on the build machine and not a result about the application: " + tail, true, true);
  } else if (elsewhere) {
    add("app:starts", false, "the application started but listened on port " + elsewhere + " instead of the PORT it was given (" + port + "); it must bind process.env.PORT so it can be served and probed: " + tail);
  } else {
    add("app:starts", false, "the application did not answer on port " + port + " within 30s" + portNote + ": " + tail);
  }
} else {
  add("app:starts", true, "the application started and answered on port " + port);

  const body = (m) => (m === "GET" || m === "HEAD" ? undefined : JSON.stringify({}));
  const call = async (m, p, init) => {
    try {
      const res = await fetch(base + p, { method: m, signal: AbortSignal.timeout(8000), ...init });
      return res.status;
    } catch (e) { return 0; }
  };
  // Path parameters cannot be guessed; a declared :id is probed with a value that must not exist.
  const concrete = (p) => p.replace(/:[A-Za-z][A-Za-z0-9_]*/g, "crestmont-acceptance-nonexistent");

  for (const e of plan.endpoints) {
    const p = concrete(e.path);
    const id = e.method + " " + e.path;

    const status = await call(e.method, p, {
      headers: { "content-type": "application/json" },
      body: body(e.method),
    });

    if (status === 0) { add(id + " :: exists", false, "no answer at all"); continue; }
    add(id + " :: exists", status !== 404 || /nonexistent/.test(p), status === 404 && !/nonexistent/.test(p) ? "the declared route is not served (404)" : "the route is served (" + status + ")");

    // An unauthenticated request must be refused with exactly the declared status.
    if (typeof e.unauthenticated === "number") {
      add(id + " :: refuses anonymous", status === e.unauthenticated,
        status === e.unauthenticated
          ? "unauthenticated request refused with " + status + " as declared"
          : "declared " + e.unauthenticated + " for an unauthenticated request, answered " + status);
    }

    // A malformed request must be refused with exactly the declared status. Only meaningful where the endpoint
    // is reachable without credentials; otherwise the auth refusal comes first and is already checked above.
    if (typeof e.invalid === "number" && e.auth === "public" && e.method !== "GET") {
      const bad = await call(e.method, p, { headers: { "content-type": "application/json" }, body: "{\"\":1}" });
      add(id + " :: refuses invalid", bad === e.invalid,
        bad === e.invalid ? "invalid request refused with " + bad + " as declared"
                          : "declared " + e.invalid + " for an invalid request, answered " + bad);
    }

  }

  // ---- a session of the driver's own, so authenticated behaviour can be exercised for real ----
  //
  // The credentials are generated here and never come from the contract. requestExample says what shape a
  // valid body has; {{email}} and {{password}} are substituted, so a manifest never carries a secret.
  const reg = plan.endpoints.find((x) => x.auth === "public" && x.method === "POST" && /register|signup|join/i.test(x.path));
  const login = plan.endpoints.find((x) => x.auth === "public" && x.method === "POST" && /login|session|signin/i.test(x.path));
  const unique = "acc-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
  const who = { email: unique + "@crestmont.test", password: "Driver-" + unique + "-Aa1!" };
  const other = { email: "other-" + unique + "@crestmont.test", password: "Other-" + unique + "-Aa1!" };

  const fill = (ex, me) => JSON.parse(JSON.stringify(ex).replaceAll("{{email}}", me.email).replaceAll("{{password}}", me.password));
  const post = async (p, bodyObj, cookie) => {
    try {
      const res = await fetch(base + p, {
        method: "POST", signal: AbortSignal.timeout(10000),
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(bodyObj),
      });
      return { status: res.status, cookie: res.headers.get("set-cookie") ?? "" };
    } catch { return { status: 0, cookie: "" }; }
  };

  let session = "";
  let otherSession = "";
  if (!reg || !reg.requestExample || !login || !login.requestExample) {
    add("auth:session", false,
      "the contract declares no register/login endpoint with a requestExample, so the driver could not obtain a session and no authenticated behaviour was exercised", true);
  } else {
    const made = await post(concrete(reg.path), fill(reg.requestExample, who), "");
    add("auth:register", made.status === (reg.success ?? 201),
      made.status === (reg.success ?? 201) ? "registered an account of the driver's own (" + made.status + ")"
        : "declared " + (reg.success ?? 201) + " for a valid registration, answered " + made.status);
    await post(concrete(reg.path), fill(reg.requestExample, other), "");
    const got2 = await post(concrete(login.path), fill(login.requestExample, other), "");
    otherSession = (got2.cookie || "").split(",").map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");

    const got = await post(concrete(login.path), fill(login.requestExample, who), "");
    const raw = (got.cookie || "").split(",").map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
    session = raw;
    add("auth:login", got.status === (login.success ?? 200) && !!raw,
      got.status === (login.success ?? 200) && raw ? "signed in and received a session cookie"
        : "login answered " + got.status + (raw ? "" : " and set no cookie"));

    // The cookie must not be readable by a script, or a cross-site page could send it.
    const flags = (got.cookie || "").toLowerCase();
    add("auth:cookie-flags", flags.includes("httponly") && flags.includes("samesite"),
      flags.includes("httponly") && flags.includes("samesite") ? "the session cookie is HttpOnly and SameSite"
        : "the session cookie is missing HttpOnly and/or SameSite");

    // Wrong password must be refused, with the same answer an unknown address gets.
    const wrong = await post(concrete(login.path), fill(login.requestExample, { email: who.email, password: "not-the-password-Aa1!" }), "");
    const unknown = await post(concrete(login.path), fill(login.requestExample, { email: "nobody-" + unique + "@crestmont.test", password: who.password }), "");
    add("auth:refuses-wrong-password", wrong.status === (login.invalid ?? 401),
      "a wrong password answered " + wrong.status + " (declared " + (login.invalid ?? 401) + ")");
    add("auth:same-answer-for-unknown-email", wrong.status === unknown.status,
      wrong.status === unknown.status ? "an unknown address gets the same answer as a wrong password"
        : "an unknown address answered " + unknown.status + " and a wrong password " + wrong.status + ", which tells an attacker which addresses are registered");
  }

  if (session) {
    const get = async (p, cookie) => {
      try { return (await fetch(base + p, { headers: { cookie }, signal: AbortSignal.timeout(8000) })).status; } catch { return 0; }
    };
    for (const e of plan.endpoints) {
      if (e.method !== "GET" || typeof e.success !== "number") continue;
      const p = concrete(e.path);
      const id = e.method + " " + e.path;
      const status = await get(p, session);

      if (e.auth === "customer") {
        add(id + " :: signed-in success", status === e.success,
          status === e.success ? "answered " + status + " for a signed-in caller as declared"
            : "declared " + e.success + " for a signed-in caller, answered " + status);
      } else if (e.auth === "staff" || e.auth === "admin") {
        // A customer session must be REFUSED, not handed an empty list: an empty list is indistinguishable from
        // a quiet day, which is how a hole stays hidden.
        add(id + " :: refuses a customer session", status === 403,
          status === 403 ? "a customer session is refused with 403"
            : "a staff endpoint answered " + status + " to a customer session" + (status === 200 ? " — a customer can read staff data" : ""));
      }
    }

    // ---- the criteria the contract made executable (AcceptanceProbe) ----
    //
    // One request each, from the session the contract named, judged against the status it declared. The criterion
    // text travels with the result, so the record reads as the criterion rather than as a route. Nothing is
    // inferred: a probe whose session could not be obtained is UNDETERMINED, exactly as an unprobed criterion is.
    const call = async (method, p, bodyObj, cookie) => {
      try {
        const res = await fetch(base + p, {
          method, signal: AbortSignal.timeout(10000),
          headers: { ...(bodyObj ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
          ...(bodyObj ? { body: JSON.stringify(bodyObj) } : {}),
        });
        return res.status;
      } catch { return 0; }
    };
    for (const pr of plan.probes || []) {
      const cookie = pr.as === "customer" ? session : pr.as === "other-customer" ? otherSession : "";
      if (pr.as !== "anonymous" && !cookie) {
        add(pr.id, false, "no " + pr.as + " session was obtained, so this was not checked: " + pr.text, true);
        continue;
      }
      const me = pr.as === "other-customer" ? other : who;
      const body = pr.body ? fill(pr.body, me) : undefined;
      let status = await call(pr.method, concrete(pr.path), body, cookie);
      if (pr.repeat) status = await call(pr.method, concrete(pr.path), body, cookie);
      add(pr.id, status === pr.expect,
        (status === pr.expect ? "answered " : "declared " + pr.expect + ", answered ") + status + " :: " + pr.text);
    }

    // Does the session survive the application restarting? A session held only in memory is not a session.
    //
    // Stopping it properly matters more than it looks: npm run start is a wrapper, SIGTERM reaches npm and the
    // node process it spawned keeps the port, so a second start binds nothing and the check reports "did not come
    // back up" when the application was fine all along. So: stop, then WAIT FOR THE PORT TO BE FREE before
    // starting again, and say which of the two failed if it does.
    const free = async () => {
      try { await fetch(base + "/", { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; }
    };
    await stopTree(child);
    let released = false;
    for (let i = 0; i < 40 && !released; i++) { await sleep(250); released = await free(); }
    if (!released) {
      add("persistence:stops-cleanly", false,
        "the application kept answering on port " + port + " after being stopped, so a restart could not be tested (on a shell wrapper, a signal may not reach the server it started)", true);
    }

    const again = spawn(plan.start[0], plan.start.slice(1), SPAWN);
    let backLog = "";
    again.stdout.on("data", (d) => { backLog += d; });
    again.stderr.on("data", (d) => { backLog += d; });
    let back = false;
    for (let i = 0; i < 60 && !back; i++) {
      await sleep(500);
      if (again.exitCode !== null) break;
      try { await fetch(base + "/", { signal: AbortSignal.timeout(1500) }); back = true; } catch { /* not yet */ }
    }
    const me = plan.endpoints.find((x) => x.auth === "customer" && x.method === "GET" && /\/me$|session/i.test(x.path));
    if (!back) {
      add("persistence:session-survives-restart", false,
        "the application did not come back up within 30s, so persistence could not be established: " + backLog.slice(-300).replace(/\s+/g, " "), true);
    } else if (!me) {
      add("persistence:session-survives-restart", false, "the contract declares no endpoint that reports the signed-in account, so a surviving session could not be observed", true);
    } else {
      const after = await get(concrete(me.path), session);
      add("persistence:session-survives-restart", after === (me.success ?? 200),
        after === (me.success ?? 200) ? "the session still worked after the application restarted"
          : "after a restart the session answered " + after + ", so sessions do not survive one");
    }
    await stopTree(again);
  }
}

await stopTree(child);

console.log(JSON.stringify({ results }));
process.exit(results.some((r) => !r.ok) ? 1 : 0);
`;

/** Write the plan and the driver into the workspace. Overwritten every cycle, so the model cannot edit them. */
export function writeAcceptanceDriver(repo: string, plan: AcceptancePlan): { driver: string; plan: string } {
  const dir = path.join(repo, ACCEPTANCE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(repo, PLAN), JSON.stringify(plan, null, 2));
  writeFileSync(path.join(repo, DRIVER), DRIVER_SOURCE);
  return { driver: DRIVER, plan: PLAN };
}

/** Parse what the driver printed. A driver that printed nothing usable is undetermined, never a pass. */
export function readAcceptanceOutput(stdout: string): AcceptanceCheck[] {
  const line = stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (!line) return [];
  try {
    const parsed = JSON.parse(line) as { results?: AcceptanceCheck[] };
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch { return []; }
}

/**
 * One check per written acceptance criterion that nothing executed established.
 *
 * The contract driver proves the API CONTRACT: each declared route is served, an anonymous caller is refused with
 * exactly the declared status, a malformed request is refused with exactly the declared status, and — once it has
 * registered and signed in as itself — that a signed-in caller gets the declared success and a staff endpoint
 * refuses a customer session.
 *
 * The manifest's per-operation `acceptance` lines are narrower than that: "a submitted request is stored as a row
 * in appointments with status 'requested'" names a table and a value. Nothing above reads the database, so those
 * are reported one by one as UNDETERMINED with their own text, rather than rolled into a single sentence. A
 * person reading the build record should be able to see WHICH criteria were not established, because that is the
 * list the six-artifact campaign has to work through.
 */
export function coverageChecks(manifest: { operations: { id: string; acceptance: string[]; acceptanceProbes?: { criterion: number }[] }[] }): AcceptanceCheck[] {
  return manifest.operations.flatMap((op) => {
    // A criterion with a probe is executed by the driver and reported there, pass or fail. Reporting it here as well
    // would both double-count it and let a criterion appear as undetermined in the same run that proved it.
    const probed = new Set((op.acceptanceProbes ?? []).map((p) => p.criterion));
    return op.acceptance.flatMap((text, i) => probed.has(i) ? [] : [{
      id: `${op.id} :: acceptance[${i}]`,
      ok: false,
      undetermined: true,
      detail: `not established by any executed check: ${text}`,
    }]);
  });
}

/** The full check list, written beside the plan so a later run can be compared with this one. */
export function writeAcceptanceResults(repo: string, checks: readonly AcceptanceCheck[]): string {
  mkdirSync(path.join(repo, ACCEPTANCE_DIR), { recursive: true });
  const counts = { pass: 0, fail: 0, undetermined: 0 };
  for (const c of checks) counts[c.undetermined ? "undetermined" : c.ok ? "pass" : "fail"]++;
  writeFileSync(path.join(repo, RESULTS), JSON.stringify({ at: new Date().toISOString(), counts, checks }, null, 2));
  return RESULTS;
}

/**
 * The verdict.
 *
 * A pass needs every check to have passed AND at least one check to have run. An undetermined check is a
 * failure: the directive's rule is that nothing may be claimed to have passed unless it actually ran and passed.
 */
/**
 * The verdict, and the COUNTS behind it.
 *
 * The counts are returned because the repair loop needs to know whether a cycle improved anything, and "ok or
 * not" cannot answer that: a repair that fixes three of four failing checks is progress, and a loop that can only
 * see the boolean stops after one attempt believing nothing moved.
 */
export function summarise(checks: readonly AcceptanceCheck[]): {
  ran: boolean; ok: boolean; detail: string; passed: number; failed: number; undetermined: number; environment: number;
} {
  if (checks.length === 0) {
    return { ran: false, ok: false, detail: "the independent acceptance driver produced no result, so nothing was verified", passed: 0, failed: 0, undetermined: 0, environment: 0 };
  }
  // An environment problem is still not a pass -- nothing was verified -- but it is not the implementation's
  // fault and is counted apart from it, so the repair loop can tell the two cases apart.
  const environment = checks.filter((c) => c.environment);
  const failed = checks.filter((c) => !c.ok && !c.undetermined && !c.environment);
  const undetermined = checks.filter((c) => c.undetermined && !c.environment);
  const passed = checks.filter((c) => c.ok);
  if (failed.length === 0 && undetermined.length === 0 && environment.length === 0) {
    return { ran: true, ok: true, detail: `${passed.length} contract check(s) passed against the running application`, passed: passed.length, failed: 0, undetermined: 0, environment: 0 };
  }
  const parts: string[] = [];
  if (failed.length) parts.push(`${failed.length} failed: ${failed.slice(0, 4).map((c) => `${c.id} — ${c.detail}`).join("; ")}`);
  if (undetermined.length) parts.push(`${undetermined.length} could not be evaluated: ${undetermined.slice(0, 3).map((c) => `${c.id} — ${c.detail}`).join("; ")}`);
  if (environment.length) parts.push(`${environment.length} could not be attempted on this build machine: ${environment.slice(0, 3).map((c) => `${c.id} — ${c.detail}`).join("; ")}`);
  return { ran: true, ok: false, detail: `${passed.length} passed, ${parts.join(". ")}`, passed: passed.length, failed: failed.length, undetermined: undetermined.length, environment: environment.length };
}
