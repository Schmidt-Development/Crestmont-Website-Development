// Simulated transactions inside each embedded portfolio demo, driven the way a visitor would (typing and clicking in
// the explorer's frame). Synthetic values only; every demo answers from its own disposable database and says that
// nothing was sent, booked or charged. Used by scripts/frontend-browser-check.mjs; each flow returns a short
// description of what completed, or throws with the step that failed.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A visitor scrolls inside the demo to reach a control before using it; the demo's own scrollIntoView keeps that
 *  scrolling inside the frame, so the automation never has to move the Crestmont page to reach it. */
const reveal = (l) => l.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" })).catch(() => {});
const click = async (l) => { await reveal(l); await l.click(); };

/** Fills the visible fields of `scope` (Page, Frame or Locator) by typing, with synthetic values. */
export async function fillVisible(scope) {
  const plan = await scope.evaluate(() => {
    const root = document;
    const vis = (e) => e.offsetParent !== null && !e.disabled && !e.readOnly;
    const val = (e) => {
      const k = `${e.name} ${e.id} ${e.placeholder} ${e.getAttribute("aria-label") || ""} ${e.labels?.[0]?.textContent || ""}`.toLowerCase();
      if (e.type === "email" || /e-?mail/.test(k)) return "visitor@example.com";
      if (e.type === "tel" || /phone|mobile/.test(k)) return "(517) 555-0142";
      if (/\bvin\b/.test(k)) return "4S4BTAFCXM3123456"; if (/zip|postal/.test(k)) return "48906"; if (/year/.test(k)) return "2018";
      if (/make/.test(k)) return "Honda"; if (/model/.test(k)) return "Civic"; if (/mile|odometer/.test(k)) return "60000";
      if (/last/.test(k)) return "Visitor"; if (/full ?name/.test(k)) return "Demo Visitor"; if (/first|your name|\bname\b/.test(k)) return "Demo";
      if (/city/.test(k)) return "Lansing"; if (/website|url|company|business/.test(k)) return null;
      if (e.type === "number") return "1"; if (e.type === "date") return new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
      if (e.tagName === "TEXTAREA") return "Portfolio demonstration — synthetic test entry."; return null;
    };
    const out = []; let i = 0;
    for (const e of root.querySelectorAll("input, textarea, select")) {
      if (!vis(e) || e.type === "hidden") continue;
      const tag = `pf${Date.now().toString(36)}${i++}`; e.setAttribute("data-pf-fill", tag);
      if (e.tagName === "SELECT") { if (!e.value) { const o = [...e.options].find((o) => o.value && !o.disabled); if (o) out.push({ tag, op: "select", v: o.value }); } continue; }
      if (e.type === "radio") { if (!root.querySelector(`input[type=radio][name="${CSS.escape(e.name)}"]:checked`) && !out.some((x) => x.radio === e.name)) out.push({ tag, op: "check", radio: e.name }); continue; }
      if (e.type === "checkbox") { if (!e.checked && (e.required || /agree|ack|consent|policy|terms|privacy/i.test(`${e.name} ${e.labels?.[0]?.textContent}`))) out.push({ tag, op: "check" }); continue; }
      if (["submit", "button", "file", "range", "color", "search"].includes(e.type)) continue;
      if (!e.value) { const v = val(e); if (v) out.push({ tag, op: "fill", v }); }
    }
    return out;
  });
  const page = scope.page ? scope : scope;
  for (const s of plan) {
    const l = page.locator(`[data-pf-fill="${s.tag}"]`);
    try { await reveal(l); if (s.op === "fill") await l.fill(s.v); else if (s.op === "select") await l.selectOption(s.v); else await l.evaluate((el) => { if (!el.checked) el.click(); }); } catch { /* best effort */ }
  }
  return plan.length;
}

const text = async (f) => (await f.locator("body").innerText()).replace(/\s+/g, " ");
const path = (f) => new URL(f.url()).pathname;
async function waitPath(f, re, what, ms = 20_000) {
  const t0 = Date.now();
  while (!re.test(path(f))) { if (Date.now() - t0 > ms) throw new Error(`${what}: still on ${path(f)}`); await sleep(250); }
}

/** A day button with open times, then the first enabled time. */
async function pickSlot(f, dayRe, timeRe) {
  const days = f.locator("main button", { hasText: dayRe }).filter({ visible: true });
  // The calendar loads its availability after the page; give it time before deciding there is none.
  for (let k = 0; k < 40 && !(await days.count()); k++) await sleep(500);
  const n = await days.count();
  for (let d = 0; d < Math.min(n, 12); d++) {
    await click(days.nth(d)); await sleep(300);
    const t = f.locator("main button:not([disabled])", { hasText: timeRe }).filter({ visible: true });
    if (await t.count()) { await click(t.first()); await sleep(250); return; }
  }
  const seen = await f.evaluate(() => [...document.querySelectorAll("main button")].filter((b) => b.offsetParent).map((b) => `${b.disabled ? "×" : ""}${b.textContent.trim().replace(/\s+/g, " ").slice(0, 14)}`).slice(0, 24).join(", "));
  const page = (await f.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
  const msg = (page.match(/[^.]*(no (open )?times?|unavailable|could not|couldn.t|error|try again|closed)[^.]*\./i) || [""])[0].slice(0, 200);
  const api = await f.evaluate(() => performance.getEntriesByType("resource").filter((e) => /avail|slot|calendar|schedule|times/i.test(e.name)).map((e) => `${new URL(e.name).pathname} ${e.responseStatus ?? ""}`).slice(-4).join(", "));
  throw new Error(`no open time found among ${n} day(s); page says: "${msg || page.slice(0, 160)}"; availability requests: ${api || "none"}; buttons: ${seen}`);
}

export const FLOWS = {
  // lansingcarrentals.com: partner application → book the call (simulated calendar, emails to the test outbox).
  "Lansing Car Rentals": async (f) => {
    await f.goto(new URL("/partner/apply", f.url()).toString());
    for (let k = 0; k < 3; k++) await fillVisible(f.locator("#apply-form"));
    if (await f.locator("[name=cash_amount]").isVisible()) { await reveal(f.locator("[name=cash_amount]")); await f.locator("[name=cash_amount]").fill("100000"); }
    await click(f.locator("#apply-form button[type=submit]"));
    await waitPath(f, /^\/partner\/schedule/, "application");
    await pickSlot(f, /open/, /^\d{1,2}:\d\d\s?(AM|PM)$/i);
    await click(f.locator("main button", { hasText: "Confirm my call" }));
    await waitPath(f, /^\/partner\/status/, "call booking");
    const t = await text(f);
    if (!/Your call is booked/.test(t) || !/TEST MODE/.test(t)) throw new Error("confirmation or test-mode notice missing");
    return "partner application saved and call booked on the simulated calendar (emails to the demo's test outbox)";
  },
  // mentorship.lansingcarrentals.com: book a paid call → simulated checkout → confirmation → captured emails.
  "Lansing Car Rentals Mentorship": async (f) => {
    await f.goto(new URL("/book", f.url()).toString());
    await pickSlot(f, /open/, /^\d{1,2}:\d\d\s?(AM|PM)$/i);
    await fillVisible(f);
    await click(f.locator("button[type=submit]").last());
    await waitPath(f, /^\/__demo\/checkout\//, "checkout");
    if (!/no card details are requested and nothing is charged/.test(await text(f))) throw new Error("simulated-checkout notice missing");
    await click(f.locator("button", { hasText: "Simulate successful payment" }));
    await waitPath(f, /^\/booking\/confirmed/, "payment");
    const t = await text(f);
    if (!/Simulated booking/.test(t) || !/BOOKING CONFIRMED/i.test(t)) throw new Error("confirmation missing");
    await click(f.locator("a", { hasText: "See the emails the live site would send" }));
    await waitPath(f, /^\/__demo\/outbox/, "outbox");
    return "call booked → simulated checkout → simulated payment → confirmation; emails captured in the demo outbox, nobody received them";
  },
  // glasslyautoglass.com: instant quote with synthetic pricing → the customer's quote page.
  "Glassly Auto Glass": async (f) => {
    await click(f.locator("a[href='#quote']").first()); await sleep(600);
    await fillVisible(f.locator("#quote-form"));
    await click(f.locator("#quote-form button[type=submit]"));
    const t0 = Date.now(); let t = "";
    while (!/Quote GL-/.test(t)) { if (Date.now() - t0 > 20_000) throw new Error("no quote shown"); await sleep(400); t = await text(f); }
    if (!/synthetic sample/.test(t)) throw new Error("synthetic-price label missing");
    await click(f.locator("a", { hasText: /Book My Replacement/i }).first());
    await waitPath(f, /^\/__demo\/quote\//, "quote link");
    return "instant quote with a labelled synthetic price (nothing saved or emailed) → the customer quote page inside the demo";
  },
  // betterlansingmechanics.com: 5-step appointment wizard → simulated Stripe checkout → confirmed booking.
  "Better Lansing Mechanics": async (f) => {
    await f.goto(new URL("/book", f.url()).toString());
    for (let step = 0; step < 8; step++) {
      if (/^\/__demo\/checkout\//.test(path(f))) break;
      await fillVisible(f);
      if (await f.locator("main button", { hasText: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d/ }).filter({ visible: true }).count()) await pickSlot(f, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d/, /^\d{1,2}:\d\d\s?(AM|PM)$/i);
      const cont = f.locator("main button", { hasText: /^(Continue|Next|Review)/ }).filter({ visible: true }).first();
      const sub = f.locator("main button", { hasText: /pay|book|confirm|checkout/i }).filter({ visible: true }).first();
      if (await cont.count()) await click(cont); else if (await sub.count()) await click(sub); else break;
      await sleep(900);
    }
    await waitPath(f, /^\/__demo\/checkout\//, "booking wizard");
    if (!/nothing is charged|no card details/i.test(await text(f))) throw new Error("simulated-checkout notice missing");
    await click(f.locator("button", { hasText: "Simulate successful payment" }));
    await waitPath(f, /^\/book\/confirmed/, "payment");
    if (!/Simulated booking/.test(await text(f))) throw new Error("simulated-booking notice missing");
    return "appointment wizard → simulated checkout → simulated payment → confirmed booking (no real appointment, charge or message)";
  },
};
