// The phase-aware repair ratchet and stall guard (failure modes F05, F10, F12, F15, F16, F20).
//
// WHY THE RATCHET EXISTS. Measured on Node 1, build bld_d6090c28f8e6923c75223307 (2026-11-02): the independently
// certified quality score went 7.50 -> 7.16 -> 7.22 -> 6.94 across four review cycles. Every repair was kept
// whatever it did, so the build could only walk away from its own best work and the LAST state -- the worst one --
// was the deliverable.
//
// WHY IT IS NO LONGER SCALAR. The first version ratcheted on the overall score, and under the design-first
// architecture that is the wrong measurement. A cycle that takes the design from 20/40 to 30/40 while deliberately
// deferred backend work falls from 30/40 to 5/40 drops the total from 7.0 to 5.5 -- and the scalar rule would have
// reverted it, destroying ten points of hard-won design to protect code the build is not meant to be writing yet.
// These tests pin BOTH guarantees at once: the decline is still caught, and that cycle is still kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MAX_IDLE_CYCLES, MAX_REGRESSIONS, POINT_EPSILON, activeCategory, keepsTree, ratchetDecision, stopsBuild,
  type PhasePoints, type RatchetInput,
} from "../src/orchestrator/ratchet.ts";
import { CATEGORY_MAX, PRIMARY_PROGRESS } from "../src/quality-weighted.ts";
import { initRepo, commitAll, headCommit, restoreTo } from "../src/git.ts";

const p = (design: number, functionality: number, other = 20): PhasePoints => ({ design, functionality, other });

/** A ratchet call with everything safe and certified unless a test says otherwise. */
const decide = (o: Partial<RatchetInput> & { current: PhasePoints | null }) => ratchetDecision({
  phase: "design", best: null, designCertified: true, designFrozen: false,
  regressions: 0, idleCycles: 0, milestoneReached: false, safetyBlockers: [], ...o,
});

// ── The active category is the measurement ────────────────────────────────────────────────────────────────────────

test("[RATCHET] each phase ratchets on its own category, and the overall total is never consulted", () => {
  assert.equal(activeCategory("design"), "design");
  assert.equal(activeCategory("design_locked"), "design");
  assert.equal(activeCategory("functionality"), "functionality");
  assert.equal(activeCategory("final_qa"), "other");
  assert.equal(activeCategory("waiting"), null);
  assert.equal(PRIMARY_PROGRESS.design, "design");
});

test("[RATCHET] THE CASE THIS WAS BUILT FOR: design 20->30 while functionality 30->5 is PROGRESS, not a rollback", () => {
  // Overall: 7.0 -> 5.5. The scalar ratchet reverted this and threw away ten points of design.
  const cycle1 = p(20, 30);
  assert.equal(decide({ phase: "design", current: cycle1, best: null }).action, "record-best");

  const cycle2 = p(30, 5);
  const d = decide({ phase: "design", current: cycle2, best: cycle1 });
  assert.equal(d.action, "record-best", "the improved design is the revision to protect");
  assert.match(d.reason, /design improved to 30\/40 from 20/);
  assert.ok(keepsTree(d), "the working tree is kept: nothing is reverted");
  assert.ok(!stopsBuild(d), "and the loop is not stopped for a lower total");

  // The totals, for the record: this is exactly the drop the old rule acted on.
  const total = (x: PhasePoints) => x.design + x.functionality + x.other;
  assert.equal(total(cycle1) / 10, 7);
  assert.equal(total(cycle2) / 10, 5.5);
  assert.ok(total(cycle2) < total(cycle1), "the overall score fell");
  assert.ok(cycle2.design > cycle1.design, "and the active category rose, which is what decides");
});

test("[RATCHET] the measured decline is still caught, in the active category's own units", () => {
  // The same shape as the real 7.50 -> 7.16 -> 7.22 -> 6.94 decline, on the 0-40 design scale.
  const measured = [30, 28.6, 28.9, 27.8];
  let best: PhasePoints | null = null, regressions = 0;
  const actions: string[] = [];
  for (const design of measured) {
    const d = decide({ phase: "design", current: p(design, 20), best, regressions });
    actions.push(d.action);
    if (d.action === "record-best") { best = p(design, 20); regressions = 0; }
    else if (d.action === "revert" || d.action === "revert-and-stop") regressions = d.regressions;
    if (d.action === "revert-and-stop") break;
  }
  assert.deepEqual(actions, ["record-best", "revert", "revert-and-stop"],
    "30 is the best; 28.6 loses ground and is reverted; from 30 again, 28.9 still loses and the loop stops");
  assert.equal(best!.design, 30, "the build stands at its best measured revision, not its last one");
  assert.ok(best!.design > 27.8, "which is better than what would otherwise have shipped");
});

test("[RATCHET] a genuine improvement becomes the new best and clears the regression count", () => {
  assert.equal(decide({ current: p(33, 10), best: p(30, 10), regressions: 1 }).action, "record-best");
  assert.equal(decide({ current: p(12, 0), best: null }).action, "record-best", "the first measurement is the first best");
});

test("[RATCHET] measurement noise does not churn the working tree", () => {
  for (const delta of [0, POINT_EPSILON / 2, -POINT_EPSILON / 2, POINT_EPSILON * 0.99]) {
    assert.equal(decide({ current: p(30 + delta, 20), best: p(30, 20) }).action, "keep", `a ${delta.toFixed(2)}-point move is noise`);
  }
  assert.equal(decide({ current: p(30.5, 20), best: p(30, 20) }).action, "record-best", "half a point -- the reviewer's own step -- is a real gain");
  assert.equal(decide({ current: p(29.5, 20), best: p(30, 20) }).action, "revert", "and a real loss is reverted");
});

test("[RATCHET] repeated losses in the active category stop the loop instead of burning GPU", () => {
  const one = decide({ current: p(25, 20), best: p(30, 20), regressions: 0 });
  assert.equal(one.action, "revert");
  assert.equal(one.action === "revert" ? one.regressions : 0, 1, "one bad attempt is just a bad attempt");
  assert.equal(decide({ current: p(25, 20), best: p(30, 20), regressions: 1 }).action, "revert-and-stop", "two in a row means the loop is not converging");
  assert.equal(MAX_REGRESSIONS, 2);
});

test("[RATCHET] an unmeasured cycle never destroys the best revision", () => {
  // A cycle can end with no card at all. A null must not be read as "zero": that would revert work that was fine,
  // and on the first cycle it would discard the only revision there is.
  assert.equal(decide({ current: null, best: p(30, 20) }).action, "uncertified");
  assert.equal(decide({ current: null, best: null }).action, "uncertified");
  assert.ok(keepsTree(decide({ current: null, best: p(30, 20) })));
});

test("[RATCHET] the active category's best never decreases across any sequence", () => {
  const sequences: (number | null)[][] = [[30, 28.6, 28.9, 27.8], [25, 24, 22], [20, 25, 30, 35], [38.4, 37.6, 38.2], [32, null, 28.8, 33.6]];
  for (const seq of sequences) {
    let best: PhasePoints | null = null, regressions = 0;
    for (const design of seq) {
      const prev = best?.design ?? null;
      const d = decide({ phase: "design", current: design === null ? null : p(design, 10), best, regressions });
      if (d.action === "record-best") best = p(design!, 10);
      else if (d.action === "revert" || d.action === "revert-and-stop") regressions = d.regressions;
      assert.ok(best === null || prev === null || best.design >= prev, `best never decreases (${prev} -> ${best?.design})`);
      if (d.action === "revert-and-stop") break;
    }
  }
});

// ── Frozen categories ─────────────────────────────────────────────────────────────────────────────────────────────

test("[RATCHET] a functionality change that damages the frozen design is repaired SELECTIVELY, not reverted", () => {
  // Reverting would also revert the backend work that caused the regression, which is the progress this cycle made.
  const d = decide({ phase: "functionality", current: p(34, 25), best: p(40, 18), designCertified: false, designFrozen: true });
  assert.equal(d.action, "repair-frozen");
  assert.equal(d.action === "repair-frozen" ? d.regressed : null, "design");
  assert.match(d.reason, /keeping the functional work/);
  assert.ok(keepsTree(d), "the functional improvement in this revision is kept");
  assert.ok(!stopsBuild(d));
});

test("[RATCHET] a design regression during the DESIGN phase is ordinary ratchet business, not a frozen-category event", () => {
  // Nothing is frozen yet, so there is no baseline to have regressed FROM; the points decide.
  const d = decide({ phase: "design", current: p(26, 20), best: p(30, 20), designCertified: false, designFrozen: false });
  assert.equal(d.action, "revert", "a real drop in the active category");
});

test("[RATCHET] a functionality improvement with the design still at 40/40 is preserved", () => {
  const d = decide({ phase: "functionality", current: p(40, 25), best: p(40, 15), designCertified: true, designFrozen: true });
  assert.equal(d.action, "record-best");
  assert.match(d.reason, /functionality improved to 25\/40 from 15/);
});

test("[RATCHET] functionality falling after it was certified blocks final QA rather than passing unnoticed", () => {
  const d = decide({ phase: "final_qa", current: p(40, 31, 18), best: p(40, 40, 14), designCertified: true, designFrozen: true });
  assert.equal(d.action, "repair-frozen");
  assert.equal(d.action === "repair-frozen" ? d.regressed : null, "functionality");
  assert.match(d.reason, /after it was certified/);
});

// ── Safety is non-deferrable in every phase ───────────────────────────────────────────────────────────────────────

test("[RATCHET] a safety-critical problem halts the build in EVERY phase, whatever the scores did", () => {
  for (const phase of ["design", "design_locked", "functionality", "final_qa", "waiting", "complete"] as const) {
    const d = decide({ phase, current: p(40, 40), best: p(10, 10), safetyBlockers: ["customer records readable across tenants"] });
    assert.equal(d.action, "halt", `${phase}: safety comes first`);
    assert.match(d.reason, /no score improvement overrides/);
    assert.ok(stopsBuild(d));
  }
  // Even a perfect design improvement does not license it.
  assert.equal(decide({ phase: "design", current: p(40, 5), best: p(20, 5), safetyBlockers: ["secret committed to the repository"] }).action, "halt");
});

// ── Stall detection ───────────────────────────────────────────────────────────────────────────────────────────────

test("[RATCHET] a newly completed milestone is progress even when the number has not moved", () => {
  const d = decide({ current: p(30, 20), best: p(30, 20), idleCycles: MAX_IDLE_CYCLES - 1, milestoneReached: true });
  assert.equal(d.action, "keep", "the cycle completed a rubric item, so it is not an idle cycle");
  assert.match(d.reason, /completed a milestone/);
});

test("[RATCHET] genuinely idle cycles escalate for a diagnostic instead of repeating the repair forever", () => {
  assert.equal(decide({ current: p(30, 20), best: p(30, 20), idleCycles: 0 }).action, "keep");
  assert.equal(decide({ current: p(30, 20), best: p(30, 20), idleCycles: 1 }).action, "keep");
  const stalled = decide({ current: p(30, 20), best: p(30, 20), idleCycles: MAX_IDLE_CYCLES - 1 });
  assert.equal(stalled.action, "escalate", `${MAX_IDLE_CYCLES} cycles with neither a point nor a milestone is stagnation`);
  assert.match(stalled.reason, /targeted diagnostic/);
  assert.ok(stopsBuild(stalled), "a person looks at it; the GPU stops");
  assert.equal(MAX_IDLE_CYCLES, 3);
});

test("[RATCHET] the limits are not removed: every stopping condition still exists", () => {
  // "Do not solve this by simply removing all limits or allowing unlimited AI cycles."
  assert.ok(MAX_REGRESSIONS > 0 && Number.isFinite(MAX_REGRESSIONS));
  assert.ok(MAX_IDLE_CYCLES > 0 && Number.isFinite(MAX_IDLE_CYCLES));
  const stoppers = [
    decide({ current: p(25, 20), best: p(30, 20), regressions: MAX_REGRESSIONS - 1 }),
    decide({ current: p(30, 20), best: p(30, 20), idleCycles: MAX_IDLE_CYCLES - 1 }),
    decide({ current: p(40, 40), best: null, safetyBlockers: ["lease lost"] }),
  ];
  for (const d of stoppers) assert.ok(stopsBuild(d), `${d.action} stops the build`);
});

test("[RATCHET] the category maxima the ratchet reports are the rubric's own", () => {
  assert.match(decide({ current: p(30, 20), best: p(30, 20) }).reason, new RegExp(`30/${CATEGORY_MAX.design}`));
});

// ── The restore it relies on ──────────────────────────────────────────────────────────────────────────────────────

const ctx = (repo: string) => ({ repo, pathEnv: process.env.PATH ?? "", home: repo });

test("[RATCHET] restoreTo puts the files back and keeps the failed attempt in the history", async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "ratchet-"));
  const c = ctx(repo);
  await initRepo(c, { name: "Test", email: "t@example.test" }, "main");
  mkdirSync(path.join(repo, "public"), { recursive: true });
  writeFileSync(path.join(repo, "public", "index.html"), "<h1>good</h1>");
  writeFileSync(path.join(repo, "public", "site.css"), "h1{color:navy}");
  const good = await commitAll(c, "the good revision");
  assert.ok(good, "a commit was made");

  // A repair that makes things worse: edits a file AND adds a new one.
  writeFileSync(path.join(repo, "public", "index.html"), "<h1>worse</h1>");
  writeFileSync(path.join(repo, "public", "stray.html"), "<h1>stray</h1>");
  const bad = await commitAll(c, "the repair that lost ground");
  assert.notEqual(bad, good);

  const restored = await restoreTo(c, good!, "revert: the design score dropped");
  assert.ok(restored, "the restore produced a commit");
  assert.equal(readFileSync(path.join(repo, "public", "index.html"), "utf8"), "<h1>good</h1>", "the edited file is back");
  assert.equal(readFileSync(path.join(repo, "public", "site.css"), "utf8"), "h1{color:navy}", "untouched files are intact");
  assert.ok(!existsSync(path.join(repo, "public", "stray.html")), "a file the bad repair ADDED is gone");

  // History is evidence: the failed attempt is still there, which `reset --hard` would have discarded.
  const { run } = await import("../src/exec.ts");
  const log = await run("git", ["log", "--oneline"], { cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: repo, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  assert.match(log.stdout, /the repair that lost ground/, "the failed repair is still in the log as evidence");
  assert.match(log.stdout, /revert: the design score dropped/, "and so is the revert, with its reason");
  assert.equal(await headCommit(c), restored);
});

test("[RATCHET] restoreTo refuses anything that is not a commit id", async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "ratchet-bad-"));
  const c = ctx(repo);
  await initRepo(c, { name: "Test", email: "t@example.test" }, "main");
  for (const bad of ["HEAD~1; rm -rf /", "../../etc", "not-a-sha", ""]) {
    await assert.rejects(() => restoreTo(c, bad, "nope"), /is not a commit id/, `refused: ${bad}`);
  }
});
