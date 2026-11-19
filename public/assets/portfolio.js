// Portfolio explorer (docs/frontend/PORTFOLIO.md). Progressive enhancement of the server-rendered list in
// src/ui/portfolio-explorer.ts. Rules this file keeps:
//  • arrows/selector switch PROJECTS only; nothing here intercepts wheel, touch or arrow keys;
//  • switching never moves focus or Crestmont's scroll position; inactive slides are inert;
//  • a demo iframe is created only for the active project once the explorer is near the viewport, and stays
//    mounted afterwards (its page and scroll position survive project switches); Reset reloads its start state;
//  • a slide frames either the REAL live website (data-kind="live": its own headers permit this origin, checked by
//    the server) or an isolated demo (data-kind="embed"). A demo frame is shown only after the demo announces itself
//    with an origin-checked postMessage; a live site has no such script, so its frame is shown once it has loaded.
//    If neither happens in time, the genuine poster (or a styled card) stays with an honest status and the
//    Visit live website link;
//  • each demo renders at a real device width (desktop 1440, tablet 820, phone 390 CSS px) and the whole viewport is
//    scaled down to fit the frame — the full width is always visible and the site scrolls natively to its end. The
//    scale never exceeds 1, and the viewport height follows the frame, so nothing is cropped horizontally.
//  • every project follows one native-first standard: the REAL live website in a native frame (rendered by the
//    visitor's own browser — never streamed from a remote machine), or an honest notice with the live link;
//  • performance: only the active project's website is loaded; at most MAX_FRAMES websites stay mounted (the current one
//    and the last one visited, so going back is instant) and older ones are unloaded so they stop using the browser and
//    GPU; switching the device viewport only changes CSS sizes (never reloads a frame);
//  • visibility protocol: each framed website is told, with an exact-origin postMessage, whether it is the project being
//    looked at ({source:"crestmont-portfolio", type:"visibility", visible}) — when the visitor switches projects, the
//    explorer leaves the screen, or the page is hidden. Websites Crestmont builds pause their own animations on it
//    (runner/starters/*/public/assets/crestmont-visibility.js); other sites simply ignore it.
(() => {
  const roots = document.querySelectorAll("[data-pfx]");
  if (!roots.length) return;
  const reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  const READY_TIMEOUT = 20000;
  const MAX_FRAMES = 2;
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
    const allowed = new Set(slides.map((s) => s.dataset.demoOrigin).filter(Boolean)); // demo handshake origins only
    const frames = new Map(); // slide index → { f, ready, timer, used }
    let cur = 0, near = false, onScreen = true;

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
    const status = (s, text, linkUrl, linkText = " Open the demo in a new tab.") => {
      const el = s.querySelector("[data-pfx-status]");
      if (!el) return;
      el.textContent = text;
      if (linkUrl) {
        const a = document.createElement("a");
        a.href = linkUrl; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = linkText;
        el.append(a);
      }
    };
    const isLive = (s) => s.dataset.kind === "live";
    const urlLabel = (s, href) => { const el = s.querySelector("[data-pfx-url]"); if (el) el.textContent = href; };

    // Scroll isolation (app.css): the stage of a shown frame is a 1px scroll container that stops a gesture leaving
    // the frame; it must never stay scrolled, so any movement is undone at once.
    const isolate = (s) => {
      const st = s.querySelector("[data-pfx-stage]");
      if (!st || st.dataset.isolated) return;
      st.dataset.isolated = "1";
      st.addEventListener("scroll", () => { if (st.scrollTop || st.scrollLeft) { st.scrollTop = 0; st.scrollLeft = 0; } }, { passive: true });
    };
    const ready = (i, rec) => {
      const s = slides[i];
      isolate(s);
      if (rec.ready) return;
      rec.ready = true; clearTimeout(rec.timer); s.classList.add("is-ready"); delete s.dataset.unavailable; status(s, "");
    };
    function mount(i) {
      const s = slides[i];
      const url = s.dataset.frameUrl;
      if (!url || frames.has(i)) return;
      const f = document.createElement("iframe");
      f.className = "pfx__frame";
      f.title = isLive(s) ? `The live ${s.dataset.name} website (interactive)` : `Interactive demo of the ${s.dataset.name} website`;
      // The demo can run its own pages and forms, and open clearly external links in a new tab; it can never
      // navigate or script Crestmont (no allow-top-navigation; cross-origin), and gets no device permissions.
      f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
      f.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'");
      f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      const rec = { f, ready: false, timer: 0, used: Date.now() };
      frames.set(i, rec);
      f.addEventListener("load", () => signal(i));
      arm(i, rec, url);
      // A live site cannot announce itself; its first load (the server verified it permits this origin) shows it.
      if (isLive(s)) f.addEventListener("load", () => { if (f.src && f.src !== "about:blank") ready(i, rec); });
      f.src = url;
      s.querySelector("[data-pfx-stage]").append(f);
    }
    function arm(i, rec, url) {
      const s = slides[i];
      rec.ready = false;
      s.classList.remove("is-ready");
      status(s, isLive(s) ? `Loading the live ${s.dataset.name} website…` : "Loading the interactive demo…");
      clearTimeout(rec.timer);
      rec.timer = setTimeout(() => {
        if (rec.ready) return;
        if (isLive(s)) status(s, `The live ${s.dataset.name} website did not load here${s.querySelector("img.pfx__poster") ? ", so a screenshot is shown instead" : ""}.`, s.dataset.liveUrl, " Visit the live website in a new tab.");
        else status(s, `The interactive ${s.dataset.name} demo did not respond, so the screenshot is shown instead.`, url);
        s.dataset.unavailable = "true";
      }, READY_TIMEOUT);
    }

    // ── Visibility protocol and frame budget ──
    // Exact-origin postMessage: the browser delivers it only if the frame still shows that origin.
    const signal = (i) => {
      const rec = frames.get(i), s = slides[i];
      const origin = s && (s.dataset.frameOrigin || s.dataset.demoOrigin);
      if (!rec || !origin || !rec.f.contentWindow) return;
      try { rec.f.contentWindow.postMessage({ source: "crestmont-portfolio", type: "visibility", visible: i === cur && onScreen && !document.hidden }, origin); } catch { /* not ready */ }
    };
    const signalAll = () => { for (const j of frames.keys()) signal(j); };
    // Unload the least recently used frames beyond the budget: they stop running scripts, timers and WebGL entirely.
    const trim = () => {
      const extra = [...frames.entries()].filter(([j]) => j !== cur).sort((a, b) => a[1].used - b[1].used);
      while (frames.size > MAX_FRAMES && extra.length) {
        const [j, rec] = extra.shift();
        clearTimeout(rec.timer); rec.f.remove(); frames.delete(j);
        slides[j].classList.remove("is-ready"); delete slides[j].dataset.unavailable; status(slides[j], "");
      }
    };

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
      ready(m.i, rec);
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
      const rec = frames.get(cur); if (rec) rec.used = Date.now();
      trim();
      signalAll();
    }

    prev && prev.addEventListener("click", () => go(cur - 1));
    next && next.addEventListener("click", () => go(cur + 1));
    pages.forEach((b) => b.addEventListener("click", () => go(Number(b.dataset.pfxGo))));
    modeBtns.forEach((b) => b.addEventListener("click", () => { userMode = true; setMode(b.dataset.pfxMode, true); }));
    resetBtn && resetBtn.addEventListener("click", () => {
      const s = slides[cur], rec = frames.get(cur);
      if (!s.dataset.frameUrl) { if (live) live.textContent = `${name(cur)} is shown as a screenshot; there is nothing to reload.`; return; }
      if (!rec) { mount(cur); return; }
      if (isLive(s)) { // back to the live site's start page
        arm(cur, rec, s.dataset.frameUrl);
        rec.f.src = s.dataset.frameUrl;
        urlLabel(s, new URL(s.dataset.frameUrl).host);
        if (live) live.textContent = `${name(cur)} reloaded at its home page.`;
        return;
      }
      // Every demo serves /__demo/reset: clears its own demo cookies and returns to the start page.
      const resetUrl = new URL("/__demo/reset", s.dataset.demoUrl).toString();
      arm(cur, rec, s.dataset.demoUrl);
      rec.f.src = resetUrl;
      urlLabel(s, new URL(s.dataset.demoUrl).host);
      if (live) live.textContent = `${name(cur)} demo reset to its starting page.`;
    });
    // A hidden page: every framed website is told it is not being looked at (and again when the page returns).
    document.addEventListener("visibilitychange", signalAll);
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
      if (expandBtn) { expandBtn.setAttribute("aria-pressed", String(on)); expandBtn.textContent = on ? "Exit full screen" : "Full screen"; }
      // Real full screen where the browser offers it; the fixed overlay alone covers the window everywhere else.
      try {
        if (on && root.requestFullscreen && !document.fullscreenElement) root.requestFullscreen({ navigationUI: "hide" }).catch(() => undefined);
        else if (!on && document.fullscreenElement === root) document.exitFullscreen().catch(() => undefined);
      } catch { /* not available */ }
      // A larger frame: re-pick the device unless the visitor chose one, then refit.
      if (!userMode) setMode(autoMode(), false); else fit();
      if (on && live) live.textContent = `Expanded view of ${name(cur)}. Press Escape or Close expanded view to return.`;
      if (expandBtn) expandBtn.focus({ preventScroll: true });
    };
    const isOpen = () => root.classList.contains("pfx--expanded");
    expandBtn && expandBtn.addEventListener("click", () => setExpanded(!isOpen()));
    // Leaving browser full screen (Escape or the browser's own control) also closes the overlay.
    document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && isOpen()) setExpanded(false); });
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
    // The explorer leaving the screen: the framed websites are told, so Crestmont-built sites pause their animations.
    if ("IntersectionObserver" in window) new IntersectionObserver((es) => { onScreen = es.some((x) => x.isIntersecting); signalAll(); }, { threshold: 0 }).observe(root);
    // Lazy: create the active demo only when the explorer approaches the viewport.
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { near = true; mount(cur); io.disconnect(); } }, { rootMargin: "300px 0px" });
      io.observe(root);
    } else { near = true; mount(cur); }
  });
})();
