// The weighted scorecard, runner side: the arithmetic, the caps, and parity with the platform's definition.
//
// The fixture these tests are built around is a real one. bld_50e28bbd1cd033ad9ddfad02 revision 1-3 certified at
// 9.4/10 with a vertically stacked desktop navigation (site.css:109 sets flex-direction: column outside any media
// query; the min-width:64rem block never resets it) and zero images against a brief asking for licensed
// photography. Every test below that mentions "9.4" is checking that the same website now scores like the website
// it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORY_MAX, CRITERION_ITEMS, FUNCTIONAL_RUBRIC, OTHER_RUBRIC, PRIMARY_PROGRESS, REQUIRED_VIEWPORTS,
  VISUAL_FAILURES, VISUAL_RUBRIC, apportion, measuredVisualFailures, phaseOutstanding, requiresImagery, scoreItems,
  scoreVisual, scoreWeighted, type VisualMeasurement, type VisualMeasurementsFile, type VisualRubricVerdict,
} from "../src/quality-weighted.ts";
import { CRITERIA, type Criterion, type CriterionId, type CriterionStatus, type Scorecard } from "../src/quality.ts";
import { parseVisualRubric, VISUAL_RUBRIC_ITEMS } from "../src/orchestrator/contracts.ts";
// The platform's authoritative definition. The runner image ships only runner/, so src/ cannot be imported by
// runner/src -- but the TESTS can, which is how the two copies are kept identical rather than hoped to be.
import * as PLATFORM from "../../src/domain/quality-rubric.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────

const criterion = (id: CriterionId, status: CriterionStatus, applicable = true): Criterion => ({
  id, name: CRITERIA.find((c) => c[0] === id)![1], applicable,
  status: applicable ? status : "not_applicable",
  evidence: status === "pass" ? [`fixture evidence for ${id}`] : [],
  reason: status === "pass" ? null : `fixture: ${id} is ${status}`,
});

/** A flat card where every criterion has the same status, with per-criterion overrides. */
function flatCard(def: CriterionStatus, over: Partial<Record<CriterionId, CriterionStatus | "na">> = {}): Scorecard {
  const criteria = CRITERIA.map(([id]) => {
    const o = over[id];
    return o === "na" ? criterion(id, "not_applicable", false) : criterion(id, o ?? def);
  });
  const applicable = criteria.filter((c) => c.applicable);
  const passed = applicable.filter((c) => c.status === "pass").length;
  return {
    schema: "crestmont.quality-scorecard/1", packageId: "business", iteration: 1, criteria,
    applicable: applicable.length, passed,
    score: passed === applicable.length ? 10 : Math.min(9.9, Math.floor((10 * passed / applicable.length) * 10) / 10),
    eligible: passed === applicable.length, waitingExternal: false, defects: [], computedAt: new Date().toISOString(),
  };
}

const fullRubric = (): VisualRubricVerdict[] => VISUAL_RUBRIC.map((i) => ({ id: i.id, points: i.max, note: "fixture: finished work" }));
const VISION = { reviewer: "local:qwen2.5vl", imagesSeen: 6, vision: true };

const measurement = (viewport: string, over: Partial<VisualMeasurement> = {}): VisualMeasurement => ({
  page: "index.html", viewport, images: 4, contentImages: 4, clipped: 0, overlaps: 0, placeholders: 0,
  styleSheets: 2, defaultFont: false, headings: 1,
  nav: { hasNav: true, visibleLinks: 5, toggleVisible: false, stacked: false, navDirection: "row" },
  ...over,
});

const visualFile = (over: Partial<VisualMeasurement> = {}, viewports = [...REQUIRED_VIEWPORTS]): VisualMeasurementsFile => ({
  schema: "crestmont.visual-measurements/1", viewports, pages: ["index.html"],
  measurements: viewports.map((v) => measurement(v, over)),
});

const weigh = (o: {
  card?: Scorecard; rubric?: VisualRubricVerdict[] | null; review?: typeof VISION | null;
  visual?: VisualMeasurementsFile | null; imagery?: boolean; phase?: Parameters<typeof scoreWeighted>[0]["phase"];
} = {}) => scoreWeighted({
  card: o.card ?? flatCard("pass"), phase: o.phase ?? "design", revision: "1-3",
  visual: o.visual === undefined ? visualFile() : o.visual,
  visualRubric: o.rubric === undefined ? fullRubric() : o.rubric,
  review: o.review === undefined ? VISION : o.review,
  requiresImagery: o.imagery ?? true, browserOk: true,
});

// ── Parity with the platform ──────────────────────────────────────────────────────────────────────────────────────

test("[QUALITY-W] the runner's rubric is byte-identical to the platform's authoritative definition", () => {
  // Two copies of the arithmetic is the design (the runner image cannot import src/), so a drift is a silent
  // disagreement about what a website is worth. This test is the only thing preventing it.
  assert.deepEqual(CATEGORY_MAX, PLATFORM.CATEGORY_MAX);
  assert.deepEqual(VISUAL_RUBRIC, PLATFORM.VISUAL_RUBRIC);
  assert.deepEqual(FUNCTIONAL_RUBRIC, PLATFORM.FUNCTIONAL_RUBRIC);
  assert.deepEqual(OTHER_RUBRIC, PLATFORM.OTHER_RUBRIC);
  assert.deepEqual(CRITERION_ITEMS, PLATFORM.CRITERION_ITEMS);
  assert.deepEqual(VISUAL_FAILURES, PLATFORM.VISUAL_FAILURES);
  assert.deepEqual(REQUIRED_VIEWPORTS, PLATFORM.REQUIRED_VIEWPORTS);
  assert.deepEqual(PRIMARY_PROGRESS, PLATFORM.PRIMARY_PROGRESS);
  // The reviewer contract's own copy of the item maxima has to agree too, or a model is asked for a score out of a
  // number the scorecard will not accept.
  assert.deepEqual(VISUAL_RUBRIC_ITEMS.map((i) => ({ id: i.id, max: i.max })), VISUAL_RUBRIC.map((i) => ({ id: i.id, max: i.max })));
});

test("[QUALITY-W] the runner and the platform compute the SAME numbers, not just from the same constants", () => {
  // Identical constants are necessary but not sufficient: the two implementations also have to agree about
  // applicability, redistribution and apportionment. So the same evidence is run through both.
  const shapes: Partial<Record<CriterionId, CriterionStatus | "na">>[] = [
    {}, { payments: "na" }, { payments: "na", workflows: "na" }, { payments: "na", integrations: "na" },
    { backend: "fail" }, { backend: "fail", database: "unsupported" }, { integrations: "pending_external" },
    { frontend: "fail", backend: "fail", database: "fail", auth: "fail", workflows: "fail", requirements: "fail", customer_experience: "fail", integrations: "fail", payments: "fail" },
  ];
  for (const shape of shapes) {
    const card = flatCard("pass", shape);
    const mine = scoreItems(FUNCTIONAL_RUBRIC, (id) => card.criteria.find((c) => (c.id as string) === id));
    const theirs = PLATFORM.scoreItems(PLATFORM.FUNCTIONAL_RUBRIC, (id) => {
      const c = card.criteria.find((x) => (x.id as string) === id);
      return c ? { applicable: c.applicable, passed: c.status === "pass", pendingExternal: c.status === "pending_external" } : null;
    });
    assert.equal(mine.points, theirs.points, `functionality points agree for ${JSON.stringify(shape)}`);
    assert.deepEqual(mine.items.map((i) => [i.id, i.points, i.max, i.applicable]), theirs.items.map((i) => [i.id, i.points, i.max, i.applicable]),
      `per-item breakdown agrees for ${JSON.stringify(shape)}`);
    assert.equal(mine.pendingExternal, theirs.pendingExternal);
  }
});

test("[QUALITY-W] a category whose item was redistributed can still reach its exact maximum", () => {
  // The bug this pins: rounding each scaled item down independently gave 11.1 + 11.1 + 8.8 + 8.8 = 39.8, so a
  // Starter website that passed EVERYTHING scored 39.8/40 and could never reach the 100/100 approval requires.
  const starter = weigh({ card: flatCard("pass", { payments: "na", integrations: "na" }) });
  assert.equal(starter.functionality.points, 40, "every applicable item passing is exactly the category maximum");
  const live = starter.functionality.items.filter((i) => i.applicable);
  assert.equal(live.reduce((s, i) => s + i.max, 0), 40, "and the displayed item maxima add up to 40, not 39.8");
  assert.equal(live.reduce((s, i) => s + i.points, 0), 40, "as do the displayed points");
  assert.equal(starter.totalPoints, 100);
  assert.equal(starter.eligible, true, "a Starter package can reach 100/100 within its own approved scope");
});

test("[QUALITY-W] the three categories are exactly 40, 40 and 20, and the rubric items add up to them", () => {
  assert.equal(CATEGORY_MAX.design + CATEGORY_MAX.functionality + CATEGORY_MAX.other, 100);
  assert.equal(VISUAL_RUBRIC.reduce((s, i) => s + i.max, 0), 40, "visual design is 40% of the score");
  assert.equal(FUNCTIONAL_RUBRIC.reduce((s, i) => s + i.max, 0), 40, "frontend and backend functionality is 40%");
  assert.equal(OTHER_RUBRIC.reduce((s, i) => s + i.max, 0), 20, "remaining quality is 20%");
});

// ── The arithmetic ────────────────────────────────────────────────────────────────────────────────────────────────

test("[QUALITY-W] a perfect website is 40 + 40 + 20 = 100 = 10.0/10 and is eligible", () => {
  const w = weigh();
  assert.equal(w.design.points, 40);
  assert.equal(w.functionality.points, 40);
  assert.equal(w.other.points, 20);
  assert.equal(w.totalPoints, 100);
  assert.equal(w.overall, 10);
  assert.equal(w.designCertified, true);
  assert.equal(w.eligible, true, "100/100 with every category measured is the only eligible state");
});

test("[QUALITY-W] the Founder's worked examples reproduce exactly", () => {
  // From the directive: 20/40 + 30/40 + 20/20 = 7.0; 30/40 + 5/40 + 20/20 = 5.5; 40/40 + 12/40 + 20/20 = 7.2.
  const cases: [number, number, number, number][] = [[20, 30, 20, 7.0], [30, 5, 20, 5.5], [40, 12, 20, 7.2], [40, 40, 20, 10.0]];
  for (const [d, f, o, overall] of cases) {
    assert.equal(Math.floor(((d + f + o) / 10) * 10 + 1e-9) / 10, overall, `${d}/40 + ${f}/40 + ${o}/20 = ${overall}/10`);
  }
});

test("[QUALITY-W] a low design score cannot be masked by high functionality", () => {
  const poor = weigh({ rubric: VISUAL_RUBRIC.map((i) => ({ id: i.id, points: i.max / 2, note: "fixture: half" })) });
  assert.equal(poor.design.points, 20, "half marks on every visual item");
  assert.equal(poor.functionality.points, 40);
  assert.equal(poor.other.points, 20);
  assert.equal(poor.totalPoints, 80);
  assert.equal(poor.designCertified, false);
  assert.equal(poor.eligible, false, "80/100 with a half-finished design is not approvable, however good the rest is");
  assert.match(poor.releaseBlockers.join("; "), /visual design is not certified/);
});

test("[QUALITY-W] an inapplicable feature earns no free points: its maximum is shared out WITHIN its own category", () => {
  // A Starter website has no payments and no booking workflow. Those criteria leave the denominator; the category
  // still totals 40, and the website cannot score Premium points for features it never had.
  const starter = flatCard("pass", { payments: "na", workflows: "na" });
  const w = weigh({ card: starter });
  assert.equal(w.functionality.points, 40, "the category still totals its maximum");
  const integrations = w.functionality.items.find((i) => i.id === "integrations")!;
  assert.equal(integrations.applicable, true, "integrations still has an applicable criterion of its own");
  // Now make the whole integrations item inapplicable and check redistribution, not a free 40.
  const w2 = weigh({ card: flatCard("pass", { payments: "na", integrations: "na" }) });
  assert.equal(w2.functionality.points, 40);
  assert.equal(w2.functionality.items.find((i) => i.id === "integrations")!.applicable, false);
  assert.equal(w2.functionality.items.find((i) => i.id === "integrations")!.max, 0, "a dropped item is worth 0, not its old maximum");
  // Failing the remaining work still costs the full category.
  const w3 = weigh({ card: flatCard("fail", { payments: "na", integrations: "na" }) });
  assert.equal(w3.functionality.points, 0, "with everything applicable failing, redistribution cannot manufacture points");
});

test("[QUALITY-W] functionality scores partially, so 15/40 -> 25/40 is visible progress", () => {
  const partial = weigh({ card: flatCard("fail", { frontend: "pass", backend: "pass" }) });
  assert.ok(partial.functionality.points >= 19 && partial.functionality.points <= 21,
    `frontend (10) + backend (10) of 40 is about half: got ${partial.functionality.points}`);
  const more = weigh({ card: flatCard("fail", { frontend: "pass", backend: "pass", database: "pass", auth: "pass" }) });
  assert.ok(more.functionality.points > partial.functionality.points, "adding persistence and auth raises the category");
});

// ── The design category: evidence, not opinion ────────────────────────────────────────────────────────────────────

test("[QUALITY-W] a missing review cannot produce a design score, and is reported as blocked rather than as 0/40 earned", () => {
  const none = weigh({ review: null, rubric: null });
  assert.equal(none.design.points, 0);
  assert.equal(none.design.state, "blocked", "\"nobody looked\" is not the same as \"it looks bad\"");
  assert.match(none.design.reason ?? "", /no vision-capable reviewer/);
  assert.equal(none.designCertified, false);
  assert.equal(none.eligible, false);
});

test("[QUALITY-W] a text-only reviewer cannot certify a visual design, even if it returns a full rubric", () => {
  const textOnly = weigh({ review: { reviewer: "local:qwen2.5-coder", imagesSeen: 0, vision: false }, rubric: fullRubric() });
  assert.equal(textOnly.design.points, 0);
  assert.equal(textOnly.designCertified, false);
  assert.ok(textOnly.visualFailures.some((f) => f.id === "no_vision"));
});

test("[QUALITY-W] a vision reviewer that received no screenshots has no basis, so the design is insufficient_evidence", () => {
  const blind = weigh({ review: { ...VISION, imagesSeen: 0 } });
  assert.equal(blind.design.state, "insufficient_evidence");
  assert.equal(blind.design.points, 0);
});

test("[QUALITY-W] missing viewport evidence prevents design certification; all three are required", () => {
  for (const missing of REQUIRED_VIEWPORTS) {
    const vps = REQUIRED_VIEWPORTS.filter((v) => v !== missing);
    const w = weigh({ visual: visualFile({}, [...vps]) });
    assert.equal(w.designCertified, false, `${missing} evidence missing must block certification`);
    assert.ok(w.designBlockers.some((b) => b.includes(missing)), `the blocker names ${missing}: ${w.designBlockers.join("; ")}`);
  }
  // Tablet is the new one. Before this engine, nothing in the pipeline ever rendered a tablet layout.
  const noTablet = weigh({ visual: visualFile({}, ["desktop", "mobile"]) });
  assert.ok(noTablet.designBlockers.some((b) => b.includes("tablet")));
});

test("[QUALITY-W] a reviewer's score above an item's maximum is clamped, and an unexplained shortfall scores 0", () => {
  const cheating = parseVisualRubric([
    { id: "layout", points: 40, note: "fixture", deficiencies: [] },
    { id: "typography", points: 5, note: "", deficiencies: [] },
    { id: "imagery", points: -3, note: "fixture", deficiencies: [] },
    { id: "nonsense", points: 99 },
  ]);
  assert.ok(cheating);
  const layout = cheating!.find((i) => i.id === "layout")!;
  assert.equal(layout.points, 8, "a model cannot award itself more than the rubric allows");
  const typography = cheating!.find((i) => i.id === "typography")!;
  assert.equal(typography.points, 0, "5/6 with no stated deficiency and no note is a number with nothing behind it");
  assert.match(typography.note ?? "", /no stated deficiency/);
  assert.equal(cheating!.find((i) => i.id === "imagery")!.points, 0, "negative points are clamped to zero");
  assert.ok(!cheating!.some((i) => (i.id as string) === "nonsense"), "an invented item is dropped");
  assert.equal(parseVisualRubric([]), null, "an empty rubric is \"no rubric\", which leaves the category unmeasured");
  assert.equal(parseVisualRubric("40/40"), null);
});

// ── Hard visual failures: the revision 1-3 fixtures ───────────────────────────────────────────────────────────────

test("[QUALITY-W] REGRESSION: a stacked desktop navigation cannot receive 40/40 — the exact revision 1-3 defect", () => {
  // site.css:109 `.site-nav ul { flex-direction: column }` outside any media query, never reset in the
  // min-width:64rem block. The links are all visible, there are more than two, and no mobile toggle is showing --
  // which is why every check in the old pipeline passed it. What makes it a defect is WHERE the links are.
  const stacked = visualFile();
  stacked.measurements = stacked.measurements.map((m) => m.viewport === "desktop"
    ? { ...m, nav: { hasNav: true, visibleLinks: 5, toggleVisible: false, stacked: true, navDirection: "column" } }
    : m);
  const w = weigh({ visual: stacked, rubric: fullRubric() });
  assert.ok(w.visualFailures.some((f) => f.id === "navigation"), "the stacked nav is measured as a hard visual failure");
  assert.equal(w.design.points, VISUAL_FAILURES.navigation.cap, `capped at ${VISUAL_FAILURES.navigation.cap}/40, not 39`);
  assert.equal(w.designCertified, false);
  assert.ok(w.design.points < 40 * 0.5, "a broken primary navigation is not a 95%-good website");
  // And the old engine's answer, for contrast: 18 of 19 criteria passing was 9.4/10.
  assert.ok(w.overall < 9.4, `the same website now scores ${w.overall}/10, not 9.4/10`);
});

test("[QUALITY-W] REGRESSION: zero imagery against a brief asking for licensed photography cannot be ignored", () => {
  const noImages = weigh({ visual: visualFile({ images: 0, contentImages: 0 }), imagery: true });
  assert.ok(noImages.visualFailures.some((f) => f.id === "imagery"));
  assert.equal(noImages.design.points, VISUAL_FAILURES.imagery.cap);
  assert.equal(noImages.designCertified, false);
  // A brief that genuinely asked for no imagery is NOT penalised: the requirement comes from the approved design.
  const textOnlySite = weigh({ visual: visualFile({ images: 0, contentImages: 0 }), imagery: false });
  assert.ok(!textOnlySite.visualFailures.some((f) => f.id === "imagery"));
  assert.equal(textOnlySite.designCertified, true);
});

test("[QUALITY-W] requiresImagery reads the approved design, not the builder", () => {
  assert.equal(requiresImagery({ imagesSource: "Licensed stock photography" }), true);
  assert.equal(requiresImagery({ imagesSource: "customer will provide photos" }), true);
  assert.equal(requiresImagery({ imagesSource: "none — text only" }), false);
  assert.equal(requiresImagery({ imagesSource: "", designSpec: "A full-width hero image above the services grid" }), true);
  assert.equal(requiresImagery({ imagesSource: "", pages: ["Home", "Gallery", "Contact"] }), true);
  assert.equal(requiresImagery({ imagesSource: "", designSpec: "type-led editorial layout", pages: ["Home", "Contact"] }), false);
});

test("[QUALITY-W] an unstyled page caps the design at zero; a blank page is the hardest visual failure there is", () => {
  const unstyled = weigh({ visual: visualFile({ styleSheets: 0, defaultFont: true }) });
  assert.ok(unstyled.visualFailures.some((f) => f.id === "unstyled"));
  assert.equal(unstyled.design.points, 0);
  assert.equal(unstyled.design.state, "insufficient_evidence");
});

test("[QUALITY-W] placeholder copy presented as final, and overlapping or clipped components, each cap the category", () => {
  const placeholder = weigh({ visual: visualFile({ placeholders: 3 }) });
  assert.equal(placeholder.design.points, VISUAL_FAILURES.placeholder.cap);
  const clipped = weigh({ visual: visualFile({ clipped: 2 }) });
  assert.equal(clipped.design.points, VISUAL_FAILURES.overlap.cap);
  // One stray overlapping box is noise; several on one page view is a layout that does not hold.
  assert.equal(weigh({ visual: visualFile({ overlaps: 1 }) }).designCertified, true, "a single overlap is not a verdict");
  assert.equal(weigh({ visual: visualFile({ overlaps: 3 }) }).design.points, VISUAL_FAILURES.overlap.cap);
});

test("[QUALITY-W] the lowest cap wins when several hard failures are measured at once", () => {
  const bad = weigh({ visual: visualFile({ styleSheets: 0, defaultFont: true, images: 0, contentImages: 0, placeholders: 2 }) });
  assert.equal(bad.design.points, 0, "unstyled caps at 0, which is lower than the imagery and placeholder caps");
});

test("[QUALITY-W] a browser check that produced no measurements is missing evidence, not a pass", () => {
  const nothing = measuredVisualFailures({ visual: null, viewports: [...REQUIRED_VIEWPORTS], browserOk: null, requiresImagery: true, review: VISION });
  assert.ok(nothing.includes("unstyled"), "no measurements and no passing browser check means the design is unevidenced");
  const ok = measuredVisualFailures({ visual: null, viewports: [...REQUIRED_VIEWPORTS], browserOk: true, requiresImagery: false, review: VISION });
  assert.deepEqual(ok, [], "a passing browser check that simply did not write the file is not itself a visual failure");
});

// ── Phase-scoped outstanding work ─────────────────────────────────────────────────────────────────────────────────

test("[QUALITY-W] outstanding work is the ACTIVE phase's, so a design cycle is not driven by deferred backend criteria", () => {
  // The design is finished; the backend is deliberately not built yet. During the design phase that is not a defect
  // list -- and feeding it to the builder is how a design phase turns into backend debugging.
  const card = flatCard("fail", {
    visual_design: "pass", brand_consistency: "pass", desktop: "pass", mobile: "pass",
    accessibility: "pass", seo: "pass", performance: "pass", security: "pass", deployment: "pass", maintainability: "pass", error_handling: "pass",
  });
  const design = weigh({ card, phase: "design" });
  assert.equal(design.designCertified, true, "the design itself is certified");
  assert.deepEqual(phaseOutstanding(design), [], "nothing is outstanding IN THE DESIGN PHASE");

  const functionality = weigh({ card, phase: "functionality" });
  const open = phaseOutstanding(functionality);
  assert.ok(open.length > 0, "the same card in the functionality phase has plenty outstanding");
  assert.ok(open.some((o) => o.includes("backend")), `backend is named: ${open.join("; ")}`);
  assert.ok(!open.some((o) => o.includes("seo") || o.includes("accessibility")), "but not the final-QA categories");
});

test("[QUALITY-W] during the design phase, outstanding work is the design's own blockers", () => {
  const w = weigh({ rubric: VISUAL_RUBRIC.map((i) => ({ id: i.id, points: i.id === "imagery" ? 2 : i.max, note: "fixture", deficiencies: ["only one stock photo, unrelated to the trade"] })), phase: "design" });
  const open = phaseOutstanding(w);
  assert.ok(open.length > 0);
  assert.ok(open.every((o) => o.startsWith("design:")), `every item is a design blocker: ${open.join("; ")}`);
  assert.ok(open.some((o) => /Imagery/i.test(o)), "and the short item is named");
});

// ── Pending external ──────────────────────────────────────────────────────────────────────────────────────────────

test("[QUALITY-W] a provider-side verification the customer must do is blocked_external, not a failure", () => {
  const card = flatCard("pass", { integrations: "pending_external" });
  const w = weigh({ card });
  assert.equal(w.functionality.state, "blocked_external");
  assert.ok(w.functionality.points < 40, "the points are not awarded");
  assert.match(w.functionality.reason ?? "", /customer's own account/);
  assert.equal(w.eligible, false, "it still blocks 100/100");
});

test("[QUALITY-W] a mocked backend cannot be counted as working functionality", () => {
  // The runner's criteria come from the acceptance gates, which test real endpoints. A card whose backend criterion
  // is "unsupported" (no gate evidence) scores the same as one that failed: zero for that item. There is no status
  // that means "mocked, so credit it".
  const mocked = weigh({ card: flatCard("pass", { backend: "unsupported", database: "unsupported" }) });
  assert.ok(mocked.functionality.points < 40);
  assert.equal(mocked.functionality.items.find((i) => i.id === "backend")!.points, 0);
  assert.equal(mocked.eligible, false);
});

// ── scoreVisual in isolation ──────────────────────────────────────────────────────────────────────────────────────

test("[QUALITY-W] apportion preserves the total and matches the platform's copy", () => {
  for (const vs of [[11.111, 11.111, 8.888, 8.888], [10, 10, 8, 8, 4], [3.333, 3.333, 3.334], [0], [], [7.5, 6, 6, 7, 6, 7]]) {
    const mine = apportion(vs);
    const theirs = PLATFORM.apportion(vs);
    assert.deepEqual(mine, theirs, `the two copies agree for ${JSON.stringify(vs)}`);
    assert.equal(Math.round(mine.parts.reduce((s, p) => s + p, 0) * 10) / 10, mine.total, `the parts sum to the total for ${JSON.stringify(vs)}`);
    for (let i = 0; i < vs.length; i++) assert.ok(mine.parts[i] <= vs[i] + 0.1 + 1e-9, "no part is inflated beyond a tenth above its exact value");
  }
});

test("[QUALITY-W] scoreVisual rounds down and never rounds its way up to a threshold", () => {
  const nearly = scoreVisual(VISUAL_RUBRIC.map((i) => ({ id: i.id, points: i.id === "layout" ? 7.5 : i.max })), [], { ...VISION, reviewer: VISION.reviewer, viewports: [...REQUIRED_VIEWPORTS] });
  assert.equal(nearly.points, 39.5, "39.5 stays 39.5; it does not become 40");
  assert.equal(nearly.state, "scored");
});
