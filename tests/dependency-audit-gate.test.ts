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

test("[SEC-007] audit exceptions: one advisory, one directory, until a date — nothing else passes", async () => {
  const { blockingAdvisories, uncovered } = await import("../scripts/audit-exceptions.mjs");
  const report = { vulnerabilities: {
    picomatch: { via: [{ url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf", severity: "high" }] },
    tinyglobby: { via: ["picomatch"] },
    other: { via: [{ url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "critical" }, { url: "https://github.com/advisories/GHSA-dddd-eeee-ffff", severity: "moderate" }] },
  } };
  assert.deepEqual(blockingAdvisories(report), ["ghsa-aaaa-bbbb-cccc", "ghsa-fc5q-39xc-vjpf"], "high and critical only; transitive entries add nothing");
  const ex = [{ advisory: "GHSA-fc5q-39xc-vjpf", path: "runner/test/fixtures/northgate-clinic-frontend", expires: "2026-12-18" }];
  const dir = "runner/test/fixtures/northgate-clinic-frontend";
  assert.deepEqual(uncovered(["ghsa-fc5q-39xc-vjpf"], ex, dir, "2026-11-18"), [], "covered while valid");
  assert.deepEqual(uncovered(["ghsa-fc5q-39xc-vjpf"], ex, dir, "2026-12-19"), ["ghsa-fc5q-39xc-vjpf"], "expired → blocks again");
  assert.deepEqual(uncovered(["ghsa-fc5q-39xc-vjpf"], ex, "runner/sandbox", "2026-11-18"), ["ghsa-fc5q-39xc-vjpf"], "another directory → blocks");
  assert.deepEqual(uncovered(["ghsa-fc5q-39xc-vjpf", "ghsa-aaaa-bbbb-cccc"], ex, dir, "2026-11-18"), ["ghsa-aaaa-bbbb-cccc"], "another advisory → blocks");
  // The committed exceptions are each one advisory, one path, with an expiry at most 31 days after approval.
  const { exceptions } = JSON.parse(readFileSync("security/audit-exceptions.json", "utf8"));
  for (const e of exceptions) {
    assert.match(e.advisory, /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    assert.ok(e.path && !e.path.includes("*"), "a single directory, no wildcard");
    assert.match(e.expires, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.approvedBy && e.reason, "approval and reason recorded");
    const approved = /\d{4}-\d{2}-\d{2}/.exec(e.approvedBy)?.[0];
    assert.ok(approved && Date.parse(e.expires) - Date.parse(approved) <= 31 * 86_400_000, "at most 31 days");
  }
});
