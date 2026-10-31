// Windows installer regression tests (AI Website Builder readiness, 2026-10-28): configuration preservation across
// re-runs (runner.env / runner.local.env), -Model limited to the model choice, pinned images, health-gated "Done",
// isolation evidence collection. RunnerEnv.ps1 is compared with runner-env.ts wherever pwsh is available (CI's
// windows-scripts job and the Windows PowerShell 5.1 workflow); the static checks below always run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  mergeRunnerEnv, parseEnvText, renderRunnerEnv, MANAGED_RUNNER_ENV_KEYS, RESERVED_LOCAL_KEYS, LOCAL_ENV_TEMPLATE, RunnerEnvError,
} from "../windows/runner-env.ts";
import type { EnvLine, MergeResult } from "../windows/runner-env.ts";
import { selectModel } from "../windows/select-model.ts";
import { RUNNER_DIR, tmp } from "./helpers.ts";

const WIN = path.join(RUNNER_DIR, "windows");
const read = (f: string) => readFileSync(path.join(WIN, f), "utf8");

function managed(over: Record<string, string> = {}): EnvLine[] {
  const v: Record<string, string> = {
    CONTROL_PLANE_URL: "https://staging.crestmont.example", BUILD_RUNNER_SECRET_FILE: "/run/secrets/build_runner_secret", RUNNER_ID: "win-build1", RUNNER_HOST_LABEL: "NODE1",
    RUNNER_AGENT_PROVIDER: "local", RUNNER_ALLOW_PAID_PROVIDER: "false", LOCAL_MODEL: "qwen3-coder:30b", LOCAL_MODEL_BASE_URL: "http://host.docker.internal:11434/v1",
    LOCAL_MODEL_CONTEXT_TOKENS: "32768", RUNNER_SANDBOX_IMAGE: "crestmont-build-sandbox:1", RUNNER_JOB_CPUS: "4", RUNNER_JOB_MEMORY: "6g",
    RUNNER_JOB_DISK_MB: "4096", RUNNER_SERVE_AI_DRAFTS: "true", LOG_LEVEL: "info",
    LOCAL_MODEL_A: "", LOCAL_MODEL_B: "", LOCAL_MODEL_A_VISION: "false", RUNNER_SLOTS: "1", INFERENCE_MAX_CONCURRENT: "1", GPU_VRAM_TOTAL_MB: "32563",
    GPU_TELEMETRY_FILE: "/run/crestmont/gpu.json", BUILD_WORKER_ID: "", BUILD_WORKER_KEY_FILE: "", ...over,
  };
  return MANAGED_RUNNER_ENV_KEYS.map((key) => ({ key, value: v[key] }));
}
const STAMP = "20261028-041500";

/** The scenarios, also replayed through RunnerEnv.ps1 for the parity test. */
const CASES: { name: string; input: { managed: EnvLine[]; existingRunnerEnv: string | null; existingLocalEnv: string | null; stamp: string } }[] = [
  { name: "fresh install", input: { managed: managed(), existingRunnerEnv: null, existingLocalEnv: null, stamp: STAMP } },
  { name: "re-run of the old installer's runner.env with hand-added repo + preview lines (CRLF)", input: {
    managed: managed({ LOCAL_MODEL: "devstral:24b" }),
    existingRunnerEnv: "CONTROL_PLANE_URL=https://staging.crestmont.example\r\nLOCAL_MODEL=qwen3-coder:30b\r\nPROJECT_REPO_OWNER=crestmont-builds\r\nPROJECT_REPO_TOKEN_FILE=/run/secrets/project_repo_token\r\nPREVIEW_DEPLOY_COMMAND=npx --yes wrangler@4.40.0 deploy --name \"$CRESTMONT_PREVIEW_NAME\"\r\nPREVIEW_DEPLOY_ENV=CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID\r\n",
    existingLocalEnv: null, stamp: STAMP } },
  { name: "local file already sets a moved key (local wins), BOM, no trailing newline", input: {
    managed: managed(), existingRunnerEnv: "PROJECT_REPO_OWNER=old-org\nPREVIEW_DEPLOY_ENV=X\n",
    existingLocalEnv: "﻿# mine\nPROJECT_REPO_OWNER=new-org", stamp: STAMP } },
  { name: "conflicts: managed and sandbox-weakening keys in runner.local.env, reserved key hand-added to runner.env", input: {
    managed: managed(), existingRunnerEnv: "RUNNER_SANDBOX=off\nKEEP_ME=1\n",
    existingLocalEnv: "RUNNER_ALLOW_PAID_PROVIDER=true\nANTHROPIC_API_KEY=sk-ant-x\nPROJECT_REPO_OWNER=o\n", stamp: STAMP } },
  { name: "idempotent second run", input: {
    managed: managed(), existingRunnerEnv: renderRunnerEnv(managed()), existingLocalEnv: LOCAL_ENV_TEMPLATE.join("\n") + "\nPROJECT_REPO_OWNER=o\n", stamp: STAMP } },
];

test("[AIB-RUNNER] runner.env is managed; a re-run moves hand-added settings to runner.local.env instead of dropping them", () => {
  const fresh = mergeRunnerEnv(CASES[0].input);
  assert.match(fresh.runnerEnv, /^# Managed by Install-CrestmontRunner\.ps1/);
  assert.deepEqual(parseEnvText(fresh.runnerEnv).map((l) => l.key), [...MANAGED_RUNNER_ENV_KEYS]);
  assert.match(fresh.runnerEnv, /\nRUNNER_ALLOW_PAID_PROVIDER=false\n/);
  assert.equal(fresh.localEnv, LOCAL_ENV_TEMPLATE.join("\n") + "\n", "local file created once from the template");
  assert.deepEqual([fresh.moved, fresh.conflicts, fresh.changed], [[], [], []]);
  assert.deepEqual(parseEnvText(fresh.localEnv), [], "the template only has comments");

  const rerun = mergeRunnerEnv(CASES[1].input);
  assert.deepEqual(rerun.moved, ["PROJECT_REPO_OWNER", "PROJECT_REPO_TOKEN_FILE", "PREVIEW_DEPLOY_COMMAND", "PREVIEW_DEPLOY_ENV"]);
  assert.match(rerun.localEnv, /# Moved from runner\.env by the installer on 20261028-041500:\nPROJECT_REPO_OWNER=crestmont-builds\n/);
  assert.match(rerun.localEnv, /PREVIEW_DEPLOY_COMMAND=npx --yes wrangler@4\.40\.0 deploy --name "\$CRESTMONT_PREVIEW_NAME"\n/, "values kept byte for byte (CR removed)");
  assert.deepEqual(parseEnvText(rerun.runnerEnv).map((l) => l.key), [...MANAGED_RUNNER_ENV_KEYS], "runner.env holds managed keys only");
  assert.ok(rerun.changed.includes("LOCAL_MODEL") && rerun.changed.includes("RUNNER_ID"), "changes are reported (the installer backs the old file up)");
  assert.ok(!rerun.changed.includes("CONTROL_PLANE_URL"));

  const localWins = mergeRunnerEnv(CASES[2].input);
  assert.deepEqual(localWins.moved, ["PREVIEW_DEPLOY_ENV"], "a key the local file already sets is not moved again");
  assert.ok(localWins.localEnv.startsWith("# mine\nPROJECT_REPO_OWNER=new-org\n# Moved from runner.env"), "BOM dropped, newline added, own lines kept first");

  const conflicts = mergeRunnerEnv(CASES[3].input);
  assert.deepEqual(conflicts.conflicts, ["RUNNER_ALLOW_PAID_PROVIDER", "ANTHROPIC_API_KEY", "RUNNER_SANDBOX"]);
  assert.deepEqual(conflicts.moved, ["KEEP_ME"], "a reserved key from an old runner.env is a conflict, never carried over");
  assert.ok(!conflicts.localEnv.includes("RUNNER_SANDBOX"));

  const again = mergeRunnerEnv(CASES[4].input);
  assert.deepEqual([again.moved, again.conflicts, again.changed], [[], [], []], "a second identical run changes nothing");
  assert.equal(again.localEnv, CASES[4].input.existingLocalEnv);
  assert.equal(again.runnerEnv, CASES[4].input.existingRunnerEnv);

  for (const k of ["RUNNER_SANDBOX", "RUNNER_JOB_UID", "ANTHROPIC_API_KEY", "RUNNER_INSTALL_NETWORK", "HTTPS_PROXY"]) assert.ok((RESERVED_LOCAL_KEYS as readonly string[]).includes(k), k);
});

test("[AIB-RUNNER] runner.env rendering refuses values that could inject lines or are not plain ASCII, and wrong key sets", () => {
  assert.throws(() => renderRunnerEnv(managed({ LOCAL_MODEL: "x\nRUNNER_ALLOW_PAID_PROVIDER=true" })), RunnerEnvError);
  assert.throws(() => renderRunnerEnv(managed({ RUNNER_ID: "café" })), RunnerEnvError);
  assert.throws(() => renderRunnerEnv(managed().slice(1)), /managed keys must be exactly/);
  assert.throws(() => mergeRunnerEnv({ ...CASES[0].input, stamp: "now" }), /stamp/);
  assert.deepEqual(parseEnvText("# c\n\n=x\nlower=1\nA_B=c=d\r\n bad line\n"), [{ key: "A_B", value: "c=d" }]);
});

/** pwsh on PATH, or PWSH=<path> (CI sets PWSH=powershell for Windows PowerShell 5.1); null when not installed. */
function findPwsh(): string | null {
  for (const c of [process.env.PWSH, "pwsh"].filter(Boolean) as string[]) {
    const r = spawnSync(c, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 60_000 });
    if (r.status === 0) return c;
  }
  return null;
}
const PWSH = findPwsh();

test("[AIB-RUNNER] RunnerEnv.ps1 (used by the installer) produces exactly what runner-env.ts produces", { skip: PWSH ? false : "pwsh not installed (runs in CI's windows-scripts job and wherever PWSH is set)" }, () => {
  const dir = tmp("aib-runnerenv-ps-");
  const script = path.join(dir, "merge.ps1");
  writeFileSync(script, [
    "param([string]$In, [string]$Out)",
    "$ErrorActionPreference = 'Stop'",
    `. '${path.join(WIN, "RunnerEnv.ps1").replaceAll("'", "''")}'`,
    "$c = [IO.File]::ReadAllText($In) | ConvertFrom-Json",
    "$r = Merge-CrestmontRunnerEnv -Managed @($c.managed) -ExistingRunnerEnv $c.existingRunnerEnv -ExistingLocalEnv $c.existingLocalEnv -Stamp $c.stamp",
    "[IO.File]::WriteAllText($Out, ($r | ConvertTo-Json -Depth 5 -Compress))",
  ].join("\n"));
  for (const c of CASES) {
    const inFile = path.join(dir, "in.json");
    const outFile = path.join(dir, "out.json");
    writeFileSync(inFile, JSON.stringify(c.input));
    const r = spawnSync(PWSH!, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-In", inFile, "-Out", outFile], { encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, `${c.name}: ${r.stderr}`);
    const ps = JSON.parse(readFileSync(outFile, "utf8").replace(/^﻿/, "")) as MergeResult;
    const ts = mergeRunnerEnv(c.input);
    // ConvertTo-Json in Windows PowerShell 5.1 writes an empty array as [] and a one-item array as the item itself.
    const arr = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]);
    assert.deepEqual({ ...ps, moved: arr(ps.moved), conflicts: arr(ps.conflicts), changed: arr(ps.changed) }, ts, c.name);
  }
});

test("[AIB-RUNNER] installer: -Model overrides only the model choice; driver, disk, WSL and Docker blockers still stop it", () => {
  const install = read("Install-CrestmontRunner.ps1");
  assert.doesNotMatch(install, /Problems\.Clear\(\)/, "no blanket clearing of blockers");
  assert.match(install, /foreach \(\$b in @\(\$rec\.modelChoiceBlockers\)\) \{ if \(\$b\) \{ \[void\]\$script:Problems\.Remove\(\$b\)/);
  assert.match(install, /if \(\$Model\) \{[\s\S]{0,400}if \(\$script:Problems\.Count\) \{ Exit-WithProblem \}/);
  // The selector separates the two kinds of blocker.
  const base = { schema: "crestmont.hardware/1", os: { build: 26100 }, cpu: { name: "x", logicalProcessors: 8 }, memory: { totalGB: 16 }, gpus: [], disks: [{ drive: "C:", freeGB: 500 }], virtualization: { wslInstalled: true }, docker: { installed: true } };
  const weak = selectModel(base as never);
  assert.equal(weak.ok, false);
  assert.equal(weak.modelChoiceBlockers.length, 1);
  assert.match(weak.modelChoiceBlockers[0], /Insufficient hardware/);
  assert.ok(weak.blockers.includes(weak.modelChoiceBlockers[0]));
  const env = selectModel({ ...base, memory: { totalGB: 64 }, cpu: { name: "x", logicalProcessors: 16 }, disks: [{ drive: "C:", freeGB: 10 }], virtualization: { wslInstalled: false } } as never);
  assert.deepEqual(env.modelChoiceBlockers, [], "disk / WSL blockers are not model-choice blockers");
  assert.ok(env.blockers.some((b) => /Free disk/.test(b)) && env.blockers.some((b) => /WSL/.test(b)));
});

test("[AIB-RUNNER] installer: configuration preserved across re-runs, inputs validated, tools always copied, Done only when healthy", () => {
  const install = read("Install-CrestmontRunner.ps1");
  assert.match(install, /\. \(Join-Path \$PSScriptRoot "RunnerEnv\.ps1"\)/, "installer uses the tested merge");
  assert.match(install, /Merge-CrestmontRunnerEnv -Managed \$managed -ExistingRunnerEnv \$oldRunnerEnv -ExistingLocalEnv \$oldLocalEnv -Stamp \$stamp/);
  assert.doesNotMatch(install, /Set-Content[^\n]*runner\.env/, "runner.env is never written blindly");
  assert.match(install, /runner\.env\.\$stamp\.bak/, "backup before a changed runner.env is replaced");
  assert.match(install, /if \(@\(\$merged\.conflicts\)\.Count\) \{[\s\S]{0,400}Exit-WithProblem/, "conflicts stop the install");
  const keysInInstaller = [...install.matchAll(/\[pscustomobject\]@\{ key = "([A-Z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keysInInstaller, [...MANAGED_RUNNER_ENV_KEYS], "installer writes exactly the managed keys, in order");
  const ps = read("RunnerEnv.ps1");
  for (const k of [...MANAGED_RUNNER_ENV_KEYS, ...RESERVED_LOCAL_KEYS]) assert.ok(ps.includes(`"${k}"`), `RunnerEnv.ps1 lists ${k}`);
  assert.match(install, /-Model must be an Ollama model tag/, "-Model validated before it reaches runner.env");
  assert.match(install, /-OllamaImage must be pinned by tag and digest/);
  assert.match(install, /\$ollamaCli = if \(Test-Path \$ollamaExe\)/, "ollama by full path after a fresh install");
  assert.doesNotMatch(install, /& ollama list|"ollama" @\("pull"/);
  assert.match(install, /Find-CrestmontMissingModel -Wanted \$pullList -Available \$names/, "exact tag match in Ollama's model list (every model of the mode; ollama-probe.test.ts)");
  // Founder V4: dual-model mode pulls and checks both models; one model is loaded at a time; GPU telemetry task.
  assert.match(install, /\[string\]\$ModelA = "",/);
  assert.match(install, /Dual-model mode needs both -ModelA \(architect\/reviewer\) and -ModelB \(builder\)/);
  assert.match(install, /\$pullList = @\(if \(\$DualMode\) \{ \$ModelA, \$ModelB \} else \{ \$selected \}\)/);
  assert.match(install, /OLLAMA_MAX_LOADED_MODELS = "1"/);
  assert.match(install, /key = "LOCAL_MODEL_A"; value = \$\(if \(\$DualMode\) \{ \$ModelA \} else \{ "" \}\)/);
  assert.match(install, /key = "BUILD_WORKER_KEY_FILE"; value = \$\(if \(\$WorkerId\) \{ "\/run\/secrets\/worker_key" \} else \{ "" \}\)/);
  assert.match(install, /CrestmontRunner-GpuTelemetry/);
  const autoStart = install.slice(install.indexOf('if (-not $NoAutoStart) {'));
  assert.doesNotMatch(autoStart.slice(0, autoStart.indexOf("Register-ScheduledTask")), /Collect-Evidence\.ps1/, "tools are not copied only with auto-start");
  assert.match(install, /foreach \(\$tool in @\("Start-CrestmontRunner\.ps1", "Get-RunnerHealth\.ps1", "Collect-Evidence\.ps1", "Discover-Hardware\.ps1", "Write-GpuTelemetry\.ps1", "Test-Node1Dispatch\.ps1", "Uninstall-CrestmontRunner\.ps1"\)\)/);
  assert.match(install, /\$healthExit = \$LASTEXITCODE[\s\S]{0,200}if \(\$healthExit -ne 0\) \{[\s\S]{0,300}exit 1/, "no 'Done' when health fails");
  assert.match(install, /KernelVersion[\s\S]{0,200}WSL2/, "WSL 2 backend detected from Docker Desktop's kernel");
  assert.match(install, /docker\.exe compose version --short/, "Compose >= 2.24 for the optional env file");
  // Compose: the local file loads first and is optional; the managed file wins.
  const compose = read("docker-compose.yml");
  assert.match(compose, /env_file:\n\s+- path: \.\/runner\.local\.env\n\s+required: false\n\s+- path: \.\/runner\.env\n\s+required: true/);
});

test("[AIB-RUNNER] Collect-Evidence.ps1: one folder for monitor + job (or the latest monitor's utilization copied), runner isolation records, an evidence index", () => {
  const ev = read("Collect-Evidence.ps1");
  assert.match(ev, /\[string\]\$EvidenceDir = ""/);
  assert.match(ev, /\$out = if \(\$EvidenceDir\) \{ \$EvidenceDir \}/);
  assert.match(ev, /-Filter "\*-monitor"[\s\S]{0,300}utilization\.csv/);
  assert.match(ev, /cp "\$d\/evidence\/"\*\.json "\/out\/\$n\/_runner-evidence\/"/, "isolation records copied from the job directory");
  assert.match(ev, /EVIDENCE-INDEX\.txt/);
  assert.match(ev, /Sandbox isolation[^\n]*sandbox-isolation-\*\.json/);
  assert.doesNotMatch(ev, /health\.json/, "the header names the file actually written (health.txt)");
  assert.match(ev, /-JobId must look like bld_/, "JobId validated before it reaches a shell script");
  assert.doesNotMatch(ev, /secrets\\\\|Copy-Item[^\n]*secrets/i, "the secrets folder is never collected");
});

const HAS_COMPOSE = spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 30_000 }).status === 0;

test("[AIB-RUNNER] real docker-compose.yml: runner.local.env is optional, runner.env wins on every managed key, and a single-quoted preview command keeps $CRESTMONT_PREVIEW_NAME", { skip: HAS_COMPOSE ? false : "docker CLI with the compose plugin not installed (CI has it)" }, () => {
  const dir = path.join(tmp("aib-compose-env-"), "compose");
  mkdirSync(path.join(dir, "proxy"), { recursive: true });
  copyFileSync(path.join(WIN, "docker-compose.yml"), path.join(dir, "docker-compose.yml"));
  copyFileSync(path.join(WIN, "proxy", "Dockerfile"), path.join(dir, "proxy", "Dockerfile"));
  const runnerEnv = (): Record<string, string> => {
    const r = spawnSync("docker", ["compose", "config", "--format", "json"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return (JSON.parse(r.stdout) as { services: { runner: { environment: Record<string, string> } } }).services.runner.environment;
  };
  writeFileSync(path.join(dir, "runner.env"), renderRunnerEnv(managed()));
  assert.equal(runnerEnv().RUNNER_ALLOW_PAID_PROVIDER, "false", "works without runner.local.env");
  writeFileSync(path.join(dir, "runner.local.env"), [
    "RUNNER_ALLOW_PAID_PROVIDER=true", "LOCAL_MODEL=other:1",
    `PREVIEW_DEPLOY_COMMAND='npx --yes wrangler@4.0.0 deploy --name "$CRESTMONT_PREVIEW_NAME"'`,
    `UNQUOTED=deploy --name "$CRESTMONT_PREVIEW_NAME"`, "PROJECT_REPO_OWNER=crestmont-builds",
  ].join("\n") + "\n");
  const env = runnerEnv();
  assert.equal(env.RUNNER_ALLOW_PAID_PROVIDER, "false", "a managed key in the local file never wins (the installer also refuses it)");
  assert.equal(env.LOCAL_MODEL, "qwen3-coder:30b");
  assert.equal(env.PROJECT_REPO_OWNER, "crestmont-builds", "the Founder's own settings reach the runner");
  // Compose escapes a literal $ as $$ in `config` output; the container receives a single $.
  assert.equal(env.PREVIEW_DEPLOY_COMMAND.replaceAll("$$", "$"), `npx --yes wrangler@4.0.0 deploy --name "$CRESTMONT_PREVIEW_NAME"`);
  assert.equal(env.UNQUOTED, `deploy --name ""`, "why PREVIEW-DEPLOYMENT.md requires single quotes");
  assert.equal(env.HTTPS_PROXY, "http://egress-proxy:3128", "compose environment: still wins over both files");
});
