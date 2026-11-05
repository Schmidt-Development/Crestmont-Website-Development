// Did the repair actually change the website? (V5 §9 "no-op protection".)
//
// Measured on bld_10e2c6007686faee0ab64d45: nine stored revisions, nine "repair" cycles, and across all of them
// EXACTLY ONE rendered change -- index-desktop.png hashed 41df475aa1 for revisions 1-6 and 12e7cbc1ed for 7-9,
// with revisions 2-6 sharing a single commit. The loop reported nine repairs. The visitor saw one. Nothing in the
// orchestrator compared the result of a repair with the state before it, so a cycle that edited nothing, or edited
// only files that render identically, was indistinguishable from a cycle that fixed the design.
//
// This module makes that comparison deterministic and observable:
//   - the RENDER fingerprint is the sha256 of each screenshot the browser check produced, per page and viewport;
//   - the SOURCE fingerprint is the sha256 of the rendering source itself (markup, styles, scripts, media), which
//     is NOT the commit hash: every cycle commits its evidence, so commits always differ and prove nothing.
//
// It decides nothing about quality -- a cycle that changes pixels can still be bad work. It answers only the
// narrower question the repair loop was never asking: did anything change at all.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export type RenderShot = { page: string; viewport: "desktop" | "mobile"; sha: string };

export type CycleFingerprint = {
  cycle: number;
  /** HEAD at the time of measurement, for the record only; never used to decide that source changed. */
  commit: string | null;
  /** sha256 over the rendering source, or null when no source could be read. */
  source: string | null;
  /** How many files that hash covers, so "null source" and "empty project" are distinguishable. */
  sourceFiles: number;
  /** One entry per screenshot, so a change can be attributed to the page and viewport that changed. */
  render: RenderShot[];
  /** The visual defects this cycle was told to fix, normalised and sorted. */
  targeted: string[];
  /** The active phase's visual points when the cycle closed, for "the targeted defects are unchanged". */
  visualPoints: number | null;
};

export type CycleEffect = {
  /**
   * "effective"   - the repair changed the rendering source or the rendered pixels;
   * "ineffective" - it changed neither, or it reproduced a state an earlier cycle already produced;
   * "unknown"     - there is nothing comparable yet (first cycle), or no render evidence on either side.
   */
  verdict: "effective" | "ineffective" | "unknown";
  sourceChanged: boolean;
  renderChanged: boolean;
  /** Pages whose rendered bytes changed, "page (viewport)". */
  changedPages: string[];
  /** The earlier cycle whose rendering this one reproduces exactly, when it is a repeat. */
  repeatOfCycle: number | null;
  /** The visual score did not move either. */
  pointsUnchanged: boolean;
  /** Plain-language explanation, safe to show the Founder and to put in a prompt. */
  reason: string;
};

/** Files that decide what a visitor sees. `.crestmont/` is excluded on purpose: it is evidence, not the website. */
const RENDER_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".json", ".md"]);
const SKIP_DIR = new Set([".git", ".crestmont", "node_modules", "dist", "build", ".next", ".cache", "coverage", ".wrangler"]);
/** Roots searched for rendering source, in order; missing roots are skipped. */
const SOURCE_ROOTS = ["public", "src", "views", "templates", "pages", "styles", "assets", "static"];
const MAX_SOURCE_FILES = 4000;

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

function walk(dir: string, rel: string, out: string[]): void {
  if (out.length >= MAX_SOURCE_FILES) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries.sort()) {
    if (out.length >= MAX_SOURCE_FILES) return;
    if (name.startsWith(".") && name !== ".well-known") continue;
    const abs = path.join(dir, name);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) { if (!SKIP_DIR.has(name)) walk(abs, `${rel}${name}/`, out); continue; }
    if (!RENDER_EXT.has(path.extname(name).toLowerCase())) continue;
    out.push(`${rel}${name}`);
  }
}

/**
 * sha256 over the rendering source: the sorted list of (relative path, content sha256).
 * A rename, a deletion and a one-character style change all move this hash; an evidence commit does not.
 */
export function sourceFingerprint(repo: string): { sha: string | null; files: number } {
  const files: string[] = [];
  for (const root of SOURCE_ROOTS) {
    const abs = path.join(repo, root);
    if (existsSync(abs)) walk(abs, `${root}/`, files);
  }
  // A single-page starter may keep index.html at the repo root.
  for (const name of ["index.html", "index.htm", "style.css", "styles.css", "app.js", "main.js"]) {
    if (existsSync(path.join(repo, name))) files.push(name);
  }
  if (!files.length) return { sha: null, files: 0 };
  const h = createHash("sha256");
  for (const rel of [...new Set(files)].sort()) {
    let body: Buffer;
    try { body = readFileSync(path.join(repo, rel)); } catch { continue; }
    h.update(rel).update("\0").update(sha256(body)).update("\n");
  }
  return { sha: h.digest("hex"), files: new Set(files).size };
}

/** sha256 of every screenshot the browser check produced, per page and viewport. */
export function renderFingerprint(repo: string): RenderShot[] {
  const dir = path.join(repo, ".crestmont", "screenshots");
  if (!existsSync(dir)) return [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: RenderShot[] = [];
  for (const f of names.filter((n) => /-(desktop|mobile)\.png$/.test(n)).sort().slice(0, 200)) {
    let body: Buffer;
    try { body = readFileSync(path.join(dir, f)); } catch { continue; }
    out.push({ page: f.replace(/-(desktop|mobile)\.png$/, ""), viewport: f.endsWith("-mobile.png") ? "mobile" : "desktop", sha: sha256(body) });
  }
  return out;
}

const normDefect = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
const renderKey = (r: RenderShot[]): string => r.map((x) => `${x.page}|${x.viewport}|${x.sha}`).sort().join("\n");

export function fingerprintCycle(o: { repo: string; cycle: number; commit: string | null; targeted: string[]; visualPoints: number | null }): CycleFingerprint {
  const src = sourceFingerprint(o.repo);
  return {
    cycle: o.cycle, commit: o.commit, source: src.sha, sourceFiles: src.files,
    render: renderFingerprint(o.repo),
    targeted: [...new Set(o.targeted.map(normDefect).filter(Boolean))].sort().slice(0, 40),
    visualPoints: o.visualPoints,
  };
}

/**
 * Compare the state a repair produced with the state before it.
 *
 * `history` is every earlier fingerprint, so a cycle that reverts the website to a rendering an earlier cycle
 * already produced is reported as a repeat -- which is how "the model keeps making and unmaking the same edit"
 * looks from the outside, and the loop used to count both halves of it as repairs.
 */
export function classifyEffect(prev: CycleFingerprint | null, now: CycleFingerprint, history: CycleFingerprint[] = []): CycleEffect {
  if (!prev) return { verdict: "unknown", sourceChanged: false, renderChanged: false, changedPages: [], repeatOfCycle: null, pointsUnchanged: false, reason: `cycle ${now.cycle} is the first measured state of this build; there is nothing before it to compare with` };
  const sourceChanged = prev.source !== now.source || prev.sourceFiles !== now.sourceFiles;
  const haveRender = prev.render.length > 0 && now.render.length > 0;
  const prevBy = new Map(prev.render.map((r) => [`${r.page}|${r.viewport}`, r.sha]));
  const nowBy = new Map(now.render.map((r) => [`${r.page}|${r.viewport}`, r.sha]));
  const changedPages: string[] = [];
  for (const [k, sha] of nowBy) { const before = prevBy.get(k); if (before === undefined || before !== sha) changedPages.push(`${k.split("|")[0]} (${k.split("|")[1]})`); }
  for (const k of prevBy.keys()) if (!nowBy.has(k)) changedPages.push(`${k.split("|")[0]} (${k.split("|")[1]}, no longer rendered)`);
  const renderChanged = changedPages.length > 0;
  const pointsUnchanged = prev.visualPoints !== null && now.visualPoints !== null && prev.visualPoints === now.visualPoints;

  // A rendering an earlier cycle already produced: the repair undid itself, or re-did an edit that was reverted.
  const key = renderKey(now.render);
  let repeatOfCycle: number | null = null;
  if (now.render.length) for (const h of history) if (h.cycle !== now.cycle && h.cycle !== prev.cycle && renderKey(h.render) === key) { repeatOfCycle = h.cycle; break; }

  if (!haveRender && !sourceChanged) {
    return { verdict: "unknown", sourceChanged, renderChanged, changedPages, repeatOfCycle, pointsUnchanged,
      reason: `cycle ${now.cycle}: no rendering source change, and there are no screenshots on ${prev.render.length ? "this" : "the previous"} side to compare, so the effect of the repair cannot be measured` };
  }
  if (!sourceChanged && !renderChanged) {
    return { verdict: "ineffective", sourceChanged, renderChanged, changedPages, repeatOfCycle, pointsUnchanged,
      reason: `cycle ${now.cycle} changed nothing a visitor can see: the rendering source hashes identically to cycle ${prev.cycle}${haveRender ? ` and all ${now.render.length} screenshots are byte-identical` : ""}${pointsUnchanged ? `, and the visual score stayed at ${now.visualPoints}` : ""}` };
  }
  if (sourceChanged && !renderChanged && haveRender) {
    return { verdict: "ineffective", sourceChanged, renderChanged, changedPages, repeatOfCycle, pointsUnchanged,
      reason: `cycle ${now.cycle} edited the source but changed no rendered pixel: all ${now.render.length} screenshots are byte-identical to cycle ${prev.cycle}, so whatever was edited does not reach the pages that were measured` };
  }
  if (repeatOfCycle !== null) {
    return { verdict: "ineffective", sourceChanged, renderChanged, changedPages, repeatOfCycle, pointsUnchanged,
      reason: `cycle ${now.cycle} rendered exactly what cycle ${repeatOfCycle} already rendered: the repair cycles are undoing and redoing the same change rather than making progress` };
  }
  return { verdict: "effective", sourceChanged, renderChanged, changedPages, repeatOfCycle, pointsUnchanged,
    reason: renderChanged
      ? `cycle ${now.cycle} changed the rendering of ${changedPages.length} screenshot(s): ${changedPages.slice(0, 6).join(", ")}${changedPages.length > 6 ? `, +${changedPages.length - 6} more` : ""}`
      : `cycle ${now.cycle} changed the rendering source; there are no screenshots to confirm the rendered result` };
}

/** How the loop should answer N ineffective repair cycles in a row. */
export const DEFAULT_NOOP = { escalateAt: 2, stopAt: 4 } as const;

export function noopVerdict(consecutive: number, limits: { escalateAt: number; stopAt: number } = DEFAULT_NOOP): "ok" | "escalate" | "stop" {
  if (consecutive >= limits.stopAt) return "stop";
  if (consecutive >= limits.escalateAt) return "escalate";
  return "ok";
}

/**
 * What the next repair prompt must say, so the builder is told the observed fact rather than being asked the same
 * thing again in the same words. Returns null when the previous repair did have an effect.
 */
export function ineffectiveFeedback(effect: CycleEffect | null, o: { consecutive: number; targeted: string[] }): string | null {
  if (!effect || effect.verdict !== "ineffective") return null;
  const lines = [
    `MEASURED FACT about your previous repair: it did not change the website.`,
    effect.reason.replace(/^cycle \d+ /, "That cycle "),
  ];
  if (effect.repeatOfCycle !== null) lines.push(`This is the second time this exact rendering has been produced, so the edit is being undone and redone. Do not make that edit again.`);
  if (o.consecutive >= 2) lines.push(`${o.consecutive} repair cycles in a row have now changed nothing a visitor can see. Repeating the same approach is not an option.`);
  lines.push(
    `Before you edit anything, find out WHY the previous edit had no effect. The likely causes, in order:`,
    `1. you edited a file that is not the one being served (check which file the page at the measured path actually loads);`,
    `2. your CSS is overridden by a later or more specific rule, or sits in a stylesheet the page does not link;`,
    `3. you edited a template or component that is not used by the pages that were measured;`,
    `4. your change is behind a build step that did not run.`,
    `Prove the cause first (read the served HTML and the stylesheets it links, in that order), then make ONE change that must visibly alter the page, and say in your report which file you changed and which rendered element it changes.`,
  );
  if (o.targeted.length) lines.push(`The defects still outstanding are: ${o.targeted.slice(0, 8).join("; ")}`);
  return lines.join("\n");
}
