// The Design Blueprint: the approved design as validated data. (V5 §5, §6, §7.)
//
// The failure these prevent, measured on bld_10e2c6007686faee0ab64d45:
//
//   the design was scored 12/40 while the written design specification read as though it had been satisfied,
//   because every sentence in it ("a clean, modern layout with a warm, professional palette") is true of any
//   rendered page and of none. There was nothing in the specification that could be violated.
//
// A blueprint can be violated. These tests hold the validator to that: it must reject the adjectives the old
// specification was made of, reject a photography plan that is really an SVG, reject a citation to a gallery
// reference nobody sent, and produce builder instructions that name the tokens and the section order.
//
// No GPU and no model: deterministic validation over literal objects.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLUEPRINT_SCHEMA, blueprintBrief, blueprintChecklist, blueprintInstructions, blueprintSummary, isVague,
  blueprintTokensCss, validateBlueprint,
} from "../src/orchestrator/blueprint.ts";

/** A blueprint that should pass: every decision made, in units, with provenance. */
const good = () => ({
  schema: BLUEPRINT_SCHEMA,
  visualIdentity: {
    palette: { background: "#FBF9F6", surface: "#FFFFFF", text: "#1A1714", brand: "#1F4D3C", accent: "#C9622B", border: "#E4DED5" },
    headingFont: "Fraunces",
    bodyFont: "Inter",
    fontSource: "Google Fonts (Fraunces 400/600, Inter 400/500)",
    typeScale: [
      { role: "h1", size: "3.25rem", weight: 600, lineHeight: "1.05", tracking: "-0.02em" },
      { role: "h2", size: "2rem", weight: 600, lineHeight: "1.15" },
      { role: "body", size: "1.0625rem", weight: 400, lineHeight: "1.65" },
      { role: "small", size: "0.875rem", weight: 500, lineHeight: "1.4" },
    ],
    spacingBase: "0.5rem",
    spacingScale: [1, 2, 3, 5, 8, 13],
    radius: "0.75rem",
    elevation: "one soft shadow, 0 1px 3px rgb(26 23 20 / 0.08); flat sections carry none",
    density: "generous",
    intent: "A visitor should feel they have found an established local firm that takes care over its work.",
  },
  pages: [{
    route: "/", title: "Junk removal in Lansing", purpose: "Turn a visitor with a full garage into a booked job",
    sections: [
      { id: "home-hero", layout: "hero-split", intent: "State what the service is and let the visitor start a booking in one move", content: "Headline \"Your junk, gone this week\", one supporting line about same-week pickup, a primary button reading \"Get a free quote\"", assets: ["hero-truck"] },
      { id: "home-steps", layout: "process-numbered", intent: "Remove the uncertainty about how a pickup actually works", content: "Three numbered steps: book a slot, we load everything, you get a receipt by email", assets: [] },
      { id: "home-proof", layout: "stat-band", intent: "Give the visitor a reason to believe the service is established", content: "Years operating, counties served, and the recycling share, each with a short label", assets: [] },
      { id: "home-cta", layout: "cta-band", intent: "Catch the visitor who scrolled the whole page without acting", content: "One line repeating the same-week promise and the quote button", assets: [] },
    ],
  }],
  components: [
    { name: "Primary button", element: "button", states: ["rest", "hover", "focus-visible", "disabled"], appearance: "Brand background, surface text, radius from --radius, lifts on hover with the single soft shadow" },
    { name: "Quote form field", element: "form field", states: ["empty", "filled", "invalid", "submitting"], appearance: "One-pixel border in --color-border, label above in the small type step, invalid state adds a red rule and a message below" },
    { name: "Site navigation", element: "nav", states: ["desktop-horizontal", "mobile-collapsed", "mobile-open"], appearance: "Horizontal row at 1366 and 768; a labelled toggle button and a stacked panel at 390" },
  ],
  visualAssets: [
    { id: "hero-truck", role: "The firm's own truck loaded on a residential street", kind: "photograph", source: "customer_upload", rights: "Owned by the customer; supplied in customer-files/", aspect: "4:3", alt: "A Junk in the Trunk truck loaded outside a house" },
    { id: "recycle-mark", role: "A small mark beside the recycling statistic", kind: "illustration", source: "authored_svg", rights: "Authored for this website", aspect: "1:1", alt: "" },
  ],
  referenceMapping: [
    { referenceId: "gal-7", borrowed: "The hero split with the photograph held to the right half and the booking action in the left column", appliesTo: "home-hero" },
  ],
});

const ctx = { sentReferenceIds: ["gal-7", "gal-9"], requiresPhotography: true };

test("[BLUEPRINT] a fully decided design validates, and nothing is silently dropped", () => {
  const v = validateBlueprint(good(), ctx);
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  const b = v.blueprint!;
  assert.equal(b.pages[0].sections.length, 4);
  assert.equal(b.pages[0].sections[0].layout, "hero-split");
  assert.equal(b.visualAssets.length, 2);
  assert.equal(b.referenceMapping.length, 1);
  assert.equal(b.visualIdentity.palette.brand, "#1f4d3c", "hex is normalised to lower case");
});

test("[BLUEPRINT] the measured failure: adjectives are rejected where a value is required", () => {
  const bad = good();
  bad.visualIdentity.palette.brand = "a warm professional green";
  bad.visualIdentity.headingFont = "a modern serif";
  const v = validateBlueprint(bad, ctx);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /palette\.brand must be a hex colour/.test(p)), v.problems.join(" | "));
  assert.ok(v.problems.some((p) => /headingFont must name a real family/.test(p)), v.problems.join(" | "));
});

test("[BLUEPRINT] a type step without a unit, or with a word for a weight, is rejected", () => {
  const bad = good();
  bad.visualIdentity.typeScale[0] = { role: "h1", size: "large", weight: 600, lineHeight: "1.05" };
  bad.visualIdentity.typeScale[1] = { role: "h2", size: "2rem", weight: "bold", lineHeight: "1.15" } as never;
  const v = validateBlueprint(bad, ctx);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /typeScale\[0\]\.size must carry a unit/.test(p)));
  assert.ok(v.problems.some((p) => /typeScale\[1\]\.weight must be a numeric font weight/.test(p)));
});

test("[BLUEPRINT] §7: a photograph with an authored source is rejected, and says what to do instead", () => {
  const bad = good();
  bad.visualAssets[0] = { ...bad.visualAssets[0], source: "authored_svg" };
  const v = validateBlueprint(bad, ctx);
  assert.equal(v.ok, false);
  const msg = v.problems.find((p) => /declared a photograph with source "authored_svg"/.test(p));
  assert.ok(msg, v.problems.join(" | "));
  assert.match(msg!, /declare it as kind "illustration"/);
});

test("[BLUEPRINT] §7: a brief that calls for photography and a blueprint that plans none is rejected", () => {
  const bad = good();
  bad.visualAssets = [bad.visualAssets[1]];
  bad.pages[0].sections[0].assets = [];
  const v = validateBlueprint(bad, ctx);
  assert.equal(v.ok, false);
  const msg = v.problems.find((p) => /calls for photography and the blueprint plans none/.test(p));
  assert.ok(msg, v.problems.join(" | "));
  assert.match(msg!, /Authored artwork is a valid part of a design but does not satisfy a photography requirement/);
});

test("[BLUEPRINT] §7: photography that is planned but placed in no section is rejected", () => {
  const bad = good();
  bad.pages[0].sections[0].assets = [];
  const v = validateBlueprint(bad, ctx);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /no section renders it/.test(p)), v.problems.join(" | "));
});

test("[BLUEPRINT] §7: an illustration may be authored — authored artwork is never penalised as such", () => {
  const ok = good();
  ok.visualAssets[1] = { ...ok.visualAssets[1], kind: "illustration", source: "authored_svg" };
  assert.deepEqual(validateBlueprint(ok, ctx).problems, []);
  // And with no photography requirement, a blueprint of pure authored artwork is perfectly valid.
  const drawn = good();
  drawn.visualAssets = [{ id: "mark", role: "A line drawing of a loaded truck", kind: "illustration", source: "authored_svg", rights: "Authored for this website", aspect: "4:3", alt: "A loaded truck, drawn" }];
  drawn.pages[0].sections[0].assets = ["mark"];
  const v = validateBlueprint(drawn, { sentReferenceIds: ["gal-7"], requiresPhotography: false });
  assert.deepEqual(v.problems, []);
});

test("[BLUEPRINT] a citation to a reference nobody sent is rejected as a fabricated provenance claim", () => {
  const bad = good();
  bad.referenceMapping[0] = { ...bad.referenceMapping[0], referenceId: "gal-does-not-exist" };
  const v = validateBlueprint(bad, ctx);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /cites reference "gal-does-not-exist", which was not among the references provided/.test(p)), v.problems.join(" | "));
});

test("[BLUEPRINT] a mapping that applies to nothing in the blueprint is rejected", () => {
  const bad = good();
  bad.referenceMapping[0] = { ...bad.referenceMapping[0], appliesTo: "the general vibe" };
  const v = validateBlueprint(bad, ctx);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /is not a section id, a page route or a component name/.test(p)));
});

test("[BLUEPRINT] no reference was sent, so an empty mapping is the honest answer and is accepted", () => {
  const ok = good();
  ok.referenceMapping = [];
  const v = validateBlueprint(ok, { requiresPhotography: true });
  assert.deepEqual(v.problems, []);
});

test("[BLUEPRINT] an unnamed section layout is rejected and the valid names are listed", () => {
  const bad = good();
  bad.pages[0].sections[1] = { ...bad.pages[0].sections[1], layout: "a nice section" };
  const v = validateBlueprint(bad, ctx);
  assert.equal(v.ok, false);
  const msg = v.problems.find((p) => /is not a named layout/.test(p));
  assert.ok(msg, v.problems.join(" | "));
  assert.match(msg!, /hero-split/);
});

test("[BLUEPRINT] a page of two sections, or content that says nothing, is not a composed page", () => {
  const bad = good();
  bad.pages[0].sections = bad.pages[0].sections.slice(0, 2);
  bad.pages[0].sections[1] = { ...bad.pages[0].sections[1], content: "relevant content", intent: "clean and modern" };
  const v = validateBlueprint(bad, ctx);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /needs at least 3 composed sections/.test(p)), v.problems.join(" | "));
  assert.ok(v.problems.some((p) => /needs the actual content it carries/.test(p)));
  assert.ok(v.problems.some((p) => /needs a real intent/.test(p)));
});

test("[BLUEPRINT] a section that renders an undeclared asset is rejected", () => {
  const bad = good();
  bad.pages[0].sections[1] = { ...bad.pages[0].sections[1], assets: ["ghost-image"] };
  const v = validateBlueprint(bad, ctx);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /renders asset "ghost-image", which is not declared in visualAssets/.test(p)));
});

test("[BLUEPRINT] a component with no declared states cannot be reviewed, so it is rejected", () => {
  const bad = good();
  bad.components[0] = { ...bad.components[0], states: [] };
  const v = validateBlueprint(bad, ctx);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /must list the states that have to exist/.test(p)));
});

test("[BLUEPRINT] a sitemap page the blueprint does not compose is reported", () => {
  const v = validateBlueprint(good(), { ...ctx, expectedRoutes: ["/", "/services.html", "/contact.html"] });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /\/services\.html, \/contact\.html, which the blueprint does not compose/.test(p)), v.problems.join(" | "));
});

test("[BLUEPRINT] a reply that is not an object, or carries the wrong schema, is rejected without throwing", () => {
  assert.equal(validateBlueprint(null).ok, false);
  assert.equal(validateBlueprint("{}").ok, false);
  assert.equal(validateBlueprint([]).ok, false);
  const wrong = { ...good(), schema: "something.else/1" };
  assert.ok(validateBlueprint(wrong, ctx).problems.some((p) => /schema must be/.test(p)));
});

test("[BLUEPRINT] duplicate asset ids and duplicate section ids are rejected", () => {
  const bad = good();
  bad.visualAssets.push({ ...bad.visualAssets[0] });
  bad.pages[0].sections[2] = { ...bad.pages[0].sections[2], id: "home-hero" };
  const v = validateBlueprint(bad, ctx);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /is used twice/.test(p)));
  assert.ok(v.problems.some((p) => /section id "home-hero" is used twice/.test(p)));
});

// ── §6: what the builder is actually given ───────────────────────────────────────────────────────────────────────

test("[BLUEPRINT] §6: the generated tokens carry every colour and type step, so the values cannot drift", () => {
  const b = validateBlueprint(good(), ctx).blueprint!;
  const css = blueprintTokensCss(b);
  assert.match(css, /--color-background: #fbf9f6;/);
  assert.match(css, /--color-brand: #1f4d3c;/);
  assert.match(css, /--font-heading: "Fraunces"/);
  assert.match(css, /--space: 0\.5rem;/);
  assert.match(css, /--space-13: calc\(var\(--space\) \* 13\);/);
  assert.match(css, /--type-h1-size: 3\.25rem;/);
  assert.match(css, /--type-h1-weight: 600;/);
  assert.match(css, /--type-h1-tracking: -0\.02em;/);
  assert.doesNotMatch(css, /--type-h2-tracking/, "a step with no tracking must not invent one");
});

test("[BLUEPRINT] §6: the builder instructions name the section ORDER and the layout of each one", () => {
  const b = validateBlueprint(good(), ctx).blueprint!;
  const text = blueprintInstructions(b);
  assert.match(text, /BUILD EXACTLY THIS/);
  assert.match(text, /1\. \[home-hero\] layout: hero-split/);
  assert.match(text, /2\. \[home-steps\] layout: process-numbered/);
  assert.match(text, /4\. \[home-cta\] layout: cta-band/);
  assert.match(text, /Component/i);
  assert.match(text, /Primary button/);
  // §7, stated where the builder reads it.
  assert.match(text, /PHOTOGRAPHS \(hero-truck\)|1 of these are PHOTOGRAPHS/);
  assert.match(text, /An SVG you\s+\n?\s*author in place of a photograph/);
});

test("[BLUEPRINT] §6: the prompt brief is far shorter than the file but keeps the tokens and the order", () => {
  const b = validateBlueprint(good(), ctx).blueprint!;
  const brief = blueprintBrief(b), full = blueprintInstructions(b);
  assert.ok(brief.length < full.length, `${brief.length} should be under ${full.length}`);
  assert.match(brief, /DESIGN-BLUEPRINT\.md/);
  assert.match(brief, /--color-brand: #1f4d3c;/);
  assert.match(brief, /1\. home-hero \(hero-split\); 2\. home-steps \(process-numbered\)/);
  assert.match(brief, /Do NOT draw an SVG in place of a photograph/);
  assert.match(brief, /never copy a Design Gallery reference screenshot|Never copy a Design Gallery reference screenshot/);
});

test("[BLUEPRINT] §8: the checklist asks questions that have a wrong answer", () => {
  const b = validateBlueprint(good(), ctx).blueprint!;
  const q = blueprintChecklist(b);
  assert.ok(q.some((x) => /are the sections, in order, \(1\) hero-split, \(2\) process-numbered/.test(x)), q.join(" | "));
  assert.ok(q.some((x) => /does it render hero-truck\?/.test(x)));
  assert.ok(q.some((x) => /Fraunces for headings and Inter for body text/.test(x)));
  assert.ok(q.some((x) => /plans 1 photograph\(s\)\. Are real photographs rendered/.test(x)));
  assert.ok(q.every((x) => !/does the website look good/i.test(x)));
});

test("[BLUEPRINT] the summary states measured counts, never an impression", () => {
  const b = validateBlueprint(good(), ctx).blueprint!;
  const s = blueprintSummary(b);
  assert.match(s, /1 page\(s\), 4 composed section\(s\), 3 component\(s\), 2 visual asset\(s\) \(1 photographic\)/);
  assert.match(s, /4-step type scale/);
});

// ── ReDoS ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("[BLUEPRINT] the vagueness check is linear: a model's filler text cannot hang the runner", () => {
  // CodeQL on PR #150: "exponential backtracking on strings starting with 'tbd' and containing many repetitions
  // of '\tna'". The old pattern had a leading \s* and a trailing [\s.,;-]* inside a repeated group, so every space
  // could be consumed by either side. Measured on the old regex: 22 reps 627 ms, 26 reps 1,143 ms, 28 reps
  // 4,521 ms -- roughly doubling every two words. The strings checked here are written by a model, so that is a
  // hang reachable from ordinary output.
  const hostile = "tbd" + "\tna".repeat(64) + "!";
  const started = Date.now();
  // It IS all filler (the trailing "!" is a separator, so it tokenises to tbd/na/na/...), and that verdict is
  // correct. What this test is about is that reaching it takes no measurable time.
  assert.equal(isVague(hostile), true);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `took ${elapsed}ms; anything near a second means the backtracking is back`);
});

test("[BLUEPRINT] the vagueness check still means what it did", () => {
  for (const s of ["clean", "Modern", "  nice, clean  ", "TBD", "n/a", "the premium", "various.", "etc"]) {
    assert.equal(isVague(s), true, `"${s}" is nothing but filler`);
  }
  for (const s of ["", "a warm welcome for a visitor with a full garage", "Fraunces", "clean lines over a photograph of the fleet", "modern kitchens, photographed on site"]) {
    assert.equal(isVague(s), false, `"${s}" says something`);
  }
});
