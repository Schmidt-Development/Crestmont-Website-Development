// How the research → CRM import rate is judged. Pure functions, no database: the staging certifier
// (scripts/research-promotion-certify.ts) reads the rows and these decide what the rows mean.
//
// They are here, and tested, because each one encodes a distinction that is easy to get wrong in a way that flatters
// the result:
//
//   - a high average is not sustained performance;
//   - a shortened window cannot certify a full hour, however good the rate over it was;
//   - and a supply shortage is neither a pass nor a throughput failure.

/** A check can pass, fail, or have been impossible to attempt. "blocked" is never a pass. */
export type Outcome = "pass" | "fail" | "blocked";

export interface MinuteCount { minute: string; leads: number }

export interface SustainedVerdict {
  outcome: Outcome;
  /** Working minutes that individually reached the target. */
  atTarget: number;
  /** How many were needed. */
  needed: number;
  /** The weakest minutes, worst first, for diagnosis. */
  worst: MinuteCount[];
}

/**
 * Sustained means minute by minute, with no average allowed to stand in for it.
 *
 * 300 leads in one minute followed by 59 idle minutes is 5/minute on average and is not a system sustaining 25 a
 * minute; a check that accepted "or the window average is fine" would certify exactly that. So every working minute
 * is counted on its own and a share of them must reach the target. The share is 90%, which tolerates one slow
 * minute in ten — a tick delayed by a slow D1 response, say — without tolerating a burst.
 */
export function judgeSustained(minutes: MinuteCount[], target: number, sharePercent = 90): SustainedVerdict {
  const atTarget = minutes.filter((m) => m.leads >= target).length;
  const needed = Math.ceil(minutes.length * (sharePercent / 100));
  const worst = [...minutes].filter((m) => m.leads < target).sort((a, b) => a.leads - b.leads).slice(0, 5);
  return { outcome: minutes.length > 0 && atTarget >= needed ? "pass" : "fail", atTarget, needed, worst };
}

export interface HourVerdict {
  outcome: Outcome;
  /** The best contiguous hour that lay entirely inside the supplied stretch, when one existed. */
  bestHour: { start: string; leads: number } | null;
  /** Leads the hour target required. */
  needed: number;
  reason: string;
}

/**
 * Certifies a full hour, and only ever from a full hour.
 *
 * Two ways this is blocked rather than judged: the measured window was shorter than an hour, or eligible supply ran
 * out inside it so no supplied hour exists. Both are reported as "blocked", because a shortened window carries no
 * information about an hour in either direction — passing it would certify an hour that was never observed, and
 * failing it would record a throughput defect that the evidence does not show.
 *
 * `workingMinutes` is the number of minutes from the window's start during which there was work to do.
 */
export function judgeFullHour(o: {
  windowMinutes: number;
  workingMinutes: number;
  minutes: MinuteCount[];
  target: number;
  drainedAt?: string | null;
  hourMinutes?: number;
}): HourVerdict {
  const hour = o.hourMinutes ?? 60;
  const needed = o.target * hour;
  if (o.windowMinutes < hour) {
    return { outcome: "blocked", bestHour: null, needed,
      reason: `the measured window is ${o.windowMinutes} minutes; an hour cannot be certified from less than ${hour}` };
  }
  if (o.workingMinutes < hour) {
    return { outcome: "blocked", bestHour: null, needed,
      reason: `eligible supply lasted only ${o.workingMinutes} minutes of the ${o.windowMinutes}-minute window`
        + (o.drainedAt ? ` (it ran out at ${o.drainedAt.slice(11, 19)}Z)` : "")
        + `, so no supplied hour exists to certify. That is a supply shortage, not a throughput failure.` };
  }
  const supplied = o.minutes.slice(0, o.workingMinutes);
  let bestHour: { start: string; leads: number } | null = null;
  for (let i = 0; i + hour <= supplied.length; i++) {
    const leads = supplied.slice(i, i + hour).reduce((a, m) => a + m.leads, 0);
    if (!bestHour || leads > bestHour.leads) bestHour = { start: supplied[i].minute, leads };
  }
  if (!bestHour) {
    return { outcome: "blocked", bestHour: null, needed, reason: "no contiguous hour of per-minute counts was available" };
  }
  return {
    outcome: bestHour.leads >= needed ? "pass" : "fail",
    bestHour, needed,
    reason: `best fully-supplied ${hour}-minute stretch (from ${bestHour.start}Z) created ${bestHour.leads} unattended CRM leads; the hour target is ${needed}`,
  };
}

/** Certified only when every check passed. A blocked check is not a pass. */
export function certified(outcomes: Outcome[]): boolean {
  return outcomes.length > 0 && outcomes.every((o) => o === "pass");
}
