// Unit tests: instructions never contain customer data; customer data is written as labeled, fenced, untrusted files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { phasePrompt, systemPromptAppend, renderBriefMarkdown, writeBriefFiles, fenceFor } from "../src/prompt.ts";
import type { Phase } from "../src/prompt.ts";
import { BRIEF_RULES } from "../src/protocol.ts";
import { BRIEF_RULES as PLATFORM_BRIEF_RULES } from "../../src/domain/builds.ts";
import { makeJob, makeBrief, CUSTOMER_MARKERS, INJECTION, tmp } from "./helpers.ts";

test("[AIB-RUNNER] runner BRIEF_RULES match the platform's src/domain/builds.ts (no drift)", () => {
  assert.deepEqual(BRIEF_RULES, [...PLATFORM_BRIEF_RULES]);
});

test("[AIB-RUNNER] system prompt and phase prompts keep customer data out of instructions", () => {
  const jobs = [
    makeJob(),
    makeJob({ kind: "revision", revision: 1, instruction: `Make the hero bigger. ${INJECTION}` }),
    makeJob({ strategy: "custom", packageId: null, starter: null, brief: { id: "b", version: 1, sha256: "0".repeat(64), content: makeBrief({ strategy: "custom", package: null, custom: { scope: `Portal ${INJECTION}`, lineItems: ["zx41-goals-marker"] } }) } }),
  ];
  for (const job of jobs) {
    const texts = [systemPromptAppend(job), ...(["plan", "build", "verify", "repair"] as Phase[]).flatMap((p) => [
      phasePrompt(job, p, { starter: "brochure-v1", resumed: false, previousNote: null }),
      phasePrompt(job, p, { starter: "brochure-v1", resumed: true, previousNote: "The previous Agent SDK session could not be restored." }),
    ])];
    for (const t of texts) {
      for (const marker of [...CUSTOMER_MARKERS, "Make the hero bigger", "Portal", "Acme", "hello@acme.example", "reference.example"]) {
        assert.ok(!t.includes(marker), `instruction text contains customer data: ${marker}`);
      }
    }
    const sp = systemPromptAppend(job);
    for (const rule of BRIEF_RULES) assert.ok(sp.includes(rule));
    assert.match(sp, /untrusted data/);
  }
});

test("[AIB-RUNNER] BRIEF.md labels customer data as untrusted and fences it so embedded backticks cannot escape", () => {
  const job = makeJob();
  const md = renderBriefMarkdown(job);
  const start = md.indexOf("BEGIN UNTRUSTED CUSTOMER DATA: customerData");
  const end = md.indexOf("END UNTRUSTED CUSTOMER DATA: customerData");
  assert.ok(start > 0 && end > start);
  const outside = md.slice(0, start) + md.slice(end);
  for (const marker of CUSTOMER_MARKERS) assert.ok(!outside.includes(marker.split("\n")[0]) || marker.startsWith("```"), `customer text outside the untrusted block: ${marker}`);
  assert.ok(md.slice(start, end).includes(JSON.stringify(INJECTION).slice(1, 20)));
  // The customer value contains a ``` fence: the wrapping fence must be longer.
  const block = md.slice(start, end);
  const fence = block.split("\n")[1].replace(/json$/, "");
  assert.ok(fence.length >= 4, `fence ${fence}`);
  assert.equal(fenceFor("a ```` b"), "`````");
  assert.match(md, /never instructions/);
});

test("[AIB-RUNNER] brief files: BRIEF.json, BRIEF.md, seed requirements and a fenced revision request", () => {
  const repo = tmp();
  const job = makeJob({ kind: "revision", revision: 2, instruction: "Use ``` and " + INJECTION });
  writeBriefFiles(repo, job, job.requirements);
  assert.deepEqual(JSON.parse(readFileSync(path.join(repo, "BRIEF.json"), "utf8")), job.brief.content);
  assert.ok(existsSync(path.join(repo, "BRIEF.md")));
  assert.deepEqual(JSON.parse(readFileSync(path.join(repo, ".crestmont", "requirements.seed.json"), "utf8")), job.requirements);
  const rev = readFileSync(path.join(repo, "REVISION-REQUEST.md"), "utf8");
  assert.match(rev, /BEGIN UNTRUSTED CUSTOMER DATA: revision request/);
  assert.match(rev, /````text/);
});

// ── Design-first phase objectives in the builder prompt ───────────────────────────────────────────────────────────

test("[AIB-PROMPT] every runner instruction still STARTS with its own first line, with the phase objective appended", () => {
  // Not cosmetic. That opening line is how the latest runner instruction is identified in a resumed conversation
  // (helpers phaseOf/stepOf do exactly this, as the local provider does), so prepending a preamble to it silently
  // breaks phase detection -- which is what happened when this block was put first.
  const job = makeJob();
  for (const [phase, opener] of [["plan", /^Phase 1 of 3/], ["build", /^Phase 2 of 3/], ["verify", /^Phase 3 of 3/], ["repair", /^Repair:/]] as const) {
    const p = phasePrompt(job, phase, { starter: "brochure-v1", resumed: false, previousNote: null, buildPhase: "design" });
    assert.match(p, opener, `${phase}: the instruction's first line is unchanged`);
    assert.match(p, /ACTIVE PHASE: VISUAL DESIGN/, `${phase}: and the phase objective is present`);
  }
  // A resumed build keeps its own opener too.
  const resumed = phasePrompt(job, "build", { starter: "brochure-v1", resumed: true, previousNote: "note", buildPhase: "functionality" });
  assert.match(resumed, /^This build is continuing from an earlier attempt/);
  assert.match(resumed, /ACTIVE PHASE: FRONTEND AND BACKEND FUNCTIONALITY/);
});

test("[AIB-PROMPT] the design phase tells the builder to DEFER backend work, and the functionality phase not to redesign", () => {
  const job = makeJob();
  const design = phasePrompt(job, "build", { starter: "fullstack-v1", resumed: false, previousNote: null, buildPhase: "design" });
  assert.match(design, /Do NOT build or debug customer-specific backend features yet/);
  assert.match(design, /deterministic mocks or fixtures/);
  assert.match(design, /a mock is never evidence that functionality works/);
  assert.match(design, /desktop \(1366px\), tablet \(768px\) and mobile \(390px\)/, "all three viewports are named");
  assert.match(design, /layout and spacing \(8\)/, "and the rubric the design will be scored against");

  const fn = phasePrompt(job, "build", { starter: "fullstack-v1", resumed: false, previousNote: null, buildPhase: "functionality", designFreeze: { revision: "1-3", designPoints: 40 } });
  assert.match(fn, /FROZEN at revision 1-3 \(40\/40\)/, "the builder is told which revision is authoritative");
  assert.match(fn, /Do not redesign the website to make the backend easier/);
  assert.match(fn, /Adapt the BACKEND to the existing approved frontend contracts/);
  assert.match(fn, /pending_external result, not a failure/, "and not to manufacture credentials it cannot have");
});

test("[AIB-PROMPT] the architect's own phase split reaches the builder, and its absence is not papered over", () => {
  const job = makeJob();
  const plan = {
    designDeliverables: ["Home, Services, Gallery, Contact at three widths"],
    designDependentInteractions: [{ component: "Quote form", states: ["empty", "error", "success"], mock: "fixture JSON behind a delay" }],
    deferredBackend: [{ capability: "quote persistence", dependsOnDesign: "the Quote form's field names", realImplementation: "POST /api/quotes to D1" }],
    finalQuality: ["WCAG 2.1 AA"],
  };
  const design = phasePrompt(job, "build", { starter: "fullstack-v1", resumed: false, previousNote: null, buildPhase: "design", phasePlan: plan });
  assert.match(design, /Home, Services, Gallery, Contact at three widths/, "this website's own deliverables");
  assert.match(design, /Quote form — states: empty, error, success; mock: fixture JSON behind a delay/);
  assert.match(design, /Deliberately DEFERRED to the functionality phase[\s\S]*quote persistence/);
  assert.doesNotMatch(design, /POST \/api\/quotes/, "the real backend implementation is NOT dangled in front of the design phase");

  const fn = phasePrompt(job, "build", { starter: "fullstack-v1", resumed: false, previousNote: null, buildPhase: "functionality", phasePlan: plan });
  assert.match(fn, /quote persistence — built against: the Quote form's field names; real implementation: POST \/api\/quotes to D1/);

  const qa = phasePrompt(job, "verify", { starter: "fullstack-v1", resumed: false, previousNote: null, buildPhase: "final_qa", phasePlan: plan });
  assert.match(qa, /WCAG 2\.1 AA/);

  // A specification written before phasePlan existed: the phase objective still appears, with no invented list.
  const legacy = phasePrompt(job, "build", { starter: "fullstack-v1", resumed: false, previousNote: null, buildPhase: "design", phasePlan: null });
  assert.match(legacy, /ACTIVE PHASE: VISUAL DESIGN/);
  assert.doesNotMatch(legacy, /the architect's own list/);
  assert.doesNotMatch(legacy, /Deliberately DEFERRED/);
});
