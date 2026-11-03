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

export type PromotionTrigger = "scheduled" | "owner" | "ingest";
export type StoppedReason = "drained" | "cap" | "budget" | "disabled" | "error";

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
 * Where every research record stands relative to the CRM. This is the reconciliation denominator: `eligibleNow` is
 * the population automatic promotion is responsible for, and every other number is a stated reason a record is not
 * in it. They sum to the records on file, so nothing is silently dropped.
 */
export async function eligibilityCensus(db: Db): Promise<EligibilityCensus> {
  const s = await loadSettings(db);
  const t = s.qualify_threshold;
  return {
    totalOnRecord: await n(db, `SELECT COUNT(*) AS n FROM research_prospects`),
    uniqueQualified: await n(db, `SELECT COUNT(*) AS n FROM research_prospects WHERE qualified = 1`),
    eligibleNow: await n(db, `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'qualified' AND qualified = 1 AND score >= ? AND promote_attempts < ?`, t, MAX_PROMOTE_ATTEMPTS),
    belowThreshold: await n(db, `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'qualified' AND qualified = 1 AND score < ?`, t),
    outOfAttempts: await n(db, `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'qualified' AND promote_attempts >= ?`, MAX_PROMOTE_ATTEMPTS),
    awaitingVerification: await n(db, `SELECT COUNT(*) AS n FROM research_prospects WHERE website_class IN ('WEBSITE_UNVERIFIED','BUSINESS_IDENTITY_UNCERTAIN')`),
    notQualified: await n(db, `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'not_qualified'`),
    needsPerson: await n(db, `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'review'`),
    suppressed: await n(db, `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'suppressed'`),
    existingCrm: await n(db, `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'existing_crm'`),
    alreadyPromoted: await n(db, `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'promoted'`),
    dismissed: await n(db, `SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'dismissed'`),
  };
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
    return finish(db, { id: runId, trigger: opts.trigger, startedAt, ...blank, remaining: await dueCount(db, now), stoppedReason: "disabled" }, opts.actorUserId ?? null);
  }

  const cap = Math.max(1, Math.min(opts.limit ?? settings.auto_promote_max_per_run, settings.auto_promote_max_per_run));
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const actor = opts.actor ?? RESEARCH_AUTOMATION;

  // Once for the whole batch rather than once per prospect: opt-outs recorded since the last run move the affected
  // prospects to 'suppressed' before anything is attempted, so a suppressed number is never promoted.
  await applySuppressions(db);

  const batch = (await db.prepare(`SELECT id FROM research_prospects
      WHERE status = 'qualified' AND qualified = 1 AND score >= ? AND promote_attempts < ? AND (promote_next_at IS NULL OR promote_next_at <= ?)
      ORDER BY score DESC, first_seen_at LIMIT ?`)
    .bind(settings.qualify_threshold, MAX_PROMOTE_ATTEMPTS, startedAt, cap).all<{ id: string }>()).results;

  const counts = { ...blank };
  const attempted: string[] = [];
  let stoppedReason: StoppedReason = batch.length < cap ? "drained" : "cap";

  for (const row of batch) {
    if (Date.now() > deadline) { stoppedReason = "budget"; break; }
    attempted.push(row.id);
    counts.examined++;
    try {
      await promote(db, actor, row.id, { sweepSuppressions: false });
      counts.promoted++;
    } catch (e) {
      // A blocked promotion is a decision, not a crash: promote() has already recorded why and, for the outcomes that
      // have a resting place, moved the prospect's status. Anything still 'qualified' afterwards is classified below.
      if (!(e instanceof HttpError) && !(e as { status?: number })?.status) {
        counts.failed++;
        await backoff(db, row.id, e, now);
      }
    }
  }

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
  const result = await finish(db, { id: runId, trigger: opts.trigger, startedAt, ...counts, remaining, stoppedReason }, opts.actorUserId ?? null);
  if (result.examined > 0 || opts.trigger === "owner") {
    await audit(db, {
      actorUserId: opts.actorUserId ?? null, action: "research.auto_promotion_run", subjectType: "research_promotion_run", subjectId: runId,
      details: { trigger: result.trigger, examined: result.examined, promoted: result.promoted, existingCrm: result.existingCrm, review: result.review, suppressed: result.suppressed, rejected: result.rejected, failed: result.failed, remaining: result.remaining, stoppedReason: result.stoppedReason },
    });
  }
  return result;
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

async function finish(db: Db, r: Omit<PromotionRunResult, "finishedAt">, actorUserId: string | null): Promise<PromotionRunResult> {
  const finishedAt = nowIso();
  await db.prepare(`INSERT INTO research_promotion_runs (id, trigger, started_at, finished_at, examined, promoted, existing_crm, review, suppressed, rejected, failed, remaining, stopped_reason, actor_user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(r.id, r.trigger, r.startedAt, finishedAt, r.examined, r.promoted, r.existingCrm, r.review, r.suppressed, r.rejected, r.failed, r.remaining, r.stoppedReason, actorUserId).run();
  return { ...r, finishedAt };
}

export interface PromotionRunRow {
  id: string; trigger: string; started_at: string; finished_at: string | null;
  examined: number; promoted: number; existing_crm: number; review: number; suppressed: number;
  rejected: number; failed: number; remaining: number; stopped_reason: string;
}

/** The most recent runs, for the dashboard and for answering "what did the backlog drain do". */
export async function recentRuns(db: Db, limit = 10): Promise<PromotionRunRow[]> {
  return (await db.prepare(`SELECT id, trigger, started_at, finished_at, examined, promoted, existing_crm, review, suppressed, rejected, failed, remaining, stopped_reason
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
