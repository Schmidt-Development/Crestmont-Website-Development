// The file scanner (scanner/) is isolated from the AI Website Builder, Research Agent, Retell agents and the
// Self-Improvement Engine: it imports only Node's standard library and its own files, holds only FILE_SCANNER_SECRET,
// and its compose project shares no network, volume or image with the build runner's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const SRC = "scanner/src";
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));

test("[SEC-003] scanner imports only node: built-ins and its own modules", () => {
  assert.ok(files.length >= 4);
  for (const f of files) {
    const src = readFileSync(`${SRC}/${f}`, "utf8");
    for (const m of src.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)) assert.match(m[1], /^(node:|\.\/[a-z-]+\.ts$)/, `${f} imports ${m[1]}`);
    assert.doesNotMatch(src, /\bimport\(\s*["'](?!node:|\.\/)/, `${f} has a dynamic import outside the scanner`);
  }
});

test("[SEC-003] scanner holds only its own credential", () => {
  const all = files.map((f) => readFileSync(`${SRC}/${f}`, "utf8")).join("\n");
  const envKeys = new Set([...all.matchAll(/env\.([A-Z][A-Z0-9_]+)|env\[["']([A-Z][A-Z0-9_]+)["']\]|n\("([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1] ?? m[2] ?? m[3]));
  assert.deepEqual([...envKeys].filter((k) => /SECRET|KEY|TOKEN|PASSWORD/.test(k)), ["FILE_SCANNER_SECRET"]);
  for (const forbidden of ["BUILD_RUNNER_SECRET", "RESEARCH_RUNNER_SECRET", "RETELL", "ANTHROPIC", "CLOUDFLARE_API_TOKEN", "EVIDENCE_INGEST_SECRET"]) assert.ok(!all.includes(forbidden), forbidden);
  // It talks to the scanner endpoints and nothing else on the platform.
  const paths = [...all.matchAll(/"(\/api\/[a-z/-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(paths)].sort(), ["/api/scan/file", "/api/scan/heartbeat", "/api/scan/queue", "/api/scan/result"]);
});

test("[SEC-003] scanner compose project is separate from the build runner's and locked down", () => {
  const c = readFileSync("scanner/docker-compose.yml", "utf8"), runner = readFileSync("runner/windows/docker-compose.yml", "utf8");
  assert.match(c, /^name: crestmont-scanner$/m);
  assert.doesNotMatch(c, /^\s+ports:/m, "nothing is published");
  assert.doesNotMatch(c, /docker\.sock/, "no Docker socket");
  assert.match(c, /scan_net: \{ internal: true \}/);
  for (const n of ["runner_net", "install_net", "external: true"]) assert.ok(!c.includes(n), `no shared network (${n})`);
  assert.ok(!/crestmont-ai-runner|crestmont-egress-proxy/.test(c), "no runner images");
  assert.match(c, /image: clamav\/clamav:[\d.]+@sha256:[0-9a-f]{64}/, "ClamAV pinned by digest");
  const scannerSvc = c.slice(c.indexOf("  scanner:"), c.indexOf("\nnetworks:"));
  for (const must of ["read_only: true", "cap_drop: [ALL]", "no-new-privileges:true", "mem_limit:", "pids_limit:", "cpus:"]) assert.ok(scannerSvc.includes(must), must);
  assert.match(readFileSync("scanner/Dockerfile", "utf8"), /^ARG NODE_IMAGE=node:[\d.]+-[a-z-]+@sha256:[0-9a-f]{64}$/m);
  assert.match(runner, /^name: crestmont-runner$/m);
  for (const must of ['CLAMD_CONF_AlertExceedsMax: "yes"', "CLAMD_CONF_StreamMaxLength: 30M"]) assert.ok(c.includes(must), must);
});
