// Northwind Pottery Studio — synthetic E2E delivery fixture. Plain, dependency-free interactions the E2E exercises.
(function () {
  document.documentElement.setAttribute("data-fixture-js", "ready");
  var toggle = document.querySelector("[data-fixture-toggle]");
  var panel = document.querySelector("[data-fixture-panel]");
  if (toggle && panel) {
    toggle.addEventListener("click", function () {
      var open = panel.hasAttribute("hidden");
      if (open) panel.removeAttribute("hidden"); else panel.setAttribute("hidden", "");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "Hide class times" : "Show class times";
    });
  }
  var reserve = document.querySelector("[data-fixture-reserve]");
  var count = document.querySelector("[data-fixture-count]");
  if (reserve && count) {
    reserve.addEventListener("click", function () {
      var n = parseInt(count.textContent, 10);
      if (n > 0) count.textContent = String(n - 1);
      if (n - 1 <= 0) { reserve.disabled = true; reserve.textContent = "Fully booked"; }
    });
  }
})();
