// Native-embedding standard built into every Crestmont starter (Owner, 2026-11-18): public pages may be shown in
// Crestmont's portfolio, every other page keeps refusing framing; the block is generated from the built pages and the
// gates refuse a conflicting rule. Also pins the copies to each other and to the platform's own definition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SENSITIVE_ROUTE } from "../../src/services/native/standard.ts";
import { editPagesHeaders, HEADERS_START, HEADERS_END } from "../../src/services/native/editors.ts";

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FULL = path.join(RUNNER, "starters", "fullstack-v1"), BRO = path.join(RUNNER, "starters", "brochure-v1");
const mod = (p: string) => import(p) as Promise<{ syncHeaders: (dir: string, o?: { write?: boolean }) => { ok: boolean; inSync: boolean; paths: string[]; problems: string[] }; SENSITIVE: RegExp; START: string; END: string; ALLOW: string; PORTFOLIO_ORIGINS: string[] }>;

test("[AIB-STD] the embedding module is identical in both starters and matches the platform's sensitive-route rule and block markers", async () => {
  const a = readFileSync(path.join(FULL, "scripts", "lib", "embedding.mjs"), "utf8"), b = readFileSync(path.join(BRO, "scripts", "embedding.mjs"), "utf8");
  assert.equal(a, b, "copy runner/starters/fullstack-v1/scripts/lib/embedding.mjs to brochure-v1/scripts/embedding.mjs");
  const m = await mod(path.join(FULL, "scripts", "lib", "embedding.mjs"));
  assert.equal(m.SENSITIVE.source, SENSITIVE_ROUTE.source, "one definition of sensitive routes");
  assert.equal(m.START, HEADERS_START);
  assert.equal(m.END, HEADERS_END);
  assert.deepEqual(m.PORTFOLIO_ORIGINS, ["https://crestmontwebsitedevelopment.com", "https://www.crestmontwebsitedevelopment.com"]);
});

test("[AIB-STD] the starters ship the standard: public pages framable by Crestmont only; admin, booking and error pages excluded; in sync", async () => {
  const m = await mod(path.join(FULL, "scripts", "lib", "embedding.mjs"));
  const full = m.syncHeaders(path.join(FULL, "public"));
  assert.deepEqual(full.problems, []);
  assert.ok(full.inSync, "fullstack-v1/public/_headers is current");
  assert.deepEqual(full.paths, ["/"], "only the homepage; /admin/ and /booking/* (token pages) are never listed");
  const bro = m.syncHeaders(path.join(BRO, "public"));
  assert.ok(bro.inSync && !bro.problems.length);
  assert.deepEqual(bro.paths, ["/", "/about", "/about.html", "/contact", "/contact.html", "/services", "/services.html"]);
  const h = readFileSync(path.join(FULL, "public", "_headers"), "utf8");
  assert.match(h, /^\/\*\n {2}X-Frame-Options: DENY$/m, "every page refuses by default");
  assert.match(h, /^\/\n {2}! X-Frame-Options\n {2}Content-Security-Policy: frame-ancestors https:\/\/crestmontwebsitedevelopment\.com https:\/\/www\.crestmontwebsitedevelopment\.com$/m);
  assert.doesNotMatch(h, /! Content-Security-Policy/, "the site's own CSP is never detached");
  assert.doesNotMatch(h, /frame-ancestors \*/);
});

test("[AIB-STD] a page added by a build is covered on the next gate run (idempotent); sensitive pages never; conflicting rules are refused", async () => {
  const m = await mod(path.join(BRO, "scripts", "embedding.mjs"));
  const dir = mkdtempSync(path.join(tmpdir(), "aib-std-"));
  cpSync(path.join(BRO, "public"), dir, { recursive: true });
  writeFileSync(path.join(dir, "gallery.html"), "<h1>Gallery</h1>");
  mkdirSync(path.join(dir, "login"), { recursive: true }); writeFileSync(path.join(dir, "login", "index.html"), "<h1>Sign in</h1>");
  mkdirSync(path.join(dir, "quote"), { recursive: true }); writeFileSync(path.join(dir, "quote", "index.html"), "<h1>Quote</h1>");
  const stale = m.syncHeaders(dir);
  assert.equal(stale.inSync, false);
  assert.ok(stale.paths.includes("/gallery") && !stale.paths.some((p) => /login|quote/.test(p)));
  const w = m.syncHeaders(dir, { write: true });
  assert.ok(w.ok);
  const once = readFileSync(path.join(dir, "_headers"), "utf8");
  m.syncHeaders(dir, { write: true });
  assert.equal(readFileSync(path.join(dir, "_headers"), "utf8"), once, "running it again changes nothing");
  assert.ok(m.syncHeaders(dir).inSync);
  // A site rule opening framing to others, or setting frame-ancestors on a public page, fails the gate.
  writeFileSync(path.join(dir, "_headers"), `/*\n  Content-Security-Policy: frame-ancestors *\n\n${once}`);
  assert.match(m.syncHeaders(dir).problems.join(), /opens framing outside Crestmont's block/);
  writeFileSync(path.join(dir, "_headers"), `/about\n  Content-Security-Policy: frame-ancestors 'none'\n\n${once}`);
  assert.match(m.syncHeaders(dir).problems.join(), /sets frame-ancestors on public page/);
  writeFileSync(path.join(dir, "_headers"), `/login/*\n  Content-Security-Policy: frame-ancestors 'none'\n\n${once}`);
  assert.deepEqual(m.syncHeaders(dir).problems, [], "a rule scoped to sensitive pages is fine");
  // The portfolio automation's Pages editor produces the same managed block format, so either tool keeps the other's.
  assert.ok(editPagesHeaders(once, ["/"], m.ALLOW).includes(HEADERS_START));
});

test("[AIB-STD] portfolio visibility protocol: one identical script in both starters, on every public page, accepting only Crestmont's exact origins from the framing window", async () => {
  const a = readFileSync(path.join(FULL, "public", "assets", "crestmont-visibility.js"), "utf8"), b = readFileSync(path.join(BRO, "public", "assets", "crestmont-visibility.js"), "utf8");
  assert.equal(a, b, "copy fullstack-v1/public/assets/crestmont-visibility.js to brochure-v1");
  const m = await mod(path.join(FULL, "scripts", "lib", "embedding.mjs"));
  for (const o of m.PORTFOLIO_ORIGINS) assert.ok(a.includes(`"${o}"`), `accepts ${o}`);
  assert.match(a, /e\.source !== window\.parent/, "only the window that frames the page");
  assert.match(a, /d\.source !== "crestmont-portfolio" \|\| d\.type !== "visibility" \|\| typeof d\.visible !== "boolean"/, "a strict message shape");
  assert.doesNotMatch(a, /postMessage|fetch\(|XMLHttpRequest|innerHTML|eval\(/, "it never sends anything back or injects content");
  for (const page of ["index.html", "about.html", "services.html", "contact.html"]) assert.match(readFileSync(path.join(BRO, "public", page), "utf8"), /<script src="\/assets\/crestmont-visibility\.js" defer><\/script>/, `brochure ${page}`);
  assert.match(readFileSync(path.join(FULL, "public", "index.html"), "utf8"), /<script src="\/assets\/crestmont-visibility\.js" defer><\/script>/, "fullstack index.html");
});
