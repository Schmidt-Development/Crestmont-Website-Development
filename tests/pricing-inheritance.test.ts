// Packages are cumulative (Founder directive 2026-10-28): Starter ⊆ Business ⊆ Premium, at the same or a larger scope.
// One structured model (PACKAGE_FEATURES) drives the comparison, the package cards, contract scope text, proposals and
// build briefs, so no page can contradict another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PACKAGES, PACKAGE_FEATURES, packageAdditions, type PackageId } from "../src/domain/catalog.ts";
import { createTestApp } from "./support/app.ts";

const TIERS: PackageId[] = ["starter", "business", "premium"];

test("[CAT-002] every capability a lower package includes is also included in every higher package", () => {
  for (const f of PACKAGE_FEATURES) {
    for (let i = 0; i < TIERS.length; i++) for (let j = i + 1; j < TIERS.length; j++) {
      if (f.levels[TIERS[i]]) assert.ok(f.levels[TIERS[j]], `${f.id}: ${TIERS[j]} must include what ${TIERS[i]} includes`);
    }
  }
  for (let i = 1; i < TIERS.length; i++) {
    const lower = PACKAGES[TIERS[i - 1]], higher = PACKAGES[TIERS[i]];
    assert.ok(higher.includes.length >= lower.includes.length, `${higher.name} never lists fewer items than ${lower.name}`);
    assert.ok(higher.pageLimit > lower.pageLimit && higher.revisionRounds > lower.revisionRounds, `${higher.name} scope grows`);
    assert.ok(higher.basePriceCents > lower.basePriceCents);
  }
});

test("[CAT-002] quantity rows state each tier's allowance; flat item lists derive from the same model", () => {
  const pages = PACKAGE_FEATURES.find((f) => f.id === "pages")!, rev = PACKAGE_FEATURES.find((f) => f.id === "revisions")!;
  for (const id of TIERS) {
    assert.match(pages.levels[id]!, new RegExp(`Up to ${PACKAGES[id].pageLimit} pages`));
    assert.equal(rev.levels[id], `${PACKAGES[id].revisionRounds} revision rounds`);
    assert.deepEqual(PACKAGES[id].includes, PACKAGE_FEATURES.flatMap((f) => (f.levels[id] ? [f.levels[id]] : [])));
  }
  for (const id of ["responsive", "forms", "seo", "analytics", "imagery", "approval", "launch", "copy"]) {
    const f = PACKAGE_FEATURES.find((x) => x.id === id)!;
    assert.ok(TIERS.every((t) => f.levels[t]), `${id} is included in every package`);
  }
  assert.ok(packageAdditions("premium").includes("Performance optimization"));
  assert.ok(!packageAdditions("business").includes("Responsive website"), "additions list only what changes");
  // Prices are unchanged by the restructure (CAT-007).
  assert.deepEqual(TIERS.map((t) => PACKAGES[t].basePriceCents), [99_900, 249_900, 499_900]);
});

test("[CAT-002] [WEB-003] the comparison page never shows a dash under a higher package where a lower one is included", async () => {
  const { client } = await createTestApp();
  const html = await (await client().get("/pricing/compare")).text();
  const rows = [...html.matchAll(/<tr><th scope="row">([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  let checked = 0;
  for (const r of rows) {
    const cells = [...r.matchAll(/<td class="compare__(yes|scope|no)"/g)].map((m) => m[1]);
    if (cells.length !== 3 || !r.includes("toggletip")) continue;
    checked++;
    const firstIncluded = cells.findIndex((c) => c !== "no");
    if (firstIncluded >= 0) assert.ok(cells.slice(firstIncluded).every((c) => c !== "no"), `row inherits upward: ${r.slice(0, 120)}`);
  }
  assert.equal(checked, PACKAGE_FEATURES.length, "one row per capability");
  assert.match(html, /Not included in Starter/);
  assert.match(html, /Included in Premium/);
  assert.doesNotMatch(html, /Not included in Premium/, "Premium includes every capability");
  const cards = await (await client().get("/pricing")).text();
  assert.match(cards, /Everything in Starter, plus:/);
  assert.match(cards, /Everything in Business, plus:/);
});
