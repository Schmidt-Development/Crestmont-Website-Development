// The design-first build sequence, end to end, with NO model and NO GPU.
//
// Every cycle here is a signed submission the test composes itself, with scorecards built from fixtures. The point
// is to prove the whole progression the Founder asked for without generating a website:
//
//   mock intake accepted -> design phase selected -> design below 40 -> design improves -> the OVERALL score falls
//   while the design rises -> no inappropriate rollback -> design reaches a verified 40/40 -> the freeze persists ->
//   the functionality phase becomes available -> a functionality improvement preserves the frozen design -> a
//   visual regression during backend work is detected -> it blocks progression until repaired -> functionality
//   reaches 40/40 -> remaining quality reaches 20/20 -> 100/100 -> internal approval is still a separate staff
//   action -> historical revisions and old scorecards are unchanged.
//
// It also pins the stall-guard behaviour at the pipeline level, which is where the old engine escalated builds for
// doing exactly what the architecture asks: a design cycle that defers backend work has a LOWER overall progress
// fraction than the cycle before it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, MemoryStorage } from "./support/app.ts";
import { FakePayments } from "./support/security-world.ts";
import * as PL from "../src/services/build-pipeline.ts";
import * as PH from "../src/services/build-phases.ts";
import { latestQuality, qualityHistory } from "../src/services/build-quality.ts";
import { REQUIRED_VIEWPORTS, SCORECARD_V2_SCHEMA, VISUAL_RUBRIC, round1 } from "../src/domain/quality-rubric.ts";
import { QUALITY_CRITERIA } from "../src/domain/quality.ts";
import { newId, nowIso } from "../src/lib/db.ts";

type Status = "pass" | "fail" | "pending_external" | "unsupported" | "not_applicable";

/** The criteria that feed each category, so a fixture can finish one category at a time. */
const DESIGN_EVIDENCE = ["visual_design", "brand_consistency", "desktop", "mobile"];
const FUNCTIONAL_EVIDENCE = ["frontend", "backend", "database", "auth", "workflows", "requirements", "customer_experience", "integrations", "payments"];
const OTHER_EVIDENCE = ["security", "accessibility", "performance", "seo", "error_handling", "deployment", "maintainability"];

function criteria(o: { functional: Status; other: Status; overrides?: Record<string, Status> }) {
  return QUALITY_CRITERIA.map((id) => {
    const status: Status = o.overrides?.[id]
      ?? (DESIGN_EVIDENCE.includes(id) ? "pass" : FUNCTIONAL_EVIDENCE.includes(id) ? o.functional : OTHER_EVIDENCE.includes(id) ? o.other : "pass");
    return { id, applicable: true, status, evidence: status === "pass" ? [`fixture evidence for ${id}`] : [], reason: status === "pass" ? null : `fixture ${status}` };
  });
}

/**
 * A weighted card. `design` is a target number of points, spread over the six rubric items from the first one
 * onward, so a rising design score moves real items rather than one opaque total.
 */
function weighted(o: {
  phase: string; design: number; functional: Status; other: Status;
  viewports?: string[]; vision?: boolean; overrides?: Record<string, Status>; revision?: string;
}): Record<string, unknown> {
  let left = o.design;
  const items = VISUAL_RUBRIC.map((i) => {
    const give = Math.min(i.max, Math.max(0, left));
    left -= give;
    return { id: i.id, points: give, max: i.max, applicable: true, note: give < i.max ? "fixture: short of the maximum" : null };
  });
  return {
    schema: SCORECARD_V2_SCHEMA, packageId: "business", iteration: 1, phase: o.phase, revision: o.revision ?? "1-1",
    design: { points: round1(items.reduce((s, i) => s + i.points, 0)), max: 40, items, state: "scored", reason: null },
    functionality: { items: [] }, other: { items: [] },
    visualFailures: [], viewports: o.viewports ?? [...REQUIRED_VIEWPORTS],
    review: o.vision === false ? { reviewer: "deterministic", imagesSeen: 0, vision: false } : { reviewer: "local:qwen2.5vl", imagesSeen: 6, vision: true },
    criteria: criteria({ functional: o.functional, other: o.other, overrides: o.overrides }),
    defects: [], waitingExternal: false, computedAt: nowIso(),
  };
}

const EVIDENCE = (ok: boolean) => ({
  summary: "fixture", changedFiles: ["public/index.html"], commits: [],
  checks: [{ id: "quality-gates", ok }, { id: "browser-check", ok: true }],
  criteria: [{ id: "ac-pages", status: ok ? "passed" : "not_verified" }],
  screenshots: REQUIRED_VIEWPORTS.filter((v) => v !== "tablet").map((v) => ({ path: `.crestmont/screenshots/home-${v}.png`, viewport: v, page: "home" })),
  defects: ok ? [] : ["fixture defect"], integrationBlockers: [], securityFindings: [], recommendedNext: [],
});

async function world() {
  const t = await createTestApp({ BUILD_RUNNER_SECRET: "s", overrides: { storage: new MemoryStorage(), payments: new FakePayments() } });
  await createStaff(t.db, "owner", "owner@crestmont.test");
  const cu = await createCustomer(t.db, "jitt@matrix.example", "Junk in the Trunk");
  const orgId = cu.organizationId;
  const pid = newId("prj");
  await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at)
    VALUES (?,?,?,'scope_review',2,'upfront',?,?)`).bind(pid, orgId, "Junk in the Trunk", nowIso(), nowIso()).run();
  const job = newId("bld");
  await t.db.prepare(`INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, state_reason, strategy, package_id, trigger, attempts, quality_required, created_at, updated_at)
    VALUES (?,?,?,'first_build',0,?,'building','running','standard','business','sweep',1,1,?,?)`)
    .bind(job, pid, orgId, `${pid}:first`, nowIso(), nowIso()).run();
  const jobRow = { id: job, project_id: pid, organization_id: orgId, attempts: 1, package_id: "business", strategy: "standard", brief_id: null };

  /** Store the snapshot for a cycle, with real screenshot files so the viewport claims can be proven. */
  const snapshot = async (cycle: number, viewports: string[] = [...REQUIRED_VIEWPORTS]) => {
    const rev = newId("brev");
    await t.db.prepare(`INSERT INTO build_revisions (id, job_id, project_id, cycle, attempt, phase, score, decision, is_best, reverted, file_count, total_bytes, created_at)
      VALUES (?,?,?,?,1,'repair',NULL,NULL,0,0,?,100,?)`).bind(rev, job, pid, cycle, viewports.length + 2, nowIso()).run();
    await t.db.prepare(`INSERT INTO build_revision_files (revision_id, path, kind, content_type, size_bytes, sha256, storage_key) VALUES (?,?,?,?,?,?,?)`)
      .bind(rev, "index.html", "page", "text/html; charset=utf-8", 10, "a".repeat(64), `k/${rev}/index.html`).run();
    await t.db.prepare(`INSERT INTO build_revision_files (revision_id, path, kind, content_type, size_bytes, sha256, storage_key) VALUES (?,?,?,?,?,?,?)`)
      .bind(rev, "assets/site.css", "asset", "text/css; charset=utf-8", 10, "c".repeat(64), `k/${rev}/site.css`).run();
    for (const v of viewports) {
      await t.db.prepare(`INSERT INTO build_revision_files (revision_id, path, kind, content_type, size_bytes, sha256, storage_key) VALUES (?,?,?,?,?,?,?)`)
        .bind(rev, `.crestmont/screenshots/home-${v}.png`, "screenshot", "image/png", 10, "b".repeat(64), `k/${rev}/${v}.png`).run();
    }
    return rev;
  };

  /** One review cycle: store the snapshot, then submit it exactly as a runner would. */
  const cycle = async (n: number, card: Record<string, unknown>, o: { decision?: string; ok?: boolean; viewports?: string[] } = {}) => {
    await snapshot(n, o.viewports ?? [...REQUIRED_VIEWPORTS]);
    const ok = o.ok ?? true;
    return PL.submitCycle(t.db, jobRow, {
      cycle: n, prompt: `fixture cycle ${n}`, promptSource: "reviewer", reviewerProvider: "local:qwen2.5vl",
      decision: o.decision ?? "FIX_DEFECTS", nextPrompt: "fixture next prompt", addresses: ["criterion:ac-pages"],
      evidence: EVIDENCE(ok), quality: card, phase: card.phase,
    });
  };

  return { t, job, pid, orgId, jobRow, cycle, snapshot };
}

// ── The whole sequence ────────────────────────────────────────────────────────────────────────────────────────────

test("[PHASES] the full design-first sequence runs on fixtures alone: no Ollama, no GPU, no generated website", async () => {
  const w = await world();

  // 1-2. The build starts with design as the active implementation priority.
  assert.equal((await PH.phaseOf(w.t.db, w.job)).build_phase, "design", "a new build starts in the design phase");

  // 3. Initial design below 40, with backend functionality already partly there (the starter's own).
  const c1 = await w.cycle(1, weighted({ phase: "design", design: 20, functional: "pass", other: "pass" }));
  assert.equal(c1.phase, "design", "20/40 does not open the gate");
  assert.deepEqual(c1.points, { design: 20, functionality: 40, other: 20, total: 80 });
  assert.ok(c1.phaseBlockers.some((b) => /not certified at 40\/40/.test(b)), c1.phaseBlockers.join("; "));

  // 4-6. The design improves to 30 while backend functionality regresses to almost nothing. The OVERALL score falls
  //      from 80 to 55, and the build must NOT be rolled back or escalated for it.
  const c2 = await w.cycle(2, weighted({ phase: "design", design: 30, functional: "fail", other: "pass" }));
  assert.equal(c2.points!.design, 30, "the design improved");
  assert.ok(c2.points!.total < c1.points!.total, `the total fell: ${c1.points!.total} -> ${c2.points!.total}`);
  assert.equal(c2.phase, "design", "still in the design phase, which is correct");
  assert.notEqual(c2.decision, "ESCALATED", "and NOT escalated for the lower total");
  assert.ok(c2.continue, "the loop continues");
  // The stall guard compares the ACTIVE category, which rose.
  const progress = await w.t.db.prepare(`SELECT cycle, score, primary_progress, milestone FROM build_cycles WHERE job_id = ? ORDER BY cycle`).bind(w.job)
    .all<{ cycle: number; score: number; primary_progress: number; milestone: number }>();
  assert.ok(progress.results[1].primary_progress > progress.results[0].primary_progress,
    `primary progress rose (${progress.results[0].primary_progress} -> ${progress.results[1].primary_progress}) even though the overall fraction did not`);

  // 7-8. Design reaches a verified 40/40 and the freeze is persisted.
  const c3 = await w.cycle(3, weighted({ phase: "design", design: 40, functional: "fail", other: "pass" }));
  assert.equal(c3.phase, "design_locked", "a verified 40/40 freezes the design and moves the phase");
  assert.equal(c3.designFrozen, true);
  const freeze = await PH.activeFreeze(w.t.db, w.job);
  assert.ok(freeze, "the freeze is a row, not a flag");
  assert.equal(freeze!.design_points, 40);
  assert.equal(freeze!.revision_cycle, 3, "and it names the snapshot that holds the approved design");
  assert.equal(freeze!.platform_verified, 1);
  assert.ok(freeze!.source_fingerprint, "with a fingerprint of the frontend that produced it");

  // 9. The functionality phase becomes available.
  const c4 = await w.cycle(4, weighted({ phase: "design_locked", design: 40, functional: "fail", other: "pass" }));
  assert.equal(c4.phase, "functionality", "the freeze is verified, so the gate opens");

  // 10. A functionality improvement preserves the frozen design.
  const c5 = await w.cycle(5, weighted({ phase: "functionality", design: 40, functional: "fail", other: "pass", overrides: { frontend: "pass", backend: "pass", database: "pass" } }));
  assert.equal(c5.phase, "functionality");
  assert.ok(c5.points!.functionality > 0 && c5.points!.functionality < 40, `partial functionality progress: ${c5.points!.functionality}`);
  assert.equal(c5.designFrozen, true, "the design is still frozen");
  assert.equal((await PH.activeFreeze(w.t.db, w.job))!.invalidated_at, null);

  // 11-12. A visual regression during backend work is DETECTED and blocks progression, without reverting the work.
  const c6 = await w.cycle(6, weighted({ phase: "functionality", design: 34, functional: "pass", other: "pass" }));
  assert.equal(c6.designFrozen, false, "the frozen design no longer holds");
  assert.ok(c6.phaseBlockers.some((b) => /frozen design no longer passes/.test(b)), c6.phaseBlockers.join("; "));
  assert.equal(c6.phase, "functionality", "the functional work is NOT reverted to an earlier phase");
  assert.equal(c6.points!.functionality, 40, "and the functional progress in the same revision is kept");
  const invalidated = (await PH.freezeHistory(w.t.db, w.job))[0];
  assert.ok(invalidated.invalidated_at, "the freeze is marked invalidated, with its reason");
  assert.match(invalidated.invalidated_reason ?? "", /cycle 6/);

  // 12b. The regression is repaired: the design certifies again and the same freeze is back in force.
  const c7 = await w.cycle(7, weighted({ phase: "functionality", design: 40, functional: "pass", other: "pass" }));
  assert.equal(c7.designFrozen, true, "re-certification puts the freeze back");
  assert.equal(c7.phase, "final_qa", "with design and functionality both at 40/40, final QA opens");

  // 13-15. Remaining quality reaches 20/20 and the build is at 100/100.
  const c8 = await w.cycle(8, weighted({ phase: "final_qa", design: 40, functional: "pass", other: "pass" }), { decision: "READY_FOR_INTERNAL_APPROVAL" });
  assert.deepEqual(c8.points, { design: 40, functionality: 40, other: 20, total: 100 });
  assert.equal(c8.phase, "complete");
  const card = (await latestQuality(w.t.db, w.job))!;
  assert.equal(card.total_points, 100);
  assert.equal(card.verified, 1, "verified by the platform's own recomputation");
  assert.equal(card.eligible, 1);
  assert.equal(card.design_certified, 1);

  // 16. Internal approval remains a separate staff-controlled action: nothing here approved anything.
  const j = await w.t.db.prepare(`SELECT state, internal_approved_at FROM build_jobs WHERE id = ?`).bind(w.job).first<{ state: string; internal_approved_at: string | null }>();
  assert.equal(j!.internal_approved_at, null, "the automated engine never approves a website");
  assert.notEqual(j!.state, "approved");

  // 17. Historical revisions and scorecards are unchanged: every cycle is still readable with its own numbers.
  const history = await qualityHistory(w.t.db, w.job);
  assert.equal(history.length, 8, "one stored scorecard per cycle, none overwritten");
  assert.deepEqual(history.map((h) => h.design_points), [20, 30, 40, 40, 40, 34, 40, 40], "including the regression at cycle 6");
  assert.ok(history.every((h) => h.schema_version === SCORECARD_V2_SCHEMA));
  const revs = (await w.t.db.prepare(`SELECT cycle, design_points, functionality_points, build_phase, is_design_baseline FROM build_revisions WHERE job_id = ? ORDER BY cycle`).bind(w.job)
    .all<{ cycle: number; design_points: number | null; functionality_points: number | null; build_phase: string | null; is_design_baseline: number }>()).results;
  assert.equal(revs.length, 8, "every snapshot is still there, immutable");
  assert.equal(revs.find((r) => r.cycle === 3)!.is_design_baseline, 1, "and the frozen baseline is identifiable");
  assert.equal(revs.find((r) => r.cycle === 2)!.design_points, 30, "each revision carries its own category scores for comparison");

  // The phase history is durable and in order.
  const phases = (await PH.milestones(w.t.db, w.job)).filter((m) => m.entered === 1).map((m) => m.phase);
  assert.deepEqual([...new Set(phases)], ["design_locked", "functionality", "final_qa", "complete"]);
});

// ── Stall guard ───────────────────────────────────────────────────────────────────────────────────────────────────

test("[PHASES] a design cycle that defers backend work is not escalated as \"no measurable progress\"", async () => {
  // The exact shape the old guard escalated. progressScore() averages everything, so three design cycles with
  // deferred backend criteria had a FALLING overall fraction, and the third was escalated.
  const w = await world();
  const designs = [14, 22, 30, 36];
  let last;
  for (const [i, design] of designs.entries()) {
    last = await w.cycle(i + 1, weighted({ phase: "design", design, functional: "fail", other: "fail" }));
    assert.notEqual(last.decision, "ESCALATED", `cycle ${i + 1}: design ${design}/40 is progress, not stagnation`);
  }
  assert.ok(last!.continue, "the loop is still running after four cycles of genuine design progress");
  const rows = (await w.t.db.prepare(`SELECT score, primary_progress FROM build_cycles WHERE job_id = ? ORDER BY cycle`).bind(w.job).all<{ score: number; primary_progress: number }>()).results;
  assert.ok(rows.every((r, i) => i === 0 || r.primary_progress > rows[i - 1].primary_progress), "every cycle raised the active category");
  assert.ok(rows[0].score <= rows[3].score + 1e-9, "while the legacy overall fraction stayed flat or lower");
});

test("[PHASES] genuinely repeated failures with no category progress still escalate", async () => {
  // The other half of the guarantee: the limits are not removed. Four identical cycles with no movement at all.
  const w = await world();
  let last;
  for (let n = 1; n <= 4; n++) {
    last = await w.cycle(n, weighted({ phase: "design", design: 12, functional: "fail", other: "fail" }), { ok: false });
    if (last.decision === "ESCALATED") break;
  }
  assert.equal(last!.decision, "ESCALATED", "a loop that is not converging is stopped for a person");
  assert.match(last!.reason, /No measurable progress in the design category|same failures repeated/);
  assert.equal(last!.continue, false, "and the GPU stops");
});

test("[PHASES] a cycle limit is still enforced", async () => {
  const w = await world();
  await w.t.db.prepare(`UPDATE build_settings SET max_review_cycles = 3`).run();
  let last;
  for (let n = 1; n <= 3; n++) {
    // Real progress every cycle, so only the cycle limit can stop it.
    last = await w.cycle(n, weighted({ phase: "design", design: 10 * n, functional: "fail", other: "fail" }));
  }
  assert.equal(last!.decision, "ESCALATED");
  assert.match(last!.reason, /limit of 3 review cycles/);
});

// ── The gates refuse what they should ─────────────────────────────────────────────────────────────────────────────

test("[PHASES] a design at 39/40 does not unlock the backend phase, however many cycles it takes", async () => {
  const w = await world();
  for (let n = 1; n <= 3; n++) {
    const r = await w.cycle(n, weighted({ phase: "design", design: 39 + n * 0.1 > 40 ? 39.5 : 39, functional: "pass", other: "pass" }));
    assert.equal(r.phase, "design", `cycle ${n}: 39/40 is not 40/40`);
    assert.equal(r.designFrozen, false);
  }
  assert.equal(await PH.activeFreeze(w.t.db, w.job), null, "no freeze was created");
});

test("[PHASES] a card claiming 40/40 with no vision reviewer freezes nothing, and the refusal is recorded", async () => {
  const w = await world();
  const r = await w.cycle(1, weighted({ phase: "design", design: 40, functional: "pass", other: "pass", vision: false }));
  assert.equal(r.phase, "design");
  assert.equal(r.designFrozen, false);
  assert.ok(r.phaseBlockers.some((b) => /vision-capable reviewer/.test(b)), r.phaseBlockers.join("; "));
  const refusals = (await PH.milestones(w.t.db, w.job)).filter((m) => m.entered === 0);
  assert.ok(refusals.length > 0, "the gate stayed shut, durably, with its reason");
});

test("[PHASES] a card claiming a viewport the snapshot cannot prove freezes nothing", async () => {
  const w = await world();
  // The card claims all three; the stored snapshot holds desktop and mobile only.
  const r = await w.cycle(1, weighted({ phase: "design", design: 40, functional: "pass", other: "pass" }), { viewports: ["desktop", "mobile"] });
  assert.equal(r.designFrozen, false);
  assert.equal(r.phase, "design");
  const card = (await latestQuality(w.t.db, w.job))!;
  assert.equal(card.verified, 0, "the card failed the platform's verification");
  assert.match(card.verification_problems_json, /tablet/);
});

test("[PHASES] a READY decision is overruled while any category is short, with the categories named", async () => {
  const w = await world();
  const r = await w.cycle(1, weighted({ phase: "design", design: 40, functional: "fail", other: "pass" }), { decision: "READY_FOR_INTERNAL_APPROVAL" });
  assert.notEqual(r.decision, "READY_FOR_INTERNAL_APPROVAL");
  assert.match(r.reason, /functionality is/, `the overrule names the short category: ${r.reason}`);
});

test("[PHASES] replaying a cycle is idempotent and reports where the build actually IS", async () => {
  const w = await world();
  const first = await w.cycle(1, weighted({ phase: "design", design: 40, functional: "fail", other: "pass" }));
  assert.equal(first.phase, "design_locked");
  // The same cycle again: the stored decision comes back, and the phase is read from the job rather than replayed.
  const again = await PL.submitCycle(w.t.db, w.jobRow, {
    cycle: 1, prompt: "fixture cycle 1", promptSource: "reviewer", reviewerProvider: "local:qwen2.5vl",
    decision: "FIX_DEFECTS", nextPrompt: "fixture next prompt", evidence: EVIDENCE(true),
  });
  assert.equal(again.decision, first.decision, "the decision is not recomputed");
  assert.equal(again.phase, "design_locked", "and the phase reported is the live one");
  assert.equal(again.designFrozen, true);
  assert.equal((await qualityHistory(w.t.db, w.job)).length, 1, "and no second scorecard was stored for the same cycle");
});

test("[PHASES] a safety finding closes every gate, whatever the scores are", async () => {
  const w = await world();
  await w.snapshot(1);
  const r = await PL.submitCycle(w.t.db, w.jobRow, {
    cycle: 1, prompt: "fixture", promptSource: "reviewer", reviewerProvider: "local:qwen2.5vl",
    decision: "FIX_DEFECTS", nextPrompt: "fix the isolation failure", addresses: ["security:tenant"],
    evidence: { ...EVIDENCE(true), securityFindings: ["one tenant's quote rows are readable by another"] },
    quality: weighted({ phase: "design", design: 40, functional: "pass", other: "pass" }), phase: "design",
  });
  // A genuine, verifiable 40/40 design that would otherwise have been frozen on this very cycle.
  assert.equal(r.phase, "design", "the safety finding stops the freeze that the score alone would have earned");
  assert.equal(r.designFrozen, false);
  assert.ok(r.phaseBlockers.some((b) => /^safety:/.test(b)), r.phaseBlockers.join("; "));
  assert.equal(await PH.activeFreeze(w.t.db, w.job), null, "nothing was certified while the isolation failure is open");
  // And the same card with no finding does freeze, which is what makes the test above mean something.
  const clean = await world();
  await clean.snapshot(1);
  const ok = await PL.submitCycle(clean.t.db, clean.jobRow, {
    cycle: 1, prompt: "fixture", promptSource: "reviewer", reviewerProvider: "local:qwen2.5vl",
    decision: "FIX_DEFECTS", nextPrompt: "continue", addresses: ["criterion:ac-pages"], evidence: EVIDENCE(true),
    quality: weighted({ phase: "design", design: 40, functional: "pass", other: "pass" }), phase: "design",
  });
  assert.equal(ok.designFrozen, true);
});
