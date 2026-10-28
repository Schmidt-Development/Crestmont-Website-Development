// End-to-end check of the egress allow-list on the real compose networks, against a real Docker daemon:
//   node --no-warnings runner/ci/egress-e2e.ts <runner image> <proxy image>
// It writes a compose project from runner/windows/docker-compose.yml with squid.conf rendered by egress-policy.ts,
// starts ONLY the egress proxy (`docker compose up --no-build egress-proxy`, images tagged as compose expects), runs a
// fake model server on this host (stand-in for Ollama on host.docker.internal:11434), and from throw-away containers
// on the internal networks asks the proxy for CONNECT tunnels / plain requests with Node's http client:
//   paid AI hosts            -> 403 from both networks (TCP_DENIED in the proxy log)
//   runner -> platform host  -> not denied;  runner -> model (CONNECT and plain GET) -> 200 from the fake model
//   install -> registry.npmjs.org -> not denied; install -> platform / model / github -> 403
//   no proxy                 -> no route out of either internal network
// Also the LOCAL-VALIDATION.md tripwire, which must fail when the proxy is stopped. Exit 0 = all as expected.
// "Not denied" means the proxy did not answer 403; whether the upstream then answers depends on the network the
// daemon has (CI: internet; elsewhere maybe none), and is printed.

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, trustedBinary, dockerImageRef } from "../src/exec.ts";
import { renderDefaultSquidConf } from "../windows/egress-policy.ts";

const [runnerArg, proxyArg] = process.argv.slice(2);
if (!runnerArg || !proxyArg) { process.stderr.write("usage: node runner/ci/egress-e2e.ts <runner image> <proxy image>\n"); process.exit(2); }
// Command-line values are validated before they reach the docker CLI: image references only, a docker binary only.
const runnerImage = dockerImageRef(runnerArg), proxyImage = dockerImageRef(proxyArg);
const DOCKER = trustedBinary("docker", process.env.DOCKER_BIN || "docker");
const RUNNER_DIR = path.resolve(import.meta.dirname, "..");
const PLATFORM = process.env.E2E_PLATFORM_HOST || "example.com";
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) };
const docker = (args: string[], cwd?: string, timeoutMs = 120_000) => run(DOCKER, args, { env, cwd, timeoutMs });

const dir = mkdtempSync(path.join(tmpdir(), "cm-egress-"));
const compose = path.join(dir, "compose");
mkdirSync(path.join(compose, "proxy"), { recursive: true });
mkdirSync(path.join(dir, "skills"));
mkdirSync(path.join(dir, "secrets"));
copyFileSync(path.join(RUNNER_DIR, "windows", "docker-compose.yml"), path.join(compose, "docker-compose.yml"));
copyFileSync(path.join(RUNNER_DIR, "windows", "proxy", "Dockerfile"), path.join(compose, "proxy", "Dockerfile"));
writeFileSync(path.join(compose, "proxy", "squid.conf"), renderDefaultSquidConf({ platformHost: PLATFORM }), { mode: 0o644 });
writeFileSync(path.join(compose, "runner.env"), "LOCAL_MODEL=e2e-model:1\n");

const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ check: name, ok, detail }); };

// Raw proxy request from a container: CONNECT host:port, or GET http://host:port/path. Prints the proxy's status.
const PROBE = `const [mode,target]=process.argv.slice(1);const http=require('http');
const o=mode==='CONNECT'?{host:'egress-proxy',port:3128,method:'CONNECT',path:target}:{host:'egress-proxy',port:3128,method:'GET',path:target,headers:{host:new URL(target).host}};
const r=http.request(o);r.setTimeout(20000,()=>{console.log('TIMEOUT');process.exit(0)});
r.on('connect',(res,s)=>{console.log(res.statusCode);s.destroy();process.exit(0)});
r.on('response',(res)=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>{console.log(res.statusCode+' '+b.slice(0,80).replace(/\\s+/g,' '));process.exit(0)})});
r.on('error',(e)=>{console.log('ERR '+e.code);process.exit(0)});r.end();`;
const probe = async (network: string, mode: "CONNECT" | "GET", target: string): Promise<string> => {
  const r = await docker(["run", "--rm", "--network", network, "--entrypoint", "node", runnerImage, "-e", PROBE, mode, target], undefined, 60_000);
  return (r.stdout.trim() || r.stderr.trim()).split("\n").pop() ?? "";
};
const direct = async (network: string, url: string): Promise<string> => {
  const r = await docker(["run", "--rm", "--network", network, "--entrypoint", "node", runnerImage, "-e",
    `fetch(process.argv[1],{signal:AbortSignal.timeout(8000)}).then(r=>console.log('REACHED '+r.status),e=>console.log('NO ROUTE '+(e.cause?.code||e.name)))`, url], undefined, 60_000);
  return r.stdout.trim();
};

const model = createServer((q, s) => { s.writeHead(q.url === "/v1/models" ? 200 : 404, { "content-type": "application/json" }); s.end(JSON.stringify({ data: [{ id: "e2e-model:1" }] })); });
await new Promise<void>((r) => model.listen(11434, "0.0.0.0", r));
try {
  for (const [img, tag] of [[runnerImage, "crestmont-ai-runner:1"], [proxyImage, "crestmont-egress-proxy:1"]]) {
    if (img !== tag) await docker(["tag", img, tag]);
  }
  const up = await docker(["compose", "up", "-d", "--no-build", "egress-proxy"], compose, 180_000);
  check("docker compose up egress-proxy", up.code === 0, up.stderr.slice(-400));
  let running = "";
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    running = (await docker(["compose", "ps", "--format", "{{.State}}", "egress-proxy"], compose)).stdout.trim();
    if (running === "running") break;
  }
  await new Promise((r) => setTimeout(r, 2000));
  check("proxy stays running (no crash loop)", running === "running", running || "(no state)");

  const nets = (await docker(["network", "inspect", "crestmont_runner", "crestmont_install", "--format", "{{.Name}}={{.Internal}}"])).stdout.trim().split("\n");
  check("crestmont_runner and crestmont_install are internal networks", nets.length === 2 && nets.every((n) => n.endsWith("=true")), nets.join(", "));

  const paid = ["api.anthropic.com:443", "anthropic.com:443", "claude.ai:443", "api.openai.com:443", "generativelanguage.googleapis.com:443", "api.mistral.ai:443", "openrouter.ai:443", "api.groq.com:443", "bedrock-runtime.us-east-1.amazonaws.com:443"];
  for (const net of ["crestmont_runner", "crestmont_install"]) {
    for (const t of paid) { const s = await probe(net, "CONNECT", t); check(`${net}: CONNECT ${t} denied (403)`, s === "403", s); }
  }
  const allowed: [string, "CONNECT" | "GET", string, (s: string) => boolean, string][] = [
    ["crestmont_runner", "CONNECT", `${PLATFORM}:443`, (s) => s !== "403" && !s.startsWith("ERR"), "runner -> platform host not denied"],
    ["crestmont_runner", "CONNECT", "host.docker.internal:11434", (s) => s === "200", "runner -> model via CONNECT (Node fetch behind HTTP_PROXY tunnels)"],
    ["crestmont_runner", "GET", "http://host.docker.internal:11434/v1/models", (s) => s.startsWith("200") && s.includes("e2e-model"), "runner -> model plain GET reaches the fake model"],
    ["crestmont_runner", "CONNECT", "registry.npmjs.org:443", (s) => s === "403", "runner itself cannot reach the npm registry"],
    ["crestmont_runner", "CONNECT", "github.com:443", (s) => s === "403", "runner -> github.com denied (no -ExtraEgressDomains)"],
    ["crestmont_runner", "CONNECT", "host.docker.internal:22", (s) => s === "403", "runner -> other host ports denied"],
    ["crestmont_runner", "GET", "http://example.org/", (s) => s.startsWith("403"), "runner -> plain HTTP elsewhere denied"],
    ["crestmont_install", "CONNECT", "registry.npmjs.org:443", (s) => s !== "403" && !s.startsWith("ERR"), "install -> registry.npmjs.org not denied"],
    ["crestmont_install", "CONNECT", `${PLATFORM}:443`, (s) => s === "403", "install -> platform denied"],
    ["crestmont_install", "CONNECT", "host.docker.internal:11434", (s) => s === "403", "install -> model denied"],
    ["crestmont_install", "CONNECT", "github.com:443", (s) => s === "403", "install -> github.com denied (no git/tarball installs)"],
  ];
  for (const [net, mode, target, ok, name] of allowed) { const s = await probe(net, mode, target); check(name, ok(s), s); }
  for (const net of ["crestmont_runner", "crestmont_install"]) {
    const s = await direct(net, "https://api.anthropic.com/v1/models");
    check(`${net}: no direct route out without the proxy`, s.startsWith("NO ROUTE"), s);
  }
  const logs = (await docker(["compose", "logs", "--no-color", "egress-proxy"], compose)).stdout;
  check("proxy access log records the paid-API denials (TCP_DENIED/403 CONNECT api.anthropic.com:443)", /TCP_DENIED\/403 \d+ CONNECT api\.anthropic\.com:443/.test(logs), logs.split("\n").filter((l) => /anthropic/.test(l)).slice(0, 2).join(" | "));

  const TRIPWIRE = "const r=require('http').request({host:'egress-proxy',port:3128,method:'CONNECT',path:'api.anthropic.com:443'});r.on('connect',(res,s)=>{s.destroy();const ok=res.statusCode===403;console.log(ok?'PASS: the proxy denied CONNECT api.anthropic.com:443 (403)':'FAIL: the proxy answered '+res.statusCode);process.exit(ok?0:1)});r.on('error',e=>{console.log('FAIL: proxy not reachable ('+e.code+')');process.exit(1)});r.end()";
  const tw = await docker(["run", "--rm", "--network", "crestmont_runner", "--entrypoint", "node", runnerImage, "-e", TRIPWIRE]);
  check("LOCAL-VALIDATION.md tripwire passes with the proxy up", tw.code === 0, tw.stdout.trim());
  await docker(["compose", "stop", "egress-proxy"], compose);
  const tw2 = await docker(["run", "--rm", "--network", "crestmont_runner", "--entrypoint", "node", runnerImage, "-e", TRIPWIRE]);
  check("the tripwire FAILS when the proxy is down (no false pass)", tw2.code !== 0, tw2.stdout.trim());
} catch (err) {
  check("egress e2e crashed", false, String(err instanceof Error ? err.stack : err));
} finally {
  await docker(["compose", "down", "-v"], compose, 120_000);
  model.close();
}

for (const r of results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.check}${r.detail ? `   [${r.detail.replace(/\s+/g, " ").slice(0, 200)}]` : ""}\n`);
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`${results.length - failed}/${results.length} egress allow-list checks passed (platform host ${PLATFORM})\n`);
process.exit(failed ? 1 : 0);
