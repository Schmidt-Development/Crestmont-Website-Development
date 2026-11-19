// Crestmont portfolio visibility protocol (Owner, 2026-11-19 — identical copy in every starter; runner/test/
// embedding-standard.test.ts keeps them identical). When this website is shown inside Crestmont's portfolio
// (https://crestmontwebsitedevelopment.com), the portfolio tells it whether it is the project a visitor is looking at.
// While it is not, the site pauses its own CSS animations and announces it, so background animation loops can rest
// (listen for the "crestmont:visibility" event, or read document.documentElement.dataset.crestmontVisible).
// Accepted only from Crestmont's exact origins and only from the window that frames this page; nothing else changes,
// nothing is sent back, and outside Crestmont's portfolio this script does nothing.
(() => {
  const ORIGINS = ["https://crestmontwebsitedevelopment.com", "https://www.crestmontwebsitedevelopment.com"];
  if (window.parent === window) return;
  const style = document.createElement("style");
  style.textContent = 'html[data-crestmont-visible="false"] *, html[data-crestmont-visible="false"] *::before, html[data-crestmont-visible="false"] *::after { animation-play-state: paused !important; }';
  document.head.append(style);
  addEventListener("message", (e) => {
    if (!ORIGINS.includes(e.origin) || e.source !== window.parent) return;
    const d = e.data;
    if (!d || typeof d !== "object" || d.source !== "crestmont-portfolio" || d.type !== "visibility" || typeof d.visible !== "boolean") return;
    document.documentElement.dataset.crestmontVisible = String(d.visible);
    dispatchEvent(new CustomEvent("crestmont:visibility", { detail: { visible: d.visible } }));
  });
})();
