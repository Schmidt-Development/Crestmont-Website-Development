import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, lastEmail } from "./support/app.ts";
import { findProhibitedClaims, PACKAGES, MAINTENANCE_PLANS, APPROVED_SERVICES, priceQuote } from "../src/domain/catalog.ts";
import { SERVICES, servicePath } from "../src/content/services.ts";
import { PUBLIC_PATHS } from "../src/routes/public.ts";
import { LEGAL_SLUGS } from "../src/content/legal.ts";
import { FABRICATION } from "./support/content-rules.ts";
import { newId, nowIso } from "../src/lib/db.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
const pngFile = (name = "capture.png") => new File([PNG], name, { type: "image/png" });

const text = (h: string) => h.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const hrefs = (h: string) => [...h.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

async function staffClient(app: Awaited<ReturnType<typeof createTestApp>>, role: Parameters<typeof createStaff>[1], email?: string) {
  const s = await createStaff(app.db, role, email);
  return { s, c: await app.client().login(s.email, undefined, s.secret) };
}

test("[WEB-001] [WEB-002] [WEB-003] [WEB-004] [WEB-007] [WEB-008] every public page returns 200 with a title", async () => {
  const { client } = await createTestApp();
  const c = client();
  const required = ["/", "/services", "/services/website-design-development", "/services/website-redesign", "/services/custom-development", "/services/technical-seo",
    "/services/e-commerce-development", "/services/custom-web-applications", "/services/portals", "/services/booking-scheduling", "/services/payments-subscriptions",
    "/services/ai-automation", "/services/api-integrations", "/services/analytics-search-console", "/services/google-business-profile", "/services/landing-pages",
    "/services/email-automation", "/services/crm-integrations", "/services/performance-optimization", "/pricing", "/pricing/compare", "/portfolio", "/about",
    "/process", "/quote", "/contact", "/faq", "/hosting-maintenance", "/register", "/login", ...LEGAL_SLUGS.map((s) => `/legal/${s}`)];
  for (const p of [...new Set([...required, ...PUBLIC_PATHS])]) {
    const res = await c.get(p);
    assert.equal(res.status, 200, `${p} → ${res.status}`);
    assert.match(await res.text(), /<title>[^<]+<\/title>/, p);
  }
  assert.equal((await c.get("/services/not-a-service")).status, 404);
  assert.equal((await c.get("/legal/not-a-policy")).status, 404);
});

test("[WEB-001] homepage includes every §12 section and CTAs to functioning workflows", async () => {
  const { client } = await createTestApp();
  const res = await client().get("/");
  const h = await res.text();
  for (const id of ["services", "packages", "process", "portfolio", "why", "capabilities", "maintenance", "experience", "faq", "contact"]) assert.match(h, new RegExp(`id="${id}"`), id);
  assert.match(h, /class="site-header"/);
  assert.match(h, /crestmont-crest\.png/);
  assert.match(h, /class="hero hero--home"/);
  assert.match(h, /class="site-footer"/);
  const links = hrefs(h);
  for (const target of ["/pricing", "/quote", "/checkout/starter", "/checkout/business", "/checkout/premium", "/contact", "/services", "/portfolio", "/process", "/faq", "/hosting-maintenance"]) {
    assert.ok(links.includes(target), `homepage links to ${target}`);
  }
  assert.match(h, /<form method="post" action="\/contact"/, "homepage contact form posts to the real handler");
});

test("[WEB-009] dead-link check: crawl every internal link reachable from the homepage", async () => {
  const { client } = await createTestApp();
  const c = client();
  const seen = new Set<string>(), queue = ["/"], checkout: string[] = [];
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const res = await c.get(path);
    assert.notEqual(res.status, 404, `dead link: ${path}`);
    assert.ok(res.status < 500, `${path} → ${res.status}`);
    if (!(res.headers.get("content-type") ?? "").includes("text/html") || res.status !== 200) continue;
    for (const href of hrefs(await res.text())) {
      if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/assets/")) continue;
      const clean = href.split("#")[0];
      // Checkout belongs to the sales area; its links are asserted for shape here and its route by that area's tests.
      if (clean.startsWith("/checkout/")) { checkout.push(clean); continue; }
      // Do not crawl into authenticated areas or forms that change state.
      if (/^\/(staff|portal|account|logout|mfa|password|verify-email|invite)/.test(clean)) continue;
      if (!seen.has(clean)) queue.push(clean);
    }
  }
  assert.ok(seen.size >= 40, `crawled ${seen.size} pages`);
  for (const p of PUBLIC_PATHS) assert.ok(seen.has(p), `${p} is linked from the site`);
  assert.deepEqual([...new Set(checkout)].sort(), ["/checkout/business", "/checkout/premium", "/checkout/starter"]);
});

test("[WEB-009] [CAT-001] prohibited-claims and fabrication scan over every rendered public page", async () => {
  const { client } = await createTestApp();
  const c = client();
  for (const p of [...PUBLIC_PATHS, "/quote/thanks", "/contact/thanks"]) {
    const t = text(await (await c.get(p)).text());
    assert.deepEqual(findProhibitedClaims(t), [], `${p} contains a prohibited claim`);
    for (const re of FABRICATION) assert.doesNotMatch(t, re, `${p} matches ${re}`);
    assert.doesNotMatch(t, /“[^”]{10,}”\s*—/, `${p} shows an unverified testimonial`);
  }
});

test("[CAT-001] service pages cover exactly the approved catalogue and nothing prohibited", async () => {
  const covered = new Set(SERVICES.flatMap((s) => s.approved));
  for (const a of APPROVED_SERVICES) assert.ok(covered.has(a), `approved service ${a} has a page`);
  for (const s of SERVICES) for (const a of s.approved) assert.ok((APPROVED_SERVICES as readonly string[]).includes(a));
  const { client } = await createTestApp();
  const h = text(await (await client().get("/services")).text());
  assert.match(h, /do not run advertising campaigns, operate social media accounts/);
  for (const s of SERVICES) assert.ok(PUBLIC_PATHS.includes(servicePath(s)));
});

test("[WEB-003] [CAT-005] pricing comes only from the catalogue; maintenance entitlements stay unpublished", async () => {
  const { client } = await createTestApp();
  const c = client();
  const pricing = await (await c.get("/pricing")).text();
  assert.match(pricing, /data-testid="price-starter">\$999</);
  assert.match(pricing, /data-testid="price-business">\$2,499</);
  assert.match(pricing, /data-testid="price-premium">\$4,999\+</);
  for (const p of Object.values(PACKAGES)) for (const i of p.includes) assert.ok(pricing.includes(i.replace(/&/g, "&amp;")), `${p.name}: ${i}`);
  const compare = await (await c.get("/pricing/compare")).text();
  assert.match(compare, /<table class="table compare">/);
  for (const p of Object.values(PACKAGES)) assert.ok(compare.includes(`<td>${p.revisionRounds}</td>`));
  assert.ok(hrefs(compare).includes("/checkout/premium"));
  for (const page of ["/", "/pricing", "/hosting-maintenance"]) {
    const h = await (await c.get(page)).text();
    for (const m of Object.values(MAINTENANCE_PLANS)) {
      assert.ok(h.includes(m.name) && h.includes(`$${m.monthlyCents / 100}`), `${page} shows ${m.name}`);
      for (const ent of Object.values(m.proposedEntitlements)) assert.ok(!h.includes(ent), `${page} must not publish proposed entitlement "${ent}"`);
    }
    assert.match(h, /Full plan details will be published here once finalised/);
  }
});

test("[WEB-005] quote form creates a CRM lead with source quote_form and confirms via PRG", async () => {
  const { db, client } = await createTestApp();
  const c = client();
  const form = await (await c.get("/quote?package=premium")).text();
  assert.match(form, /<option value="premium" selected>/);
  const res = await c.post("/quote", { name: "Morgan Hale", email: "morgan@halebuild.example", phone: "+1 517 555 0100", company: "Hale Build", website: "https://halebuild.example",
    interest: "custom", service: "custom-web-applications", budget: "$10,000 – $25,000", timeline: "1 – 3 months", message: "We need a scheduling portal for our crews with customer approvals." });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/quote/thanks");
  const lead = await db.prepare(`SELECT l.id, l.source, l.stage, l.interest, l.message, c.email FROM leads l JOIN contacts c ON c.id = l.contact_id`).first<{ id: string; source: string; stage: string; interest: string; message: string; email: string }>();
  assert.equal(lead?.source, "quote_form");
  assert.equal(lead?.stage, "new");
  assert.equal(lead?.interest, "custom");
  assert.match(lead!.message, /Budget range: \$10,000 – \$25,000/);
  assert.match(lead!.message, /Timeline: 1 – 3 months/);
  assert.match(lead!.message, /Service: Custom web applications/);
  const det = await db.prepare(`SELECT * FROM lead_request_details WHERE lead_id = ?`).bind(lead!.id).first<{ budget_range: string; service_slug: string }>();
  assert.equal(det?.service_slug, "custom-web-applications");
  assert.equal((await lastEmail(db, "morgan@halebuild.example"))?.template, "lead_received");
  const thanks = await c.get("/quote/thanks");
  assert.equal(thanks.status, 200);
  assert.match(await thanks.text(), /Quote request received/);
  assert.ok(await db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'lead.created' AND subject_id = ?`).bind(lead!.id).first());
});

test("[WEB-005] [WEB-004] invalid submissions show accessible errors and write nothing", async () => {
  const { db, client } = await createTestApp();
  const c = client();
  const bad = await c.post("/quote", { name: "A", email: "not-an-email", interest: "custom", budget: "", timeline: "", message: "short", website: "javascript:alert(1)" });
  assert.equal(bad.status, 422);
  const h = await bad.text();
  assert.match(h, /role="alert"/);
  assert.match(h, /aria-invalid="true" aria-describedby="f-email-err"/);
  assert.match(h, /Enter a valid email address/);
  assert.match(h, /Choose a budget range/);
  assert.match(h, /value="A"/, "valid input is preserved");
  const badContact = await c.post("/contact", { name: "Pat", email: "pat@example.com", interest: "other", message: "" });
  assert.equal(badContact.status, 422);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM leads`).first<{ n: number }>())!.n, 0);
  // Honeypot: looks successful to the bot, writes no lead.
  const bot = await c.post("/contact", { name: "Bot", email: "bot@example.com", interest: "other", message: "Buy cheap things now please", fax_number: "123" });
  assert.equal(bot.status, 303);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM leads`).first<{ n: number }>())!.n, 0);
  // Missing CSRF token is refused centrally.
  assert.equal((await c.post("/contact", { name: "Pat", email: "pat@example.com", interest: "other", message: "Hello there team" }, { csrf: false })).status, 403);
});

test("[WEB-004] contact form creates a web_form lead", async () => {
  const { db, client } = await createTestApp();
  const res = await client().post("/contact", { name: "Riley Park", email: "riley@example.com", interest: "maintenance", message: "Do you host sites built elsewhere?" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/contact/thanks");
  const lead = await db.prepare(`SELECT source, interest FROM leads`).first<{ source: string; interest: string }>();
  assert.deepEqual({ ...lead }, { source: "web_form", interest: "maintenance" });
});

test("[WEB-005] bot verification fails closed outside development when Turnstile is not configured", async () => {
  const { db, client } = await createTestApp({ ENVIRONMENT: "staging" });
  const res = await client().post("/contact", { name: "Riley Park", email: "riley@example.com", interest: "other", message: "Hello from staging" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /could not verify/);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM leads`).first<{ n: number }>())!.n, 0);
});

test("[CMS-001] [CMS-002] draft → preview → publish changes public content, with history and audit", async () => {
  const app = await createTestApp();
  const { c, s } = await staffClient(app, "administrator");
  const list = await c.get("/staff/cms");
  assert.equal(list.status, 200);
  assert.match(await list.text(), /Homepage sections/);
  const editor = await c.get("/staff/cms/home.hero");
  assert.equal(editor.status, 200);
  const save = await c.post("/staff/cms/home.hero", { eyebrow: "Crestmont", heading: "Refined websites for serious businesses.", lede: "A new lead paragraph for the homepage hero section.", primary_label: "See packages", quote_label: "Get a quote", note: "test copy" });
  assert.equal(save.status, 303);
  const rev = await app.db.prepare(`SELECT id, status FROM cms_revisions`).first<{ id: string; status: string }>();
  assert.equal(rev?.status, "draft");
  const anon = app.client();
  assert.doesNotMatch(await (await anon.get("/")).text(), /Refined websites for serious businesses/, "drafts are not public");
  assert.doesNotMatch(await (await anon.get(`/?preview=${rev!.id}`)).text(), /Refined websites/, "anonymous visitors cannot preview drafts");
  const preview = await (await c.get(`/?preview=${rev!.id}`)).text();
  assert.match(preview, /Refined websites for serious businesses/);
  assert.match(preview, /Preview of an unpublished revision/);
  const pub = await c.post(`/staff/cms/revisions/${rev!.id}/publish`);
  assert.equal(pub.status, 303);
  assert.match(await (await anon.get("/")).text(), /Refined websites for serious businesses/);
  // second revision archives the first on publish
  await c.post("/staff/cms/home.hero", { eyebrow: "Crestmont", heading: "Second heading for the hero.", lede: "Another lead paragraph for the homepage hero.", primary_label: "See packages", quote_label: "Get a quote" });
  const rev2 = await app.db.prepare(`SELECT id FROM cms_revisions WHERE status = 'draft'`).first<{ id: string }>();
  await c.post(`/staff/cms/revisions/${rev2!.id}/publish`);
  const statuses = (await app.db.prepare(`SELECT status FROM cms_revisions ORDER BY created_at, rowid`).all<{ status: string }>()).results.map((r) => r.status);
  assert.deepEqual(statuses, ["archived", "published"]);
  const hist = await (await c.get("/staff/cms/home.hero")).text();
  assert.match(hist, /Revision history/);
  assert.match(hist, /Archived/);
  const actions = (await app.db.prepare(`SELECT action FROM audit_logs WHERE actor_user_id = ? AND action LIKE 'cms.%'`).bind(s.id).all<{ action: string }>()).results.map((r) => r.action);
  assert.deepEqual(actions.sort(), ["cms.draft_saved", "cms.draft_saved", "cms.published", "cms.published"]);
  // revert to repository default
  assert.equal((await c.post("/staff/cms/home.hero/revert")).status, 303);
  assert.match(await (await anon.get("/")).text(), /Websites built with discipline and care/);
});

test("[CMS-002] CMS validation rejects prohibited claims and empty fields", async () => {
  const app = await createTestApp();
  const { c } = await staffClient(app, "administrator");
  const res = await c.post("/staff/cms/home.cta", { heading: "We guarantee rankings for every client", body: "" });
  assert.equal(res.status, 422);
  const h = await res.text();
  assert.match(h, /prohibited claim/);
  assert.match(h, /Text is required/);
  assert.equal((await app.db.prepare(`SELECT COUNT(*) AS n FROM cms_revisions`).first<{ n: number }>())!.n, 0);
});

test("[CMS-002] staff without cms.edit and anonymous visitors are refused", async () => {
  const app = await createTestApp();
  const { c } = await staffClient(app, "sales");
  assert.equal((await c.get("/staff/cms")).status, 403);
  assert.equal((await c.post("/staff/cms/home.hero", { eyebrow: "x", heading: "x", lede: "x", primary_label: "x", quote_label: "x" })).status, 403);
  assert.equal((await c.get("/staff/portfolio")).status, 403);
  const anon = await app.client().get("/staff/cms");
  assert.equal(anon.status, 303);
  assert.match(anon.headers.get("location") ?? "", /^\/login/);
  assert.equal((await app.db.prepare(`SELECT COUNT(*) AS n FROM cms_revisions`).first<{ n: number }>())!.n, 0);
});

test("[CMS-003] [CAT-007] pricing presentation edits need the Owner to publish and never change checkout prices", async () => {
  const app = await createTestApp();
  const { c: admin } = await staffClient(app, "administrator");
  const { c: owner, s: ownerUser } = await staffClient(app, "owner");
  const fields = { heading: "Investment", lede: "Clear prices for every package.", starter_tagline: "Starter tagline text", business_tagline: "Business tagline text", premium_tagline: "Premium tagline text", custom_heading: "Bespoke work", custom_body: "Larger projects are quoted separately." };
  const priced = await admin.post("/staff/cms/pricing.presentation", { ...fields, starter_tagline: "Now only $499!" });
  assert.equal(priced.status, 422, "prices cannot be typed into the CMS");
  assert.equal((await admin.post("/staff/cms/pricing.presentation", fields)).status, 303);
  const rev = await app.db.prepare(`SELECT id, status, requires_founder_approval FROM cms_revisions`).first<{ id: string; status: string; requires_founder_approval: number }>();
  assert.deepEqual({ ...rev, id: undefined }, { id: undefined, status: "pending_founder_approval", requires_founder_approval: 1 });
  assert.ok(await app.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'cms.pricing_approval'`).bind(ownerUser.id).first(), "Owner is notified");
  assert.equal((await admin.post(`/staff/cms/revisions/${rev!.id}/publish`)).status, 403, "administrator cannot publish pricing presentation");
  assert.doesNotMatch(await (await app.client().get("/pricing")).text(), /Investment/);
  assert.equal((await owner.post(`/staff/cms/revisions/${rev!.id}/publish`)).status, 303);
  const pricing = await (await app.client().get("/pricing")).text();
  assert.match(pricing, /Investment/);
  assert.match(pricing, /data-testid="price-starter">\$999</);
  assert.equal(priceQuote({ packageId: "starter" }).totalCents, 99_900);
  assert.equal(priceQuote({ packageId: "business" }).totalCents, 249_900);
  assert.ok(await app.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'cms.pricing_presentation_approved' AND actor_user_id = ?`).bind(ownerUser.id).first());
});

test("[PORT-004] [PORT-006] seeded portfolio projects are unpublished, verified-only and not public", async () => {
  const { db, client } = await createTestApp();
  const rows = (await db.prepare(`SELECT slug, live_url, published, desktop_screenshot_file_id, mobile_screenshot_file_id, relationship, description FROM portfolio_projects ORDER BY position`).all<Record<string, unknown>>()).results;
  assert.deepEqual(rows.map((r) => r.live_url), ["https://betterlansingmechanics.com", "https://lansingcarrentals.com", "https://mentorship.lansingcarrentals.com"]);
  for (const r of rows) {
    assert.equal(r.published, 0);
    assert.equal(r.desktop_screenshot_file_id, null);
    assert.equal(r.mobile_screenshot_file_id, null);
    assert.match(String(r.relationship), /relationship documentation pending \(BLK-008\)/);
    assert.doesNotMatch(String(r.description), /\b\d+\s+(cars|vehicles)\b|revenue|\$\d/i, "owner-reported figures are not repeated");
  }
  const c = client();
  const list = await (await c.get("/portfolio")).text();
  assert.doesNotMatch(list, /Better Lansing Mechanics|Lansing Car Rentals/);
  assert.match(list, /Portfolio projects are being prepared/);
  assert.doesNotMatch(await (await c.get("/")).text(), /Better Lansing Mechanics/);
  assert.equal((await c.get("/portfolio/better-lansing-mechanics")).status, 404);
  assert.doesNotMatch(await (await c.get("/sitemap.xml")).text(), /portfolio\/better/);
});

test("[PORT-007] publishing is refused while screenshots or relationship documentation are missing", async () => {
  const app = await createTestApp();
  const { c } = await staffClient(app, "owner");
  const id = "pf_better_lansing_mechanics";
  const editor = await (await c.get(`/staff/portfolio/${id}`)).text();
  assert.match(editor, /Publishing is blocked until/);
  assert.match(editor, /shot shot--pending/);
  const refused = await c.post(`/staff/portfolio/${id}/publish`);
  assert.equal(refused.status, 409);
  const h = await refused.text();
  assert.match(h, /genuine desktop screenshot/);
  assert.match(h, /relationship to this business has not been documented/);
  assert.equal((await app.db.prepare(`SELECT published FROM portfolio_projects WHERE id = ?`).bind(id).first<{ published: number }>())!.published, 0);
  // Upload only screenshots: still refused because relationship is pending.
  assert.equal((await c.post(`/staff/portfolio/${id}/screenshot`, { kind: "desktop", captured_on: "2026-10-26", screenshot: pngFile() })).status, 303);
  assert.equal((await c.post(`/staff/portfolio/${id}/screenshot`, { kind: "mobile", captured_on: "2026-10-26", screenshot: pngFile("m.png") })).status, 303);
  assert.equal((await c.post(`/staff/portfolio/${id}/verify-link`, { verified_on: "2026-10-26" })).status, 303);
  assert.equal((await c.post(`/staff/portfolio/${id}/publish`)).status, 409);
  // Non-image uploads are rejected.
  const svg = await c.post(`/staff/portfolio/${id}/screenshot`, { kind: "desktop", captured_on: "2026-10-26", screenshot: new File(["<svg></svg>"], "x.svg", { type: "image/svg+xml" }) });
  assert.equal(svg.status, 422);
  assert.match(await svg.text(), /PNG, JPEG or WebP/);
  const fake = await c.post(`/staff/portfolio/${id}/screenshot`, { kind: "desktop", captured_on: "2026-10-26", screenshot: new File(["not really a png"], "x.png", { type: "image/png" }) });
  assert.equal(fake.status, 422);
});

test("[PORT-007] [PORT-006] full portfolio workflow: upload, replace, verify, document, publish, reorder, testimonials, case study", async () => {
  const app = await createTestApp();
  const { c, s } = await staffClient(app, "administrator");
  const id = "pf_lansing_car_rentals";
  await c.post(`/staff/portfolio/${id}/screenshot`, { kind: "desktop", captured_on: "2026-10-26", screenshot: pngFile() });
  const first = (await app.db.prepare(`SELECT desktop_screenshot_file_id AS f FROM portfolio_projects WHERE id = ?`).bind(id).first<{ f: string }>())!.f;
  await c.post(`/staff/portfolio/${id}/screenshot`, { kind: "desktop", captured_on: "2026-10-27", screenshot: pngFile("d2.png") });
  const second = (await app.db.prepare(`SELECT desktop_screenshot_file_id AS f FROM portfolio_projects WHERE id = ?`).bind(id).first<{ f: string }>())!.f;
  assert.notEqual(first, second);
  assert.equal((await app.db.prepare(`SELECT replaced_by FROM files WHERE id = ?`).bind(first).first<{ replaced_by: string }>())!.replaced_by, second);
  const file = await app.db.prepare(`SELECT f.folder, o.kind FROM files f JOIN organizations o ON o.id = f.organization_id WHERE f.id = ?`).bind(second).first<{ folder: string; kind: string }>();
  assert.deepEqual({ ...file }, { folder: "portfolio", kind: "internal" });
  await c.post(`/staff/portfolio/${id}/screenshot`, { kind: "mobile", captured_on: "2026-10-26", screenshot: pngFile("m.png") });
  assert.equal((await app.client().get(`/portfolio-media/${second}`)).status, 404, "unpublished project media is not public");
  const badRel = await c.post(`/staff/portfolio/${id}/relationship`, { relationship: "Still pending", evidence: "x" });
  assert.equal(badRel.status, 422);
  assert.equal((await c.post(`/staff/portfolio/${id}/relationship`, { relationship: "Website built by the Crestmont Founder for a related business", evidence: "Founder authorization letter on file, dated 2026-10-26" })).status, 303);
  assert.equal((await c.post(`/staff/portfolio/${id}/verify-link`, { verified_on: "2026-10-26" })).status, 303);
  assert.equal((await c.post(`/staff/portfolio/${id}/publish`)).status, 303);
  const anon = app.client();
  const list = await (await anon.get("/portfolio")).text();
  assert.match(list, /Lansing Car Rentals/);
  assert.match(await (await anon.get("/")).text(), /Lansing Car Rentals/);
  const cs = await anon.get("/portfolio/lansing-car-rentals");
  assert.equal(cs.status, 200);
  const csh = await cs.text();
  assert.match(csh, /<dialog id="viewer"/);
  assert.match(csh, /data-viewer/);
  assert.match(csh, /href="https:\/\/lansingcarrentals\.com" rel="noopener" target="_blank">Visit live website/);
  assert.match(csh, /Booking via links to Turo/);
  const media = await anon.get(`/portfolio-media/${second}`);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await media.arrayBuffer()), PNG);
  assert.equal((await anon.get(`/portfolio-media/${first}`)).status, 404, "replaced screenshots are no longer served");
  assert.match(await (await anon.get("/sitemap.xml")).text(), /portfolio\/lansing-car-rentals/);
  // Testimonials need verification evidence and are separate + unpublished by default.
  assert.equal((await c.post(`/staff/portfolio/${id}/testimonials`, { author: "A. Person", body: "Great to work with on this site.", evidence: "" })).status, 422);
  assert.equal((await c.post(`/staff/portfolio/${id}/testimonials`, { author: "A. Person", body: "Great to work with on this site.", evidence: "Email from author dated 2026-10-26 granting permission" })).status, 303);
  assert.doesNotMatch(await (await anon.get("/portfolio/lansing-car-rentals")).text(), /Great to work with/);
  const tid = (await app.db.prepare(`SELECT id, verified_by FROM testimonials`).first<{ id: string; verified_by: string }>())!;
  assert.equal(tid.verified_by, s.id);
  await c.post(`/staff/portfolio/testimonials/${tid.id}/publish`);
  assert.match(await (await anon.get("/portfolio/lansing-car-rentals")).text(), /Great to work with/);
  // Reorder.
  await c.post(`/staff/portfolio/${id}/move`, { dir: "up" });
  const order = (await app.db.prepare(`SELECT id FROM portfolio_projects ORDER BY position`).all<{ id: string }>()).results.map((r) => r.id);
  assert.equal(order[0], id);
  // Changing the live link unpublishes and requires re-verification.
  const p = (await app.db.prepare(`SELECT * FROM portfolio_projects WHERE id = ?`).bind(id).first<Record<string, string>>())!;
  await c.post(`/staff/portfolio/${id}`, { name: p.name, slug: p.slug, industry: p.industry, live_url: "https://example.org", description: p.description, features: "Single-page website", technology_summary: "", relationship: p.relationship });
  const after = (await app.db.prepare(`SELECT published, link_verified_at FROM portfolio_projects WHERE id = ?`).bind(id).first<{ published: number; link_verified_at: string | null }>())!;
  assert.deepEqual({ ...after }, { published: 0, link_verified_at: null });
  const audited = (await app.db.prepare(`SELECT action FROM audit_logs WHERE subject_id = ? AND subject_type = 'portfolio_project'`).bind(id).all<{ action: string }>()).results.map((r) => r.action);
  for (const a of ["portfolio.screenshot_uploaded", "portfolio.screenshot_replaced", "portfolio.relationship_documented", "portfolio.link_verified", "portfolio.published", "portfolio.reordered", "portfolio.unpublished"]) assert.ok(audited.includes(a), a);
});

test("[PORT-007] staff can add a new project; it starts unpublished", async () => {
  const app = await createTestApp();
  const { c } = await staffClient(app, "owner");
  const bad = await c.post("/staff/portfolio", { name: "X", slug: "Bad Slug", industry: "", live_url: "http://insecure.example", description: "short", features: "", technology_summary: "", relationship: "" });
  assert.equal(bad.status, 422);
  const ok = await c.post("/staff/portfolio", { name: "New Project", slug: "new-project", industry: "Retail", live_url: "https://new.example", description: "A verified description of the live website.", features: "Contact form", technology_summary: "", relationship: "Relationship documentation pending" });
  assert.equal(ok.status, 303);
  const row = await app.db.prepare(`SELECT published, position FROM portfolio_projects WHERE slug = 'new-project'`).first<{ published: number; position: number }>();
  assert.deepEqual({ ...row }, { published: 0, position: 4 });
});

test("[PORT-006] /portfolio-media serves only screenshots of published portfolio projects", async () => {
  const app = await createTestApp();
  await createStaff(app.db, "owner");
  const uploader = (await app.db.prepare(`SELECT id FROM users LIMIT 1`).first<{ id: string }>())!.id;
  const customerOrg = newId("org");
  const fid = newId("file");
  await app.db.batch([
    app.db.prepare(`INSERT INTO organizations (id, name, kind, created_at) VALUES (?, 'Customer Co', 'customer', ?)`).bind(customerOrg, nowIso()),
    app.db.prepare(`INSERT INTO files (id, organization_id, r2_key, filename, content_type, size_bytes, sha256, scan_status, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,'clean',?,?)`)
      .bind(fid, customerOrg, "customer/private.png", "private.png", "image/png", PNG.length, "00", uploader, nowIso()),
  ]);
  await app.storage.put("customer/private.png", PNG, "image/png");
  const anon = app.client();
  assert.equal((await anon.get(`/portfolio-media/${fid}`)).status, 404, "customer files are never public");
  assert.equal((await anon.get(`/portfolio-media/file_doesnotexist`)).status, 404);
  assert.equal((await anon.get(`/portfolio-media/..%2F..%2Fetc`)).status, 404);
});

test("[WEB-010] robots disallows everything outside production; sitemap lists public pages", async () => {
  const dev = await createTestApp();
  const r = await dev.client().get("/robots.txt");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "User-agent: *\nDisallow: /\n");
  assert.match(await (await dev.client().get("/")).text(), /<meta name="robots" content="noindex, nofollow">/);
  const staging = await createTestApp({ ENVIRONMENT: "staging" });
  assert.match(await (await staging.client().get("/robots.txt")).text(), /Disallow: \/\n/);
  const prod = await createTestApp({ ENVIRONMENT: "production" });
  const pr = await (await prod.client().get("/robots.txt")).text();
  assert.match(pr, /Allow: \//);
  assert.match(pr, /Disallow: \/staff/);
  assert.match(pr, /Sitemap: http:\/\/crestmont\.test\/sitemap\.xml/);
  const sm = await prod.client().get("/sitemap.xml");
  assert.equal(sm.headers.get("content-type"), "application/xml; charset=utf-8");
  const xml = await sm.text();
  for (const p of PUBLIC_PATHS) assert.ok(xml.includes(`<loc>http://crestmont.test${p}</loc>`), p);
  const home = await (await prod.client().get("/")).text();
  assert.match(home, /<meta name="description" content="[^"]{40,}">/);
  assert.match(home, /<link rel="canonical" href="http:\/\/crestmont\.test\/">/);
});

test("[LEGAL-001] [LEGAL-002] [WEB-008] policy pages are drafts pending attorney review and never claim approval", async () => {
  const { client } = await createTestApp();
  const c = client();
  for (const slug of LEGAL_SLUGS) {
    const h = await (await c.get(`/legal/${slug}`)).text();
    assert.match(h, /Draft — pending attorney review/, slug);
    assert.doesNotMatch(text(h), /(?<!not (yet )?(been )?)\b(reviewed|approved) by (an |our )?attorney|attorney[- ]approved/i, slug);
  }
  const refunds = text(await (await c.get("/legal/refunds")).text());
  assert.match(refunds, /decided by the Founder/);
  assert.match(refunds, /law or payment-card network rules/);
  assert.match(refunds, /AI systems never approve or issue refunds/);
});

test("[IDENT-005] disclosures render business facts only from settings and never invent them", async () => {
  const app = await createTestApp();
  const before = text(await (await app.client().get("/legal/disclosures")).text());
  assert.match(before, /will be published here before Crestmont accepts payments/);
  await app.db.batch([
    app.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('business.legal_name', 'Crestmont Website Development LLC', ?)`).bind(nowIso()),
    app.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('business.address', 'PO Box 100, Lansing, MI 48901', ?)`).bind(nowIso()),
  ]);
  const after = text(await (await app.client().get("/legal/disclosures")).text());
  assert.match(after, /Legal name: Crestmont Website Development LLC/);
  assert.match(after, /Registered business address: PO Box 100, Lansing, MI 48901/);
  assert.match(text(await (await app.client().get("/legal/privacy")).text()), /Crestmont Website Development LLC/);
});

test("[SUP-005] staffed hours come only from settings; no 24/7 human support claim", async () => {
  const app = await createTestApp();
  const sup = text(await (await app.client().get("/legal/support")).text());
  assert.match(sup, /submit support tickets at any time/);
  assert.match(sup, /Staffed support hours will be published on this page/);
  assert.doesNotMatch(sup, /24\/7 (human|live|staff)/i);
  await app.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('support.staffed_hours', 'Mon–Fri 9am–5pm ET', ?)`).bind(nowIso()).run();
  assert.match(text(await (await app.client().get("/legal/support")).text()), /Staffed support hours: Mon–Fri 9am–5pm ET/);
  assert.match(text(await (await app.client().get("/contact")).text()), /Mon–Fri 9am–5pm ET/);
});
