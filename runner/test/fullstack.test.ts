// Full-stack builder V2 and the permanent quality engine. The starter's own acceptance gates run here for real
// (scripts/gates.mjs against the real Worker code and a local SQLite D1); jobs use a FAKE model, FAKE docker and a
// FAKE control plane. Nothing here is GPU or staging evidence: the real Node 1 / staging runs are in CONTINUITY §8.
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { buildFixtureSite } from "./fixtures/fullstack/site.ts";
import { score, scorecardOutstanding, requestedCapabilities, CRITERIA } from "../src/quality.ts";
import type { GatesFile, ScoreInput } from "../src/quality.ts";
import type { CheckOutcome } from "../src/checks.ts";
import { runJob, trustedVerifications } from "../src/job.ts";
import type { JobDeps } from "../src/job.ts";
import { ControlPlaneClient } from "../src/control-plane.ts";
import { silentLogger } from "../src/log.ts";
import { MockAdvisor, DeterministicReviewer } from "../src/orchestrator/advisors.ts";
import { RUNNER_DIR, tmp, startFakeControlPlane, startFakeModel, fakeDocker, makeJob, makeBrief, makeConfig, makeSkillsDir, testManifest, claimFrom, SECRET, POLLUTED_ENV } from "./helpers.ts";
import type { FakeModelReply, FakeModelRequest } from "./helpers.ts";

const STARTER = path.join(RUNNER_DIR, "starters", "fullstack-v1");
const fixture = (n: string) => JSON.parse(readFileSync(path.join(RUNNER_DIR, "test", "fixtures", "fullstack", `${n}.json`), "utf8"));
const site = (cfg: unknown) => buildFixtureSite(STARTER, path.join(tmp("aib-fs-"), "site"), cfg);
function gates(dir: string, pkg: string, brief?: unknown): { code: number | null; out: GatesFile & { summary: { failed: string[]; pendingExternal: string[] }; scopeChanges: { feature: string }[] } } {
  if (brief) writeFileSync(path.join(dir, "BRIEF.json"), JSON.stringify(brief));
  const r = spawnSync(process.execPath, ["--no-warnings", "scripts/gates.mjs", "--package", pkg, "--json"], { cwd: dir, encoding: "utf8", timeout: 300_000 });
  // The last line is the integrity digest of gates.json (checked by the runner); the rest is the JSON report.
  const lines = r.stdout.trimEnd().split("\n");
  const digest = /^CRESTMONT-GATES-SHA256 ([0-9a-f]{64})$/.exec(lines.at(-1) ?? "");
  assert.ok(digest, "gates print their digest line last");
  assert.equal(createHash("sha256").update(readFileSync(path.join(dir, ".crestmont", "quality", "gates.json"))).digest("hex"), digest[1], "the digest is of the gates.json written");
  return { code: r.status, out: JSON.parse(lines.slice(0, -1).join("\n")) };
}
const findings = (g: ReturnType<typeof gates>, id: string) => g.out.gates[id].findings.join("\n");

test("[AIB-V2] the website's protected package matrix equals the runner's starter manifest (one source of truth)", () => {
  const manifest = JSON.parse(readFileSync(path.join(STARTER, "starter.json"), "utf8"));
  const copy = JSON.parse(readFileSync(path.join(STARTER, "scripts", "packages.json"), "utf8"));
  assert.deepEqual(copy.packages, manifest.packages);
  for (const f of manifest.protected) assert.ok(existsSync(path.join(STARTER, f)), `protected file ${f} exists`);
  assert.equal(manifest.quality, "crestmont.quality-scorecard/1");
  for (const p of ["starter", "business", "premium", "custom"]) assert.ok(manifest.packages[p].capabilities.includes("contact"), `${p} has a working contact form`);
});

// ── cross-industry acceptance (independent fixtures, one reusable foundation, no industry hardcoding) ──

for (const [name, pkg, expectE] of [["service-area", "business", "pending_external"], ["appointment", "business", "pending_external"], ["transaction", "premium", "pending_external"], ["starter-contact", "starter", "pending_external"]] as const) {
  test(`[AIB-V2] cross-industry: the ${name} business (${pkg} package) passes every required gate on the same foundation; provider-side verification stays pending without the customer's accounts`, () => {
    const g = gates(site(fixture(name)), pkg);
    assert.equal(g.code, 0, JSON.stringify(g.out.summary));
    assert.deepEqual(g.out.summary.failed, []);
    for (const id of ["A", "B", "C", "D", "F", "G", "J"]) assert.equal(g.out.gates[id].status, "pass", `${id}: ${findings(g, id)}`);
    assert.equal(g.out.gates.E.status, expectE, "never 'pass' without a provider-side verification");
    assert.equal(g.out.tests!.failed, 0);
  });
}

test("[AIB-V2] the starter as shipped (unconfigured, placeholder pages) fails acceptance", () => {
  const dir = path.join(tmp("aib-fs-"), "raw");
  buildFixtureSite(STARTER, dir, JSON.parse(readFileSync(path.join(STARTER, "business.config.json"), "utf8")));
  // Undo the fixture's page writing: the shipped starter pages.
  for (const f of ["index.html"]) writeFileSync(path.join(dir, "public", f), readFileSync(path.join(STARTER, "public", f)));
  const g = gates(dir, "business");
  assert.equal(g.code, 1);
  assert.match(findings(g, "A"), /configured must be true/);
  assert.match(findings(g, "B"), /STARTER-PLACEHOLDER/);
});

test("[AIB-V2] placeholder functionality fails: a form that posts nowhere, an href=\"#\" control, missing booking widget", () => {
  const dir = site(fixture("service-area"));
  const contact = path.join(dir, "public", "contact.html");
  writeFileSync(contact, readFileSync(contact, "utf8").replace('<form data-api="/api/contact"', '<form action="#"').replace("<p>", '<p><a href="#">Call now</a> '));
  rmSync(path.join(dir, "public", "book.html"));
  const g = gates(dir, "business");
  assert.equal(g.code, 1);
  assert.match(findings(g, "B"), /does not post to a site endpoint/);
  assert.match(findings(g, "B"), /empty or # href/);
  assert.match(findings(g, "A"), /booking is enabled but no page has the booking widget/);
});

test("[AIB-V2] requirements gate: a requested, included feature must be enabled; one outside the package is a recorded scope change; missing facts are never invented", () => {
  const cfg = fixture("starter-contact");
  const brief = makeBrief({ customerData: { ...makeBrief().customerData, features: [{ key: "contact_form", details: "" }, { key: "booking", details: "appointments" }] } });
  const onStarter = gates(site(cfg), "starter", brief);
  assert.equal(onStarter.code, 0, "booking is not in the Starter package: not built, not a failure");
  assert.deepEqual(onStarter.out.scopeChanges.map((s) => s.feature), ["booking"]);
  const onBusiness = gates(site(cfg), "business", brief);
  assert.equal(onBusiness.code, 1);
  assert.match(findings(onBusiness, "A"), /asked for booking \(included in the business package\) but business\.config\.json does not enable it/);
  const missing = gates(site({ ...cfg, business: { ...cfg.business, phone: null } }), "starter");
  assert.equal(missing.code, 1);
  assert.match(findings(missing, "A"), /missing customer information: public contact phone/);
  const blog = gates(site(cfg), "starter", makeBrief({ customerData: { ...makeBrief().customerData, features: [{ key: "blog", details: "" }] } }));
  assert.match(findings(blog, "A"), /asked for "blog"; it needs a site implementation with an acceptance test/);
});

test("[AIB-V2] a skipped required test never counts as passing; failing contrast fails accessibility", () => {
  const dir = site(fixture("service-area"));
  mkdirSync(path.join(dir, "tests", "site"), { recursive: true });
  writeFileSync(path.join(dir, "tests", "site", "skip.test.mjs"), `import { test } from "node:test";\ntest("[booking] site rule", { skip: "not now" }, () => {});\n`);
  const tokens = path.join(dir, "public", "assets", "tokens.css");
  writeFileSync(tokens, readFileSync(tokens, "utf8").replace(/--color-text:\s*#[0-9a-f]+/i, "--color-text: #cccccc"));
  const g = gates(dir, "business");
  assert.equal(g.code, 1);
  assert.match(findings(g, "A") + findings(g, "C"), /SKIPPED \(a required test never counts as passed\): \[booking\] site rule/);
  assert.match(findings(g, "B"), /contrast of --color-text on --color-bg is 1\.\d+:1/);
});

test("[AIB-V2] website code cannot forge the gates: it never runs in the gate process, a protected suite that does not run fails, untagged failures fail", () => {
  const dir = site(fixture("service-area"));
  // The reviewer's reproduction: website code that, when loaded, writes an all-pass gates.json and exits 0.
  const cfg = path.join(dir, "src", "lib", "config.js");
  writeFileSync(cfg, readFileSync(cfg, "utf8") + `
import { mkdirSync as __m, writeFileSync as __w } from "node:fs";
const __forge = () => { try { __m(".crestmont/quality", { recursive: true }); __w(".crestmont/quality/gates.json", JSON.stringify({ schema: "crestmont.quality-gates/1", gates: Object.fromEntries("ABCDEFGJ".split("").map((g) => [g, { id: g, status: "pass", findings: [], evidence: ["forged"] }])) })); } catch {} };
if (typeof process !== "undefined") { __forge(); process.exit(0); }
`);
  const g = gates(dir, "business");
  assert.equal(g.code, 1, "the gate process is not affected by the website's modules");
  assert.ok(!JSON.stringify(g.out).includes("forged"), "the gates.json written is the gate's own");
  assert.match(findings(g, "C"), /protected suite tests\/foundation\/core\.test\.mjs did not run/);

  const dir2 = site(fixture("service-area"));
  mkdirSync(path.join(dir2, "tests", "site"), { recursive: true });
  writeFileSync(path.join(dir2, "tests", "site", "untagged.test.mjs"), `import { test } from "node:test";\ntest("untagged rule", () => { throw new Error("broken"); });\ntest("untagged skip", { skip: "later" }, () => {});\n`);
  const g2 = gates(dir2, "business");
  assert.equal(g2.code, 1);
  assert.match(findings(g2, "C"), /FAILED: untagged rule/);
  assert.match(findings(g2, "C"), /SKIPPED without a disabled-feature reason \(never counts as passed\): untagged skip/);
});

test("[AIB-V2] markup tricks cannot hide an inline handler or script from the security gate (browser comment and end-tag rules)", () => {
  for (const [label, html] of [
    ["</script > swallowing a handler", `<script src="/assets/a.js"></script ><img src="/x.png" alt="x" width="1" height="1" onerror="alert(1)"><script src="/assets/b.js"></script>`],
    ["--!> ends a comment in browsers", `<!-- note --!><button type="button" onclick="alert(1)">Go</button> -->`],
    ["abrupt <!--> comment", `<!--><img src="/x.png" alt="x" width="1" height="1" onload="alert(1)">-->`],
    ["inline script closed as </script >", `<script>alert(1)</script >`],
  ] as const) {
    const dir = site(fixture("starter-contact"));
    const page = path.join(dir, "public", "index.html");
    writeFileSync(page, readFileSync(page, "utf8").replace("</main>", `${html}</main>`));
    const g = gates(dir, "starter");
    assert.equal(g.code, 1, label);
    assert.match(findings(g, "F"), /inline (event handler|script)/, label);
  }
});

test("[AIB-V2] provider verification comes only from the runner's broker record: a builder-written results file verifies nothing", () => {
  const dir = site(fixture("service-area"));
  writeFileSync(path.join(dir, ".crestmont", "integration-results.json"), JSON.stringify([{ operation: "stripe.verify_test_key", status: "passed" }, { operation: "resend.verify_sending_domain", status: "passed" }]));
  assert.equal(gates(dir, "business").out.gates.E.status, "pending_external", "fabricated results ignored");
  const jobDir = tmp("aib-jobdir-");
  writeFileSync(path.join(jobDir, "integration-operations-done.json"), JSON.stringify({ "stripe.verify_test_key": { status: "passed" }, "resend.verify_sending_domain": { status: "passed" } }));
  mkdirSync(path.join(dir, ".crestmont", "quality"), { recursive: true });
  writeFileSync(path.join(dir, ".crestmont", "quality", "verifications.json"), JSON.stringify(trustedVerifications(jobDir)));
  assert.equal(gates(dir, "business").out.gates.E.status, "pass", "verified by the runner's own record");
});

// ── the quality scorecard ──

const DIGEST = "d".repeat(64);
const okCheck = (id: string): CheckOutcome => ({ id, label: id, command: id, ok: true, code: 0, timedOut: false, outputTail: "", ...(id === "quality-gates" ? { gatesDigest: DIGEST } : {}) });
/** A failing gate makes the gate command exit non-zero, as the real script does (the runner checks they agree). */
const gateExit1 = (i: ScoreInput) => { i.checks = i.checks.map((c) => (c.id === "quality-gates" ? { ...c, ok: false, code: 1 } : c)); return i; };
const passGate = (id: string) => ({ id, status: "pass" as const, findings: [], evidence: [`${id} ok`] });
function input(over: Partial<ScoreInput> = {}, features: Record<string, boolean> = { contact: true, admin: true }): ScoreInput {
  const gatesFile: GatesFile = { schema: "crestmont.quality-gates/1", package: "starter", features, requested: [], scopeChanges: [], missingInformation: [], gates: Object.fromEntries(["A", "B", "C", "D", "F", "G", "J"].map((g) => [g, passGate(g)])), frontend: { errors: [] } };
  gatesFile.gates.E = { id: "E", status: "not_applicable", findings: [], evidence: [] };
  (gatesFile as GatesFile & { _sha256?: string })._sha256 = DIGEST;
  const assessment = Object.fromEntries(["visual_design", "brand_consistency", "maintainability", "customer_experience"].map((k) => [k, { verdict: "pass" as const, note: "professional" }]));
  return {
    packageId: "starter", capabilities: ["contact", "admin", "notifications"], requested: ["contact"],
    checks: [okCheck("quality-gates"), okCheck("browser-check"), okCheck("credential-scan")], gates: gatesFile,
    screenshots: [{ viewport: "desktop" }, { viewport: "mobile" }],
    review: { decision: "READY_FOR_FINAL_QA", addresses: [], findings: [], nextPrompt: null, assessment, imagesSeen: 2 },
    requirements: [{ key: "page:home", status: "verified" }], criteria: [], securityFindings: [], previewDeployed: true, iteration: 1, ...over,
  };
}

test("[AIB-QUALITY] 10/10 only when every applicable criterion passes with evidence; non-applicable criteria leave the denominator", () => {
  const c = score(input());
  assert.equal(c.criteria.length, CRITERIA.length, "all 20 criteria are always evaluated");
  assert.deepEqual(c.criteria.filter((x) => !x.applicable).map((x) => x.id).sort(), ["integrations", "payments", "workflows"], "a Starter contact site has no booking, payments or integrations to score");
  assert.equal(c.applicable, 17);
  assert.equal(c.score, 10);
  assert.equal(c.eligible, true);
  assert.ok(c.criteria.filter((x) => x.applicable).every((x) => x.status === "pass" && x.evidence.length > 0), "every pass names its evidence");
});

test("[AIB-QUALITY] the same engine scores every package against its own scope: a Business site needing booking and payments cannot reach 10/10 unless they work", () => {
  const features = { contact: true, admin: true, booking: true, payments: true, notifications: true, quotes: true };
  const business = input({ packageId: "business", capabilities: ["contact", "admin", "notifications", "quotes", "booking", "payments"], requested: ["contact", "booking", "payments"] }, features);
  business.gates!.gates.E = { id: "E", status: "pass", findings: [], evidence: ["stripe verified"] };
  const ok = score(business);
  assert.equal(ok.applicable, 20);
  assert.equal(ok.eligible, true);
  business.gates!.gates.C = { id: "C", status: "fail", findings: ["FAILED: [booking] double booking"], evidence: [] };
  const broken = score(gateExit1(business));
  assert.equal(broken.eligible, false);
  assert.ok(broken.score < 10);
  assert.deepEqual(broken.criteria.filter((x) => x.status === "fail").map((x) => x.id).sort(), ["backend", "error_handling", "workflows"]);
  // A requested feature the builder did not enable is a failure, never "not applicable".
  const dropped = score({ ...input({ packageId: "business", capabilities: ["contact", "admin", "booking"], requested: ["contact", "booking"] }) });
  assert.equal(dropped.criteria.find((x) => x.id === "workflows")!.status, "fail");
});

test("[AIB-QUALITY] unsupported or fabricated evidence cannot pass: no gate run, a gates file without the runner's own gate check, a rule-based reviewer, a reviewer who saw no screenshots", () => {
  const noRun = score(input({ checks: [okCheck("browser-check"), okCheck("credential-scan")] }));
  assert.equal(noRun.eligible, false, "a gates.json the runner did not produce in this run is ignored");
  assert.ok(noRun.criteria.filter((x) => x.status === "unsupported").length >= 8);
  const rules = score(input({ review: { decision: "READY_FOR_FINAL_QA", addresses: [], findings: [], nextPrompt: null } }));
  assert.deepEqual(rules.criteria.filter((x) => x.status === "unsupported").map((x) => x.id).sort(), ["brand_consistency", "customer_experience", "maintainability", "visual_design"]);
  const blind = score(input({ review: { ...input().review!, imagesSeen: 0 } }));
  assert.equal(blind.criteria.find((x) => x.id === "visual_design")!.status, "unsupported", "a visual verdict without seeing the screenshots is not evidence");
  const noShots = score(input({ screenshots: [{ viewport: "desktop" }] }));
  assert.equal(noShots.criteria.find((x) => x.id === "mobile")!.status, "unsupported");
  assert.ok(scorecardOutstanding(noShots).some((o) => o.startsWith("quality:mobile:")));
});

test("[AIB-QUALITY] a gates file is evidence only when its bytes match the gate command's single digest and its exit status agrees", () => {
  assert.equal(score(input()).eligible, true);
  const mismatch = input(); (mismatch.gates as GatesFile & { _sha256?: string })._sha256 = "e".repeat(64);
  assert.equal(score(mismatch).eligible, false, "a file rewritten after the gate run is not evidence");
  const none = input({ checks: [{ ...okCheck("quality-gates"), gatesDigest: null }, okCheck("browser-check"), okCheck("credential-scan")] });
  assert.equal(score(none).eligible, false, "no digest (or a second one) voids the file");
  const forged = gateExit1(input());
  assert.equal(score(forged).eligible, false, "an all-pass file with a failing gate command is forged");
  assert.ok(score(forged).criteria.filter((x) => x.status === "unsupported").length >= 8);
});

test("[AIB-QUALITY] score is rounded DOWN and capped below 10 unless eligible; pending provider verification waits instead of repairing", () => {
  const one = input();
  one.gates!.gates.G = { id: "G", status: "fail", findings: ["p95 120 ms"], evidence: [] };
  const c = score(gateExit1(one));
  assert.equal(c.passed, 16);
  assert.equal(c.score, 9.4, "16/17 × 10 = 9.41 → 9.4, never rounded up");
  const ext = input({}, { contact: true, admin: true, notifications: true });
  ext.gates!.gates.E = { id: "E", status: "pending_external", findings: ["Email: no verified sending domain"], evidence: [] };
  const w = score(ext);
  assert.equal(w.eligible, false);
  assert.equal(w.waitingExternal, true);
  assert.deepEqual(w.defects, [], "nothing to repair: it waits for the customer's provider account");
  assert.deepEqual(requestedCapabilities([{ key: "booking" }, { key: "ecommerce" }]).sort(), ["booking", "contact", "payments"]);
});

// ── the quality engine inside real (mocked) builds ──

const call = (name: string, args: Record<string, unknown>): FakeModelReply => ({ toolCalls: [{ name, arguments: args }] });
const phaseOf = (r: FakeModelRequest) => { const i = r.messages.filter((m) => m.role === "user" && /^(Phase \d|Repair|This build is continuing|CONTEXT RESET)/.test(m.content ?? "")).pop()?.content ?? ""; return /Phase 1/.test(i) ? "plan" : /Phase 2/.test(i) ? "build" : /Phase 3/.test(i) ? "verify" : "repair"; };
const stepOf = (r: FakeModelRequest) => { let n = 0; for (let i = r.messages.length - 1; i >= 0 && !(r.messages[i].role === "user" && /^(Phase \d|Repair|This build is continuing)/.test(r.messages[i].content ?? "")); i--) if (r.messages[i].role === "assistant") n++; return n; };

/** A scripted "model" that applies a prepared website (as the real builder would write it) and verifies it. */
function builder(prepared: string) {
  return (r: FakeModelRequest): FakeModelReply => {
    const p = phaseOf(r), s = stepOf(r);
    const script: Record<string, FakeModelReply[]> = {
      plan: [call("write_file", { path: ".crestmont/plan.md", content: "# Plan\n- configure, pages, verify\n" }), call("finish", { summary: "planned" })],
      build: [call("run_command", { command: `cp -r ${prepared}/public ${prepared}/business.config.json ${prepared}/tests . ` }), call("finish", { summary: "built" })],
      verify: [call("run_command", { command: "node --no-warnings scripts/gates.mjs --package starter" }),
        call("report_requirement", { key: "page:home", status: "verified", evidence: "node scripts/gates.mjs: gate B pass" }),
        call("report_requirement", { key: "page:contact", status: "verified", evidence: "node scripts/gates.mjs: gate A/C contact tests pass" }),
        call("write_file", { path: ".crestmont/needs-information.json", content: "[]" }),
        // Provider-side checks are the RUNNER's (after Owner approval); the builder can only request them.
        call("write_file", { path: ".crestmont/integration-operations.json", content: JSON.stringify([{ operation: "resend.verify_sending_domain", summary: "verify the customer's sending domain" }]) }),
        call("finish", { summary: "verified" })],
      repair: [call("finish", { summary: "nothing to repair" })],
    };
    return script[p][Math.min(s, script[p].length - 1)];
  };
}

const assessed = (over: Record<string, unknown> = {}) => new MockAdvisor({ verdicts: [{ decision: "READY_FOR_FINAL_QA", addresses: [], findings: [], nextPrompt: null, imagesSeen: 2,
  assessment: { visual_design: { verdict: "pass", note: "polished on desktop and mobile" }, brand_consistency: { verdict: "pass", note: "tokens applied" }, maintainability: { verdict: "pass", note: "starter patterns kept" }, customer_experience: { verdict: "pass", note: "clear contact journey" } }, ...over }] });

/** The job's own customer (makeBrief): the website must show the brief's business facts (brief conformance). */
function forBrief(cfg: Record<string, any>) {
  const b = makeBrief().customerData.business;
  return { ...cfg, business: { ...cfg.business, name: b.name, email: b.publicEmail, phone: b.publicPhone } };
}

async function fullstackJob(cfgFile: Record<string, any>, reviewer: MockAdvisor | DeterministicReviewer, o: { emailVerified?: boolean } = {}) {
  const prepared = site(forBrief(cfgFile));
  const manifest = testManifest();
  // The Owner approved the read-only operation; the customer's own Resend key is in the runner's secrets (FAKE value).
  const approvals = o.emailVerified ? [{ id: "apr_1", kind: "integration_operation", summary: "x", operation: "resend.verify_sending_domain", status: "approved", decision_note: null }] : [];
  const cp = await startFakeControlPlane({ jobs: [makeJob({ starter: { name: "fullstack", version: "1" }, packageId: "starter", quality: "required" })],
    extraRoutes: { "approvals/list": () => ({ approvals }), "approvals/request": () => ({ id: "apr_req", status: "pending" }), "integrations/report": () => ({ updated: 1 }) } });
  const secretsDir = tmp("aib-secrets-");
  mkdirSync(path.join(secretsDir, "integrations", "prj_test1"), { recursive: true });
  writeFileSync(path.join(secretsDir, "integrations", "prj_test1", "RESEND_API_KEY"), "re_" + "f".repeat(20));
  const resendCalls: string[] = [];
  const fetchImpl = (async (url: string | URL) => { resendCalls.push(String(url)); return Response.json({ data: [{ name: "acme.example", status: "verified" }] }); }) as unknown as typeof fetch;
  const model = await startFakeModel(builder(prepared));
  const docker = fakeDocker({ screenshots: true });
  const base = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: "x" });
  const cfg = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(manifest), local: { ...base.local, baseUrl: model.url }, secretsDir });
  const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: cfg.runnerId, sleep: async () => {}, retry: { attempts: 2, baseMs: 1 } });
  const job = await claimFrom(cp);
  const deps: JobDeps = { cfg, client, manifest, logger: silentLogger, heartbeatMs: 25, interruptGraceMs: 200, processEnv: POLLUTED_ENV, dockerExecutor: docker.executor, reviewer, architect: null, fetchImpl };
  try { return { s: await runJob(job, deps), cp, resendCalls }; } finally { await model.close(); await cp.close(); }
}

test("[AIB-QUALITY] a full-stack build with a verified 10/10 within its scope completes as ready_for_review and reports its scorecard [fake model, fake docker]", async () => {
  const { s, resendCalls } = await fullstackJob(fixture("starter-contact"), assessed(), { emailVerified: true });
  assert.equal(s.outcome, "ready_for_review", String(s.complete?.error));
  assert.deepEqual(resendCalls, ["https://api.resend.com/domains"], "verified by the runner's approved read-only operation, once");
  const q = s.complete!.quality as { score: number; eligible: boolean; applicable: number };
  assert.equal(q.eligible, true);
  assert.equal(q.score, 10);
  const card = JSON.parse(readFileSync(path.join(s.workspace!, "repo", ".crestmont", "quality", "scorecard.json"), "utf8"));
  assert.equal(card.score, 10);
  assert.ok(existsSync(path.join(s.workspace!, "repo", ".crestmont", "quality", "gates.json")));
});

test("[AIB-QUALITY] a score below 10 can never enter internal approval: the rule-based reviewer cannot judge design, so the build stops for a person (no automatic retry) [fake model, fake docker]", async () => {
  const { s } = await fullstackJob(fixture("starter-contact"), new DeterministicReviewer(), { emailVerified: true });
  assert.equal(s.outcome, "stopped");
  assert.notEqual(s.outcome, "ready_for_review");
  assert.match(String(s.complete?.error), /^Quality engine: the website is not eligible for internal approval: \d\.\d\/10 .*visual_design/);
  const q = s.complete!.quality as { score: number; eligible: boolean };
  assert.equal(q.eligible, false);
  assert.ok(q.score < 10);
});

test("[AIB-QUALITY] only a provider-side verification missing: the build waits as needs_information (it is not repaired, not approved) [fake model, fake docker]", async () => {
  const { s } = await fullstackJob(fixture("starter-contact"), assessed());
  assert.equal(s.outcome, "needs_information", String(s.complete?.error));
  assert.ok((s.complete!.missingInformation ?? []).some((m) => /External integrations: .*Resend/.test(m)));
});
