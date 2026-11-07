// Finding what an uploaded design depends on, and pointing it at the local copies.
//
// The measurement container has no network. Until these assets are pinned, a site whose typography comes from a
// font CDN is measured in a fallback face and that becomes the approved design -- so what this file is really
// about is whether every dependency that changes the appearance is actually FOUND. One missed reference is one
// silently wrong baseline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classify, discoverRefs, pinExternalAssets, refsInCss, refsInHtml, rewriteReferences, visualImpact,
} from "../src/frontend/pin-assets.ts";
import type { ResolvedAsset } from "../src/frontend/pin-assets.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "ext-assets-"));
const urls = (refs: { url: string }[]) => refs.map((r) => r.url).sort();

test("[EA-01] every reference that changes the appearance is found, and nothing else is", () => {
  const html = `<!doctype html><html><head>
<link rel=preconnect href="https://fonts.gstatic.com">
<link rel=stylesheet href="https://fonts.googleapis.com/css2?family=Fraunces">
<link rel=stylesheet href="local.css">
<link rel=icon href="https://cdn.example.com/favicon.ico">
<link rel=preload as=font href="https://cdn.example.com/body.woff2" crossorigin>
<style>@font-face{font-family:R;src:url('https://cdn.example.com/inline.woff2')}
.hero{background-image:url(https://images.example.com/hero.jpg)}</style>
</head><body>
<img src="https://images.example.com/logo.png" alt=Logo>
<img src="/local/photo.png">
<img src="data:image/gif;base64,R0lGOD">
<img srcset="https://images.example.com/a.png 1x, https://images.example.com/b.png 2x" src="https://images.example.com/a.png">
<video poster="https://images.example.com/poster.jpg"></video>
<img src="//protocol.example.com/relative.png">
<script src="https://cdn.example.com/analytics.js"></script>
<a href="https://example.com/not-an-asset">A link is not a dependency</a>
</body></html>`;

  const refs = refsInHtml(html, "index.html");
  assert.deepEqual(urls(refs), [
    "https://cdn.example.com/body.woff2",
    "https://cdn.example.com/favicon.ico",
    "https://cdn.example.com/analytics.js",
    "https://cdn.example.com/inline.woff2",
    "https://fonts.googleapis.com/css2?family=Fraunces",
    "https://images.example.com/a.png",
    "https://images.example.com/b.png",
    "https://images.example.com/hero.jpg",
    "https://images.example.com/logo.png",
    "https://images.example.com/poster.jpg",
    "https://protocol.example.com/relative.png",
  ].sort(), JSON.stringify(urls(refs)));

  // A relative path is already inside the artifact; a data: URI carries its own bytes; a preconnect is a hint
  // about a dependency, not one; a hyperlink is not an asset at all.
  for (const notADependency of ["local.css", "/local/photo.png", "data:", "not-an-asset"]) {
    assert.ok(!refs.some((r) => r.url.includes(notADependency)), `${notADependency} must not be collected`);
  }

  // Each one is classified, because what a missing dependency DOES to the page depends on what it is.
  const kind = (u: string) => refs.find((r) => r.url.includes(u))!.kind;
  assert.equal(kind("css2?family"), "stylesheet");
  assert.equal(kind("body.woff2"), "font");
  assert.equal(kind("inline.woff2"), "font");
  assert.equal(kind("logo.png"), "image");
  assert.equal(kind("favicon.ico"), "image");
  assert.equal(kind("poster.jpg"), "image");
  assert.equal(kind("analytics.js"), "script");
  // A protocol-relative URL loads over https in a browser, so it is collected as https.
  assert.ok(refs.some((r) => r.url === "https://protocol.example.com/relative.png"));
});

test("[EA-02] a stylesheet's own references are found, including its @import", () => {
  const css = `@import url("https://fonts.googleapis.com/css2?family=Inter");
@import 'https://cdn.example.com/reset.css';
@font-face{font-family:Rowe;src:url(https://fonts.gstatic.com/s/a/b.woff2) format('woff2')}
.hero{background:#fff url( "https://images.example.com/grain.png" ) repeat}
.local{background:url(../img/local.png)}`;

  assert.deepEqual(urls(refsInCss(css, "styles.css")), [
    "https://cdn.example.com/reset.css",
    "https://fonts.googleapis.com/css2?family=Inter",
    "https://fonts.gstatic.com/s/a/b.woff2",
    "https://images.example.com/grain.png",
  ]);
  // An extensionless font-CDN stylesheet is still a stylesheet.
  assert.equal(classify("https://fonts.googleapis.com/css2?family=Inter"), "stylesheet");
  assert.equal(classify("https://fonts.gstatic.com/s/a/b.woff2"), "font");
});

test("[EA-03] a reference is rewritten exactly, and relative to the file that holds it", () => {
  // The document is not re-serialised: an owner's hand-written HTML has to come out of this byte-identical apart
  // from the URLs, because the next thing that happens is that it gets measured.
  const html = `<img src="https://images.example.com/logo.png" alt="Logo"><p>https://images.example.com/logo.png in text</p>`;
  const r1 = rewriteReferences(html, "index.html", [
    { url: "https://images.example.com/logo.png", raw: "https://images.example.com/logo.png", localPath: "_crestmont-assets/abc.png" },
  ]);
  assert.equal(r1.content, `<img src="_crestmont-assets/abc.png" alt="Logo"><p>_crestmont-assets/abc.png in text</p>`);
  assert.equal(r1.replaced, 1);

  // A stylesheet two levels down needs its own relative path, or the browser resolves it against the wrong base.
  const css = `@font-face{src:url(https://cdn.example.com/body.woff2)}`;
  const r2 = rewriteReferences(css, "assets/css/site.css", [
    { url: "https://cdn.example.com/body.woff2", raw: "https://cdn.example.com/body.woff2", localPath: "_crestmont-assets/def.woff2" },
  ]);
  assert.equal(r2.content, `@font-face{src:url(../../_crestmont-assets/def.woff2)}`);

  // A URL that is a prefix of another must not be rewritten inside it.
  const both = `<img src="https://x.example.com/a.png"><img src="https://x.example.com/a.png?v=2">`;
  const r3 = rewriteReferences(both, "index.html", [
    { url: "https://x.example.com/a.png", raw: "https://x.example.com/a.png", localPath: "_crestmont-assets/one.png" },
    { url: "https://x.example.com/a.png?v=2", raw: "https://x.example.com/a.png?v=2", localPath: "_crestmont-assets/two.png" },
  ]);
  assert.equal(r3.content, `<img src="_crestmont-assets/one.png"><img src="_crestmont-assets/two.png">`);
});

test("[EA-04] a missing dependency is described by what it does to the page", () => {
  assert.match(visualImpact("font", "https://fonts.gstatic.com/a.woff2"), /fallback font/);
  assert.match(visualImpact("font", "https://fonts.gstatic.com/a.woff2"), /fonts\.gstatic\.com/);
  assert.match(visualImpact("image", "https://img.example.com/hero.jpg"), /renders empty/);
  assert.match(visualImpact("stylesheet", "https://cdn.example.com/site.css"), /unstyled/);
  assert.match(visualImpact("script", "https://cdn.example.com/a.js"), /not part of the measured design/);
});

/** A resolver that pins whatever it is given, so the writing and rewriting can be tested without a platform. */
function pinner(script: Record<string, { kind?: string; type?: string; body?: string; refuse?: string }>) {
  const asked: string[][] = [];
  return {
    asked,
    resolve: (async (refs: readonly { url: string; kind: string }[]) => {
      asked.push(refs.map((r) => r.url));
      return refs.map((r): ResolvedAsset => {
        const s = script[r.url];
        if (!s || s.refuse) return { url: r.url, kind: r.kind as never, status: "refused", why: s?.refuse ?? "not in the script" };
        const sha = `${Buffer.from(r.url).toString("hex").slice(0, 32)}`.padEnd(32, "0");
        const ext = s.kind === "stylesheet" ? ".css" : s.kind === "font" ? ".woff2" : ".png";
        return {
          url: r.url, kind: (s.kind ?? r.kind) as never, status: "pinned", sha256: sha,
          bytes: (s.body ?? "x").length, contentType: s.type ?? "image/png",
          localPath: `_crestmont-assets/${sha}${ext}`,
          body: Buffer.from(s.body ?? "x").toString("base64"),
        };
      });
    }),
  };
}

test("[PIN-01] the assets are written in, the references are local, and a stylesheet's own fonts are pinned too", async () => {
  // The common real case, and the reason there are two rounds: the document names a Google Fonts stylesheet, and
  // THAT stylesheet names the woff2 files. Pinning only what the document names would store the stylesheet and
  // none of the fonts it exists to load, and the page would still render in a fallback face.
  const repo = tmp();
  writeFileSync(path.join(repo, "index.html"),
    `<!doctype html><link rel=stylesheet href="https://fonts.googleapis.com/css2?family=Rowe">`
    + `<img src="https://images.example.com/hero.png">`);

  const p = pinner({
    "https://fonts.googleapis.com/css2?family=Rowe": {
      kind: "stylesheet", type: "text/css",
      body: `@font-face{font-family:Rowe;src:url(https://fonts.gstatic.com/s/rowe.woff2) format('woff2')}`,
    },
    "https://fonts.gstatic.com/s/rowe.woff2": { kind: "font", type: "font/woff2", body: "woff2-bytes" },
    "https://images.example.com/hero.png": { kind: "image", type: "image/png", body: "png-bytes" },
  });

  const out = await pinExternalAssets({ repo, resolve: p.resolve });
  assert.equal(out.rounds, 2, "the second round is what finds the fonts the stylesheet needs");
  assert.equal(out.missing.length, 0, JSON.stringify(out.missing));
  assert.equal(out.assets.filter((a) => a.status === "pinned").length, 3, JSON.stringify(out.assets));
  assert.ok(p.asked[1]?.includes("https://fonts.gstatic.com/s/rowe.woff2"), `round two asked for the font: ${JSON.stringify(p.asked)}`);

  // The document now references local files only.
  const html = readFileSync(path.join(repo, "index.html"), "utf8");
  assert.ok(!html.includes("https://"), `no external reference is left: ${html}`);
  assert.match(html, /_crestmont-assets\//);
  assert.ok(out.rewritten.includes("index.html"));

  // And so does the pinned stylesheet, relative to its own location.
  const sheet = out.assets.find((a) => a.kind === "stylesheet")!;
  const css = readFileSync(path.join(repo, sheet.localPath!), "utf8");
  assert.ok(!css.includes("https://"), `the stylesheet's own font reference is local: ${css}`);
  assert.match(css, /url\(\.\.\/_crestmont-assets\/[0-9a-f]+\.woff2\)/, css);
});

test("[PIN-02] an unavailable asset is reported with its visual impact, and the import still measures", async () => {
  const repo = tmp();
  mkdirSync(path.join(repo, "css"), { recursive: true });
  writeFileSync(path.join(repo, "index.html"), `<link rel=stylesheet href="css/site.css"><img src="https://images.example.com/gone.png">`);
  writeFileSync(path.join(repo, "css", "site.css"), `@font-face{src:url(https://fonts.example.com/missing.woff2)}`);

  const p = pinner({
    "https://images.example.com/gone.png": { refuse: "the host answered 404" },
    "https://fonts.example.com/missing.woff2": { refuse: "the host answered 403: this asset is not publicly readable" },
  });
  const out = await pinExternalAssets({ repo, resolve: p.resolve });

  assert.equal(out.missing.length, 2, JSON.stringify(out.missing));
  const font = out.missing.find((m) => m.kind === "font")!;
  assert.match(font.why, /not publicly readable/);
  assert.match(font.impact, /fallback font/, "the owner is told what it does to the design, not just that it failed");
  assert.equal(font.referencedBy, "css/site.css", "and which file wanted it");
  const img = out.missing.find((m) => m.kind === "image")!;
  assert.match(img.impact, /renders empty/);

  // Nothing was rewritten, because nothing is local.
  assert.deepEqual(out.rewritten, []);
  assert.equal(readFileSync(path.join(repo, "index.html"), "utf8").includes("https://images.example.com/gone.png"), true);
});

test("[PIN-03] discovery reads every HTML and CSS file in the artifact, and skips what is not the site", async () => {
  const repo = tmp();
  mkdirSync(path.join(repo, "pages"), { recursive: true });
  mkdirSync(path.join(repo, "node_modules", "junk"), { recursive: true });
  mkdirSync(path.join(repo, "_crestmont-assets"), { recursive: true });
  writeFileSync(path.join(repo, "index.html"), `<img src="https://a.example.com/1.png">`);
  writeFileSync(path.join(repo, "pages", "about.html"), `<img src="https://a.example.com/2.png">`);
  writeFileSync(path.join(repo, "site.css"), `.x{background:url(https://a.example.com/3.png)}`);
  writeFileSync(path.join(repo, "node_modules", "junk", "dep.html"), `<img src="https://a.example.com/4.png">`);
  writeFileSync(path.join(repo, "_crestmont-assets", "already.css"), `.y{background:url(https://a.example.com/5.png)}`);

  assert.deepEqual(urls(discoverRefs(repo)), [
    "https://a.example.com/1.png",
    "https://a.example.com/2.png",
    "https://a.example.com/3.png",
  ], "a dependency's dependencies are not the site's, and an already-pinned file is not re-read");
});
