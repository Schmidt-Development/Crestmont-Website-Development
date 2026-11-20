// Queue stress (Owner, 2026-11-20, Phase 6 Test E): batches of 1, 10, 50 and 100 websites submitted through the real
// bulk Add and worked through ONLY by the real scheduled job, plus overlapping operations, a worker that stops
// mid-round, a verifier that times out, provider rate limiting and a provider outage with recovery. The verifier here
// is a deterministic stand-in (each site's verdict is known); the real-browser verdicts are proven by
// portfolio-native-matrix.test.ts. Every run must end settled, with one entry and at most one rule per website, and
// nothing published — without any direct database edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { NativeWorld, homepage, page } from "./support/native-world.ts";
import { listActive } from "../src/services/portfolio.ts";
import { runJobs } from "../src/app/scheduled.ts";
import { advanceAllNative, advanceNative } from "../src/services/native/orchestrator.ts";
import { nativeDepsFrom } from "../src/services/native/deps.ts";

const ACCT = "d".repeat(32);
/** A stress-test entry (by its parsed hostname; the test database also holds its own seed entries). */
const isStress = (u: string) => { try { return new URL(u).hostname.endsWith(".stress-native.com"); } catch { return false; } };
type V = { ok: boolean; checks: { name: string; ok: boolean; detail: string }[]; summary: string; at: string };
const pass = (): V => ({ ok: true, checks: [{ name: "frame", ok: true, detail: "loaded" }], summary: "Verified in a real browser: frame", at: new Date().toISOString() });
const fail = (): V => ({ ok: false, checks: [{ name: "canvas", ok: false, detail: "essential 480×480 webgl canvas drew nothing — also when visited directly" }], summary: "canvas: essential canvas drew nothing — also when visited directly", at: new Date().toISOString() });

function world(n: number, prefix: string) {
  const w = new NativeWorld();
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    const host = `${prefix}-${i}.stress-native.com`;
    // Every fifth site has its own defect (must end unavailable); the rest refuse framing until Crestmont's rule.
    w.site({ host, pages: { "/": homepage(`${prefix} ${i}`), "/about": page("About"), "/login": page("Sign in") } }).cloudflareZone(host, ACCT, { proxied: [host] });
    urls.push(`https://${host}/`);
  }
  return { w, urls };
}

async function app(w: NativeWorld, opts: { verify?: (u: string, o: string) => Promise<V>; api?: typeof fetch } = {}) {
  const verified: string[] = [];
  const verify = opts.verify ?? (async (_u: string, o: string) => (/-\d*[05]\.stress/.test(o) ? fail() : pass()));
  const t = await createTestApp({ PORTFOLIO_CLOUDFLARE_TOKEN: "cf-test-token", PORTFOLIO_NATIVE_CONCURRENCY: "4", PORTFOLIO_NATIVE_ONBOARD_DAILY: "400",
    overrides: { portfolioFetch: w.fetchSite, providerFetch: opts.api ?? w.fetchApi, nativeVerify: async (u: string, o: string) => { verified.push(o); return verify(u, o); } } } as never);
  const owner = await createStaff(t.db, "owner");
  const o = await t.client().login(owner.email, TEST_PASSWORD);
  return { t, o, verified };
}

async function settle(t: Awaited<ReturnType<typeof createTestApp>>, max = 80) {
  let ticks = 0;
  for (; ticks < max; ticks++) {
    if (!(await listActive(t.db)).some((p) => isStress(p.live_url) && (p.native_state === "checking" || p.native_state === "preparing"))) break;
    await runJobs(t.env, ["portfolio_native"]);
  }
  return ticks;
}

function invariants(w: NativeWorld, all: Awaited<ReturnType<typeof listActive>>, n: number) {
  const entries = all.filter((p) => isStress(p.live_url));   // (the test database's own seed entries aside)
  assert.equal(entries.length, n, "exactly one entry per website");
  assert.equal(new Set(entries.map((p) => p.live_url)).size, n, "no duplicate entries");
  assert.ok(w.zones.every((z) => (z.rulesets?.rules.length ?? 0) <= 1), "at most one Crestmont rule per zone");
  assert.equal(entries.filter((p) => p.published).length, 0, "nothing published");
  for (const p of entries) {
    const bad = /-\d*[05]\.stress/.test(p.live_url);
    assert.equal(p.native_state, bad ? "unavailable" : "native_verified", `${p.slug}: ${p.native_reason}`);
  }
}

for (const n of [1, 10, 50, 100]) {
  test(`[PORT-NATIVE-STRESS] a batch of ${n}: one bulk Add, only the scheduled job, every website settled correctly`, { timeout: 600_000 }, async () => {
    const { w, urls } = world(n, `b${n}`);
    const { t, o, verified } = await app(w);
    const t0 = Date.now();
    assert.equal((await o.post("/staff/portfolio/bulk", { urls: urls.join("\n") })).status, 200);
    const ticks = await settle(t);
    const entries = await listActive(t.db);
    invariants(w, entries, n);
    assert.equal(verified.length, n, "one verification per website — none repeated");
    console.log(JSON.stringify({ batch: n, ticks, verifications: verified.length, ms: Date.now() - t0 }));
    t.close();
  });
}

test("[PORT-NATIVE-STRESS] overlapping operations: two rounds and a staff re-check at once never advance an entry twice", { timeout: 300_000 }, async () => {
  const { w, urls } = world(20, "ov");
  // A slow verifier, so the overlapping rounds really overlap.
  const { t, o, verified } = await app(w, { verify: async (_u, origin) => { await new Promise((r) => setTimeout(r, 40)); return /-\d*[05]\.stress/.test(origin) ? fail() : pass(); } });
  await o.post("/staff/portfolio/bulk", { urls: urls.join("\n") });
  const d = nativeDepsFrom(t.env, t.db, "http://crestmont.test");
  const first = (await listActive(t.db)).find((p) => isStress(p.live_url))!;
  await Promise.all([advanceAllNative(d, 30, { maxVerifications: 30, concurrency: 4 }), advanceAllNative(d, 30, { maxVerifications: 30, concurrency: 4 }), advanceNative(d, first.id, { force: true }), runJobs(t.env, ["portfolio_native"])]);
  await settle(t);
  invariants(w, await listActive(t.db), 20);
  assert.equal(verified.length, 20, "each website verified once, however the operations overlapped");
  t.close();
});

test("[PORT-NATIVE-STRESS] a worker that stops mid-step and a verifier that times out: the entries resume on later ticks", { timeout: 300_000 }, async () => {
  const { w, urls } = world(10, "stop");
  let calls = 0;
  const { t, o } = await app(w, { verify: async (_u, origin) => {
    calls++;
    if (calls === 2) throw new Error("worker stopped (simulated)");                                     // a crash mid-verification
    if (calls === 3) return { ok: false, checks: [{ name: "browser", ok: false, detail: "The verification browser failed: Timed out after 120000 ms" }], summary: "browser: The verification browser failed: Timed out", at: new Date().toISOString() };
    return /-\d*[05]\.stress/.test(origin) ? fail() : pass();
  } });
  await o.post("/staff/portfolio/bulk", { urls: urls.join("\n") });
  await settle(t);
  // A crashed or timed-out step leaves its entry in progress for the next tick (the lease is released or expires; a
  // verification-browser failure is a transient error, retried automatically).
  let entries = (await listActive(t.db)).filter((p) => isStress(p.live_url));
  const stuck = entries.filter((p) => p.native_state !== (/-\d*[05]\.stress/.test(p.live_url) ? "unavailable" : "native_verified"));
  assert.deepEqual(stuck.map((p) => p.slug), [], "recovered by the job alone — no one had to press Retry");
  entries = await listActive(t.db);
  invariants(w, entries, 10);
  assert.equal(entries.filter((p) => p.native_lease_until).length, 0, "no lease left behind");
  t.close();
});

test("[PORT-NATIVE-STRESS] provider rate limiting and an outage: nothing is duplicated or lost; everything completes after recovery", { timeout: 300_000 }, async () => {
  const { w, urls } = world(12, "out");
  let outage = true, n = 0;
  const api: typeof fetch = async (input, init) => {
    n++;
    if (outage) return new Response(JSON.stringify({ success: false, errors: [{ message: "Service unavailable" }] }), { status: 503, headers: { "content-type": "application/json" } });
    if (n % 7 === 0) return new Response(JSON.stringify({ success: false, errors: [{ code: 10429, message: "rate limited" }] }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } });
    return w.fetchApi(input, init);
  };
  const { t, o } = await app(w, { api });
  await o.post("/staff/portfolio/bulk", { urls: urls.join("\n") });
  await settle(t, 6);
  const during = await listActive(t.db);
  assert.equal(during.filter((p) => p.native_state === "native_verified").length, 0, "nothing is verified while the provider is down");
  assert.ok(w.zones.every((z) => !z.rulesets?.rules.length), "no change was half-applied during the outage");
  outage = false;
  // Recovery without anyone acting: transient failures stayed in progress, so the job simply continues (bounded).
  await settle(t);
  invariants(w, await listActive(t.db), 12);
  t.close();
});
