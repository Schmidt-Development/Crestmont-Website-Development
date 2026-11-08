#!/usr/bin/env node
// Measuring an imported, Founder-approved frontend. Runs INSIDE the per-job sandbox container (network none).
//
//   node /opt/crestmont/frontend-import.mjs --root dist [--out .crestmont/import] [--json]
//
// Produces four things, and judges none of them:
//
//   1. ROUTES - every page the site actually serves.
//   2. An INTERACTION INVENTORY - navigation, dropdowns, buttons, forms, inputs, links - split into the ones
//      that ALREADY WORK and the ones that need a backend. The split is made by evidence: a control is clicked
//      and the DOM is watched. A button that opens a menu on its own is not waiting for a backend; one that does
//      nothing is. Guessing from the label alone would mark every "Book now" as broken and every mobile menu
//      toggle as finished, which is backwards.
//   3. DESIGN SIGNATURES - the skeleton, palette, fonts, type scale and frame that `design-lock.ts` freezes.
//      Content is deliberately excluded: no text, and no absolute vertical positions.
//   4. BASELINE SCREENSHOTS at desktop, tablet and mobile, plus the interactive states that matter (an open
//      navigation, a focused form), because a design is not only its resting state.
//
// Separate from browser-check.mjs on purpose. That script is the legacy pipeline's pass/fail gate and is still
// serving live projects; this one measures and records. Sharing a file would put both at risk of the other's bugs.

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function args(argv) {
  const o = { root: "dist", out: ".crestmont/import", json: false, timeoutMs: 20000, maxPages: 40, maxProbes: 12, app: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") o.root = argv[++i];
    else if (argv[i] === "--out") o.out = argv[++i];
    else if (argv[i] === "--json") o.json = true;
    else if (argv[i] === "--timeout-ms") o.timeoutMs = Number(argv[++i]) || o.timeoutMs;
    else if (argv[i] === "--max-pages") o.maxPages = Number(argv[++i]) || o.maxPages;
    else if (argv[i] === "--max-probes") o.maxProbes = Number(argv[++i]) || o.maxProbes;
    else if (argv[i] === "--app") o.app = argv[++i];
    // An unknown flag is refused rather than ignored. The sandbox runs the copy baked into its IMAGE, so a runner
    // asking for something this build does not have means the image is stale -- and silently ignoring it is the
    // worst outcome: measured on 2026-11-07, --app was dropped without a word and the run reported a clean static
    // measurement, so a feature that had never executed looked as though it had.
    else if (argv[i].startsWith("--")) {
      console.error("frontend-import: unknown option " + argv[i] + " (this build of the instrument is older than the runner asking for it)");
      process.exit(2);
    }
  }
  return o;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".txt": "text/plain", ".xml": "application/xml", ".map": "application/json" };

function pages(root, dir = root, depth = 0) {
  const out = [];
  for (const e of readdirSync(dir).sort()) {
    const p = path.join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory() && depth < 3 && e !== "node_modules" && !e.startsWith(".")) out.push(...pages(root, p, depth + 1));
    else if (st.isFile() && e.endsWith(".html")) out.push(path.relative(root, p).split(path.sep).join("/"));
  }
  return out;
}

/**
 * Measure against the running APPLICATION rather than a static copy of the built site.
 *
 * Without this the instrument serves `dist` from its own file server, so there is no backend in the picture at all
 * -- at baseline or afterwards -- and a page behind authentication can only ever be captured as an anonymous
 * visitor sees it. Comparing that with an approved rendering that shows its content is comparing two different
 * views and calling the difference drift.
 *
 * The baseline capture has no application to start and is unaffected: it keeps the static server, which is what
 * the approved frontend is.
 */
async function startApp(spec, cwd) {
  const { spawn } = await import("node:child_process");
  const env = { ...process.env, PORT: String(spec.port), NODE_ENV: "test" };
  if (spec.seedFile) env.CRESTMONT_SEED = spec.seedFile;
  const child = spawn(spec.start[0], spec.start.slice(1), {
    cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const origin = "http://127.0.0.1:" + spec.port;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error("the application exited (" + child.exitCode + "): " + log.slice(-300));
    try { await fetch(origin + "/", { signal: AbortSignal.timeout(1500) }); break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (child.exitCode !== null) throw new Error("the application exited (" + child.exitCode + "): " + log.slice(-300));
  const stop = async () => {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      else process.kill(-child.pid, "SIGTERM");
    } catch { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
    for (let i = 0; i < 40 && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250));
  };
  return { origin, stop, log: () => log };
}

/** Normalise the text of the declared selectors, AFTER the signature has been measured and before the screenshot. */
const MASK = (selectors) => {
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) n.textContent = "—";
    }
  }
  return selectors.length;
};

function serve(root) {
  const base = path.resolve(root);
  const server = createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(base, "." + rel);
    if (!file.startsWith(base + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      // A single-page app routes in the browser: unknown extension-less paths fall back to index.html, as a real
      // static host would, so client-side routes are reachable.
      const spa = path.join(base, "index.html");
      if (!path.extname(rel) && existsSync(spa)) {
        res.writeHead(200, { "content-type": TYPES[".html"] });
        res.end(readFileSync(spa));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

const VIEWPORTS = [
  { name: "desktop", width: 1366, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
];

// One function, serialized into the browser. It returns the design signature and the interaction inventory for
// the page it runs on. Everything it reports is read from the rendered result, never from the source.
const MEASURE = () => {
  const vis = (e) => {
    if (!e || !e.getBoundingClientRect) return false;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(e);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.01;
  };

  // A class list with build-generated hashes removed. Vite, CSS Modules and styled-components all emit names
  // that change when the bundle is rebuilt; keeping them would make every rebuild look like a design change.
  const classShape = (e) => {
    const keep = [...e.classList]
      .filter((c) => c.length <= 40 && !/[0-9a-f]{6,}/i.test(c) && !/^(?:css|sc|jsx)-/.test(c) && !/_[A-Za-z0-9]{5,}$/.test(c))
      .sort()
      .slice(0, 3);
    return keep.length ? "." + keep.join(".") : "";
  };

  const norm = (c) => {
    if (!c) return null;
    const s = String(c).trim();
    if (!s || s === "transparent" || s === "none" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(s)) return null;
    return s;
  };

  const all = [...document.querySelectorAll("body *")].filter(vis).slice(0, 4000);

  const palette = new Map();
  const fonts = new Set();
  const sizes = new Set();
  for (const e of all) {
    const s = getComputedStyle(e);
    for (const c of [norm(s.color), norm(s.backgroundColor), norm(s.borderTopColor)]) {
      if (c) palette.set(c, (palette.get(c) ?? 0) + 1);
    }
    const fam = String(s.fontFamily || "").split(",")[0].replace(/["']/g, "").trim();
    if (fam) fonts.add(fam);
    const px = Math.round(parseFloat(s.fontSize) || 0);
    if (px > 0 && e.textContent && e.textContent.trim()) sizes.add(px);
  }
  // A colour painted on exactly one tiny element is noise; two occurrences is a design decision.
  const paletteList = [...palette.entries()].filter(([, n]) => n >= 2).map(([c]) => c).sort().slice(0, 48);

  const STRUCT = "header,nav,main,footer,section,article,aside,form,h1,h2,h3,ul,ol,table,figure";
  const skeleton = [...document.querySelectorAll(STRUCT)].filter(vis).slice(0, 120)
    .map((e) => e.tagName.toLowerCase() + classShape(e));

  const landmarkEls = [...document.querySelectorAll("header,nav,main,footer,body > section,main > section,body > div > section")].filter(vis).slice(0, 24);
  const seen = new Map();
  const landmarks = landmarkEls.map((e) => {
    const tag = e.tagName.toLowerCase();
    const n = (seen.get(tag) ?? 0) + 1;
    seen.set(tag, n);
    const r = e.getBoundingClientRect();
    return {
      sel: n === 1 ? tag : tag + ":nth(" + n + ")",
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });

  const label = (e) => (e.getAttribute("aria-label") || e.getAttribute("name") || e.getAttribute("placeholder") || (e.textContent || "").trim() || e.getAttribute("title") || "").replace(/\s+/g, " ").slice(0, 60);
  const ident = (e) => {
    const tag = e.tagName.toLowerCase();
    if (e.id) return tag + "#" + e.id;
    const nm = e.getAttribute("name");
    if (nm) return tag + "[name=" + nm + "]";
    const cs = classShape(e);
    if (cs) return tag + cs;
    const l = label(e);
    return l ? tag + "[" + l.slice(0, 24) + "]" : tag;
  };

  const items = [];
  const push = (e, role, extra) => items.push({ element: ident(e), role, label: label(e), ...extra });

  for (const f of [...document.querySelectorAll("form")].filter(vis)) {
    const fields = [...f.querySelectorAll("input:not([type=hidden]),select,textarea")];
    const action = f.getAttribute("action") || "";
    push(f, "form", {
      fields: fields.length,
      fieldNames: fields.map((i) => i.getAttribute("name") || i.getAttribute("id") || i.type).filter(Boolean).slice(0, 20),
      action,
      method: (f.getAttribute("method") || "get").toLowerCase(),
      // A form with fields has to reach a server to mean anything, unless it is a mail or phone handoff.
      needsBackend: fields.length > 0 && !/^(mailto:|tel:)/i.test(action),
      functional: false,
      evidence: fields.length === 0 ? "a form with no fields" : fields.length + " field(s), action \"" + (action || "(none)") + "\"",
    });
  }

  for (const i of [...document.querySelectorAll("input:not([type=hidden]),select,textarea")].filter(vis)) {
    const t = (i.getAttribute("type") || i.tagName.toLowerCase()).toLowerCase();
    push(i, "input", {
      inputType: t,
      inForm: !!i.closest("form"),
      required: i.hasAttribute("required"),
      // A standalone search, email, password or file field is a backend call waiting to happen.
      needsBackend: !i.closest("form") && ["search", "email", "password", "file"].includes(t),
      functional: false,
      evidence: "type " + t + (i.closest("form") ? ", inside a form" : ", standalone"),
    });
  }

  for (const a of [...document.querySelectorAll("a[href]")].filter(vis).slice(0, 200)) {
    const href = a.getAttribute("href") || "";
    const scheme = (/^(mailto:|tel:|https?:)/i.exec(href) || [])[1];
    const s = scheme ? scheme.toLowerCase() : "";
    push(a, "link", {
      href: href.slice(0, 200),
      external: s === "http:" || s === "https:",
      // A link already works: it is navigation, and the route list proves whether its target resolves.
      needsBackend: false,
      functional: true,
      evidence: s ? "a " + s.replace(":", "") + " link" : href.startsWith("#") ? "an in-page anchor" : "an in-site link",
    });
  }

  const buttons = [...document.querySelectorAll("button,[role=button],summary,[aria-expanded],[data-toggle],[aria-haspopup]")].filter(vis).slice(0, 60);
  for (const b of buttons) {
    const inForm = !!b.closest("form");
    const type = (b.getAttribute("type") || "").toLowerCase();
    const tag = b.tagName.toLowerCase();
    push(b, tag === "summary" ? "disclosure" : (b.hasAttribute("aria-expanded") || b.hasAttribute("aria-haspopup")) ? "dropdown" : "button", {
      inForm,
      submits: inForm && type !== "button",
      expandable: b.hasAttribute("aria-expanded") || tag === "summary" || b.hasAttribute("aria-haspopup"),
      needsBackend: false,          // decided after probing
      functional: false,
      evidence: "not yet probed",
    });
  }

  // The rest of the vocabulary §5 asks for. Each is identified from the markup's own semantics -- a role, an
  // input type, an autocomplete token -- not from the words on the control, because a button labelled "Book now"
  // may already work and one labelled "Learn more" may open a payment drawer.
  // WHAT COUNTS AS "NEEDS A BACKEND".
  //
  // Only where the markup itself shows an unfulfilled SERVER interaction: a form with fields, a file input, a
  // password field, a search box, a payment field. Those cannot mean anything without a server.
  //
  // Everything else is recorded with its kind and marked UNDETERMINED. A pricing table, a statistic, a date
  // picker and a tab strip may each be static content the Founder typed in, or a view onto live data -- and the
  // markup cannot tell which. Guessing "backend" put Summit Haul's static rate table on the integration plan as
  // work to invent, which is precisely what §5 forbids: "do not invent business policies, prices, payment
  // requirements or third-party integration details that the Founder or customer has not approved". An
  // undetermined element is a QUESTION for the contract, recorded explicitly, not a task.
  const seenEls = new Set(items.map((i) => i.element));
  const extra = (sel, kind, needsBackend, why, filter) => {
    for (const e of [...document.querySelectorAll(sel)].filter(vis).filter(filter || (() => true)).slice(0, 40)) {
      const id = ident(e);
      const already = items.find((i) => i.element === id);
      if (already) {
        // Already inventoried as a form, input or button; enrich it rather than listing it twice.
        already.kind = already.kind || kind;
        if (needsBackend && !already.functional) already.needsBackend = true;
        continue;
      }
      if (seenEls.has(id)) continue;
      seenEls.add(id);
      push(e, kind, {
        kind,
        needsBackend: needsBackend === true,
        undetermined: needsBackend === "undetermined",
        functional: false,
        evidence: needsBackend === "undetermined"
          ? why + ". Whether it shows live data or content the Founder typed in cannot be read from the markup: the contract decides, and it is recorded here as a question rather than assumed to be work."
          : why,
      });
    }
  };

  extra("dialog, [role=dialog], [role=alertdialog], [aria-modal=true]", "modal", false, "a modal or dialog");
  extra("[role=drawer], .drawer, [data-drawer], aside[aria-hidden]", "drawer", false, "a drawer or off-canvas panel");
  extra("input[type=date], input[type=datetime-local], input[type=time], [role=grid][aria-label*=calendar i], .calendar, .datepicker", "calendar", "undetermined",
    "a date or calendar control");
  extra("input[type=file]", "upload", true, "a file upload: the file has to go somewhere");
  extra("input[type=search], [role=searchbox], form[role=search]", "search", true, "a search control: results come from a server");
  extra("input[type=password]", "auth", true, "a password field: this is an authentication surface");
  extra("[autocomplete^='cc-'], [data-stripe], .StripeElement, #card-element, [name*=card i][name*=number i]", "payment", true,
    "a payment field. No payment provider is assumed: the contract must say which one and in which mode");
  extra("[role=tablist], [role=tabpanel]", "tabs", false, "a tabbed interface");
  extra("[role=table], table", "data-table", "undetermined", "a table of rows", (e) => e.querySelectorAll("tr").length > 2);
  extra("[role=menu], [role=menubar], [role=listbox], [role=combobox]", "menu", false, "a menu or listbox");
  extra("[role=switch], input[type=checkbox][role=switch], .toggle[role=button]", "toggle", "undetermined", "a toggle, which may or may not persist a preference");
  extra("progress, [role=progressbar], .stat, [data-metric]", "dashboard", "undetermined", "a figure or progress indicator");

  // External services the page already reaches for. Recorded, never assumed to be approved.
  const origin = location.origin;
  const external = new Set();
  for (const e of [...document.querySelectorAll("script[src], iframe[src], link[href][rel~=preconnect], link[href][rel~=dns-prefetch], img[src]")]) {
    const u = e.getAttribute("src") || e.getAttribute("href") || "";
    if (!/^https?:\/\//i.test(u)) continue;
    try {
      const h = new URL(u).origin;
      if (h !== origin) external.add(h);
    } catch { /* not a URL we can read */ }
  }

  const navs = [...document.querySelectorAll("nav")].filter(vis);

  return {
    externalOrigins: [...external].sort().slice(0, 30),
    signature: {
      skeleton,
      palette: paletteList,
      fonts: [...fonts].sort(),
      typeScale: [...sizes].sort((a, b) => a - b),
      landmarks,
      docHeight: Math.round(document.documentElement.scrollHeight),
    },
    items,
    facts: {
      title: (document.title || "").slice(0, 120),
      navs: navs.length,
      navLinks: navs.reduce((n, v) => n + v.querySelectorAll("a[href]").length, 0),
      stylesheets: document.styleSheets.length,
      images: document.querySelectorAll("img").length,
      headings: document.querySelectorAll("h1,h2,h3").length,
      overflowPx: document.documentElement.scrollWidth - window.innerWidth,
    },
  };
};

// Act on a control, then read what the page did about it.
//
// This is the evidence that separates "already functional" from "waiting for a backend". A mobile menu toggle
// flips aria-expanded and changes the DOM; a "Request a quote" button that posts nowhere does neither.
//
// IT IS DELIBERATELY TWO STEPS, with a wait between them. The first version snapshotted the page immediately
// after `el.click()` in the same evaluate, and reported Summit Haul's menu button as needing a backend. It does
// not: React 18 batches state updates and flushes them on a later task, so the "after" snapshot was taken before
// the component had re-rendered. Any framework with async rendering — React, Vue, Svelte — would have been
// mis-measured the same way, which would have put a working control on the integration plan.

const PROBE_ACT = (spec) => {
  const vis = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(e);
    return s.display !== "none" && s.visibility !== "hidden";
  };
  const find = () => {
    if (spec.kind === "select") {
      return [...document.querySelectorAll("select")].filter(vis).slice(0, 30)[spec.index];
    }
    return [...document.querySelectorAll("button,[role=button],summary,[aria-expanded],[data-toggle],[aria-haspopup]")].filter(vis).slice(0, 60)[spec.index];
  };
  const el = find();
  if (!el) return { probed: false, reason: "the control was not found on this render" };

  const snap = () => ({
    expanded: el.getAttribute("aria-expanded"),
    open: el.parentElement && el.parentElement.tagName.toLowerCase() === "details" ? el.parentElement.open : null,
    dom: document.body.innerHTML.length,
    count: document.querySelectorAll("body *").length,
    url: location.href,
    classes: el.className,
    value: "value" in el ? String(el.value) : null,
  });

  window.__cmProbe = { before: snap(), threw: null };

  try {
    if (spec.kind === "select") {
      // Pick a different, enabled option and tell the page about it the way a person would.
      const opts = [...el.options].filter((o) => !o.disabled);
      const next = opts.find((o) => o.value !== el.value);
      if (!next) return { probed: false, reason: "the dropdown has only one selectable option" };
      el.value = next.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.click();
    }
  } catch (e) {
    window.__cmProbe.threw = String(e && e.message).slice(0, 120);
  }
  return { probed: true };
};

const PROBE_READ = (spec) => {
  const vis = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(e);
    return s.display !== "none" && s.visibility !== "hidden";
  };
  const el = spec.kind === "select"
    ? [...document.querySelectorAll("select")].filter(vis).slice(0, 30)[spec.index]
    : [...document.querySelectorAll("button,[role=button],summary,[aria-expanded],[data-toggle],[aria-haspopup]")].filter(vis).slice(0, 60)[spec.index];
  const state = window.__cmProbe;
  if (!el || !state) return { probed: false, reason: "the control went away between acting and reading" };

  const after = {
    expanded: el.getAttribute("aria-expanded"),
    open: el.parentElement && el.parentElement.tagName.toLowerCase() === "details" ? el.parentElement.open : null,
    dom: document.body.innerHTML.length,
    count: document.querySelectorAll("body *").length,
    url: location.href,
    classes: el.className,
    value: "value" in el ? String(el.value) : null,
  };
  const before = state.before;

  const changes = [];
  if (before.expanded !== after.expanded) changes.push("aria-expanded " + before.expanded + " -> " + after.expanded);
  if (before.open !== after.open) changes.push("details open " + before.open + " -> " + after.open);
  if (before.count !== after.count) changes.push((after.count - before.count) + " element(s) added or removed");
  else if (Math.abs(after.dom - before.dom) > 8) changes.push("the markup changed");
  if (before.classes !== after.classes) changes.push("its own classes changed");
  if (before.url !== after.url) changes.push("navigated to " + after.url.slice(0, 80));

  return { probed: true, reacted: changes.length > 0, changes, threw: state.threw };
};

/** Act, let the framework render, then read. The wait is what makes the answer true. */
async function probe(page, spec, settleMs = 220) {
  const acted = await page.evaluate(PROBE_ACT, spec).catch((e) => ({ probed: false, reason: String(e.message).slice(0, 120) }));
  if (!acted.probed) return acted;
  await page.waitForTimeout(settleMs);
  return await page.evaluate(PROBE_READ, spec).catch((e) => ({ probed: false, reason: String(e.message).slice(0, 120) }));
}

const safeName = (s) => s.replace(/[^a-z0-9_-]/gi, "-");

async function main() {
  const o = args(process.argv.slice(2));
  if (!existsSync(o.root)) { console.error("frontend-import: " + o.root + " does not exist"); process.exit(2); }
  let chromium;
  try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch {
    console.error("frontend-import: the playwright package is not available (build image problem)"); process.exit(2);
  }

  const list = pages(o.root).slice(0, o.maxPages);
  if (!list.length) { console.error("frontend-import: no .html pages under " + o.root); process.exit(1); }
  mkdirSync(o.out, { recursive: true });
/**
 * Bring the page to rest before it is measured, so measuring the same bytes twice gives the same answer.
 *
 * `waitUntil: "load"` plus `document.fonts.ready` is not enough for a real website, and the Founder's law firm
 * document is the proof: four of its images carry `loading="lazy"`, and part of the page is generated by its own
 * JavaScript. A lazy image below the fold has not loaded when `load` fires, and whether it has by the time a
 * full-page screenshot scrolls past it depends on timing. So the same artifact measured to one of two stable
 * fingerprints -- 973c825990b3 or b2dd67f23666 -- differing by 12207px of layout, and the visual gate failed
 * against whichever one it had not got. A gate that cannot agree with itself can never be passed.
 *
 * This makes the resting state explicit rather than hoping for it:
 *   · every image is made eager and scrolled past, so nothing is waiting to be seen;
 *   · every image is awaited to completion, and decoded, so its intrinsic size is in the layout;
 *   · fonts are awaited, because a fallback face measures differently;
 *   · and the document height has to hold still across two samples, which is what catches JavaScript that is
 *     still adding to the page.
 *
 * It is deliberately bounded: a page that never settles is measured as it is after the budget rather than
 * hanging the build, and that is reported by the caller as the measurement it actually is.
 */
const SETTLE = `async () => {
  const imgs = Array.from(document.images || []);
  for (const im of imgs) {
    try { im.loading = "eager"; } catch (e) { /* read-only in old engines */ }
    try { im.decoding = "sync"; } catch (e) { /* optional */ }
  }
  // Walk the page so anything lazy is asked for, then come back: a full-page screenshot would do this later and
  // we want it done BEFORE the geometry is read.
  const h = () => document.documentElement.scrollHeight;
  for (let y = 0; y < h(); y += Math.max(200, window.innerHeight)) window.scrollTo(0, y);
  window.scrollTo(0, 0);

  await Promise.all(Array.from(document.images || []).map((im) => {
    if (im.complete) return im.decode ? im.decode().catch(() => {}) : null;
    return new Promise((res) => {
      const done = () => res();
      im.addEventListener("load", done, { once: true });
      im.addEventListener("error", done, { once: true });
    });
  }));
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* ignore */ } }

  // Height stability alone was not enough, and iteration 8 said why: four article.pcard elements present in one
  // measurement and absent in another, and a tablet-only section spacing shift. Those cards are built by the
  // page's own JavaScript on DOMContentLoaded and sized by requestAnimationFrame, so the document height can hold
  // still for two samples while the DOM is still being written. Waiting longer would be guessing; waiting for the
  // DOM to stop changing is the actual condition.
  //
  // So: no DOM mutations for a quiet window, then the height held across samples. Both bounded.
  await new Promise((resolve) => {
    let quiet;
    let mutations = 0;
    const obs = new MutationObserver(() => {
      mutations++;
      clearTimeout(quiet);
      quiet = setTimeout(finish, 400);
    });
    const finish = () => { try { obs.disconnect(); } catch (e) { /* already gone */ } resolve(mutations); };
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    quiet = setTimeout(finish, 400);
    // Never wait on a page that mutates for ever (a clock, a carousel, a polling widget).
    setTimeout(finish, 4000);
  });

  // The height has to stop moving. Two equal samples a frame apart, up to a bounded number of tries.
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const now = document.documentElement.scrollHeight;
    if (now === last) return { settled: true, height: now, images: (document.images || []).length };
    last = now;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { settled: false, height: last, images: (document.images || []).length };
}`;

/** Run SETTLE on a page, and never let a stubborn page fail the measurement outright. */
async function settle(p) {
  try { return await p.evaluate(SETTLE); } catch (e) { return { settled: false, height: 0, images: 0 }; }
}

  const shotDir = path.join(o.out, "screenshots");
  mkdirSync(shotDir, { recursive: true });

  // Either the approved frontend as shipped (a static server, which is what the baseline is) or the finished
  // application (so a page behind authentication can be captured as a signed-in person sees it).
  const spec = o.app ? JSON.parse(readFileSync(o.app, "utf8")) : null;
  const byPage = new Map((spec?.states ?? []).map((st) => [st.page, st]));
  let server = null, app = null, origin;
  if (spec) {
    app = await startApp(spec, process.cwd());
    origin = app.origin;
  } else {
    server = await serve(o.root);
    origin = "http://127.0.0.1:" + server.address().port;
  }
  const browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });

  const routes = [];
  const externalOrigins = new Set();
  const signatures = [];
  const renders = [];
  const inventory = [];
  const states = [];
  const problems = [];

  try {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      for (const rel of list) {
        const name = rel.replace(/\.html$/, "").replace(/\/index$/, "") || "index";
        const p = await context.newPage();
        const consoleErrors = [];
        p.on("pageerror", (e) => consoleErrors.push("page error: " + String(e.message).slice(0, 200)));
        p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });

        try {
          // A page the contract declared as needing a session is captured as a signed-in person sees it. The
          // anonymous rendering of the same page is captured below as its own state, so access control is still
          // checked -- separately, which is what it is.
          const want = byPage.get(name);
          if (want && spec?.login && spec.credentials?.[want.session]) {
            await context.request.post(origin + spec.login.path, { data: spec.credentials[want.session] }).catch(() => {});
          }

          await p.goto(origin + "/" + rel, { waitUntil: "load", timeout: o.timeoutMs });
          // Let fonts settle and any entry animation finish, so the baseline is the resting design.
          const rest = await settle(p);
          if (!rest.settled) console.error(JSON.stringify({ warn: "page did not come to rest before measuring", page: name, viewport: vp.name, height: rest.height }));
          await p.waitForTimeout(100);

          const m = await p.evaluate(MEASURE);

          // Masking happens AFTER the signature is measured, so palette, skeleton, fonts and type scale are read
          // from the page as it really rendered. Only the screenshot hash is affected, which is the only thing a
          // date or a row count can move.
          if (want?.mask?.length) await p.evaluate(MASK, want.mask).catch(() => {});

          const shot = path.join(shotDir, safeName(name) + "-" + vp.name + ".png");
          await p.screenshot({ path: shot, fullPage: true });
          renders.push({ page: name, viewport: vp.name, sha: sha256(readFileSync(shot)), file: path.relative(o.out, shot).split(path.sep).join("/") });

          signatures.push({ page: name, viewport: vp.name, ...m.signature });
          if (vp.name === "desktop") routes.push({ page: name, file: rel, externalOrigins: m.externalOrigins ?? [], ...m.facts });
          for (const o of m.externalOrigins ?? []) externalOrigins.add(o);

          // Probe clickable controls for client-side behaviour. Desktop and mobile only: a mobile menu toggle is
          // often the one control that behaves differently, and probing all three viewports triples the cost for
          // no new information.
          if (vp.name === "desktop" || vp.name === "mobile") {
            const clickables = m.items.filter((i) => ["button", "dropdown", "disclosure"].includes(i.role));
            const selects = m.items.filter((i) => i.role === "input" && i.inputType === "select");

            for (let i = 0; i < Math.min(clickables.length, o.maxProbes); i++) {
              const verdict = await probe(p, { kind: "button", index: i });
              const item = clickables[i];
              if (verdict.probed) {
                item.functional = !!verdict.reacted;
                item.needsBackend = !verdict.reacted && !item.submits;
                item.evidence = verdict.reacted
                  ? "clicking it changed the page on its own: " + verdict.changes.join("; ")
                  : item.submits ? "it submits its form, so it needs the form's backend"
                  : "clicking it changed nothing on the page, so it is waiting on a backend";
              } else {
                item.evidence = "could not be probed: " + (verdict.reason || "unknown");
              }
              // The page has been clicked; reload so the next probe starts from the resting state.
              await p.goto(origin + "/" + rel, { waitUntil: "load", timeout: o.timeoutMs });
              await settle(p);
              await p.waitForTimeout(80);
            }

            // A <select> is a dropdown too, and the directive asks for dropdowns. Changing its value is the
            // equivalent of clicking a button: if the page re-renders, the control already works.
            for (let i = 0; i < Math.min(selects.length, o.maxProbes); i++) {
              const verdict = await probe(p, { kind: "select", index: i });
              const item = selects[i];
              if (verdict.probed) {
                item.functional = !!verdict.reacted;
                item.needsBackend = !verdict.reacted && !item.inForm;
                item.evidence = verdict.reacted
                  ? "choosing a different option changed the page on its own: " + verdict.changes.join("; ")
                  : item.inForm ? "it is a field of a form, so it needs the form's backend"
                  : "changing it did nothing, so whatever it is meant to filter is not wired up";
              } else {
                item.evidence = "could not be probed: " + (verdict.reason || "unknown");
              }
              await p.goto(origin + "/" + rel, { waitUntil: "load", timeout: o.timeoutMs });
              await settle(p);
              await p.waitForTimeout(80);
            }

            // Interactive states worth a picture: an open navigation, and a form being filled in.
            const expandIdx = clickables.findIndex((x) => x.expandable);
            if (expandIdx >= 0) {
              await probe(p, { kind: "button", index: expandIdx });
              const f = path.join(shotDir, safeName(name) + "-" + vp.name + "-nav-open.png");
              await p.screenshot({ path: f, fullPage: false });
              states.push({ page: name, viewport: vp.name, state: "nav-open", sha: sha256(readFileSync(f)), file: path.relative(o.out, f).split(path.sep).join("/") });
              await p.goto(origin + "/" + rel, { waitUntil: "load", timeout: o.timeoutMs });
              await settle(p);
              await p.waitForTimeout(80);
            }

            if (m.items.some((i) => i.role === "form" && i.fields > 0)) {
              const focused = await p.evaluate(() => {
                const f = [...document.querySelectorAll("form")].find((x) => x.querySelectorAll("input:not([type=hidden]),textarea").length > 0);
                const first = f && f.querySelector("input:not([type=hidden]),textarea");
                if (!first) return false;
                first.focus();
                first.scrollIntoView({ block: "center" });
                return true;
              }).catch(() => false);
              if (focused) {
                await p.waitForTimeout(120);
                const f = path.join(shotDir, safeName(name) + "-" + vp.name + "-form-focus.png");
                await p.screenshot({ path: f, fullPage: false });
                states.push({ page: name, viewport: vp.name, state: "form-focus", sha: sha256(readFileSync(f)), file: path.relative(o.out, f).split(path.sep).join("/") });
              }
            }
          }


          for (const it of m.items) inventory.push({ page: name, viewport: vp.name, ...it });

          // The access-denied rendering of a session-gated page, captured in its own right rather than mistaken for
          // the page. "Never expose private data to satisfy a screenshot" cuts both ways: the signed-in capture is
          // the design comparison, and this is the proof that an anonymous visitor does not get it.
          if (byPage.has(name) && spec && vp.name === "desktop") {
            const anon = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
            try {
              const ap = await anon.newPage();
              await ap.goto(origin + "/" + rel, { waitUntil: "load", timeout: o.timeoutMs });
              await settle(ap);
              await ap.waitForTimeout(200);
              const f2 = path.join(shotDir, safeName(name) + "-" + vp.name + "-access-denied.png");
              await ap.screenshot({ path: f2, fullPage: false });
              states.push({ page: name, viewport: vp.name, state: "access-denied", sha: sha256(readFileSync(f2)), file: path.relative(o.out, f2).split(path.sep).join("/") });
            } catch (e) {
              problems.push(name + " at " + vp.name + ": the access-denied state could not be captured: " + String(e.message).slice(0, 120));
            } finally {
              await anon.close().catch(() => {});
            }
          }

          if (consoleErrors.length) problems.push(name + " @ " + vp.name + ": " + consoleErrors.slice(0, 3).join(" | "));
          if (m.facts.overflowPx > 1) problems.push(name + " @ " + vp.name + ": the page is " + m.facts.overflowPx + "px wider than the viewport");
        } catch (e) {
          problems.push(name + " @ " + vp.name + ": " + String(e.message).slice(0, 300));
        } finally {
          await p.close().catch(() => {});
        }
      }
      await context.close();
    }
  } finally {
    await browser.close().catch(() => {});
    if (server) server.close();
    if (app) await app.stop().catch(() => {});
  }

  // One inventory entry per page+element. A control measured at several viewports is one interaction; the
  // viewports it was seen at are kept, so a mobile-only control is still visible in the record.
  const merged = new Map();
  for (const it of inventory) {
    const k = it.page + "|" + it.element;
    const prev = merged.get(k);
    if (!prev) { merged.set(k, { ...it, viewports: [it.viewport] }); continue; }
    prev.viewports.push(it.viewport);
    // Functional anywhere is functional; "needs a backend" only when nothing made it react.
    prev.functional = prev.functional || it.functional;
    prev.needsBackend = prev.needsBackend && it.needsBackend;
    prev.undetermined = prev.undetermined || it.undetermined;
    if (it.functional && !/changed the page on its own/.test(prev.evidence || "")) prev.evidence = it.evidence;
  }
  const interactions = [...merged.values()].map((x) => { const { viewport, ...rest } = x; return rest; });

  const report = {
    schema: "crestmont.frontend-import/1",
    root: o.root,
    at: new Date().toISOString(),
    routes, signatures, renders, states, interactions, problems,
    // Third-party origins the approved frontend already reaches for. RECORDED, never assumed to be approved:
    // §5 is explicit that third-party integration details the Founder has not approved are not to be invented.
    externalOrigins: [...externalOrigins].sort(),
    summary: {
      routes: routes.length,
      viewports: VIEWPORTS.map((v) => v.name),
      signatures: signatures.length,
      screenshots: renders.length + states.length,
      interactions: interactions.length,
      needingBackend: interactions.filter((i) => i.needsBackend).length,
      alreadyFunctional: interactions.filter((i) => i.functional).length,
      // Recorded questions, not work: elements whose data source the contract has to settle.
      undetermined: interactions.filter((i) => i.undetermined).length,
      // One count per discovered kind, so a glance says whether this site has payments, uploads or a calendar.
      kinds: interactions.reduce((acc, i) => { const k = i.kind || i.role; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
      externalOrigins: externalOrigins.size,
    },
  };

  writeFileSync(path.join(o.out, "import.json"), JSON.stringify(report, null, 2) + "\n");
  if (o.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log("routes: " + report.summary.routes + "; signatures: " + report.summary.signatures + "; screenshots: " + report.summary.screenshots);
    console.log("interactions: " + report.summary.interactions + " (" + report.summary.alreadyFunctional + " already working, " + report.summary.needingBackend + " need a backend)");
    for (const p of report.problems.slice(0, 10)) console.log("problem: " + p);
  }
  // Problems are reported, not fatal: a console warning on one page is no reason to refuse an import a person has
  // already approved. A missing render IS fatal, because there would be no baseline.
  process.exit(renders.length === 0 ? 1 : 0);
}

main().catch((e) => { console.error("frontend-import: " + String((e && e.stack) || e).slice(0, 2000)); process.exit(2); });
