// Quality engine persistence and gates (platform). Scorecards are stored for every reported build iteration;
// internal approval of a quality-required build needs the latest scorecard to be verified AND eligible; reusable
// causes become builder improvement proposals that change nothing without a person's approval.
//
// TWO SCHEMAS LIVE HERE AT ONCE, ON PURPOSE.
//   /1 — the flat twenty-criteria scorecard. Eligible at a verified 10/10. Historical rows keep these numbers
//        exactly as reported, and are labelled legacy in the UI. bld_50e28bbd1cd033ad9ddfad02's 9.4 is one of them:
//        it stays visible as history and is never presented as having passed the weighted visual rubric.
//   /2 — the weighted scorecard: Visual Design 40 + Functionality 40 + Remaining 20. Eligible only at a verified
//        100/100 with every category actually measured, and no compensating scores.
// A card is routed by its own `schema` field, so a runner one version behind still reports a card the platform
// stores and verifies rather than rejecting outright — it simply cannot reach the new eligibility.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { HttpError } from "../app/http.ts";
import { audit } from "./security.ts";
import { verifyScorecard, requiredCapabilities, type VerifiedScorecard } from "../domain/quality.ts";
import { isScorecardV2, verifyScorecard2, type VerifiedScorecard2 } from "../domain/quality-verify.ts";
import { SCORECARD_V1_SCHEMA, SCORECARD_V2_SCHEMA, round1 } from "../domain/quality-rubric.ts";
import { evidencedViewports } from "./build-phases.ts";

export interface QualityRow {
  id: string; job_id: string; attempt: number; iteration: number; package_id: string; outcome: string; score: number; applicable: number; passed: number;
  eligible: number; waiting_external: number; verified: number; verification_problems_json: string; criteria_json: string; defects_json: string; created_at: string;
  /** 0076: weighted scorecard. Rows that predate it default to SCORECARD_V1_SCHEMA and leave the rest NULL. */
  schema_version: string; build_phase: string | null;
  design_points: number | null; functionality_points: number | null; other_points: number | null; total_points: number | null;
  rubric_json: string; design_certified: number; design_blockers_json: string;
}

/** A recorded card, either schema. `score` is always the 0-10 figure so existing readers keep working. */
export type RecordedQuality =
  | ({ version: 1 } & VerifiedScorecard)
  | ({ version: 2; score: number; applicable: number; passed: number } & VerifiedScorecard2);

interface JobLike { id: string; project_id: string; organization_id: string; attempts: number; package_id: string | null; strategy: string; brief_id: string | null }

/** The scope the platform scores against: the package and what the customer asked for in the brief snapshot. */
export async function scopeOf(db: Db, job: JobLike): Promise<{ packageId: string; required: Set<string> }> {
  const packageId = job.package_id ?? (job.strategy === "custom" ? "custom" : "starter");
  const brief = job.brief_id ? await db.prepare(`SELECT content_json FROM build_briefs WHERE id = ?`).bind(job.brief_id).first<{ content_json: string }>() : null;
  let features: { key: string }[] = [], integrations: string[] = [];
  try {
    const c = brief ? (JSON.parse(brief.content_json) as { customerData?: { features?: { key: string }[]; integrations?: string[] } }).customerData : undefined;
    features = Array.isArray(c?.features) ? c!.features : [];
    integrations = Array.isArray(c?.integrations) ? c!.integrations : [];
  } catch { /* an unreadable brief means the core scope only */ }
  return { packageId, required: requiredCapabilities(packageId, features, integrations) };
}

/**
 * Verify and store a reported scorecard. Returns the platform's OWN verification, never the runner's numbers.
 *
 * For a weighted card the viewport claims are additionally checked against the screenshot files the stored snapshot
 * actually holds: this is the one place that has both the card and the bytes, so "the reviewer saw tablet" stops
 * being an assertion and becomes a fact about R2.
 */
export async function recordQuality(db: Db, job: JobLike, outcome: string, raw: unknown, o: { revision?: { attempt: number; cycle: number } | null } = {}): Promise<RecordedQuality> {
  const scope = await scopeOf(db, job);
  const at = nowIso();
  // Improvement proposals are made once per BUILD, at completion, not on every review cycle. The card is now also
  // recorded per cycle (so the Founder can compare revisions), and proposing from each of them would turn
  // builder_improvements.occurrences from "builds that hit this defect" into "cycles that hit it" -- inflating a
  // number the Owner reads when deciding whether a reusable fix is worth engineering time.
  const propose = outcome !== "cycle";

  if (!isScorecardV2(raw)) {
    const v = verifyScorecard(raw, scope);
    await db.prepare(`INSERT INTO build_quality (id, job_id, project_id, attempt, iteration, package_id, outcome, score, applicable, passed, eligible, waiting_external, verified, verification_problems_json, criteria_json, defects_json, created_at, schema_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(newId("bq"), job.id, job.project_id, job.attempts, v.iteration, v.packageId, outcome.slice(0, 40), v.score, v.applicable, v.passed, v.eligible ? 1 : 0, v.waitingExternal ? 1 : 0, v.ok ? 1 : 0,
        JSON.stringify(v.problems.slice(0, 40)), JSON.stringify(v.criteria), JSON.stringify(v.defects), at, SCORECARD_V1_SCHEMA).run();
    if (propose) await proposeImprovements(db, job, v.defects);
    return { version: 1, ...v };
  }

  const proven = o.revision ? await evidencedViewports(db, job.id, o.revision.attempt, o.revision.cycle) : null;
  const v = verifyScorecard2(raw, { ...scope, evidencedViewports: proven });
  const applicable = v.criteria.filter((c) => c.applicable).length;
  const passed = v.criteria.filter((c) => c.applicable && c.status === "pass").length;
  await db.prepare(`INSERT INTO build_quality (id, job_id, project_id, attempt, iteration, package_id, outcome, score, applicable, passed, eligible, waiting_external, verified, verification_problems_json, criteria_json, defects_json, created_at,
        schema_version, build_phase, design_points, functionality_points, other_points, total_points, rubric_json, design_certified, design_blockers_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(newId("bq"), job.id, job.project_id, job.attempts, v.iteration, v.packageId, outcome.slice(0, 40), v.overall, applicable, passed,
      v.eligible ? 1 : 0, v.waitingExternal ? 1 : 0, v.ok ? 1 : 0,
      JSON.stringify(v.problems.slice(0, 40)), JSON.stringify(v.criteria), JSON.stringify(v.defects), at,
      SCORECARD_V2_SCHEMA, v.phase, round1(v.design.points), round1(v.functionality.points), round1(v.other.points), v.totalPoints,
      JSON.stringify({ design: v.design, functionality: v.functionality, other: v.other, visualFailures: v.visualFailures, viewports: v.viewports, review: v.review }),
      v.designCertified ? 1 : 0, JSON.stringify(v.designBlockers.slice(0, 20))).run();
  if (propose) await proposeImprovements(db, job, v.defects);
  return { version: 2, score: v.overall, applicable, passed, ...v };
}

export async function latestQuality(db: Db, jobId: string): Promise<QualityRow | null> {
  return db.prepare(`SELECT * FROM build_quality WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(jobId).first<QualityRow>();
}

/** Every stored card for a job, newest first: the Founder's revision-by-revision comparison reads this. */
export async function qualityHistory(db: Db, jobId: string): Promise<QualityRow[]> {
  return (await db.prepare(`SELECT * FROM build_quality WHERE job_id = ? ORDER BY created_at ASC, rowid ASC`).bind(jobId).all<QualityRow>()).results;
}

/**
 * Internal approval gate. There is no override, and no compensating arithmetic:
 *   schema /1 (legacy): a verified 10/10 within the approved scope;
 *   schema /2:          a verified 100/100 — 40/40 design, 40/40 functionality, 20/20 remaining, each measured.
 */
export async function assertQualityForApproval(db: Db, job: { id: string; quality_required: number }): Promise<void> {
  if (!job.quality_required) return;
  const q = await latestQuality(db, job.id);
  if (!q) throw new HttpError(409, "Quality engine: this build has no quality scorecard, so it cannot be approved internally.");
  if (!q.verified) throw new HttpError(409, `Quality engine: the build's scorecard failed the platform's verification (${(JSON.parse(q.verification_problems_json) as string[]).slice(0, 3).join("; ")}).`);
  if (q.eligible) return;
  if (q.schema_version === SCORECARD_V2_SCHEMA) {
    const blockers = (JSON.parse(q.design_blockers_json) as string[]).slice(0, 3);
    throw new HttpError(409, `Quality engine: this build is at ${q.total_points ?? 0}/100 — visual design ${q.design_points ?? 0}/40, frontend and backend ${q.functionality_points ?? 0}/40, remaining quality ${q.other_points ?? 0}/20. Only a verified 100/100 can be approved internally${blockers.length ? ` (design: ${blockers.join("; ")})` : ""}.`);
  }
  throw new HttpError(409, `Quality engine: the build scored ${q.score}/10; only a verified 10/10 within the approved scope can be approved internally.`);
}

/**
 * Reusable causes (not the website's own code) become builder improvement proposals: root cause, proposed reusable
 * fix, regression test, affected components, risk and evidence. Recurrences are counted on the same proposal. A
 * proposal changes nothing by itself: it waits for a person, and an approved one still goes through code review and
 * the normal deployment gates (the builder is never modified from customer-generated code).
 */
async function proposeImprovements(db: Db, job: JobLike, defects: { criterion: string; class: string; detail: string }[]): Promise<void> {
  const reusable = defects.filter((d) => ["starter", "builder_prompt", "architecture", "integration", "test_coverage", "deployment", "security"].includes(d.class));
  for (const d of reusable.slice(0, 10)) {
    const key = await sha256Hex(`${d.class}|${d.criterion}|${d.detail.replace(/[0-9a-f]{8,}|\d+/gi, "#").slice(0, 160)}`);
    const at = nowIso();
    const evidence = JSON.stringify({ job: job.id, attempt: job.attempts, detail: d.detail });
    const fix = FIX[d.class] ?? FIX.website;
    const r = await db.prepare(`INSERT INTO builder_improvements (id, dedupe_key, defect_class, criterion, root_cause, proposed_fix, regression_test, affected_components, risk, evidence_json, occurrences, first_job_id, last_job_id, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?, 'proposed', ?, ?) ON CONFLICT(dedupe_key) DO UPDATE SET occurrences = occurrences + 1, last_job_id = excluded.last_job_id, evidence_json = excluded.evidence_json, updated_at = excluded.updated_at`)
      .bind(newId("bim"), key, d.class, d.criterion, `Quality criterion "${d.criterion}" failed for a reusable reason (${d.class}): ${d.detail}`.slice(0, 600), fix.fix, fix.test, fix.components, fix.risk, evidence, job.id, job.id, at, at).run();
    if (r.meta?.changes) await audit(db, { actorKind: "system", action: "builds.improvement_proposed", subjectType: "build_job", subjectId: job.id, organizationId: job.organization_id, details: { class: d.class, criterion: d.criterion } });
  }
}

const FIX: Record<string, { fix: string; test: string; components: string; risk: string }> = {
  starter: { fix: "Fix the reusable component in runner/starters/fullstack-v1 so every future website gets the corrected behaviour.", test: "Add a foundation test (tests/foundation) that fails before the fix and run it across the cross-industry fixtures.", components: "runner/starters/fullstack-v1", risk: "Medium: shared by every new build; cross-industry fixtures must stay green." },
  builder_prompt: { fix: "Clarify the builder's phase prompt or STARTER.md so the model produces the required behaviour by default.", test: "Add a runner test asserting the prompt contains the rule, plus a fixture build that previously failed this criterion.", components: "runner/src/prompt.ts, runner/starters/fullstack-v1/STARTER.md", risk: "Low: guidance only." },
  architecture: { fix: "Change the architect's specification rules so the data model / structure covers this case.", test: "Add an orchestrator test with a specification fixture covering the case.", components: "runner/src/orchestrator", risk: "Medium." },
  integration: { fix: "Extend the integration adapter or the trusted operation catalogue (test mode, read-only) for this provider.", test: "Add an adapter test with a signed fake provider response and a broker test.", components: "runner/starters/fullstack-v1/src/lib, runner/src/integrations", risk: "Medium: provider-facing; test mode only." },
  test_coverage: { fix: "Add the missing automated check so this criterion always has evidence (never 'unsupported').", test: "The new check itself, with a failing and a passing fixture.", components: "runner/starters/fullstack-v1/scripts/gates.mjs, runner/src/quality.ts", risk: "Low." },
  deployment: { fix: "Fix the deployment configuration template or the preview deploy path.", test: "Add a gate J case and a preview-gate test.", components: "runner/starters/fullstack-v1/wrangler.jsonc, runner/src/preview-gate.ts", risk: "Medium: staging only; production stays Owner-controlled." },
  security: { fix: "Fix the shared security control (validation, auth, CSRF, rate limit, headers, secrets) in the foundation.", test: "Add a [security] foundation test reproducing the weakness.", components: "runner/starters/fullstack-v1/src/lib", risk: "High until fixed; review by a person required." },
  website: { fix: "Website-specific: repaired in the website itself.", test: "Covered by the website's own tests.", components: "the website", risk: "Low." },
};

/** Owner decision on a proposal (approve = queue it for engineering; it still needs code review and deployment). */
export async function decideImprovement(db: Db, userId: string, id: string, decision: "approved" | "rejected", note: string) {
  const r = await db.prepare(`UPDATE builder_improvements SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ? AND status = 'proposed'`)
    .bind(decision, userId, nowIso(), note.trim().slice(0, 1000) || null, nowIso(), id).run();
  if (!r.meta?.changes) throw new HttpError(409, "This proposal was already decided.");
  await audit(db, { actorUserId: userId, action: `builds.improvement_${decision}`, subjectType: "builder_improvement", subjectId: id, details: { note: note.slice(0, 200) } });
}
