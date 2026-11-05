// What the BUILDER model looks at, and why. (V5 correction §1, §3, §4, §5.)
//
// The pipeline this replaces: the Design Gallery chose six references, Model A looked at them and wrote a
// paragraph, and Model B -- the model that actually writes the HTML and CSS -- was given the paragraph. It had
// never seen the standard it was being scored against, and it had never seen what its own code rendered. It was
// then asked, cycle after cycle, to close a visual gap it had no way to perceive. Measured on
// bld_10e2c6007686faee0ab64d45: nine repair cycles, one rendered change, design held at 12-23/40.
//
// This module decides, for one phase, the small set of images that would actually help, and prepares each one to a
// token budget without making it unreadable (image-fit.ts). The choices are deliberately narrow:
//
//   BUILD    the approved concept from the gallery reference the blueprint cites. There is nothing rendered yet,
//            so there is nothing to compare; what the builder needs is the standard.
//   REPAIR   the page actually being repaired, as the visitor first sees it, beside that same reference. This is
//            the comparison the whole correction is about: "here is what you built, here is what it should be
//            like, name the differences and fix them."
//
// Never the whole gallery and never the whole history: §4 is explicit that recreating the context problem is not
// an acceptable way to solve the vision problem, and the measured numbers leave no room for it anyway.

import path from "node:path";
import { mkdirSync } from "node:fs";
import { conceptColumn, fitForVision, type ConceptRegion } from "./image-fit.ts";
import type { DesignBlueprint } from "./blueprint.ts";
import { recordDelivery, recordExclusion, type ReferenceManifest } from "./reference-manifest.ts";

/** Above-the-fold heights: what a visitor sees before scrolling, which is where a design is first judged. */
export const VIEWPORT_HEIGHT: Readonly<Record<string, number>> = Object.freeze({ desktop: 768, tablet: 1024, mobile: 844 });
/** Below these widths a rendered page stops being judgeable; mobile is legitimately narrow. */
const MIN_WIDTH: Readonly<Record<string, number>> = Object.freeze({ desktop: 640, tablet: 560, mobile: 360 });

export interface GalleryRef { id: string; title: string; path: string }
export interface Shot { page: string; viewport: string; path: string }

export interface BuilderVisionPlan {
  /** Exactly what to attach, in order, each labelled for what it is. */
  images: { path: string; label: string }[];
  /** The text that goes with them: what they are and what to do with them. */
  note: string;
  /** For the manifest: which reference/screenshot each attachment came from, and what was done to it. */
  prepared: { id: string; label: string; sentPath: string; sentSha256: string; width: number; height: number; tokens: number; operation: string; concept?: string; note: string }[];
  /** Images that were considered and left out, with the reason. Recorded, never silently dropped. */
  excluded: { id: string; reason: string }[];
}

/** The gallery reference the approved blueprint actually cites, and the concept within it. */
export function approvedReference(blueprint: DesignBlueprint | null, available: readonly GalleryRef[]): { ref: GalleryRef; region: ConceptRegion | null; borrowed: string } | null {
  if (!available.length) return null;
  for (const use of blueprint?.referenceMapping ?? []) {
    const ref = available.find((r) => r.id === use.referenceId);
    if (!ref) continue;
    const region = use.conceptCount && use.conceptCount > 1 ? conceptColumn((use.conceptIndex ?? 1) - 1, use.conceptCount) : null;
    return { ref, region, borrowed: use.borrowed };
  }
  // No blueprint, or it cites nothing available: the first reference is still better than none, and the absence of
  // a concept selection is stated rather than guessed at.
  return { ref: available[0], region: null, borrowed: "" };
}

/**
 * Choose and prepare the images for one builder phase.
 *
 * `budgetTokens` is the whole allowance for images in this phase's requests. It is spent on the comparison first:
 * a repair with the reference but not the rendered page cannot say what is different.
 */
export function planBuilderVision(i: {
  phase: "build" | "repair";
  workDir: string;
  blueprint: DesignBlueprint | null;
  references: readonly GalleryRef[];
  screenshots: readonly Shot[];
  /** The page the repair is aimed at ("index", "services"); the homepage when nothing more specific is known. */
  targetPage?: string | null;
  budgetTokens: number;
}): BuilderVisionPlan {
  const out: BuilderVisionPlan = { images: [], note: "", prepared: [], excluded: [] };
  try { mkdirSync(i.workDir, { recursive: true }); } catch { /* fitForVision reports the failure per image */ }
  let left = Math.max(0, i.budgetTokens);

  const approved = approvedReference(i.blueprint, i.references);
  const lines: string[] = [];

  // ── the rendered page first, in a repair: it is the thing being changed ────────────────────────────────────────
  const rendered: Shot[] = [];
  if (i.phase === "repair" && i.screenshots.length) {
    const page = i.targetPage ?? (i.screenshots.some((s) => s.page === "index") ? "index" : i.screenshots[0].page);
    for (const vp of ["desktop", "mobile"]) {
      const s = i.screenshots.find((x) => x.page === page && x.viewport === vp);
      if (s) rendered.push(s);
    }
  }
  for (const s of rendered) {
    const share = Math.floor(left * (s.viewport === "desktop" ? 0.45 : 0.22));
    const r = fitForVision(s.path, i.workDir, { maxTokens: share, purpose: "viewport", viewportHeight: VIEWPORT_HEIGHT[s.viewport] ?? 768, minWidth: MIN_WIDTH[s.viewport] ?? 640 });
    const id = `render:${s.page}:${s.viewport}`;
    if (r.refused) { out.excluded.push({ id, reason: r.reason }); continue; }
    const label = `YOUR OWN WEBSITE AS IT RENDERS NOW — ${s.page} at ${s.viewport} (${r.to.width}x${r.to.height})`;
    out.images.push({ path: r.to.path, label });
    out.prepared.push({ id, label, sentPath: r.to.path, sentSha256: r.to.sha256, width: r.to.width, height: r.to.height, tokens: r.to.tokens, operation: r.operation, note: r.note });
    left -= r.to.tokens;
  }

  // ── the standard ──────────────────────────────────────────────────────────────────────────────────────────────
  if (approved && left > 0) {
    const r = fitForVision(approved.ref.path, i.workDir, { maxTokens: left, purpose: "overview", region: approved.region ?? undefined });
    if (r.refused) out.excluded.push({ id: approved.ref.id, reason: r.reason });
    else {
      const label = `DESIGN REFERENCE (another studio's work — the standard of craft to reach, NOT this customer's website and NEVER to be copied or published) — ${approved.ref.title}${r.concept ? `, ${r.concept}` : ""}`;
      out.images.push({ path: r.to.path, label });
      out.prepared.push({ id: approved.ref.id, label, sentPath: r.to.path, sentSha256: r.to.sha256, width: r.to.width, height: r.to.height, tokens: r.to.tokens, operation: r.operation, concept: r.concept, note: r.note });
      left -= r.to.tokens;
    }
  } else if (!approved) {
    lines.push("No design reference is available for this build, so there is no visual standard attached: work from the written design specification and the blueprint.");
  }

  // ── what to do with them ──────────────────────────────────────────────────────────────────────────────────────
  if (out.images.length) {
    lines.unshift(
      i.phase === "repair"
        ? "LOOK AT THE IMAGES BELOW BEFORE YOU EDIT ANYTHING. One is the page your code renders right now; one is the design standard it is being measured against."
        : "LOOK AT THE IMAGE BELOW BEFORE YOU EDIT ANYTHING. It is the design standard this website is being built to reach.",
    );
    if (i.phase === "repair" && rendered.length) {
      lines.push(
        "",
        "Name the differences that MATTER before you change anything: composition and section rhythm, the type scale and",
        "its hierarchy, spacing and density, the presence and quality of imagery, and the finish of buttons, cards and",
        "forms. Capitalisation, a label's wording and a two-pixel margin are not what separates these two images.",
        "Then make the smallest set of changes to the responsible stylesheet, markup or assets that closes the biggest",
        "of those differences, and say in .crestmont/agent-report.md which difference you were closing and which file",
        "you changed. The runner re-renders the page afterwards and compares it with this one: a repair that changes no",
        "rendered pixel is recorded as ineffective and does not count.",
      );
    }
    if (approved) {
      lines.push(
        "",
        `The reference is a REFERENCE. Build an original website for this customer that reaches that standard${approved.borrowed ? ` — the approved design takes from it: ${approved.borrowed}` : ""}.`,
        "Do not copy its text, its layout pixel for pixel, or any of its image files. Its images are another studio's and",
        "are not licensed for this website; where the blueprint calls for a photograph, use the customer's own file from",
        "customer-files/ or leave the space reserved and record it in .crestmont/defects.json.",
      );
    }
  }
  out.note = lines.join("\n");
  return out;
}

/** Write a plan's outcome into the manifest, so "the builder saw it" has a file and a hash behind it. */
export function recordBuilderVision(m: ReferenceManifest, plan: BuilderVisionPlan, delivered: readonly { path: string }[], context: string): void {
  const sent = new Set(delivered.map((d) => d.path));
  for (const pr of plan.prepared) {
    if (sent.has(pr.sentPath)) {
      recordDelivery(m, pr.id, { to: "builder", sentPath: pr.sentPath, sentSha256: pr.sentSha256, width: pr.width, height: pr.height, tokens: pr.tokens, operation: pr.operation, concept: pr.concept, note: pr.note, context });
    } else {
      // Prepared but not carried by the request: the provider's own budget dropped it. It was NOT seen.
      recordExclusion(m, pr.id, { to: "builder", reason: "prepared for this request but dropped by the provider's context budget; it did not reach the model", context });
    }
  }
  for (const x of plan.excluded) recordExclusion(m, x.id, { to: "builder", reason: x.reason, context });
}
