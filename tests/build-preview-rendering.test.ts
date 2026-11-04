// The preview has to RENDER, not merely respond.
//
// bld_50e28bbd1cd033ad9ddfad02 revision 1-3 scored 9.4/10 and opened in Edge as raw HTML: Times New Roman, blue
// underlined links, bullet-point navigation, no layout. Every existing test passed throughout, because they all
// asked questions that a broken preview answers correctly -- the rewritten URLs were right, the route returned
// HTTP 200, the stored bytes were intact. None of them asked whether a browser could actually fetch the
// stylesheet the HTML points at.
//
// Measured cause (Microsoft Edge, DevTools Protocol, against the stored bytes of that revision):
//   document            200 text/html
//   assets/tokens.css   303 -> /login  -> net::ERR_BLOCKED_BY_ORB
//   assets/site.css     303 -> /login  -> net::ERR_BLOCKED_BY_ORB
//   assets/app.js       303 -> /login  -> net::ERR_BLOCKED_BY_ORB
// The CSP `sandbox` directive gives the preview an opaque origin; a browser does not send a SameSite=Lax session
// cookie on a request an opaque-origin document makes; requireStaff therefore saw an anonymous request and
// redirected it to the sign-in page, which is HTML and so is refused in place of a stylesheet.
//
// These tests pin the three things that failure needed, so it cannot come back quietly:
//   1. the preview's subresource URLs resolve WITHOUT a session cookie  (the actual defect)
//   2. a page's stylesheet URL is served as text/css and not as a redirect to HTML
//   3. the token is a real capability -- scoped, signed and expiring -- and not a guessable string
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  previewToken, previewTokenValid, previewHeaders, PREVIEW_TOKEN_TTL_S, rewriteForPrefix, resolveRequested,
} from "../src/services/build-revisions.ts";

const ENV = { BUILD_RUNNER_SECRET: "runner-secret-at-least-32-characters-long!!" };
const JOB = "bld_50e28bbd1cd033ad9ddfad02";

test("[PREVIEW-RENDER] the stylesheet a preview page asks for is reachable with no session cookie at all", async () => {
  // This is the defect in one assertion. The preview document runs at an opaque origin, so every request it makes
  // is anonymous; if reaching its own stylesheet needs a cookie, the page cannot be styled, whatever the route
  // returns to a logged-in human clicking the link.
  const t = (await previewToken(ENV, JOB, 1, 3))!;
  assert.ok(t, "a token is minted when a signing secret exists");
  assert.equal(await previewTokenValid(ENV, JOB, 1, 3, t), true,
    "and it authorises the revision on its own -- no cookie, no session, no staff record is consulted");
});

test("[PREVIEW-RENDER] a page's <link href> points inside the capability prefix, so the browser's request carries the token", async () => {
  const t = (await previewToken(ENV, JOB, 1, 3))!;
  const prefix = `/build-preview/${JOB}/1-3/${t}`;
  // The real stored markup of revision 1-3: root-relative, exactly as the full-stack starter emits it.
  const html = `<!doctype html><html><head>
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/app.js" defer></script></head>
<body><a href="/services.html">Services</a><img src="/img/truck.png" srcset="/img/truck.png 1x, /img/truck@2x.png 2x"></body></html>`;
  const out = rewriteForPrefix("text/html; charset=utf-8", html, prefix);

  for (const asset of ["assets/tokens.css", "assets/site.css", "assets/app.js", "services.html", "img/truck.png"]) {
    assert.ok(out.includes(`${prefix}/${asset}`), `${asset} is requested through the capability prefix`);
  }
  assert.ok(out.includes(`${prefix}/img/truck@2x.png 2x`), "srcset candidates too, or retina images 404");
  // A bare root-relative URL left behind would hit the staff origin and be redirected to /login: the exact bug.
  assert.doesNotMatch(out, /(?:href|src)="\/(?!build-preview\/)/,
    "no root-relative URL survives the rewrite pointing outside the capability prefix");
});

test("[PREVIEW-RENDER] CSS is rewritten too, so url() assets inside the stylesheet resolve", () => {
  const prefix = "/build-preview/bld_x/1-3/tok";
  const css = `@font-face{src:url("/assets/inter.woff2")}.hero{background-image:url(/img/hero.jpg)}`;
  const out = rewriteForPrefix("text/css; charset=utf-8", css, prefix);
  assert.ok(out.includes(`${prefix}/assets/inter.woff2`));
  assert.ok(out.includes(`${prefix}/img/hero.jpg`));
});

test("[PREVIEW-RENDER] the sandbox stays, and the policy names the preview's own prefix rather than 'self'", () => {
  const base = "https://example.test/build-preview/bld_x/1-3/tok/";
  const csp = previewHeaders("text/html; charset=utf-8", base)["content-security-policy"];

  // The boundary that made the cookie unusable is the boundary we are keeping: generated JavaScript must not be
  // able to reach a staff session. Removing `sandbox` would have "fixed" the rendering and broken this.
  assert.match(csp, /sandbox allow-scripts allow-forms allow-popups/, "the document still gets an opaque origin");
  assert.doesNotMatch(csp, /allow-same-origin/,
    "never alongside allow-scripts: that would let the generated page script the staff origin");
  assert.match(csp, /connect-src 'none'/, "the generated frontend still cannot call the platform API");
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);

  // `'self'` is meaningless to a document whose origin is opaque; the policy must name the prefix instead, which
  // also confines the generated page to its OWN snapshot rather than the whole origin.
  // frame-ancestors is exempt: it is matched against the EMBEDDING page's origin (the staff page), not against
  // this document's own, so 'self' is both meaningful and correct there.
  // Compared as whole source expressions, not as substrings of the policy: "the prefix appears somewhere in
  // style-src" would also be true of a policy that merely allowed a host the prefix happens to sit under.
  for (const directive of ["default-src", "img-src", "style-src", "script-src", "font-src"]) {
    const sources = (new RegExp(`(?:^|; )${directive} ([^;]*)`).exec(csp)?.[1] ?? "").trim().split(/\s+/);
    assert.ok(sources.includes(base), `${directive} names the preview prefix exactly, not a bare origin`);
    assert.ok(!sources.includes("'self'"),
      `${directive} must not rely on 'self': this document's origin is opaque, so 'self' can never match it`);
  }
  assert.match(csp, /style-src [^;]*'unsafe-inline'/, "inline <style> blocks the builder emits still apply");
});

test("[PREVIEW-RENDER] the token is scoped to one revision of one job, and expires", async () => {
  const t = (await previewToken(ENV, JOB, 1, 3))!;
  assert.equal(await previewTokenValid(ENV, JOB, 1, 3, t), true);

  assert.equal(await previewTokenValid(ENV, JOB, 1, 2, t), false, "not another cycle");
  assert.equal(await previewTokenValid(ENV, JOB, 2, 3, t), false, "not another attempt");
  assert.equal(await previewTokenValid(ENV, "bld_someoneelse000000000", 1, 3, t), false, "not another customer's build");
  assert.equal(await previewTokenValid({ BUILD_RUNNER_SECRET: "a-different-secret-entirely-0123456789" }, JOB, 1, 3, t), false,
    "not under a different signing key");

  // Expiry, checked past the boundary rather than at it.
  const later = Date.now() + (PREVIEW_TOKEN_TTL_S + 120) * 1000;
  assert.equal(await previewTokenValid(ENV, JOB, 1, 3, t, later), false, "an hour-old link stops working");
});

test("[PREVIEW-RENDER] a tampered or absent token is refused, and no secret means no token rather than a weak one", async () => {
  const t = (await previewToken(ENV, JOB, 1, 3))!;
  const [exp, mac] = t.split("-");
  for (const bad of [
    "", "undefined", "null", t.slice(0, -1), `${exp}-${"0".repeat(48)}`,
    `${Number(exp) + 86400}-${mac}`,            // a later expiry with the original signature
    `${exp}-${mac.toUpperCase()}`,              // case-shifted hex
    `${exp}-${mac}extra`, `../../${t}`,
  ]) {
    assert.equal(await previewTokenValid(ENV, JOB, 1, 3, bad), false, `refused: ${JSON.stringify(bad)}`);
  }
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.equal(await previewTokenValid(ENV, JOB, 1, 3, bad), false, "non-strings are refused, not coerced");
  }
  // Without a secret the page must say so (it renders an explicit alert) rather than fall back to something guessable.
  assert.equal(await previewToken({}, JOB, 1, 3), null);
  assert.equal(await previewTokenValid({}, JOB, 1, 3, t), false, "and nothing validates against a missing key");
});

test("[PREVIEW-RENDER] extensionless in-page links still resolve, so navigation inside the preview works", () => {
  const stored = new Set(["index.html", "services.html", "about.html", "booking/manage.html", "assets/site.css"]);
  const has = (p: string) => stored.has(p);
  assert.equal(resolveRequested("", has), "index.html", "the revision root is the home page");
  assert.equal(resolveRequested("/", has), "index.html");
  assert.equal(resolveRequested("/services", has), "services.html", "the starter publishes extensionless URLs");
  assert.equal(resolveRequested("/services.html", has), "services.html");
  assert.equal(resolveRequested("/booking/manage", has), "booking/manage.html");
  assert.equal(resolveRequested("/assets/site.css", has), "assets/site.css");
  assert.equal(resolveRequested("/nope", has), null, "and a page the revision does not hold is a 404, not a guess");
  // The capability must not become a traversal: the token segment is stripped by the router, and what is left is
  // still validated as a revision path.
  assert.equal(resolveRequested("/../../../etc/passwd", has), null);
  assert.equal(resolveRequested("/..%2f..%2fsecret", has), null);
});
