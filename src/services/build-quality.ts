// Quality engine persistence and gates (platform). Scorecards are stored for every reported build iteration;
// internal approval of a quality-required build needs the latest scorecard to be verified AND eligible (10/10);
// reusable causes become builder improvement proposals that change nothing without a person's approval.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { HttpError } from "../app/http.ts";
import { audit } from "./security.ts";
import { verifyScorecard, requiredCapabilities, type VerifiedScorecard } from "../domain/quality.ts";

export interface QualityRow {
  id: string; job_id: string; attempt: number; iteration: number; package_id: string; outcome: string; score: number; applicable: number; passed: number;
  eligible: number; waiting_external: number; verified: number; verification_problems_json: string; criteria_json: string; defects_json: string; created_at: string;
}

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

/** Verify and store a reported scorecard. Returns the platform's verification. */
export async function recordQuality(db: Db, job: JobLike, outcome: string, raw: unknown): Promise<VerifiedScorecard> {
  const v = verifyScorecard(raw, await scopeOf(db, job));
  await db.prepare(`INSERT INTO build_quality (id, job_id, project_id, attempt, iteration, package_id, outcome, score, applicable, passed, eligible, waiting_external, verified, verification_problems_json, criteria_json, defects_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(newId("bq"), job.id, job.project_id, job.attempts, v.iteration, v.packageId, outcome.slice(0, 40), v.score, v.applicable, v.passed, v.eligible ? 1 : 0, v.waitingExternal ? 1 : 0, v.ok ? 1 : 0,
      JSON.stringify(v.problems.slice(0, 40)), JSON.stringify(v.criteria), JSON.stringify(v.defects), nowIso()).run();
  await proposeImprovements(db, job, v);
  return v;
}

export async function latestQuality(db: Db, jobId: string): Promise<QualityRow | null> {
  return db.prepare(`SELECT * FROM build_quality WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(jobId).first<QualityRow>();
}

/** Internal approval gate: a quality-required build needs a verified 10/10. There is no override. */
export async function assertQualityForApproval(db: Db, job: { id: string; quality_required: number }): Promise<void> {
  if (!job.quality_required) return;
  const q = await latestQuality(db, job.id);
  if (!q) throw new HttpError(409, "Quality engine: this build has no quality scorecard, so it cannot be approved internally.");
  if (!q.verified) throw new HttpError(409, `Quality engine: the build's scorecard failed the platform's verification (${(JSON.parse(q.verification_problems_json) as string[]).slice(0, 3).join("; ")}).`);
  if (!q.eligible) throw new HttpError(409, `Quality engine: the build scored ${q.score}/10; only a verified 10/10 within the approved scope can be approved internally.`);
}

/**
 * Reusable causes (not the website's own code) become builder improvement proposals: root cause, proposed reusable
 * fix, regression test, affected components, risk and evidence. Recurrences are counted on the same proposal. A
 * proposal changes nothing by itself: it waits for a person, and an approved one still goes through code review and
 * the normal deployment gates (the builder is never modified from customer-generated code).
 */
async function proposeImprovements(db: Db, job: JobLike, v: VerifiedScorecard): Promise<void> {
  const reusable = v.defects.filter((d) => ["starter", "builder_prompt", "architecture", "integration", "test_coverage", "deployment", "security"].includes(d.class));
  for (const d of reusable.slice(0, 10)) {
    const key = await sha256Hex(`${d.class}|${d.criterion}|${d.detail.replace(/[0-9a-f]{8,}|\d+/gi, "#").slice(0, 160)}`);
    const at = nowIso();
    const evidence = JSON.stringify({ job: job.id, attempt: job.attempts, iteration: v.iteration, score: v.score, detail: d.detail });
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
