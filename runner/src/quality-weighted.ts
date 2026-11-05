// The weighted quality scorecard (schema /2), runner side: Visual Design 40 + Functionality 40 + Remaining 20.
//
// WHY. bld_50e28bbd1cd033ad9ddfad02 revision 1-3 was certified 9.4/10 with a vertically stacked desktop navigation
// and no images at all, because `visual_design` was one binary PASS among twenty near-equal criteria and could cost
// at most 1/19 of the score. A customer buys the look and the working website; those two now carry 80 of 100 points,
// the visual half is scored item by item from a vision reviewer's numbers, and a measured visual defect caps the
// category rather than nudging it.
//
// WHAT THIS FILE IS NOT. It does not judge anything. The twenty criteria (quality.ts) remain the evidence engine and
// are read here, not re-decided; the visual rubric comes from the independent reviewer; the hard visual failures come
// from the browser check's measurements. This file weights and caps, and that is all, which is why the platform can
// recompute exactly the same numbers from the same reported evidence (src/domain/quality-verify.ts).
//
// THE RUBRIC CONSTANTS BELOW MIRROR src/domain/quality-rubric.ts. runner/test/quality-weighted.test.ts imports both
// and fails if they diverge: the runner ships as a Docker image containing only runner/, so it cannot import the
// platform module, and a silent divergence would give the build and the platform two different notions of quality.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Criterion, CriterionId, Scorecard } from "./quality.ts";

// ── Rubric (mirror of src/domain/quality-rubric.ts) ───────────────────────────────────────────────────────────────

export const CATEGORY_MAX = Object.freeze({ design: 40, functionality: 40, other: 20 });
export const TOTAL_MAX = 100;

export const VISUAL_RUBRIC = Object.freeze([
  { id: "layout", max: 8, label: "Layout composition, spacing, hierarchy and alignment" },
  { id: "typography", max: 6, label: "Typography, visual branding and colour harmony" },
  { id: "imagery", max: 6, label: "Imagery, media selection, relevance and presentation" },
  { id: "components", max: 7, label: "Component polish, interaction states and visual consistency" },
  { id: "responsive", max: 6, label: "Responsive visual quality across desktop, tablet and mobile" },
  { id: "industry", max: 7, label: "Industry appropriateness, distinctiveness and premium presentation" },
] as const);
export type VisualItemId = (typeof VISUAL_RUBRIC)[number]["id"];

export const FUNCTIONAL_RUBRIC = Object.freeze([
  { id: "frontend", max: 10, label: "Frontend controls, navigation, forms and interactions" },
  { id: "backend", max: 10, label: "Backend APIs, validation and business logic" },
  { id: "data", max: 8, label: "Database persistence, permissions and authenticated functionality" },
  { id: "journeys", max: 8, label: "Complete tested end-to-end customer and administrative journeys" },
  { id: "integrations", max: 4, label: "External service integration correctness" },
] as const);

export const OTHER_RUBRIC = Object.freeze([
  { id: "security", max: 6, label: "Security and privacy" },
  { id: "accessibility", max: 4, label: "Accessibility" },
  { id: "performance", max: 4, label: "Performance" },
  { id: "seo", max: 2, label: "SEO and search presentation" },
  { id: "reliability", max: 2, label: "Reliability and error handling" },
  { id: "deployment", max: 2, label: "Deployment readiness and maintainability" },
] as const);

export const CRITERION_ITEMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
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

export const DESIGN_EVIDENCE_CRITERIA = Object.freeze(["visual_design", "brand_consistency", "desktop", "mobile"]);

export const VISUAL_FAILURES = Object.freeze({
  unstyled: { cap: 0, detail: "a page rendered unstyled or failed to load" },
  navigation: { cap: 12, detail: "primary navigation is broken or stacked where it should be horizontal" },
  overlap: { cap: 14, detail: "components overlap or content is clipped" },
  overflow: { cap: 18, detail: "the page scrolls horizontally at a required viewport" },
  imagery: { cap: 24, detail: "the approved design requires imagery and the website has none" },
  placeholder: { cap: 20, detail: "placeholder content or media is presented as final" },
  evidence: { cap: 0, detail: "a required viewport has no screenshot evidence" },
  no_vision: { cap: 0, detail: "no vision-capable reviewer inspected the rendered website" },
} as const);
export type VisualFailureId = keyof typeof VISUAL_FAILURES;

export const REQUIRED_VIEWPORTS = Object.freeze(["desktop", "tablet", "mobile"] as const);
export type Viewport = (typeof REQUIRED_VIEWPORTS)[number];

export const BUILD_PHASES = Object.freeze(["design", "design_locked", "functionality", "final_qa", "waiting", "complete"] as const);
export type BuildPhase = (typeof BUILD_PHASES)[number];

export const PRIMARY_PROGRESS: Readonly<Record<BuildPhase, "design" | "functionality" | "other" | null>> = Object.freeze({
  design: "design", design_locked: "design", functionality: "functionality",
  final_qa: "other", waiting: null, complete: null,
});

export const SCORECARD_V2_SCHEMA = "crestmont.quality-scorecard/2";

// ── Types ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CategoryScore {
  points: number;
  max: number;
  items: { id: string; points: number; max: number; applicable: boolean; note: string | null }[];
  state: "scored" | "awaiting" | "insufficient_evidence" | "blocked_external" | "blocked";
  reason: string | null;
}

export interface Scorecard2 {
  schema: typeof SCORECARD_V2_SCHEMA;
  packageId: string;
  iteration: number;
  phase: BuildPhase;
  /** "<attempt>-<cycle>" of the stored snapshot this card measures, so a design freeze can name a real revision. */
  revision: string | null;
  design: CategoryScore;
  functionality: CategoryScore;
  other: CategoryScore;
  totalPoints: number;
  overall: number;
  visualFailures: { id: VisualFailureId; detail: string; cap: number }[];
  viewports: Viewport[];
  review: { reviewer: string; imagesSeen: number; vision: boolean } | null;
  criteria: { id: CriterionId; applicable: boolean; status: string; evidence: string[]; reason: string | null }[];
  defects: { criterion: string; class: string; detail: string }[];
  designCertified: boolean;
  designBlockers: string[];
  eligible: boolean;
  releaseBlockers: string[];
  waitingExternal: boolean;
  computedAt: string;
}

/** One page/viewport row of browser-check.mjs --visual-out. */
export interface VisualMeasurement {
  page: string;
  viewport: string;
  images: number;
  /** Raster imagery: <img>, <picture source>, CSS background-image, excluding icon-sized decoration. */
  contentImages: number;
  /**
   * Authored vector artwork over 48px (inline <svg>), counted separately from raster imagery. Absent on
   * measurements written before browser-check.mjs reported it.
   */
  vectorArt?: number;
  /**
   * Visible RASTER images with real intrinsic pixels: the only thing that can be a photograph (V5 §7). Optional
   * because measurements recorded before this existed have none, and absent must mean "not measured" rather than
   * "zero" -- a legacy measurement must not be read as proof that a build shipped without photographs.
   */
  photoImages?: number;
  clipped: number;
  overlaps: number;
  placeholders: number;
  styleSheets: number;
  defaultFont: boolean;
  headings: number;
  nav?: { hasNav: boolean; visibleLinks: number; toggleVisible: boolean; stacked: boolean; navDirection: string | null } | null;
}

export interface VisualMeasurementsFile {
  schema: "crestmont.visual-measurements/1";
  viewports: string[];
  pages: string[];
  measurements: VisualMeasurement[];
}

/** The reviewer's numeric visual judgement (part of its JSON answer; see orchestrator/contracts.ts). */
export interface VisualRubricVerdict {
  id: VisualItemId;
  points: number;
  note?: string | null;
  deficiencies?: string[];
}

export const round1 = (n: number) => Math.floor(n * 10 + 1e-9) / 10;

/**
 * Round a set of values to one decimal so that they still SUM to the rounded total (largest remainder first).
 *
 * This is not cosmetic. When an item's points are redistributed because its criteria are out of scope, the scaled
 * maxima stop being whole numbers: a Starter website with no payments gives 10 -> 11.111, 8 -> 8.888. Rounding each
 * one down independently produced 11.1 + 11.1 + 8.8 + 8.8 = 39.8, so a Starter site that passed EVERYTHING scored
 * 39.8/40 functionality and could never reach the 100/100 internal approval requires.
 */
export function apportion(values: number[]): { parts: number[]; total: number } {
  const total = round1(values.reduce((s, v) => s + v, 0));
  const parts = values.map((v) => round1(v));
  let tenths = Math.round((total - parts.reduce((s, p) => s + p, 0)) * 10);
  if (tenths <= 0 || !parts.length) return { parts, total };
  const order = values.map((v, i) => ({ i, rem: v * 10 - Math.floor(v * 10 + 1e-9) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; tenths > 0; k++, tenths--) parts[order[k % order.length].i] = round1(parts[order[k % order.length].i] + 0.1);
  return { parts, total };
}

/**
 * Where the browser check writes its measurements, relative to the website repository.
 *
 * A POSIX literal, deliberately, not path.join: this string is passed as an argument to a command that runs INSIDE
 * the Linux build container. On a Windows runner host path.join produces ".crestmont\quality\visual.json", and the
 * container would create one file whose name contains backslashes instead of writing into the directory — so the
 * measurements would silently never be found. (The sibling `--out .crestmont/screenshots` argument is a POSIX
 * literal for the same reason.) `readVisualMeasurements` joins it with the host repo path, where either separator
 * works.
 */
export const VISUAL_MEASUREMENTS_FILE = ".crestmont/quality/visual.json";

/** The browser check's measurements for this cycle, or null when it did not run or wrote nothing usable. */
export function readVisualMeasurements(repo: string): VisualMeasurementsFile | null {
  const f = path.join(repo, ...VISUAL_MEASUREMENTS_FILE.split("/"));
  if (!existsSync(f)) return null;
  try {
    const v = JSON.parse(readFileSync(f, "utf8")) as VisualMeasurementsFile;
    if (v?.schema !== "crestmont.visual-measurements/1" || !Array.isArray(v.measurements)) return null;
    return v;
  } catch { return null; }
}

/**
 * Does the APPROVED design call for imagery?
 *
 * Read from the customer's own brief and the architect's design specification, never from the builder: revision 1-3
 * of bld_50e28bbd1cd033ad9ddfad02 shipped zero images against an intake whose content source said "licensed", and
 * nothing in the pipeline compared the two. "stock" and "licensed" are answers that promise photography; "none"
 * and an empty answer are not, and a design spec that names photography, gallery or hero imagery counts either way.
 */
export function requiresImagery(o: { imagesSource?: string | null; designSpec?: string | null; pages?: string[] }): boolean {
  const src = (o.imagesSource ?? "").toLowerCase();
  if (/\bnone\b|no (?:images|photos)|text only/.test(src)) return false;
  if (/licen[cs]ed|stock|customer|provided|own photo|photograph/.test(src)) return true;
  const spec = (o.designSpec ?? "").toLowerCase();
  if (/\b(?:photograph|photography|hero image|imagery|gallery|image grid|lifestyle (?:shot|image))/.test(spec)) return true;
  return (o.pages ?? []).some((p) => /gallery|portfolio|our work|projects/i.test(p));
}

/**
 * Does the approved design call for PHOTOGRAPHY specifically? (V5 §7.)
 *
 * Narrower than requiresImagery on purpose, and the distinction is the whole point. "This page needs a visual"
 * is satisfied by authored artwork; "this page needs photographs of the customer's trucks" is not. The builder
 * prompt used to tell the model that an SVG counted and "an authored illustration is far better than an empty
 * space" (runner/src/prompt.ts), the browser check counted any <img> or <svg> as imagery, and the two together
 * meant a brief asking for licensed photography could be answered with line art and score full marks for it.
 *
 * Photography is required when something SAYS so -- the intake's image source, the architect's design
 * specification, or the blueprint planning a photographic asset. It is never inferred from a page name: a
 * gallery page can legitimately be a gallery of illustrated work.
 */
export function requiresPhotography(o: { imagesSource?: string | null; designSpec?: string | null; blueprintPhotographs?: number }): boolean {
  if ((o.blueprintPhotographs ?? 0) > 0) return true;
  const src = (o.imagesSource ?? "").toLowerCase();
  if (/\bnone\b|no (?:images|photos)|text only|illustration only|no photograph/.test(src)) return false;
  if (/photo|photograph|stock|licen[cs]ed|headshot|lifestyle shot/.test(src)) return true;
  const spec = (o.designSpec ?? "").toLowerCase();
  return /\b(?:photograph|photography|photo(?:s|graphs)?\b|licen[cs]ed (?:image|imagery|photo)|stock (?:image|imagery|photo)|headshot)/.test(spec);
}

// ── Scoring ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function scoreItems(
  rubric: readonly { id: string; max: number; label: string }[],
  status: (id: string) => Criterion | undefined,
): { items: CategoryScore["items"]; points: number; pendingExternal: boolean } {
  const live: { id: string; max: number; fraction: number; note: string | null }[] = [];
  const dropped: { id: string; max: number }[] = [];
  let pendingExternal = false;
  for (const item of rubric) {
    let applicable = 0, passed = 0;
    const notes: string[] = [];
    for (const id of CRITERION_ITEMS[item.id] ?? []) {
      const c = status(id);
      if (!c || !c.applicable) continue;
      applicable++;
      if (c.status === "pass") passed++;
      else { notes.push(id); if (c.status === "pending_external") pendingExternal = true; }
    }
    if (applicable === 0) dropped.push({ id: item.id, max: item.max });
    else live.push({ id: item.id, max: item.max, fraction: passed / applicable, note: notes.length ? `not passed: ${notes.join(", ")}` : null });
  }
  const liveMax = live.reduce((s, i) => s + i.max, 0);
  const droppedMax = dropped.reduce((s, i) => s + i.max, 0);
  const scale = liveMax > 0 ? (liveMax + droppedMax) / liveMax : 0;
  // Apportioned, not rounded item by item: the displayed items must add up to the category's own total, or a
  // website whose package excludes a feature could never reach its maximum (see `apportion`).
  const maxima = apportion(live.map((i) => i.max * scale));
  const scored = apportion(live.map((i) => i.max * scale * i.fraction));
  const items: CategoryScore["items"] = [
    ...live.map((i, n) => ({ id: i.id, points: scored.parts[n], max: maxima.parts[n], applicable: true, note: i.note })),
    ...dropped.map((i) => ({ id: i.id, points: 0, max: 0, applicable: false, note: "not in this website's approved scope" })),
  ];
  return { items, points: scored.total, pendingExternal };
}

/**
 * The hard visual failures the browser check actually measured, plus the ones the evidence set itself establishes.
 *
 * `requiresImagery` comes from the approved design, never from the model: a brief that asked for licensed
 * photography and a website with no content images is a failure to report, and revision 1-3 is the proof that
 * nothing else in the pipeline noticed.
 */
export function measuredVisualFailures(o: {
  visual: VisualMeasurementsFile | null;
  viewports: Viewport[];
  browserOk: boolean | null;
  requiresImagery: boolean;
  review: { vision: boolean; imagesSeen: number } | null;
}): VisualFailureId[] {
  const out = new Set<VisualFailureId>();
  if (!o.review || !o.review.vision) out.add("no_vision");
  for (const v of REQUIRED_VIEWPORTS) if (!o.viewports.includes(v)) out.add("evidence");
  const m = o.visual?.measurements ?? [];
  if (!m.length) {
    // No measurements at all: the browser check did not run or produced nothing. That is missing evidence, which
    // caps the design at 0 -- not a pass by default.
    if (o.browserOk !== true) out.add("unstyled");
    return [...out];
  }
  // No stylesheet at all, OR the browser's own default serif with only one sheet: the second is the signature of a
  // page whose CSS loaded but applied nothing. `defaultFont` alone is not enough — a deliberate `font-family: serif`
  // is a styling choice, not a failure.
  if (m.some((x) => x.styleSheets === 0 || (x.defaultFont && x.styleSheets <= 1 && x.contentImages === 0))) out.add("unstyled");
  if (m.some((x) => x.viewport === "desktop" && x.nav && (x.nav.stacked || (x.nav.hasNav && x.nav.visibleLinks < 2) || x.nav.toggleVisible))) out.add("navigation");
  if (m.some((x) => x.placeholders > 0)) out.add("placeholder");
  // Overlap/clipping: a single stray box is noise, several on one page view is a layout that does not hold.
  if (m.some((x) => x.clipped > 0 || x.overlaps >= 2)) out.add("overlap");
  // The imagery CAP is for a page with no visual content at all. Authored vector artwork is visual content: 24
  // inline illustrations are not "none", and capping a site that has them at 24/40 punished the builder for doing
  // what the design-phase prompt told it to do. Whether that artwork meets the brief's PHOTOGRAPHY requirement is
  // a separate judgement, scored on the imagery rubric item and named as an unmet requirement -- never full credit
  // for an illustration, and never a hard cap for having one.
  if (o.requiresImagery && m.every((x) => x.contentImages === 0 && (x.vectorArt ?? 0) === 0)) out.add("imagery");
  if (o.browserOk === false && !out.size) out.add("overflow"); // the check failed for a layout reason not named above
  return [...out];
}

export function scoreVisual(
  rubric: VisualRubricVerdict[] | null,
  failures: VisualFailureId[],
  o: { reviewer: string | null; vision: boolean; imagesSeen: number; viewports: Viewport[]; photographyRequired?: boolean; hasPhotography?: boolean },
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
    let points = round1(raw);
    let note = r?.note ?? (r ? null : "the reviewer did not score this item");
    // Vector artwork is visual content, but it is not photography. When the approved design calls for photographs
    // and the page carries none, the imagery ITEM is held to half marks and the shortfall is named. This is the
    // other half of the imagery correction: lifting the hard cap for authored illustrations must not quietly hand
    // them full imagery credit, or "we drew an icon" would satisfy "the brief asks for photographs of the work".
    if (i.id === "imagery" && o.photographyRequired && !o.hasPhotography) {
      const half = round1(i.max / 2);
      if (points > half) {
        points = half;
        note = `held at ${half}/${i.max}: the approved design calls for photography and the rendered pages carry none (authored artwork only). ${note ?? ""}`.trim();
      }
    }
    return { id: i.id as string, points, max: i.max, applicable: true, note };
  });
  const scored = round1(items.reduce((s, i) => s + i.points, 0));
  const caps = failures.map((f) => ({ id: f, ...VISUAL_FAILURES[f] }));
  const ceiling = caps.length ? Math.min(...caps.map((c) => c.cap)) : max;
  const missingViewports = REQUIRED_VIEWPORTS.filter((v) => !o.viewports.includes(v));
  return {
    points: round1(Math.min(scored, ceiling)), max, items,
    state: caps.length && ceiling === 0 ? "insufficient_evidence" : "scored",
    reason: caps.length ? `capped at ${ceiling}/${max}: ${caps.map((c) => c.detail).join("; ")}`
      : missingViewports.length ? `no evidence at ${missingViewports.join(", ")}` : null,
  };
}

export interface WeightedInput {
  /** The v1 evidence scorecard for this cycle: its criteria are the functionality/other evidence, unchanged. */
  card: Scorecard;
  phase: BuildPhase;
  revision: string | null;
  visual: VisualMeasurementsFile | null;
  visualRubric: VisualRubricVerdict[] | null;
  review: { reviewer: string; imagesSeen: number; vision: boolean } | null;
  /** The approved design calls for imagery (brief: images_source / an imagery requirement in the design spec). */
  requiresImagery: boolean;
  /**
   * The approved design calls for PHOTOGRAPHY specifically (V5 §7): requiresPhotography() above, or a blueprint
   * that plans a photographic asset. Separate from requiresImagery, and never derived from it: "this page needs a
   * visual" is satisfied by authored artwork, "this page needs photographs of the customer's trucks" is not, and
   * treating them as one requirement is how a brief asking for licensed photography was answered with line art
   * and scored full marks for imagery.
   */
  requiresPhotography?: boolean;
  browserOk: boolean | null;
}

export function scoreWeighted(i: WeightedInput): Scorecard2 {
  const byId = new Map(i.card.criteria.map((c) => [c.id as string, c]));
  const status = (id: string) => byId.get(id);
  const viewports = [...new Set((i.visual?.viewports ?? []).filter((v): v is Viewport => (REQUIRED_VIEWPORTS as readonly string[]).includes(v)))];

  const failures = measuredVisualFailures({ visual: i.visual, viewports, browserOk: i.browserOk, requiresImagery: i.requiresImagery, review: i.review });
  // Raster imagery anywhere in the rendered pages. Vector artwork does not count here: this is the photography
  // question, kept separate from "does the page have any visual content at all".
  //
  // photoImages is the measurement that answers it -- visible <img> and background images with a raster source and
  // real intrinsic pixels. Measurements recorded before that number existed have none, and there the older
  // contentImages is the best available evidence: reading a legacy file as "zero photographs" would hold an older
  // build to a measurement nobody took.
  const measurements = i.visual?.measurements ?? [];
  const photoMeasured = measurements.some((m) => typeof m.photoImages === "number");
  const hasPhotography = photoMeasured
    ? measurements.some((m) => (m.photoImages ?? 0) > 0)
    : measurements.some((m) => m.contentImages > 0);
  const design = scoreVisual(i.visualRubric, failures, {
    reviewer: i.review?.reviewer ?? null, vision: i.review?.vision ?? false, imagesSeen: i.review?.imagesSeen ?? 0, viewports,
    photographyRequired: i.requiresPhotography ?? false, hasPhotography,
  });
  const fn = scoreItems(FUNCTIONAL_RUBRIC, status);
  const ot = scoreItems(OTHER_RUBRIC, status);
  const functionality = category("functionality", fn, CATEGORY_MAX.functionality);
  const other = category("other", ot, CATEGORY_MAX.other);

  const totalPoints = round1(design.points + functionality.points + other.points);
  const visualFailures = failures.map((id) => ({ id, detail: VISUAL_FAILURES[id].detail, cap: VISUAL_FAILURES[id].cap }));
  const dBlockers = designBlockers({ design, visualFailures: failures, viewports, review: i.review, revision: i.revision });
  const rBlockers = releaseBlockers({ design, functionality, other, designCertified: dBlockers.length === 0 });
  const notPassed = i.card.criteria.filter((c) => c.applicable && c.status !== "pass");

  return {
    schema: SCORECARD_V2_SCHEMA, packageId: i.card.packageId, iteration: i.card.iteration, phase: i.phase, revision: i.revision,
    design, functionality, other, totalPoints, overall: round1(totalPoints / 10),
    visualFailures, viewports, review: i.review,
    criteria: i.card.criteria.map((c) => ({ id: c.id, applicable: c.applicable, status: c.status, evidence: c.evidence, reason: c.reason })),
    defects: i.card.defects.map((d) => ({ criterion: d.criterion as string, class: d.class as string, detail: d.detail })),
    designCertified: dBlockers.length === 0, designBlockers: dBlockers.slice(0, 30),
    eligible: rBlockers.length === 0, releaseBlockers: rBlockers.slice(0, 30),
    waitingExternal: notPassed.length > 0 && notPassed.every((c) => c.status === "pending_external"),
    computedAt: new Date().toISOString(),
  };
}

function category(id: "functionality" | "other", r: ReturnType<typeof scoreItems>, max: number): CategoryScore {
  const live = r.items.filter((x) => x.applicable);
  const state: CategoryScore["state"] = live.length === 0 ? "insufficient_evidence"
    : r.pendingExternal && r.points < max ? "blocked_external" : "scored";
  const reason = live.length === 0 ? `${id}: no applicable criterion, so this category has no evidence`
    : state === "blocked_external" ? `${id}: waiting for a provider-side verification that needs the customer's own account` : null;
  return { points: r.points, max, items: r.items, state, reason };
}

export function designBlockers(i: {
  design: CategoryScore; visualFailures: VisualFailureId[]; viewports: Viewport[];
  review: { reviewer: string; imagesSeen: number; vision: boolean } | null; revision: string | null;
}): string[] {
  const out: string[] = [];
  if (!i.review || !i.review.vision) out.push("no vision-capable reviewer inspected the rendered website");
  else if (i.review.imagesSeen <= 0) out.push("the reviewer received no screenshots");
  for (const v of REQUIRED_VIEWPORTS) if (!i.viewports.includes(v)) out.push(`no ${v} screenshot evidence`);
  for (const f of i.visualFailures) out.push(VISUAL_FAILURES[f].detail);
  if (i.design.state !== "scored") out.push(i.design.reason ?? `the visual category is ${i.design.state}`);
  if (i.design.points < CATEGORY_MAX.design) out.push(`visual design is ${round1(i.design.points)}/${CATEGORY_MAX.design}`);
  for (const item of i.design.items) {
    if (item.applicable && item.points < item.max) out.push(`${VISUAL_RUBRIC.find((r) => r.id === item.id)?.label ?? item.id}: ${round1(item.points)}/${item.max}`);
  }
  if (!i.revision) out.push("no stored revision is identified for this design");
  return [...new Set(out)];
}

export function releaseBlockers(c: { design: CategoryScore; functionality: CategoryScore; other: CategoryScore; designCertified: boolean }): string[] {
  const out: string[] = [];
  if (!c.designCertified) out.push("visual design is not certified at 40/40");
  for (const [id, cat] of [["functionality", c.functionality], ["other", c.other]] as const) {
    if (cat.state !== "scored") out.push(`${id}: ${cat.reason ?? cat.state}`);
    if (cat.points < CATEGORY_MAX[id]) out.push(`${id} is ${round1(cat.points)}/${CATEGORY_MAX[id]}`);
  }
  return out;
}

/** Outstanding work for the ACTIVE phase only: the loop must not be driven by an inactive category's failures. */
export function phaseOutstanding(card: Scorecard2): string[] {
  const cat = PRIMARY_PROGRESS[card.phase];
  if (cat === "design") return card.designBlockers.map((b) => `design:${b.slice(0, 160)}`);
  const items = cat === "functionality" ? card.functionality.items : cat === "other" ? card.other.items : [];
  const ids = new Set<string>();
  for (const item of items) if (item.applicable && item.points < item.max) for (const c of CRITERION_ITEMS[item.id] ?? []) ids.add(c);
  return card.criteria.filter((c) => ids.has(c.id as string) && c.applicable && c.status !== "pass" && c.status !== "pending_external")
    .map((c) => `quality:${c.id}: ${(c.reason ?? c.status).slice(0, 160)}`);
}
