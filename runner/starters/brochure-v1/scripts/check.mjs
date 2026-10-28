#!/usr/bin/env node
// Offline acceptance check for the brochure starter (no network, no dependencies).
//   npm run check -- --package starter|business|premium [--allow-placeholders] [--root <dir>] [--json]
// Checks: HTML validation-lite (doctype, lang, charset, tag balance, duplicate ids), internal links/assets/anchors,
// SEO meta per package level, accessibility basics, responsive CSS, package page limit, contact form, leftovers
// (starter placeholders, lorem ipsum, bracketed/template fill-ins, TODO/FIXME, placeholder image services).
// Exit code 1 when any ERROR is found. WARNINGs are printed but do not fail the check.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = { package: "starter", allowPlaceholders: false, root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--package") opts.package = argv[++i] ?? "";
    else if (a === "--allow-placeholders") opts.allowPlaceholders = true;
    else if (a === "--root") opts.root = path.resolve(argv[++i] ?? ".");
    else if (a === "--json") opts.json = true;
  }
  return opts;
}

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

/** Minimal tokenizer: returns tags (with attributes) and the text between them; script/style bodies are skipped. */
/** @param {string} html */
function tokenize(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "");
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

/** @param {string} html */
function textOf(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;/gi, " ").replace(/\s+/g, " ").trim();
}

export function runCheck(opts) {
  /** @type {{level:"ERROR"|"WARN", file:string, message:string}[]} */
  const findings = [];
  const err = (file, message) => findings.push({ level: "ERROR", file, message });
  const warn = (file, message) => findings.push({ level: "WARN", file, message });
  const profiles = JSON.parse(readFileSync(path.join(here, "check-profiles.json"), "utf8"));
  const profile = profiles[opts.package];
  const pub = path.join(opts.root, "public");
  if (!profile) { err("(args)", `unknown package "${opts.package}"`); return findings; }
  if (!existsSync(pub)) { err("public/", "missing public/ directory"); return findings; }

  const files = walk(pub);
  const rel = (f) => path.relative(opts.root, f).split(path.sep).join("/");
  const htmlFiles = files.filter((f) => f.endsWith(".html"));
  const pages = htmlFiles.filter((f) => path.basename(f) !== "404.html");
  /** @type {Map<string, {ids:Set<string>}>} */
  const parsed = new Map();

  // Page limit.
  if (pages.length > profile.maxPages) err("public/", `${pages.length} pages exceed the ${opts.package} package limit of ${profile.maxPages}`);
  if (!pages.some((f) => rel(f) === "public/index.html")) err("public/index.html", "home page missing");

  // Leftovers in any text asset.
  for (const f of files.filter((x) => /\.(html|xml|txt|css|js|json|webmanifest)$/.test(x))) {
    const t = readFileSync(f, "utf8");
    if (!opts.allowPlaceholders && t.includes("STARTER-PLACEHOLDER")) err(rel(f), "starter placeholder text remains (STARTER-PLACEHOLDER)");
    if (/lorem ipsum/i.test(t)) err(rel(f), "lorem ipsum filler text");
    if (PLACEHOLDER_IMAGES.test(t)) err(rel(f), "placeholder image service (not licensed imagery, and unavailable offline)");
    if (f.endsWith(".html")) {
      const text = textOf(t.replace(/<!--[\s\S]*?-->/g, ""));
      const token = TEMPLATE_TOKEN.exec(text);
      if (token) err(rel(f), `unfilled template text "${token[0].slice(0, 60)}"`);
      if (/\b(?:TODO|FIXME)\b/.test(text)) err(rel(f), "TODO/FIXME left in page text");
    }
  }

  const titles = new Map();
  let contactFormFound = false;
  for (const f of htmlFiles) {
    const file = rel(f);
    const html = readFileSync(f, "utf8");
    const { clean, tags } = tokenize(html);
    const opens = tags.filter((t) => t.type === "open");
    const find = (name) => opens.filter((t) => t.name === name);
    const is404 = path.basename(f) === "404.html";

    if (!/^\s*<!doctype html>/i.test(html)) err(file, "missing <!doctype html>");
    const htmlTag = find("html")[0];
    if (!htmlTag || !htmlTag.attrs.lang) err(file, "<html> needs a lang attribute");
    const metas = find("meta");
    if (!metas.some((m) => "charset" in m.attrs)) err(file, "missing <meta charset>");
    const viewport = metas.find((m) => m.attrs.name === "viewport");
    if (!viewport || !/width\s*=\s*device-width/.test(viewport.attrs.content ?? "")) err(file, "missing responsive viewport meta (width=device-width)");

    // Tag balance.
    /** @type {string[]} */
    const stack = [];
    for (const t of tags) {
      if (t.type === "open") { if (!VOID.has(t.name) && !t.selfClose) stack.push(t.name); continue; }
      if (VOID.has(t.name)) { err(file, `closing tag for void element </${t.name}>`); continue; }
      while (stack.length && stack[stack.length - 1] !== t.name && OPTIONAL_CLOSE.has(stack[stack.length - 1])) stack.pop();
      if (stack[stack.length - 1] === t.name) stack.pop();
      else { err(file, `unexpected </${t.name}> (open: ${stack.slice(-3).join(" > ") || "none"})`); }
    }
    const unclosed = stack.filter((n) => !OPTIONAL_CLOSE.has(n));
    if (unclosed.length) err(file, `unclosed element(s): ${unclosed.slice(-5).join(", ")}`);

    // Ids.
    const ids = new Set();
    for (const t of opens) {
      if (!t.attrs.id) continue;
      if (ids.has(t.attrs.id)) err(file, `duplicate id "${t.attrs.id}"`);
      ids.add(t.attrs.id);
    }
    parsed.set(path.resolve(f), { ids });

    // SEO meta.
    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(clean);
    const title = titleMatch ? textOf(titleMatch[1]) : "";
    if (!title) err(file, "missing or empty <title>");
    else {
      if (title.length > 70) warn(file, `title is ${title.length} characters (aim for ≤ 70)`);
      if (!is404) { if (titles.has(title)) warn(file, `duplicate title also used by ${titles.get(title)}`); titles.set(title, file); }
    }
    const desc = metas.find((m) => m.attrs.name === "description")?.attrs.content?.trim() ?? "";
    if (!desc) err(file, "missing meta description");
    else if (desc.length < 50 || desc.length > 160) warn(file, `meta description is ${desc.length} characters (aim for 50–160)`);
    if (!is404 && profile.seo !== "basic") {
      if (!find("link").some((l) => (l.attrs.rel ?? "").split(/\s+/).includes("canonical") && l.attrs.href)) err(file, "missing canonical link");
      if (!metas.some((m) => m.attrs.property === "og:title")) err(file, "missing og:title");
      if (!metas.some((m) => m.attrs.property === "og:description")) err(file, "missing og:description");
    }
    if (profile.seo === "enhanced" && path.basename(f) === "index.html" && !find("script").some((s) => s.attrs.type === "application/ld+json")) {
      err(file, "missing structured data (application/ld+json) on the home page");
    }

    // Accessibility basics.
    const h1s = find("h1").length;
    if (h1s !== 1) err(file, `expected exactly one <h1>, found ${h1s}`);
    if (!find("main").length) err(file, "missing <main> landmark");
    let lastLevel = 0;
    for (const t of opens.filter((x) => /^h[1-6]$/.test(x.name))) {
      const level = Number(t.name[1]);
      if (lastLevel && level > lastLevel + 1) warn(file, `heading level skips from h${lastLevel} to h${level}`);
      lastLevel = level;
    }
    for (const img of find("img")) if (!("alt" in img.attrs)) err(file, `<img src="${img.attrs.src ?? ""}"> has no alt attribute`);
    const labelFor = new Set(find("label").map((l) => l.attrs.for).filter(Boolean));
    for (const c of opens.filter((t) => ["input", "select", "textarea"].includes(t.name))) {
      const type = (c.attrs.type ?? "text").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
      if (!(c.attrs.id && labelFor.has(c.attrs.id)) && !c.attrs["aria-label"] && !c.attrs["aria-labelledby"]) err(file, `form control "${c.attrs.name ?? c.attrs.id ?? c.name}" has no label`);
    }
    // Link text and target=_blank.
    const anchorRe = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = anchorRe.exec(clean))) {
      const a = attrs(am[1]);
      if (!textOf(am[2]) && !a["aria-label"] && !/<img\b[^>]*\balt\s*=\s*["'][^"']+["']/i.test(am[2])) err(file, `link to "${a.href ?? ""}" has no accessible text`);
      if (a.target === "_blank" && !/noopener/.test(a.rel ?? "")) warn(file, `target=_blank link to "${a.href ?? ""}" without rel="noopener"`);
      if (a.href === "" || a.href === "#") warn(file, "link with empty href");
    }

    // Contact form.
    const formRe = /<form\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/form>/gi;
    let fm;
    while ((fm = formRe.exec(clean))) {
      const fa = attrs(fm[1]);
      if (fa.action === "/api/contact") {
        const names = new Set([...fm[2].matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((x) => x[1]));
        if (["name", "email", "message"].every((n) => names.has(n))) contactFormFound = true;
        else err(file, "contact form must have name, email and message fields");
      }
    }
  }

  // Internal links, assets and anchors (after all pages are parsed).
  for (const f of htmlFiles) {
    const file = rel(f);
    const { tags } = tokenize(readFileSync(f, "utf8"));
    for (const t of tags) {
      if (t.type !== "open") continue;
      const ref = t.name === "a" || t.name === "link" ? t.attrs.href : ["img", "script", "source", "iframe"].includes(t.name) ? t.attrs.src : undefined;
      if (ref === undefined || ref === "" || EXTERNAL.test(ref)) continue;
      const [pathPart, hash] = ref.split("#");
      const cleanPath = decodeURI(pathPart.split("?")[0]);
      let target = cleanPath === "" ? path.resolve(f) : cleanPath.startsWith("/") ? path.join(pub, cleanPath) : path.resolve(path.dirname(f), cleanPath);
      if (!target.startsWith(pub)) { err(file, `link "${ref}" points outside public/`); continue; }
      if (cleanPath.endsWith("/") || (existsSync(target) && statSync(target).isDirectory())) target = path.join(target, "index.html");
      else if (!existsSync(target) && existsSync(target + ".html")) target = target + ".html";
      if (!existsSync(target)) { err(file, `broken internal reference "${ref}"`); continue; }
      if (hash && target.endsWith(".html")) {
        const info = parsed.get(path.resolve(target));
        if (info && !info.ids.has(hash)) err(file, `anchor "#${hash}" not found in ${rel(target)}`);
      }
    }
  }

  // Site-level SEO files.
  if (!existsSync(path.join(pub, "robots.txt"))) err("public/robots.txt", "missing robots.txt");
  const sitemapFile = path.join(pub, "sitemap.xml");
  if (!existsSync(sitemapFile)) err("public/sitemap.xml", "missing sitemap.xml");
  else {
    const sm = readFileSync(sitemapFile, "utf8");
    for (const p of pages) {
      const r = path.relative(pub, p).split(path.sep).join("/");
      const urlPath = r === "index.html" ? "/" : "/" + r;
      const alt = urlPath.replace(/\.html$/, "");
      if (!sm.includes(`${urlPath}<`) && !sm.includes(`${alt}<`) && !(r === "index.html" && /<loc>[^<]*\/<\/loc>/.test(sm))) {
        (profile.seo === "basic" ? warn : err)("public/sitemap.xml", `sitemap does not list ${urlPath}`);
      }
    }
  }

  // Responsive CSS.
  const css = files.filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8")).join("\n");
  if (!/@media\b/.test(css) && !/clamp\(/.test(css)) err("public/assets/css", "no responsive rules (@media or clamp()) found");

  if (profile.contactForm && !contactFormFound) err("public/", "no contact form posting to /api/contact with name, email and message fields");
  return findings;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const findings = runCheck(opts);
  const errors = findings.filter((f) => f.level === "ERROR");
  if (opts.json) process.stdout.write(JSON.stringify({ package: opts.package, errors: errors.length, findings }, null, 2) + "\n");
  else {
    for (const f of findings) process.stdout.write(`${f.level.padEnd(5)} ${f.file}: ${f.message}\n`);
    process.stdout.write(`\n${errors.length} error(s), ${findings.length - errors.length} warning(s) for package "${opts.package}".\n`);
  }
  process.exit(errors.length ? 1 : 0);
}
