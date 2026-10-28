// Progressive enhancement only: every feature works without JavaScript (the no-JS fallbacks live in nojs.css,
// loaded through <noscript>). Motion language: docs/frontend/DESIGN.md §6.
(() => {
  const root = document.documentElement;
  root.classList.add("js");
  const reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

  // ── Header: hairline appears once the page scrolls (passive, rAF-throttled) ──
  const header = document.querySelector("[data-site-header]");
  if (header) {
    let ticking = false;
    const update = () => { header.setAttribute("data-scrolled", String(window.scrollY > 8)); ticking = false; };
    window.addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  }

  // ── Menus: public navigation panel and the app sidebar (off-canvas below 960px) ──
  // Escape and outside clicks close; focus moves into the menu and returns to the toggle; links close it.
  const toggles = [...document.querySelectorAll("[data-toggle]")];
  const setOpen = (btn, open, { focus = true } = {}) => {
    const target = document.getElementById(btn.getAttribute("data-toggle"));
    if (!target) return;
    target.setAttribute("data-open", String(open));
    btn.setAttribute("aria-expanded", String(open));
    if (target.id === "site-nav") document.body.setAttribute("data-nav-open", String(open));
    if (open && focus) {
      const first = target.querySelector("a[aria-current='page']") || target.querySelector("nav a, a, button");
      if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
    } else if (!open && focus && target.contains(document.activeElement)) btn.focus();
  };
  toggles.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.getAttribute("data-toggle"));
      if (target) setOpen(btn, target.getAttribute("data-open") !== "true");
    });
  });
  const closeAll = (focus = true) => toggles.forEach((b) => { if (b.getAttribute("aria-expanded") === "true") setOpen(b, false, { focus }); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest("[data-close-nav]")) { closeAll(); return; }
    toggles.forEach((b) => {
      if (b.getAttribute("aria-expanded") !== "true") return;
      const t = document.getElementById(b.getAttribute("data-toggle"));
      if (t && !t.contains(e.target) && !b.contains(e.target)) setOpen(b, false, { focus: false });
      else if (t && e.target.closest("a") && t.contains(e.target)) setOpen(b, false, { focus: false });
    });
  });
  let lastWide = window.innerWidth > 1020;
  window.addEventListener("resize", () => { const wide = window.innerWidth > 1020; if (wide !== lastWide) { lastWide = wide; closeAll(false); } }, { passive: true });

  // ── Confirm dangerous actions (runs before the busy-state handler below) ──
  document.querySelectorAll("form[data-confirm]").forEach((f) => {
    f.addEventListener("submit", (e) => { if (!window.confirm(f.getAttribute("data-confirm"))) { e.preventDefault(); e.stopImmediatePropagation(); } });
  });

  // ── Prevent double submission; the pressed button shows a busy state ──
  // Forms that do not navigate (file downloads such as CSV exports) re-enable after a few seconds.
  document.querySelectorAll("form").forEach((f) => {
    f.addEventListener("submit", (e) => {
      if (e.defaultPrevented) return;
      const pressed = e.submitter instanceof HTMLButtonElement ? e.submitter : f.querySelector("button[type=submit]");
      setTimeout(() => {
        // Checked again here, after every submit handler has run: a submit cancelled later (for example by client-side
        // validation) must not leave the button disabled and busy.
        if (e.defaultPrevented) return;
        const buttons = f.querySelectorAll("button[type=submit]");
        buttons.forEach((b) => { b.setAttribute("aria-disabled", "true"); b.disabled = true; });
        // Buttons with their own sending state (contact form) keep their label visible instead of the generic spinner.
        if (pressed && pressed.classList.contains("btn") && !pressed.hasAttribute("data-cx-send") && f.method.toLowerCase() === "post") pressed.setAttribute("data-busy", "true");
        setTimeout(() => buttons.forEach((b) => { b.disabled = false; b.removeAttribute("aria-disabled"); b.removeAttribute("data-busy"); }), 8000);
      }, 0);
    });
  });
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    document.querySelectorAll("button[data-busy], button[aria-disabled='true']").forEach((b) => { b.disabled = false; b.removeAttribute("aria-disabled"); b.removeAttribute("data-busy"); });
  });

  // ── Toasts: dismiss button, auto-dismiss with an exit transition; paused while hovered or focused ──
  document.querySelectorAll(".toast").forEach((t) => {
    const close = document.createElement("button");
    close.type = "button"; close.className = "toast__close"; close.setAttribute("aria-label", "Dismiss notification"); close.textContent = "×";
    t.appendChild(close);
    let timer = 0;
    const leave = () => { t.setAttribute("data-leaving", "true"); setTimeout(() => t.remove(), reduceMotion.matches ? 0 : 300); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(leave, 7000); };
    close.addEventListener("click", leave);
    t.addEventListener("mouseenter", () => clearTimeout(timer)); t.addEventListener("mouseleave", arm);
    t.addEventListener("focusin", () => clearTimeout(timer)); t.addEventListener("focusout", arm);
    arm();
  });

  // ── Conditional form sections: <div data-show-when="fieldName=value1,value2"> ──
  const sync = () => {
    document.querySelectorAll("[data-show-when]").forEach((el) => {
      const [name, vals] = el.getAttribute("data-show-when").split("=");
      const allowed = vals.split(",");
      const inputs = document.querySelectorAll(`[name="${name}"]`);
      let match = false;
      inputs.forEach((i) => { if ((i.type === "checkbox" || i.type === "radio") ? i.checked && allowed.includes(i.value) : allowed.includes(i.value)) match = true; });
      el.hidden = !match;
    });
  };
  document.addEventListener("change", sync); sync();

  // ── Screenshot viewer (full screen) ──
  document.querySelectorAll("[data-viewer]").forEach((a) => {
    a.addEventListener("click", (e) => {
      const dlg = document.getElementById("viewer");
      if (!dlg || typeof dlg.showModal !== "function") return;
      e.preventDefault();
      dlg.querySelector("img").src = a.getAttribute("href");
      dlg.querySelector("img").alt = a.getAttribute("data-alt") || "";
      dlg.showModal();
    });
  });
  document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  document.querySelectorAll("dialog:not(.drawer)").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

  // ── Copy buttons for share URLs and other copyable values ──
  if (navigator.clipboard) {
    document.querySelectorAll(".share-url").forEach((el) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn btn--secondary btn--sm copy-btn"; b.textContent = "Copy link";
      b.style.marginTop = ".5rem";
      b.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(el.textContent.trim()); b.textContent = "Copied"; b.setAttribute("data-copied", "true"); }
        catch { b.textContent = "Select and copy the link"; }
        setTimeout(() => { b.textContent = "Copy link"; b.removeAttribute("data-copied"); }, 2400);
      });
      el.insertAdjacentElement("afterend", b);
    });
  }

  // ── File drop zones: highlight while a file is dragged over ──
  document.querySelectorAll(".dropzone").forEach((z) => {
    ["dragenter", "dragover"].forEach((t) => z.addEventListener(t, () => z.setAttribute("data-over", "true")));
    ["dragleave", "drop"].forEach((t) => z.addEventListener(t, () => z.removeAttribute("data-over")));
  });

  // ── Scrollable tab strips: mark which edge has hidden content; keep the current tab in view ──
  document.querySelectorAll(".tabs").forEach((t) => {
    const mark = () => {
      const max = t.scrollWidth - t.clientWidth;
      t.setAttribute("data-overflow", max <= 2 ? "none" : t.scrollLeft < 4 ? "end" : t.scrollLeft > max - 4 ? "start" : "both");
    };
    const cur = t.querySelector("[aria-current='page']");
    if (cur && t.scrollWidth > t.clientWidth) t.scrollLeft = Math.max(0, cur.offsetLeft - t.clientWidth / 3);
    t.addEventListener("scroll", mark, { passive: true }); window.addEventListener("resize", mark, { passive: true }); mark();
  });

  // ═════════════════════════════ Motion system (docs/frontend/MOTION.md) ═════════════════════════════
  // Separate channels: load sequences (M01/M02, CSS-led), viewport entry (one IntersectionObserver), scroll progress
  // (one passive rAF loop, only for sections near the viewport), hover/focus (M03) and clicks (M07, M09, M10).
  const RM = () => reduceMotion.matches;
  const rand = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // Split an element's text into word spans (.w) with --i indexes. Spaces stay text nodes, so selection, copy and
  // screen readers read the sentence normally. Only plain-text elements are split; anything with markup is left alone.
  const splitWords = (el) => {
    if (el.dataset.split || el.children.length) return [];
    const text = el.textContent;
    el.textContent = "";
    const out = [];
    text.split(/(\s+)/).forEach((part) => {
      if (!part) return;
      if (/^\s+$/.test(part)) { el.append(part); return; }
      const w = document.createElement("span");
      w.className = "w"; w.style.setProperty("--i", String(out.length)); w.textContent = part;
      el.append(w); out.push(w);
    });
    el.dataset.split = "1";
    return out;
  };

  // ── M01: opening tile reveal. Pure CSS timeline; the script only removes the finished overlay. ──
  const intro = document.querySelector("[data-intro]");
  if (intro) {
    const done = () => { intro.remove(); root.classList.remove("has-intro-running"); };
    if (RM()) done();
    else { intro.addEventListener("animationend", (e) => { if (e.target === intro) done(); }); setTimeout(done, 1500); }
  }

  // ── M02: hero headline resolves word by word, starting when the intro's tiles have cleared. ──
  // The CSS keeps the heading hidden until --intro-offset and then shows it whole (failsafe). If this script runs
  // before that moment, it splits the heading and lets each word resolve in sequence instead.
  document.querySelectorAll(".hero-title").forEach((h) => {
    if (RM() || !h.getAnimations) return;
    const hold = h.getAnimations().find((a) => a.animationName === "show-now");
    if (!hold) return;
    const delay = hold.effect && hold.effect.getTiming ? Number(hold.effect.getTiming().delay) || 0 : 0;
    const remaining = delay - (Number(hold.currentTime) || 0);
    if (remaining < 40) return;                       // too late: the heading is (about to be) visible as a whole
    const ws = splitWords(h);
    if (!ws.length) return;
    h.classList.add("hero-words");
    h.style.setProperty("--intro-offset", `${Math.round(remaining)}ms`);
    hold.finish();
  });

  // ── Viewport-entry reveals (M05, M08–M10): elements below the fold when the script starts are marked pending and
  // revealed when they enter. Elements already visible or above the viewport are never hidden (reload midway, fast
  // scroll). Groups give their [data-reveal] children a short stagger. ──
  document.querySelectorAll("[data-reveal-group]").forEach((g) => {
    let i = 0;
    g.querySelectorAll("[data-reveal]").forEach((el) => { if (!el.style.getPropertyValue("--rd")) el.style.setProperty("--rd", `${Math.min(i, 8) * 75}ms`); i++; });
  });
  const revealEls = [...document.querySelectorAll("[data-reveal]")];
  revealEls.forEach((el) => { if (el.classList.contains("reveal-words")) splitWords(el); });
  const vh = () => window.innerHeight || document.documentElement.clientHeight;
  let io = null;
  if (!RM() && "IntersectionObserver" in window) {
    io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { en.target.setAttribute("data-reveal", "in"); io.unobserve(en.target); } });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    revealEls.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top > vh() * 0.92) { el.setAttribute("data-reveal", "pending"); io.observe(el); }
    });
  }
  const sweepPassed = () => {                       // anything scrolled past while pending (fast scroll, jump links)
    document.querySelectorAll('[data-reveal="pending"]').forEach((el) => {
      if (el.getBoundingClientRect().bottom < 0) { el.setAttribute("data-reveal", "in"); if (io) io.unobserve(el); }
    });
  };

  // ── Tile engine (M03 buttons, M06 illustrations). Tiles only fade between two stable states, once, in a seeded
  // random order — never alternating, so there is no strobe. ──
  const shuffleDelays = (n, span, seed) => { const r = rand(seed); return Array.from({ length: n }, () => Math.round(r() * span)); };

  // M03 — build a button's tile layer lazily on first hover/focus. Each tile clips a full copy of the hover face
  // (gold background, dark label, swapped arrow square), so the label stays legible at every moment of the fill.
  const buildFx = (btn) => {
    const w = btn.offsetWidth, h = btn.offsetHeight;
    if (!w || !h) return;
    if (btn._fx && btn._fx.w === w && btn._fx.h === h) return;
    if (btn._fx) btn._fx.el.remove();
    const fx = document.createElement("span"); fx.className = "btn__fx"; fx.setAttribute("aria-hidden", "true");
    const cs = getComputedStyle(btn);
    const size = Math.max(14, Math.round(h / 2));
    const cols = Math.max(2, Math.ceil(w / size)), rows = Math.max(1, Math.round(h / size));
    const delays = shuffleDelays(cols * rows, 220, (w * 31 + h) | 7);
    const face = document.createElement("span"); face.className = "btn__face";
    face.style.cssText = `width:${w}px;height:${h}px;padding:${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft};gap:${cs.columnGap};justify-content:${cs.justifyContent};border-radius:${cs.borderRadius}`;
    [...btn.childNodes].forEach((n) => { if (!(n instanceof Element && n.classList.contains("btn__fx"))) face.append(n.cloneNode(true)); });
    face.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const t = document.createElement("span"); t.className = "btn__tile";
      const x = Math.round((c * w) / cols), y = Math.round((r * h) / rows), x2 = Math.round(((c + 1) * w) / cols), y2 = Math.round(((r + 1) * h) / rows);
      t.style.cssText = `left:${x + 1}px;top:${y + 1}px;width:${x2 - x}px;height:${y2 - y}px;--d:${delays[r * cols + c]}ms`;
      const f = face.cloneNode(true); f.style.left = `${-x - 1}px`; f.style.top = `${-y - 1}px`;
      t.append(f); fx.append(t);
    }
    btn.append(fx);
    btn._fx = { el: fx, w, h };
  };
  const FX_SEL = ".btn--primary, .btn--secondary";
  const armFx = (e) => {
    const btn = e.target instanceof Element ? e.target.closest(FX_SEL) : null;
    if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true" || btn.closest(".btn__face")) return;
    const fresh = !btn._fx || btn._fx.w !== btn.offsetWidth || btn._fx.h !== btn.offsetHeight;
    if (!fresh) return;
    // New tiles would otherwise appear directly in their hovered end state; hold them at zero for one frame so the
    // staggered fill actually plays on the first hover.
    btn.classList.add("btn--fx-arming");
    buildFx(btn);
    void btn.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => btn.classList.remove("btn--fx-arming")));
  };
  document.addEventListener("pointerover", armFx, { passive: true });
  document.addEventListener("focusin", armFx);

  // M06 — illustration tile transition: the outgoing image breaks into a grid that clears in random order while the
  // incoming image assembles tile by tile. The frame keeps its dimensions; an in-flight transition is completed
  // instantly before the next one starts, so number, text and image can never disagree.
  const preload = new Map();
  const loadImg = (src) => { if (!preload.has(src)) { const im = new Image(); im.decoding = "async"; im.src = src; preload.set(src, im.decode ? im.decode().catch(() => {}) : Promise.resolve()); } return preload.get(src); };
  const tileSwap = (frame, toSrc, { grid = 8, from = null } = {}) => {
    const img = frame.querySelector("img");
    if (frame._tile) frame._tile.finish();
    const fromSrc = from === null ? (img ? img.getAttribute("src") : null) : from;
    if (!img || fromSrc === toSrc && from === null) return;
    if (RM()) { img.src = toSrc; return; }
    const w = frame.clientWidth, h = frame.clientHeight;
    const layer = document.createElement("span"); layer.className = "tilefx"; layer.setAttribute("aria-hidden", "true");
    const outD = shuffleDelays(grid * grid, 150, 11), inD = shuffleDelays(grid * grid, 190, 29);
    const anims = [];
    const mk = (src, i, r, c) => {
      const t = document.createElement("i");
      const x = (c * w) / grid, y = (r * h) / grid;
      t.style.cssText = `left:${x}px;top:${y}px;width:${w / grid + 0.5}px;height:${h / grid + 0.5}px;background-image:url("${src}");background-size:${w}px ${h}px;background-position:${-x}px ${-y}px`;
      layer.append(t); return t;
    };
    for (let r = 0; r < grid; r++) for (let c = 0; c < grid; c++) {
      const i = r * grid + c;
      if (fromSrc) { const t = mk(fromSrc, i, r, c); anims.push(t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, delay: outD[i], fill: "forwards", easing: "linear" })); }
      const t2 = mk(toSrc, i, r, c); t2.style.opacity = "0";
      anims.push(t2.animate([{ opacity: 0, transform: "scale(.92)" }, { opacity: 1, transform: "none" }], { duration: 110, delay: 70 + inD[i], fill: "forwards", easing: "cubic-bezier(.2,.7,.2,1)" }));
    }
    img.style.visibility = "hidden";
    frame.append(layer);
    let finished = false;
    const finish = () => { if (finished) return; finished = true; anims.forEach((a) => a.cancel()); img.src = toSrc; img.style.visibility = ""; layer.remove(); frame._tile = null; };
    frame._tile = { finish };
    Promise.all(anims.map((a) => a.finished)).then(finish, finish);
  };

  // ── M07: roving tablist for "Anatomy of a build" (existing behaviour, kept). ──
  const tablist = (list, onSelect) => {
    const tabs = [...list.querySelectorAll("[role=tab]")];
    if (!tabs.length) return;
    const select = (i, focus) => {
      tabs.forEach((t, j) => { t.setAttribute("aria-selected", String(i === j)); t.tabIndex = i === j ? 0 : -1; });
      if (focus) tabs[i].focus();
      onSelect(i, tabs[i]);
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(i, false));
      t.addEventListener("keydown", (e) => {
        const k = e.key, n = tabs.length;
        const next = k === "ArrowDown" || k === "ArrowRight" ? (i + 1) % n : k === "ArrowUp" || k === "ArrowLeft" ? (i - 1 + n) % n : k === "Home" ? 0 : k === "End" ? n - 1 : -1;
        if (next >= 0) { e.preventDefault(); select(next, true); }
      });
    });
    select(Math.max(0, tabs.findIndex((t) => t.getAttribute("aria-selected") === "true")), false);
    return select;
  };
  document.querySelectorAll("[data-anatomy]").forEach((wrap) => {
    const mini = wrap.querySelector(".mini"), list = wrap.querySelector("[role=tablist]"), caption = wrap.querySelector("[data-anatomy-caption]");
    if (!mini || !list) return;
    list.querySelectorAll("li").forEach((li) => li.setAttribute("role", "presentation"));
    tablist(list, (i, tab) => { mini.setAttribute("data-layer", String(i + 1)); if (caption) caption.textContent = tab.querySelector(".anatomy__tab-title")?.textContent ?? ""; });
  });

  // ── Scroll-driven sequences: M04 statement stage and M06 process stages ──
  const wide = () => window.matchMedia("(min-width: 761px)").matches;
  const statements = [...document.querySelectorAll("[data-statement]")].map((sec) => {
    const text = sec.querySelector(".scroll-words"); const ws = text ? splitWords(text) : [];
    const labels = [...sec.querySelectorAll(".statement__label")];
    return { sec, ws, labels, thresholds: labels.map((_, i) => 0.30 + i * 0.12) };
  });
  const updateStatement = (s) => {
    const r = s.sec.getBoundingClientRect(), H = vh();
    if (r.bottom < -H || r.top > 2 * H) return;
    const enter = Math.min(1, Math.max(0, (H - r.top) / (H * 0.9)));          // 0 when the section top meets the fold
    const pinned = wide() && !RM();
    const p = pinned ? Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - H))) : enter;
    s.sec.style.setProperty("--p", p.toFixed(3));
    const nOn = Math.round(Math.min(1, Math.max(0, (enter - 0.25) / 0.6)) * s.ws.length);
    s.ws.forEach((w, i) => { if (i < nOn) w.setAttribute("data-on", ""); else w.removeAttribute("data-on"); });
    s.labels.forEach((l, i) => { const on = pinned ? p >= s.thresholds[i] : enter > 0.6; if (on) l.setAttribute("data-on", ""); else l.removeAttribute("data-on"); });
  };

  const stageSets = [...document.querySelectorAll("[data-stages]")].map((wrap) => {
    const stages = [...wrap.querySelectorAll(".stage")];
    const art = wrap.querySelector("[data-stage-art]"), numWrap = wrap.querySelector(".stages__num-wrap");
    stages.forEach((st) => loadImg(st.getAttribute("data-art")));
    wrap.classList.add("stages--live");
    return { wrap, stages, art, numWrap, current: 0 };
  });
  const setStage = (s, i) => {
    if (i === s.current) return;
    const dir = i > s.current ? 1 : -1;
    s.current = i;
    s.stages.forEach((st, j) => { if (j === i) st.setAttribute("data-current", ""); else st.removeAttribute("data-current"); });
    const label = `/${String(i + 1).padStart(2, "0")}`;
    if (s.numWrap) {
      const old = s.numWrap.querySelector(".stages__num");
      s.numWrap.querySelectorAll(".stages__num--in").forEach((n) => n.remove());
      if (RM() || !old.animate) old.textContent = label;
      else {
        const nu = document.createElement("span"); nu.className = "stages__num stages__num--in"; nu.textContent = label; s.numWrap.append(nu);
        old.animate([{ transform: "none", opacity: 1 }, { transform: `translateY(${-100 * dir}%)`, opacity: 0 }], { duration: 240, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" });
        nu.animate([{ transform: `translateY(${100 * dir}%)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 240, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" })
          .finished.then(() => { if (nu.isConnected) { old.getAnimations().forEach((a) => a.cancel()); old.textContent = label; nu.remove(); } }, () => {});
      }
    }
    if (s.art && wide()) { const src = s.stages[i].getAttribute("data-art"); loadImg(src).then(() => { if (s.current === i) tileSwap(s.art, src); }); }
  };
  const updateStages = (s) => {
    const r = s.wrap.getBoundingClientRect(), H = vh();
    if (r.bottom < -H || r.top > 2 * H) return;
    const line = H * 0.48;
    let idx = 0;
    s.stages.forEach((st, j) => { if (st.getBoundingClientRect().top <= line) idx = j; });
    setStage(s, idx);
  };
  // Mobile: each phase's own illustration assembles from tiles when it enters.
  if (io && !wide()) {
    const mio = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (!en.isIntersecting) return; mio.unobserve(en.target);
      const img = en.target.querySelector("img"); if (img) tileSwap(en.target, img.getAttribute("src"), { grid: 6, from: "" });
    }), { threshold: 0.35 });
    document.querySelectorAll(".stage__art-m").forEach((f) => { if (f.getBoundingClientRect().top > vh()) mio.observe(f); });
  }

  let scrollTick = false;
  const onScroll = () => {
    scrollTick = false;
    statements.forEach(updateStatement);
    stageSets.forEach(updateStages);
    sweepPassed();
  };
  const requestTick = () => { if (!scrollTick) { scrollTick = true; requestAnimationFrame(onScroll); } };
  if (statements.length || stageSets.length || revealEls.length) {
    window.addEventListener("scroll", requestTick, { passive: true });
    window.addEventListener("resize", requestTick, { passive: true });
    onScroll();
  }

  // ── M09: package type switch (both sets are real catalogue items). Without JS both sets are listed. ──
  document.querySelectorAll("[data-switch]").forEach((sw) => {
    const plansEl = sw.closest("section").querySelector("[data-plans]");
    const btns = [...sw.querySelectorAll("[data-switch-to]")], pill = sw.querySelector(".switch__pill");
    const sets = btns.map((b) => document.getElementById(b.getAttribute("data-switch-to")));
    if (!plansEl || sets.some((x) => !x)) return;
    sw.hidden = false; sw.setAttribute("role", "tablist"); sw.setAttribute("aria-label", "Plan type");
    plansEl.classList.add("plans--live");
    btns.forEach((b, i) => { b.id = b.id || `switch-${i}`; b.setAttribute("role", "tab"); b.setAttribute("aria-controls", sets[i].id); sets[i].setAttribute("role", "tabpanel"); sets[i].setAttribute("aria-labelledby", b.id); });
    const place = (i) => { const b = btns[i]; pill.style.width = `${b.offsetWidth}px`; pill.style.transform = `translateX(${b.offsetLeft - 4}px)`; };
    let cur = 0;
    const show = (i, animate) => {
      btns.forEach((b, j) => { b.setAttribute("aria-selected", String(i === j)); b.tabIndex = i === j ? 0 : -1; b.removeAttribute("data-settled"); });
      clearTimeout(sw._settle);
      if (animate && !RM()) { place(i); sw._settle = setTimeout(() => btns[i].setAttribute("data-settled", ""), 300); }
      else { sw.classList.add("switch--instant"); place(i); btns[i].setAttribute("data-settled", ""); void sw.offsetWidth; sw.classList.remove("switch--instant"); }
      const prev = sets[cur]; cur = i;
      sets.forEach((s, j) => { s.hidden = j !== i; });
      if (!animate || RM() || !prev || prev === sets[i]) return;
      sets[i].querySelectorAll(".package").forEach((card, k) => {
        card.animate([{ opacity: 0, transform: "translateY(18px)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: k * 70, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" });
        const price = card.querySelector(".price");
        if (price) price.animate([{ opacity: 0, transform: "translateY(60%)", filter: "blur(4px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], { duration: 300, delay: 80 + k * 70, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" });
      });
    };
    btns.forEach((b, i) => {
      b.addEventListener("click", () => show(i, true));
      b.addEventListener("keydown", (e) => { const n = e.key === "ArrowRight" ? (i + 1) % btns.length : e.key === "ArrowLeft" ? (i - 1 + btns.length) % btns.length : -1; if (n >= 0) { e.preventDefault(); show(n, true); btns[n].focus(); } });
    });
    show(0, false);
    window.addEventListener("resize", () => place(cur), { passive: true });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => place(cur));
  });

  // ── M10: FAQ disclosures with a real height transition; aria-expanded mirrors the open state. ──
  document.querySelectorAll("details.disclosure").forEach((d) => {
    const sum = d.querySelector("summary"), body = d.querySelector(".disclosure__body") || [...d.children].find((c) => c !== sum);
    if (!sum || !body) return;
    sum.setAttribute("aria-expanded", String(d.open));
    let anim = null;
    sum.addEventListener("click", (e) => {
      if (RM() || !body.animate) { setTimeout(() => sum.setAttribute("aria-expanded", String(d.open)), 0); return; }
      e.preventDefault();
      if (anim) anim.cancel();
      const opening = !d.open || d.dataset.closing === "true";
      if (opening) {
        delete d.dataset.closing; d.dataset.opening = "true"; d.open = true; sum.setAttribute("aria-expanded", "true");
        const h = body.scrollHeight;
        anim = body.animate([{ height: "0px", opacity: 0 }, { height: `${h}px`, opacity: 1 }], { duration: 280, easing: "cubic-bezier(.2,.7,.2,1)" });
        anim.onfinish = () => { anim = null; delete d.dataset.opening; };
      } else {
        d.dataset.closing = "true"; sum.setAttribute("aria-expanded", "false");
        const h = body.offsetHeight;
        anim = body.animate([{ height: `${h}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 240, easing: "cubic-bezier(.65,0,.35,1)" });
        anim.onfinish = () => { anim = null; d.open = false; delete d.dataset.closing; };
      }
    });
    d.addEventListener("toggle", () => { if (!d.dataset.closing) sum.setAttribute("aria-expanded", String(d.open)); });
  });

  // ───────────── UX workstream (BRAND-003..005) ─────────────
  // Drawer quick-view: links marked data-drawer="<url>" open that page's [data-drawer-body] in the
  // shared <dialog class="drawer">. The link's own href stays a normal page, so without JS (or if the
  // fetch fails) it simply navigates. Content is server-rendered and escaped; nodes are imported, scripts dropped.
  const drawer = document.getElementById("drawer");
  document.addEventListener("click", async (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[data-drawer]") : null;
    if (!a || !drawer || typeof drawer.showModal !== "function" || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const body = drawer.querySelector(".drawer__body");
    const title = drawer.querySelector(".drawer__title");
    const full = drawer.querySelector("[data-drawer-full]");
    full.setAttribute("href", a.getAttribute("href"));
    title.textContent = "Loading…";
    body.replaceChildren(document.getElementById("skeleton-tpl").content.cloneNode(true));
    drawer.showModal();
    try {
      const res = await fetch(a.getAttribute("data-drawer"), { credentials: "same-origin", headers: { accept: "text/html" } });
      if (!res.ok) throw new Error(String(res.status));
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const part = doc.querySelector("[data-drawer-body]");
      if (!part) throw new Error("no drawer body");
      part.querySelectorAll("script").forEach((s) => s.remove());
      title.textContent = part.getAttribute("data-drawer-title") || title.textContent;
      body.replaceChildren(...[...part.childNodes].map((n) => document.importNode(n, true)));
    } catch {
      window.location.assign(a.getAttribute("href"));
    }
  });
  if (drawer) drawer.addEventListener("click", (e) => { if (e.target === drawer) drawer.close(); }); // backdrop click

  // Skeleton loaders: navigating to a slow, fully server-rendered page shows placeholders while it computes.
  const main = document.querySelector("[data-slow-target]");
  const tpl = document.getElementById("skeleton-tpl");
  let slowTimer = 0;
  const showSkeleton = () => {
    if (!main || !tpl || main.classList.contains("is-loading")) return;
    slowTimer = window.setTimeout(() => {
      main.classList.add("is-loading");
      main.prepend(tpl.content.cloneNode(true));
    }, 120);
  };
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[data-slow]") : null;
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) showSkeleton();
  });
  document.querySelectorAll("form[data-slow]").forEach((f) => f.addEventListener("submit", showSkeleton));
  window.addEventListener("pageshow", () => {
    window.clearTimeout(slowTimer);
    if (main) { main.classList.remove("is-loading"); main.querySelectorAll(":scope > .loading-state").forEach((n) => n.remove()); }
  });

  // Rich text: toolbar + live preview for [data-richtext] fields. The preview is built with DOM nodes and
  // textContent only (never innerHTML) and mirrors the server renderer in src/ui/markdown.ts.
  const SAFE = /^(https?:\/\/[^\s"'<>`]+|mailto:[^\s"'<>`/]+@[^\s"'<>`]+)$/i;
  const INLINE = /\[([^\]\n]{1,300})\]\(([^)\s]{1,500})\)|\*\*(?=\S)([\s\S]*?\S)\*\*|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<![A-Za-z0-9])_(?=[^\s_])([^_\n]*?[^\s_])_(?![A-Za-z0-9])/;
  const inline = (parent, text, links = true, depth = 0) => {
    let rest = text;
    while (rest) {
      const m = depth > 6 ? null : INLINE.exec(rest);
      if (!m) { parent.append(rest); break; }
      parent.append(rest.slice(0, m.index));
      const [whole, lt, lu, bold, star, under] = m;
      if (lt !== undefined) {
        if (links && SAFE.test(lu.trim()) && lu.length <= 500) {
          const a = document.createElement("a"); a.href = lu.trim(); if (/^https?:/i.test(lu)) a.rel = "noopener noreferrer";
          inline(a, lt, false, depth + 1); parent.append(a);
        } else inline(parent, lt, false, depth + 1);
      } else {
        const el = document.createElement(bold !== undefined ? "strong" : "em");
        inline(el, bold ?? star ?? under, links, depth + 1); parent.append(el);
      }
      rest = rest.slice(m.index + whole.length);
    }
  };
  const render = (src, out) => {
    out.replaceChildren();
    for (const block of src.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
      const lines = block.split("\n").filter((l) => l.trim());
      let para = [], list = null;
      const flushP = () => { if (para.length) { const p = document.createElement("p"); inline(p, para.join(" ").replace(/\s+/g, " ").trim()); out.append(p); } para = []; };
      const flushL = () => { if (list) { const el = document.createElement(list.kind); list.items.forEach((i) => { const li = document.createElement("li"); inline(li, i); el.append(li); }); out.append(el); } list = null; };
      for (const line of lines) {
        const h = /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line), b = /^\s{0,3}[-*]\s+(.*)$/.exec(line), n = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/.exec(line);
        if (h) { flushP(); flushL(); const el = document.createElement(h[1].length === 3 ? "h3" : "h2"); inline(el, h[2]); out.append(el); }
        else if (b || n) { flushP(); const kind = b ? "ul" : "ol"; if (list && list.kind !== kind) flushL(); if (!list) list = { kind, items: [] }; list.items.push((b || n)[1].trim()); }
        else if (list && /^\s{2,}\S/.test(line)) list.items[list.items.length - 1] += " " + line.trim();
        else { flushL(); para.push(line.trim()); }
      }
      flushP(); flushL();
    }
  };
  const TOOLS = [
    ["Heading", (sel) => ({ text: `## ${sel || "Heading"}`, line: true })],
    ["Bold", (sel) => ({ text: `**${sel || "bold text"}**` })],
    ["Italic", (sel) => ({ text: `*${sel || "italic text"}*` })],
    ["Link", (sel) => { const url = window.prompt("Link address (https://, http:// or mailto:)", "https://"); if (!url) return null; if (!SAFE.test(url.trim())) { window.alert("Only https://, http:// and mailto: links are allowed."); return null; } return { text: `[${sel || "link text"}](${url.trim()})` }; }],
    ["Bullets", (sel) => ({ text: (sel || "Item").split("\n").map((l) => `- ${l}`).join("\n"), line: true })],
    ["Numbered", (sel) => ({ text: (sel || "Item").split("\n").map((l, i) => `${i + 1}. ${l}`).join("\n"), line: true })],
  ];
  document.querySelectorAll("[data-richtext]").forEach((wrap) => {
    const ta = document.getElementById(wrap.getAttribute("data-richtext"));
    const out = wrap.querySelector("[data-preview-for]");
    if (!ta || !out) return;
    const bar = document.createElement("div");
    bar.className = "richtext__toolbar"; bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Formatting"); bar.setAttribute("aria-controls", ta.id);
    TOOLS.forEach(([label, fn]) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn btn--ghost btn--sm"; b.textContent = label;
      b.addEventListener("click", () => {
        const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e);
        const r = fn(sel); if (!r) return;
        const before = ta.value.slice(0, s), after = ta.value.slice(e);
        const pre = r.line && before && !before.endsWith("\n") ? "\n" : "";
        ta.value = before + pre + r.text + after;
        ta.focus(); ta.setSelectionRange(s + pre.length, s + pre.length + r.text.length);
        ta.dispatchEvent(new Event("input"));
      });
      bar.append(b);
    });
    ta.parentElement.insertBefore(bar, ta);
    const update = () => render(ta.value, out);
    ta.addEventListener("input", update); update();
  });
  // Live unread counts (PORTAL-005): passive polling while the tab is visible; never extends the session.
  const live = document.querySelector("[data-live-root]");
  if (live && window.fetch) {
    const links = { messages: ["/portal/messages", "/staff/conversations"], notifications: ["/portal/notifications", "/staff/notifications"] };
    let base = null, timer = null;
    const badge = (href, n) => {
      document.querySelectorAll(`.side-link[href="${href}"]`).forEach((a) => {
        let b = a.querySelector("[data-live-badge]");
        if (!n) { if (b) b.remove(); return; }
        if (!b) { b = document.createElement("span"); b.className = "badge badge--gold"; b.setAttribute("data-live-badge", ""); a.appendChild(b); }
        b.textContent = String(n);
      });
    };
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/live/unread", { credentials: "same-origin", headers: { accept: "application/json" }, redirect: "manual" });
        if (r.status !== 200) { clearInterval(timer); return; }
        const d = await r.json();
        for (const k of Object.keys(links)) links[k].forEach((h) => badge(h, d[k]));
        if (base === null) { base = d; return; }
        const more = [];
        if (d.messages > base.messages) more.push(`${d.messages - base.messages} new message${d.messages - base.messages === 1 ? "" : "s"}`);
        if (d.notifications > base.notifications) more.push(`${d.notifications - base.notifications} new notification${d.notifications - base.notifications === 1 ? "" : "s"}`);
        if (more.length) {
          live.textContent = more.join(" · ") + " ";
          const a = document.createElement("a"); a.href = location.pathname + location.search; a.textContent = "Refresh";
          live.appendChild(a); live.hidden = false;
        }
      } catch { /* offline: try again next tick */ }
    };
    poll();
    timer = setInterval(poll, 30000);
    document.addEventListener("visibilitychange", poll);
  }

  // Toggletips (pricing comparison): the explanation is in the HTML and visible without JavaScript; with JavaScript it opens
  // on click or Enter/Space and closes with Escape or a click elsewhere. Never hover-only.
  {
    const tips = document.querySelectorAll(".toggletip");
    if (tips.length) {
      document.documentElement.classList.add("has-toggletips");
      const close = (except) => tips.forEach((b) => { if (b !== except) b.setAttribute("aria-expanded", "false"); });
      tips.forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); const open = b.getAttribute("aria-expanded") !== "true"; close(b); b.setAttribute("aria-expanded", String(open)); }));
      document.addEventListener("click", () => close(null));
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") { const o = document.querySelector('.toggletip[aria-expanded="true"]'); if (o) { o.setAttribute("aria-expanded", "false"); o.focus(); } } });
    }
  }

  // Contact & quote forms (docs/frontend/CONTACT.md). Same fields and server validation as always; this adds live
  // progress, inline checks that mirror the server's rules, the topic-reactive workspace, and a sending state that
  // blocks a second click (the server also ignores duplicate submissions). Success is only ever the server's redirect.
  {
    const RULES = {
      name: (v) => (v.length >= 2 && v.length <= 120 ? "" : "Enter your name (2–120 characters)"),
      email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254 ? "" : "Enter a valid email address"),
      phone: (v) => (!v || /^[+0-9 ().-]{7,40}$/.test(v) ? "" : "Enter a valid phone number, or leave it blank"),
      message: (v, el) => { const min = Number(el?.closest("form")?.dataset.minMessage) || 10; return v.length >= min && v.length <= 4000 ? "" : min === 20 ? "Describe your project in 20–4000 characters" : `Enter a message of ${min}–4000 characters`; },
    };
    const setError = (el, msg) => {
      const field = el.closest(".field"); if (!field) return;
      const id = `${el.id}-err`; let err = document.getElementById(id);
      if (msg) {
        if (!err) { err = document.createElement("span"); err.className = "error-text"; err.id = id; field.append(err); }
        err.textContent = msg; el.setAttribute("aria-invalid", "true");
        const d = new Set((el.getAttribute("aria-describedby") || "").split(" ").filter(Boolean)); d.add(id); el.setAttribute("aria-describedby", [...d].join(" "));
      } else if (err) { err.remove(); el.removeAttribute("aria-invalid"); el.setAttribute("aria-describedby", (el.getAttribute("aria-describedby") || "").split(" ").filter((x) => x && x !== id).join(" ")); }
    };
    const check = (el) => { const r = RULES[el.name]; if (!r) return ""; const msg = r(el.value.trim(), el); setError(el, msg); return msg; };
    document.querySelectorAll("[data-cx-form], [data-lead-form]").forEach((form) => {
      const cx = form.closest("[data-cx]");
      const send = form.querySelector('button[type="submit"]');
      const bar = form.querySelector("[data-cx-bar]"), prog = form.querySelector("[data-cx-progress]"), count = form.querySelector("[data-cx-count]");
      const required = ["name", "email", "message"];
      const progress = () => {
        if (!bar) return;
        let done = required.filter((n) => { const el = form.elements[n]; return el && !RULES[n](el.value.trim(), el); }).length;
        const topic = form.querySelector('input[name="interest"]:checked'); if (topic) done++;
        const total = required.length + 1;
        bar.style.width = `${(done / total) * 100}%`;
        prog.textContent = done === total ? "Ready to send" : `${done} of ${total} required details complete`;
        if (cx) cx.style.setProperty("--cx-p", String(done / total));
      };
      form.addEventListener("input", (e) => {
        const t = e.target;
        if (t.name === "message" && count) count.textContent = String(t.value.length);
        if (t.getAttribute("aria-invalid") === "true") check(t);
        progress();
      });
      form.addEventListener("change", (e) => { if (e.target.name === "interest" && cx) cx.dataset.topic = e.target.dataset.cxTopic || "chat"; progress(); });
      form.addEventListener("focusout", (e) => { if (e.target.value) check(e.target); });
      form.addEventListener("focusin", (e) => { if (cx) cx.dataset.focus = e.target.name || ""; });
      form.addEventListener("submit", (e) => {
        if (form.dataset.sending === "true") { e.preventDefault(); return; }
        const bad = [...form.querySelectorAll("input, textarea")].filter((el) => RULES[el.name] && check(el));
        if (bad.length) { e.preventDefault(); bad[0].focus(); return; }
        form.dataset.sending = "true";
        if (send) {
          // Drop the hover tile layer (M03): its copies of the old label would otherwise show over "Sending…".
          const fx = send.querySelector(".btn__fx"); if (fx) fx.remove(); send._fx = null;
          send.setAttribute("aria-disabled", "true"); send.classList.add("is-sending");
          const l = send.querySelector(".cx-send__label"); if (l) l.textContent = "Sending…";
        }
        if (cx) cx.classList.add("is-sending");
      });
      window.addEventListener("pageshow", () => {
        delete form.dataset.sending;
        if (send) { send.removeAttribute("aria-disabled"); send.classList.remove("is-sending"); const l = send.querySelector(".cx-send__label"); if (l) l.textContent = "Send message"; }
        if (cx) cx.classList.remove("is-sending");
      });
      progress();
    });
  }
})();
