// The repair ratchet: a build must not be able to walk away from its own best work.
//
// WHY THIS EXISTS. Measured on Node 1 (build bld_d6090c28f8e6923c75223307, 2026-11-02): the independently certified
// quality score went 7.50 -> 7.16 -> 7.22 -> 6.94 across four review cycles. Every repair was kept whatever it did to
// the site, so the build could only lose ground, and the LAST state -- the worst one -- was what the customer would
// have received. A score is a measurement, so it is treated as one: keep the best revision, and when a repair
// measurably loses ground, go back to it before trying again.
//
// The bounded repair loop is a different guarantee and does not give this one. It stops a build that stops
// IMPROVING; it has nothing to say about which revision the customer ends up with, and it will happily end on the
// worst one. (Failure modes F05, F10, F12, F15, F16, F20.)
//
// This is a pure function of the measurements, deliberately: it holds no state, reads no files and is driven by
// whatever 0-10 quality measurement the orchestrator already has -- here the quality scorecard's own score, so no
// second notion of quality is introduced alongside it.

/**
 * How much the score must move before a change counts as real rather than measurement noise.
 *
 * 0.15 comes from the reviewer scoring each category in halves, which moves a weighted figure in steps of about 0.1.
 * The scorecard this runner computes moves in larger steps than that (one criterion of about twenty, so roughly 0.5),
 * so against that measurement any single criterion flipping is a real move -- which is the intended reading: a
 * criterion changing state is a fact about the website, not noise.
 */
export const QUALITY_EPSILON = 0.15;

/**
 * Repairs that lower the score in a row before the build stops repairing. Two is deliberate: one regression can be
 * an unlucky attempt, two in a row means the loop is not converging and further GPU time is waste.
 */
export const MAX_REGRESSIONS = 2;

export type RatchetAction =
  /** The best score so far: this revision is the one to protect. */
  | { action: "record-best" }
  /** Within epsilon of the best: the repair held the line, so it is kept. */
  | { action: "keep" }
  /** A real drop: go back to the best revision and try again. */
  | { action: "revert"; regressions: number }
  /** A real drop, and enough of them in a row that repairing is no longer converging. */
  | { action: "revert-and-stop"; regressions: number }
  /** Nothing measured yet, so there is nothing to compare or protect. */
  | { action: "uncertified" };

export function ratchetDecision(
  current: number | null,
  best: number | null,
  regressions: number,
  o: { epsilon?: number; maxRegressions?: number } = {},
): RatchetAction {
  const eps = o.epsilon ?? QUALITY_EPSILON;
  const max = o.maxRegressions ?? MAX_REGRESSIONS;
  if (current === null) return { action: "uncertified" };
  if (best === null || current > best + eps) return { action: "record-best" };
  if (current < best - eps) {
    const n = regressions + 1;
    return n >= max ? { action: "revert-and-stop", regressions: n } : { action: "revert", regressions: n };
  }
  return { action: "keep" };
}
