// Crestmont website assistant (docs/frontend/CHATBOT.md). Progressive enhancement of the hidden widget in the public
// layout. Rules this file keeps:
//  • it never shows a scripted answer as an AI reply: it asks GET /api/assistant first and, when live answers are not
//    available, says so and offers links and a person instead;
//  • replies are rendered as text; only site paths the server approved become links;
//  • the conversation lives in this tab's sessionStorage (survives page navigation, cleared by Restart), never on the
//    server; nothing else is stored;
//  • non-modal panel: focus moves into it on open and back to the launcher on close (Escape); no focus trap;
//  • it hides while the mobile menu, the portfolio's expanded view or an on-page form field (phone keyboard) is active.
(() => {
  const root = document.querySelector("[data-cb]");
  if (!root || window.__crestmontAssistant) return;
  window.__crestmontAssistant = true;
  const $ = (s) => root.querySelector(s);
  const launch = $("[data-cb-launch]"), panel = $("[data-cb-panel]"), log = $("[data-cb-log]"), form = $("[data-cb-form]"), input = $("[data-cb-input]");
  const sendBtn = $("[data-cb-send]"), statusEl = $("[data-cb-status]"), suggest = $("[data-cb-suggest]"), offline = $("[data-cb-offline]");
  const KEY = "cm-assistant-v1";
  const store = { get() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { return null; } }, set(v) { try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode: in-memory only */ } } };
  const state = Object.assign({ messages: [], open: false, hello: false, session: "" }, store.get() || {});
  if (!state.session) state.session = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^a-z0-9-]/gi, "").slice(0, 40);
  let available = null, busy = false, checking = null;
  const save = () => store.set({ messages: state.messages.slice(-30), open: state.open, hello: state.hello, session: state.session });

  const LINK_RE = /(?<![\w/])\/[a-z0-9\-/]+/gi;
  function render(m, animate) {
    const el = document.createElement("div");
    el.className = `cb__msg cb__msg--${m.role === "user" ? "user" : m.kind || "ai"}`;
    if (m.role !== "user" && !m.kind) { const tag = document.createElement("span"); tag.className = "cb__who"; tag.textContent = "AI assistant"; el.append(tag); }
    const allowed = new Set(m.links || []);
    for (const para of String(m.content).split(/\n{2,}/)) {
      const p = document.createElement("p");
      let last = 0;
      for (const match of para.matchAll(LINK_RE)) {
        const path = match[0].replace(/[).,;:]+$/, "");
        if (!allowed.has(path)) continue;
        p.append(para.slice(last, match.index));
        const a = document.createElement("a"); a.href = path; a.textContent = path; p.append(a);
        last = match.index + path.length;
      }
      p.append(para.slice(last));
      el.append(p);
    }
    if (animate) el.classList.add("is-new");
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function note(text, kind = "note") { const el = render({ role: "assistant", kind, content: text }, true); return el; }
  const typing = () => { const t = document.createElement("div"); t.className = "cb__typing"; t.setAttribute("aria-label", "The assistant is writing"); t.innerHTML = "<i></i><i></i><i></i>"; log.append(t); log.scrollTop = log.scrollHeight; return t; };

  function setAvailable(a) {
    available = a;
    statusEl.textContent = a ? "AI · answers from Crestmont's published information" : "Live AI answers off · links and a person below";
    root.classList.toggle("is-offline", !a);
    offline.hidden = a;
    input.disabled = !a; sendBtn.disabled = !a;
    input.placeholder = a ? "Ask about services, pricing or the process…" : "Live answers are off right now";
    suggest.hidden = !a || state.messages.length > 0;
  }
  function checkAvailability() { return (checking = checking || checkNow()); }
  async function checkNow() {
    try {
      const r = await fetch("/api/assistant", { headers: { accept: "application/json" }, credentials: "same-origin" });
      const d = await r.json();
      setAvailable(!!d.available);
    } catch { setAvailable(false); }
  }

  function open(focusInput = true) {
    state.open = true; save();
    panel.hidden = false; root.classList.add("is-open");
    launch.setAttribute("aria-expanded", "true");
    $("[data-cb-hello]").hidden = true; $("[data-cb-dot]").hidden = true;
    if (available === null) checkAvailability();
    log.scrollTop = log.scrollHeight;
    if (focusInput) (input.disabled ? log : input).focus({ preventScroll: true });
  }
  function close(focusLaunch = true) {
    state.open = false; save();
    panel.hidden = true; root.classList.remove("is-open");
    launch.setAttribute("aria-expanded", "false");
    if (focusLaunch) launch.focus({ preventScroll: true });
  }

  async function ask(text) {
    text = text.trim();
    if (!text || busy) return;
    if (available === null) await checkAvailability(); // a question typed while the page is still checking is kept, not lost
    if (!available) { note("Live AI answers aren't switched on right now. The links below cover most questions, or talk to a person."); return; }
    busy = true; sendBtn.disabled = true; suggest.hidden = true;
    const userMsg = { role: "user", content: text };
    state.messages.push(userMsg); save(); render(userMsg, true);
    input.value = ""; autosize();
    const t = typing();
    try {
      const r = await fetch("/api/assistant", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json", "x-assistant-session": state.session },
        body: JSON.stringify({ messages: state.messages.filter((m) => !m.kind).map((m) => ({ role: m.role, content: m.content })) }),
      });
      const d = await r.json().catch(() => ({}));
      t.remove();
      if (r.ok && d.reply) {
        const m = { role: "assistant", content: d.reply, links: d.links || [] };
        state.messages.push(m); save(); render(m, true);
      } else {
        // The visitor's message stays in view but is removed from the conversation sent next time.
        state.messages.pop(); save();
        if (r.status === 503 && d.code === "unavailable") { setAvailable(false); note("Live AI answers aren't switched on right now. The links below cover most questions, or talk to a person."); }
        else note(d.message || "Something went wrong. Please try again, or talk to a person.", "error");
      }
    } catch {
      t.remove(); state.messages.pop(); save();
      note("You appear to be offline — your message wasn't sent. Check your connection and try again.", "error");
    } finally { busy = false; sendBtn.disabled = !available; if (state.open) input.focus({ preventScroll: true }); }
  }

  function autosize() { input.style.height = "auto"; input.style.height = Math.min(120, input.scrollHeight) + "px"; }
  function restart() {
    state.messages = []; save();
    log.querySelectorAll(".cb__msg:not(.cb__msg--welcome), .cb__typing").forEach((n) => n.remove());
    suggest.hidden = !available;
    note("New conversation started.", "note");
    input.focus({ preventScroll: true });
  }

  launch.addEventListener("click", () => (state.open ? close() : open()));
  $("[data-cb-close]").addEventListener("click", () => close());
  $("[data-cb-restart]").addEventListener("click", restart);
  $("[data-cb-hello-x]").addEventListener("click", () => { $("[data-cb-hello]").hidden = true; state.hello = true; save(); });
  suggest.addEventListener("click", (e) => { const b = e.target.closest("[data-cb-ask]"); if (b) ask(b.textContent); });
  form.addEventListener("submit", (e) => { e.preventDefault(); ask(input.value); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); } });
  input.addEventListener("input", autosize);
  root.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.open) { e.stopPropagation(); close(); } });

  // Stay out of the way: hide while the mobile menu or the portfolio's expanded view is open, or while an on-page form
  // field has focus on a narrow screen (the phone keyboard would push the launcher over the form's buttons).
  const narrow = window.matchMedia("(max-width: 760px)");
  const sync = () => {
    const menuOpen = !!document.querySelector('.site-header .nav-toggle[aria-expanded="true"]');
    const pfx = document.documentElement.classList.contains("pfx-lock");
    const a = document.activeElement;
    const typingElsewhere = narrow.matches && a && !root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
    root.classList.toggle("is-hidden", menuOpen || pfx || (typingElsewhere && !state.open));
  };
  document.addEventListener("focusin", sync); document.addEventListener("focusout", () => setTimeout(sync, 0));
  const mo = new MutationObserver(sync);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  const toggle = document.querySelector(".site-header .nav-toggle");
  if (toggle) mo.observe(toggle, { attributes: true, attributeFilter: ["aria-expanded"] });

  // Restore this tab's conversation, then show the widget.
  for (const m of state.messages) render(m, false);
  root.hidden = false;
  if (state.open) { open(false); } else {
    checkAvailability();
    // A gentle, once-per-session hello after a short delay (not on phones, never while typing).
    if (!state.hello && !narrow.matches) setTimeout(() => { if (!state.open && !root.classList.contains("is-hidden")) { $("[data-cb-hello]").hidden = false; $("[data-cb-dot]").hidden = false; state.hello = true; save(); } }, 9000);
  }
  sync();
})();
