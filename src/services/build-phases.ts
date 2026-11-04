// Build phases and the design freeze (platform). The phase machine lives HERE, not in the runner: a runner can
// propose that its design is finished, and only the platform — which re-verified the scorecard itself — decides
// whether the gate opens.
//
// WHY THE PLATFORM OWNS IT. "Design at 39/40 cannot unlock the backend phase" has to be true even when the runner
// believes otherwise, is a version behind, or has been restarted mid-build. And the freeze has to survive a runner
// restart, a container replacement, a GPU model change, a checkpoint restore and a resumed multi-segment build, so
// it is rows in D1 rather than state in a process that may not exist in a minute's time.
//
// WHAT A FREEZE IS. A row naming: the job and attempt, the stored snapshot (attempt-cycle) whose files ARE the
// approved design, the commit, the 40/40 rubric with the reviewer's own per-item notes, the viewports evidenced,
// the gallery references a vision model actually saw, the reviewer by name, and a fingerprint of the frontend
// source. `platform_verified` is 1 only once this platform has re-verified the card the certification came from:
// that column, not the runner's claim, is what the functionality gate reads.

import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { HttpError } from "../app/http.ts";
import { audit } from "./security.ts";
import {
  BUILD_PHASES, CATEGORY_MAX, NEXT_PHASE, PHASE_LABEL, PRIMARY_PROGRESS, phaseBlockers, round1,
  type BuildPhase, type CategoryScore,
} from "../domain/quality-rubric.ts";
import type { VerifiedScorecard2 } from "../domain/quality-verify.ts";

export interface FreezeRow {
  id: string; job_id: string; project_id: string; attempt: number;
  revision_attempt: number; revision_cycle: number; commit_sha: string | null;
  design_points: number; rubric_json: string; viewports_json: string; screenshots_json: string;
  source_fingerprint: string | null; design_references_json: string;
  reviewer: string; reviewer_model: string | null; images_seen: number;
  certified_at: string; platform_verified: number; invalidated_at: string | null; invalidated_reason: string | null;
}

export interface PhaseRow { build_phase: BuildPhase; design_freeze_id: string | null }

export const isBuildPhase = (v: unknown): v is BuildPhase => (BUILD_PHASES as readonly string[]).includes(String(v));

export async function phaseOf(db: Db, jobId: string): Promise<PhaseRow> {
  const r = await db.prepare(`SELECT build_phase, design_freeze_id FROM build_jobs WHERE id = ?`).bind(jobId).first<PhaseRow>();
  if (!r) throw new HttpError(404, "No such build job");
  return { build_phase: isBuildPhase(r.build_phase) ? r.build_phase : "design", design_freeze_id: r.design_freeze_id };
}

/** The freeze that is currently authoritative for a job: verified, not invalidated. */
export async function activeFreeze(db: Db, jobId: string): Promise<FreezeRow | null> {
  const f = await db.prepare(`SELECT f.* FROM build_jobs j JOIN build_design_freezes f ON f.id = j.design_freeze_id WHERE j.id = ?`).bind(jobId).first<FreezeRow>();
  return f && !f.invalidated_at && f.platform_verified ? f : null;
}

export async function freezeHistory(db: Db, jobId: string): Promise<FreezeRow[]> {
  return (await db.prepare(`SELECT * FROM build_design_freezes WHERE job_id = ? ORDER BY certified_at DESC`).bind(jobId).all<FreezeRow>()).results;
}

export async function milestones(db: Db, jobId: string) {
  return (await db.prepare(`SELECT phase, cycle, design_points, functionality_points, other_points, reason, blockers_json, entered, created_at
      FROM build_phase_milestones WHERE job_id = ? ORDER BY created_at ASC`).bind(jobId)
    .all<{ phase: BuildPhase; cycle: number | null; design_points: number | null; functionality_points: number | null; other_points: number | null; reason: string; blockers_json: string; entered: number; created_at: string }>()).results;
}

/**
 * Record a design certification and make it the authoritative freeze.
 *
 * Refused unless the verified card actually supports it: a card the platform could not verify, or whose design is
 * short of 40/40, or that names no stored revision, cannot create a freeze. The refusal is recorded as a milestone
 * with `entered = 0` and its blockers, so "the design was not certified, and why" is as durable as a success.
 */
export async function freezeDesign(db: Db, job: { id: string; project_id: string; organization_id: string; attempts: number }, o: {
  card: VerifiedScorecard2;
  revision: { attempt: number; cycle: number } | null;
  commitSha: string | null;
  cycle: number | null;
  /** Frontend source + asset bytes of the approved design, for the fingerprint. */
  sourceFingerprint?: string | null;
  /** Gallery reference ids whose images a vision model actually received (design_reference_uses.model_saw = 1). */
  designReferences?: string[];
  reviewerModel?: string | null;
  screenshots?: string[];
}): Promise<{ frozen: FreezeRow | null; blockers: string[] }> {
  const blockers = [...o.card.designBlockers];
  if (!o.card.ok) blockers.unshift(`the platform could not verify this scorecard: ${o.card.problems.slice(0, 3).join("; ")}`);
  if (!o.revision) blockers.push("no stored revision snapshot holds this design");
  if (blockers.length) {
    await recordMilestone(db, job, { phase: "design_locked", cycle: o.cycle, card: o.card, entered: false, reason: "design certification refused", blockers });
    return { frozen: null, blockers };
  }
  const rev = o.revision!;
  const at = nowIso();
  const id = newId("bdf");
  await db.prepare(`INSERT INTO build_design_freezes (id, job_id, project_id, attempt, revision_attempt, revision_cycle, commit_sha, design_points,
      rubric_json, viewports_json, screenshots_json, source_fingerprint, design_references_json, reviewer, reviewer_model, images_seen, certified_at, platform_verified)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT (job_id, attempt, revision_attempt, revision_cycle) DO UPDATE SET
        design_points = excluded.design_points, rubric_json = excluded.rubric_json, viewports_json = excluded.viewports_json,
        screenshots_json = excluded.screenshots_json, source_fingerprint = excluded.source_fingerprint,
        design_references_json = excluded.design_references_json, reviewer = excluded.reviewer, reviewer_model = excluded.reviewer_model,
        images_seen = excluded.images_seen, certified_at = excluded.certified_at, platform_verified = 1,
        invalidated_at = NULL, invalidated_reason = NULL`)
    .bind(id, job.id, job.project_id, job.attempts, rev.attempt, rev.cycle, o.commitSha, round1(o.card.design.points),
      JSON.stringify(o.card.design.items), JSON.stringify(o.card.viewports), JSON.stringify((o.screenshots ?? []).slice(0, 60)),
      o.sourceFingerprint ?? null, JSON.stringify((o.designReferences ?? []).slice(0, 40)),
      o.card.review?.reviewer ?? "unknown", o.reviewerModel ?? null, o.card.review?.imagesSeen ?? 0, at).run();

  const frozen = await db.prepare(`SELECT * FROM build_design_freezes WHERE job_id = ? AND attempt = ? AND revision_attempt = ? AND revision_cycle = ?`)
    .bind(job.id, job.attempts, rev.attempt, rev.cycle).first<FreezeRow>();
  if (!frozen) throw new HttpError(500, "the design freeze was not stored");

  await db.prepare(`UPDATE build_jobs SET design_freeze_id = ?, build_phase = 'design_locked', updated_at = ? WHERE id = ?`).bind(frozen.id, at, job.id).run();
  // The snapshot that holds the approved design is marked, so the Founder can find the authoritative baseline among
  // the revisions without reading the freeze row.
  await db.prepare(`UPDATE build_revisions SET is_design_baseline = 0 WHERE job_id = ?`).bind(job.id).run();
  await db.prepare(`UPDATE build_revisions SET is_design_baseline = 1 WHERE job_id = ? AND attempt = ? AND cycle = ?`).bind(job.id, rev.attempt, rev.cycle).run();
  await recordMilestone(db, job, { phase: "design_locked", cycle: o.cycle, card: o.card, entered: true, reason: `Visual design certified at ${round1(o.card.design.points)}/40 and frozen at revision ${rev.attempt}-${rev.cycle}`, blockers: [] });
  await audit(db, { actorKind: "system", action: "builds.design_frozen", subjectType: "build_job", subjectId: job.id, organizationId: job.organization_id, details: { freeze: frozen.id, revision: `${rev.attempt}-${rev.cycle}`, designPoints: round1(o.card.design.points), reviewer: o.card.review?.reviewer ?? null } });
  return { frozen, blockers: [] };
}

/**
 * Later work changed the frozen presentation and the design no longer certifies.
 *
 * The freeze is NOT deleted and the functional work is NOT reverted: the row is marked invalidated with the reason,
 * the job goes back to the functionality phase with a design repair outstanding, and the certification history keeps
 * showing what was approved and when it stopped holding. Blindly reverting the whole project here would throw away
 * the backend progress that caused the regression, which is the opposite of what is wanted.
 */
export async function invalidateFreeze(db: Db, job: { id: string; organization_id: string }, reason: string): Promise<boolean> {
  const at = nowIso();
  const r = await db.prepare(`UPDATE build_design_freezes SET invalidated_at = ?, invalidated_reason = ?
      WHERE id = (SELECT design_freeze_id FROM build_jobs WHERE id = ?) AND invalidated_at IS NULL`)
    .bind(at, reason.slice(0, 600), job.id).run();
  if (!r.meta?.changes) return false;
  await audit(db, { actorKind: "system", action: "builds.design_freeze_invalidated", subjectType: "build_job", subjectId: job.id, organizationId: job.organization_id, details: { reason: reason.slice(0, 300) } });
  return true;
}

/** Re-certification after a repaired visual regression: the same freeze holds again. */
export async function revalidateFreeze(db: Db, job: { id: string; organization_id: string }, card: VerifiedScorecard2): Promise<boolean> {
  if (!card.designCertified || !card.ok) return false;
  const r = await db.prepare(`UPDATE build_design_freezes SET invalidated_at = NULL, invalidated_reason = NULL
      WHERE id = (SELECT design_freeze_id FROM build_jobs WHERE id = ?) AND invalidated_at IS NOT NULL`).bind(job.id).run();
  if (!r.meta?.changes) return false;
  await audit(db, { actorKind: "system", action: "builds.design_freeze_revalidated", subjectType: "build_job", subjectId: job.id, organizationId: job.organization_id, details: { designPoints: round1(card.design.points) } });
  return true;
}

export interface PhaseDecision {
  phase: BuildPhase;
  previous: BuildPhase;
  advanced: boolean;
  blockers: string[];
  /** The ACTIVE phase's own category score: the number the stall guard compares. */
  primaryProgress: number | null;
  primaryCategory: "design" | "functionality" | "other" | null;
  reason: string;
}

/**
 * Advance the job's phase if its gate is open, using the platform's OWN verification of the card.
 *
 * Only ever one step at a time, and only forward: a card claiming 100/100 on its first cycle still has to pass the
 * design gate, be frozen, and pass the functionality gate on subsequent cycles. That is deliberate — the freeze is a
 * durable record of an approved design, and a build that skipped it has no approved design to point at.
 */
export async function advancePhase(db: Db, job: { id: string; project_id: string; organization_id: string; attempts: number }, o: {
  card: VerifiedScorecard2;
  cycle: number | null;
  safetyBlockers?: string[];
}): Promise<PhaseDecision> {
  const { build_phase: previous } = await phaseOf(db, job.id);
  const freeze = await activeFreeze(db, job.id);
  const primaryCategory = PRIMARY_PROGRESS[previous];
  const primaryProgress = primaryCategory ? round1(o.card[primaryCategory].points) : null;

  const blockers = phaseBlockers({
    phase: previous, design: o.card.design, functionality: o.card.functionality, other: o.card.other,
    designCertified: o.card.designCertified, designFrozen: !!freeze, safetyBlockers: o.safetyBlockers ?? [],
  });
  // "The visual design is not certified at 40/40" tells the runner nothing it can act on. Whenever the design is
  // what is short, the specific reasons travel with the refusal: the missing viewport, the text-only reviewer, the
  // item that scored below its maximum. A gate that will not say why it is shut cannot be satisfied.
  if (blockers.length && !o.card.designCertified && o.card.designBlockers.length) {
    blockers.push(...o.card.designBlockers.slice(0, 6).filter((b) => !blockers.includes(b)));
  }
  if (!o.card.ok) blockers.unshift(`the platform could not verify this scorecard: ${o.card.problems.slice(0, 3).join("; ")}`);

  const next = NEXT_PHASE[previous];
  if (blockers.length || !next) {
    const reason = blockers.length
      ? `${PHASE_LABEL[previous]} continues: ${blockers.slice(0, 3).join("; ")}`
      : `${PHASE_LABEL[previous]} is the final phase`;
    await recordMilestone(db, job, { phase: previous, cycle: o.cycle, card: o.card, entered: false, reason, blockers });
    return { phase: previous, previous, advanced: false, blockers, primaryProgress, primaryCategory, reason };
  }

  // design -> design_locked is the freeze itself, which has its own evidence requirements and its own writer.
  if (previous === "design") {
    return { phase: previous, previous, advanced: false, blockers: [], primaryProgress, primaryCategory,
      reason: "the design is certified; the freeze records it and moves the job to design_locked" };
  }

  await db.prepare(`UPDATE build_jobs SET build_phase = ?, updated_at = ? WHERE id = ?`).bind(next, nowIso(), job.id).run();
  const reason = `${PHASE_LABEL[previous]} complete: ${describe(previous, o.card)}`;
  await recordMilestone(db, job, { phase: next, cycle: o.cycle, card: o.card, entered: true, reason, blockers: [] });
  await audit(db, { actorKind: "system", action: "builds.phase_advanced", subjectType: "build_job", subjectId: job.id, organizationId: job.organization_id, details: { from: previous, to: next, designPoints: round1(o.card.design.points), functionalityPoints: round1(o.card.functionality.points), otherPoints: round1(o.card.other.points) } });
  return { phase: next, previous, advanced: true, blockers: [], primaryProgress, primaryCategory, reason };
}

/** Put a job into `waiting` (an external party or missing information), remembering the phase to return to. */
export async function setPhase(db: Db, job: { id: string; project_id: string; organization_id: string; attempts: number }, phase: BuildPhase, reason: string): Promise<void> {
  if (!isBuildPhase(phase)) throw new HttpError(422, "unknown build phase");
  await db.prepare(`UPDATE build_jobs SET build_phase = ?, updated_at = ? WHERE id = ?`).bind(phase, nowIso(), job.id).run();
  await db.prepare(`INSERT INTO build_phase_milestones (id, job_id, attempt, phase, cycle, reason, blockers_json, entered, created_at) VALUES (?,?,?,?,NULL,?,'[]',1,?)`)
    .bind(newId("bpm"), job.id, job.attempts, phase, reason.slice(0, 600), nowIso()).run();
}

async function recordMilestone(db: Db, job: { id: string; attempts: number }, o: {
  phase: BuildPhase; cycle: number | null; card: VerifiedScorecard2; entered: boolean; reason: string; blockers: string[];
}): Promise<void> {
  await db.prepare(`INSERT INTO build_phase_milestones (id, job_id, attempt, phase, cycle, design_points, functionality_points, other_points, reason, blockers_json, entered, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(newId("bpm"), job.id, job.attempts, o.phase, o.cycle, round1(o.card.design.points), round1(o.card.functionality.points), round1(o.card.other.points),
      o.reason.slice(0, 600), JSON.stringify(o.blockers.slice(0, 20)), o.entered ? 1 : 0, nowIso()).run();
}

const describe = (phase: BuildPhase, card: VerifiedScorecard2) => {
  const cat = PRIMARY_PROGRESS[phase];
  return cat ? `${cat} ${round1(card[cat].points)}/${CATEGORY_MAX[cat]}` : "no category score";
};

/** Fingerprint of the frontend source and assets that produced a design, so later work can be told it moved. */
export async function designFingerprint(files: { path: string; sha256: string }[]): Promise<string> {
  const visual = files.filter((f) => /\.(?:html|css|svg|png|jpe?g|webp|avif|woff2?)$/i.test(f.path) && !f.path.startsWith(".crestmont/"));
  return sha256Hex(visual.map((f) => `${f.path}:${f.sha256}`).sort().join("\n"));
}

/** Per-phase efficiency metrics, accumulated. Measured values only; nothing here is estimated. */
export async function recordPhaseMetrics(db: Db, job: { id: string; attempts: number }, phase: BuildPhase, add: {
  inferenceCalls?: number; inputTokens?: number; outputTokens?: number; elapsedMs?: number; reviewMs?: number;
  implementationMs?: number; revisions?: number; reviews?: number; rollbacks?: number; ineffectiveRepairs?: number;
}): Promise<void> {
  if (!isBuildPhase(phase)) return;
  const n = (v: number | undefined) => Math.max(0, Math.trunc(v ?? 0));
  await db.prepare(`INSERT INTO build_phase_metrics (job_id, attempt, phase, inference_calls, input_tokens, output_tokens, elapsed_ms, review_ms, implementation_ms, revisions, reviews, rollbacks, ineffective_repairs, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (job_id, attempt, phase) DO UPDATE SET
        inference_calls = inference_calls + excluded.inference_calls, input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens, elapsed_ms = elapsed_ms + excluded.elapsed_ms,
        review_ms = review_ms + excluded.review_ms, implementation_ms = implementation_ms + excluded.implementation_ms,
        revisions = revisions + excluded.revisions, reviews = reviews + excluded.reviews,
        rollbacks = rollbacks + excluded.rollbacks, ineffective_repairs = ineffective_repairs + excluded.ineffective_repairs,
        updated_at = excluded.updated_at`)
    .bind(job.id, job.attempts, phase, n(add.inferenceCalls), n(add.inputTokens), n(add.outputTokens), n(add.elapsedMs), n(add.reviewMs),
      n(add.implementationMs), n(add.revisions), n(add.reviews), n(add.rollbacks), n(add.ineffectiveRepairs), nowIso()).run();
}

export async function phaseMetrics(db: Db, jobId: string) {
  return (await db.prepare(`SELECT * FROM build_phase_metrics WHERE job_id = ? ORDER BY attempt, phase`).bind(jobId)
    .all<{ attempt: number; phase: BuildPhase; inference_calls: number; input_tokens: number; output_tokens: number; elapsed_ms: number; review_ms: number; implementation_ms: number; revisions: number; reviews: number; rollbacks: number; ineffective_repairs: number }>()).results;
}

/** Which viewports a stored revision can actually prove it rendered, from the screenshot files it holds. */
export async function evidencedViewports(db: Db, jobId: string, attempt: number, cycle: number): Promise<("desktop" | "tablet" | "mobile")[]> {
  const rows = (await db.prepare(`SELECT f.path FROM build_revisions r JOIN build_revision_files f ON f.revision_id = r.id
      WHERE r.job_id = ? AND r.attempt = ? AND r.cycle = ? AND f.kind = 'screenshot'`).bind(jobId, attempt, cycle).all<{ path: string }>()).results;
  const out = new Set<"desktop" | "tablet" | "mobile">();
  for (const r of rows) for (const v of ["desktop", "tablet", "mobile"] as const) if (r.path.includes(`-${v}.`)) out.add(v);
  return [...out];
}

export type { BuildPhase, CategoryScore };
