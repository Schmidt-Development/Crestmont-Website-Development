// Regression check for the NATIVE LIVE website checks in scripts/preview-explorer-checks.mjs (2026-11-18 production
// acceptance fix): the shared checks must judge a real production website by how it actually works — not by the
// isolated demo's custom messaging. Production run 44262294583 failed ten checks that assumed demo behaviour on real
// sites (a protected /login, /partner/apply or /book "must load in the frame"; the label "must follow" a cross-origin
// page; a one-page site "must have" an in-page link). This drives the same checkInteractive() against TEST DATA
// fixture sites, served through request routing (nothing external is contacted), on desktop and phone, and asserts:
//   • live-multipage — public /services loads in the frame; protected /login (frame-ancestors 'none', XFO DENY) never
//     does, opens in a new tab, and is reported as still refusing framing;
//   • live-onepage   — no public page: its in-page link moves the site only; protected /book is never framed;
//   • live-nonav     — no public page and no in-page link: recorded, and a real click is shown to reach the site;
//   • live-chatty    — a live site that posts Crestmont demo messages itself: the label never follows it;
//   • live-leaky     — NEGATIVE CONTROL: its /login permits framing by Crestmont and it has no framed-mode link handler
//                      → the security check and the protected-tap check must both FAIL.
// Every other check (scrolling, isolation, reload, devices) must pass for every fixture.
//   PLAYWRIGHT_MODULE=… node scripts/live-site-nav-check.mjs http://localhost:8787
// (after: node scripts/scroll-isolation-seed.mjs .dev/x.db live-multipage,live-onepage,live-nonav,live-chatty,live-leaky)
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = pw.chromium ? pw : pw.default;
const { checkInteractive } = await import("./preview-explorer-checks.mjs");
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\/[A-Za-z0-9.:-]+$/.test(base)) { console.error("usage: live-site-nav-check.mjs <crestmont-origin>"); process.exit(2); }

const PUBLIC = { "content-type": "text/html", "content-security-policy": `frame-ancestors ${base}` };
const PRIVATE = { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" };
const filler = (n) => Array.from({ length: n }, (_, i) => `<h2>Section ${i + 1}</h2><p>TEST DATA paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>`).join("");
// The framing standard's link handler: inside a frame, links to non-framable pages open in a new tab.
const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const handler = (paths) => `<script data-private="${attr(paths.join(" "))}">(() => { const P = document.currentScript.dataset.private.split(" "); if (window !== top) addEventListener("click", (e) => { const a = e.target.closest("a[href]"); if (!a) return; const u = new URL(a.href, location.href); if (u.origin === location.origin && P.includes(u.pathname)) { e.preventDefault(); open(u.href, "_blank", "noopener"); } }, true); })();</script>`;
const page = (body, extra = "") => `<!doctype html><meta name=viewport content="width=device-width"><title>TEST DATA fixture</title><style>body{font:16px sans-serif;margin:0;padding:16px}nav a{margin-right:12px}</style>${extra}<body>${body}</body>`;

const SITES = {
  "live-multipage": {
    "/": [PUBLIC, page(`<nav><a href="/services">Services</a><a href="/login">Log in</a></nav><h1>Multi-page fixture</h1>${filler(40)}`, handler(["/login"]))],
    "/services": [PUBLIC, page(`<h1>Services</h1>${filler(10)}`)],
    "/login": [PRIVATE, page("<h1>Sign in</h1>")],
  },
  "live-onepage": {
    "/": [PUBLIC, page(`<nav><a href="#contact">Contact</a><a href="/book">Book now</a></nav><h1>One-page fixture</h1>${filler(40)}<h2 id="contact">Contact</h2><p>TEST DATA</p>${filler(5)}`, handler(["/book"]))],
    "/book": [PRIVATE, page("<h1>Booking</h1>")],
  },
  "live-nonav": {
    "/": [PUBLIC, page(`<h1>No-navigation fixture</h1><p><a href="https://example.org/" target="_blank" rel="noopener">Partner</a> · <a href="tel:+15555550100">Call</a> · <a href="/quote">Get a quote</a></p>${filler(40)}`, handler(["/quote"]))],
    "/quote": [PRIVATE, page("<h1>Quote</h1>")],
  },
  "live-chatty": {
    "/": [PUBLIC, page(`<nav><a href="/about">About</a></nav><h1>Chatty fixture</h1>${filler(40)}<script>setInterval(() => parent.postMessage({ source: "crestmont-demo", type: "navigate", href: location.origin + "/self-announced" }, "*"), 300);</script>`)],
    "/about": [PUBLIC, page(`<h1>About</h1>${filler(10)}`)],
  },
  "live-leaky": {
    "/": [PUBLIC, page(`<nav><a href="/services">Services</a><a href="/login">Log in</a></nav><h1>Leaky fixture</h1>${filler(40)}`)],
    "/services": [PUBLIC, page(`<h1>Services</h1>${filler(10)}`)],
    "/login": [PUBLIC, page("<h1>Sign in (wrongly framable)</h1>")], // the defect the security check must catch
  },
};
const answer = (url) => {
  const u = new URL(url), site = SITES[u.hostname.split(".")[0]], hit = site?.[u.pathname];
  return hit ? { status: 200, headers: hit[0], body: hit[1] } : { status: 404, headers: { "content-type": "text/plain" }, body: "" };
};
const headersOf = async (url) => { const a = answer(url); return { status: a.status, headersArray: Object.entries(a.headers).map(([name, value]) => ({ name, value })) }; };

// What each fixture must show. pass: checks that must PASS; fail: checks that must FAIL (the negative control).
const EXPECT = {
  "live-multipage": { pass: [/sensitive route \/login still refuses framing/, /protected link \/login never loads inside the frame .*opened in a new tab \(\/login\)/, /public navigation to \/services loads inside the frame/, /forged messages .* are ignored/], fail: [] },
  "live-onepage": { pass: [/sensitive route \/book still refuses framing/, /protected link \/book never loads inside the frame .*opened in a new tab/, /in-page link #contact moves the live site only/], fail: [] },
  "live-nonav": { pass: [/sensitive route \/quote still refuses framing/, /no public in-site link to follow \(recorded, not invented\) — a real click reaches the live site/], fail: [] },
  "live-chatty": { pass: [/public navigation to \/about loads inside the frame/, /label stays the live site's host; forged messages .* are ignored/], fail: [] },
  "live-leaky": { pass: [/public navigation to \/services loads inside the frame/], fail: [/sensitive route \/login PERMITS framing by Crestmont — must refuse/, /protected link \/login never loads inside the frame .*no new tab opened/] },
};

let failed = 0;
const verdict = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) failed++; };
const b = await chromium.launch();
for (const [name, viewport, mobile] of [["desktop", { width: 1440, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]]) {
  const ctx = await b.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  await ctx.route(/^https:\/\/live-[a-z]+\.fixture-portfolio\.com\//, (r) => { const a = answer(r.request().url()); r.fulfill({ status: a.status, headers: a.headers, body: a.body }); });
  for (const slug of Object.keys(SITES)) {
    const p = await ctx.newPage(), seen = [];
    const ok = (c, m) => { seen.push({ c: !!c, m }); console.log(`  ${c ? "pass" : "fail"} ${m}`); };
    try {
      await p.goto(`${base}/portfolio/${slug}`, { waitUntil: "domcontentloaded" });
      await p.locator(".pfx").first().scrollIntoViewIfNeeded();
      for (let k = 0; k < 60 && !(await p.evaluate(() => document.querySelector(".pfx__slide")?.classList.contains("is-ready"))); k++) await p.waitForTimeout(300);
      await checkInteractive(p, `${name} /portfolio/${slug}`, ok, { touch: mobile, headersOf });
    } catch (e) { ok(false, `${slug}: ${String(e.message).split("\n")[0].slice(0, 200)}`); }
    const e = EXPECT[slug], has = (rx, c) => seen.some((x) => x.c === c && rx.test(x.m));
    for (const rx of e.pass) verdict(has(rx, true), `${name} ${slug}: passes — ${rx.source}`);
    for (const rx of e.fail) verdict(has(rx, false), `${name} ${slug}: the security check catches the defect — ${rx.source}`);
    const unexpected = seen.filter((x) => !x.c && !e.fail.some((rx) => rx.test(x.m)));
    verdict(unexpected.length === 0, `${name} ${slug}: no other check fails${unexpected.length ? ` — ${unexpected.map((x) => x.m).join(" | ")}` : ""} (${seen.length} checks)`);
    await p.close();
  }
  await ctx.close();
}
await b.close();
console.log(failed ? `${failed} live-site regression check(s) failed` : "live-site checks verified against every fixture (desktop and phone)");
process.exit(failed ? 1 : 0);
