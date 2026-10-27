// Progressive enhancement only: every feature works without JavaScript. Motion language: docs/frontend/DESIGN.md §6.
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
        const buttons = f.querySelectorAll("button[type=submit]");
        buttons.forEach((b) => { b.setAttribute("aria-disabled", "true"); b.disabled = true; });
        if (pressed && pressed.classList.contains("btn") && f.method.toLowerCase() === "post") pressed.setAttribute("data-busy", "true");
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

  // ── Roving tablists: the "Anatomy of a build" concept and the process stepper ──
  // Markup is a complete ordered list without JS; with JS one item is selected at a time.
  const tablist = (list, onSelect) => {
    const tabs = [...list.querySelectorAll("[role=tab]")];
    if (!tabs.length) return;
    const select = (i, focus) => {
      tabs.forEach((t, j) => {
        t.setAttribute("aria-selected", String(i === j)); t.tabIndex = i === j ? 0 : -1;
        if (j < i) t.setAttribute("data-past", "true"); else t.removeAttribute("data-past");
      });
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
    const initial = Math.max(0, tabs.findIndex((t) => t.getAttribute("aria-selected") === "true"));
    select(initial, false);
    return select;
  };

  document.querySelectorAll("[data-anatomy]").forEach((wrap) => {
    const mini = wrap.querySelector(".mini");
    const list = wrap.querySelector("[role=tablist]");
    const caption = wrap.querySelector("[data-anatomy-caption]");
    if (!mini || !list) return;
    list.querySelectorAll("li").forEach((li) => li.setAttribute("role", "presentation"));
    tablist(list, (i, tab) => {
      mini.setAttribute("data-layer", String(i + 1));
      if (caption) caption.textContent = tab.querySelector(".anatomy__tab-title")?.textContent ?? "";
    });
  });

  document.querySelectorAll("[data-stepper]").forEach((wrap) => {
    const list = wrap.querySelector("[role=tablist]");
    const panel = wrap.querySelector("[data-stepper-panel]");
    if (!list || !panel) return;
    list.querySelectorAll("li").forEach((li) => li.setAttribute("role", "presentation"));
    const tabs = [...list.querySelectorAll("[role=tab]")];
    const count = panel.querySelector("[data-panel-count]"), title = panel.querySelector("[data-panel-title]"), body = panel.querySelector("[data-panel-text]");
    const prev = panel.querySelector("[data-step-prev]"), next = panel.querySelector("[data-step-next]");
    let current = 0;
    const select = tablist(list, (i, tab) => {
      current = i;
      count.textContent = `Step ${i + 1} of ${tabs.length}`;
      title.textContent = tab.getAttribute("data-title") || tab.textContent.trim();
      body.textContent = tab.getAttribute("data-body") || "";
      const wrapBody = panel.querySelector("[data-panel-body]");
      if (wrapBody && !reduceMotion.matches) { wrapBody.style.animation = "none"; void wrapBody.offsetWidth; wrapBody.style.animation = ""; }
      if (prev) prev.disabled = i === 0;
      if (next) next.disabled = i === tabs.length - 1;
    });
    panel.hidden = false;
    if (prev) prev.addEventListener("click", () => select(Math.max(0, current - 1), false));
    if (next) next.addEventListener("click", () => select(Math.min(tabs.length - 1, current + 1), false));
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
})();
