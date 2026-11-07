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

export interface AcceptanceCheck {
  id: string;
  ok: boolean;
  /** True when the check could not be evaluated. Never counts as a pass. */
  undetermined?: boolean;
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
    ...(isContract(a) ? { success: a.success, invalid: a.invalid, unauthenticated: a.unauthenticated } : {}),
  }));
  return { start: startCommand(repo, manifest), port, endpoints };
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

const plan = JSON.parse(readFileSync(new URL("./plan.json", import.meta.url), "utf8"));
const results = [];
const add = (id, ok, detail, undetermined) => results.push({ id, ok, detail, ...(undetermined ? { undetermined: true } : {}) });

if (!plan.start) {
  add("app:starts", false, "the project has no start script and no server file, so the application could not be started", true);
  console.log(JSON.stringify({ results }));
  process.exit(1);
}

const base = "http://127.0.0.1:" + plan.port;
const child = spawn(plan.start[0], plan.start.slice(1), {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(plan.port), NODE_ENV: "test" },
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32",
});
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
  add("app:starts", false, "the application did not answer on port " + plan.port + " within 30s: " + log.slice(-400).replace(/\s+/g, " "));
} else {
  add("app:starts", true, "the application started and answered on port " + plan.port);

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

    // Business flows behind a credential are not invented here.
    if (e.auth !== "public" && typeof e.success === "number") {
      add(id + " :: authenticated success", false,
        "needs a credential the contract does not carry, so the declared " + e.success + " was not exercised", true);
    }
  }
}

child.kill("SIGTERM");
await sleep(300);
if (child.exitCode === null) child.kill("SIGKILL");

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
 * The verdict.
 *
 * A pass needs every check to have passed AND at least one check to have run. An undetermined check is a
 * failure: the directive's rule is that nothing may be claimed to have passed unless it actually ran and passed.
 */
export function summarise(checks: readonly AcceptanceCheck[]): { ran: boolean; ok: boolean; detail: string } {
  if (checks.length === 0) {
    return { ran: false, ok: false, detail: "the independent acceptance driver produced no result, so nothing was verified" };
  }
  const failed = checks.filter((c) => !c.ok && !c.undetermined);
  const undetermined = checks.filter((c) => c.undetermined);
  const passed = checks.filter((c) => c.ok);
  if (failed.length === 0 && undetermined.length === 0) {
    return { ran: true, ok: true, detail: `${passed.length} contract check(s) passed against the running application` };
  }
  const parts: string[] = [];
  if (failed.length) parts.push(`${failed.length} failed: ${failed.slice(0, 4).map((c) => `${c.id} — ${c.detail}`).join("; ")}`);
  if (undetermined.length) parts.push(`${undetermined.length} could not be evaluated: ${undetermined.slice(0, 3).map((c) => `${c.id} — ${c.detail}`).join("; ")}`);
  return { ran: true, ok: false, detail: `${passed.length} passed, ${parts.join(". ")}` };
}
