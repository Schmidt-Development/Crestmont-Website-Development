// The phase-aware repair ratchet: a build must not walk away from its best work, and must not be stopped for
// losing ground in a category it is not working on yet.
//
// WHY IT EXISTS AT ALL. Measured on Node 1 (bld_d6090c28f8e6923c75223307, 2026-11-02): the certified score went
// 7.50 -> 7.16 -> 7.22 -> 6.94 across four review cycles. Every repair was kept whatever it did, so the build could
// only lose ground and the LAST state -- the worst one -- was what the customer would have received. So the best
// revision is kept, and a repair that measurably loses ground goes back to it.
//
// WHY IT CHANGED. The first version ratcheted on ONE scalar: the overall score. Under the design-first architecture
// that is the wrong measurement, and actively harmful. A cycle that takes the design from 20/40 to 30/40 while
// backend functionality temporarily falls from 30/40 to 5/40 drops the total from 7.0 to 5.5 -- and the scalar
// ratchet would have reverted it, destroying ten points of hard-won design work to protect backend code the build is
// deliberately not building yet. "Never discard a better design solely because backend points dropped."
//
// So the measurement is now the ACTIVE PHASE's own category, and the invariants of the categories already certified
// are checked separately. A frozen design that regresses is not noise to be averaged away: it is a separate, named
// outcome (`repair-frozen`) asking for a selective repair that keeps the functional work, rather than a
// whole-project revert that throws it away.
//
// This stays a pure function of the measurements: no state, no files, no I/O. Everything it needs is passed in.

import { CATEGORY_MAX, PRIMARY_PROGRESS, type BuildPhase } from "../quality-weighted.ts";

/**
 * How far a category's points must move before the change is real rather than measurement noise.
 *
 * On the 0-40 point scale the reviewer scores each visual rubric item in halves, so the smallest honest movement is
 * half a point. 0.4 sits just under that: a single half-point judgement counts as a real move, while a rounding
 * artefact does not. (The old scalar epsilon was 0.15 on the 0-10 overall scale -- the same ratio.)
 */
export const POINT_EPSILON = 0.4;

/**
 * Repairs that lower the ACTIVE category in a row before the build stops repairing. Two is deliberate: one
 * regression can be an unlucky attempt, two in a row means the loop is not converging and further GPU time is waste.
 */
export const MAX_REGRESSIONS = 2;

/**
 * Cycles with no measurable active-phase progress before the loop escalates. A cycle that completes a rubric item,
 * freezes a phase or verifies a new integration is progress even when the number has not moved yet -- that is what
 * `milestoneReached` carries. Three cycles with neither a milestone nor a point is genuine stagnation.
 */
export const MAX_IDLE_CYCLES = 3;

export interface PhasePoints {
  design: number;
  functionality: number;
  other: number;
}

export interface RatchetInput {
  phase: BuildPhase;
  /** This cycle's measured category points, or null when nothing was certified this cycle. */
  current: PhasePoints | null;
  /** The best card measured IN THIS PHASE so far. Phases do not share a best: a new phase starts its own. */
  best: PhasePoints | null;
  /** The design still passes its full certification on the current tree. */
  designCertified: boolean;
  /** A persisted, platform-verified design freeze exists, so a design regression regresses a FROZEN baseline. */
  designFrozen: boolean;
  /** Consecutive active-category regressions so far. */
  regressions: number;
  /** Consecutive cycles with neither an active-category gain nor a milestone. */
  idleCycles: number;
  /** A rubric item completed, a phase frozen, an integration verified: progress the number may not show yet. */
  milestoneReached: boolean;
  /** Critical security, data-integrity, budget or lease problems. Non-deferrable in EVERY phase. */
  safetyBlockers: string[];
  epsilon?: number;
  maxRegressions?: number;
}

export type RatchetAction =
  /** The best active-category result so far: this revision is the one to protect. */
  | { action: "record-best"; reason: string }
  /** Held the line in the active category (or improved it while another category fell): kept. */
  | { action: "keep"; reason: string }
  /**
   * A category that was already certified has regressed. The work in this revision is NOT thrown away: the build
   * repairs the regression selectively and re-certifies, because reverting would also revert the progress that
   * caused it.
   */
  | { action: "repair-frozen"; reason: string; regressed: "design" | "functionality" }
  /** A real drop in the ACTIVE category: go back to the best revision of this phase and try again. */
  | { action: "revert"; reason: string; regressions: number }
  /** Enough active-category drops in a row that repairing is no longer converging. */
  | { action: "revert-and-stop"; reason: string; regressions: number }
  /** No active-phase progress for MAX_IDLE_CYCLES: escalate for a targeted diagnostic rather than loop. */
  | { action: "escalate"; reason: string }
  /** A safety-critical problem. Stops regardless of any score, in any phase. */
  | { action: "halt"; reason: string }
  /** Nothing measured yet, so there is nothing to compare or protect. */
  | { action: "uncertified"; reason: string };

/** The category whose points are the progress signal in this phase. */
export const activeCategory = (phase: BuildPhase) => PRIMARY_PROGRESS[phase];

export function ratchetDecision(i: RatchetInput): RatchetAction {
  const eps = i.epsilon ?? POINT_EPSILON;
  const max = i.maxRegressions ?? MAX_REGRESSIONS;

  // 1. Safety first, in every phase. A design score going up never licenses shipping a security regression.
  if (i.safetyBlockers.length) {
    return { action: "halt", reason: `Safety-critical problem, which no score improvement overrides: ${i.safetyBlockers.slice(0, 3).join("; ").slice(0, 400)}` };
  }
  if (!i.current) return { action: "uncertified", reason: "nothing was certified this cycle, so there is nothing to compare" };

  // 2. A category already certified must not regress unnoticed -- but repairing it selectively beats reverting,
  //    because the revision that broke it also carries the work that broke it on purpose.
  const frozen = frozenRegression(i);
  if (frozen) return frozen;

  const cat = activeCategory(i.phase);
  if (!cat) return { action: "keep", reason: `phase "${i.phase}" has no active category to ratchet on` };

  const now = i.current[cat];
  const before = i.best ? i.best[cat] : null;

  // 3. Progress in the active category. The overall total is deliberately not consulted: it may fall.
  if (before === null || now > before + eps) {
    return { action: "record-best", reason: `${cat} improved to ${round(now)}/${CATEGORY_MAX[cat]}${before === null ? "" : ` from ${round(before)}`}, so this revision is the one to protect` };
  }
  if (now < before - eps) {
    const n = i.regressions + 1;
    const reason = `${cat} fell from ${round(before)} to ${round(now)} of ${CATEGORY_MAX[cat]}: the repair lost ground in the phase's own category`;
    return n >= max
      ? { action: "revert-and-stop", reason: `${reason}, ${n} cycles in a row`, regressions: n }
      : { action: "revert", reason, regressions: n };
  }

  // 4. Held the line. A milestone means the cycle did something even if the number did not move; without one,
  //    enough idle cycles mean a person should look rather than the GPU keep spending.
  if (i.milestoneReached) return { action: "keep", reason: `${cat} held at ${round(now)}/${CATEGORY_MAX[cat]} and the cycle completed a milestone` };
  if (i.idleCycles + 1 >= MAX_IDLE_CYCLES) {
    return { action: "escalate", reason: `${MAX_IDLE_CYCLES} cycles with no measurable progress in ${cat} (still ${round(now)}/${CATEGORY_MAX[cat]}) and no completed milestone; escalated for a targeted diagnostic instead of repeating the repair` };
  }
  return { action: "keep", reason: `${cat} held at ${round(now)}/${CATEGORY_MAX[cat]}` };
}

/**
 * A regression in a category this build has already certified. Design is checked whenever it is frozen and the build
 * has moved past the design phase; functionality once the build has reached final QA. Both are reported as
 * `repair-frozen` so the caller repairs selectively rather than reverting.
 */
function frozenRegression(i: RatchetInput): RatchetAction | null {
  if (i.designFrozen && !i.designCertified && i.phase !== "design") {
    return {
      action: "repair-frozen", regressed: "design",
      reason: "the frozen design no longer passes its certification on this revision: repair the visual regression and re-certify, keeping the functional work this cycle produced",
    };
  }
  if (i.current && (i.phase === "final_qa" || i.phase === "complete") && i.current.functionality < CATEGORY_MAX.functionality - POINT_EPSILON) {
    return {
      action: "repair-frozen", regressed: "functionality",
      reason: `functionality fell to ${round(i.current.functionality)}/${CATEGORY_MAX.functionality} after it was certified: repair it before completing the remaining quality work`,
    };
  }
  return null;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** True when this action means the build keeps the current tree rather than restoring an earlier one. */
export const keepsTree = (a: RatchetAction) => a.action === "record-best" || a.action === "keep" || a.action === "repair-frozen" || a.action === "uncertified";

/** True when the build stops after this action (a person decides what happens next). */
export const stopsBuild = (a: RatchetAction) => a.action === "revert-and-stop" || a.action === "escalate" || a.action === "halt";
