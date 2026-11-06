// Joining the browser's measurements to the two schemas that act on them.
//
// `sandbox/frontend-import.mjs` runs in the container and writes `import.json`. It measures and judges nothing.
// This module is the other half: it turns those measurements into a `DesignBaseline` that can be frozen and an
// `InteractionItem[]` that a plan can be checked against, and it runs the comparison after integration work.
//
// The split exists because the measuring half has to be plain JavaScript inside the sandbox image, and the
// deciding half should be typed, unit-tested, and runnable without Docker.

import { readFileSync } from "node:fs";
import path from "node:path";
import { captureBaseline, compareToBaseline } from "./design-lock.ts";
import type { DeclaredChange, DesignBaseline, DesignSignature, DriftReport, Shot, Viewport } from "./design-lock.ts";
import { coverage, declaredChanges } from "./integration-manifest.ts";
import type { Coverage, IntegrationManifest, InteractionItem } from "./integration-manifest.ts";

export const IMPORT_SCHEMA = "crestmont.frontend-import/1";

export interface ImportRoute {
  page: string;
  file: string;
  title: string;
  navs: number;
  navLinks: number;
  stylesheets: number;
  images: number;
  headings: number;
  overflowPx: number;
}

export interface ImportInteraction {
  page: string;
  element: string;
  role: string;
  label: string;
  needsBackend: boolean;
  functional: boolean;
  /** Recorded as a question for the contract rather than inferred as work. */
  undetermined?: boolean;
  kind?: string;
  evidence: string;
  viewports: Viewport[];
  fields?: number;
  fieldNames?: string[];
  action?: string;
  method?: string;
  inputType?: string;
  inForm?: boolean;
  submits?: boolean;
  expandable?: boolean;
  href?: string;
}

export interface ImportReport {
  schema: string;
  root: string;
  at: string;
  routes: ImportRoute[];
  signatures: (DesignSignature & { page: string; viewport: Viewport })[];
  renders: (Shot & { file: string })[];
  states: (Shot & { state: string; file: string })[];
  interactions: ImportInteraction[];
  problems: string[];
  summary: Record<string, unknown>;
}

export class ImportError extends Error {}

/** Read and check an `import.json`. A report this code cannot vouch for is not silently half-used. */
export function readImportReport(dir: string): ImportReport {
  const file = dir.endsWith(".json") ? dir : path.join(dir, "import.json");
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch {
    throw new ImportError(`no import report at ${file}; the extraction step did not run or did not finish`);
  }
  let r: ImportReport;
  try { r = JSON.parse(raw) as ImportReport; } catch {
    throw new ImportError(`the import report at ${file} is not valid JSON`);
  }
  if (r.schema !== IMPORT_SCHEMA) throw new ImportError(`the import report is ${JSON.stringify(r.schema)}; this code reads ${IMPORT_SCHEMA}`);
  if (!Array.isArray(r.signatures) || r.signatures.length === 0) throw new ImportError("the import report measured no pages, so there is no design to freeze");
  if (!Array.isArray(r.renders) || r.renders.length === 0) throw new ImportError("the import report captured no screenshots, so there is no visual baseline");
  return r;
}

/** The interactions a plan is checked against. */
export function inventoryOf(r: ImportReport): InteractionItem[] {
  return r.interactions.map((i) => ({
    page: i.page,
    element: i.element,
    role: i.role,
    // Something already working is not waiting for a backend, whatever its label suggests.
    needsBackend: i.needsBackend && !i.functional,
  }));
}

/**
 * Freeze the approved design from a real import.
 *
 * `approvedBy` is passed in, never defaulted: the whole architecture rests on a person having approved this
 * frontend, and a baseline that cannot name them is not one.
 */
export function baselineFrom(r: ImportReport, o: { artifactSha: string; sourceFingerprint: string | null; approvedBy: string }): DesignBaseline {
  return captureBaseline({
    artifactSha: o.artifactSha,
    sourceFingerprint: o.sourceFingerprint,
    approvedBy: o.approvedBy,
    signatures: r.signatures,
    // The interactive states are evidence beside the resting renders: a design is not only how it sits still.
    renders: [...r.renders.map((s) => ({ page: s.page, viewport: s.viewport, sha: s.sha }))],
    at: r.at,
  });
}

/** Screenshots of interactive states, keyed so a before/after comparison can find its pair. */
export function statesOf(r: ImportReport): Map<string, string> {
  return new Map(r.states.map((s) => [`${s.page}|${s.viewport}|${s.state}`, s.sha]));
}

export interface VerifyResult {
  drift: DriftReport;
  /** Interactive states whose appearance changed, which the resting-state comparison cannot see. */
  stateChanges: { key: string; before: string; after: string }[];
  coverage: Coverage | null;
  /** Pages the manifest said would change. */
  declared: DeclaredChange[];
}

/**
 * Compare a fresh import against the frozen baseline.
 *
 * Two comparisons, because one is not enough: the design lock judges the resting pages, and the interactive
 * states are compared separately. A menu that opens over the content in the wrong colour never appears in a
 * resting screenshot, so without this it would pass.
 */
export function verifyAgainstBaseline(
  baseline: DesignBaseline,
  after: ImportReport,
  o: { manifest?: IntegrationManifest; before?: ImportReport } = {},
): VerifyResult {
  const declared = o.manifest ? declaredChanges(o.manifest) : [];
  const drift = compareToBaseline(baseline, after.signatures, {
    declared,
    renders: after.renders.map((s) => ({ page: s.page, viewport: s.viewport, sha: s.sha })),
  });

  const stateChanges: { key: string; before: string; after: string }[] = [];
  if (o.before) {
    const was = statesOf(o.before);
    for (const [key, sha] of statesOf(after)) {
      const prev = was.get(key);
      if (prev && prev !== sha) stateChanges.push({ key, before: prev, after: sha });
    }
  }

  return {
    drift,
    stateChanges,
    coverage: o.manifest ? coverage(o.manifest, inventoryOf(after)) : null,
    declared,
  };
}

/** The import in words, for the build record. */
export function describeImport(r: ImportReport): string {
  const needing = r.interactions.filter((i) => i.needsBackend && !i.functional);
  const working = r.interactions.filter((i) => i.functional);
  const open = r.interactions.filter((i) => i.undetermined);
  const lines = [
    `${r.routes.length} route(s) at ${[...new Set(r.signatures.map((s) => s.viewport))].join(", ")}: ${r.routes.map((x) => x.page).join(", ")}`,
    `${r.renders.length} baseline screenshot(s) and ${r.states.length} interactive state(s)`,
    `${r.interactions.length} interaction(s): ${working.length} already work without a backend, ${needing.length} need one, ${open.length} undetermined`,
  ];
  for (const i of needing) lines.push(`  needs a backend — ${i.page}/${i.element}: ${i.evidence}`);
  for (const i of open) lines.push(`  undetermined — ${i.page}/${i.element} (${i.kind ?? i.role}): the contract must say whether this shows live data`);
  if (r.problems.length) lines.push(`problems: ${r.problems.join("; ")}`);
  return lines.join("\n");
}

export function describeVerify(v: VerifyResult): string {
  const lines: string[] = [];
  lines.push(v.drift.ok ? `the approved design held across ${v.drift.compared} page view(s)` : `the approved design did NOT hold across ${v.drift.compared} page view(s)`);
  for (const f of v.drift.findings) lines.push(`  ${f.kind} — ${f.page}${f.viewport ? ` @ ${f.viewport}` : ""}${f.aspects.length ? ` [${f.aspects.join(", ")}]` : ""}: ${f.detail}`);
  for (const s of v.stateChanges) lines.push(`  interactive state changed — ${s.key}`);
  if (v.coverage) {
    lines.push(v.coverage.uncovered.length
      ? `  ${v.coverage.uncovered.length} interaction(s) needing a backend are not in the plan: ${v.coverage.uncovered.map((i) => `${i.page}/${i.element}`).join(", ")}`
      : `  every interaction needing a backend is covered (${v.coverage.covered}/${v.coverage.needingBackend})`);
  }
  return lines.join("\n");
}
