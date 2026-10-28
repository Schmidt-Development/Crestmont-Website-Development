// Interactive service visuals (docs/frontend/SERVICE-VISUALS.md). Progressive enhancement of the complete server-
// rendered demonstrations in src/ui/service-visuals.ts. Everything is local, synthetic state: no network requests,
// no storage, no forms submitted. Mouse, touch and keyboard all work; nothing depends on hover; reduced motion
// removes timed sequences; timers pause while a visual is offscreen. Event delegation on each figure means Reset can
// simply restore the original markup.
(() => {
  "use strict";
  if (window.__crestmontServices) return;
  window.__crestmontServices = true;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const $ = (r, s) => r.querySelector(s);
  const $$ = (r, s) => Array.from(r.querySelectorAll(s));
  const money = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const press = (els, on) => els.forEach((b) => b.setAttribute("aria-pressed", String(on(b))));

  // ── shared frame: live announcements, offscreen pause, timers that wait while paused, reset ──
  function setup(fig) {
    const body = $(fig, ".sv__body"), live = $(fig, "[data-sv-live]");
    const initial = { body: body.innerHTML, controls: $(fig, ".sv__controls")?.innerHTML, notes: $(fig, ".sv__notes")?.innerHTML };
    let paused = false, queue = [], gen = 0;
    const api = {
      fig, body, gen: () => gen,
      say(t) { if (!live) return; live.textContent = ""; setTimeout(() => { live.textContent = t; }, 30); },
      /** Runs fn after ms, waiting while the visual is offscreen; cancelled by reset. */
      later(ms, fn) { const g = gen; const run = () => { if (g !== gen) return; if (paused) queue.push(run); else fn(); }; if (reduce.matches || ms <= 0) run(); else setTimeout(run, ms); },
      /** Reveals items one at a time (all at once with reduced motion). */
      sequence(items, ms, each, done) { let i = 0; const step = () => { if (i >= items.length) { done && done(); return; } each(items[i], i); i++; if (reduce.matches) step(); else api.later(ms, step); }; step(); },
      reset() { gen++; queue = []; body.innerHTML = initial.body; const c = $(fig, ".sv__controls"); if (c && initial.controls != null) c.innerHTML = initial.controls; const n = $(fig, ".sv__notes"); if (n && initial.notes != null) n.innerHTML = initial.notes; },
      note(key) { $$(fig, ".sv__note").forEach((n) => n.toggleAttribute("data-on", n.dataset.note === key)); const n = $(fig, `.sv__note[data-note="${CSS.escape(key)}"]`); if (n) api.say(n.textContent); },
      pick(key) { press($$(fig, ".sv__controls .sv__opt[data-key]"), (b) => b.dataset.key === key); },
    };
    if ("IntersectionObserver" in window) new IntersectionObserver((es) => es.forEach((e) => {
      paused = !e.isIntersecting; fig.toggleAttribute("data-paused", paused);
      if (!paused) { const q = queue; queue = []; q.forEach((f) => f()); }
    })).observe(fig);
    fig.setAttribute("data-js", "");
    return api;
  }

  const engines = {};

  // 1. Layers: choose a layer to separate it; Replay assembles the page layer by layer.
  engines.layers = (v) => {
    const wrap = () => $(v.body, ".sv-layers");
    const show = (key) => { wrap().dataset.view = key; v.pick(key); v.note(key); };
    const replay = () => {
      const w = wrap(); const order = ["structure", "visual", "responsive", "function"];
      w.dataset.view = "build"; w.dataset.built = "0"; v.pick(""); v.say("Assembling the page, layer by layer.");
      v.sequence(order, 650, (k, i) => { w.dataset.built = String(i + 1); v.note(k); }, () => v.later(700, () => show("all")));
    };
    v.fig.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-replay")) replay(); else if (b.dataset.key) show(b.dataset.key);
    });
  };

  // 2. Before/after comparison: pointer drag anywhere on the stage, keyboard on the handle, presets.
  engines.compare = (v) => {
    const c = $(v.body, ".sv-compare"), h = $(c, ".sv-compare__handle");
    const set = (p, announce) => {
      p = Math.max(0, Math.min(100, Math.round(p))); c.style.setProperty("--pos", p + "%"); c.dataset.pos = String(p);
      const t = p === 0 ? "Showing the original layout" : p === 100 ? "Showing the redesigned layout" : `${100 - p}% redesigned, ${p}% original`;
      h.setAttribute("aria-valuenow", String(p)); h.setAttribute("aria-valuetext", t);
      v.pick(String([0, 50, 100].includes(p) ? p : -1)); if (announce) v.say(t);
    };
    let drag = false;
    const at = (e) => { const r = c.getBoundingClientRect(); set(((e.clientX - r.left) / r.width) * 100); };
    c.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; drag = true; c.setPointerCapture(e.pointerId); c.classList.add("is-dragging"); at(e); h.focus({ preventScroll: true }); });
    c.addEventListener("pointermove", (e) => { if (drag) at(e); });
    const end = () => { if (!drag) return; drag = false; c.classList.remove("is-dragging"); v.say(h.getAttribute("aria-valuetext")); };
    c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
    h.addEventListener("keydown", (e) => {
      const p = Number(c.dataset.pos); const m = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -20, PageUp: 20 };
      if (e.key in m) set(p + m[e.key], true); else if (e.key === "Home") set(0, true); else if (e.key === "End") set(100, true); else return;
      e.preventDefault();
    });
    v.fig.addEventListener("click", (e) => { const b = e.target.closest(".sv__controls [data-key]"); if (b) { c.classList.add("is-animating"); set(Number(b.dataset.key), true); v.later(500, () => c.classList.remove("is-animating")); } });
    set(50);
  };

  // 3. Shop: cart with accurate integer-cent totals, illustrative checkout, completion, reset.
  engines.shop = (v) => {
    const SHIP = 600; let cart = new Map(), order = 1000;
    const S = () => $(v.body, ".sv-shop");
    const step = (name) => {
      const s = S(); s.dataset.step = name;
      $$(s, "[data-step-chip]").forEach((li) => (li.dataset.stepChip === name ? li.setAttribute("aria-current", "step") : li.removeAttribute("aria-current")));
    };
    const totals = () => { let n = 0, sub = 0; for (const it of cart.values()) { n += it.qty; sub += it.qty * it.cents; } return { n, sub, ship: n ? SHIP : 0, total: sub + (n ? SHIP : 0) }; };
    const render = () => {
      const s = S(), t = totals(), lines = $(s, "[data-cart-lines]");
      lines.innerHTML = "";
      if (!t.n) { const li = document.createElement("li"); li.className = "sv-cart__empty"; li.textContent = "Your demonstration cart is empty."; lines.append(li); }
      for (const [id, it] of cart) {
        const li = document.createElement("li"); li.className = "sv-cart__line";
        const name = document.createElement("span"); name.className = "sv-cart__name"; name.textContent = it.name;
        const q = document.createElement("span"); q.className = "sv-qty";
        const mk = (txt, act, label) => { const b = document.createElement("button"); b.type = "button"; b.className = "sv-qty__btn"; b.dataset.qty = act; b.dataset.id = id; b.textContent = txt; b.setAttribute("aria-label", label); return b; };
        const n = document.createElement("span"); n.className = "sv-qty__n"; n.textContent = String(it.qty);
        q.append(mk("−", "dec", `Remove one ${it.name}`), n, mk("+", "inc", `Add one ${it.name}`));
        const amt = document.createElement("span"); amt.className = "sv-cart__amt"; amt.textContent = money(it.qty * it.cents);
        li.append(name, q, amt); lines.append(li);
      }
      $(s, "[data-cart-count]").textContent = `(${t.n} ${t.n === 1 ? "item" : "items"})`;
      $(s, "[data-subtotal]").textContent = money(t.sub); $(s, "[data-shipping]").textContent = money(t.ship); $(s, "[data-total]").textContent = money(t.total);
      $(s, "[data-checkout-total]").textContent = money(t.total);
      $(s, "[data-to-checkout]").disabled = !t.n;
      if (s.dataset.step === "products" || s.dataset.step === "cart") step(t.n ? "cart" : "products");
      return t;
    };
    const change = (id, d, name, cents) => {
      const it = cart.get(id) || { name, cents, qty: 0 }; it.qty += d;
      if (it.qty <= 0) cart.delete(id); else cart.set(id, it);
      const t = render(); v.say(`${it.name}: ${Math.max(it.qty, 0)} in cart. Total before tax ${money(t.total)}.`);
    };
    v.fig.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return; const s = S();
      if (b.dataset.add) { const p = b.closest("[data-product]"); change(p.dataset.product, 1, p.dataset.name, Number(p.dataset.cents)); b.closest(".sv-prod").classList.remove("is-added"); void b.offsetWidth; b.closest(".sv-prod").classList.add("is-added"); }
      else if (b.dataset.qty) { const it = cart.get(b.dataset.id); change(b.dataset.id, b.dataset.qty === "inc" ? 1 : -1, it.name, it.cents); const nb = $(s, `[data-qty="${b.dataset.qty}"][data-id="${b.dataset.id}"]`) || $(s, "[data-to-checkout]"); nb.focus(); }
      else if (b.hasAttribute("data-to-checkout")) { step("checkout"); $(s, "[data-pay]").focus(); v.say("Illustrative checkout. Nothing is collected or charged."); }
      else if (b.hasAttribute("data-back-cart")) { step("cart"); $(s, "[data-to-checkout]").focus(); }
      else if (b.hasAttribute("data-pay")) {
        const t = totals(); order++; const ref = "DEMO-" + order;
        $(s, "[data-order]").textContent = ref;
        const lines = [...cart.values()].map((it) => `  ${it.qty} × ${it.name}  ${money(it.qty * it.cents)}`);
        $(s, "[data-email]").textContent = [`Subject: Order ${ref} confirmed (demonstration)`, "", ...lines, `  Shipping  ${money(t.ship)}`, `  Total before tax  ${money(t.total)}`].join("\n");
        step("done"); $(s, "[data-panel=done]").setAttribute("tabindex", "-1"); $(s, "[data-panel=done]").focus({ preventScroll: true });
        v.say(`Demonstration order ${ref} complete. Nothing was charged.`);
      } else if (b.hasAttribute("data-reset")) { cart = new Map(); v.reset(); render(); v.say("Demonstration reset."); }
    });
    render();
  };

  // 4. Modules: one shared data store drives scheduling, the dashboard and workflow tasks.
  engines.modules = (v) => {
    let k = { bookings: 1, open: 1, done: 0 };
    const M = () => $(v.body, ".sv-mod");
    const show = (key) => { M().dataset.module = key; v.pick(key); v.note(key); };
    const pulse = (...lines) => lines.forEach((l) => { const p = $(M(), `[data-line="${l}"]`); if (!p) return; p.classList.remove("is-flow"); void p.getBoundingClientRect(); p.classList.add("is-flow"); });
    const kpis = () => Object.entries(k).forEach(([n, val]) => { const el = $(M(), `[data-kpi="${n}"]`); el.textContent = String(val); el.classList.remove("is-bump"); void el.offsetWidth; el.classList.add("is-bump"); });
    const feed = (t) => { const li = document.createElement("li"); li.textContent = t; $(M(), "[data-feed]").prepend(li); };
    v.fig.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.key) show(b.dataset.key);
      else if (b.dataset.book) {
        const t = b.dataset.book, cell = document.createElement("span"); cell.className = "sv-mod__booked sv-mod__booked--new"; cell.textContent = "Booked · you (sample)"; b.replaceWith(cell);
        k.bookings++; k.open++; kpis(); feed(`Appointment booked for ${t} (sample)`);
        const li = document.createElement("li"), s = document.createElement("span"), d = document.createElement("button");
        s.textContent = `Send confirmation for ${t}`; d.type = "button"; d.className = "sv__opt sv__opt--sm"; d.dataset.done = ""; d.textContent = "Mark done";
        li.append(s, d); $(M(), "[data-tasks]").append(li);
        pulse("scheduling", "dashboard", "workflow");
        v.say(`Booked ${t}. Saved once in shared data: the dashboard now shows ${k.bookings} bookings and a follow-up task was created.`);
      } else if (b.hasAttribute("data-done")) {
        const li = b.closest("li"); li.classList.add("is-done"); const tag = document.createElement("span"); tag.className = "sv-mod__ok"; tag.textContent = "Done"; b.replaceWith(tag);
        k.open--; k.done++; kpis(); feed(`Task completed: ${li.firstChild.textContent}`); pulse("workflow", "dashboard");
        v.say(`Task completed. The dashboard shows ${k.done} completed and ${k.open} open.`);
      } else if (b.hasAttribute("data-reset")) { k = { bookings: 1, open: 1, done: 0 }; v.reset(); show("scheduling"); v.say("Demonstration reset."); }
    });
  };

  // 5. Technical SEO: select pages to inspect; a restrained crawl follows robots → sitemap → links.
  engines.sitemap = (v) => {
    const CRAWL = [
      ["robots", "Read /robots.txt — crawling allowed; sitemap location found"], ["sitemap", "Read /sitemap.xml — 6 indexable pages listed"],
      ["home", "Fetched / — title, description and canonical present; Organization data valid"], ["services", "Fetched /services — followed internal links"],
      ["kitchens", "Fetched /services/kitchens — Service structured data valid"], ["bathrooms", "Fetched /services/bathrooms — Service structured data valid"],
      ["about", "Fetched /about"], ["contact", "Fetched /contact"], ["old", "Old address /old-services.html → 301 to /services; not indexed twice"],
    ];
    const S = () => $(v.body, ".sv-seo");
    const inspect = (id, say = true) => {
      press($$(S(), "[data-node-btn]"), (b) => b.dataset.nodeBtn === id);
      $$(S(), "[data-meta]").forEach((d) => d.toggleAttribute("data-on", d.dataset.meta === id));
      if (say) v.say(`Inspecting ${$(S(), `[data-meta="${id}"] code`).textContent}.`);
    };
    let crawling = false;
    v.fig.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.nodeBtn) inspect(b.dataset.nodeBtn);
      else if (b.hasAttribute("data-crawl") && !crawling) {
        crawling = true; b.disabled = true; const s = S(), log = $(s, "[data-log]"); log.innerHTML = ""; s.classList.add("is-crawling");
        $$(s, "[data-node-btn]").forEach((n) => n.classList.remove("is-crawled"));
        v.say("Crawl started.");
        v.sequence(CRAWL, 700, ([id, msg]) => {
          const n = $(s, `[data-node-btn="${id}"]`); $$(s, ".is-visiting").forEach((x) => x.classList.remove("is-visiting"));
          n.classList.add("is-crawled", "is-visiting"); inspect(id, false);
          const li = document.createElement("li"); li.textContent = msg; log.append(li);
        }, () => { $$(s, ".is-visiting").forEach((x) => x.classList.remove("is-visiting")); s.classList.remove("is-crawling"); crawling = false; b.disabled = false; b.textContent = "Run crawl again"; v.say("Crawl complete: 6 pages indexable, 1 redirect, 2 crawl files."); });
      } else if (b.hasAttribute("data-reset")) { crawling = false; v.reset(); v.say("Demonstration reset."); }
    });
  };

  // 6. Generic staged flow: steps, explicit approval gates, scenario toggles, simulated logs.
  engines.flow = (v) => {
    let state;
    const F = () => $(v.body, ".sv-flow");
    const keys = () => $$(F(), "[data-chip]").map((c) => c.dataset.chip);
    const init = () => {
      state = { i: 0, flags: new Set($$(F(), "[data-toggle][aria-pressed=true]").map((t) => t.dataset.toggle)), done: new Set() };
      $$(F(), "[data-seq]").forEach((l) => { l.hidden = true; $$(l, "li").forEach((li) => li.classList.remove("is-in")); });
      apply(); go(0, false);
    };
    const gateOpen = (i) => { const p = $$(F(), ".sv-flow__panel")[i]; return !p.hasAttribute("data-gate") || state.done.has("approve"); };
    const apply = () => {
      const f = state.flags; if (["spf", "dkim", "dmarc"].some((x) => $(F(), `[data-toggle="${x}"]`))) { if (f.has("spf") && f.has("dkim") && f.has("dmarc")) f.add("authok"); else f.delete("authok"); }
      $$(F(), "[data-when]").forEach((el) => { el.hidden = !f.has(el.dataset.when); });
      $$(F(), "[data-unless]").forEach((el) => { el.hidden = f.has(el.dataset.unless); });
    };
    const go = (i, announce = true) => {
      const ks = keys(); i = Math.max(0, Math.min(ks.length - 1, i));
      // An approval gate cannot be skipped: steps after it stay locked until a person approves.
      for (let g = 0; g < i; g++) if (!gateOpen(g)) { i = g; break; }
      state.i = i; const f = F(); f.dataset.stage = ks[i];
      $$(f, "[data-chip]").forEach((c, n) => { c.setAttribute("aria-pressed", String(n === i)); c.classList.toggle("is-past", n < i); const locked = [...Array(n).keys()].some((g) => !gateOpen(g)); c.disabled = locked; });
      $$(f, ".sv-flow__panel").forEach((p, n) => p.toggleAttribute("data-on", n === i));
      const next = $(v.fig, "[data-next]"), prev = $(v.fig, "[data-prev]");
      if (prev) prev.disabled = i === 0;
      if (next) { const blocked = !gateOpen(i); next.disabled = i === ks.length - 1 || blocked; next.textContent = blocked ? "Waiting for approval" : "Next step"; }
      if (announce) { const p = $$(f, ".sv-flow__panel")[i]; v.say(`Step ${i + 1} of ${ks.length}: ${p.getAttribute("aria-label")}. ${p.querySelector("p")?.textContent ?? ""}`); }
    };
    const play = (id) => {
      // Only the log for the current scenario plays (alternatives sit inside hidden conditional blocks).
      const visible = $$(F(), `[data-seq="${CSS.escape(id)}"]`).filter((l) => !l.parentElement.closest("[hidden]"));
      visible.forEach((l) => { l.hidden = false; $$(l, "li").forEach((li) => li.classList.remove("is-in")); });
      const items = visible.flatMap((l) => $$(l, "li"));
      v.sequence(items, 520, (li) => { li.classList.add("is-in"); v.say(li.textContent); });
    };
    v.fig.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b || b.disabled) return;
      if (b.dataset.chip) go(keys().indexOf(b.dataset.chip));
      else if (b.hasAttribute("data-next")) go(state.i + 1);
      else if (b.hasAttribute("data-prev")) go(state.i - 1);
      else if (b.hasAttribute("data-reset")) { v.reset(); init(); v.say("Replaying from the first step."); }
      else if (b.dataset.toggle) {
        const t = b.dataset.toggle, group = b.closest(".sv-actions");
        if (group) { $$(group, "[data-toggle]").forEach((x) => { state.flags.delete(x.dataset.toggle); x.setAttribute("aria-pressed", "false"); }); state.flags.add(t); b.setAttribute("aria-pressed", "true"); }
        else { const on = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", String(on)); on ? state.flags.add(t) : state.flags.delete(t); }
        $$(F(), "[data-seq]").forEach((l) => { l.hidden = true; });
        state.done.forEach((d) => { if (d !== "approve") state.done.delete(d); });
        apply(); v.say(`${b.textContent.trim()}: ${b.getAttribute("aria-pressed") === "true" ? "on" : "off"}.`);
      } else if (b.dataset.act) {
        const id = b.dataset.act; state.done.add(id);
        if (id === "changes") { state.done.delete("approve"); $$(F(), '[data-seq="approve"]').forEach((l) => { l.hidden = true; }); }
        if (id === "approve") { $$(F(), '[data-seq="changes"]').forEach((l) => { l.hidden = true; }); }
        play(id); go(state.i, false);
        if (id === "approve") { const n = $(v.fig, "[data-next]"); n && n.focus(); }
      }
    });
    init();
  };

  // Custom development: milestone payments, exact to the cent (the final payment absorbs rounding).
  engines.milestones = (v) => {
    const r = $(v.body, ".sv-ms__range");
    const upd = () => {
      const c = Math.round(Number(r.value) * 100), a = Math.round(c * 0.5), b = Math.round(c * 0.25), d = c - a - b;
      const fmt = (x) => "$" + (x / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      $(v.body, "[data-ms-value]").textContent = "$" + Number(r.value).toLocaleString("en-US");
      $(v.body, '[data-ms="50"]').textContent = fmt(a); $(v.body, '[data-ms="25a"]').textContent = fmt(b); $(v.body, '[data-ms="25b"]').textContent = fmt(d);
      r.setAttribute("aria-valuetext", `$${Number(r.value).toLocaleString("en-US")}: deposit ${fmt(a)}, after design ${fmt(b)}, before launch ${fmt(d)}`);
    };
    r.addEventListener("input", upd); upd();
  };

  // Portals: role switch re-evaluates every row from the same permission rules.
  engines.roles = (v) => {
    const WHO = { customer: ["Signed in as a customer (sample)", "Two-factor: optional"], staff: ["Signed in as staff (sample)", "Two-factor: required"], admin: ["Signed in as an administrator (sample)", "Two-factor: required"] };
    v.fig.addEventListener("click", (e) => {
      const b = e.target.closest(".sv__controls [data-key]"); if (!b) return; const role = b.dataset.key, R = $(v.body, ".sv-roles");
      R.dataset.role = role; v.pick(role); v.note(role);
      let n = 0; $$(R, "[data-roles]").forEach((li) => { const ok = li.dataset.roles.split(" ").includes(role); n += ok; li.toggleAttribute("data-denied", !ok); $(li, ".sv-roles__state").textContent = ok ? "Visible" : "No access"; });
      $(R, "[data-who]").textContent = WHO[role][0]; $(R, "[data-mfa]").textContent = WHO[role][1];
      const li = document.createElement("li"); li.textContent = `Switched to ${b.textContent.toLowerCase()} view · ${n} of 7 areas visible`; $(R, "[data-activity]").prepend(li);
      v.say(`${b.textContent} view: ${n} of 7 areas visible.`);
    });
  };

  // Booking: availability rules → open slots → selection → confirmation.
  engines.booking = (v) => {
    const B = $(v.body, ".sv-book"); let sel = null;
    const on = (k) => $(B, `[data-toggle="${k}"]`).getAttribute("aria-pressed") === "true";
    const order = ["8:00", "9:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
    // Slots use aria-disabled (not disabled) and a roving tabindex, so arrow keys can move across the whole week and
    // a screen reader hears why a time is unavailable; Tab enters and leaves the grid in one step.
    let focusSlot = null;
    const render = () => {
      let open = 0, first = null;
      $$(B, ".sv-slot").forEach((s) => {
        const d = s.dataset.day, t = s.dataset.time, prev = order[order.indexOf(t) - 1];
        let why = "";
        if (s.hasAttribute("data-busy")) why = "Busy";
        else if (on("hours") && (t === "8:00" || t === "17:00")) why = "Closed";
        else if (!on("sameday") && d === "Mon") why = "Same day";
        else if (on("buffer") && prev && prev !== "11:00" && $(B, `.sv-slot[data-day="${d}"][data-time="${prev}"][data-busy]`)) why = "Buffer";
        s.textContent = why; s.setAttribute("aria-disabled", String(!!why)); s.dataset.state = why ? why.toLowerCase().replace(" ", "-") : "open";
        s.setAttribute("aria-label", `${d} ${t}: ${why || "available"}`); if (!why) { open++; first = first || s; }
        if (sel === s && why) sel = null;
        s.setAttribute("aria-pressed", String(sel === s));
      });
      const roving = focusSlot || sel || first || $(B, ".sv-slot");
      $$(B, ".sv-slot").forEach((s) => { s.tabIndex = s === roving ? 0 : -1; });
      $(B, "[data-count]").textContent = `${open} open times this week under these rules.`;
      const c = $(B, "[data-confirm]"); c.innerHTML = "";
      const p = document.createElement("p");
      if (sel) {
        p.className = "sv-ok"; p.textContent = `${sel.dataset.day} ${sel.dataset.time} selected (demonstration — nothing is booked).`;
        const q = document.createElement("p"); q.className = "sv-small";
        q.textContent = on("deposit") ? "Next: a deposit is paid through the provider's hosted checkout, then the booking is confirmed and the calendar updated." : "Next: the booking is confirmed, the calendar updated and confirmation and reminder emails scheduled.";
        c.append(p, q);
      } else { p.className = "sv-small"; p.textContent = "Select an open time to see the confirmation."; c.append(p); }
      return open;
    };
    v.fig.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.toggle) { b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")); const n = render(); v.say(`${b.textContent}: ${b.getAttribute("aria-pressed") === "true" ? "on" : "off"}. ${n} open times.`); }
      else if (b.classList.contains("sv-slot")) {
        focusSlot = b;
        if (b.getAttribute("aria-disabled") === "true") { render(); v.say(`${b.dataset.day} ${b.dataset.time} is not available: ${b.textContent.toLowerCase()}.`); return; }
        sel = b; render(); v.say(`${b.dataset.day} ${b.dataset.time} selected.`);
      }
    });
    B.addEventListener("keydown", (e) => {
      const s = e.target.closest(".sv-slot"); if (!s) return;
      const all = $$(B, ".sv-slot"), i = all.indexOf(s), m = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 5, ArrowUp: -5 }[e.key];
      if (!m) return; const n = all[i + m]; if (!n) return;
      e.preventDefault(); focusSlot = n; all.forEach((x) => { x.tabIndex = x === n ? 0 : -1; }); n.focus();
    });
    render();
  };

  // Events (analytics and landing pages): interactions on a fictional page record named events.
  engines.events = (v) => {
    const t0 = Date.now();
    v.fig.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return; const E = $(v.body, ".sv-ev");
      if (b.dataset.ev) {
        const [name, params] = b.dataset.ev.split("|"); const log = $(E, "[data-evlog]"); $(log, ".sv-ev__empty")?.remove();
        const li = document.createElement("li"), n = document.createElement("code"), p = document.createElement("span");
        n.textContent = name; p.textContent = ` · ${params} · +${((Date.now() - t0) / 1000).toFixed(1)}s`; li.append(n, p); log.prepend(li);
        v.say(`Event recorded: ${name}.`);
        if (b.hasAttribute("data-open-form")) $(E, "[data-form]").setAttribute("data-on", "");
        if (b.hasAttribute("data-submit-form")) { $(E, "[data-form]").removeAttribute("data-on"); $(E, "[data-thanks]").setAttribute("data-on", ""); }
      } else if (b.hasAttribute("data-remove-access")) {
        const off = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", String(off));
        $(E, "[data-access]").textContent = off ? "Access removed — your business still owns every account and all data" : "Delegated access";
        v.say(off ? "Crestmont's access removed. You still own the accounts and data." : "Delegated access restored.");
      } else if (b.dataset.key) { $(E, ".sv-ev__site").dataset.device = b.dataset.key; v.pick(b.dataset.key); v.say(`${b.textContent} preview.`); }
      else if (b.hasAttribute("data-reset")) { v.reset(); v.say("Demonstration reset."); }
    });
  };

  // Performance: each optimisation changes the illustrative waterfall it acts on.
  engines.waterfall = (v) => {
    const W = $(v.body, ".sv-wf"), SCALE = 70;
    const on = (k) => $(W, `[data-toggle="${k}"]`).getAttribute("aria-pressed") === "true";
    const render = () => {
      const r = { html: [0, 10], css: [10, 10], font: [12, 14], hero: [12, 46], tag: [20, 24], app: [14, 22] };
      if (on("img")) r.hero = [12, 12];
      if (on("tags")) r.tag = [20, 8];
      if (on("cache")) { r.css[1] = 4; r.font[1] = 5; r.app[1] = 9; r.css[0] = 10; }
      const fcpBase = Math.max(r.html[0] + r.html[1], r.css[0] + r.css[1]);
      if (on("defer")) r.app = [fcpBase + 2, r.app[1]];
      const fcp = on("defer") ? fcpBase : Math.max(fcpBase, r.app[0] + r.app[1]);
      const end = Math.max(...Object.values(r).map(([s, d]) => s + d));
      Object.entries(r).forEach(([id, [s, d]]) => { const bar = $(W, `[data-res="${id}"] .sv-wf__bar`); bar.style.setProperty("--s", String((s / SCALE) * 100)); bar.style.setProperty("--d", String((d / SCALE) * 100)); });
      $(W, '[data-res="app"] .sv-wf__label').textContent = on("defer") ? "Page script (deferred)" : "Page script (render-blocking)";
      $(W, '[data-res="hero"] .sv-wf__label').textContent = on("img") ? "Hero image (compressed)" : "Hero image (oversized)";
      $(W, '[data-mark="first"]').style.setProperty("--at", String((fcp / SCALE) * 100));
      $(W, '[data-mark="end"]').style.setProperty("--at", String((end / SCALE) * 100));
      const sh = $(W, "[data-shift]"); sh.textContent = on("space") ? "No layout shift: space is reserved before the image arrives" : "Layout shift: the hero image pushes text down as it loads"; sh.classList.toggle("is-ok", on("space"));
      return { fcp, end };
    };
    W.addEventListener("click", (e) => {
      const b = e.target.closest("[data-toggle]"); if (!b) return;
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")); const t = render();
      v.say(`${b.textContent}: ${b.getAttribute("aria-pressed") === "true" ? "on" : "off"}. First content at ${Math.round((t.fcp / SCALE) * 100)}% and fully loaded at ${Math.round((t.end / SCALE) * 100)}% of the original scale.`);
    });
    render();
  };

  // AI receptionist control centre: a scripted, clearly simulated call. Lines play in order (or step with Next line);
  // each line's data-effect updates the call state and the connected systems. Text-only, so it works without sound.
  engines.receptionist = (v) => {
    const R = () => $(v.body, ".rc");
    let i = 0, playing = false, secs = 0, started = false, quiet = true; // quiet: no line-by-line announcements until the visitor interacts
    const scn = () => $(R(), `.rc-scn[data-scn="${R().dataset.scenario}"]`);
    const lines = () => $$(scn(), ".rc-line");
    const btn = () => $(v.fig, "[data-play]");
    const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    const setState = (t) => { $(R(), "[data-call-state]").textContent = t; };
    const sys = (k, val) => { const el = $(R(), `[data-sys="${k}"]`); if (!el) return; $(el, "[data-sys-val]").textContent = val; el.classList.remove("is-pulse"); void el.offsetWidth; el.classList.add("is-pulse", "is-set"); };
    // The call clock is simulated: each spoken line adds its speaking time, so it reads the same with or without motion.
    const clock = (add) => { secs += add; $(R(), "[data-timer]").textContent = fmt(Math.round(secs)); };
    const apply = (effect) => (effect || "").split(";").filter(Boolean).forEach((e) => {
      const eq = e.indexOf("=");
      if (eq > 0) { sys(e.slice(0, eq), e.slice(eq + 1)); return; }
      if (e === "checks") $$(scn(), "[data-check]").forEach((c) => c.classList.add("is-ok"));
      else if (e === "call:dialing") { R().dataset.state = "dialing"; setState("Dialing… (simulated)"); }
      else if (e === "call:connected") { R().dataset.state = "live"; setState("Connected · AI receptionist on the line"); }
      else if (e === "call:ended") { R().dataset.state = "ended"; setState("Call completed"); speak(null); }
      else if (e === "summary") $(scn(), "[data-summary]").classList.add("is-in");
    });
    const speak = (who) => {
      R().dataset.speaking = who || "";
      $(R(), "[data-speaker]").textContent = who === "ai" ? "AI receptionist speaking" : who === "caller" ? (R().dataset.mode === "outbound" ? "Customer speaking" : "Caller speaking") : "—";
    };
    const scrollLog = () => { const box = $(R(), "[data-scroll]"); box.scrollTop = box.scrollHeight; };
    const show = (n) => {
      const ls = lines(); const li = ls[n]; if (!li) return false;
      li.classList.add("is-in"); apply(li.dataset.effect); speak(li.dataset.who === "system" ? null : li.dataset.who);
      if (li.dataset.who !== "system" && R().dataset.state === "live") clock(durationOf(li) / 1000 * 1.6);
      scrollLog();
      if (!quiet) v.say(`${$(li, ".rc-line__who").textContent}: ${$(li, ".rc-line__text").textContent}`);
      return true;
    };
    const durationOf = (li) => li.dataset.who === "system" ? 950 : Math.min(4200, 750 + $(li, ".rc-line__text").textContent.length * 27);
    const loop = () => {
      if (!playing) return;
      if (i >= lines().length) { playing = false; btn().textContent = "Play again"; return; }
      const li = lines()[i]; show(i); i++;
      v.later(durationOf(li), loop);
    };
    const reset = (keep) => {
      playing = false; i = 0; secs = 0; v.reset();
      const r = R(); if (keep) { r.dataset.mode = keep.mode; r.dataset.scenario = keep.scenario; }
      selectUI(); setState("Ready — press Play to start the simulated call");
    };
    const selectUI = () => {
      const r = R(), mode = r.dataset.mode || "inbound";
      r.dataset.mode = mode;
      $$(r, "[data-mode-btn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.modeBtn === mode)));
      $$(r, "[data-scn-btn]").forEach((b) => { b.hidden = b.dataset.mode !== mode; b.setAttribute("aria-pressed", String(b.dataset.scnBtn === r.dataset.scenario)); });
      $$(r, ".rc-scn").forEach((x) => x.toggleAttribute("data-on", x.dataset.scn === r.dataset.scenario));
      const sc = scn();
      $(r, "[data-caller]").textContent = sc.dataset.caller;
      $(r, "[data-number]").textContent = sc.dataset.number;
      r.dataset.state = "idle"; speak(null); $(r, "[data-timer]").textContent = "00:00";
      btn().textContent = "Play call";
    };
    v.fig.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.modeBtn) { const first = $(v.fig, `[data-scn-btn][data-mode="${b.dataset.modeBtn}"]`); reset({ mode: b.dataset.modeBtn, scenario: first.dataset.scnBtn }); v.say(`${b.textContent} calls. Scenario: ${first.textContent}.`); }
      else if (b.dataset.scnBtn) { reset({ mode: b.dataset.mode, scenario: b.dataset.scnBtn }); v.say(`Scenario: ${b.textContent}. Press Play call to start.`); }
      else if (b.hasAttribute("data-play")) {
        if (playing) { playing = false; b.textContent = "Resume call"; v.say("Paused."); return; }
        if (i >= lines().length) { const keep = { mode: R().dataset.mode, scenario: R().dataset.scenario }; reset(keep); }
        playing = true; btn().textContent = "Pause"; loop();
      } else if (b.hasAttribute("data-step")) {
        playing = false; btn().textContent = i ? "Resume call" : "Play call";
        if (i >= lines().length) { v.say("End of the call. Replay to start again."); return; }
        show(i); i++; if (i >= lines().length) btn().textContent = "Play again";
      } else if (b.hasAttribute("data-reset")) { reset({ mode: R().dataset.mode, scenario: R().dataset.scenario }); v.say("Ready to replay."); }
    });
    selectUI();
    // The console comes alive as it scrolls into view: the call starts by itself (Pause is always available). With
    // reduced motion it shows the completed call at once instead — a complete state without timed movement.
    const begin = () => {
      if (started) return; started = true;
      if (reduce.matches) { while (i < lines().length) { show(i); i++; } btn().textContent = "Play again"; return; }
      playing = true; btn().textContent = "Pause"; loop();
    };
    v.fig.addEventListener("click", () => { started = true; quiet = false; }, true);
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => { if (es.some((x) => x.intersectionRatio >= 0.45)) { io.disconnect(); begin(); } }, { threshold: [0, 0.45] });
      io.observe(v.fig);
    }
  };

  // Voice styles: a radio group (arrow keys move and select). Preview is text + waveform — no audio until a provider
  // is approved, and the page says so.
  engines.voices = (v) => {
    const L = $(v.body, ".vl"), items = $$(L, "[data-voice-btn]");
    const pick = (b, focus) => {
      items.forEach((x) => { const on = x === b; x.setAttribute("aria-checked", String(on)); x.tabIndex = on ? 0 : -1; });
      L.dataset.voice = b.dataset.voiceBtn;
      $$(L, "[data-voice-card]").forEach((c) => c.toggleAttribute("data-on", c.dataset.voiceCard === b.dataset.voiceBtn));
      const card = $(L, `[data-voice-card="${b.dataset.voiceBtn}"]`);
      card.classList.remove("is-speaking"); void card.offsetWidth; card.classList.add("is-speaking");
      v.later(2600, () => card.classList.remove("is-speaking"));
      if (focus) b.focus();
      v.say(`${$(b, ".vl__name").textContent}. Sample line: ${$(card, ".vl__line").textContent}`);
    };
    L.addEventListener("click", (e) => { const b = e.target.closest("[data-voice-btn]"); if (b) pick(b, false); });
    L.addEventListener("keydown", (e) => {
      const b = e.target.closest("[data-voice-btn]"); if (!b) return;
      const k = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]; if (!k) return;
      e.preventDefault(); pick(items[(items.indexOf(b) + k + items.length) % items.length], true);
    });
  };

  const start = () => $$(document, "[data-sv]").forEach((fig) => {
    if (fig.hasAttribute("data-js")) return;
    const kind = fig.dataset.sv.split(" ")[0]; const eng = engines[kind];
    if (eng) try { eng(setup(fig)); } catch (err) { fig.removeAttribute("data-js"); console.error("[services]", err); }
  });
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", start) : start();
})();
