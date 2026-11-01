// Gate B (frontend) checks, run by scripts/gates.mjs: offline HTML validation-lite, links, SEO, accessibility basics,
// responsive CSS, color contrast of the design tokens, real working forms (no placeholders), required widgets.
// HTML parsing helpers are the brochure starter's (approved, reviewed); the rules below are the full-stack profile.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const OPTIONAL_CLOSE = new Set(["p", "li", "dt", "dd", "option", "tr", "td", "th", "thead", "tbody", "tfoot"]);
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
// Generic AI/template leftovers the customer would see: bracketed fill-ins and unrendered template variables.
const TEMPLATE_TOKEN = /\[(?:your|insert|enter|add|company|business|client|placeholder)\b[^\]\n]{0,60}\]|\{\{[^}\n]{1,60}\}\}/i;
const PLACEHOLDER_IMAGES = /\b(?:via\.placeholder\.com|placeholder\.com|placehold\.(?:co|it)|picsum\.photos|dummyimage\.com|placekitten\.com|loremflickr\.com)\b/i;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

/** @param {string} s */
function attrs(s) {
  /** @type {Record<string,string>} */
  const out = {};
  const re = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

/**
 * Where a comment that starts at `start` (at "<!--") ends, the way browsers parse it: "<!-->" and "<!--->" close at
 * once, otherwise the first "-->" or "--!>"; an unterminated comment runs to the end of the document. A scanner, not
 * a regex, so content a browser renders can never be skipped as a "comment" by this checker.
 * @param {string} html @param {number} start
 */
function commentEnd(html, start) {
  const body = start + 4;
  if (html.startsWith(">", body)) return body + 1;
  if (html.startsWith("->", body)) return body + 2;
  const a = html.indexOf("-->", body), b = html.indexOf("--!>", body);
  const ends = [a < 0 ? Infinity : a + 3, b < 0 ? Infinity : b + 4];
  const e = Math.min(...ends);
  return e === Infinity ? html.length : e;
}

/** The document with every comment removed (browser comment rules; see commentEnd). @param {string} html */
function stripComments(html) {
  let out = "";
  let i = 0;
  for (;;) {
    const c = html.indexOf("<!--", i);
    if (c < 0) return out + html.slice(i);
    out += html.slice(i, c);
    i = commentEnd(html, c);
  }
}

/** Minimal tokenizer: returns tags (with attributes) and the text between them; script/style bodies are skipped. */
/** @param {string} html */
function tokenize(html) {
  const clean = stripComments(html);
  /** @type {{type:"open"|"close", name:string, attrs:Record<string,string>, selfClose:boolean, index:number}[]} */
  const tags = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = re.exec(clean))) {
    const name = m[2].toLowerCase();
    tags.push({ type: m[1] ? "close" : "open", name, attrs: m[1] ? {} : attrs(m[3]), selfClose: /\/\s*$/.test(m[3]), index: m.index });
    if (!m[1] && (name === "script" || name === "style")) {
      const end = clean.toLowerCase().indexOf(`</${name}`, re.lastIndex);
      if (end >= 0) re.lastIndex = end;
    }
  }
  return { clean, tags };
}

/**
 * Visible text of an HTML fragment (for matching only, never output). A scanner, not a regex: comments and
 * script/style elements are removed even when unterminated or closed as `</script >`; then every tag and any stray
 * angle bracket.
 * @param {string} html
 */
function textOf(html) {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    let end;
    if (lower.startsWith("<!--", lt)) {
      end = commentEnd(lower, lt);
    } else {
      const m = /^<(script|style)\b/.exec(lower.slice(lt, lt + 8));
      if (m) {
        const close = lower.indexOf(`</${m[1]}`, lt + 1);
        const gt = close < 0 ? -1 : lower.indexOf(">", close);
        end = gt < 0 ? html.length : gt + 1;
      } else {
        const gt = html.indexOf(">", lt + 1);
        end = gt < 0 ? html.length : gt + 1;
      }
    }
    out += " ";
    i = end;
  }
  return out.replace(/[<>]/g, " ").replace(/&[a-z]+;|&#\d+;/gi, " ").replace(/\s+/g, " ").trim();
}

/** Body of a parsed <script> element (to its closing tag, or the end of the document). */
function scriptBody(clean, tag) {
  const open = clean.indexOf(">", tag.index);
  const close = clean.toLowerCase().indexOf("</script", open + 1);
  return clean.slice(open + 1, close < 0 ? clean.length : close);
}

export { tokenize, textOf, attrs, walk, stripComments };

/** WCAG relative luminance contrast of two #rrggbb colors. */
export function contrast(a, b) {
  const lum = (hex) => {
    const n = hex.replace("#", "");
    const v = (n.length === 3 ? n.split("").map((c) => c + c).join("") : n).match(/../g).map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const API_FORMS = { "/api/contact": ["name", "email", "message"], "/api/quotes": ["name", "email", "details"] };

/**
 * @param {{ root: string, features: Record<string, boolean>, maxPages: number, seo: "basic"|"expanded"|"enhanced" }} o
 * @returns {{ errors: {file:string, message:string, area:string}[], warnings: {file:string, message:string, area:string}[], pages: string[] }}
 */
export function runFrontend(o) {
  const errors = [], warnings = [];
  const err = (area, file, message) => errors.push({ area, file, message });
  const warn = (area, file, message) => warnings.push({ area, file, message });
  const pub = path.join(o.root, "public");
  if (!existsSync(pub)) { err("frontend", "public/", "missing public/ directory"); return { errors, warnings, pages: [] }; }
  const files = walk(pub);
  const rel = (f) => path.relative(o.root, f).split(path.sep).join("/");
  const html = files.filter((f) => f.endsWith(".html"));
  const pages = html.filter((f) => !/(^|\/)404\.html$/.test(rel(f)) && !rel(f).startsWith("public/admin/") && !rel(f).startsWith("public/booking/"));
  if (pages.length > o.maxPages) err("requirements", "public/", `${pages.length} public pages exceed the package limit of ${o.maxPages}`);
  if (!existsSync(path.join(pub, "index.html"))) err("frontend", "public/index.html", "home page missing");
  for (const f of files.filter((x) => /\.(html|xml|txt|css|js|json)$/.test(x))) {
    const t = readFileSync(f, "utf8");
    if (t.includes("STARTER-PLACEHOLDER")) err("frontend", rel(f), "starter placeholder text remains (STARTER-PLACEHOLDER)");
    if (/lorem ipsum/i.test(t)) err("frontend", rel(f), "lorem ipsum filler text");
    if (PLACEHOLDER_IMAGES.test(t)) err("frontend", rel(f), "placeholder image service");
    if (f.endsWith(".html")) {
      const text = textOf(t);
      const token = TEMPLATE_TOKEN.exec(text);
      if (token) err("frontend", rel(f), `unfilled template text "${token[0].slice(0, 60)}"`);
      if (/\b(?:TODO|FIXME)\b/.test(text)) err("frontend", rel(f), "TODO/FIXME left in page text");
      // Judged on the parsed tags (browser comment rules, script bodies skipped), never on a stripped copy of the
      // text: no markup trick can hide an inline handler or script from this check.
      const parsed = tokenize(t);
      if (parsed.tags.some((g) => g.type === "open" && Object.keys(g.attrs).some((a) => /^on[a-z]/.test(a)))) err("security", rel(f), "inline event handler (on…=): not allowed by the Content-Security-Policy");
      if (parsed.tags.some((g) => g.type === "open" && g.name === "script" && !("src" in g.attrs) && !/application\/ld\+json/i.test(g.attrs.type ?? "") && scriptBody(parsed.clean, g).trim())) err("security", rel(f), "inline script: move it to a file (Content-Security-Policy script-src 'self')");
      if (/<script\b[^>]*\bsrc=["']https?:/i.test(t)) err("security", rel(f), "third-party script: not allowed by the Content-Security-Policy");
    }
  }
  const titles = new Map();
  const found = { contact: false, quotes: false, booking: false, manage: false };
  for (const f of html) {
    const file = rel(f);
    const src = readFileSync(f, "utf8");
    const { clean, tags } = tokenize(src);
    const opens = tags.filter((t) => t.type === "open");
    const find = (n) => opens.filter((t) => t.name === n);
    const isPage = pages.includes(f);
    if (!/^\s*<!doctype html>/i.test(src)) err("frontend", file, "missing <!doctype html>");
    if (!find("html")[0]?.attrs.lang) err("accessibility", file, "<html> needs a lang attribute");
    const metas = find("meta");
    if (!metas.some((m) => "charset" in m.attrs)) err("frontend", file, "missing <meta charset>");
    if (!/width\s*=\s*device-width/.test(metas.find((m) => m.attrs.name === "viewport")?.attrs.content ?? "")) err("responsive", file, "missing responsive viewport meta");
    const stack = [];
    for (const t of tags) {
      if (t.type === "open") { if (!VOID.has(t.name) && !t.selfClose) stack.push(t.name); continue; }
      while (stack.length && stack.at(-1) !== t.name && OPTIONAL_CLOSE.has(stack.at(-1))) stack.pop();
      if (stack.at(-1) === t.name) stack.pop(); else err("frontend", file, `unexpected </${t.name}>`);
    }
    if (stack.filter((n) => !OPTIONAL_CLOSE.has(n)).length) err("frontend", file, `unclosed element(s): ${stack.slice(-4).join(", ")}`);
    const ids = new Set();
    for (const t of opens) if (t.attrs.id) { if (ids.has(t.attrs.id)) err("frontend", file, `duplicate id "${t.attrs.id}"`); ids.add(t.attrs.id); }
    const title = textOf(/<title>([\s\S]*?)<\/title>/i.exec(clean)?.[1] ?? "");
    if (!title) err("seo", file, "missing <title>");
    else if (isPage) { if (titles.has(title)) err("seo", file, `duplicate title (also ${titles.get(title)})`); titles.set(title, file); if (title.length > 70) warn("seo", file, `title is ${title.length} characters`); }
    const desc = metas.find((m) => m.attrs.name === "description")?.attrs.content?.trim() ?? "";
    if (!desc) err("seo", file, "missing meta description");
    if (isPage && o.seo !== "basic") {
      if (!find("link").some((l) => (l.attrs.rel ?? "").split(/\s+/).includes("canonical"))) err("seo", file, "missing canonical link");
      if (!metas.some((m) => m.attrs.property === "og:title") || !metas.some((m) => m.attrs.property === "og:description")) err("seo", file, "missing Open Graph title/description");
    }
    if (rel(f) === "public/index.html" && o.seo !== "basic") {
      const ld = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i.exec(src);
      if (!ld) err("seo", file, "missing structured data (application/ld+json) on the home page");
      else { try { const j = JSON.parse(ld[1]); if (!j["@type"] || !j.name) err("seo", file, "structured data needs @type and name"); } catch { err("seo", file, "structured data is not valid JSON"); } }
    }
    if (find("h1").length !== 1) err("accessibility", file, `expected exactly one <h1>, found ${find("h1").length}`);
    if (!find("main").length) err("accessibility", file, "missing <main> landmark");
    let last = 0;
    for (const t of opens.filter((x) => /^h[1-6]$/.test(x.name))) { const l = Number(t.name[1]); if (last && l > last + 1) warn("accessibility", file, `heading level skips from h${last} to h${l}`); last = l; }
    for (const img of find("img")) {
      if (!("alt" in img.attrs)) err("accessibility", file, `<img src="${img.attrs.src ?? ""}"> has no alt attribute`);
      if (!img.attrs.width || !img.attrs.height) warn("performance", file, `<img src="${img.attrs.src ?? ""}"> has no width/height (layout shift)`);
      if (!/^(lazy|eager)$/.test(img.attrs.loading ?? "")) warn("performance", file, `<img src="${img.attrs.src ?? ""}"> has no loading attribute`);
    }
    const labelFor = new Set(find("label").map((l) => l.attrs.for).filter(Boolean));
    for (const c of opens.filter((t) => ["input", "select", "textarea"].includes(t.name))) {
      const type = (c.attrs.type ?? "text").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image"].includes(type) || (c.attrs.class ?? "").includes("hp-field")) continue;
      if (!(c.attrs.id && labelFor.has(c.attrs.id)) && !c.attrs["aria-label"] && !c.attrs["aria-labelledby"]) err("accessibility", file, `form control "${c.attrs.name ?? c.attrs.id ?? c.name}" has no label`);
    }
    const anchorRe = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = anchorRe.exec(clean))) {
      const a = attrs(am[1]);
      if (!textOf(am[2]) && !a["aria-label"] && !/<img\b[^>]*\balt\s*=\s*["'][^"']+["']/i.test(am[2])) err("accessibility", file, `link to "${a.href ?? ""}" has no accessible text`);
      if (a.href === "" || a.href === "#") err("frontend", file, "link with an empty or # href (a non-functional control)");
      if (a.target === "_blank" && !/noopener/.test(a.rel ?? "")) warn("security", file, `target=_blank link without rel="noopener"`);
    }
    // Forms: every form must submit to a real endpoint of this site (data-api) with the fields the endpoint needs.
    const formRe = /<form\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/form>/gi;
    let fm;
    while ((fm = formRe.exec(clean))) {
      const fa = attrs(fm[1]);
      const names = new Set([...fm[2].matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((x) => x[1]));
      const inBooking = /data-booking/.test(clean.slice(Math.max(0, fm.index - 3000), fm.index));
      if (fa.id === "login") continue; // admin sign-in (admin.js)
      if (inBooking) { if (!["name", "email"].every((n) => names.has(n))) err("frontend", file, "booking form needs name and email fields"); continue; }
      const target = fa["data-api"];
      if (!target) { err("frontend", file, `form ${fa.id ? `#${fa.id} ` : ""}does not post to a site endpoint (data-api="/api/…"): placeholder forms fail acceptance`); continue; }
      if (fa.action && fa.action !== target) err("frontend", file, "form action and data-api disagree");
      const need = API_FORMS[target];
      if (!need) { err("frontend", file, `form posts to ${target}, which is not an endpoint of this site`); continue; }
      const missing = need.filter((n) => !names.has(n));
      if (missing.length) err("frontend", file, `form for ${target} is missing field(s): ${missing.join(", ")}`);
      if (target === "/api/contact") found.contact = true;
      if (target === "/api/quotes") found.quotes = true;
    }
    if (/data-booking/.test(clean)) {
      found.booking = true;
      if (!/<select\b[^>]*name=["']serviceId["']/.test(clean) || !/<input\b[^>]*name=["']date["']/.test(clean) || !/class=["'][^"']*\bslots\b/.test(clean)) err("frontend", file, "booking widget needs a serviceId select, a date input and a .slots container");
    }
    if (/data-manage/.test(clean)) found.manage = true;
    if (isPage && !find("nav").length) err("frontend", file, "page has no navigation");
    if (isPage && !/src=["']\/assets\/app\.js["']/.test(clean)) err("frontend", file, "page does not load /assets/app.js (forms and navigation would not work)");
  }
  if (o.features.contact && !found.contact) err("requirements", "public/", "contact is enabled but no page has a contact form posting to /api/contact");
  if (o.features.quotes && !found.quotes) err("requirements", "public/", "quotes are enabled but no page has a quote form posting to /api/quotes");
  if (o.features.booking && !found.booking) err("requirements", "public/", "booking is enabled but no page has the booking widget (data-booking)");
  if (o.features.booking && !found.manage) err("requirements", "public/", "booking is enabled but public/booking/manage.html (data-manage) is missing");
  // Internal links and assets.
  for (const f of html) {
    for (const t of tokenize(readFileSync(f, "utf8")).tags) {
      if (t.type !== "open") continue;
      const ref = t.name === "a" || t.name === "link" ? t.attrs.href : ["img", "script", "source"].includes(t.name) ? t.attrs.src : undefined;
      if (!ref || EXTERNAL.test(ref) || ref.startsWith("#") || ref.startsWith("/api/")) continue;
      const clean = decodeURI(ref.split("#")[0].split("?")[0]);
      let target = clean.startsWith("/") ? path.join(pub, clean) : path.resolve(path.dirname(f), clean);
      if (!target.startsWith(pub)) { err("frontend", rel(f), `link "${ref}" points outside public/`); continue; }
      if (clean.endsWith("/") || (existsSync(target) && statSync(target).isDirectory())) target = path.join(target, "index.html");
      else if (!existsSync(target) && existsSync(target + ".html")) target += ".html";
      if (!existsSync(target)) err("frontend", rel(f), `broken internal reference "${ref}"`);
    }
  }
  if (!existsSync(path.join(pub, "robots.txt"))) err("seo", "public/robots.txt", "missing robots.txt");
  const sm = existsSync(path.join(pub, "sitemap.xml")) ? readFileSync(path.join(pub, "sitemap.xml"), "utf8") : null;
  if (!sm) err("seo", "public/sitemap.xml", "missing sitemap.xml");
  else for (const p of pages) { const r = path.relative(pub, p).split(path.sep).join("/"); const u = r === "index.html" ? "/" : "/" + r; if (!sm.includes(`${u}<`) && !sm.includes(`${u.replace(/\.html$/, "")}<`)) err("seo", "public/sitemap.xml", `sitemap does not list ${u}`); }
  const css = files.filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8")).join("\n");
  if (!/@media\b/.test(css)) err("responsive", "public/assets", "no responsive rules (@media) found");
  const token = (n) => new RegExp(`--${n}\\s*:\\s*(#[0-9a-fA-F]{3,6})\\b`).exec(css)?.[1];
  for (const [fg, bg] of [["color-text", "color-bg"], ["color-on-primary", "color-primary"], ["color-muted", "color-bg"], ["color-primary", "color-bg"]]) {
    const a = token(fg), b = token(bg);
    if (!a || !b) { err("accessibility", "public/assets/tokens.css", `design token --${fg} or --${bg} is missing (hex color required)`); continue; }
    const ratio = contrast(a, b);
    if (ratio < 4.5) err("accessibility", "public/assets/tokens.css", `contrast of --${fg} on --${bg} is ${ratio.toFixed(2)}:1 (WCAG AA needs 4.5:1)`);
  }
  for (const f of files) {
    const st = statSync(f);
    if (/\.(png|jpe?g|webp|avif|gif)$/i.test(f) && st.size > 500_000) err("performance", rel(f), `image is ${Math.round(st.size / 1024)} KB (limit 500 KB)`);
  }
  return { errors, warnings, pages: pages.map(rel) };
}
