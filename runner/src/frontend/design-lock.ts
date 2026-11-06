// The approved design, frozen — and the test for whether backend work has disturbed it.
//
// THE INVERSION. `repair-effect.ts` exists to catch a cycle that changed NOTHING: there, no change is the
// failure. Here it is the opposite. The Founder's frontend is already right, so the question every integration
// cycle has to answer is "did this leave the approved appearance alone?".
//
// WHY PIXEL HASHES ARE NOT THE LOCK. Making a site functional is supposed to change what is on screen. A price
// comes from the database instead of being typed in, a form reports a real validation error, a listing shows
// eight items rather than three. A rule of "no rendered byte may differ" would fail every successful
// integration, so it would be turned off within a day and protect nothing.
//
// WHAT IS ACTUALLY LOCKED is the design itself, measured apart from the content poured into it:
//
//   - the layout skeleton (which elements, nested how, in what order);
//   - the palette actually painted;
//   - the fonts and the type scale actually used;
//   - the geometry of the page's landmarks.
//
// Those four do not move when real data arrives. They move when someone restyles a button, swaps a font, drops a
// section, or breaks a grid — which is exactly the harm this guards against. Changes in rendered pixels with an
// intact signature are CONTENT changes, allowed where the integration manifest declared that route would change,
// and reported as undeclared drift where it did not.

import { createHash } from "node:crypto";

/**
 * The three viewports a design is approved at. `repair-effect.ts`'s `RenderShot` covers only desktop and mobile,
 * because the legacy rubric never rendered a tablet; its shots are structurally assignable to `Shot` below, so
 * both can be passed here while that narrower type stays untouched.
 */
export type Viewport = "desktop" | "tablet" | "mobile";

/** One screenshot, by page and viewport. Evidence, not the lock. */
export interface Shot {
  page: string;
  viewport: Viewport;
  sha: string;
}

/**
 * One page at one viewport, measured so that content is excluded and design is not.
 *
 * Produced in the browser by `sandbox/design-signature.mjs`; this module only ever hashes and compares it, so the
 * two can be tested separately.
 */
export interface DesignSignature {
  page: string;
  viewport: Viewport;
  /** Visible block elements as `tag.class-shape` in document order, depth-limited. Text is never included. */
  skeleton: string[];
  /** Every colour actually painted (background, text, border), normalised to `rgb()`/`rgba()` and sorted. */
  palette: string[];
  /** Font families actually resolved, sorted. */
  fonts: string[];
  /** Rendered font sizes in px, sorted — the type scale. */
  typeScale: number[];
  /** The page's landmarks and their boxes, rounded. A grid that breaks shows up here. */
  landmarks: { sel: string; x: number; y: number; w: number; h: number }[];
  /** Full document height in px. Content makes this move; a collapsed layout makes it move a lot. */
  docHeight: number;
}

export interface DesignBaseline {
  /** The artifact this baseline belongs to. */
  artifactSha: string;
  /** `sourceFingerprint()` over the built frontend: the source that produced these renders. */
  sourceFingerprint: string | null;
  signatures: DesignSignature[];
  /** The screenshot hashes, as evidence. Not the lock. */
  renders: Shot[];
  /** sha256 over every signature, canonically ordered. One value that names this exact design. */
  fingerprint: string;
  capturedAt: string;
  /** Who approved it. Under this architecture that is the Founder, never a model. */
  approvedBy: string;
}

/** How much a landmark may move before it counts as the layout changing. */
export const TOLERANCE = {
  /** Landmark boxes are rounded to this many px before comparison: anti-aliasing and font hinting are not drift. */
  boxRoundPx: 8,
  /** A landmark may shift by this many rounded units and still be the same layout. */
  boxShiftPx: 16,
  /** Document height may differ by this fraction before it is called a layout change rather than content. */
  docHeightFraction: 0.5,
} as const;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const round = (n: number, to: number): number => Math.round(n / to) * to;
const key = (s: { page: string; viewport: string }): string => `${s.page}|${s.viewport}`;

/**
 * The page's frame: the landmarks in vertical order with their horizontal placement and the spacing between
 * them. Absolute `y` and `h` are deliberately absent — see the note in `lockedAspects`. This is the one
 * definition of "the layout", used both to name a design and to test whether it still holds.
 */
export function frameOf(s: DesignSignature): { sel: string; x: number; w: number; gap: number }[] {
  const ls = [...s.landmarks].sort((a, b) => a.y - b.y);
  return ls.map((l, i) => ({ sel: l.sel, x: l.x, w: l.w, gap: i === 0 ? l.y : l.y - (ls[i - 1].y + ls[i - 1].h) }));
}

/**
 * The canonical form of a signature: what the lock is actually over.
 *
 * Excludes `docHeight` and every absolute vertical position, because real content legitimately changes both.
 * Height is compared separately, with a generous tolerance, so a page that collapses to nothing is still caught.
 */
export function canonical(s: DesignSignature): string {
  const frame = frameOf(s)
    .map((f) => `${f.sel}@x${round(f.x, TOLERANCE.boxRoundPx)},w${round(f.w, TOLERANCE.boxRoundPx)},gap${round(f.gap, TOLERANCE.boxRoundPx)}`);
  return [
    `page=${s.page}`, `viewport=${s.viewport}`,
    `skeleton=${s.skeleton.join(">")}`,
    `palette=${[...s.palette].sort().join(",")}`,
    `fonts=${[...s.fonts].sort().join(",")}`,
    `type=${[...s.typeScale].sort((a, b) => a - b).join(",")}`,
    `frame=${frame.join(";")}`,
  ].join("\n");
}

export function signatureHash(s: DesignSignature): string {
  return sha256(canonical(s));
}

export function baselineFingerprint(signatures: readonly DesignSignature[]): string {
  return sha256(signatures.map(canonical).sort().join("\n--\n"));
}

/**
 * Freeze an approved design.
 *
 * `approvedBy` is required and is not defaulted. A baseline that cannot say who approved it is not a baseline,
 * and under this architecture the answer is a person.
 */
export function captureBaseline(o: {
  artifactSha: string;
  sourceFingerprint: string | null;
  signatures: readonly DesignSignature[];
  renders?: readonly Shot[];
  approvedBy: string;
  at?: string;
}): DesignBaseline {
  if (!o.signatures.length) throw new Error("a design baseline needs at least one measured page; nothing was captured");
  if (!o.approvedBy.trim()) throw new Error("a design baseline must record who approved it");
  const signatures = [...o.signatures].sort((a, b) => key(a).localeCompare(key(b)));
  return {
    artifactSha: o.artifactSha,
    sourceFingerprint: o.sourceFingerprint,
    signatures,
    renders: [...(o.renders ?? [])],
    fingerprint: baselineFingerprint(signatures),
    capturedAt: o.at ?? new Date().toISOString(),
    approvedBy: o.approvedBy.trim(),
  };
}

/** What the integration manifest says about a route, as far as the lock cares. */
export interface DeclaredChange {
  page: string;
  /** `content` — real data replaces placeholder content here. `none` — this route must render identically. */
  expect: "content" | "none";
  /** Why, in the integrator's own words. Goes into the drift report. */
  reason?: string;
}

export type DriftKind =
  | "design-drift"        // the locked design itself moved. Always a violation.
  | "undeclared-content"  // the rendering changed where nothing said it would.
  | "declared-content"    // the rendering changed where the manifest said it would. Not a violation.
  | "missing-page"        // a page in the baseline no longer renders at all.
  | "new-page";           // a page that was not in the approved design.

export interface DriftFinding {
  kind: DriftKind;
  page: string;
  viewport?: Viewport;
  /** Which locked aspects moved: "palette", "fonts", "type scale", "skeleton", "layout". */
  aspects: string[];
  detail: string;
}

export interface DriftReport {
  /** True only when the approved design is intact and every rendering change was declared. */
  ok: boolean;
  findings: DriftFinding[];
  /** Pages compared, for the record: a report over zero pages must not read as a pass. */
  compared: number;
  baselineFingerprint: string;
  currentFingerprint: string;
}

const setDiff = (a: readonly string[], b: readonly string[]): string[] => {
  const B = new Set(b);
  return a.filter((x) => !B.has(x));
};

/** The locked aspects that differ between two signatures of the same page. */
function lockedAspects(base: DesignSignature, now: DesignSignature): { aspects: string[]; detail: string[] } {
  const aspects: string[] = [];
  const detail: string[] = [];

  const addedColours = setDiff(now.palette, base.palette);
  const lostColours = setDiff(base.palette, now.palette);
  if (addedColours.length || lostColours.length) {
    aspects.push("palette");
    if (addedColours.length) detail.push(`colours not in the approved design: ${addedColours.slice(0, 5).join(", ")}`);
    if (lostColours.length) detail.push(`approved colours no longer painted: ${lostColours.slice(0, 5).join(", ")}`);
  }

  const addedFonts = setDiff(now.fonts, base.fonts);
  const lostFonts = setDiff(base.fonts, now.fonts);
  if (addedFonts.length || lostFonts.length) {
    aspects.push("fonts");
    detail.push(`fonts changed: ${lostFonts.join(", ") || "(none lost)"} → ${addedFonts.join(", ") || "(none added)"}`);
  }

  const addedSizes = setDiff(now.typeScale.map(String), base.typeScale.map(String));
  if (addedSizes.length) {
    aspects.push("type scale");
    detail.push(`font sizes not in the approved type scale: ${addedSizes.slice(0, 6).join(", ")}px`);
  }

  if (base.skeleton.join(">") !== now.skeleton.join(">")) {
    aspects.push("skeleton");
    const lost = setDiff(base.skeleton, now.skeleton);
    const gained = setDiff(now.skeleton, base.skeleton);
    detail.push(lost.length || gained.length
      ? `structure changed: ${lost.length} element(s) gone (${lost.slice(0, 4).join(", ")}), ${gained.length} added (${gained.slice(0, 4).join(", ")})`
      : `the same elements are present but in a different order`);
  }

  // Landmarks.
  //
  // Neither absolute `y` nor `h` is a design property. A section that now holds eight real services instead of
  // three typed ones is TALLER, and everything below it is further down the page — through no fault of the
  // design. Comparing absolute y would therefore flag every successful integration, which is how a lock like this
  // ends up switched off.
  //
  // What the design actually fixes is the horizontal frame (`x`, `w` — the grid), the vertical ORDER of the
  // landmarks, and the SPACING between them. Those three are untouched by content and broken by a restyle.
  const baseFrame = frameOf(base);
  const nowFrame = frameOf(now);
  const baseOrder = baseFrame.map((f) => f.sel);
  const nowOrder = nowFrame.map((f) => f.sel);
  const nowBySel = new Map(nowFrame.map((f) => [f.sel, f]));

  const moved: string[] = [];
  const gone: string[] = [];
  for (const l of baseFrame) {
    const cur = nowBySel.get(l.sel);
    if (!cur) { gone.push(l.sel); continue; }
    const dx = Math.abs(cur.x - l.x);
    const dw = Math.abs(cur.w - l.w);
    const dgap = Math.abs(cur.gap - l.gap);
    if (dx > TOLERANCE.boxShiftPx || dw > TOLERANCE.boxShiftPx || dgap > TOLERANCE.boxShiftPx) {
      const why = [
        dx > TOLERANCE.boxShiftPx ? `moved ${Math.round(dx)}px across` : null,
        dw > TOLERANCE.boxShiftPx ? `width changed by ${Math.round(dw)}px` : null,
        dgap > TOLERANCE.boxShiftPx ? `spacing above it changed by ${Math.round(dgap)}px` : null,
      ].filter(Boolean).join(", ");
      moved.push(`${l.sel} (${why})`);
    }
  }

  const baseSels = new Set(baseOrder);
  const reordered = baseOrder.filter((s) => nowBySel.has(s)).join(">") !== nowOrder.filter((s) => baseSels.has(s)).join(">");
  if (gone.length || moved.length || reordered) {
    aspects.push("layout");
    if (gone.length) detail.push(`landmarks missing: ${gone.join(", ")}`);
    if (moved.length) detail.push(`landmarks changed beyond ${TOLERANCE.boxShiftPx}px: ${moved.slice(0, 4).join("; ")}`);
    if (reordered) detail.push(`landmarks are in a different vertical order: ${baseOrder.join(" → ")} became ${nowOrder.join(" → ")}`);
  }

  if (base.docHeight > 0) {
    const ratio = Math.abs(now.docHeight - base.docHeight) / base.docHeight;
    // Only a gross change counts. Real content moves this freely; a page collapsing to a blank does not.
    if (ratio > TOLERANCE.docHeightFraction) {
      aspects.push("layout");
      detail.push(`the page is ${now.docHeight < base.docHeight ? "shorter" : "taller"} by ${Math.round(ratio * 100)}% (${base.docHeight} → ${now.docHeight} px)`);
    }
  }

  return { aspects: [...new Set(aspects)], detail };
}

/**
 * Has backend work disturbed the approved design?
 *
 * `declared` is what the integration manifest said would change. A rendering change with an intact signature is
 * reported as `declared-content` where it was declared and `undeclared-content` where it was not; only the former
 * is allowed. A signature change is `design-drift` whatever the manifest claims — a declaration cannot authorise
 * restyling the Founder's design.
 */
export function compareToBaseline(
  baseline: DesignBaseline,
  current: readonly DesignSignature[],
  o: { declared?: readonly DeclaredChange[]; renders?: readonly Shot[] } = {},
): DriftReport {
  const findings: DriftFinding[] = [];
  const now = new Map(current.map((s) => [key(s), s]));
  const declared = new Map((o.declared ?? []).map((d) => [d.page, d]));

  let compared = 0;
  for (const base of baseline.signatures) {
    const k = key(base);
    const cur = now.get(k);
    if (!cur) {
      findings.push({ kind: "missing-page", page: base.page, viewport: base.viewport, aspects: [], detail: `${base.page} at ${base.viewport} was in the approved design and no longer renders` });
      continue;
    }
    compared++;
    now.delete(k);

    const { aspects, detail } = lockedAspects(base, cur);
    if (aspects.length) {
      findings.push({ kind: "design-drift", page: base.page, viewport: base.viewport, aspects, detail: detail.join("; ") });
      continue;
    }

    // The design held. Did the rendering change anyway? That is content, and it needs a declaration.
    const was = baseline.renders.find((r) => r.page === base.page && r.viewport === base.viewport);
    const is = (o.renders ?? []).find((r) => r.page === base.page && r.viewport === base.viewport);
    if (was && is && was.sha !== is.sha) {
      const d = declared.get(base.page);
      findings.push(d && d.expect === "content"
        ? { kind: "declared-content", page: base.page, viewport: base.viewport, aspects: [], detail: `content changed as declared${d.reason ? `: ${d.reason}` : ""}; the approved design is intact` }
        : { kind: "undeclared-content", page: base.page, viewport: base.viewport, aspects: [], detail: `the rendering changed but nothing in the integration manifest said this page would change` });
    }
  }

  for (const extra of now.values()) {
    findings.push({ kind: "new-page", page: extra.page, viewport: extra.viewport, aspects: [], detail: `${extra.page} at ${extra.viewport} is not part of the approved design` });
  }

  // A comparison that measured nothing is not a pass. This is the gate that an empty render directory would
  // otherwise sail straight through.
  const measuredNothing = compared === 0;
  if (measuredNothing) {
    findings.push({ kind: "missing-page", page: "(none)", aspects: [], detail: `no page of the approved design could be compared: ${baseline.signatures.length} baseline page(s), ${current.length} measured` });
  }

  const violations = findings.filter((f) => f.kind !== "declared-content");
  return {
    ok: violations.length === 0 && !measuredNothing,
    findings,
    compared,
    baselineFingerprint: baseline.fingerprint,
    currentFingerprint: baselineFingerprint(current),
  };
}

/** The drift report in words, for the build record and for a prompt. */
export function describeDrift(r: DriftReport): string {
  if (r.ok) return `the approved design is intact across ${r.compared} page view(s)${r.findings.length ? `; ${r.findings.length} declared content change(s)` : ""}`;
  const lines = r.findings
    .filter((f) => f.kind !== "declared-content")
    .map((f) => `${f.kind} — ${f.page}${f.viewport ? ` @ ${f.viewport}` : ""}${f.aspects.length ? ` [${f.aspects.join(", ")}]` : ""}: ${f.detail}`);
  return `the approved design did not hold across ${r.compared} page view(s):\n${lines.join("\n")}`;
}

/**
 * The baseline as a row for the existing `build_design_freezes` table.
 *
 * That table is reused rather than replaced, and two of its columns mean something different now, so they are
 * mapped explicitly rather than quietly filled:
 *
 *   - `reviewer` becomes the Founder, not a model. `reviewer_model` is null and `images_seen` is 0, because no
 *     model certified anything.
 *   - `design_points` is the rubric's full 40. Under this architecture that is a statement that the design is
 *     approved by the person who owns the decision, NOT a score a reviewer produced. `rubric_json` says so in
 *     those words, so a later reader is not misled by the number.
 */
export function freezeRow(b: DesignBaseline, o: { jobId: string; projectId: string; attempt: number; revisionAttempt: number; revisionCycle: number; commitSha: string | null }) {
  const viewports = [...new Set(b.signatures.map((s) => s.viewport))];
  return {
    job_id: o.jobId,
    project_id: o.projectId,
    attempt: o.attempt,
    revision_attempt: o.revisionAttempt,
    revision_cycle: o.revisionCycle,
    commit_sha: o.commitSha,
    design_points: 40,
    rubric_json: JSON.stringify({
      basis: "founder-approved-frontend",
      note: "Not a model rubric score. The design arrived approved by the Founder; 40 records that approval so the existing functionality gate reads it correctly.",
      design_fingerprint: b.fingerprint,
      artifact_sha: b.artifactSha,
      pages: b.signatures.map((s) => ({ page: s.page, viewport: s.viewport, signature: signatureHash(s) })),
    }),
    viewports_json: JSON.stringify(viewports),
    screenshots_json: JSON.stringify(b.renders),
    source_fingerprint: b.sourceFingerprint,
    design_references_json: "[]",
    reviewer: b.approvedBy,
    reviewer_model: null,
    images_seen: 0,
    certified_at: b.capturedAt,
  };
}
