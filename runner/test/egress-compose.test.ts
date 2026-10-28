// Network allow-list and compose-structure tests for the Windows deployment kit.
//  - squid.conf.template rendering (egress-policy.ts mirrors Install-CrestmontRunner.ps1 / SquidConf.ps1) and a
//    rule-by-rule evaluation of who may reach what. This models Squid's http_access semantics for the ACL types the
//    file uses; it is not Squid. `squid -k parse` runs in CI (runner-images job) and, where a squid binary is given
//    in SQUID_BIN, here too.
//  - When pwsh is available (CI, or PWSH=<path>), the PowerShell renderer's output must equal the TypeScript one.
//  - docker-compose.yml structure via `docker compose config` (canonical JSON) when the docker CLI with the compose
//    plugin is installed (no daemon needed), plus text checks that always run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  renderDefaultSquidConf, renderSquidConf, parseSquidPolicy, evaluateSquid, NETWORKS, PAID_AI_DOMAINS, isPaidAiHost,
  EgressPolicyError, TEMPLATE_PATH, OLLAMA_PULL_DOMAINS,
} from "../windows/egress-policy.ts";
import type { SquidInputs } from "../windows/egress-policy.ts";
import { assertLocalEndpoint } from "../src/providers/local.ts";
import { PaidProviderRefusedError } from "../src/providers/types.ts";
import { RUNNER_DIR, tmp } from "./helpers.ts";

const WIN = path.join(RUNNER_DIR, "windows");
const PLATFORM = "staging.crestmont.example";

function policy(extra: string[] = [], ollamaInDocker = false) {
  return parseSquidPolicy(renderDefaultSquidConf({ platformHost: PLATFORM, extraDomains: extra, ollamaInDocker }));
}
const req = (net: keyof typeof NETWORKS, host: string, port = 443, method = port === 443 ? "CONNECT" : "GET") => ({ clientIp: NETWORKS[net], method, host, port });

test("[AIB-RUNNER] squid allow-list: runner reaches the platform and the local model, installs reach only registry.npmjs.org", () => {
  const p = policy();
  const allowed = (r: ReturnType<typeof req>) => evaluateSquid(p, r).allowed;
  assert.ok(allowed(req("runner", PLATFORM)), "runner -> platform (CONNECT 443)");
  assert.ok(allowed(req("runner", "host.docker.internal", 11434, "POST")), "runner -> native Ollama (plain HTTP 11434)");
  assert.ok(allowed(req("runner", "host.docker.internal", 11434, "GET")));
  assert.ok(allowed(req("install", "registry.npmjs.org")), "install container -> npm registry");
  // Node's fetch behind HTTP_PROXY (undici EnvHttpProxyAgent) tunnels http:// through CONNECT: the model port must
  // accept CONNECT from the runner, for the model host only (found with a real Squid; see LOCAL-VALIDATION.md).
  assert.ok(allowed(req("runner", "host.docker.internal", 11434, "CONNECT")), "runner -> model via CONNECT (Node fetch)");
  assert.ok(allowed(req("runner", "ollama", 11434, "CONNECT")), "runner -> ollama container via CONNECT");
  // Everything else is denied.
  assert.equal(allowed(req("runner", "host.docker.internal", 22, "CONNECT")), false, "no CONNECT to other ports of the host");
  assert.equal(allowed(req("runner", "evil.example", 11434, "CONNECT")), false, "port 11434 only on the model hosts");
  assert.equal(allowed(req("install", "host.docker.internal", 11434, "CONNECT")), false, "install containers never tunnel to the model");
  assert.equal(allowed(req("runner", "registry.npmjs.org")), false, "the runner itself does not install packages");
  assert.equal(allowed(req("install", PLATFORM)), false, "install containers never reach the platform");
  assert.equal(allowed(req("install", "host.docker.internal", 11434, "POST")), false, "install containers never reach the model");
  assert.equal(allowed(req("install", "github.com")), false, "no git/tarball sources for installs");
  assert.equal(allowed(req("install", "registry.yarnpkg.com")), false);
  assert.equal(allowed(req("runner", "github.com")), false, "repos need -ExtraEgressDomains");
  assert.equal(allowed(req("runner", "example.org", 80, "GET")), false, "no plain HTTP elsewhere");
  assert.equal(allowed(req("outside", PLATFORM)), false, "only the compose networks may use the proxy");
  assert.equal(allowed(req("runner", "registry.ollama.ai")), false, "model pulls only with the ollama-in-docker profile");
  assert.equal(evaluateSquid(p, req("runner", "evil.example")).rule, "http_access deny all");
});

test("[AIB-RUNNER] squid allow-list: anthropic.com, api.openai.com and other hosted AI APIs are denied first, from every network", () => {
  const hosts = [
    "anthropic.com", "api.anthropic.com", "claude.ai", "api.claude.com", "api.openai.com", "openai.com", "x.openai.azure.com",
    "api.mistral.ai", "generativelanguage.googleapis.com", "openrouter.ai", "api.groq.com", "api.together.xyz", "api.together.ai",
    "api.fireworks.ai", "api.cohere.ai", "api.cohere.com", "api.deepseek.com", "api.x.ai", "api.perplexity.ai",
    "api.replicate.com", "api-inference.huggingface.co", "router.huggingface.co", "bedrock-runtime.us-east-1.amazonaws.com",
  ];
  // Even with permissive-looking extras configured, the paid denial wins because it is evaluated first.
  const p = policy(["github.com", "api.github.com", "api.cloudflare.com"], true);
  for (const host of hosts) {
    assert.ok(isPaidAiHost(host), `${host} is classified as a hosted AI API`);
    for (const net of ["runner", "install", "outside"] as const) {
      const r = evaluateSquid(p, req(net, host));
      assert.equal(r.allowed, false, `${net} -> ${host}`);
      assert.match(r.rule, /^http_access deny paid_ai/, `${host} denied by the paid_ai rule (logged as TCP_DENIED), not just by deny all`);
    }
  }
  const order = p.rules.map((r) => `${r.action} ${r.terms.map((t) => (t.negate ? "!" : "") + t.name).join(" ")}`);
  assert.deepEqual(order.slice(0, 2), ["deny paid_ai", "deny paid_ai_re"]);
  assert.equal(order.at(-1), "deny all");
  // Extras and the ollama-in-docker pull hosts work where intended.
  assert.ok(evaluateSquid(p, req("runner", "api.github.com")).allowed);
  assert.ok(evaluateSquid(p, req("runner", "registry.ollama.ai")).allowed);
  assert.equal(evaluateSquid(p, req("install", "api.github.com")).allowed, false);
});

test("[AIB-RUNNER] squid rendering validates every substituted host: no rule injection, no paid AI allow-listing", () => {
  const t = readFileSync(TEMPLATE_PATH, "utf8");
  const ok = renderSquidConf(t, { platformHost: "Staging.Crestmont.Example" });
  assert.match(ok, /^acl control_plane dstdomain staging\.crestmont\.example$/m);
  assert.match(ok, /^acl runner_extra dstdomain none\.invalid$/m);
  assert.match(ok, /^acl ollama_pull dstdomain none\.invalid$/m);
  assert.doesNotMatch(ok.replace(/^#.*$/gm, ""), /__[A-Z_]+__/, "no placeholder left");
  assert.doesNotMatch(ok, /\r/, "LF line endings");
  assert.match(renderSquidConf(t, { platformHost: PLATFORM, ollamaInDocker: true }), new RegExp(`^acl ollama_pull dstdomain ${OLLAMA_PULL_DOMAINS.join(" ").replaceAll(".", "\\.")}$`, "m"));
  const bad: [Partial<Parameters<typeof renderSquidConf>[1]>, RegExp][] = [
    [{ platformHost: "x.example\nhttp_access allow all" }, /not a valid host name/],
    [{ platformHost: "x.example all" }, /not a valid host name/],
    [{ platformHost: ".crestmont.example" }, /exact host/],
    [{ platformHost: "localhost" }, /not a valid host name/],
    [{ extraDomains: ["github.com", "evil.example http_access allow all"] }, /not a valid host name/],
    [{ extraDomains: ["api.openai.com"] }, /hosted AI API/],
    [{ extraDomains: [".anthropic.com"] }, /hosted AI API/],
    [{ extraDomains: [".azure.com"] }, /hosted AI API/, ],
    [{ extraDomains: [".googleapis.com"] }, /hosted AI API/],
    [{ extraDomains: ["bedrock-runtime.eu-west-1.amazonaws.com"] }, /hosted AI API/],
    [{ extraDomains: ["*.github.com"] }, /not a valid host name/],
  ];
  for (const [input, re] of bad) {
    assert.throws(() => renderSquidConf(t, { platformHost: PLATFORM, ...input }), (e: unknown) => e instanceof EgressPolicyError && re.test(e.message), JSON.stringify(input));
  }
  assert.throws(() => renderSquidConf("http_port 3128\n", { platformHost: PLATFORM }), /missing the __PLATFORM_HOST__/);
});

test("[AIB-RUNNER] paid AI host lists agree: proxy template, local provider endpoint refusal, evidence collector", () => {
  const squid = readFileSync(TEMPLATE_PATH, "utf8");
  const listed = squid.split("\n").filter((l) => l.startsWith("acl paid_ai dstdomain")).flatMap((l) => l.split(/\s+/).slice(3));
  assert.deepEqual([...listed].sort(), [...PAID_AI_DOMAINS].sort(), "squid.conf.template paid_ai == PAID_AI_DOMAINS");
  for (const d of [...PAID_AI_DOMAINS, ".ollama.com", "bedrock-runtime.us-west-2.amazonaws.com"]) {
    const host = d.startsWith(".") ? `api${d}` : d;
    assert.throws(() => assertLocalEndpoint(`https://${host}/v1`, "qwen3-coder:30b"), PaidProviderRefusedError, `local provider refuses ${host}`);
  }
  assert.doesNotThrow(() => assertLocalEndpoint("http://host.docker.internal:11434/v1", "qwen3-coder:30b"));
  const ps = readFileSync(path.join(WIN, "SquidConf.ps1"), "utf8");
  for (const d of PAID_AI_DOMAINS) assert.ok(ps.includes(`"${d}"`), `SquidConf.ps1 lists ${d}`);
  const evidence = readFileSync(path.join(WIN, "Collect-Evidence.ps1"), "utf8");
  const m = /\$paidPattern = '([^']+)'/.exec(evidence);
  assert.ok(m, "Collect-Evidence.ps1 defines $paidPattern");
  const re = new RegExp(m[1], "i");
  for (const d of PAID_AI_DOMAINS) assert.ok(re.test(` CONNECT ${d.replace(/^\./, "api.")}:443 `), `evidence counts ${d}`);
  assert.ok(re.test(" CONNECT bedrock-runtime.us-east-1.amazonaws.com:443 "));
  assert.equal(re.test(" CONNECT registry.npmjs.org:443 "), false);
  assert.equal(re.test(" CONNECT inbox.aircraft.example:443 "), false, "no substring false positives");
});

/** pwsh on PATH, or PWSH=<path>; null when PowerShell is not installed. */
function findPwsh(): string | null {
  for (const c of [process.env.PWSH, "pwsh"].filter(Boolean) as string[]) {
    const r = spawnSync(c, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 60_000 });
    if (r.status === 0) return c;
  }
  return null;
}
const PWSH = findPwsh();

test("[AIB-RUNNER] SquidConf.ps1 (used by the installer) renders byte-for-byte what egress-policy.ts renders, and refuses the same inputs", { skip: PWSH ? false : "pwsh not installed (runs in CI's windows-scripts job and wherever PWSH is set)" }, () => {
  const dir = tmp("aib-squid-ps-");
  const script = path.join(dir, "render.ps1");
  writeFileSync(script, [
    "param([string]$Template, [string]$PlatformHost, [string]$Extra, [switch]$OllamaInDocker, [string]$Out)",
    "$ErrorActionPreference = 'Stop'",
    `. '${path.join(WIN, "SquidConf.ps1").replaceAll("'", "''")}'`,
    "$t = [IO.File]::ReadAllText($Template)",
    "$extras = @(); if ($Extra) { $extras = $Extra -split ',' }",
    "try { $s = ConvertTo-SquidConf -Template $t -PlatformHost $PlatformHost -ExtraDomains $extras -OllamaInDocker:$OllamaInDocker; [IO.File]::WriteAllText($Out, $s); exit 0 }",
    "catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }",
  ].join("\n"));
  const cases: { platformHost: string; extra: string[]; ollama: boolean; error?: RegExp }[] = [
    { platformHost: PLATFORM, extra: [], ollama: false },
    { platformHost: "Staging.Crestmont.Example", extra: ["github.com", "api.github.com", "api.cloudflare.com"], ollama: true },
    { platformHost: PLATFORM, extra: ["api.openai.com"], ollama: false, error: /hosted AI API/ },
    { platformHost: PLATFORM, extra: [".azure.com"], ollama: false, error: /hosted AI API/ },
    { platformHost: "x.example all", extra: [], ollama: false, error: /not a valid host name/ },
    { platformHost: ".crestmont.example", extra: [], ollama: false, error: /exact host/ },
  ];
  for (const c of cases) {
    const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}.conf`);
    // (No empty arguments: Windows PowerShell 5.1 drops "" on the -File command line.)
    const args = ["-NoProfile", "-NonInteractive", "-File", script, "-Template", TEMPLATE_PATH, "-PlatformHost", c.platformHost, ...(c.extra.length ? ["-Extra", c.extra.join(",")] : []), "-Out", out, ...(c.ollama ? ["-OllamaInDocker"] : [])];
    const r = spawnSync(PWSH!, args, { encoding: "utf8", timeout: 120_000 });
    if (c.error) {
      assert.equal(r.status, 3, `${JSON.stringify(c)} must be refused: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, c.error);
      assert.throws(() => renderDefaultSquidConf({ platformHost: c.platformHost, extraDomains: c.extra, ollamaInDocker: c.ollama }), c.error);
      continue;
    }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const fromPs = readFileSync(out, "utf8");
    assert.equal(fromPs, renderDefaultSquidConf({ platformHost: c.platformHost, extraDomains: c.extra, ollamaInDocker: c.ollama }), JSON.stringify(c));
  }
});

const SQUID = process.env.SQUID_BIN || null;
test("[AIB-RUNNER] squid -k parse accepts the rendered configuration (SQUID_BIN set)", { skip: SQUID ? false : "set SQUID_BIN=<squid binary> to run; CI parses it inside the built proxy image" }, () => {
  const dir = tmp("aib-squid-");
  const inputs: [string, SquidInputs][] = [["default", { platformHost: PLATFORM }], ["extras", { platformHost: PLATFORM, extraDomains: ["github.com", "api.github.com"], ollamaInDocker: true }]];
  for (const [name, input] of inputs) {
    const conf = path.join(dir, `${name}.conf`);
    // pid file / logs under the temp dir so parsing needs no root paths.
    writeFileSync(conf, renderDefaultSquidConf(input).replace("pid_filename /run/squid/squid.pid", `pid_filename ${dir}/squid.pid`));
    const r = spawnSync(SQUID!, ["-k", "parse", "-f", conf], { encoding: "utf8", timeout: 60_000 });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.doesNotMatch(out, /FATAL|ERROR|Bungled/i, out);
    // Known, accepted: `via off` (no proxy name in requests) and IPv6 being compiled out of a local test build.
    const warnings = out.split("\n").filter((l) => /WARNING|has not been enabled/i.test(l) && !/HTTP requires the use of Via|IPv6 has not been enabled/.test(l));
    assert.deepEqual(warnings, [], "no unexpected squid warnings");
  }
});

// ── compose structure ──

interface ComposeService {
  image?: string; restart?: string; ports?: unknown[]; networks?: Record<string, unknown>; cpus?: number | string;
  mem_limit?: string | number; pids_limit?: number; cap_drop?: string[]; cap_add?: string[]; security_opt?: string[];
  read_only?: boolean; volumes?: { type: string; source?: string; target: string; read_only?: boolean }[];
  healthcheck?: unknown; logging?: { driver: string; options?: Record<string, string> }; privileged?: boolean;
  network_mode?: string; pid?: string; profiles?: string[]; environment?: Record<string, string | null>;
}
interface ComposeConfig { services: Record<string, ComposeService>; networks: Record<string, { internal?: boolean; name?: string }> }

function composeConfig(): ComposeConfig | { error: string } | null {
  const probe = spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 30_000 });
  if (probe.status !== 0) return null;
  const dir = tmp("aib-compose-");
  mkdirSync(path.join(dir, "compose", "proxy"), { recursive: true });
  copyFileSync(path.join(WIN, "docker-compose.yml"), path.join(dir, "compose", "docker-compose.yml"));
  copyFileSync(path.join(WIN, "proxy", "Dockerfile"), path.join(dir, "compose", "proxy", "Dockerfile"));
  writeFileSync(path.join(dir, "compose", "runner.env"), "LOCAL_MODEL=test:1\n");
  const r = spawnSync("docker", ["compose", "--profile", "ollama-in-docker", "config", "--format", "json"], { cwd: path.join(dir, "compose"), encoding: "utf8", timeout: 60_000, env: { ...process.env, DOCKER_SOCKET_GID: "998" } });
  if (r.status !== 0) return { error: `docker compose config failed: ${r.stderr}` };
  return JSON.parse(r.stdout) as ComposeConfig;
}
const COMPOSE = composeConfig();

test("[AIB-RUNNER] docker-compose.yml (docker compose config): internal networks, no published ports, restart policy, limits, socket only in the runner", { skip: COMPOSE ? false : "docker CLI with the compose plugin not installed (CI has it)" }, () => {
  if (COMPOSE && "error" in COMPOSE) assert.fail(COMPOSE.error);
  const c = COMPOSE as ComposeConfig;
  assert.equal(c.networks.runner_net.internal, true);
  assert.equal(c.networks.install_net.internal, true);
  assert.notEqual(c.networks.egress_net.internal, true, "only the proxy's egress network leaves the host");
  assert.deepEqual(Object.keys(c.services).sort(), ["egress-proxy", "ollama", "runner"]);
  for (const [name, s] of Object.entries(c.services)) {
    assert.ok(!s.ports || s.ports.length === 0, `${name}: no published ports`);
    assert.equal(s.restart, "unless-stopped", `${name}: restart policy`);
    assert.notEqual(s.privileged, true, `${name}: not privileged`);
    assert.ok(!s.network_mode, `${name}: no host/none network_mode overrides`);
    assert.notEqual(s.pid, "host", `${name}: no host pid namespace`);
    assert.ok((s.security_opt ?? []).some((o) => /^no-new-privileges(:true)?$/.test(o)), `${name}: no-new-privileges`);
    assert.ok(Number(s.pids_limit) > 0, `${name}: pids limit`);
    assert.equal(s.logging?.driver ?? "json-file", "json-file");
    const sock = (s.volumes ?? []).filter((v) => /docker\.sock/.test(`${v.source} ${v.target}`));
    if (name === "runner") assert.equal(sock.length, 1, "the runner holds the Docker socket to create sandboxes");
    else assert.equal(sock.length, 0, `${name}: no Docker socket`);
    if (s.image) assert.doesNotMatch(s.image, /:latest$|^[^:]+$/, `${name}: pinned image tag (${s.image})`);
  }
  const runner = c.services.runner;
  assert.deepEqual(Object.keys(runner.networks ?? {}), ["runner_net"], "runner only on the internal network");
  assert.equal(runner.read_only, true);
  assert.deepEqual(runner.cap_drop, ["ALL"]);
  assert.ok(!runner.cap_add?.length, "runner gets no capabilities back");
  assert.ok(Number(runner.cpus) > 0 && Number(runner.mem_limit) > 0, "runner CPU and memory limits");
  assert.ok(runner.healthcheck, "runner healthcheck");
  assert.equal(runner.environment?.RUNNER_HEALTH_HOST, "127.0.0.1");
  assert.equal(runner.environment?.NODE_USE_ENV_PROXY, "1");
  for (const v of runner.volumes ?? []) {
    if (v.target === "/run/secrets" || v.target === "/skills") assert.equal(v.read_only, true, `${v.target} read-only`);
  }
  const proxy = c.services["egress-proxy"];
  assert.deepEqual(Object.keys(proxy.networks ?? {}).sort(), ["egress_net", "install_net", "runner_net"]);
  assert.deepEqual(proxy.cap_drop, ["ALL"]);
  assert.deepEqual(proxy.cap_add ?? [], [], "squid runs unprivileged from the start: no capabilities added back");
  assert.ok(Number(proxy.cpus) > 0 && Number(proxy.mem_limit) > 0, "proxy CPU and memory limits");
  assert.ok((proxy.volumes ?? []).every((v) => v.read_only), "proxy config mounted read-only");
  const ollama = c.services.ollama;
  assert.deepEqual(ollama.profiles, ["ollama-in-docker"], "Ollama in Docker is opt-in");
  assert.deepEqual(Object.keys(ollama.networks ?? {}), ["runner_net"], "Ollama container has no direct egress");
  assert.match(String(ollama.image), /^ollama\/ollama:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
});

test("[AIB-RUNNER] docker-compose.yml text checks (no docker needed): no ports, sandboxes not defined in compose, pinned images", () => {
  const compose = readFileSync(path.join(WIN, "docker-compose.yml"), "utf8");
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.doesNotMatch(compose, /privileged:\s*true|network_mode:\s*host|pid:\s*host/);
  const sockLines = compose.split("\n").filter((l) => /docker\.sock/.test(l) && !/^\s*#/.test(l));
  assert.equal(sockLines.length, 1, "exactly one Docker socket mount (the runner's)");
  const runnerBlock = compose.slice(compose.indexOf("\n  runner:"), compose.indexOf("\n  ollama:"));
  assert.ok(runnerBlock.includes(sockLines[0]), "the socket mount is in the runner service");
  assert.doesNotMatch(compose, /crestmont-build-sandbox/, "per-build sandboxes are created by the runner with its own flags, never by compose");
  assert.match(compose, /\$\{OLLAMA_IMAGE:-ollama\/ollama:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}\}/);
  assert.equal((compose.match(/restart: unless-stopped/g) ?? []).length, 3);
});
