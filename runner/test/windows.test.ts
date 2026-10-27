// Unit/static tests for the Windows deployment kit: the model decision table for several hardware profiles, the
// documented Discover-Hardware.ps1 output schema, light static checks of the PowerShell scripts (PowerShell itself is
// not available in this test environment, so these do NOT prove the scripts run), and the compose/proxy policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { selectModel, usableVram, nvidiaDriverVersion, nvidiaDriverTooOld, parseHardwareBytes } from "../windows/select-model.ts";
import type { Hardware, HardwareGpu } from "../windows/select-model.ts";
import { RUNNER_DIR, REPO_ROOT, tmp } from "./helpers.ts";

const WIN = path.join(RUNNER_DIR, "windows");

function hw(o: { gpus?: Partial<HardwareGpu>[]; ram?: number; threads?: number; freeGB?: number; wsl?: boolean; docker?: boolean } = {}): Hardware {
  return {
    schema: "crestmont.hardware/1",
    cpu: { name: "Test CPU", cores: Math.max(1, (o.threads ?? 32) / 2), logicalProcessors: o.threads ?? 32 },
    memory: { totalGB: o.ram ?? 128 },
    gpus: (o.gpus ?? []).map((g) => ({ name: "GPU", vendor: "nvidia", vramGB: 24, vramReliable: true, driverVersion: "566.36", source: "nvidia-smi", ...g })),
    disks: [{ drive: "C:", freeGB: o.freeGB ?? 900 }],
    virtualization: { wslInstalled: o.wsl ?? true, wslVersion2: true },
    docker: { installed: o.docker ?? true, serverReachable: true },
  };
}

test("[AIB-RUNNER] select-model: hardware tiers map to sourced models, quantizations, context and parallelism", () => {
  const a = selectModel(hw({ gpus: [{ name: "RTX PRO 6000", vramGB: 96 }], ram: 256 }));
  assert.equal(a.tier, "A"); assert.equal(a.model, "qwen3-coder-next:q8_0"); assert.equal(a.contextTokens, 65_536); assert.ok(a.ok);
  const b = selectModel(hw({ gpus: [{ name: "RTX 6000 Ada", vramGB: 48 }] }));
  assert.equal(b.tier, "B"); assert.equal(b.model, "qwen3-coder:30b-a3b-q8_0"); assert.equal(b.contextTokens, 65_536);
  const b2 = selectModel(hw({ gpus: [{ vramGB: 40 }] }));
  assert.equal(b2.model, "qwen3-coder:30b-a3b-q8_0"); assert.equal(b2.contextTokens, 32_768);
  const c = selectModel(hw({ gpus: [{ name: "RTX 4090", vramGB: 24 }], ram: 64 }));
  assert.equal(c.tier, "C"); assert.equal(c.model, "qwen3-coder:30b"); assert.equal(c.quantization, "Q4_K_M"); assert.equal(c.acceleration, "gpu");
  assert.ok(c.alternatives.some((x) => x.startsWith("devstral-small-2")));
  const d = selectModel(hw({ gpus: [{ name: "RTX 4080", vramGB: 16 }], ram: 64 }));
  assert.equal(d.tier, "D"); assert.equal(d.acceleration, "gpu+cpu-offload"); assert.equal(d.ollama.kvCacheType, "q8_0");
  assert.ok(d.warnings.some((w) => /offloads layers to the CPU/.test(w)));
  const e = selectModel(hw({ gpus: [], ram: 96, threads: 32 }));
  assert.equal(e.tier, "E"); assert.equal(e.acceleration, "cpu-only"); assert.equal(e.ollama.flashAttention, false);
  for (const r of [a, b, c, d, e]) {
    assert.equal(r.ollama.numParallel, 1);
    assert.equal(r.license, "Apache-2.0");
    assert.ok(r.contextTokens >= 22_000, "agents need a large context (OpenHands: >= 22000)");
    assert.ok(r.sources.length > 0);
  }
  // Two 24 GB GPUs: total VRAM counts, with a warning to confirm the split.
  const two = selectModel(hw({ gpus: [{ vramGB: 24 }, { vramGB: 24 }] }));
  assert.equal(two.model, "qwen3-coder:30b-a3b-q8_0");
  assert.ok(two.warnings.some((w) => /Several GPUs/.test(w)));
});

test("[AIB-RUNNER] select-model says plainly when hardware is insufficient or prerequisites block", () => {
  const weak = selectModel(hw({ gpus: [{ name: "GTX 1650", vramGB: 4 }], ram: 16, threads: 8 }));
  assert.equal(weak.ok, false); assert.equal(weak.tier, "insufficient"); assert.equal(weak.model, null);
  assert.match(weak.summary, /^INSUFFICIENT/);
  assert.match(weak.blockers.join(" "), /Insufficient hardware/);
  const intel = selectModel(hw({ gpus: [{ name: "Intel Arc A770", vendor: "intel", vramGB: 16 }], ram: 32, threads: 8 }));
  assert.equal(intel.tier, "insufficient", "Intel GPUs are not accelerated by Ollama on Windows; 32 GB RAM is below the CPU-only bar");
  assert.equal(usableVram(hw({ gpus: [{ vendor: "intel", vramGB: 16 }] })).totalGB, 0);
  const oldDriver = selectModel(hw({ gpus: [{ vramGB: 24, driverVersion: "537.58" }] }));
  assert.equal(oldDriver.ok, false); assert.match(oldDriver.blockers.join(" "), /older than 551\.61/); assert.match(oldDriver.summary, /^BLOCKED/);
  const disk = selectModel(hw({ gpus: [{ vramGB: 24 }], freeGB: 30 }));
  assert.equal(disk.ok, false); assert.match(disk.blockers.join(" "), /Free disk/);
  const noWsl = selectModel(hw({ gpus: [{ vramGB: 24 }], wsl: false, docker: false }));
  assert.match(noWsl.blockers.join(" "), /WSL is not installed/); assert.match(noWsl.blockers.join(" "), /Docker Desktop is not installed/);
  const wmi = selectModel(hw({ gpus: [{ vramGB: 4, vramReliable: false, source: "Win32_VideoController" }], ram: 64 }));
  assert.ok(wmi.warnings.some((w) => /32-bit field/.test(w)), "WMI VRAM figure flagged as unreliable");
  assert.equal(selectModel({ ...hw(), schema: "x" as "crestmont.hardware/1" }).ok, false);
});

test("[AIB-RUNNER] Discover-Hardware.ps1 emits every field the documented schema and select-model need (static check; PowerShell not run here)", () => {
  const ps = readFileSync(path.join(WIN, "Discover-Hardware.ps1"), "utf8");
  for (const field of ["schema = \"crestmont.hardware/1\"", "collectedAt", "logicalProcessors", "cores", "totalGB", "freeGB", "vramGB", "vramReliable", "driverVersion", "source", "utilizationPercent", "wslInstalled", "wslVersion2", "wslStatusRaw", "serverReachable", "clientVersion", "hostSetting", "npmRegistry", "platform", "loadPercent", "usedPercent", "warnings"]) {
    assert.ok(ps.includes(field), `field ${field}`);
  }
  assert.match(ps, /nvidia-smi/);
  assert.match(ps, /Win32_VideoController/);
  assert.match(ps, /\$req\.Method = "HEAD"/, "reachability uses HEAD requests");
  for (const forbidden of [/Set-ItemProperty/, /New-NetFirewallRule/, /Set-NetFirewall/, /\bInvoke-WebRequest\b.*-Method\s+Post/i, /SetEnvironmentVariable/, /Remove-Item/, /build_runner_secret|CrestmontRunner\\secrets/i]) {
    assert.doesNotMatch(ps, forbidden, `discovery must be read-only: ${forbidden}`);
  }
  const doc = readFileSync(path.join(REPO_ROOT, "docs", "ai-builds", "WINDOWS-SUPERCOMPUTER.md"), "utf8");
  for (const field of ["vramReliable", "wslVersion2", "serverReachable", "npmRegistry", "crestmont.hardware/1"]) assert.ok(doc.includes(field), `schema documented: ${field}`);
});

/** Light PowerShell lint: balanced (), {}, [] outside strings/comments/here-strings, and known parse traps. */
function lintPowerShell(src: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\n") line++;
    if (src.startsWith("<#", i)) { const e = src.indexOf("#>", i); if (e < 0) { problems.push(`unclosed block comment at line ${line}`); break; } line += src.slice(i, e).split("\n").length - 1; i = e + 2; continue; }
    if (ch === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if ((src.startsWith("@'", i) || src.startsWith("@\"", i)) && src[i + 2] === "\n" || src.startsWith("@'\r\n", i)) {
      const q = src[i + 1];
      const e = src.indexOf(`\n${q}@`, i);
      if (e < 0) { problems.push(`unclosed here-string at line ${line}`); break; }
      line += src.slice(i, e + 1).split("\n").length - 1; i = e + 3; continue;
    }
    if (ch === "'" ) { i++; while (i < src.length && !(src[i] === "'" && src[i + 1] !== "'")) { if (src[i] === "'" ) i++; if (src[i] === "\n") line++; i++; } i++; continue; }
    if (ch === "\"") {
      i++;
      let depth = 0;
      while (i < src.length) {
        if (src[i] === "`") { i += 2; continue; }
        if (src[i] === "\n") line++;
        if (src.startsWith("$(", i)) { depth++; i += 2; continue; }
        if (depth > 0 && src[i] === "(") { depth++; }
        else if (depth > 0 && src[i] === ")") { depth--; }
        else if (depth === 0 && src[i] === "\"") { if (src[i + 1] === "\"") { i += 2; continue; } break; }
        i++;
      }
      i++; continue;
    }
    if ("({[".includes(ch)) stack.push(ch);
    else if (")}]".includes(ch)) { const top = stack.pop(); if (top !== pairs[ch]) { problems.push(`unbalanced ${ch} at line ${line}`); break; } }
    i++;
  }
  if (stack.length && !problems.length) problems.push(`unclosed ${stack.join("")}`);
  for (const [n, l] of src.split("\n").entries()) {
    if (/"[^"]*\$(?!env:|script:|global:|using:)[A-Za-z_]\w*:\s/.test(l)) problems.push(`line ${n + 1}: "$name:" inside a string is a drive-qualified variable; use \${name}`);
    if (/\?\?|\?\./.test(l.replace(/#.*$/, "").replace(/"[^"]*"|'[^']*'/g, ""))) problems.push(`line ${n + 1}: ?? / ?. need PowerShell 7 (target is Windows PowerShell 5.1)`);
    if (/^\s*\$args\s*=/.test(l)) problems.push(`line ${n + 1}: assigning the automatic variable $args`);
  }
  return problems;
}

test("[AIB-RUNNER] PowerShell scripts pass a light static lint and are ASCII-only (the real parse + PSScriptAnalyzer run is Test-WindowsScripts.ps1, in CI)", () => {
  const scripts = readdirSync(WIN).filter((f) => f.endsWith(".ps1"));
  for (const f of ["Discover-Hardware.ps1", "Install-CrestmontRunner.ps1", "Start-CrestmontRunner.ps1", "Get-RunnerHealth.ps1", "Collect-Evidence.ps1", "SquidConf.ps1", "Test-WindowsScripts.ps1"]) {
    assert.ok(scripts.includes(f), `${f} present`);
  }
  for (const f of scripts) {
    const bytes = readFileSync(path.join(WIN, f));
    // Windows PowerShell 5.1 reads BOM-less files as ANSI: UTF-8 punctuation (e.g. an em dash, E2 80 94) becomes
    // characters such as U+201D that PowerShell treats as a quote, which can break string parsing.
    assert.equal(bytes.findIndex((b) => b > 127), -1, `${f} must be ASCII-only`);
    assert.deepEqual(lintPowerShell(bytes.toString("utf8")), [], f);
  }
  assert.ok(lintPowerShell("function a { (\n }").length > 0, "lint detects imbalance");
  assert.ok(lintPowerShell("Write-Host \"build $b: x\"").length > 0, "lint detects the $name: trap");
  const install = readFileSync(path.join(WIN, "Install-CrestmontRunner.ps1"), "utf8");
  assert.doesNotMatch(install, /New-NetFirewallRule|netsh\s+advfirewall/i, "no inbound firewall rules");
  assert.match(install, /OLLAMA_HOST = "127\.0\.0\.1:11434"/);
  assert.match(install, /RUNNER_ALLOW_PAID_PROVIDER=false/);
  assert.match(install, /if \(-not \$Install\)/, "installs only with -Install");
  assert.match(install, /Read-Host -AsSecureString/, "secret entered hidden, never echoed");
  assert.match(install, /ZeroFreeBSTR/, "the unmanaged copy of the secret is zeroed");
  assert.match(install, /\. \(Join-Path \$PSScriptRoot "SquidConf\.ps1"\)/, "installer uses the tested renderer");
  assert.match(install, /ConvertTo-SquidConf -Template \$template -PlatformHost \$PlatformHost -ExtraDomains \$ExtraEgressDomains/);
  assert.doesNotMatch(install, /\.Replace\("__PLATFORM_HOST__"/, "no second, untested substitution");
  assert.match(install, /sandbox\\package-lock\.json/, "installer refuses to build without the committed lockfiles");
  assert.match(install, /OLLAMA_IMAGE=\$OllamaImage/);
  assert.match(install, /\[string\]\$OllamaImage = "ollama\/ollama:\d+\.\d+\.\d+"/);
});

test("[AIB-RUNNER] select-model: NVIDIA driver versions in nvidia-smi and Windows driver-store form", () => {
  assert.equal(nvidiaDriverVersion("566.36"), "566.36");
  assert.equal(nvidiaDriverVersion("551.61"), "551.61");
  assert.equal(nvidiaDriverVersion("31.0.15.5161"), "551.61", "Win32_VideoController form: 15.5161 -> 551.61");
  assert.equal(nvidiaDriverVersion("32.0.15.6636"), "566.36");
  assert.equal(nvidiaDriverVersion("31.0.15.3758"), "537.58");
  assert.equal(nvidiaDriverVersion("30.0.14.9649"), "496.49");
  assert.equal(nvidiaDriverVersion(""), null);
  assert.equal(nvidiaDriverVersion("unknown"), null);
  assert.equal(nvidiaDriverTooOld("31.0.15.5161"), false);
  assert.equal(nvidiaDriverTooOld("31.0.15.3758"), true);
  assert.equal(nvidiaDriverTooOld("551.52"), true);
  assert.equal(nvidiaDriverTooOld(null), false);
  // Before this fix the Windows form was read as major version 32 and every such machine was BLOCKED.
  const wmi = selectModel(hw({ gpus: [{ name: "RTX 4090", vramGB: 24, driverVersion: "32.0.15.6636", source: "registry qwMemorySize" }] }));
  assert.equal(wmi.ok, true, wmi.blockers.join(" "));
  const old = selectModel(hw({ gpus: [{ name: "RTX 4090", vramGB: 24, driverVersion: "31.0.15.3758", source: "Win32_VideoController" }] }));
  assert.match(old.blockers.join(" "), /537\.58 \(reported as 31\.0\.15\.3758\) .*older than 551\.61/);
});

test("[AIB-RUNNER] select-model tolerates Windows PowerShell JSON shapes: BOM, UTF-16, single objects, strings, missing sections", () => {
  const doc = { schema: "crestmont.hardware/1", cpu: { name: "CPU", cores: "16", logicalProcessors: "32" }, memory: { totalGB: "128" },
    gpus: { name: "RTX 4090", vendor: "NVIDIA", vramGB: "24", vramReliable: true, driverVersion: "566.36", source: "nvidia-smi" },
    disks: { drive: "C:", freeGB: "900" }, virtualization: { wslInstalled: true }, docker: { installed: true } };
  const json = JSON.stringify(doc);
  const variants: [string, Buffer][] = [
    ["utf8", Buffer.from(json, "utf8")],
    ["utf8 BOM (Out-File -Encoding utf8 in 5.1)", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, "utf8")])],
    ["utf16le BOM (> redirection in 5.1)", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, "utf16le")])],
    ["utf16le without BOM", Buffer.from(json, "utf16le")],
  ];
  for (const [label, buf] of variants) {
    const r = selectModel(parseHardwareBytes(buf));
    assert.equal(r.tier, "C", label);
    assert.equal(r.ok, true, `${label}: ${r.blockers.join(" ")}`);
    assert.equal(r.jobLimits.cpus, 8, `${label}: threads parsed from a string`);
  }
  const be = Buffer.from(json, "utf16le"); be.swap16();
  assert.equal(selectModel(parseHardwareBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).tier, "C", "utf16be BOM");
  assert.throws(() => parseHardwareBytes(Buffer.from("not json")), SyntaxError);
  // Missing sections: no crash, and the verdict says what is unknown instead of guessing.
  const bare = selectModel({ schema: "crestmont.hardware/1" } as unknown as Hardware);
  assert.equal(bare.ok, false);
  assert.equal(bare.tier, "insufficient");
  assert.match(bare.blockers.join(" "), /largest free is unknown/);
  const nullGpu = selectModel(hw({ gpus: [{ vendor: "amd", vramGB: null, vramReliable: false, source: "Win32_VideoController" }], ram: 64, threads: 16 }));
  assert.equal(nullGpu.tier, "E", "a GPU with unknown VRAM is not counted as accelerated");
  assert.ok(nullGpu.warnings.some((w) => /32-bit field/.test(w)));
  // Exact tier boundaries (VRAM thresholds are model file + 4 GB headroom).
  assert.equal(selectModel(hw({ gpus: [{ vramGB: 36 }] })).tier, "B");
  assert.equal(selectModel(hw({ gpus: [{ vramGB: 35.9 }] })).tier, "C");
  assert.equal(selectModel(hw({ gpus: [{ vramGB: 23 }] })).tier, "C");
  assert.equal(selectModel(hw({ gpus: [{ vramGB: 22.9 }], ram: 32 })).tier, "D");
  assert.equal(selectModel(hw({ gpus: [{ vramGB: 16 }], ram: 31 })).tier, "insufficient", "16 GB GPU needs 32 GB RAM for offload");
  assert.equal(selectModel(hw({ gpus: [{ vramGB: 89 }], ram: 63 })).tier, "B", "tier A also needs 64 GB RAM");
  assert.equal(selectModel(hw({ gpus: [], ram: 48, threads: 7 })).tier, "insufficient", "CPU-only needs 8 threads");
  assert.equal(selectModel(hw({ gpus: [], ram: 47.9, threads: 64 })).tier, "insufficient");
  // Job limits stay within their documented bounds on tiny and huge machines.
  for (const [ram, threads] of [[48, 8], [2048, 256]]) {
    const r = selectModel(hw({ gpus: [{ vramGB: 96 }], ram, threads }));
    assert.ok(r.jobLimits.cpus >= 2 && r.jobLimits.cpus <= 8, `cpus ${r.jobLimits.cpus}`);
    assert.ok(r.jobLimits.memoryGB >= 4 && r.jobLimits.memoryGB <= 8, `memory ${r.jobLimits.memoryGB}`);
  }
});

test("[AIB-RUNNER] select-model CLI reads a UTF-16 hardware.json and exits 0 (ok) / 3 (not ok)", () => {
  const dir = tmp("aib-hw-");
  const good = path.join(dir, "good.json");
  writeFileSync(good, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(hw({ gpus: [{ vramGB: 24 }] })), "utf16le")]));
  const r = spawnSync(process.execPath, ["--no-warnings", path.join(WIN, "select-model.ts"), good], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).model, "qwen3-coder:30b");
  const weak = path.join(dir, "weak.json");
  writeFileSync(weak, JSON.stringify(hw({ gpus: [], ram: 8, threads: 4 })));
  assert.equal(spawnSync(process.execPath, ["--no-warnings", path.join(WIN, "select-model.ts"), weak], { encoding: "utf8" }).status, 3);
});

test("[AIB-RUNNER] compose + proxy policy: no published ports, internal networks, paid AI hosts denied, installs reach only the npm registry", () => {
  const compose = readFileSync(path.join(WIN, "docker-compose.yml"), "utf8");
  assert.doesNotMatch(compose, /^\s+ports:/m, "no published ports");
  assert.match(compose, /runner_net:\n\s+name: crestmont_runner\n\s+internal: true/);
  assert.match(compose, /install_net:\n\s+name: crestmont_install\n\s+internal: true/);
  const runner = compose.slice(compose.indexOf("  runner:"), compose.indexOf("  ollama:"));
  assert.match(runner, /networks: \[runner_net\]/, "runner only on the internal network");
  assert.match(runner, /restart: unless-stopped/);
  assert.match(runner, /read_only: true/);
  assert.match(runner, /cap_drop: \[ALL\]/);
  assert.match(runner, /max-size/, "log rotation");
  assert.match(runner, /healthcheck:/);
  assert.match(runner, /NODE_USE_ENV_PROXY: "1"/);
  const squid = readFileSync(path.join(WIN, "proxy", "squid.conf.template"), "utf8");
  const order = squid.split("\n").filter((l) => l.startsWith("http_access"));
  assert.equal(order[0], "http_access deny paid_ai", "paid AI denial comes first");
  assert.equal(order.at(-1), "http_access deny all");
  assert.ok(order.includes("http_access allow install_net CONNECT npm_registry"));
  assert.ok(!order.some((l) => /allow install_net/.test(l) && !/npm_registry/.test(l)), "install network reaches only the registry");
  assert.match(squid, /acl paid_ai dstdomain \.anthropic\.com/);
});
