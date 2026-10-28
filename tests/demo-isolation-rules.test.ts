// The isolation audit decides whether a demo-branch push would start a Cloudflare Git build. Its rule evaluation must
// follow Cloudflare's documented semantics and lean towards reporting a build whenever a setting is ambiguous.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_BRANCHES, matches, branchSelected, pathsTrigger } from "../scripts/demo-isolation-rules.ts";
import { classify, netlifyDeploys } from "../scripts/demo-isolation-rules.ts";

test("[SEC-002] isolation audit: wildcard, branch and path rules follow Cloudflare's semantics and fail safe", () => {
  assert.ok(matches("*", "anything") && matches("crestmont/*", "crestmont/portfolio-demo") && matches("*.md", "docs/a.md"));
  assert.ok(!matches("crestmont/*", "main") && !matches("main", "crestmont/main"));
  // Preview trigger "all branches except main" selects a demo branch; excluding crestmont/* deselects it.
  assert.ok(branchSelected("crestmont/portfolio-demo", ["*"], ["main"]));
  assert.ok(!branchSelected("crestmont/portfolio-demo", ["*"], ["main", "crestmont/*"]));
  assert.ok(!branchSelected("crestmont/portfolio-demo", ["main"], []));
  assert.ok(branchSelected("crestmont/portfolio-demo", [], []), "empty includes are treated as every branch (fail safe)");
  // Paths: excludes first, then includes; default includes everything; forced builds for empty pushes.
  const files = DEMO_BRANCHES[3].files;
  assert.ok(pathsTrigger(files, [], []));
  assert.ok(!pathsTrigger(files, ["*"], ["portfolio-demo/*", ".github/*"]));
  assert.ok(pathsTrigger(files, ["*"], ["portfolio-demo/*"]), ".github/ still matches");
  assert.ok(pathsTrigger([], ["src/*"], ["*"]), "zero-file pushes always build");
  assert.equal(new Set(DEMO_BRANCHES.map((d) => `${d.repo}:${d.branch}`)).size, 4);
});

test("[SEC-002] audit error classes: HTTP 400 is an invalid request, never a missing permission; Netlify rule is conservative", () => {
  assert.deepEqual([400, 401, 403, 404, 429, 500, 0].map(classify), ["invalid-request", "authentication", "permission", "not-found", "rate-limited", "service", "network"]);
  const b = "crestmont/portfolio-demo-rentals";
  assert.equal(netlifyDeploys(b, { allowed_branches: ["cloudflare-pages-deployment"] }), false, "only the production branch deploys");
  assert.equal(netlifyDeploys(b, { allowed_branches: [] }), true, "empty list may mean all branches");
  assert.equal(netlifyDeploys(b, {}), true);
  assert.equal(netlifyDeploys(b, { allowed_branches: ["main", "crestmont/*"] }), true, "wildcards are not trusted");
  assert.equal(netlifyDeploys(b, { allowed_branches: [b] }), true);
  assert.equal(netlifyDeploys(b, { stop_builds: true, allowed_branches: [] }), false);
});
