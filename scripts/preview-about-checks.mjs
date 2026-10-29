// About · "How our capabilities connect": every selection, at the caller's viewport, checked from the rendered page.
// A node's complete box (label + selected ring + focus ring) must lie inside the diagram panel, clear of the core and
// of other nodes, labels untruncated and readable, connectors attached to the node and core centres, and the detail
// panel must follow the selection. Keyboard arrows move the selection with a visible focus ring.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function checkConstellation(p, base, label, ok, { touch = false } = {}) {
  await p.goto(base + "/about", { waitUntil: "domcontentloaded" });
  const fig = p.locator("#sv-constellation");
  await fig.scrollIntoViewIfNeeded(); await sleep(300);
  const keys = await p.$$eval("#sv-constellation [data-cst]", (n) => n.map((x) => x.dataset.cst));
  const problems = [];
  let layout = "";
  for (const k of keys) {
    const node = p.locator(`#sv-constellation [data-cst=${k}]`);
    if (touch) await node.tap(); else await node.click();
    await sleep(150);
    const r = await p.evaluate((k) => {
      const C = document.querySelector("#sv-constellation .cst"), st = C.querySelector(".cst__stage").getBoundingClientRect(), svg = C.querySelector(".cst__lines").getBoundingClientRect();
      const M = 6, pr = []; // selected ring 6px; focus ring 3px offset + 2px outline
      const nodes = [...C.querySelectorAll("[data-cst]")].map((n) => ({ k: n.dataset.cst, el: n, r: n.getBoundingClientRect() }));
      const core = C.querySelector(".cst__core").getBoundingClientRect();
      const ov = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      for (const n of nodes) {
        if (n.r.left - M < st.left - 0.5 || n.r.right + M > st.right + 0.5 || n.r.top - M < st.top - 0.5 || n.r.bottom + M > st.bottom + 0.5) pr.push(`${n.k} outside the panel`);
        if (n.el.scrollWidth > n.el.clientWidth + 1) pr.push(`${n.k} label truncated`);
        if (parseFloat(getComputedStyle(n.el).fontSize) < 12) pr.push(`${n.k} text below 12px`);
        if (ov(n.r, core)) pr.push(`${n.k} overlaps the core`);
        for (const o of nodes) if (o.k > n.k && ov(n.r, o.r)) pr.push(`${n.k}/${o.k} overlap`);
        const sp = C.querySelector(`[data-spoke="${n.k}"]`);
        const pt = (x, y) => [svg.left + x.baseVal.value / 100 * svg.width, svg.top + y.baseVal.value / 100 * svg.height];
        const [x2, y2] = pt(sp.x2, sp.y2), [x1, y1] = pt(sp.x1, sp.y1);
        if (Math.abs(x2 - (n.r.left + n.r.width / 2)) > 1.5 || Math.abs(y2 - (n.r.top + n.r.height / 2)) > 1.5) pr.push(`${n.k} connector detached`);
        if (Math.abs(x1 - (core.left + core.width / 2)) > 1.5 || Math.abs(y1 - (core.top + core.height / 2)) > 1.5) pr.push("connector not from the core");
      }
      const sel = C.querySelector('[aria-pressed="true"]')?.dataset.cst, det = C.querySelector(".cst__detail[data-on]")?.dataset.cstDetail;
      if (sel !== k || det !== k) pr.push(`selecting ${k} → pressed ${sel}, detail ${det}`);
      if (!C.querySelector(`[data-spoke="${k}"]`).classList.contains("is-on")) pr.push(`${k} connector not highlighted`);
      if (document.documentElement.scrollWidth > innerWidth) pr.push(`page overflows by ${document.documentElement.scrollWidth - innerWidth}px`);
      return { pr, layout: C.dataset.layout };
    }, k);
    problems.push(...r.pr); layout = r.layout;
  }
  ok(problems.length === 0, `${label} About diagram: all ${keys.length} selections — nodes, labels, rings and connectors inside the panel (${layout} layout)${problems.length ? ` — ${[...new Set(problems)].slice(0, 4).join("; ")}` : ""}`);
  if (!touch) {
    await p.locator("#sv-constellation [data-cst=design]").focus(); await p.keyboard.press("ArrowLeft");
    const kb = await p.evaluate(() => { const a = document.activeElement, st = document.querySelector("#sv-constellation .cst__stage").getBoundingClientRect(), r = a.getBoundingClientRect(), cs = getComputedStyle(a);
      return { a: a.dataset.cst, sel: document.querySelector('#sv-constellation [aria-pressed="true"]').dataset.cst, ring: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2, inside: r.left - 5 >= st.left - 0.5 && r.right + 5 <= st.right + 0.5 }; });
    ok(kb.a === "care" && kb.sel === "care" && kb.ring && kb.inside, `${label} About diagram: arrow keys move the selection; the focus ring is visible and inside the panel`);
  }
  await p.locator("#sv-constellation").screenshot({ path: `${process.env.PREVIEW_SHOTS ?? "."}/about-constellation-${label.replace(/\W+/g, "-")}.png` }).catch(() => {});
}
