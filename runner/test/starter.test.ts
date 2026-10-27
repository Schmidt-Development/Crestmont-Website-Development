// Unit tests: the brochure starter, its offline check, the contact stub, the skills manifest and the poll loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, cpSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PACKAGES } from "../../src/domain/catalog.ts";
import { loadStarter, starterDir, previewConfigProblems } from "../src/checks.ts";
import { loadManifest, preflight, provisionSkills } from "../src/skills.ts";
import { runLoop } from "../src/main.ts";
import { ControlPlaneClient } from "../src/control-plane.ts";
import { silentLogger } from "../src/log.ts";
import { RUNNER_DIR, tmp, makeSkillsDir, makeConfig, startFakeControlPlane, makeJob, SECRET, testManifest, fakeSdk, happyAgent, SDK_OPT_IN } from "./helpers.ts";

const STARTER = path.join(RUNNER_DIR, "starters", "brochure-v1");

function check(root: string, ...args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync("node", [path.join(root, "scripts", "check.mjs"), "--root", root, ...args], { encoding: "utf8" }) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}

test("[AIB-RUNNER] starter.json page limits and check profiles match the catalog PACKAGES", () => {
  const spec = loadStarter(starterDir(path.join(RUNNER_DIR, "starters"), { name: "brochure", version: "1" }));
  const profiles = JSON.parse(readFileSync(path.join(STARTER, "scripts", "check-profiles.json"), "utf8"));
  for (const id of ["starter", "business", "premium"] as const) {
    assert.equal(spec.packages[id].maxPages, PACKAGES[id].pageLimit, id);
    assert.equal(profiles[id].maxPages, PACKAGES[id].pageLimit, id);
    assert.ok(spec.packages[id].requirements.length >= 5);
  }
  assert.throws(() => starterDir("/s", { name: "../x", version: "1" }), /Invalid starter/);
  assert.deepEqual(previewConfigProblems(STARTER), [], "the approved starter config is deployable as a preview");
});

test("[AIB-RUNNER] starter check passes structurally, fails while placeholders remain, and enforces the package page limit", () => {
  assert.equal(check(STARTER, "--allow-placeholders").code, 0);
  const r = check(STARTER);
  assert.equal(r.code, 1);
  assert.match(r.out, /STARTER-PLACEHOLDER/);
  const site = tmp();
  cpSync(STARTER, site, { recursive: true });
  for (let i = 1; i <= 2; i++) {
    const html = readFileSync(path.join(site, "public", "about.html"), "utf8").replace(/About —/, `Extra ${i} —`);
    writeFileSync(path.join(site, "public", `extra${i}.html`), html);
  }
  assert.match(check(site, "--allow-placeholders", "--package", "starter").out, /6 pages exceed the starter package limit of 5/);
  const biz = check(site, "--allow-placeholders", "--package", "business");
  assert.doesNotMatch(biz.out, /exceed/);
  assert.match(biz.out, /missing canonical link/, "business requires expanded SEO");
});

test("[AIB-RUNNER] starter check catches broken links, missing alt, unlabeled inputs and unbalanced tags", () => {
  const site = tmp();
  cpSync(STARTER, site, { recursive: true });
  const f = path.join(site, "public", "services.html");
  writeFileSync(f, readFileSync(f, "utf8")
    .replace("</ul>\n      </div>", '</ul><img src="assets/img/x.png"><a href="missing.html">Missing</a><a href="contact.html#nope">Bad anchor</a><input name="q"><div>\n      </div>'));
  const out = check(site, "--allow-placeholders").out;
  assert.match(out, /broken internal reference "missing\.html"/);
  assert.match(out, /broken internal reference "assets\/img\/x\.png"/);
  assert.match(out, /has no alt attribute/);
  assert.match(out, /anchor "#nope" not found/);
  assert.match(out, /form control "q" has no label/);
  assert.match(out, /unclosed element|unexpected <\//);
});

test("[AIB-RUNNER] contact endpoint stub is clearly unconfigured: validates, never claims a send", async () => {
  const mod = await import(path.join(STARTER, "src", "worker.js")) as { default: { fetch(r: Request, env: Record<string, unknown>): Promise<Response> } };
  const env = { CONTACT_MAIL_PROVIDER: "", ASSETS: { fetch: async () => new Response("asset") } };
  const form = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
  const post = (fields: Record<string, string>, e: Record<string, unknown> = env) => mod.default.fetch(new Request("https://site.test/api/contact", { method: "POST", body: form(fields) }), e);
  const bad = await post({ name: "", email: "nope", message: "" });
  assert.equal(bad.status, 422);
  const ok = await post({ name: "Ann", email: "ann@example.com", message: "Hi" });
  assert.equal(ok.status, 503);
  assert.deepEqual(await ok.json(), { ok: false, configured: false, error: "The contact form is not connected yet. Please use the email address or phone number on this page." });
  const named = await post({ name: "Ann", email: "ann@example.com", message: "Hi" }, { ...env, CONTACT_MAIL_PROVIDER: "resend" });
  assert.equal(named.status, 501, "a provider name alone is not an integration");
  const spam = await post({ name: "x", email: "x@y.z", message: "m", company_website: "http://spam" });
  assert.equal(spam.status, 200);
  assert.equal((await mod.default.fetch(new Request("https://site.test/api/contact"), env)).status, 405);
  assert.equal(await (await mod.default.fetch(new Request("https://site.test/about.html"), env)).text(), "asset");
  assert.match(readFileSync(path.join(STARTER, "src", "worker.js"), "utf8"), /CONTACT FORM: UNCONFIGURED/);
});

test("[AIB-RUNNER] skills manifest names the Founder's toolkit with sources and required flags; provisioning copies only listed skills", async () => {
  const m = loadManifest(path.join(RUNNER_DIR, "skills", "manifest.json"));
  const titles = Object.values(m.skills).map((s) => s.title);
  for (const t of ["Frontend Design", "UI/UX Pro Max", "Taste Skill", "Impeccable", "Emil design engineering", "Design Auditor", "Web Design Guidelines", "DESIGN.md references", "Image to Code", "Webapp Testing", "Playwright"]) {
    assert.ok(titles.includes(t), t);
  }
  for (const wf of Object.values(m.workflows)) {
    assert.ok(wf.skills.some((s) => s.required) && wf.skills.some((s) => !s.required));
    for (const t of ["git", "node", "npm", "chromium"]) assert.ok(wf.tools.includes(t), t);
  }
  const src = makeSkillsDir(m);
  writeFileSync(path.join(src, "not-listed-skill.md"), "x");
  const env = { PATH: process.env.PATH ?? "", HOME: tmp() };
  const pf = await preflight({ manifest: testManifest(), workflow: "custom-app", skillsSourceDir: src, sandbox: "off", env });
  assert.ok(pf.ok, pf.errors.join("; "));
  const repo = tmp();
  const names = provisionSkills(repo, pf.skills);
  assert.deepEqual(names.sort(), m.workflows["custom-app"].skills.map((s) => s.name).sort());
  assert.ok(!existsSync(path.join(repo, ".claude", "skills", "design-taste-frontend")), "skills outside the workflow are not copied");
  // Pinned hash mismatch fails a required skill.
  const pinned = testManifest();
  pinned.skills["frontend-design"].sha256 = "0".repeat(64);
  const pf2 = await preflight({ manifest: pinned, workflow: "custom-app", skillsSourceDir: src, sandbox: "off", env });
  assert.ok(!pf2.ok);
  assert.match(pf2.errors.join(" "), /sha256 .* does not match the pinned/);
});

test("[AIB-RUNNER] poll loop backs off while idle and runs a claimed job once [mock SDK]", async () => {
  const cp = await startFakeControlPlane({ jobs: [] });
  try {
    const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(testManifest()), pollMinMs: 10, pollMaxMs: 40, ...SDK_OPT_IN });
    const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: "r" });
    const sleeps: number[] = [];
    let polls = 0;
    const jobs = await runLoop({ cfg, client, queryFn: fakeSdk(happyAgent()).queryFn, manifest: testManifest(), logger: silentLogger,
      shouldStop: () => polls >= 4, sleep: async (ms) => { sleeps.push(ms); polls++; } });
    assert.equal(jobs, 0);
    assert.deepEqual(sleeps, [10, 15, 23, 35]);
    cp.jobs.push(makeJob());
    const ran = await runLoop({ cfg, client, queryFn: fakeSdk(happyAgent()).queryFn, manifest: testManifest(), logger: silentLogger, shouldStop: () => false, once: true });
    assert.equal(ran, 1);
    assert.equal(cp.byPath("complete")[0].body.outcome, "ready_for_review");
  } finally { await cp.close(); }
});
