// TEST DATA fixture websites for the portfolio display-mode and remote-browser checks (scripts/remote-browser-check.mjs,
// dev/server.ts with REMOTE_BROWSER_FIXTURES=1). Each lives at https://<name>.fixture-portfolio.com/ and is answered
// locally — by the dev server's live-site check and by the remote browser's request interception — never fetched from
// the network. Every page reports what it saw (path, clicks, typed text, scroll, viewport, touches, animation frames)
// with a same-site GET to /__state, which the dev server records, so the check can prove that a visitor's input reached
// the real page inside the remote Chromium (not just that pixels changed).
//
//   fa-none       Content-Security-Policy: frame-ancestors 'none'        → Mode B (remote)
//   xfo-deny      X-Frame-Options: DENY, a long page                     → Mode B (remote)
//   heavy-js      frame-ancestors 'none', continuous JS + CSS animation  → Mode B (remote)
//   late-paint    frame-ancestors 'none', a dark empty page whose content fades in after 1.5 s (as Get Every Invoice
//                 Paid does on production)                                → Mode B (remote)
//   allowed       frame-ancestors <Crestmont origin>                     → Mode A (native embed)
//   unavailable   does not answer                                        → Mode C (honest fallback)
export const FIXTURE_DOMAIN = "fixture-portfolio.com";
export const FIXTURES = ["fa-none", "xfo-deny", "heavy-js", "late-paint", "allowed", "unavailable"];
export const EXPECTED_MODE = { "fa-none": "remote", "xfo-deny": "remote", "heavy-js": "remote", "late-paint": "remote", allowed: "embed", unavailable: "unavailable" };

// Fixed, known positions (CSS px of the remote page) so the check can aim at them at any device width (≥ 390).
export const LAYOUT = {
  about: { x: 45, y: 30 }, login: { x: 135, y: 30 }, external: { x: 225, y: 30 }, download: { x: 315, y: 30 },
  clicker: { x: 110, y: 110 }, search: { x: 110, y: 180 }, post: { x: 110, y: 240 },
};

const state = new Map(); // host → latest report
export const fixtureState = (name) => state.get(`${name}.${FIXTURE_DOMAIN}`) ?? null;
export const resetFixtureState = () => state.clear();

const page = (name, path, opts) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} fixture${path === "/" ? "" : ` — ${path}`}</title>
<style>
  *{box-sizing:border-box} body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#f4f1ea;color:#111}
  header{position:fixed;left:0;top:0;width:100%;height:60px;background:#1d3557;z-index:5}
  header a{position:absolute;top:10px;width:85px;height:40px;display:grid;place-items:center;color:#fff;background:#457b9d;text-decoration:none;font-size:13px}
  #about{left:3px} #login{left:93px} #external{left:183px} #download{left:273px}
  .ctl{position:absolute;left:10px;width:200px;height:50px;font-size:15px}
  #clicker{top:85px;background:#e63946;color:#fff;border:0} #q{top:160px;height:40px} #postf button{position:absolute;left:10px;top:220px;width:200px;height:40px}
  #pw{position:absolute;left:230px;top:160px;width:140px;height:40px}
  main{padding-top:300px;min-height:${opts.long ? 9000 : 4000}px;background:linear-gradient(#f4f1ea,#a8dadc)}
  #end{position:absolute;left:10px;top:${opts.long ? 8900 : 3900}px} #layout{position:absolute;left:230px;top:85px}
  ${opts.late ? "html,body{background:#0b1220} body>*{opacity:0} body.in>*{opacity:1;transition:opacity .4s}" : ""}
  ${opts.anim ? "#spin{position:absolute;left:230px;top:220px;width:60px;height:60px;background:#2a9d8f;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}} #anim{position:absolute;left:0;top:300px;width:100%;height:200px}" : ""}
</style></head><body>
<header><a id="about" href="/about">About</a><a id="login" href="/login">Sign in</a><a id="external" href="https://elsewhere.fixture-portfolio.net/">Partner</a><a id="download" href="/files/brochure.pdf" download>Brochure</a></header>
<button id="clicker" class="ctl" type="button">Clicked 0</button>
<input id="q" class="ctl" type="search" placeholder="Search" aria-label="Search">
<input id="pw" type="password" aria-label="Password">
<form id="postf" method="post" action="/contact"><input type="hidden" name="x" value="1"><button type="submit">Send enquiry</button></form>
<p id="layout"></p>${opts.anim ? '<div id="spin"></div><canvas id="anim" width="1440" height="200"></canvas>' : ""}
<main><h1>${name} — ${path}</h1><p>TEST DATA fixture site.</p><p id="end">End of page</p></main>
<script>
  const S = { path: location.pathname, clicks: 0, q: "", scrollY: 0, w: innerWidth, touches: 0, raf: 0, loads: 0, ua: navigator.userAgent.includes("Mobile") ? "mobile" : "desktop" };
  try { S.loads = Number(sessionStorage.getItem("loads") || 0) + 1; sessionStorage.setItem("loads", S.loads); } catch {}
  let t = 0; const report = () => { clearTimeout(t); t = setTimeout(() => fetch("/__state?" + new URLSearchParams(Object.entries(S).map(([k, v]) => [k, String(v)])), { cache: "no-store" }).catch(() => {}), 60); };
  document.getElementById("layout").textContent = innerWidth < 600 ? "Phone layout" : innerWidth < 1024 ? "Tablet layout" : "Desktop layout";
  document.getElementById("clicker").addEventListener("click", (e) => { S.clicks++; e.target.textContent = "Clicked " + S.clicks; report(); });
  document.getElementById("q").addEventListener("input", (e) => { S.q = e.target.value; report(); });
  addEventListener("scroll", () => { S.scrollY = Math.round(scrollY); report(); }, { passive: true });
  addEventListener("touchstart", () => { S.touches++; report(); }, { passive: true });
  addEventListener("resize", () => { S.w = innerWidth; report(); });
  ${opts.anim ? `const c = document.getElementById("anim").getContext("2d"); const loop = (ts) => { S.raf++; c.fillStyle = "hsl(" + ((ts / 8) % 360) + ",70%,50%)"; c.fillRect(0, 0, 1440, 200); for (let i = 0; i < 2000; i++) Math.sqrt(i * ts); if (S.raf % 30 === 0) report(); requestAnimationFrame(loop); }; requestAnimationFrame(loop);` : ""}
  ${opts.late ? 'setTimeout(() => document.body.classList.add("in"), 1500);' : ""}
  report();
</script></body></html>`;

/** The fixture answer for a URL, or null when the URL is not a fixture host. `origin` is Crestmont's own origin. */
export function fixtureResponse(url, origin) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!u.hostname.endsWith(`.${FIXTURE_DOMAIN}`) && !u.hostname.endsWith(".fixture-portfolio.net")) return null;
  const name = u.hostname.slice(0, -(FIXTURE_DOMAIN.length + 1));
  if (u.hostname.endsWith(".fixture-portfolio.net")) return { status: 200, headers: { "content-type": "text/html" }, body: "<!doctype html><title>Elsewhere</title><h1>Third-party site</h1>", record: () => state.set(`elsewhere.${FIXTURE_DOMAIN}`, { reached: "1" }) };
  if (name === "unavailable") return { error: true };
  if (!FIXTURES.includes(name)) return { status: 404, headers: { "content-type": "text/plain" }, body: "no such fixture" };
  if (u.pathname === "/__state") {
    const prev = state.get(u.hostname) ?? {};
    state.set(u.hostname, { ...prev, ...Object.fromEntries(u.searchParams), at: String(Date.now()) });
    return { status: 204, headers: { "cache-control": "no-store" }, body: "" };
  }
  // A private route, a file download or a form post reaching the site would be a policy failure: recorded for the check.
  if (/^\/(login|files|contact)/.test(u.pathname)) {
    const prev = state.get(u.hostname) ?? {};
    state.set(u.hostname, { ...prev, privateReached: u.pathname });
  }
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  if (name === "fa-none" || name === "heavy-js" || name === "late-paint") headers["content-security-policy"] = "frame-ancestors 'none'";
  if (name === "xfo-deny") headers["x-frame-options"] = "DENY";
  if (name === "allowed") headers["content-security-policy"] = `frame-ancestors 'self' ${origin}`;
  return { status: 200, headers, body: page(name, u.pathname, { long: name === "xfo-deny", anim: name === "heavy-js", late: name === "late-paint" }) };
}
