// Progressive enhancement for every page: navigation toggle, API forms (data-api), booking flow, manage page.
// Forms post JSON to the site's own /api/* endpoints and show loading, field errors, success and failure states.
// Nothing here fakes a result: every success message is the server's answer.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function setStatus(el, kind, text) {
  if (!el) return;
  el.dataset.kind = kind;
  el.textContent = text;
  if (text) el.focus?.();
}

async function api(path, { method = "GET", body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), "x-requested-with": "fetch", ...headers }, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  } catch {
    return { ok: false, status: 0, data: { error: { message: "We could not reach the server. Check your connection and try again." } } };
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

function fieldErrors(form, fields = {}) {
  for (const el of $$("[aria-invalid]", form)) el.removeAttribute("aria-invalid");
  for (const el of $$(".field-error", form)) el.remove();
  for (const [name, message] of Object.entries(fields)) {
    const input = form.elements.namedItem(name);
    if (!input || !(input instanceof HTMLElement)) continue;
    input.setAttribute("aria-invalid", "true");
    const p = document.createElement("p");
    p.className = "field-error";
    p.id = `${input.id || name}-error`;
    p.textContent = message;
    input.setAttribute("aria-describedby", p.id);
    input.insertAdjacentElement("afterend", p);
  }
}

const idemKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

/** Any <form data-api="/api/…"> becomes a JSON form with full state handling. */
function enhanceForms() {
  for (const form of $$("form[data-api]")) {
    const status = $(".status", form) ?? form.insertAdjacentElement("afterbegin", Object.assign(document.createElement("div"), { className: "status", tabIndex: -1, role: "status" }));
    let key = idemKey();
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const button = $("button[type=submit]", form);
      const body = Object.fromEntries(new FormData(form).entries());
      button?.setAttribute("disabled", "");
      setStatus(status, "info", form.dataset.sending ?? "Sending…");
      const r = await api(form.dataset.api, { method: "POST", body, headers: { "idempotency-key": key } });
      button?.removeAttribute("disabled");
      if (r.ok) {
        fieldErrors(form);
        form.reset();
        key = idemKey();
        const ref = r.data?.quote?.reference ? ` Your reference is ${r.data.quote.reference}.` : "";
        setStatus(status, "success", (form.dataset.success ?? "Thank you. We received your message.") + ref);
      } else {
        fieldErrors(form, r.data?.error?.fields);
        setStatus(status, "error", r.data?.error?.message ?? "Something went wrong. Please try again.");
      }
    });
  }
}

function enhanceNav() {
  const btn = $(".nav-toggle");
  const nav = $(".site-nav");
  if (!btn || !nav) return;
  btn.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    btn.setAttribute("aria-expanded", String(open));
  });
}

const money = (cents, currency = "usd") => new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

/** <section data-booking> : service → date → time → details → booked (and Checkout when the service is paid online). */
async function enhanceBooking() {
  const root = $("[data-booking]");
  if (!root) return;
  const status = $(".status", root);
  const svcSel = $("select[name=serviceId]", root);
  const dateIn = $("input[name=date]", root);
  const slotsEl = $(".slots", root);
  const form = $("form", root);
  let chosen = null;
  const [svcRes, cfgRes] = await Promise.all([api("/api/services"), api("/api/config")]);
  if (!svcRes.ok) { setStatus(status, "error", "Online booking is unavailable right now. Please call us."); return; }
  const services = svcRes.data.services.filter((s) => s.bookable);
  if (!services.length) { setStatus(status, "info", "No services can be booked online at the moment. Please call us."); return; }
  svcSel.replaceChildren(...services.map((s) => new Option(`${s.name}${s.priceCents ? ` — ${money(s.priceCents, cfgRes.data?.payments?.currency)}` : s.priceNote ? ` — ${s.priceNote}` : ""}`, s.id)));
  const today = new Date();
  dateIn.min = today.toISOString().slice(0, 10);
  const max = cfgRes.data?.booking?.maxDaysAhead ?? 60;
  dateIn.max = new Date(today.getTime() + max * 864e5).toISOString().slice(0, 10);
  const tz = cfgRes.data?.business?.timeZone;
  const fmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz });
  async function load() {
    chosen = null;
    form.hidden = true;
    if (!dateIn.value) { slotsEl.replaceChildren(); return; }
    slotsEl.replaceChildren(Object.assign(document.createElement("p"), { className: "loading", textContent: "Loading available times" }));
    const r = await api(`/api/availability?service=${encodeURIComponent(svcSel.value)}&date=${dateIn.value}`);
    if (!r.ok) { slotsEl.replaceChildren(); setStatus(status, "error", r.data?.error?.message ?? "Could not load times."); return; }
    setStatus(status, "info", "");
    if (!r.data.slots.length) { slotsEl.replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "No times are available that day. Please try another date." })); return; }
    slotsEl.replaceChildren(...r.data.slots.map((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = fmt.format(new Date(s.start));
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => {
        for (const x of $$("button", slotsEl)) x.setAttribute("aria-pressed", "false");
        b.setAttribute("aria-pressed", "true");
        chosen = s.start;
        form.hidden = false;
        $("input,textarea", form)?.focus();
      });
      return b;
    }));
  }
  svcSel.addEventListener("change", load);
  dateIn.addEventListener("change", load);
  let key = idemKey();
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!chosen) { setStatus(status, "error", "Choose a time first."); return; }
    const body = { ...Object.fromEntries(new FormData(form).entries()), serviceId: svcSel.value, start: chosen };
    const button = $("button[type=submit]", form);
    button.setAttribute("disabled", "");
    setStatus(status, "info", "Booking…");
    const r = await api("/api/bookings", { method: "POST", body, headers: { "idempotency-key": key } });
    button.removeAttribute("disabled");
    if (!r.ok) { fieldErrors(form, r.data?.error?.fields); setStatus(status, "error", r.data?.error?.message ?? "Could not book. Please try again."); if (r.status === 409) load(); return; }
    key = idemKey();
    const b = r.data.booking;
    sessionStorage.setItem(`manage:${b.reference}`, r.data.manageToken);
    if (b.paymentRequired) {
      setStatus(status, "info", "Taking you to secure payment…");
      const c = await api(`/api/bookings/${b.reference}/checkout`, { method: "POST", body: {}, headers: { "x-manage-token": r.data.manageToken } });
      if (c.ok && c.data.url) { location.assign(c.data.url); return; }
      setStatus(status, "error", c.data?.error?.message ?? "Payment could not be started. Your time is held for 30 minutes; open the link in your email to pay.");
      return;
    }
    location.assign(`/booking/manage.html?ref=${encodeURIComponent(b.reference)}&new=1#token=${r.data.manageToken}`);
  });
}

/** /booking/manage.html and /booking/confirmation.html: status from the server, cancel / reschedule. */
async function enhanceManage() {
  const root = $("[data-manage]");
  if (!root) return;
  const status = $(".status", root);
  const params = new URLSearchParams(location.search);
  const ref = params.get("ref") ?? "";
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? sessionStorage.getItem(`manage:${ref}`) ?? "";
  if (token) sessionStorage.setItem(`manage:${ref}`, token);
  const show = (b) => {
    $("[data-field=reference]", root).textContent = b.reference;
    $("[data-field=service]", root).textContent = b.service;
    $("[data-field=when]", root).textContent = b.when;
    $("[data-field=status]", root).textContent = b.status.replace("_", " ");
    $("[data-action=cancel]", root).hidden = !["confirmed", "pending_payment"].includes(b.status);
  };
  const h = { "x-manage-token": token };
  async function refresh(attempt = 0) {
    const r = await api(`/api/bookings/${encodeURIComponent(ref)}`, { headers: h });
    if (!r.ok) { setStatus(status, "error", r.data?.error?.message ?? "Booking not found. Use the link from your email."); return; }
    show(r.data.booking);
    // After Checkout the webhook may arrive a moment later: the page waits for the SERVER to confirm the payment.
    if (r.data.booking.status === "pending_payment" && params.has("session_id") && attempt < 10) { setStatus(status, "info", "Confirming your payment…"); setTimeout(() => refresh(attempt + 1), 2000); return; }
    if (r.data.booking.status === "confirmed" && (params.has("session_id") || params.has("new"))) setStatus(status, "success", "Your booking is confirmed. We emailed you the details.");
  }
  await refresh();
  $("[data-action=cancel]", root)?.addEventListener("click", async () => {
    if (!confirm("Cancel this booking?")) return;
    const r = await api(`/api/bookings/${encodeURIComponent(ref)}/cancel`, { method: "POST", body: {}, headers: h });
    if (r.ok) { show(r.data.booking); setStatus(status, "success", "Your booking is cancelled."); }
    else setStatus(status, "error", r.data?.error?.message ?? "Could not cancel.");
  });
}

document.addEventListener("DOMContentLoaded", () => { enhanceNav(); enhanceForms(); enhanceBooking(); enhanceManage(); });
