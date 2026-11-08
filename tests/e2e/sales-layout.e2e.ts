// Phase 2.2: Sales & Conversion → Leads by source never overflows its card. Renders the REAL /staff/sales HTML (an
// in-memory app with 36,756 leads) and the REAL stylesheet in Chromium, adds an extreme card built with the same
// barChart component (very long source names, seven-figure counts), and checks every bar row at desktop, tablet and
// phone widths: labels and values stay inside the card, never overlap, bars stay within their track, and the page
// never scrolls sideways. TEST DATA only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./support.ts";
import { createTestApp, createStaff, TEST_PASSWORD } from "../support/app.ts";
import { barChart } from "../../src/ui/components.ts";
import { nowIso } from "../../src/lib/db.ts";

let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
after(async () => { await browser?.close(); });

test("[BRAND-006] Leads by source: labels and counts stay inside the card, never overlap, at 1440, 1024, 768, 390 and 320px", async () => {
  const t = await createTestApp({});
  const owner = await createStaff(t.db, "owner");
  const at = nowIso();
  // 36,756 research-style leads plus a few from other sources (bulk, via recursive CTEs).
  await t.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 36780)
      INSERT INTO contacts (id, name, created_at) SELECT 'ct_bulk_' || i, 'Bulk Contact ' || i, ? FROM n`).bind(at).run();
  await t.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 36780)
      INSERT INTO leads (id, contact_id, source, stage, created_at, updated_at)
      SELECT 'ld_bulk_' || i, 'ct_bulk_' || i, CASE WHEN i <= 36756 THEN 'manual' WHEN i <= 36770 THEN 'ai_receptionist' ELSE 'referral' END,
             CASE WHEN i % 997 = 0 THEN 'converted' ELSE 'new' END, ?, ? FROM n`).bind(at, at).run();
  const c = t.client(); await c.login(owner.email, TEST_PASSWORD, owner.secret);
  const page = await (await c.get("/staff/sales")).text();
  assert.match(page, />36,756 <span class="bar-chart__sub">36 converted<\/span>/, "large counts are formatted, conversions stay visible");

  const extreme = barChart([
    { label: "An extraordinarily long lead source name that would never fit on one line of a narrow card", value: 1_234_567, display: "1,234,567", sub: "98,765 converted" },
    { label: "Supercalifragilisticexpialidocious-source-without-any-spaces-at-all", value: 36_756, display: "36,756", sub: "0 converted" },
    { label: "Referral", value: 1, display: "1", sub: "1 converted" },
  ]);
  const css = readFileSync(new URL("../../public/assets/app.css", import.meta.url), "utf8");
  const main = /<main[\s\S]*<\/main>/.exec(page)?.[0] ?? page;
  const doc = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${main}
    <section class="container"><div class="grid grid-2"><section class="card" data-extreme><h2>Extreme values</h2>${extreme}</section><section class="card"><h2>Neighbour</h2><p>Another card.</p></section></div></section></body></html>`;

  browser = await launchBrowser();
  const problems: string[] = [];
  for (const width of [1440, 1024, 768, 390, 320]) {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
    const p = await ctx.newPage();
    await p.setContent(doc, { waitUntil: "load" });
    const found = await p.evaluate(() => {
      const out: string[] = [];
      const within = (a: DOMRect, b: DOMRect) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
      for (const chart of Array.from(document.querySelectorAll(".bar-chart"))) {
        const card = chart.closest(".card")!.getBoundingClientRect();
        for (const row of Array.from(chart.querySelectorAll(".bar-chart__row"))) {
          const lab = row.querySelector(".bar-chart__label")!.getBoundingClientRect();
          const val = row.querySelector(".bar-chart__value")!.getBoundingClientRect();
          const track = row.querySelector(".bar-chart__bar")!.getBoundingClientRect();
          const fill = row.querySelector(".bar-chart__bar > span")!.getBoundingClientRect();
          const name = (row.querySelector(".bar-chart__label")!.textContent ?? "").slice(0, 24);
          if (!within(lab, card)) out.push(`label "${name}" leaves the card`);
          if (!within(val, card)) out.push(`value of "${name}" leaves the card`);
          if (!within(track, card)) out.push(`bar of "${name}" leaves the card`);
          if (fill.right > track.right + 0.5) out.push(`bar fill of "${name}" exceeds its track`);
          const overlap = lab.right > val.left + 0.5 && lab.left < val.right - 0.5 && lab.bottom > val.top + 0.5 && lab.top < val.bottom - 0.5;
          if (overlap) out.push(`label and value of "${name}" overlap`);
        }
      }
      if (document.documentElement.scrollWidth > window.innerWidth) out.push(`page scrolls sideways by ${document.documentElement.scrollWidth - window.innerWidth}px`);
      return out;
    });
    problems.push(...(found as string[]).map((f) => `${width}px: ${f}`));
    await ctx.close();
  }
  assert.deepEqual(problems, []);
});
