// READY-013: recalculation of derived readiness state.
//
// The derivation in derive.ts is a pure function and is recomputed on every read, so the dashboard can never
// serve a stale answer. This module persists the result so the Owner can also see WHEN readiness was last
// recalculated, WHAT changed and WHY — and so a regression leaves a trail instead of silently reverting.
//
// Called whenever something that can change a verdict happens: evidence ingested, a deployment recorded, a
// blocker opened or resolved, requirements registered. It is idempotent (a second run with no new facts writes
// no history and reports 0 changed), retryable (a failure is recorded and nothing is half-written, because the
// writes go through one D1 batch) and auditable (every transition is an append-only row).
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { loadReadinessInput } from "./report.ts";
import { computeRequirementStatuses } from "./engine.ts";

export interface SyncResult {
  syncId: string;
  trigger: string;
  requirements: number;
  changed: number;
  headCommit: string | null;
  transitions: { id: string; from: string | null; to: string }[];
}

interface StoredState { requirement_id: string; state: string; progress: string; complete: number; complete_at: string; detail: string; proven_commit: string | null; head_commit: string | null; evidence_run_ids: string | null }

/**
 * Recomputes every requirement's derived state and records what moved.
 * `trigger` says what prompted it, e.g. `evidence:staging_e2e`, `deployment:staging`, `blocker`, `manual`.
 */
export async function syncDerivedStates(db: Db, trigger: string, now = new Date()): Promise<SyncResult> {
  const startedAt = nowIso();
  const syncId = newId("rsync");
  try {
    const input = await loadReadinessInput(db, now);
    const statuses = computeRequirementStatuses(input);
    const stored = new Map(
      (await db.prepare(`SELECT * FROM requirement_state`).all<StoredState>()).results.map((r) => [r.requirement_id, r]),
    );
    const at = nowIso();
    const headCommit = statuses.find((s) => s.headCommit)?.headCommit ?? null;
    const writes = [];
    const transitions: SyncResult["transitions"] = [];

    for (const s of statuses) {
      const prev = stored.get(s.id);
      const runIds = s.evidenceRunIds.join(" ");
      const same = prev && prev.state === s.autoState && prev.progress === s.autoProgress
        && !!prev.complete === s.autoComplete && prev.complete_at === s.completeAt && prev.detail === s.autoDetail
        && (prev.proven_commit ?? null) === s.provenCommit && (prev.head_commit ?? null) === s.headCommit
        && (prev.evidence_run_ids ?? "") === runIds;
      if (same) continue; // idempotent: nothing to write when nothing moved

      writes.push(db.prepare(
        `INSERT INTO requirement_state (requirement_id, state, progress, complete, complete_at, detail, proven_commit, head_commit, evidence_run_ids, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(requirement_id) DO UPDATE SET state=excluded.state, progress=excluded.progress, complete=excluded.complete,
           complete_at=excluded.complete_at, detail=excluded.detail, proven_commit=excluded.proven_commit,
           head_commit=excluded.head_commit, evidence_run_ids=excluded.evidence_run_ids, updated_at=excluded.updated_at`,
      ).bind(s.id, s.autoState, s.autoProgress, s.autoComplete ? 1 : 0, s.completeAt, s.autoDetail, s.provenCommit, s.headCommit, runIds, at));

      // Only a real change of state earns a history row; a reworded detail is not a transition.
      if (!prev || prev.state !== s.autoState) {
        transitions.push({ id: s.id, from: prev?.state ?? null, to: s.autoState });
        writes.push(db.prepare(
          `INSERT INTO requirement_state_history (requirement_id, sync_id, from_state, to_state, detail, head_commit, changed_at)
           VALUES (?,?,?,?,?,?,?)`,
        ).bind(s.id, syncId, prev?.state ?? null, s.autoState, s.autoDetail, s.headCommit, at));
      }
    }

    writes.push(db.prepare(
      `INSERT INTO readiness_sync (id, trigger, head_commit, requirements, changed, error, started_at, finished_at) VALUES (?,?,?,?,?,NULL,?,?)`,
    ).bind(syncId, trigger.slice(0, 100), headCommit, statuses.length, transitions.length, startedAt, at));

    await db.batch(writes); // atomic in D1: a failure leaves no partial sync
    return { syncId, trigger, requirements: statuses.length, changed: transitions.length, headCommit, transitions };
  } catch (err) {
    // Retryable: the failure is visible rather than silently leaving the dashboard on old numbers.
    await db.prepare(
      `INSERT INTO readiness_sync (id, trigger, head_commit, requirements, changed, error, started_at, finished_at) VALUES (?,?,NULL,0,0,?,?,?)`,
    ).bind(syncId, trigger.slice(0, 100), String((err as Error).message).slice(0, 500), startedAt, nowIso()).run().catch(() => {});
    throw err;
  }
}

export interface SyncRow { id: string; trigger: string; head_commit: string | null; requirements: number; changed: number; error: string | null; started_at: string; finished_at: string }

/** The most recent synchronisations, newest first — "last recalculated" on the dashboard. */
export async function recentSyncs(db: Db, limit = 10): Promise<SyncRow[]> {
  return (await db.prepare(`SELECT * FROM readiness_sync ORDER BY finished_at DESC, rowid DESC LIMIT ?`).bind(limit).all<SyncRow>()).results;
}

export interface TransitionRow { requirement_id: string; from_state: string | null; to_state: string; detail: string; head_commit: string | null; changed_at: string }

/** Recent transitions, for the dashboard's "what changed" panel and for a single requirement's history. */
export async function recentTransitions(db: Db, opts: { requirementId?: string; limit?: number } = {}): Promise<TransitionRow[]> {
  const limit = opts.limit ?? 20;
  const sql = `SELECT requirement_id, from_state, to_state, detail, head_commit, changed_at FROM requirement_state_history
               ${opts.requirementId ? "WHERE requirement_id = ?" : ""} ORDER BY id DESC LIMIT ?`;
  const stmt = opts.requirementId ? db.prepare(sql).bind(opts.requirementId, limit) : db.prepare(sql).bind(limit);
  return (await stmt.all<TransitionRow>()).results;
}

/** Requirements that lost a verdict they previously held: what the Owner must look at first. */
export async function regressions(db: Db): Promise<StoredState[]> {
  return (await db.prepare(`SELECT * FROM requirement_state WHERE state IN ('REGRESSED','EVIDENCE_STALE') ORDER BY requirement_id`).all<StoredState>()).results;
}
