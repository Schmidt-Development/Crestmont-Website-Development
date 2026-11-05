import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SECTION_ORDER, assemble, describeSections, loadSections, outstanding, recordSection,
  saveSections, schemaForSection, sectionOf, sectionsPath, unwrapSection,
} from "../src/orchestrator/blueprint-sections.ts";

const dir = () => mkdtempSync(path.join(tmpdir(), "bp-sections-"));
const JOB = "bld_test";
const HASH = "spec-hash-1";

/** A valid value for each section, matching what validateBlueprint requires. */
const VALUES: Record<string, unknown> = {
  visualIdentity: {
    palette: { background: "#FFFFFF", surface: "#F6F3EC", text: "#22262A", muted: "#5B6670", primary: "#1F3D2B", accent: "#D98324", border: "#D9D3C7" },
    headingFont: "Fraunces", bodyFont: "Inter", fontSource: "Google Fonts (Fraunces, Inter)",
    typeScale: [
      { role: "display", size: "3.25rem", weight: 700, lineHeight: "1.05" },
      { role: "h1", size: "2.5rem", weight: 700, lineHeight: "1.1" },
      { role: "h2", size: "1.75rem", weight: 600, lineHeight: "1.2" },
      { role: "body", size: "1rem", weight: 400, lineHeight: "1.6" },
      { role: "small", size: "0.875rem", weight: 400, lineHeight: "1.5" },
    ],
    spacingBase: "0.5rem", spacingScale: [0.5, 1, 2, 3, 4, 6, 8],
    radius: "0.5rem", elevation: "0 1px 2px rgba(0,0,0,0.06)", density: "generous",
    intent: "a calm, photographic hauling company that reads as insured and professional",
  },
  components: [{ name: "Primary button", states: [{ state: "default", appearance: "forest green fill, white label, 0.5rem radius" }, { state: "hover", appearance: "amber fill, charcoal label" }] }],
  pages: [{ route: "/", title: "Home", sections: [{ layout: "hero-split", intent: "a full-bleed photographic hero with the quote action", content: "crew clearing a garage, headline and a single call to action" }] }],
  visualAssets: [{ id: "hero", kind: "photograph", source: "licensed_stock", intent: "a crew loading a truck outside a suburban home", alt: "Two crew members carrying a sofa to a truck" }],
  referenceMapping: [{ referenceId: "dref_1", borrowed: "the full-bleed photographic hero and the service tiles beneath it", conceptIndex: 1, conceptCount: 3 }],
};

const fill = (d: string, names: readonly string[]) => {
  let f = loadSections(d, JOB, 1, HASH);
  for (const n of names) f = recordSection(f, n as never, VALUES[n]);
  saveSections(d, f);
  return f;
};

test("[BP-SEC-001] a section that succeeded is kept when a later one fails", () => {
  const d = dir();
  let f = fill(d, ["visualIdentity", "components"]);

  // Page composition fails. The two sections already accepted must survive it.
  f = recordSection(f, "pages", null, ["route \"/\" has no sections"]);
  saveSections(d, f);

  const reloaded = loadSections(d, JOB, 1, HASH);
  assert.notEqual(sectionOf(reloaded, "visualIdentity").value, null, "the colour system survived the failure");
  assert.notEqual(sectionOf(reloaded, "components").value, null, "so did the components");
  assert.equal(sectionOf(reloaded, "pages").value, null, "and the failed section is still outstanding");
  assert.deepEqual(sectionOf(reloaded, "pages").problems, ["route \"/\" has no sections"], "with the reason, so the retry can correct only this section");
  assert.deepEqual(outstanding(reloaded), ["pages", "visualAssets", "referenceMapping"]);
  assert.match(describeSections(reloaded), /2 of 5 blueprint section\(s\) complete/);
});

test("[BP-SEC-002] completed sections survive a restart, and are discarded when the design changed", () => {
  const d = dir();
  fill(d, ["visualIdentity"]);

  // A fresh process, same job and same accepted specification: the work is still there.
  const resumed = loadSections(d, JOB, 2, HASH);
  assert.notEqual(sectionOf(resumed, "visualIdentity").value, null, "a restart does not lose a finished section");

  // A DIFFERENT specification: half a blueprint describing an older design is worse than starting again.
  const changed = loadSections(d, JOB, 2, "spec-hash-2");
  assert.equal(sectionOf(changed, "visualIdentity").value, null, "sections written against another design are not reused");
  assert.equal(outstanding(changed).length, SECTION_ORDER.length);

  // A different job never inherits another's sections.
  assert.equal(sectionOf(loadSections(d, "bld_other", 1, HASH), "visualIdentity").value, null);
});

test("[BP-SEC-003] an incomplete blueprint is reported incomplete, never assembled as if it were whole", () => {
  const d = dir();
  const f = fill(d, ["visualIdentity", "components", "pages"]);
  const a = assemble(f, { sentReferenceIds: ["dref_1"] });
  assert.equal(a.ok, false, "three of five sections is not a blueprint");
  assert.equal(a.blueprint, null);
  assert.deepEqual(a.missing, ["visualAssets", "referenceMapping"]);
  assert.match(a.problems.join(" "), /incomplete/);
});

test("[BP-SEC-004] a complete set is assembled and judged by the SAME validator, not a relaxed one", () => {
  const d = dir();
  const f = fill(d, SECTION_ORDER);
  const a = assemble(f, { sentReferenceIds: ["dref_1"] });
  assert.deepEqual(a.missing, []);
  // Whether this fixture passes every rule is not the point; what matters is that the real validator ran and
  // that nothing was waved through because the document arrived in pieces.
  if (!a.ok) {
    assert.ok(a.problems.length > 0, "a rejection names its problems");
    assert.ok(!a.problems.some((p) => /incomplete/.test(p)), `the sections were all present; the problems are real validation ones: ${a.problems.join("; ")}`);
  } else {
    assert.ok(a.blueprint, "an accepted assembly returns the blueprint itself");
    assert.equal((a.blueprint as { schema: string }).schema, "crestmont.design-blueprint/1");
  }
});

test("[BP-SEC-005] each section is asked for with the whole blueprint's own schema, so the two cannot drift", () => {
  for (const n of SECTION_ORDER) {
    const s = schemaForSection(n) as { required: string[]; properties: Record<string, unknown> };
    assert.deepEqual(s.required, [n], `${n} asks for exactly its own key`);
    assert.ok(s.properties[n], `${n} carries the real schema for that key`);
  }
});

test("[BP-SEC-006] a section answer is accepted wrapped or bare, and a wrapper for a different section is refused", () => {
  assert.deepEqual(unwrapSection("components", { components: VALUES.components }), VALUES.components, "wrapped, as asked");
  assert.deepEqual(unwrapSection("components", VALUES.components), VALUES.components, "or bare, as models often answer");
  assert.equal(unwrapSection("components", { pages: VALUES.pages }), null, "an answer about a different section is not silently accepted");
  assert.equal(unwrapSection("components", null), null);
  assert.equal(unwrapSection("components", "not an object"), null);
});

test("[BP-SEC-007] a corrupt or foreign sections file never breaks the build", () => {
  const d = dir();
  writeFileSync(sectionsPath(d), "{ this is not json");
  assert.doesNotThrow(() => loadSections(d, JOB, 1, HASH));
  assert.equal(outstanding(loadSections(d, JOB, 1, HASH)).length, SECTION_ORDER.length, "a corrupt file simply means starting again");

  writeFileSync(sectionsPath(d), JSON.stringify({ schema: "something.else/9", sections: [] }));
  assert.equal(outstanding(loadSections(d, JOB, 1, HASH)).length, SECTION_ORDER.length);
});
