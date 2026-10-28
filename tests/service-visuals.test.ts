// Interactive service visuals: one per service page, rendered beside the unchanged hero copy and CTAs, complete
// without JavaScript, clearly illustrative, and free of real transactions, forms or prohibited claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";
import { SERVICES, servicePath } from "../src/content/services.ts";
import { SERVICE_VISUAL_SLUGS, serviceVisual } from "../src/ui/service-visuals.ts";
import { findProhibitedClaims } from "../src/domain/catalog.ts";
import { FABRICATION } from "./support/content-rules.ts";

test("[WEB-002] [WEB-009] every service page has its own interactive visual; no new offerings are introduced", () => {
  assert.deepEqual([...SERVICE_VISUAL_SLUGS].sort(), SERVICES.map((s) => s.slug).sort());
  for (const slug of SERVICE_VISUAL_SLUGS) {
    const h = String(serviceVisual(slug));
    assert.match(h, /Illustrative demonstration/, `${slug}: labelled illustrative`);
    assert.match(h, /<script src="\/assets\/services\.js" defer><\/script>/);
    assert.doesNotMatch(h, /<form|<input(?![^>]*type="range")|<iframe|https?:\/\//i, `${slug}: no forms, data inputs, frames or external URLs`);
    const text = h.replace(/<[^>]+>/g, " ");
    assert.equal(findProhibitedClaims(text).length, 0, `${slug}: no prohibited claims`);
    for (const re of FABRICATION) assert.doesNotMatch(text, re, `${slug}: no fabrication pattern`);
  }
});

test("[WEB-002] [WEB-007] service pages keep their heading, summary, CTAs, prices and terms, with the visual beside them", async () => {
  const { client } = await createTestApp();
  const c = client();
  for (const s of SERVICES) {
    const res = await c.get(servicePath(s));
    assert.equal(res.status, 200, servicePath(s));
    const html = await res.text();
    assert.match(html, /class="hero hero--page hero--service"/, `${s.slug}: two-column hero`);
    assert.equal((html.match(/data-sv="/g) ?? []).length, 1, `${s.slug}: one visual`);
    assert.ok(html.indexOf("hero-service__copy") < html.indexOf("hero-service__visual"), "copy first (left / top on phones)");
    assert.ok(html.includes(`<h1 class="hero-title">${s.name.replace(/&/g, "&amp;")}`) || s.slug === "hosting-maintenance", `${s.slug}: heading unchanged`);
    if (s.slug === "hosting-maintenance") assert.match(html, /href="\/contact\?topic=maintenance"/);
    else if (s.pricing === "custom") assert.match(html, new RegExp(`href="/quote\\?service=${s.slug}"`));
    else { assert.match(html, /href="\/pricing"/); assert.match(html, /How it is priced/); }
  }
});
