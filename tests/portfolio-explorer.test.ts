// Interactive portfolio explorer: data model, demo-origin allow-list, CSP, rendering and repeatable setup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestApp } from "./support/app.ts";
import { approvedDemoOrigins, demoState, validateDemo, publishBlockers, type PortfolioProject } from "../src/services/portfolio.ts";
import { pageCsp, PAGE_CSP } from "../src/app/http.ts";
import { PORTFOLIO_PROJECTS } from "../src/content/portfolio-projects.ts";
import { findProhibitedClaims } from "../src/domain/catalog.ts";
import { FABRICATION } from "./support/content-rules.ts";

const ORIGINS = PORTFOLIO_PROJECTS.map((p) => new URL(p.demoUrl).origin).join(" ");
const tmp = mkdtempSync(join(tmpdir(), "pfx-"));
function setupSql(extra: string[] = []): string {
  const out = join(tmp, `setup-${Math.random().toString(36).slice(2)}.sql`);
  execFileSync(process.execPath, ["--no-warnings", "scripts/portfolio-setup.ts", "--out", out, "--origins", ORIGINS, "--verified-on", "2026-10-28", ...extra], { stdio: "pipe" });
  return readFileSync(out, "utf8");
}

test("[PORT-006] demo origins: only configured https origins are approved; local http only in development; junk can never widen framing", () => {
  const a = approvedDemoOrigins("https://a.example.dev, https://b.example.dev:8443 javascript:alert(1) http://evil.example https://x.example/path *");
  assert.deepEqual([...a], ["https://a.example.dev", "https://b.example.dev:8443"]);
  assert.equal(approvedDemoOrigins("http://localhost:8831").size, 0);
  assert.equal(approvedDemoOrigins("http://localhost:8831", { allowLocal: true }).size, 1);
  assert.equal(approvedDemoOrigins("http://10.0.0.1:80", { allowLocal: true }).size, 0, "only loopback hosts are local");
});

test("[PORT-006] demo state: embeds only a ready, verified demo on an approved origin that is not the production site", () => {
  const ok = new Set(["https://demo.example.dev"]);
  const base = { demo_url: "https://demo.example.dev/", demo_status: "ready" as const, demo_verified_at: "2026-10-28T00:00:00.000Z", live_url: "https://live.example.com" };
  assert.deepEqual(demoState(base, ok), { kind: "embed", url: "https://demo.example.dev/", origin: "https://demo.example.dev" });
  assert.equal(demoState({ ...base, demo_verified_at: null }, ok).kind, "unavailable");
  assert.equal(demoState({ ...base, demo_status: "unavailable" }, ok).kind, "unavailable");
  assert.equal(demoState(base, new Set()).kind, "unavailable", "unapproved origin in this environment");
  assert.equal(demoState({ ...base, demo_url: "https://live.example.com/demo", live_url: "https://live.example.com" }, new Set(["https://live.example.com"])).kind, "unavailable", "production is never embedded");
  assert.equal(demoState({ ...base, demo_status: "none" }, ok).kind, "none");
  const v = validateDemo({ demo_url: "https://live.example.com/", demo_status: "ready", demo_revision: "repo@abc1234", verified_on: "2026-10-28", poster_desktop_asset: "", poster_mobile_asset: "" }, "https://live.example.com", new Set(["https://live.example.com"]));
  assert.ok(v.issues.some((i) => /never the production website/.test(i)));
  const w = validateDemo({ demo_url: "https://other.example.dev/", demo_status: "ready", demo_revision: "repo@abc", verified_on: "", poster_desktop_asset: "/assets/../x.webp", poster_mobile_asset: "" }, "https://live.example.com", ok);
  assert.ok(w.issues.some((i) => /not on the approved list/.test(i)) && w.issues.some((i) => /verified/.test(i)) && w.issues.some((i) => /\/assets\/portfolio/.test(i)));
});

test("[SEC-002] page CSP: frame-src gains only the approved demo origins of pages that embed them; every other page is unchanged", () => {
  assert.equal(pageCsp([]), PAGE_CSP);
  const c = pageCsp(["https://demo.example.dev", "https://evil.example.dev/x", "javascript:alert(1)"]);
  assert.match(c, /frame-src https:\/\/challenges\.cloudflare\.com https:\/\/demo\.example\.dev;/);
  assert.doesNotMatch(c, /evil|javascript/);
  assert.match(c, /frame-ancestors 'none'/, "Crestmont itself can still never be framed");
});

test("[PORT-004] [PORT-007] portfolio setup: four founder-owned projects, factual copy, bundled genuine posters, founder authorization recorded through relationship evidence + audit log", () => {
  assert.deepEqual(PORTFOLIO_PROJECTS.map((p) => p.name), ["Lansing Car Rentals", "Glassly Auto Glass", "Lansing Car Rentals Mentorship", "Better Lansing Mechanics"]);
  for (const p of PORTFOLIO_PROJECTS) {
    const text = [p.description, p.technology, ...p.features].join("\n");
    assert.equal(findProhibitedClaims(text).length, 0, `${p.slug}: no prohibited claims`);
    for (const re of FABRICATION) assert.doesNotMatch(text, re, `${p.slug}: no fabrication pattern`);
    assert.doesNotMatch(p.description, /\b\d+\s+(cars|vehicles)\b|revenue|\$\d/i, `${p.slug}: no metrics or prices`);
    assert.notEqual(new URL(p.demoUrl).host, new URL(p.liveUrl).host, `${p.slug}: demo is a separate deployment`);
    for (const f of [p.posterDesktop, p.posterTablet, p.posterMobile]) assert.ok(existsSync(join("public", f)), `${f} is bundled`);
  }
  const sql = setupSql(["--verified", "glassly-auto-glass"]);
  assert.match(sql, /ON CONFLICT\(id\) DO UPDATE/);
  assert.match(sql, /'portfolio\.relationship_documented'/);
  assert.match(sql, /Founder Noah Schmidt confirmed in writing on 2026-10-27/);
  assert.doesNotMatch(sql, /pending/i);
});

test("[PORT-006] [PORT-007] explorer: published records drive one shared component on /portfolio, the homepage and case studies; setup is idempotent", async () => {
  const { db, client } = await createTestApp({ PORTFOLIO_DEMO_ORIGINS: ORIGINS });
  const sql = setupSql(["--verified", PORTFOLIO_PROJECTS.map((p) => p.slug).join(",")]);
  db.raw.exec(sql);
  const count = async () => (await db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE subject_type = 'portfolio_project'`).first<{ n: number }>())!.n;
  const audits = await count();
  db.raw.exec(sql);
  assert.equal(await count(), audits, "re-running the setup adds no duplicate audit rows");
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM portfolio_projects WHERE published = 1`).first<{ n: number }>())!.n, 4);
  const pr = (await db.prepare(`SELECT * FROM portfolio_projects WHERE id = 'pf_glassly_auto_glass'`).first<PortfolioProject>())!;
  assert.deepEqual(publishBlockers(pr), [], "bundled posters satisfy the genuine-screenshot requirement");

  const c = client();
  const res = await c.get("/portfolio");
  const html = await res.text();
  assert.equal((html.match(/data-pfx-slide/g) ?? []).length, 4, "four slides from four published records");
  for (const p of PORTFOLIO_PROJECTS) assert.ok(html.includes(`data-demo-url="${p.demoUrl}"`), `${p.slug} embeds its isolated demo`);
  assert.match(html, /aria-label="Previous project: Better Lansing Mechanics"/);
  assert.match(html, /aria-label="Next project: Glassly Auto Glass"/);
  assert.match(html, /Interactive demo — no real transactions/);
  assert.match(html, /<script src="\/assets\/portfolio\.js" defer>/);
  // Framing: every slide has a device stage with the genuine desktop, tablet and phone captures, and the visitor can
  // pick the device viewport (desktop 1440 / tablet 820 / phone 390 CSS px, scaled to fit — never cropped).
  assert.equal((html.match(/data-pfx-stage/g) ?? []).length, 4);
  for (const p of PORTFOLIO_PROJECTS) for (const f of [p.posterDesktop, p.posterTablet, p.posterMobile]) assert.ok(html.includes(`src="${f}"`), `${f} rendered`);
  for (const m of ["desktop", "tablet", "mobile"]) assert.match(html, new RegExp(`data-pfx-mode="${m}"`));
  for (const p of PORTFOLIO_PROJECTS) assert.ok(html.includes(`href="${p.liveUrl}" target="_blank" rel="noopener noreferrer">Visit live website`), "separate live-site link");
  const csp = res.headers.get("content-security-policy")!;
  for (const o of ORIGINS.split(" ")) assert.ok(csp.includes(o), `frame-src allows ${o}`);
  for (const t of [html.replace(/<[^>]+>/g, " ")]) { assert.equal(findProhibitedClaims(t).length, 0); for (const re of FABRICATION) assert.doesNotMatch(t, re); }

  const home = await (await c.get("/")).text();
  assert.equal((home.match(/data-pfx-slide/g) ?? []).length, 4, "homepage uses the same component and data");
  const login = await c.get("/login");
  assert.doesNotMatch(login.headers.get("content-security-policy")!, /workers\.dev/, "pages without the explorer keep the default CSP");

  const cs = await (await c.get("/portfolio/glassly-auto-glass")).text();
  assert.equal((cs.match(/data-pfx-slide/g) ?? []).length, 1);
  assert.match(cs, /pfx--single/);

  // Reordering and unpublishing in the data immediately change the explorer (no hard-coded projects).
  db.raw.exec(`UPDATE portfolio_projects SET published = 0 WHERE slug = 'glassly-auto-glass'; UPDATE portfolio_projects SET position = 0 WHERE slug = 'better-lansing-mechanics';`);
  const after = await (await c.get("/portfolio")).text();
  assert.equal((after.match(/data-pfx-slide/g) ?? []).length, 3);
  assert.ok(after.indexOf('id="pfx-better-lansing-mechanics"') < after.indexOf('id="pfx-lansing-car-rentals"'), "order follows position");
  assert.doesNotMatch(after, /Glassly Auto Glass/);
});

test("[PORT-006] explorer without approved origins (or unverified demos) shows genuine posters with an honest status — never an unapproved frame", async () => {
  const { db, client } = await createTestApp({ PORTFOLIO_DEMO_ORIGINS: "" });
  db.raw.exec(setupSql(["--verified", "glassly-auto-glass"]));
  const res = await client().get("/portfolio");
  const html = await res.text();
  assert.doesNotMatch(html, /data-demo-url=/);
  assert.match(html, /The interactive demo is not available in this environment\./);
  assert.match(html, /src="\/assets\/portfolio\/glassly-auto-glass-desktop\.webp"/);
  assert.doesNotMatch(res.headers.get("content-security-policy")!, /workers\.dev/);
});
