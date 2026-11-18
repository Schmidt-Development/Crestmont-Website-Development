// Live website showcase (Owner, 2026-11-15): a staff member enters a live URL; Crestmont checks the site's own framing
// headers for this origin, and the portfolio shows the REAL, working website when — and only when — the site permits
// it. Screenshots are optional for such entries and remain the honest fallback for sites that refuse framing.
// Consent and ownership records stay mandatory. TEST DATA only; every network answer is a local stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { evaluateFraming, checkEmbed, safePublicUrl, pageFacts } from "../src/services/embed-check.ts";
import { publishBlockers, liveEmbed, previewState, EMBED_MAX_AGE_MS, getBySlug, refreshAllEmbeds, type PortfolioProject } from "../src/services/portfolio.ts";
import { runJobs } from "../src/app/scheduled.ts";

const CRESTMONT = "https://crestmontwebsitedevelopment.com";
const page = (u: string) => new URL(u);
const h = (o: Record<string, string>) => new Headers(o);
const LHC_CSP = "frame-ancestors https://crestmontwebsitedevelopment.com https://www.crestmontwebsitedevelopment.com";

test("[PORT-006] [PORT-007] framing verdict follows the site's own headers exactly (CSP frame-ancestors first, then X-Frame-Options)", () => {
  const lhc = page("https://leadhavencollective.com/");
  assert.equal(evaluateFraming(h({ "content-security-policy": LHC_CSP }), lhc, CRESTMONT).allowed, true, "Lead Haven Collective's policy permits Crestmont");
  assert.equal(evaluateFraming(h({ "content-security-policy": LHC_CSP }), lhc, "https://evil.example.com").allowed, false, "…and nobody else");
  assert.equal(evaluateFraming(h({ "content-security-policy": LHC_CSP }), lhc, "https://crestmont-platform-staging.partners-df4.workers.dev").allowed, false, "…not even Crestmont's staging origin");
  assert.equal(evaluateFraming(h({ "x-frame-options": "DENY" }), lhc, CRESTMONT).allowed, false);
  assert.equal(evaluateFraming(h({ "x-frame-options": "SAMEORIGIN" }), lhc, CRESTMONT).allowed, false);
  assert.equal(evaluateFraming(h({ "content-security-policy": "default-src 'self'; frame-ancestors 'none'" }), lhc, CRESTMONT).allowed, false);
  assert.equal(evaluateFraming(h({ "content-security-policy": "frame-ancestors 'self'" }), lhc, CRESTMONT).allowed, false);
  assert.equal(evaluateFraming(h({ "content-security-policy": "frame-ancestors https:" }), lhc, CRESTMONT).allowed, true);
  assert.equal(evaluateFraming(h({ "content-security-policy": "frame-ancestors *" }), lhc, CRESTMONT).allowed, true);
  assert.equal(evaluateFraming(h({ "content-security-policy": "frame-ancestors *.crestmontwebsitedevelopment.com" }), lhc, CRESTMONT).allowed, false, "a subdomain wildcard does not cover the apex");
  assert.equal(evaluateFraming(h({ "content-security-policy": "frame-ancestors crestmontwebsitedevelopment.com" }), lhc, CRESTMONT).allowed, true, "scheme-less host source");
  assert.equal(evaluateFraming(h({ "content-security-policy": "frame-ancestors https://crestmontwebsitedevelopment.com:8443" }), lhc, CRESTMONT).allowed, false, "wrong port");
  // Every enforced policy must allow it (two policies are combined with a comma by fetch).
  assert.equal(evaluateFraming(h({ "content-security-policy": `${LHC_CSP}, frame-ancestors 'none'` }), lhc, CRESTMONT).allowed, false);
  // frame-ancestors present → X-Frame-Options is ignored by browsers, so the CSP decides.
  assert.equal(evaluateFraming(h({ "content-security-policy": LHC_CSP, "x-frame-options": "DENY" }), lhc, CRESTMONT).allowed, true);
  assert.equal(evaluateFraming(h({}), lhc, CRESTMONT).allowed, true, "no restriction sent");
  assert.equal(evaluateFraming(h({ "x-frame-options": "ALLOW-FROM https://crestmontwebsitedevelopment.com" }), lhc, CRESTMONT).allowed, true, "obsolete ALLOW-FROM is not enforced");
});

test("[PORT-006] [PORT-007] the check only loads public https pages and follows https redirects to the address it frames", async () => {
  for (const bad of ["http://leadhavencollective.com/", "https://127.0.0.1/", "https://localhost/", "https://intranet/", "https://user:pw@example.org/", "https://leadhavencollective.com:8080/", "https://10.0.0.1/", "javascript:alert(1)"])
    assert.equal(safePublicUrl(bad), null, bad);
  const calls: string[] = [];
  const stub: typeof fetch = async (input) => {
    const u = String(input); calls.push(u);
    if (u === "https://www.leadhavencollective.com/") return new Response(null, { status: 301, headers: { location: "https://leadhavencollective.com/" } });
    if (u === "https://leadhavencollective.com/") return new Response(`<html><head><title>Lead Haven Collective — The Right Leads. Every Industry.</title><meta name="description" content="Lead Haven Collective is a multi-industry B2B lead marketplace."></head></html>`, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": LHC_CSP } });
    if (u === "https://redirects-to-http.fixture-portfolio.com/") return new Response(null, { status: 302, headers: { location: "http://redirects-to-http.fixture-portfolio.com/" } });
    if (u === "https://missing.fixture-portfolio.com/") return new Response("no", { status: 404 });
    if (u === "https://pdf.fixture-portfolio.com/") return new Response("%PDF", { headers: { "content-type": "application/pdf" } });
    throw new TypeError("offline");
  };
  const r = await checkEmbed("https://www.leadhavencollective.com/", CRESTMONT, stub);
  assert.equal(r.status, "allowed");
  assert.equal(r.url, "https://leadhavencollective.com/", "frames the final address (no cross-origin redirect inside the frame)");
  assert.equal(r.title, "Lead Haven Collective — The Right Leads. Every Industry.");
  assert.equal(r.description, "Lead Haven Collective is a multi-industry B2B lead marketplace.");
  assert.equal((await checkEmbed("https://redirects-to-http.fixture-portfolio.com/", CRESTMONT, stub)).status, "error");
  assert.match((await checkEmbed("https://missing.fixture-portfolio.com/", CRESTMONT, stub)).detail, /HTTP 404/);
  assert.match((await checkEmbed("https://pdf.fixture-portfolio.com/", CRESTMONT, stub)).detail, /not a web page/);
  assert.match((await checkEmbed("https://down.fixture-portfolio.com/", CRESTMONT, stub)).detail, /did not answer/);
  assert.deepEqual(pageFacts(`<meta property="og:site_name" content="Glassly &amp; Co"><title>x</title>`).siteName, "Glassly & Co");
  assert.equal(pageFacts(`<title>A &amp;quot;B&amp;quot; &amp;lt;C&amp;gt;</title>`).title, "A &quot;B&quot; &lt;C&gt;", "entities are decoded once, never twice");
});

test("[PORT-006] [PORT-007] screenshots are optional only while the live site is verified embeddable; otherwise they stay required", () => {
  const base = { desktop_screenshot_file_id: null, mobile_screenshot_file_id: null, poster_desktop_asset: null, poster_mobile_asset: null, relationship: "Founder-owned", relationship_documented_at: "2026-11-15T00:00:00.000Z", link_verified_at: "2026-11-15T00:00:00.000Z", portfolio_consent_at: "2026-11-15T00:00:00.000Z", portfolio_consent_withdrawn_at: null } as unknown as PortfolioProject;
  const now = new Date().toISOString();
  assert.deepEqual(publishBlockers({ ...base, embed_status: "allowed", embed_url: "https://leadhavencollective.com/", embed_checked_at: now }), [], "a live, interactive entry publishes without screenshots");
  const stale = new Date(Date.now() - EMBED_MAX_AGE_MS - 60_000).toISOString();
  assert.equal(liveEmbed({ embed_status: "allowed", embed_url: "https://leadhavencollective.com/", embed_checked_at: stale }), null, "a stale check no longer counts");
  const blocked = publishBlockers({ ...base, embed_status: "blocked", embed_url: "https://leadhavencollective.com/", embed_checked_at: now });
  assert.equal(blocked.length, 2);
  assert.match(blocked[0], /does not permit embedding/);
  // Consent can never be skipped.
  assert.ok(publishBlockers({ ...base, portfolio_consent_at: null, embed_status: "allowed", embed_url: "https://leadhavencollective.com/", embed_checked_at: now }).some((b) => /opt-in/.test(b)));
});

test("[PORT-006] [PORT-007] the real production website always wins over a demo: native frame, then remote viewer, then the demo (Owner, 2026-11-18)", () => {
  const demo = "https://site-portfolio-demo.example-demos.dev/";
  const approved = new Set([new URL(demo).origin]);
  const now = new Date().toISOString();
  const p = (o: Partial<PortfolioProject>) => ({ live_url: "https://site.fixture-portfolio.com", demo_url: demo, demo_status: "ready", demo_verified_at: now, embed_status: "none", embed_url: null, embed_checked_at: null, display_mode: "unchecked", ...o }) as unknown as PortfolioProject;
  // A ready, verified, approved demo no longer overrides a live website that permits this site.
  const native = previewState(p({ embed_status: "allowed", embed_url: "https://site.fixture-portfolio.com/", embed_checked_at: now, display_mode: "embed" }), approved, Date.now(), true);
  assert.equal(native.kind, "live");
  assert.equal(native.kind === "live" && native.origin, "https://site.fixture-portfolio.com");
  // A site that refuses framing is shown through the remote viewer — the real website, not the demo.
  const remote = previewState(p({ embed_status: "blocked", embed_url: "https://site.fixture-portfolio.com/", embed_checked_at: now, display_mode: "remote" }), approved, Date.now(), true);
  assert.deepEqual(remote, { kind: "remote", url: "https://site.fixture-portfolio.com/" });
  // Only when neither live method is available does the demo appear (honestly labelled as a demo by the explorer).
  assert.equal(previewState(p({ embed_status: "blocked", display_mode: "remote" }), approved, Date.now(), false).kind, "embed", "remote browser off → demo");
  assert.equal(previewState(p({ embed_status: "error", display_mode: "unavailable" }), approved, Date.now(), true).kind, "embed", "site unavailable → demo");
  // A stale permission is not trusted; the remote viewer or the demo takes over.
  const stale = new Date(Date.now() - EMBED_MAX_AGE_MS - 60_000).toISOString();
  assert.equal(previewState(p({ embed_status: "allowed", embed_url: "https://site.fixture-portfolio.com/", embed_checked_at: stale, display_mode: "embed" }), approved, Date.now(), true).kind, "embed");
});

/** A staff-side stub of two websites: one permits Crestmont (the test origin), one refuses framing. */
const sites = (origin: string): typeof fetch => async (input) => {
  const u = String(input);
  if (u.startsWith("https://live-site.fixture-portfolio.com/")) return new Response(`<html><head><title>Live Fixture | Home</title><meta property="og:site_name" content="Live Fixture"><meta name="description" content="Live Fixture is a TEST DATA website that permits Crestmont to show it live."></head></html>`, { headers: { "content-type": "text/html", "content-security-policy": `frame-ancestors ${origin}` } });
  if (u.startsWith("https://locked-site.fixture-portfolio.com/")) return new Response(`<html><head><title>Locked Fixture</title></head></html>`, { headers: { "content-type": "text/html", "x-frame-options": "DENY" } });
  throw new TypeError("offline");
};

test("[PORT-006] [PORT-007] enter a URL → confirm details → native verification in a real browser → publish after authorization, with no screenshot", async () => {
  const t0 = await createTestApp();
  const origin = new URL(t0.env.APP_URL!).origin;
  t0.close();
  // The real-browser step is replaced here (tests/portfolio-native-browser.test.ts drives the real verifier in Chromium);
  // it records what it was asked to verify so the test can open the same verification page.
  const asked: { pageUrl: string; liveOrigin: string }[] = [];
  const nativeVerify = async (pageUrl: string, liveOrigin: string) => { asked.push({ pageUrl, liveOrigin }); return { ok: true, at: new Date().toISOString(), summary: "Verified in a real browser: frame, content, javascript, scroll, click, mobile", checks: [{ name: "frame", ok: true, detail: "loaded" }, { name: "content", ok: true, detail: "visible" }] }; };
  const t = await createTestApp({ overrides: { portfolioFetch: sites(origin), nativeVerify } } as never);
  const owner = await createStaff(t.db, "owner");
  const o = await t.client().login(owner.email, TEST_PASSWORD, owner.secret);

  // Step 1: only the address.
  const list = await (await o.get("/staff/portfolio")).text();
  assert.match(list, /data-testid="pf-new"/);
  // Step 2: Crestmont reads the page and pre-fills it; nothing is saved yet.
  const before = (await t.db.prepare(`SELECT COUNT(*) AS n FROM portfolio_projects`).first<{ n: number }>())!.n;
  const step2 = await (await o.post("/staff/portfolio/new", { live_url: "live-site.fixture-portfolio.com" })).text();
  assert.match(step2, /data-testid="pf-native-plan"/);
  assert.match(step2, /Native-ready/);
  assert.match(step2, /name="name"[^>]*value="Live Fixture"|value="Live Fixture"/);
  assert.match(step2, /value="live-fixture"/);
  assert.match(step2, /Live Fixture is a TEST DATA website/);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM portfolio_projects`).first<{ n: number }>())!.n, before, "nothing saved before confirmation");
  // Confirm: created unpublished, and the live preview is checked straight away.
  const created = await o.post("/staff/portfolio", { name: "Live Fixture", slug: "live-fixture", industry: "Testing", live_url: "https://live-site.fixture-portfolio.com/", description: "Live Fixture is a TEST DATA website that permits Crestmont to show it live.", features: "Home page", technology_summary: "", relationship: "Relationship documentation pending" });
  assert.equal(created.status, 303);
  const p = (await getBySlug(t.db, "live-fixture"))!;
  assert.equal(p.embed_status, "allowed");
  assert.equal(p.embed_url, "https://live-site.fixture-portfolio.com/");
  assert.equal(p.published, 0);
  // A new entry is native-required and was verified straight away, through Crestmont's own verification page.
  assert.equal(p.native_required, 1);
  assert.equal(p.native_state, "native_verified");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].liveOrigin, "https://live-site.fixture-portfolio.com");
  assert.match(asked[0].pageUrl, new RegExp(`^${origin}/portfolio/native-verify/[0-9a-f]+$`));
  const vp = await t.client().get(new URL(asked[0].pageUrl).pathname);
  assert.equal(vp.status, 200);
  const vph = await vp.text();
  assert.match(vph, /<iframe data-testid="native-verify-frame" src="https:\/\/live-site\.fixture-portfolio\.com\/"[^>]*sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"/);
  assert.match(vp.headers.get("content-security-policy")!, /frame-src [^;]*https:\/\/live-site\.fixture-portfolio\.com/);
  assert.match(vp.headers.get("content-security-policy")!, /frame-ancestors 'none'/, "the verification page itself cannot be framed");
  assert.equal((await t.client().get("/portfolio/native-verify/not-a-token")).status, 404);
  // The editor shows the real website in the explorer, lists only authorization steps, and frames exactly that origin.
  const ed = await o.get(`/staff/portfolio/${p.id}`);
  const edh = await ed.text();
  assert.match(edh, /data-kind="live"[^>]*data-frame-url="https:\/\/live-site\.fixture-portfolio\.com\/"/);
  assert.match(ed.headers.get("content-security-policy")!, /frame-src [^;]*https:\/\/live-site\.fixture-portfolio\.com/);
  assert.doesNotMatch(edh, /screenshot of the live site has not been uploaded/);
  assert.match(edh, /data-testid="pf-native" data-native-state="native_verified"/);
  assert.match(edh, /Live website — Native \(verified\)/);
  assert.match(edh, /The preview shows the correct website/);
  // Publishing is still refused until the relationship, link and owner's consent are recorded — never assumed.
  assert.equal((await o.post(`/staff/portfolio/${p.id}/publish`, {})).status, 409);
  await o.post(`/staff/portfolio/${p.id}/verify-link`, { verified_on: new Date().toISOString().slice(0, 10) });
  await o.post(`/staff/portfolio/${p.id}/relationship`, { relationship: "Client website built by the Crestmont team (TEST DATA)", evidence: "Signed engagement letter on file, TEST DATA" });
  await o.post(`/staff/portfolio/${p.id}/consent`, { given_by: "Test Owner, owner", method: "written", given_on: "2026-11-15", evidence: "Consent email on file, TEST DATA" });
  assert.equal((await o.post(`/staff/portfolio/${p.id}/publish`, {})).status, 303);
  assert.equal((await getBySlug(t.db, "live-fixture"))!.published, 1, "published with no screenshot at all");

  // Public case study: the live website, the right CSP, honest labels, structured data, no "capture pending" boxes.
  const pub = await t.client().get("/portfolio/live-fixture");
  const html = await pub.text();
  assert.equal(pub.status, 200);
  assert.match(html, /class="pfx__flag pfx__flag--live"/);
  assert.match(html, /Live website<\/span>/);
  assert.match(html, /The real, live website — native, verified in a real browser/);
  assert.match(html, /data-pfx-expand[^>]*>Full screen</);
  assert.match(html, /Visit live website/);
  assert.match(html, /"@type":"CreativeWork"/);
  assert.doesNotMatch(html, /capture pending/i);
  assert.match(pub.headers.get("content-security-policy")!, /frame-src https:\/\/challenges\.cloudflare\.com https:\/\/live-site\.fixture-portfolio\.com/);

  // A site that refuses framing, with no hosting connection configured: never handed to the remote browser or a
  // screenshot; the editor says exactly what is needed, the origin is never framed, and it cannot be published.
  await o.post("/staff/portfolio", { name: "Locked Fixture", slug: "locked-fixture", industry: "Testing", live_url: "https://locked-site.fixture-portfolio.com/", description: "Locked Fixture is a TEST DATA website that refuses to be framed.", features: "", technology_summary: "", relationship: "Relationship documentation pending" });
  const lk = (await getBySlug(t.db, "locked-fixture"))!;
  assert.equal(lk.embed_status, "blocked");
  const lkh = await o.get(`/staff/portfolio/${lk.id}`);
  const lkt = await lkh.text();
  assert.equal(lk.display_mode, "unavailable");
  assert.equal(lk.native_state, "authorization_required");
  assert.match(lkt, /data-native-state="authorization_required"/);
  assert.match(lkt, /Authorization required/);
  assert.match(lkt, /X-Frame-Options: DENY/);
  assert.match(lkt, /PORTFOLIO_CLOUDFLARE_TOKEN/, "names the exact connection that is missing");
  assert.match(lkt, /never changes a site it cannot prove you control/);
  assert.doesNotMatch(lkt, /data-frame-url="https:\/\/locked-site/);
  assert.doesNotMatch(lkh.headers.get("content-security-policy")!, /locked-site/);
  assert.match(lkt, /not verified as a native embed yet/);
  assert.doesNotMatch(lkt, /screenshot of the live site has not been uploaded/, "screenshots are no substitute for a new entry");
  assert.equal(asked.length, 1, "nothing to verify while the site refuses");
  t.close();
});

test("[PORT-006] [PORT-007] daily re-check and the release pipeline: a site that stops permitting framing falls back to its screenshot", async () => {
  let permit = true;
  const t0 = await createTestApp(); const origin = new URL(t0.env.APP_URL!).origin; t0.close();
  const stub: typeof fetch = async () => new Response("<title>x</title>", { headers: { "content-type": "text/html", ...(permit ? { "content-security-policy": `frame-ancestors ${origin}` } : { "x-frame-options": "DENY" }) } });
  const t = await createTestApp({ overrides: { portfolioFetch: stub } } as never);
  const r1 = await runJobs(t.env, ["portfolio_embeds"]);
  assert.equal(r1.portfolio_embeds.ok, true);
  assert.match(r1.portfolio_embeds.detail, /:allowed/);
  permit = false;
  const r2 = await runJobs(t.env, ["portfolio_embeds"]);
  assert.match(r2.portfolio_embeds.detail, /:blocked/);
  const anyAllowed = await t.db.prepare(`SELECT COUNT(*) AS n FROM portfolio_projects WHERE embed_status = 'allowed'`).first<{ n: number }>();
  assert.equal(anyAllowed!.n, 0);
  // A check that cannot reach the site does not erase a recent permission (a definite refusal does, as above).
  permit = true; await runJobs(t.env, ["portfolio_embeds"]);
  const before = await t.db.prepare(`SELECT embed_status, embed_checked_at FROM portfolio_projects WHERE slug = 'lead-haven-collective'`).first<{ embed_status: string; embed_checked_at: string }>();
  assert.equal(before!.embed_status, "allowed");
  const down = await createTestApp({ DB: t.db, overrides: { portfolioFetch: async () => { throw new TypeError("network"); } } } as never);
  await runJobs(down.env, ["portfolio_embeds"]);
  const after = await t.db.prepare(`SELECT embed_status, embed_checked_at, embed_detail FROM portfolio_projects WHERE slug = 'lead-haven-collective'`).first<{ embed_status: string; embed_checked_at: string; embed_detail: string }>();
  assert.equal(after!.embed_status, "allowed");
  assert.equal(after!.embed_checked_at, before!.embed_checked_at);
  assert.match(after!.embed_detail, /could not reach the site/);
  // The ops endpoint (release pipeline) refuses an unsigned call.
  const unsigned = await t.client().request("POST", "/api/ops/portfolio-embeds", { body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(unsigned.status, 401);
  t.close();
});

test("[PORT-006] [PORT-007] migration 0108: Lead Haven Collective keeps its existing record; only missing authorization is recorded and it publishes once the live check passes", async () => {
  const sql = readFileSync("migrations/0108_lead_haven_collective_portfolio.sql", "utf8");
  const allow: typeof fetch = async () => new Response("<title>LHC</title>", { headers: { "content-type": "text/html", "content-security-policy": LHC_CSP } });
  const lhcOrigin = CRESTMONT;

  // A record the Owner created in Staff → Portfolio (blocked by the old screenshot rule): its copy must survive.
  const t = await createTestApp();
  t.db.raw.exec(`DELETE FROM portfolio_projects WHERE slug = 'lead-haven-collective'`);
  // (created before migration 0110, so it is an existing — not native-required — entry)
  t.db.raw.exec(`INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, technology_summary, position, published, updated_at, created_at, native_required, native_state)
    VALUES ('pf_owner_lhc', 'lead-haven-collective', 'Lead Haven Collective', 'Lead generation', 'https://leadhavencollective.com/', 'Relationship documentation pending', 'OWNER WRITTEN description of Lead Haven Collective.', '["Owner feature one","Owner feature two"]', NULL, 9, 0, '2026-11-14T00:00:00.000Z', '2026-11-14T00:00:00.000Z', 0, 'legacy')`);
  t.db.raw.exec(sql);
  let p = (await getBySlug(t.db, "lead-haven-collective"))!;
  assert.equal(p.id, "pf_owner_lhc", "the existing record is used");
  assert.equal(p.description, "OWNER WRITTEN description of Lead Haven Collective.");
  assert.equal(p.verified_features_json, '["Owner feature one","Owner feature two"]');
  assert.equal(p.industry, "Lead generation");
  assert.ok(p.relationship_documented_at && !/pending/i.test(p.relationship));
  assert.equal(p.portfolio_consent_method, "written");
  assert.match(p.portfolio_consent_evidence!, /2026-11-15/);
  assert.equal(p.publish_when_ready, 1);
  assert.equal(p.published, 0, "not published by the migration itself");
  // Not publishable until the live check confirms embedding (it has no screenshots).
  assert.ok(publishBlockers(p).some((b) => /screenshot/.test(b)));
  const r = await refreshAllEmbeds(t.db, lhcOrigin, allow);
  assert.deepEqual(r.find((x) => x.slug === "lead-haven-collective"), { slug: "lead-haven-collective", status: "allowed", mode: "embed", detail: `Content-Security-Policy frame-ancestors allows ${CRESTMONT}`, published: true });
  p = (await getBySlug(t.db, "lead-haven-collective"))!;
  assert.equal(p.published, 1);
  assert.equal(p.publish_when_ready, 0, "one time only: a later unpublish by the Owner stands");
  t.db.raw.exec(sql); // re-running changes nothing
  assert.equal((await getBySlug(t.db, "lead-haven-collective"))!.publish_when_ready, 0);
  t.close();

  // A recorded consent withdrawal is never overwritten.
  const w = await createTestApp();
  w.db.raw.exec(`UPDATE portfolio_projects SET portfolio_consent_at = NULL, portfolio_consent_withdrawn_at = '2026-11-14T00:00:00.000Z', publish_when_ready = 0 WHERE slug = 'lead-haven-collective'`);
  w.db.raw.exec(sql);
  const wp = (await getBySlug(w.db, "lead-haven-collective"))!;
  assert.equal(wp.portfolio_consent_at, null);
  assert.equal(wp.publish_when_ready, 0);
  w.close();

  // No record at all: one is created, unpublished, at the end of the order.
  const n = await createTestApp();
  const row = (await getBySlug(n.db, "lead-haven-collective"))!;
  assert.equal(row.name, "Lead Haven Collective");
  assert.equal(row.live_url, "https://leadhavencollective.com/");
  assert.equal(row.published, 0);
  n.close();
});

test("[PORT-006] [PORT-007] production wiring: the check passes through the Worker's egress allowlist — the checked host only, only for that request", async () => {
  // Production installs guardFetch over the global fetch (src/worker.ts → installEgressGuard). Deploys 43759950375 and
  // 43764297050 showed every live check "did not answer": the guard refused the client sites before any request left.
  const { guardFetch, egressAllowed } = await import("../src/lib/egress.ts");
  const seen: string[] = [];
  const network: typeof fetch = async (input) => {
    const u = String(input); seen.push(u);
    if (u === "https://www.leadhavencollective.com/") return new Response(null, { status: 301, headers: { location: "https://leadhavencollective.com/" } });
    return new Response("<title>Lead Haven Collective</title>", { headers: { "content-type": "text/html", "content-security-policy": LHC_CSP } });
  };
  const guarded = guardFetch(network);
  // Without per-request permission the guard refuses — and the real cause is now reported, not a bare "network error".
  const blocked = await (async () => { try { await guarded("https://leadhavencollective.com/"); return null; } catch (e) { return e as Error; } })();
  assert.equal(blocked?.name, "EgressBlockedError");
  // Through checkEmbed: allowed for each hop (www → apex redirect included), and removed again afterwards.
  const r = await checkEmbed("https://www.leadhavencollective.com/", CRESTMONT, guarded);
  assert.equal(r.status, "allowed", r.detail);
  assert.deepEqual(seen, ["https://www.leadhavencollective.com/", "https://leadhavencollective.com/"]);
  assert.equal(egressAllowed("https://leadhavencollective.com/"), false, "the host is not left on the allowlist");
  assert.equal(egressAllowed("https://www.leadhavencollective.com/"), false);
  // Crestmont's own provider hosts and paid AI APIs are never checked, even when entered as a live link.
  for (const u of ["https://api.stripe.com/", "https://api.resend.com/", "https://api.anthropic.com/"]) {
    const x = await checkEmbed(u, CRESTMONT, guarded);
    assert.equal(x.status, "error"); assert.match(x.detail, /not a client website/);
  }
  assert.equal(seen.length, 2, "no request was made to a provider host");
  // A genuine network failure keeps its cause in the recorded detail.
  const down = await checkEmbed("https://leadhavencollective.com/", CRESTMONT, guardFetch(async () => { throw new TypeError("fetch failed"); }));
  assert.match(down.detail, /did not answer \(TypeError: fetch failed\)/);

  // End to end with the guard in place: the daily job publishes Lead Haven Collective (no screenshots needed).
  // (The test app's origin is http://crestmont.test, so the stubbed site permits exactly that origin here.)
  const appNet = guardFetch(async () => new Response("<title>LHC</title>", { headers: { "content-type": "text/html", "content-security-policy": "frame-ancestors http://crestmont.test" } }));
  const t = await createTestApp({ overrides: { portfolioFetch: appNet } } as never);
  const res = await runJobs(t.env, ["portfolio_embeds"]);
  assert.match(res.portfolio_embeds.detail, /lead-haven-collective:allowed\+published/);
  const lhc = (await getBySlug(t.db, "lead-haven-collective"))!;
  assert.equal(lhc.embed_status, "allowed", lhc.embed_detail ?? "");
  assert.equal(lhc.published, 1, "published once every requirement is met — no screenshot needed");
  t.close();
});
