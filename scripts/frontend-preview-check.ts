// Frontend preview only (deploy-frontend-preview.yml). Proves, on the deployed preview, that the Founder's own
// secrets open it: preview password → gated homepage → demo Owner sign-in → two-factor enrolment required.
// It stops at the redirect to two-factor setup (it never enrols an authenticator), and prints no credentials.
// Usage: PREVIEW_PASSWORD=… DEMO_PASSWORD=… node --no-warnings scripts/frontend-preview-check.ts <base-url>
const base = (process.argv[2] ?? "").replace(/\/$/, "");
const gatePw = process.env.PREVIEW_PASSWORD ?? "", demoPw = process.env.DEMO_PASSWORD ?? "";
if (!/^https?:\/\//.test(base) || !gatePw || !demoPw) throw new Error("usage: PREVIEW_PASSWORD=… DEMO_PASSWORD=… frontend-preview-check.ts <base-url>");

const jar = new Map<string, string>();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function req(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), cookie: cookieHeader() } });
  for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
  return res;
}
const fail = (m: string): never => { console.log(`::error::${m}`); process.exit(1); };

// 1. Preview password (the Worker secret was just written; allow up to ~60 s to propagate).
for (let i = 0; i < 12 && !jar.has("cm_preview"); i++) {
  await req("/__preview-access", { method: "POST", body: new URLSearchParams({ password: gatePw, next: "/" }) });
  if (!jar.has("cm_preview")) await new Promise((r) => setTimeout(r, 5000));
}
if (!jar.has("cm_preview")) fail("the preview did not accept FRONTEND_PREVIEW_PASSWORD");
console.log("ok   preview password accepted");

// 2. Gated homepage renders.
const home = await req("/");
if (home.status !== 200 || !(await home.text()).includes("Websites built with")) fail(`homepage behind the gate returned ${home.status}`);
console.log("ok   homepage renders behind the gate");

// 2b. Portfolio: every "Visit live website" link on the hosted page is the real public site (never a demo or staging
// host), opens safely in a new tab, and the destination actually answers on its canonical host.
{
  const { PORTFOLIO_PROJECTS } = await import("../src/content/portfolio-projects.ts");
  const page = await req("/portfolio"); const html = await page.text();
  if (page.status !== 200) fail(`/portfolio returned ${page.status}`);
  const links = [...html.matchAll(/<a class="pfx__link pfx__link--live" href="([^"]+)" target="_blank" rel="([^"]+)"/g)].map((m) => ({ href: m[1], rel: m[2] }));
  const expected = PORTFOLIO_PROJECTS.map((p) => new URL(p.liveUrl).href);
  if (links.length !== expected.length) fail(`/portfolio shows ${links.length} live-website links, expected ${expected.length}`);
  for (const l of links) {
    if (!expected.includes(new URL(l.href).href)) fail(`unexpected live-website link ${l.href}`);
    if (!/\bnoopener\b/.test(l.rel) || !/\bnoreferrer\b/.test(l.rel)) fail(`${l.href}: rel="${l.rel}" must include noopener noreferrer`);
    if (/workers\.dev|pages\.dev|staging|preview/i.test(l.href)) fail(`${l.href} points at a demo, preview or staging host`);
    let res: Response | null = null;
    for (let i = 0; i < 3 && !res?.ok; i++) { res = await fetch(l.href, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (Crestmont portfolio link check)" } }).catch(() => null); if (!res?.ok) await new Promise((r) => setTimeout(r, 3000)); }
    if (!res?.ok) fail(`${l.href} did not load (HTTP ${res?.status ?? "network error"})`);
    if (new URL(res!.url).host !== new URL(l.href).host) fail(`${l.href} redirected to ${res!.url}`);
    console.log(`ok   live website ${l.href} → HTTP ${res!.status}`);
  }
  const embedded = [...html.matchAll(/data-demo-url="([^"]+)"/g)].map((m) => m[1]);
  console.log(`ok   portfolio: ${links.length} live-website links verified; ${embedded.length} interactive demo(s) embedded${embedded.length ? ` (${embedded.join(", ")})` : " — screenshots with an honest status until demos are verified"}`);
}

// 3. Demo Owner signs in with the Founder's demo password and is sent to two-factor setup (2FA stays required).
const login = await req("/login"); const csrf = /name="_csrf" value="([0-9a-f]{32})"/.exec(await login.text())?.[1];
if (!csrf) fail("sign-in form has no CSRF token");
const post = await req("/login", { method: "POST", body: new URLSearchParams({ _csrf: csrf!, email: "owner@crestmont-preview.test", password: demoPw }) });
const loc = post.headers.get("location") ?? "";
if (post.status !== 303 && post.status !== 302) fail(`demo Owner sign-in was not accepted (HTTP ${post.status})`);
if (!/^\/mfa(\/setup)?(\?|$)/.test(new URL(loc, base).pathname + new URL(loc, base).search)) fail(`demo Owner sign-in redirected to ${new URL(loc, base).pathname}, expected two-factor setup`);
const owner = await req("/staff/owner");
if (owner.status === 200 && !(owner.headers.get("location") ?? "").length && (await owner.text()).includes("Executive overview")) fail("Owner dashboard opened without two-factor authentication");
console.log("ok   demo Owner sign-in accepted; two-factor enrolment is required before any staff page");
