// In-page visual/accessibility rules shared by the local sweep (visual.e2e.ts) and the staging sweep
// (staging-quality.e2e.ts). Each function is serialised into the page by page.evaluate, so it must be self-contained.
/** Runs in the page: layout, landmark, naming, image and tap-target rules. */
export function pageRules({ mobile, width }: { mobile: boolean; width: number }) {
  // Every <nav> must be labelled; no exceptions remain.
  const KNOWN_UNLABELLED_NAV: string[] = [];
  const problems: string[] = [];
  const vis = (el: Element) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest("[hidden],dialog:not([open]),template,.hp,.visually-hidden,.skip"); };
  // Measured against the configured viewport width: mobile emulation widens the layout viewport (innerWidth)
  // to fit overflowing content, which hides exactly the bug this check looks for.
  const over = Math.max(document.documentElement.scrollWidth, window.innerWidth) - width;
  if (over > 0) {
    const culprits = [...document.querySelectorAll("body *")].filter((e) => vis(e) && e.getBoundingClientRect().right > width + 1 && !e.closest(".table-wrap,.kanban,.tabs,pre,.code-block"))
      .slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}`);
    problems.push(`horizontal overflow ${over}px (${culprits.join(", ")})`);
  }
  const mains = document.querySelectorAll("main");
  if (mains.length !== 1) problems.push(`${mains.length} <main> landmarks`);
  for (const n of document.querySelectorAll("nav")) if (!n.getAttribute("aria-label") && !n.getAttribute("aria-labelledby") && !KNOWN_UNLABELLED_NAV.includes(location.pathname)) problems.push(`unlabelled <nav class="${n.className}">`);
  if (document.querySelectorAll("h1").length !== 1) problems.push(`${document.querySelectorAll("h1").length} h1 elements`);
  for (const b of document.querySelectorAll("button, [role=button], a.btn")) {
    if (b.closest("template")) continue;
    const name = (b.getAttribute("aria-label") || (b as HTMLElement).innerText || b.textContent || "").trim();
    if (!name) problems.push(`button without accessible name: ${b.outerHTML.slice(0, 80)}`);
  }
  for (const el of document.querySelectorAll("input:not([type=hidden]), select, textarea")) {
    if (el.closest("template,.hp")) continue;
    const labelled = (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest("label") || el.getAttribute("aria-label");
    if (!labelled) problems.push(`unlabelled field ${(el as HTMLInputElement).name}`);
    for (const ref of (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)) if (!document.getElementById(ref)) problems.push(`aria-describedby → missing #${ref}`);
    if (el.getAttribute("aria-invalid") === "true" && !el.getAttribute("aria-describedby")) problems.push(`invalid field ${(el as HTMLInputElement).name} not linked to its error`);
  }
  for (const img of document.querySelectorAll("img")) {
    const i = img as HTMLImageElement;
    if (!i.hasAttribute("alt")) problems.push(`img without alt ${i.src}`);
    if (!vis(i) || !i.complete || !i.naturalWidth) continue;
    const r = i.getBoundingClientRect();
    if (r.width > i.naturalWidth + 0.5 || r.height > i.naturalHeight + 0.5) problems.push(`image upscaled ${i.getAttribute("src")}: ${i.naturalWidth}x${i.naturalHeight} shown ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  if (mobile) {
    const targets = document.querySelectorAll("button, .btn, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, .side-link, .tabs a, .nav a, .chip, .pagination a, label.checkbox, summary");
    for (const t of targets) {
      if (!vis(t) || t.closest("template,.hp")) continue;
      const r = t.getBoundingClientRect();
      if (r.height < 34 - 0.5) problems.push(`tap target ${Math.round(r.height)}px high: ${t.tagName.toLowerCase()}.${[...t.classList].join(".")} "${((t as HTMLElement).innerText || "").trim().slice(0, 30)}"`);
    }
  }
  return problems;
}

/** Runs in the page: WCAG contrast for every visible text run against its effective background. */
export function contrastRules() {
  const parse = (c: string) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const lum = (c: { r: number; g: number; b: number }) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const blend = (top: { r: number; g: number; b: number; a: number }, under: { r: number; g: number; b: number }) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a) });
  const bgOf = (el: Element | null): { r: number; g: number; b: number } => {
    const chain: Element[] = [];
    for (let e = el; e; e = e.parentElement) chain.push(e);
    let base = { r: 255, g: 255, b: 255 };
    for (const e of chain.reverse()) {
      const s = getComputedStyle(e);
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) base = blend(c, base);
    }
    return base;
  };
  const out: { text: string; ratio: number; need: number; sel: string }[] = [];
  const seen = new Set<Element>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !(n.textContent ?? "").trim()) continue;
    seen.add(el);
    if (el.closest("template,script,style,.hp,.visually-hidden,.skip,dialog:not([open]),[hidden],[aria-hidden=true],[disabled],[aria-disabled=true],option")) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || s.visibility === "hidden" || s.display === "none" || parseFloat(s.opacity) === 0) continue;
    const fg = parse(s.color); if (!fg) continue;
    const bg = bgOf(el);
    const size = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    const cr = ratio(blend(fg, bg), bg);
    if (cr < need - 0.01) out.push({ text: (n.textContent ?? "").trim().slice(0, 40), ratio: Math.round(cr * 100) / 100, need, sel: `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}` });
  }
  return out;
}
