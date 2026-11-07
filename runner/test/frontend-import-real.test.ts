// The import pipeline, tested against output a real run actually produced.
//
// `test/fixtures/real-import/` is not hand-written. It came out of `ci/frontend-import-poc.ts` driving real
// Docker: a real npm install through the registry proxy, a real Vite build with no network, and real Chromium
// measuring Summit Haul at desktop, tablet and mobile. Synthetic fixtures prove the code is self-consistent;
// these prove it survives contact with a browser. §17 items 16-20.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { baselineFrom, describeImport, describeVerify, inventoryOf, readImportReport, verifyAgainstBaseline } from "../src/frontend/import.ts";
import type { ImportReport } from "../src/frontend/import.ts";
import type { DesignBaseline } from "../src/frontend/design-lock.ts";
import { coverage, validateManifest } from "../src/frontend/integration-manifest.ts";
import type { IntegrationManifest } from "../src/frontend/integration-manifest.ts";
import { planBuild, staticRoot } from "../src/frontend/build.ts";
import { visualSummary } from "../src/frontend/design-locked-job.ts";

const DIR = path.resolve(import.meta.dirname, "fixtures/real-import");
const load = <T>(name: string): T => JSON.parse(readFileSync(path.join(DIR, name), "utf8")) as T;

const BASE = load<ImportReport>("import-baseline.json");
const AFTER = load<ImportReport>("import-after-integration.json");
const DRIFT = load<ImportReport>("import-after-drift.json");
const BASELINE = load<DesignBaseline>("design-baseline.json");
const MANIFEST = load<IntegrationManifest>("integration-manifest.json");

test("[REAL-001] a real browser run produced three routes at three viewports", () => {
  const r = readImportReport(path.join(DIR, "import-baseline.json"));
  assert.deepEqual(r.routes.map((x) => x.page).sort(), ["index", "quote", "services"]);
  assert.equal(r.signatures.length, 9, "three pages at desktop, tablet and mobile");
  assert.deepEqual([...new Set(r.signatures.map((s) => s.viewport))].sort(), ["desktop", "mobile", "tablet"]);
  assert.equal(r.renders.length, 9, "one baseline screenshot each");
  assert.ok(r.states.length >= 4, `and the interactive states: ${r.states.map((s) => `${s.page}/${s.viewport}/${s.state}`).join(", ")}`);
  assert.ok(r.states.some((s) => s.state === "nav-open"), "an open navigation was captured");
  assert.ok(r.states.some((s) => s.state === "form-focus"), "and a focused form");
  assert.deepEqual(r.problems, [], `the approved frontend rendered cleanly: ${r.problems.join("; ")}`);

  // Every screenshot is a distinct real image.
  const shas = new Set([...r.renders, ...r.states].map((s) => s.sha));
  assert.equal(shas.size, r.renders.length + r.states.length, "no two screenshots are the same file");
  assert.ok([...shas].every((s) => /^[0-9a-f]{64}$/.test(s)));
});

test("[REAL-002] the measured design signature is the real one, not a placeholder", () => {
  const home = BASE.signatures.find((s) => s.page === "index" && s.viewport === "desktop")!;

  // Summit Haul's approved palette, read back out of a real render.
  for (const c of ["rgb(31, 61, 43)", "rgb(217, 131, 36)", "rgb(232, 220, 200)"]) {
    assert.ok(home.palette.includes(c), `${c} is painted on the page; got ${home.palette.join(" ")}`);
  }
  assert.ok(home.fonts.length > 0 && home.fonts.every((f) => f.length > 0), home.fonts.join(","));
  assert.ok(home.typeScale.length >= 5, `a real type scale: ${home.typeScale.join(",")}`);
  assert.ok(home.typeScale.includes(16), "including the body size");
  assert.ok(home.skeleton.length >= 10, `a real structure: ${home.skeleton.length} elements`);
  assert.ok(home.skeleton[0].startsWith("header"), home.skeleton.slice(0, 3).join(" > "));

  // Landmarks with real geometry at the real viewport width.
  const header = home.landmarks.find((l) => l.sel === "header")!;
  assert.equal(header.w, 1366, "the desktop viewport width");
  assert.ok(header.h > 40 && header.h < 200, `a plausible header height: ${header.h}`);
  assert.ok(home.landmarks.some((l) => l.sel === "footer"), home.landmarks.map((l) => l.sel).join(","));
  assert.ok(home.docHeight > 1000, `a real page height: ${home.docHeight}`);

  // Mobile is genuinely a different layout, not the same numbers relabelled.
  const mobile = BASE.signatures.find((s) => s.page === "index" && s.viewport === "mobile")!;
  assert.equal(mobile.landmarks.find((l) => l.sel === "header")!.w, 390);
  assert.notEqual(mobile.docHeight, home.docHeight);
});

test("[REAL-003] the interaction inventory separates what works from what needs a backend", () => {
  // The whole point of probing rather than guessing from labels.
  const needing = BASE.interactions.filter((i) => i.needsBackend && !i.functional);
  assert.equal(needing.length, 1, `exactly one thing needs a backend, got: ${needing.map((i) => i.element).join(", ")}`);
  assert.equal(needing[0].element, "form#quote-request");
  assert.equal(needing[0].page, "quote");
  assert.match(needing[0].evidence, /6 field\(s\)/);

  // The mobile menu toggle is real client-side behaviour and must NOT be on the integration plan. An earlier
  // version of the probe reported it as needing a backend, because it read the DOM before React re-rendered.
  const toggles = BASE.interactions.filter((i) => i.element === "button.nav-toggle");
  assert.equal(toggles.length, 3, "one per page");
  for (const t of toggles) {
    assert.equal(t.functional, true, `${t.page}: ${t.evidence}`);
    assert.equal(t.needsBackend, false);
    assert.match(t.evidence, /aria-expanded false -> true/, "proved by watching the attribute change");
  }

  // The services filter is a <select> that really filters, proved by elements leaving the page.
  const filter = BASE.interactions.find((i) => i.element === "select#job-category")!;
  assert.equal(filter.functional, true);
  assert.match(filter.evidence, /element\(s\) added or removed/);

  // The FAQ disclosures work without any server.
  const faq = BASE.interactions.filter((i) => i.role === "disclosure");
  assert.equal(faq.length, 3);
  assert.ok(faq.every((f) => f.functional && !f.needsBackend), faq.map((f) => f.evidence).join(" | "));

  // Links are navigation, never an integration task.
  assert.ok(BASE.interactions.filter((i) => i.role === "link").every((l) => !l.needsBackend));

  // And the inventory handed to `coverage()` reflects that split.
  const inv = inventoryOf(BASE);
  assert.equal(inv.filter((i) => i.needsBackend).length, 1);
  assert.equal(inv.length, BASE.interactions.length);
});

test("[REAL-004] the frozen baseline matches the one the pipeline wrote, and the plan validates against it", () => {
  const rebuilt = baselineFrom(BASE, {
    artifactSha: BASELINE.artifactSha,
    sourceFingerprint: BASELINE.sourceFingerprint,
    approvedBy: BASELINE.approvedBy,
  });
  assert.equal(rebuilt.fingerprint, BASELINE.fingerprint, "freezing the same import gives the same fingerprint");
  assert.equal(rebuilt.signatures.length, 9);

  // The plan the run produced is tied to these exact fingerprints.
  const checked = validateManifest(MANIFEST, {
    approvedPages: [...new Set(BASE.signatures.map((s) => s.page))],
    designFingerprint: BASELINE.fingerprint,
    artifactSha: BASELINE.artifactSha,
  });
  assert.equal(checked.ok, true, JSON.stringify(checked.problems));

  // And it covers the one interaction that needs a backend.
  const cov = coverage(checked.manifest!, inventoryOf(BASE));
  assert.equal(cov.needingBackend, 1);
  assert.deepEqual(cov.uncovered, []);
  assert.deepEqual(cov.unmatched, [], "the plan points at an element that really exists on the page");

  // A plan written against a different design is refused even though everything else about it is fine.
  const stale = validateManifest({ ...MANIFEST, designFingerprint: "f".repeat(64) }, {
    approvedPages: ["index", "quote", "services"], designFingerprint: BASELINE.fingerprint, artifactSha: BASELINE.artifactSha,
  });
  assert.equal(stale.ok, false);
  assert.ok(stale.problems.some((p) => p.code === "design-mismatch"));
});

test("[REAL-005] connecting the backend did not disturb the approved design", () => {
  // The question the whole architecture exists to answer, on real before-and-after renders.
  const v = verifyAgainstBaseline(BASELINE, AFTER, { manifest: MANIFEST, before: BASE });

  assert.equal(v.drift.ok, true, describeVerify(v));
  assert.equal(v.drift.compared, 9, "every approved page view was compared");
  assert.deepEqual(v.drift.findings.filter((f) => f.kind !== "declared-content"), []);
  assert.deepEqual(v.stateChanges, [], "and the interactive states are unchanged too");
  assert.equal(v.drift.currentFingerprint, BASELINE.fingerprint, "the design is literally the same design");
  assert.match(describeVerify(v), /the approved design held across 9 page view/);

  // The site still has the same routes and the same controls afterwards.
  assert.deepEqual(AFTER.routes.map((r) => r.page).sort(), BASE.routes.map((r) => r.page).sort());
  assert.equal(AFTER.interactions.length, BASE.interactions.length);
});

test("[REAL-006] one changed CSS custom property is caught on every page and every viewport", () => {
  // The lock has to be shown to bite, or [REAL-005] proves nothing. `--amber: #d98324 -> #007aff` and nothing else.
  const v = verifyAgainstBaseline(BASELINE, DRIFT, { manifest: MANIFEST, before: BASE });

  assert.equal(v.drift.ok, false);
  const drifted = v.drift.findings.filter((f) => f.kind === "design-drift");
  assert.equal(drifted.length, 9, "all three pages at all three viewports");
  assert.ok(drifted.every((f) => f.aspects.includes("palette")), drifted.map((f) => f.aspects.join("+")).join(" | "));

  // It names the colour that should not be there and the approved one that went missing.
  for (const f of drifted) {
    assert.match(f.detail, /rgb\(0, 122, 255\)/, f.detail);
    assert.match(f.detail, /rgb\(217, 131, 36\)/, f.detail);
  }
  assert.notEqual(v.drift.currentFingerprint, BASELINE.fingerprint);

  // And the interactive states moved as well, which the resting comparison alone would not have shown.
  assert.ok(v.stateChanges.length >= 4, `${v.stateChanges.length} interactive state(s) changed`);
  assert.ok(v.stateChanges.some((s) => s.key.includes("nav-open")));

  // A declaration does not excuse it: the manifest declared the quote page as a content change, and the quote
  // page is still reported as design drift.
  assert.ok(drifted.some((f) => f.page === "quote"), "a content declaration cannot authorise a restyle");

  // The SUMMARY has to carry that detail, because it is what a person reads and what the repair brief is built
  // from. It used to print `${page} [${aspects}]` alone: the Northgate run reported "staff [palette, skeleton]"
  // three times for a build whose rewrite had deleted three approved summary cards, and neither the operator nor
  // the model was told which elements were gone. Two repair cycles then changed nothing on this gate.
  const summary = visualSummary(drifted, v.stateChanges.length);
  assert.match(summary, /9 drift finding\(s\)/);
  assert.match(summary, /interactive state\(s\) changed/);
  assert.match(summary, /rgb\(0, 122, 255\)/, "the colour that should not be there is named in the summary");
  assert.match(summary, /rgb\(217, 131, 36\)/, "and the approved one that went missing");
  assert.match(summary, /and 6 more/, "with the rest counted rather than dropped silently");
});

test("[REAL-010] the summary names components that were removed, not just the aspect that moved", () => {
  // A structural loss is the case the Northgate run hit: the approved page keeps its palette only because the
  // elements carrying those colours exist. Delete them and both aspects move at once, which is precisely the
  // signal "[palette, skeleton]" on its own cannot distinguish from a restyle.
  const summary = visualSummary([{
    kind: "design-drift", page: "staff", viewport: "desktop", aspects: ["palette", "skeleton"],
    detail: "approved colours no longer painted: rgb(138, 90, 18), rgb(29, 106, 79); structure changed: 4 element(s) gone (h3, h3, h3, h2), 0 added",
  }], 1);
  assert.match(summary, /staff at desktop/, "the page and the viewport");
  assert.match(summary, /4 element\(s\) gone/, "and that components were removed");
  assert.match(summary, /rgb\(138, 90, 18\)/, "and which approved colours went with them");
});

test("[REAL-007] a malformed or missing report is refused rather than half-used", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "import-bad-"));
  const write = (name: string, body: string) => { const p = path.join(tmp, name); writeFileSync(p, body); return p; };

  assert.throws(() => readImportReport(path.join(DIR, "does-not-exist")), /no import report at/);
  assert.throws(() => readImportReport(write("a.json", "{ not json,")), /not valid JSON/);

  // A report from a later version of the instrument is refused, not guessed at: the shape this code reads from
  // it could mean something different there.
  assert.throws(() => readImportReport(write("b.json", JSON.stringify({ ...BASE, schema: "crestmont.frontend-import/2" }))), /this code reads crestmont\.frontend-import\/1/);

  // A run that measured nothing, or captured nothing, has no baseline in it — and must not produce an empty one.
  assert.throws(() => readImportReport(write("c.json", JSON.stringify({ ...BASE, signatures: [] }))), /measured no pages/);
  assert.throws(() => readImportReport(write("d.json", JSON.stringify({ ...BASE, renders: [] }))), /no visual baseline/);

  assert.throws(() => baselineFrom({ ...BASE, signatures: [] }, { artifactSha: "a", sourceFingerprint: null, approvedBy: "Founder" }), /at least one measured page/);
  assert.throws(() => baselineFrom(BASE, { artifactSha: "a", sourceFingerprint: null, approvedBy: "" }), /who approved/);
});

test("[REAL-008] the build plan reads the real project, and a static site needs no build at all", () => {
  const fixture = path.resolve(import.meta.dirname, "fixtures/summit-haul-frontend");
  const plan = planBuild(fixture, "vite");
  assert.ok(!("error" in plan), JSON.stringify(plan));
  if ("error" in plan) return;

  assert.equal(plan.needsInstall, true);
  assert.deepEqual(plan.buildCommand, ["npm", "run", "build"], "the project's own build script, not one invented for it");
  assert.equal(plan.expectOutput, "dist");
  assert.match(plan.rationale, /vite build/);

  // A static site is already the deliverable.
  const staticPlan = planBuild(fixture, "static");
  assert.ok(!("error" in staticPlan));
  if (!("error" in staticPlan)) {
    assert.equal(staticPlan.buildCommand, null, "nothing to build");
    assert.equal(staticPlan.needsInstall, false);
  }
  assert.equal(staticRoot(fixture), "", "index.html is at the project root");

  // A React project with no build script cannot be built, and says so rather than guessing a command.
  const nowhere = planBuild(path.resolve(import.meta.dirname, "fixtures"), "react");
  assert.ok("error" in nowhere);
  if ("error" in nowhere) assert.match(nowhere.error, /package\.json|build/);
});

test("[REAL-009] the import reads as a plain account of what was found", () => {
  const text = describeImport(BASE);
  assert.match(text, /3 route\(s\) at desktop, tablet, mobile/);
  assert.match(text, /9 baseline screenshot\(s\)/);
  assert.match(text, /28 already work without a backend, 1 need one/);
  assert.match(text, /needs a backend — quote\/form#quote-request/);
});
