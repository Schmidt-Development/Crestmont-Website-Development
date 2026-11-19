// Native readiness operations (Owner, 2026-11-19): the production Worker verifies its own connections read-only, reports
// what they authorize (never a token), discovers hosting without changing anything, and runs the controlled onboarding
// of one owned website — only behind a one-time challenge written with the production Cloudflare token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createTestApp } from "./support/app.ts";
import { NativeWorld, homepage, page } from "./support/native-world.ts";
import { getBySlug } from "../src/services/portfolio.ts";

const ACCT = "c".repeat(32);
const TOKENS = { PORTFOLIO_CLOUDFLARE_TOKEN: "cf-test-token", PORTFOLIO_VERCEL_TOKEN: "vc-test-token", PORTFOLIO_GITHUB_TOKEN: "gh-test-token" };
async function challenge(t: Awaited<ReturnType<typeof createTestApp>>, uses = 5) {
  const nonce = randomBytes(32).toString("hex");
  const value = JSON.stringify({ hash: createHash("sha256").update(nonce).digest("hex"), expiresAt: new Date(Date.now() + 14 * 60_000).toISOString(), uses, payload: {} });
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_by, updated_at) VALUES ('ops.challenge.portfolio_native', ?, NULL, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(value, new Date().toISOString()).run();
  return nonce;
}
const site = (host: string) => ({ host, pages: { "/": homepage(host), "/about": page("About"), "/login": page("Sign in") } });

test("[PORT-NATIVE-OPS] check: read-only connection report (identity, accounts, zones, projects, repositories, missing permissions) and hosting discovery — no token in the response, nothing changed", async () => {
  const w = new NativeWorld().site(site("owned.fixture-native.com")).cloudflareZone("fixture-native.com", ACCT, { workerDomain: { hostname: "owned.fixture-native.com", service: "owned" } })
    .vercel({ id: "prj_v", name: "v-site", domain: "v.fixture-native.com", verified: true, repo: "owner/v-site", branch: "main", root: "" }).repo("owner/v-site").site(site("v.fixture-native.com"));
  const t = await createTestApp({ ...TOKENS, overrides: { portfolioFetch: w.fetchSite, providerFetch: w.fetchApi, nativeVerify: async () => ({ ok: true, at: new Date().toISOString(), summary: "ok", checks: [] }) } } as never);
  const post = (body: unknown) => t.client().request("POST", "/api/ops/portfolio-native", { body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  assert.equal((await post({ action: "check" })).status, 401, "no challenge, no answer");
  assert.equal((await post({ action: "check", challenge: "f".repeat(64) })).status, 401, "a wrong challenge is refused");
  const res = await post({ action: "check", challenge: await challenge(t), urls: ["https://owned.fixture-native.com/", "https://v.fixture-native.com/", "https://unknown.fixture-native.com/", "http://10.0.0.1/"] });
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const secret of ["cf-test-token", "vc-test-token", "gh-test-token"]) assert.ok(!text.includes(secret), `${secret} never appears in the response`);
  const j = JSON.parse(text) as { connections: Record<string, { authenticated: boolean; identity: string; scope: Record<string, unknown>; missing: string[] }>; discovery: { url: string; status: string; hosting: { found: boolean; detail: string } | null }[] };
  assert.equal(j.connections.cloudflare.authenticated, true);
  assert.deepEqual(j.connections.cloudflare.scope.zones, ["fixture-native.com"]);
  assert.match(JSON.stringify(j.connections.cloudflare.scope.perAccount), /owned\.fixture-native\.com → owned/);
  assert.match(String(j.connections.cloudflare.scope.responseHeaderRules), /fixture-native\.com: readable/);
  assert.equal(j.connections.vercel.identity, "test-owner");
  assert.match(JSON.stringify(j.connections.vercel.scope.projects), /v-site \[v\.fixture-native\.com\] ← owner\/v-site \(main\)/);
  assert.equal(j.connections.github.authenticated, true);
  assert.deepEqual(j.connections.github.scope.repositories, ["owner/v-site (write)"]);
  assert.deepEqual(j.connections.github.missing, []);
  assert.match(String(j.connections.github.scope.automaticMerging), /^on — /);
  assert.deepEqual(j.discovery.map((x) => [x.status, x.hosting?.found ?? null]), [["blocked", true], ["blocked", true], ["error", false], ["invalid", null]]);
  assert.match(j.discovery[0].hosting!.detail, /Workers custom domain \(owned\)/);
  assert.deepEqual(w.writes, [], "discovery and verification changed nothing at any provider");
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM portfolio_projects WHERE live_url LIKE '%fixture-native%'`).first<{ n: number }>())!.n, 0, "nothing created");
  t.close();
});

test("[PORT-NATIVE-OPS] check: a GitHub token without the Checks API is reported as manual approval (not a missing permission); the Pages list is read without per_page", async () => {
  const w = new NativeWorld().site(site("owned.fixture-native.com")).cloudflareZone("fixture-native.com", ACCT, { workerDomain: { hostname: "owned.fixture-native.com", service: "owned" } }).repo("owner/v-site");
  w.repos.get("owner/v-site")!.checksUnreadable = true;
  const t = await createTestApp({ ...TOKENS, overrides: { portfolioFetch: w.fetchSite, providerFetch: w.fetchApi } } as never);
  const res = await t.client().request("POST", "/api/ops/portfolio-native", { body: JSON.stringify({ action: "check", challenge: await challenge(t), urls: ["https://owned.fixture-native.com/"] }), headers: { "content-type": "application/json" } });
  const j = await res.json() as { connections: Record<string, { scope: Record<string, unknown>; missing: string[]; errors: string[] }> };
  assert.deepEqual(j.connections.github.missing, []);
  assert.match(String(j.connections.github.scope.automaticMerging), /^off — this connection cannot read checks, so Crestmont opens each header pull request and waits for you to review and merge it/);
  assert.deepEqual(j.connections.cloudflare.errors, [], "the Pages list answered");
  assert.deepEqual(w.writes, []);
  t.close();
});

test("[PORT-NATIVE-OPS] check reports a token that does not authenticate and the permissions that are missing", async () => {
  const w = new NativeWorld();
  const t = await createTestApp({ PORTFOLIO_CLOUDFLARE_TOKEN: "wrong", PORTFOLIO_GITHUB_TOKEN: "gh-test-token", overrides: { providerFetch: w.fetchApi } } as never);
  const res = await t.client().request("POST", "/api/ops/portfolio-native", { body: JSON.stringify({ action: "check", challenge: await challenge(t) }), headers: { "content-type": "application/json" } });
  const j = await res.json() as { connections: Record<string, { connected: boolean; authenticated: boolean; missing: string[]; errors: string[] }> };
  assert.equal(j.connections.cloudflare.authenticated, false);
  assert.ok(j.connections.cloudflare.missing.length || j.connections.cloudflare.errors.length);
  assert.equal(j.connections.vercel.connected, false);
  assert.match(j.connections.github.missing.join(), /can push to none/);
  t.close();
});

test("[PORT-NATIVE-OPS] onboard + advance: an owned Cloudflare site is prepared and verified; an unpublished acceptance entry is converted, not duplicated; published entries are never converted", async () => {
  const w = new NativeWorld().site(site("owned.fixture-native.com")).cloudflareZone("fixture-native.com", ACCT, { workerDomain: { hostname: "owned.fixture-native.com", service: "owned" } });
  const t = await createTestApp({ ...TOKENS, overrides: { portfolioFetch: w.fetchSite, providerFetch: w.fetchApi, nativeVerify: async () => ({ ok: true, at: new Date().toISOString(), summary: "Verified in a real browser: frame, content", checks: [{ name: "frame", ok: true, detail: "loaded" }] }) } } as never);
  // The release pipeline's acceptance entry for the same site (unpublished, legacy, relationship pending).
  const at = new Date().toISOString();
  await t.db.prepare(`INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, position, published, updated_at, created_at, native_required, native_state) VALUES ('pf_acc','owned-acceptance','Owned','T','https://owned.fixture-native.com/','Relationship documentation pending','TEST DATA','[]',9,0,?,?,0,'legacy')`).bind(at, at).run();
  const post = async (body: Record<string, unknown>) => (await t.client().request("POST", "/api/ops/portfolio-native", { body: JSON.stringify({ ...body, challenge: await challenge(t) }), headers: { "content-type": "application/json" } }));
  const r1 = await (await post({ action: "onboard", url: "https://owned.fixture-native.com/" })).json() as { slug: string; state: string; converted: boolean; created: boolean; preview: string | null };
  assert.deepEqual([r1.slug, r1.state, r1.converted, r1.created], ["owned-acceptance", "preparing", true, false]);
  assert.equal(w.zones[0].rulesets!.rules.length, 1);
  const r2 = await (await post({ action: "advance", slug: "owned-acceptance" })).json() as { state: string; preview: string | null; published: boolean };
  assert.equal(r2.state, "native_verified");
  assert.match(r2.preview!, /^\/portfolio\/preview\/[0-9a-f]{48}$/);
  assert.equal(r2.published, false, "never published by an operation");
  const pv = await (await t.client().get(r2.preview!)).text();
  assert.match(pv, /data-kind="live"[^>]*data-frame-url="https:\/\/owned\.fixture-native\.com\/"/, "the preview shows the real site in the native frame");
  assert.doesNotMatch(pv, /data-remote-slug/, "never the remote browser");
  assert.equal((await getBySlug(t.db, "owned-acceptance"))!.portfolio_consent_at, null);
  // A published existing entry is never converted by an operation.
  await t.db.prepare(`INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, position, published, updated_at, created_at, native_required, native_state) VALUES ('pf_pub','pub','Pub','T','https://published.fixture-native.com/','Client','TEST DATA','[]',10,1,?,?,0,'legacy')`).bind(at, at).run();
  assert.equal((await post({ action: "onboard", url: "https://published.fixture-native.com/" })).status, 422);
  assert.equal((await post({ action: "onboard", url: "http://10.0.0.1/" })).status, 422);
  assert.equal((await post({ action: "advance", slug: "pub" })).status, 422);
  t.close();
});

test("[PORT-NATIVE-OPS] prepare: one bounded round drives every published entry (cheap preparation before verification), reports every entry's readiness, and the strict gate fails until each required entry is verified", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const w = new NativeWorld()
    .site({ ...site("blocked.fixture-native.com") }).cloudflareZone("blocked.fixture-native.com", ACCT, { workerDomain: { hostname: "blocked.fixture-native.com", service: "blocked" } })
    .site({ ...site("open.fixture-native.com"), baseXfo: null, baseCsp: "frame-ancestors http://crestmont.test" } as never);
  const t = await createTestApp({ ...TOKENS, overrides: { portfolioFetch: w.fetchSite, providerFetch: w.fetchApi, nativeVerify: async () => ({ ok: true, at: new Date().toISOString(), summary: "Verified in a real browser", checks: [] }) } } as never);
  const at = new Date().toISOString();
  for (const [slug, url] of [["blocked-pub", "https://blocked.fixture-native.com/"], ["open-pub", "https://open.fixture-native.com/"]])
    await t.db.prepare(`INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, position, published, updated_at, created_at, native_required, native_state, native_migrated_at) VALUES (?,?,?,'T',?,'TEST DATA','TEST DATA','[]',90,1,?,?,1,'checking',?)`).bind(`pf_${slug.replace("-", "_")}`, slug, slug, url, at, at, at).run();
  // Only these two are published here (the seeded entries would otherwise be required too — and rightly fail the gate).
  await t.db.prepare(`UPDATE portfolio_projects SET published = 0 WHERE slug NOT IN ('blocked-pub', 'open-pub')`).run();
  const post = async (body: unknown) => t.client().request("POST", "/api/ops/portfolio-native", { body: JSON.stringify({ ...body as object, challenge: await challenge(t) }), headers: { "content-type": "application/json" } });
  type R = { round: { slug: string; state: string; published: boolean }[]; readiness: { slug: string; published: boolean; state: string; codes: string[] }[]; previews: Record<string, string | null> };
  const r1 = await (await post({ action: "prepare" })).json() as R;
  const order = r1.round.map((x) => x.slug);
  assert.ok(order.indexOf("blocked-pub") < order.indexOf("open-pub"), `cheap preparation before a verification: ${order}`);
  assert.equal(r1.round.find((x) => x.slug === "blocked-pub")!.state, "preparing", "the rule was applied");
  assert.equal(r1.round.find((x) => x.slug === "open-pub")!.state, "native_verified");
  assert.match(r1.previews["open-pub"]!, /^\/portfolio\/preview\/[0-9a-f]{48}$/);
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const gate = (r: R, named = "") => { writeFileSync(join(dir, "r.json"), JSON.stringify(r)); try { return { code: 0, out: execFileSync(process.execPath, ["scripts/native-readiness-gate.mjs", join(dir, "r.json"), named], { encoding: "utf8" }) }; } catch (e) { const x = e as { status: number; stdout: string }; return { code: x.status, out: x.stdout }; } };
  const g1 = gate(r1);
  assert.equal(g1.code, 1, "a published entry still preparing fails the strict gate");
  assert.match(g1.out, /✗ blocked-pub \(blocked-pub\) \| yes \| preparing/);
  // Next round: the rule has taken effect → verified; no second rule was created.
  const r2 = await (await post({ action: "prepare" })).json() as R;
  assert.equal(r2.readiness.find((x) => x.slug === "blocked-pub")!.state, "native_verified");
  assert.equal(w.zones[0].rulesets!.rules.length, 1, "one rule, never duplicated");
  assert.equal(gate(r2).code, 0, "every published entry verified → the gate passes");
  // A named acceptance slug that does not exist (or is not verified) fails the gate.
  const g3 = gate(r2, "no-such-entry");
  assert.equal(g3.code, 1);
  assert.match(g3.out, /no-such-entry .* missing/);
  t.close();
});

test("[PORT-NATIVE] the 15-minute job is bounded: a time budget and a verification budget per tick; the rest is deferred, never dropped", async () => {
  const { advanceAllNative } = await import("../src/services/native/orchestrator.ts");
  const { nativeDepsFrom } = await import("../src/services/native/deps.ts");
  const w = new NativeWorld();
  for (let i = 1; i <= 4; i++) w.site({ ...site(`v${i}.fixture-native.com`), baseXfo: null, baseCsp: "frame-ancestors http://crestmont.test" } as never);
  let verifications = 0;
  const t = await createTestApp({ ...TOKENS, overrides: { portfolioFetch: w.fetchSite, providerFetch: w.fetchApi, nativeVerify: async () => { verifications++; return { ok: true, at: new Date().toISOString(), summary: "Verified", checks: [] }; } } } as never);
  const at = new Date().toISOString();
  for (let i = 1; i <= 4; i++) await t.db.prepare(`INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, position, published, updated_at, created_at, native_required, native_state) VALUES (?,?,?,'T',?,'TEST DATA','TEST DATA','[]',90,1,?,?,1,'checking')`).bind(`pf_v${i}`, `v${i}`, `v${i}`, `https://v${i}.fixture-native.com/`, at, at).run();
  await t.db.prepare(`UPDATE portfolio_projects SET archived_at = ? WHERE slug NOT LIKE 'v_'`).bind(at).run(); // only these four here
  const d = nativeDepsFrom(t.env, t.db, "http://crestmont.test");
  const out = await advanceAllNative(d, 10, { maxVerifications: 2 });
  assert.equal(verifications, 2);
  assert.deepEqual(out.map((x) => x.state), ["native_verified", "native_verified", "deferred: verification budget", "deferred: verification budget"]);
  const next = await advanceAllNative(d, 10, { maxVerifications: 2 });
  assert.deepEqual(next.map((x) => x.state), ["native_verified", "native_verified"], "the deferred ones complete on the next tick; the verified ones are not repeated");
  t.close();
});
