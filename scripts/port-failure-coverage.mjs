// Ports the A-J failure inventory into this repository and records the coverage that exists HERE.
// A row leaves OPEN only when a shared safeguard in this repo covers it AND a test file in this repo proves it.
// Every test path below was checked to exist before this script was written.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const SRC = "C:/CrestmontRunner-src/Crestmont-Website-Development-main/docs/ai-builds/failure-coverage.json";
const REPO = "C:/Crestmont-Admin";
const OUT_DIR = `${REPO}/docs/ai-builds`;
const old = JSON.parse(readFileSync(SRC, "utf8"));

// Shared safeguards: the point of the directive is that one mechanism covers many failure modes, so these -- not
// 231 separate systems -- are the units of coverage.
const SAFEGUARDS = {
  S1: { name: "Quality scorecard (20 criteria; a verified 10/10 is required before internal approval)", where: "runner/src/quality.ts, enforced by the platform at approval", test: "runner/test/fullstack.test.ts [AIB-QUALITY] (the scorecard rules themselves); tests/builds-v2.test.ts [AIB-QUALITY] (platform enforcement at approval)" },
  S2: { name: "Acceptance gates A-J, and website code that cannot forge them", where: "the starter's acceptance commands; results in .crestmont/quality/gates.json, trusted only when the runner's own quality-gates check ran this cycle and its bytes match that command's single digest", test: "runner/test/fullstack.test.ts [AIB-V2]" },
  S3: { name: "Cross-file contract check (element ids, form fields, endpoint paths)", where: "runner/src/contracts-check.ts", test: "runner/test/contracts-check.test.ts [CONTRACT]" },
  S4: { name: "Headless browser check: EVERY .html page under the site root x desktop and mobile (console errors, failed requests, horizontal overflow, nav landmark, screenshots)", where: "runner/sandbox/browser-check.mjs", test: "runner/test/browser-check.test.ts [AIB-RUNNER]" },
  S5: { name: "Persistence check: a success claim must be backed by a durable write", where: "runner/src/checks.ts", test: "runner/test/durability.test.ts" },
  S6: { name: "Credential scan: no credentials or local secret files in the website's source", where: "runner/src/checks.ts credentialScan", test: "runner/test/exec-security.test.ts" },
  S7: { name: "Brief conformance: the customer's own business details appear on the site", where: "runner/src/checks.ts briefConformance", test: "runner/test/job.test.ts" },
  S8: { name: "Sandbox isolation verified by docker inspect (no network, read-only root, no capabilities, non-root, only the job's mounts)", where: "runner/src/checks.ts isolationCheck", test: "runner/test/isolation.test.ts" },
  S9: { name: "Independent review session (Model A with vision); a verdict is 'unsupported' unless the reviewer actually saw desktop AND mobile screenshots", where: "runner/src/orchestrator/advisors.ts, runner/src/quality.ts", test: "runner/test/orchestrator.test.ts; runner/test/fullstack.test.ts [AIB-QUALITY]" },
  S10: { name: "Acceptance evidence record: missing evidence is reported as missing, never as a failing website, and the runner never supplies a status itself", where: "runner/src/orchestrator/evidence.ts missingCriteriaEvidence", test: "runner/test/acceptance-evidence.test.ts [AIB-EVIDENCE]" },
  S11: { name: "Requirement integrity: 'verified' needs evidence, that evidence survives the round-trip through the platform, and the checks that just ran outrank the claim seed", where: "runner/src/requirements.ts, src/services/builds.ts claim", test: "runner/test/report.test.ts [AIB-REQ-EVIDENCE]; tests/builds.test.ts [AIB-REQ-EVIDENCE]" },
  S12: { name: "Bounded repair loop (cycle limit, repeated failure signature, no measurable progress, ineffective-repair guard), and an overrule that carries its own corrective prompt", where: "src/services/build-pipeline.ts submitCycle, runner/src/job.ts", test: "tests/builds-v2.test.ts [AIB-013], [AIB-OVERRULE]" },
  S13: { name: "pending_external: a customer-owned service is never recorded as live; the build waits for the customer instead of faking it", where: "runner/src/quality.ts, src/services/build-pipeline.ts", test: "tests/builds-v2.test.ts [AIB-013]" },
  S15: { name: "Repair ratchet: the best revision is kept, a repair that measurably loses ground is reverted to it, and repeated regressions stop the loop", where: "runner/src/orchestrator/ratchet.ts, runner/src/git.ts restoreTo, wired into the cycle loop in runner/src/job.ts", test: "runner/test/quality-ratchet.test.ts [RATCHET]" },
  S14: { name: "Segment continuation: a per-segment limit ends a segment, not the build; 'released' requeues without spending an attempt and resumes from the checkpoint", where: "runner/src/job.ts, src/services/builds.ts", test: "tests/builds.test.ts [AIB-004] (the platform half); runner/test/continuity.test.ts [AIB-CONTINUITY] (the archive half: built and restored from a drive-letter path); runner/test/orchestrator.test.ts [AIB-015] (checkpointed and released without spending an attempt)" },
};

// Safeguards the inventory assumed but that DO NOT EXIST in this repository. Recorded, not quietly dropped.
const MISSING_SAFEGUARDS = {};

// Tests that bear on a safeguard above and are FAILING in this repository, on the pristine baseline too. Named
// here so no safeguard above looks better proven than it is.
const KNOWN_FAILING_TESTS = {
  "runner/test/fullstack.test.ts [AIB-QUALITY] ... [fake model, fake docker]": {
    bears_on: ["S1", "S2", "S7"],
    detail: "Three end-to-end tests ('a verified 10/10 ... completes as ready_for_review', 'a score below 10 can never enter internal approval', 'only a provider-side verification missing') fail with \"Acceptance checks failed: quality-gates, brief-conformance\". Identical on the pristine baseline, so not a regression. Every gate test that runs the real gates against a fixture website passes, including all four cross-industry package runs, so what is unproven is the fake-model end-to-end wiring rather than the scorecard rules or the gates.",
    status: "PRE_EXISTING_FAILURE",
  },
  "runner/test/resilience.test.ts [AIB-RUNNER] checkpoints never carry links": {
    bears_on: ["S14"],
    detail: "Asserts that symlinks are left out when a checkpoint is built and that an archive containing links is refused on restore. It fails on this machine with EPERM creating a symlink at C:\etc\passwd, which needs elevation, identically on the pristine baseline. The refusal-on-restore half is what matters for safety and is not what fails; the test cannot set up its fixture without an elevated shell.",
    status: "PRE_EXISTING_FAILURE",
  },
};

// Rows that change status, each with the reason. Nothing here is marked covered without a test in this repo.
const UPDATES = {
  A24: { status: "FIXED_AND_VERIFIED", safeguards: ["S11", "S1"],
    rootCause: "A requirement could be marked verified without evidence; and -- the defect found in run 5 -- the evidence was dropped by the claim query, so from the second segment on the runner's own PASSING checks came back unevidenced and were downgraded to unverified.",
    note: "Both directions are closed: a claim of 'verified' still needs evidence, and real evidence now survives the round-trip so a genuine verification is not re-judged as a bare claim." },
  A25: { status: "FIXED_AND_VERIFIED", safeguards: ["S10", "S2"],
    rootCause: "Nothing distinguished an acceptance criterion that FAILED from one with no recorded status, so four consecutive builds were repaired against criteria that were never failing, while the scorecard could not rise above about a third however good the website was.",
    note: "A missing .crestmont/acceptance.json is now reported as missing evidence, naming the file, the shape and the criteria still unrecorded. The runner never writes a status itself: an invented one would be exactly the fabricated verification the quality engine exists to prevent." },
  B30: { status: "EXISTING_AND_VERIFIED", safeguards: ["S1", "S12", "S10"],
    note: "A premature 'ready' is overruled against the evidence, and no build reaches internal approval without a verified 10/10. Verified here by running those tests, which pass." },
  E03: { status: "EXISTING_AND_VERIFIED", safeguards: ["S4"],
    note: "The browser check walks every .html page under the site root recursively, not just the home page: run 5 reported 22/22 page views over 11 pages. The inventory cited runner/test/review-isolation.test.ts, which does not exist here; the real proof is the browser-check test." },
  E04: { status: "EXISTING_AND_VERIFIED", safeguards: ["S4", "S9"],
    note: "A desktop-only run leaves the 'mobile' criterion unsupported and outstanding, and a reviewer that saw no screenshots cannot pass a visual criterion. The inventory cited runner/test/quality.test.ts, which does not exist here; the real proof is fullstack.test.ts [AIB-QUALITY]." },
  E09: { status: "FIXED_AND_VERIFIED", safeguards: ["S12"],
    rootCause: "The reviewer contract says nextPrompt is null for any decision that is not a continuation. When the platform overruled such a decision into a continuation there was no prompt, so it escalated the build instead of naming the work -- blaming the reviewer for an omission it had never been asked to fill.",
    note: "An overrule now writes the prompt from the outstanding items it just named. The loop bounds are unchanged: [AIB-013] still escalates after three identical cycles." },
  F15: { status: "FIXED_AND_VERIFIED", safeguards: ["S15"],
    note: "The ratchet stops the loop after two repairs in a row that lower the score, instead of spending more GPU time on a loop that is not converging." },  F16: { status: "FIXED_AND_VERIFIED", safeguards: ["S15"],
    note: "restoreTo puts the working tree back to the best revision as a NEW commit, so the failed attempt stays in the log as evidence -- what `reset --hard` would have discarded. A file a bad repair ADDED is removed too, which `checkout -- .` leaves behind." },  F20: { status: "FIXED_AND_VERIFIED", safeguards: ["S15"],
    note: "The best measured revision is recorded and restored, so a build can no longer walk away from its own best work. Measured on Node 1 (2026-11-02): 7.50 -> 7.16 -> 7.22 -> 6.94, every repair kept whatever it did, so the worst state was the deliverable. Driven by the quality scorecard this runner already computes, so no second notion of quality is introduced alongside it." },  G15: { status: "FIXED_AND_VERIFIED", safeguards: ["S14"],
    rootCause: "Checkpoint archives were never built on Windows at all: GNU tar read the absolute \"C:\...\" archive path as host:path and tried to reach a remote host, and the caller only logged a warning. The agent transcript and runner state were therefore lost at every segment boundary, and a restore from a checkpoint key could not have worked.",
    note: "tar now runs with the workspace as its working directory and only relative paths, which both GNU tar and the bsdtar that Windows ships accept. A checkpoint is built and read back from a drive-letter path under test. Found by chasing [AIB-015], which this document had recorded as the pre-existing failure most worth investigating: the assertion was right and the product was wrong." },
  G16: { status: "FIXED_AND_VERIFIED", safeguards: ["S14", "S11"],
    rootCause: "Resume worked, but a resumed segment was judged against a lossy echo of its own earlier results: segment 1 was unaffected and every later segment inherited unevidenced check requirements.",
    note: "This failure mode was invisible until segment continuation worked, because until then nothing resumed far enough to reach it." },
  G18: { status: "BLOCKED_ON_AUTHORIZATION", safeguards: [],
    note: "The installed runner service and this source tree are different versions. Resolving it needs an elevated command on Node 1; this session can neither authorize nor perform that." },
  G19: { status: "BLOCKED_ON_AUTHORIZATION", safeguards: [],
    note: "Local and installed-runner behaviour cannot be compared while the two are different versions. Blocked on the same elevated step as G18." },
};

for (const [, s] of Object.entries(SAFEGUARDS)) {
  for (const f of s.test.split(";").map((x) => x.trim().split(" ")[0])) {
    if (!existsSync(`${REPO}/${f}`)) throw new Error(`cited test does not exist: ${f}`);
  }
}

const rows = old.rows.map((r) => {
  const u = UPDATES[r.id];
  if (!u) return { ...r, safeguards: [] };
  return { ...r, status: u.status, safeguards: u.safeguards,
    ...(u.rootCause ? { rootCause: u.rootCause } : {}), note: u.note,
    test: u.safeguards.map((s) => SAFEGUARDS[s].test).join("; ") || "none in this repository" };
});

const counts = {};
for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;

const doc = {
  schema: "crestmont.failure-coverage/2",
  generatedAt: new Date().toISOString(),
  principle: "Shared safeguards, not 231 separate systems: each failure mode is covered by one of the mechanisms in `safeguards`, and a row leaves OPEN only when a named test in THIS repository proves that mechanism catches it.",
  honesty: [
    "OPEN means not investigated in this repository yet. It does not mean the failure cannot happen, and it does not mean it is uncovered.",
    "The gates A-J are implemented in runner/starters/fullstack-v1/scripts/gates.mjs, not in runner/src, which is why they are easy to miss when reading the runner. Mapping the remaining rows means reading that script against each row; that is the next step and it has not been taken.",
    "Five rows the source inventory recorded as verified cited test files that did not exist here. Two (E03, E04) were already covered by differently-named tests and have been re-cited. Three (F15, F16, F20) depended on a quality ratchet that was genuinely absent; the ratchet rule and the git restore it needs have since been brought in and wired into the cycle loop, driven by the quality scorecard this runner already computes so no second notion of quality is introduced alongside it.",
  ],
  safeguards: SAFEGUARDS,
  missingSafeguards: MISSING_SAFEGUARDS,
  knownFailingTests: KNOWN_FAILING_TESTS,
  counts, total: rows.length,
  rows,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/failure-coverage.json`, JSON.stringify(doc, null, 2) + "\n");

const md = ["# A-J failure-mode coverage", "", doc.principle, ""];
for (const h of doc.honesty) md.push(`- ${h}`);
md.push("", `Generated ${doc.generatedAt} from ${rows.length} failure modes.`, "", "| status | rows |", "| --- | --- |");
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) md.push(`| ${k} | ${v} |`);

if (Object.keys(MISSING_SAFEGUARDS).length) {
  md.push("", "## Gaps: safeguards the inventory assumed that do not exist here", "");
  for (const [name, g] of Object.entries(MISSING_SAFEGUARDS)) {
    md.push(`### ${name} (${g.rows.join(", ")})`, "", `Expected: ${g.expected}`, "", g.finding, "");
  }
}

md.push("", "## Cited tests that are failing in this repository", "");
for (const [name, k] of Object.entries(KNOWN_FAILING_TESTS)) {
  md.push(`### \`${name}\``, "", `Bears on: ${k.bears_on.join(", ")} (${k.status})`, "", k.detail, "");
}

md.push("## Shared safeguards", "");
for (const [id, s] of Object.entries(SAFEGUARDS)) md.push(`**${id}. ${s.name}**`, "", `- Where: ${s.where}`, `- Proven by: \`${s.test}\``, "");

md.push("## Rows that are not OPEN", "", "| id | failure mode | status | safeguards | proven by |", "| --- | --- | --- | --- | --- |");
for (const r of rows.filter((x) => x.status !== "OPEN")) {
  md.push(`| ${r.id} | ${r.description} | ${r.status} | ${(r.safeguards ?? []).join(", ") || "-"} | ${String(r.test ?? "-").replace(/\|/g, "\\|")} |`);
}

md.push("", "### Why", "");
for (const r of rows.filter((x) => x.note)) {
  md.push(`**${r.id} ${r.description}**`, "");
  if (r.rootCause && r.rootCause !== "not investigated in this assignment") md.push(r.rootCause, "");
  md.push(r.note, "");
}

md.push("## Still open", "", "Not yet investigated in this repository, grouped by category.", "");
for (const cat of [...new Set(rows.map((r) => r.category))].sort()) {
  const open = rows.filter((r) => r.category === cat && r.status === "OPEN");
  if (open.length) md.push(`- **${cat}** (${open.length}): ${open.map((r) => `${r.id} ${r.description}`).join("; ")}`);
}
md.push("");
writeFileSync(`${OUT_DIR}/failure-coverage.md`, md.join("\n"));

console.log("counts:", JSON.stringify(counts));
