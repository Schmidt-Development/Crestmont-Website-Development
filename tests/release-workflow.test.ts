// release.yml can be started by hand for a commit on main (INFRA-005): it tags that commit itself and then does exactly
// what a tag push does. It never approves or deploys, never moves an existing tag, and never interpolates input into run:.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const y = readFileSync(".github/workflows/release.yml", "utf8");

test("[INFRA-005] release workflow: tag push and manual dispatch with a validated tag and commit", () => {
  assert.match(y, /push:\n\s+tags: \["v\*"\]/);
  assert.match(y, /workflow_dispatch:\n\s+inputs:\n\s+tag:[\s\S]*?commit:/);
  // Inputs only through env (F-23), then validated before anything else runs.
  assert.match(y, /TAG: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(y, /RELEASE_COMMIT: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.commit \|\| github\.sha \}\}/);
  for (const m of y.matchAll(/run: [|>]?([\s\S]*?)(?=\n {6}- |\n*$)/g)) assert.doesNotMatch(m[1], /\$\{\{\s*inputs\./, "no input interpolated into run:");
  assert.ok(y.indexOf("Validate the release inputs") < y.indexOf("actions/checkout@"), "inputs validated before checkout");
  assert.match(y, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+/);
  assert.match(y, /\^\[0-9a-f\]\{40\}\$/);
});

test("[INFRA-005] manual release: only a commit on main, never an existing tag, and the candidate binds that commit", () => {
  const step = y.slice(y.indexOf("Create the tag on a commit that is on main"), y.indexOf("actions/setup-node@"));
  assert.match(step, /if: github\.event_name == 'workflow_dispatch'/);
  assert.match(step, /git merge-base --is-ancestor "\$RELEASE_COMMIT" origin\/main/);
  assert.match(step, /git ls-remote --exit-code --tags origin "refs\/tags\/\$TAG"[\s\S]*already exists/);
  assert.ok(step.indexOf("ls-remote") < step.indexOf("git push"), "existing tags are checked before pushing");
  assert.doesNotMatch(step, /--force|-f\b/, "a tag is never moved");
  assert.match(y, /ref: \$\{\{ env\.RELEASE_COMMIT \}\}/, "the released commit is the one checked out (wrangler.toml digest)");
  assert.match(y, /release-candidate\.ts --tag "\$TAG" --commit "\$RELEASE_COMMIT"/);
  assert.doesNotMatch(y, /GITHUB_SHA/);
  const code = y.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(code, /wrangler (deploy|rollback|secret)|CLOUDFLARE_API_TOKEN|gh workflow run|actions\/workflows/, "release approves and deploys nothing");
});
