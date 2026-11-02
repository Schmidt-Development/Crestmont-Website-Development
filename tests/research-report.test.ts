// Research metric samples (migration 0070) and the 24-hour report arithmetic. The report is what the Founder will
// judge a proof run by, so these tests pin the two things that could quietly mislead: a rate claimed for time that
// was never observed, and funnel stages being added together. All data here is TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";
import { heartbeat, sampleBucket, dashboard } from "../src/services/research.ts";
import { buildReport, formatReport, type BatchRow, type ProspectCounts, type SampleRow } from "../src/services/research-report.ts";

const EMPTY_PROSPECTS: ProspectCounts = {
  qualifiedInWindow: 0, awaitingDecision: 0, reviewInWindow: 0, suppressedInWindow: 0,
  existingCrmInWindow: 0, notQualifiedInWindow: 0, eligibleForCalling: 0, byClassInWindow: {},
};

const sample = (over: Partial<SampleRow> & { bucket: string }): SampleRow => ({
  runner_id: "research-node1", at: `${over.bucket}:00.000Z`, day: over.bucket.slice(0, 10),
  evaluated: 0, websites_checked: 0, failed_jobs: 0, sent: 0, records_per_hour: 0,
  queue_depth: 100, outbox_depth: 0, paused: 0, auth_failed: 0,
  cpu_pct: null, ram_used_gb: null, ram_total_gb: null, rss_mb: null, disk_free_gb: null,
  gpu_util_pct: null, gpu_mem_used_mb: null, gpu_name: null,
  drafts_pending: null, drafts_done: null, drafts_dropped: null, drafts_deferrals: null,
  ...over,
});

// ───────────── bucketing and persistence ─────────────

test("[AIOPS-001] heartbeat samples land in 15-minute buckets, so a 60-second heartbeat keeps 96 rows a day", async () => {
  assert.equal(sampleBucket(new Date("2026-11-02T13:00:05Z")), "2026-11-02T13:00");
  assert.equal(sampleBucket(new Date("2026-11-02T13:14:59Z")), "2026-11-02T13:00");
  assert.equal(sampleBucket(new Date("2026-11-02T13:15:00Z")), "2026-11-02T13:15");
  assert.equal(sampleBucket(new Date("2026-11-02T13:59:59Z")), "2026-11-02T13:45");

  const app = await createTestApp();
  const status = (evaluated: number, extra: Record<string, unknown> = {}) => ({
    day: "2026-11-02", evaluated, websitesChecked: evaluated * 2, failedJobs: 0, sentToday: Math.floor(evaluated / 3),
    recordsPerHour: evaluated, queueDepth: 500, outbox: 0, inFlight: 4, paused: false,
    platform: { ok: true, authFailed: false },
    resources: { cpuPct: 41, ramUsedGb: 9.5, ramTotalGb: 64, rssMb: 310, diskFreeGb: 412, gpu: { utilPct: 3, memUsedMb: 900, memTotalMb: 32607, name: "NVIDIA GeForce RTX 5090" } },
    drafts: { pending: 2, done: 7, dropped: 0, deferrals: 5 },
    ...extra,
  });
  // Three heartbeats inside one bucket: the last one wins, one row only.
  for (const [t, ev] of [["2026-11-02T13:00:10Z", 10], ["2026-11-02T13:07:00Z", 40], ["2026-11-02T13:14:50Z", 90]] as const)
    await heartbeat(app.db, { runnerId: "research-node1", version: "0.1.0", status: status(ev) }, new Date(t));
  await heartbeat(app.db, { runnerId: "research-node1", version: "0.1.0", status: status(150) }, new Date("2026-11-02T13:16:00Z"));

  const rows = (await app.db.prepare(`SELECT bucket, evaluated, websites_checked, sent, cpu_pct, ram_used_gb, disk_free_gb, gpu_util_pct, gpu_name, drafts_deferrals, paused, auth_failed FROM research_runner_samples ORDER BY bucket`).all<Record<string, unknown>>()).results;
  assert.equal(rows.length, 2, "two 15-minute buckets, not four heartbeats");
  assert.equal(rows[0]!.bucket, "2026-11-02T13:00");
  assert.equal(rows[0]!.evaluated, 90, "the last heartbeat in the bucket wins");
  assert.equal(rows[0]!.websites_checked, 180);
  assert.equal(rows[0]!.sent, 30);
  assert.equal(rows[0]!.cpu_pct, 41);
  assert.equal(rows[0]!.ram_used_gb, 9.5);
  assert.equal(rows[0]!.disk_free_gb, 412);
  assert.equal(rows[0]!.gpu_util_pct, 3);
  assert.equal(rows[0]!.gpu_name, "NVIDIA GeForce RTX 5090");
  assert.equal(rows[0]!.drafts_deferrals, 5, "GPU stand-downs for the Website Builder are recorded");
  assert.equal(rows[0]!.paused, 0);
  assert.equal(rows[0]!.auth_failed, 0);
  assert.equal(rows[1]!.evaluated, 150);
});

test("[AIOPS-001] a worker that reports no resources or drafts stores NULL, not 0, and a paused or refused worker is recorded", async () => {
  const app = await createTestApp();
  await heartbeat(app.db, { runnerId: "minimal", status: { day: "2026-11-02", evaluated: 5 } }, new Date("2026-11-02T01:00:00Z"));
  const r = (await app.db.prepare(`SELECT cpu_pct, gpu_util_pct, gpu_name, drafts_done, evaluated, paused FROM research_runner_samples WHERE runner_id = 'minimal'`).first<Record<string, unknown>>())!;
  assert.equal(r.cpu_pct, null, "'not reported' must stay distinguishable from 'zero'");
  assert.equal(r.gpu_util_pct, null);
  assert.equal(r.gpu_name, null);
  assert.equal(r.drafts_done, null);
  assert.equal(r.evaluated, 5);
  assert.equal(r.paused, 0);

  await heartbeat(app.db, { runnerId: "blocked", status: { day: "2026-11-02", paused: true, platform: { authFailed: true } } }, new Date("2026-11-02T01:00:00Z"));
  const b = (await app.db.prepare(`SELECT paused, auth_failed FROM research_runner_samples WHERE runner_id = 'blocked'`).first<Record<string, unknown>>())!;
  assert.equal(b.paused, 1);
  assert.equal(b.auth_failed, 1);

  // The pre-existing latest-status and per-day rows keep working alongside the new series.
  const d = await dashboard(app.db, new Date("2026-11-02T02:00:00Z"));
  assert.equal(d.runners.length, 2);
  assert.equal(d.evaluatedToday, 5);
});

// ───────────── report arithmetic ─────────────

test("[AIOPS-001] rates are the sum of positive differences between samples, and a counter reset never inflates them", () => {
  const samples = [
    sample({ bucket: "2026-11-02T10:00", evaluated: 1000, websites_checked: 500 }),
    sample({ bucket: "2026-11-02T10:15", evaluated: 1300, websites_checked: 650 }),
    sample({ bucket: "2026-11-02T10:30", evaluated: 1600, websites_checked: 800 }),
    sample({ bucket: "2026-11-02T10:45", evaluated: 1900, websites_checked: 950 }),
    sample({ bucket: "2026-11-02T11:00", evaluated: 2200, websites_checked: 1100 }),
    // Fresh state file: the counter drops. The drop is not progress and the new value is not a 2,200-record jump.
    sample({ bucket: "2026-11-02T11:15", evaluated: 50, websites_checked: 25 }),
    sample({ bucket: "2026-11-02T11:30", evaluated: 350, websites_checked: 175 }),
  ];
  const r = buildReport({
    windowStart: "2026-11-02T10:00:00.000Z", windowEnd: "2026-11-03T10:00:00.000Z", now: "2026-11-02T11:35:00.000Z",
    target: 25_000, samples, batches: [], prospects: EMPTY_PROSPECTS, promoted: 0, promotionBlocked: 0,
  });
  // 300×4 across 10:15–11:00, then 300 at 11:30. The reset contributes nothing.
  assert.equal(r.funnel.businessesEvaluated, 1500);
  assert.equal(r.funnel.websitesChecked, 750);
  assert.equal(r.window.complete, false, "only 1.6 h of the 24 observed");
  assert.match(r.target.claimable, /Window incomplete/);
  assert.match(r.target.claimable, /No daily figure may be claimed/);
});

test("[AIOPS-001] an incomplete window yields no daily claim, and a complete one that misses the target says so plainly", () => {
  const samples: SampleRow[] = [];
  // A full 24 hours at a steady 250 evaluations per 15 minutes = 1,000/hour. Samples run 00:00..23:45 (96 of them),
  // so 95 intervals are observed: the last quarter-hour before midnight is never sampled, which is the inherent
  // one-bucket loss at a day boundary and is why this reads 23,750 rather than a tidy 24,000.
  for (let i = 0; i < 96; i++) {
    const d = new Date(Date.parse("2026-11-02T00:00:00.000Z") + i * 15 * 60e3);
    samples.push(sample({ bucket: `${d.toISOString().slice(0, 14)}${String(d.getUTCMinutes()).padStart(2, "0")}`, evaluated: 250 * i, day: "2026-11-02" }));
  }
  const prospects = { ...EMPTY_PROSPECTS, qualifiedInWindow: 3_600, awaitingDecision: 3_600 };
  const r = buildReport({
    windowStart: "2026-11-02T00:00:00.000Z", windowEnd: "2026-11-03T00:00:00.000Z", now: "2026-11-03T00:05:00.000Z",
    target: 25_000, samples, batches: [], prospects, promoted: 12, promotionBlocked: 3,
  });
  assert.equal(r.window.complete, true);
  assert.equal(r.funnel.businessesEvaluated, 23_750, "95 observed intervals, not an extrapolated 96th");
  assert.equal(r.rates.evaluatedPerHourMean, 990);
  assert.equal(r.funnel.qualifiedProspects, 3_600);
  assert.equal(r.rates.observedQualificationRate, 0.1516);
  assert.equal(r.target.achieved, false);
  assert.equal(r.target.shortfall, 21_400);
  assert.match(r.target.claimable, /NOT met, short by 21400/);
  // Peak and worst are only ever taken from hours the worker reported right through.
  assert.ok(r.rates.peakSustainedHour, "a complete hour exists");
  assert.equal(r.rates.peakSustainedHour!.evaluated, 1_000, "a full hour of four observed intervals");
  // The first hour of the window holds only three observed intervals: its opening sample has no predecessor to
  // difference against. That is reported as it is, not padded up to the steady rate.
  assert.equal(r.rates.worstCompleteHour!.hour, "2026-11-02T00");
  assert.equal(r.rates.worstCompleteHour!.evaluated, 750);
  // Funnel stages stay separate in the rendered report.
  const text = formatReport(r);
  assert.match(text, /Businesses evaluated: 23750/);
  assert.match(text, /Qualified research prospects: 3600/);
  assert.match(text, /CRM leads created \(Owner promotions\): 12/);
  assert.match(text, /Contacts eligible for automated AI calling: 0 \(0 by design/);
});

test("[AIOPS-001] a partial hour is never counted as a peak hour", () => {
  const samples = [
    sample({ bucket: "2026-11-02T10:00", evaluated: 0 }),
    sample({ bucket: "2026-11-02T10:15", evaluated: 100 }),
    sample({ bucket: "2026-11-02T10:30", evaluated: 200 }),
    sample({ bucket: "2026-11-02T10:45", evaluated: 300 }),
    // 11:00 has a single sample with a huge jump: real work, but not an hour's worth of observation.
    sample({ bucket: "2026-11-02T11:00", evaluated: 9_000 }),
  ];
  const r = buildReport({
    windowStart: "2026-11-02T10:00:00.000Z", windowEnd: "2026-11-03T10:00:00.000Z", now: "2026-11-02T11:05:00.000Z",
    target: 25_000, samples, batches: [], prospects: EMPTY_PROSPECTS, promoted: 0, promotionBlocked: 0,
  });
  assert.equal(r.funnel.businessesEvaluated, 9_000, "all observed progress is still counted");
  assert.equal(r.rates.peakSustainedHour!.hour, "2026-11-02T10", "the 4-bucket hour is the only sustained one");
  assert.equal(r.rates.peakSustainedHour!.evaluated, 300);
  assert.ok(r.rates.hourly.some((h) => h.hour === "2026-11-02T11" && !h.complete));
});

test("[AIOPS-001] the limiting factor names the real blocker: no worker, paused, refused credentials, delivery or supply", () => {
  const base = { windowStart: "2026-11-02T00:00:00.000Z", windowEnd: "2026-11-03T00:00:00.000Z", now: "2026-11-03T00:00:00.000Z", target: 25_000, batches: [] as BatchRow[], prospects: EMPTY_PROSPECTS, promoted: 0, promotionBlocked: 0 };

  assert.match(buildReport({ ...base, samples: [] }).target.limitingFactor, /no worker samples/);
  assert.match(buildReport({ ...base, samples: [] }).target.nextChange, /install and start the worker/);

  const paused = [sample({ bucket: "2026-11-02T00:00", paused: 1 }), sample({ bucket: "2026-11-02T00:15", paused: 1 })];
  assert.match(buildReport({ ...base, samples: paused }).target.limitingFactor, /paused on the platform/);
  assert.match(buildReport({ ...base, samples: paused }).target.nextChange, /resume research/);

  const refused = [sample({ bucket: "2026-11-02T00:00" }), sample({ bucket: "2026-11-02T00:15", auth_failed: 1 })];
  assert.match(buildReport({ ...base, samples: refused }).target.limitingFactor, /refused the worker's credentials/);
  assert.match(buildReport({ ...base, samples: refused }).target.nextChange, /RESEARCH_RUNNER_SECRET/);

  // Verified locally but not accepted downstream: a backed-up outbox, not a throughput problem.
  const backedUp = [sample({ bucket: "2026-11-02T00:00", evaluated: 0 }), sample({ bucket: "2026-11-02T00:15", evaluated: 900, outbox_depth: 700 })];
  assert.match(buildReport({ ...base, samples: backedUp }).target.limitingFactor, /staging delivery/);

  // Nothing left in the queue: ingest is the limit, not verification.
  const dry = [sample({ bucket: "2026-11-02T00:00", evaluated: 0, queue_depth: 0 }), sample({ bucket: "2026-11-02T00:15", evaluated: 10, queue_depth: 0 })];
  assert.match(buildReport({ ...base, samples: dry }).target.limitingFactor, /source supply/);

  // Plenty evaluated, almost nothing qualifying: say so instead of advising more volume.
  const lowYield = [sample({ bucket: "2026-11-02T00:00", evaluated: 0 }), sample({ bucket: "2026-11-02T00:15", evaluated: 2_000 })];
  const r = buildReport({ ...base, samples: lowYield, prospects: { ...EMPTY_PROSPECTS, qualifiedInWindow: 10 } });
  assert.match(r.target.limitingFactor, /qualification yield/);
  assert.match(r.target.nextChange, /more evaluations will not help/);
});

test("[AIOPS-001] delivery counts come from batch timestamps, and worker uptime is measured against expected samples", () => {
  const samples = [
    sample({ bucket: "2026-11-02T00:00", evaluated: 0 }),
    sample({ bucket: "2026-11-02T00:15", evaluated: 400 }),
  ];
  const batches: BatchRow[] = [
    { received_at: "2026-11-02T00:10:00.000Z", record_count: 120, created: 100, updated: 20, unchanged: 0, rejected: 2, crm_matches: 5, duplicates_prevented: 7 },
    { received_at: "2026-11-02T00:20:00.000Z", record_count: 80, created: 70, updated: 10, unchanged: 0, rejected: 0, crm_matches: 1, duplicates_prevented: 3 },
  ];
  const r = buildReport({
    windowStart: "2026-11-02T00:00:00.000Z", windowEnd: "2026-11-03T00:00:00.000Z", now: "2026-11-02T00:30:00.000Z",
    target: 25_000, samples, batches, prospects: EMPTY_PROSPECTS, promoted: 4, promotionBlocked: 1,
  });
  assert.equal(r.funnel.recordsDeliveredToStaging, 200);
  assert.equal(r.funnel.recordsCreated, 170);
  assert.equal(r.funnel.recordsRejected, 2);
  assert.equal(r.funnel.duplicatesPrevented, 10);
  assert.equal(r.funnel.crmMatches, 6);
  assert.equal(r.funnel.crmLeadsCreated, 4);
  assert.equal(r.funnel.promotionsBlocked, 1);
  // 0.5 h observed → 2 expected samples for one runner, and 2 arrived.
  assert.equal(r.worker.expectedSamples, 2);
  assert.equal(r.worker.uptimePct, 100);
  assert.deepEqual(r.worker.runners, ["research-node1"]);
  assert.equal(r.worker.lastOutboxDepth, 0);
});

test("[AIOPS-001] host resources are reported as measured, and 'not reported' never becomes a number", () => {
  const samples = [
    sample({ bucket: "2026-11-02T00:00", cpu_pct: 20, ram_used_gb: 8, ram_total_gb: 64, rss_mb: 300, disk_free_gb: 500, gpu_util_pct: 0, gpu_mem_used_mb: 0, gpu_name: "RTX 5090", drafts_done: 0, drafts_deferrals: 0 }),
    sample({ bucket: "2026-11-02T00:15", cpu_pct: 80, ram_used_gb: 12, ram_total_gb: 64, rss_mb: 640, disk_free_gb: 420, gpu_util_pct: 7, gpu_mem_used_mb: 1_200, gpu_name: "RTX 5090", drafts_done: 9, drafts_deferrals: 31 }),
  ];
  const r = buildReport({ windowStart: "2026-11-02T00:00:00.000Z", windowEnd: "2026-11-03T00:00:00.000Z", now: "2026-11-02T00:30:00.000Z", target: 25_000, samples, batches: [], prospects: EMPTY_PROSPECTS, promoted: 0, promotionBlocked: 0 });
  assert.equal(r.resources.cpuPctMax, 80);
  assert.equal(r.resources.cpuPctMean, 50);
  assert.equal(r.resources.ramUsedGbMax, 12);
  assert.equal(r.resources.diskFreeGbMin, 420, "the low-water mark is what matters for disk");
  assert.equal(r.resources.gpuName, "RTX 5090");
  assert.equal(r.resources.gpuUtilPctMax, 7);
  assert.equal(r.resources.draftsDeferrals, 31);

  const none = buildReport({ windowStart: "2026-11-02T00:00:00.000Z", windowEnd: "2026-11-03T00:00:00.000Z", now: "2026-11-02T00:30:00.000Z", target: 25_000, samples: [sample({ bucket: "2026-11-02T00:00" })], batches: [], prospects: EMPTY_PROSPECTS, promoted: 0, promotionBlocked: 0 });
  assert.equal(none.resources.cpuPctMax, null);
  assert.equal(none.resources.gpuUtilPctMax, null);
  assert.match(formatReport(none), /CPU: max not reported/);
});

test("[AIOPS-001] a window crossing midnight counts the new day's progress instead of reading a negative jump", () => {
  const samples = [
    sample({ bucket: "2026-11-02T23:30", day: "2026-11-02", evaluated: 10_000 }),
    sample({ bucket: "2026-11-02T23:45", day: "2026-11-02", evaluated: 10_250 }),
    // Midnight: the worker's daily counters restart at 0, then climb again.
    sample({ bucket: "2026-11-03T00:00", day: "2026-11-03", evaluated: 180 }),
    sample({ bucket: "2026-11-03T00:15", day: "2026-11-03", evaluated: 430 }),
  ];
  const r = buildReport({
    windowStart: "2026-11-02T23:30:00.000Z", windowEnd: "2026-11-03T23:30:00.000Z", now: "2026-11-03T00:20:00.000Z",
    target: 25_000, samples, batches: [], prospects: EMPTY_PROSPECTS, promoted: 0, promotionBlocked: 0,
  });
  // 250 before midnight, 180 since midnight, 250 after: the reset is progress, not a negative.
  assert.equal(r.funnel.businessesEvaluated, 680);
  assert.ok(r.rates.hourly.every((h) => h.evaluated >= 0));
});

test("[AIOPS-001] a missing samples table never stops the worker: the heartbeat still returns its controls", async () => {
  const app = await createTestApp();
  // Simulates a Worker deployed ahead of migration 0070. Telemetry is expendable; the controls are not.
  await app.db.prepare(`DROP TABLE research_runner_samples`).run();
  const controls = await heartbeat(app.db, { runnerId: "research-node1", version: "0.1.0", status: { day: "2026-11-02", evaluated: 7 } }, new Date("2026-11-02T09:00:00Z"));
  assert.equal(controls.paused, true, "research ships paused, and the worker is still told so");
  assert.equal(controls.maxBatch, 200);
  assert.ok(controls.enabledSources.includes("overture"));
  // The durable counters the dashboard uses are unaffected.
  const d = await dashboard(app.db, new Date("2026-11-02T09:05:00Z"));
  assert.equal(d.evaluatedToday, 7);
  assert.equal(d.runners.length, 1);
});

test("[AIOPS-001] 'website opportunities' counts only the evidence-backed classes, never healthy or unverified sites", () => {
  const prospects: ProspectCounts = {
    ...EMPTY_PROSPECTS,
    byClassInWindow: {
      VERIFIED_WEBSITE_BROKEN: 40, VERIFIED_WEBSITE_ISSUES: 60, NO_OFFICIAL_WEBSITE_FOUND: 25,
      VERIFIED_OFFICIAL_WEBSITE: 900, WEBSITE_UNVERIFIED: 500, BUSINESS_IDENTITY_UNCERTAIN: 70,
    },
  };
  const r = buildReport({
    windowStart: "2026-11-02T00:00:00.000Z", windowEnd: "2026-11-03T00:00:00.000Z", now: "2026-11-02T01:00:00.000Z",
    target: 25_000, samples: [], batches: [], prospects, promoted: 0, promotionBlocked: 0,
  });
  assert.equal(r.funnel.websiteOpportunities, 125, "broken + issues + no-website-found only");
  const text = formatReport(r);
  assert.match(text, /Verified website opportunities: 125/);
  // The healthy and unverified classes are still shown, just never folded into the opportunity count.
  assert.match(text, /VERIFIED_OFFICIAL_WEBSITE 900/);
  assert.match(text, /WEBSITE_UNVERIFIED 500/);
});
