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
