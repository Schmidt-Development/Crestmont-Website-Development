// Automatic research → CRM promotion, and the backlog reconciliation that uses the same code path.
//
// The problem it solves: promotion was only ever a per-prospect Owner click (`POST /staff/research/promote` with one
// `prospect_id`). With a worker producing thousands of qualified prospects a day, the CRM could only ever receive a
// handful, so qualified businesses accumulated in `research_prospects` with nothing moving them.
//
// What this does NOT change, deliberately:
//  - Every promotion still goes through `promote()` and therefore through the CRM intake engine
//    (`contact-identity.ts`, channel `research_agent`): customer matching, do-not-call, email suppression, erasure,
//    shared-identifier review, the idempotency key `research_agent:promote:<prospect>` and the audit record all apply
//    exactly as they do to a human promotion. Nothing is inserted behind the CRM's back.
//  - Only `status = 'qualified'` is promoted. `review` means a person has to decide who a shared number reaches, or
//    which of two records of one business is real; that stays a human decision.
//  - Creating a CRM lead releases nobody for calling. Outbound eligibility is computed fail-closed and stays
//    `blocked` (`src/domain/research.ts#outboundEligibility`), so a new lead starts no call, SMS or email.
//  - A paused Research Agent does NOT stop this. Pausing stops new research; the backlog that already exists still
//    has to reach the CRM. Those are different things.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { HttpError } from "../app/http.ts";
import { type Actor } from "../domain/authz.ts";
import { audit } from "./security.ts";
import { applySuppressions, loadSettings, promote } from "./research.ts";

/**
 * The automatic promoter's identity. `kind: "system"` matters: `can()` refuses every Founder-protected permission to
 * a non-user actor, so this actor can create a CRM lead and nothing else of consequence — it cannot change pricing,
 * approve a release, issue a refund or simulate a payment. Same shape as `SALES_AUTOMATION` in quotes.ts.
 */
export const RESEARCH_AUTOMATION: Actor = { kind: "system", roles: [{ role: "owner", organizationId: "system" }], mfaVerified: true };

/** A prospect the intake engine keeps refusing is left alone after this many attempts and reported, not retried forever. */
export const MAX_PROMOTE_ATTEMPTS = 5;
/** Backoff before the next attempt: 15 min, 1 h, 4 h, 16 h, then it is out of attempts. */
const BACKOFF_MS = [15 * 60e3, 60 * 60e3, 4 * 3600e3, 16 * 3600e3];
/** A run stops cleanly before the Worker's own limits bite; the next tick resumes where it stopped. */
const DEFAULT_BUDGET_MS = 20_000;
/**
 * How many promotions are in flight at once. A promotion is latency-bound, not CPU-bound: measured on the real code
 * path it walks about 5.6 D1 round trips in series, so one prospect spends most of its time waiting and several can
 * wait together. The ceiling is D1's 1,000 queries per Worker invocation (a batch counts as one), which at ~8.3
 * round trips per promotion is about 120 promotions per invocation whatever the concurrency.
 */
export const DEFAULT_CONCURRENCY = 8;
export const MAX_CONCURRENCY = 24;
/**
 * D1 allows 1,000 queries per Worker invocation and refuses the 1,001st with "Too many API requests by single Worker
 * invocation" — a `batch()` counting as one however many statements it carries. A promotion issues about 8.3 of
 * them, and the run itself spends a handful on the suppression sweep, the candidate read, the classification, the
 * backoffs and its own record. So a run promotes at most this many prospects whatever the Owner's cap says, and
 * stops with `query_limit` so the next tick continues rather than the invocation being killed mid-batch.
 * 100 x 8.3 = 830, which leaves room for the overhead and for a promotion that takes a longer path than measured.
 */
export const MAX_PER_INVOCATION = 100;

/** The identifiers the CRM intake engine matches on; two prospects sharing one must never be promoted concurrently. */
interface CandidateRow { id: string; phone_norm: string | null; email: string | null; domain: string | null }
function identityKeys(r: CandidateRow): string[] {
  const keys: string[] = [];
  if (r.phone_norm) keys.push(`p:${r.phone_norm}`);
  if (r.email) keys.push(`e:${r.email.toLowerCase()}`);
  if (r.domain) keys.push(`d:${r.domain.toLowerCase()}`);
  // A prospect with no identifier at all cannot collide with anything, and the intake engine will reject it on its
  // own terms. It is given a key unique to itself so it neither blocks nor is blocked.
  return keys.length ? keys : [`id:${r.id}`];
}

export type PromotionTrigger = "scheduled" | "owner" | "ingest";
export type StoppedReason = "drained" | "cap" | "budget" | "disabled" | "error" | "query_limit" | "locked";

/**
 * How long a lease is held before it is considered stale. It has to outlast the longest run a budget allows, with
 * room for the classification and record-keeping that follow the batch; a Worker killed mid-run leaves the lease
 * behind, and this is how long the schedule waits before taking it back.
 */
const LEASE_MS = 150_000;

/**
 * Takes the promotion lease, or reports that another run holds it.
 *
 * One conditional UPDATE, because a single D1 statement is atomic: the run that changed a row has the lease and the
 * one that changed none does not. Expiry rather than a flag means a crashed run cannot wedge the schedule.
 */
async function acquireLease(db: Db, runId: string, trigger: PromotionTrigger, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const until = new Date(now.getTime() + LEASE_MS).toISOString();
  const r = await db.prepare(`UPDATE research_promotion_lease SET holder = ?, trigger = ?, acquired_at = ?, expires_at = ?
      WHERE id = 1 AND (expires_at IS NULL OR expires_at <= ?)`).bind(runId, trigger, at, until, at).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Releases it, but only if we still hold it: a run whose lease already expired must not evict its successor. */
async function releaseLease(db: Db, runId: string): Promise<void> {
  await db.prepare(`UPDATE research_promotion_lease SET holder = NULL, trigger = NULL, expires_at = NULL WHERE id = 1 AND holder = ?`).bind(runId).run();
}

export interface PromotionRunResult {
  id: string;
  trigger: PromotionTrigger;
  startedAt: string;
  finishedAt: string;
  /** Prospects this run actually attempted. */
  examined: number;
  /** New CRM leads created. */
  promoted: number;
  /** Matched an existing CRM contact; no second lead was created. */
  existingCrm: number;
  /** Sent to the CRM's duplicate-review queue, or holding a shared number: a person decides. */
  review: number;
  /** Do-not-call, email suppression or erasure. */
  suppressed: number;
  /** The intake engine refused the record as invalid. */
  rejected: number;
  /** Unexpected failure; retried with backoff, then reported. */
  failed: number;
  /** Wall clock of the run, so leads-per-second is readable from the row rather than inferred. */
  durationMs: number;
  /** Left out of the batch for sharing an identifier with one that was taken; the next tick picks them up. */
  deferredIdentity: number;
  /** Promotions that were in flight. */
  concurrency: number;
  /** Still eligible and due when the run stopped. */
  remaining: number;
  stoppedReason: StoppedReason;
}

/** Prospects that are eligible for the CRM right now, and the reasons the rest are not. Pure counting, no writes. */
export interface EligibilityCensus {
  totalOnRecord: number;
  uniqueQualified: number;        // qualified = 1, however they were later decided
  eligibleNow: number;            // status 'qualified', at or above the live threshold, attempts left
  belowThreshold: number;         // qualified when ingested, but the Owner's threshold has risen since
  outOfAttempts: number;          // tried MAX_PROMOTE_ATTEMPTS times and still refused
  awaitingVerification: number;   // website unverified or identity uncertain: cannot be qualified evidence
  notQualified: number;
  needsPerson: number;            // status 'review'
  suppressed: number;
  existingCrm: number;
  alreadyPromoted: number;
  dismissed: number;
}

const n = async (db: Db, sql: string, ...b: unknown[]) => Number((await db.prepare(sql).bind(...b).first<{ n: number | null }>())?.n ?? 0);

/**
 * The census as plain SQL, keyed by the field it fills. Exported because two things need the same definition of
 * "eligible": this service (through the D1 binding) and the staging reconciliation report (through
 * `wrangler d1 execute`, which cannot call TypeScript). A reconciliation whose two halves disagree about eligibility
 * is worse than no reconciliation, so there is exactly one definition and both read it.
 *
 * The threshold and attempt cap are interpolated as numbers, never as caller text.
 */
export function censusQueries(qualifyThreshold: number): Record<keyof EligibilityCensus, string> {
  const t = Number(qualifyThreshold) || 0;
  const maxAttempts = Number(MAX_PROMOTE_ATTEMPTS);
  return {
    totalOnRecord: `SELECT COUNT(*) AS n FROM research_prospects`,
    uniqueQualified: `SELECT COUNT(*) AS n FROM research_prospects WHERE qualified = 1`,
    eligibleNow: `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'qualified' AND qualified = 1 AND score >= ${t} AND promote_attempts < ${maxAttempts}`,
    belowThreshold: `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'qualified' AND qualified = 1 AND score < ${t}`,
    outOfAttempts: `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'qualified' AND promote_attempts >= ${maxAttempts}`,
    awaitingVerification: `SELECT COUNT(*) AS n FROM research_prospects WHERE website_class IN ('WEBSITE_UNVERIFIED','BUSINESS_IDENTITY_UNCERTAIN')`,
    notQualified: `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'not_qualified'`,
    needsPerson: `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'review'`,
    suppressed: `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'suppressed'`,
    existingCrm: `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'existing_crm'`,
    alreadyPromoted: `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'promoted'`,
    dismissed: `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'dismissed'`,
  };
}

/**
 * Where every research record stands relative to the CRM. This is the reconciliation denominator: `eligibleNow` is
 * the population automatic promotion is responsible for, and every other number is a stated reason a record is not
 * in it. They sum to the records on file, so nothing is silently dropped.
 */
export async function eligibilityCensus(db: Db): Promise<EligibilityCensus> {
  const s = await loadSettings(db);
  const q = censusQueries(s.qualify_threshold);
  const out = {} as EligibilityCensus;
  for (const [key, sql] of Object.entries(q)) out[key as keyof EligibilityCensus] = await n(db, sql);
  return out;
}

/** How many prospects are eligible and due for an attempt right now. */
export async function dueCount(db: Db, now: Date): Promise<number> {
  const s = await loadSettings(db);
  return n(db, `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'qualified' AND qualified = 1 AND score >= ?
      AND promote_attempts < ? AND (promote_next_at IS NULL OR promote_next_at <= ?)`, s.qualify_threshold, MAX_PROMOTE_ATTEMPTS, now.toISOString());
}

export interface RunOptions {
  trigger: PromotionTrigger;
  now?: Date;
  /** Owner-triggered runs record who asked. */
  actor?: Actor;
  actorUserId?: string | null;
  /** Overrides the Owner's per-run cap (never raises it above the cap). */
  limit?: number;
  budgetMs?: number;
  /** Promotions in flight at once; clamped to MAX_CONCURRENCY. Defaults to DEFAULT_CONCURRENCY. */
  concurrency?: number;
}

/**
 * Promotes one bounded, resumable batch of eligible prospects.
 *
 * Resumability and idempotency come from state already in the database, not from anything held in memory: a prospect
 * the intake engine decided on is moved out of `status = 'qualified'` by `promote()`, and the intake engine's own
 * idempotency key means a repeat attempt on the same prospect returns the first decision instead of a second lead.
 * So a crash mid-run, two runs overlapping, or the same run repeated all converge on the same CRM.
 */
export async function runAutoPromotion(db: Db, opts: RunOptions): Promise<PromotionRunResult> {
  const now = opts.now ?? new Date();
  const startedAt = now.toISOString();
  const runId = newId("rpr");
  const settings = await loadSettings(db);
  const blank = { examined: 0, promoted: 0, existingCrm: 0, review: 0, suppressed: 0, rejected: 0, failed: 0 };

  // A scheduled run only acts when the Owner has turned automatic promotion on. An Owner-triggered run is itself the
  // decision, so it runs either way. Note what is NOT checked here: `settings.paused`. Pausing stops new research;
  // the backlog already on file still has to reach the CRM.
  if (opts.trigger === "scheduled" && !settings.auto_promote) {
    // Reached only by the scheduled job, so there is no human action to attribute and nothing happened to audit.
    // Deliberately before the lease: an off switch must stay the cheapest possible tick.
    return finish(db, { id: runId, trigger: opts.trigger, startedAt, ...blank, remaining: await dueCount(db, now), stoppedReason: "disabled" }, opts.actorUserId ?? null, 0, 0, 0);
  }

  // Overlap protection. At one tick a minute a run that overruns would otherwise be working while its successor
  // starts: nothing would be corrupted (the idempotency key sees to that) but the whole next invocation would be
  // spent re-walking work in flight, and the per-minute figure — the figure the target is stated in — would be
  // unreadable. A run that cannot take the lease therefore does nothing and says so.
  if (!(await acquireLease(db, runId, opts.trigger, now))) {
    return finish(db, { id: runId, trigger: opts.trigger, startedAt, ...blank, remaining: await dueCount(db, now), stoppedReason: "locked" }, opts.actorUserId ?? null, 0, 0, 0);
  }
  try {
  const ownerCap = Math.max(1, Math.min(opts.limit ?? settings.auto_promote_max_per_run, settings.auto_promote_max_per_run));
  const cap = Math.min(ownerCap, MAX_PER_INVOCATION);
  // Recorded so "why did a run of 200 stop at 100" is answerable from the run row rather than from the source.
  const cappedByQueryLimit = cap < ownerCap;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const actor = opts.actor ?? RESEARCH_AUTOMATION;

  // Once for the whole batch rather than once per prospect: opt-outs recorded since the last run move the affected
  // prospects to 'suppressed' before anything is attempted, so a suppressed number is never promoted.
  await applySuppressions(db);

  // Candidates are read with the identifiers the CRM matches on, because the batch has to be made identity-disjoint
  // before anything runs concurrently (see below). Over-fetching a little leaves room to drop the ones that collide.
  const candidates = (await db.prepare(`SELECT id, phone_norm, email, domain FROM research_prospects
      WHERE status = 'qualified' AND qualified = 1 AND score >= ? AND promote_attempts < ? AND (promote_next_at IS NULL OR promote_next_at <= ?)
      ORDER BY score DESC, first_seen_at LIMIT ?`)
    .bind(settings.qualify_threshold, MAX_PROMOTE_ATTEMPTS, startedAt, Math.min(cap * 2, cap + 200)).all<CandidateRow>()).results;

  // Why this exists: running promotions concurrently is the only way to reach the throughput target, and serial
  // execution was quietly doing one job beyond ordering — it guaranteed that when two prospects share a phone
  // number, an email or a company domain, the SECOND one saw the contact the first had just created and was parked
  // at `existing_crm` instead of creating a second lead. Run those two at the same time and both would evaluate
  // against a CRM that does not yet contain the other, and both could create one. So the race is removed rather
  // than mitigated: a batch never contains two prospects that share an identifier, and the ones left out are simply
  // the next run's work. No suppression, duplicate-review or matching rule is relaxed to achieve this.
  const batch: CandidateRow[] = [];
  const claimed = new Set<string>();
  const deferredForIdentity: string[] = [];
  for (const row of candidates) {
    if (batch.length >= cap) break;
    const keys = identityKeys(row);
    if (keys.some((k) => claimed.has(k))) { deferredForIdentity.push(row.id); continue; }
    for (const k of keys) claimed.add(k);
    batch.push(row);
  }

  const counts = { ...blank };
  const attempted: string[] = [];
  // "drained" only when the database genuinely had nothing more to give. Prospects held back because they share an
  // identifier with one in this batch are not drained: the next tick picks them up.
  let stoppedReason: StoppedReason = batch.length < cap && deferredForIdentity.length === 0 && candidates.length < cap
    ? "drained"
    : cappedByQueryLimit ? "query_limit" : "cap";

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY, batch.length || 1));
  let next = 0;
  let outOfBudget = false;
  const worker = async () => {
    for (;;) {
      if (Date.now() > deadline) { outOfBudget = true; return; }
      const i = next++;
      if (i >= batch.length) return;
      const row = batch[i];
      attempted.push(row.id);
      counts.examined++;
      try {
        await promote(db, actor, row.id, { sweepSuppressions: false });
        counts.promoted++;
      } catch (e) {
        // A blocked promotion is a decision, not a crash: promote() has already recorded why and, for the outcomes
        // that have a resting place, moved the prospect's status. Anything still 'qualified' afterwards is
        // classified below.
        if (!(e instanceof HttpError) && !(e as { status?: number })?.status) {
          counts.failed++;
          await backoff(db, row.id, e, now);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (outOfBudget && next < batch.length) stoppedReason = "budget";

  // One query classifies the whole batch from the status promote() left behind, instead of a read per prospect.
  if (attempted.length) {
    const ph = attempted.map(() => "?").join(",");
    for (const r of (await db.prepare(`SELECT status, COUNT(*) AS n FROM research_prospects WHERE id IN (${ph}) GROUP BY status`).bind(...attempted).all<{ status: string; n: number }>()).results) {
      const c = Number(r.n);
      if (r.status === "existing_crm") counts.existingCrm += c;
      else if (r.status === "review") counts.review += c;
      else if (r.status === "suppressed") counts.suppressed += c;
    }
    // Still 'qualified' and not counted as promoted: the intake engine refused the record itself (invalid), so it is
    // backed off and, after MAX_PROMOTE_ATTEMPTS, reported as unresolved rather than retried forever.
    const stuck = (await db.prepare(`SELECT id FROM research_prospects WHERE id IN (${ph}) AND status = 'qualified'`).bind(...attempted).all<{ id: string }>()).results;
    const toBackOff = stuck.filter((x) => !!x.id);
    counts.rejected += Math.max(0, toBackOff.length - counts.failed);
    for (const x of toBackOff) await backoff(db, x.id, null, now);
  }
  // promote() counts a created lead itself, but a replayed idempotent promotion also returns success without creating
  // a row. `promoted` is therefore reconciled against what the status says, so it can never overstate new leads.
  counts.promoted = Math.min(counts.promoted, counts.examined - counts.existingCrm - counts.review - counts.suppressed - counts.rejected - counts.failed);
  if (counts.promoted < 0) counts.promoted = 0;

  const remaining = await dueCount(db, now);
  if (stoppedReason === "cap" && remaining === 0) stoppedReason = "drained";
  const result = await finish(db, { id: runId, trigger: opts.trigger, startedAt, ...counts, remaining, stoppedReason }, opts.actorUserId ?? null,
    Date.now() - now.getTime(), deferredForIdentity.length, concurrency);
  if (result.examined > 0 || opts.trigger === "owner") {
    await audit(db, {
      actorUserId: opts.actorUserId ?? null, action: "research.auto_promotion_run", subjectType: "research_promotion_run", subjectId: runId,
      details: { trigger: result.trigger, examined: result.examined, promoted: result.promoted, existingCrm: result.existingCrm, review: result.review, suppressed: result.suppressed, rejected: result.rejected, failed: result.failed, remaining: result.remaining, stoppedReason: result.stoppedReason, durationMs: result.durationMs, concurrency: result.concurrency },
    });
  }
  return result;
  } finally {
    // Always, including on the way out of an exception: a run that threw must not hold the schedule for LEASE_MS.
    await releaseLease(db, runId).catch(() => {});
  }
}

/** Records the attempt and when to try again. After the last backoff step the prospect drops out of the due set. */
async function backoff(db: Db, id: string, error: unknown, now: Date): Promise<void> {
  const row = await db.prepare(`SELECT promote_attempts AS a FROM research_prospects WHERE id = ?`).bind(id).first<{ a: number }>();
  const attempts = Number(row?.a ?? 0) + 1;
  const wait = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
  const msg = error === null ? "The CRM intake engine refused this record; see the research.promotion_blocked audit entry"
    : String((error as Error)?.message ?? error).slice(0, 300);
  await db.prepare(`UPDATE research_prospects SET promote_attempts = ?, promote_last_error = ?, promote_next_at = ?, updated_at = ? WHERE id = ?`)
    .bind(attempts, msg, new Date(now.getTime() + wait).toISOString(), now.toISOString(), id).run();
}

async function finish(db: Db, r: Omit<PromotionRunResult, "finishedAt" | "durationMs" | "deferredIdentity" | "concurrency">, actorUserId: string | null,
  durationMs: number, deferredIdentity: number, concurrency: number): Promise<PromotionRunResult> {
  const finishedAt = nowIso();
  await db.prepare(`INSERT INTO research_promotion_runs (id, trigger, started_at, finished_at, examined, promoted, existing_crm, review, suppressed, rejected, failed, remaining, stopped_reason, actor_user_id, duration_ms, deferred_identity, concurrency)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(r.id, r.trigger, r.startedAt, finishedAt, r.examined, r.promoted, r.existingCrm, r.review, r.suppressed, r.rejected, r.failed, r.remaining, r.stoppedReason, actorUserId,
      Math.max(0, Math.round(durationMs)), deferredIdentity, concurrency).run();
  return { ...r, finishedAt, durationMs: Math.max(0, Math.round(durationMs)), deferredIdentity, concurrency };
}

export interface PromotionRunRow {
  id: string; trigger: string; started_at: string; finished_at: string | null;
  examined: number; promoted: number; existing_crm: number; review: number; suppressed: number;
  rejected: number; failed: number; remaining: number; stopped_reason: string;
  duration_ms: number | null; deferred_identity: number; concurrency: number | null;
}

/** The most recent runs, for the dashboard and for answering "what did the backlog drain do". */
export async function recentRuns(db: Db, limit = 10): Promise<PromotionRunRow[]> {
  return (await db.prepare(`SELECT id, trigger, started_at, finished_at, examined, promoted, existing_crm, review, suppressed, rejected, failed, remaining, stopped_reason,
        duration_ms, deferred_identity, concurrency
      FROM research_promotion_runs ORDER BY started_at DESC LIMIT ?`).bind(limit).all<PromotionRunRow>()).results;
}

/** Totals over a window, so the dashboard can report imports against the eligible population rather than clicks. */
export async function promotionTotals(db: Db, sinceIso: string) {
  const r = await db.prepare(`SELECT COALESCE(SUM(examined),0) AS examined, COALESCE(SUM(promoted),0) AS promoted, COALESCE(SUM(existing_crm),0) AS existing_crm,
      COALESCE(SUM(review),0) AS review, COALESCE(SUM(suppressed),0) AS suppressed, COALESCE(SUM(rejected),0) AS rejected, COALESCE(SUM(failed),0) AS failed
      FROM research_promotion_runs WHERE started_at >= ?`).bind(sinceIso).first<Record<string, number>>();
  return {
    examined: Number(r?.examined ?? 0), promoted: Number(r?.promoted ?? 0), existingCrm: Number(r?.existing_crm ?? 0),
    review: Number(r?.review ?? 0), suppressed: Number(r?.suppressed ?? 0), rejected: Number(r?.rejected ?? 0), failed: Number(r?.failed ?? 0),
  };
}

/** The per-minute target the system is built to sustain, and the floor an alert fires below. */
export const TARGET_PER_MINUTE = 25;
/** Below this many eligible prospects, missing the target is a supply problem, not a throughput one. */
export const MIN_BACKLOG_FOR_TARGET = TARGET_PER_MINUTE * 10;

export interface ImportRate {
  /** Genuinely new CRM leads created in the window, counted from the leads table itself. */
  leads: number;
  /** Per minute and per hour, derived from the real row count over the real window. */
  perMinute: number;
  perHour: number;
  /** Minutes the window actually covers. */
  minutes: number;
  /** Scheduled ticks that recorded a run in the window, and how many were turned away by the lease. */
  runs: number;
  locked: number;
  /** Totals the runs themselves reported, for comparison against the row count. */
  reported: number;
  failed: number;
  retried: number;
  /** Prospects held back for sharing an identifier with one already in a batch. */
  deferredIdentity: number;
  /** Longest and mean run, in milliseconds. */
  slowestMs: number;
  meanMs: number;
  /** Still eligible when this was read. */
  backlog: number;
  /** True when the rate is under target while there is clearly enough work to hit it. */
  belowTarget: boolean;
}

/**
 * The import rate as the CRM sees it.
 *
 * `leads` comes from the `leads` table, NOT from the promoter's counters: the target is stated in successfully
 * persisted, genuinely new CRM leads, and a counter can be wrong in a way a row cannot. `reported` is carried
 * alongside precisely so the two can be compared — a gap between them is a defect, not a rounding difference.
 */
export async function importRate(db: Db, minutes: number, now = new Date()): Promise<ImportRate> {
  const since = new Date(now.getTime() - minutes * 60_000).toISOString();
  const [leadRow, runRow, backlog] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent' AND created_at >= ?`).bind(since).first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(promoted),0) AS reported, COALESCE(SUM(failed),0) AS failed,
        COALESCE(SUM(deferred_identity),0) AS deferred, COALESCE(MAX(duration_ms),0) AS slowest,
        COALESCE(AVG(duration_ms),0) AS mean, COALESCE(SUM(CASE WHEN stopped_reason = 'locked' THEN 1 ELSE 0 END),0) AS locked
        FROM research_promotion_runs WHERE started_at >= ?`).bind(since).first<Record<string, number>>(),
    dueCount(db, now),
  ]);
  const retriedRow = await db.prepare(`SELECT COUNT(*) AS n FROM research_prospects WHERE promote_attempts > 0 AND status = 'qualified'`).first<{ n: number }>();
  const leads = Number(leadRow?.n ?? 0);
  const perMinute = minutes > 0 ? leads / minutes : 0;
  return {
    leads, perMinute, perHour: perMinute * 60, minutes,
    runs: Number(runRow?.runs ?? 0), locked: Number(runRow?.locked ?? 0),
    reported: Number(runRow?.reported ?? 0), failed: Number(runRow?.failed ?? 0), retried: Number(retriedRow?.n ?? 0),
    deferredIdentity: Number(runRow?.deferred ?? 0),
    slowestMs: Math.round(Number(runRow?.slowest ?? 0)), meanMs: Math.round(Number(runRow?.mean ?? 0)),
    backlog,
    // Under target only counts as a problem when there was work to do: with the backlog drained, a low rate is the
    // correct outcome and must never page anyone.
    belowTarget: perMinute < TARGET_PER_MINUTE && backlog >= MIN_BACKLOG_FOR_TARGET,
  };
}
