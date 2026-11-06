// The approved design holding, or not, while the backend is wired in.
//
// The rule these tests pin down: real data arriving is allowed and expected; restyling the Founder's design is
// not. A lock that failed every successful integration would be switched off in a day, and a lock that passed a
// font swap would be worthless, so both halves are tested together. §17 items 6-10.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOLERANCE, baselineFingerprint, captureBaseline, compareToBaseline, describeDrift, freezeRow, signatureHash,
} from "../src/frontend/design-lock.ts";
import type { DesignSignature } from "../src/frontend/design-lock.ts";
import type { RenderShot } from "../src/orchestrator/repair-effect.ts";

/** Summit Haul's palette, since it is the design this architecture was written in response to. */
const sig = (over: Partial<DesignSignature> = {}): DesignSignature => ({
  page: "index",
  viewport: "desktop",
  skeleton: ["header.nav", "main.stack", "section.hero", "section.services", "section.quote", "footer.foot"],
  palette: ["rgb(31, 61, 43)", "rgb(232, 220, 200)", "rgb(217, 131, 36)", "rgb(255, 255, 255)"],
  fonts: ["Barlow Condensed", "Inter"],
  typeScale: [14, 16, 18, 24, 40, 64],
  landmarks: [
    { sel: "header", x: 0, y: 0, w: 1440, h: 88 },
    { sel: "main", x: 0, y: 88, w: 1440, h: 3200 },
    { sel: "footer", x: 0, y: 3288, w: 1440, h: 240 },
  ],
  docHeight: 3528,
  ...over,
});

const shot = (page: string, viewport: "desktop" | "mobile", sha: string): RenderShot => ({ page, viewport, sha });

const base = (signatures = [sig()], renders = [shot("index", "desktop", "aaa")]) =>
  captureBaseline({ artifactSha: "art_1", sourceFingerprint: "src_1", signatures, renders, approvedBy: "Founder (Noah)", at: "2026-11-05T00:00:00.000Z" });

test("[DL-001] a baseline names one exact design, and will not be captured without an approver", () => {
  const b = base();
  assert.equal(b.fingerprint.length, 64);
  assert.equal(b.approvedBy, "Founder (Noah)");
  assert.equal(b.artifactSha, "art_1");

  // The same design measured again is the same fingerprint, whatever order the pages came back in.
  const a = sig({ page: "index" });
  const c = sig({ page: "contact", viewport: "mobile" });
  assert.equal(baselineFingerprint([a, c]), baselineFingerprint([c, a]), "page order is not part of the design");

  // A restyle is a different design.
  assert.notEqual(signatureHash(sig()), signatureHash(sig({ palette: [...sig().palette, "rgb(255, 0, 0)"] })));

  // A baseline that cannot say who approved it, or that measured nothing, is not a baseline.
  assert.throws(() => captureBaseline({ artifactSha: "a", sourceFingerprint: null, signatures: [sig()], approvedBy: "  " }), /who approved/);
  assert.throws(() => captureBaseline({ artifactSha: "a", sourceFingerprint: null, signatures: [], approvedBy: "Founder" }), /at least one measured page/);
});

test("[DL-002] real data replacing placeholder content passes when the manifest declared it", () => {
  const b = base();
  // The services page now lists eight real services from the database instead of three typed ones: the section is
  // taller, the pixels differ, and NONE of the locked aspects moved.
  const after = sig({
    landmarks: [
      { sel: "header", x: 0, y: 0, w: 1440, h: 88 },
      { sel: "main", x: 0, y: 88, w: 1440, h: 4000 },
      { sel: "footer", x: 0, y: 4088, w: 1440, h: 240 },
    ],
    docHeight: 4328,
  });

  const r = compareToBaseline(b, [after], {
    renders: [shot("index", "desktop", "bbb")],
    declared: [{ page: "index", expect: "content", reason: "services are read from the database" }],
  });

  assert.equal(r.ok, true, describeDrift(r));
  assert.equal(r.compared, 1);
  assert.deepEqual(r.findings.map((f) => f.kind), ["declared-content"]);
  assert.match(describeDrift(r), /the approved design is intact across 1 page view/);
  // A landmark growing taller to hold real rows is content. Its y moving because the one above it grew is too.
  assert.ok(!r.findings.some((f) => f.aspects.includes("layout")), "a section growing to fit real data is not a layout change");
});

test("[DL-003] the same change with nothing declared is reported, not waved through", () => {
  const b = base();
  const r = compareToBaseline(b, [sig()], { renders: [shot("index", "desktop", "bbb")] });

  assert.equal(r.ok, false);
  assert.deepEqual(r.findings.map((f) => f.kind), ["undeclared-content"]);
  assert.match(r.findings[0].detail, /nothing in the integration manifest said this page would change/);

  // "expect: none" is a declaration that the page must NOT change, so a change there is still a finding.
  const pinned = compareToBaseline(b, [sig()], { renders: [shot("index", "desktop", "bbb")], declared: [{ page: "index", expect: "none" }] });
  assert.equal(pinned.ok, false);
  assert.equal(pinned.findings[0].kind, "undeclared-content");

  // And with no rendering change at all there is nothing to report.
  const still = compareToBaseline(b, [sig()], { renders: [shot("index", "desktop", "aaa")] });
  assert.equal(still.ok, true);
  assert.deepEqual(still.findings, []);
});

test("[DL-004] a declaration cannot authorise restyling the Founder's design", () => {
  const b = base();
  // The integrator restyled the call-to-action and declared the page as a content change.
  const restyled = sig({ palette: ["rgb(31, 61, 43)", "rgb(232, 220, 200)", "rgb(0, 122, 255)", "rgb(255, 255, 255)"] });

  const r = compareToBaseline(b, [restyled], {
    renders: [shot("index", "desktop", "bbb")],
    declared: [{ page: "index", expect: "content", reason: "wired up the quote form" }],
  });

  assert.equal(r.ok, false, "a content declaration does not cover a palette change");
  assert.equal(r.findings[0].kind, "design-drift");
  assert.deepEqual(r.findings[0].aspects, ["palette"]);
  assert.match(r.findings[0].detail, /rgb\(0, 122, 255\)/, "the colour that should not be there is named");
  assert.match(r.findings[0].detail, /rgb\(217, 131, 36\)/, "and the approved colour that went missing");
  assert.match(describeDrift(r), /design-drift/);
});

test("[DL-005] each locked aspect is detected and named separately", () => {
  const b = base();
  const only = (s: DesignSignature) => {
    const r = compareToBaseline(b, [s], { renders: [shot("index", "desktop", "bbb")] });
    assert.equal(r.ok, false);
    assert.equal(r.findings[0].kind, "design-drift");
    return r.findings[0];
  };

  assert.deepEqual(only(sig({ fonts: ["Inter", "Roboto"] })).aspects, ["fonts"]);
  assert.match(only(sig({ fonts: ["Inter", "Roboto"] })).detail, /Barlow Condensed/);

  assert.deepEqual(only(sig({ typeScale: [14, 16, 18, 21, 24, 40, 64] })).aspects, ["type scale"], "a size that is not in the approved scale");

  const dropped = only(sig({ skeleton: ["header.nav", "main.stack", "section.hero", "section.services", "footer.foot"] }));
  assert.deepEqual(dropped.aspects, ["skeleton"]);
  assert.match(dropped.detail, /section\.quote/, "the section that disappeared is named");

  const reordered = only(sig({ skeleton: ["header.nav", "main.stack", "section.services", "section.hero", "section.quote", "footer.foot"] }));
  assert.deepEqual(reordered.aspects, ["skeleton"]);
  assert.match(reordered.detail, /different order/, "the same sections in the wrong order is still a design change");

  const shoved = only(sig({
    landmarks: [
      { sel: "header", x: 0, y: 0, w: 1440, h: 88 },
      { sel: "main", x: 240, y: 88, w: 960, h: 3200 },
      { sel: "footer", x: 0, y: 3288, w: 1440, h: 240 },
    ],
  }));
  assert.deepEqual(shoved.aspects, ["layout"]);
  assert.match(shoved.detail, /main/, "the landmark that moved is named");

  const gone = only(sig({ landmarks: sig().landmarks.filter((l) => l.sel !== "footer") }));
  assert.deepEqual(gone.aspects, ["layout"]);
  assert.match(gone.detail, /landmarks missing: footer/);

  const collapsed = only(sig({ docHeight: 400 }));
  assert.deepEqual(collapsed.aspects, ["layout"]);
  assert.match(collapsed.detail, /shorter by 89%/, "a page that collapses to almost nothing is caught by height alone");
});

test("[DL-006] rendering noise and legitimate growth are not drift", () => {
  const b = base();
  // Sub-pixel and anti-aliasing movement: inside the rounding, so it is not reported at all.
  const jittered = sig({
    landmarks: [
      { sel: "header", x: 0, y: 1, w: 1440, h: 89 },
      { sel: "main", x: 2, y: 90, w: 1438, h: 3203 },
      { sel: "footer", x: 0, y: 3290, w: 1440, h: 241 },
    ],
    docHeight: 3531,
  });
  const r = compareToBaseline(b, [jittered], { renders: [shot("index", "desktop", "aaa")] });
  assert.equal(r.ok, true, describeDrift(r));
  assert.deepEqual(r.findings, []);

  // The tolerance is a stated number, not a feeling, and a shift past it IS reported.
  const past = sig({ landmarks: [{ sel: "header", x: TOLERANCE.boxShiftPx + 8, y: 0, w: 1440, h: 88 }, ...sig().landmarks.slice(1)] });
  assert.equal(compareToBaseline(b, [past], {}).ok, false);
});

test("[DL-007] a page that stops rendering, or one that was never approved, is a finding", () => {
  const b = base([sig({ page: "index" }), sig({ page: "services" })], [shot("index", "desktop", "aaa"), shot("services", "desktop", "ccc")]);

  const missing = compareToBaseline(b, [sig({ page: "index" })], { renders: [shot("index", "desktop", "aaa")] });
  assert.equal(missing.ok, false);
  assert.equal(missing.compared, 1, "the page that did render was still compared");
  const m = missing.findings.find((f) => f.kind === "missing-page")!;
  assert.match(m.detail, /services at desktop was in the approved design and no longer renders/);

  const extra = compareToBaseline(b, [sig({ page: "index" }), sig({ page: "services" }), sig({ page: "admin" })], {});
  const n = extra.findings.find((f) => f.kind === "new-page")!;
  assert.match(n.detail, /admin at desktop is not part of the approved design/);
  assert.equal(extra.ok, false, "a page nobody approved is not silently accepted");
});

test("[DL-008] measuring nothing is never a pass", () => {
  // The failure this exists for: an empty screenshot directory, a crashed render step, a browser that never
  // started — and a gate that reports "no drift found" because it compared no pages.
  const b = base();
  const r = compareToBaseline(b, [], {});
  assert.equal(r.ok, false, "zero pages compared must not read as the design holding");
  assert.equal(r.compared, 0);
  assert.match(describeDrift(r), /no page of the approved design could be compared: 1 baseline page\(s\), 0 measured/);
});

test("[DL-009] the freeze row reuses the existing table and does not misrepresent what certified it", () => {
  const b = base([sig(), sig({ page: "index", viewport: "mobile" })]);
  const row = freezeRow(b, { jobId: "bld_x", projectId: "prj_x", attempt: 1, revisionAttempt: 1, revisionCycle: 3, commitSha: "deadbeef" });

  assert.equal(row.job_id, "bld_x");
  assert.equal(row.design_points, 40);
  assert.deepEqual(JSON.parse(row.viewports_json), ["desktop", "mobile"]);
  assert.equal(row.source_fingerprint, "src_1");

  // The columns that would otherwise imply a model certified the design.
  assert.equal(row.reviewer, "Founder (Noah)", "the reviewer is the person who made the decision");
  assert.equal(row.reviewer_model, null, "no model certified anything");
  assert.equal(row.images_seen, 0);
  assert.deepEqual(JSON.parse(row.design_references_json), [], "no gallery reference fed this design");

  // And the 40 is explained in the record, so a later reader does not mistake it for a rubric score.
  const rubric = JSON.parse(row.rubric_json);
  assert.equal(rubric.basis, "founder-approved-frontend");
  assert.match(rubric.note, /Not a model rubric score/);
  assert.equal(rubric.design_fingerprint, b.fingerprint);
  assert.equal(rubric.pages.length, 2);
  assert.equal(rubric.pages[0].signature, signatureHash(b.signatures[0]));
});
