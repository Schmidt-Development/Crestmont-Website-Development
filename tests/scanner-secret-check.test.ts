import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deriveStagingKey } from "../scripts/staging-secrets.ts";

const checksum = (v: string) => createHash("sha256").update(`crestmont-checksum:v1:${v}`).digest("hex").slice(0, 12);
const run = (root: string, installedAt: string) => execFileSync(process.execPath, ["--no-warnings", "scripts/scanner-secret-check.ts", "--offline", "--installed-at", installedAt],
  { env: { ...process.env, ACCESS_ROOT_KEY: root, GITHUB_ACTIONS: "" }, encoding: "utf8" });

test("[SEC-003] scanner secret probe derives the key exactly as deploy-staging does (token as stored, whitespace included) and never prints a secret (run 42337949581)", () => {
  const dir = mkdtempSync(join(tmpdir(), "scanprobe-"));
  try {
    const padded = "cf-token-for-the-probe-test-0123456789abcdef\n";   // a GitHub secret saved with a trailing newline
    const deployKey = deriveStagingKey(padded, "scanner"), trimmedKey = deriveStagingKey(padded.trim(), "scanner");
    assert.notEqual(deployKey, trimmedKey, "the whitespace changes the derived key");
    const env = join(dir, "scanner.env");
    writeFileSync(env, `PLATFORM_URL=https://x.example\nSCANNER_ID=n1\nFILE_SCANNER_SECRET=${deployKey}\n`);
    const out = run(padded, env);
    assert.match(out, new RegExp(`derives scanner key\\s+: ${checksum(deployKey)}\\s+\\(as the deploy derives it\\)`));
    assert.match(out, new RegExp(`trimmed token derives\\s+: ${checksum(trimmedKey)}`));
    assert.match(out, /installed == derived\s+: YES/);
    for (const secret of [deployKey, trimmedKey, padded.trim()]) assert.ok(!out.includes(secret), "no secret or token in the output");
    writeFileSync(env, `FILE_SCANNER_SECRET=${trimmedKey}\n`);
    assert.match(run(padded, env), /installed == derived\s+: NO — scanner\.env holds the TRIMMED-token key/);
    assert.doesNotMatch(run(padded.trim(), env), /surrounding whitespace|trimmed token derives/, "a clean token reports one key");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[SEC-003] the probe workflow tests the value the deploy installs: the staging FILE_SCANNER_SECRET when set, else the derived key", async () => {
  const { readFileSync } = await import("node:fs");
  const probe = readFileSync(".github/workflows/scanner-secret-probe.yml", "utf8"), deploy = readFileSync(".github/workflows/deploy-staging.yml", "utf8");
  assert.match(deploy, /SCANNER_SECRET: \$\{\{ secrets\.FILE_SCANNER_SECRET \}\}[\s\S]*if \[ -z "\$SCANNER_SECRET" \]; then SCANNER_SECRET=\$\(node --no-warnings scripts\/staging-secrets\.ts derive scanner\)/, "the deploy prefers the GitHub secret");
  assert.match(probe, /FILE_SCANNER_SECRET: \$\{\{ secrets\.FILE_SCANNER_SECRET \}\}/);
  assert.match(probe, /if \[ -n "\$FILE_SCANNER_SECRET" \]; then[\s\S]*--probe-provided "\$STAGING_URL"[\s\S]*else[\s\S]*--probe "\$STAGING_URL"/);
  assert.doesNotMatch(probe, /echo[^\n]*\$FILE_SCANNER_SECRET/, "never echoed");
});
