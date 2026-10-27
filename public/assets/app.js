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
})();
