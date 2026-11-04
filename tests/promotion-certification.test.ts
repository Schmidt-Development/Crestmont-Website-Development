// How the CRM import rate is judged (src/domain/promotion-certification.ts).
//
// Each of these tests exists because the easy version of the check passes in a case it should not. They are the
// difference between certifying a system and certifying a number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { certified, judgeFullHour, judgeSustained, type MinuteCount } from "../src/domain/promotion-certification.ts";

const minutes = (counts: number[], from = Date.parse("2026-11-04T10:00:00.000Z")): MinuteCount[] =>
  counts.map((leads, i) => ({ minute: new Date(from + i * 60_000).toISOString().slice(0, 16), leads }));

// ───────────── sustained means minute by minute ─────────────

test("[CRM-005] a burst with a healthy average is NOT sustained performance", () => {
  // 300 in one minute and nothing for the rest: 5/minute on average over the hour, and 1 of 60 minutes at target.
  const burst = judgeSustained(minutes([300, ...Array(59).fill(0)]), 25);
  assert.equal(burst.outcome, "fail", "a single burst cannot certify a sustained rate");
  assert.equal(burst.atTarget, 1);
  assert.equal(burst.needed, 54);
  // The total over the window is 300, which is 5/minute: an average-based check would have been satisfied by a
  // different arrangement of the same figure. This one is not, whatever the total.
  assert.ok(burst.worst.length > 0, "the weakest minutes are reported so a failure is diagnosable");
  assert.equal(burst.worst[0].leads, 0);
});

test("[CRM-005] an hour that holds the target every minute passes, and one slow minute in ten is tolerated", () => {
  assert.equal(judgeSustained(minutes(Array(60).fill(25)), 25).outcome, "pass");
  assert.equal(judgeSustained(minutes(Array(60).fill(100)), 25).outcome, "pass", "above target is still sustained");

  // 54 of 60 is exactly 90%: the allowance for a tick delayed by a slow database response.
  const six = judgeSustained(minutes([...Array(54).fill(25), ...Array(6).fill(0)]), 25);
  assert.equal(six.outcome, "pass");
  assert.equal(six.atTarget, 54);

  // Seven is one too many, however large the leads in the other minutes are.
  const seven = judgeSustained(minutes([...Array(53).fill(1000), ...Array(7).fill(0)]), 25);
  assert.equal(seven.outcome, "fail", "53 of 60 fails even when the minutes that worked were enormous");
});

test("[CRM-005] a minute exactly at target counts; a minute one short does not", () => {
  assert.equal(judgeSustained(minutes(Array(10).fill(25)), 25).outcome, "pass");
  assert.equal(judgeSustained(minutes(Array(10).fill(24)), 25).outcome, "fail");
});

test("[CRM-005] no minutes at all is a failure, not a vacuous pass", () => {
  const none = judgeSustained([], 25);
  assert.equal(none.outcome, "fail", "an empty window must not certify anything");
  assert.equal(none.atTarget, 0);
});

// ───────────── an hour is certified only from an hour ─────────────

test("[CRM-005] a window shorter than an hour cannot certify an hour, however good its rate", () => {
  // 30 minutes at four times the target: an excellent rate, and no information about an hour.
  const short = judgeFullHour({ windowMinutes: 30, workingMinutes: 30, minutes: minutes(Array(30).fill(100)), target: 25 });
  assert.equal(short.outcome, "blocked");
  assert.match(short.reason, /cannot be certified from less than 60/);
  assert.equal(short.bestHour, null);
});

test("[CRM-005] supply running out inside the window blocks the hour and says it was supply, not throughput", () => {
  // The first 20 minutes ran at four times target, then the backlog was empty for 40 minutes.
  const drained = judgeFullHour({
    windowMinutes: 60, workingMinutes: 20, target: 25,
    minutes: minutes([...Array(20).fill(100), ...Array(40).fill(0)]),
    drainedAt: "2026-11-04T10:20:00.000Z",
  });
  assert.equal(drained.outcome, "blocked", "an hour that was not supplied for an hour is not certifiable");
  assert.match(drained.reason, /supply lasted only 20 minutes/);
  assert.match(drained.reason, /supply shortage, not a throughput failure/);
  assert.match(drained.reason, /10:20:00Z/, "and says when it ran out");
});

test("[CRM-005] a fully supplied hour at target is certified; below target it fails rather than being blocked", () => {
  const ok = judgeFullHour({ windowMinutes: 60, workingMinutes: 60, minutes: minutes(Array(60).fill(25)), target: 25 });
  assert.equal(ok.outcome, "pass");
  assert.equal(ok.bestHour?.leads, 1500);
  assert.equal(ok.needed, 1500);

  const low = judgeFullHour({ windowMinutes: 60, workingMinutes: 60, minutes: minutes(Array(60).fill(24)), target: 25 });
  assert.equal(low.outcome, "fail", "supplied for an hour and short of the target is a real throughput failure");
  assert.equal(low.bestHour?.leads, 1440);
});

test("[CRM-005] the best hour is the best CONTIGUOUS supplied hour, not the sum of the best minutes", () => {
  // 90 supplied minutes: a weak first half hour, then a strong hour.
  const v = judgeFullHour({
    windowMinutes: 90, workingMinutes: 90, target: 25,
    minutes: minutes([...Array(30).fill(0), ...Array(60).fill(30)]),
  });
  assert.equal(v.outcome, "pass");
  assert.equal(v.bestHour?.leads, 1800);
  assert.equal(v.bestHour?.start, "2026-11-04T10:30", "it found the strong hour, not a cherry-picked set of minutes");
});

test("[CRM-005] an hour is never assembled from minutes after the supply ran out", () => {
  // 70-minute window, supply for 60, then 10 minutes of heavy manual activity that must not be borrowed.
  const v = judgeFullHour({
    windowMinutes: 70, workingMinutes: 60, target: 25,
    minutes: minutes([...Array(60).fill(25), ...Array(10).fill(1000)]),
    drainedAt: "2026-11-04T11:00:00.000Z",
  });
  assert.equal(v.outcome, "pass");
  assert.equal(v.bestHour?.leads, 1500, "exactly the supplied hour; the later minutes were not counted");
});

// ───────────── the overall verdict ─────────────

test("[CRM-005] certified requires every check to pass: blocked is not a pass", () => {
  assert.equal(certified(["pass", "pass", "pass"]), true);
  assert.equal(certified(["pass", "blocked"]), false, "a check that could not be attempted does not certify");
  assert.equal(certified(["pass", "fail"]), false);
  assert.equal(certified([]), false, "nothing checked certifies nothing");
});
