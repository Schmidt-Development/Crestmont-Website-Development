// Check integrity and customer-requirement checks (AI Website Builder readiness, 2026-10-28).
// The agent can edit every file in its workspace, so the runner's acceptance verdict must not depend on files the
// agent controls. MOCK/FAKE tests: fake control plane, fake Agent SDK messages, no model runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import path from "node:path";
import { runJob } from "../src/job.ts";
import { ControlPlaneClient } from "../src/control-plane.ts";
import { silentLogger } from "../src/log.ts";
import { loadStarter, restoreProtectedFiles, briefConformance } from "../src/checks.ts";
import {
  RUNNER_DIR, tmp, startFakeControlPlane, makeJob, claimFrom, fakeSdk, makeSkillsDir, testManifest, makeConfig, SECRET,
  POLLUTED_ENV, initMsg, resultMsg, writeFakeTranscript, SDK_OPT_IN, fillStarterFromBrief,
} from "./helpers.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const STARTER = path.join(RUNNER_DIR, "starters", "brochure-v1");
const manifest = testManifest();

function starterCopy(): string {
  const repo = tmp("aib-int-");
  for (const e of ["public", "scripts", "package.json"]) cpSync(path.join(STARTER, e), path.join(repo, e), { recursive: true });
  return repo;
}

test("[AIB-RUNNER] protected checker files: changed or deleted files are restored from the runner's starter and reported; links are never written through", () => {
  const spec = loadStarter(STARTER);
  assert.deepEqual(spec.protected, ["scripts/check.mjs", "scripts/check-profiles.json"]);
  assert.deepEqual(spec.acceptance[0].command, ["node", "scripts/check.mjs", "--package", "{package}"], "the checker runs directly, not through an editable npm script");

  const repo = starterCopy();
  assert.deepEqual(restoreProtectedFiles(STARTER, repo, spec), [], "untouched copy: nothing to restore");
  writeFileSync(path.join(repo, "scripts", "check.mjs"), "process.exit(0)\n");
  writeFileSync(path.join(repo, "scripts", "check-profiles.json"), JSON.stringify({ starter: { maxPages: 999, contactForm: false, seo: "basic" } }));
  assert.deepEqual(restoreProtectedFiles(STARTER, repo, spec).sort(), ["scripts/check-profiles.json", "scripts/check.mjs"]);
  assert.equal(readFileSync(path.join(repo, "scripts", "check.mjs"), "utf8"), readFileSync(path.join(STARTER, "scripts", "check.mjs"), "utf8"));

  // A planted link: scripts/ -> a directory outside the workspace. The runner replaces the link, never writes through it.
  const outside = tmp("aib-outside-");
  writeFileSync(path.join(outside, "keep.txt"), "host file");
  const repo2 = starterCopy();
  execFileSync("rm", ["-rf", path.join(repo2, "scripts")]);
  symlinkSync(outside, path.join(repo2, "scripts"));
  assert.deepEqual(restoreProtectedFiles(STARTER, repo2, spec).sort(), ["scripts/check-profiles.json", "scripts/check.mjs"]);
  assert.ok(!lstatSync(path.join(repo2, "scripts")).isSymbolicLink());
  assert.ok(!existsSync(path.join(outside, "check.mjs")), "nothing written outside the workspace");
  assert.equal(readFileSync(path.join(outside, "keep.txt"), "utf8"), "host file");

  // A link at the file itself is replaced too.
  const repo3 = starterCopy();
  execFileSync("rm", ["-f", path.join(repo3, "scripts", "check.mjs")]);
  symlinkSync(path.join(outside, "keep.txt"), path.join(repo3, "scripts", "check.mjs"));
  assert.deepEqual(restoreProtectedFiles(STARTER, repo3, spec), ["scripts/check.mjs"]);
  assert.equal(readFileSync(path.join(outside, "keep.txt"), "utf8"), "host file");

  assert.throws(() => restoreProtectedFiles(STARTER, repo, { ...spec, protected: ["../escape.js"] }), /invalid protected path/);
  assert.throws(() => restoreProtectedFiles(STARTER, repo, { ...spec, protected: [".git/hooks/pre-commit"] }), /invalid protected path/);
});

test("[AIB-RUNNER] a build whose agent weakens the checker still fails on the real checks, and the report says the checker was restored [mock SDK]", async () => {
  const cp = await startFakeControlPlane({ jobs: [makeJob()] });
  const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(manifest), ...SDK_OPT_IN });
  const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: cfg.runnerId, sleep: async () => {}, retry: { attempts: 2, baseMs: 1 } });
  try {
    const job = await claimFrom(cp);
    const sdk = fakeSdk(async function* (ctx): AsyncGenerator<SDKMessage> {
      const sid = ctx.options.resume ?? "sess-tamper";
      writeFakeTranscript(ctx.options, sid);
      yield initMsg(sid);
      const repo = String(ctx.options.cwd);
      // Leaves every starter placeholder in place, then "makes the checks pass" by editing the checker and the script.
      writeFileSync(path.join(repo, "scripts", "check.mjs"), "process.exit(0)\n");
      const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
      pkg.scripts.check = "true";
      writeFileSync(path.join(repo, "package.json"), JSON.stringify(pkg));
      yield resultMsg(sid, 0.1 * ctx.call, 1);
    });
    const s = await runJob(job, { cfg, client, queryFn: sdk.queryFn, manifest, logger: silentLogger, heartbeatMs: 25, interruptGraceMs: 200, processEnv: POLLUTED_ENV });
    assert.equal(s.outcome, "failed");
    assert.match(String(s.complete?.error), /Acceptance checks failed: static-check/);
    assert.match(String(s.complete?.report), /STARTER-PLACEHOLDER/);
    assert.match(String(s.complete?.report), /Check integrity: the agent had changed scripts\/check\.mjs/);
    assert.equal(s.complete?.previewUrl, null);
  } finally { await cp.close(); }
});

test("[AIB-RUNNER] brief conformance: the customer's business name, public email and phone must appear on the generated site", () => {
  const facts = { businessName: "Harbor & Pine Bakery", publicEmail: "Hello@HarborPine.example", publicPhone: "+1 (313) 555-0142" };
  const repo = starterCopy();
  // Placeholders only: every detail missing.
  let r = briefConformance(repo, facts)!;
  assert.equal(r.ok, false);
  assert.match(r.outputTail, /business name \("Harbor & Pine Bakery"\) does not appear on the home page/);
  assert.match(r.outputTail, /public email \(hello@harborpine\.example\) does not appear/);
  assert.match(r.outputTail, /public phone number/);
  // Filled in the way the site would render them: HTML entities, curly apostrophes, other phone formatting.
  const idx = path.join(repo, "public", "index.html");
  writeFileSync(idx, readFileSync(idx, "utf8").replace("STARTER-PLACEHOLDER Clear headline", "Harbor &amp; Pine Bakery headline"));
  const contact = path.join(repo, "public", "contact.html");
  writeFileSync(contact, readFileSync(contact, "utf8").replace("STARTER-PLACEHOLDER public email", "hello@harborpine.example").replace("STARTER-PLACEHOLDER public phone", "313.555.0142"));
  r = briefConformance(repo, facts)!;
  assert.equal(r.ok, true, r.outputTail);
  assert.equal(r.id, "brief-conformance");
  // Only on an inner page is not enough for the name; nothing to check when the brief has no details.
  const repo2 = starterCopy();
  writeFileSync(path.join(repo2, "public", "about.html"), readFileSync(path.join(repo2, "public", "about.html"), "utf8").replace("STARTER-PLACEHOLDER Business name", "Harbor &amp; Pine Bakery"));
  assert.match(briefConformance(repo2, { businessName: facts.businessName })!.outputTail, /home page/);
  assert.equal(briefConformance(repo2, {}), null);
  assert.equal(briefConformance(tmp("aib-nopub-"), facts), null, "no static site: not applicable");
  // A wrong number that merely shares a short suffix does not pass.
  const repo3 = starterCopy();
  fillStarterFromBrief(repo3);
  const c3 = path.join(repo3, "public", "contact.html");
  writeFileSync(c3, readFileSync(c3, "utf8").replace('href="tel:+10000000000"', 'href="tel:+12485550142"'));
  assert.match(briefConformance(repo3, { publicPhone: facts.publicPhone })!.outputTail, /public phone number/);
});

test("[AIB-RUNNER] starter check rejects generic template leftovers: bracketed fill-ins, template variables, TODO text and placeholder image services", () => {
  const repo = starterCopy();
  fillStarterFromBrief(repo);
  const check = () => spawnSync(process.execPath, [path.join(repo, "scripts", "check.mjs"), "--root", repo, "--package", "starter"], { encoding: "utf8" });
  const base = check();
  assert.equal(base.status, 0, base.stdout);
  const about = path.join(repo, "public", "about.html");
  const original = readFileSync(about, "utf8");
  for (const [snippet, finding] of [
    ["<p>Call us at [Your Phone Number] today.</p>", /unfilled template text "\[Your Phone Number\]"/],
    ["<p>Welcome to {{ business_name }}.</p>", /unfilled template text "\{\{ business_name \}\}"/],
    ["<p>TODO: write the story.</p>", /TODO\/FIXME left in page text/],
    ['<img src="https://via.placeholder.com/600x400" alt="Team">', /placeholder image service/],
  ] as const) {
    writeFileSync(about, original.replace("</main>", `${snippet}</main>`));
    const r = check();
    assert.equal(r.status, 1, `${snippet}\n${r.stdout}`);
    assert.match(r.stdout, finding);
  }
  // Comments are not page text.
  writeFileSync(about, original.replace("</main>", "<!-- TODO later --></main>"));
  assert.equal(check().status, 0);
});

test("[AIB-RUNNER] browser-check.mjs uses the image's Playwright, never a playwright package planted in the project (real headless Chromium)", (t) => {
  const nodePath = [process.env.NODE_PATH, "/opt/npm-tools/node_modules", "/usr/local/lib/node_modules"].filter(Boolean).join(path.delimiter);
  const env = { ...process.env, NODE_PATH: nodePath };
  const probe = spawnSync(process.execPath, ["-e", "const p=require('playwright');process.exit(require('fs').existsSync(p.chromium.executablePath())?0:1)"], { env, encoding: "utf8" });
  if (probe.status !== 0) { t.skip("Playwright/Chromium not installed on this host"); return; }
  const root = tmp("aib-bc-fake-");
  cpSync(path.join(STARTER, "public"), path.join(root, "public"), { recursive: true });
  const about = path.join(root, "public", "about.html");
  writeFileSync(about, readFileSync(about, "utf8").replace("</main>", "<script>throw new Error('boom')</script></main>"));
  // A fake "playwright" in the project that would report every page as fine.
  mkdirSync(path.join(root, "node_modules", "playwright"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "playwright", "package.json"), JSON.stringify({ name: "playwright", version: "0.0.0", main: "index.js" }));
  writeFileSync(path.join(root, "node_modules", "playwright", "index.js"), "require('fs').writeFileSync('FAKE-USED','1'); module.exports = { chromium: { launch: async () => { process.exit(0); } } };");
  const r = spawnSync(process.execPath, [path.join(RUNNER_DIR, "sandbox", "browser-check.mjs"), "--root", "public", "--out", "shots"], { cwd: root, env, encoding: "utf8", timeout: 180_000 });
  assert.ok(!existsSync(path.join(root, "FAKE-USED")), "the planted package was not loaded");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /page error: boom/);
});

test("[AIB-RUNNER] visible-text extraction drops comments, script and style however they are closed (no markup survives)", async () => {
  const { visibleText } = await import("../src/checks.ts");
  const html = `<p>Keep A</p><!-- hidden --><script >x("Harbor")</script ><style>.a{}</style\n><p>Keep B</p><!--<!--nested--> after<script>never closed <b>Harbor</b>`;
  const t = visibleText(html);
  assert.match(t, /Keep A/);
  assert.match(t, /Keep B/);
  assert.match(t, /after/);
  assert.doesNotMatch(t, /Harbor|hidden|\.a\{|[<>]/);
  assert.equal(visibleText("a <!-- open comment never closed Harbor").includes("Harbor"), false);
  // The starter checker uses the same scanner for TODO/template detection: commented or scripted text is not page text.
  const repo = starterCopy();
  fillStarterFromBrief(repo);
  const about = path.join(repo, "public", "about.html");
  writeFileSync(about, readFileSync(about, "utf8").replace("</main>", "<script >/* TODO */</script ><!--- TODO --></main>"));
  const r = spawnSync(process.execPath, [path.join(repo, "scripts", "check.mjs"), "--root", repo, "--package", "starter"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});
