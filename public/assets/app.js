// Progressive enhancement only: every feature works without JavaScript.
(() => {
  // Mobile nav / sidebar toggles
  document.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.getAttribute("data-toggle"));
      if (!target) return;
      const open = target.getAttribute("data-open") === "true";
      target.setAttribute("data-open", String(!open));
      btn.setAttribute("aria-expanded", String(!open));
    });
  });
  // Confirm dangerous actions
  document.querySelectorAll("form[data-confirm]").forEach((f) => {
    f.addEventListener("submit", (e) => { if (!window.confirm(f.getAttribute("data-confirm"))) e.preventDefault(); });
  });
  // Prevent double submission
  document.querySelectorAll("form").forEach((f) => {
    f.addEventListener("submit", () => {
      setTimeout(() => f.querySelectorAll("button[type=submit]").forEach((b) => { b.setAttribute("aria-disabled", "true"); b.disabled = true; }), 0);
    });
  });
  // Auto-dismiss toasts
  document.querySelectorAll(".toast").forEach((t) => setTimeout(() => t.remove(), 7000));
  // Conditional form sections: <div data-show-when="fieldName=value1,value2">
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
  // Screenshot viewer (full screen)
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
