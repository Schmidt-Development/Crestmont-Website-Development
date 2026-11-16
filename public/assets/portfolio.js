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
//  • a slide with data-kind="remote" (Mode B: the site refuses framing) shows the REAL live website through
//    Crestmont's remote browser: a session is requested from /api/portfolio/remote-sessions, its WebSocket streams
//    JPEG frames of an isolated Chromium page onto a <canvas>, and the visitor's pointer, wheel, touch and keys are sent
//    back. Only the active slide holds a session; it closes when the visitor moves on or hides the page, and an ended
//    or refused session leaves an honest notice (with Resume where it can) — never a screenshot presented as live.
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
    const allowed = new Set(slides.map((s) => s.dataset.demoOrigin).filter(Boolean)); // demo handshake origins only
    const frames = new Map(); // slide index → { f, ready, timer }
    const remotes = new Map(); // slide index → remote-browser session state
    const previewTok = root.dataset.preview || "";
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
      for (const rec of remotes.values()) tx(rec, { t: "device", d: m, h: frameH() });
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
    const isRemote = (s) => s.dataset.kind === "remote";
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
      if (isRemote(s)) { mountRemote(i); return; }
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
      const rec = { f, ready: false, timer: 0 };
      frames.set(i, rec);
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

    // ── Mode B: the remote browser ──
    const tx = (rec, m) => { if (rec.ws && rec.ws.readyState === 1) rec.ws.send(JSON.stringify(m)); };
    const frameH = () => Math.round(parseFloat(getComputedStyle(root).getPropertyValue("--pfx-fh")) || 900);
    const flag = (s, text) => { const el = s.querySelector("[data-pfx-flag]"); if (el) el.textContent = text; };
    const notice = (s, text, opts = {}) => {
      const el = s.querySelector("[data-pfx-status]");
      if (!el) return;
      el.textContent = text;
      if (opts.resume) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "pfx__resume"; b.dataset.pfxResume = ""; b.textContent = opts.resume;
        b.addEventListener("click", opts.onResume);
        el.append(" ", b);
      }
      const a = document.createElement("a");
      a.href = s.dataset.liveUrl; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = " Visit the live website in a new tab.";
      el.append(a);
    };
    function mountRemote(i) {
      const s = slides[i];
      let rec = remotes.get(i);
      if (rec && (rec.ws || rec.starting || rec.refused)) return;
      if (!rec) {
        const c = document.createElement("canvas");
        c.className = "pfx__frame pfx__remote";
        c.tabIndex = 0;
        c.setAttribute("role", "img");
        c.setAttribute("aria-roledescription", "remote browser");
        c.setAttribute("aria-label", `The live ${s.dataset.name} website, shown through Crestmont's remote browser. Click, scroll, touch or type to use it; sign-in, forms and purchases are turned off.`);
        s.querySelector("[data-pfx-stage]").append(c);
        rec = { c, g: c.getContext("2d"), ws: null, ready: false, timer: 0, w: 0, h: 0, pending: null, drawing: false, starting: false, refused: false };
        remotes.set(i, rec);
        bindRemoteInput(i, rec);
      }
      connect(i, rec);
    }
    async function connect(i, rec) {
      const s = slides[i];
      rec.ready = false; rec.starting = true; rec.refused = false; rec.offscreen = false;
      s.classList.remove("is-ready"); delete s.dataset.unavailable; s.dataset.remoteState = "starting";
      flag(s, "Live website · remote view");
      status(s, `Starting a remote browser for the live ${s.dataset.name} website…`);
      clearTimeout(rec.timer);
      rec.timer = setTimeout(() => { if (!rec.ready) stop(i, rec, "timeout"); }, READY_TIMEOUT + 10000);
      let r = {}, ok = false;
      try {
        const res = await fetch("/api/portfolio/remote-sessions", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify(previewTok ? { slug: s.dataset.remoteSlug, preview: previewTok } : { slug: s.dataset.remoteSlug }) });
        r = await res.json().catch(() => ({}));
        ok = res.ok && typeof r.ws === "string";
      } catch { /* network */ }
      rec.starting = false;
      if (!ok) { refuse(i, rec, r.code, r.message); return; }
      if (i !== cur || document.hidden) return; // the visitor moved on while it was starting; the unclaimed session expires
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${r.ws}&device=${encodeURIComponent(root.dataset.mode)}&h=${frameH()}`);
      ws.binaryType = "blob";
      rec.ws = ws;
      ws.addEventListener("message", (e) => { if (typeof e.data === "string") onNotice(i, rec, e.data); else draw(i, rec, e.data); });
      ws.addEventListener("close", () => { if (rec.ws === ws) { rec.ws = null; if (s.dataset.remoteState !== "ended" && s.dataset.remoteState !== "unavailable") stop(i, rec, rec.ready ? "closed" : "error"); } });
    }
    // Only the newest frame is drawn; frames that arrive while one is decoding replace each other.
    function draw(i, rec, blob) {
      rec.pending = blob;
      if (rec.drawing) return;
      rec.drawing = true;
      const step = () => {
        const b = rec.pending; rec.pending = null;
        if (!b) { rec.drawing = false; return; }
        createImageBitmap(b).then((bmp) => {
          if (rec.c.width !== bmp.width || rec.c.height !== bmp.height) { rec.c.width = bmp.width; rec.c.height = bmp.height; }
          rec.g.drawImage(bmp, 0, 0);
          if (bmp.close) bmp.close();
          if (!rec.ready) {
            const s = slides[i];
            rec.ready = true; clearTimeout(rec.timer); s.classList.add("is-ready"); s.dataset.remoteState = "live"; isolate(s); status(s, "");
          }
          step();
        }, step);
      };
      step();
    }
    function onNotice(i, rec, text) {
      let m; try { m = JSON.parse(text); } catch { return; }
      if (!m || typeof m !== "object") return;
      const s = slides[i];
      if (m.t === "ready" || m.t === "viewport") { rec.w = Number(m.w) || 0; rec.h = Number(m.h) || 0; }
      else if (m.t === "url" && typeof m.href === "string") { try { const u = new URL(m.href); if (u.protocol === "https:") urlLabel(s, u.host + (u.pathname === "/" ? "" : u.pathname)); } catch { /* ignore */ } }
      else if (m.t === "blocked" && live) live.textContent = `${String(m.title || "That page")} — not available in the portfolio view.`;
      else if (m.t === "ended") stop(i, rec, String(m.reason || "ended"));
      else if (m.t === "error") stop(i, rec, "error");
    }
    // A session that ended (inactivity, time limit, the visitor moved on) keeps its last picture, clearly marked, with Resume.
    function stop(i, rec, reason) {
      const s = slides[i];
      clearTimeout(rec.timer);
      const ws = rec.ws; rec.ws = null;
      try { if (ws) ws.close(1000, "done"); } catch { /* closed */ }
      if (reason === "error" || reason === "timeout" || !rec.ready) { refuse(i, rec, "error"); return; }
      s.dataset.remoteState = "ended";
      flag(s, "Remote view paused");
      const why = reason === "idle" ? "The remote view paused after a period of inactivity." : reason === "time-limit" ? "The remote view reached its time limit." : reason === "away" ? "The remote view paused while you were away." : "The remote view has ended.";
      notice(s, `${why} The picture above is no longer live.`, { resume: "Resume", onResume: () => connect(i, rec) });
    }
    // Mode C at view time: the remote browser is busy, over budget, off or failed. Never shown as interactive.
    function refuse(i, rec, code, message) {
      const s = slides[i];
      clearTimeout(rec.timer);
      rec.refused = true; rec.ready = false;
      s.classList.remove("is-ready"); s.dataset.remoteState = "unavailable"; s.dataset.unavailable = "true";
      const shot = !!s.querySelector("img.pfx__poster");
      flag(s, shot ? "Screenshot" : "Live view unavailable");
      const why = typeof message === "string" && message ? message : code === "busy" ? "All interactive viewers are in use right now." : "The interactive remote view is not available right now.";
      notice(s, `${why}${shot ? " A screenshot of the live website is shown instead — it is not interactive." : ""}`, code === "busy" || code === "error" || !code ? { resume: "Try again", onResume: () => { rec.refused = false; connect(i, rec); } } : {});
    }
    function bindRemoteInput(i, rec) {
      const c = rec.c;
      const pt = (cx, cy) => {
        const r = c.getBoundingClientRect(), w = rec.w || c.width || 1, h = rec.h || c.height || 1;
        return { x: Math.round(((cx - r.left) / (r.width || 1)) * w), y: Math.round(((cy - r.top) / (r.height || 1)) * h) };
      };
      const BTN = ["left", "middle", "right"];
      let move = null, raf = 0;
      const flush = () => { raf = 0; if (move) { tx(rec, move); move = null; } };
      c.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "touch") return;
        e.preventDefault(); c.focus({ preventScroll: true });
        try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        flush(); tx(rec, { t: "mouse", a: "down", b: BTN[e.button] || "left", n: e.detail || 1, ...pt(e.clientX, e.clientY) });
      });
      c.addEventListener("pointerup", (e) => { if (e.pointerType === "touch") return; flush(); tx(rec, { t: "mouse", a: "up", b: BTN[e.button] || "left", n: e.detail || 1, ...pt(e.clientX, e.clientY) }); });
      c.addEventListener("pointermove", (e) => {
        if (e.pointerType === "touch") return;
        move = { t: "mouse", a: "move", ...pt(e.clientX, e.clientY) };
        if (!raf) raf = requestAnimationFrame(flush);
      });
      c.addEventListener("contextmenu", (e) => e.preventDefault());
      // The wheel and touch scroll the remote page only: Crestmont's page never moves while the pointer is on it.
      c.addEventListener("wheel", (e) => {
        e.preventDefault();
        const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
        tx(rec, { t: "wheel", dx: Math.round(e.deltaX * k), dy: Math.round(e.deltaY * k), ...pt(e.clientX, e.clientY) });
      }, { passive: false });
      const touches = (e) => [...e.touches].slice(0, 5).map((t) => ({ id: t.identifier % 100, ...pt(t.clientX, t.clientY) }));
      let tmove = null, traf = 0;
      const tflush = () => { traf = 0; if (tmove) { tx(rec, tmove); tmove = null; } };
      c.addEventListener("touchstart", (e) => { e.preventDefault(); tflush(); tx(rec, { t: "touch", a: "start", p: touches(e) }); }, { passive: false });
      c.addEventListener("touchmove", (e) => { e.preventDefault(); tmove = { t: "touch", a: "move", p: touches(e) }; if (!traf) traf = requestAnimationFrame(tflush); }, { passive: false });
      c.addEventListener("touchend", (e) => { e.preventDefault(); tflush(); tx(rec, e.touches.length ? { t: "touch", a: "move", p: touches(e) } : { t: "touch", a: "end", p: [] }); }, { passive: false });
      c.addEventListener("touchcancel", () => { tflush(); tx(rec, { t: "touch", a: "cancel", p: [] }); });
      const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
      const key = (a) => (e) => {
        if (e.key === "Tab" || (e.key === "Escape" && isOpen())) return; // focus can always leave; Escape closes full screen
        if (e.key.length > 24) return;
        e.preventDefault();
        tx(rec, { t: "key", a, key: e.key, code: e.code, mod: mods(e) });
      };
      c.addEventListener("keydown", key("down"));
      c.addEventListener("keyup", key("up"));
    }
    const pauseRemote = (i, reason) => { const rec = remotes.get(i); if (rec && rec.ws) stop(i, rec, reason); };

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
      for (const j of remotes.keys()) if (j !== cur) pauseRemote(j, "away");
      if (near) mount(cur);
    }

    prev && prev.addEventListener("click", () => go(cur - 1));
    next && next.addEventListener("click", () => go(cur + 1));
    pages.forEach((b) => b.addEventListener("click", () => go(Number(b.dataset.pfxGo))));
    modeBtns.forEach((b) => b.addEventListener("click", () => { userMode = true; setMode(b.dataset.pfxMode, true); }));
    resetBtn && resetBtn.addEventListener("click", () => {
      const s = slides[cur], rec = frames.get(cur);
      if (isRemote(s)) {
        const rr = remotes.get(cur);
        if (rr && rr.ws) { tx(rr, { t: "nav", a: "home" }); urlLabel(s, s.dataset.remoteHost); if (live) live.textContent = `${name(cur)} reloaded at its home page.`; }
        else if (rr) { rr.refused = false; connect(cur, rr); } else mountRemote(cur);
        return;
      }
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
    const histBtn = (sel, a) => { const b = root.querySelector(sel); if (b) b.addEventListener("click", () => { const rr = remotes.get(cur); if (rr && isRemote(slides[cur])) tx(rr, { t: "nav", a }); }); };
    histBtn("[data-pfx-back]", "back");
    histBtn("[data-pfx-forward]", "forward");
    // A hidden page holds no browser: the session pauses and Resume starts a new one.
    document.addEventListener("visibilitychange", () => { if (document.hidden) for (const j of remotes.keys()) pauseRemote(j, "away"); });
    window.addEventListener("pagehide", () => { for (const j of remotes.keys()) pauseRemote(j, "away"); });
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
    // Mode B costs browser time: a remote session is released as soon as the explorer leaves the screen and started
    // again when it comes back (only if it was released for that reason).
    if ("IntersectionObserver" in window && slides.some(isRemote)) {
      new IntersectionObserver((es) => {
        const on = es.some((x) => x.isIntersecting);
        const rec = remotes.get(cur);
        if (!on) { if (rec && rec.ws) { stop(cur, rec, "away"); rec.offscreen = true; } }
        else if (rec && rec.offscreen && !rec.ws && !rec.starting) { rec.offscreen = false; connect(cur, rec); }
      }, { threshold: 0 }).observe(root);
    }
    // Lazy: create the active demo only when the explorer approaches the viewport.
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { near = true; mount(cur); io.disconnect(); } }, { rootMargin: "300px 0px" });
      io.observe(root);
    } else { near = true; mount(cur); }
  });
})();
