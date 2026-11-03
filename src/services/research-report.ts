// Research performance report over a measurement window: pure aggregation, no I/O, so the arithmetic can be tested.
// Fed by scripts/research-24h-report.ts, which reads the rows from staging D1.
//
// Two rules this module exists to enforce:
//  1. The funnel stages are never conflated. Discovered, evaluated, websites checked, opportunities, qualified,
//     delivered, CRM leads and callable contacts are separate numbers and stay separate all the way to the summary.
//  2. A rate is only ever reported for time that was actually observed. Worker counters are cumulative for the
//     worker's own UTC day, so progress is the sum of positive differences between consecutive samples of the same
//     (runner, day). Nothing is extrapolated from a partial window: `complete` says whether 24 hours really elapsed.

/** One row of research_runner_samples (migration 0070). */
export interface SampleRow {
  bucket: string; runner_id: string; at: string; day: string;
  evaluated: number; websites_checked: number; failed_jobs: number; sent: number; records_per_hour: number;
  queue_depth: number; outbox_depth: number; paused: number; auth_failed: number;
  cpu_pct: number | null; ram_used_gb: number | null; ram_total_gb: number | null; rss_mb: number | null;
  disk_free_gb: number | null; gpu_util_pct: number | null; gpu_mem_used_mb: number | null; gpu_name: string | null;
  drafts_pending: number | null; drafts_done: number | null; drafts_dropped: number | null; drafts_deferrals: number | null;
}

/** One row of research_batches, restricted to the window by received_at. */
export interface BatchRow {
  received_at: string; record_count: number; created: number; updated: number; unchanged: number;
  rejected: number; crm_matches: number; duplicates_prevented: number;
}

/** Counts read straight from research_prospects / audit_logs for the window. */
export interface ProspectCounts {
  qualifiedInWindow: number;        // prospects whose evidence qualified, first seen in the window
  awaitingDecision: number;         // status qualified or review (any age)
  reviewInWindow: number;
  suppressedInWindow: number;
  existingCrmInWindow: number;
  notQualifiedInWindow: number;
  eligibleForCalling: number;       // must be 0; the outbound gate is closed by design
  byClassInWindow: Record<string, number>;
}

export interface ReportInput {
  windowStart: string;
  windowEnd: string;
  now: string;
  target: number;                   // qualified prospects per 24 h the run is striving for
  samples: SampleRow[];
  batches: BatchRow[];
  prospects: ProspectCounts;
  promoted: number;                 // audit_logs research.prospect_promoted in the window
  promotionBlocked: number;         // audit_logs research.promotion_blocked in the window
}

export interface HourPoint { hour: string; evaluated: number; websitesChecked: number; failures: number; delivered: number; buckets: number; complete: boolean }

const BUCKETS_PER_HOUR = 4;
/**
 * The classes that represent an evidence-backed website opportunity, i.e. the ones the worker sends at all. A
 * verified, healthy site and an unverified or uncertain one are NOT opportunities and are never counted as such.
 */
export const OPPORTUNITY_CLASSES = ["VERIFIED_WEBSITE_BROKEN", "VERIFIED_WEBSITE_ISSUES", "NO_OFFICIAL_WEBSITE_FOUND"] as const;
const num = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/**
 * Progress per hour, from a worker counter that is cumulative for the worker's own UTC day.
 *
 * Three cases, per runner, in bucket order:
 *  - the first sample has no baseline, so whatever happened before the window is not counted as ours;
 *  - the worker's day changed: its counters restarted at 0 at midnight, so the new sample's own value IS the
 *    progress since midnight (taking a difference across the boundary would read as a large negative);
 *  - otherwise the difference, and a drop (a fresh state file mid-day) contributes 0 rather than a negative or an
 *    inflated jump.
 *
 * This deliberately under-reports rather than over-reports: work done between the last sample of one day and
 * midnight is never observed, so a 15-minute sampling interval can lose up to one bucket at each day boundary.
 */
function deltas(rows: SampleRow[], field: "evaluated" | "websites_checked" | "failed_jobs" | "sent"): Map<string, number> {
  const byHour = new Map<string, number>();
  const byRunner = new Map<string, SampleRow[]>();
  for (const r of rows) (byRunner.get(r.runner_id) ?? byRunner.set(r.runner_id, []).get(r.runner_id)!).push(r);
  for (const g of byRunner.values()) {
    g.sort((a, b) => a.bucket.localeCompare(b.bucket));
    for (let i = 1; i < g.length; i++) {
      const cur = g[i]!, prev = g[i - 1]!;
      const d = cur.day !== prev.day ? cur[field] : cur[field] - prev[field];
      if (d <= 0) continue;
      const hour = cur.bucket.slice(0, 13);
      byHour.set(hour, (byHour.get(hour) ?? 0) + d);
    }
  }
  return byHour;
}

function sum(m: Map<string, number>): number { let n = 0; for (const v of m.values()) n += v; return n; }

export interface ResearchReport {
  window: { start: string; end: string; generatedAt: string; hoursObserved: number; complete: boolean };
  worker: {
    runners: string[]; samples: number; expectedSamples: number; uptimePct: number | null;
    pausedSamples: number; authFailedSamples: number; lastSampleAt: string | null; lastQueueDepth: number | null; lastOutboxDepth: number | null;
    /** True when every check-in came from the staging deploy's end-to-end test rather than a real worker. */
    onlyDeployTestRunners: boolean;
  };
  funnel: {
    businessesEvaluated: number; websitesChecked: number; processingFailures: number;
    websiteOpportunities: number; opportunitiesByClass: Record<string, number>;
    qualifiedProspects: number; recordsDeliveredToStaging: number; recordsCreated: number; recordsUpdated: number;
    recordsUnchanged: number; recordsRejected: number; duplicatesPrevented: number; crmMatches: number;
    crmLeadsCreated: number; promotionsBlocked: number; prospectsAwaitingDecision: number;
    contactsEligibleForAutomatedCalling: number;
  };
  rates: {
    hourly: HourPoint[];
    evaluatedPerHourMean: number | null; qualifiedPerHourMean: number | null;
    peakSustainedHour: HourPoint | null; worstCompleteHour: HourPoint | null;
    observedQualificationRate: number | null;
    /** Why the rate is null, when it is. Reported so a withheld figure is never read as a zero. */
    rateWithheldBecause: string | null;
    deliveredPerHourMean: number | null;
  };
  resources: {
    cpuPctMax: number | null; cpuPctMean: number | null; ramUsedGbMax: number | null; ramTotalGb: number | null;
    rssMbMax: number | null; diskFreeGbMin: number | null;
    gpuName: string | null; gpuUtilPctMax: number | null; gpuMemUsedMbMax: number | null;
    draftsDone: number | null; draftsDeferrals: number | null; draftsDropped: number | null;
  };
  target: {
    qualifiedTarget: number; qualifiedAchieved: number; shortfall: number; achieved: boolean;
    projectedDailyQualified: number | null; projectedDailyEvaluated: number | null;
    limitingFactor: string; nextChange: string;
    claimable: string;
  };
}

export function buildReport(input: ReportInput): ResearchReport {
  const inWindow = input.samples.filter((s) => s.at >= input.windowStart && s.at <= input.windowEnd);
  const evaluated = deltas(inWindow, "evaluated");
  const websites = deltas(inWindow, "websites_checked");
  const failures = deltas(inWindow, "failed_jobs");

  const startMs = Date.parse(input.windowStart), endMs = Date.parse(input.windowEnd), nowMs = Date.parse(input.now);
  const observedEndMs = Math.min(endMs, nowMs);
  const hoursObserved = Math.max(0, (observedEndMs - startMs) / 3600e3);
  const complete = nowMs >= endMs;

  const runners = [...new Set(inWindow.map((s) => s.runner_id))].sort();
  const expectedSamples = Math.max(0, Math.round((hoursObserved * BUCKETS_PER_HOUR))) * Math.max(1, runners.length);
  const last = inWindow.length ? inWindow.reduce((a, b) => (a.at > b.at ? a : b)) : null;

  // Delivery is a true timestamp series, independent of the worker's own counters.
  const delivered = new Map<string, number>();
  for (const b of input.batches) {
    const h = b.received_at.slice(0, 13);
    delivered.set(h, (delivered.get(h) ?? 0) + b.record_count);
  }

  const hours = [...new Set([...evaluated.keys(), ...websites.keys(), ...failures.keys(), ...delivered.keys()])].sort();
  const bucketsPerHour = new Map<string, number>();
  for (const s of inWindow) {
    const h = s.bucket.slice(0, 13);
    bucketsPerHour.set(h, (bucketsPerHour.get(h) ?? 0) + 1);
  }
  const hourly: HourPoint[] = hours.map((hour) => {
    const buckets = bucketsPerHour.get(hour) ?? 0;
    return {
      hour, evaluated: evaluated.get(hour) ?? 0, websitesChecked: websites.get(hour) ?? 0,
      failures: failures.get(hour) ?? 0, delivered: delivered.get(hour) ?? 0,
      buckets,
      // A rate is only a full hour's rate when the worker reported through the whole hour. Counting deltas needs a
      // preceding sample, so a complete hour has all 4 buckets (per runner).
      complete: buckets >= BUCKETS_PER_HOUR * Math.max(1, runners.length),
    };
  });
  const completeHours = hourly.filter((h) => h.complete);

  const totalEvaluated = sum(evaluated);
  const totalWebsites = sum(websites);
  const totalFailures = sum(failures);
  const totalDelivered = input.batches.reduce((a, b) => a + b.record_count, 0);

  const mean = (n: number) => (hoursObserved > 0 ? n / hoursObserved : null);
  const qualified = input.prospects.qualifiedInWindow;
  /**
   * Qualified ÷ evaluated is only meaningful when both describe the same work. They do not over a short window:
   * `qualified` counts prospects the PLATFORM first saw in the window, while `totalEvaluated` counts what the
   * WORKER reported finishing in it, and a prospect can be delivered minutes after it was evaluated. A 30-minute
   * read of a paused worker produced "3500%" (70 newly seen against 2 evaluated), which is not a yield at all.
   *
   * So the rate is reported only when the denominator both contains enough work to mean something and is at least
   * as large as the numerator. Otherwise it is withheld as not measurable, never printed as a percentage.
   */
  const MIN_EVALUATED_FOR_RATE = 100;
  const rateIsMeaningful = totalEvaluated >= MIN_EVALUATED_FOR_RATE && totalEvaluated >= qualified;
  const observedQualificationRate = rateIsMeaningful ? qualified / totalEvaluated : null;
  const rateWithheldBecause = rateIsMeaningful ? null
    : totalEvaluated === 0 ? "no evaluation was observed in this window"
    : totalEvaluated < qualified ? `${qualified} prospects were first seen but only ${totalEvaluated} evaluations were reported in this window: they describe different work, so the ratio would not be a yield`
    : `only ${totalEvaluated} evaluations observed (a rate needs at least ${MIN_EVALUATED_FOR_RATE})`;

  const peak = completeHours.length ? completeHours.reduce((a, b) => (b.evaluated > a.evaluated ? b : a)) : null;
  const worst = completeHours.length ? completeHours.reduce((a, b) => (b.evaluated < a.evaluated ? b : a)) : null;

  const pick = (f: (s: SampleRow) => number | null, agg: (xs: number[]) => number): number | null => {
    const xs: number[] = [];
    for (const s of inWindow) { const v = f(s); if (v !== null) xs.push(v); }
    return xs.length ? agg(xs) : null;
  };
  const maxOf = (xs: number[]) => Math.max(...xs);
  const minOf = (xs: number[]) => Math.min(...xs);
  const meanOf = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

  // Projection: only ever the observed rate times 24 h, and only when a meaningful stretch was observed. It is
  // labelled a projection everywhere it is shown, and `complete` says whether the 24 hours actually happened.
  const projectedDailyEvaluated = hoursObserved >= 1 ? Math.round(totalEvaluated / hoursObserved * 24) : null;
  const projectedDailyQualified = hoursObserved >= 1 && observedQualificationRate !== null
    ? Math.round(totalEvaluated / hoursObserved * 24 * observedQualificationRate) : null;

  const shortfall = Math.max(0, input.target - qualified);
  // The staging deploy's end-to-end test checks in under a throwaway `staging-e2e-*` runner id. Those samples are
  // real, but they are a test harness, not a worker doing continuous research, and reading them as one would make an
  // idle platform look staffed. Reported separately, and named as the limiting factor when they are all there is.
  const onlyDeployTestRunners = runners.length > 0 && runners.every((r) => r.startsWith("staging-e2e-"));
  const limitingFactor = ((): string => {
    if (!inWindow.length) return "no worker samples in the window: the worker was not running, or not reaching the platform";
    if (onlyDeployTestRunners) return "no research worker: the only check-ins are the staging deploy's end-to-end test (runner id staging-e2e-*), which researches a fixed 30-business sample and stops";
    if (inWindow.every((s) => s.paused === 1)) return "research was paused on the platform for the whole window";
    if (inWindow.some((s) => s.auth_failed === 1)) return "the platform refused the worker's credentials, so delivery stopped (RESEARCH_RUNNER_SECRET mismatch)";
    if (last && last.outbox_depth > 0 && totalDelivered < totalEvaluated) return "staging delivery: verified records are queued locally faster than the platform accepts them";
    if (observedQualificationRate !== null && observedQualificationRate < 0.05 && totalEvaluated > 500) return "qualification yield: businesses are being evaluated but few meet the evidence bar";
    if (last && last.queue_depth === 0) return "source supply: the worker ran out of queued candidates (ingest, not verification, is the limit)";
    const cpuMax = pick((s) => num(s.cpu_pct), maxOf);
    if (cpuMax !== null && cpuMax >= 90) return "CPU on the workstation";
    return "website verification throughput (per-host politeness and real site latency)";
  })();
  const nextChange = limitingFactor.startsWith("no worker samples") || limitingFactor.startsWith("no research worker") ? "install and start the worker on Node 1 (docs/research/RUNBOOK.md §1)"
    : limitingFactor.startsWith("research was paused") ? "resume research in /staff/research (Owner)"
    : limitingFactor.startsWith("the platform refused") ? "re-run the installer with the matching RESEARCH_RUNNER_SECRET (RUNBOOK §5)"
    : limitingFactor.startsWith("staging delivery") ? "raise max_batch in /staff/research, or let the local outbox drain at a safe rate"
    : limitingFactor.startsWith("qualification yield") ? "review the rejection reasons before raising volume: more evaluations will not help"
    : limitingFactor.startsWith("source supply") ? "widen RESEARCH_STATES, or confirm the Overture snapshot finished ingesting"
    : limitingFactor.startsWith("CPU") ? "lower HTTP_CONCURRENCY, or move drafting off this machine"
    : "raise HTTP_CONCURRENCY in controlled increments while error rate and accuracy hold";

  return {
    window: { start: input.windowStart, end: input.windowEnd, generatedAt: input.now, hoursObserved: Math.round(hoursObserved * 100) / 100, complete },
    worker: {
      runners, samples: inWindow.length, expectedSamples,
      uptimePct: expectedSamples > 0 ? Math.min(100, Math.round((inWindow.length / expectedSamples) * 1000) / 10) : null,
      pausedSamples: inWindow.filter((s) => s.paused === 1).length,
      authFailedSamples: inWindow.filter((s) => s.auth_failed === 1).length,
      lastSampleAt: last?.at ?? null, lastQueueDepth: last?.queue_depth ?? null, lastOutboxDepth: last?.outbox_depth ?? null,
      onlyDeployTestRunners,
    },
    funnel: {
      businessesEvaluated: totalEvaluated, websitesChecked: totalWebsites, processingFailures: totalFailures,
      websiteOpportunities: OPPORTUNITY_CLASSES.reduce((a, k) => a + (input.prospects.byClassInWindow[k] ?? 0), 0),
      opportunitiesByClass: input.prospects.byClassInWindow,
      qualifiedProspects: qualified,
      recordsDeliveredToStaging: totalDelivered,
      recordsCreated: input.batches.reduce((a, b) => a + b.created, 0),
      recordsUpdated: input.batches.reduce((a, b) => a + b.updated, 0),
      recordsUnchanged: input.batches.reduce((a, b) => a + b.unchanged, 0),
      recordsRejected: input.batches.reduce((a, b) => a + b.rejected, 0),
      duplicatesPrevented: input.batches.reduce((a, b) => a + b.duplicates_prevented, 0),
      crmMatches: input.batches.reduce((a, b) => a + b.crm_matches, 0),
      crmLeadsCreated: input.promoted, promotionsBlocked: input.promotionBlocked,
      prospectsAwaitingDecision: input.prospects.awaitingDecision,
      contactsEligibleForAutomatedCalling: input.prospects.eligibleForCalling,
    },
    rates: {
      hourly,
      evaluatedPerHourMean: mean(totalEvaluated) === null ? null : Math.round(mean(totalEvaluated)!),
      qualifiedPerHourMean: mean(qualified) === null ? null : Math.round(mean(qualified)! * 10) / 10,
      deliveredPerHourMean: mean(totalDelivered) === null ? null : Math.round(mean(totalDelivered)!),
      peakSustainedHour: peak, worstCompleteHour: worst,
      observedQualificationRate: observedQualificationRate === null ? null : Math.round(observedQualificationRate * 10000) / 10000,
      rateWithheldBecause,
    },
    resources: {
      cpuPctMax: pick((s) => num(s.cpu_pct), maxOf), cpuPctMean: pick((s) => num(s.cpu_pct), meanOf),
      ramUsedGbMax: pick((s) => num(s.ram_used_gb), maxOf), ramTotalGb: pick((s) => num(s.ram_total_gb), maxOf),
      rssMbMax: pick((s) => num(s.rss_mb), maxOf), diskFreeGbMin: pick((s) => num(s.disk_free_gb), minOf),
      gpuName: inWindow.find((s) => s.gpu_name)?.gpu_name ?? null,
      gpuUtilPctMax: pick((s) => num(s.gpu_util_pct), maxOf), gpuMemUsedMbMax: pick((s) => num(s.gpu_mem_used_mb), maxOf),
      draftsDone: pick((s) => num(s.drafts_done), maxOf), draftsDeferrals: pick((s) => num(s.drafts_deferrals), maxOf),
      draftsDropped: pick((s) => num(s.drafts_dropped), maxOf),
    },
    target: {
      qualifiedTarget: input.target, qualifiedAchieved: qualified, shortfall, achieved: complete && qualified >= input.target,
      projectedDailyQualified, projectedDailyEvaluated, limitingFactor, nextChange,
      claimable: complete
        ? (qualified >= input.target
          ? `${qualified} qualified prospects in a full 24-hour window: the ${input.target}/day target was met over this window. Sustained capacity still needs the source-supply check in docs/research/CAPACITY.md §4.`
          : `${qualified} qualified prospects in a full 24-hour window against a target of ${input.target}: NOT met, short by ${shortfall}.`)
        : `Window incomplete (${Math.round(hoursObserved * 100) / 100} h of 24 observed). No daily figure may be claimed from this; the projection is the observed rate times 24 and is not a result.`,
    },
  };
}

/** Plain-text summary for the log, a Markdown file or a step summary. Keeps every funnel stage on its own line. */
export function formatReport(r: ResearchReport): string {
  const n = (x: number | null | undefined, unit = "") => (x === null || x === undefined ? "not reported" : `${x}${unit}`);
  const L: string[] = [];
  L.push(`# Research 24-hour report`);
  L.push("");
  L.push(`Window ${r.window.start} → ${r.window.end} (${r.window.hoursObserved} h observed, ${r.window.complete ? "COMPLETE" : "INCOMPLETE"})`);
  L.push(`Generated ${r.window.generatedAt}`);
  L.push("");
  L.push(`## Target`);
  L.push(r.target.claimable);
  L.push(`- Qualified achieved: ${r.target.qualifiedAchieved} of ${r.target.qualifiedTarget} (shortfall ${r.target.shortfall})`);
  L.push(`- Projected daily at the observed rate: ${n(r.target.projectedDailyQualified)} qualified from ${n(r.target.projectedDailyEvaluated)} evaluated — a projection, not a result`);
  L.push(`- Limiting factor: ${r.target.limitingFactor}`);
  L.push(`- Smallest next change: ${r.target.nextChange}`);
  L.push("");
  L.push(`## Worker`);
  L.push(`- Runners: ${r.worker.runners.join(", ") || "none"}`);
  L.push(r.worker.expectedSamples > 0
    ? `- Samples: ${r.worker.samples} of ${r.worker.expectedSamples} expected (uptime ${n(r.worker.uptimePct, "%")})`
    : `- Samples: ${r.worker.samples}; the window is shorter than one 15-minute bucket, so uptime is not meaningful yet`);
  if (r.worker.onlyDeployTestRunners) L.push(`- NOTE: every check-in is from the staging deploy's end-to-end test, not a research worker. These figures do not describe continuous research.`);
  L.push(`- Paused samples: ${r.worker.pausedSamples}; credential failures: ${r.worker.authFailedSamples}`);
  L.push(`- Last sample: ${r.worker.lastSampleAt ?? "none"}; queue ${n(r.worker.lastQueueDepth)}, outbox ${n(r.worker.lastOutboxDepth)}`);
  L.push("");
  L.push(`## Funnel (each stage is a different number — never add them together)`);
  L.push(`- Businesses evaluated: ${r.funnel.businessesEvaluated}`);
  L.push(`- Websites checked: ${r.funnel.websitesChecked}`);
  L.push(`- Processing failures: ${r.funnel.processingFailures}`);
  L.push(`- Verified website opportunities: ${r.funnel.websiteOpportunities}`);
  L.push(`- All classifications seen: ${Object.entries(r.funnel.opportunitiesByClass).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  L.push(`- Qualified research prospects: ${r.funnel.qualifiedProspects}`);
  L.push(`- Records delivered to staging: ${r.funnel.recordsDeliveredToStaging} (created ${r.funnel.recordsCreated}, updated ${r.funnel.recordsUpdated}, unchanged ${r.funnel.recordsUnchanged}, rejected ${r.funnel.recordsRejected})`);
  L.push(`- Duplicates prevented: ${r.funnel.duplicatesPrevented}; existing CRM matches: ${r.funnel.crmMatches}`);
  L.push(`- CRM leads created (Owner promotions): ${r.funnel.crmLeadsCreated}; promotions blocked: ${r.funnel.promotionsBlocked}`);
  L.push(`- Prospects awaiting an Owner decision: ${r.funnel.prospectsAwaitingDecision}`);
  L.push(`- Contacts eligible for automated AI calling: ${r.funnel.contactsEligibleForAutomatedCalling} (0 by design — docs/research/COMPLIANCE-GATE.md)`);
  L.push("");
  L.push(`## Rates`);
  L.push(`- Mean evaluated/hour: ${n(r.rates.evaluatedPerHourMean)}; qualified/hour: ${n(r.rates.qualifiedPerHourMean)}; delivered/hour: ${n(r.rates.deliveredPerHourMean)}`);
  L.push(`- Observed qualification rate: ${r.rates.observedQualificationRate === null ? `not measurable — ${r.rates.rateWithheldBecause}` : `${(r.rates.observedQualificationRate * 100).toFixed(2)}%`}`);
  L.push(`- Peak sustained complete hour: ${r.rates.peakSustainedHour ? `${r.rates.peakSustainedHour.hour} — ${r.rates.peakSustainedHour.evaluated} evaluated` : "no complete hour observed"}`);
  L.push(`- Worst complete hour: ${r.rates.worstCompleteHour ? `${r.rates.worstCompleteHour.hour} — ${r.rates.worstCompleteHour.evaluated} evaluated` : "no complete hour observed"}`);
  L.push("");
  L.push(`## Host resources (as the worker measured them)`);
  L.push(`- CPU: max ${n(r.resources.cpuPctMax, "%")}, mean ${n(r.resources.cpuPctMean, "%")}`);
  L.push(`- RAM used: max ${n(r.resources.ramUsedGbMax, " GB")} of ${n(r.resources.ramTotalGb, " GB")}; worker RSS max ${n(r.resources.rssMbMax, " MB")}`);
  L.push(`- Disk free (data drive): min ${n(r.resources.diskFreeGbMin, " GB")}`);
  L.push(`- GPU: ${r.resources.gpuName ?? "none reported"} — util max ${n(r.resources.gpuUtilPctMax, "%")}, memory max ${n(r.resources.gpuMemUsedMbMax, " MB")}`);
  L.push(`- Optional drafts: done ${n(r.resources.draftsDone)}, stood down for the Website Builder ${n(r.resources.draftsDeferrals)}, dropped ${n(r.resources.draftsDropped)}`);
  L.push("");
  L.push(`Accuracy is NOT measured here. A false-positive rate needs the hand-verified sample in docs/research/RUNBOOK.md §4.`);
  return L.join("\n");
}
