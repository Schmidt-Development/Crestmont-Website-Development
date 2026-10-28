// Secret scanning on every CI run (SEC-004, INFRA-004): fails if a tracked file contains something shaped like a real
// credential. Obvious test placeholders (sk_test_contract, whsec_buildtest, re_test_…) are allowed; live-mode keys,
// cloud access keys, private keys and GitHub/Slack tokens never are.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const RULES: [string, RegExp][] = [
  ["Stripe live secret/restricted key", /\b(sk|rk)_live_[0-9A-Za-z]{16,}/],
  ["Stripe test key with real entropy", /\bsk_test_[0-9A-Za-z]{40,}/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["Private key block", /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b|\bgithub_pat_[0-9A-Za-z_]{60,}/],
  ["Slack token", /\bxox[abpr]-[0-9A-Za-z-]{20,}/],
  ["Anthropic API key", /\bsk-ant-(api|admin)\d{2}-[0-9A-Za-z_-]{40,}/],
  ["Resend API key with real entropy", /\bre_[0-9A-Za-z]{8}_[0-9A-Za-z]{20,}/],
  ["Cloudflare API token assignment", /CLOUDFLARE_API_TOKEN\s*[:=]\s*["']?[0-9A-Za-z_-]{40}\b/],
];

function trackedFiles(): string[] {
  try { return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean); }
  catch { return []; }
}

test("[SEC-004] [INFRA-004] secret scan: no tracked file contains a credential-shaped value", (t) => {
  const files = trackedFiles();
  if (!files.length) { t.skip("not a git checkout"); return; }
  const hits: string[] = [];
  for (const f of files) {
    if (/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|gz)$/i.test(f)) continue;
    let s: string;
    try { if (statSync(f).size > 2_000_000) continue; s = readFileSync(f, "utf8"); } catch { continue; }
    for (const [name, re] of RULES) {
      const m = re.exec(s);
      if (m) hits.push(`${f}: ${name} (${m[0].slice(0, 12)}…)`);
    }
  }
  assert.deepEqual(hits, []);
  // The scanner itself must catch what it claims to.
  for (const [name, sample] of [["Stripe live secret/restricted key", "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc"], ["AWS access key id", "AKIA" + "IOSFODNN7EXAMPLE"], ["Private key block", "-----BEGIN " + "PRIVATE KEY-----"]] as const)
    assert.ok(RULES.find(([n]) => n === name)![1].test(sample), name);
});
