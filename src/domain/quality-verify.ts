// Independent platform verification of a weighted scorecard (schema /2).
//
// The runner computes the card from its own evidence. The platform never takes its word for it, and "independent"
// here means the platform RECOMPUTES rather than re-reads: applicability comes from the package and the customer's
// brief, every item's points are recalculated from the reported per-criterion statuses and the reviewer's own
// numeric rubric, and the category and overall arithmetic are derived here. A runner that simply sends
// `design: { points: 40 }` gets its own number thrown away and replaced by what its evidence supports.
//
// What this file can and cannot see, stated plainly so no one mistakes it for more than it is: it verifies
// structure, applicability, evidence presence and arithmetic. It cannot look at a screenshot. The claim "the
// reviewer saw three viewports" is checked against the snapshot's stored files by the caller
// (services/build-quality.ts), which is the one place that holds both the card and the bytes.

import {
  CATEGORY_MAX, CRITERION_ITEMS, FUNCTIONAL_RUBRIC, OTHER_RUBRIC, REQUIRED_VIEWPORTS, SCORECARD_V2_SCHEMA,
  VISUAL_FAILURES, VISUAL_RUBRIC, BUILD_PHASES, designBlockers, releaseBlockers, round1, scoreItems, scoreVisual, totals,
  type BuildPhase, type CategoryScore, type Viewport, type VisualFailureId, type VisualItemId,
} from "./quality-rubric.ts";
import { QUALITY_CRITERIA, optionalCriteria, type QualityCriterion } from "./quality.ts";

const STATUSES = ["pass", "fail", "pending_external", "unsupported", "not_applicable"] as const;
type Status = (typeof STATUSES)[number];

export interface VerifiedScorecard2 {
  schema: typeof SCORECARD_V2_SCHEMA;
  /** Structurally sound, applicability honest, arithmetic correct. A false `ok` never yields an approvable card. */
  ok: boolean;
  problems: string[];
  iteration: number;
  packageId: string;
  phase: BuildPhase;
  design: CategoryScore;
  functionality: CategoryScore;
  other: CategoryScore;
  totalPoints: number;
  overall: number;
  designCertified: boolean;
  designBlockers: string[];
  visualFailures: { id: VisualFailureId; detail: string; cap: number }[];
  viewports: Viewport[];
  review: { reviewer: string; imagesSeen: number; vision: boolean } | null;
  criteria: { id: QualityCriterion; applicable: boolean; status: Status; evidence: string[]; reason: string | null }[];
  defects: { criterion: string; class: string; detail: string }[];
  eligible: boolean;
  releaseBlockers: string[];
  waitingExternal: boolean;
}

const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function isScorecardV2(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && (raw as { schema?: unknown }).schema === SCORECARD_V2_SCHEMA;
}

export function verifyScorecard2(raw: unknown, ctx: { packageId: string; required: Set<string>; evidencedViewports?: Viewport[] | null }): VerifiedScorecard2 {
  const problems: string[] = [];
  const q = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (q.schema !== SCORECARD_V2_SCHEMA) problems.push("unknown scorecard schema");

  // ── 1. The twenty evidence criteria, with applicability recomputed from the approved scope ──
  const list = Array.isArray(q.criteria) ? q.criteria as Record<string, unknown>[] : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const c of list) {
    const id = String(c?.id ?? "");
    if (!(QUALITY_CRITERIA as readonly string[]).includes(id)) { problems.push(`unknown criterion ${id.slice(0, 40)}`); continue; }
    if (byId.has(id)) problems.push(`duplicate criterion ${id}`);
    byId.set(id, c);
  }
  const optional = optionalCriteria(ctx.required);
  const criteria: VerifiedScorecard2["criteria"] = [];
  for (const id of QUALITY_CRITERIA) {
    const c = byId.get(id);
    if (!c) {
      problems.push(`criterion ${id} is missing`);
      criteria.push({ id, applicable: true, status: "unsupported", evidence: [], reason: "missing from the scorecard" });
      continue;
    }
    let status: Status = (STATUSES as readonly string[]).includes(String(c.status)) ? String(c.status) as Status : "unsupported";
    if (status !== c.status) problems.push(`criterion ${id}: invalid status`);
    let applicable = c.applicable === true;
    if (!applicable && !optional.has(id)) {
      problems.push(`criterion ${id} is required by this website's scope but was reported not applicable`);
      applicable = true; status = "unsupported";
    }
    if (applicable && status === "not_applicable") { problems.push(`criterion ${id}: applicable but marked not_applicable`); status = "unsupported"; }
    const evidence = (Array.isArray(c.evidence) ? c.evidence : []).filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.slice(0, 300)).slice(0, 20);
    // A "pass" is a claim about the website; without named evidence it is the builder's opinion, which is what the
    // whole engine exists to refuse.
    if (applicable && status === "pass" && !evidence.length) { problems.push(`criterion ${id}: "pass" without evidence`); status = "unsupported"; }
    criteria.push({ id, applicable, status: applicable ? status : "not_applicable", evidence, reason: typeof c.reason === "string" ? c.reason.slice(0, 400) : null });
  }
  const statusOf = new Map(criteria.map((c) => [c.id as string, c]));
  const lookup = (id: string) => {
    const c = statusOf.get(id);
    return c ? { applicable: c.applicable, passed: c.status === "pass", pendingExternal: c.status === "pending_external" } : null;
  };

  // ── 2. Review provenance. "vision" is a property of the model the runner used, not something a model may assert ──
  const r = q.review && typeof q.review === "object" ? q.review as Record<string, unknown> : null;
  const imagesSeen = Math.max(0, Math.trunc(num(r?.imagesSeen) ?? 0));
  const review = r && str(r.reviewer, 80)
    ? { reviewer: str(r.reviewer, 80), imagesSeen, vision: r.vision === true }
    : null;
  if (review?.vision && imagesSeen <= 0) problems.push("the review claims vision but received no images");

  // ── 3. Viewports: what the runner reported, intersected with what the stored snapshot can prove ──
  const reported = (Array.isArray(q.viewports) ? q.viewports : []).filter((v): v is Viewport => (REQUIRED_VIEWPORTS as readonly string[]).includes(String(v)));
  let viewports = [...new Set(reported)];
  if (ctx.evidencedViewports) {
    const proven = new Set(ctx.evidencedViewports);
    const unproven = viewports.filter((v) => !proven.has(v));
    if (unproven.length) problems.push(`viewport evidence claimed but not stored in the snapshot: ${unproven.join(", ")}`);
    viewports = viewports.filter((v) => proven.has(v));
  }

  // ── 4. Hard visual failures. The runner's measurements, plus the ones the platform can derive itself ──
  const declared = (Array.isArray(q.visualFailures) ? q.visualFailures : [])
    .map((f) => String((f as { id?: unknown })?.id ?? f))
    .filter((f): f is VisualFailureId => f in VISUAL_FAILURES);
  const failures = new Set<VisualFailureId>(declared);
  // The browser check's own criteria are objective: a failing desktop or mobile criterion IS a hard visual failure,
  // whatever the card says about it. This is the check that would have caught revision 1-3's stacked navigation had
  // the browser check measured it, and it closes the path where a runner simply omits the failure it found.
  for (const id of ["desktop", "mobile"] as const) {
    const c = statusOf.get(id);
    if (c?.applicable && c.status === "fail") failures.add("navigation");
    if (c?.applicable && (c.status === "unsupported")) failures.add("evidence");
  }
  if (!review || !review.vision) failures.add("no_vision");
  for (const v of REQUIRED_VIEWPORTS) if (!viewports.includes(v)) failures.add("evidence");
  const visualFailures = [...failures].map((id) => ({ id, detail: VISUAL_FAILURES[id].detail, cap: VISUAL_FAILURES[id].cap }));

  // ── 5. Recompute every category. The reported points are compared, never trusted ──
  const rubricItems = (Array.isArray((q.design as { items?: unknown })?.items) ? (q.design as { items: unknown[] }).items : [])
    .map((i) => i as Record<string, unknown>)
    .filter((i) => (VISUAL_RUBRIC as readonly { id: string }[]).some((v) => v.id === String(i.id)))
    .map((i) => ({ id: String(i.id) as VisualItemId, points: num(i.points) ?? 0, note: str(i.note, 400) || null }));
  const design = scoreVisual(rubricItems.length ? rubricItems : null, [...failures], {
    reviewer: review?.reviewer ?? null, vision: review?.vision ?? false, imagesSeen, viewports,
  });
  const fn = scoreItems(FUNCTIONAL_RUBRIC, lookup);
  const ot = scoreItems(OTHER_RUBRIC, lookup);
  const functionality = category("functionality", fn, CATEGORY_MAX.functionality);
  const other = category("other", ot, CATEGORY_MAX.other);
  const { totalPoints, overall } = totals(design, functionality, other);

  // Arithmetic the runner reported, against the arithmetic its own evidence supports.
  for (const [name, want, got] of [
    ["design", design.points, num((q.design as { points?: unknown })?.points)],
    ["functionality", functionality.points, num((q.functionality as { points?: unknown })?.points)],
    ["other", other.points, num((q.other as { points?: unknown })?.points)],
    ["total", totalPoints, num(q.totalPoints)],
  ] as const) {
    if (got !== null && Math.abs(got - want) > 0.05) problems.push(`reported ${name} ${got} does not match the evidence (${round1(want)})`);
  }
  const reportedOverall = num(q.overall);
  if (reportedOverall !== null && Math.abs(reportedOverall - overall) > 0.05) problems.push(`reported overall ${reportedOverall} does not match ${overall}`);

  // ── 6. Phase, certification and eligibility ──
  const phase: BuildPhase = (BUILD_PHASES as readonly string[]).includes(String(q.phase)) ? String(q.phase) as BuildPhase : "design";
  if (!(BUILD_PHASES as readonly string[]).includes(String(q.phase))) problems.push(`unknown build phase ${String(q.phase).slice(0, 30)}`);
  const certBlockers = designBlockers({ design, visualFailures: [...failures], viewports, review, revision: str(q.revision, 20) || "pending" });
  const certified = certBlockers.length === 0;
  if (q.designCertified === true && !certified) problems.push(`reported designCertified, but ${certBlockers[0]}`);

  const relBlockers = releaseBlockers({ design, functionality, other, designCertified: certified });
  const eligible = relBlockers.length === 0 && problems.length === 0;
  if (q.eligible === true && !eligible) problems.push("reported eligible, but the categories do not support it");

  const notPassed = criteria.filter((c) => c.applicable && c.status !== "pass");
  const defects = (Array.isArray(q.defects) ? q.defects as Record<string, unknown>[] : []).slice(0, 60).map((d) => ({
    criterion: str(d.criterion, 40), class: str(d.class, 30) || "website", detail: str(d.detail, 400),
  }));

  return {
    schema: SCORECARD_V2_SCHEMA, ok: problems.length === 0, problems: problems.slice(0, 60),
    iteration: Number.isInteger(q.iteration) ? q.iteration as number : 0, packageId: ctx.packageId, phase,
    design, functionality, other, totalPoints, overall,
    designCertified: certified && problems.length === 0, designBlockers: certBlockers.slice(0, 30),
    visualFailures, viewports, review, criteria, defects,
    eligible, releaseBlockers: relBlockers.slice(0, 30),
    waitingExternal: notPassed.length > 0 && notPassed.every((c) => c.status === "pending_external"),
  };
}

/** Wrap a recomputed item set as a category, classifying WHY it is short rather than calling everything a failure. */
function category(id: "functionality" | "other", r: ReturnType<typeof scoreItems>, max: number): CategoryScore {
  const live = r.items.filter((i) => i.applicable);
  const state: CategoryScore["state"] = r.missing.length ? "insufficient_evidence"
    : live.length === 0 ? "insufficient_evidence"
    : r.pendingExternal && r.points < max ? "blocked_external"
    : "scored";
  const reason = r.missing.length ? `criteria missing from the scorecard: ${r.missing.slice(0, 6).join(", ")}`
    : live.length === 0 ? "no applicable criterion, so this category has no evidence"
    : state === "blocked_external" ? "waiting for a provider-side verification that needs the customer's own account"
    : null;
  return { points: r.points, max, items: r.items, state, reason: reason && `${id}: ${reason}` };
}
