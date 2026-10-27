// Runs runner/sandbox/browser-check.mjs for real in headless Chromium against the brochure starter (passes) and a
// broken copy (fails). Skipped when Playwright + Chromium are not installed on the test host. Outside a container;
// in production the same script runs inside the per-build sandbox image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { RUNNER_DIR, tmp } from "./helpers.ts";

const SCRIPT = path.join(RUNNER_DIR, "sandbox", "browser-check.mjs");
const nodePath = [process.env.NODE_PATH, "/opt/npm-tools/node_modules", "/usr/local/lib/node_modules"].filter(Boolean).join(path.delimiter);
const env = { ...process.env, NODE_PATH: nodePath };
const probe = spawnSync(process.execPath, ["-e", "const p=require('playwright');process.exit(require('fs').existsSync(p.chromium.executablePath())?0:1)"], { env, encoding: "utf8" });
const available = probe.status === 0;

function runCheck(root: string) {
  return spawnSync(process.execPath, [SCRIPT, "--root", "public", "--out", "shots"], { cwd: root, env, encoding: "utf8", timeout: 180_000 });
}

test("[AIB-RUNNER] browser-check.mjs passes the brochure starter and fails on overflow, missing assets and page errors (real headless Chromium)", { skip: available ? false : "Playwright/Chromium not installed on this host" }, () => {
  const ok = tmp("aib-bc-");
  cpSync(path.join(RUNNER_DIR, "starters", "brochure-v1", "public"), path.join(ok, "public"), { recursive: true });
  const r1 = runCheck(ok);
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /browser-check: 10\/10 page views passed \(5 pages x 2 viewports\)/);
  assert.equal(readdirSync(path.join(ok, "shots")).filter((f) => f.endsWith(".png")).length, 10);

  const bad = tmp("aib-bc-bad-");
  cpSync(path.join(RUNNER_DIR, "starters", "brochure-v1", "public"), path.join(bad, "public"), { recursive: true });
  const about = path.join(bad, "public", "about.html");
  writeFileSync(about, readFileSync(about, "utf8").replace("</main>", "<div style=\"width:3000px\">wide</div><img src=\"assets/missing.png\" alt=\"x\"><script>throw new Error('boom')</script></main>"));
  const r2 = runCheck(bad);
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /FAIL about\.html @ mobile/);
  assert.match(r2.stdout, /horizontal overflow/);
  assert.match(r2.stdout, /HTTP 404: \/assets\/missing\.png/);
  assert.match(r2.stdout, /page error: boom/);
  assert.match(r2.stdout, /PASS index\.html @ mobile/);
  assert.ok(existsSync(path.join(bad, "shots", "index-desktop.png")));
});
