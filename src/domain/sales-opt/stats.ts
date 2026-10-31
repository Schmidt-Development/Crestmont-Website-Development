// Statistics for sales-optimization metrics and experiments (SALESOPT-004, SALESOPT-009). Pure: no I/O.
//
// Conversion is a proportion of CONNECTED calls that led to a verified (webhook-confirmed, not refunded or
// disputed) payment. Intervals are Wilson score intervals; arm comparisons use a two-proportion z-test with a
// Wilson/Newcombe difference interval. Nothing here is a claim that a difference is real-world causal: the
// experiment decision only says whether the data meets the Founder-approved bar.

/** Standard-normal quantile for the two-sided levels the platform uses. */
export const Z: Readonly<Record<string, number>> = { "0.90": 1.6449, "0.95": 1.96, "0.99": 2.5758 };

export interface Interval { low: number; high: number }

/** Wilson score interval for k successes out of n. n = 0 → the uninformative [0, 1]. */
export function wilson(k: number, n: number, z = Z["0.95"]): Interval {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) return { low: 0, high: 1 };
  const p = Math.min(Math.max(k / n, 0), 1);
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Newcombe (hybrid Wilson) interval for p1 − p2. */
export function diffInterval(k1: number, n1: number, k2: number, n2: number, z = Z["0.95"]): Interval {
  const a = wilson(k1, n1, z), b = wilson(k2, n2, z);
  const p1 = n1 ? k1 / n1 : 0, p2 = n2 ? k2 / n2 : 0;
  const d = p1 - p2;
  return {
    low: d - Math.sqrt((p1 - a.low) ** 2 + (b.high - p2) ** 2),
    high: d + Math.sqrt((a.high - p1) ** 2 + (p2 - b.low) ** 2),
  };
}

/** Two-sided p-value of the pooled two-proportion z-test. */
export function twoProportionP(k1: number, n1: number, k2: number, n2: number): number {
  if (n1 <= 0 || n2 <= 0) return 1;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = Math.abs(k1 / n1 - k2 / n2) / se;
  return 2 * (1 - normalCdf(z));
}

/** Abramowitz–Stegun 7.1.26 approximation (|error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export const rate = (k: number, n: number): number | null => (n > 0 ? k / n : null);

// ───────────── Safety thresholds ─────────────

/** Founder-adjustable limits (so_control.thresholds_json). Defaults are conservative. */
export interface SafetyThresholds {
  /** Minimum connected calls on a version before any safety rate is judged. */
  minConnected: number;
  /** Opt-out requests per connected call. */
  maxOptOutRate: number;
  /** Compliance findings (observed) per analysed call. */
  maxComplianceRate: number;
  /** Complaints (escalations with a complaint finding) per connected call. */
  maxComplaintRate: number;
  /** Calls ending in error per attempt. */
  maxErrorRate: number;
  /** Refunds + disputes per attributed sale. */
  maxRefundRate: number;
}

export const DEFAULT_THRESHOLDS: SafetyThresholds = {
  minConnected: 50, maxOptOutRate: 0.15, maxComplianceRate: 0.02, maxComplaintRate: 0.05, maxErrorRate: 0.05, maxRefundRate: 0.2,
};

export function parseThresholds(json: string | null | undefined): SafetyThresholds {
  let raw: Record<string, unknown> = {};
  try { raw = json ? JSON.parse(json) : {}; } catch { raw = {}; }
  const out = { ...DEFAULT_THRESHOLDS };
  for (const k of Object.keys(DEFAULT_THRESHOLDS) as (keyof SafetyThresholds)[]) {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (k === "minConnected") { if (v >= 20 && v <= 100_000) out[k] = Math.round(v); }
    else if (v > 0 && v <= 1) out[k] = v;
  }
  return out;
}

export interface SafetyCounts { attempts: number; connected: number; analysed: number; optOuts: number; complianceFindings: number; complaints: number; errors: number; sales: number; refundsOrDisputes: number }

export interface SafetyBreach { metric: string; value: number; limit: number }

/**
 * Breaches are judged on the LOWER bound of the Wilson interval, so a version is only stopped when the data
 * shows the rate is above the limit with 95% confidence — except compliance, where any rate above the limit
 * on the point estimate counts once the minimum sample is reached (compliance failures are not traded off).
 */
export function safetyBreaches(c: SafetyCounts, t: SafetyThresholds): SafetyBreach[] {
  const out: SafetyBreach[] = [];
  if (c.connected < t.minConnected) return out;
  const lowerAbove = (k: number, n: number, limit: number, metric: string) => {
    if (n <= 0) return;
    const lb = wilson(k, n).low;
    if (lb > limit) out.push({ metric, value: k / n, limit });
  };
  lowerAbove(c.optOuts, c.connected, t.maxOptOutRate, "opt_out_rate");
  lowerAbove(c.complaints, c.connected, t.maxComplaintRate, "complaint_rate");
  lowerAbove(c.errors, c.attempts, t.maxErrorRate, "error_rate");
  if (c.analysed > 0 && c.complianceFindings / c.analysed > t.maxComplianceRate) out.push({ metric: "compliance_rate", value: c.complianceFindings / c.analysed, limit: t.maxComplianceRate });
  if (c.sales >= 10) lowerAbove(c.refundsOrDisputes, c.sales, t.maxRefundRate, "refund_rate");
  return out;
}

// ───────────── Experiment decisions ─────────────

export interface ArmCounts { connected: number; conversions: number; revenueCents: number; safety: SafetyCounts }

export type ExperimentDecision =
  | { decision: "stop_safety"; detail: string; breaches: SafetyBreach[] }
  | { decision: "continue"; detail: string }
  | { decision: "candidate_better"; detail: string }
  | { decision: "no_difference"; detail: string }
  | { decision: "baseline_better"; detail: string };

/**
 * Never promotes on a small sample: both arms need min_connected_per_arm connected calls, and "candidate_better"
 * requires the whole 95% interval of (candidate − baseline) conversion to be above zero AND no safety breach.
 * The result is a recommendation; promotion is still a Founder decision.
 */
export function decideExperiment(base: ArmCounts, cand: ArmCounts, minPerArm: number, t: SafetyThresholds): ExperimentDecision {
  const breaches = safetyBreaches(cand.safety, t);
  if (breaches.length) return { decision: "stop_safety", detail: `Candidate breached ${breaches.map((b) => `${b.metric} ${(b.value * 100).toFixed(1)}% > ${(b.limit * 100).toFixed(1)}%`).join(", ")}`, breaches };
  if (base.connected < minPerArm || cand.connected < minPerArm) {
    return { decision: "continue", detail: `Need ${minPerArm} connected calls per arm (baseline ${base.connected}, candidate ${cand.connected}).` };
  }
  const d = diffInterval(cand.conversions, cand.connected, base.conversions, base.connected);
  const p = twoProportionP(cand.conversions, cand.connected, base.conversions, base.connected);
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const detail = `Conversion candidate ${pct(cand.conversions / cand.connected)} vs baseline ${pct(base.conversions / base.connected)}; difference 95% CI [${pct(d.low)}, ${pct(d.high)}], p=${p.toFixed(4)}.`;
  if (d.low > 0) return { decision: "candidate_better", detail };
  if (d.high < 0) return { decision: "baseline_better", detail };
  return { decision: "no_difference", detail };
}

/** Deterministic arm assignment: the same lead always lands in the same arm of an experiment. */
export async function assignArm(experimentId: string, leadKey: string, candidateShare: number): Promise<"baseline" | "candidate"> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${experimentId}\n${leadKey}`)));
  const bucket = ((digest[0] << 24) >>> 0 | digest[1] << 16 | digest[2] << 8 | digest[3]) >>> 0;
  return bucket / 0x1_0000_0000 < candidateShare ? "candidate" : "baseline";
}
