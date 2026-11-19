// Native readiness for new portfolio entries (Owner, 2026-11-18): a website the Owner controls is prepared through the
// authorized provider connections, followed through its deployment and verified before it can be shown — and every
// way that can fail is reported exactly. Providers and sites are the hermetic TEST DATA world (support/native-world.ts);
// the real-browser step is replaced here (tests/portfolio-native-browser.test.ts runs the real verifier in Chromium).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { NativeWorld, homepage, page } from "./support/native-world.ts";
import { getBySlug, getById, publishBlockers } from "../src/services/portfolio.ts";
import { runJobs } from "../src/app/scheduled.ts";
import { publicPaths, sensitiveLinks, crestmontOrigins, isPublicPath, frameAncestorsValue } from "../src/services/native/standard.ts";
import { editVercelJson, editPagesHeaders, EditError } from "../src/services/native/editors.ts";
import { desiredRule, rewriteFrameAncestors } from "../src/services/native/cloudflare.ts";
import { connectionsFrom } from "../src/services/native/connections.ts";

const TOKENS = { PORTFOLIO_CLOUDFLARE_TOKEN: "cf-test-token", PORTFOLIO_VERCEL_TOKEN: "vc-test-token", PORTFOLIO_GITHUB_TOKEN: "gh-test-token" };
const ACCT = "a".repeat(32);
type V = { ok: boolean; at: string; summary: string; checks: { name: string; ok: boolean; detail: string }[] };
const passing = async (): Promise<V> => ({ ok: true, at: new Date().toISOString(), summary: "Verified in a real browser: frame, content, javascript, canvas, scroll, click, mobile", checks: [{ name: "frame", ok: true, detail: "loaded" }] });

async function setup(world: NativeWorld, env: Record<string, unknown> = TOKENS, verify: (u: string, o: string) => Promise<V> = passing) {
  const verified: string[] = [];
  const t = await createTestApp({ ...env, overrides: { portfolioFetch: world.fetchSite, providerFetch: world.fetchApi, nativeVerify: async (u: string, o: string) => { verified.push(o); return verify(u, o); } } } as never);
  const owner = await createStaff(t.db, "owner");
  const o = await t.client().login(owner.email, TEST_PASSWORD);
  const add = async (slug: string, url: string) => {
    const r = await o.post("/staff/portfolio", { name: slug, slug, industry: "Testing", live_url: url, description: `${slug} is a TEST DATA website for native onboarding.`, features: "", technology_summary: "", relationship: "Relationship documentation pending" });
    assert.equal(r.status, 303);
    return (await getBySlug(t.db, slug))!;
  };
  const again = async (id: string) => { await o.post(`/staff/portfolio/${id}/embed-check`, {}); return (await getById(t.db, id))!; };
  const tick = async (id: string) => { await runJobs(t.env, ["portfolio_native"]); return (await getById(t.db, id))!; };
  return { t, o, add, again, tick, verified };
}
const site = (host: string, extra: Partial<Parameters<NativeWorld["site"]>[0]> = {}) => ({ host, pages: { "/": homepage(host), "/services": page("Services"), "/about": page("About"), "/login": page("Sign in"), "/book": page("Book") }, ...extra });

test("[PORT-NATIVE] standard: Crestmont origins, public paths from the homepage (sensitive and query links never), deterministic rule, safe editors", () => {
  assert.deepEqual(crestmontOrigins("https://crestmontwebsitedevelopment.com"), ["https://crestmontwebsitedevelopment.com", "https://www.crestmontwebsitedevelopment.com"]);
  assert.deepEqual(crestmontOrigins("https://www.crestmontwebsitedevelopment.com"), ["https://crestmontwebsitedevelopment.com", "https://www.crestmontwebsitedevelopment.com"]);
  assert.equal(frameAncestorsValue("https://crestmontwebsitedevelopment.com"), "frame-ancestors https://crestmontwebsitedevelopment.com https://www.crestmontwebsitedevelopment.com");
  const html = `<a href="/services">s</a><a href="/about/">a</a><a href="/login">l</a><a href="/account/settings">x</a><a href="/book">b</a><a href="/quote">q</a><a href="/checkout">c</a><a href="/api/x">api</a><a href="/blog?id=1">q</a><a href="https://other.com/x">o</a><a href="/file.pdf">f</a><a href="mailto:a@b.com">m</a><a href="#top">t</a>`;
  assert.deepEqual(publicPaths("https://site.com/", html), ["/", "/about", "/about/", "/services", "/services/"]);
  assert.deepEqual(sensitiveLinks("https://site.com/", html), ["/account/settings", "/api/x", "/book", "/checkout", "/login", "/quote"]);
  for (const p of ["/login", "/sign-up", "/owner/dash", "/admin", "/checkout/x", "/billing", "/pay", "/apply", "/partner/apply", "/book", "/quote", "/invoices/9", "/token/x", "/api/v1", "/x?y"]) assert.equal(isPublicPath(p), false, p);
  // The Cloudflare rule is a pure function of the input (re-running cannot drift).
  return Promise.all([desiredRule("a.com", ["/x", "/"], "frame-ancestors X"), desiredRule("a.com", ["/", "/x", "/x"], "frame-ancestors X")]).then(([a, b]) => {
    assert.deepEqual(a, b);
    assert.equal(a.expression, '(http.host eq "a.com" and http.request.uri.path in {"/" "/x"})');
    assert.deepEqual(a.action_parameters, { headers: { "Content-Security-Policy": { operation: "add", value: "frame-ancestors X" }, "X-Frame-Options": { operation: "remove" } } });
    // vercel.json: other keys and header rules kept; Crestmont's entries replaced, never duplicated; unsafe input refused.
    const before = JSON.stringify({ framework: "nextjs", headers: [{ source: "/(.*)", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] }] });
    const once = editVercelJson(before, ["/", "/about"], "frame-ancestors https://crestmontwebsitedevelopment.com");
    assert.equal(editVercelJson(once, ["/", "/about"], "frame-ancestors https://crestmontwebsitedevelopment.com"), once, "idempotent");
    const j = JSON.parse(once);
    assert.equal(j.framework, "nextjs");
    assert.deepEqual(j.headers[0], { source: "/(.*)", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] });
    assert.equal(j.headers.length, 3);
    assert.throws(() => editVercelJson("{not json", ["/"], "frame-ancestors x"), EditError);
    assert.throws(() => editVercelJson(JSON.stringify({ routes: [] }), ["/"], "frame-ancestors x"), /legacy `routes`/);
    const h = editPagesHeaders("/*\n  X-Frame-Options: DENY\n", ["/"], "frame-ancestors https://crestmontwebsitedevelopment.com");
    assert.equal(editPagesHeaders(h, ["/"], "frame-ancestors https://crestmontwebsitedevelopment.com"), h, "idempotent");
    assert.match(h, /^\/\*\n {2}X-Frame-Options: DENY\n/, "the site's own rules are kept");
    assert.throws(() => editPagesHeaders("# crestmont-native-embedding:start — x\n/", ["/"], "x"), /incomplete/);
    assert.deepEqual(connectionsFrom({}), { cloudflare: null, vercel: null, github: null });
  });
});

test("[PORT-NATIVE] Cloudflare-hosted owned site: refuses → Crestmont's zone rule on the public paths only → headers change → verified → publishable; re-running changes nothing", async () => {
  const w = new NativeWorld().site(site("cf-owned.fixture-native.com")).cloudflareZone("fixture-native.com", ACCT, { workerDomain: { hostname: "cf-owned.fixture-native.com", service: "cf-owned" } });
  const { t, o, add, again, tick, verified } = await setup(w);
  const step2 = await (await o.post("/staff/portfolio/new", { live_url: "cf-owned.fixture-native.com" })).text();
  assert.match(step2, /Crestmont will prepare this website for native embedding/);
  assert.match(step2, /Workers custom domain \(cf-owned\)/, "the hosting is discovered through the authorized account before anything is created");
  let p = await add("cf-owned", "https://cf-owned.fixture-native.com/");
  assert.equal(p.native_state, "preparing");
  assert.match(p.native_provider!, /cloudflare-zone \(Workers custom domain \(cf-owned\)\)/);
  const rules = w.zones[0].rulesets!.rules;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].expression, '(http.host eq "cf-owned.fixture-native.com" and http.request.uri.path in {"/" "/about" "/about/" "/services" "/services/"})', "public pages only — /login and /book are never listed");
  assert.equal(verified.length, 0, "nothing verified while the site still refused at the first check");
  // Next step (the 15-minute job): the site now permits Crestmont → real-browser verification → native verified.
  p = await tick(p.id);
  assert.equal(p.native_state, "native_verified", p.native_reason!);
  assert.equal(p.embed_status, "allowed");
  assert.deepEqual(verified, ["https://cf-owned.fixture-native.com"]);
  assert.match(p.native_verification!, /"name":"protected pages","ok":true,"detail":"Sensitive pages still refuse framing: \/book, \/login"/);
  assert.equal(w.respond("https://cf-owned.fixture-native.com/login")!.headers["x-frame-options"], "DENY", "sensitive pages unchanged");
  // Publishing: only the existing authorization steps remain — no screenshots, no other substitute.
  assert.deepEqual(publishBlockers(p).filter((b) => /native|screenshot/i.test(b)), []);
  await o.post(`/staff/portfolio/${p.id}/verify-link`, { verified_on: new Date().toISOString().slice(0, 10) });
  await o.post(`/staff/portfolio/${p.id}/relationship`, { relationship: "Website owned by the Owner (TEST DATA)", evidence: "TEST DATA ownership record" });
  await o.post(`/staff/portfolio/${p.id}/consent`, { given_by: "Test Owner, owner", method: "written", given_on: new Date().toISOString().slice(0, 10), evidence: "TEST DATA consent on file" });
  assert.equal((await o.post(`/staff/portfolio/${p.id}/publish`, {})).status, 303);
  const pub = await t.client().get("/portfolio/cf-owned");
  assert.match(await pub.text(), /data-kind="live"[^>]*data-frame-url="https:\/\/cf-owned\.fixture-native\.com\/"/);
  // Re-running ("Check again", forced) re-verifies but does not touch the provider again: no duplicate rule.
  const writes = w.writes.length;
  p = await again(p.id);
  assert.equal(p.native_state, "native_verified");
  assert.equal(w.zones[0].rulesets!.rules.length, 1);
  assert.equal(w.writes.length, writes, "no provider write on a re-check");
  t.close();
});

test("[PORT-NATIVE] Vercel + GitHub (unprotected): PR with vercel.json → merged → deployment READY → verified; one PR only; protected branch waits for the Owner", async () => {
  const w = new NativeWorld().site(site("vc-owned.fixture-native.com"))
    .vercel({ id: "prj_vc", name: "vc-owned", domain: "vc-owned.fixture-native.com", verified: true, repo: "owner/vc-owned", branch: "main", root: "" })
    .repo("owner/vc-owned", { files: { "vercel.json": JSON.stringify({ framework: "nextjs" }) } })
    .site(site("vc-protected.fixture-native.com"))
    .vercel({ id: "prj_vp", name: "vc-protected", domain: "vc-protected.fixture-native.com", verified: true, repo: "owner/vc-protected", branch: "main", root: "" })
    .repo("owner/vc-protected", { protectedReviews: true });
  const { t, o, add, again, tick } = await setup(w, { PORTFOLIO_VERCEL_TOKEN: "vc-test-token", PORTFOLIO_GITHUB_TOKEN: "gh-test-token" });
  let p = await add("vc-owned", "https://vc-owned.fixture-native.com/");
  const repo = w.repos.get("owner/vc-owned")!;
  assert.equal(repo.pulls.length, 1);
  assert.equal(repo.pulls[0].merged, true, "unprotected branch: merged by Crestmont once GitHub reported it mergeable");
  const merged = JSON.parse(repo.branches.main.files["vercel.json"]);
  assert.equal(merged.framework, "nextjs", "the site's own settings are kept");
  assert.deepEqual(merged.headers.map((h: { source: string }) => h.source), ["/", "/about", "/about/", "/services", "/services/"]);
  assert.equal(p.native_state, "preparing");
  assert.match(p.native_reason!, /Merged https:\/\/github\.com\/owner\/vc-owned\/pull\/1; Vercel deployment .*BUILDING/);
  p = await tick(p.id);  // the deployment finishes → the site permits Crestmont on the next check
  if (p.native_state !== "native_verified") p = await tick(p.id);
  assert.equal(p.native_state, "native_verified", p.native_reason!);
  p = await again(p.id);
  assert.equal(repo.pulls.length, 1, "no second PR");
  // Protected production branch: the PR waits for the Owner's own approval — Crestmont never merges it.
  let q = await add("vc-protected", "https://vc-protected.fixture-native.com/");
  assert.equal(q.native_state, "authorization_required");
  assert.match(q.native_reason!, /Waiting for your approval: review and merge https:\/\/github\.com\/owner\/vc-protected\/pull\/1/);
  const ed = await (await o.get(`/staff/portfolio/${q.id}`)).text();
  assert.match(ed, /data-native-state="authorization_required"/);
  assert.match(ed, /href="https:\/\/github\.com\/owner\/vc-protected\/pull\/1"/);
  assert.equal(w.repos.get("owner/vc-protected")!.pulls[0].merged, false);
  q = await again(q.id);
  assert.equal(w.repos.get("owner/vc-protected")!.pulls.length, 1, "the same PR is kept, not reopened");
  w.ownerMerges("owner/vc-protected", 1);
  for (let i = 0; i < 4 && q.native_state !== "native_verified"; i++) q = await again(q.id);
  assert.equal(q.native_state, "native_verified", q.native_reason!);
  t.close();
});

test("[PORT-NATIVE] Cloudflare Pages (static, Git-linked): _headers in the published folder via a PR → deployed → verified", async () => {
  const w = new NativeWorld().site(site("pg-owned.fixture-native.com")).cloudflareZone("other-zone.com", ACCT)
    .pages({ name: "pg-owned", account: ACCT, domain: "pg-owned.fixture-native.com", repo: "owner/pg-owned", branch: "production", destination: "public", buildCommand: "" })
    .repo("owner/pg-owned", { branch: "production", files: { "public/_headers": "/*\n  X-Frame-Options: DENY\n" } });
  // The Pages domain is not in a connected zone, so the change goes through its repository.
  w.zones.length = 0; w.zones.push({ id: "z".repeat(32), name: "unrelated.com", account: ACCT, rulesets: null, dns: [], workerDomains: [] });
  const { t, add, tick } = await setup(w, { PORTFOLIO_CLOUDFLARE_TOKEN: "cf-test-token", PORTFOLIO_GITHUB_TOKEN: "gh-test-token" });
  let p = await add("pg-owned", "https://pg-owned.fixture-native.com/");
  const files = w.repos.get("owner/pg-owned")!.branches.production.files;
  assert.match(files["public/_headers"], /^\/\*\n {2}X-Frame-Options: DENY\n\n# crestmont-native-embedding:start/);
  assert.doesNotMatch(files["public/_headers"], /\/login|\/book/);
  for (let i = 0; i < 4 && p.native_state !== "native_verified"; i++) p = await tick(p.id);
  assert.equal(p.native_state, "native_verified", p.native_reason!);
  t.close();
});

test("[PORT-NATIVE] negatives: no connection, unknown domain, unverified Vercel domain, read-only repository, CSP conflict, invalid link — each reported exactly; nothing changed at any provider", async () => {
  const w = new NativeWorld()
    .site(site("unknown.fixture-native.com"))
    .site(site("unverified.fixture-native.com")).vercel({ id: "prj_u", name: "u", domain: "unverified.fixture-native.com", verified: false, repo: "owner/u", branch: "main", root: "" })
    .site(site("readonly.fixture-native.com")).vercel({ id: "prj_r", name: "r", domain: "readonly.fixture-native.com", verified: true, repo: "someone-else/r", branch: "main", root: "" }).repo("someone-else/r", { push: false })
    .site(site("conflict.fixture-native.com", { baseCsp: "default-src 'self'; frame-ancestors 'none'", cspNonce: true })).cloudflareZone("conflict.fixture-native.com", ACCT, { proxied: ["conflict.fixture-native.com"] });
  const none = await setup(w, {});
  const a = await none.add("no-conn", "https://unknown.fixture-native.com/");
  assert.equal(a.native_state, "authorization_required");
  assert.match(a.native_reason!, /No hosting or repository connection is configured/);
  none.t.close();
  const { t, o, add } = await setup(w);
  const u = await add("unknown", "https://unknown.fixture-native.com/");
  assert.equal(u.native_state, "authorization_required");
  assert.match(u.native_reason!, /not served by any connected account .*Cloudflare: unknown\.fixture-native\.com is not in any Cloudflare zone or Pages project this connection can read; Vercel: .*not a domain of any project/);
  const v = await add("unverified", "https://unverified.fixture-native.com/");
  assert.match(v.native_reason!, /attached to the Vercel project u but not verified there, so Crestmont does not treat it as yours/);
  const r = await add("readonly", "https://readonly.fixture-native.com/");
  assert.equal(r.native_state, "authorization_required");
  assert.match(r.native_reason!, /can read someone-else\/r but cannot push to it/);
  const c = await add("conflict", "https://conflict.fixture-native.com/");
  assert.equal(c.native_state, "unavailable");
  assert.match(c.native_reason!, /own Content-Security-Policy sets "frame-ancestors 'none'".*cannot replace just that directive: the site's Content-Security-Policy changes between requests/);
  assert.equal(w.zones[0].rulesets, null, "no rule added when it could not work");
  assert.deepEqual(w.writes, [], "nothing was changed at any provider in any of these cases");
  // An invalid link is refused at step 1.
  const bad = await o.post("/staff/portfolio/new", { live_url: "http://10.0.0.1/admin" });
  assert.equal(bad.status, 422);
  t.close();
});

test("[PORT-NATIVE] negatives: failed deployment, a rule without effect (removed, not re-applied), a PR closed unmerged (not reopened), a failed browser verification, redirects", async () => {
  const w = new NativeWorld()
    .site(site("faildeploy.fixture-native.com")).vercel({ id: "prj_f", name: "f", domain: "faildeploy.fixture-native.com", verified: true, repo: "owner/f", branch: "main", root: "", failDeploy: true }).repo("owner/f")
    .site(site("noeffect.fixture-native.com", { ruleTakesEffect: false })).cloudflareZone("noeffect.fixture-native.com", ACCT, { proxied: ["noeffect.fixture-native.com"] })
    .site(site("closed.fixture-native.com")).vercel({ id: "prj_c", name: "c", domain: "closed.fixture-native.com", verified: true, repo: "owner/c", branch: "main", root: "" }).repo("owner/c", { protectedReviews: true })
    .site(site("webglfail.fixture-native.com", { baseXfo: null }))
    .site({ host: "redirect.fixture-native.com", pages: {}, redirectTo: "https://www.redirect-target.com/" }).site(site("www.redirect-target.com", { baseXfo: null }));
  let now = Date.now();
  const failing = async (_u: string, origin: string): Promise<V> => origin.includes("webglfail")
    ? { ok: false, at: new Date().toISOString(), summary: "canvas: 480×480 canvas drew nothing (WebGL/2D failed to render)", checks: [{ name: "canvas", ok: false, detail: "480×480 canvas drew nothing (WebGL/2D failed to render)" }] } : passing();
  const { t, add, again, tick } = await setup(w, TOKENS, failing);
  // Failed deployment.
  let f = await add("faildeploy", "https://faildeploy.fixture-native.com/");
  for (let i = 0; i < 3 && f.native_state === "preparing"; i++) f = await tick(f.id);
  assert.equal(f.native_state, "unavailable");
  assert.match(f.native_reason!, /The deployment of https:\/\/github\.com\/owner\/f\/pull\/1 failed \(Vercel deployment dpl_\w+: ERROR\)/);
  // A Cloudflare rule that does not take effect: removed after the grace period and recorded; never re-applied in a loop.
  let n = await add("noeffect", "https://noeffect.fixture-native.com/");
  assert.equal(n.native_state, "preparing");
  assert.equal(w.zones[0].rulesets!.rules.length, 1);
  await t.db.prepare(`UPDATE portfolio_projects SET native_change = json_set(native_change, '$.appliedAt', ?) WHERE id = ?`).bind(new Date(now - 11 * 60_000).toISOString(), n.id).run();
  n = await tick(n.id);
  assert.equal(n.native_state, "unavailable");
  assert.match(n.native_reason!, /did not take effect within 10 minutes .* so it was removed again/);
  assert.equal(w.zones[0].rulesets!.rules.length, 0, "rolled back");
  await t.db.prepare(`UPDATE portfolio_projects SET native_updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).bind(n.id).run();
  n = await tick(n.id);
  assert.equal(w.zones[0].rulesets!.rules.length, 0, "the 15-minute job does not re-apply a failed rule");
  assert.match(n.native_reason!, /Use "Check again" to start over/);
  n = await again(n.id);
  assert.equal(w.zones[0].rulesets!.rules.length, 1, "an explicit staff re-check starts over");
  // A PR closed without merging: recorded, never reopened by itself.
  w.repos.get("owner/c")!.closeNextPr = true;
  let c = await add("closed", "https://closed.fixture-native.com/");
  assert.equal(c.native_state, "unavailable");
  assert.match(c.native_reason!, /was closed without merging\. Crestmont does not reopen it by itself/);
  await t.db.prepare(`UPDATE portfolio_projects SET native_updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).bind(c.id).run();
  c = await tick(c.id);
  assert.equal(w.repos.get("owner/c")!.pulls.length, 1);
  // A site that permits framing but fails the real-browser check (its WebGL scene never draws): not native, not publishable.
  const g = await add("webglfail", "https://webglfail.fixture-native.com/");
  assert.equal(g.native_state, "unavailable");
  assert.match(g.native_reason!, /real-browser check failed — canvas: 480×480 canvas drew nothing/);
  assert.ok(publishBlockers(g).some((b) => /not verified as a native embed/.test(b)));
  // Redirects are followed to the address actually framed.
  const rd = await add("redirect", "https://redirect.fixture-native.com/");
  assert.equal(rd.embed_url, "https://www.redirect-target.com/");
  assert.equal(rd.native_state, "native_verified");
  now = Date.now();
  t.close();
});

test("[PORT-NATIVE] real-browser verifications are capped per day; existing entries are untouched by the native job", async () => {
  const w = new NativeWorld().site(site("cap1.fixture-native.com", { baseXfo: null })).site(site("cap2.fixture-native.com", { baseXfo: null }));
  const { t, add } = await setup(w, { ...TOKENS, PORTFOLIO_NATIVE_VERIFY_DAILY: "1" });
  const a = await add("cap1", "https://cap1.fixture-native.com/");
  const b = await add("cap2", "https://cap2.fixture-native.com/");
  assert.equal(a.native_state, "native_verified");
  assert.equal(b.native_state, "checking");
  assert.match(b.native_reason!, /real-browser verifications \(1\) are used up/);
  // The six existing entries (legacy) are never touched by the native job.
  const before = (await t.db.prepare(`SELECT COUNT(*) AS n FROM portfolio_projects WHERE native_required = 0 AND native_state = 'legacy'`).first<{ n: number }>())!.n;
  await runJobs(t.env, ["portfolio_native"]);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM portfolio_projects WHERE native_required = 0 AND native_state = 'legacy'`).first<{ n: number }>())!.n, before);
  assert.ok(before >= 1);
  t.close();
});

test("[PORT-NATIVE] Cloudflare site whose own policy says frame-ancestors 'none': the rule replaces only that directive, only on public paths, only while the policy is exactly the one read — every other directive kept; sensitive pages still refuse", async () => {
  const FA = frameAncestorsValue("http://crestmont.test");
  // Pure rewrite: one directive changes, the rest is byte-for-byte the site's own policy.
  const own = "default-src 'self'; script-src 'self' https://cdn.example.com; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";
  assert.deepEqual(rewriteFrameAncestors(own, FA), { ok: true, observed: own, value: `default-src 'self'; script-src 'self' https://cdn.example.com; ${FA}; base-uri 'self'; object-src 'none'` });
  assert.match((rewriteFrameAncestors("default-src 'self', frame-ancestors 'none'", FA) as { why: string }).why, /more than one Content-Security-Policy/);
  assert.match((rewriteFrameAncestors("frame-ancestors 'none'; frame-ancestors 'self'", FA) as { why: string }).why, /2 frame-ancestors directives/);
  assert.match((rewriteFrameAncestors(`default-src 'self'; frame-ancestors 'none'; x ${"a".repeat(1600)}`, FA) as { why: string }).why, /longer than 1500/);
  assert.match((rewriteFrameAncestors("default-src 'self'\u00e9; frame-ancestors 'none'", FA) as { why: string }).why, /cannot match exactly/);
  const rule = await desiredRule("h.example.com", ["/", "/about"], FA, own);
  assert.equal(rule.expression, `(http.host eq "h.example.com" and http.request.uri.path in {"/" "/about"} and http.response.headers["content-security-policy"][0] eq ${JSON.stringify(own)})`);
  assert.deepEqual(rule.action_parameters, { headers: { "Content-Security-Policy": { operation: "set", value: `default-src 'self'; script-src 'self' https://cdn.example.com; ${FA}; base-uri 'self'; object-src 'none'` }, "X-Frame-Options": { operation: "remove" } } });

  const w = new NativeWorld().site(site("strict.fixture-native.com", { baseCsp: own })).cloudflareZone("strict.fixture-native.com", ACCT, { workerDomain: { hostname: "strict.fixture-native.com", service: "strict-production" } });
  const { t, add, tick } = await setup(w);
  let p = await add("strict", "https://strict.fixture-native.com/");
  assert.equal(p.native_state, "preparing", p.native_reason!);
  assert.match(p.native_reason!, /only the frame-ancestors directive of the site's own policy is replaced, every other directive is kept/);
  const rules = w.zones[0].rulesets!.rules;
  assert.equal(rules.length, 1);
  assert.doesNotMatch(rules[0].expression, /login|book/, "sensitive pages are never in the rule");
  // The live site now answers with its own policy, only frame-ancestors changed; sensitive pages unchanged.
  const home = w.respond("https://strict.fixture-native.com/")!;
  assert.equal(home.headers["content-security-policy"], `default-src 'self'; script-src 'self' https://cdn.example.com; ${FA}; base-uri 'self'; object-src 'none'`);
  assert.equal(home.headers["x-frame-options"], undefined);
  const login = w.respond("https://strict.fixture-native.com/login")!;
  assert.equal(login.headers["x-frame-options"], "DENY");
  assert.equal(login.headers["content-security-policy"], "frame-ancestors 'none'");
  p = await tick(p.id);
  assert.equal(p.native_state, "native_verified", p.native_reason!);
  // If the site later sends a different policy, the rule no longer matches: the page refuses framing again (fail closed).
  w.sites.get("strict.fixture-native.com")!.baseCsp = own.replace("object-src 'none'", "object-src 'self'");
  const changed = w.respond("https://strict.fixture-native.com/")!;
  assert.equal(changed.headers["content-security-policy"], own.replace("object-src 'none'", "object-src 'self'"));
  assert.equal(changed.headers["x-frame-options"], "DENY");
  t.close();
});

test("[PORT-NATIVE] Cloudflare Pages discovery never sends a per_page the Pages API refuses (production HTTP 400)", async () => {
  const w = new NativeWorld().site(site("pg2.fixture-native.com")).cloudflareZone("other-zone2.com", ACCT)
    .pages({ name: "pg2", account: ACCT, domain: "pg2.fixture-native.com", repo: "owner/pg2", branch: "main", destination: "", buildCommand: "" }).repo("owner/pg2");
  const { t, add } = await setup(w);
  const p = await add("pg2", "https://pg2.fixture-native.com/");
  assert.match(p.native_provider ?? "", /cloudflare-pages/, p.native_reason!);
  assert.ok(!w.calls.some((c) => /pages\/projects\?.*per_page/.test(c)), "no per_page on the Pages list");
  t.close();
});
