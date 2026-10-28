// Dependency locking and image-build policy (static, no network): the runner's lockfile is committed and matches
// package.json; every npm install in the Dockerfiles is `npm ci` from a lockfile; base images are exact version tags
// (or digests); the images run as non-root; CI builds the images without pushing. The sandbox and the optional paid
// adapter lockfiles could not be generated where this was written (no registry access): those checks report a skip
// with the reason until the lockfiles are committed, and then validate them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RUNNER_DIR, REPO_ROOT } from "./helpers.ts";

const read = (p: string) => readFileSync(path.join(RUNNER_DIR, p), "utf8");
const json = (p: string) => JSON.parse(read(p)) as Record<string, unknown>;
const EXACT = /^\d+\.\d+\.\d+$/;

interface Lock { name: string; version: string; lockfileVersion: number; packages: Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; dev?: boolean }> }

function checkLock(dir: string): void {
  const pkg = json(`${dir}/package.json`) as { name: string; version: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const lock = json(`${dir}/package-lock.json`) as unknown as Lock;
  assert.equal(lock.lockfileVersion, 3, `${dir}: lockfileVersion 3 (npm >= 9)`);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  const root = lock.packages[""];
  assert.deepEqual(root.dependencies ?? {}, pkg.dependencies && Object.keys(pkg.dependencies).length ? pkg.dependencies : {}, `${dir}: lockfile root dependencies == package.json (npm ci would refuse otherwise)`);
  assert.deepEqual(root.optionalDependencies ?? {}, pkg.optionalDependencies ?? {});
  for (const [name, spec] of Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) })) {
    assert.match(spec, EXACT, `${dir}: ${name} pinned exactly`);
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${dir}: ${name} is in the lockfile`);
    assert.equal(entry.version, spec, `${dir}: locked ${name} version`);
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key) continue;
    assert.match(String(entry.resolved), /^https:\/\/registry\.npmjs\.org\//, `${dir}: ${key} resolved from the public npm registry`);
    assert.match(String(entry.integrity), /^sha512-/, `${dir}: ${key} has a sha512 integrity hash`);
  }
}

test("[AIB-RUNNER] runner/package-lock.json is committed and matches package.json; the local default has no runtime npm dependencies", () => {
  assert.ok(existsSync(path.join(RUNNER_DIR, "package-lock.json")), "runner/package-lock.json committed (npm ci is reproducible)");
  checkLock(".");
  const pkg = json("package.json");
  assert.deepEqual(pkg.dependencies, {}, "the local default runner needs no npm packages");
  assert.equal(pkg.optionalDependencies, undefined, "the paid SDK is not an optional dependency of the default install (it lives in agent-sdk/)");
  const sdk = json("agent-sdk/package.json") as { dependencies: Record<string, string> };
  assert.match(sdk.dependencies["@anthropic-ai/claude-agent-sdk"], EXACT);
  assert.match(sdk.dependencies.playwright, EXACT);
  const sandbox = json("sandbox/package.json") as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(sandbox.dependencies), ["playwright"]);
  assert.match(sandbox.dependencies.playwright, EXACT);
  assert.equal(sdk.dependencies.playwright, sandbox.dependencies.playwright, "one Playwright version across images");
});

const sandboxLock = existsSync(path.join(RUNNER_DIR, "sandbox", "package-lock.json"));
test("[AIB-RUNNER] runner/sandbox/package-lock.json locks Playwright for the sandbox image", { skip: sandboxLock ? false : "not committed yet: generate with `npm install --package-lock-only --ignore-scripts` in runner/sandbox (CI uploads one as the runner-lockfiles artifact), review, commit" }, () => {
  checkLock("sandbox");
});

const sdkLock = existsSync(path.join(RUNNER_DIR, "agent-sdk", "package-lock.json"));
test("[AIB-RUNNER] runner/agent-sdk/package-lock.json locks the optional paid adapter", { skip: sdkLock ? false : "not committed (optional paid adapter; its image build refuses to run without it)" }, () => {
  checkLock("agent-sdk");
});

function fromLines(dockerfile: string): { args: Record<string, string>; froms: string[] } {
  const args: Record<string, string> = {};
  const froms: string[] = [];
  for (const l of dockerfile.split("\n")) {
    const a = /^ARG\s+([A-Z_]+)=(\S+)/.exec(l);
    if (a) args[a[1]] = a[2];
    const f = /^FROM\s+(\S+)/.exec(l);
    if (f) froms.push(f[1].replace(/^\$\{([A-Z_]+)\}$/, (_m, n: string) => args[n] ?? `UNSET:${n}`));
  }
  return { args, froms };
}

// Exact version tag AND immutable digest (the tag stays for readability; Docker resolves the digest). Digests are the
// ones CI's runner-images job reports per tag ("Base image digest" annotations); re-pin only after reviewing a change.
const IMAGE_REF = /^[a-z0-9./-]+:\d+(\.\d+){1,2}(-[a-z0-9.-]+)?@sha256:[0-9a-f]{64}$/;

test("[AIB-RUNNER] Dockerfiles: npm ci from lockfiles only, base images pinned by tag and digest, non-root users, hadolint exceptions documented", () => {
  // The optional Ollama container image is pinned the same way, in the compose default and the installer default.
  const compose = read("windows/docker-compose.yml");
  const ollamaDefault = /\$\{OLLAMA_IMAGE:-([^}]+)\}/.exec(compose)?.[1] ?? "";
  assert.match(ollamaDefault, IMAGE_REF, "compose: ollama image default pinned by digest");
  assert.match(read("windows/Install-CrestmontRunner.ps1"), new RegExp(`\\[string\\]\\$OllamaImage = "${ollamaDefault.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), "installer default = compose default");
  const files = { runner: "Dockerfile", sandbox: "sandbox/Dockerfile", proxy: "windows/proxy/Dockerfile" };
  for (const [name, f] of Object.entries(files)) {
    const src = read(f);
    const code = src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    assert.doesNotMatch(code, /npm (install|i)\b(?! --package-lock-only)/, `${name}: no npm install (npm ci only)`);
    assert.doesNotMatch(code, /npx --yes|npx -y/, `${name}: no ad-hoc npx downloads`);
    assert.doesNotMatch(code, /curl[^\n]*\|\s*(ba)?sh|wget[^\n]*\|\s*(ba)?sh/, `${name}: no curl | sh`);
    const { froms } = fromLines(src);
    assert.ok(froms.length >= 1);
    for (const ref of froms) {
      if (/^[a-z]+$/.test(ref)) continue; // a build stage name
      assert.match(ref, IMAGE_REF, `${name}: FROM ${ref} is an exact version tag pinned to a sha256 digest`);
      assert.doesNotMatch(ref, /:latest\b|:(\d+)(-[a-z-]+)?$/, `${name}: FROM ${ref} is not a floating tag`);
    }
    for (const m of code.matchAll(/hadolint ignore=([A-Z0-9,]+)/g)) assert.deepEqual(m[1].split(","), ["DL3008"], `${name}: only the documented apt pinning exception`);
  }
  const runner = read(files.runner);
  assert.match(runner, /COPY package\.json package-lock\.json \.\/\nRUN npm ci --omit=dev --ignore-scripts/);
  assert.match(runner, /^USER runner$/m);
  assert.match(runner, /INSTALL_AGENT_SDK=true needs runner\/agent-sdk\/package-lock\.json/, "the paid adapter build refuses to run unlocked");
  assert.match(runner, /npm ci --prefix \/app\/agent-sdk/);
  const sandbox = read(files.sandbox);
  assert.match(sandbox, /COPY package\.json package-lock\.json \.\/\nRUN npm ci --omit=dev --ignore-scripts/);
  assert.match(sandbox, /\.\/node_modules\/\.bin\/playwright install --with-deps chromium/, "Chromium from the locked Playwright");
  assert.match(sandbox, /useradd --uid 10001/);
  assert.match(sandbox, /^USER builder$/m);
  const sandboxCode = sandbox.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(sandboxCode, /docker|sudo/i, "no docker CLI or sudo in the sandbox image");
});

test("[AIB-RUNNER] CI builds the runner, sandbox and proxy images (no push, read-only token) and runs their self-checks", () => {
  const ci = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const job = (name: string) => {
    const start = ci.indexOf(`\n  ${name}:\n`);
    assert.ok(start >= 0, `job ${name} exists`);
    const next = ci.slice(start + 1).search(/\n  [a-z0-9-]+:\n/);
    return next < 0 ? ci.slice(start) : ci.slice(start, start + 1 + next);
  };
  const images = job("runner-images");
  assert.match(images, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(images, /--push|docker push|docker login|packages: write|id-token/);
  assert.match(images, /docker buildx build [^\n]*-f runner\/Dockerfile runner\n/);
  assert.match(images, /docker buildx build [^\n]*-f runner\/sandbox\/Dockerfile runner\/sandbox\n/);
  assert.match(images, /docker buildx build [^\n]*runner\/windows\/proxy\n/);
  assert.match(images, /runner\/ci\/sandbox-self-check\.ts crestmont-build-sandbox:ci/);
  assert.match(images, /runner\/ci\/runner-image-self-check\.ts crestmont-ai-runner:ci crestmont-egress-proxy:ci/);
  assert.match(images, /runner\/ci\/egress-e2e\.ts crestmont-ai-runner:ci crestmont-egress-proxy:ci/);
  assert.match(images, /hadolint-Linux-x86_64\n[\s\S]*sha256sum -c/, "hadolint binary checksum verified");
  const ps = job("windows-scripts");
  assert.match(ps, /permissions:\n\s+contents: read\n/);
  assert.match(ps, /shell: pwsh\n\s+run: \.\/runner\/windows\/Test-WindowsScripts\.ps1/);
  const winWf = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "windows-powershell.yml"), "utf8");
  const ps51 = winWf.slice(winWf.indexOf("\n  windows-powershell-51:\n"));
  assert.ok(winWf.includes("\n  windows-powershell-51:\n"), "Windows PowerShell 5.1 job exists");
  assert.match(winWf, /paths: \["runner\/windows\/\*\*"/, "Windows-hosted minutes only when the Windows kit changes");
  assert.match(winWf, /^permissions:\n\s+contents: read\n/m);
  assert.match(ps51, /runs-on: windows-latest/);
  assert.match(ps51, /Discover-Hardware\.ps1/);
  assert.doesNotMatch(ci, /ANTHROPIC_API_KEY|OPENAI_API_KEY/, "CI never gets a paid AI key");
});
