// Frontend closeout (docs/closeout/AUDIT-2026-10-29.md §C): SEO metadata, portfolio copy and provenance, conditional
// copy, AI Receptionist truthfulness, accessibility markup and the CSS/no-JS rules behind them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestApp } from "./support/app.ts";
import { RECEPTIONIST_UNBUILT, FABRICATION } from "./support/content-rules.ts";
import { SERVICES, servicePath, serviceBySlug } from "../src/content/services.ts";
import { PORTFOLIO_PROJECTS } from "../src/content/portfolio-projects.ts";
import { MAINTENANCE_PLANS } from "../src/domain/catalog.ts";
import { metaDescription, OG_IMAGE } from "../src/ui/layout.ts";
import { escapeHtml } from "../src/lib/html.ts";

const attr = (h: string, re: RegExp) => re.exec(h)?.[1];
const titleOf = (h: string) => attr(h, /<title>([^<]*)<\/title>/);
const descOf = (h: string) => attr(h, /<meta name="description" content="([^"]*)">/);
const text = (h: string) => h.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

function portfolioSql(verified = ""): string {
  const out = join(mkdtempSync(join(tmpdir(), "closeout-pf-")), "setup.sql");
  execFileSync(process.execPath, ["--no-warnings", "scripts/portfolio-setup.ts", "--out", out, "--origins", PORTFOLIO_PROJECTS.map((p) => new URL(p.demoUrl).origin).join(" "), "--verified-on", "2026-10-28", ...(verified ? ["--verified", verified] : [])], { stdio: "pipe" });
  return readFileSync(out, "utf8");
}

test("[WEB-002] [WEB-010] every service page has its own title and description from the service name and summary; the CMS summary overrides it (CREST-GAP-046)", async () => {
  const { db, client } = await createTestApp();
  const c = client();
  const pages = SERVICES.filter((s) => s.pricing !== "maintenance");
  const titles = new Set<string>(), descs = new Set<string>();
  for (const s of pages) {
    const h = await (await c.get(servicePath(s))).text();
    const t = titleOf(h)!, d = descOf(h)!;
    assert.equal(t, `${escapeHtml(s.name)} · Crestmont Website Development`, `${s.slug} title`);
    assert.equal(d, escapeHtml(metaDescription(s.summary)), `${s.slug} description from its summary`);
    assert.ok(d.length <= 160);
    titles.add(t); descs.add(d);
  }
  assert.equal(titles.size, pages.length, "unique titles");
  assert.equal(descs.size, pages.length, "unique descriptions");
  // CMS override: a published summary revision becomes the page's description.
  const now = new Date().toISOString();
  db.raw.exec(`PRAGMA foreign_keys = OFF`);
  await db.prepare(`INSERT INTO cms_entries (id, key, published_revision_id) VALUES ('cms_seo_test', 'service.technical-seo', 'rev_seo_test')`).run();
  await db.prepare(`INSERT INTO cms_revisions (id, entry_id, body_json, status, requires_founder_approval, author_user_id, approved_by, created_at, note) VALUES ('rev_seo_test', 'cms_seo_test', ?, 'published', 0, 'usr_test', NULL, ?, NULL)`)
    .bind(JSON.stringify({ summary: "Edited summary from the CMS for technical SEO.", intro: serviceBySlug("technical-seo")!.intro }), now).run();
  const edited = await (await client().get("/services/technical-seo")).text();
  assert.equal(descOf(edited), "Edited summary from the CMS for technical SEO.");
  assert.equal(titleOf(edited), "Technical SEO · Crestmont Website Development");
});

test("[WEB-010] metadata: case-study descriptions are single-line and cut at a word (CREST-GAP-096); /login and /register have descriptions (CREST-GAP-103)", async () => {
  assert.equal(metaDescription("One\n two   three"), "One two three");
  const long = "word ".repeat(60);
  const cut = metaDescription(long);
  assert.ok(cut.length <= 155 && cut.endsWith("…") && !/\s…$/.test(cut) && /^(word )*word…$/.test(cut), cut);
  const { db, client } = await createTestApp();
  db.raw.exec(portfolioSql());
  for (const p of PORTFOLIO_PROJECTS) {
    const d = descOf(await (await client().get(`/portfolio/${p.slug}`)).text())!.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    assert.doesNotMatch(d, /\n/, `${p.slug}: no newline`);
    assert.ok(d.length <= 155, `${p.slug}: ${d.length} chars`);
    const plain = p.description.replace(/\s+/g, " ");
    if (plain.length > 155) { assert.ok(d.endsWith("…")); assert.ok(plain.startsWith(d.slice(0, -1)), `${p.slug}: cut at a word boundary`); assert.match(plain.slice(d.length - 1, d.length), /\s/, `${p.slug}: next character is a space`); }
  }
  for (const path of ["/login", "/register"]) {
    const d = descOf(await (await client().get(path)).text());
    assert.ok(d && d.length >= 50 && d.length <= 160, `${path} has a meta description: ${d}`);
  }
});

test("[WEB-010] [BRAND-001] social metadata: og:url, og:image (1200×630 brand image), twitter card on public pages; JSON-LD Organization + WebSite only in production, without ratings (CREST-GAP-075)", async () => {
  assert.ok(existsSync(join("public", OG_IMAGE.path)), "og image is bundled");
  const png = readFileSync(join("public", OG_IMAGE.path));
  assert.equal(png.readUInt32BE(16), 1200); assert.equal(png.readUInt32BE(20), 630);
  const dev = await (await (await createTestApp()).client().get("/pricing")).text();
  assert.match(dev, /<meta property="og:url" content="http:\/\/crestmont\.test\/pricing">/);
  assert.match(dev, /<meta property="og:image" content="http:\/\/crestmont\.test\/assets\/brand\/og-image\.png">/);
  assert.match(dev, /<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">/);
  assert.match(dev, /<meta name="twitter:card" content="summary_large_image">/);
  const devHome = await (await (await createTestApp()).client().get("/")).text();
  assert.doesNotMatch(devHome, /application\/ld\+json/, "no structured data outside production");
  const prod = await createTestApp({ ENVIRONMENT: "production", APP_URL: "https://crestmontwebsitedevelopment.com" });
  const home = await (await prod.client().get("/")).text();
  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(home);
  assert.ok(ld, "homepage carries JSON-LD in production");
  const data = JSON.parse(ld![1]);
  const types = data["@graph"].map((x: { "@type": string }) => x["@type"]);
  assert.deepEqual(types, ["Organization", "WebSite"]);
  assert.equal(data["@graph"][0].url, "https://crestmontwebsitedevelopment.com/");
  assert.doesNotMatch(ld![1], /aggregateRating|ratingValue|review/i, "no ratings or reviews");
  assert.match(home, /<meta property="og:url" content="https:\/\/crestmontwebsitedevelopment\.com\/">/);
  const other = await (await prod.client().get("/pricing")).text();
  assert.doesNotMatch(other, /application\/ld\+json/, "only the homepage describes the organisation");
});

test("[PORT-006] production portfolio is poster-only with visitor-facing copy: no 'click inside', no Reset, no 'in this environment' (CREST-GAP-047)", async () => {
  const { db, client } = await createTestApp({ ENVIRONMENT: "production" });
  db.raw.exec(portfolioSql(PORTFOLIO_PROJECTS.map((p) => p.slug).join(",")));
  for (const path of ["/", "/portfolio", "/portfolio/glassly-auto-glass"]) {
    const h = await (await client().get(path)).text();
    assert.match(h, /data-pfx-slide/, `${path} renders the explorer`);
    assert.doesNotMatch(h, /data-demo-url=/, `${path}: production frames nothing`);
    assert.doesNotMatch(h, /click inside/i, `${path}: no 'click inside'`);
    assert.doesNotMatch(h, /data-pfx-reset|Reset demo/, `${path}: no Reset control`);
    assert.doesNotMatch(h, /in this environment/i, `${path}: no environment wording`);
    assert.match(h, /demonstration build, which uses sample data/, `${path}: hint describes the screenshots`);
  }
  // A demo the owner marked temporarily unavailable still says so, in visitor terms.
  db.raw.exec(`UPDATE portfolio_projects SET demo_status = 'unavailable' WHERE slug = 'glassly-auto-glass'`);
  assert.match(await (await client().get("/portfolio")).text(), /The interactive demo is temporarily unavailable, so a screenshot is shown instead\./);
  // Where demos are approved (staging), the demo controls and hint are unchanged.
  const st = await createTestApp({ PORTFOLIO_DEMO_ORIGINS: PORTFOLIO_PROJECTS.map((p) => new URL(p.demoUrl).origin).join(" ") });
  st.db.raw.exec(portfolioSql(PORTFOLIO_PROJECTS.map((p) => p.slug).join(",")));
  const sh = await (await st.client().get("/portfolio")).text();
  assert.match(sh, /data-pfx-reset/); assert.match(sh, /click inside the demo/);
});

test("[PORT-004] [WEB-009] screenshot provenance: copy and alt text say the posters are demonstration-build captures (CREST-GAP-048); case-study screenshots have dimensions (CREST-GAP-078)", async () => {
  const { db, client } = await createTestApp();
  db.raw.exec(portfolioSql());
  const pf = await (await client().get("/portfolio")).text();
  assert.doesNotMatch(text(pf), /captured from the production site/i);
  assert.match(text(pf), /captured from an isolated demonstration build of each site that uses sample data/);
  const cs = await (await client().get("/portfolio/lansing-car-rentals")).text();
  const imgs = [...cs.matchAll(/<img [^>]*>/g)].map((m) => m[0]).filter((t) => /assets\/portfolio\//.test(t));
  assert.ok(imgs.length >= 4);
  for (const t of imgs) assert.match(t, /alt="[^"]*demonstration build with sample data\)"/, t);
  const caseShots = /<div class="container case-shots">([\s\S]*?)<\/section>/.exec(cs)![1];
  const shots = [...caseShots.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
  assert.equal(shots.length, 2);
  assert.match(shots[0], /width="1440" height="900"/); assert.match(shots[1], /width="390" height="844"/);
  assert.match(caseShots, /Desktop · demonstration build with sample data/);
  for (const re of FABRICATION) assert.doesNotMatch(text(cs), re);
});

test("[SUP-005] [WEB-004] /contact shows 'Staffed hours' only once support.staffed_hours is set (CREST-GAP-049)", async () => {
  const { db, client } = await createTestApp();
  const before = await (await client().get("/contact")).text();
  assert.doesNotMatch(before, /Staffed hours/);
  assert.doesNotMatch(before, /published here once confirmed/);
  await db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('support.staffed_hours', 'Monday–Friday, 9am–5pm Eastern (TEST DATA)', ?)`).bind(new Date().toISOString()).run();
  assert.match(await (await client().get("/contact")).text(), /<strong>Staffed hours:<\/strong> Monday–Friday, 9am–5pm Eastern \(TEST DATA\)\./);
});

test("[WEB-007] [CAT-006] hosting page: the automatic-billing renewal line appears only once maintenance entitlements are approved (CREST-GAP-090)", async () => {
  const { client } = await createTestApp();
  assert.doesNotMatch(await (await client().get("/hosting-maintenance")).text(), /renew monthly by automatic billing/);
  const plans = Object.values(MAINTENANCE_PLANS);
  const saved = plans.map((p) => p.entitlementsStatus);
  try {
    for (const p of plans) (p as { entitlementsStatus: string }).entitlementsStatus = "approved";
    assert.match(await (await client().get("/hosting-maintenance")).text(), /Plans renew monthly by automatic billing/);
  } finally { plans.forEach((p, i) => ((p as { entitlementsStatus: string }).entitlementsStatus = saved[i])); }
});

test("[WEB-005] /quote/thanks confirms receipt only after a saved submission (PRG flash); a direct visit is neutral (CREST-GAP-097)", async () => {
  const { client } = await createTestApp();
  const direct = await (await client().get("/quote/thanks")).text();
  assert.doesNotMatch(direct, /Quote request received|is now in our CRM/);
  assert.match(direct, /confirms a quote request right after it is sent/);
  const c = client();
  const res = await c.post("/quote", { name: "Morgan Hale", email: "morgan@example.com", interest: "custom", budget: "Not sure yet", timeline: "Flexible", message: "We need a booking portal for our studio customers." });
  assert.equal(res.headers.get("location"), "/quote/thanks");
  assert.match(await (await c.get("/quote/thanks")).text(), /Quote request received/);
  assert.doesNotMatch(await (await c.get("/quote/thanks")).text(), /Quote request received/, "a reload no longer confirms");
});

test("[WEB-008] [LEGAL-001] the privacy policy page links signed-in visitors to data download and deletion at /account/privacy, outside the policy text (CREST-GAP-043)", async () => {
  const { client } = await createTestApp();
  const h = await (await client().get("/legal/privacy")).text();
  const article = /<article class="prose legal">[\s\S]*?<\/article>/.exec(h)![0];
  const line = /<p class="legal-account-link" data-privacy-self-service>([\s\S]*?)<\/p>/.exec(h);
  assert.ok(line, "the page-level line is present");
  assert.match(line![1], /Signed in\?<\/strong> Download or delete your data at <a href="\/account\/privacy">\/account\/privacy<\/a>/);
  assert.ok(h.indexOf(line![0]) > h.indexOf(article) + article.length - 1, "outside (after) the policy text");
  assert.doesNotMatch(article, /data-privacy-self-service/);
  for (const other of ["/legal/terms", "/legal/refunds"]) assert.doesNotMatch(await (await client().get(other)).text(), /data-privacy-self-service/, other);
});

test("[WEB-009] 404s raised inside routes are titled 'Page not found', like unmatched paths (CREST-GAP-098)", async () => {
  const { client } = await createTestApp();
  for (const path of ["/services/no-such-service", "/portfolio/no-such-project", "/legal/no-such-policy", "/no-such-page"]) {
    const res = await client().get(path);
    assert.equal(res.status, 404, path);
    const h = await res.text();
    assert.match(h, /<h1>Page not found<\/h1>/, path);
    assert.match(titleOf(h)!, /^Page not found · /, path);
  }
});

test("[VOICE-001] [WEB-009] AI Receptionist copy: every claim is delivered capability or custom per-client configuration; no unbuilt feature stated as built-in; the scripted demo stays labelled (CREST-GAP-051)", async () => {
  const { client } = await createTestApp();
  const strip = (h: string) => text(h.replace(/<figure class="sv sv--receptionist[\s\S]*?<\/figure>/g, " "));
  const page = await (await client().get("/services/ai-receptionist")).text();
  const home = await (await client().get("/")).text();
  const homeSection = home.slice(home.indexOf('id="ai-receptionist"'), home.indexOf('id="portfolio"'));
  assert.ok(homeSection.length > 500, "homepage AI Receptionist section found");
  const s = serviceBySlug("ai-receptionist")!;
  const sources: [string, string][] = [["service page", strip(page)], ["homepage section", strip(homeSection)], ["service catalogue", [s.summary, s.intro, ...s.includes, ...s.boundaries].join(" ")]];
  for (const [where, t] of sources) for (const re of RECEPTIONIST_UNBUILT) assert.doesNotMatch(t, re, `${where}: ${re}`);
  for (const [where, t] of sources) assert.match(t, /custom/i, `${where}: worded as custom work`);
  assert.match(strip(page), /voice provider (you|they) choose/);
  assert.match(strip(homeSection), /voice provider you choose/);
  assert.match(page, /Simulated call · no real call, no audio/, "the demo is labelled as a simulation");
  assert.match(page, /scripted illustration of one possible custom configuration/i);
  assert.match(homeSection, /Simulated call · no real call, no audio/);
  assert.match(page, /href="\/quote\?service=ai-receptionist"/, "the service is still offered");
  // The rule catches the old wording.
  const old = "Picks up on the first ring. Checks availability, books and reschedules appointments in your calendar and sends a confirmation.";
  assert.ok(RECEPTIONIST_UNBUILT.some((re) => re.test(old)));
});

test("[TEST-003] [BRAND-006] accessibility markup: auth pages start with a skip link (CREST-GAP-095); simulation field text meets 4.5:1 (CREST-GAP-099)", async () => {
  const { client } = await createTestApp();
  for (const path of ["/login", "/register", "/password/forgot"]) {
    const h = await (await client().get(path)).text();
    assert.match(h, /<body><a class="skip" href="#main">Skip to content<\/a>/, path);
    assert.match(h, /<main id="main"/, path);
  }
  const css = readFileSync("public/assets/app.css", "utf8");
  const color = /\.sv-ev__field \{[^}]*background: (#[0-9a-f]{3,6});[^}]*color: (#[0-9a-f]{6});/i.exec(css)!;
  const lum = (hex: string) => { const n = hex.length === 4 ? hex.slice(1).split("").map((x) => x + x).join("") : hex.slice(1); const c = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const [a, b] = [lum(color[1]), lum(color[2])].sort((x, y) => y - x);
  assert.ok((a + 0.05) / (b + 0.05) >= 4.5, `contrast ${((a + 0.05) / (b + 0.05)).toFixed(2)}:1`);
});

test("[BRAND-006] [TEST-003] touch targets ≥ 44px under (pointer: coarse), (max-width: 760px) for the audited controls (CREST-GAP-045); no-JS mobile nav is visible (CREST-GAP-077)", () => {
  const css = readFileSync("public/assets/app.css", "utf8");
  const block = css.slice(css.lastIndexOf("@media (pointer: coarse), (max-width: 760px) {"));
  for (const sel of [".btn.btn--sm", ".pfx__seg .pfx__tool", ".pfx__page", ".sv__opt.sv__opt--sm", ".toast__close", ".cb__hello-x", ".cb__icon", ".cb__chip", ".cb__links a", ".cb__foot a", ".jr__stop"]) {
    assert.ok(block.includes(sel), `${sel} is covered by the final touch-target block`);
  }
  assert.ok(css.lastIndexOf("@media (pointer: coarse), (max-width: 760px) {") > css.lastIndexOf(".jr__stop { width: 26px"), "the touch-target block comes after the compact sizes it overrides");
  assert.doesNotMatch(block, /min-height: (3\d|4[0-3])px|width: (2\d|3\d|4[0-3])px/, "no size below 44px in the block");
  const nojs = readFileSync("public/assets/nojs.css", "utf8");
  const nav = /@media \(max-width: 1020px\) \{([\s\S]*?)\n\}/.exec(nojs.slice(nojs.indexOf("CREST-GAP-077")))![1];
  assert.match(nav, /\.site-header \.nav \{[^}]*visibility: visible;[^}]*opacity: 1;/);
  assert.match(nav, /\.site-header \.nav-toggle \{ display: none !important; \}/);
});

test("[TEST-003] [BRAND-006] lists keep their list semantics: no <ul>/<ol> carries a role that orphans its <li> items (axe listitem, staging deploy #66 /about)", async () => {
  const { client } = await createTestApp();
  const paths = ["/", "/about", "/services", "/pricing", "/pricing/compare", "/process", "/contact", "/faq", "/portfolio", "/login", "/register", "/password/forgot",
    ...SERVICES.map((s) => servicePath(s))];
  const bad: string[] = [];
  for (const path of [...new Set(paths)]) {
    const res = await client().get(path);
    if (res.status !== 200) continue;
    const h = await res.text();
    // A list may take another role only when each <li> takes its own (e.g. role="presentation" around role="tab").
    for (const m of h.matchAll(/<(ul|ol)\b[^>]*\brole="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
      if (m[2] === "list") continue;
      const orphans = [...m[3]!.matchAll(/<li\b(?![^>]*\brole=)[^>]*>/g)].length;
      if (orphans) bad.push(`${path}: <${m[1]} role="${m[2]}"> with ${orphans} <li> without a role`);
    }
  }
  assert.deepEqual(bad, []);
});
