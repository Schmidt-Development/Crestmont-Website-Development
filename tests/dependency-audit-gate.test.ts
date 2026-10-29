// CREST-GAP-069: the CI dependency audit can fail the build (it used to end with `|| true` and had no lockfile to read).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("[SEC-007] CI dependency audit is blocking on high advisories and audits every committed lockfile", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const start = ci.indexOf("- name: Dependency audit");
  assert.ok(start > 0, "dependency audit step exists");
  const step = ci.slice(start, ci.indexOf("\n      - ", start + 1));
  assert.doesNotMatch(step, /\|\|\s*true/, "the audit result is never swallowed");
  assert.match(step, /set -euo pipefail/);
  assert.match(step, /npm audit --audit-level=high/);
  assert.match(step, /git ls-files '\*package\.json'/, "every committed package.json is considered");
});
