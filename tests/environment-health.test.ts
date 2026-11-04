// ENV-01 … ENV-07: the environment pages must report what the platform ACTUALLY runs.
//
// Two classes of defect are fixed here and pinned by these tests:
//   1. Identifier drift — the environment page asked for "d1"/"r2" while the health rows are written under
//      "database"/"object_storage", so the real probes were invisible and every page showed a permanent
//      "No health record" row beside the verified one.
//   2. Provider drift — the AI row demanded ANTHROPIC_API_KEY and probed Anthropic, although Crestmont runs a
//      self-hosted model on Node 1. A healthy platform reported itself broken, and the "fix" would have been to
//      start paying for inference nobody asked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { assessConfiguration, refreshIntegrationHealth, INTEGRATIONS, isIntegrationId } from "../src/services/integrations.ts";

const deps = (t: Awaited<ReturnType<typeof createTestApp>>, over: Record<string, unknown> = {}) =>
  ({ db: t.db, env: { ...t.env, ...over }, storage: t.storage ?? null } as Parameters<typeof assessConfiguration>[0]);

// ───────────── ENV-01 / ENV-02: identifiers ─────────────

test("[INFRA-002] [READY-006] the environment pages ask for integration ids that actually exist", () => {
  const src = readFileSync("src/routes/readiness.ts", "utf8");
  const listed = [...src.matchAll(/^\s{2}(development|staging|production): \[([^\]]+)\]/gm)]
    .flatMap((m) => m[2].split(",").map((s) => s.trim().replace(/^"|"$/g, "")));
  assert.ok(listed.length >= 20, "the per-environment lists were found");
  const unknown = [...new Set(listed)].filter((id) => !isIntegrationId(id));
  assert.deepEqual(unknown, [], "every id on an environment page must be defined in src/services/integrations.ts");
  assert.ok(listed.includes("database") && listed.includes("object_storage"));
  assert.ok(!listed.includes("d1") && !listed.includes("r2"), "the ids that matched nothing are gone");
});

test("[INFRA-002] a health row stored under a legacy id still answers for its canonical row", () => {
  const src = readFileSync("src/routes/readiness.ts", "utf8");
  assert.match(src, /LEGACY_INTEGRATION_IDS[\s\S]{0,120}d1: "database"[\s\S]{0,60}r2: "object_storage"/,
    "old rows keep their meaning instead of being orphaned");
});

test("[INFRA-002] the D1 and R2 checks are real: SELECT 1, and a write/read/delete round trip", async () => {
  const t = await createTestApp();
  const db = await assessConfiguration(deps(t), "database");
  assert.equal(db.probe, true, "the database row is probeable");
  const store = await assessConfiguration(deps(t), "object_storage");
  assert.equal(store.probe, true, "the storage row is probeable");
  const src = readFileSync("src/services/integrations.ts", "utf8");
  assert.match(src, /case "database": \{[\s\S]{0,400}SELECT 1 AS ok/);
  assert.match(src, /case "object_storage": \{[\s\S]{0,600}await s\.put\([\s\S]{0,200}await s\.get\([\s\S]{0,120}await s\.delete\(/,
    "the storage probe writes, reads back and cleans up its own object");
});

test("[INFRA-002] with no bucket bound, object storage is reported as unavailable rather than guessed", async () => {
  const t = await createTestApp();
  const a = await assessConfiguration({ db: t.db, env: t.env, storage: null } as Parameters<typeof assessConfiguration>[0], "object_storage");
  assert.equal(a.status, "not_configured");
  assert.equal(a.probe, false);
});

// ───────────── ENV-06: the AI backend that is actually selected ─────────────

test("[AIOPS-002] the self-hosted runner is the AI backend when AI_PROVIDER=local-runner, with no Anthropic key", async () => {
  const t = await createTestApp();
  const a = await assessConfiguration(deps(t, { AI_PROVIDER: "local-runner", BUILD_RUNNER_SECRET: "s".repeat(40), ANTHROPIC_API_KEY: undefined }), "ai");
  assert.notEqual(a.status, "not_configured", "a configured self-hosted runner is not 'no AI'");
  assert.match(a.detail, /Self-hosted runner selected/);
  assert.match(a.detail, /no paid API/i);
  assert.equal(a.probe, true, "it is verifiable — by heartbeat, not by a paid call");
});

test("[AIOPS-002] local-runner without its secret names the missing secret, and never asks for an Anthropic key", async () => {
  const t = await createTestApp();
  const a = await assessConfiguration(deps(t, { AI_PROVIDER: "local-runner", BUILD_RUNNER_SECRET: undefined }), "ai");
  assert.equal(a.status, "not_configured");
  assert.match(a.detail, /BUILD_RUNNER_SECRET is not set/);
  assert.ok(!/ANTHROPIC_API_KEY/.test(a.detail), "the fix must never be 'buy Anthropic inference'");
});

test("[AIOPS-002] an unused Anthropic key never switches paid AI on by itself", async () => {
  const t = await createTestApp();
  const a = await assessConfiguration(deps(t, { AI_PROVIDER: undefined, ANTHROPIC_API_KEY: "sk-ant-unused" }), "ai");
  assert.equal(a.status, "not_configured");
  assert.match(a.detail, /present but unused/);
});

test("[AIOPS-002] the AI probe reads the runner's heartbeat and never starts a build", async () => {
  const t = await createTestApp();
  const src = readFileSync("src/services/integrations.ts", "utf8");
  const probe = src.slice(src.indexOf('case "ai": {', src.indexOf("async function probe")));
  assert.match(probe, /build_runners[\s\S]{0,120}last_seen_at/, "the heartbeat table is what is read");
  assert.ok(!/api\.anthropic\.com/.test(probe.slice(0, probe.indexOf('AI_PROVIDER !== "anthropic"'))),
    "the self-hosted path must not call a paid API");
  // Never polled: honest, and not a failure.
  await t.db.prepare(`DELETE FROM build_runners`).run().catch(() => {});
  const rows = await refreshIntegrationHealth(deps(t, { AI_PROVIDER: "local-runner", BUILD_RUNNER_SECRET: "s".repeat(40) }));
  const ai = rows.find((r) => r.integration === "ai")!;
  assert.notEqual(ai.status, "verified", "nothing is verified without a heartbeat");
});

test("[AIOPS-002] a runner that polled recently verifies the AI backend", async () => {
  const t = await createTestApp();
  await t.db.prepare(`INSERT INTO build_runners (runner_id, version, capabilities, last_seen_at) VALUES (?,?,?,?)`)
    .bind("node1", "1.4.0", "{}", new Date().toISOString()).run();
  const { verifyIntegration } = await import("../src/services/integrations.ts");
  const out = await verifyIntegration(deps(t, { AI_PROVIDER: "local-runner", BUILD_RUNNER_SECRET: "s".repeat(40) }), "ai", null);
  assert.equal(out.status, "verified");
  assert.match(out.detail, /node1/);
  assert.match(out.detail, /No paid API is used/);
});

// ───────────── ENV-07: GitHub ─────────────

test("[READY-005] a snapshot pushed by GitHub Actions counts as repository access, with no Worker token", async () => {
  const t = await createTestApp();
  await t.db.prepare(`INSERT INTO github_sync (id, repo, fetched_at, ok, payload_json, source) VALUES (?,?,?,?,?,?)`)
    .bind("gh-1", "Schmidt-Development/Crestmont-Website-Development", new Date().toISOString(), 1, "{}", "push").run();
  const a = await assessConfiguration(deps(t, { GITHUB_TOKEN: undefined, GITHUB_REPO: undefined }), "github");
  assert.equal(a.status, "verified");
  assert.match(a.detail, /read-only workflow token/);
  assert.match(a.detail, /Crestmont-Website-Development/);
});

test("[READY-005] an old pushed snapshot is degraded, not silently trusted", async () => {
  const t = await createTestApp();
  const old = new Date(Date.now() - 200 * 3_600_000).toISOString();
  await t.db.prepare(`INSERT INTO github_sync (id, repo, fetched_at, ok, payload_json, source) VALUES (?,?,?,?,?,?)`)
    .bind("gh-old", "Schmidt-Development/Crestmont-Website-Development", old, 1, "{}", "push").run();
  const a = await assessConfiguration(deps(t, { GITHUB_TOKEN: undefined, GITHUB_REPO: undefined }), "github");
  assert.equal(a.status, "degraded");
  assert.match(a.detail, /h old/);
});

test("[READY-005] with neither a token nor a pushed snapshot, GitHub is honestly not configured", async () => {
  const t = await createTestApp();
  const a = await assessConfiguration(deps(t, { GITHUB_TOKEN: undefined, GITHUB_REPO: undefined }), "github");
  assert.equal(a.status, "not_configured");
});

test("[INFRA-002] every integration the dashboard defines has a label and a stable id", () => {
  assert.ok(INTEGRATIONS.length >= 14);
  for (const i of INTEGRATIONS) {
    assert.match(i.id, /^[a-z_]+$/, `${i.id} is a stable identifier`);
    assert.ok(i.label.length > 3, `${i.id} has a human label`);
  }
  const labels: string[] = INTEGRATIONS.map((i) => i.label);
  assert.ok(!labels.includes("AI provider (Anthropic)"),
    "the AI row must not be labelled for a provider Crestmont does not use");
});
