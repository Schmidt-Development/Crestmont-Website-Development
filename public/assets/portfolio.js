// Portfolio explorer (docs/frontend/PORTFOLIO.md). Progressive enhancement of the server-rendered list in
// src/ui/portfolio-explorer.ts. Rules this file keeps:
//  • arrows/selector switch PROJECTS only; nothing here intercepts wheel, touch or arrow keys;
//  • switching never moves focus or Crestmont's scroll position; inactive slides are inert;
//  • a demo iframe is created only for the active project once the explorer is near the viewport, and stays
//    mounted afterwards (its page and scroll position survive project switches); Reset reloads its start state;
//  • frames are shown only after the demo announces itself with an origin-checked postMessage; otherwise the
//    genuine poster stays and an honest status explains what happened;
//  • each demo renders at a real device width (desktop 1440, tablet 820, phone 390 CSS px) and the whole viewport is
//    scaled down to fit the frame — the full width is always visible and the site scrolls natively to its end. The
//    scale never exceeds 1, and the viewport height follows the frame, so nothing is cropped horizontally.
(() => {
  const roots = document.querySelectorAll("[data-pfx]");
  if (!roots.length) return;
  const reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  const READY_TIMEOUT = 20000;
  const DEVICES = { desktop: { w: 1440, pad: 0, label: "Desktop" }, tablet: { w: 820, pad: 14, label: "Tablet" }, mobile: { w: 390, pad: 14, label: "Phone" } };

  roots.forEach((root) => {
    const slides = [...root.querySelectorAll("[data-pfx-slide]")];
    const n = slides.length;
    const track = root.querySelector("[data-pfx-track]");
    const live = root.querySelector("[data-pfx-live]");
    const prev = root.querySelector("[data-pfx-prev]");
    const next = root.querySelector("[data-pfx-next]");
    const pages = [...root.querySelectorAll("[data-pfx-go]")];
    const expandBtn = root.querySelector("[data-pfx-expand]");
    const resetBtn = root.querySelector("[data-pfx-reset]");
    const modeBtns = [...root.querySelectorAll("[data-pfx-mode]")];
    const allowed = new Set(slides.map((s) => s.dataset.demoOrigin).filter(Boolean));
    const frames = new Map(); // slide index → { f, ready, timer }
    let cur = 0, near = false;

    // Fit: one measurement per explorer (every slide has the same frame), applied as CSS variables.
    const screen0 = slides[0] && slides[0].querySelector("[data-pfx-screen]");
    const fit = () => {
      if (!screen0) return;
      const d = DEVICES[root.dataset.mode] || DEVICES.desktop;
      const W = screen0.clientWidth, H = screen0.clientHeight;
      if (!W || !H) return;
      const s = Math.min(1, (W - 2 * d.pad) / d.w);
      const stW = Math.round(d.w * s), stH = Math.max(1, H - 2 * d.pad);
      root.style.setProperty("--pfx-s", s.toFixed(4));
      root.style.setProperty("--pfx-dw", d.w + "px");
      root.style.setProperty("--pfx-stw", stW + "px");
      root.style.setProperty("--pfx-sth", stH + "px");
      root.style.setProperty("--pfx-fh", Math.round(stH / s) + "px");
      root.style.setProperty("--pfx-pad", d.pad + "px");
      root.dataset.scale = s < 0.6 ? "small" : "ok";
    };
    // Default device follows the space available (a phone gets the phone layout, not a shrunken desktop).
    // The automatic device follows the VISITOR's screen, not the frame's width: a laptop visitor sees every website at
    // its desktop layout (scaled to fit), whichever page hosts the explorer. Picking by frame width put the narrower
    // homepage/portfolio frames into the tablet layout on 1000–1200px laptops while the wider case-study frame stayed
    // on desktop, which showed full-bleed sites (Glassly's cover-video hero) as a cropped portrait close-up.
    const autoMode = () => { const W = innerWidth; return W >= 1024 ? "desktop" : W >= 600 ? "tablet" : "mobile"; };
    const setMode = (m, announce) => {
      root.dataset.mode = m;
      modeBtns.forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.pfxMode === m)));
      fit();
      if (announce && live) live.textContent = `${DEVICES[m].label} viewport: the website is shown at ${DEVICES[m].w} pixels wide${Number(getComputedStyle(root).getPropertyValue("--pfx-s")) < 1 ? ", scaled to fit" : ""}.`;
    };
    let userMode = false;
    const name = (i) => slides[(i + n) % n].dataset.name;
    const status = (s, text, linkUrl) => {
      const el = s.querySelector("[data-pfx-status]");
      if (!el) return;
      el.textContent = text;
      if (linkUrl) {
        const a = document.createElement("a");
        a.href = linkUrl; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = " Open the demo in a new tab.";
        el.append(a);
      }
    };
    const urlLabel = (s, href) => { const el = s.querySelector("[data-pfx-url]"); if (el) el.textContent = href; };

    function mount(i) {
      const s = slides[i];
      const url = s.dataset.demoUrl;
      if (!url || frames.has(i)) return;
      const f = document.createElement("iframe");
      f.className = "pfx__frame";
      f.title = `Interactive demo of the ${s.dataset.name} website`;
      // The demo can run its own pages and forms, and open clearly external links in a new tab; it can never
      // navigate or script Crestmont (no allow-top-navigation; cross-origin), and gets no device permissions.
      f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
      f.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'");
      f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      const rec = { f, ready: false, timer: 0 };
      frames.set(i, rec);
      arm(i, rec, url);
      f.src = url;
      s.querySelector("[data-pfx-stage]").append(f);
    }
    function arm(i, rec, url) {
      const s = slides[i];
      rec.ready = false;
      s.classList.remove("is-ready");
      status(s, "Loading the interactive demo…");
      clearTimeout(rec.timer);
      rec.timer = setTimeout(() => {
        if (rec.ready) return;
        status(s, `The interactive ${s.dataset.name} demo did not respond, so the screenshot is shown instead.`, url);
        s.dataset.unavailable = "true";
      }, READY_TIMEOUT);
    }

    // Origin-checked handshake from the demo's embed script: {source:"crestmont-demo", type:"ready"|"navigate", href}.
    // A message is accepted only when ALL hold: its origin is an approved demo origin, it was sent by one of this
    // explorer's own frames (event.source), that frame's slide expects exactly this origin, and the payload is a plain
    // object of a known type with a same-origin, bounded href. Anything else is ignored without changing the UI.
    const MSG_TYPES = new Set(["ready", "navigate"]);
    const demoMessage = (e, types) => {
      const d = e.data;
      if (!allowed.has(e.origin) || !d || typeof d !== "object" || Array.isArray(d)) return null;
      if (d.source !== "crestmont-demo" || typeof d.type !== "string" || !types.has(d.type)) return null;
      if (d.href !== undefined && (typeof d.href !== "string" || d.href.length > 2048)) return null;
      for (const [i, rec] of frames) {
        if (!rec.f.contentWindow || rec.f.contentWindow !== e.source) continue;
        return slides[i].dataset.demoOrigin === e.origin ? { i, rec, d } : null;
      }
      return null; // not one of this explorer's frames (another window or frame, even of an approved origin)
    };
    window.addEventListener("message", (e) => {
      const m = demoMessage(e, MSG_TYPES);
      if (!m) return;
      const s = slides[m.i], rec = m.rec;
      if (!rec.ready) { rec.ready = true; clearTimeout(rec.timer); s.classList.add("is-ready"); delete s.dataset.unavailable; status(s, ""); }
      if (typeof m.d.href === "string") {
        try { const u = new URL(m.d.href); if (u.origin === e.origin) urlLabel(s, u.host + (u.pathname === "/" ? "" : u.pathname)); } catch { /* ignore */ }
      }
    });

    function go(i, announce = true) {
      cur = ((i % n) + n) % n;
      track.style.transform = `translateX(${-cur * 100}%)`;
      slides.forEach((s, j) => { const off = j !== cur; s.inert = off; if (off) s.setAttribute("aria-hidden", "true"); else s.removeAttribute("aria-hidden"); });
      pages.forEach((b, j) => (j === cur ? b.setAttribute("aria-current", "true") : b.removeAttribute("aria-current")));
      if (prev) prev.setAttribute("aria-label", `Previous project: ${name(cur - 1)}`);
      if (next) next.setAttribute("aria-label", `Next project: ${name(cur + 1)}`);
      if (announce && live) live.textContent = `Showing ${name(cur)}, project ${cur + 1} of ${n}.`;
      if (near) mount(cur);
    }

    prev && prev.addEventListener("click", () => go(cur - 1));
    next && next.addEventListener("click", () => go(cur + 1));
    pages.forEach((b) => b.addEventListener("click", () => go(Number(b.dataset.pfxGo))));
    modeBtns.forEach((b) => b.addEventListener("click", () => { userMode = true; setMode(b.dataset.pfxMode, true); }));
    resetBtn && resetBtn.addEventListener("click", () => {
      const s = slides[cur], rec = frames.get(cur);
      if (!s.dataset.demoUrl) { if (live) live.textContent = `${name(cur)} has no interactive demo to reset.`; return; }
      if (!rec) { mount(cur); return; }
      // Every demo serves /__demo/reset: clears its own demo cookies and returns to the start page.
      const resetUrl = new URL("/__demo/reset", s.dataset.demoUrl).toString();
      arm(cur, rec, s.dataset.demoUrl);
      rec.f.src = resetUrl;
      urlLabel(s, new URL(s.dataset.demoUrl).host);
      if (live) live.textContent = `${name(cur)} demo reset to its starting page.`;
    });
    // Expanding takes the explorer out of the flow; a spacer holds its place so the page never shortens (which would
    // clamp the scroll position), and the exact position is restored on close.
    // While expanded the explorer is a modal dialog (CREST-GAP-076): role=dialog + aria-modal, everything outside it is
    // inert (not focusable, hidden from assistive technology), focus starts on Close, Tab wraps inside the overlay, and
    // Escape closes it — also when a demo forwards the key ({source:"crestmont-demo", type:"key", key:"Escape"}),
    // since key presses inside a cross-origin frame never reach this page.
    let spacer = null, savedY = 0, inerted = [], savedAttrs = null;
    const inertOutside = (el) => {
      const out = [];
      for (let node = el; node && node.parentElement; node = node.parentElement) {
        for (const sib of node.parentElement.children) if (sib !== node && !sib.inert && sib.tagName !== "SCRIPT") { sib.inert = true; out.push(sib); }
        if (node.parentElement === document.body) break;
      }
      return out;
    };
    const setExpanded = (on) => {
      if (on === root.classList.contains("pfx--expanded")) return;
      if (on) {
        savedY = window.scrollY;
        spacer = document.createElement("div"); spacer.setAttribute("aria-hidden", "true"); spacer.style.height = root.offsetHeight + "px";
        root.before(spacer);
        savedAttrs = ["role", "aria-roledescription", "aria-label", "aria-modal"].map((a) => [a, root.getAttribute(a)]);
        root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.removeAttribute("aria-roledescription");
        root.setAttribute("aria-label", `Expanded view: ${name(cur)}`);
        inerted = inertOutside(root);
      } else {
        inerted.forEach((x) => { x.inert = false; }); inerted = [];
        if (savedAttrs) savedAttrs.forEach(([a, v]) => (v === null ? root.removeAttribute(a) : root.setAttribute(a, v)));
        savedAttrs = null;
      }
      root.classList.toggle("pfx--expanded", on);
      document.documentElement.classList.toggle("pfx-lock", on);
      if (!on) { spacer && spacer.remove(); spacer = null; window.scrollTo({ top: savedY, behavior: "instant" }); }
      if (expandBtn) { expandBtn.setAttribute("aria-pressed", String(on)); expandBtn.textContent = on ? "Close expanded view" : "Expand"; }
      // A larger frame: re-pick the device unless the visitor chose one, then refit.
      if (!userMode) setMode(autoMode(), false); else fit();
      if (on && live) live.textContent = `Expanded view of ${name(cur)}. Press Escape or Close expanded view to return.`;
      if (expandBtn) expandBtn.focus({ preventScroll: true });
    };
    const isOpen = () => root.classList.contains("pfx--expanded");
    expandBtn && expandBtn.addEventListener("click", () => setExpanded(!isOpen()));
    const focusables = () => [...root.querySelectorAll("a[href], button:not([disabled]), iframe, [tabindex]:not([tabindex='-1'])")]
      .filter((x) => !x.closest("[inert]") && !x.hidden && x.getClientRects().length);
    document.addEventListener("keydown", (e) => {
      if (!isOpen()) return;
      if (e.key === "Escape") { e.preventDefault(); setExpanded(false); return; }
      if (e.key !== "Tab") return;
      const f = focusables(); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    });
    // Escape pressed inside the demo (its embed forwards it): same checks as the handshake, including event.source.
    const KEY_TYPES = new Set(["key"]);
    window.addEventListener("message", (e) => {
      if (!isOpen()) return;
      const m = demoMessage(e, KEY_TYPES);
      if (m && m.d.key === "Escape") setExpanded(false);
    });

    if (reduce.matches) track.style.transition = "none";
    setMode(autoMode(), false);
    if ("ResizeObserver" in window && screen0) {
      new ResizeObserver(() => { const m = autoMode(); if (!userMode && m !== root.dataset.mode) setMode(m, false); else fit(); }).observe(screen0);
    } else window.addEventListener("resize", fit);
    go(0, false);
    // Lazy: create the active demo only when the explorer approaches the viewport.
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { near = true; mount(cur); io.disconnect(); } }, { rootMargin: "300px 0px" });
      io.observe(root);
    } else { near = true; mount(cur); }
  });
})();
