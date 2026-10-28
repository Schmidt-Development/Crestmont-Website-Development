// Founder V3: Node 1 packaging for the Claude-only orchestrator (static checks of the shipped files; the real
// installation is validated on Node 1, see docs/ai-builds/ORCHESTRATOR.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const WIN = path.join(import.meta.dirname, "..", "windows");
const read = (f: string) => readFileSync(path.join(WIN, f), "utf8");

test("[AIB-015] docker-compose.claude.yml: three account workers, own network, no Docker socket, no ports, no API key, paid provider off, sandbox on", () => {
  const y = read("docker-compose.claude.yml");
  for (const n of [1, 2, 3]) {
    assert.match(y, new RegExp(`claude-${n}:\\n    <<: \\*claude-worker`));
    assert.match(y, new RegExp(`- \\{ path: ./claude-${n}.env, required: true \\}`));
    assert.match(y, new RegExp(`- \\.\\./claude/claude-${n}:/claude/claude-${n}\\n`));
  }
  assert.doesNotMatch(y, /docker\.sock/, "the agent's commands cannot start containers");
  assert.doesNotMatch(y, /^\s+ports:/m);
  assert.doesNotMatch(y, /ANTHROPIC_API_KEY|OPENAI|CODEX|ollama:/i);
  assert.match(y, /RUNNER_ALLOW_PAID_PROVIDER: "false"/);
  assert.match(y, /RUNNER_SANDBOX: "on"/);
  assert.match(y, /networks: \[claude_net\]/);
  assert.match(y, /claude_net:\n    name: crestmont_claude\n    internal: true\n    ipam: \{ config: \[\{ subnet: 172\.30\.30\.0\/24 \}\] \}/, "the subnet the proxy's claude_net acl expects");
  assert.match(y, /runner:\n    profiles: \["local-runner"\]/, "the local-model runner does not start in this mode");
  assert.match(read("proxy/squid.conf.template"), /acl claude_net src 172\.30\.30\.0\/24/);
});

test("[AIB-015] installer -Provider ClaudeCode: no Ollama, Claude Code image, three worker ids, sign-in instructions, Claude hosts only from the worker network", () => {
  const ps = read("Install-CrestmontRunner.ps1");
  assert.match(ps, /\[ValidateSet\("Local", "ClaudeCode"\)\]\[string\]\$Provider = "Local"/, "the existing local mode stays the default");
  assert.match(ps, /if \(-not \$ClaudeMode -and -not \$OllamaInDocker -and -not \(Test-Path \$ollamaExe\)/, "Ollama is not installed for Claude Code");
  assert.match(ps, /"--build-arg", "INSTALL_CLAUDE_CODE=true"/);
  assert.match(ps, /"claude-code\\package-lock\.json"/);
  assert.match(ps, /-ClaudeCode:\$ClaudeMode/);
  assert.match(ps, /key = "RUNNER_AGENT_PROVIDER"; value = \$\(if \(\$ClaudeMode\) \{ "claude-code" \} else \{ "local" \}\) \}/);
  assert.match(ps, /key = "RUNNER_ALLOW_PAID_PROVIDER"; value = "false"/);
  assert.match(ps, /CLAUDE_CONFIG_DIR=\/claude\/claude-\$i/);
  assert.doesNotMatch(ps, /ANTHROPIC_API_KEY/);
  const dockerfile = readFileSync(path.join(import.meta.dirname, "..", "Dockerfile"), "utf8");
  assert.match(dockerfile, /ARG INSTALL_CLAUDE_CODE=false/, "the default image is unchanged");
  assert.match(dockerfile, /npm ci --prefix \/app\/claude-code/, "installed only from a reviewed lockfile");
  const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "claude-code", "package.json"), "utf8"));
  assert.match(pkg.dependencies["@anthropic-ai/claude-code"], /^\d+\.\d+\.\d+$/, "exact version");
  for (const f of ["Start-CrestmontRunner.ps1", "Get-RunnerHealth.ps1"]) assert.match(read(f), /docker-compose\.claude\.yml/);
});
