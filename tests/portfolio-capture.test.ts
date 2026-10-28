import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PORTFOLIO_TARGETS, VIEWPORTS, acceptable, type CaptureRecord } from "../scripts/capture-portfolio.ts";

test("[PORT-001] [PORT-002] [PORT-003] screenshot capture targets exactly the recorded live portfolio sites at desktop and mobile widths, and rejects parked/redirected or failed captures", () => {
  const seeded = readFileSync("migrations/0005_cms_portfolio.sql", "utf8");
  for (const t of PORTFOLIO_TARGETS) assert.ok(seeded.includes(`'${t.url}'`), `${t.url} is the recorded live URL`);
  assert.deepEqual(PORTFOLIO_TARGETS.map((t) => t.requirement), ["PORT-001", "PORT-002", "PORT-003"]);
  assert.ok(VIEWPORTS.desktop.width >= 1280 && VIEWPORTS.mobile.width <= 414 && VIEWPORTS.mobile.isMobile);
  const base: CaptureRecord = { slug: "x", requirement: "PORT-001", url: "https://betterlansingmechanics.com", viewport: "desktop", finalUrl: "https://www.betterlansingmechanics.com/", httpStatus: 200, capturedAt: "", file: "x.png", sha256: "a", bytes: 1, error: null };
  assert.equal(acceptable(base), true);
  assert.equal(acceptable({ ...base, finalUrl: "https://parking-provider.example/lander" }), false, "a redirect to another host is not a genuine capture");
  assert.equal(acceptable({ ...base, httpStatus: 503 }), false);
  assert.equal(acceptable({ ...base, error: "timeout", file: null }), false);
  const wf = readFileSync(".github/workflows/portfolio-screenshots.yml", "utf8");
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /contents: read/);
  assert.doesNotMatch(wf, /secrets\.|wrangler|deploy/i, "capture never touches the platform or its secrets");
});
