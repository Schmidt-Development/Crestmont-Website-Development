// The weighted quality contract, platform side: independent verification, the phase machine, and the design freeze.
//
// The runner computes a scorecard; this platform recomputes it. That distinction is the whole point of these tests:
// a runner that simply sends `design: { points: 40 }, designCertified: true` must get its own numbers thrown away
// and replaced by what its reported evidence actually supports.
//
// The fixture throughout is the real failure. bld_50e28bbd1cd033ad9ddfad02 revision 1-3 certified at 9.4/10 with a
// vertically stacked desktop navigation (site.css:109 sets flex-direction: column outside any media query; the
// min-width:64rem block never resets it) and zero images against a brief asking for licensed photography.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_PHASES, CATEGORY_MAX, NEXT_PHASE, PRIMARY_PROGRESS, REQUIRED_VIEWPORTS, SCORECARD_V2_SCHEMA, VISUAL_RUBRIC,
  designBlockers, phaseBlockers, releaseBlockers, round1, type CategoryScore,
} from "../src/domain/quality-rubric.ts";
import { isScorecardV2, verifyScorecard2 } from "../src/domain/quality-verify.ts";
import { QUALITY_CRITERIA, requiredCapabilities } from "../src/domain/quality.ts";
import * as PH from "../src/services/build-phases.ts";
import { assertQualityForApproval, latestQuality, recordQuality } from "../src/services/build-quality.ts";
import { primaryProgress } from "../src/services/build-pipeline.ts";
import { createTestApp, createStaff, createCustomer, MemoryStorage } from "./support/app.ts";
import { FakePayments } from "./support/security-world.ts";
import { newId, nowIso } from "../src/lib/db.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────

const SCOPE = { packageId: "business", required: requiredCapabilities("business", [{ key: "booking" }, { key: "ecommerce" }], ["stripe"]) };

type Status = "pass" | "fail" | "pending_external" | "unsupported" | "not_applicable";

const criteria = (def: Status, over: Partial<Record<string, Status | "na">> = {}) =>
  QUALITY_CRITERIA.map((id) => {
    const o = over[id];
    if (o === "na") return { id, applicable: false, status: "not_applicable", evidence: [], reason: null };
    const status = o ?? def;
    return { id, applicable: true, status, evidence: status === "pass" ? [`fixture evidence for ${id}`] : [], reason: status === "pass" ? null : `fixture ${status}` };
  });

const fullVisual = () => VISUAL_RUBRIC.map((i) => ({ id: i.id, points: i.max, max: i.max, applicable: true, note: null }));

/** A weighted card as a correct runner would report it. Individual tests spoil one part at a time. */
function card(o: {
  criteriaOver?: Partial<Record<string, Status | "na">>;
  criteriaDefault?: Status;
  visual?: { id: string; points: number }[] | null;
  viewports?: string[];
  review?: { reviewer: string; imagesSeen: number; vision: boolean } | null;
  visualFailures?: { id: string }[];
  phase?: string;
  claim?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const items = o.visual === undefined ? fullVisual() : (o.visual ?? []);
  const design = items.reduce((s, i) => s + i.points, 0);
  return {
    schema: SCORECARD_V2_SCHEMA, packageId: "business", iteration: 1, phase: o.phase ?? "design", revision: "1-3",
    design: { points: design, max: 40, items, state: "scored", reason: null },
    functionality: { points: 40, max: 40, items: [], state: "scored", reason: null },
    other: { points: 20, max: 20, items: [], state: "scored", reason: null },
    totalPoints: design + 60, overall: round1((design + 60) / 10),
    visualFailures: o.visualFailures ?? [],
    viewports: o.viewports ?? [...REQUIRED_VIEWPORTS],
    review: o.review === undefined ? { reviewer: "local:qwen2.5vl", imagesSeen: 6, vision: true } : o.review,
    criteria: criteria(o.criteriaDefault ?? "pass", o.criteriaOver),
    defects: [], designCertified: true, eligible: true, waitingExternal: false, computedAt: nowIso(),
    ...o.claim,
  };
}

// ── The arithmetic the platform owns ──────────────────────────────────────────────────────────────────────────────

test("[QUALITY-V2] visual design is 40%, functionality 40% and remaining quality 20% of the total", () => {
  assert.equal(CATEGORY_MAX.design, 40);
  assert.equal(CATEGORY_MAX.functionality, 40);
  assert.equal(CATEGORY_MAX.other, 20);
  assert.equal(CATEGORY_MAX.design + CATEGORY_MAX.functionality + CATEGORY_MAX.other, 100);
  const v = verifyScorecard2(card(), SCOPE);
  assert.deepEqual(v.problems, [], "a correct card verifies cleanly");
  assert.equal(v.totalPoints, 100);
  assert.equal(v.overall, 10);
  assert.equal(v.eligible, true);
});

test("[QUALITY-V2] the platform RECOMPUTES: a fabricated 40/40 design is replaced by what the evidence supports", () => {
  // The whole purpose of the second computation. The runner claims a perfect design and declares itself certified;
  // its rubric items say otherwise, and the rubric items are the evidence.
  const lying = card({
    visual: VISUAL_RUBRIC.map((i) => ({ id: i.id, points: i.id === "imagery" ? 0 : i.max })),
    claim: { design: { points: 40, max: 40, items: VISUAL_RUBRIC.map((i) => ({ id: i.id, points: i.id === "imagery" ? 0 : i.max, max: i.max, applicable: true, note: null })), state: "scored", reason: null }, totalPoints: 100, overall: 10, designCertified: true, eligible: true },
  });
  const v = verifyScorecard2(lying, SCOPE);
  assert.equal(v.design.points, 34, "the recomputed design is 34/40, not the 40 it claimed");
  assert.ok(v.problems.some((p) => /reported design 40 does not match the evidence \(34\)/.test(p)), v.problems.join("; "));
  assert.ok(v.problems.some((p) => /reported designCertified/.test(p)), v.problems.join("; "));
  assert.equal(v.designCertified, false);
  assert.equal(v.eligible, false);
  assert.equal(v.ok, false, "a card whose arithmetic does not match its evidence is not verified");
});

test("[QUALITY-V2] a fabricated total, a fabricated overall and a fabricated eligibility are each caught", () => {
  const v = verifyScorecard2(card({ criteriaDefault: "fail", criteriaOver: { frontend: "pass" }, claim: { totalPoints: 100, overall: 10, eligible: true } }), SCOPE);
  assert.ok(v.problems.some((p) => /reported total 100 does not match/.test(p)), v.problems.join("; "));
  assert.ok(v.problems.some((p) => /reported overall 10 does not match/.test(p)), v.problems.join("; "));
  assert.ok(v.problems.some((p) => /reported eligible/.test(p)), v.problems.join("; "));
  assert.equal(v.eligible, false);
});

test("[QUALITY-V2] a low design score cannot be masked by high functionality, in either direction", () => {
  // 35/40: five points short on layout, everything else at its maximum.
  const weakDesign = verifyScorecard2(card({ visual: VISUAL_RUBRIC.map((i) => ({ id: i.id, points: i.id === "layout" ? i.max - 5 : i.max })), claim: { designCertified: false, eligible: false } }), SCOPE);
  assert.equal(weakDesign.design.points, 35);
  assert.equal(weakDesign.functionality.points, 40);
  assert.equal(weakDesign.other.points, 20);
  assert.equal(weakDesign.totalPoints, 95, "95/100 is a high total");
  assert.equal(weakDesign.eligible, false, "and it still does not pass: 35/40 design is not 40/40");
  assert.match(weakDesign.releaseBlockers.join("; "), /visual design is not certified/);

  // The mirror case. The claimed category points and totals are left off entirely, so the platform's own
  // recomputation is the only arithmetic in play and nothing is reported as a reported-vs-evidence mismatch.
  const weakBackend = verifyScorecard2(card({
    criteriaOver: { backend: "fail", database: "fail" },
    claim: { functionality: { items: [] }, other: { items: [] }, totalPoints: undefined, overall: undefined, eligible: false, designCertified: true },
  }), SCOPE);
  assert.deepEqual(weakBackend.problems, [], weakBackend.problems.join("; "));
  assert.deepEqual(weakBackend.designBlockers, [], "the design itself is genuinely perfect");
  assert.equal(weakBackend.designCertified, true);
  assert.equal(weakBackend.design.points, 40);
  assert.ok(weakBackend.functionality.points < 40, `backend and persistence failing costs the category: ${weakBackend.functionality.points}`);
  assert.equal(weakBackend.eligible, false, "a perfect design does not carry unfinished backend work");
  assert.ok(weakBackend.releaseBlockers.some((b) => /functionality is/.test(b)), weakBackend.releaseBlockers.join("; "));
});

test("[QUALITY-V2] an inapplicable feature earns no free points, and a required one cannot be declared inapplicable", () => {
  // Business includes payments and booking, so the card may not drop them.
  const dodging = verifyScorecard2(card({ criteriaOver: { payments: "na", workflows: "na" } }), SCOPE);
  assert.ok(dodging.problems.some((p) => /payments is required by this website's scope but was reported not applicable/.test(p)), dodging.problems.join("; "));
  assert.ok(dodging.problems.some((p) => /workflows is required/.test(p)));
  assert.equal(dodging.ok, false);

  // A Starter website genuinely has neither, and the same card verifies.
  const starter = { packageId: "starter", required: requiredCapabilities("starter", [], []) };
  const honest = verifyScorecard2(card({ criteriaOver: { payments: "na", workflows: "na" }, claim: { packageId: "starter" } }), starter);
  assert.deepEqual(honest.problems, [], honest.problems.join("; "));
  assert.equal(honest.functionality.points, 40, "and can still reach its own maximum within its approved scope");
  assert.equal(honest.eligible, true);
});

test("[QUALITY-V2] a \"pass\" with no evidence is not a pass", () => {
  const unevidenced = card();
  (unevidenced.criteria as { id: string; evidence: string[] }[]).find((c) => c.id === "backend")!.evidence = [];
  const v = verifyScorecard2(unevidenced, SCOPE);
  assert.ok(v.problems.some((p) => /backend: "pass" without evidence/.test(p)), v.problems.join("; "));
  assert.equal(v.criteria.find((c) => c.id === "backend")!.status, "unsupported");
  assert.ok(v.functionality.points < 40);
});

test("[QUALITY-V2] a missing criterion is missing evidence, not a silent omission", () => {
  const short = card();
  short.criteria = (short.criteria as { id: string }[]).filter((c) => c.id !== "security");
  const v = verifyScorecard2(short, SCOPE);
  assert.ok(v.problems.some((p) => /criterion security is missing/.test(p)));
  assert.equal(v.other.points < 20, true, "and the category it fed loses its points");
});

// ── The design category: vision, viewports, hard failures ─────────────────────────────────────────────────────────

test("[QUALITY-V2] a missing review cannot produce a full design score", () => {
  const v = verifyScorecard2(card({ review: null, visual: null, claim: { designCertified: false, eligible: false } }), SCOPE);
  assert.equal(v.design.points, 0);
  assert.equal(v.design.state, "blocked", "\"nobody looked\" is distinguished from \"it looks bad\"");
  assert.equal(v.designCertified, false);
  assert.ok(v.visualFailures.some((f) => f.id === "no_vision"));
});

test("[QUALITY-V2] a review that claims vision but received no images is refused", () => {
  const v = verifyScorecard2(card({ review: { reviewer: "local:qwen2.5vl", imagesSeen: 0, vision: true } }), SCOPE);
  assert.ok(v.problems.some((p) => /claims vision but received no images/.test(p)), v.problems.join("; "));
  assert.equal(v.designCertified, false);
});

test("[QUALITY-V2] missing screenshots prevent design certification; desktop, tablet AND mobile are required", () => {
  assert.deepEqual([...REQUIRED_VIEWPORTS], ["desktop", "tablet", "mobile"]);
  for (const missing of REQUIRED_VIEWPORTS) {
    const v = verifyScorecard2(card({ viewports: REQUIRED_VIEWPORTS.filter((x) => x !== missing), claim: { designCertified: false } }), SCOPE);
    assert.equal(v.designCertified, false, `${missing} missing must block certification`);
    assert.ok(v.designBlockers.some((b) => b.includes(missing)), v.designBlockers.join("; "));
  }
});

test("[QUALITY-V2] a viewport the stored snapshot cannot prove is stripped, and the claim is reported", () => {
  // This is the strongest independent check available: the platform holds the card AND the files.
  const v = verifyScorecard2(card(), { ...SCOPE, evidencedViewports: ["desktop", "mobile"] });
  assert.ok(v.problems.some((p) => /viewport evidence claimed but not stored in the snapshot: tablet/.test(p)), v.problems.join("; "));
  assert.deepEqual(v.viewports, ["desktop", "mobile"], "the unproven claim is removed, not believed");
  assert.equal(v.designCertified, false);
});

test("[QUALITY-V2] REGRESSION: a failing desktop criterion IS a hard visual failure, even if the card omits it", () => {
  // The path where a runner measures the stacked navigation and simply does not declare it. The browser check's own
  // desktop criterion is objective, so the platform derives the failure itself.
  const quiet = verifyScorecard2(card({ criteriaOver: { desktop: "fail" }, visualFailures: [], claim: { designCertified: true } }), SCOPE);
  assert.ok(quiet.visualFailures.some((f) => f.id === "navigation"), "the platform adds the failure the card left out");
  assert.ok(quiet.design.points <= 12, `capped, not 39: got ${quiet.design.points}`);
  assert.equal(quiet.designCertified, false);
  assert.ok(quiet.problems.some((p) => /reported designCertified/.test(p)));
});

test("[QUALITY-V2] an unsupported desktop or mobile criterion is missing evidence, which caps the design at zero", () => {
  const v = verifyScorecard2(card({ criteriaOver: { mobile: "unsupported" }, claim: { designCertified: false } }), SCOPE);
  assert.ok(v.visualFailures.some((f) => f.id === "evidence"));
  assert.equal(v.design.points, 0);
});

test("[QUALITY-V2] designBlockers names every shortfall, so \"not certified\" is never unexplained", () => {
  const design: CategoryScore = {
    points: 36, max: 40, state: "scored", reason: null,
    items: VISUAL_RUBRIC.map((i) => ({ id: i.id, points: i.id === "imagery" ? 2 : i.max, max: i.max, applicable: true, note: null })),
  };
  const blockers = designBlockers({ design, visualFailures: [], viewports: [...REQUIRED_VIEWPORTS], review: { reviewer: "r", imagesSeen: 3, vision: true }, revision: "1-3" });
  assert.ok(blockers.some((b) => /visual design is 36\/40/.test(b)));
  assert.ok(blockers.some((b) => /Imagery/i.test(b) && /2\/6/.test(b)), `the short item is named with its score: ${blockers.join("; ")}`);
  assert.equal(designBlockers({ design: { ...design, points: 40, items: fullVisual() }, visualFailures: [], viewports: [...REQUIRED_VIEWPORTS], review: { reviewer: "r", imagesSeen: 3, vision: true }, revision: "1-3" }).length, 0);
});

// ── Phase gates ───────────────────────────────────────────────────────────────────────────────────────────────────

test("[QUALITY-V2] design at 39/40 cannot unlock the backend phase", () => {
  const nearly: CategoryScore = {
    points: 39, max: 40, state: "scored", reason: null,
    items: VISUAL_RUBRIC.map((i) => ({ id: i.id, points: i.id === "layout" ? 7 : i.max, max: i.max, applicable: true, note: null })),
  };
  const full = { points: 40, max: 40, state: "scored" as const, reason: null, items: [] };
  const twenty = { points: 20, max: 20, state: "scored" as const, reason: null, items: [] };
  const blocked = phaseBlockers({ phase: "design", design: nearly, functionality: full, other: twenty, designCertified: false, designFrozen: false, safetyBlockers: [] });
  assert.deepEqual(blocked, ["the visual design is not certified at 40/40"]);
  const open = phaseBlockers({ phase: "design", design: { ...nearly, points: 40, items: fullVisual() }, functionality: full, other: twenty, designCertified: true, designFrozen: false, safetyBlockers: [] });
  assert.deepEqual(open, [], "a genuine 40/40 opens the gate");
});

test("[QUALITY-V2] the functionality phase cannot start before the freeze is persisted AND platform-verified", () => {
  const full = { points: 40, max: 40, state: "scored" as const, reason: null, items: [] };
  const twenty = { points: 20, max: 20, state: "scored" as const, reason: null, items: [] };
  const unfrozen = phaseBlockers({ phase: "design_locked", design: full, functionality: full, other: twenty, designCertified: true, designFrozen: false, safetyBlockers: [] });
  assert.deepEqual(unfrozen, ["the approved design has not been frozen and verified by the platform"]);
  assert.deepEqual(phaseBlockers({ phase: "design_locked", design: full, functionality: full, other: twenty, designCertified: true, designFrozen: true, safetyBlockers: [] }), []);
});

test("[QUALITY-V2] safety blockers close every gate in every phase, whatever the scores say", () => {
  const full = { points: 40, max: 40, state: "scored" as const, reason: null, items: [] };
  const twenty = { points: 20, max: 20, state: "scored" as const, reason: null, items: [] };
  for (const phase of BUILD_PHASES) {
    const b = phaseBlockers({ phase, design: full, functionality: full, other: twenty, designCertified: true, designFrozen: true, safetyBlockers: ["tenant isolation broken"] });
    assert.deepEqual(b, ["safety: tenant isolation broken"], `${phase}: safety is non-deferrable`);
  }
});

test("[QUALITY-V2] final certification needs all three categories, with no compensating arithmetic", () => {
  const full = { points: 40, max: 40, state: "scored" as const, reason: null, items: [] };
  assert.deepEqual(releaseBlockers({ design: full, functionality: full, other: { points: 20, max: 20, state: "scored", reason: null, items: [] }, designCertified: true }), []);
  // 35/40 design with a mathematically high total.
  const compensating = releaseBlockers({ design: { ...full, points: 35 }, functionality: full, other: { points: 20, max: 20, state: "scored", reason: null, items: [] }, designCertified: false });
  assert.ok(compensating.some((b) => /visual design is not certified/.test(b)));
  // 40/40 design with incomplete backend work.
  const incomplete = releaseBlockers({ design: full, functionality: { ...full, points: 28 }, other: { points: 20, max: 20, state: "scored", reason: null, items: [] }, designCertified: true });
  assert.ok(incomplete.some((b) => /functionality is 28\/40/.test(b)));
  // A category that was never measured cannot be treated as complete.
  const unmeasured = releaseBlockers({ design: full, functionality: { points: 40, max: 40, state: "insufficient_evidence", reason: "no evidence", items: [] }, other: { points: 20, max: 20, state: "scored", reason: null, items: [] }, designCertified: true });
  assert.ok(unmeasured.some((b) => /no evidence/.test(b)), "an unverified category is not complete");
});

test("[QUALITY-V2] the phase order is one step at a time, forward only", () => {
  assert.equal(NEXT_PHASE.design, "design_locked");
  assert.equal(NEXT_PHASE.design_locked, "functionality");
  assert.equal(NEXT_PHASE.functionality, "final_qa");
  assert.equal(NEXT_PHASE.final_qa, "complete");
  assert.equal(NEXT_PHASE.complete, null);
  assert.equal(NEXT_PHASE.waiting, null, "waiting is left by an explicit decision, not by scoring");
});

test("[QUALITY-V2] primaryProgress is the ACTIVE category, not the overall fraction", () => {
  const c = (phase: string, d: number, f: number, o: number) => ({ phase: phase as never, design: { points: d }, functionality: { points: f }, other: { points: o } });
  assert.equal(primaryProgress(c("design", 30, 5, 20), 0.9), 0.75, "design 30/40 during the design phase");
  assert.equal(primaryProgress(c("functionality", 40, 10, 20), 0.9), 0.25, "functionality 10/40 during the functionality phase");
  assert.equal(primaryProgress(c("final_qa", 40, 40, 15), 0.9), 0.75, "remaining 15/20 during final QA");
  assert.equal(primaryProgress(c("waiting", 40, 40, 20), 0.42), 0.42, "with no active category the legacy fraction is kept");
  assert.equal(primaryProgress(null, 0.42), 0.42, "and a legacy runner's card keeps the legacy signal");
  // The case the old guard escalated: design up, total down.
  assert.ok(primaryProgress(c("design", 30, 5, 20), 0) > primaryProgress(c("design", 20, 30, 20), 0),
    "design 20->30 is progress even though the total fell from 70 to 55");
  assert.deepEqual(PRIMARY_PROGRESS.functionality, "functionality");
});

// ── Persistence: the freeze survives, and legacy rows are untouched ───────────────────────────────────────────────

async function world() {
  const t = await createTestApp({ BUILD_RUNNER_SECRET: "s", overrides: { storage: new MemoryStorage(), payments: new FakePayments() } });
  await createStaff(t.db, "owner", "owner@crestmont.test");
  const cu = await createCustomer(t.db, "jitt@matrix.example", "Junk in the Trunk");
  const org = { id: cu.organizationId };
  const pid = newId("prj");
  await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at)
    VALUES (?,?,?,'scope_review',2,'upfront',?,?)`).bind(pid, org.id, "Junk in the Trunk", nowIso(), nowIso()).run();
  const job = newId("bld");
  await t.db.prepare(`INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, state_reason, strategy, package_id, trigger, attempts, quality_required, created_at, updated_at)
    VALUES (?,?,?,'first_build',0,?,'building','running','standard','business','sweep',1,1,?,?)`)
    .bind(job, pid, org.id, `${pid}:first`, nowIso(), nowIso()).run();
  const jobLike = { id: job, project_id: pid, organization_id: org.id, attempts: 1, package_id: "business", strategy: "standard", brief_id: null };
  const snapshot = async (cycle: number, viewports: string[]) => {
    const rev = newId("brev");
    await t.db.prepare(`INSERT INTO build_revisions (id, job_id, project_id, cycle, attempt, phase, score, decision, is_best, reverted, file_count, total_bytes, created_at)
      VALUES (?,?,?,?,1,'repair',NULL,NULL,0,0,?,100,?)`).bind(rev, job, pid, cycle, viewports.length + 1, nowIso()).run();
    await t.db.prepare(`INSERT INTO build_revision_files (revision_id, path, kind, content_type, size_bytes, sha256, storage_key) VALUES (?,?,?,?,?,?,?)`)
      .bind(rev, "index.html", "page", "text/html; charset=utf-8", 10, "a".repeat(64), `k/${rev}/index.html`).run();
    for (const v of viewports) {
      await t.db.prepare(`INSERT INTO build_revision_files (revision_id, path, kind, content_type, size_bytes, sha256, storage_key) VALUES (?,?,?,?,?,?,?)`)
        .bind(rev, `.crestmont/screenshots/home-${v}.png`, "screenshot", "image/png", 10, "b".repeat(64), `k/${rev}/${v}.png`).run();
    }
    return rev;
  };
  return { t, org, pid, job, jobLike, snapshot };
}

test("[QUALITY-V2] a stored revision's own screenshot files decide which viewports are evidenced", async () => {
  const w = await world();
  await w.snapshot(1, ["desktop", "mobile"]);
  assert.deepEqual((await PH.evidencedViewports(w.t.db, w.job, 1, 1)).sort(), ["desktop", "mobile"]);
  await w.snapshot(2, ["desktop", "tablet", "mobile"]);
  assert.deepEqual((await PH.evidencedViewports(w.t.db, w.job, 1, 2)).sort(), ["desktop", "mobile", "tablet"]);
  assert.deepEqual(await PH.evidencedViewports(w.t.db, w.job, 1, 99), [], "a revision that does not exist proves nothing");
});

test("[QUALITY-V2] a verified 40/40 creates a durable design freeze that names a real revision and reviewer", async () => {
  const w = await world();
  await w.snapshot(1, ["desktop", "tablet", "mobile"]);
  const v = verifyScorecard2(card(), { ...SCOPE, evidencedViewports: ["desktop", "tablet", "mobile"] });
  assert.equal(v.designCertified, true);

  const { frozen, blockers } = await PH.freezeDesign(w.t.db, w.jobLike, {
    card: v, revision: { attempt: 1, cycle: 1 }, commitSha: "c".repeat(40), cycle: 1,
    sourceFingerprint: await PH.designFingerprint([{ path: "assets/site.css", sha256: "d".repeat(64) }]),
    screenshots: [".crestmont/screenshots/home-desktop.png"], reviewerModel: "qwen2.5vl:7b",
  });
  assert.deepEqual(blockers, []);
  assert.ok(frozen, "the freeze was stored");
  assert.equal(frozen!.design_points, 40);
  assert.equal(frozen!.platform_verified, 1, "the platform verified it itself; the gate reads this column");
  assert.equal(frozen!.revision_attempt, 1);
  assert.equal(frozen!.revision_cycle, 1);
  assert.equal(frozen!.reviewer, "local:qwen2.5vl");
  assert.ok(frozen!.source_fingerprint, "the frontend fingerprint is recorded so later work can be told it moved");

  // Durable: the phase moved, the snapshot is marked, and both survive being read back fresh.
  assert.equal((await PH.phaseOf(w.t.db, w.job)).build_phase, "design_locked");
  assert.ok(await PH.activeFreeze(w.t.db, w.job));
  const baseline = await w.t.db.prepare(`SELECT is_design_baseline FROM build_revisions WHERE job_id = ? AND cycle = 1`).bind(w.job).first<{ is_design_baseline: number }>();
  assert.equal(baseline!.is_design_baseline, 1, "the Founder can find the authoritative visual baseline among the revisions");
  const m = await PH.milestones(w.t.db, w.job);
  assert.ok(m.some((x) => x.phase === "design_locked" && x.entered === 1), "the milestone is durable, not an in-memory flag");
});

test("[QUALITY-V2] a design certification the platform could not verify does NOT create a freeze, and the refusal is recorded", async () => {
  const w = await world();
  await w.snapshot(1, ["desktop", "mobile"]);
  // The card claims all three viewports; the snapshot holds two.
  const v = verifyScorecard2(card(), { ...SCOPE, evidencedViewports: ["desktop", "mobile"] });
  assert.equal(v.ok, false);
  const { frozen, blockers } = await PH.freezeDesign(w.t.db, w.jobLike, { card: v, revision: { attempt: 1, cycle: 1 }, commitSha: null, cycle: 1 });
  assert.equal(frozen, null, "a runner saying 40/40 is not a design freeze");
  assert.ok(blockers.length > 0);
  assert.equal((await PH.phaseOf(w.t.db, w.job)).build_phase, "design", "the build stays in the design phase");
  const m = await PH.milestones(w.t.db, w.job);
  assert.ok(m.some((x) => x.entered === 0 && x.reason === "design certification refused"), "\"the gate stayed shut, and why\" is as durable as a success");
  assert.ok((JSON.parse(m.find((x) => x.entered === 0)!.blockers_json) as string[]).length > 0, "with its blockers");
});

test("[QUALITY-V2] a visual regression during backend work invalidates the freeze without reverting the functional work", async () => {
  const w = await world();
  await w.snapshot(1, ["desktop", "tablet", "mobile"]);
  const good = verifyScorecard2(card(), { ...SCOPE, evidencedViewports: ["desktop", "tablet", "mobile"] });
  await PH.freezeDesign(w.t.db, w.jobLike, { card: good, revision: { attempt: 1, cycle: 1 }, commitSha: "c".repeat(40), cycle: 1 });
  await PH.advancePhase(w.t.db, w.jobLike, { card: good, cycle: 2 });
  assert.equal((await PH.phaseOf(w.t.db, w.job)).build_phase, "functionality");

  assert.equal(await PH.invalidateFreeze(w.t.db, { id: w.job, organization_id: w.org.id }, "cycle 3: the services grid overlaps the footer at 768px"), true);
  assert.equal(await PH.activeFreeze(w.t.db, w.job), null, "the frozen design no longer holds");
  const history = await PH.freezeHistory(w.t.db, w.job);
  assert.equal(history.length, 1, "the freeze row is kept, not deleted: the certification history stays intact");
  assert.match(history[0].invalidated_reason ?? "", /overlaps the footer/);
  assert.equal((await PH.phaseOf(w.t.db, w.job)).build_phase, "functionality", "and the functional work is NOT reverted to the design phase");

  // Re-certification after a selective repair puts the same freeze back in force.
  assert.equal(await PH.revalidateFreeze(w.t.db, { id: w.job, organization_id: w.org.id }, good), true);
  assert.ok(await PH.activeFreeze(w.t.db, w.job));
});

test("[QUALITY-V2] the frozen design survives a checkpoint recovery: it is rows, not memory", async () => {
  const w = await world();
  await w.snapshot(1, ["desktop", "tablet", "mobile"]);
  const v = verifyScorecard2(card(), { ...SCOPE, evidencedViewports: ["desktop", "tablet", "mobile"] });
  await PH.freezeDesign(w.t.db, w.jobLike, { card: v, revision: { attempt: 1, cycle: 1 }, commitSha: "c".repeat(40), cycle: 1 });
  // "Recovery" here means reading the state back with nothing carried over, which is what a replaced container does.
  const phase = await PH.phaseOf(w.t.db, w.job);
  const freeze = await PH.activeFreeze(w.t.db, w.job);
  assert.equal(phase.build_phase, "design_locked");
  assert.equal(phase.design_freeze_id, freeze!.id, "the job points at the freeze that is authoritative");
  assert.equal(freeze!.revision_attempt, 1);
  assert.equal(freeze!.revision_cycle, 1, "the CORRECT frozen revision is preserved");
});

test("[QUALITY-V2] approval needs a verified 100/100; the refusal says which category is short", async () => {
  const w = await world();
  await w.snapshot(1, ["desktop", "tablet", "mobile"]);
  const short = card({ criteriaOver: { backend: "fail" }, claim: { designCertified: true, eligible: false, functionality: { points: 30, max: 40, items: [], state: "scored", reason: null }, totalPoints: 90, overall: 9 } });
  const rec = await recordQuality(w.t.db, w.jobLike, "cycle", short, { revision: { attempt: 1, cycle: 1 } });
  assert.equal(rec.version, 2);
  assert.equal(rec.eligible, false);
  await assert.rejects(
    () => assertQualityForApproval(w.t.db, { id: w.job, quality_required: 1 }),
    (e: Error) => /visual design 40\/40/.test(e.message) && /frontend and backend 30\/40/.test(e.message) && /remaining quality 20\/20/.test(e.message) && /100\/100/.test(e.message),
    "the refusal names the categories, not just a number",
  );

  // And a genuine 100/100 is accepted.
  await recordQuality(w.t.db, w.jobLike, "cycle", card(), { revision: { attempt: 1, cycle: 1 } });
  await assertQualityForApproval(w.t.db, { id: w.job, quality_required: 1 });
});

test("[QUALITY-V2] a legacy scorecard is stored as legacy, keeps its own 10/10 rule, and is never rewritten", async () => {
  const w = await world();
  // The shape of the Junk in the Trunk card: schema /1, 9.4/10, not eligible.
  const legacy = {
    schema: "crestmont.quality-scorecard/1", packageId: "business", iteration: 3,
    criteria: QUALITY_CRITERIA.map((id) => ({ id, name: id, applicable: id !== "payments", status: id === "payments" ? "not_applicable" : id === "integrations" ? "fail" : "pass", evidence: ["fixture"], reason: null })),
    score: 9.4, eligible: false, waitingExternal: false, defects: [], computedAt: nowIso(),
  };
  assert.equal(isScorecardV2(legacy), false);
  const rec = await recordQuality(w.t.db, w.jobLike, "ready_for_review", legacy);
  assert.equal(rec.version, 1, "an older runner's card is still verified and stored");
  const row = (await latestQuality(w.t.db, w.job))!;
  assert.equal(row.schema_version, "crestmont.quality-scorecard/1", "and is identified as legacy scoring");
  assert.equal(row.design_points, null, "with no fabricated category breakdown");
  assert.equal(row.functionality_points, null);
  assert.equal(row.total_points, null);
  assert.equal(row.build_phase, null);
  // Its own rule still applies, unchanged: a legacy card is eligible only at a verified 10/10.
  await assert.rejects(() => assertQualityForApproval(w.t.db, { id: w.job, quality_required: 1 }), /only a verified 10\/10/);
});

test("[QUALITY-V2] the existing Junk in the Trunk build is not altered by any of this", async () => {
  // Historical data is read, never rewritten. A build that predates the phase machine reports "design" because it
  // never passed a design gate -- claiming any later phase for it would be a backfilled fiction.
  const w = await world();
  assert.equal((await PH.phaseOf(w.t.db, w.job)).build_phase, "design");
  assert.equal((await PH.phaseOf(w.t.db, w.job)).design_freeze_id, null);
  assert.deepEqual(await PH.freezeHistory(w.t.db, w.job), []);
  assert.deepEqual(await PH.milestones(w.t.db, w.job), []);
});

test("[QUALITY-V2] per-phase efficiency metrics accumulate and are measured, never estimated", async () => {
  const w = await world();
  await PH.recordPhaseMetrics(w.t.db, w.jobLike, "design", { inferenceCalls: 4, outputTokens: 1200, elapsedMs: 60_000, reviews: 1, revisions: 2 });
  await PH.recordPhaseMetrics(w.t.db, w.jobLike, "design", { inferenceCalls: 3, outputTokens: 800, elapsedMs: 30_000, reviews: 1, rollbacks: 1 });
  await PH.recordPhaseMetrics(w.t.db, w.jobLike, "functionality", { inferenceCalls: 9, outputTokens: 5000, elapsedMs: 300_000 });
  const m = await PH.phaseMetrics(w.t.db, w.job);
  const design = m.find((x) => x.phase === "design")!;
  assert.equal(design.inference_calls, 7, "accumulated, not overwritten");
  assert.equal(design.output_tokens, 2000);
  assert.equal(design.rollbacks, 1);
  assert.equal(m.find((x) => x.phase === "functionality")!.inference_calls, 9);
  assert.equal(m.length, 2, "one row per phase per attempt");
});
