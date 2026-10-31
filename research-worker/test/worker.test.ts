// Research worker: unit and integration tests. All businesses, domains and numbers are TEST DATA; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { State } from "../src/state.ts";
import { loadConfig, assertLoopback } from "../src/config.ts";
import { parseRobots, robotsDecision, isPublicAddress, Http } from "../src/http.ts";
import { pageFacts, identity, parkedPage } from "../src/identity.ts";
import { evaluate, candidateDomains, type Probe } from "../src/pipeline.ts";
import { htmlFindings, brokenReason } from "../src/audit.ts";
import { LocalModel } from "../src/model.ts";
import { snapshotQuery, toCandidate, rowLicense } from "../src/sources/overture.ts";
import { surt, indexQuery, CommonCrawl } from "../src/sources/commoncrawl.ts";
import { osmCandidate } from "../src/sources/osm.ts";
import { fsqCandidate } from "../src/sources/foursquare.ts";
import { silentLogger } from "../src/log.ts";
import { validateProspect } from "../../src/domain/research.ts";
import { FakeHttp, cand, deps, ok, fail, status, page, NOW } from "./helpers.ts";

const SITE = "https://riverside-plumbing.example/";

// ───────────── configuration & safety ─────────────

test("config refuses a remote or https Ollama, a short secret and a non-https platform", () => {
  assert.throws(() => assertLoopback("http://10.0.0.5:11434"), /this machine/);
  assert.throws(() => assertLoopback("https://ollama.com"), /this machine/);
  assert.doesNotThrow(() => assertLoopback("http://127.0.0.1:11434"));
  assert.throws(() => loadConfig({ CRESTMONT_URL: "http://staging.example", RESEARCH_RUNNER_SECRET: "x" }), /CRESTMONT_URL[\s\S]*RESEARCH_RUNNER_SECRET/);
  const c = loadConfig({ CRESTMONT_URL: "https://crestmont-platform-staging.example.workers.dev", RESEARCH_RUNNER_SECRET: "s".repeat(40), RESEARCH_STATES: "mi, oh" });
  assert.deepEqual(c.states, ["MI", "OH"]);
  assert.equal(c.foursquare.enabled, false, "Foursquare OS stays off until the Founder accepts its access terms");
  assert.equal(c.osm.enabled, false, "OSM stays off (ODbL internal-use decision)");
});

test("never reaches private networks: loopback, RFC 1918, link-local/metadata, CGNAT and IPv6 private ranges are refused", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:192.168.0.1"]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "104.16.0.1", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
  const http = new Http({ userAgent: "t", robotsToken: "CrestmontResearchBot", timeoutMs: 2000, perHostIntervalMs: 1000, concurrency: 2, maxBytes: 100000 });
  const r = await http.get("http://localhost:9/");
  assert.equal(r.error?.kind === "blocked_address" || r.robotsBlocked, true, `localhost refused (${JSON.stringify(r.error)})`);
});

test("robots.txt: our own group beats '*', longest rule wins, Allow wins ties, wildcards and Crawl-delay are honoured", () => {
  const r = parseRobots(`User-agent: *\nDisallow: /\n\nUser-agent: CrestmontResearchBot\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\nCrawl-delay: 7\n`);
  assert.deepEqual(robotsDecision(r, "CrestmontResearchBot", "/"), { allowed: true, crawlDelay: 7 });
  assert.equal(robotsDecision(r, "CrestmontResearchBot", "/private/x").allowed, false);
  assert.equal(robotsDecision(r, "CrestmontResearchBot", "/private/public/x").allowed, true);
  assert.equal(robotsDecision(r, "CrestmontResearchBot", "/menu.pdf").allowed, false);
  assert.equal(robotsDecision(r, "OtherBot", "/").allowed, false);
  assert.equal(robotsDecision(parseRobots("User-agent: *\nDisallow:\n"), "CrestmontResearchBot", "/").allowed, true);
});

// ───────────── identity (stage D) ─────────────

test("identity: phone or street match confirms; a similarly named business with other contact details is never treated as official", () => {
  const c = cand();
  const good = identity(c, pageFacts(page()), ["overture"]);
  assert.ok(good.official && good.signals.some((s) => s.includes("phone")), JSON.stringify(good));
  const sameNameOtherBusiness = identity(c, pageFacts(page({ phone: "(616) 555-2900", street: "77 Lake Ave", city: "Grand Rapids" })), []);
  assert.equal(sameNameOtherBusiness.official, false, "name alone is not identity");
  assert.ok(sameNameOtherBusiness.contradictions.length);
  const listedNameOnly = identity(cand({ phones: [] }), pageFacts(page({ phone: "", street: "PO Box 5" })), ["overture"]);
  assert.equal(listedNameOnly.official, true, "listed by a source + strong name match");
  assert.equal(parkedPage(pageFacts("<title>example.com</title><body>This domain is for sale! Buy this domain.</body>")), "this domain is for sale");
});

// ───────────── stages A-E ─────────────

test("stage A/B: social and directory links are not official websites; another dataset's matching record and business email domains are used; names never become guessed domains", () => {
  const st = new State(":memory:");
  st.upsertCandidate(cand({ businessKey: "foursquare_os:f1", websites: ["riversideplumbingmi.example"], sources: [{ source: "foursquare_os", sourceId: "f1", license: "Apache-2.0", retrievedAt: NOW() }] }), "MI", new Date(), 30);
  st.upsertCandidate(cand({ businessKey: "foursquare_os:f2", name: "Totally Different Bakery", websites: ["bakery.example"], sources: [{ source: "foursquare_os", sourceId: "f2", license: "Apache-2.0", retrievedAt: NOW() }] }), "MI", new Date(), 30);
  const c = cand({ websites: ["https://www.facebook.com/riverside", "yelp.com/biz/riverside"], emails: ["owner@riverside-mail.example", "x@gmail.com"] });
  st.upsertCandidate(c, "MI", new Date(), 30);
  const { domains, checks } = candidateDomains(c, st);
  assert.deepEqual(domains.map((d) => d.domain).sort(), ["riverside-mail.example", "riversideplumbingmi.example"]);
  assert.deepEqual(domains.find((d) => d.domain === "riversideplumbingmi.example")!.listedBy, ["foursquare_os"]);
  assert.match(checks[0].result, /2 social\/directory profile/);
  assert.ok(!domains.some((d) => d.domain === "bakery.example"), "same phone but different name is not the same business");
});

test("broken website: one failure is re-checked later; only repeated, spaced failures of a listed site are classified broken, with the evidence of each attempt", async () => {
  const st = new State(":memory:");
  const http = new FakeHttp({ [SITE]: status(SITE, 503), "http://riverside-plumbing.example/": status("http://riverside-plumbing.example/", 503) });
  const first = await evaluate(cand(), deps(http, st), null);
  assert.equal(first.kind, "defer");
  const second = await evaluate(cand(), deps(http, st), (first as { probe: Probe }).probe);
  assert.equal(second.kind, "done");
  if (second.kind !== "done") return;
  assert.equal(second.cls, "VERIFIED_WEBSITE_BROKEN");
  assert.equal(second.send, true);
  assert.match(second.prospect.findings![0].evidence, /503[\s\S]*503/);
  assert.ok(validateProspect(second.prospect).ok, "the platform accepts the result");
  const dead = await evaluate(cand(), deps(new FakeHttp({}), st, { brokenAttempts: 1 }), null);
  assert.equal(dead.kind === "done" && dead.cls, "VERIFIED_WEBSITE_BROKEN", "domain that does not resolve");
});

test("issues vs healthy: missing viewport and plain HTTP are documented findings; a healthy official site is verified and not sent", async () => {
  const st = new State(":memory:");
  const plain = "http://riverside-plumbing.example/";
  const issues = await evaluate(cand(), deps(new FakeHttp({ [SITE]: fail(SITE, "tls"), [plain]: ok(plain, page({ viewport: false })) }), st), null);
  assert.ok(issues.kind === "done" && issues.cls === "VERIFIED_WEBSITE_ISSUES", JSON.stringify(issues).slice(0, 300));
  if (issues.kind !== "done") return;
  const codes = issues.prospect.findings!.map((f) => f.code);
  assert.ok(codes.includes("no_https") && codes.includes("no_viewport_meta"), codes.join());
  for (const f of issues.prospect.findings!) assert.ok(f.evidence && f.url && f.method && f.observedAt && f.confidence > 0, `finding ${f.code} carries its evidence`);
  const healthy = await evaluate(cand(), deps(new FakeHttp({ [SITE]: ok(SITE, page()) }), new State(":memory:")), null);
  assert.ok(healthy.kind === "done" && healthy.cls === "VERIFIED_OFFICIAL_WEBSITE" && healthy.send === false, JSON.stringify(healthy).slice(0, 400));
});

test("redirects: a long chain is a finding; the final URL is what gets audited", () => {
  const r = ok("https://riverside-plumbing.example/", page(), { finalUrl: "https://www.riverside-plumbing.example/home", chain: [301, 302, 301, 200].map((s, i) => ({ url: `https://riverside-plumbing.example/${i}`, status: s })) });
  const f = htmlFindings(r, pageFacts(page()), page());
  assert.ok(f.some((x) => x.code === "redirect_chain"));
});

test("no official website found: only after stages A-C, with the checks recorded; a listed site that belongs to someone else is 'unverified', not 'no website'", async () => {
  const none = await evaluate(cand({ websites: [] }), deps(new FakeHttp({}), new State(":memory:")), null);
  assert.ok(none.kind === "done" && none.cls === "NO_OFFICIAL_WEBSITE_FOUND");
  if (none.kind !== "done") return;
  const stages = none.prospect.website.checks!.map((c) => c.stage);
  assert.ok(stages.includes("A") && stages.includes("B") && stages.includes("E"));
  assert.match(none.prospect.website.checks!.at(-1)!.result, /not proof that none exists/);
  const other = await evaluate(cand(), deps(new FakeHttp({ [SITE]: ok(SITE, page({ title: "Lakeview Dental", phone: "(616) 555-2900", street: "9 Elm St", city: "Holland" })) }), new State(":memory:")), null);
  assert.ok(other.kind === "done" && other.cls === "WEBSITE_UNVERIFIED", "false official-domain match avoided");
  const robots = await evaluate(cand(), deps(new FakeHttp({ [SITE]: { ...ok(SITE, ""), robotsBlocked: true, status: null } }), new State(":memory:")), null);
  assert.ok(robots.kind === "done" && robots.cls === "WEBSITE_UNVERIFIED", "robots.txt exclusion is respected, not worked around");
  const closed = await evaluate(cand({ operatingStatus: "permanently_closed" }), deps(new FakeHttp({}), new State(":memory:")), null);
  assert.ok(closed.kind === "done" && closed.cls === "BUSINESS_IDENTITY_UNCERTAIN" && !closed.send);
});

test("brokenReason ignores access restrictions (401/403/429 are not 'broken')", () => {
  assert.equal(brokenReason(status(SITE, 403)), null);
  assert.equal(brokenReason(status(SITE, 429)), null);
  assert.ok(brokenReason(status(SITE, 500)));
});

// ───────────── local model ─────────────

test("local model drafts: accepted when factual, discarded when they add prices, percentages or unseen domains; failures leave no draft", async () => {
  const reply = (content: object) => (async () => new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }))) as unknown as typeof fetch;
  const m = new LocalModel({ baseUrl: "http://127.0.0.1:11434", name: "qwen-test", timeoutMs: 5000, numCtx: 4096, concurrency: 1 });
  const input = { name: "Riverside Plumbing", category: "plumber", city: "Lansing", state: "MI", websiteClass: "VERIFIED_WEBSITE_BROKEN" as const, websiteUrl: SITE, findings: [], recommendedPackage: "business", allowedDomains: ["riverside-plumbing.example"] };
  const good = await m.draft(input, reply({ summary: "Riverside Plumbing in Lansing; its listed website riverside-plumbing.example returned server errors on repeated checks.", brief: "Mention that the website did not load during two checks and ask whether they know." }));
  assert.ok(good.summary && good.brief && !good.rejected.length);
  const bad = await m.draft(input, reply({ summary: "A new site for $999 will boost sales 40%.", brief: "Their real site is riversideplumbingmi.com." }));
  assert.equal(bad.summary, null); assert.equal(bad.brief, null); assert.ok(bad.rejected.length >= 2);
  const down = await m.draft(input, (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch);
  assert.equal(down.summary, null); assert.match(down.rejected[0], /failed/);
});

// ───────────── sources ─────────────

test("Overture: schema probe builds the query for the release (basic_category when present), fails loudly on missing columns; per-row licences kept", () => {
  const cols = new Map([["id", "VARCHAR"], ["names", "STRUCT"], ["addresses", "STRUCT[]"], ["phones", "VARCHAR[]"], ["websites", "VARCHAR[]"], ["bbox", "STRUCT"], ["sources", "STRUCT(property VARCHAR, dataset VARCHAR, license VARCHAR)[]"], ["basic_category", "VARCHAR"], ["operating_status", "VARCHAR"], ["confidence", "DOUBLE"]]);
  const q = snapshotQuery("s3://overturemaps-us-west-2/release", "2026-10-21.0", cols, 0.5);
  assert.match(q, /basic_category AS category/);
  assert.match(q, /list_transform\(sources, s -> s\.license\)/);
  assert.match(q, /addresses\[1\]\.country = 'US'/);
  assert.match(q, /permanently_closed/);
  cols.delete("phones");
  assert.throws(() => snapshotQuery("s3://x", "2026-10-21.0", cols, 0.5), /missing phones/);
  assert.equal(rowLicense(["Foursquare"], null), "Apache-2.0");
  assert.equal(rowLicense(["AllThePlaces"], null), "CC0-1.0");
  assert.equal(rowLicense(["meta"], null), "CDLA-Permissive-2.0");
  const c = toCandidate({ id: "08f2a", name: " Riverside Plumbing ", category: "plumber", line: "120 Main St", city: "Lansing", state: "US-MI", zip: "48933-1234", lat: 42.7, lon: -84.5, phones: ["+1 517-555-2142", "bad"], emails: ["INFO@riverside.example"], websites: ["riverside.example"], socials: ["https://facebook.com/x"], confidence: 0.93, operating_status: "open", datasets: ["meta"], licenses: null }, "2026-10-21.0", NOW())!;
  assert.deepEqual([c.businessKey, c.address.state, c.address.zip, c.phones[0], c.emails[0], c.sources[0].license], ["overture:08f2a", "MI", "48933", "+15175552142", "info@riverside.example", "CDLA-Permissive-2.0"]);
});

test("Common Crawl: SURT-range query, cached per domain, throttled, daily budget, and failures never stop verification", async () => {
  assert.equal(surt("riverside-plumbing.example"), "example,riverside-plumbing)");
  assert.match(indexQuery("CC-MAIN-2026-40", ["https://data.commoncrawl.org/a.parquet"], ["a.example"]), /url_surtkey >= 'example,a\)'/);
  const st = new State(":memory:");
  let queries = 0, fail = false;
  const db = { exec: async () => { queries++; if (fail) throw new Error("503 Slow Down"); return "a.example|3|200|2026-09-01 00:00:00\n"; } };
  const cc = new CommonCrawl(db, st, silentLogger, { crawl: "CC-MAIN-2026-40", maxDomainsPerQuery: 10, minQueryIntervalMs: 60_000, dailyQueryBudget: 2, fetchText: async () => "cc-index/table/cc-main/warc/crawl=CC-MAIN-2026-40/subset=warc/part-0.parquet" });
  const r1 = await cc.lookup(["a.example", "b.example"], 1_000_000);
  assert.equal(r1.get("a.example")!.captures, 3);
  assert.equal(r1.get("b.example")!.captures, 0);
  await cc.lookup(["a.example"], 1_000_001);
  assert.equal(queries, 1, "cached");
  assert.equal((await cc.lookup(["c.example"], 1_000_002)).size, 0, "throttled: no second query within the interval");
  fail = true;
  assert.equal((await cc.lookup(["c.example"], 2_000_000)).size, 0, "a failed lookup returns nothing and does not throw");
  assert.equal((await cc.lookup(["d.example"], 9_000_000)).size, 0, "daily budget of 2 queries reached");
  assert.equal(queries, 2);
});

test("OSM and Foursquare records keep their own licences (ODbL / Apache-2.0) and ids", () => {
  const o = osmCandidate({ type: "Feature", properties: { "@type": "node", "@id": "123", name: "Corner Cafe", amenity: "cafe", phone: "517-555-2190;517-555-2191", "addr:housenumber": "5", "addr:street": "Oak St", "addr:city": "Lansing", "addr:postcode": "48933", website: "cornercafe.example" }, geometry: { type: "Point", coordinates: [-84.5, 42.7] } }, "MI", "2026-10-30", NOW())!;
  assert.deepEqual([o.businessKey, o.sources[0].license, o.phones.length, o.address.line, o.category], ["osm_geofabrik:n123", "ODbL-1.0", 2, "5 Oak St", "amenity=cafe"]);
  const f = fsqCandidate({ fsq_place_id: "abc", name: "Corner Cafe", latitude: 42.7, longitude: -84.5, address: "5 Oak St", locality: "Lansing", region: "Michigan", postcode: "48933", tel: "(517) 555-2190", website: null, email: null, category: "Cafe", date_refreshed: "2026-09-01" }, "2026-09-15", NOW())!;
  assert.deepEqual([f.businessKey, f.address.state, f.sources[0].license], ["foursquare_os:abc", "MI", "Apache-2.0"]);
});

// ───────────── durable state ─────────────

test("state: unchanged source records are skipped, changed ones re-queued; a crashed lease is reclaimed; results that did not change are not resent", () => {
  const st = new State(":memory:");
  const t0 = new Date("2026-10-30T10:00:00Z");
  assert.equal(st.upsertCandidate(cand(), "MI", t0, 30), "new");
  assert.equal(st.upsertCandidate({ ...cand(), sources: [{ ...cand().sources[0], retrievedAt: "2026-11-01T00:00:00.000Z", release: "2026-11-18.0" }] }, "MI", t0, 30), "unchanged", "a new release with the same facts is not re-processed");
  const claimed = st.claim(10, t0, 60_000);
  assert.equal(claimed.length, 1);
  assert.equal(st.claim(10, new Date(t0.getTime() + 1000), 60_000).length, 0, "leased");
  assert.equal(st.claim(10, new Date(t0.getTime() + 61_000), 60_000).length, 1, "lease expired after a crash: work resumes");
  st.finish("overture:t1", { x: 1 }, t0);
  assert.ok(st.enqueueBatch(100, t0));
  assert.equal(st.upsertCandidate({ ...cand(), phones: ["+15175552143"] }, "MI", t0, 30), "changed");
  st.claim(10, t0, 60_000);
  st.finish("overture:t1", { x: 1 }, t0);
  assert.equal(st.enqueueBatch(100, t0), null, "identical result is not sent twice");
});

test("outbox: a batch keeps its id across retries; 413 puts its records back for smaller batches; platform rejections are recorded", () => {
  const st = new State(":memory:");
  const t = new Date();
  for (let i = 0; i < 5; i++) { st.upsertCandidate(cand({ businessKey: `overture:o${i}` }), "MI", t, 30); }
  st.claim(10, t, 60_000);
  for (let i = 0; i < 5; i++) st.finish(`overture:o${i}`, { i }, t);
  const b = st.enqueueBatch(3, t)!;
  st.retryOutbox(b.batchId, "HTTP 503", 0, t);
  assert.equal(st.nextOutbox(new Date(t.getTime() + 10))!.batch_id, b.batchId, "same id on retry");
  st.splitOutbox(b.batchId, t);
  assert.equal(st.outboxDepth(), 0);
  assert.equal(st.stages().ready, 5);
  st.markRejected([{ businessKey: "overture:o1", issues: ["bad"] }], t);
  assert.equal(st.stages().failed, 1);
});

// ───────────── regressions from the independent review ─────────────

test("[review] IP-literal hosts (including redirect targets) are refused; NAT64, 6to4 and IPv4-compatible IPv6 are not public", async () => {
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => { if (req.url === "/robots.txt") { res.writeHead(404).end(); return; } res.writeHead(200, { "content-type": "text/html" }).end("INTERNAL"); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    const http = new Http({ userAgent: "t", robotsToken: "CrestmontResearchBot", timeoutMs: 2000, perHostIntervalMs: 1000, concurrency: 2, maxBytes: 100000 });
    const r = await http.get(`http://127.0.0.1:${port}/secret`);
    assert.equal(r.status, null);
    assert.equal(r.error?.kind, "blocked_address");
    assert.equal(r.body, "");
    for (const u of ["http://[::1]/", "http://192.168.1.1/admin", "http://169.254.169.254/latest/meta-data/"]) assert.equal((await http.get(u)).error?.kind, "blocked_address", u);
  } finally { srv.close(); }
  for (const ip of ["64:ff9b::c0a8:101", "2002:c0a8:101::1", "::192.168.1.1", "::ffff:c0a8:101"]) assert.equal(isPublicAddress(ip), false, ip);
});

test("[review] a Crawl-delay over 60 s marks the site restricted instead of holding a worker slot", () => {
  const r = parseRobots("User-agent: *\nCrawl-delay: 86400\n");
  assert.equal(robotsDecision(r, "CrestmontResearchBot", "/").crawlDelay, 86400);
  // Http.allowed() treats it as disallowed; verified through the decision the client uses:
  const http = new Http({ userAgent: "t", robotsToken: "CrestmontResearchBot", timeoutMs: 2000, perHostIntervalMs: 1000, concurrency: 1, maxBytes: 1000 });
  (http as unknown as { hosts: Map<string, unknown> }).hosts.set("slow.example", { next: 0, busy: false, robots: { at: Date.now(), r } });
  return http.allowed(new URL("https://slow.example/")).then((ok) => assert.equal(ok, false));
});

test("[review] a batch the platform refuses permanently is parked with the reason, not retried forever; 413 never resurrects re-queued work", () => {
  const st = new State(":memory:");
  const t = new Date();
  for (let i = 0; i < 3; i++) st.upsertCandidate(cand({ businessKey: `overture:p${i}` }), "MI", t, 30);
  st.claim(10, t, 60_000);
  for (let i = 0; i < 3; i++) st.finish(`overture:p${i}`, { i }, t);
  const b = st.enqueueBatch(10, t)!;
  st.parkOutbox(b.batchId, "platform refused the batch (422)", t);
  assert.equal(st.outboxDepth(), 0);
  assert.equal(st.stages().failed, 3);
  const st2 = new State(":memory:");
  st2.upsertCandidate(cand({ businessKey: "overture:q1" }), "MI", t, 30); st2.claim(1, t, 60_000); st2.finish("overture:q1", { a: 1 }, t);
  const b2 = st2.enqueueBatch(10, t)!;
  st2.upsertCandidate({ ...cand({ businessKey: "overture:q1" }), phones: ["+15175552199"] }, "MI", t, 30); // source changed meanwhile
  st2.splitOutbox(b2.batchId, t);
  assert.equal(st2.stages().pending, 1, "re-verified, not re-sent with the old result");
});

// ───────────── CodeQL js/double-escaping regression (identity.ts decodeEntities) ─────────────
import { decodeEntities } from "../src/identity.ts";

test("[review] HTML entities are decoded exactly once: double-encoded and nested references stay literal text", () => {
  // Double-encoded: one decoding step only.
  assert.equal(decodeEntities("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
  assert.equal(decodeEntities("&amp;amp;"), "&amp;");
  assert.equal(decodeEntities("&amp;#38;"), "&#38;");
  assert.equal(decodeEntities("&#38;lt;"), "&lt;", "numeric & followed by an entity name is not decoded again");
  assert.equal(decodeEntities("&#x26;quot;"), "&quot;");
  assert.equal(decodeEntities("&amp;amp;amp;"), "&amp;amp;");
  // Decoding the output again is a separate, explicit step (never done by the worker): each step peels one layer.
  assert.equal(decodeEntities(decodeEntities("&amp;amp;lt;")), "&lt;");
});

test("[review] legitimate business names with ampersands and common entities decode correctly", () => {
  assert.equal(decodeEntities("Smith &amp; Sons Plumbing"), "Smith & Sons Plumbing");
  assert.equal(decodeEntities("Smith & Sons Plumbing"), "Smith & Sons Plumbing", "a bare & is kept");
  assert.equal(decodeEntities("A&amp;B Auto &#8211; Lansing&nbsp;MI"), "A&B Auto – Lansing MI");
  assert.equal(decodeEntities("Joe&#39;s &quot;Best&quot; Pizza &#x2014; O&apos;Neil"), "Joe's \"Best\" Pizza — O'Neil");
  assert.equal(decodeEntities("Caf&#233; &AMP; Bakery"), "Café & Bakery");
  // Identity matching still works for an ampersand name rendered with &amp; on the page.
  const c = cand({ name: "Smith & Sons Plumbing", phones: ["+15175552142"] });
  const r = identity(c, pageFacts(page({ title: "Smith &amp; Sons Plumbing" })), []);
  assert.ok(r.signals.some((s) => s.includes("business name")), JSON.stringify(r));
  assert.equal(pageFacts("<title>Smith &amp;amp; Sons</title>").title, "Smith &amp; Sons");
});

test("[review] malformed and out-of-range references never throw and never produce invalid characters", () => {
  assert.equal(decodeEntities("&amp"), "&amp", "no semicolon: left as written");
  assert.equal(decodeEntities("&unknownentity;"), "&unknownentity;");
  assert.equal(decodeEntities("&#;&#x;&#xZZ;"), "&#;&#x;&#xZZ;");
  assert.equal(decodeEntities("&#0;"), "�");
  assert.equal(decodeEntities("&#xD800;"), "�", "lone surrogate");
  assert.equal(decodeEntities("&#1114112;"), "�", "above U+10FFFF");
  assert.equal(decodeEntities("&#99999999999;"), "&#99999999999;", "absurdly long number is not a reference");
  assert.equal(decodeEntities("&#60;b&#62;"), "<b>", "decoded angle brackets are plain text; tags were stripped before decoding");
  assert.doesNotThrow(() => decodeEntities("&".repeat(10000) + "amp;".repeat(10000)));
  // pageFacts strips tags before decoding, so encoded markup cannot become a tag that is then stripped or matched.
  const f = pageFacts("<h1>&lt;img src=x onerror=alert(1)&gt; Riverside</h1>");
  assert.equal(f.h1, "<img src=x onerror=alert(1)> Riverside");
});

// ───────────── regressions from the first real-data runs (aggregate diagnostics) ─────────────

test("[live] politeness and robots waits never count as a slow website; only the final HTML response time does", () => {
  const html = page();
  const waited = ok(SITE, html, { ms: 9000, responseMs: 350 });
  assert.ok(!htmlFindings(waited, pageFacts(html), html).some((f) => f.code === "slow_response"), "9 s of our own waiting is not the site's fault");
  const slow = ok(SITE, html, { ms: 9000, responseMs: 6200 });
  const f = htmlFindings(slow, pageFacts(html), html).find((x) => x.code === "slow_response");
  assert.ok(f && /6200 ms/.test(f.evidence));
  assert.ok(!htmlFindings(ok(SITE, html, { ms: 9000 }), pageFacts(html), html).some((x) => x.code === "slow_response"), "no measurement, no finding");
});

test("[live] a script-built page without visible contact details is recorded, but cannot make a healthy site 'with issues' on its own", async () => {
  const jsPage = `<!doctype html><html lang="en"><head><title>Riverside Plumbing</title><meta name="viewport" content="width=device-width"><meta name="description" content="x"></head><body><h1>Riverside Plumbing</h1><p>120 Main Street, Lansing</p><div id="app"></div><script src="/app.js"></script></body></html>`;
  const r = await evaluate(cand(), deps(new FakeHttp({ [SITE]: ok(SITE, jsPage, { responseMs: 300 }) }), new State(":memory:")), null);
  assert.ok(r.kind === "done");
  if (r.kind !== "done") return;
  const nc = r.prospect.findings!.find((f) => f.code === "no_contact_method");
  assert.ok(nc && nc.confidence < 0.6, "recorded with low confidence");
  assert.equal(r.cls, "VERIFIED_OFFICIAL_WEBSITE");
  assert.equal(r.send, false);
});

test("[live] results that are not sent are kept locally for diagnostics and never batched", () => {
  const st = new State(":memory:");
  const t = new Date();
  st.upsertCandidate(cand(), "MI", t, 30); st.claim(1, t, 60_000);
  st.finish("overture:t1", { website: { classification: "VERIFIED_OFFICIAL_WEBSITE" } }, t, false);
  assert.equal(st.stages().skipped, 1);
  assert.equal(st.enqueueBatch(10, t), null);
  assert.ok((st.db.prepare(`SELECT result FROM candidates`).get() as { result: string | null }).result);
});

test("[live] robots.txt redirects are followed (RFC 9309); a redirect into a private address is refused", async () => {
  const { createServer } = await import("node:http");
  const hits: string[] = [];
  const srv = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/robots.txt") { res.writeHead(301, { location: "/real-robots.txt" }).end(); return; }
    if (req.url === "/real-robots.txt") { res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /private\n"); return; }
    res.writeHead(200, { "content-type": "text/html" }).end("<title>ok</title>");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    const http = new Http({ userAgent: "t", robotsToken: "CrestmontResearchBot", timeoutMs: 2000, perHostIntervalMs: 1000, concurrency: 2, maxBytes: 100000, allowLoopback: true });
    assert.equal(await http.allowed(new URL(`http://127.0.0.1:${port}/`)), true, "redirected robots.txt read: / allowed");
    assert.equal(await http.allowed(new URL(`http://127.0.0.1:${port}/private/x`)), false, "and its rules applied");
    assert.ok(hits.includes("/real-robots.txt"));
  } finally { srv.close(); }
});

test("[live] franchise and multi-location handling: brand-managed chain locations are not prospects; same-site locations of one business are recognised", async () => {
  const st = new State(":memory:");
  const chain = await evaluate(cand({ businessKey: "overture:chain1", name: "Big Burger", brand: "Big Burger", brandWikidata: "Q123" }), deps(new FakeHttp({}), st), null);
  assert.ok(chain.kind === "done" && chain.send === false && chain.cls === "WEBSITE_UNVERIFIED");
  if (chain.kind === "done") assert.match(chain.prospect.website.checks!.find((c) => c.stage === "A" && /brand/.test(c.result))!.result, /Q123/);
  // Two locations of one local business share a website that shows the central phone number.
  const site = "https://riverside-plumbing.example/";
  const centralPage = page({ phone: "(517) 555-2900", street: "1 Central Ave" });
  const a = cand({ businessKey: "overture:loc1", phones: ["+15175552142"], address: { line: "120 Main St", city: "Lansing", state: "MI", zip: "48933" } });
  const b = cand({ businessKey: "overture:loc2", phones: ["+15175552143"], address: { line: "9 Oak St", city: "Lansing", state: "MI", zip: "48912" } });
  st.upsertCandidate(a, "MI", new Date(), 30); st.upsertCandidate(b, "MI", new Date(), 30);
  const r = await evaluate(a, deps(new FakeHttp({ [site]: ok(site, centralPage, { responseMs: 200 }) }), st), null);
  assert.ok(r.kind === "done" && r.cls === "VERIFIED_OFFICIAL_WEBSITE", JSON.stringify(r).slice(0, 300));
  if (r.kind === "done") assert.ok(r.prospect.website.identitySignals!.some((s) => /other location/.test(s)));
  // Without a sibling location, a different phone on a listed page is still not confirmed (no false identity).
  const solo = await evaluate(cand({ businessKey: "overture:solo" }), deps(new FakeHttp({ [site]: ok(site, centralPage, { responseMs: 200 }) }), new State(":memory:")), null);
  assert.ok(solo.kind === "done" && solo.cls === "WEBSITE_UNVERIFIED");
});

// ───────────── regressions from the independent lead audit (2026-10-30) ─────────────
import { probeDomains } from "../src/pipeline.ts";

test("[audit] a listed domain that does not exist is reported as a DNS failure (broken listing), not as 'robots.txt disallows'", async () => {
  const http = new Http({ userAgent: "t", robotsToken: "CrestmontResearchBot", timeoutMs: 3000, perHostIntervalMs: 1000, concurrency: 2, maxBytes: 100000 });
  const r = await http.get("https://does-not-exist-crestmont-audit-test.invalid/");
  assert.equal(r.robotsBlocked, false);
  assert.ok(r.error && ["dns", "timeout", "other"].includes(r.error.kind), JSON.stringify(r.error));
  const st = new State(":memory:");
  const listedDead = cand({ websites: ["https://does-not-exist-crestmont-audit-test.invalid/"] });
  const out = await evaluate(listedDead, deps(http as never, st, { brokenAttempts: 1 }), null);
  assert.ok(out.kind === "done" && out.cls === "VERIFIED_WEBSITE_BROKEN", JSON.stringify(out).slice(0, 300));
});

test("[audit] 'no website found' must survive a name-derived probe: the business's own site (phone match) is found; another business's site is ignored", async () => {
  assert.deepEqual(probeDomains("Riverside Plumbing LLC"), ["riversideplumbing.com", "riverside-plumbing.com"]);
  assert.deepEqual(probeDomains("A&B"), []);
  const own = "https://riversideplumbing.com/";
  const found = await evaluate(cand({ websites: [] }), deps(new FakeHttp({ [own]: ok(own, page(), { responseMs: 200 }) }), new State(":memory:")), null);
  assert.ok(found.kind === "done" && found.cls === "VERIFIED_OFFICIAL_WEBSITE", "false 'no website' avoided");
  const other = await evaluate(cand({ websites: [] }), deps(new FakeHttp({ [own]: ok(own, page({ phone: "(616) 555-2900", street: "9 Elm St", city: "Holland" }), { responseMs: 200 }) }), new State(":memory:")), null);
  assert.ok(other.kind === "done" && other.cls === "NO_OFFICIAL_WEBSITE_FOUND", "a similarly named business is not this one");
  if (other.kind === "done") assert.ok(other.prospect.website.checks!.some((c) => /name-derived domain probe/.test(c.method)));
});

test("[audit] the pipeline records independent existence corroboration for 'no website found' (profiles, multiple datasets)", async () => {
  const r = await evaluate(cand({ websites: ["https://www.facebook.com/riverside"], datasets: ["meta", "Foursquare"] }), deps(new FakeHttp({}), new State(":memory:")), null);
  assert.ok(r.kind === "done" && r.cls === "NO_OFFICIAL_WEBSITE_FOUND");
  if (r.kind === "done") {
    assert.ok(r.prospect.website.identitySignals!.some((s) => /^online profile: facebook\.com/.test(s)));
    assert.ok(r.prospect.website.identitySignals!.some((s) => /^listed by 2 independent datasets/.test(s)));
  }
  const bare = await evaluate(cand({ websites: [], datasets: ["meta"] }), deps(new FakeHttp({}), new State(":memory:")), null);
  assert.ok(bare.kind === "done" && !bare.prospect.website.identitySignals!.some((s) => /online profile|independent datasets/.test(s)));
});

test("[audit] a dead listed domain is not 'broken' when the business has moved to a working site (stale listing); it stays broken otherwise", async () => {
  const own = "https://riversideplumbing.com/";
  const moved = await evaluate(cand(), deps(new FakeHttp({ [own]: ok(own, page(), { responseMs: 200 }) }), new State(":memory:"), { brokenAttempts: 1 }), null);
  assert.ok(moved.kind === "done" && moved.cls === "VERIFIED_OFFICIAL_WEBSITE", JSON.stringify(moved).slice(0, 300));
  if (moved.kind === "done") {
    assert.equal(moved.prospect.website.url, own);
    assert.ok(moved.prospect.website.checks!.some((c) => /current website found at riversideplumbing\.com/.test(c.result)));
  }
  // A similarly named site of another business does not rescue it: the dead listing is still reported as broken.
  const other = await evaluate(cand(), deps(new FakeHttp({ [own]: ok(own, page({ phone: "(616) 555-2900", street: "9 Elm St", city: "Holland" }), { responseMs: 200 }) }), new State(":memory:"), { brokenAttempts: 1 }), null);
  assert.ok(other.kind === "done" && other.cls === "VERIFIED_WEBSITE_BROKEN");
  if (other.kind === "done") assert.ok(other.prospect.website.checks!.some((c) => c.method === "stale-listing check"));
});
