// MOCK/unit tests for isolation, the agent environment, permissions and configuration. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertIsolation, IsolationError, buildAgentEnv, buildCheckEnv, createWorkspace, claudeSettings, FORBIDDEN_ENV, findLocalWorkspace } from "../src/workspace.ts";
import { loadConfig } from "../src/config.ts";
import { redact, createLogger } from "../src/log.ts";
import { REPO_ROOT, tmp, makeConfig, POLLUTED_ENV } from "./helpers.ts";

const PATTERNS = [/Crestmont-Website-Development/i];
const PATH = process.env.PATH ?? "/usr/bin:/bin";

test("[AIB-RUNNER] refuses to start inside a Crestmont platform checkout (cwd or workspace root)", async () => {
  // This test runs from a real Crestmont checkout, so the refusal is exercised against the real repository.
  await assert.rejects(assertIsolation({ cwd: REPO_ROOT, workspacesRoot: tmp(), platformRepoPatterns: PATTERNS, pathEnv: PATH }), IsolationError);
  await assert.rejects(assertIsolation({ cwd: tmp(), workspacesRoot: path.join(REPO_ROOT, "runner", "not-yet-created", "ws"), platformRepoPatterns: PATTERNS, pathEnv: PATH }),
    (e: unknown) => e instanceof IsolationError && /workspace root/.test(e.message));
});

test("[AIB-RUNNER] refuses a workspace root inside any git repository; accepts a plain directory", async () => {
  const outer = tmp();
  execFileSync("git", ["init", "-q", outer]);
  execFileSync("git", ["-C", outer, "remote", "add", "origin", "https://github.com/example/unrelated.git"]);
  await assert.rejects(assertIsolation({ cwd: tmp(), workspacesRoot: path.join(outer, "ws"), platformRepoPatterns: PATTERNS, pathEnv: PATH }), /inside a git repository/);
  // A non-platform repository as the runner cwd is fine; a platform remote is not.
  await assertIsolation({ cwd: outer, workspacesRoot: tmp(), platformRepoPatterns: PATTERNS, pathEnv: PATH });
  const platformLike = tmp();
  execFileSync("git", ["init", "-q", platformLike]);
  execFileSync("git", ["-C", platformLike, "remote", "add", "origin", "https://github.com/someone/Crestmont-Website-Development.git"]);
  await assert.rejects(assertIsolation({ cwd: platformLike, workspacesRoot: tmp(), platformRepoPatterns: PATTERNS, pathEnv: PATH }), /Crestmont platform checkout/);
  await assertIsolation({ cwd: tmp(), workspacesRoot: tmp(), platformRepoPatterns: PATTERNS, pathEnv: PATH });
});

test("[AIB-RUNNER] one private workspace per attempt; workspaceRef lookups refuse path tricks", () => {
  const root = tmp();
  const a = createWorkspace(root, { id: "bld_1", attempt: 1 });
  const b = createWorkspace(root, { id: "bld_1", attempt: 1 });
  assert.notEqual(a.dir, b.dir);
  for (const d of [a.home, a.repo, a.tmp, a.checkpoints]) assert.ok(existsSync(d) && d.startsWith(a.dir));
  assert.equal(findLocalWorkspace(root, a.ref)?.dir, a.dir);
  assert.equal(findLocalWorkspace(root, "../etc"), null);
  assert.equal(findLocalWorkspace(root, "/etc"), null);
  assert.equal(findLocalWorkspace(root, "does-not-exist"), null);
});

test("[AIB-RUNNER] agent env contains only allowlisted variables and never runner, platform, repo, preview or payment secrets", () => {
  const ws = createWorkspace(tmp(), { id: "bld_env", attempt: 1 });
  const cfg = makeConfig({ controlPlaneUrl: "https://cp.test", skillsSourceDir: tmp(), agentPassthrough: Object.keys(POLLUTED_ENV) });
  const env = buildAgentEnv(cfg, ws, POLLUTED_ENV);
  for (const k of Object.keys(env)) assert.ok(!FORBIDDEN_ENV.test(k), k);
  for (const k of ["BUILD_RUNNER_SECRET", "STRIPE_SECRET_KEY", "CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN", "PROJECT_REPO_TOKEN", "DATABASE_URL"]) assert.ok(!(k in env), k);
  assert.equal(env.HOME, ws.home);
  assert.equal(env.TMPDIR, ws.tmp);
  assert.equal(env.TZ, "UTC", "harmless passthrough kept");
  const check = buildCheckEnv(env);
  assert.ok(!("ANTHROPIC_API_KEY" in check), "checks run without the model credential");
});

test("[AIB-RUNNER] .claude/settings.json denies network tools, .git edits and reads outside the workspace", () => {
  const s = claudeSettings({ repo: "/w/repo", secretsDir: "/run/secrets", allowedDomains: ["registry.npmjs.org"], referenceDomains: ["reference.example"], fetchReferences: false, sandbox: "on" }) as {
    permissions: { defaultMode: string; allow: string[]; deny: string[]; blockReadsOutsideWorkingDirectories: boolean; disableBypassPermissionsMode: string };
    sandbox: { enabled: boolean; failIfUnavailable: boolean; allowUnsandboxedCommands: boolean; network: { allowedDomains: string[] }; filesystem: { denyRead: string[] } };
  };
  assert.equal(s.permissions.defaultMode, "dontAsk");
  assert.equal(s.permissions.disableBypassPermissionsMode, "disable");
  assert.equal(s.permissions.blockReadsOutsideWorkingDirectories, true);
  for (const r of ["Bash(curl *)", "Bash(wget *)", "Bash(ssh *)", "Bash(git push *)", "Bash(git remote *)", "Bash(git config *)", "Bash(npx wrangler deploy *)", "Bash(printenv)", "WebFetch", "WebSearch", "Edit(.git/**)", "Edit(.claude/**)", "Read(//proc/**)", "Read(//run/secrets/**)"]) {
    assert.ok(s.permissions.deny.includes(r), r);
  }
  assert.ok(!s.permissions.allow.some((a) => a.startsWith("WebFetch")), "reference fetching off by default");
  assert.deepEqual(s.sandbox.network.allowedDomains, ["registry.npmjs.org"]);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.equal(s.sandbox.failIfUnavailable, true);
  assert.deepEqual(s.sandbox.filesystem.denyRead, ["/run/secrets"]);
  const withRefs = claudeSettings({ repo: "/w/repo", secretsDir: "/run/secrets", allowedDomains: [], referenceDomains: ["reference.example"], fetchReferences: true, sandbox: "off" }) as { permissions: { allow: string[]; deny: string[] }; sandbox?: unknown };
  assert.ok(withRefs.permissions.allow.includes("WebFetch(domain:reference.example)"));
  assert.ok(!withRefs.permissions.deny.includes("WebFetch"));
  assert.equal(withRefs.sandbox, undefined);
  // V3: the worker's own Claude Code config dir (its account sign-in) is off limits to the agent's tools and commands.
  const cc = claudeSettings({ repo: "/w/repo", secretsDir: "/run/secrets", allowedDomains: [], referenceDomains: [], fetchReferences: false, sandbox: "on", privateDirs: ["/claude/claude-1"] }) as { permissions: { deny: string[] }; sandbox: { filesystem: { denyRead: string[] } } };
  for (const r of ["Read(//claude/claude-1/**)", "Edit(//claude/claude-1/**)"]) assert.ok(cc.permissions.deny.includes(r), r);
  assert.deepEqual(cc.sandbox.filesystem.denyRead, ["/run/secrets", "/claude/claude-1"]);
});

test("[AIB-RUNNER] config reads secrets from *_FILE, requires the essentials and redacts secret values from logs", () => {
  const dir = tmp();
  writeFileSync(path.join(dir, "secret"), "file-based-runner-secret-123456\n");
  writeFileSync(path.join(dir, "key"), "sk-ant-api03-filebasedkey-abcdefghijkl\n");
  const cfg = loadConfig({
    CONTROL_PLANE_URL: "https://crestmont.example", BUILD_RUNNER_SECRET_FILE: path.join(dir, "secret"), ANTHROPIC_API_KEY_FILE: path.join(dir, "key"),
    RUNNER_WORKSPACES: path.join(dir, "ws"), SKILLS_SOURCE_DIR: path.join(dir, "skills"), PATH: "/usr/bin",
    RUNNER_AGENT_PROVIDER: "claude-agent-sdk", RUNNER_ALLOW_PAID_PROVIDER: "true",
  });
  assert.equal(cfg.secret, "file-based-runner-secret-123456");
  assert.equal(cfg.anthropicApiKey, "sk-ant-api03-filebasedkey-abcdefghijkl");
  assert.equal(cfg.repo, null);
  assert.equal(cfg.preview, null);
  assert.equal(cfg.sandbox, "on", "sandbox on by default");
  assert.throws(() => loadConfig({ PATH: "/usr/bin" }), /CONTROL_PLANE_URL, BUILD_RUNNER_SECRET, LOCAL_MODEL, RUNNER_WORKSPACES, SKILLS_SOURCE_DIR/);
  assert.throws(() => loadConfig({ PATH: "/usr/bin", RUNNER_AGENT_PROVIDER: "claude-agent-sdk" }), /CONTROL_PLANE_URL, BUILD_RUNNER_SECRET, ANTHROPIC_API_KEY, RUNNER_WORKSPACES, SKILLS_SOURCE_DIR/);
  const lines: string[] = [];
  const log = createLogger({ sink: (l) => lines.push(l) });
  log.info("x", { leaked: "file-based-runner-secret-123456", key: "sk-ant-api03-filebasedkey-abcdefghijkl", header: "authorization: Bearer abc.def" });
  assert.doesNotMatch(lines[0], /file-based-runner-secret|filebasedkey|abc\.def/);
  assert.equal(redact("ghp_" + "a".repeat(30)), "[redacted]");
  mkdirSync(path.join(dir, "ws"), { recursive: true });
});
