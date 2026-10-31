// Native Ollama detection in the Windows installer (OllamaProbe.ps1), regression for Node 1 (2026-10-31).
// Observed on Node 1 (Windows build 26300): Ollama served on 127.0.0.1:11434 (`ollama ps` worked, Test-NetConnection
// TcpTestSucceeded=True, netstat showed ESTABLISHED connections) while `Get-NetTCPConnection -LocalPort 11434 -State
// Listen` returned nothing, and the installer stopped with "Ollama is not listening on port 11434".
// The PowerShell functions run wherever pwsh is available (CI's test job on ubuntu-latest has it; the Windows
// PowerShell 5.1 workflow sets PWSH=powershell, which also exercises Get-NetTCPConnection and netstat for real).
// The static checks always run. Nothing here claims anything about Node 1 itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Server, type AddressInfo } from "node:net";
import path from "node:path";
import { RUNNER_DIR, REPO_ROOT, tmp } from "./helpers.ts";

const WIN = path.join(RUNNER_DIR, "windows");
// Windows checkouts may use CRLF (core.autocrlf); the static checks compare LF text.
const read = (f: string) => readFileSync(path.join(WIN, f), "utf8").replace(/\r\n/g, "\n");
const MODEL_A = "qwen3.8:27b-q4_K_M";
const MODEL_B = "qwen3.6:35b-a3b-q4_K_M";

function findPwsh(): string | null {
  for (const c of [process.env.PWSH, "pwsh"].filter(Boolean) as string[]) {
    const r = spawnSync(c, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 60_000 });
    if (r.status === 0) return c;
  }
  return null;
}
const PWSH = findPwsh();
const SKIP = PWSH ? false : "pwsh not installed (runs in CI and wherever PWSH is set)";

/** Run PowerShell code after dot-sourcing OllamaProbe.ps1; the code's last value is returned as parsed JSON. Async, so
 *  servers in this process keep answering while PowerShell probes them. OLLAMA_HOST is removed from the environment. */
async function ps<T = any>(code: string): Promise<T> {
  const dir = tmp("aib-ollama-probe-");
  const script = path.join(dir, "run.ps1");
  const out = path.join(dir, "out.json");
  writeFileSync(script, [
    "$ErrorActionPreference = 'Stop'",
    `. '${path.join(WIN, "OllamaProbe.ps1").replaceAll("'", "''")}'`,
    `$r = & { ${code} }`,
    `[IO.File]::WriteAllText('${out.replaceAll("'", "''")}', (ConvertTo-Json -InputObject $r -Depth 6 -Compress))`,
  ].join("\n"));
  const env = { ...process.env };
  delete env.OLLAMA_HOST;
  const { status, stderr } = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const p = spawn(PWSH!, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { env });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.stdout.on("data", () => {});
    p.on("close", (s) => resolve({ status: s, stderr: err }));
  });
  assert.equal(status, 0, stderr);
  return JSON.parse(readFileSync(out, "utf8").replace(/^﻿/, "")) as T;
}
// ConvertTo-Json in Windows PowerShell 5.1 writes a one-item array as the item itself.
const arr = <T>(v: T | T[] | null | undefined): T[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

const NODE1_SOURCES = `@("Get-NetTCPConnection: 0", "GetActiveTcpListeners: 0", "netstat: 0")`;
const NO_HOST = `@{ Process = ""; User = ""; Machine = "" }`;

test("[AIB-RUNNER] Node 1 regression: API answering + no listener listed + localhost-only proven by probe = OK (with a warning), not 'not listening'", { skip: SKIP }, async () => {
  const r = await ps(`Resolve-CrestmontOllamaExposure -Version "0.32.0" -Listener @() -ListenerSource ${NODE1_SOURCES} -HostSetting ${NO_HOST} -ProbedAddress @("192.168.1.20", "172.24.80.1", "fe80::1%12") -ExposedAddress @()`);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.apiResponding, true);
  assert.equal(r.version, "0.32.0");
  assert.equal(r.listenerEnumerated, false);
  assert.deepEqual(arr(r.problems), []);
  assert.equal(arr(r.warnings).length, 1);
  assert.match(arr<string>(r.warnings)[0], /No listener for port 11434 was listed \(Get-NetTCPConnection: 0; GetActiveTcpListeners: 0; netstat: 0\).*refused connections on all 3 non-loopback/);
});

test("[AIB-RUNNER] the localhost-only rule is not bypassed: exposure by probe, by listener or by OLLAMA_HOST each stops the install", { skip: SKIP }, async () => {
  const r = await ps(`@(
    (Resolve-CrestmontOllamaExposure -Version "0.32.0" -Listener @() -ListenerSource ${NODE1_SOURCES} -HostSetting ${NO_HOST} -ProbedAddress @("192.168.1.20") -ExposedAddress @("192.168.1.20")),
    (Resolve-CrestmontOllamaExposure -Version "0.32.0" -Listener @([pscustomobject]@{ address = "0.0.0.0"; pid = 11472 }) -HostSetting ${NO_HOST} -ProbedAddress @("192.168.1.20")),
    (Resolve-CrestmontOllamaExposure -Version "0.32.0" -Listener @([pscustomobject]@{ address = "::" }) -HostSetting ${NO_HOST}),
    (Resolve-CrestmontOllamaExposure -Version "0.32.0" -Listener @() -ListenerSource ${NODE1_SOURCES} -HostSetting @{ Process = ""; User = ""; Machine = "0.0.0.0" } -ProbedAddress @("192.168.1.20")),
    (Resolve-CrestmontOllamaExposure -Version "0.32.0" -Listener @() -HostSetting @{ Process = ""; User = ":11434"; Machine = "" } -ProbedAddress @("192.168.1.20")),
    (Resolve-CrestmontOllamaExposure -Version "0.32.0" -Listener @([pscustomobject]@{ address = "127.0.0.1" }, [pscustomobject]@{ address = "192.168.1.20" }) -HostSetting ${NO_HOST})
  )`);
  const [probe, any4, any6, machine, user, mixed] = r;
  for (const x of r) assert.equal(x.ok, false, JSON.stringify(x));
  assert.match(arr<string>(probe.problems).join(" "), /accepts connections on non-loopback address\(es\) 192\.168\.1\.20/);
  assert.match(arr<string>(any4.problems).join(" "), /listens on 0\.0\.0\.0: Ollama must be localhost only/);
  assert.match(arr<string>(any6.problems).join(" "), /listens on ::/);
  assert.match(arr<string>(machine.problems).join(" "), /OLLAMA_HOST \(Machine scope\) is '0\.0\.0\.0'.*the installer does not change it/);
  assert.match(arr<string>(user.problems).join(" "), /OLLAMA_HOST \(User scope\) is ':11434', which binds Ollama to every interface/);
  assert.match(arr<string>(mixed.problems).join(" "), /listens on 192\.168\.1\.20/);
});

test("[AIB-RUNNER] liveness is the Ollama API, not an open TCP port: no version = stop, even with a loopback listener", { skip: SKIP }, async () => {
  const r = await ps(`Resolve-CrestmontOllamaExposure -Version "" -ApiError "answered, but not with JSON (not the Ollama API?)" -Listener @([pscustomobject]@{ address = "127.0.0.1" }) -HostSetting ${NO_HOST}`);
  assert.equal(r.ok, false);
  assert.equal(r.apiResponding, false);
  assert.match(arr<string>(r.problems)[0], /does not answer at http:\/\/127\.0\.0\.1:11434\/api\/version \(answered, but not with JSON.*only accepts TCP connections is not enough/);
  const ok = await ps(`Resolve-CrestmontOllamaExposure -Version "0.32.0" -Listener @([pscustomobject]@{ address = "127.0.0.1" }, [pscustomobject]@{ address = "::1" }) -HostSetting @{ Process = ""; User = "127.0.0.1:11434"; Machine = "" } -ProbedAddress @("10.0.0.5")`);
  assert.equal(ok.ok, true);
  assert.deepEqual(arr(ok.warnings), [], "listeners listed: no fallback warning");
});

test("[AIB-RUNNER] OLLAMA_HOST is read the way Ollama reads it (scheme, brackets, empty host = every interface)", { skip: SKIP }, async () => {
  const cases: [string, boolean][] = [
    ["", true], ["127.0.0.1:11434", true], ["127.0.0.1", true], ["localhost:11434", true], ["http://127.0.0.1:11434", true],
    ["http://localhost:11434/", true], ["[::1]:11434", true], ["::1", true], ["127.0.0.2:11434", true], ["::ffff:127.0.0.1", true],
    ["0.0.0.0", false], ["0.0.0.0:11434", false], [":11434", false], ["http://0.0.0.0:11434", false], ["[::]:11434", false], ["::", false],
    ["192.168.1.20:11434", false], ["node1.lan:11434", false],
  ];
  const r = await ps(`@(${cases.map(([v]) => `(Get-CrestmontOllamaHostBind '${v}')`).join(", ")})`);
  cases.forEach(([v, loop], i) => assert.equal(r[i].loopback, loop, `OLLAMA_HOST='${v}' -> bind '${r[i].bindHost}'`));
});

test("[AIB-RUNNER] netstat -ano parsing: established connections are not listeners; listeners are found in any locale", { skip: SKIP }, async () => {
  const dir = tmp("aib-netstat-");
  const established = path.join(dir, "established.txt");
  const listening = path.join(dir, "listening.txt");
  // What Node 1 showed: connections to/from Ollama, no LISTENING row in the captured output.
  writeFileSync(established, [
    "", "Active Connections", "", "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:11434        127.0.0.1:52011        ESTABLISHED     11472",
    "  TCP    127.0.0.1:52011        127.0.0.1:11434        ESTABLISHED     20188",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234", "",
  ].join("\r\n"));
  writeFileSync(listening, [
    "  Proto  Lokale Adresse         Remoteadresse          Status           PID",
    "  TCP    127.0.0.1:11434        0.0.0.0:0              ABHOEREN        11472",
    "  TCP    127.0.0.1:114341       0.0.0.0:0              LISTENING       9",
    "  TCP    [::1]:11434            [::]:0                 LISTENING       11472",
    "  TCP    0.0.0.0:11434          0.0.0.0:0              LISTENING       11472",
    "  UDP    0.0.0.0:11434          *:*                                    77",
  ].join("\n"));
  const r = await ps(`@{ e = @(ConvertFrom-CrestmontNetstatListen -Text ([IO.File]::ReadAllText('${established}')) -Port 11434); l = @(ConvertFrom-CrestmontNetstatListen -Text ([IO.File]::ReadAllText('${listening}')) -Port 11434) }`);
  assert.deepEqual(arr(r.e), [], "ESTABLISHED rows are not listeners");
  assert.deepEqual(arr<any>(r.l).map((x) => [x.address, x.pid]), [["127.0.0.1", 11472], ["::1", 11472], ["0.0.0.0", 11472]]);
});

test("[AIB-RUNNER] model tags are matched exactly against Ollama's list (no substring, no near-miss tags)", { skip: SKIP }, async () => {
  const r = await ps(`@{
    none = @(Find-CrestmontMissingModel -Wanted @("${MODEL_A}", "${MODEL_B}") -Available @("qwen3:30b-a3b"));
    oneMissing = @(Find-CrestmontMissingModel -Wanted @("${MODEL_A}", "${MODEL_B}") -Available @("qwen3:30b-a3b", "${MODEL_A}", "qwen3.6:35b-a3b", "qwen3.6:35b-a3b-mtp-q4_K_M"));
    all = @(Find-CrestmontMissingModel -Wanted @("${MODEL_A}", "${MODEL_B}") -Available @("${MODEL_B}", "${MODEL_A}"));
    bare = @(Find-CrestmontMissingModel -Wanted @("llama3") -Available @("llama3:latest"));
  }`);
  assert.deepEqual(arr(r.none), [MODEL_A, MODEL_B]);
  assert.deepEqual(arr(r.oneMissing), [MODEL_B], "qwen3.6:35b-a3b (the default quantization) is not qwen3.6:35b-a3b-q4_K_M");
  assert.deepEqual(arr(r.all), []);
  assert.deepEqual(arr(r.bare), []);
});

async function listen(server: Server, host: string): Promise<number> {
  await new Promise<void>((res) => server.listen(0, host, () => res()));
  return (server.address() as AddressInfo).port;
}
function fakeOllama() {
  return createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/version") return res.end(JSON.stringify({ version: "0.32.0" }));
    if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "qwen3:30b-a3b", model: "qwen3:30b-a3b" }, { name: MODEL_A, model: MODEL_A }, { name: MODEL_B, model: MODEL_B }] }));
    res.statusCode = 404; res.end("{}");
  });
}

test("[AIB-RUNNER] end to end on real sockets: a localhost-only Ollama-like API passes, its exact tags are read, nothing is changed", { skip: SKIP }, async () => {
  const srv = fakeOllama();
  const port = await listen(srv, "127.0.0.1");
  try {
    const r = await ps(`@{ state = (Get-CrestmontOllamaState -Port ${port}); names = @(Get-CrestmontOllamaModelName -Port ${port}) }`);
    assert.equal(r.state.ok, true, JSON.stringify(r.state));
    assert.equal(r.state.version, "0.32.0");
    assert.deepEqual(arr(r.state.evidence.exposed), []);
    assert.deepEqual(arr<string>(r.names).sort(), [MODEL_B, MODEL_A, "qwen3:30b-a3b"].sort());
  } finally { srv.close(); }
});

test("[AIB-RUNNER] end to end: a port that accepts TCP but is not the Ollama API fails; so does a closed port", { skip: SKIP }, async () => {
  const tcp = createTcpServer((s) => s.end("SSH-2.0-not-ollama\r\n"));
  const port = await listen(tcp, "127.0.0.1");
  const closed = createTcpServer(); const closedPort = await listen(closed, "127.0.0.1"); closed.close();
  try {
    const r = await ps(`@((Get-CrestmontOllamaState -Port ${port}), (Get-CrestmontOllamaState -Port ${closedPort}))`);
    for (const x of r) {
      assert.equal(x.ok, false);
      assert.equal(x.apiResponding, false);
      assert.match(arr<string>(x.problems)[0], /does not answer/);
    }
  } finally { tcp.close(); }
});

test("[AIB-RUNNER] end to end: an Ollama-like API bound to every interface is refused", { skip: SKIP }, async () => {
  const srv = fakeOllama();
  const port = await listen(srv, "0.0.0.0");
  try {
    const r = await ps(`Get-CrestmontOllamaState -Port ${port}`);
    assert.equal(r.apiResponding, true);
    assert.equal(r.ok, false, "0.0.0.0 must be detected by the listener sources or the non-loopback probe");
    assert.match(arr<string>(r.problems).join(" "), /listens on 0\.0\.0\.0|accepts connections on non-loopback/);
  } finally { srv.close(); }
});

test("[AIB-RUNNER] installer: Ollama detection uses OllamaProbe.ps1, never the listener list alone; -PreserveOllamaConfig changes and restarts nothing", () => {
  const install = read("Install-CrestmontRunner.ps1");
  const probe = read("OllamaProbe.ps1");
  assert.match(install, /\. \(Join-Path \$PSScriptRoot "OllamaProbe\.ps1"\)/);
  const code = install.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code, /Get-NetTCPConnection/, "the listener list is not the liveness test (Node 1 false negative)");
  assert.doesNotMatch(install, /Ollama is not listening on port 11434/);
  assert.match(install, /\$ollamaState = Get-CrestmontOllamaState -Port 11434/);
  assert.match(install, /if \(-not \$ollamaState\.ok\) \{ Exit-WithProblem \}/, "every exposure or API problem stops the install");
  assert.match(install, /Find-CrestmontMissingModel -Wanted \$pullList -Available \$names/, "exact tags from Ollama's own list");
  assert.match(install, /ollama-connectivity\.json/, "evidence recorded");
  // -PreserveOllamaConfig: the block reports drift only; $changed (the restart trigger) is set only in the other branch.
  const pres = install.slice(install.indexOf("if ($PreserveOllamaConfig) {"), install.indexOf("  } else {\n    foreach ($k in $ollamaEnv.Keys)"));
  assert.ok(pres.length > 100, "preserve block found");
  assert.doesNotMatch(pres, /SetEnvironmentVariable|Stop-Process|Start-Process|\$changed = \$true/);
  assert.equal(install.match(/\$changed = \$true/g)?.length, 1);
  // The probe module only reads.
  assert.doesNotMatch(probe, /SetEnvironmentVariable|Stop-Process|Start-Process|Restart-|Set-NetFirewall|New-NetFirewallRule|netsh/i);
  assert.match(probe, /\$req\.Proxy = \$null/, "the API probe never goes through a proxy");
});

test("[AIB-RUNNER] Node 1 install command: verified dual-model tags, one slot, no auto-start, Ollama preserved, from main", () => {
  const doc = readFileSync(path.join(REPO_ROOT, "docs", "ai-builds", "NODE1-INSTALL.md"), "utf8").replace(/\r\n/g, "\n");
  const install = read("Install-CrestmontRunner.ps1");
  const cmd = doc.slice(doc.indexOf("**E. Install**"), doc.indexOf("## 5. What the installer changes"));
  for (const flag of [`-ModelA ${MODEL_A}`, `-ModelB ${MODEL_B}`, "-Slots 1", "-GpuConcurrency 1", "-PreserveOllamaConfig", "-NoAutoStart", "-NoStart"]) {
    assert.ok(cmd.includes(flag), `install command has ${flag}`);
  }
  assert.match(doc, /\$branch = "main"/, "downloads the branch the fix is merged to");
  assert.match(install, /\[ValidateRange\(1, 16\)\]\[int\]\$Slots = 1/);
  assert.match(install, /OLLAMA_MAX_LOADED_MODELS = "1"/);
});
