// Self-check of a BUILT per-build sandbox image, run against a real Docker daemon:
//   node --no-warnings runner/ci/sandbox-self-check.ts <image>
// It drives the runner's own JobSandbox class (runner/src/sandbox.ts) with the real docker CLI, so the container gets
// exactly the production flags (--network none, --user 10001, --read-only, tmpfs, --cap-drop ALL,
// no-new-privileges, CPU/RAM/PID limits, only the job's repo + home mounted) and checks, inside it:
//   uid 10001; no network tools (curl, wget, nc, ssh, docker, sudo, ...); no network (fetch fails, only loopback);
//   read-only root with writable /tmp and repo; no effective capabilities; the per-command timeout kills;
//   Playwright is the version locked in runner/sandbox/package.json; and Chromium launches OFFLINE: browser-check.mjs
//   passes the brochure starter and writes screenshots.
// Used by the CI job runner-images. Exit 0 = every check passed. It never contacts a model or the control plane.

import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobSandbox, cliDockerExecutor } from "../src/sandbox.ts";
import type { JobSandboxConfig } from "../src/config.ts";
import { createWorkspace } from "../src/workspace.ts";
import { run, trustedBinary, dockerImageRef } from "../src/exec.ts";

const RUNNER_DIR = path.resolve(import.meta.dirname, "..");
const image = process.argv[2] ? dockerImageRef(process.argv[2]) : process.argv[2];
if (!image) { process.stderr.write("usage: node runner/ci/sandbox-self-check.ts <sandbox image>\n"); process.exit(2); }

const cfg: JobSandboxConfig = {
  dockerBin: process.env.DOCKER_BIN || "docker", image, volume: "", cpus: "2", memory: "2g", pidsLimit: 512, tmpfsMb: 256,
  commandTimeoutMs: 120_000, installTimeoutMs: 300_000, installNetwork: "none", installProxy: "http://egress-proxy:3128",
  registry: "https://registry.npmjs.org/", diskQuotaMb: 4096, uid: 10001, allowedBuildScripts: [], browserCheck: true,
};

function chmodTree(p: string): void {
  const st = statSync(p);
  chmodSync(p, st.isDirectory() ? 0o777 : 0o666);
  if (st.isDirectory()) for (const e of readdirSync(p)) chmodTree(path.join(p, e));
}

const root = mkdtempSync(path.join(tmpdir(), "cm-selfcheck-"));
const ws = createWorkspace(root, { id: "ci-selfcheck", attempt: 1 });
cpSync(path.join(RUNNER_DIR, "starters", "brochure-v1"), ws.repo, { recursive: true });
// The CI user is not uid 10001: let the container user write the bind-mounted job directories (test only; production
// uses the named workspaces volume, owned by 10001).
chmodTree(ws.dir);

const docker = cliDockerExecutor(cfg.dockerBin, { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) });
const sandbox = new JobSandbox(cfg, ws, "ci-selfcheck", docker);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ check: name, ok, detail: detail.slice(0, 600) }); };
const sh = (cmd: string, timeoutMs?: number) => sandbox.shell(cmd, timeoutMs);

try {
  const pre = await JobSandbox.preflight(cfg, docker);
  check("image present and docker reachable (JobSandbox.preflight)", pre.length === 0, pre.join("; "));

  const id = await sh("id -u; id -g");
  check("runs as uid/gid 10001", id.code === 0 && id.stdout.split(/\s+/).filter(Boolean).join(":") === "10001:10001", id.stdout + id.stderr);

  // (apt-get and su are part of Debian's essential set; apt-get cannot fetch anything without a network or root, and
  // su is harmless without its setuid bit, which the next check verifies is gone.)
  const tools = await sh("for t in curl wget nc ncat netcat socat ssh scp sftp telnet ftp rsync docker sudo; do command -v \"$t\" >/dev/null 2>&1 && echo \"FOUND $t\"; done; true");
  const found = tools.stdout.split("\n").filter((l) => l.startsWith("FOUND "));
  check("no network/escalation tools (curl, wget, nc, ssh, docker, sudo, ...)", tools.code === 0 && found.length === 0, found.join(", ") || "none");

  const suid = await sh("find / -xdev -type f -perm /6000 2>/dev/null | head -20; true");
  check("no setuid/setgid binaries", suid.code === 0 && suid.stdout.trim() === "", suid.stdout || "none");

  const net = await sandbox.argv(["node", "-e", "const os=require('os');const ifs=Object.keys(os.networkInterfaces());fetch('https://registry.npmjs.org/',{signal:AbortSignal.timeout(8000)}).then(()=>{console.log('FETCH-OK',ifs);process.exit(1)},(e)=>{console.log('fetch failed as expected:',e.cause?.code||e.name,'interfaces:',ifs.join(','));process.exit(ifs.every(i=>i==='lo')?0:2)})"]);
  check("no network: outbound fetch fails, only the loopback interface exists", net.code === 0, net.stdout + net.stderr);

  const fs1 = await sh("touch /usr/local/x 2>/dev/null && echo ROOT-WRITABLE; touch /tmp/ok && echo TMP-OK; touch /workspace/repo/.ok && echo REPO-OK; touch \"$HOME/.ok\" && echo HOME-OK");
  check("read-only root; /tmp, repo and home writable", !fs1.stdout.includes("ROOT-WRITABLE") && ["TMP-OK", "REPO-OK", "HOME-OK"].every((m) => fs1.stdout.includes(m)), fs1.stdout + fs1.stderr);

  const caps = await sh("grep -E '^(CapEff|CapPrm|NoNewPrivs)' /proc/self/status");
  check("no effective capabilities, no_new_privs set", /CapEff:\s*0+\b/.test(caps.stdout) && /CapPrm:\s*0+\b/.test(caps.stdout) && /NoNewPrivs:\s*1/.test(caps.stdout), caps.stdout);

  const t0 = Date.now();
  const slow = await sandbox.argv(["sleep", "30"], 2_000);
  check("per-command timeout kills the command (timeout -k inside the container)", slow.timedOut && Date.now() - t0 < 25_000, `code ${slow.code} after ${Date.now() - t0} ms`);

  const pin = JSON.parse(readFileSync(path.join(RUNNER_DIR, "sandbox", "package.json"), "utf8")).dependencies.playwright as string;
  const pw = await sandbox.argv(["node", "-p", "JSON.parse(require('fs').readFileSync('/opt/crestmont/node_modules/playwright/package.json','utf8')).version"]);
  check(`Playwright is the locked version ${pin}`, pw.code === 0 && pw.stdout.trim() === pin, pw.stdout + pw.stderr);

  const tools2 = await sh("bash --version | head -1; timeout --version | head -1; git --version; node --version; npm --version");
  check("bash, coreutils timeout, git, node, npm present", tools2.code === 0, tools2.stdout + tools2.stderr);

  const bc = await sandbox.browserCheck("public", 300_000);
  const shots = existsSync(path.join(ws.repo, ".crestmont", "screenshots")) ? readdirSync(path.join(ws.repo, ".crestmont", "screenshots")).filter((f) => f.endsWith(".png")) : [];
  check("Chromium launches offline: browser-check.mjs passes the brochure starter and writes screenshots", bc.code === 0 && shots.length >= 2, `exit ${bc.code}; ${shots.length} screenshots; ${(bc.stdout + bc.stderr).slice(-400)}`);
} catch (err) {
  check("self-check crashed", false, String(err instanceof Error ? err.stack : err));
} finally {
  await sandbox.close();
  const left = await run(trustedBinary("docker", cfg.dockerBin), ["ps", "-a", "--filter", `name=${sandbox.name}`, "--format", "{{.Names}}"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 30_000 });
  check("job container removed on close", left.stdout.trim() === "", left.stdout);
}

for (const r of results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.check}${r.ok ? "" : `\n      ${r.detail.replace(/\n/g, "\n      ")}`}\n`);
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`${results.length - failed}/${results.length} sandbox self-checks passed for ${image}\n`);
process.exit(failed ? 1 : 0);
