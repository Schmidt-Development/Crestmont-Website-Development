// Building the Design Blueprint a section at a time, and keeping the sections that worked.
//
// WHY. The blueprint was one enormous JSON answer after a long inspection session, and that is a brittle shape:
// on bld_dcb3063d445e6f8890d66516 all three attempts produced nothing usable -- one unparseable answer and two
// context overflows -- so the build ran with no blueprint at all and the design phase could not be checked
// against named layouts, exact colours or planned photography. Every attempt started again from nothing, because
// a whole-document answer has no partial success.
//
// Sections change that. Each one is asked for on its own, validated on its own, and kept once it is valid. A
// failure in page composition does not throw away a colour system that was already correct, and a retry corrects
// only what is actually wrong.
//
// WHAT THIS DOES NOT DO. It does not weaken the contract. The sections are assembled into exactly the same
// DesignBlueprint and put through the same `validateBlueprint`; a blueprint missing a required section is
// incomplete and says so rather than passing as complete.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BLUEPRINT_JSON_SCHEMA, BLUEPRINT_SCHEMA, validateBlueprint, type DesignBlueprint } from "./blueprint.ts";

/**
 * The sections, in the order they are generated.
 *
 * The order is not arbitrary: identity first because colour, type and spacing are what every later section refers
 * to; then the components those pages are built from; then the pages themselves; then the assets they need; and
 * the reference mapping last, when there is something concrete to map a reference onto.
 */
export const SECTION_ORDER = ["visualIdentity", "components", "pages", "visualAssets", "referenceMapping"] as const;
export type SectionName = typeof SECTION_ORDER[number];

/** What each section is for, in the words the architect is asked in. */
export const SECTION_PURPOSE: Record<SectionName, string> = {
  visualIdentity: "the brand identity, colour system, typography and spacing: exact hex values, real family names, a type scale with units and weights, and the spacing scale everything else is measured in",
  components: "every component in scope and the appearance of each of its states, so a builder knows what a button, card, field or nav actually looks like when it is hovered, focused, disabled or in error",
  pages: "each page's sections in render order, each with a named layout from the closed list, so composition is executable rather than described",
  visualAssets: "every image the design needs: what it is, where it comes from, and whether it is a photograph, an illustration, a map or a logo — with provenance, because a photograph cannot be invented",
  referenceMapping: "which approved gallery reference each decision borrows from, and which concept within it, so the design can be checked against what was approved",
};

export interface SectionState {
  name: SectionName;
  /** The accepted value, or null while the section is still outstanding. */
  value: unknown | null;
  attempts: number;
  /** Why the last attempt was rejected, for a corrective retry that fixes only this section. */
  problems: string[];
  at: string | null;
}

export interface SectionsFile {
  schema: "crestmont.blueprint-sections/1";
  jobId: string;
  attempt: number;
  /** The design specification these sections were written against; a different one invalidates them. */
  specHash: string;
  sections: SectionState[];
  updatedAt: string;
}

const FILE = "blueprint-sections.json";
const empty = (name: SectionName): SectionState => ({ name, value: null, attempts: 0, problems: [], at: null });

export function sectionsPath(workDir: string): string {
  return path.join(workDir, FILE);
}

/**
 * The sections kept from earlier attempts, or a fresh set.
 *
 * Sections written against a DIFFERENT design specification are discarded rather than reused: a blueprint that
 * half-describes an older design is worse than one that admits it has to start again.
 */
export function loadSections(workDir: string, jobId: string, attempt: number, specHash: string): SectionsFile {
  const p = sectionsPath(workDir);
  const fresh: SectionsFile = {
    schema: "crestmont.blueprint-sections/1", jobId, attempt, specHash,
    sections: SECTION_ORDER.map(empty), updatedAt: new Date().toISOString(),
  };
  if (!existsSync(p)) return fresh;
  try {
    const got = JSON.parse(readFileSync(p, "utf8")) as Partial<SectionsFile>;
    if (got.schema !== "crestmont.blueprint-sections/1" || got.jobId !== jobId || got.specHash !== specHash) return fresh;
    const byName = new Map((got.sections ?? []).map((s) => [s.name, s]));
    return { ...fresh, attempt, sections: SECTION_ORDER.map((n) => byName.get(n) ?? empty(n)) };
  } catch {
    return fresh;
  }
}

export function saveSections(workDir: string, f: SectionsFile): void {
  try {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(sectionsPath(workDir), JSON.stringify({ ...f, updatedAt: new Date().toISOString() }, null, 2));
  } catch { /* the sections are an optimisation; losing the file costs a regeneration, never correctness */ }
}

export const sectionOf = (f: SectionsFile, name: SectionName): SectionState =>
  f.sections.find((s) => s.name === name) ?? empty(name);

/** Sections still to produce, in generation order. */
export function outstanding(f: SectionsFile): SectionName[] {
  return SECTION_ORDER.filter((n) => sectionOf(f, n).value === null);
}

export function recordSection(f: SectionsFile, name: SectionName, value: unknown | null, problems: string[] = []): SectionsFile {
  const next = f.sections.map((s) => s.name === name
    ? { ...s, value: value ?? null, attempts: s.attempts + 1, problems, at: value ? new Date().toISOString() : s.at }
    : s);
  return { ...f, sections: next };
}

/** The JSON schema for one section, taken from the whole-blueprint schema so the two can never drift apart. */
export function schemaForSection(name: SectionName): unknown {
  const props = (BLUEPRINT_JSON_SCHEMA as { properties: Record<string, unknown> }).properties;
  return {
    type: "object", additionalProperties: false,
    required: [name],
    properties: { [name]: props[name] },
  };
}

export interface Assembled {
  ok: boolean;
  blueprint: DesignBlueprint | null;
  /** Everything wrong with the assembled document, from the ONE validator the whole-blueprint path uses. */
  problems: string[];
  missing: SectionName[];
}

/**
 * Put the sections back together and judge the result by the existing contract.
 *
 * Nothing here is relaxed because the document arrived in pieces: a missing section is reported as missing, and
 * the assembled whole goes through `validateBlueprint` exactly as a single-answer blueprint does.
 */
export function assemble(f: SectionsFile, ctx: { sentReferenceIds?: readonly string[]; requiresPhotography?: boolean; expectedRoutes?: readonly string[] } = {}): Assembled {
  const missing = outstanding(f);
  const raw: Record<string, unknown> = { schema: BLUEPRINT_SCHEMA };
  for (const n of SECTION_ORDER) {
    const s = sectionOf(f, n);
    if (s.value !== null) raw[n] = s.value;
  }
  if (missing.length) {
    return { ok: false, blueprint: null, missing, problems: [`the blueprint is incomplete: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} still missing`] };
  }
  const v = validateBlueprint(raw, ctx);
  return { ok: v.ok, blueprint: v.blueprint, problems: v.problems, missing: [] };
}

/**
 * A section's value, unwrapped from whatever the model returned.
 *
 * It is asked for as `{ "visualIdentity": { ... } }` so the schema can be reused verbatim, but models answer with
 * the bare object about as often. Both are accepted; nothing else is.
 */
export function unwrapSection(name: SectionName, raw: unknown): unknown | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (name in o && o[name] !== undefined && o[name] !== null) return o[name];
  // A bare value is fine when it is plainly the section itself rather than a wrapper around something else.
  if (SECTION_ORDER.some((n) => n !== name && n in o)) return null;
  return Array.isArray(raw) || Object.keys(o).length > 0 ? raw : null;
}

/** One line for the build record. */
export function describeSections(f: SectionsFile): string {
  const done = SECTION_ORDER.filter((n) => sectionOf(f, n).value !== null);
  return `${done.length} of ${SECTION_ORDER.length} blueprint section(s) complete${done.length ? `: ${done.join(", ")}` : ""}`
    + (outstanding(f).length ? ` — outstanding: ${outstanding(f).join(", ")}` : "");
}
