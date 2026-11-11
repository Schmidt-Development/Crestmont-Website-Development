// Staff → Portfolio display order (Founder, 2026-11-11). Drag a project by its handle with a mouse, pen or finger (pointer
// events, so it works on touch screens), or focus the handle and press the arrow keys. The new order is written into the
// Save order form; nothing changes until the Owner saves. Without JavaScript the Up / Down buttons still work.
(() => {
  const list = document.querySelector("[data-pf-order]");
  const input = document.querySelector("[data-pf-order-input]");
  const status = document.querySelector("[data-pf-status]");
  if (!list || !input) return;
  const saved = input.value;
  const items = () => [...list.querySelectorAll("[data-pf-id]")];
  const sync = () => {
    items().forEach((li, i) => { const pos = li.querySelector("[data-pf-pos]"); if (pos) pos.textContent = String(i + 1); });
    input.value = items().map((li) => li.dataset.pfId).join(",");
    if (status) status.textContent = input.value === saved ? "" : "Order changed — press Save order to keep it.";
  };
  const announce = (li) => { if (status) status.textContent = `${li.querySelector("a")?.textContent ?? "Project"} moved to position ${items().indexOf(li) + 1} of ${items().length}. Press Save order to keep it.`; };

  list.addEventListener("keydown", (e) => {
    const h = e.target.closest("[data-pf-handle]");
    if (!h || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const li = h.closest("[data-pf-id]");
    const sib = e.key === "ArrowUp" ? li.previousElementSibling : li.nextElementSibling;
    if (!sib) return;
    if (e.key === "ArrowUp") list.insertBefore(li, sib); else list.insertBefore(sib, li);
    h.focus(); sync(); announce(li);
  });

  let drag = null;
  list.addEventListener("pointerdown", (e) => {
    const h = e.target.closest("[data-pf-handle]");
    if (!h || e.button > 0) return;
    e.preventDefault();
    const li = h.closest("[data-pf-id]");
    drag = { li, id: e.pointerId };
    li.classList.add("is-dragging");
    h.setPointerCapture(e.pointerId);
  });
  // The dragged project goes before the first other project whose middle is below the pointer (or last), so a fast
  // drag, a drag above or below the list, or one released in the gap between cards all land where the pointer is.
  const place = (y) => {
    const before = items().find((x) => x !== drag.li && (() => { const r = x.getBoundingClientRect(); return y < r.top + r.height / 2; })());
    if ((before ?? null) !== drag.li.nextElementSibling) { list.insertBefore(drag.li, before ?? null); sync(); }
  };
  // Held near the top or bottom of the screen, the page keeps scrolling (a finger held still sends no move events), so
  // a long list can be reordered on a phone.
  const EDGE = 60;
  const tick = () => {
    if (!drag) return;
    const dy = drag.y < EDGE ? -14 : drag.y > window.innerHeight - EDGE ? 14 : 0;
    if (dy) { const before = window.scrollY; window.scrollBy(0, dy); if (window.scrollY !== before) place(drag.y); }
    drag.raf = requestAnimationFrame(tick);
  };
  list.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    drag.y = e.clientY;
    place(e.clientY);
    if (!drag.raf) drag.raf = requestAnimationFrame(tick);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.raf) cancelAnimationFrame(drag.raf);
    drag.li.classList.remove("is-dragging");
    announce(drag.li);
    drag = null;
  };
  list.addEventListener("pointerup", end);
  list.addEventListener("pointercancel", end);
})();
