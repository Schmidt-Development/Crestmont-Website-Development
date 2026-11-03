// The repair ratchet (failure modes F05, F10, F12, F15, F16, F20).
//
// Measured on Node 1, build bld_d6090c28f8e6923c75223307 (2026-11-02): the independently certified quality score went
// 7.50 -> 7.16 -> 7.22 -> 6.94 across four review cycles. Every repair was kept whatever it did to the site, so the
// build could only walk away from its own best work, and the LAST state -- the worst one -- was the deliverable.
// These tests pin the rule that stops that, and the git restore it relies on.
//
// The bounded repair loop does NOT give this guarantee: it stops a build that stops improving, and says nothing about
// which revision the customer ends up with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ratchetDecision, QUALITY_EPSILON, MAX_REGRESSIONS } from "../src/orchestrator/ratchet.ts";
import { initRepo, commitAll, headCommit, restoreTo } from "../src/git.ts";

// ── the decision rule ──────────────────────────────────────────────────────────────────────────────────────────────

test("[RATCHET] the real decline is caught: every losing repair is reverted and the loop stops", () => {
  // Replay of the measured sequence. Under the old behaviour all four were kept and 6.94 shipped.
  const measured = [7.50, 7.16, 7.22, 6.94];
  let best: number | null = null, regressions = 0;
  const actions: string[] = [];
  for (const q of measured) {
    const d = ratchetDecision(q, best, regressions);
    actions.push(d.action);
    if (d.action === "record-best") { best = q; regressions = 0; }
    else if (d.action === "revert" || d.action === "revert-and-stop") regressions = d.regressions;
    if (d.action === "revert-and-stop") break;
  }
  assert.deepEqual(actions, ["record-best", "revert", "revert-and-stop"],
    "7.50 is the best; 7.16 loses ground and is reverted; from 7.50 again, 7.22 still loses and the loop stops");
  assert.equal(best, 7.50, "the build stands at its best measured revision, not its last one");
  assert.ok(best > 6.94, "which is better than what actually shipped");
});

test("[RATCHET] a genuine improvement becomes the new best and clears the regression count", () => {
  assert.deepEqual(ratchetDecision(8.2, 7.5, 1), { action: "record-best" });
  assert.deepEqual(ratchetDecision(5.0, null, 0), { action: "record-best" }, "the first measured score is the first best");
});

test("[RATCHET] measurement noise does not churn the working tree", () => {
  for (const delta of [0, QUALITY_EPSILON / 2, -QUALITY_EPSILON / 2, QUALITY_EPSILON * 0.99]) {
    assert.equal(ratchetDecision(7.5 + delta, 7.5, 0).action, "keep", `a ${delta.toFixed(3)} move is noise, not progress`);
  }
  assert.equal(ratchetDecision(7.5 + QUALITY_EPSILON * 1.5, 7.5, 0).action, "record-best", "a real gain is recorded");
  assert.equal(ratchetDecision(7.5 - QUALITY_EPSILON * 1.5, 7.5, 0).action, "revert", "a real loss is reverted");
});

test("[RATCHET] repeated losses stop the loop instead of burning GPU", () => {
  assert.deepEqual(ratchetDecision(6.0, 7.5, 0), { action: "revert", regressions: 1 }, "one bad attempt is just a bad attempt");
  assert.deepEqual(ratchetDecision(6.0, 7.5, 1), { action: "revert-and-stop", regressions: 2 }, "two in a row means the loop is not converging");
  assert.equal(MAX_REGRESSIONS, 2);
});

test("[RATCHET] an unmeasured cycle never destroys the best revision", () => {
  // A cycle can end without a score at all (no scorecard computed for it). A null must not be read as "zero": that
  // would revert work that was fine, and on the first cycle it would discard the only revision there is.
  assert.deepEqual(ratchetDecision(null, 7.5, 0), { action: "uncertified" });
  assert.deepEqual(ratchetDecision(null, null, 0), { action: "uncertified" });
});

test("[RATCHET] the rule is monotone: the best never decreases across any sequence", () => {
  const sequences = [[7.5, 7.16, 7.22, 6.94], [6.31, 6.0, 5.5], [5, 6, 7, 8], [9.6, 9.4, 9.55], [8, null as unknown as number, 7.2, 8.4]];
  for (const seq of sequences) {
    let best: number | null = null, regressions = 0;
    for (const q of seq) {
      const prev = best;
      const d = ratchetDecision(q, best, regressions);
      if (d.action === "record-best") best = q;
      else if (d.action === "revert" || d.action === "revert-and-stop") regressions = d.regressions;
      assert.ok(best === null || prev === null || best >= prev, `best never decreases (${prev} -> ${best})`);
      if (d.action === "revert-and-stop") break;
    }
  }
});

// ── the restore it relies on ───────────────────────────────────────────────────────────────────────────────────────

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

  const restored = await restoreTo(c, good!, "revert: the quality score dropped");
  assert.ok(restored, "the restore produced a commit");
  assert.equal(readFileSync(path.join(repo, "public", "index.html"), "utf8"), "<h1>good</h1>", "the edited file is back");
  assert.equal(readFileSync(path.join(repo, "public", "site.css"), "utf8"), "h1{color:navy}", "untouched files are intact");
  assert.ok(!existsSync(path.join(repo, "public", "stray.html")), "a file the bad repair ADDED is gone");

  // History is evidence: the failed attempt is still there, which `reset --hard` would have discarded.
  const { run } = await import("../src/exec.ts");
  const log = await run("git", ["log", "--oneline"], { cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: repo, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  assert.match(log.stdout, /the repair that lost ground/, "the failed repair is still in the log as evidence");
  assert.match(log.stdout, /revert: the quality score dropped/, "and so is the revert, with its reason");
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
