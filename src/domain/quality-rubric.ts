// The weighted quality rubric and the phase machine: ONE authoritative definition of how a website is scored.
//
// WHY THIS REPLACES THE FLAT SCORECARD. Build bld_50e28bbd1cd033ad9ddfad02 revision 1-3 was certified 9.4/10 because
// 18 of 19 applicable criteria passed. Measured afterwards on the stored snapshot: `.site-nav ul { flex-direction:
// column }` at site.css:109 sits outside any media query and the `min-width: 64rem` block never resets it, so the
// primary desktop navigation renders as a vertical stack; and the page carries ZERO images against a brief whose
// images_source is "licensed". Both are defects a paying customer sees first. Neither could move the score by more
// than 1/19 ≈ 0.5, and `visual_design` was one binary PASS covering the whole visual product.
//
// So visual design is no longer one of twenty equal checks. It is 40 of 100 points, scored item by item from
// evidence, and a severe visual defect caps it however good everything else looks.
//
// THE ARITHMETIC. TotalPoints = DesignPoints(40) + FunctionalityPoints(40) + OtherPoints(20); OverallScore =
// TotalPoints / 10. The overall figure is informational: it is NOT what decides rollback, phase advancement or
// loop termination (see PRIMARY_PROGRESS and the phase-aware ratchet). A build that improves its design from 20/40
// to 30/40 while backend functionality temporarily falls from 30/40 to 5/40 has made progress in its active phase
// even though the total dropped from 7.0 to 5.5.
//
// THE RUNNER HAS A MIRROR OF THIS FILE (runner/src/quality.ts: VISUAL_RUBRIC, FUNCTIONAL_RUBRIC, OTHER_RUBRIC,
// CRITERION_ITEMS). runner/test/quality-weighted.test.ts imports both and fails if they diverge, which is how the
// platform's independent verification and the runner's computation stay the same arithmetic rather than two
// notions of quality that drift apart.

// ── Categories ────────────────────────────────────────────────────────────────────────────────────────────────────

export const CATEGORY_MAX = Object.freeze({ design: 40, functionality: 40, other: 20 });
export type CategoryId = keyof typeof CATEGORY_MAX;
export const TOTAL_MAX = 100;

/**
 * Category A — Visual Design, 40 points. Scored ONLY from an independent vision-capable reviewer's numeric judgement
 * of real browser screenshots. There is no deterministic substitute: a rule can prove a page overflows, it cannot
 * prove a page looks professional. A missing or text-only reviewer therefore yields 0 and a `blocked` state, never
 * a default pass (directive §11 "No-vision handling").
 */
export const VISUAL_RUBRIC = Object.freeze([
  { id: "layout", max: 8, label: "Layout composition, spacing, hierarchy and alignment" },
  { id: "typography", max: 6, label: "Typography, visual branding and colour harmony" },
  { id: "imagery", max: 6, label: "Imagery, media selection, relevance and presentation" },
  { id: "components", max: 7, label: "Component polish, interaction states and visual consistency" },
  { id: "responsive", max: 6, label: "Responsive visual quality across desktop, tablet and mobile" },
  { id: "industry", max: 7, label: "Industry appropriateness, distinctiveness and premium presentation" },
] as const);
export type VisualItemId = (typeof VISUAL_RUBRIC)[number]["id"];

/** Category B — Frontend and Backend Functionality, 40 points. Earned from the acceptance criteria's evidence. */
export const FUNCTIONAL_RUBRIC = Object.freeze([
  { id: "frontend", max: 10, label: "Frontend controls, navigation, forms and interactions" },
  { id: "backend", max: 10, label: "Backend APIs, validation and business logic" },
  { id: "data", max: 8, label: "Database persistence, permissions and authenticated functionality" },
  { id: "journeys", max: 8, label: "Complete tested end-to-end customer and administrative journeys" },
  { id: "integrations", max: 4, label: "External service integration correctness" },
] as const);
export type FunctionalItemId = (typeof FUNCTIONAL_RUBRIC)[number]["id"];

/** Category C — Remaining Website Quality, 20 points. */
export const OTHER_RUBRIC = Object.freeze([
  { id: "security", max: 6, label: "Security and privacy" },
  { id: "accessibility", max: 4, label: "Accessibility" },
  { id: "performance", max: 4, label: "Performance" },
  { id: "seo", max: 2, label: "SEO and search presentation" },
  { id: "reliability", max: 2, label: "Reliability and error handling" },
  { id: "deployment", max: 2, label: "Deployment readiness and maintainability" },
] as const);
export type OtherItemId = (typeof OTHER_RUBRIC)[number]["id"];

export type RubricItemId = VisualItemId | FunctionalItemId | OtherItemId;

/**
 * Which of the twenty evidence criteria feed each functionality/other item. The criteria themselves do not go away:
 * they are the evidence engine (acceptance gates, browser checks, credential scan, persistence check), and the
 * rubric is the weighting layer over them. A criterion the approved scope does not include leaves its item's
 * denominator; if every criterion of an item is out of scope the item's points are redistributed WITHIN its own
 * category, never across categories, so a Starter website cannot earn Premium points for features it never had.
 */
export const CRITERION_ITEMS: Readonly<Record<FunctionalItemId | OtherItemId, readonly string[]>> = Object.freeze({
  frontend: ["frontend"],
  backend: ["backend"],
  data: ["database", "auth"],
  journeys: ["workflows", "requirements", "customer_experience"],
  integrations: ["integrations", "payments"],
  security: ["security"],
  accessibility: ["accessibility"],
  performance: ["performance"],
  seo: ["seo"],
  reliability: ["error_handling"],
  deployment: ["deployment", "maintainability"],
});

/**
 * Criteria that are evidence for the DESIGN category rather than for functionality: they cap the reviewer's visual
 * score instead of adding points of their own. `visual_design` and `brand_consistency` are the reviewer's own
 * binary verdicts (superseded by its numeric rubric); `desktop` and `mobile` are the browser check's objective
 * measurement of the rendered page, and a failure there is a hard visual failure below.
 */
export const DESIGN_EVIDENCE_CRITERIA = Object.freeze(["visual_design", "brand_consistency", "desktop", "mobile"]);

// ── Hard visual failures ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Objectively measurable visual defects. Each one CAPS the design category, so "39/40 with broken primary
 * navigation" is arithmetically impossible however polished the rest is (directive §2 "Hard visual failure
 * conditions"). The cap is the ceiling for the whole category, not a subtraction, which is the difference between
 * "one item lost a point" and "this website is not finished".
 *
 * These are detected, not judged: a rule can see that a nav list is stacked at 1440px, that content is wider than
 * the viewport, that a page applied no stylesheet, or that an approved design requiring imagery shipped none.
 */
export const VISUAL_FAILURES = Object.freeze({
  /** The browser check could not load a page, or the page applied no stylesheet at all. */
  unstyled: { cap: 0, detail: "a page rendered unstyled or failed to load" },
  /** Primary navigation is broken at a viewport the customer uses. */
  navigation: { cap: 12, detail: "primary navigation is broken or stacked where it should be horizontal" },
  /** Components overlap, or content is clipped. */
  overlap: { cap: 14, detail: "components overlap or content is clipped" },
  /** Content is wider than the viewport, so the page scrolls sideways. */
  overflow: { cap: 18, detail: "the page scrolls horizontally at a required viewport" },
  /** The approved design requires imagery and the website has none. */
  imagery: { cap: 24, detail: "the approved design requires imagery and the website has none" },
  /** Placeholder copy or media presented as final. */
  placeholder: { cap: 20, detail: "placeholder content or media is presented as final" },
  /** A required viewport has no screenshot evidence at all. */
  evidence: { cap: 0, detail: "a required viewport has no screenshot evidence" },
  /** The reviewer could not actually see the rendered website. */
  no_vision: { cap: 0, detail: "no vision-capable reviewer inspected the rendered website" },
} as const);
export type VisualFailureId = keyof typeof VISUAL_FAILURES;

/** Viewports the design must be evidenced at. Tablet is new: the old engine only ever required desktop and mobile. */
export const REQUIRED_VIEWPORTS = Object.freeze(["desktop", "tablet", "mobile"] as const);
export type Viewport = (typeof REQUIRED_VIEWPORTS)[number];

// ── Phases ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The build's phase. Persisted (build_jobs.build_phase), never held only in memory: a runner restart, a container
 * replacement, a checkpoint restore or a resumed multi-segment build must all come back to the same phase and the
 * same frozen design, which an in-memory variable cannot survive.
 */
export const BUILD_PHASES = Object.freeze(["design", "design_locked", "functionality", "final_qa", "waiting", "complete"] as const);
export type BuildPhase = (typeof BUILD_PHASES)[number];

export const PHASE_LABEL: Readonly<Record<BuildPhase, string>> = Object.freeze({
  design: "Design", design_locked: "Design locked", functionality: "Functionality",
  final_qa: "Final QA", waiting: "Waiting", complete: "Complete",
});

/**
 * The category whose score IS the progress signal in each phase. Everything else may move in either direction
 * without the loop treating it as failure or success — subject to the invariants in `phaseBlockers` below.
 */
export const PRIMARY_PROGRESS: Readonly<Record<BuildPhase, CategoryId | null>> = Object.freeze({
  design: "design", design_locked: "design", functionality: "functionality",
  final_qa: "other", waiting: null, complete: null,
});

export interface CategoryScore {
  points: number;
  max: number;
  items: { id: RubricItemId; points: number; max: number; applicable: boolean; note: string | null }[];
  /** `scored` = measured from evidence; the rest are deliberately NOT zero-with-a-shrug (directive §3). */
  state: "scored" | "awaiting" | "insufficient_evidence" | "blocked_external" | "blocked";
  /** Why the category is not `scored`, or why points were capped. */
  reason: string | null;
}

export interface Scorecard2 {
  schema: typeof SCORECARD_V2_SCHEMA;
  packageId: string;
  iteration: number;
  phase: BuildPhase;
  design: CategoryScore;
  functionality: CategoryScore;
  other: CategoryScore;
  totalPoints: number;
  /** totalPoints / 10, for display only. */
  overall: number;
  /** Hard visual failures measured this cycle, each with the cap it imposed. */
  visualFailures: { id: VisualFailureId; detail: string; cap: number }[];
  /** Viewports with real screenshot evidence this cycle. */
  viewports: Viewport[];
  /** The reviewer that produced the visual rubric, and whether it actually saw images. */
  review: { reviewer: string; imagesSeen: number; vision: boolean } | null;
  /** Per-criterion evidence, unchanged in meaning from schema /1 so history stays comparable. */
  criteria: { id: string; applicable: boolean; status: string; evidence: string[]; reason: string | null }[];
  defects: { criterion: string; class: string; detail: string }[];
  /** Design is certified: 40/40, every item at max, all three viewports evidenced, a vision reviewer, no hard failure. */
  designCertified: boolean;
  /** 100/100 with every category `scored`: the only state that may enter internal approval. */
  eligible: boolean;
  waitingExternal: boolean;
  computedAt: string;
}

export const SCORECARD_V2_SCHEMA = "crestmont.quality-scorecard/2";
export const SCORECARD_V1_SCHEMA = "crestmont.quality-scorecard/1";

// ── Arithmetic ────────────────────────────────────────────────────────────────────────────────────────────────────

/** One decimal, rounded DOWN: a category never rounds its way up to a threshold it did not reach. */
export const round1 = (n: number) => Math.floor(n * 10 + 1e-9) / 10;

/**
 * Round a set of values to one decimal so that they still SUM to the rounded total (largest remainder first).
 *
 * This is not cosmetic. When an item's points are redistributed because its criteria are out of scope, the scaled
 * maxima stop being whole numbers: a Starter website with no payments gives 10 → 11.111, 8 → 8.888. Rounding each
 * one down independently produced 11.1 + 11.1 + 8.8 + 8.8 = 39.8, so a Starter site that passed EVERYTHING scored
 * 39.8/40 functionality and could never reach the 100/100 that internal approval requires. The 0.2 had to go
 * somewhere, and silently withholding it from the customer whose package happens to exclude a feature is the one
 * place it must not go.
 */
export function apportion(values: number[]): { parts: number[]; total: number } {
  const total = round1(values.reduce((s, v) => s + v, 0));
  const parts = values.map((v) => round1(v));
  let tenths = Math.round((total - parts.reduce((s, p) => s + p, 0)) * 10);
  if (tenths <= 0 || !parts.length) return { parts, total };
  // Largest fractional remainder first, so the tenths land where the most was lost.
  const order = values.map((v, i) => ({ i, rem: v * 10 - Math.floor(v * 10 + 1e-9) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; tenths > 0; k++, tenths--) parts[order[k % order.length].i] = round1(parts[order[k % order.length].i] + 0.1);
  return { parts, total };
}

/**
 * Points for an evidence-driven category. Each item scores max × (passed / applicable) over the criteria mapped to
 * it; an item with no applicable criterion is dropped and its maximum is shared out over the items that remain,
 * in proportion to their own maxima, so the category's total stays exactly its maximum.
 */
export function scoreItems(
  rubric: readonly { id: RubricItemId; max: number; label: string }[],
  criterionStatus: (id: string) => { applicable: boolean; passed: boolean; pendingExternal: boolean } | null,
): { items: CategoryScore["items"]; points: number; pendingExternal: boolean; missing: string[] } {
  const live: { id: RubricItemId; max: number; fraction: number; note: string | null }[] = [];
  const dropped: { id: RubricItemId; max: number }[] = [];
  const missing: string[] = [];
  let pendingExternal = false;

  for (const item of rubric) {
    const ids = CRITERION_ITEMS[item.id as FunctionalItemId | OtherItemId] ?? [];
    let applicable = 0, passed = 0;
    const notes: string[] = [];
    for (const id of ids) {
      const st = criterionStatus(id);
      if (!st) { missing.push(id); continue; }
      if (!st.applicable) continue;
      applicable++;
      if (st.passed) passed++;
      else { notes.push(id); if (st.pendingExternal) pendingExternal = true; }
    }
    if (applicable === 0) dropped.push({ id: item.id, max: item.max });
    else live.push({ id: item.id, max: item.max, fraction: passed / applicable, note: notes.length ? `not passed: ${notes.join(", ")}` : null });
  }

  const liveMax = live.reduce((s, i) => s + i.max, 0);
  const droppedMax = dropped.reduce((s, i) => s + i.max, 0);
  // Redistribution within the category only. With no live item at all there is nothing to redistribute onto, so the
  // category scores 0 rather than silently awarding its full maximum for an empty rubric.
  const scale = liveMax > 0 ? (liveMax + droppedMax) / liveMax : 0;

  // Apportioned, not rounded item by item: the displayed items must add up to the category's own total, or a
  // website whose package excludes a feature could never reach its maximum (see `apportion`).
  const maxima = apportion(live.map((i) => i.max * scale));
  const scored = apportion(live.map((i) => i.max * scale * i.fraction));
  const items: CategoryScore["items"] = [
    ...live.map((i, n) => ({ id: i.id, points: scored.parts[n], max: maxima.parts[n], applicable: true, note: i.note })),
    ...dropped.map((i) => ({ id: i.id, points: 0, max: 0, applicable: false, note: "not in this website's approved scope" })),
  ];
  return { items, points: scored.total, pendingExternal, missing };
}

/**
 * Points for the visual category from the reviewer's numeric rubric, with the hard-failure caps applied.
 * `caps` is the set of measured failures; the lowest cap among them is the ceiling.
 */
export function scoreVisual(
  rubric: { id: VisualItemId; points: number; note?: string | null }[] | null,
  failures: VisualFailureId[],
  o: { reviewer: string | null; vision: boolean; imagesSeen: number; viewports: Viewport[] },
): CategoryScore {
  const max = CATEGORY_MAX.design;
  const blank = (state: CategoryScore["state"], reason: string): CategoryScore => ({
    points: 0, max, state, reason,
    items: VISUAL_RUBRIC.map((i) => ({ id: i.id, points: 0, max: i.max, applicable: true, note: null })),
  });
  if (!o.reviewer || !o.vision) return blank("blocked", "no vision-capable reviewer inspected the rendered website, so the visual design cannot be certified");
  if (o.imagesSeen <= 0) return blank("insufficient_evidence", "the reviewer received no screenshots, so its visual judgement has no basis");
  if (!rubric || rubric.length === 0) return blank("insufficient_evidence", "the reviewer returned no numeric visual rubric");

  const given = new Map(rubric.map((r) => [r.id, r]));
  const items = VISUAL_RUBRIC.map((i) => {
    const r = given.get(i.id);
    const raw = r && Number.isFinite(r.points) ? Math.max(0, Math.min(i.max, r.points)) : 0;
    return { id: i.id, points: round1(raw), max: i.max, applicable: true, note: r?.note ?? (r ? null : "the reviewer did not score this item") };
  });
  const scored = round1(items.reduce((s, i) => s + i.points, 0));

  const caps = failures.map((f) => ({ id: f, ...VISUAL_FAILURES[f] }));
  const ceiling = caps.length ? Math.min(...caps.map((c) => c.cap)) : max;
  const points = Math.min(scored, ceiling);
  const missingViewports = REQUIRED_VIEWPORTS.filter((v) => !o.viewports.includes(v));

  return {
    points: round1(points), max, items,
    state: caps.length && ceiling === 0 ? "insufficient_evidence" : "scored",
    reason: caps.length
      ? `capped at ${ceiling}/${max}: ${caps.map((c) => c.detail).join("; ")}`
      : missingViewports.length ? `no evidence at ${missingViewports.join(", ")}` : null,
  };
}

/** The whole-card arithmetic, in one place, so the platform and the runner cannot disagree about it. */
export function totals(design: CategoryScore, functionality: CategoryScore, other: CategoryScore) {
  const totalPoints = round1(design.points + functionality.points + other.points);
  return { totalPoints, overall: round1(totalPoints / 10) };
}

// ── Certification and phase gates ─────────────────────────────────────────────────────────────────────────────────

export interface DesignCertificationInput {
  design: CategoryScore;
  visualFailures: VisualFailureId[];
  viewports: Viewport[];
  review: { reviewer: string; imagesSeen: number; vision: boolean } | null;
  /** The stored revision this certification belongs to ("<attempt>-<cycle>"), so the freeze names a real snapshot. */
  revision: string | null;
}

/**
 * Why the design is NOT certified, as a list. Empty = certified. A model saying "looks perfect" is not evidence and
 * cannot appear here: every condition is a fact about the measured card, the screenshot set or the reviewer.
 */
export function designBlockers(i: DesignCertificationInput): string[] {
  const out: string[] = [];
  if (!i.review || !i.review.vision) out.push("no vision-capable reviewer inspected the rendered website");
  else if (i.review.imagesSeen <= 0) out.push("the reviewer received no screenshots");
  for (const v of REQUIRED_VIEWPORTS) if (!i.viewports.includes(v)) out.push(`no ${v} screenshot evidence`);
  for (const f of i.visualFailures) out.push(VISUAL_FAILURES[f].detail);
  if (i.design.state !== "scored") out.push(i.design.reason ?? `the visual category is ${i.design.state}`);
  if (i.design.points < CATEGORY_MAX.design) out.push(`visual design is ${round1(i.design.points)}/${CATEGORY_MAX.design}`);
  for (const item of i.design.items) {
    if (item.applicable && item.points < item.max) {
      out.push(`${VISUAL_RUBRIC.find((r) => r.id === item.id)?.label ?? item.id}: ${round1(item.points)}/${item.max}`);
    }
  }
  if (!i.revision) out.push("no stored revision is identified for this design");
  return [...new Set(out)];
}

export const designCertified = (i: DesignCertificationInput) => designBlockers(i).length === 0;

export interface PhaseStateInput {
  phase: BuildPhase;
  design: CategoryScore;
  functionality: CategoryScore;
  other: CategoryScore;
  designCertified: boolean;
  /** A persisted, platform-verified design freeze exists for this build. */
  designFrozen: boolean;
  /** Critical security / data-integrity / budget / lease problems: non-deferrable in every phase. */
  safetyBlockers: string[];
}

/**
 * Why the build may NOT leave its current phase. Empty = the gate is open.
 *
 * Note what is deliberately absent: the overall score. A phase advances on its own category plus the invariants of
 * the categories already certified, never on the total.
 */
export function phaseBlockers(i: PhaseStateInput): string[] {
  if (i.safetyBlockers.length) return i.safetyBlockers.map((s) => `safety: ${s}`);
  switch (i.phase) {
    case "design":
      return i.designCertified ? [] : ["the visual design is not certified at 40/40"];
    case "design_locked":
      return i.designFrozen ? [] : ["the approved design has not been frozen and verified by the platform"];
    case "functionality": {
      const out: string[] = [];
      if (!i.designCertified) out.push("the frozen design no longer passes: repair the visual regression before certifying functionality");
      if (i.functionality.state !== "scored") out.push(i.functionality.reason ?? `functionality is ${i.functionality.state}`);
      if (i.functionality.points < CATEGORY_MAX.functionality) out.push(`functionality is ${round1(i.functionality.points)}/${CATEGORY_MAX.functionality}`);
      return out;
    }
    case "final_qa": {
      const out: string[] = [];
      if (!i.designCertified) out.push("the frozen design no longer passes");
      if (i.functionality.points < CATEGORY_MAX.functionality) out.push(`functionality is ${round1(i.functionality.points)}/${CATEGORY_MAX.functionality}`);
      if (i.other.state !== "scored") out.push(i.other.reason ?? `remaining quality is ${i.other.state}`);
      if (i.other.points < CATEGORY_MAX.other) out.push(`remaining quality is ${round1(i.other.points)}/${CATEGORY_MAX.other}`);
      return out;
    }
    case "waiting":
      return ["waiting for information or an external party"];
    case "complete":
      return [];
  }
}

/** The phase a build in `phase` moves to when its gate is open. */
export const NEXT_PHASE: Readonly<Record<BuildPhase, BuildPhase | null>> = Object.freeze({
  design: "design_locked", design_locked: "functionality", functionality: "final_qa",
  final_qa: "complete", waiting: null, complete: null,
});

/**
 * Final release eligibility: 40 + 40 + 20 with every category actually measured. No compensating scores — 35/40
 * design with a high total does not pass, and neither does 40/40 design with incomplete backend work.
 */
export function releaseBlockers(c: { design: CategoryScore; functionality: CategoryScore; other: CategoryScore; designCertified: boolean }): string[] {
  const out: string[] = [];
  if (!c.designCertified) out.push("visual design is not certified at 40/40");
  for (const [id, cat] of [["functionality", c.functionality], ["other", c.other]] as const) {
    if (cat.state !== "scored") out.push(`${id}: ${cat.reason ?? cat.state}`);
    if (cat.points < CATEGORY_MAX[id]) out.push(`${id} is ${round1(cat.points)}/${CATEGORY_MAX[id]}`);
  }
  return out;
}
