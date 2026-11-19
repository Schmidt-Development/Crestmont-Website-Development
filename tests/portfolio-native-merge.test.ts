// Automatic merging of Crestmont's header pull requests fails closed (Owner, 2026-11-19): it merges only when every
// required check passed, protection was read and asks for no review, no reviewer requested changes, GitHub reports the
// PR cleanly mergeable ("unstable" is NOT accepted), and the merge names the verified head commit. Pure gate tests plus
// the same rules through the hermetic GitHub model (support/native-world.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeGate, advancePr, NO_CI_GRACE_MS, type GateInput } from "../src/services/native/github.ts";
import { NativeWorld } from "./support/native-world.ts";

const now = Date.parse("2026-11-19T12:00:00Z");
const base = (over: Partial<GateInput> = {}): GateInput => ({
  pr: { state: "open", draft: false, mergeable: true, mergeable_state: "clean", head: { sha: "a".repeat(40) }, created_at: new Date(now - 60_000).toISOString() },
  protection: { readable: true, protected: false, requiredContexts: [], requiresReviews: false },
  checkRuns: { readable: true, complete: true, runs: [{ name: "build", status: "completed", conclusion: "success" }] },
  statuses: { readable: true, items: [] },
  reviews: { readable: true, changesRequested: false },
  now, ...over,
});

test("[PORT-NATIVE-MERGE] gate: successful checks merge; pending waits; failed, unstable, missing and unreadable never merge", () => {
  assert.deepEqual(mergeGate(base()), { merge: true, detail: "all 1 check(s) passed" });
  // Pending checks: wait (and re-check later).
  const p = mergeGate(base({ checkRuns: { readable: true, complete: true, runs: [{ name: "build", status: "in_progress", conclusion: null }] } }));
  assert.equal(p.merge, false); assert.equal((p as { wait: boolean }).wait, true); assert.match(p.detail, /still running: build/);
  assert.match(mergeGate(base({ statuses: { readable: true, items: [{ context: "ci/legacy", state: "pending" }] } })).detail, /still running: ci\/legacy/);
  // Failed checks (any non-success conclusion, or a failing commit status): stop.
  for (const c of ["failure", "cancelled", "timed_out", "action_required", "stale"]) {
    const r = mergeGate(base({ checkRuns: { readable: true, complete: true, runs: [{ name: "build", status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: c }] } }));
    assert.equal(r.merge, false, c); assert.equal((r as { wait: boolean }).wait, false, c); assert.match(r.detail, new RegExp(`lint \\(${c}\\)`));
  }
  assert.match(mergeGate(base({ statuses: { readable: true, items: [{ context: "deploy/preview", state: "error" }] } })).detail, /deploy\/preview \(error\)/);
  // The newest status per context decides (a re-run that passed supersedes an older failure).
  assert.equal(mergeGate(base({ statuses: { readable: true, items: [{ context: "ci", state: "success" }, { context: "ci", state: "failure" }] } })).merge, true);
  // "unstable" (a non-required check failed) is never accepted, even with no failing check visible to Crestmont.
  const u = mergeGate(base({ pr: { ...base().pr, mergeable_state: "unstable" } }));
  assert.equal(u.merge, false); assert.equal((u as { wait: boolean }).wait, false);
  for (const ms of ["blocked", "behind", "unknown", undefined]) assert.equal(mergeGate(base({ pr: { ...base().pr, mergeable_state: ms } })).merge, false, String(ms));
  // Missing required check: wait until it reports; never merge without it.
  const m = mergeGate(base({ protection: { readable: true, protected: true, requiredContexts: ["build", "security/scan"], requiresReviews: false } }));
  assert.equal(m.merge, false); assert.match(m.detail, /required checks have not reported yet: security\/scan/);
  assert.equal(mergeGate(base({ protection: { readable: true, protected: true, requiredContexts: ["build"], requiresReviews: false } })).merge, true);
  // Unverifiable: protection, check runs (or a truncated list), statuses or reviews unreadable → fail closed.
  for (const over of [{ protection: { readable: false, protected: true, requiredContexts: [], requiresReviews: false } }, { checkRuns: { readable: false, complete: false, runs: [] } }, { checkRuns: { readable: true, complete: false, runs: [] } }, { statuses: { readable: false, items: [] } }, { reviews: { readable: false, changesRequested: false } }] as Partial<GateInput>[]) {
    const r = mergeGate(base(over)); assert.equal(r.merge, false); assert.equal((r as { wait: boolean }).wait, false); assert.match(r.detail, /could not be read/);
  }
  // Reviews: required reviews or a change request → never merged by Crestmont.
  assert.match(mergeGate(base({ protection: { readable: true, protected: true, requiredContexts: [], requiresReviews: true } })).detail, /requires a reviewed pull request/);
  assert.match(mergeGate(base({ reviews: { readable: true, changesRequested: true } })).detail, /requested changes/);
  // No CI at all: wait 10 minutes for checks to start; then merge only because none is required.
  const noCi = { checkRuns: { readable: true, complete: true, runs: [] } };
  assert.equal(mergeGate(base(noCi)).merge, false);
  assert.match(mergeGate(base({ ...noCi, pr: { ...base().pr, created_at: new Date(now - NO_CI_GRACE_MS - 1000).toISOString() } })).detail, /no CI is configured/);
  // Closed or draft PRs.
  assert.equal(mergeGate(base({ pr: { ...base().pr, draft: true } })).merge, false);
  assert.equal(mergeGate(base({ pr: { ...base().pr, state: "closed" } })).merge, false);
});

test("[PORT-NATIVE-MERGE] through GitHub: pending → not merged and re-checked; failed → handed to the Owner; missing required → waits; unreadable → handed to the Owner; passed → merged at the verified head commit", async () => {
  const gh = { token: "gh-test-token" };
  const run = async (opts: Parameters<NativeWorld["repo"]>[1], tweak?: (w: NativeWorld) => void) => {
    const w = new NativeWorld().repo("owner/x", { files: { "vercel.json": "{}" }, ...opts });
    tweak?.(w);
    const r = w.repos.get("owner/x")!;
    r.branches["crestmont/native-embedding"] = { sha: "b".repeat(40), files: {} };
    r.pulls.push({ number: 1, head: "crestmont/native-embedding", base: "main", state: "open", merged: false, merge_commit_sha: null, title: "t", created_at: new Date(Date.now() - 60_000).toISOString() });
    const c = { repo: "owner/x", base: "main", path: "vercel.json", pr: 1, url: "https://github.com/owner/x/pull/1", committed: true, merged: false, mergeSha: null, needsApproval: false };
    return { w, out: await advancePr(w.fetchApi, gh, c) };
  };
  let x = await run({ checks: [{ name: "build", status: "in_progress", conclusion: null }] });
  assert.equal(x.out.merged, false); assert.equal(x.out.needsApproval, false); assert.match(x.out.detail, /Not merged yet — checks still running: build/); assert.deepEqual(x.w.mergeCalls, []);
  x = await run({ checks: [{ name: "build", status: "completed", conclusion: "failure" }] });
  assert.equal(x.out.merged, false); assert.equal(x.out.needsApproval, true); assert.match(x.out.detail, /will not merge .* checks failed: build \(failure\)/); assert.deepEqual(x.w.mergeCalls, []);
  x = await run({ requiredChecks: ["build", "security/scan"] });
  assert.equal(x.out.merged, false); assert.match(x.out.detail, /required checks have not reported yet: security\/scan/); assert.deepEqual(x.w.mergeCalls, []);
  x = await run({}, (w) => { w.repos.get("owner/x")!.checksUnreadable = true; });
  assert.equal(x.out.needsApproval, true); assert.match(x.out.detail, /Checks: read/); assert.deepEqual(x.w.mergeCalls, []);
  x = await run({ requiredChecks: ["build"] }, (w) => { w.repos.get("owner/x")!.protectionUnreadable = true; });
  assert.equal(x.out.needsApproval, true); assert.match(x.out.detail, /Administration: read/); assert.deepEqual(x.w.mergeCalls, []);
  x = await run({}, (w) => { w.repos.get("owner/x")!.changesRequested = true; });
  assert.equal(x.out.needsApproval, true); assert.match(x.out.detail, /requested changes/); assert.deepEqual(x.w.mergeCalls, []);
  x = await run({ requiredChecks: ["build"], statuses: [{ context: "vercel", state: "success" }] });
  assert.equal(x.out.merged, true, x.out.detail); assert.match(x.out.detail, /all 2 check\(s\) passed, including the required build/);
  assert.deepEqual(x.w.mergeCalls, [`owner/x#1@${"b".repeat(40)}`], "the merge names the verified head commit");
});
