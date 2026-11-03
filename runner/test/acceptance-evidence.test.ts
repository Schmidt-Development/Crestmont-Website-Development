// Missing acceptance evidence is reported as missing, not as a failing website (real defect, 2026-11-03).
//
// Four consecutive real Business builds (bld_38c053c4, bld_c9bce024, bld_b125d09d and the run before them) stalled on
// the same thing. The agent is told once, in a single bullet, to record each acceptance criterion's status in
// .crestmont/acceptance.json. It never wrote the file. Every criterion therefore stayed "not_verified", the scorecard
// could not rise above roughly a third however good the website was, and the repair loop escalated with
// "criterion:ac-pages; criterion:ac-responsive; criterion:ac-brand; criterion:ac-copy survived 3 targeted repairs"
// -- while all seven runner checks passed. The builder was given no way to tell that the problem was a missing file
// rather than a broken page, so three targeted repairs went into working code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingCriteriaEvidence } from "../src/orchestrator/evidence.ts";

const CRITERIA = [{ id: "ac-pages" }, { id: "ac-responsive" }, { id: "ac-brand" }];

test("[AIB-EVIDENCE] no recorded status at all: the note names the file, the format and every criterion", () => {
  const out = missingCriteriaEvidence(CRITERIA, new Map());
  assert.equal(out.length, 1);
  assert.match(out[0], /missing, not failing/, "the distinction is the whole point: unverified is not the same as failing");
  assert.match(out[0], /\.crestmont\/acceptance\.json/, "names the exact file to write");
  assert.match(out[0], /"status":"passed\|failed\|not_verified"/, "and the shape to write in it");
  assert.match(out[0], /ac-pages, ac-responsive, ac-brand/, "and which criteria have no status yet");
  assert.match(out[0], /ONLY where a test or screenshot proves it/, "without inviting a status the agent cannot support");
});

test("[AIB-EVIDENCE] a partially recorded set counts what is left, and a complete one says nothing", () => {
  const partial = missingCriteriaEvidence(CRITERIA, new Map([["ac-pages", "passed"]]));
  assert.equal(partial.length, 1);
  assert.match(partial[0], /1 of 3/, "reports how much evidence exists, so progress is visible");
  assert.match(partial[0], /ac-responsive, ac-brand/);
  assert.doesNotMatch(partial[0], /ac-pages,/, "a criterion that already has a status is not asked for again");

  // "failed" and "not_verified" are RECORDED statuses: the agent did its job and the website has a real problem.
  // Nagging about the file then would bury the actual defect under paperwork.
  const recorded = new Map([["ac-pages", "failed"], ["ac-responsive", "not_verified"], ["ac-brand", "passed"]]);
  assert.deepEqual(missingCriteriaEvidence(CRITERIA, recorded), [], "every criterion has a status, so there is nothing to say");
});

test("[AIB-EVIDENCE] a build with no acceptance criteria is never nagged about them", () => {
  assert.deepEqual(missingCriteriaEvidence([], new Map()), [], "no specification criteria, no evidence to record");
});
