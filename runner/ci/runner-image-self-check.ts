// Self-check of the BUILT runner and egress-proxy images (CI job runner-images), against a real Docker daemon:
//   node --no-warnings runner/ci/runner-image-self-check.ts <runner image> <proxy image>
// Runner image: non-root uid 10001; Node >= 22.21 (NODE_USE_ENV_PROXY); docker CLI >= 26 inside; git, tar, tini;
// no paid SDK in the default build; the runner code loads; select-model.ts runs exactly as the installer runs it
// (network none, hardware.json mounted read-only); the paid adapter is refused without RUNNER_ALLOW_PAID_PROVIDER.
// Proxy image: `squid -k parse` accepts squid.conf rendered from the template by egress-policy.ts (the same output
// as the installer's SquidConf.ps1, see test/egress-compose.test.ts).
// Exit 0 = every check passed. Nothing here contacts a model server or the control plane.

import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, trustedBinary, dockerImageRef } from "../src/exec.ts";
import { renderDefaultSquidConf } from "../windows/egress-policy.ts";

const [runnerArg, proxyArg] = process.argv.slice(2);
if (!runnerArg || !proxyArg) { process.stderr.write("usage: node runner/ci/runner-image-self-check.ts <runner image> <proxy image>\n"); process.exit(2); }
const runnerImage = dockerImageRef(runnerArg), proxyImage = dockerImageRef(proxyArg);
const DOCKER = trustedBinary("docker", process.env.DOCKER_BIN || "docker");

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) };
const docker = (args: string[], timeoutMs = 120_000) => run(DOCKER, args, { env, timeoutMs });
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ check: name, ok, detail: detail.slice(0, 800) }); };
const semverAtLeast = (v: string, min: [number, number]) => { const [a, b] = v.trim().replace(/^v/, "").split(".").map(Number); return a > min[0] || (a === min[0] && b >= min[1]); };

const dir = mkdtempSync(path.join(tmpdir(), "cm-imgcheck-"));
chmodSync(dir, 0o755);

try {
  const base = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
  const id = await docker([...base, "--entrypoint", "id", runnerImage, "-u"]);
  check("runner image runs as uid 10001", id.code === 0 && id.stdout.trim() === "10001", id.stdout + id.stderr);

  const nodeV = await docker([...base, "--entrypoint", "node", runnerImage, "-p", "process.versions.node"]);
  check("Node >= 22.21 (fetch honours HTTP(S)_PROXY with NODE_USE_ENV_PROXY=1)", nodeV.code === 0 && semverAtLeast(nodeV.stdout, [22, 21]), nodeV.stdout + nodeV.stderr);

  const cli = await docker([...base, "--entrypoint", "docker", runnerImage, "version", "--format", "{{.Client.Version}}"]);
  check("docker CLI >= 26 inside the runner image (volume-subpath mounts)", semverAtLeast(cli.stdout.split("\n")[0] ?? "0.0", [26, 0]), cli.stdout + cli.stderr);

  const tools = await docker([...base, "--entrypoint", "sh", runnerImage, "-c", "git --version && tar --version | head -1 && test -x /usr/bin/tini && echo tini-ok"]);
  check("git, tar and tini present", tools.code === 0 && tools.stdout.includes("tini-ok"), tools.stdout + tools.stderr);

  const sdk = await docker([...base, "--entrypoint", "sh", runnerImage, "-c", "if [ -e /app/node_modules/@anthropic-ai ]; then echo SDK-PRESENT; exit 1; fi; ls /app/node_modules 2>/dev/null | wc -l"]);
  check("default build contains no paid SDK and no npm packages", sdk.code === 0 && sdk.stdout.trim() === "0", sdk.stdout + sdk.stderr);

  const load = await docker([...base, "--entrypoint", "node", runnerImage, "--no-warnings", "-e", "Promise.all(['/app/src/main.ts','/app/src/job.ts','/app/src/providers/local.ts'].map(f=>import(f))).then(()=>console.log('runner modules load'),e=>{console.error(e);process.exit(1)})"]);
  check("runner modules load inside the image", load.code === 0 && load.stdout.includes("runner modules load"), load.stdout + load.stderr);

  writeFileSync(path.join(dir, "hardware.json"), JSON.stringify({
    schema: "crestmont.hardware/1", cpu: { name: "CI", cores: 16, logicalProcessors: 32 }, memory: { totalGB: 128 },
    gpus: [{ name: "Test GPU", vendor: "nvidia", vramGB: 24, vramReliable: true, driverVersion: "566.36", source: "nvidia-smi" }],
    disks: [{ drive: "C:", freeGB: 900 }], virtualization: { wslInstalled: true, wslVersion2: true }, docker: { installed: true },
  }));
  chmodSync(path.join(dir, "hardware.json"), 0o644);
  const sel = await docker(["run", "--rm", "--network", "none", "-v", `${dir}:/in:ro`, "--entrypoint", "node", runnerImage, "--no-warnings", "windows/select-model.ts", "/in/hardware.json"]);
  let model = "";
  try { model = JSON.parse(sel.stdout).model; } catch { model = ""; }
  check("select-model.ts runs in the image the way the installer runs it", sel.code === 0 && model === "qwen3-coder:30b", sel.stdout.slice(0, 300) + sel.stderr);

  const paid = await docker([...base, "--tmpfs", "/tmp", "-e", "CONTROL_PLANE_URL=https://platform.example", "-e", `BUILD_RUNNER_SECRET=${"x".repeat(40)}`,
    // A dummy key so configuration loading gets as far as the paid-provider gate; nothing is ever sent with it.
    "-e", "ANTHROPIC_API_KEY=not-a-real-key-ci-self-check", "-e", "RUNNER_AGENT_PROVIDER=claude-agent-sdk", "-e", "RUNNER_WORKSPACES=/tmp/ws", "-e", "SKILLS_SOURCE_DIR=/tmp/skills", runnerImage]);
  check("paid adapter refused without RUNNER_ALLOW_PAID_PROVIDER=true (no fallback, exits non-zero)", paid.code !== 0 && /RUNNER_ALLOW_PAID_PROVIDER/.test(paid.stdout + paid.stderr), (paid.stdout + paid.stderr).slice(-400));

  for (const [name, input] of [
    ["default", { platformHost: "staging.crestmont.example" }],
    ["extras + ollama-in-docker", { platformHost: "staging.crestmont.example", extraDomains: ["github.com", "api.github.com", "api.cloudflare.com"], ollamaInDocker: true }],
  ] as [string, Parameters<typeof renderDefaultSquidConf>[0]][]) {
    const conf = path.join(dir, `squid-${name.replace(/\W+/g, "-")}.conf`);
    writeFileSync(conf, renderDefaultSquidConf(input));
    chmodSync(conf, 0o644);
    const parse = await docker(["run", "--rm", "--network", "none", "-v", `${conf}:/etc/squid/squid.conf:ro`, "--entrypoint", "squid", proxyImage, "-k", "parse", "-f", "/etc/squid/squid.conf"]);
    const out = parse.stdout + parse.stderr;
    check(`proxy image: squid -k parse accepts the rendered allow-list (${name})`, parse.code === 0 && !/FATAL|Bungled|ERROR/i.test(out), out.slice(-600));
  }
  const ver = await docker(["run", "--rm", "--network", "none", "--entrypoint", "squid", proxyImage, "-v"]);
  check("proxy image: squid version", ver.code === 0, ver.stdout.split("\n")[0] ?? "");
} catch (err) {
  check("self-check crashed", false, String(err instanceof Error ? err.stack : err));
}

for (const r of results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.check}${r.detail && (!r.ok || /squid version/.test(r.check)) ? `\n      ${r.detail.replace(/\n/g, "\n      ")}` : ""}\n`);
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`${results.length - failed}/${results.length} runner/proxy image self-checks passed\n`);
process.exit(failed ? 1 : 0);
